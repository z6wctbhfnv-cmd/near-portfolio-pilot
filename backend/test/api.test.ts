import { afterEach, describe, expect, it } from "vitest";
import { applyIntentResult, syncOwnerIntents } from "../src/app.js";
import { buildServer } from "../src/server.js";
import { DEFAULT_UNIVERSE } from "../src/tokens.js";
import { testApp, wasmBuilt } from "./fakes.js";

process.env.NODE_ENV = "test";
const servers: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

function setup(env: Record<string, string> = {}) {
  const t = testApp(env);
  const server = buildServer(t.app);
  servers.push(server);
  const call = async (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const res = await server.inject({ method, url, payload: payload as never, headers });
    return { status: res.statusCode, body: res.json() as any };
  };
  return { ...t, server, call };
}

const NEAR_OWNER = { type: "near", account_id: "owner.near", public_key: "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp" };
const SIGNED = { standard: "nep413", payload: { message: "sign me", recipient: "agentsonintents", nonce: "AAAA" }, public_key: NEAR_OWNER.public_key, signature: "ed25519:sig" };

describe("meta routes", () => {
  it("health, config without secrets, strategies, universe", async () => {
    const { call } = setup();
    expect((await call("GET", "/health")).body.ok).toBe(true);
    const cfg = (await call("GET", "/v1/config")).body;
    expect(cfg.agent_api_key).toBe(true);
    expect(JSON.stringify(cfg)).not.toContain("test-partner-key");
    expect(cfg.live_execution).toBe(false);
    const s = (await call("GET", "/v1/strategies")).body.data;
    expect(s.map((x: { id: string }) => x.id)).toEqual(["rebalance", "trend", "vol_target", "dca"]);
    expect(s[0].params_schema.type).toBe("object");
    const u = (await call("GET", "/v1/universe")).body.data;
    expect(u.find((a: { symbol: string }) => a.symbol === "NEAR").price).toBe(4);
  });

  it("requires the bearer token when one is configured", async () => {
    const { call } = setup({ PILOT_API_TOKEN: "s3cret" });
    expect((await call("GET", "/health")).status).toBe(200);
    expect((await call("GET", "/v1/pilots")).status).toBe(401);
    expect((await call("GET", "/v1/pilots", undefined, { authorization: "Bearer wrong!" })).status).toBe(401);
    expect((await call("GET", "/v1/pilots", undefined, { authorization: "Bearer s3cret" })).status).toBe(200);
  });

  it("parses a mandate with the AI and falls back to rules on a bad answer", async () => {
    const { call, ai } = setup({ NEARAI_API_KEY: "k" });
    ai.answers.push({ risk: "low", assets: ["NEAR", "ETH"], budget: { daily_usd: 300 }, max_trade_usd: 60 });
    const good = (await call("POST", "/v1/mandate/parse", { text: "careful, NEAR and ETH, 300 a day, 60 per trade" })).body;
    expect(good.source).toBe("ai");
    expect(good.policy.budget.daily_usd).toBe("300.00");
    expect(good.policy.actions).toEqual(["swap"]);
    expect(good.strategy.id).toBe("rebalance");

    ai.answers.push("I think you should buy DOGE!!!");
    const bad = (await call("POST", "/v1/mandate/parse", { text: "careful, NEAR only" })).body;
    expect(bad.source).toBe("rules");
    expect(bad.notes.join(" ")).toMatch(/AI/);
    expect(bad.mandate.assets).toEqual(["NEAR"]);

    // A JSON answer of the wrong shape must not pass just because every field has a default.
    ai.answers.push({ summary: "hello", proposals: [] });
    const wrong = (await call("POST", "/v1/mandate/parse", { text: "careful, NEAR only" })).body;
    expect(wrong.source).toBe("rules");
    expect(wrong.mandate.assets).toEqual(["NEAR"]);

    // A partial answer keeps what the rules found for the rest.
    ai.answers.push({ max_trade_usd: 25 });
    const partial = (await call("POST", "/v1/mandate/parse", { text: "careful, NEAR only, 70 a day" })).body;
    expect(partial.source).toBe("ai");
    expect(partial.mandate).toMatchObject({ risk: "low", assets: ["NEAR"], max_trade_usd: 25, budget: { daily_usd: 70 } });

    // An invented asset is refused.
    ai.answers.push({ assets: ["DOGE"] });
    expect((await call("POST", "/v1/mandate/parse", { text: "NEAR" })).body.source).toBe("rules");
  });
});

