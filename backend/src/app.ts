/** Wires every service together. Tests build the same graph with fakes injected. */
import { watchTasks } from "./social.js";
import { dirname, resolve } from "node:path";
import { AgentGateway } from "./agent.js";
import type { Config } from "./config.js";
import { type Db, logEvent, openDb } from "./db.js";
import { Executor } from "./executor.js";
import { FeeLedger } from "./fees.js";
import { HealthChecker } from "./health.js";
import { PriceHistory } from "./history.js";
import { HyperliquidTestnet } from "./hyperliquid.js";
import type { FeeRoute } from "./mandate.js";
import { NearAiClient } from "./nearai.js";
import { NftPublisher, publishCheckpoints } from "./nft.js";
import { OutLayerClient } from "./outlayer.js";
import { PerpExecutor } from "./perps.js";
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
  /** Hyperliquid client override (tests). */
  hl?: HyperliquidTestnet;
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
  const hl = deps.hl ?? new HyperliquidTestnet({ privateKey: cfg.HL_TESTNET_PRIVATE_KEY, accountAddress: cfg.HL_ACCOUNT_ADDRESS, builder: cfg.HL_BUILDER_ADDRESS, fetch: f });
  const perps = cfg.HL_PERPS_ENABLED ? new PerpExecutor({ db, hl, maxLeverage: cfg.HL_MAX_LEVERAGE, maxOrderUsd: cfg.HL_MAX_ORDER_USD, slippage: cfg.HL_SLIPPAGE }) : null;
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
    bondGate: cfg.BOND_GATE,
    perps,
  });
  const reviewer = new Reviewer(db, pilots, history, ai, cfg.REVIEW_EVERY_DAYS);
  const fees = new FeeLedger({
    db,
    pilots,
    gateway,
    catalog,
    nft,
    paymentsEnabled: cfg.FEE_PAYMENTS_ENABLED,
    liveExecution: cfg.LIVE_EXECUTION,
    feeAssetId: cfg.FEE_ASSET_ID,
    minFeeUsd: cfg.MIN_FEE_USD,
  });
  const health = new HealthChecker({ db, pilots, history, catalog, wasm, nft, costBps: cfg.PAPER_COST_BPS, bondGate: cfg.BOND_GATE });
  /** The signed policy gets the fee destination only while fee payments are on and an NFT contract is set. */
  const policyOptions = (): { fee?: FeeRoute } =>
    cfg.FEE_PAYMENTS_ENABLED && cfg.STRATEGY_NFT_CONTRACT ? { fee: { contract: cfg.STRATEGY_NFT_CONTRACT, assetId: cfg.FEE_ASSET_ID } } : {};
  return { cfg, db, box, gateway, catalog, history, wasm, outlayer, ai, nft, pilots, executor, runner, reviewer, fees, health, hl, perps, policyOptions };
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
  await publishCheckpoints(app.db, app.nft, Date.now(), { reportCapital: app.cfg.NFT_REPORT_COPIED_CAPITAL }).catch(err(null, "nft checkpoints"));
  for (const p of await app.pilots.dueReviews()) {
    await app.reviewer.review(p.id).catch(err(p.id, "review"));
  }
  // Price-triggered tasks ("if BTC < 60k, buy $500"): fire the ones whose condition holds now.
  await watchTasks(app).catch(err(null, "price tasks"));
  // Weekly copy fees: settle finished weeks, follow payments in flight, credit them on chain.
  for (const p of await app.fees.due()) {
    await app.fees.settle(p.id).catch(err(p.id, "fees"));
  }
  if (app.gateway.hasKey || app.nft.configured) await app.fees.reconcile().catch(err(null, "fee reconcile"));
  // Daily health check: a few pilots per tick, and at most a few drift replays (serverless time limit).
  let replays = 0;
  for (const p of (await app.health.due()).slice(0, 20)) {
    await app.health.check(p.id, { allowBacktest: replays++ < 5 }).catch(err(p.id, "health check"));
  }
  if (app.perps) await app.perps.reconcile().catch(err(null, "perp reconcile"));
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
