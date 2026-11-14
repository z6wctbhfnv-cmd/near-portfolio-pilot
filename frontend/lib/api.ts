// Client for the Pilot backend (backend/README.md). Base URL from NEXT_PUBLIC_API_BASE.
import type { Owner, OwnerAction } from "./owner";
export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8787").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      ...rest,
      method: rest.method ?? (json !== undefined ? "POST" : "GET"),
      headers: {
        ...(json !== undefined ? { "content-type": "application/json" } : {}),
        ...(currentPilotKey() ? { "x-pilot-key": currentPilotKey()! } : {}),
        ...(rest.headers ?? {}),
      },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError("offline", "Can’t reach the Pilot backend.", 0);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(e?.code ?? "http_" + res.status, e?.message ?? res.statusText, res.status);
  }
  return body as T;
}

/* ---------- types (only the fields the UI reads) ---------- */
export type Mandate = {
  risk: string; assets: string[]; stable: string;
  budget: { daily_usd: number | null; weekly_usd: number | null; monthly_usd: number | null };
  max_trade_usd: number | null; max_actions_per_hour: number | null; owner_approval: boolean;
  timelock_minutes?: number;
  schedule?: { time_zone: string; days: string[]; start: string; end: string } | null;
  /** Sell everything to the stablecoin and pause when the portfolio falls this far below its peak. */
  drawdown_stop?: { enabled: boolean; max_drawdown: number };
};
export type StrategyRef = { id: string; params: Record<string, unknown> & { weights?: Record<string, number>; every_hours?: number } };
export type ParseResult = { mandate: Mandate; notes: string[]; warnings: string[]; source: string; strategy: StrategyRef; policy: unknown };
export type Pilot = {
  id: string; name: string; status: string; mode: "paper" | "live"; owner: Owner | null;
  mandate: Mandate; strategy: StrategyRef; paper_holdings?: Record<string, number>;
  following?: Following; referrer?: string | null; swarm?: Swarm["swarm"];
  next_run_at: number; next_review_at: number; created_at: number;
};
export type Portfolio = { rows: { symbol: string; units: number; price: number; usd: number }[]; total_usd: number; source: string };
export type Execution = { id: string; status: string; from?: string; to?: string; from_symbol?: string; to_symbol?: string; amount_in_usd?: number; error_code?: string; created_at: number; [k: string]: unknown };
export type Run = { id: string; created_at: number; engine: string; output?: { explanation?: string; reason?: string; orders?: unknown[]; [k: string]: unknown }; executions?: Execution[]; [k: string]: unknown };
export type PilotEvent = { id?: string; kind?: string; type?: string; message?: string; created_at: number; [k: string]: unknown };
export type Snapshot = { created_at?: number; at?: number; total_usd?: number; value_usd?: number; [k: string]: unknown };
export type Review = { id: string; created_at: number; status?: string; summary?: string; proposals?: unknown[]; [k: string]: unknown };
export type CatalogueStrategy = { id: string; name: string; description: string; params_schema: unknown; review_tunable: string[] };
export type Backtest = { metrics?: Record<string, number>; benchmark?: Record<string, number>; equity?: { t: number; v: number }[] | number[]; [k: string]: unknown };
export type UniverseAsset = { symbol: string; price: number; stable: boolean; listed: boolean };
export type IntentStatus = { status: string; failure_code?: string | null; details?: Record<string, unknown>; [k: string]: unknown };
export type PendingIntent = { correlation_id: string; type: string; status: string; created_at: number };


