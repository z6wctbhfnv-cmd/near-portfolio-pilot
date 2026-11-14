/**
 * Hyperliquid TESTNET client: reads (meta, mids, account) and signed IOC orders.
 *
 * Testnet only, by construction: the URL is fixed and every action is signed with the testnet
 * source ("b"); there is no mainnet switch. The key should be a Hyperliquid API wallet, which can
 * trade for the account but cannot withdraw, so "nothing leaves the wallet" also holds for perps.
 *
 * Signing follows the official Python SDK (hyperliquid/utils/signing.py): the action is msgpack
 * encoded, followed by the nonce and a vault flag, keccak-hashed, and signed as the EIP-712 "Agent"
 * phantom message on domain {name: "Exchange", version: "1", chainId: 1337}. Tests check our
 * hash and signature against vectors produced by that SDK (test/hyperliquid.test.ts).
 *
 * Builder code: with HL_BUILDER_ADDRESS set, each order carries {b, f: 50}, a 0.05% fee to Pilot's
 * builder address. Hyperliquid charges it only after the account approves that builder once
 * (approveBuilderFee, signed by the main wallet, not the API wallet); until then orders with a
 * builder are refused, so the builder stays unset unless the approval is done.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

export const HL_TESTNET_URL = "https://api.hyperliquid-testnet.xyz";
/** Pilot's builder fee on perps, in tenths of a basis point: 50 = 0.05%. Hyperliquid's cap is 0.1%. */
export const BUILDER_FEE_TENTHS_BPS = 50;

