/**
 * The gap work end to end over HTTP, against fakes: weekly copy fees (paper and live), the author
 * bond gate, the daily health check, the swarm, and perps on the runner. Needs the built WASM.
 */
import { afterEach, describe, expect, it } from "vitest";
import { tick } from "../src/app.js";
import { PERIOD_MS, scriptCodeHash } from "../src/nft.js";
import { buildServer } from "../src/server.js";
import { DEFAULT_UNIVERSE } from "../src/tokens.js";
import { StrategyWasm } from "../src/wasm.js";
import { testApp, WASM_PATH, wasmBuilt } from "./fakes.js";

process.env.NODE_ENV = "test";
const DAY = 86_400_000;
const USDC = DEFAULT_UNIVERSE.find((a) => a.symbol === "USDC")!.asset_id;
const NFT_ENV = { STRATEGY_NFT_CONTRACT: "nft.test", NEAR_RPC_URL: "https://rpc.test" };
const NEAR_OWNER = { type: "near", account_id: "owner.near", public_key: "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp" };
const SIGNED = { standard: "nep413", payload: { message: "sign me", recipient: "agentsonintents", nonce: "AAAA" }, public_key: NEAR_OWNER.public_key, signature: "ed25519:sig" };

const servers: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

function setup(env: Record<string, string> = {}, deps: { wasm?: StrategyWasm } = {}) {
  const t = testApp(env, deps);
  const server = buildServer(t.app);
  servers.push(server);
  const call = async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.json() as any };
  };
  /** Mints the script on the fake chain, held by `holder`. */
  const mint = (strategy: string, holder = "author.near", bond?: [string, string]) => {
    const token = `wasm-${strategy}@v1`;
    t.chain.tokens[scriptCodeHash(t.app.wasm.wasmSha256, strategy)] = token;
    t.chain.holders[token] = holder;
    if (bond) t.chain.bonds[token] = bond;
    return token;
  };
  return { ...t, server, call, mint };
}

async function paperPilot(t: ReturnType<typeof setup>, strategy: unknown = { id: "rebalance", params: { weights: { NEAR: 0.5 } } }, mandate?: unknown) {
  const r = await t.call("POST", "/v1/pilots", { name: "Paper", strategy, initial_usd: 1000, ...(mandate ? { mandate } : {}) });
  expect(r.status).toBe(201);
  return r.body.pilot.id as string;
}

async function livePilot(t: ReturnType<typeof setup>) {
  const created = await t.call("POST", "/v1/pilots", {
    name: "Live",
    mode: "live",
    owner: NEAR_OWNER,
    accepted_terms: true,
    strategy: { id: "rebalance", params: { weights: { NEAR: 0.5 } } },
    mandate: { assets: ["NEAR"], budget: { daily_usd: 100 }, max_trade_usd: 60 },
  });
  expect(created.status).toBe(201);
  const id = created.body.pilot.id as string;
  await t.call("POST", `/v1/intents/${created.body.owner_action.correlation_id}/submit`, { signed_data: SIGNED });
  const g = await t.call("POST", `/v1/pilots/${id}/grants`, { ttl_days: 7 });
  await t.call("POST", `/v1/intents/${g.body.owner_action.correlation_id}/submit`, { signed_data: SIGNED });
  t.agent.balances = { USDC: String(100 * 1e6) };
  return { id, policy: created.body.pilot.policy };
}

/** The end of the fee week that contains `now`, and a value recorded just before it. */
async function endOfWeek(t: ReturnType<typeof setup>, id: string, now: number, usd: number) {
  const periodEnd = Math.floor(now / PERIOD_MS) * PERIOD_MS + PERIOD_MS;
  await t.app.db.prepare("INSERT INTO snapshots (pilot_id, ts, total_usd, holdings_json) VALUES (?, ?, ?, '[]')").run(id, periodEnd - 1000, usd);
  return periodEnd;
}