/* ---------- social, fees, health, swarm (backend PR #14 + follow-up) ---------- */
export type Following = { token_id: string; strategy_id: string; since: number } | null;
export type FeeRow = { id: string; period_end_ms: number; status: string; token_id: string; holder: string | null; equity_usd: number; hwm_usd: number; profit_usd: number; holder_bps: number; payment_bps: number; fee_usd: number; hwm_after_usd: number | null; kind: string; error: string | null; [k: string]: unknown };
export type FeeEstimate = { equity_usd: number; peak_usd: number; profit_usd: number; fee_usd: number; holder_usd: number; platform_usd: number; payment_bps: number } | null;
export type Fees = { terms: { holder_bps_default: number; platform_bps: number; referral_bps_of_platform: number; payments_enabled: boolean }; following: Following; estimate: FeeEstimate; peaks: unknown[]; data: FeeRow[] };
export type Gate = { token_id: string | null; holder: string | null; own: boolean; held_usd: number | null; required_usd: number | null; open: boolean; reason: string; strategy?: string };
export type Finding = { check: string; severity: "ok" | "warn" | "stop" | "muted"; detail: string };
export type HealthCheck = { id: string; day: number; status: "ok" | "warn" | "stop"; findings: Finding[]; question: { text: string; options: { id: "pause" | "keep"; label: string }[] } | null; answer: "pause" | "keep" | null; answered_at: number | null; created_at: number };
export type SwarmScript = { key: string; id: string; params: Record<string, unknown>; weight?: number; cap?: number };
export type Swarm = { swarm: { scripts: SwarmScript[]; allocation?: string } | null; state: { alloc: Record<string, number>; alloc_reason: string; sleeves: { key: string; cash: boolean; share: number | null; value_usd: number }[] } | null };
export type PriceTask = { id: string; asset: string; op: "<" | ">"; price: number; side: "buy" | "sell"; usd: number; status: string; text: string | null; fired_at: number | null; fired_price: number | null };

const list = <T,>(p: Promise<{ data: T[] }>) => p.then((r) => r.data);

