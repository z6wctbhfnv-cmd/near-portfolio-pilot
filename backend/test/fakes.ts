/**
 * In-process fakes for every outside service: the NEAR Intents Agent API, Binance klines and
 * NEAR AI. They follow the documented shapes and rules closely enough to test our side of each
 * contract (idempotency keys, error codes, statuses) without touching mainnet.
 */
import { existsSync } from "node:fs";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { DEFAULT_UNIVERSE } from "../src/tokens.js";
import { StrategyWasm } from "../src/wasm.js";

export const WASM_PATH = new URL("../../strategies/target/wasm32-wasip1/release/pilot-strategies.wasm", import.meta.url).pathname;
export const wasmBuilt = existsSync(WASM_PATH);

const PRICES: Record<string, number> = { USDC: 1, USDT: 1, NEAR: 4, BTC: 70_000, ETH: 2_000, SOL: 100, ZEC: 500 };
const DECIMALS: Record<string, number> = { USDC: 6, USDT: 6, NEAR: 24, BTC: 8, ETH: 18, SOL: 9, ZEC: 8 };

export type SwapCall = { body: Record<string, unknown>; idempotencyKey: string | null; grant: string | null };

export class FakeAgentApi {
  prices = { ...PRICES };
  calls: Array<{ method: string; path: string }> = [];
  swaps: SwapCall[] = [];
  /** Responses already given per Idempotency-Key (the API replays them). */
  replay = new Map<string, unknown>();
  intents = new Map<string, { type: string; status: string; agent_id?: string; body: Record<string, unknown> }>();
  ops = new Map<string, { status: string }>();
  policy = { status: "APPLIED", synced: true, frozen: false, revision: 1 };
  network = "operational";
  balances: Record<string, string> = {};
  /** Queue of failures for the next live swaps: an Agent API error code with HTTP status and retryable flag. */
  failNextSwaps: Array<{ status: number; code: string; retryable?: boolean }> = [];
  /** Withdraw calls (fee payments): body, key, grant; previews are recorded with dry: true. */
  withdraws: SwapCall[] = [];
  failNextWithdraws: Array<{ status: number; code: string; retryable?: boolean }> = [];
  withdrawWarnings: Array<{ code: string; detail: string }> = [];
  /** Overrides merged into the policy the API reports (e.g. actions and destinations). */
  policyExtra: Record<string, unknown> = {};
  /** GET /v1/agents/{id}/history entries, newest first. */
  history: Array<Record<string, unknown>> = [];
  quoteWarnings: Array<{ code: string; detail: string }> = [];
  nextOpStatus = "PROCESSING";
  /** Simulates the Agent API host being down for the public token list. */
  tokensDown = false;
  seq = 0;

  token(symbol: string) {
    const u = DEFAULT_UNIVERSE.find((a) => a.symbol === symbol)!;
    return {
      asset_id: u.asset_id,
      symbol,
      decimals: DECIMALS[symbol]!,
      blockchain: "near",
      price: this.prices[symbol]!,
      price_updated_at: new Date().toISOString(),
      price_expires_at: new Date(Date.now() + 600_000).toISOString(),
    };
  }

  private err(status: number, code: string, retryable = false) {
    return new Response(
      JSON.stringify({ errors: [{ status: String(status), code, layer: "api", title: code, ...(retryable ? { meta: { retryable: true } } : {}) }], meta: { request_id: "req" } }),
      { status, headers: { "content-type": "application/json" } },
    );
  }