describe.skipIf(!wasmBuilt)("paper pilot", () => {
  it("creates, runs, fills trades, snapshots and reviews", async () => {
    const { call, app } = setup();
    const created = await call("POST", "/v1/pilots", {
      name: "Paper test",
      mode: "paper",
      strategy: { id: "rebalance", params: { weights: { NEAR: 0.5, BTC: 0.25 } } },
      initial_usd: 1000,
    });
    expect(created.status).toBe(201);
    const id = created.body.pilot.id;
    expect(created.body.pilot.status).toBe("active");

    const run = (await call("POST", `/v1/pilots/${id}/run`)).body;
    expect(run.status).toBe("ok");
    expect(run.engine).toBe("local");
    expect(run.output.trades).toHaveLength(2);
    expect(run.executions.every((e: { status: string }) => e.status === "paper_filled")).toBe(true);
    expect(run.nft_status).toBe("unpublished");

    const port = (await call("GET", `/v1/pilots/${id}/portfolio`)).body;
    const near = port.rows.find((r: { symbol: string }) => r.symbol === "NEAR");
    expect(near.usd).toBeCloseTo(500 * (1 - 0.003), 0);
    expect(port.total_usd).toBeCloseTo(1000 - 750 * 0.003, 0);

    // Second run right away: within the band, nothing to do.
    const run2 = (await call("POST", `/v1/pilots/${id}/run`)).body;
    expect(run2.output.trades).toHaveLength(0);
    expect(run2.output.rebalance).toBe(false);

    expect((await call("GET", `/v1/pilots/${id}/runs`)).body.data).toHaveLength(2);
    expect((await call("GET", `/v1/pilots/${id}/snapshots`)).body.data.length).toBe(2);

    const review = (await call("POST", `/v1/pilots/${id}/review`, {})).body;
    expect(review.source).toBe("rules");
    expect(review.metrics.trades_filled).toBe(2);
    expect(app.pilots.get(id)!.next_review_at).toBeGreaterThan(Date.now());
  });

  it("runs trend with cached history and applies an AI review within bounds", async () => {
    const { call, ai } = setup({ NEARAI_API_KEY: "k" });
    ai.answers.push({ risk: "medium", assets: ["NEAR", "BTC"] });
    const id = (
      await call("POST", "/v1/pilots", { name: "Trend", mode: "paper", text: "NEAR and BTC, medium risk", initial_usd: 500 })
    ).body.pilot.id;
    const run = (await call("POST", `/v1/pilots/${id}/run`)).body;
    expect(run.status).toBe("ok");
    expect(Object.keys(run.input.history)).toEqual(["BTC", "NEAR"]);
    expect(run.input.history.NEAR.length).toBe(51);

    ai.answers.push({ summary: "Choppy week.", risk_flags: ["whipsaw"], proposals: [{ param: "sma_days", value: 500, reason: "slower" }, { param: "weights", value: 1, reason: "no" }] });
    const review = (await call("POST", `/v1/pilots/${id}/review`, {})).body;
    expect(review.source).toBe("ai");
    expect(review.status).toBe("proposed");
    expect(review.proposals.accepted).toEqual([{ param: "sma_days", from: 50, to: 63, reason: "slower" }]);
    expect(review.proposals.rejected[0].param).toBe("weights");
    const applied = (await call("POST", `/v1/reviews/${review.id}/apply`)).body;
    expect(applied.status).toBe("applied");
    expect((await call("GET", `/v1/pilots/${id}`)).body.pilot.strategy.params.sma_days).toBe(63);
  });

  it("runs the strategy on OutLayer when configured, falls back locally on failure", async () => {
    const { call, outlayer } = setup({ STRATEGY_ENGINE: "auto", OUTLAYER_PAYMENT_KEY: "pilot.near:1:secret", OUTLAYER_PROJECT: "pilot.near/strategies" });
    const id = (await call("POST", "/v1/pilots", { name: "TEE", strategy: { id: "rebalance", params: { weights: { NEAR: 0.5 } } } })).body.pilot.id;
    const run = (await call("POST", `/v1/pilots/${id}/run`)).body;
    expect(run.engine).toBe("outlayer");
    expect(outlayer.calls[0]).toMatchObject({ path: "/call/pilot.near/strategies", paymentKey: "pilot.near:1:secret" });
    expect(run.attestation.call_id).toMatch(/^1111/);
    expect(run.attestation.record.tdx_quote).toBe("deadbeef");
    expect(run.executions).toHaveLength(1);

    outlayer.failWith = { status: 402, reason: "insufficient_balance" };
    const run2 = (await call("POST", `/v1/pilots/${id}/run`)).body;
    expect(run2.engine).toBe("local");
    expect(run2.status).toBe("ok");
    expect(run2.error).toMatch(/OutLayer failed/);
  });

  it("pauses and resumes", async () => {
    const { call } = setup();
    const id = (await call("POST", "/v1/pilots", { name: "P", strategy: { id: "dca", params: { buy: { NEAR: 1 } } } })).body.pilot.id;
    expect((await call("PATCH", `/v1/pilots/${id}`, { paused: true })).body.pilot.status).toBe("paused");
    expect((await call("PATCH", `/v1/pilots/${id}`, { paused: true })).status).toBe(409);
    expect((await call("PATCH", `/v1/pilots/${id}`, { paused: false })).body.pilot.status).toBe("active");
  });

  it("backtests over the API", async () => {
    const { call } = setup();
    const r = (await call("POST", "/v1/strategies/trend/backtest", { params: { weights: { NEAR: 0.5 } }, days: 120 })).body;
    expect(r.metrics.days).toBeGreaterThan(100);
    expect(r.activity.strategy_errors).toBe(0);
    expect((await call("POST", "/v1/strategies/nope/backtest", { params: {} })).status).toBe(404);
  });
});

