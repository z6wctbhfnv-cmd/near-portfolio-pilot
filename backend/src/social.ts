/**
 * The social side of a pilot: copying a script NFT (follow / unfollow), the referrer, and
 * price-triggered tasks ("if BTC < 60k, buy $500").
 *
 * Copying on a paper pilot is real inside the simulation: the pilot switches to the followed
 * script, trades it on paper and its fee ledger charges the holder's share of new profit. On a live
 * pilot the agent account has to call the contract's `follow`, which needs the strategy NFT
 * contract on mainnet (the Agent API is mainnet-only); until then a live follow is refused with the
 * reason, never faked.
 */
import { randomUUID } from "node:crypto";
import type { App } from "./app.js";
import { requiredBond, copiedCapitalUsd, MIN_BOND_USD } from "./copying.js";
import { json, logEvent, parse } from "./db.js";
import { ownerNearAccount } from "./fees.js";
import type { Pilot } from "./pilots.js";
import { parseStrategyParams, type StrategyId } from "./strategies.js";

/** The script NFTs dolya's runner can execute: the four WASM strategies (see HANDOFF.md). */
const RUNNABLE: Record<string, StrategyId> = {
  "wasm-rebalance": "rebalance",
  "wasm-trend": "trend",
  "wasm-vol-target": "vol_target",
  "wasm-dca": "dca",
};

export function strategyForToken(tokenId: string): StrategyId | null {
  const base = tokenId.split("@")[0]!.toLowerCase();
  return RUNNABLE[base] ?? null;
}

export class SocialError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type TokenGate = {
  token_id: string;
  holder: string | null;
  own: boolean;
  held_usd: number | null;
  required_usd: number | null;
  copied_capital_usd: number | null;
  open: boolean;
  reason: string;
};

/** Bond gate for one script NFT, read from the contract. Fails closed when the bond can't be read. */
export async function tokenGate(app: App, owner: unknown, tokenId: string): Promise<TokenGate> {
  const base = { token_id: tokenId, holder: null, own: false, held_usd: null, required_usd: null, copied_capital_usd: null };
  if (!app.nft.contract) return { ...base, open: false, reason: "no strategy NFT contract configured" };
  try {
    const holder = await app.nft.revenueReceiver(tokenId);
    if (!holder) return { ...base, open: false, reason: "no such script NFT" };
    const me = ownerNearAccount(owner);
    if (me && me === holder) return { ...base, holder, own: true, open: true, reason: "you hold this script's NFT" };
    const strategy = strategyForToken(tokenId);
    const [bond, capital] = await Promise.all([app.nft.bondStatus(tokenId), strategy ? copiedCapitalUsd(app.db, strategy, holder) : Promise.resolve(0)]);
    const required = Math.max(bond.required_usd, requiredBond(capital));
    const open = bond.held_usd + 1e-9 >= required;
    return {
      ...base,
      holder,
      held_usd: bond.held_usd,
      required_usd: required,
      copied_capital_usd: capital,
      open,
      reason: open
        ? `the holder's bond $${bond.held_usd.toFixed(2)} covers the required $${required.toFixed(2)}`
        : `the holder's bond is $${bond.held_usd.toFixed(2)}, below the required $${required.toFixed(2)} (the larger of $${MIN_BOND_USD} and 1% of copiers' capital)`,
    };
  } catch (e) {
    return { ...base, open: false, reason: `bond unreadable: ${(e as Error).message}` };
  }
}

/** Parameters for `strategy` that keep the pilot's own assets and stablecoin. */
function paramsFor(p: Pilot, strategy: StrategyId): Record<string, unknown> {
  const cur = p.strategy.params as Record<string, unknown>;
  const stable = String(cur.stable ?? p.mandate?.stable ?? "USDC");
  const weights = (cur.weights ?? cur.buy) as Record<string, number> | undefined;
  const assets = weights && Object.keys(weights).length ? Object.keys(weights) : (p.mandate?.assets ?? ["NEAR", "BTC", "ETH"]);
  const share = weights ? Object.values(weights).reduce((a, b) => a + b, 0) : 0.6;
  const each = Number((Math.min(0.9, share || 0.6) / assets.length).toFixed(6));
  const w = Object.fromEntries(assets.map((s) => [s, each]));
  const common = { stable, min_trade_usd: cur.min_trade_usd ?? 5 };
  if (strategy === "dca") return parseStrategyParams("dca", { ...common, buy: Object.fromEntries(assets.map((s) => [s, 1 / assets.length])), amount_usd: 20, every_days: 7 });
  return parseStrategyParams(strategy, { ...common, weights: w });
}