  private ok(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  private statusBody(cid: string, type: string, status: string, extra: Record<string, unknown> = {}) {
    return {
      correlation_id: cid,
      agent_id: "agent_1",
      status,
      failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      dispatch_committed_at: null,
      grant: null,
      type,
      details: {},
      ...extra,
    };
  }

  async handle(url: URL, init: RequestInit): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.pathname;
    this.calls.push({ method, path });
    const headers = new Headers(init.headers);
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (path === "/v1/tokens") return this.tokensDown ? this.err(503, "provider_unavailable") : this.ok({ data: DEFAULT_UNIVERSE.map((u) => this.token(u.symbol)) });
    if (path === "/v1/network") {
      return this.ok({
        network: "mainnet",
        contract_id: "outlayer.near",
        supported_owner_types: ["near", "evm", "passkey"],
        status: {
          overall: this.network,
          checked_at: new Date().toISOString(),
          components: ["one_click", "custody", "near"].map((id) => ({ id, status: this.network, reason: null, affects: [], since: "", checked_at: "" })),
        },
      });
    }
    if (!headers.get("x-api-key")) return this.err(401, "invalid_api_key");

    if (path === "/v1/generate-intent" && method === "POST") {
      const cid = `intent_${++this.seq}`;
      const agentId = body.type === "agent_create" ? "agent_1" : (body.agent_id as string | undefined);
      this.intents.set(cid, { type: String(body.type), status: "PENDING_SIGNATURE", agent_id: agentId, body });
      return this.ok({
        type: body.type,
        correlation_id: cid,
        agent_id: agentId,
        signer: "owner.near",
        intent: { standard: "nep413", payload: { message: "sign me", recipient: "agentsonintents", nonce: "AAAA" } },
        preview: { summary: "Create agent… Risk notice: you may lose all assets.", policy: body.policy ?? null },
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
    }
    if (path === "/v1/submit-intent" && method === "POST") {
      const it = this.intents.get(String(body.correlation_id));
      if (!it) return this.err(404, "not_found");
      it.status = "SUCCESS";
      return this.ok(this.statusBody(String(body.correlation_id), it.type, "PROCESSING"));
    }
    if (path === "/v1/status") {
      const cid = url.searchParams.get("correlation_id")!;
      const it = this.intents.get(cid);
      if (it) return this.ok(this.statusBody(cid, it.type, it.status, it.type === "agent_create" ? { details: { agent_id: "agent_1" } } : {}));
      const op = this.ops.get(cid);
      if (op) return this.ok(this.statusBody(cid, "swap", op.status));
      return this.err(404, "not_found");
    }
    const m = path.match(/^\/v1\/agents\/([^/]+)(\/.*)?$/);
    if (m) {
      const sub = m[2] ?? "";
      if (sub === "/policy") {
        return this.ok({
          wallet_id: "w",
          revision: this.policy.revision,
          policy_hash: "h",
          status: this.policy.status,
          applied_at: null,
          transaction_hash: null,
          provider_policy_synced: this.policy.synced,
          cooldowns: { policy_change_available_at: null, unfreeze_available_at: null },
          policy: { frozen: this.policy.frozen, actions: ["swap"], assets: "any", destinations: { mode: "only", list: [] }, ...this.policyExtra },
          usage: {
            budget: {
              daily: { limit_usd: "100.00", spent_usd: "0", remaining_usd: "100.00", resets_at: null },
              weekly: { limit_usd: null, spent_usd: null, remaining_usd: null, resets_at: null },
              monthly: { limit_usd: null, spent_usd: null, remaining_usd: null, resets_at: null },
            },
            timelock: { delay_ms: 0, scheduled_count: 0 },
          },
        });
      }
      if (sub === "/balances") {
        return this.ok({
          source: "public",
          balances: Object.entries(this.balances).map(([sym, raw]) => {
            const t = this.token(sym);
            return { asset_id: t.asset_id, symbol: sym, decimals: t.decimals, balance_raw: raw, balance: (Number(raw) / 10 ** t.decimals).toString(), available_raw: raw, available: null };
          }),
        });
      }
      if (sub === "/swap" && method === "POST") {
        if (body.dry) {
          const from = DEFAULT_UNIVERSE.find((u) => u.asset_id === body.origin_asset)!;
          const to = DEFAULT_UNIVERSE.find((u) => u.asset_id === body.destination_asset)!;
          const usd = (Number(body.amount) / 10 ** DECIMALS[from.symbol]!) * this.prices[from.symbol]!;
          const out = BigInt(Math.floor(((usd * 0.997) / this.prices[to.symbol]!) * 10 ** Math.min(DECIMALS[to.symbol]!, 15))) * 10n ** BigInt(Math.max(0, DECIMALS[to.symbol]! - 15));
          return this.ok({
            dry: true,
            type: "swap",
            quote: { amountIn: body.amount, amountOut: out.toString(), amountInUsd: usd.toFixed(2) },
            spend: { amount_usd: usd.toFixed(2), budget: {} },
            owner_approval: false,
            fee: { amount_usd: (usd * 0.003).toFixed(2), percent: "0.3" },
            warnings: this.quoteWarnings,
          });
        }
        const key = headers.get("idempotency-key");
        this.swaps.push({ body, idempotencyKey: key, grant: headers.get("x-grant-token") });
        if (key && this.replay.has(key)) return this.ok(this.replay.get(key), 202);
        const fail = this.failNextSwaps.shift();
        if (fail) return this.err(fail.status, fail.code, fail.retryable);
        const cid = `op_${++this.seq}`;
        this.ops.set(cid, { status: this.nextOpStatus });
        const res = this.statusBody(cid, "swap", this.nextOpStatus);
        if (key) this.replay.set(key, res);
        return this.ok(res, 202);
      }
      if (sub === "/withdraw" && method === "POST") {
        const key = headers.get("idempotency-key");
        this.withdraws.push({ body, idempotencyKey: key, grant: headers.get("x-grant-token") });
        if (body.dry) {
          const usd = Number(body.amount) / 1e6;
          return this.ok({ dry: true, type: "withdraw", quote: { amount_out: body.amount }, spend: { amount_usd: usd.toFixed(2), budget: {} }, fee: null, warnings: this.withdrawWarnings });
        }
        if (key && this.replay.has(key)) return this.ok(this.replay.get(key), 202);
        const fail = this.failNextWithdraws.shift();
        if (fail) return this.err(fail.status, fail.code, fail.retryable);
        const cid = `op_${++this.seq}`;
        this.ops.set(cid, { status: this.nextOpStatus });
        const res = this.statusBody(cid, "withdraw", this.nextOpStatus);
        if (key) this.replay.set(key, res);
        return this.ok(res, 202);
      }
      if (sub === "/history") return this.ok({ data: this.history, next_cursor: null });
      if (sub === "") return this.ok({ id: m[1], name: "x", status: "ACTIVE", wallet: { near_account_id: "agent1.near" } });
    }
    return this.err(404, "not_found");
  }
}

/** Synthetic Binance klines: a smooth up-and-down path per symbol. */
export function fakeKlines(url: URL): Response {
  if (url.pathname.endsWith("/ticker/price")) {
    const symbols = JSON.parse(url.searchParams.get("symbols") ?? "[]") as string[];
    const spot: Record<string, number> = { NEARUSDT: 4, BTCUSDT: 70_000, ETHUSDT: 2_000, SOLUSDT: 100, ZECUSDT: 500 };
    return new Response(JSON.stringify(symbols.map((s) => ({ symbol: s, price: String(spot[s] ?? 1) }))), { headers: { "content-type": "application/json" } });
  }
  const symbol = url.searchParams.get("symbol")!;
  const start = Number(url.searchParams.get("startTime"));
  const base = { NEARUSDT: 4, BTCUSDT: 70_000, ETHUSDT: 2_000, SOLUSDT: 100, ZECUSDT: 500 }[symbol] ?? 1;
  const day = 86_400_000;
  const today = Math.floor(Date.now() / day) * day;
  const rows = [];
  for (let t = Math.floor(start / day) * day; t <= today && rows.length < 1000; t += day) {
    const i = t / day;
    const close = base * (1 + 0.3 * Math.sin(i / 20) + 0.05 * Math.sin(i / 3));
    rows.push([t, "0", "0", "0", String(close), "0", t + day - 1]);
  }
  return new Response(JSON.stringify(rows), { headers: { "content-type": "application/json" } });
}

export class FakeNearAi {
  answers: unknown[] = [];
  requests: unknown[] = [];
  handle(_url: URL, init: RequestInit): Response {
    this.requests.push(JSON.parse(String(init.body)));
    const next = this.answers.shift() ?? { summary: "Quiet week.", risk_flags: [], proposals: [] };
    const content = typeof next === "string" ? next : JSON.stringify(next);
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { "content-type": "application/json" } });
  }
}

