/**
 * Weekly review. One AI agent (NEAR AI Cloud) reads the week's numbers and may PROPOSE parameter
 * changes. It has no tools and cannot trade: proposals are validated against the strategy schema,
 * limited to tunable parameters, clamped to ±25% per review, and applied only when the owner
 * opted into auto-apply (or approves them through the API). Without a key, a rule-based reviewer
 * gives the same shape of answer.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type Db, json, logEvent, parse } from "./db.js";
import type { PriceHistory } from "./history.js";
import type { NearAiClient } from "./nearai.js";
import type { Pilots } from "./pilots.js";
import { MAX_REVIEW_STEP, parseStrategyParams, REVIEW_TUNABLE, STRATEGY_INFO, STRATEGY_SCHEMAS, type StrategyId, strategySymbols } from "./strategies.js";

const DAY = 86_400_000;

export type Proposal = { param: string; from: number; to: number; reason: string };

const AiAnswer = z.object({
  summary: z.string().min(1).max(2000),
  risk_flags: z.array(z.string().max(300)).max(10).default([]),
  proposals: z
    .array(z.object({ param: z.string(), value: z.number(), reason: z.string().max(500).default("") }))
    .max(5)
    .default([]),
});

export type ReviewMetrics = {
  period_days: number;
  start_usd: number | null;
  end_usd: number | null;
  return_pct: number | null;
  max_drawdown_pct: number | null;
  runs: number;
  run_errors: number;
  trades_filled: number;
  trades_blocked: number;
  blocked_reasons: Record<string, number>;
  turnover_usd: number;
  market_change_pct: Record<string, number | null>;
};

export async function computeMetrics(db: Db, history: PriceHistory, pilotId: string, symbols: string[], from: number, to: number): Promise<ReviewMetrics> {
  const snaps = await db
    .prepare("SELECT ts, total_usd FROM snapshots WHERE pilot_id = ? AND ts >= ? AND ts <= ? ORDER BY ts")
    .all<{ ts: number; total_usd: number }>(pilotId, from, to);
  let peak = 0;
  let mdd = 0;
  for (const s of snaps) {
    peak = Math.max(peak, s.total_usd);
    if (peak > 0) mdd = Math.max(mdd, 1 - s.total_usd / peak);
  }
  const runs = await db.prepare("SELECT status FROM runs WHERE pilot_id = ? AND started_at >= ? AND started_at <= ?").all<{ status: string }>(pilotId, from, to);
  const ex = await db
    .prepare("SELECT status, error_code, usd FROM executions WHERE pilot_id = ? AND created_at >= ? AND created_at <= ?")
    .all<{ status: string; error_code: string | null; usd: number }>(pilotId, from, to);
  const filled = ex.filter((e) => ["paper_filled", "SUCCESS"].includes(e.status));
  const blocked = ex.filter((e) => ["blocked", "refused"].includes(e.status));
  const reasons: Record<string, number> = {};
  for (const b of blocked) reasons[b.error_code ?? "unknown"] = (reasons[b.error_code ?? "unknown"] ?? 0) + 1;
  const market: Record<string, number | null> = {};
  for (const s of symbols) {
    const c = await history.closes(s, from, to);
    market[s] = c.length >= 2 ? Number(((c[c.length - 1]!.close / c[0]!.close - 1) * 100).toFixed(2)) : null;
  }
  const first = snaps[0]?.total_usd ?? null;
  const last = snaps[snaps.length - 1]?.total_usd ?? null;
  return {
    period_days: Math.round((to - from) / DAY),
    start_usd: first,
    end_usd: last,
    return_pct: first && last ? Number(((last / first - 1) * 100).toFixed(2)) : null,
    max_drawdown_pct: snaps.length ? Number((mdd * 100).toFixed(2)) : null,
    runs: runs.length,
    run_errors: runs.filter((r) => r.status === "error").length,
    trades_filled: filled.length,
    trades_blocked: blocked.length,
    blocked_reasons: reasons,
    turnover_usd: Number(filled.reduce((a, e) => a + e.usd, 0).toFixed(2)),
    market_change_pct: market,
  };
}

/** Keeps only safe proposals: tunable params, inside schema bounds, at most ±25% per review. */
export function sanitizeProposals(strategy: StrategyId, params: Record<string, unknown>, raw: Array<{ param: string; value: number; reason: string }>) {
  const accepted: Proposal[] = [];
  const rejected: Array<{ param: string; why: string }> = [];
  let next = { ...params };
  for (const p of raw) {
    if (!REVIEW_TUNABLE[strategy].includes(p.param)) {
      rejected.push({ param: p.param, why: "not tunable by review" });
      continue;
    }
    const cur = Number(params[p.param]);
    if (!Number.isFinite(cur) || !Number.isFinite(p.value)) {
      rejected.push({ param: p.param, why: "not a number" });
      continue;
    }
    const lo = cur * (1 - MAX_REVIEW_STEP);
    const hi = cur * (1 + MAX_REVIEW_STEP);
    let to = Math.min(hi, Math.max(lo, p.value));
    const shape = (STRATEGY_SCHEMAS[strategy].shape as Record<string, z.ZodType>)[p.param];
    const isInt = shape && JSON.stringify(z.toJSONSchema(shape, { io: "input" })).includes('"integer"');
    to = isInt ? Math.round(to) : Number(to.toFixed(4));
    if (to === cur) {
      rejected.push({ param: p.param, why: "no change after clamping" });
      continue;
    }
    try {
      next = parseStrategyParams(strategy, { ...next, [p.param]: to });
      accepted.push({ param: p.param, from: cur, to, reason: p.reason });
    } catch (e) {
      rejected.push({ param: p.param, why: (e as Error).message });
    }
  }
  return { accepted, rejected, params: next };
}