const firstValue = async (t: ReturnType<typeof setup>, id: string) =>
  (await t.app.db.prepare("SELECT total_usd FROM snapshots WHERE pilot_id = ? ORDER BY ts LIMIT 1").get<{ total_usd: number }>(id))!.total_usd;

describe.skipIf(!wasmBuilt)("weekly copy fees", () => {
  it("paper: charges new profit once per week, holds the peak, carries dust", async () => {
    const t = setup(NFT_ENV);
    t.mint("rebalance");
    const id = await paperPilot(t);
    expect((await t.call("POST", `/v1/pilots/${id}/run`)).body.status).toBe("ok");
    const start = await firstValue(t, id);
    const now = Date.now();
    const end1 = await endOfWeek(t, id, now, 1200);
    const usdcBefore = (await t.app.pilots.get(id))!.paper_holdings!.USDC!;

    const r1 = (await t.app.fees.settle(id, end1)).row!;
    expect(r1).toMatchObject({ status: "paper_paid", token_id: "wasm-rebalance@v1", holder: "author.near", payer_is_holder: 0, holder_bps: 500, payment_bps: 525 });
    expect(r1.profit_usd).toBeCloseTo(1200 - start, 6);
    expect(r1.fee_usd).toBeCloseTo(((1200 - start) * 525) / 10_000, 5);
    expect(r1.hwm_after_usd).toBeCloseTo(1200 - r1.fee_usd, 6);
    expect((await t.app.pilots.get(id))!.paper_holdings!.USDC).toBeCloseTo(usdcBefore - r1.fee_usd, 6);

    // Idempotent: the same week again is the same row, nothing debited twice.
    expect((await t.app.fees.settle(id, end1)).row!.id).toBe(r1.id);
    expect((await t.app.pilots.get(id))!.paper_holdings!.USDC).toBeCloseTo(usdcBefore - r1.fee_usd, 6);

    // Next week below the peak: no fee, the peak stays.
    const end2 = await endOfWeek(t, id, end1, 1150);
    expect((await t.app.fees.settle(id, end2)).row).toMatchObject({ status: "no_profit", fee_usd: 0, hwm_after_usd: r1.hwm_after_usd });
    // A week just above it: under MIN_FEE_USD, carried over, the peak does not move.
    const end3 = await endOfWeek(t, id, end2, r1.hwm_after_usd! + 5);
    expect((await t.app.fees.settle(id, end3)).row).toMatchObject({ status: "carried", hwm_after_usd: r1.hwm_after_usd });

    const fees = (await t.call("GET", `/v1/pilots/${id}/fees`)).body;
    expect(fees.terms).toMatchObject({ platform_bps: 25, referral_bps_of_platform: 10, holder_bps_default: 500, payments_enabled: false });
    expect(fees.data.map((r: { status: string }) => r.status)).toEqual(["carried", "no_profit", "paper_paid"]);
    expect(fees.peaks[0].hwm_usd).toBeCloseTo(r1.hwm_after_usd!, 6);
  });

  it("no NFT, no fee; a swarm pilot is not charged per sleeve yet", async () => {
    const t = setup(NFT_ENV);
    const id = await paperPilot(t);
    await t.call("POST", `/v1/pilots/${id}/run`);
    expect((await t.app.fees.settle(id, Date.now() + PERIOD_MS)).skipped).toMatch(/no NFT/);
    const t2 = setup();
    const id2 = await paperPilot(t2);
    await t2.call("POST", `/v1/pilots/${id2}/run`);
    expect((await t2.call("POST", `/v1/pilots/${id2}/fees/settle`)).body.skipped).toMatch(/STRATEGY_NFT_CONTRACT/);
  });

  it("live: the policy carries the fee destination; nothing is sent until the owner signed it", async () => {
    const t = setup({ ...NFT_ENV, FEE_PAYMENTS_ENABLED: "true" });
    t.mint("rebalance", "author.near", ["100000000", "100000000"]); // bonded: copying is open
    const { id, policy } = await livePilot(t);
    expect(policy.actions).toEqual(["swap", "withdraw"]);
    expect(policy.destinations).toEqual({ mode: "only", list: [{ action: "withdraw", chain: "near", address: "nft.test", memo: null }] });
    await t.call("POST", `/v1/pilots/${id}/run`);
    const end = await endOfWeek(t, id, Date.now(), (await firstValue(t, id)) + 100);
    // The agent's applied policy (fake) still says swap only.
    expect((await t.app.fees.settle(id, end)).row).toMatchObject({ status: "blocked", error_code: "fee_destination_missing" });
    expect(t.agent.withdraws).toHaveLength(0);
    // Signed: the preview runs, but LIVE_EXECUTION is off, so nothing is sent.
    t.agent.policyExtra = { actions: ["swap", "withdraw"], destinations: { mode: "only", list: [{ action: "withdraw", chain: "near", address: "nft.test", memo: null }] } };
    const r = (await t.app.fees.settle(id, end)).row!;
    expect(r).toMatchObject({ status: "blocked", error_code: "live_execution_disabled", payment_bps: 525 });
    expect(t.agent.withdraws.map((w) => w.body.dry)).toEqual([true]);
    expect(t.agent.withdraws[0]!.idempotencyKey).toMatch(/^feeprev-/);
  });

  it("live: stored key, retry under the SAME key, peak lowered on success, then credited on chain", async () => {
    const t = setup({ ...NFT_ENV, FEE_PAYMENTS_ENABLED: "true", LIVE_EXECUTION: "true", NEAR_ACCOUNT_ID: "recorder.test", NEAR_PRIVATE_KEY: "ed25519:1111" });
    t.mint("rebalance", "author.near", ["100000000", "100000000"]);
    const { id } = await livePilot(t);
    t.agent.policyExtra = { actions: ["swap", "withdraw"], destinations: { mode: "only", list: [{ action: "withdraw", chain: "near", address: "nft.test", memo: null }] } };
    await t.call("POST", `/v1/pilots/${id}/run`);
    const start = await firstValue(t, id);
    const now = Date.now();
    const end = await endOfWeek(t, id, now, start + 150);
    // 50 USDC was deposited during the week: not profit.
    t.agent.history = [{ type: "deposit", status: "SUCCESS", created_at: new Date(end - 2 * DAY).toISOString(), details: { request: { origin_asset: USDC }, delivered: String(50e6) } }];
    const recorded: unknown[] = [];
    t.app.nft.recordFeePayment = async (a) => {
      recorded.push(a);
      t.chain.payments[a.reference] = a.amount;
      return "tx-record";
    };
    t.agent.failNextWithdraws.push({ status: 503, code: "internal_error", retryable: true });

    const r = (await t.app.fees.settle(id, end)).row!;
    expect(r.deposits_usd).toBe(50);
    expect(r.profit_usd).toBeCloseTo(100, 6);
    expect(r.fee_usd).toBe(5.25);
    expect(r.amount_atomic).toBe("5250000");
    expect(r.status).toBe("retry_pending");
    const live = t.agent.withdraws.filter((w) => !w.body.dry);
    expect(live).toHaveLength(1);
    expect(live[0]!.idempotencyKey).toBe(r.idempotency_key);
    expect(live[0]!.body).toMatchObject({ asset: USDC, amount: "5250000", chain: "near", recipient: "nft.test", reference: r.reference });
    expect(live[0]!.body).not.toHaveProperty("memo");
    expect(live[0]!.grant).toMatch(/^ngt_/);
    // The week cannot start over while its payment is in flight.
    expect((await t.app.fees.settle(id, end)).skipped).toMatch(/in flight/);

    await t.app.fees.reconcile();
    const replays = t.agent.withdraws.filter((w) => !w.body.dry);
    expect(replays).toHaveLength(2);
    expect(replays[1]!.idempotencyKey).toBe(r.idempotency_key);
    const sent = (await t.app.fees.get(r.id))!;
    expect(sent.status).toBe("PROCESSING");
    expect(sent.hwm_after_usd).toBeNull();

    t.agent.ops.get(sent.correlation_id!)!.status = "SUCCESS";
    const rec = await t.app.fees.reconcile();
    expect(rec.recorded).toBe(1);
    const done = (await t.app.fees.get(r.id))!;
    expect(done).toMatchObject({ status: "SUCCESS", record_status: "recorded", credited_atomic: "5250000", record_tx: "tx-record" });
    expect(done.hwm_after_usd).toBeCloseTo(start + 150 - 5.25, 6);
    expect(recorded).toEqual([{ payer: "owner.near", tokenId: "wasm-rebalance@v1", feeToken: USDC.replace("nep141:", ""), amount: "5250000", reference: r.reference }]);
    // Nothing more to send or record.
    await t.app.fees.reconcile();
    expect(t.agent.withdraws.filter((w) => !w.body.dry)).toHaveLength(2);
    expect(recorded).toHaveLength(1);
  });

  it("live: the holder running its own script pays only 0.25%; a short balance blocks without moving the peak", async () => {
    const t = setup({ ...NFT_ENV, FEE_PAYMENTS_ENABLED: "true", LIVE_EXECUTION: "true" });
    t.mint("rebalance", "owner.near", ["0", "100000000"]);
    const { id } = await livePilot(t);
    t.agent.policyExtra = { actions: ["swap", "withdraw"], destinations: { mode: "only", list: [{ action: "withdraw", chain: "near", address: "nft.test", memo: null }] } };
    await t.call("POST", `/v1/pilots/${id}/run`);
    const start = await firstValue(t, id);
    const end = await endOfWeek(t, id, Date.now(), start + 1000);
    t.agent.balances = { USDC: "1000000" }; // 1 USDC; the fee is 2.50
    const r = (await t.app.fees.settle(id, end)).row!;
    expect(r).toMatchObject({ payer: "owner.near", payer_is_holder: 1, payment_bps: 25, fee_usd: 2.5, status: "blocked", error_code: "insufficient_balance" });
    const peak = (await t.app.fees.peaks(id))[0] as { hwm_usd: number };
    expect(peak.hwm_usd).toBeCloseTo(start, 6);
  });
});