/** OutLayer stand-in: runs the posted input through the same WASM and answers like /call does. */
export class FakeOutLayer {
  calls: Array<{ path: string; paymentKey: string | null; input: unknown }> = [];
  failWith: { status: number; reason: string } | null = null;
  private wasm = new StrategyWasm(WASM_PATH);
  handle(url: URL, init: RequestInit): Response {
    const headers = new Headers(init.headers);
    if (url.pathname.startsWith("/attestations/by-call/")) {
      return new Response(JSON.stringify({ call_id: url.pathname.split("/").pop(), tdx_quote: "deadbeef", code_hash: "c0de" }), { headers: { "content-type": "application/json" } });
    }
    const body = JSON.parse(String(init.body)) as { input: unknown };
    this.calls.push({ path: url.pathname, paymentKey: headers.get("x-payment-key"), input: body.input });
    if (this.failWith) return new Response(JSON.stringify({ error: "nope", reason: this.failWith.reason }), { status: this.failWith.status });
    const output = this.wasm.run(body.input).output;
    return new Response(
      JSON.stringify({ call_id: "11111111-2222-3333-4444-555555555555", status: "completed", output, time_ms: 12, compute_cost: "100", attestation_url: "https://outlayer.test/attestations/by-call/11111111-2222-3333-4444-555555555555" }),
      { headers: { "content-type": "application/json" } },
    );
  }
}