// ------------------------------------------------------------------ msgpack (the subset actions use)

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function be(n: number | bigint, bytes: number) {
  const out = new Uint8Array(bytes);
  let v = BigInt(n);
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** msgpack as Python's `msgpack.packb` writes it for actions: maps keep insertion order. */
export function msgpack(v: unknown): Uint8Array {
  if (v === null || v === undefined) return Uint8Array.of(0xc0);
  if (v === true) return Uint8Array.of(0xc3);
  if (v === false) return Uint8Array.of(0xc2);
  if (typeof v === "number" || typeof v === "bigint") {
    if (typeof v === "number" && !Number.isInteger(v)) throw new Error("floats are not used in actions: send prices and sizes as strings");
    const n = BigInt(v);
    if (n >= 0n) {
      if (n < 128n) return Uint8Array.of(Number(n));
      if (n < 256n) return concat([Uint8Array.of(0xcc), be(n, 1)]);
      if (n < 65_536n) return concat([Uint8Array.of(0xcd), be(n, 2)]);
      if (n < 4_294_967_296n) return concat([Uint8Array.of(0xce), be(n, 4)]);
      return concat([Uint8Array.of(0xcf), be(n, 8)]);
    }
    if (n >= -32n) return Uint8Array.of(Number(n & 0xffn));
    if (n >= -128n) return concat([Uint8Array.of(0xd0), be(n & 0xffn, 1)]);
    if (n >= -32_768n) return concat([Uint8Array.of(0xd1), be(n & 0xffffn, 2)]);
    if (n >= -2_147_483_648n) return concat([Uint8Array.of(0xd2), be(n & 0xffffffffn, 4)]);
    return concat([Uint8Array.of(0xd3), be(n & 0xffffffffffffffffn, 8)]);
  }
  if (typeof v === "string") {
    const b = new TextEncoder().encode(v);
    const head = b.length < 32 ? Uint8Array.of(0xa0 | b.length) : b.length < 256 ? Uint8Array.of(0xd9, b.length) : b.length < 65_536 ? concat([Uint8Array.of(0xda), be(b.length, 2)]) : concat([Uint8Array.of(0xdb), be(b.length, 4)]);
    return concat([head, b]);
  }
  if (Array.isArray(v)) {
    const head = v.length < 16 ? Uint8Array.of(0x90 | v.length) : v.length < 65_536 ? concat([Uint8Array.of(0xdc), be(v.length, 2)]) : concat([Uint8Array.of(0xdd), be(v.length, 4)]);
    return concat([head, ...v.map(msgpack)]);
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    const n = entries.length;
    const head = n < 16 ? Uint8Array.of(0x80 | n) : n < 65_536 ? concat([Uint8Array.of(0xde), be(n, 2)]) : concat([Uint8Array.of(0xdf), be(n, 4)]);
    return concat([head, ...entries.flatMap(([k, x]) => [msgpack(k), msgpack(x)])]);
  }
  throw new Error(`cannot msgpack ${typeof v}`);
}

// ------------------------------------------------------------------ numbers on the wire

/** The SDK's float_to_wire: at most 8 decimals, no trailing zeros, never "-0". */
export function floatToWire(x: number): string {
  const rounded = x.toFixed(8);
  if (Math.abs(Number(rounded) - x) >= 1e-12) throw new Error(`${x} needs more than 8 decimals`);
  if (Number(rounded) === 0) return "0";
  return rounded.replace(/\.?0+$/, "");
}

/** A marketable IOC price: mid moved by the slippage, 5 significant figures, at most 6 - szDecimals decimals. */
export function slippagePrice(mid: number, isBuy: boolean, slippage: number, szDecimals: number): number {
  const px = mid * (isBuy ? 1 + slippage : 1 - slippage);
  const sig = Number(px.toPrecision(5));
  const d = Math.max(0, 6 - szDecimals);
  return Number(sig.toFixed(d));
}

// ------------------------------------------------------------------ signing

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fromHex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const utf8 = (s: string) => new TextEncoder().encode(s);

/** keccak256(msgpack(action) ‖ nonce (8 bytes, big-endian) ‖ vault flag [‖ vault address]). */
export function actionHash(action: unknown, nonce: number, vaultAddress: string | null = null): Uint8Array {
  const vault = vaultAddress ? concat([Uint8Array.of(1), fromHex(vaultAddress)]) : Uint8Array.of(0);
  return keccak_256(concat([msgpack(action), be(nonce, 8), vault]));
}

const DOMAIN_TYPE = keccak_256(utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
const AGENT_TYPE = keccak_256(utf8("Agent(string source,bytes32 connectionId)"));
const DOMAIN_SEPARATOR = keccak_256(concat([DOMAIN_TYPE, keccak_256(utf8("Exchange")), keccak_256(utf8("1")), be(1337, 32), new Uint8Array(32)]));

/** The EIP-712 digest of the phantom agent for a testnet ("b") action hash. */
export function agentDigest(hash: Uint8Array, source: "a" | "b" = "b"): Uint8Array {
  const struct = keccak_256(concat([AGENT_TYPE, keccak_256(utf8(source)), hash]));
  return keccak_256(concat([Uint8Array.of(0x19, 0x01), DOMAIN_SEPARATOR, struct]));
}

/** Python's eth_utils.to_hex(int): no zero padding. */
const intHex = (b: Uint8Array) => "0x" + (BigInt("0x" + hex(b)).toString(16) || "0");

export type HlSignature = { r: string; s: string; v: number };

/** Signs an L1 action for TESTNET. */
export function signL1Action(privateKey: string, action: unknown, nonce: number): HlSignature {
  const digest = agentDigest(actionHash(action, nonce), "b");
  const sig = secp256k1.sign(digest, fromHex(privateKey), { prehash: false, format: "recovered" });
  return { r: intHex(sig.slice(1, 33)), s: intHex(sig.slice(33, 65)), v: 27 + sig[0]! };
}

export function addressOf(privateKey: string): string {
  const pub = secp256k1.getPublicKey(fromHex(privateKey), false);
  return "0x" + hex(keccak_256(pub.slice(1)).slice(12));
}

// ------------------------------------------------------------------ client

export type OrderWire = { a: number; b: boolean; p: string; s: string; r: boolean; t: { limit: { tif: "Ioc" | "Gtc" | "Alo" } }; c?: string };
export type AccountState = { equity: number; gross_notional: number; positions: Record<string, number> };
export type OrderStatus = { kind: "filled"; total_sz: number; avg_px: number; oid: number } | { kind: "resting"; oid: number } | { kind: "error"; error: string };

let lastNonce = 0;
/** Millisecond nonces that never repeat, even for two orders in the same millisecond. */
export function nextNonce(now = Date.now()) {
  lastNonce = Math.max(now, lastNonce + 1);
  return lastNonce;
}

export class HyperliquidTestnet {
  readonly url = HL_TESTNET_URL;
  private metaCache: { at: number; universe: Array<{ name: string; szDecimals: number }> } | null = null;

  constructor(
    private readonly opts: { privateKey?: string; accountAddress?: string; builder?: string; fetch?: typeof fetch },
  ) {}

  get canTrade() {
    return Boolean(this.opts.privateKey);
  }

  /** The account traded for: the configured address, else the key's own address. */
  get user(): string | null {
    return this.opts.accountAddress?.toLowerCase() ?? (this.opts.privateKey ? addressOf(this.opts.privateKey) : null);
  }

  get builder() {
    return this.opts.builder ? { b: this.opts.builder.toLowerCase(), f: BUILDER_FEE_TENTHS_BPS } : null;
  }

  private async post<T>(path: "/info" | "/exchange", body: unknown): Promise<T> {
    const res = await (this.opts.fetch ?? fetch)(`${this.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Hyperliquid ${path} ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  }

  async meta() {
    if (this.metaCache && Date.now() - this.metaCache.at < 600_000) return this.metaCache.universe;
    const m = await this.post<{ universe: Array<{ name: string; szDecimals: number }> }>("/info", { type: "meta" });
    this.metaCache = { at: Date.now(), universe: m.universe };
    return m.universe;
  }

  async mids(): Promise<Record<string, number>> {
    const m = await this.post<Record<string, string>>("/info", { type: "allMids" });
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Number(v)]));
  }

  async account(): Promise<AccountState> {
    if (!this.user) throw new Error("no Hyperliquid account configured");
    const s = await this.post<{ marginSummary: { accountValue: string; totalNtlPos: string }; assetPositions: Array<{ position: { coin: string; szi: string } }> }>("/info", {
      type: "clearinghouseState",
      user: this.user,
    });
    return {
      equity: Number(s.marginSummary.accountValue),
      gross_notional: Number(s.marginSummary.totalNtlPos),
      positions: Object.fromEntries(s.assetPositions.map((p) => [p.position.coin, Number(p.position.szi)])),
    };
  }

  /** Status of an order by its client order id (cloid); null when Hyperliquid never saw it. */
  async orderByCloid(cloid: string): Promise<{ status: string } | null> {
    if (!this.user) throw new Error("no Hyperliquid account configured");
    const r = await this.post<{ status: string; order?: { status: string } }>("/info", { type: "orderStatus", user: this.user, oid: cloid });
    return r.status === "order" && r.order ? { status: r.order.status } : null;
  }

  /** The order action the SDK would build, with our builder fee when one is configured. */
  orderAction(wire: OrderWire) {
    return { type: "order", orders: [wire], grouping: "na", ...(this.builder ? { builder: this.builder } : {}) };
  }

  /** Signs and sends one order. */
  async placeOrder(wire: OrderWire, nonce = nextNonce()): Promise<OrderStatus> {
    if (!this.opts.privateKey) throw new Error("HL_TESTNET_PRIVATE_KEY is not set");
    const action = this.orderAction(wire);
    const signature = signL1Action(this.opts.privateKey, action, nonce);
    const r = await this.post<{ status: string; response: unknown }>("/exchange", { action, nonce, signature, vaultAddress: null, expiresAfter: null });
    if (r.status !== "ok") return { kind: "error", error: typeof r.response === "string" ? r.response : JSON.stringify(r.response) };
    const st = (r.response as { data?: { statuses?: Array<Record<string, { totalSz?: string; avgPx?: string; oid?: number }> | { error: string }> } }).data?.statuses?.[0];
    if (!st) return { kind: "error", error: "no order status in the answer" };
    if ("error" in st && typeof st.error === "string") return { kind: "error", error: st.error };
    const s = st as Record<string, { totalSz?: string; avgPx?: string; oid?: number }>;
    if (s.filled) return { kind: "filled", total_sz: Number(s.filled.totalSz), avg_px: Number(s.filled.avgPx), oid: s.filled.oid ?? 0 };
    if (s.resting) return { kind: "resting", oid: s.resting.oid ?? 0 };
    return { kind: "error", error: `unknown order status ${JSON.stringify(st)}` };
  }
}
