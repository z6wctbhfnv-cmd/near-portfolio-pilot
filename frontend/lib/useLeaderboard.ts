"use client";
import { useCallback, useEffect, useState } from "react";
import { loadBacktests, scriptsOnChain, type Backtested, type ScriptOnChain } from "./chain";
import { api } from "./api";

/** The script NFTs dolya's own runner executes, with the settings their backtest uses. */
const WASM: Record<string, { strategy: string; doc: string; params: Record<string, unknown> }> = {
  "wasm-rebalance@v1": { strategy: "rebalance", doc: "Holds a fixed mix and rebalances when a weight drifts past the band.", params: { weights: { NEAR: 0.2, BTC: 0.2, ETH: 0.2 } } },
  "wasm-trend@v1": { strategy: "trend", doc: "Holds each asset while it trades above its 50-day average; cuts it below.", params: { weights: { NEAR: 0.2, BTC: 0.2, ETH: 0.2 }, sma_days: 50 } },
  "wasm-vol-target@v1": { strategy: "vol_target", doc: "Scales risk so recent volatility matches a target.", params: { weights: { NEAR: 0.3, BTC: 0.3, ETH: 0.3 }, target_vol: 0.5 } },
  "wasm-dca@v1": { strategy: "dca", doc: "Buys a fixed amount on a schedule.", params: { buy: { NEAR: 0.5, BTC: 0.5 }, amount_usd: 20, every_days: 7 } },
};
export const isCopyable = (id: string) => id in WASM;

/** Two-year backtests of the WASM scripts by the backend's own engine (real daily prices, after costs). */
async function wasmBacktests(): Promise<Backtested[]> {
  const out = await Promise.all(Object.entries(WASM).map(async ([id, w]): Promise<Backtested | null> => {
    try {
      const r = await api.backtestDaily(w.strategy, w.params, 730);
      return { id, doc: w.doc, uses_perps: false, record_return: r.metrics.total_return, record_max_drawdown: r.metrics.max_drawdown, daily_returns: r.daily_returns, daily_start: r.daily_start, periods: {}, params: r.params };
    } catch { return null; } // backend offline: the row says "no record yet"
  }));
  return out.filter((x): x is Backtested => x !== null);
}

/** On-chain facts for every script NFT, joined with the backtest record where one exists. */
export function useLeaderboard() {
  const [chain, setChain] = useState<ScriptOnChain[] | null>(null);
  const [chainError, setChainError] = useState<string | null>(null);
  const [backtests, setBacktests] = useState<Backtested[]>([]);

  const load = useCallback(async (force = false) => {
    try { setChain(await scriptsOnChain(force)); setChainError(null); }
    catch (e) { setChainError((e as Error).message); }
  }, []);

  useEffect(() => {
    load();
    loadBacktests().then((b) => {
      setBacktests(b);
      wasmBacktests().then((w) => { if (w.length) setBacktests([...b.filter((x) => !w.some((y) => y.id === x.id)), ...w]); });
    });
  }, [load]);

  const ids = chain ? chain.map((c) => c.id) : backtests.map((b) => b.id);
  const rows = ids.map((id) => ({ id, chain: chain?.find((c) => c.id === id) ?? null, bt: backtests.find((b) => b.id === id) ?? null }));
  return { rows, chain, chainError, loading: chain === null && !chainError, reload: () => load(true) };
}

export type LeaderRow = ReturnType<typeof useLeaderboard>["rows"][number];
