/**
 * Historical simulation. Every decision is made by the real strategy WASM module, day by day, on
 * closes it could have seen at that time (no look-ahead); trades fill at that day's close minus a
 * flat cost in basis points (spread + solver fee + slippage).
 */
import { DAY_MS, dayStart, type PriceHistory } from "./history.js";
import { parseStrategyParams, STRATEGY_INFO, type StrategyId, strategySymbols } from "./strategies.js";
import type { StrategyWasm } from "./wasm.js";

export type BacktestRequest = {
  strategy: StrategyId;
  params: Record<string, unknown>;
  from: number;
  to: number;
  initial_usd: number;
  cost_bps: number;
};

export type StrategyOutput = {
  ok: boolean;
  error?: string;
  trades: Array<{ sell: string; buy: string; usd: number }>;
  state: unknown;
  target_weights: Record<string, number>;
  notes: string[];
  total_usd: number;
  input_sha256: string;
};

export type Metrics = {
  days: number;
  start_usd: number;
  end_usd: number;
  total_return: number;
  cagr: number | null;
  max_drawdown: number;
  ann_vol: number;
  sharpe: number | null;
};

export function metrics(equity: number[], startUsd: number): Metrics {
  const end = equity[equity.length - 1] ?? startUsd;
  let peak = -Infinity;
  let mdd = 0;
  for (const e of equity) {
    peak = Math.max(peak, e);
    if (peak > 0) mdd = Math.max(mdd, 1 - e / peak);
  }
  const rets: number[] = [];
  for (let i = 1; i < equity.length; i++) if (equity[i - 1]! > 0) rets.push(equity[i]! / equity[i - 1]! - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  const years = equity.length / 365;
  const r = (x: number) => Number(x.toFixed(6));
  return {
    days: equity.length,
    start_usd: r(startUsd),
    end_usd: r(end),
    total_return: r(end / startUsd - 1),
    cagr: years >= 0.25 && end > 0 ? r((end / startUsd) ** (1 / years) - 1) : null,
    max_drawdown: r(mdd),
    ann_vol: r(sd * Math.sqrt(365)),
    sharpe: sd > 0 ? r((mean / sd) * Math.sqrt(365)) : null,
  };
}

export async function backtest(wasm: StrategyWasm, history: PriceHistory, req: BacktestRequest) {
  const params = parseStrategyParams(req.strategy, req.params);
  const symbols = strategySymbols(req.strategy, params);
  const stable = String(params.stable);
  const lookback = STRATEGY_INFO[req.strategy].history_days(params);
  const from = dayStart(req.from);
  const to = dayStart(req.to);
  if (to <= from) throw new Error("`to` must be after `from`");
  const warmupFrom = from - lookback * DAY_MS;
  await history.ensure(symbols, warmupFrom);

  // Price table: day -> symbol -> close, only days where every symbol has a close.
  const series = Object.fromEntries(symbols.map((s) => [s, new Map(history.closes(s, warmupFrom, to).map((r) => [r.day, r.close]))]));
  const allDays: number[] = [];
  for (let d = warmupFrom; d <= to; d += DAY_MS) if (symbols.every((s) => series[s]!.has(d))) allDays.push(d);
  const days = allDays.filter((d) => d >= from);
  if (days.length < 2) throw new Error("not enough price history for this period");

  const cost = req.cost_bps / 10_000;
  const units: Record<string, number> = Object.fromEntries(symbols.map((s) => [s, 0]));
  units[stable] = req.initial_usd; // start fully in the stablecoin
  let state: unknown = {};
  const everyDays = Math.max(1, Math.round(Number(params.every_hours ?? 24) / 24));
  const equity: number[] = [];
  const curve: Array<{ day: string; usd: number }> = [];
  let trades = 0;
  let turnover = 0;
  let fees = 0;
  let errors = 0;
  let lastError: string | null = null;

  for (let i = 0; i < days.length; i++) {
    const d = days[i]!;
    const px = (s: string) => series[s]!.get(d)!;
    if (i % everyDays === 0) {
      const hist: Record<string, number[]> = {};
      if (lookback > 0) {
        const idx = allDays.indexOf(d);
        const window = allDays.slice(Math.max(0, idx - lookback + 1), idx + 1);
        for (const s of symbols) if (s !== stable) hist[s] = window.map((w) => series[s]!.get(w)!);
      }
      const input = {
        strategy: req.strategy,
        params,
        now_ms: d + DAY_MS - 1,
        state,
        portfolio: symbols.map((s) => ({ symbol: s, units: units[s]!, price: px(s) })),
        history: hist,
      };
      const { output } = wasm.run<StrategyOutput>(input);
      if (!output.ok) {
        errors++;
        lastError = output.error ?? "unknown";
      } else {
        state = output.state;
        for (const t of output.trades) {
          const sellUnits = Math.min(units[t.sell] ?? 0, t.usd / px(t.sell));
          const usd = sellUnits * px(t.sell);
          if (usd <= 0) continue;
          units[t.sell] = (units[t.sell] ?? 0) - sellUnits;
          units[t.buy] = (units[t.buy] ?? 0) + (usd * (1 - cost)) / px(t.buy);
          trades++;
          turnover += usd;
          fees += usd * cost;
        }
      }
    }
    const value = symbols.reduce((a, s) => a + units[s]! * px(s), 0);
    equity.push(value);
    curve.push({ day: new Date(d).toISOString().slice(0, 10), usd: Number(value.toFixed(2)) });
  }

  // Benchmark: buy the strategy's full-risk weights on day one (one cost), never trade again.
  const w = (req.strategy === "dca" ? params.buy : params.weights) as Record<string, number>;
  const d0 = days[0]!;
  const holdUnits: Record<string, number> = {};
  let rest = req.initial_usd;
  for (const [s, wt] of Object.entries(w)) {
    const usd = req.initial_usd * wt;
    holdUnits[s] = (usd * (1 - cost)) / series[s]!.get(d0)!;
    rest -= usd;
  }
  holdUnits[stable] = (holdUnits[stable] ?? 0) + rest;
  const holdEquity = days.map((d) => Object.entries(holdUnits).reduce((a, [s, u]) => a + u * series[s]!.get(d)!, 0));

  const step = Math.max(1, Math.ceil(curve.length / 400));
  return {
    strategy: req.strategy,
    params,
    period: { from: new Date(days[0]!).toISOString().slice(0, 10), to: new Date(days[days.length - 1]!).toISOString().slice(0, 10) },
    cost_bps: req.cost_bps,
    engine: { wasm_sha256: wasm.wasmSha256, decisions_every_days: everyDays },
    metrics: metrics(equity, req.initial_usd),
    benchmark_hold: metrics(holdEquity, req.initial_usd),
    activity: { trades, turnover_usd: Number(turnover.toFixed(2)), fees_usd: Number(fees.toFixed(2)), strategy_errors: errors, last_error: lastError },
    final_units: Object.fromEntries(Object.entries(units).map(([k, v]) => [k, Number(v.toFixed(8))])),
    equity_curve: curve.filter((_, i) => i % step === 0 || i === curve.length - 1),
  };
}
