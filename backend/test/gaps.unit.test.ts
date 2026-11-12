/**
 * Pure parts of the gap work: fee math, the swarm coordinator, Hyperliquid signing and the perp
 * executor's limits, and the fee destination in the signed policy. No WASM, no network.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { copiedCapitalUsd, requiredBond } from "../src/copying.js";
import { openDb } from "../src/db.js";
import { computeFee, nextPeak } from "../src/fees.js";
import { actionHash, addressOf, agentDigest, floatToWire, HyperliquidTestnet, msgpack, nextNonce, signL1Action, slippagePrice } from "../src/hyperliquid.js";
import { compilePolicy, MandateSchema } from "../src/mandate.js";
import { PerpExecutor, perpTargets } from "../src/perps.js";
import { allocate, attribute, CASH, initialState, plan, rebalanceSleeves, type SwarmConfig, SwarmConfigSchema, trueUp, valueOf } from "../src/swarm.js";
import { DEFAULT_UNIVERSE } from "../src/tokens.js";
import { FakeHyperliquid } from "./fakes.js";

const USDC = DEFAULT_UNIVERSE.find((a) => a.symbol === "USDC")!.asset_id;

describe("copy fees on new profit (contract fee model)", () => {
  it("a follower pays 5% to the holder plus 0.25% to Pilot, as the contract splits it", () => {
    const c = computeFee({ equity: 11_000, hwm: 10_000, deposits: 0, holderBps: 500, payerIsHolder: false });
    expect(c.profit_usd).toBe(1000);
    expect(c.payment_bps).toBe(525);
    expect(c.fee_usd).toBe(52.5);
    // contract: holder part = amount * 500 / 525
    expect(c.holder_usd).toBe(50);
    expect(c.platform_usd).toBe(2.5);
  });

  it("the holder on its own script pays only Pilot's 0.25%; a free script pays 0.25% too", () => {
    expect(computeFee({ equity: 11_000, hwm: 10_000, deposits: 0, holderBps: 500, payerIsHolder: true })).toMatchObject({ payment_bps: 25, fee_usd: 2.5, holder_usd: 0 });
    expect(computeFee({ equity: 11_000, hwm: 10_000, deposits: 0, holderBps: 0, payerIsHolder: false })).toMatchObject({ payment_bps: 25, fee_usd: 2.5 });
    expect(computeFee({ equity: 11_000, hwm: 10_000, deposits: 0, holderBps: 1000, payerIsHolder: false }).fee_usd).toBe(102.5);
    expect(() => computeFee({ equity: 1, hwm: 1, deposits: 0, holderBps: 1001, payerIsHolder: false })).toThrow(/outside/);
  });

  it("no fee below the peak, deposits are never profit, and the peak is measured after fees", () => {
    expect(computeFee({ equity: 9_000, hwm: 10_000, deposits: 0, holderBps: 500, payerIsHolder: false }).fee_usd).toBe(0);
    // 2,000 deposited and 1,000 earned: only the 1,000 is charged.
    const c = computeFee({ equity: 13_000, hwm: 10_000, deposits: 2_000, holderBps: 500, payerIsHolder: false });
    expect(c.hwm_usd).toBe(12_000);
    expect(c.fee_usd).toBe(52.5);
    expect(nextPeak(c, 13_000, true)).toBe(12_947.5);
    // Not paid (blocked, carried): the peak stays, so the same profit is charged once, later.
    expect(nextPeak(c, 13_000, false)).toBe(12_000);
  });

  it("required bond is max($100, 1% of copiers' capital) and counts only other owners' live capital", async () => {
    expect(requiredBond(0)).toBe(100);
    expect(requiredBond(50_000)).toBe(500);
    const db = openDb(":memory:");
    const now = Date.now();
    const ins = db.prepare("INSERT INTO pilots (id, name, status, mode, owner_json, strategy_id, strategy_params_json, swarm_json, swarm_state_json, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?, '{}', ?, ?, ?, ?)");
    await ins.run("a", "a", "live", JSON.stringify({ type: "near", account_id: "copier.near" }), "trend", null, null, now, now);
    await ins.run("b", "b", "live", JSON.stringify({ type: "near", account_id: "author.near" }), "trend", null, null, now, now); // the holder's own
    await ins.run("c", "c", "paper", null, "trend", null, null, now, now); // paper money is not capital
    await ins.run("d", "d", "live", null, "rebalance", JSON.stringify({ scripts: [{ key: "t", id: "trend" }] }), JSON.stringify({ alloc: { t: 0.5 } }), now, now);
    const snap = db.prepare("INSERT INTO snapshots (pilot_id, ts, total_usd, holdings_json) VALUES (?, ?, ?, '[]')");
    for (const [id, v] of [["a", 30_000], ["b", 99_000], ["c", 99_000], ["d", 40_000]] as const) await snap.run(id, now, v);
    expect(await copiedCapitalUsd(db, "trend", "author.near")).toBe(50_000);
  });
});

describe("swarm: the main agent over several script agents", () => {
  const px = { USDC: 1, NEAR: 4, BTC: 70_000, ETH: 2_000 };
  const cfg = (over: Partial<SwarmConfig> = {}) =>
    SwarmConfigSchema.parse({ scripts: [{ key: "a", id: "rebalance", params: { weights: { NEAR: 0.5 } } }, { key: "b", id: "trend", params: { weights: { BTC: 0.5 } } }], ...over });

  it("allocates equal, manual or calm (inverse volatility), capped, the rest in cash", () => {
    expect(allocate(cfg()).alloc).toEqual({ a: 0.5, b: 0.5 });
    expect(allocate(cfg({ allocation: "manual", scripts: [{ key: "a", id: "dca", params: {}, cap: 0.6, weight: 0.3 }, { key: "b", id: "dca", params: {}, cap: 0.6, weight: 0.2 }] })).alloc).toEqual({ a: 0.3, b: 0.2 });
    const calm = allocate(cfg({ allocation: "calm" }), { a: 0.2, b: 0.6 });
    expect(calm.alloc.a).toBeCloseTo(0.6, 6); // capped at 0.6 (would be 0.75)
    expect(calm.alloc.b).toBeCloseTo(0.25, 6);
    expect(calm.reason).toMatch(/capped a/);
    expect(() => SwarmConfigSchema.parse({ scripts: [{ key: "a", id: "dca" }, { key: "a", id: "trend" }] })).toThrow(/unique/);
    expect(() => SwarmConfigSchema.parse({ allocation: "manual", scripts: [{ key: "a", id: "dca", weight: 0.8 }, { key: "b", id: "dca", weight: 0.5 }] })).toThrow(/at most 1/);
  });

  it("sleeves are books over one wallet: reallocation moves books, never the totals", () => {
    const st = initialState(cfg(), { USDC: 1000, NEAR: 50 }, px, 0);
    const total = (a: string) => Object.values(st.sleeves).reduce((t, s) => t + (s.units[a] ?? 0), 0);
    expect(total("USDC")).toBeCloseTo(1000, 9);
    expect(total("NEAR")).toBeCloseTo(50, 9);
    expect(valueOf(st.sleeves.a!.units, px)).toBeCloseTo(600, 6);
    expect(valueOf(st.sleeves[CASH]!.units, px)).toBeCloseTo(0, 6);
    const re = rebalanceSleeves(st.sleeves, { a: 0.2, b: 0.3 }, px);
    expect(valueOf(re.a!.units, px)).toBeCloseTo(240, 6);
    expect(valueOf(re[CASH]!.units, px)).toBeCloseTo(600, 6);
    expect(Object.values(re).reduce((t, s) => t + (s.units.NEAR ?? 0), 0)).toBeCloseTo(50, 9);
  });

  it("true-up: the wallet is the truth; new money lands in cash", () => {
    const s = trueUp({ a: { units: { USDC: 300, NEAR: 10 }, state: 1 }, b: { units: { USDC: 100 }, state: 2 } }, { USDC: 200, NEAR: 10, ETH: 1 });
    expect(s.a!.units.USDC).toBeCloseTo(150);
    expect(s.b!.units.USDC).toBeCloseTo(50);
    expect(s[CASH]!.units.ETH).toBe(1);
    expect(s.a!.state).toBe(1);
  });

  it("crosses opposite wishes inside the wallet and sends only the net", () => {
    const p = plan([
      { key: "a", trades: [{ sell: "NEAR", buy: "USDC", usd: 100 }] },
      { key: "b", trades: [{ sell: "USDC", buy: "NEAR", usd: 60 }, { sell: "USDC", buy: "BTC", usd: 50 }] },
    ]);
    // a sells $100 of NEAR, b buys $60 of it: $60 never leaves the wallet. USDC: a brings 100, b spends 110.
    expect(p.crossed.NEAR).toBe(60);
    expect(p.crossed.USDC).toBe(100);
    // Only the net goes out, asset to asset: $40 of NEAR and $10 of USDC into the $50 of BTC b wants.
    expect(p.trades).toEqual([
      { sell: "NEAR", buy: "BTC", usd: 40 },
      { sell: "USDC", buy: "BTC", usd: 10 },
    ]);
    expect(p.reasons.join(" ")).toMatch(/NEAR: b \+\$60.00 against a -\$100.00/);
  });

  it("drops what the signed policy does not allow, with a reason", () => {
    const p = plan([{ key: "a", trades: [{ sell: "USDC", buy: "ZEC", usd: 20 }, { sell: "USDC", buy: "NEAR", usd: 20 }] }], { allowed: new Set(["USDC", "NEAR"]) });
    expect(p.trades).toEqual([{ sell: "USDC", buy: "NEAR", usd: 20 }]);
    expect(p.dropped[0]!.reason).toMatch(/does not allow ZEC/);
  });

  it("books crossed amounts and market fills back to the scripts that asked", () => {
    const sleeves = { a: { units: { NEAR: 100, USDC: 0 }, state: null }, b: { units: { USDC: 400 }, state: null } };
    const wants = [
      { key: "a", trades: [{ sell: "NEAR", buy: "USDC", usd: 400 }] }, // all of a's NEAR
      { key: "b", trades: [{ sell: "USDC", buy: "NEAR", usd: 100 }] },
    ];
    const p = plan(wants);
    expect(p.trades).toEqual([{ sell: "NEAR", buy: "USDC", usd: 300 }]);
    // The market filled the 300 at a 1% cost: 75 NEAR out, 297 USDC in.
    const after = { NEAR: 25, USDC: 697 };
    const s = attribute(sleeves, p, { NEAR: -75, USDC: 297 }, px, after);
    expect(s.a!.units.NEAR ?? 0).toBeCloseTo(0, 9);
    expect(s.a!.units.USDC).toBeCloseTo(100 + 297, 6); // crossed 100 from b + its market fill
    expect(s.b!.units.NEAR).toBeCloseTo(25, 9); // crossed, at the market price, no cost
    expect(s.b!.units.USDC).toBeCloseTo(300, 6);
  });
});

describe("Hyperliquid testnet signing (vectors from the official Python SDK)", () => {
  const v = JSON.parse(readFileSync(new URL("./hl-vectors.json", import.meta.url), "utf8")) as {
    address: string;
    cases: Array<{ name: string; action: unknown; nonce: number; hash: string; signature: { r: string; s: string; v: number } }>;
  };
  const KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";

  it("derives the address, hashes and signs exactly like the SDK", () => {
    expect(addressOf(KEY).toLowerCase()).toBe(v.address.toLowerCase());
    for (const c of v.cases) {
      expect("0x" + Buffer.from(actionHash(c.action, c.nonce)).toString("hex")).toBe(c.hash);
      expect(signL1Action(KEY, c.action, c.nonce)).toEqual(c.signature);
    }
  });

  it("signs for testnet only: the signature recovers to the key on the testnet digest", () => {
    const c = v.cases[0]!;
    const sig = signL1Action(KEY, c.action, c.nonce);
    const s = secp256k1.Signature.fromHex(BigInt(sig.r).toString(16).padStart(64, "0") + BigInt(sig.s).toString(16).padStart(64, "0"), "compact").addRecoveryBit(sig.v - 27);
    const pub = s.recoverPublicKey(agentDigest(actionHash(c.action, c.nonce), "b")).toBytes(false);
    expect(pub).toEqual(secp256k1.getPublicKey(Buffer.from(KEY.slice(2), "hex"), false));
  });

  it("never reuses a nonce, even within one millisecond", () => {
    const a = nextNonce(5_000_000_000_000);
    expect(nextNonce(5_000_000_000_000)).toBe(a + 1);
    expect(nextNonce(4_000_000_000_000)).toBe(a + 2);
  });

  it("writes numbers like the SDK", () => {
    expect(floatToWire(70700)).toBe("70700");
    expect(floatToWire(0.0012)).toBe("0.0012");
    expect(floatToWire(-0)).toBe("0");
    expect(() => floatToWire(0.123456789)).toThrow(/8 decimals/);
    expect(slippagePrice(70_000, true, 0.01, 5)).toBe(70700);
    expect(slippagePrice(3.98765, false, 0.01, 1)).toBe(3.9478);
    expect(Buffer.from(msgpack({ a: 1, b: [true, null], c: "x" })).toString("hex")).toBe("83a16101a16292c3c0a163a178");
  });
});

describe("perp executor (Hyperliquid testnet fake)", () => {
  function setup(opts: { key?: boolean; builder?: string } = {}) {
    const fake = new FakeHyperliquid();
    const f = (async (input: string | URL | Request, init: RequestInit = {}) => fake.handle(new URL(String(input)), init)) as typeof fetch;
    const hl = new HyperliquidTestnet({ privateKey: opts.key === false ? undefined : "0x" + "11".repeat(32), builder: opts.builder, fetch: f, ...(opts.key === false ? { accountAddress: "0x" + "22".repeat(20) } : {}) });
    const db = openDb(":memory:");
    const ex = new PerpExecutor({ db, hl, maxLeverage: 1, maxOrderUsd: 200, slippage: 0.01 });
    return { fake, hl, db, ex };
  }

  it("reads perp keys from target weights", () => {
    expect(perpTargets({ NEAR: 0.5, "BTC-PERP": -0.2, "ETH-PERP": Number.NaN })).toEqual({ BTC: -0.2 });
  });

  it("caps a new position per order, signs with a cloid and the builder fee", async () => {
    const { fake, ex } = setup({ builder: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD" });
    const rows = await ex.rebalance("p1", "r1", { BTC: 0.5 }, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("filled");
    expect(rows[0]!.usd).toBe(200); // $500 wanted, $200 per order
    const o = fake.orders[0]!;
    expect(o.action.builder).toEqual({ b: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", f: 50 });
    expect(o.action.orders[0]!.c).toBe(rows[0]!.cloid);
    expect(o.action.orders[0]!).toMatchObject({ a: 0, b: true, s: "0.00286", r: false });
    expect(o.signature.r).toMatch(/^0x[0-9a-f]+$/);
  });

  it("keeps gross exposure within the leverage limit, but always lets a position shrink", async () => {
    const { fake, ex } = setup();
    fake.positions = { ETH: 0.45 }; // $900 of $1000 equity at 1x
    const rows = await ex.rebalance("p1", "r1", { ETH: 0.9, SOL: 0.5 }, null); // keep ETH, add SOL
    const sol = rows.find((r) => r.coin === "SOL")!;
    expect(sol.status).toBe("filled");
    expect(sol.usd).toBeCloseTo(100, 0); // only $100 of room left
    fake.positions = { ETH: 0.45 };
    const close = await ex.rebalance("p1", "r2", { ETH: -0.0 }, 50);
    expect(close[0]).toMatchObject({ coin: "ETH", status: "filled" });
    expect(fake.orders.at(-1)!.action.orders[0]!).toMatchObject({ b: false, r: true, s: "0.45" }); // $900 out, above every cap
  });

  it("without a key it checks and stores the order but sends nothing", async () => {
    const { fake, ex } = setup({ key: false });
    const rows = await ex.rebalance("p1", null, { NEAR: 0.1 }, null);
    expect(rows[0]).toMatchObject({ status: "blocked", error_code: "no_key" });
    expect(fake.orders).toHaveLength(0);
  });

  it("a lost answer is looked up by cloid, never sent twice", async () => {
    const { fake, ex, db } = setup();
    fake.failNext = "transport";
    const rows = await ex.rebalance("p1", null, { NEAR: 0.1 }, null);
    expect(rows[0]!.status).toBe("unknown");
    expect(fake.orders).toHaveLength(1);
    await ex.reconcile();
    expect((await ex.get(rows[0]!.id))!.status).toBe("filled");
    expect(fake.orders).toHaveLength(1);
    // A cloid the venue never saw becomes an error after two minutes: safe to try again later.
    await db.prepare("INSERT INTO perp_orders (id, pilot_id, cloid, coin, usd, request_json, status, created_at, updated_at) VALUES ('x', 'p1', '0xdead', 'BTC', 10, '{}', 'unknown', 0, 0)").run();
    await ex.reconcile();
    expect((await ex.get("x"))!).toMatchObject({ status: "error", error_code: "never_reached" });
  });
});

describe("signed policy with the fee destination", () => {
  const tokens = DEFAULT_UNIVERSE.map((u) => ({ asset_id: u.asset_id, symbol: u.symbol, decimals: 6, price: 1 })) as never;
  it("adds exactly one way out: a USDC withdraw to the NFT contract, no memo", () => {
    const m = MandateSchema.parse({ assets: ["NEAR"], stable: "USDT" });
    const without = compilePolicy(m, tokens).policy;
    expect(without.actions).toEqual(["swap"]);
    expect(without.destinations).toEqual({ mode: "only", list: [] });
    const withFee = compilePolicy(m, tokens, { fee: { contract: "dolya-nft.near", assetId: USDC } }).policy;
    expect(withFee.actions).toEqual(["swap", "withdraw"]);
    expect(withFee.destinations).toEqual({ mode: "only", list: [{ action: "withdraw", chain: "near", address: "dolya-nft.near", memo: null }] });
    expect(withFee.assets).toContain(USDC);
    expect(Object.keys(withFee.limits.per_transaction ?? {})).toContain(USDC);
  });
});
