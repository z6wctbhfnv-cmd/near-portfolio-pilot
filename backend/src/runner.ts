/**
 * One pilot "tick": read the portfolio, run the strategy (OutLayer TEE or the same WASM locally),
 * execute its trades (paper or live), take a snapshot, publish the run to the strategy NFT.
 */
import { randomUUID } from "node:crypto";
import type { AgentGateway } from "./agent.js";
import type { StrategyOutput } from "./backtest.js";
import { copyGate } from "./copying.js";
import { type Db, json, logEvent } from "./db.js";
import type { Executor, ExecutionRow } from "./executor.js";
import type { PriceHistory } from "./history.js";
import type { NftPublisher } from "./nft.js";
import type { OutLayerClient } from "./outlayer.js";
import { type PerpExecutor, perpTargets } from "./perps.js";
import type { Pilot, Pilots } from "./pilots.js";
import { parseStrategyParams, STRATEGY_INFO, type StrategyId, strategySymbols } from "./strategies.js";
import { allocate, attribute, initialState, plan, rebalanceSleeves, trueUp, valueOf } from "./swarm.js";
import { DEFAULT_UNIVERSE, type TokenCatalog } from "./tokens.js";
import { sha256Hex, type StrategyWasm } from "./wasm.js";

export type RunnerDeps = {
  db: Db;
  pilots: Pilots;
  gateway: AgentGateway;
  catalog: TokenCatalog;
  history: PriceHistory;
  wasm: StrategyWasm;
  outlayer: OutLayerClient;
  executor: Executor;
  nft: NftPublisher;
  engine: "local" | "outlayer" | "auto";
  outlayerProject?: string;
  /** Who is stopped when a copied script's holder bond is short: see config BOND_GATE. */
  bondGate?: "live" | "all" | "off";
  /** Hyperliquid testnet perps; null when HL_PERPS_ENABLED is off. */
  perps?: PerpExecutor | null;
};

type StrategyInput = { strategy: StrategyId; params: Record<string, unknown>; now_ms: number; state: unknown; portfolio: Array<{ symbol: string; units: number; price: number }>; history: Record<string, number[]> };

/** One strategy NFT per pilot listing: the strategy id plus the pilot's short id. */

export type Holdings = Record<string, number>;

export class Runner {
  private running = new Set<string>();

  constructor(private readonly d: RunnerDeps) {}

  /** Current holdings in whole units, by universe symbol. */
  async holdings(p: Pilot): Promise<{ holdings: Holdings; source: "paper" | "agent" }> {
    if (p.mode === "paper") return { holdings: { ...(p.paper_holdings ?? {}) }, source: "paper" };
    if (!p.agent_id) throw new Error("live pilot has no agent yet");
    const b = await this.d.gateway.api().getBalances(p.agent_id, { source: "public" });
    const holdings: Holdings = {};
    for (const e of b.balances) {
      const u = DEFAULT_UNIVERSE.find((a) => a.asset_id === e.asset_id);
      if (!u) continue;
      const token = await this.d.catalog.get(e.asset_id);
      const units = e.balance !== null ? Number(e.balance) : token ? Number(e.balance_raw) / 10 ** token.decimals : 0;
      holdings[u.symbol] = (holdings[u.symbol] ?? 0) + units;
    }
    return { holdings, source: "agent" };
  }

  async valuation(holdings: Holdings) {
    const u = await this.d.catalog.universe();
    const rows = Object.entries(holdings).map(([symbol, units]) => {
      const price = u.find((a) => a.symbol === symbol)?.price ?? null;
      return { symbol, units, price, usd: price !== null ? Number((units * price).toFixed(2)) : null };
    });
    return { rows, total_usd: Number(rows.reduce((a, r) => a + (r.usd ?? 0), 0).toFixed(2)) };
  }

  async snapshot(pilotId: string, total: number, rows: unknown) {
    await this.d.db.prepare("INSERT INTO snapshots (pilot_id, ts, total_usd, holdings_json) VALUES (?, ?, ?, ?)").run(pilotId, Date.now(), total, json(rows));
  }

