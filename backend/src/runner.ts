/**
 * One pilot "tick": read the portfolio, run the strategy (OutLayer TEE or the same WASM locally),
 * execute its trades (paper or live), take a snapshot, publish the run to the strategy NFT.
 */
import { randomUUID } from "node:crypto";
import type { AgentGateway } from "./agent.js";
import type { StrategyOutput } from "./backtest.js";
import { type Db, json, logEvent } from "./db.js";
import type { Executor, ExecutionRow } from "./executor.js";
import type { PriceHistory } from "./history.js";
import type { NftPublisher } from "./nft.js";
import type { OutLayerClient } from "./outlayer.js";
import type { Pilot, Pilots } from "./pilots.js";
import { STRATEGY_INFO, strategySymbols } from "./strategies.js";
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
};

/** One strategy NFT per pilot listing: the strategy id plus the pilot's short id. */
export const nftTokenId = (p: { id: string; strategy: { id: string } }) => `${p.strategy.id}-${p.id.slice(0, 8)}`;

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

  snapshot(pilotId: string, total: number, rows: unknown) {
    this.d.db.prepare("INSERT INTO snapshots (pilot_id, ts, total_usd, holdings_json) VALUES (?, ?, ?, ?)").run(pilotId, Date.now(), total, json(rows));
  }

  /** Runs one decision for a pilot. Never throws for expected failures: they are recorded on the run. */
  async run(pilotId: string, opts: { reason?: string } = {}) {
    if (this.running.has(pilotId)) throw new Error("a run for this pilot is already in progress");
    this.running.add(pilotId);
    const runId = randomUUID();
    const started = Date.now();
    this.d.db
      .prepare("INSERT INTO runs (id, pilot_id, started_at, engine, status) VALUES (?, ?, ?, 'local', 'running')")
      .run(runId, pilotId, started);
    try {
      return await this.runInner(pilotId, runId, started, opts.reason ?? "manual");
    } catch (e) {
      const msg = (e as Error).message;
      this.d.db.prepare("UPDATE runs SET status = 'error', error = ?, finished_at = ? WHERE id = ?").run(msg, Date.now(), runId);
      logEvent(this.d.db, pilotId, "error", `run failed: ${msg}`, { run_id: runId });
      return this.getRun(runId);
    } finally {
      this.running.delete(pilotId);
    }
  }

  private async runInner(pilotId: string, runId: string, started: number, reason: string) {
    const p = this.d.pilots.get(pilotId);
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

    // History: closed days from the cache, plus the live price as the latest point.
    const lookback = STRATEGY_INFO[p.strategy.id].history_days(params);
    const history: Record<string, number[]> = {};
    if (lookback > 0) {
      const risk = symbols.filter((s) => !DEFAULT_UNIVERSE.find((a) => a.symbol === s)?.stable);
      await this.d.history.ensure(risk, Date.now() - (lookback + 5) * 86_400_000);
      for (const s of risk) {
        const closes = this.d.history.lastCloses(s, lookback - 1);
        const live = portfolio.find((x) => x.symbol === s)?.price;
        history[s] = live ? [...closes, live] : closes;
      }
    }

    const state = p.strategy.state && typeof p.strategy.state === "object" ? p.strategy.state : {};
    const input = { strategy: p.strategy.id, params, now_ms: started, state, portfolio, history };
    const inputJson = JSON.stringify(input);

    // Decide: OutLayer TEE when configured, else the same module locally.
    let engine: "local" | "outlayer" = "local";
    let output: StrategyOutput;
    let attestation: unknown = null;
    const useOutLayer = this.d.engine === "outlayer" || (this.d.engine === "auto" && this.d.outlayer.configured);
    const notes: string[] = [];
    if (useOutLayer) {
      try {
        const call = await this.d.outlayer.run(input);
        output = call.output as unknown as StrategyOutput;
        engine = "outlayer";
        attestation = { call_id: call.call_id, attestation_url: call.attestation_url, time_ms: call.time_ms, compute_cost: call.compute_cost };
        if (call.call_id) {
          try {
            attestation = { ...(attestation as object), record: await this.d.outlayer.attestation(call.call_id) };
          } catch (e) {
            notes.push(`attestation record not readable yet: ${(e as Error).message}`);
          }
        }
      } catch (e) {
        if (this.d.engine === "outlayer") throw e;
        notes.push(`OutLayer failed, ran locally: ${(e as Error).message}`);
        output = this.d.wasm.run<StrategyOutput>(inputJson).output;
      }
    } else {
      output = this.d.wasm.run<StrategyOutput>(inputJson).output;
    }
    const outputJson = JSON.stringify(output);
    const wasmSha = this.d.wasm.available() ? this.d.wasm.wasmSha256 : null;
    this.d.db
      .prepare("UPDATE runs SET engine = ?, wasm_sha256 = ?, input_sha256 = ?, output_sha256 = ?, input_json = ?, output_json = ?, attestation_json = ? WHERE id = ?")
      .run(engine, wasmSha, sha256Hex(inputJson), sha256Hex(outputJson), inputJson, outputJson, json(attestation), runId);

    if (!output.ok) throw new Error(`strategy refused the input: ${output.error}`);

    // Act.
    let executions: ExecutionRow[] = [];
    if (output.trades.length) {
      if (p.mode === "paper") {
        const h = { ...holdings };
        executions = await this.d.executor.paper(pilotId, runId, h, output.trades);
        this.d.pilots.update(pilotId, { paper_holdings_json: json(h) });
      } else {
        const m = p.mandate;
        executions = await this.d.executor.live(pilotId, runId, p.agent_id!, output.trades, {
          maxTradeUsd: m?.max_trade_usd ?? null,
          remainingBudgetUsd: null,
        });
      }
    }

    // Persist strategy state only when the trades it assumed actually went through (or there were none).
    const acted = !output.trades.length || executions.some((e) => e.status === "paper_filled" || e.status === "SUCCESS" || e.status === "QUEUED" || e.status === "PROCESSING");
    const everyHours = Number(params.every_hours ?? 24);
    this.d.pilots.update(pilotId, {
      ...(acted ? { strategy_state_json: json(output.state ?? {})! } : {}),
      next_run_at: Date.now() + everyHours * 3_600_000,
    });

    const after = await this.holdings(this.d.pilots.get(pilotId)!);
    const val = await this.valuation(after.holdings);
    this.snapshot(pilotId, val.total_usd, val.rows);

    this.d.db
      .prepare("UPDATE runs SET status = 'ok', total_usd = ?, finished_at = ?, error = ? WHERE id = ?")
      .run(val.total_usd, Date.now(), notes.length ? notes.join("; ") : null, runId);
    logEvent(this.d.db, pilotId, "info", `run ${reason}: ${output.trades.length} trade(s), engine ${engine}`, { run_id: runId });

    await this.publish(runId, p, started).catch((e) => {
      this.d.db.prepare("UPDATE runs SET nft_status = 'failed', error = COALESCE(error || '; ', '') || ? WHERE id = ?").run(`nft: ${(e as Error).message}`, runId);
    });
    return this.getRun(runId);
  }

  /** Appends the run to the strategy NFT's on-chain history, when a publisher is configured. */
  private async publish(runId: string, p: Pilot, startedAt: number) {
    const run = this.getRun(runId)!;
    if (!this.d.nft.configured || !run.wasm_sha256) {
      this.d.db.prepare("UPDATE runs SET nft_status = 'unpublished' WHERE id = ?").run(runId);
      return;
    }
    const prev = this.d.db
      .prepare("SELECT total_usd FROM snapshots WHERE pilot_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1")
      .get(p.id, startedAt) as { total_usd: number } | undefined;
    const ret = prev && prev.total_usd > 0 && run.total_usd !== null ? run.total_usd / prev.total_usd - 1 : 0;
    const tokenId = nftTokenId(p);
    const out = run.output as { engine_version?: string } | null;
    await this.d.nft.prepareToken(tokenId, `${p.strategy.id} · ${p.name}`.slice(0, 120), {
      strategy_id: p.strategy.id,
      // Engine version plus code hash: a rebuild with new code is a new version label on-chain.
      version: `${out?.engine_version ?? "0.0.0"}+${run.wasm_sha256.slice(0, 12)}`,
      wasm_sha256: run.wasm_sha256,
      source_url: "https://github.com/z6wctbhfnv-cmd/near-portfolio-pilot/tree/main/strategies",
      outlayer_project: this.d.outlayer.configured ? (this.d.outlayerProject ?? null) : null,
      params_json: JSON.stringify(p.strategy.params).slice(0, 4000),
    });
    const tx = await this.d.nft.recordRun(tokenId, {
      run_id: runId,
      timestamp_ms: startedAt,
      engine: run.engine,
      input_sha256: run.input_sha256!,
      output_sha256: run.output_sha256!,
      attestation_ref: (run.attestation as { call_id?: string } | null)?.call_id ?? null,
      wasm_sha256: run.wasm_sha256,
      period_return_bps: Math.round(ret * 10_000),
      equity_usd_e6: Math.round((run.total_usd ?? 0) * 1e6),
    });
    this.d.db.prepare("UPDATE runs SET nft_status = 'published', nft_tx = ? WHERE id = ?").run(tx, runId);
  }

  getRun(id: string) {
    const r = this.d.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    const p = (s: unknown) => (typeof s === "string" ? JSON.parse(s) : null);
    const executions = this.d.db.prepare("SELECT * FROM executions WHERE run_id = ? ORDER BY created_at").all(id) as Array<Record<string, unknown>>;
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
    };
  }
}
