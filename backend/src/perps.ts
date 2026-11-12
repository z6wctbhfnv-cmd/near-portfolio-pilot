/**
 * Perp execution on Hyperliquid TESTNET, behind HL_PERPS_ENABLED (off by default).
 *
 * A strategy's `target_weights` may hold perp keys ("BTC-PERP": -0.2 = short 20%). The executor sizes
 * them against the Hyperliquid account's own equity (testnet margin is separate from the NEAR agent
 * wallet), and every order passes the owner's limits first, as spot swaps do:
 * - only BTC, ETH, SOL and NEAR perps;
 * - a new or larger position is capped per order (HL_MAX_ORDER_USD and the mandate's max trade) and
 *   by gross leverage (HL_MAX_LEVERAGE x equity); a reducing order is always allowed (it lowers risk);
 * - orders under Hyperliquid's $10 minimum are skipped.
 * The client order id (cloid) is stored before the order is sent, so a lost answer is looked up by
 * cloid on the next reconcile instead of being sent again.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { type Db, json, logEvent } from "./db.js";
import { type HyperliquidTestnet, type OrderWire, slippagePrice, floatToWire } from "./hyperliquid.js";

export const PERP_COINS = ["BTC", "ETH", "SOL", "NEAR"];
export const PERP_SUFFIX = "-PERP";
export const HL_MIN_ORDER_USD = 10;

export type PerpOrderRow = {
  id: string;
  pilot_id: string;
  run_id: string | null;
  cloid: string;
  coin: string;
  usd: number;
  request_json: string;
  status: string;
  response_json: string | null;
  error_code: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

export function perpTargets(weights: Record<string, number> | undefined): Record<string, number> {
  return Object.fromEntries(Object.entries(weights ?? {}).filter(([k, w]) => k.endsWith(PERP_SUFFIX) && Number.isFinite(w)).map(([k, w]) => [k.slice(0, -PERP_SUFFIX.length), w]));
}

export class PerpExecutor {
  constructor(
    private readonly d: { db: Db; hl: HyperliquidTestnet; maxLeverage: number; maxOrderUsd: number; slippage: number },
  ) {}

  private async insert(r: Omit<PerpOrderRow, "created_at" | "updated_at">) {
    const now = Date.now();
    await this.d.db
      .prepare("INSERT INTO perp_orders (id, pilot_id, run_id, cloid, coin, usd, request_json, status, response_json, error_code, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(r.id, r.pilot_id, r.run_id, r.cloid, r.coin, r.usd, r.request_json, r.status, r.response_json, r.error_code, r.error, now, now);
  }

  private async update(id: string, f: Partial<PerpOrderRow>) {
    const keys = Object.keys(f);
    await this.d.db
      .prepare(`UPDATE perp_orders SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => (f as Record<string, string | number | null>)[k] ?? null), Date.now(), id);
  }

  list(pilotId: string) {
    return this.d.db.prepare("SELECT * FROM perp_orders WHERE pilot_id = ? ORDER BY created_at DESC LIMIT 200").all<PerpOrderRow>(pilotId);
  }

  /**
   * Moves the account toward `weights` (coin -> signed share of equity). `maxTradeUsd`: the mandate's
   * per-trade cap, if any. Returns the order rows of this call.
   */
  async rebalance(pilotId: string, runId: string | null, weights: Record<string, number>, maxTradeUsd: number | null): Promise<PerpOrderRow[]> {
    const [acct, mids, meta] = await Promise.all([this.d.hl.account(), this.d.hl.mids(), this.d.hl.meta()]);
    const rows: PerpOrderRow[] = [];
    let gross = acct.gross_notional;
    const coins = [...new Set([...Object.keys(weights), ...Object.keys(acct.positions).filter((c) => PERP_COINS.includes(c))])].sort();
    for (const coin of coins) {
      const id = randomUUID();
      const cloid = "0x" + randomBytes(16).toString("hex");
      const mid = mids[coin];
      const w = weights[coin] ?? 0;
      const base = { id, pilot_id: pilotId, run_id: runId, cloid, coin, response_json: null };
      const block = async (code: string, error: string, usd = 0, request: unknown = { coin, weight: w }) => {
        await this.insert({ ...base, usd, request_json: json(request)!, status: "blocked", error_code: code, error });
        rows.push((await this.get(id))!);
      };
      if (!PERP_COINS.includes(coin)) {
        await block("asset_not_allowed", `${coin} perps are not allowed`);
        continue;
      }
      const asset = meta.findIndex((a) => a.name === coin);
      if (!mid || asset < 0) {
        await block("price_unavailable", `no Hyperliquid testnet market for ${coin}`);
        continue;
      }
      const cur = (acct.positions[coin] ?? 0) * mid;
      const target = Math.max(-1, Math.min(1, w)) * acct.equity;
      let delta = target - cur;
      if (Math.abs(delta) < HL_MIN_ORDER_USD) continue; // close enough, nothing to do
      const after0 = cur + delta;
      const reducing = Math.abs(after0) < Math.abs(cur) - 1e-9 && cur * after0 >= 0;
      if (!reducing) {
        const cap = Math.min(this.d.maxOrderUsd, maxTradeUsd ?? Infinity);
        if (Math.abs(delta) > cap) delta = Math.sign(delta) * cap;
        // The largest position this coin may reach: leverage x equity minus what the other coins use.
        const maxAbs = Math.max(0, this.d.maxLeverage * acct.equity - (gross - Math.abs(cur)));
        const after = cur + delta;
        if (Math.abs(after) > maxAbs) delta = Math.sign(after) * maxAbs - cur;
        if (Math.abs(delta) < HL_MIN_ORDER_USD || Math.sign(delta) !== Math.sign(target - cur)) {
          await block("leverage_limit", `the order would take gross exposure above ${this.d.maxLeverage}x equity ($${acct.equity.toFixed(2)})`, target - cur);
          continue;
        }
      }
      const szDecimals = meta[asset]!.szDecimals;
      const size = Number((Math.abs(delta) / mid).toFixed(szDecimals));
      if (size <= 0) {
        await block("size_too_small", "rounds to zero", delta);
        continue;
      }
      const isBuy = delta > 0;
      const wire: OrderWire = { a: asset, b: isBuy, p: floatToWire(slippagePrice(mid, isBuy, this.d.slippage, szDecimals)), s: floatToWire(size), r: reducing, t: { limit: { tif: "Ioc" } }, c: cloid };
      const nonce = Date.now();
      // The cloid and the exact request are stored BEFORE sending.
      await this.insert({ ...base, usd: Number(delta.toFixed(2)), request_json: json({ action: this.d.hl.orderAction(wire), nonce, mid })!, status: "prepared", error_code: null, error: null });
      if (!this.d.hl.canTrade) {
        await this.update(id, { status: "blocked", error_code: "no_key", error: "HL_TESTNET_PRIVATE_KEY is not set: order checked, nothing sent" });
      } else {
        try {
          const r = await this.d.hl.placeOrder(wire, nonce);
          if (r.kind === "error") await this.update(id, { status: "error", error_code: "venue_refused", error: r.error, response_json: json(r) });
          else await this.update(id, { status: r.kind, response_json: json(r) });
          if (r.kind !== "error") gross += Math.abs(cur + delta) - Math.abs(cur);
        } catch (e) {
          // Maybe sent: the cloid tells on the next reconcile.
          await this.update(id, { status: "unknown", error_code: "transport_error", error: (e as Error).message });
        }
      }
      const row = (await this.get(id))!;
      await logEvent(this.d.db, pilotId, row.status === "filled" || row.status === "resting" ? "info" : "warn", `perp ${coin} ${isBuy ? "buy" : "sell"} $${Math.abs(delta).toFixed(2)}${reducing ? " (reduce)" : ""}: ${row.status}`, { perp_order_id: id });
      rows.push(row);
    }
    return rows;
  }

  get(id: string) {
    return this.d.db.prepare("SELECT * FROM perp_orders WHERE id = ?").get<PerpOrderRow>(id);
  }

  /** Orders whose answer was lost: look them up by cloid; never seen after 2 minutes = never sent. */
  async reconcile() {
    const rows = await this.d.db.prepare("SELECT * FROM perp_orders WHERE status = 'unknown'").all<PerpOrderRow>();
    for (const r of rows) {
      try {
        const s = await this.d.hl.orderByCloid(r.cloid);
        if (s) await this.update(r.id, { status: s.status === "filled" ? "filled" : s.status === "open" ? "resting" : s.status, error_code: null, error: null });
        else if (Date.now() - r.created_at > 120_000) await this.update(r.id, { status: "error", error_code: "never_reached", error: "Hyperliquid has no order with this cloid: nothing was placed" });
      } catch (e) {
        await logEvent(this.d.db, r.pilot_id, "warn", `perp reconcile ${r.id} failed`, { error: (e as Error).message });
      }
    }
    return rows.length;
  }
}