  /** Runs one decision for a pilot. Never throws for expected failures: they are recorded on the run. */
  async run(pilotId: string, opts: { reason?: string } = {}) {
    if (this.running.has(pilotId)) throw new Error("a run for this pilot is already in progress");
    this.running.add(pilotId);
    const runId = randomUUID();
    const started = Date.now();
    await this.d.db
      .prepare("INSERT INTO runs (id, pilot_id, started_at, engine, status) VALUES (?, ?, ?, 'local', 'running')")
      .run(runId, pilotId, started);
    try {
      return await this.runInner(pilotId, runId, started, opts.reason ?? "manual");
    } catch (e) {
      const msg = (e as Error).message;
      await this.d.db.prepare("UPDATE runs SET status = 'error', error = ?, finished_at = ? WHERE id = ?").run(msg, Date.now(), runId);
      await logEvent(this.d.db, pilotId, "error", `run failed: ${msg}`, { run_id: runId });
      return await this.getRun(runId);
    } finally {
      this.running.delete(pilotId);
    }
  }

  private async runInner(pilotId: string, runId: string, started: number, reason: string) {
    const p = await this.d.pilots.get(pilotId);
    if (!p) throw new Error("pilot not found");
    const params = p.strategy.params;
    const symbols = strategySymbols(p.strategy.id, params);

    const { holdings } = await this.holdings(p);
    const universe = await this.d.catalog.universe();
    const portfolio = [];
    for (const s of new Set([...symbols, ...Object.keys(holdings)])) {
      const price = universe.find((a) => a.symbol === s)?.price;
      if (!price) {
        if (symbols.includes(s)) throw new Error(`no current price for ${s}`);
        continue; // unmanaged asset without a price: leave it out
      }
      portfolio.push({ symbol: s, units: holdings[s] ?? 0, price });
    }
    portfolio.sort((a, b) => a.symbol.localeCompare(b.symbol));

    // Drawdown stop, checked before the strategy gets a say: below the peak by the owner's limit,
    // sell everything to the stablecoin and pause until the owner resumes.
    const stop = await this.drawdownCheck(p, portfolio);
    if (stop.triggered) return this.emergencyExit(p, runId, holdings, portfolio, stop, reason);

    if (p.swarm?.scripts.length) return this.runSwarm(p, runId, started, reason, holdings);

    // A copied script runs only while its holder's bond covers the copiers (see copying.ts).
    const notes: string[] = [];
    const gate = await this.copyCheck(p, p.strategy.id);
    if (!gate.open) {
      if (this.blocksOnBond(p)) return this.skipRun(p, runId, gate.reason, { bond: gate });
      notes.push(`${gate.reason} (a live pilot would not trade)`);
    }

    const history = await this.historyFor(p.strategy.id, params, symbols, portfolio);
    const state = p.strategy.state && typeof p.strategy.state === "object" ? p.strategy.state : {};
    const input: StrategyInput = { strategy: p.strategy.id, params, now_ms: started, state, portfolio, history };
    const inputJson = JSON.stringify(input);
    const { output, engine, attestation } = await this.decide(input, notes);
    const outputJson = JSON.stringify(output);
    const wasmSha = this.d.wasm.available() ? this.d.wasm.wasmSha256 : null;
    await this.d.db
      .prepare("UPDATE runs SET engine = ?, wasm_sha256 = ?, input_sha256 = ?, output_sha256 = ?, input_json = ?, output_json = ?, attestation_json = ? WHERE id = ?")
      .run(engine, wasmSha, sha256Hex(inputJson), sha256Hex(outputJson), inputJson, outputJson, json(attestation), runId);

    if (!output.ok) throw new Error(`strategy refused the input: ${output.error}`);

    // Act.
    let executions: ExecutionRow[] = [];
    if (output.trades.length) {
      const limits = await this.limits(p);
      if (p.mode === "paper") {
        const h = { ...holdings };
        executions = await this.d.executor.paper(pilotId, runId, h, output.trades, limits);
        await this.d.pilots.update(pilotId, { paper_holdings_json: json(h) });
      } else {
        executions = await this.d.executor.live(pilotId, runId, p.agent_id!, output.trades, limits);
      }
    }

    // Persist strategy state unless every trade was refused before anything was sent. A swap that is
    // pending approval, uncertain or awaiting a same-key replay counts as acted: otherwise the next
    // run would plan the same buy again under a new key (a double buy).
    const acted = !output.trades.length || executions.some((e) => e.status !== "blocked" && e.status !== "refused");
    const everyHours = Number(params.every_hours ?? 24);
    await this.d.pilots.update(pilotId, {
      ...(acted ? { strategy_state_json: json(output.state ?? {})! } : {}),
      next_run_at: Date.now() + everyHours * 3_600_000,
    });
    await this.runPerps(p, runId, output.target_weights, notes);

    const after = await this.holdings((await this.d.pilots.get(pilotId))!);
    const val = await this.valuation(after.holdings);
    await this.snapshot(pilotId, val.total_usd, val.rows);

    await this.d.db
      .prepare("UPDATE runs SET status = 'ok', total_usd = ?, finished_at = ?, error = ? WHERE id = ?")
      .run(val.total_usd, Date.now(), notes.length ? notes.join("; ") : null, runId);
    await logEvent(this.d.db, pilotId, "info", `run ${reason}: ${output.trades.length} trade(s), engine ${engine}`, { run_id: runId });

    await this.publish(runId, p, started).catch(async (e) => {
      await this.d.db.prepare("UPDATE runs SET nft_status = 'failed', error = COALESCE(error || '; ', '') || ? WHERE id = ?").run(`nft: ${(e as Error).message}`, runId);
    });
    return await this.getRun(runId);
  }