/** The strategy NFT contract's views over a fake NEAR JSON-RPC (host rpc.test). Writes are stubbed per test. */
export class FakeNftChain {
  tokens: Record<string, string> = {}; // code hash -> token id
  holders: Record<string, string> = {};
  copyFee: Record<string, number> = {};
  bonds: Record<string, [string, string]> = {}; // token -> [held, required], USD with 6 decimals
  payments: Record<string, string> = {}; // reference -> credited
  failViews = false;
  calls: string[] = [];
  handle(init: RequestInit): Response {
    const req = JSON.parse(String(init.body)) as { params: { method_name: string; args_base64: string } };
    const method = req.params.method_name;
    const args = JSON.parse(Buffer.from(req.params.args_base64, "base64").toString()) as Record<string, string>;
    this.calls.push(method);
    const answer = (v: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: "pilot", result: { result: [...Buffer.from(JSON.stringify(v))] } }), { headers: { "content-type": "application/json" } });
    if (this.failViews) return new Response(JSON.stringify({ jsonrpc: "2.0", id: "pilot", error: { message: "rpc down" } }), { headers: { "content-type": "application/json" } });
    switch (method) {
      case "token_by_code_hash":
        return answer(this.tokens[args.code_hash!] ?? null);
      case "revenue_receiver":
        return answer(this.holders[args.token_id!] ?? null);
      case "copy_fee":
        return answer([this.copyFee[args.token_id!] ?? 500, 0, 0]);
      case "bond_status":
        return answer(this.bonds[args.token_id!] ?? ["0", "100000000"]);
      case "fee_payment":
        return answer(this.payments[args.reference!] ?? null);
      case "record":
        return answer([]);
      default:
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: "pilot", error: { message: `no view ${method}` } }), { headers: { "content-type": "application/json" } });
    }
  }
}

