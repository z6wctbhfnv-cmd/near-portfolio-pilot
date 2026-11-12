/**
 * The swarm: one main agent coordinating several script agents inside one owner wallet.
 *
 * The owner follows several scripts. Each script runs as its own agent on a "sleeve": a virtual
 * book of units that is its share of the wallet. The main agent:
 *  1. allocates the owner's capital across the followed scripts (equal, manual or calm =
 *     inverse volatility), with a per-script cap; what no script gets stays in a cash sleeve;
 *  2. lets every script decide on its own sleeve, exactly as a single pilot would (same WASM);
 *  3. resolves conflicts: when one script buys what another sells, the two are crossed inside the
 *     wallet at the market price, with no swap and no fee; only the net goes to the market, paired
 *     directly asset to asset where possible;
 *  4. stays inside the signed policy: a trade touching an asset the policy does not allow is
 *     dropped (with a reason) before anything is sent; the executor then applies the mandate's
 *     per-trade and budget caps and the Agent API applies the policy itself;
 *  5. books the result back to the sleeves: crossed amounts move between sleeves, and what the
 *     market actually filled goes to the scripts that asked for it, pro rata.
 * The wallet is always the truth: before each run the sleeves are scaled so that, asset by asset,
 * they add up to what the wallet holds.
 *
 * Everything here is pure (no I/O) so it can be tested on its own; runner.ts does the I/O.
 */
import { z } from "zod";
import { STRATEGY_IDS, type StrategyId } from "./strategies.js";

export const CASH = "_cash";

export const SwarmConfigSchema = z
  .object({
    scripts: z
      .array(
        z.object({
          /** Unique name of this script agent within the swarm, e.g. "trend". */
          key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
          id: z.enum(STRATEGY_IDS as [StrategyId, ...StrategyId[]]),
          params: z.record(z.string(), z.unknown()).default({}),
          /** Most of the wallet this script may run, 0..1. */
          cap: z.number().gt(0).max(1).default(0.6),
          /** Share for `allocation: "manual"`. */
          weight: z.number().min(0).max(1).optional(),
        }),
      )
      .min(1)
      .max(5)
      .refine((s) => new Set(s.map((x) => x.key)).size === s.length, "script keys must be unique"),
    allocation: z.enum(["equal", "manual", "calm"]).default("equal"),
    review_every_days: z.number().int().min(1).max(90).default(7),
  })
  .refine((c) => c.allocation !== "manual" || c.scripts.every((s) => s.weight !== undefined), "manual allocation needs a weight for every script")
  .refine((c) => c.allocation !== "manual" || c.scripts.reduce((a, s) => a + (s.weight ?? 0), 0) <= 1 + 1e-9, "manual weights must sum to at most 1");

export type SwarmConfig = z.infer<typeof SwarmConfigSchema>;
export type Units = Record<string, number>;
export type Sleeve = { units: Units; state: unknown };
export type SwarmState = { sleeves: Record<string, Sleeve>; alloc: Record<string, number>; alloc_at: number; alloc_reason: string };
export type Trade = { sell: string; buy: string; usd: number };
export type Prices = Record<string, number>;

export const valueOf = (u: Units, px: Prices) => Object.entries(u).reduce((a, [s, n]) => a + n * (px[s] ?? 0), 0);

/**
 * Capital per script. `vols`: annualised volatility per script (for "calm"). Shares are capped; what
 * a cap holds back is not pushed onto the other scripts, it stays in cash.
 */
export function allocate(cfg: SwarmConfig, vols: Record<string, number> = {}): { alloc: Record<string, number>; reason: string } {
  let raw: Record<string, number>;
  let reason: string;
  if (cfg.allocation === "manual") {
    raw = Object.fromEntries(cfg.scripts.map((s) => [s.key, s.weight ?? 0]));
    reason = "your manual shares";
  } else if (cfg.allocation === "calm" && cfg.scripts.every((s) => (vols[s.key] ?? 0) > 0)) {
    const inv = Object.fromEntries(cfg.scripts.map((s) => [s.key, 1 / Math.max(vols[s.key]!, 0.02)]));
    const total = Object.values(inv).reduce((a, b) => a + b, 0);
    raw = Object.fromEntries(Object.entries(inv).map(([k, v]) => [k, v / total]));
    reason = "calmer scripts get more: " + cfg.scripts.map((s) => `${s.key} ${(vols[s.key]! * 100).toFixed(0)}% vol`).join(", ");
  } else {
    raw = Object.fromEntries(cfg.scripts.map((s) => [s.key, 1 / cfg.scripts.length]));
    reason = cfg.allocation === "calm" ? "equal shares (no volatility history yet)" : "equal shares";
  }
  const alloc: Record<string, number> = {};
  for (const s of cfg.scripts) {
    const share = Math.min(raw[s.key] ?? 0, s.cap);
    if (share > 1e-6) alloc[s.key] = Number(share.toFixed(6));
  }
  const capped = cfg.scripts.filter((s) => (raw[s.key] ?? 0) > s.cap + 1e-9).map((s) => s.key);
  if (capped.length) reason += `; capped ${capped.join(", ")} (the rest stays in cash)`;
  return { alloc, reason };
}