  /**
   * Marks the run for the strategy NFT. Runs are not written one by one: once a week the scheduler
   * appends one checkpoint per script (see nft.ts, publishCheckpoints).
   */
  private async publish(runId: string, _p: Pilot, _startedAt: number) {
    const run = (await this.getRun(runId))!;
    const status = this.d.nft.configured && run.wasm_sha256 ? "queued" : "unpublished";
    await this.d.db.prepare("UPDATE runs SET nft_status = ? WHERE id = ?").run(status, runId);
  }

  /** Closed daily closes plus the live price as the latest point, for the script's lookback. */
  private async historyFor(id: StrategyId, params: Record<string, unknown>, symbols: string[], portfolio: Array<{ symbol: string; price: number }>) {
    const lookback = STRATEGY_INFO[id].history_days(params);
    const history: Record<string, number[]> = {};
    if (lookback > 0) {
      const risk = symbols.filter((s) => !DEFAULT_UNIVERSE.find((a) => a.symbol === s)?.stable);
      await this.d.history.ensure(risk, Date.now() - (lookback + 5) * 86_400_000);
      for (const s of risk) {
        const closes = await this.d.history.lastCloses(s, lookback - 1);
        const live = portfolio.find((x) => x.symbol === s)?.price;
        history[s] = live ? [...closes, live] : closes;
      }
    }
    return history;
  }

  /** Decide: OutLayer TEE when configured, else the same module locally. */
  private async decide(input: StrategyInput, notes: string[]): Promise<{ output: StrategyOutput; engine: "local" | "outlayer"; attestation: unknown }> {
    const useOutLayer = this.d.engine === "outlayer" || (this.d.engine === "auto" && this.d.outlayer.configured);
    if (useOutLayer) {
      try {
        const call = await this.d.outlayer.run(input);
        let attestation: unknown = { call_id: call.call_id, attestation_url: call.attestation_url, time_ms: call.time_ms, compute_cost: call.compute_cost };
        if (call.call_id) {
          try {
            attestation = { ...(attestation as object), record: await this.d.outlayer.attestation(call.call_id) };
          } catch (e) {
            notes.push(`attestation record not readable yet: ${(e as Error).message}`);
          }
        }
        return { output: call.output as unknown as StrategyOutput, engine: "outlayer", attestation };
      } catch (e) {
        if (this.d.engine === "outlayer") throw e;
        notes.push(`OutLayer failed, ran locally: ${(e as Error).message}`);
      }
    }
    return { output: this.d.wasm.run<StrategyOutput>(JSON.stringify(input)).output, engine: "local", attestation: null };
  }

  private copyCheck(p: Pilot, strategyId: string) {
    return copyGate(this.d.db, this.d.nft, p.owner, strategyId, this.d.wasm.available() ? this.d.wasm.wasmSha256 : null);
  }

  private blocksOnBond(p: Pilot) {
    const mode = this.d.bondGate ?? "live";
    return mode === "all" || (mode === "live" && p.mode === "live");
  }