/** Hyperliquid testnet stand-in (host api.hyperliquid-testnet.xyz). */
export class FakeHyperliquid {
  equity = 1000;
  positions: Record<string, number> = {};
  mids: Record<string, number> = { BTC: 70_000, ETH: 2_000, SOL: 100, NEAR: 4 };
  universe = [
    { name: "BTC", szDecimals: 5 },
    { name: "ETH", szDecimals: 4 },
    { name: "SOL", szDecimals: 2 },
    { name: "NEAR", szDecimals: 1 },
  ];
  orders: Array<{ action: { orders: Array<{ a: number; b: boolean; p: string; s: string; r: boolean; c?: string }>; builder?: unknown }; nonce: number; signature: { r: string; s: string; v: number } }> = [];
  known = new Map<string, string>(); // cloid -> status
  failNext: "transport" | "refuse" | null = null;
  handle(url: URL, init: RequestInit): Response {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const ok = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    if (url.pathname === "/info") {
      if (body.type === "meta") return ok({ universe: this.universe });
      if (body.type === "allMids") return ok(Object.fromEntries(Object.entries(this.mids).map(([k, v]) => [k, String(v)])));
      if (body.type === "clearinghouseState") {
        const gross = Object.entries(this.positions).reduce((a, [c, n]) => a + Math.abs(n * this.mids[c]!), 0);
        return ok({ marginSummary: { accountValue: String(this.equity), totalNtlPos: String(gross) }, assetPositions: Object.entries(this.positions).map(([coin, szi]) => ({ position: { coin, szi: String(szi) } })) });
      }
      if (body.type === "orderStatus") {
        const st = this.known.get(String(body.oid));
        return ok(st ? { status: "order", order: { status: st } } : { status: "unknownOid" });
      }
    }
    if (url.pathname === "/exchange") {
      const o = body as unknown as FakeHyperliquid["orders"][number];
      const fail = this.failNext;
      this.failNext = null;
      if (fail === "refuse") return ok({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Insufficient margin to place order." }] } } });
      const w = o.action.orders[0]!;
      const coin = this.universe[w.a]!.name;
      this.orders.push(o);
      this.positions[coin] = (this.positions[coin] ?? 0) + (w.b ? 1 : -1) * Number(w.s);
      if (w.c) this.known.set(w.c, "filled");
      if (fail === "transport") return new Response("bad gateway", { status: 502 });
      return ok({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: w.s, avgPx: String(this.mids[coin]), oid: this.orders.length } }] } } });
    }
    return new Response("not found", { status: 404 });
  }
}

export function testApp(env: Record<string, string> = {}, deps: { wasm?: StrategyWasm } = {}) {
  const agent = new FakeAgentApi();
  const ai = new FakeNearAi();
  const outlayer = new FakeOutLayer();
  const chain = new FakeNftChain();
  const hl = new FakeHyperliquid();
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input));
    const merged: RequestInit = req ? { method: req.method, headers: req.headers, body: req.body ? await req.text() : undefined, ...init } : init;
    if (url.host === "agent.test") return agent.handle(url, merged);
    if (url.host === "klines.test") return fakeKlines(url);
    if (url.host === "ai.test") return ai.handle(url, merged);
    if (url.host === "outlayer.test") return outlayer.handle(url, merged);
    if (url.host === "rpc.test") return chain.handle(merged);
    if (url.host === "api.hyperliquid-testnet.xyz") return hl.handle(url, merged);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const cfg = loadConfig({
    DATABASE_PATH: ":memory:",
    PILOT_MASTER_KEY: "test-master-key",
    NEAR_INTENTS_AGENT_API_URL: "https://agent.test",
    NEAR_INTENTS_AGENT_API_KEY: "test-partner-key",
    HISTORY_API_URL: "https://klines.test",
    NEARAI_BASE_URL: "https://ai.test/v1",
    OUTLAYER_API_URL: "https://outlayer.test",
    STRATEGY_WASM_PATH: WASM_PATH,
    STRATEGY_ENGINE: "local",
    SCHEDULER_ENABLED: "false",
    ...env,
  });
  const app = buildApp(cfg, { fetch: fetchImpl, db: openDb(":memory:"), settleWaitMs: 0, ...(deps.wasm ? { wasm: deps.wasm } : {}) });
  return { app, agent, ai, outlayer, chain, hl, cfg, fetch: fetchImpl };
}
