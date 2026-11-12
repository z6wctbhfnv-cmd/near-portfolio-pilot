import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WASI } from "node:wasi";
import { describe, expect, it } from "vitest";
import { backtest } from "../src/backtest.js";
import { openDb } from "../src/db.js";
import { PriceHistory } from "../src/history.js";
import { sha256Hex, StrategyWasm } from "../src/wasm.js";
import { WASM_PATH, wasmBuilt } from "./fakes.js";

const input = {
  strategy: "rebalance",
  now_ms: 1_700_000_000_000,
  params: { weights: { NEAR: 0.3, BTC: 0.3 }, band: 0.05 },
  portfolio: [
    { symbol: "BTC", units: 0.001, price: 70_000 },
    { symbol: "NEAR", units: 10, price: 4 },
    { symbol: "USDC", units: 500, price: 1 },
  ],
};

/** The same module under Node's own WASI implementation (real fds), as an independent runtime. */
async function runWithNodeWasi(json: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pilot-wasi-"));
  writeFileSync(join(dir, "in.json"), json);
  const inFd = openSync(join(dir, "in.json"), "r");
  const outFd = openSync(join(dir, "out.json"), "w");
  const wasi = new WASI({ version: "preview1", args: [], env: {}, stdin: inFd, stdout: outFd, returnOnExit: true });
  const mod = await WebAssembly.compile(readFileSync(WASM_PATH));
  const inst = await WebAssembly.instantiate(mod, wasi.getImportObject() as WebAssembly.Imports);
  wasi.start(inst);
  closeSync(inFd);
  closeSync(outFd);
  return readFileSync(join(dir, "out.json"), "utf8");
}

describe.skipIf(!wasmBuilt)("strategy wasm", () => {
  const wasm = new StrategyWasm(WASM_PATH);

  it("gives byte-identical output in our shim and in node:wasi", async () => {
    const json = JSON.stringify(input);
    const ours = wasm.run(json).stdout;
    const theirs = await runWithNodeWasi(json);
    expect(ours).toBe(theirs);
    const out = JSON.parse(ours);
    expect(out.ok).toBe(true);
    expect(out.input_sha256).toBe(sha256Hex(json));
  });

  it("is deterministic and reports errors as JSON", () => {
    expect(wasm.run(input).stdout).toBe(wasm.run(input).stdout);
    const bad = wasm.run({ strategy: "nope", now_ms: 0, portfolio: [] }).output as { ok: boolean; error: string };
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("unknown strategy");
  });

  it("backtests without look-ahead on synthetic prices", async () => {
    const db = openDb(":memory:");
    const h = new PriceHistory(db, "https://unused.test");
    const day = 86_400_000;
    const start = Math.floor(Date.now() / day) * day - 200 * day;
    // NEAR doubles linearly; the strategy may only react after the fact.
    h.load("NEAR", Array.from({ length: 200 }, (_, i) => ({ day: start + i * day, close: 2 + (i / 199) * 2 })));
    const r = await backtest(wasm, h, {
      strategy: "rebalance",
      params: { weights: { NEAR: 0.5 }, band: 0.05 },
      from: start + 10 * day,
      to: start + 199 * day,
      initial_usd: 1000,
      cost_bps: 0,
    });
    expect(r.activity.strategy_errors).toBe(0);
    expect(r.activity.trades).toBeGreaterThan(1);
    // 50/50 with rebalancing on a steady rise earns less than holding 50% NEAR untouched.
    expect(r.metrics.end_usd).toBeGreaterThan(1000);
    expect(r.metrics.end_usd).toBeLessThan(r.benchmark_hold.end_usd);
    expect(r.engine.wasm_sha256).toBe(wasm.wasmSha256);
  });
});
