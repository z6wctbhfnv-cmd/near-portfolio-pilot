import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { type Checkpoint, NftPublisher, PERIOD_MS, publishCheckpoints, scriptCodeHash } from "../src/nft.js";

const WASM = "ab".repeat(32);

/** An NFT recorder over an in-memory "chain": views answered locally, appends captured. */
class FakeNft extends NftPublisher {
  appended: Array<{ tokenId: string; cp: Checkpoint }> = [];
  constructor(
    private tokens: Record<string, string>,
    private chain: Record<string, Checkpoint[]> = {},
  ) {
    super({ contract: "nft.testnet", accountId: "recorder.testnet", privateKey: "ed25519:x", rpcUrl: "http://unused" });
  }
  override async tokenByCodeHash(h: string) {
    return this.tokens[h] ?? null;
  }
  override async record(t: string) {
    return this.chain[t] ?? [];
  }
  override async appendCheckpoint(tokenId: string, cp: Checkpoint) {
    this.appended.push({ tokenId, cp });
    (this.chain[tokenId] ??= []).push(cp);
    return `tx-${this.appended.length}`;
  }
}

async function seed() {
  const db = openDb(":memory:");
  const now = Date.now();
  const insPilot = db.prepare(
    "INSERT INTO pilots (id, name, status, mode, strategy_id, strategy_params_json, created_at, updated_at) VALUES (?, ?, 'active', 'paper', ?, '{}', ?, ?)",
  );
  await insPilot.run("p1", "one", "trend", now, now);
  await insPilot.run("p2", "two", "trend", now, now);
  await insPilot.run("p3", "three", "dca", now, now);
  const end = Math.floor(now / PERIOD_MS) * PERIOD_MS;
  const start = end - PERIOD_MS;
  const snap = db.prepare("INSERT INTO snapshots (pilot_id, ts, total_usd, holdings_json) VALUES (?, ?, ?, '{}')");
  await snap.run("p1", start - 1000, 1000);
  await snap.run("p1", end - 1000, 1100); // +10%
  await snap.run("p2", start + 1000, 500); // started mid-period
  await snap.run("p2", end - 1000, 500); // 0%
  const run = db.prepare(
    "INSERT INTO runs (id, pilot_id, started_at, engine, wasm_sha256, output_sha256, status) VALUES (?, ?, ?, 'local', ?, ?, 'ok')",
  );
  await run.run("r1", "p1", start + 5000, WASM, "11".repeat(32));
  await run.run("r2", "p2", start + 6000, WASM, "22".repeat(32));
  await run.run("r3", "p3", start + 7000, WASM, "33".repeat(32)); // dca: no NFT minted
  return { db, now, end };
}

describe("strategy NFT checkpoints", () => {
  it("binds a script to the module hash plus the strategy id", () => {
    expect(scriptCodeHash(WASM, "trend")).toMatch(/^[0-9a-f]{64}$/);
    expect(scriptCodeHash(WASM, "trend")).not.toBe(scriptCodeHash(WASM, "dca"));
    expect(scriptCodeHash(WASM.toUpperCase(), "trend")).toBe(scriptCodeHash(WASM, "trend"));
  });

  it("appends one checkpoint per minted script with the average period return", async () => {
    const { db, now, end } = await seed();
    const nft = new FakeNft({ [scriptCodeHash(WASM, "trend")]: "trend@v1" });
    const done = await publishCheckpoints(db, nft, now);
    expect(done).toEqual([{ token_id: "trend@v1", tx: "tx-1" }]);
    const cp = nft.appended[0]!.cp;
    expect(cp.period_end_ms).toBe(end);
    expect(cp.equity_index).toBe("1050000"); // (10% + 0%) / 2
    expect(cp.followers).toBe(2);
    expect(cp.code_hash).toBe(scriptCodeHash(WASM, "trend"));
    expect(cp.proofs_hash).toMatch(/^[0-9a-f]{64}$/);
    const runs = await db.prepare("SELECT id, nft_status FROM runs ORDER BY id").all();
    expect(runs).toEqual([
      { id: "r1", nft_status: "published" },
      { id: "r2", nft_status: "published" },
      { id: "r3", nft_status: null },
    ]);
  });

  it("compounds onto the last on-chain index and never repeats a period", async () => {
    const { db, now, end } = await seed();
    const prev: Checkpoint = { period_end_ms: end - PERIOD_MS, equity_index: "2000000", proofs_hash: "0".repeat(64), executions: 0, code_hash: "x", followers: 1 };
    const nft = new FakeNft({ [scriptCodeHash(WASM, "trend")]: "trend@v1" }, { "trend@v1": [prev] });
    await publishCheckpoints(db, nft, now);
    expect(nft.appended[0]!.cp.equity_index).toBe("2100000");
    await publishCheckpoints(db, nft, now);
    expect(nft.appended).toHaveLength(1);
  });

  it("does nothing without a configured recorder", async () => {
    const { db, now } = await seed();
    const nft = new NftPublisher({ rpcUrl: "http://unused" });
    expect(await publishCheckpoints(db, nft, now)).toEqual([]);
  });
});

describe("chain views over a flaky public RPC", () => {
  const answer = (v: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: "pilot", result: { result: [...Buffer.from(JSON.stringify(v))] } }), { headers: { "content-type": "application/json" } });
  const nft = (rpcUrl: string, f: typeof fetch) => new NftPublisher({ contract: "nft.testnet", rpcUrl, fetch: f });

  it("retries a rate limit and a dropped connection, alternating with the second endpoint", async () => {
    const seen: string[] = [];
    const f = (async (url: string) => {
      seen.push(String(url));
      if (seen.length === 1) return new Response("slow down", { status: 429 });
      if (seen.length === 2) throw new TypeError("fetch failed");
      return answer("holder.testnet");
    }) as unknown as typeof fetch;
    expect(await nft("https://test.rpc.fastnear.com", f).revenueReceiver("x@v1")).toBe("holder.testnet");
    expect(seen).toEqual(["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org", "https://test.rpc.fastnear.com"]);
  });

  it("treats an answer from the chain as final, and never adds an endpoint next to a private RPC", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "pilot", result: { error: "wasm execution failed with error: MethodResolveError(MethodNotFound)" } }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await expect(nft("https://test.rpc.fastnear.com", f).view("offers", { token_id: "x@v1" })).rejects.toThrow(/MethodNotFound/);
    expect(calls).toBe(1);

    const seen: string[] = [];
    const down = (async (url: string) => {
      seen.push(String(url));
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(nft("https://rpc.internal.example", down).view("offers")).rejects.toThrow(/fetch failed/);
    expect(new Set(seen)).toEqual(new Set(["https://rpc.internal.example"]));
    expect(seen).toHaveLength(4);
  });
});