  /** Ends a run without deciding or trading, and tries again at the next interval. */
  private async skipRun(p: Pilot, runId: string, why: string, output: Record<string, unknown>) {
    const everyHours = Number(p.strategy.params.every_hours ?? 24);
    await this.d.db.prepare("UPDATE runs SET status = 'skipped', error = ?, output_json = ?, finished_at = ? WHERE id = ?").run(why, json({ ok: false, skipped: why, ...output }), Date.now(), runId);
    await this.d.pilots.update(p.id, { next_run_at: Date.now() + everyHours * 3_600_000 });
    await logEvent(this.d.db, p.id, "warn", `run skipped: ${why}`, { run_id: runId });
    return await this.getRun(runId);
  }

  /** Perp weights in the decision go to Hyperliquid testnet, when perps are on. */
  private async runPerps(p: Pilot, runId: string, weights: Record<string, number> | undefined, notes: string[]) {
    const targets = perpTargets(weights);
    if (!Object.keys(targets).length) return;
    if (!this.d.perps) {
      notes.push(`perp weights ${Object.entries(targets).map(([c, w]) => `${c} ${w}`).join(", ")} ignored: HL_PERPS_ENABLED is off`);
      return;
    }
    try {
      const rows = await this.d.perps.rebalance(p.id, runId, targets, p.mandate?.max_trade_usd ?? null);
      notes.push(`perps (Hyperliquid testnet): ${rows.map((r) => `${r.coin} ${r.status}`).join(", ") || "nothing to change"}`);
    } catch (e) {
      notes.push(`perps failed: ${(e as Error).message}`);
      await logEvent(this.d.db, p.id, "warn", `perps failed: ${(e as Error).message}`, { run_id: runId });
    }
  }

