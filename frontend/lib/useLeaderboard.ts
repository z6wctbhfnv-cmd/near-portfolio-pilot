"use client";
import { useCallback, useEffect, useState } from "react";
import { loadBacktests, scriptsOnChain, type Backtested, type ScriptOnChain } from "./chain";

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
    loadBacktests().then(setBacktests);
  }, [load]);

  const ids = chain ? chain.map((c) => c.id) : backtests.map((b) => b.id);
  const rows = ids.map((id) => ({ id, chain: chain?.find((c) => c.id === id) ?? null, bt: backtests.find((b) => b.id === id) ?? null }));
  return { rows, chain, chainError, loading: chain === null && !chainError, reload: () => load(true) };
}

export type LeaderRow = ReturnType<typeof useLeaderboard>["rows"][number];