export async function follow(app: App, p: Pilot, tokenId: string) {
  const strategy = strategyForToken(tokenId);
  if (!strategy) {
    throw new SocialError(
      409,
      "not_runnable",
      "This script runs only in the research engine. dolya's runner can copy the four WASM scripts: wasm-rebalance, wasm-trend, wasm-vol-target and wasm-dca.",
    );
  }
  const gate = await tokenGate(app, p.owner, tokenId);
  if (p.mode === "live") {
    if (!gate.open) throw new SocialError(409, "copy_closed", `Copying is closed: ${gate.reason}.`);
    throw new SocialError(
      409,
      "live_follow_unavailable",
      "A live copy needs the agent's account to call follow on the strategy NFT contract, and that contract is on testnet while the Agent API is mainnet-only. Copy on a paper portfolio meanwhile.",
    );
  }
  const params = paramsFor(p, strategy);
  const following = { token_id: tokenId, strategy_id: strategy, since: Date.now() };
  const pilot = await app.pilots.update(p.id, {
    strategy_id: strategy,
    strategy_params_json: json(params)!,
    strategy_state_json: "{}",
    following_json: json(following)!,
    swarm_json: null,
    swarm_state_json: null,
    next_run_at: Date.now(),
  });
  await logEvent(app.db, p.id, "info", `copying ${tokenId} on paper`, { gate });
  return {
    pilot,
    gate,
    note: gate.open
      ? "Copying on paper. Fees to the holder are charged weekly on new profit, in the paper ledger."
      : `Copying on paper only: on chain this copy would be refused, because ${gate.reason}.`,
  };
}

export async function unfollow(app: App, p: Pilot) {
  if (!p.following) throw new SocialError(409, "not_following", "This pilot is not copying a script.");
  const pilot = await app.pilots.update(p.id, { following_json: null });
  await logEvent(app.db, p.id, "info", `stopped copying ${p.following.token_id}`);
  return { pilot };
}

const NEAR_ACCOUNT = /^(?=.{2,64}$)([a-z\d]+[-_])*[a-z\d]+(\.([a-z\d]+[-_])*[a-z\d]+)*$/;

export async function setReferrer(app: App, p: Pilot, referrer: string) {
  const r = referrer.trim().toLowerCase();
  if (!NEAR_ACCOUNT.test(r)) throw new SocialError(400, "validation_failed", "The referrer must be a NEAR account, e.g. friend.near.");
  if (p.referrer) throw new SocialError(409, "already_set", `The referrer is already ${p.referrer}; the contract records it once.`);
  if (r === ownerNearAccount(p.owner)) throw new SocialError(400, "validation_failed", "You can't refer yourself.");
  const pilot = await app.pilots.update(p.id, { referrer: r });
  await logEvent(app.db, p.id, "info", `referrer recorded: ${r}`);
  return {
    pilot,
    on_chain: false,
    note:
      p.mode === "live"
        ? "Saved. The agent records it on the NFT contract (set_referrer) once that contract is on mainnet."
        : "Saved for this paper portfolio. The referrer's 0.1% comes out of dolya's 0.25%, never out of your profit.",
  };
}

// ------------------------------------------------------------------ price tasks

export type TaskRow = {
  id: string;
  pilot_id: string;
  asset: string;
  op: "<" | ">";
  price: number;
  side: "buy" | "sell";
  usd: number;
  status: "active" | "done" | "failed" | "cancelled";
  text: string | null;
  fired_at: number | null;
  fired_price: number | null;
  result_json: string | null;
  created_at: number;
};

export const taskView = (t: TaskRow) => ({ ...t, result: parse(t.result_json, null), result_json: undefined });

export async function listTasks(app: App, pilotId: string) {
  return (await app.db.prepare("SELECT * FROM tasks WHERE pilot_id = ? ORDER BY created_at DESC").all<TaskRow>(pilotId)).map(taskView);
}