/** Deterministic reviewer used without a NEAR AI key (and as the AI's sanity baseline). */
export function ruleReview(strategy: StrategyId, params: Record<string, unknown>, m: ReviewMetrics) {
  const flags: string[] = [];
  const proposals: Array<{ param: string; value: number; reason: string }> = [];
  if (m.max_drawdown_pct !== null && m.max_drawdown_pct > 15) {
    flags.push(`drawdown ${m.max_drawdown_pct}% this period`);
    if ("max_scale" in params) proposals.push({ param: "max_scale", value: Number(params.max_scale) * 0.8, reason: "deep drawdown: cut maximum risk" });
    if ("off_fraction" in params) proposals.push({ param: "off_fraction", value: Number(params.off_fraction) * 0.8, reason: "deep drawdown: hold less when trend is down" });
    if ("target_vol" in params) proposals.push({ param: "target_vol", value: Number(params.target_vol) * 0.8, reason: "deep drawdown: lower volatility target" });
  }
  if (m.trades_blocked > 0) flags.push(`${m.trades_blocked} trade(s) blocked: ${Object.entries(m.blocked_reasons).map(([k, v]) => `${k} ×${v}`).join(", ")}`);
  if (m.run_errors > 0) flags.push(`${m.run_errors} run(s) failed`);
  if (m.end_usd && m.turnover_usd > m.end_usd * 2 && "band" in params) {
    flags.push("high turnover for the period");
    proposals.push({ param: "band", value: Number(params.band) * 1.2, reason: "trading too often: widen the rebalance band" });
  }
  const summary =
    m.return_pct === null
      ? `Not enough snapshots this period to measure a return (${m.runs} run(s)).`
      : `Portfolio ${m.return_pct >= 0 ? "gained" : "lost"} ${Math.abs(m.return_pct)}% over ${m.period_days} days (max drawdown ${m.max_drawdown_pct}%), ${m.trades_filled} trade(s) filled, ${m.trades_blocked} blocked.`;
  return { summary, risk_flags: flags, proposals };
}

const SYSTEM = `You review an automated crypto portfolio strategy once a week. You cannot trade or move funds; you can only propose small parameter changes, which code will clamp to ±25% and validate.
Answer with ONLY one JSON object: {"summary": "2-4 plain sentences for the owner", "risk_flags": ["..."], "proposals": [{"param": "<name>", "value": <number>, "reason": "..."}]}.
Propose a change only when the numbers clearly justify it; an empty list is a good answer. Never promise returns. Be specific and calm.`;

export class Reviewer {
  constructor(
    private readonly db: Db,
    private readonly pilots: Pilots,
    private readonly history: PriceHistory,
    private readonly ai: NearAiClient,
    private readonly reviewEveryDays: number,
  ) {}

