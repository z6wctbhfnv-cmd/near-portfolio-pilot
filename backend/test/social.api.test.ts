/** Copying a script NFT, the referrer and price-triggered tasks, over HTTP against fakes. */
import { afterEach, describe, expect, it } from "vitest";
import { tick } from "../src/app.js";
import { buildServer } from "../src/server.js";
import { strategyForToken } from "../src/social.js";
import { testApp, wasmBuilt } from "./fakes.js";

process.env.NODE_ENV = "test";
const NFT_ENV = { STRATEGY_NFT_CONTRACT: "nft.test", NEAR_RPC_URL: "https://rpc.test" };
const NEAR_OWNER = { type: "near", account_id: "owner.near", public_key: "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp" };

const servers: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

function setup(env: Record<string, string> = {}) {
  const t = testApp({ ...NFT_ENV, ...env });
  const server = buildServer(t.app);
  servers.push(server);
  const call = async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.json() as any };
  };
  return { ...t, call };
}

async function paperPilot(call: ReturnType<typeof setup>["call"], extra: Record<string, unknown> = {}) {
  const r = await call("POST", "/v1/pilots", {
    name: "Paper",
    mode: "paper",
    strategy: { id: "rebalance", params: { weights: { NEAR: 0.3, BTC: 0.3 } } },
    mandate: { assets: ["NEAR", "BTC"], max_trade_usd: 1000, budget: { daily_usd: 5000 } },
    initial_usd: 1000,
    ...extra,
  });
  expect(r.status).toBe(201);
  return r.body.pilot.id as string;
}

describe("token → runnable strategy", () => {
  it("maps the four WASM script NFTs and nothing else", () => {
    expect(strategyForToken("wasm-rebalance@v1")).toBe("rebalance");
    expect(strategyForToken("wasm-vol-target@v2")).toBe("vol_target");
    expect(strategyForToken("donchian-breakout@v1")).toBeNull();
  });
});

describe.skipIf(!wasmBuilt)("copying a script", () => {
  it("paper pilot copies, runs the script and reports the bond gate honestly", async () => {
    const { call, chain } = setup();
    chain.holders["wasm-trend@v1"] = "author.near";
    const id = await paperPilot(call);
    const f = await call("POST", `/v1/pilots/${id}/follow`, { token_id: "wasm-trend@v1" });
    expect(f.status).toBe(200);
    expect(f.body.pilot.strategy.id).toBe("trend");
    expect(f.body.pilot.following.token_id).toBe("wasm-trend@v1");
    expect(f.body.gate.open).toBe(false); // the fake bond is $0 of $100
    expect(f.body.note).toMatch(/paper only/);
    const run = (await call("POST", `/v1/pilots/${id}/run`)).body;
    expect(run.status).toBe("ok");
    expect(run.input.strategy).toBe("trend");
    const fees = (await call("GET", `/v1/pilots/${id}/fees`)).body;
    expect(fees.following.token_id).toBe("wasm-trend@v1");
    expect(fees.estimate).toMatchObject({ payment_bps: 525 });
    expect((await call("POST", `/v1/pilots/${id}/unfollow`)).body.pilot.following).toBeNull();
  });

  it("refuses scripts the runner cannot execute and live copies, with reasons", async () => {
    const { call } = setup();
    const id = await paperPilot(call);
    const r = await call("POST", `/v1/pilots/${id}/follow`, { token_id: "donchian-breakout@v1" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("not_runnable");
    const live = await call("POST", "/v1/pilots", {
      name: "Live", mode: "live", owner: NEAR_OWNER, accepted_terms: true,
      strategy: { id: "rebalance", params: { weights: { NEAR: 0.5 } } }, mandate: { assets: ["NEAR"] },
    });
    const lid = live.body.pilot.id;
    await call("POST", `/v1/intents/${live.body.owner_action.correlation_id}/submit`, { signed_data: { standard: "nep413", payload: {}, public_key: NEAR_OWNER.public_key, signature: "ed25519:x" } });
    const lf = await call("POST", `/v1/pilots/${lid}/follow`, { token_id: "wasm-trend@v1" });
    expect(lf.status).toBe(409);
    expect(["copy_closed", "live_follow_unavailable"]).toContain(lf.body.error.code);
  });

  it("gate for any script, for the leaderboard", async () => {
    const { call, chain } = setup();
    chain.holders["wasm-dca@v1"] = "author.near";
    chain.bonds["wasm-dca@v1"] = ["150000000", "100000000"];
    const g = (await call("GET", "/v1/scripts/wasm-dca@v1/gate")).body;
    expect(g).toMatchObject({ holder: "author.near", held_usd: 150, open: true });
  });
});

describe.skipIf(!wasmBuilt)("referrer and price tasks", () => {
  it("records the referrer once", async () => {
    const { call } = setup();
    const id = await paperPilot(call);
    expect((await call("POST", `/v1/pilots/${id}/referrer`, { referrer: "Bad Name!" })).status).toBe(400);
    const r = await call("POST", `/v1/pilots/${id}/referrer`, { referrer: "friend.near" });
    expect(r.body.pilot.referrer).toBe("friend.near");
    expect((await call("POST", `/v1/pilots/${id}/referrer`, { referrer: "other.near" })).status).toBe(409);
  });

  it("fires a price task once, through the paper executor and the caps", async () => {
    const { call, app } = setup();
    const id = await paperPilot(call);
    expect((await call("POST", `/v1/pilots/${id}/tasks`, { asset: "BTC", op: "<", price: 1, side: "buy", usd: 50 })).status).toBe(201);
    const t = await call("POST", `/v1/pilots/${id}/tasks`, { asset: "BTC", op: "<", price: 1_000_000, side: "buy", usd: 50, text: "if BTC below 1M buy $50" });
    expect((await call("POST", `/v1/pilots/${id}/tasks`, { asset: "BTC", op: "<", price: 1, side: "buy", usd: 5000 })).status).toBe(400);
    await app.pilots.update(id, { next_run_at: Date.now() + 86_400_000 }); // keep the strategy out of this tick
    await tick(app);
    const tasks = (await call("GET", `/v1/pilots/${id}/tasks`)).body.data as Array<{ id: string; status: string; fired_price: number | null }>;
    const fired = tasks.find((x) => x.id === t.body.id)!;
    expect(fired.status).toBe("done");
    expect(fired.fired_price).toBeGreaterThan(0);
    expect(tasks.filter((x) => x.status === "active")).toHaveLength(1); // the BTC < $1 one waits
    const btc = (await call("GET", `/v1/pilots/${id}/portfolio`)).body.rows.find((r: { symbol: string }) => r.symbol === "BTC");
    expect(btc.usd).toBeGreaterThan(40);
    await tick(app);
    expect((await call("GET", `/v1/pilots/${id}/tasks`)).body.data.filter((x: { status: string }) => x.status === "done")).toHaveLength(1);
    const left = tasks.find((x) => x.status === "active")!;
    expect((await call("DELETE", `/v1/pilots/${id}/tasks/${left.id}`)).body.status).toBe("cancelled");
  });
});