/** Scales the sleeves so that each asset adds up to what the wallet holds; new money goes to cash. */
export function trueUp(sleeves: Record<string, Sleeve>, holdings: Units): Record<string, Sleeve> {
  const out: Record<string, Sleeve> = Object.fromEntries(Object.entries(sleeves).map(([k, s]) => [k, { units: { ...s.units }, state: s.state }]));
  out[CASH] ??= { units: {}, state: null };
  const assets = new Set([...Object.keys(holdings), ...Object.values(out).flatMap((s) => Object.keys(s.units))]);
  for (const a of assets) {
    const have = Math.max(0, holdings[a] ?? 0);
    const booked = Object.values(out).reduce((t, s) => t + Math.max(0, s.units[a] ?? 0), 0);
    for (const s of Object.values(out)) {
      if (booked > 0) s.units[a] = (Math.max(0, s.units[a] ?? 0) / booked) * have;
      else delete s.units[a];
    }
    if (booked <= 0 && have > 0) out[CASH]!.units[a] = have;
  }
  return out;
}

/**
 * Moves value between sleeves until each holds its allocated share of the wallet. Only books move:
 * a sleeve gives a slice of everything it holds, so every asset's total stays the same and no trade
 * is needed. Sleeves for scripts no longer in the swarm hand everything back to cash.
 */
export function rebalanceSleeves(sleeves: Record<string, Sleeve>, alloc: Record<string, number>, px: Prices): Record<string, Sleeve> {
  const out: Record<string, Sleeve> = Object.fromEntries(Object.entries(sleeves).map(([k, s]) => [k, { units: { ...s.units }, state: s.state }]));
  out[CASH] ??= { units: {}, state: null };
  for (const k of Object.keys(alloc)) out[k] ??= { units: {}, state: null };
  const total = Object.values(out).reduce((a, s) => a + valueOf(s.units, px), 0);
  if (total <= 0) return out;
  const target = (k: string) => (k === CASH ? Math.max(0, 1 - Object.values(alloc).reduce((a, b) => a + b, 0)) : (alloc[k] ?? 0)) * total;
  // Over-allocated sleeves give a pro-rata slice of all they hold into a pool.
  const pool: Units = {};
  for (const [k, s] of Object.entries(out)) {
    const v = valueOf(s.units, px);
    if (v <= target(k) + 1e-9 || v <= 0) continue;
    const f = 1 - target(k) / v;
    for (const [a, n] of Object.entries(s.units)) {
      pool[a] = (pool[a] ?? 0) + n * f;
      s.units[a] = n * (1 - f);
    }
  }
  // Under-allocated sleeves take from the pool by their shortfall.
  const short = Object.entries(out).map(([k, s]) => [k, Math.max(0, target(k) - valueOf(s.units, px))] as const);
  const need = short.reduce((a, [, v]) => a + v, 0);
  if (need <= 0) return out;
  for (const [k, v] of short) {
    if (v <= 0) continue;
    for (const [a, n] of Object.entries(pool)) out[k]!.units[a] = (out[k]!.units[a] ?? 0) + (n * v) / need;
  }
  for (const k of Object.keys(out)) if (k !== CASH && !(k in alloc) && valueOf(out[k]!.units, px) < 1e-6) delete out[k];
  return out;
}

export type Want = { key: string; trades: Trade[] };
export type Plan = {
  /** Per sleeve, per asset: the USD it asked to change (buys > 0, sells < 0), after dropped trades. */
  deltas: Record<string, Record<string, number>>;
  /** Per asset: USD crossed between scripts inside the wallet (no swap). */
  crossed: Record<string, number>;
  /** What goes to the market. */
  trades: Trade[];
  dropped: Array<{ key: string; trade: Trade; reason: string }>;
  reasons: string[];
};

/**
 * Nets the scripts' trades. `allowed`: assets the signed policy allows (undefined = paper, all).
 */
