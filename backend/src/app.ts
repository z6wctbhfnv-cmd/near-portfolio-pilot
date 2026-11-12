/** Wires every service together. Tests build the same graph with fakes injected. */
import { dirname, resolve } from "node:path";
import { AgentGateway } from "./agent.js";
import type { Config } from "./config.js";
import { type Db, logEvent, openDb } from "./db.js";
import { Executor } from "./executor.js";
import { PriceHistory } from "./history.js";
import { NearAiClient } from "./nearai.js";
import { NftPublisher, publishCheckpoints } from "./nft.js";
import { OutLayerClient } from "./outlayer.js";
import { Pilots } from "./pilots.js";
import { Reviewer } from "./review.js";
import { Runner } from "./runner.js";
import { SecretBox } from "./secrets.js";
import { TokenCatalog } from "./tokens.js";
import { StrategyWasm } from "./wasm.js";

export type AppDeps = {
  fetch?: typeof fetch;
  db?: Db;
  wasm?: StrategyWasm;
  settleWaitMs?: number;
};

export function buildApp(cfg: Config, deps: AppDeps = {}) {
  const f = deps.fetch ?? fetch;
  const db = deps.db ?? openDb(cfg.DATABASE_URL ?? cfg.DATABASE_PATH, cfg.DATABASE_AUTH_TOKEN);
  // With a remote database there is no lasting disk for a generated key file: the key must be set.
  if (cfg.DATABASE_URL && !cfg.PILOT_MASTER_KEY) throw new Error("PILOT_MASTER_KEY must be set when DATABASE_URL is used");
  const keyFile = resolve(cfg.DATABASE_PATH === ":memory:" ? "/tmp" : dirname(cfg.DATABASE_PATH), ".master_key");
  const box = SecretBox.fromConfig(cfg.PILOT_MASTER_KEY, keyFile);
  const gateway = new AgentGateway(cfg, db, box, f);
  const catalog = new TokenCatalog(() => gateway.tokens(), 60_000);
  const history = new PriceHistory(db, cfg.HISTORY_API_URL, f);
  const wasm = deps.wasm ?? new StrategyWasm(cfg.STRATEGY_WASM_PATH);
  const outlayer = new OutLayerClient({ baseUrl: cfg.OUTLAYER_API_URL, paymentKey: cfg.OUTLAYER_PAYMENT_KEY, project: cfg.OUTLAYER_PROJECT, fetch: f });
  const ai = new NearAiClient({ apiKey: cfg.NEARAI_API_KEY, baseUrl: cfg.NEARAI_BASE_URL, model: cfg.NEARAI_MODEL, fetch: f });
  const nft = new NftPublisher({
    contract: cfg.STRATEGY_NFT_CONTRACT,
    accountId: cfg.NEAR_ACCOUNT_ID,
    privateKey: cfg.NEAR_PRIVATE_KEY,
    rpcUrl: cfg.NEAR_RPC_URL,
    fetch: f,
  });
  const pilots = new Pilots(db);
  const executor = new Executor({
    db,
    gateway,
    catalog,
    liveExecution: cfg.LIVE_EXECUTION,
    maxSlippageBps: cfg.MAX_SLIPPAGE_BPS,
    paperCostBps: cfg.PAPER_COST_BPS,
    settleWaitMs: deps.settleWaitMs ?? 20_000,
  });
  const runner = new Runner({
    db,
    pilots,
    gateway,
    catalog,
    history,
    wasm,
    outlayer,
    executor,
    nft,
    engine: cfg.STRATEGY_ENGINE,
    outlayerProject: cfg.OUTLAYER_PROJECT,
  });
  const reviewer = new Reviewer(db, pilots, history, ai, cfg.REVIEW_EVERY_DAYS);
  return { cfg, db, box, gateway, catalog, history, wasm, outlayer, ai, nft, pilots, executor, runner, reviewer };
}

export type App = ReturnType<typeof buildApp>;

/**
 * Background loop: due pilot runs, open live executions, weekly reviews, and owner intents still
 * waiting on the chain. Each step is isolated so one failure never stops the others.
 */
export function startScheduler(app: App, everyMs = 60_000) {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await tick(app);
    } finally {
      busy = false;
    }
  };
  const handle = setInterval(() => void run(), everyMs);
  void run();
  return () => clearInterval(handle);
}

/**
 * One pass of background work. The local server calls it every minute; on Vercel, Cron calls
 * POST /api/cron, which runs exactly this.
 */
export async function tick(app: App) {
  const err = (pilotId: string | null, what: string) => (e: unknown) => logEvent(app.db, pilotId, "error", `${what}: ${(e as Error).message}`);
  for (const p of await app.pilots.due()) {
    await app.runner.run(p.id, { reason: "scheduled" }).catch(err(p.id, "scheduled run"));
  }
  if (app.gateway.hasKey) {
    await app.executor.reconcile().catch(err(null, "reconcile"));
    await syncOwnerIntents(app).catch(err(null, "intent sync"));
  }
  await publishCheckpoints(app.db, app.nft).catch(err(null, "nft checkpoints"));
  for (const p of await app.pilots.dueReviews()) {
    await app.reviewer.review(p.id).catch(err(p.id, "review"));
  }
}

/** Follows submitted owner intents to their end and applies the result to the pilot. */
export async function syncOwnerIntents(app: App) {
  const rows = await app.db
    .prepare("SELECT correlation_id FROM owner_intents WHERE submitted_at IS NOT NULL AND status NOT IN ('SUCCESS','FAILED','REFUNDED','NEEDS_REVIEW')")
    .all<{ correlation_id: string }>();
  for (const r of rows) {
    const s = await app.gateway.status(r.correlation_id);
    await applyIntentResult(app, r.correlation_id, s.status);
  }
}

/** Effects of a finished owner intent on local state. */
export async function applyIntentResult(app: App, correlationId: string, status: string) {
  const row = await app.gateway.intentRow(correlationId);
  if (!row?.pilot_id) return;
  await app.gateway.settleGrant(correlationId, status);
  if (status !== "SUCCESS") {
    if (row.type === "agent_create" && app.gateway.isTerminal(status)) await app.pilots.update(row.pilot_id, { status: "draft" });
    return;
  }
  const meta = JSON.parse(row.meta_json ?? "null") as { policy?: unknown; mandate?: unknown } | null;
  switch (row.type) {
    case "agent_create":
      await app.pilots.update(row.pilot_id, { status: "active", agent_id: row.agent_id, next_run_at: Date.now() });
      break;
    case "policy_update":
      if (meta?.policy) await app.pilots.update(row.pilot_id, { policy_json: JSON.stringify(meta.policy), ...(meta.mandate ? { mandate_json: JSON.stringify(meta.mandate) } : {}) });
      break;
    case "agent_freeze":
      await app.pilots.update(row.pilot_id, { status: "frozen" });
      break;
    case "agent_unfreeze":
      await app.pilots.update(row.pilot_id, { status: "active" });
      break;
    case "agent_archive":
    case "agent_delete":
      await app.pilots.update(row.pilot_id, { status: "archived" });
      break;
  }
  await logEvent(app.db, row.pilot_id, "info", `owner intent ${row.type} settled: ${status}`, { correlation_id: correlationId });
}