describe.skipIf(!wasmBuilt)("live pilot on the Agent API (fake)", () => {
  async function livePilot(env: Record<string, string> = {}) {
    const t = setup(env);
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
    expect(created.body.pilot.status).toBe("pending_owner");
    expect(created.body.owner_action.intent.standard).toBe("nep413");
    expect(created.body.owner_action.preview.summary).toMatch(/Risk notice/);

    // Owner signs agent_create in their wallet; we submit.
    const cid = created.body.owner_action.correlation_id;
    const st = await t.call("POST", `/v1/intents/${cid}/submit`, { signed_data: SIGNED });
    expect(st.body.status).toBe("SUCCESS");
    const p = (await t.call("GET", `/v1/pilots/${id}`)).body.pilot;
    expect(p.status).toBe("active");
    expect(p.agent_id).toBe("agent_1");

    // Grant for the runner, signed by the owner.
    const g = await t.call("POST", `/v1/pilots/${id}/grants`, { ttl_days: 7 });
    expect(g.status).toBe(201);
    await t.call("POST", `/v1/intents/${g.body.owner_action.correlation_id}/submit`, { signed_data: SIGNED });
    const grantRow = t.app.db.prepare("SELECT status, token_enc FROM grants WHERE pilot_id = ?").get(id) as { status: string; token_enc: string };
    expect(grantRow.status).toBe("active");
    expect(grantRow.token_enc).not.toMatch(/ngt_/);

    // 100 USDC and no NEAR: the 50/50 strategy wants to buy 50 USD of NEAR (under the 60 USD cap).
    t.agent.balances = { USDC: String(100 * 1e6) };
    return { ...t, id };
  }

  it("refuses live creation without the owner's acceptance of the terms", async () => {
    const { call } = setup();
    const r = await call("POST", "/v1/pilots", { name: "x", mode: "live", owner: NEAR_OWNER, text: "NEAR" });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/accepted_terms/);
  });

  it("checks quotes but sends nothing while LIVE_EXECUTION is off", async () => {
    const { call, agent, id } = await livePilot();
    const run = (await call("POST", `/v1/pilots/${id}/run`)).body;
    expect(run.status).toBe("ok");
    expect(run.executions).toHaveLength(1);
    const e = run.executions[0];
    expect(e.kind).toBe("live");
    expect(e.status).toBe("blocked");
    expect(e.error_code).toBe("live_execution_disabled");
    expect(e.quote.quote.amountOut).toMatch(/^\d+$/);
    expect(e.request.min_amount_out).toMatch(/^\d+$/);
    expect(agent.swaps).toHaveLength(0); // no live swap call at all
  });

  it("sends with the stored key, replays retryable failures under the SAME key", async () => {
    const { call, agent, app, id } = await livePilot({ LIVE_EXECUTION: "true" });
    agent.failNextSwaps.push({ status: 503, code: "internal_error", retryable: true });
    const run = (await call("POST", `/v1/pilots/${id}/run`)).body;
    const e = run.executions[0];
    expect(e.status).toBe("retry_pending");
    expect(agent.swaps).toHaveLength(1);
    const key = agent.swaps[0]!.idempotencyKey;
    expect(key).toBe(e.idempotency_key);
    expect(agent.swaps[0]!.grant).toMatch(/^ngt_/);

    const r = await app.executor.reconcile();
    expect(r.replayed).toBe(1);
    expect(agent.swaps).toHaveLength(2);
    expect(agent.swaps[1]!.idempotencyKey).toBe(key); // never a new key for a maybe-sent request
    expect(agent.swaps[1]!.body).toEqual(agent.swaps[0]!.body);
    const after = app.executor.get(e.id)!;
    expect(after.status).toBe("PROCESSING");
    expect(after.correlation_id).toMatch(/^op_/);

    // The reconciler follows it to the end by polling, never by resending.
    agent.ops.get(after.correlation_id!)!.status = "SUCCESS";
    await app.executor.reconcile();
    expect(app.executor.get(e.id)!.status).toBe("SUCCESS");
    expect(agent.swaps).toHaveLength(2);
  });

  it("keeps polling UNCERTAIN without resubmitting", async () => {
    const { call, agent, app, id } = await livePilot({ LIVE_EXECUTION: "true" });
    agent.nextOpStatus = "UNCERTAIN";
    const e = (await call("POST", `/v1/pilots/${id}/run`)).body.executions[0];
    expect(e.status).toBe("UNCERTAIN");
    await app.executor.reconcile();
    await app.executor.reconcile();
    expect(agent.swaps).toHaveLength(1);
  });

  it("blocks on quote warnings, on mandate caps, and when not ready", async () => {
    const { call, agent, app, id } = await livePilot({ LIVE_EXECUTION: "true" });
    agent.quoteWarnings = [{ code: "spend_budget_exceeded", detail: "over budget" }];
    let e = (await call("POST", `/v1/pilots/${id}/run`)).body.executions[0];
    expect(e.status).toBe("blocked");
    expect(e.error_code).toBe("spend_budget_exceeded");

    agent.quoteWarnings = [];
    agent.balances = { USDC: String(1000 * 1e6) }; // 1000 → buy 500 of NEAR > 60 USD mandate cap
    e = (await call("POST", `/v1/pilots/${id}/run`)).body.executions[0];
    expect(e.error_code).toBe("mandate_trade_limit");

    agent.balances = { USDC: String(100 * 1e6) };
    agent.policy.synced = false;
    e = (await call("POST", `/v1/pilots/${id}/run`)).body.executions[0];
    expect(e.error_code).toBe("not_ready");
    expect(e.error).toMatch(/synced/);
    expect(agent.swaps).toHaveLength(0);
    expect(app.pilots.get(id)!.strategy.state).toEqual({});
  });

  it("refusals that sent nothing are final for that key", async () => {
    const { call, agent, app, id } = await livePilot({ LIVE_EXECUTION: "true" });
    agent.failNextSwaps.push({ status: 403, code: "spend_budget_exceeded" });
    const e = (await call("POST", `/v1/pilots/${id}/run`)).body.executions[0];
    expect(e.status).toBe("refused");
    await app.executor.reconcile();
    expect(agent.swaps).toHaveLength(1);
  });

  it("prepares policy updates and freezes as owner intents", async () => {
    const { call, app, id } = await livePilot();
    const upd = await call("POST", `/v1/pilots/${id}/policy`, { text: "NEAR and BTC, 50 a day" });
    expect(upd.status).toBe(201);
    const cid = upd.body.owner_action.correlation_id;
    await call("POST", `/v1/intents/${cid}/submit`, { signed_data: SIGNED });
    const btc = DEFAULT_UNIVERSE.find((u) => u.symbol === "BTC")!.asset_id;
    expect(app.pilots.get(id)!.policy).toMatchObject({ assets: expect.arrayContaining([btc]) });

    const fr = await call("POST", `/v1/pilots/${id}/freeze`);
    await call("POST", `/v1/intents/${fr.body.owner_action.correlation_id}/submit`, { signed_data: SIGNED });
    expect(app.pilots.get(id)!.status).toBe("frozen");
    applyIntentResult(app, "missing", "SUCCESS"); // unknown ids are ignored
    await syncOwnerIntents(app);
  });

  it("rejects a strategy outside the signed policy", async () => {
    const { call, id } = await livePilot();
    const r = await call("PUT", `/v1/pilots/${id}/strategy`, { id: "rebalance", params: { weights: { SOL: 0.5 } } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("outside_policy");
  });
});
