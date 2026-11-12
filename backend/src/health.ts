/**
 * Daily script health check, one per pilot per UTC day (pilot/health.py is the research version).
 *
 * A script's code is fixed by its hash, so what goes wrong day to day is how it runs:
 * - errors:     failed runs, swaps that need attention or were refused by the policy;
 * - schedule:   no run for much longer than the script's own interval;
 * - stale_data: daily closes (or the live price) the script decides on are too old;
 * - drift:      the last week replayed from the pilot's real starting position with the same WASM
 *               on daily closes, against what the pilot actually made;
 * - slippage:   live fills against their quotes;
 * - bond:       the holder's bond no longer covers copying (the run gate blocks it already);
 * - fees:       a weekly fee could not be paid.
 * Each finding is ok, warn or stop. When there is anything to say, the check ends with one question
 * to the owner: "Pause" or "Keep running". Nothing pauses on its own here: the drawdown stop and the
 * bond gate already act by themselves, and a drift or data finding can be a false alarm, so the
 * owner decides. "Keep running" mutes the same finding for MUTE_DAYS so it does not ask every day.
 */
import { randomUUID } from "node:crypto";
import { backtest } from "./backtest.js";
import { copyGate } from "./copying.js";
import { type Db, json, logEvent, parse } from "./db.js";
import type { PriceHistory } from "./history.js";
import type { NftPublisher } from "./nft.js";
import type { Pilot, Pilots } from "./pilots.js";
import { strategySymbols } from "./strategies.js";
import { DEFAULT_UNIVERSE, type TokenCatalog } from "./tokens.js";
import type { StrategyWasm } from "./wasm.js";

const DAY = 86_400_000;
export const MUTE_DAYS = 3;
/** Codes that are expected by design (paper/live switches, the mandate's own caps), not problems. */
const EXPECTED_BLOCKS = new Set(["live_execution_disabled", "mandate_budget", "mandate_trade_limit"]);

export type Finding = { check: string; severity: "ok" | "warn" | "stop" | "muted"; detail: string; data?: unknown };
export type HealthCheck = {
  id: string;
  pilot_id: string;
  day: number;
  status: "ok" | "warn" | "stop";
  findings: Finding[];
  question: { text: string; options: Array<{ id: "pause" | "keep"; label: string }> } | null;
  answer: "pause" | "keep" | null;
  answered_at: number | null;
  created_at: number;
};

type Row = { id: string; pilot_id: string; day: number; status: string; findings_json: string; question_json: string | null; answer: string | null; answered_at: number | null; created_at: number };
const view = (r: Row): HealthCheck => ({
  id: r.id,
  pilot_id: r.pilot_id,
  day: r.day,
  status: r.status as HealthCheck["status"],
  findings: parse<Finding[]>(r.findings_json, []),
  question: parse(r.question_json, null),
  answer: (r.answer as HealthCheck["answer"]) ?? null,
  answered_at: r.answered_at,
  created_at: r.created_at,
});

export type HealthDeps = {
  db: Db;
  pilots: Pilots;
  history: PriceHistory;
  catalog: TokenCatalog;
  wasm: StrategyWasm;
  nft: NftPublisher;
  costBps: number;
  /** Slippage the record assumes per swap, in bps; live fills worse than twice this are flagged. */
  assumedSlippageBps?: number;
};

export class HealthChecker {
  constructor(private readonly d: HealthDeps) {}

  async latest(pilotId: string) {
    const r = await this.d.db.prepare("SELECT * FROM health_checks WHERE pilot_id = ? ORDER BY day DESC LIMIT 1").get<Row>(pilotId);
    return r ? view(r) : null;
  }

  async list(pilotId: string, limit = 30) {
    return (await this.d.db.prepare("SELECT * FROM health_checks WHERE pilot_id = ? ORDER BY day DESC LIMIT ?").all<Row>(pilotId, limit)).map(view);
  }

  async get(id: string) {
    const r = await this.d.db.prepare("SELECT * FROM health_checks WHERE id = ?").get<Row>(id);
    return r ? view(r) : null;
  }

  /** Pilots with no check for today yet. */
  async due(now = Date.now()) {
    const day = Math.floor(now / DAY) * DAY;
    return this.d.db
      .prepare("SELECT id FROM pilots WHERE status IN ('active','paused') AND NOT EXISTS (SELECT 1 FROM health_checks h WHERE h.pilot_id = pilots.id AND h.day = ?)")
      .all<{ id: string }>(day);
  }