  async review(pilotId: string, opts: { periodDays?: number } = {}) {
    const p = await this.pilots.get(pilotId);
    if (!p) throw new Error("pilot not found");
    const to = Date.now();
    const from = to - (opts.periodDays ?? this.reviewEveryDays) * DAY;
    const symbols = strategySymbols(p.strategy.id, p.strategy.params);
    const metrics = await computeMetrics(this.db, this.history, pilotId, symbols, from, to);

    let source: "ai" | "rules" = "rules";
    let answer = ruleReview(p.strategy.id, p.strategy.params, metrics);
    let model: string | null = null;
    const notes: string[] = [];
    if (this.ai.configured) {
      try {
        const raw = await this.ai.chatJson([
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: JSON.stringify({
              strategy: { id: p.strategy.id, about: STRATEGY_INFO[p.strategy.id].description, params: p.strategy.params, tunable: REVIEW_TUNABLE[p.strategy.id] },
              mandate: p.mandate,
              metrics,
              rule_based_flags: answer.risk_flags,
            }),
          },
        ]);
        const parsed = AiAnswer.parse(raw);
        answer = { summary: parsed.summary, risk_flags: parsed.risk_flags, proposals: parsed.proposals };
        source = "ai";
        model = this.ai.model;
      } catch (e) {
        notes.push(`AI review unavailable, rule-based review used: ${(e as Error).message}`);
      }
    }
    const { accepted, rejected } = sanitizeProposals(p.strategy.id, p.strategy.params, answer.proposals);
    const id = randomUUID();
    const status = accepted.length ? "proposed" : "no_change";
    await this.db
      .prepare(
        `INSERT INTO reviews (id, pilot_id, period_start, period_end, metrics_json, source, model, summary, risk_flags_json, proposals_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, pilotId, from, to, json(metrics), source, model, answer.summary, json([...answer.risk_flags, ...notes]), json({ accepted, rejected }), status, Date.now());
    await this.pilots.update(pilotId, { next_review_at: to + this.reviewEveryDays * DAY });
    await logEvent(this.db, pilotId, "info", `review (${source}): ${accepted.length} proposal(s)`, { review_id: id });
    if (accepted.length && p.review_auto_apply) await this.apply(id);
    return (await this.get(id))!;
  }

  /** Applies a review's accepted proposals to the pilot's parameters (re-validated). */
  async apply(reviewId: string) {
    const r = await this.get(reviewId);
    if (!r) throw new Error("review not found");
    if (r.status !== "proposed") throw new Error(`review is ${r.status}`);
    const p = (await this.pilots.get(r.pilot_id))!;
    let params = { ...p.strategy.params };
    for (const prop of r.proposals.accepted) params = parseStrategyParams(p.strategy.id, { ...params, [prop.param]: prop.to });
    await this.pilots.update(p.id, { strategy_params_json: json(params)! });
    await this.db.prepare("UPDATE reviews SET status = 'applied', applied_at = ? WHERE id = ?").run(Date.now(), reviewId);
    await logEvent(this.db, p.id, "info", "review proposals applied", { review_id: reviewId, params });
    return (await this.get(reviewId))!;
  }

  async dismiss(reviewId: string) {
    await this.db.prepare("UPDATE reviews SET status = 'dismissed' WHERE id = ? AND status = 'proposed'").run(reviewId);
    return this.get(reviewId);
  }

  async get(id: string) {
    const r = await this.db.prepare("SELECT * FROM reviews WHERE id = ?").get<Record<string, unknown>>(id);
    return r ? this.view(r) : undefined;
  }

  async list(pilotId: string) {
    return (await this.db.prepare("SELECT * FROM reviews WHERE pilot_id = ? ORDER BY created_at DESC").all<Record<string, unknown>>(pilotId)).map((r) => this.view(r));
  }

  private view(r: Record<string, unknown>) {
    return {
      id: r.id as string,
      pilot_id: r.pilot_id as string,
      period_start: r.period_start as number,
      period_end: r.period_end as number,
      source: r.source as string,
      model: r.model as string | null,
      summary: r.summary as string,
      risk_flags: parse<string[]>(r.risk_flags_json, []),
      proposals: parse<{ accepted: Proposal[]; rejected: Array<{ param: string; why: string }> }>(r.proposals_json, { accepted: [], rejected: [] }),
      metrics: parse<ReviewMetrics | null>(r.metrics_json, null),
      status: r.status as string,
      created_at: r.created_at as number,
      applied_at: r.applied_at as number | null,
    };
  }
}