  /**
   * A swarm run (see swarm.ts): each followed script decides on its own sleeve, the main agent nets
   * the trades, sends only the net, and books the fills back to the sleeves.
   */
  private async runSwarm(p: Pilot, runId: string, started: number, reason: string, holdings: Holdings) {
    const cfg = p.swarm!;
    const universe = await this.d.catalog.universe();
    const px: Record<string, number> = Object.fromEntries(universe.filter((a) => a.price).map((a) => [a.symbol, a.price!]));
    const notes: string[] = [];
    const DAY = 86_400_000;

    // Books: the wallet is the truth; the allocation is reviewed every `review_every_days`.
    let st = p.swarm_state;
    const keys = cfg.scripts.map((s) => s.key);
    const changed = !st || keys.some((k) => !(k in st!.alloc) && !(k in st!.sleeves)) || Object.keys(st.alloc).some((k) => !keys.includes(k));
    if (!st) {
      st = initialState(cfg, holdings, px, started);
      notes.push(`allocation: ${st.alloc_reason}`);
    } else {
      let sleeves = trueUp(st.sleeves, holdings);
      if (changed || started - st.alloc_at >= cfg.review_every_days * DAY) {
        const a = allocate(cfg);
        sleeves = rebalanceSleeves(sleeves, a.alloc, px);
        st = { sleeves, alloc: a.alloc, alloc_at: started, alloc_reason: a.reason };
        notes.push(`allocation reviewed: ${a.reason}`);
      } else {
        st = { ...st, sleeves };
      }
    }

    // Each script agent decides on its own sleeve, with the same WASM a single pilot runs.
    const wants: Array<{ key: string; trades: Array<{ sell: string; buy: string; usd: number }> }> = [];
    const agents: Array<Record<string, unknown>> = [];
    const nextState: Record<string, unknown> = {};
    const inputs: Record<string, StrategyInput> = {};
    let engineUsed: "local" | "outlayer" = "local";
    for (const s of cfg.scripts) {
      const sleeve = st.sleeves[s.key] ?? { units: {}, state: null };
      const value = valueOf(sleeve.units, px);
      const gate = await this.copyCheck(p, s.id);
      if (!gate.open && this.blocksOnBond(p)) {
        agents.push({ key: s.key, strategy: s.id, value_usd: value, skipped: gate.reason });
        continue;
      }
      if (!gate.open) notes.push(`${s.key}: ${gate.reason} (a live pilot would not trade it)`);
      // Everything in a sleeve is this script's to manage: a reallocation can hand it a slice of
      // assets it does not trade, and it must be able to sell them (the WASM's sell_unmanaged).
      const params = { ...parseStrategyParams(s.id, { stable: p.strategy.params.stable ?? "USDC", ...s.params }), sell_unmanaged: true };
      const symbols = strategySymbols(s.id, params);
      const missing = symbols.filter((x) => !px[x]);
      if (missing.length) {
        agents.push({ key: s.key, strategy: s.id, value_usd: value, skipped: `no current price for ${missing.join(", ")}` });
        continue;
      }
      const portfolio = [...new Set([...symbols, ...Object.keys(sleeve.units).filter((x) => px[x])])]
        .sort()
        .map((x) => ({ symbol: x, units: sleeve.units[x] ?? 0, price: px[x]! }));
      const history = await this.historyFor(s.id, params, symbols, portfolio);
      const input: StrategyInput = { strategy: s.id, params, now_ms: started, state: sleeve.state && typeof sleeve.state === "object" ? sleeve.state : {}, portfolio, history };
      inputs[s.key] = input;
      const { output, engine } = await this.decide(input, notes);
      if (engine === "outlayer") engineUsed = "outlayer";
      if (!output.ok) {
        agents.push({ key: s.key, strategy: s.id, value_usd: value, error: output.error ?? "refused the input" });
        continue;
      }
      wants.push({ key: s.key, trades: output.trades });
      nextState[s.key] = output.state ?? {};
      agents.push({ key: s.key, strategy: s.id, share: st.alloc[s.key] ?? 0, value_usd: Number(value.toFixed(2)), trades: output.trades, notes: output.notes, target_weights: output.target_weights });
    }

    // The main agent: net, keep inside the policy, send only the net.
    const allowed =
      p.mode === "live" && p.policy && (p.policy as { assets?: string[] | "any" }).assets !== "any"
        ? new Set(((p.policy as { assets: string[] }).assets ?? []).map((id) => DEFAULT_UNIVERSE.find((a) => a.asset_id === id)?.symbol).filter((x): x is string => Boolean(x)))
        : undefined;
    const pl = plan(wants, { allowed });
    notes.push(...pl.reasons);
    let executions: ExecutionRow[] = [];
    let after = holdings;
    if (pl.trades.length) {
      const limits = await this.limits(p);
      if (p.mode === "paper") {
        const h = { ...holdings };
        executions = await this.d.executor.paper(p.id, runId, h, pl.trades, limits);
        await this.d.pilots.update(p.id, { paper_holdings_json: json(h) });
      } else {
        executions = await this.d.executor.live(p.id, runId, p.agent_id!, pl.trades, limits);
      }
      after = (await this.holdings((await this.d.pilots.get(p.id))!)).holdings;
    }
    const realized = Object.fromEntries([...new Set([...Object.keys(after), ...Object.keys(holdings)])].map((a) => [a, (after[a] ?? 0) - (holdings[a] ?? 0)]));
    const sleeves = attribute(st.sleeves, pl, realized, px, after);
    // A script's state moves on when its wish was crossed or something it wanted was sent.
    const sent = executions.some((e) => e.status !== "blocked" && e.status !== "refused");
    for (const [k, next] of Object.entries(nextState)) {
      const d = pl.deltas[k] ?? {};
      const crossed = Object.keys(d).some((a) => (pl.crossed[a] ?? 0) > 0.005);
      if (!Object.keys(d).length || crossed || sent) sleeves[k] = { units: sleeves[k]?.units ?? {}, state: next };
    }
    const everyHours = Math.min(...cfg.scripts.map((s) => Number(s.params.every_hours ?? 24)));
    await this.d.pilots.update(p.id, { swarm_state_json: json({ ...st, sleeves })!, next_run_at: Date.now() + everyHours * 3_600_000 });

    // Perps: the scripts' perp weights, blended by their shares.
    const perp: Record<string, number> = {};
    for (const a of agents) for (const [k, w] of Object.entries((a.target_weights as Record<string, number>) ?? {})) if (k.endsWith("-PERP")) perp[k] = (perp[k] ?? 0) + w * Number(a.share ?? 0);
    await this.runPerps(p, runId, perp, notes);

    const val = await this.valuation(after);
    await this.snapshot(p.id, val.total_usd, val.rows);
    for (const a of agents) {
      const sl = sleeves[a.key as string];
      if (sl) a.value_after_usd = Number(valueOf(sl.units, px).toFixed(2));
    }
    const output = { ok: true, engine: "swarm", trades: pl.trades, plan: { crossed: pl.crossed, dropped: pl.dropped }, agents, alloc: st.alloc, notes };
    const inputJson = JSON.stringify({ swarm: cfg, inputs });
    const wasmSha = this.d.wasm.available() ? this.d.wasm.wasmSha256 : null;
    await this.d.db
      .prepare("UPDATE runs SET engine = ?, wasm_sha256 = ?, input_sha256 = ?, output_sha256 = ?, input_json = ?, output_json = ?, status = 'ok', total_usd = ?, finished_at = ?, error = ? WHERE id = ?")
      .run(engineUsed, wasmSha, sha256Hex(inputJson), sha256Hex(JSON.stringify(output)), inputJson, json(output), val.total_usd, Date.now(), notes.length ? notes.join("; ") : null, runId);
    await logEvent(this.d.db, p.id, "info", `swarm run ${reason}: ${wants.length} script(s), ${pl.trades.length} net trade(s), ${Object.values(pl.crossed).filter((x) => x > 0.005).length} crossed`, { run_id: runId });
    return await this.getRun(runId);
  }

