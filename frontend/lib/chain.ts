// Read-only views of the strategy NFT contract over NEAR JSON-RPC. No wallet, no keys.
import { NFT } from "./config";

const b64 = (o: unknown) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));

export async function view<T>(method: string, args: Record<string, unknown> = {}, contract = NFT.contract, rpc = NFT.rpc): Promise<T> {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "dolya", method: "query",
      params: { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: b64(args) } }),
  });
  const j = await r.json();
  if (j.error || j.result?.error) throw new Error(String(j.error?.data ?? j.error?.message ?? j.result?.error ?? "rpc error"));
  return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result))) as T;
}

export type Checkpoint = { period_end_ms: number; equity_index: string; proofs_hash: string; executions: number; code_hash: string; followers: number };
export type OpenParam = { name: string; label?: string; min: number; max: number; step?: number; default: number };

export type ScriptOnChain = {
  id: string;
  title: string;
  description: string;
  holder: string;
  author: string;
  codeHash: string;
  record: Checkpoint[];
  followers: number;
  /** yoctoNEAR, null when not for sale */
  price: string | null;
  hidden: boolean;
  version: number;
  changedAt: number;
  fee: { bps: number; next: number; at: number };
  openParams: OpenParam[];
  bond: { held: number; required: number };
  feesEarned: number;
};

type Token = { token_id: string; owner_id: string; metadata?: { title?: string; description?: string } };

async function oneScript(t: Token): Promise<ScriptOnChain> {
  const id = t.token_id;
  const a = { token_id: id };
  const [info, record, followers, price, hidden, version, fee, params, bond, earned] = await Promise.all([
    view<{ code_hash: string; author: string } | null>("strategy_info", a),
    view<Checkpoint[]>("record", { token_id: id, from_index: 0, limit: 200 }).catch(() => []),
    view<number>("follower_count", a).catch(() => 0),
    view<string | null>("sale_price", a).catch(() => null),
    view<boolean>("is_hidden", a).catch(() => false),
    view<[number, number]>("script_version", a).catch(() => [1, 0] as [number, number]),
    view<[number, number, number]>("copy_fee", a).catch(() => [500, 0, 0] as [number, number, number]),
    view<string>("open_params", a).catch(() => "[]"),
    view<[string, string]>("bond_status", a).catch(() => ["0", "100000000"] as [string, string]),
    view<string>("fees_earned", { token_id: id, fee_token: NFT.feeToken }).catch(() => "0"),
  ]);
  let openParams: OpenParam[] = [];
  try { openParams = JSON.parse(params); } catch { /* bad schema: none */ }
  return {
    id, title: t.metadata?.title ?? id, description: t.metadata?.description ?? "",
    holder: t.owner_id, author: info?.author ?? t.owner_id, codeHash: info?.code_hash ?? "",
    record, followers: Number(followers) || 0, price, hidden, version: version[0], changedAt: version[1],
    fee: { bps: fee[0], next: fee[1], at: fee[2] }, openParams,
    bond: { held: Number(bond[0]) / 1e6, required: Number(bond[1]) / 1e6 },
    feesEarned: Number(earned) / 1e6,
  };
}

const CACHE = "dolya.chain.v1";
const TTL = 2 * 60_000;

/** Every script NFT with its on-chain facts. Cached for two minutes in this tab. */
export async function scriptsOnChain(force = false): Promise<ScriptOnChain[]> {
  if (!force) {
    try {
      const c = JSON.parse(sessionStorage.getItem(CACHE) ?? "null");
      if (c && Date.now() - c.at < TTL) return c.data;
    } catch { /* storage blocked */ }
  }
  const total = Number(await view<string>("nft_total_supply"));
  const tokens: Token[] = [];
  for (let i = 0; i < total; i += 50) tokens.push(...(await view<Token[]>("nft_tokens", { from_index: String(i), limit: 50 })));
  const data = await Promise.all(tokens.map(oneScript));
  try { sessionStorage.setItem(CACHE, JSON.stringify({ at: Date.now(), data })); } catch { /* storage blocked */ }
  return data;
}

