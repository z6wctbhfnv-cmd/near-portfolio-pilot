/** The nine starter scripts and changed starters (a starter with the user's own params), over HTTP against fakes. */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { canonical, scriptHash, SCRIPT_PREFIX } from "../src/scripts.js";
import { STRATEGY_IDS } from "../src/strategies.js";
import { testApp, wasmBuilt } from "./fakes.js";

process.env.NODE_ENV = "test";
const NFT_ENV = { STRATEGY_NFT_CONTRACT: "nft.test", NEAR_RPC_URL: "https://rpc.test" };

const servers: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

function setup() {
  const t = testApp(NFT_ENV);
  const server = buildServer(t.app);
  servers.push(server);
  const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never, headers: { authorization: "Bearer test-admin" } });
    return { status: res.statusCode, body: res.json() as any };
  };
  return { ...t, call };
}

const NEW: Record<string, Record<string, unknown>> = {
  momentum: { weights: { BTC: 0.3, ETH: 0.3, NEAR: 0.2 }, lookback_days: 30, top_k: 2 },
  mean_reversion: { weights: { BTC: 0.3, ETH: 0.3 }, trend_days: 60, dip: 0.03 },
  breakout: { weights: { BTC: 0.4, ETH: 0.4 }, entry_days: 30, exit_days: 10 },
  dip_buy: { weights: { BTC: 0.3, ETH: 0.2 }, window_days: 20 },
  stress_rotation: { weights: { BTC: 0.5, ETH: 0.3 }, trend_days: 30 },
};

describe("the nine starter scripts", () => {
  it("are all in the catalogue", async () => {
    const { call } = setup();
    const ids = (await call("GET", "/v1/strategies")).body.data.map((s: { id: string }) => s.id);
    expect(ids).toEqual(["rebalance", "trend", "vol_target", "dca", "momentum", "mean_reversion", "breakout", "dip_buy", "stress_rotation"]);
    expect(STRATEGY_IDS).toHaveLength(9);
  });

  it.skipIf(!wasmBuilt).each(Object.keys(NEW))("%s backtests in the WASM engine without errors", async (id) => {
    const { call } = setup();
    const r = await call("POST", `/v1/strategies/${id}/backtest`, { params: NEW[id], days: 200 });
    expect(r.status).toBe(200);
    expect(r.body.metrics.days).toBeGreaterThan(150);
    expect(r.body.activity.strategy_errors).toBe(0);
  });

  it("rejects params the engine would refuse", async () => {
    const { call } = setup();
    const bad = await call("POST", "/v1/strategies/stress_rotation/backtest", { params: { weights: { ETH: 0.5 } }, days: 60 });
    expect(bad.status).toBe(400);
    const order = await call("POST", "/v1/strategies/breakout/backtest", { params: { weights: { BTC: 0.5 }, entry_days: 10, exit_days: 20 }, days: 60 });
    expect(order.status).toBe(400);
  });
});

describe("changed starters", () => {
  it("register with defaults filled and a hash anyone can recompute", async () => {
    const { call } = setup();
    const r = await call("POST", "/v1/scripts", { base: "momentum", params: { weights: { NEAR: 0.4, BTC: 0.4 }, lookback_days: 90 }, name: "Slow momentum" });
    expect(r.status).toBe(201);
    expect(r.body.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.params.top_k).toBe(2); // default filled
    expect(r.body.params.lookback_days).toBe(90);
    const again = await call("POST", "/v1/scripts", { base: "momentum", params: { lookback_days: 90, weights: { BTC: 0.4, NEAR: 0.4 } } });
    expect(again.body.code_hash).toBe(r.body.code_hash); // key order does not matter
    const other = await call("POST", "/v1/scripts", { base: "momentum", params: { weights: { NEAR: 0.4, BTC: 0.4 }, lookback_days: 91 } });
    expect(other.body.code_hash).not.toBe(r.body.code_hash);
    const expected = createHash("sha256").update(SCRIPT_PREFIX + canonical({ base: "momentum", params: r.body.params })).digest("hex");
    expect(r.body.code_hash).toBe(expected);
    expect(scriptHash("momentum", r.body.params)).toBe(expected);
    expect((await call("GET", `/v1/scripts/hash/${r.body.code_hash}`)).body.base).toBe("momentum");
    expect((await call("GET", `/v1/scripts/hash/${"0".repeat(64)}`)).status).toBe(404);
    expect((await call("POST", "/v1/scripts", { base: "nope", params: {} })).status).toBe(400);
    expect((await call("POST", "/v1/scripts", { base: "stress_rotation", params: { weights: { ETH: 0.5 } } })).status).toBe(400);
  });

  it.skipIf(!wasmBuilt)("a copier's pilot runs the changed starter's own params", async () => {
    const { call, chain } = setup();
    const reg = (await call("POST", "/v1/scripts", { base: "breakout", params: { weights: { BTC: 0.3, NEAR: 0.3 }, entry_days: 40, exit_days: 15 } })).body;
    chain.infos["my-breakout@v1"] = { strategy_id: "my-breakout@v1", code_hash: reg.code_hash, author: "alice.testnet" };
    chain.holders["my-breakout@v1"] = "alice.testnet";
    expect((await call("GET", "/v1/scripts/my-breakout@v1/script")).body).toMatchObject({ runnable: true, kind: "changed", base: "breakout" });
    expect((await call("GET", "/v1/scripts/wasm-trend@v1/script")).body).toMatchObject({ runnable: true, kind: "starter", base: "trend" });
    expect((await call("GET", "/v1/scripts/donchian-breakout@v1/script")).body).toMatchObject({ runnable: false, kind: "research" });

    const p = await call("POST", "/v1/pilots", {
      name: "Copier",
      mode: "paper",
      strategy: { id: "rebalance", params: { weights: { NEAR: 0.3, BTC: 0.3 } } },
      mandate: { assets: ["NEAR", "BTC"], max_trade_usd: 1000, budget: { daily_usd: 5000 } },
      initial_usd: 1000,
    });
    const id = p.body.pilot.id as string;
    const f = await call("POST", `/v1/pilots/${id}/follow`, { token_id: "my-breakout@v1" });
    expect(f.status).toBe(200);
    expect(f.body.pilot.strategy.id).toBe("breakout");
    expect(f.body.pilot.strategy.params.entry_days).toBe(40);
    expect(f.body.pilot.following.token_id).toBe("my-breakout@v1");
    const run = (await call("POST", `/v1/pilots/${id}/run`)).body;
    expect(run.status).toBe("ok");
    expect(run.input.strategy).toBe("breakout");
    expect(run.input.params.entry_days).toBe(40);

    const research = await call("POST", `/v1/pilots/${id}/follow`, { token_id: "donchian-breakout@v1" });
    expect(research.status).toBe(409);
    expect(research.body.error ?? research.body.code).toBeTruthy();
  });
});