  /** Where the portfolio stands against the owner's drawdown stop. */
  async drawdownCheck(p: Pilot, portfolio: Array<{ symbol: string; units: number; price: number }>) {
    const cfg = p.mandate?.drawdown_stop ?? { enabled: true, max_drawdown: 0.2 };
    const value = portfolio.reduce((a, x) => a + x.units * x.price, 0);
    const row = await this.d.db
      .prepare("SELECT MAX(total_usd) AS peak FROM snapshots WHERE pilot_id = ? AND ts >= ?")
      .get<{ peak: number | null }>(p.id, p.risk_since ?? 0);
    const peak = Math.max(row?.peak ?? 0, value);
    const drawdown = peak > 0 ? 1 - value / peak : 0;
    // Nothing risky held means nothing to sell (a fall in value then comes from money moved out).
    const stable = String(p.strategy.params.stable ?? p.mandate?.stable ?? "USDC");
    const atRisk = portfolio.some((x) => x.symbol !== stable && !DEFAULT_UNIVERSE.find((a) => a.symbol === x.symbol)?.stable && x.units * x.price >= 1);
    return { enabled: cfg.enabled, limit: cfg.max_drawdown, value, peak, drawdown, triggered: cfg.enabled && atRisk && peak > 0 && drawdown >= cfg.max_drawdown };
  }

  /**
   * Sells every risk asset to the stablecoin. The mandate's per-trade and budget caps do not slow the
   * exit down (it only reduces risk); on a live agent the signed Agent API policy still applies, so
   * whatever it refuses is retried on the next run. The pilot pauses once nothing risky is left.
   */
  private async emergencyExit(
    p: Pilot,
    runId: string,
    holdings: Record<string, number>,
    portfolio: Array<{ symbol: string; units: number; price: number }>,
    stop: Awaited<ReturnType<Runner["drawdownCheck"]>>,
    reason: string,
  ) {
    const stable = String(p.strategy.params.stable ?? p.mandate?.stable ?? "USDC");
    const isStable = (s: string) => s === stable || DEFAULT_UNIVERSE.find((a) => a.symbol === s)?.stable;
    const trades = portfolio
      .filter((x) => !isStable(x.symbol) && x.units * x.price >= 1)
      .map((x) => ({ sell: x.symbol, buy: stable, usd: Math.floor(x.units * x.price * 100) / 100 }));
    const note = `drawdown stop: ${(stop.drawdown * 100).toFixed(1)}% below the peak of ${stop.peak.toFixed(2)} USD (limit ${(stop.limit * 100).toFixed(0)}%)`;
    const output = { ok: true, engine: "risk", trades, notes: [note], target_weights: { [stable]: 1 } };
    await this.d.db.prepare("UPDATE runs SET engine = 'local', output_json = ? WHERE id = ?").run(json(output), runId);
    const limits = { maxTradeUsd: null, remainingBudgetUsd: null, minTradeUsd: 1 };
    let executions: ExecutionRow[] = [];
    if (trades.length) {
      if (p.mode === "paper") {
        const h = { ...holdings };
        executions = await this.d.executor.paper(p.id, runId, h, trades, limits);
        await this.d.pilots.update(p.id, { paper_holdings_json: json(h) });
      } else {
        executions = await this.d.executor.live(p.id, runId, p.agent_id!, trades, limits);
      }
    }
    const after = await this.holdings((await this.d.pilots.get(p.id))!);
    const val = await this.valuation(after.holdings);
    await this.snapshot(p.id, val.total_usd, val.rows);
    const riskLeft = val.rows.some((r) => !isStable(r.symbol) && (r.usd ?? 0) >= 1);
    // Fully out: pause. Something refused (live policy budget): keep going on the next run.
    await this.d.pilots.update(p.id, riskLeft ? { next_run_at: Date.now() + 3_600_000 } : { status: "paused" });
    await this.d.db
      .prepare("UPDATE runs SET status = 'ok', total_usd = ?, finished_at = ?, error = ? WHERE id = ?")
      .run(val.total_usd, Date.now(), note, runId);
    await logEvent(this.d.db, p.id, "warn", `${note}: sold ${trades.length} position(s) to ${stable}${riskLeft ? ", the rest on the next run" : ", pilot paused until you resume"}`, {
      run_id: runId,
      reason,
      executions: executions.map((e) => e.status),
    });
    return await this.getRun(runId);
  }