  /**
   * Runs today's check (again, if `force`) and stores it. `allowBacktest: false` skips the drift
   * replay (the scheduler caps how many run per tick, to fit a serverless time limit).
   */
  async check(pilotId: string, opts: { now?: number; force?: boolean; allowBacktest?: boolean } = {}): Promise<HealthCheck> {
    const now = opts.now ?? Date.now();
    const day = Math.floor(now / DAY) * DAY;
    const existing = await this.d.db.prepare("SELECT * FROM health_checks WHERE pilot_id = ? AND day = ?").get<Row>(pilotId, day);
    if (existing && !opts.force) return view(existing);
    const p = await this.d.pilots.get(pilotId);
    if (!p) throw new Error("pilot not found");

    const findings: Finding[] = [];
    const add = (check: string, severity: Finding["severity"], detail: string, data?: unknown) => findings.push({ check, severity, detail, ...(data !== undefined ? { data } : {}) });
    await this.errors(p, now, add);
    await this.schedule(p, now, add);
    await this.staleData(p, now, add);
    if (opts.allowBacktest !== false) await this.drift(p, now, add);
    await this.slippage(p, now, add);
    await this.bond(p, add);
    await this.fees(p, now, add);
    if (!findings.some((f) => f.severity !== "ok")) add("all", "ok", "no problems found");

    // "Keep running" mutes the same check for a few days.
    const muted = new Set(
      (await this.d.db.prepare("SELECT findings_json FROM health_checks WHERE pilot_id = ? AND answer = 'keep' AND answered_at > ?").all<{ findings_json: string }>(pilotId, now - MUTE_DAYS * DAY))
        .flatMap((r) => parse<Finding[]>(r.findings_json, []))
        .filter((f) => f.severity === "warn" || f.severity === "stop")
        .map((f) => f.check),
    );
    for (const f of findings) if ((f.severity === "warn" || f.severity === "stop") && muted.has(f.check)) f.severity = "muted";
    const live = findings.filter((f) => f.severity === "warn" || f.severity === "stop");
    const status: HealthCheck["status"] = live.some((f) => f.severity === "stop") ? "stop" : live.length ? "warn" : "ok";
    const question = live.length
      ? {
          text: `${p.name}: ${live.length} problem${live.length > 1 ? "s" : ""} today (${live.map((f) => f.check).join(", ")}). Pause the pilot, or keep it running?`,
          options: [
            { id: "pause" as const, label: "Pause" },
            { id: "keep" as const, label: "Keep running" },
          ],
        }
      : null;
    const id = existing?.id ?? randomUUID();
    if (existing) {
      await this.d.db
        .prepare("UPDATE health_checks SET status = ?, findings_json = ?, question_json = ?, answer = NULL, answered_at = NULL, created_at = ? WHERE id = ?")
        .run(status, json(findings), json(question), now, id);
    } else {
      await this.d.db
        .prepare("INSERT INTO health_checks (id, pilot_id, day, status, findings_json, question_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, pilotId, day, status, json(findings), json(question), now);
    }
    if (status !== "ok") await logEvent(this.d.db, pilotId, status === "stop" ? "error" : "warn", `health check: ${live.map((f) => `${f.check}: ${f.detail}`).join("; ")}`, { health_check_id: id });
    return (await this.get(id))!;
  }

  /** The owner's answer. "pause" pauses an active pilot (resume with PATCH paused:false). */
  async answer(id: string, answer: "pause" | "keep") {
    const c = await this.get(id);
    if (!c) return null;
    if (!c.question) throw new Error("this check asked nothing");
    if (c.answer) throw new Error(`already answered: ${c.answer}`);
    await this.d.db.prepare("UPDATE health_checks SET answer = ?, answered_at = ? WHERE id = ?").run(answer, Date.now(), id);
    if (answer === "pause") {
      const p = await this.d.pilots.get(c.pilot_id);
      if (p?.status === "active") await this.d.pilots.update(p.id, { status: "paused" });
    }
    await logEvent(this.d.db, c.pilot_id, "info", `owner answered the health check: ${answer === "pause" ? "pause" : "keep running"}`, { health_check_id: id });
    return { check: await this.get(id), pilot: await this.d.pilots.get(c.pilot_id) };
  }

  // ------------------------------------------------------------------ checks

  private async errors(p: Pilot, now: number, add: (c: string, s: Finding["severity"], d: string, x?: unknown) => void) {
    const failed = await this.d.db.prepare("SELECT error FROM runs WHERE pilot_id = ? AND status = 'error' AND started_at > ? ORDER BY started_at DESC").all<{ error: string | null }>(p.id, now - DAY);
    if (failed.length) add("errors", failed.length >= 3 ? "stop" : "warn", `${failed.length} failed run(s) in 24 h; last: ${failed[0]!.error ?? "unknown"}`);
    const execs = await this.d.db
      .prepare("SELECT status, error_code FROM executions WHERE pilot_id = ? AND created_at > ? AND status IN ('needs_attention','refused','blocked','FAILED','REFUNDED')")
      .all<{ status: string; error_code: string | null }>(p.id, now - DAY);
    const attention = execs.filter((e) => e.status === "needs_attention");
    if (attention.length) add("errors", "stop", `${attention.length} swap(s) need attention: ${[...new Set(attention.map((e) => e.error_code))].join(", ")}`);
    const refused = execs.filter((e) => e.status !== "needs_attention" && !EXPECTED_BLOCKS.has(e.error_code ?? ""));
    if (refused.length) add("refused", "warn", `${refused.length} swap(s) refused or failed in 24 h: ${[...new Set(refused.map((e) => e.error_code ?? e.status))].join(", ")}`);
  }

  private async schedule(p: Pilot, now: number, add: (c: string, s: Finding["severity"], d: string) => void) {
    if (p.status !== "active") return;
    const last = await this.d.db.prepare("SELECT MAX(started_at) AS t FROM runs WHERE pilot_id = ?").get<{ t: number | null }>(p.id);
    const every = Number(p.strategy.params.every_hours ?? 24) * 3_600_000;
    const since = now - (last?.t ?? p.created_at);
    if (since > 2 * every + 3_600_000) add("schedule", "warn", `no run for ${(since / 3_600_000).toFixed(0)} h (the script runs every ${(every / 3_600_000).toFixed(0)} h)`);
  }

  private symbols(p: Pilot): string[] {
    if (p.swarm?.scripts.length) return [...new Set(p.swarm.scripts.flatMap((s) => strategySymbols(s.id, { stable: "USDC", ...s.params })))];
    return strategySymbols(p.strategy.id, p.strategy.params);
  }

  private async staleData(p: Pilot, now: number, add: (c: string, s: Finding["severity"], d: string) => void) {
    const risk = this.symbols(p).filter((s) => !DEFAULT_UNIVERSE.find((a) => a.symbol === s)?.stable);
    const universe = await this.d.catalog.universe().catch(() => []);
    for (const s of risk) {
      if (!universe.find((a) => a.symbol === s)?.price) add("stale_data", "stop", `no current price for ${s}`);
      const row = await this.d.db.prepare("SELECT MAX(day) AS day FROM price_history WHERE symbol = ?").get<{ day: number | null }>(s);
      if (!row?.day) continue; // history is fetched on the first run that needs it
      const age = (now - row.day) / DAY;
      // The newest closed day is yesterday's (its timestamp is its start), so ~2 days is normal.
      if (age > 4) add("stale_data", "stop", `daily closes for ${s} are ${age.toFixed(1)} days old`);
      else if (age > 2.5) add("stale_data", "warn", `daily closes for ${s} are ${age.toFixed(1)} days old`);
    }
  }

  private async drift(p: Pilot, now: number, add: (c: string, s: Finding["severity"], d: string, x?: unknown) => void) {
    if (p.swarm?.scripts.length) return add("drift", "ok", "swarm pilots: drift is not replayed per sleeve yet");
    if (!this.d.wasm.available()) return;
    const from = Math.floor((now - 7 * DAY) / DAY) * DAY;
    const to = Math.floor(now / DAY) * DAY - DAY; // the last closed day
    const start = await this.d.db.prepare("SELECT ts, total_usd, holdings_json FROM snapshots WHERE pilot_id = ? AND ts >= ? ORDER BY ts LIMIT 1").get<{ ts: number; total_usd: number; holdings_json: string }>(p.id, from);
    const end = await this.d.db.prepare("SELECT ts, total_usd, holdings_json FROM snapshots WHERE pilot_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1").get<{ ts: number; total_usd: number; holdings_json: string }>(p.id, now);
    if (!start || !end || end.ts - start.ts < 5 * DAY) return; // needs most of a week of record
    const symbols = new Set(strategySymbols(p.strategy.id, p.strategy.params));
    const rows = (h: string) => parse<Array<{ symbol: string; units: number; usd: number | null }>>(h, []).filter((r) => symbols.has(r.symbol));
    const startRows = rows(start.holdings_json);
    const startUsd = startRows.reduce((a, r) => a + (r.usd ?? 0), 0);
    const endUsd = rows(end.holdings_json).reduce((a, r) => a + (r.usd ?? 0), 0);
    if (startUsd <= 0) return;
    try {
      const sim = await backtest(this.d.wasm, this.d.history, {
        strategy: p.strategy.id,
        params: p.strategy.params,
        from: Math.floor(start.ts / DAY) * DAY,
        to,
        initial_usd: startUsd,
        cost_bps: this.d.costBps,
        initial_units: Object.fromEntries(startRows.map((r) => [r.symbol, r.units])),
      });
      const live = endUsd / startUsd - 1;
      const simulated = sim.metrics.total_return;
      const gap = live - simulated;
      const sev = Math.abs(gap) > 0.05 ? "stop" : Math.abs(gap) > 0.02 ? "warn" : "ok";
      add("drift", sev, `live ${(live * 100).toFixed(1)}% vs the script replayed on daily closes ${(simulated * 100).toFixed(1)}% over the week`, { live, simulated });
    } catch (e) {
      add("drift", "ok", `drift not checked: ${(e as Error).message}`);
    }
  }

  private async slippage(p: Pilot, now: number, add: (c: string, s: Finding["severity"], d: string, x?: unknown) => void) {
    if (p.mode !== "live") return;
    const rows = await this.d.db.prepare("SELECT response_json FROM executions WHERE pilot_id = ? AND kind = 'live' AND status = 'SUCCESS' AND created_at > ?").all<{ response_json: string | null }>(p.id, now - 7 * DAY);
    const slips: number[] = [];
    for (const r of rows) {
      const d = parse<{ details?: { amount_out?: string | null; expected_amount_out?: string } }>(r.response_json, {}).details;
      const got = Number(d?.amount_out);
      const exp = Number(d?.expected_amount_out);
      if (got > 0 && exp > 0) slips.push(1 - got / exp);
    }
    if (!slips.length) return;
    const avg = slips.reduce((a, b) => a + b, 0) / slips.length;
    const assumed = (this.d.assumedSlippageBps ?? 25) / 10_000;
    if (avg > 2 * assumed) add("slippage", "warn", `average slippage ${(avg * 100).toFixed(2)}% over ${slips.length} fill(s) vs ${(assumed * 100).toFixed(2)}% assumed`, { avg, fills: slips.length });
    else add("slippage", "ok", `average slippage ${(avg * 100).toFixed(2)}% over ${slips.length} fill(s)`);
  }

  private async bond(p: Pilot, add: (c: string, s: Finding["severity"], d: string, x?: unknown) => void) {
    if (!this.d.nft.contract || !this.d.wasm.available()) return;
    const scripts = p.swarm?.scripts.length ? p.swarm.scripts.map((s) => s.id) : [p.strategy.id];
    for (const id of new Set(scripts)) {
      const g = await copyGate(this.d.db, this.d.nft, p.owner, id, this.d.wasm.wasmSha256);
      if (!g.open) add("bond", "stop", `${id}: ${g.reason}`, g);
    }
  }

  private async fees(p: Pilot, now: number, add: (c: string, s: Finding["severity"], d: string) => void) {
    const rows = await this.d.db
      .prepare("SELECT token_id, error_code, error FROM fee_ledger WHERE pilot_id = ? AND updated_at > ? AND status IN ('blocked','refused','needs_attention') AND COALESCE(error_code, '') NOT IN ('fees_disabled','live_execution_disabled')")
      .all<{ token_id: string; error_code: string | null; error: string | null }>(p.id, now - 7 * DAY);
    for (const r of rows) add("fees", "warn", `weekly fee for ${r.token_id} not paid: ${r.error_code}: ${r.error ?? ""}`);
  }
}
