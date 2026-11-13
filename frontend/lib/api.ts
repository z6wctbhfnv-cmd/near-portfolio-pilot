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
      headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(rest.headers ?? {}) },
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

const list = <T,>(p: Promise<{ data: T[] }>) => p.then((r) => r.data);

export const api = {
  health: () => req<{ ok: boolean; wasm: boolean }>("/health"),
  universe: () => list<UniverseAsset>(req("/v1/universe")),
  strategies: () => list<CatalogueStrategy>(req("/v1/strategies")),
  backtest: (id: string, params: Record<string, unknown>, days = 90) => req<Backtest>(`/v1/strategies/${id}/backtest`, { json: { params, days } }),
  parse: (text: string) => req<ParseResult>("/v1/mandate/parse", { json: { text } }),
  compile: (mandate: Mandate) => req<Omit<ParseResult, "notes" | "source">>("/v1/mandate/compile", { json: { mandate } }),
  createPilot: (body: { name: string; text?: string; mandate?: Mandate; initial_usd: number; mode?: "paper" | "live"; owner?: Owner; accepted_terms?: boolean }) =>
    req<{ pilot: Pilot; notes?: string[]; warnings?: string[]; owner_action?: OwnerAction }>("/v1/pilots", { json: body }),
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

  /** NEAR AI drafts a script from an idea (needs NEARAI_API_KEY on the backend). */
  draftScript: (idea: string) => req<{ code: string; model: string }>("/v1/scripts/draft", { json: { idea } }),
};

/* ---------- the pilot this browser is looking at ---------- */
const KEY = "dolya.pilot";
export const currentPilotId = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
export const setCurrentPilotId = (id: string | null) => { try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch { /* storage blocked */ } };