export const api = {
  health: () => req<{ ok: boolean; wasm: boolean }>("/health"),
  universe: () => list<UniverseAsset>(req("/v1/universe")),
  strategies: () => list<CatalogueStrategy>(req("/v1/strategies")),
  backtest: (id: string, params: Record<string, unknown>, days = 90) => req<Backtest>(`/v1/strategies/${id}/backtest`, { json: { params, days } }),
  /** A backtest with one return per day, for the leaderboard's period tables. */
  backtestDaily: (id: string, params: Record<string, unknown>, days = 730) =>
    req<{ metrics: { total_return: number; max_drawdown: number }; daily_start: number; daily_returns: number[]; params: Record<string, unknown> }>(`/v1/strategies/${id}/backtest`, { json: { params, days, daily: true } }),
  parse: (text: string) => req<ParseResult>("/v1/mandate/parse", { json: { text } }),
  compile: (mandate: Mandate) => req<Omit<ParseResult, "notes" | "source">>("/v1/mandate/compile", { json: { mandate } }),
  createPilot: (body: { name: string; text?: string; mandate?: Mandate; initial_usd: number; mode?: "paper" | "live"; owner?: Owner; accepted_terms?: boolean }) =>
    req<{ pilot: Pilot; pilot_key?: string; notes?: string[]; warnings?: string[]; owner_action?: OwnerAction }>("/v1/pilots", { json: body }),
  pilots: () => list<Pilot>(req("/v1/pilots")),
  pilot: (id: string) => req<Pilot & { pilot?: Pilot }>(`/v1/pilots/${id}`).then((r) => (r.pilot ?? r) as Pilot),
  patchPilot: (id: string, body: { name?: string; paused?: boolean; review_auto_apply?: boolean; drawdown_stop?: { enabled?: boolean; max_drawdown?: number } }) => req<unknown>(`/v1/pilots/${id}`, { method: "PATCH", json: body }),
  setStrategy: (id: string, s: StrategyRef) => req<unknown>(`/v1/pilots/${id}/strategy`, { method: "PUT", json: s }),
  portfolio: (id: string) => req<Portfolio>(`/v1/pilots/${id}/portfolio`),
  run: (id: string) => req<Run>(`/v1/pilots/${id}/run`, { method: "POST", json: {} }),
  runs: (id: string) => list<Run>(req(`/v1/pilots/${id}/runs`)),
  executions: (id: string) => list<Execution>(req(`/v1/pilots/${id}/executions`)),
  events: (id: string) => list<PilotEvent>(req(`/v1/pilots/${id}/events`)),
  snapshots: (id: string) => list<Snapshot>(req(`/v1/pilots/${id}/snapshots`)),
  review: (id: string) => req<Review>(`/v1/pilots/${id}/review`, { json: {} }),
  reviews: (id: string) => list<Review>(req(`/v1/pilots/${id}/reviews`)),
  applyReview: (rid: string) => req<unknown>(`/v1/reviews/${rid}/apply`, { json: {} }),
  dismissReview: (rid: string) => req<unknown>(`/v1/reviews/${rid}/dismiss`, { json: {} }),

  /* owner actions on a live pilot: the backend prepares, the owner signs, the backend submits */
  grant: (id: string) => req<{ grant_id: string; expires_at: number; owner_action: OwnerAction }>(`/v1/pilots/${id}/grants`, { json: {} }),
  policy: (id: string, mandate?: Mandate) => req<{ owner_action: OwnerAction; warnings?: string[] }>(`/v1/pilots/${id}/policy`, { json: mandate ? { mandate } : {} }),
  ownerAction: (id: string, action: "freeze" | "unfreeze") => req<{ owner_action: OwnerAction }>(`/v1/pilots/${id}/${action}`, { json: {} }),
  pilotIntents: (id: string) => list<PendingIntent>(req(`/v1/pilots/${id}/intents`)),
  submitIntent: (cid: string, signed_data: Record<string, unknown>) => req<IntentStatus>(`/v1/intents/${encodeURIComponent(cid)}/submit`, { json: { signed_data } }),
  intentStatus: (cid: string, waitMs = 0) => req<{ status: IntentStatus; generated?: OwnerAction }>(`/v1/intents/${encodeURIComponent(cid)}?wait_ms=${waitMs}`),


  /* copying, fees, health, swarm, tasks, referrer */
  follow: (id: string, token_id: string) => req<{ pilot: Pilot; gate: Gate; note: string }>(`/v1/pilots/${id}/follow`, { json: { token_id } }),
  unfollow: (id: string) => req<{ pilot: Pilot }>(`/v1/pilots/${id}/unfollow`, { json: {} }),
  scriptGate: (token: string) => req<Gate>(`/v1/scripts/${encodeURIComponent(token)}/gate`),
  copyGate: (id: string) => req<{ bond_gate: string; data: Gate[] }>(`/v1/pilots/${id}/copy-gate`),
  fees: (id: string) => req<Fees>(`/v1/pilots/${id}/fees`),
  settleFees: (id: string) => req<unknown>(`/v1/pilots/${id}/fees/settle`, { json: {} }),
  pilotHealth: (id: string) => req<{ latest: HealthCheck | null; data: HealthCheck[] }>(`/v1/pilots/${id}/health`),
  healthCheck: (id: string) => req<HealthCheck>(`/v1/pilots/${id}/health/check`, { json: {} }),
  healthAnswer: (checkId: string, answer: "pause" | "keep") => req<HealthCheck>(`/v1/health/${checkId}/answer`, { json: { answer } }),
  swarm: (id: string) => req<Swarm>(`/v1/pilots/${id}/swarm`),
  setSwarm: (id: string, body: { scripts: SwarmScript[]; allocation?: "equal" | "manual" | "calm" }) => req<{ pilot: Pilot }>(`/v1/pilots/${id}/swarm`, { method: "PUT", json: body }),
  clearSwarm: (id: string) => req<{ pilot: Pilot }>(`/v1/pilots/${id}/swarm`, { method: "DELETE" }),
  tasks: (id: string) => list<PriceTask>(req(`/v1/pilots/${id}/tasks`)),
  addTask: (id: string, t: { asset: string; op: "<" | ">"; price: number; side: "buy" | "sell"; usd: number; text?: string }) => req<PriceTask>(`/v1/pilots/${id}/tasks`, { json: t }),
  cancelTask: (id: string, taskId: string) => req<PriceTask>(`/v1/pilots/${id}/tasks/${taskId}`, { method: "DELETE" }),
  referrer: (id: string, referrer: string) => req<{ pilot: Pilot; note: string }>(`/v1/pilots/${id}/referrer`, { json: { referrer } }),

  /** NEAR AI drafts a script from an idea (needs NEARAI_API_KEY on the backend). */
  draftScript: (idea: string) => req<{ code: string; model: string }>("/v1/scripts/draft", { json: { idea } }),
};

/* ---------- the pilot this browser is looking at ---------- */
const KEY = "dolya.pilot";
const PILOT_KEY = "dolya.pilotKey";
export const currentPilotId = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
/** The pilot key the backend handed out when this browser created the pilot: it opens that pilot only. */
export const currentPilotKey = () => { try { return localStorage.getItem(PILOT_KEY); } catch { return null; } };
export const setCurrentPilotId = (id: string | null, key?: string | null) => {
  try {
    if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY);
    if (!id) localStorage.removeItem(PILOT_KEY); else if (key) localStorage.setItem(PILOT_KEY, key);
  } catch { /* storage blocked */ }
};