export async function addTask(app: App, p: Pilot, t: { asset: string; op: "<" | ">"; price: number; side: "buy" | "sell"; usd: number; text?: string }) {
  const universe = await app.catalog.universe();
  const asset = universe.find((a) => a.symbol === t.asset.toUpperCase() && !a.stable);
  if (!asset) throw new SocialError(400, "validation_failed", `${t.asset} is not a tradable asset here.`);
  const max = p.mandate?.max_trade_usd;
  if (max && t.usd > max) throw new SocialError(400, "validation_failed", `Your rules cap a trade at $${max}; this task asks for $${t.usd}.`);
  const id = randomUUID();
  await app.db
    .prepare("INSERT INTO tasks (id, pilot_id, asset, op, price, side, usd, status, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)")
    .run(id, p.id, asset.symbol, t.op, t.price, t.side, t.usd, t.text ?? null, Date.now());
  await logEvent(app.db, p.id, "info", `task added: ${t.side} $${t.usd} ${asset.symbol} when ${t.op} ${t.price}`);
  return taskView((await app.db.prepare("SELECT * FROM tasks WHERE id = ?").get<TaskRow>(id))!);
}

export async function cancelTask(app: App, pilotId: string, taskId: string) {
  await app.db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ? AND pilot_id = ? AND status = 'active'").run(taskId, pilotId);
  const t = await app.db.prepare("SELECT * FROM tasks WHERE id = ? AND pilot_id = ?").get<TaskRow>(taskId, pilotId);
  return t ? taskView(t) : null;
}

/**
 * Fires every active task whose price condition holds now. A fired task trades once, through the
 * same executor and mandate caps as a strategy run, then is done. Frozen or paused pilots wait.
 */
export async function watchTasks(app: App, now = Date.now()) {
  const tasks = await app.db.prepare("SELECT * FROM tasks WHERE status = 'active' ORDER BY created_at").all<TaskRow>();
  if (!tasks.length) return { checked: 0, fired: 0 };
  const universe = await app.catalog.universe();
  const price = (s: string) => universe.find((a) => a.symbol === s)?.price ?? null;
  let fired = 0;
  for (const t of tasks) {
    const px = price(t.asset);
    if (px === null) continue;
    if (!(t.op === "<" ? px < t.price : px > t.price)) continue;
    const p = await app.pilots.get(t.pilot_id);
    if (!p) continue;
    if (p.status !== "active") continue;
    const stable = String(p.strategy.params.stable ?? "USDC");
    const trade = t.side === "buy" ? { sell: stable, buy: t.asset, usd: t.usd } : { sell: t.asset, buy: stable, usd: t.usd };
    try {
      const limits = await app.runner.limits(p);
      let rows;
      if (p.mode === "paper") {
        const h = { ...(p.paper_holdings ?? {}) };
        rows = await app.executor.paper(p.id, `task-${t.id}`, h, [trade], limits);
        await app.pilots.update(p.id, { paper_holdings_json: json(h) });
      } else {
        if (!p.agent_id) continue;
        rows = await app.executor.live(p.id, `task-${t.id}`, p.agent_id, [trade], limits);
      }
      const ok = rows.some((r) => r.status !== "blocked" && r.status !== "refused");
      await app.db
        .prepare("UPDATE tasks SET status = ?, fired_at = ?, fired_price = ?, result_json = ? WHERE id = ?")
        .run(ok ? "done" : "failed", now, px, json(rows.map((r) => ({ id: r.id, status: r.status, usd: r.usd, error_code: r.error_code, error: r.error }))), t.id);
      await logEvent(app.db, p.id, ok ? "info" : "warn", `task fired at ${t.asset} $${px}: ${t.side} $${t.usd} → ${ok ? "done" : rows[0]?.error_code ?? "blocked"}`, { task_id: t.id });
      if (ok) {
        const v = await app.runner.valuation((await app.runner.holdings((await app.pilots.get(p.id))!)).holdings);
        await app.runner.snapshot(p.id, v.total_usd, v.rows);
      }
      fired++;
    } catch (e) {
      await logEvent(app.db, p.id, "error", `task ${t.id} failed: ${(e as Error).message}`);
    }
  }
  return { checked: tasks.length, fired };
}