describe.skipIf(!wasmBuilt)("author bond gate", () => {
  it("a live pilot does not trade a copied script while the holder's bond is short", async () => {
    const t = setup(NFT_ENV);
    const token = t.mint("rebalance");
    const { id } = await livePilot(t);
    const swapsBefore = t.agent.calls.filter((c) => c.path.endsWith("/swap")).length;
    const run = (await t.call("POST", `/v1/pilots/${id}/run`)).body;
    expect(run.status).toBe("skipped");
    expect(run.error).toMatch(/copying closed: the holder's bond is \$0.00, below the required \$100.00/);
    expect(t.agent.calls.filter((c) => c.path.endsWith("/swap")).length).toBe(swapsBefore);
    const gate = (await t.call("GET", `/v1/pilots/${id}/copy-gate`)).body;
    expect(gate.data[0]).toMatchObject({ strategy: "rebalance", token_id: token, open: false, own: false, held_usd: 0, required_usd: 100 });

    t.chain.bonds[token] = ["100000000", "100000000"];
    expect((await t.call("POST", `/v1/pilots/${id}/run`)).body.status).toBe("ok");

    // A bond we cannot read is not a bond: fail closed.
    t.chain.failViews = true;
    t.app.nft["tokenCache"].clear();
    const blind = (await t.call("POST", `/v1/pilots/${id}/run`)).body;
    expect(blind.status).toBe("skipped");
    expect(blind.error).toMatch(/bond unknown/);
  });

  it("your own script needs no bond; paper pilots are warned unless BOND_GATE=all", async () => {
    const own = setup(NFT_ENV);
    own.mint("rebalance", "owner.near");
    const { id } = await livePilot(own);
    expect((await own.call("POST", `/v1/pilots/${id}/run`)).body.status).toBe("ok");

    const t = setup(NFT_ENV);
    t.mint("rebalance");
    const paper = await paperPilot(t);
    const run = (await t.call("POST", `/v1/pilots/${paper}/run`)).body;
    expect(run.status).toBe("ok");
    expect(run.error).toMatch(/copying closed.*a live pilot would not trade/);

    const strict = setup({ ...NFT_ENV, BOND_GATE: "all" });
    strict.mint("rebalance");
    const p2 = await paperPilot(strict);
    expect((await strict.call("POST", `/v1/pilots/${p2}/run`)).body.status).toBe("skipped");
  });
});

describe.skipIf(!wasmBuilt)("daily health check", () => {
  it("asks Pause / Keep running when something is wrong; keep mutes it, pause pauses", async () => {
    const t = setup();
    const id = await paperPilot(t);
    await t.call("POST", `/v1/pilots/${id}/run`);
    const ok = (await t.call("POST", `/v1/pilots/${id}/health/check`)).body;
    expect(ok.status).toBe("ok");
    expect(ok.question).toBeNull();

    const ins = t.app.db.prepare("INSERT INTO runs (id, pilot_id, started_at, engine, status, error) VALUES (?, ?, ?, 'local', 'error', 'boom')");
    for (const n of [1, 2, 3]) await ins.run(`e${n}`, id, Date.now() - n * 1000);
    const bad = (await t.call("POST", `/v1/pilots/${id}/health/check`)).body;
    expect(bad.status).toBe("stop");
    expect(bad.findings.find((f: { check: string }) => f.check === "errors").detail).toMatch(/3 failed run\(s\).*boom/);
    expect(bad.question.options.map((o: { id: string }) => o.id)).toEqual(["pause", "keep"]);
    expect((await t.call("GET", `/v1/pilots/${id}/health`)).body.latest.id).toBe(bad.id);

    const kept = await t.call("POST", `/v1/health/${bad.id}/answer`, { answer: "keep" });
    expect(kept.status).toBe(200);
    expect(kept.body.pilot.status).toBe("active");
    expect((await t.call("POST", `/v1/health/${bad.id}/answer`, { answer: "pause" })).status).toBe(409);
    // The same problem again within MUTE_DAYS: shown, but not asked again.
    const muted = (await t.call("POST", `/v1/pilots/${id}/health/check`)).body;
    expect(muted.status).toBe("ok");
    expect(muted.question).toBeNull();
    expect(muted.findings.find((f: { check: string }) => f.check === "errors").severity).toBe("muted");

    const t2 = setup();
    const id2 = await paperPilot(t2);
    await t2.call("POST", `/v1/pilots/${id2}/run`);
    await t2.app.db.prepare("INSERT INTO runs (id, pilot_id, started_at, engine, status, error) VALUES ('e1', ?, ?, 'local', 'error', 'boom')").run(id2, Date.now());
    const c2 = (await t2.call("POST", `/v1/pilots/${id2}/health/check`)).body;
    expect(c2.status).toBe("warn");
    const paused = await t2.call("POST", `/v1/health/${c2.id}/answer`, { answer: "pause" });
    expect(paused.body.pilot.status).toBe("paused");
  });

  it("flags drift between the pilot's week and the script replayed on daily closes", async () => {
    const t = setup();
    const id = await paperPilot(t);
    await t.call("POST", `/v1/pilots/${id}/run`);
    const now = Date.now();
    const snap = t.app.db.prepare("INSERT INTO snapshots (pilot_id, ts, total_usd, holdings_json) VALUES (?, ?, ?, ?)");
    await t.app.db.prepare("DELETE FROM snapshots WHERE pilot_id = ?").run(id);
    await snap.run(id, now - 6 * DAY, 1000, JSON.stringify([{ symbol: "USDC", units: 500, price: 1, usd: 500 }, { symbol: "NEAR", units: 125, price: 4, usd: 500 }]));
    await snap.run(id, now, 1400, JSON.stringify([{ symbol: "USDC", units: 900, price: 1, usd: 900 }, { symbol: "NEAR", units: 125, price: 4, usd: 500 }]));
    const c = (await t.call("POST", `/v1/pilots/${id}/health/check`)).body;
    const drift = c.findings.find((f: { check: string }) => f.check === "drift");
    expect(drift.severity).toBe("stop");
    expect(drift.data.live).toBeCloseTo(0.4, 6);
    expect(Math.abs(drift.data.simulated)).toBeLessThan(0.3);
  });

  it("the scheduler checks every active pilot once a day", async () => {
    const t = setup();
    const a = await paperPilot(t);
    const b = await paperPilot(t);
    await tick(t.app);
    const rows = await t.app.db.prepare("SELECT pilot_id FROM health_checks ORDER BY pilot_id").all<{ pilot_id: string }>();
    expect(rows.map((r) => r.pilot_id).sort()).toEqual([a, b].sort());
    await tick(t.app);
    expect((await t.app.db.prepare("SELECT COUNT(*) AS n FROM health_checks").get<{ n: number }>())!.n).toBe(2);
  });
});

describe.skipIf(!wasmBuilt)("swarm: several scripts in one wallet", () => {
  it("allocates, runs each script on its sleeve, crosses conflicting trades, keeps books equal to the wallet", async () => {
    const t = setup();
    // Caps large enough that every planned trade fills in one run.
    const id = await paperPilot(t, undefined, { budget: { daily_usd: 10_000 }, max_trade_usd: 1_000 });
    const cfg = (a: Record<string, number>, b: Record<string, number>) => ({
      scripts: [
        { key: "a", id: "rebalance", params: { weights: a } },
        { key: "b", id: "rebalance", params: { weights: b } },
      ],
    });
    // A rebalance script manages only the assets in its weights, so both list both coins.
    expect((await t.call("PUT", `/v1/pilots/${id}/swarm`, cfg({ NEAR: 0.5, BTC: 0 }, { BTC: 0.5, NEAR: 0 }))).status).toBe(200);
    const r1 = (await t.call("POST", `/v1/pilots/${id}/run`)).body;
    expect(r1.status).toBe("ok");
    expect(r1.output.engine).toBe("swarm");
    expect(r1.output.alloc).toEqual({ a: 0.5, b: 0.5 });
    expect(r1.output.agents.map((x: { key: string }) => x.key)).toEqual(["a", "b"]);
    // Each buys $250 for its $500 sleeve: no conflict, both go to the market.
    expect(r1.executions.map((e: { buy_symbol: string; status: string }) => `${e.buy_symbol}:${e.status}`).sort()).toEqual(["BTC:paper_filled", "NEAR:paper_filled"]);

    const books = async () => {
      const p = (await t.app.pilots.get(id))!;
      const sum = (a: string) => Object.values(p.swarm_state!.sleeves).reduce((x, s) => x + (s.units[a] ?? 0), 0);
      for (const [a, n] of Object.entries(p.paper_holdings!)) expect(sum(a)).toBeCloseTo(n, 8);
      return p;
    };
    await books();

    // The scripts swap tastes: a now wants BTC, b wants NEAR. They trade with each other, not the market.
    await t.call("PUT", `/v1/pilots/${id}/swarm`, cfg({ NEAR: 0, BTC: 0.5 }, { BTC: 0, NEAR: 0.5 }));
    const r2 = (await t.call("POST", `/v1/pilots/${id}/run`)).body;
    expect(r2.output.plan.crossed.NEAR).toBeGreaterThan(200);
    expect(r2.output.plan.crossed.BTC).toBeGreaterThan(200);
    const toMarket = r2.output.trades.reduce((x: number, tr: { usd: number }) => x + tr.usd, 0);
    expect(toMarket).toBeLessThan(10);
    expect(r2.error).toMatch(/crossed inside the wallet/);
    const p = await books();
    const px = { NEAR: 4, BTC: 70_000 } as Record<string, number>;
    expect((p.swarm_state!.sleeves.a!.units.BTC ?? 0) * px.BTC!).toBeGreaterThan(200);
    expect((p.swarm_state!.sleeves.b!.units.NEAR ?? 0) * px.NEAR!).toBeGreaterThan(200);

    const view = (await t.call("GET", `/v1/pilots/${id}/swarm`)).body;
    expect(view.state.sleeves.map((s: { key: string }) => s.key).sort()).toEqual(["_cash", "a", "b"]);
    expect((await t.call("DELETE", `/v1/pilots/${id}/swarm`)).body.pilot.swarm).toBeNull();
    expect((await t.call("POST", `/v1/pilots/${id}/run`)).body.output.engine).not.toBe("swarm");
  });

  it("refuses a swarm outside the signed policy and invalid configs", async () => {
    const t = setup();
    const { id } = await livePilot(t);
    const r = await t.call("PUT", `/v1/pilots/${id}/swarm`, { scripts: [{ key: "a", id: "rebalance", params: { weights: { ZEC: 0.5 } } }] });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("outside_policy");
    expect((await t.call("PUT", `/v1/pilots/${id}/swarm`, { scripts: [] })).status).toBe(400);
    expect((await t.call("PUT", `/v1/pilots/${id}/swarm`, { scripts: [{ key: "a", id: "rebalance", params: { weights: { NEAR: 2 } } }] })).status).toBe(400);
  });
});

/** A strategy that wants a 10% BTC short on perps and no spot change. */
class PerpWasm extends StrategyWasm {
  constructor() {
    super(WASM_PATH);
  }
  override run<T>(input: unknown) {
    const output = { ok: true, trades: [], state: {}, target_weights: { USDC: 1, "BTC-PERP": -0.1 }, notes: [], total_usd: 0, input_sha256: "" };
    return { output: output as T, inputJson: JSON.stringify(input), stdout: JSON.stringify(output), wasmSha256: this.wasmSha256 };
  }
}

describe.skipIf(!wasmBuilt)("perps on the runner (Hyperliquid testnet fake)", () => {
  it("ignores perp weights while HL_PERPS_ENABLED is off", async () => {
    const t = setup({}, { wasm: new PerpWasm() });
    const id = await paperPilot(t);
    const run = (await t.call("POST", `/v1/pilots/${id}/run`)).body;
    expect(run.error).toMatch(/BTC -0.1 ignored: HL_PERPS_ENABLED is off/);
    expect(t.hl.orders).toHaveLength(0);
    expect((await t.call("GET", `/v1/pilots/${id}/perps`)).body).toMatchObject({ enabled: false, data: [] });
  });

  it("sends the perp order to testnet with the builder fee when enabled", async () => {
    const t = setup({ HL_PERPS_ENABLED: "true", HL_TESTNET_PRIVATE_KEY: "0x" + "11".repeat(32), HL_BUILDER_ADDRESS: "0x" + "ab".repeat(20) }, { wasm: new PerpWasm() });
    const id = await paperPilot(t);
    const run = (await t.call("POST", `/v1/pilots/${id}/run`)).body;
    expect(run.perp_orders).toHaveLength(1);
    // -10% of $1000 is a $100 short, capped by the mandate's $50 per trade (perp cap is $200).
    expect(run.perp_orders[0]).toMatchObject({ coin: "BTC", status: "filled", usd: -50 });
    expect(t.hl.orders[0]!.action.builder).toEqual({ b: "0x" + "ab".repeat(20), f: 50 });
    expect(t.hl.positions.BTC).toBeLessThan(0);
    const cfg = (await t.call("GET", "/v1/config")).body;
    expect(cfg.perps).toMatchObject({ enabled: true, network: "hyperliquid-testnet", key: true });
    expect(JSON.stringify(cfg)).not.toContain("1111111111");
    const acct = (await t.call("GET", "/v1/perps/account")).body;
    expect(acct).toMatchObject({ network: "hyperliquid-testnet", equity: 1000 });
  });
});