export const clearChainCache = () => { try { sessionStorage.removeItem(CACHE); } catch { /* storage blocked */ } };

/** The checkpoints are simulated until the backend attaches Agent API execution proofs. */
export const simulatedRecord = (r: Checkpoint[]) => r.length > 0 && r.every((c) => /^0+$/.test(c.proofs_hash));

/** Change over the on-chain record, first to last checkpoint. */
export function recordChange(r: Checkpoint[]) {
  if (r.length < 2) return null;
  const first = Number(r[0].equity_index), last = Number(r[r.length - 1].equity_index);
  return first > 0 ? last / first - 1 : null;
}

export const yoctoToNear = (y: string) => Number(BigInt(y) / 10n ** 21n) / 1000;
/** Exact NEAR amount of a yocto string, for deposits (no rounding: a buy must attach at least the price). */
export function yoctoToNearExact(y: string) {
  const v = BigInt(y), whole = v / 10n ** 24n, frac = (v % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}
export const nearToYocto = (n: number) => (BigInt(Math.round(n * 1000)) * 10n ** 21n).toString();

/** "referrer_of" for any account, null when none. */
export const referrerOf = (account: string) => view<string | null>("referrer_of", { account });

export type Offer = { account: string; yocto: string };
/**
 * Open offers on a script, highest first. null = the deployed contract has no offers yet
 * (it needs the upgrade with make_offer / accept_offer).
 */
export async function offersOn(tokenId: string): Promise<Offer[] | null> {
  try {
    const rows = await view<Array<[string, string]>>("offers", { token_id: tokenId, from_index: 0, limit: 100 });
    return rows.map(([account, yocto]) => ({ account, yocto })).sort((a, b) => (BigInt(b.yocto) > BigInt(a.yocto) ? 1 : -1));
  } catch (e) {
    if (/MethodNotFound|MethodResolveError|not found|CompilationError/i.test(String((e as Error).message))) return null;
    throw e;
  }
}

/* ---------- backtests (web/data/report.json, exported to public/backtests.json) ---------- */
export type Backtested = { id: string; doc: string; uses_perps: boolean; record_return: number; record_max_drawdown: number; daily_returns: number[]; daily_start: number; periods: Record<string, number>; params: Record<string, unknown> };

let backtests: Promise<Backtested[]> | null = null;
export function loadBacktests() {
  backtests ??= fetch("/backtests.json").then((r) => r.json()).then((j) => j.strategies as Backtested[]).catch(() => { backtests = null; return []; });
  return backtests;
}

/** Return, worst drop and return-per-drop over the last `days` of a backtest. A new version restarts the record. */
export function periodStats(x: Backtested, days: number, changedAt = 0) {
  let r = x.daily_returns;
  if (changedAt) r = r.slice(Math.max(0, Math.ceil((changedAt - x.daily_start) / 86_400_000)));
  const w = r.slice(-days);
  let eq = 1, peak = 1, mdd = 0;
  const curve = [1];
  for (const d of w) { eq *= 1 + d; peak = Math.max(peak, eq); mdd = Math.max(mdd, 1 - eq / peak); curve.push(eq); }
  const roi = eq - 1;
  const step = Math.max(1, Math.floor(curve.length / 40));
  return { roi, mdd, ratio: roi / Math.max(mdd, 0.01), days: w.length, curve: curve.filter((_, i) => i % step === 0 || i === curve.length - 1) };
}

const TITLES: Record<string, string> = {
  "hold-rebalance": "Hold & rebalance", "momentum-top2": "Momentum rotation", "vol-target": "Volatility target",
  "trend-longshort": "Trend long/short", "funding-carry": "Funding carry", "mean-reversion": "Mean reversion",
  "eth-btc-relative": "ETH vs BTC", "gold-crypto-rotation": "Gold / crypto rotation", "donchian-breakout": "Breakout",
  "funding-reversion": "Funding reversion", "wasm-rebalance": "Constant mix", "wasm-trend": "Trend filter",
  "wasm-vol-target": "Volatility target (WASM)", "wasm-dca": "Weekly buys",
};
export const scriptTitle = (id: string) => TITLES[id.split("@")[0]] ?? id.split("@")[0];