export function plan(wants: Want[], opts: { allowed?: Set<string> } = {}): Plan {
  const deltas: Plan["deltas"] = {};
  const dropped: Plan["dropped"] = [];
  for (const w of wants) {
    const d: Record<string, number> = (deltas[w.key] = {});
    for (const t of w.trades) {
      const outside = [t.sell, t.buy].filter((a) => opts.allowed && !opts.allowed.has(a));
      if (outside.length) {
        dropped.push({ key: w.key, trade: t, reason: `the signed policy does not allow ${outside.join(", ")}` });
        continue;
      }
      if (!(t.usd > 0) || t.sell === t.buy) continue;
      d[t.sell] = (d[t.sell] ?? 0) - t.usd;
      d[t.buy] = (d[t.buy] ?? 0) + t.usd;
    }
  }
  const assets = [...new Set(Object.values(deltas).flatMap((d) => Object.keys(d)))].sort();
  const crossed: Record<string, number> = {};
  const net: Record<string, number> = {};
  const reasons: string[] = [];
  for (const a of assets) {
    const buys = Object.values(deltas).reduce((t, d) => t + Math.max(0, d[a] ?? 0), 0);
    const sells = Object.values(deltas).reduce((t, d) => t + Math.max(0, -(d[a] ?? 0)), 0);
    crossed[a] = Math.min(buys, sells);
    net[a] = buys - sells;
    if (crossed[a]! > 0.005) {
      const who = (sign: 1 | -1) =>
        Object.entries(deltas)
          .filter(([, d]) => sign * (d[a] ?? 0) > 0)
          .map(([k, d]) => `${k} ${sign > 0 ? "+" : "-"}$${Math.abs(d[a]!).toFixed(2)}`)
          .join(", ");
      reasons.push(`${a}: ${who(1)} against ${who(-1)}: $${crossed[a]!.toFixed(2)} crossed inside the wallet, net ${net[a]! >= 0 ? "+" : "-"}$${Math.abs(net[a]!).toFixed(2)} to the market`);
    }
  }
  // Pair net sellers with net buyers, biggest first: each pair is one swap.
  const sellers = assets.filter((a) => net[a]! < -1e-9).map((a) => ({ a, left: -net[a]! })).sort((x, y) => y.left - x.left);
  const buyers = assets.filter((a) => net[a]! > 1e-9).map((a) => ({ a, left: net[a]! })).sort((x, y) => y.left - x.left);
  const trades: Trade[] = [];
  let i = 0;
  let j = 0;
  while (i < sellers.length && j < buyers.length) {
    const usd = Math.min(sellers[i]!.left, buyers[j]!.left);
    if (usd >= 0.01) trades.push({ sell: sellers[i]!.a, buy: buyers[j]!.a, usd: Number(usd.toFixed(2)) });
    sellers[i]!.left -= usd;
    buyers[j]!.left -= usd;
    if (sellers[i]!.left <= 1e-9) i++;
    if (buyers[j]!.left <= 1e-9) j++;
  }
  for (const d of dropped) reasons.push(`dropped ${d.key}: ${d.trade.sell}->${d.trade.buy} $${d.trade.usd.toFixed(2)}: ${d.reason}`);
  return { deltas, crossed, trades, dropped, reasons };
}

/**
 * Books a run's result to the sleeves. `realized`: units each asset actually changed by in the wallet
 * from the market trades (after minus before). Crossed amounts move between the scripts that wanted
 * them; market fills go to the scripts whose wish was not crossed, pro rata. A final true-up against
 * `holdings` makes the books exact.
 */
export function attribute(sleeves: Record<string, Sleeve>, p: Plan, realized: Units, px: Prices, holdings: Units): Record<string, Sleeve> {
  const out: Record<string, Sleeve> = Object.fromEntries(Object.entries(sleeves).map(([k, s]) => [k, { units: { ...s.units }, state: s.state }]));
  for (const a of Object.keys(p.crossed)) {
    const price = px[a];
    if (!price) continue;
    const entries = Object.entries(p.deltas).filter(([, d]) => (d[a] ?? 0) !== 0);
    const buys = entries.reduce((t, [, d]) => t + Math.max(0, d[a]!), 0);
    const sells = entries.reduce((t, [, d]) => t + Math.max(0, -d[a]!), 0);
    const crossedUnits = p.crossed[a]! / price;
    const r = realized[a] ?? 0;
    for (const [k, d] of entries) {
      const s = (out[k] ??= { units: {}, state: null });
      const want = d[a]!;
      if (want > 0) {
        const residual = buys > 0 ? want * (1 - p.crossed[a]! / buys) : 0;
        const residualTotal = buys - p.crossed[a]!;
        s.units[a] = (s.units[a] ?? 0) + (buys > 0 ? (want / buys) * crossedUnits : 0) + (r > 0 && residualTotal > 1e-9 ? (residual / residualTotal) * r : 0);
      } else {
        const w = -want;
        const residual = sells > 0 ? w * (1 - p.crossed[a]! / sells) : 0;
        const residualTotal = sells - p.crossed[a]!;
        s.units[a] = (s.units[a] ?? 0) - (sells > 0 ? (w / sells) * crossedUnits : 0) + (r < 0 && residualTotal > 1e-9 ? (residual / residualTotal) * r : 0);
      }
    }
  }
  return trueUp(out, holdings);
}

/** A fresh swarm over `holdings`: everything starts in cash, then the allocation moves the books. */
export function initialState(cfg: SwarmConfig, holdings: Units, px: Prices, now: number, vols: Record<string, number> = {}): SwarmState {
  const { alloc, reason } = allocate(cfg, vols);
  const sleeves = rebalanceSleeves({ [CASH]: { units: { ...holdings }, state: null } }, alloc, px);
  return { sleeves, alloc, alloc_at: now, alloc_reason: reason };
}