  /**
   * The mandate's caps for this run. Paper pilots count their own fills against every budget window
   * the owner set (day, week, month) and take the tightest; live pilots take the remaining budget
   * from the Agent API's policy usage instead.
   */
  async limits(p: Pilot) {
    const m = p.mandate;
    const minTradeUsd = Number(p.strategy.params.min_trade_usd ?? 5);
    let remainingBudgetUsd: number | null = null;
    if (p.mode === "paper" && m) {
      const spentSince = this.d.db.prepare(
        "SELECT COALESCE(SUM(usd), 0) AS s FROM executions WHERE pilot_id = ? AND status = 'paper_filled' AND created_at > ?",
      );
      const day = 86_400_000;
      for (const [cap, windowMs] of [
        [m.budget.daily_usd, day],
        [m.budget.weekly_usd, 7 * day],
        [m.budget.monthly_usd, 30 * day],
      ] as const) {
        if (!cap) continue;
        const spent = (await spentSince.get<{ s: number }>(p.id, Date.now() - windowMs))?.s ?? 0;
        const left = Math.max(0, cap - spent);
        remainingBudgetUsd = remainingBudgetUsd === null ? left : Math.min(remainingBudgetUsd, left);
      }
    }
    return { maxTradeUsd: m?.max_trade_usd ?? null, remainingBudgetUsd, minTradeUsd };
  }

  async getRun(id: string) {
    const r = await this.d.db.prepare("SELECT * FROM runs WHERE id = ?").get<Record<string, unknown>>(id);
    if (!r) return undefined;
    const p = (s: unknown) => (typeof s === "string" ? JSON.parse(s) : null);
    const executions = await this.d.db.prepare("SELECT * FROM executions WHERE run_id = ? ORDER BY created_at").all<Record<string, unknown>>(id);
    const perps = await this.d.db.prepare("SELECT * FROM perp_orders WHERE run_id = ? ORDER BY created_at").all<Record<string, unknown>>(id);
    return {
      id: r.id as string,
      pilot_id: r.pilot_id as string,
      status: r.status as string,
      engine: r.engine as string,
      started_at: r.started_at as number,
      finished_at: r.finished_at as number | null,
      wasm_sha256: r.wasm_sha256 as string | null,
      input_sha256: r.input_sha256 as string | null,
      output_sha256: r.output_sha256 as string | null,
      input: p(r.input_json),
      output: p(r.output_json),
      attestation: p(r.attestation_json),
      total_usd: r.total_usd as number | null,
      error: r.error as string | null,
      nft_status: r.nft_status as string | null,
      nft_tx: r.nft_tx as string | null,
      executions: executions.map((e) => ({ ...e, request_json: undefined, request: p(e.request_json), quote: p(e.quote_json), quote_json: undefined, response: p(e.response_json), response_json: undefined })),
      perp_orders: perps.map((o) => ({ ...o, request_json: undefined, request: p(o.request_json), response: p(o.response_json), response_json: undefined })),
    };
  }
}
