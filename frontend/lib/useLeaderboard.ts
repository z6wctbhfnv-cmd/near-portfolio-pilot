"use client";
import { useCallback, useEffect, useState } from "react";
import { scriptsOnChain, type Backtested, type ScriptOnChain } from "./chain";
import { api, type TokenScript } from "./api";
import { isStarterToken } from "./starters";

/**
 * The leaderboard shows community scripts only: starters that users changed and minted, and new
 * scripts. The nine starters every user gets (and the team's research NFTs) are not listed.
 * A changed starter runs in dolya's engine, so it gets a two-year backtest and can be copied.
 */
export function useLeaderboard() {
  const [chain, setChain] = useState<ScriptOnChain[] | null>(null);
  const [chainError, setChainError] = useState<string | null>(null);
  const [scripts, setScripts] = useState<Record<string, TokenScript>>({});
  const [backtests, setBacktests] = useState<Backtested[]>([]);

  const load = useCallback(async (force = false) => {
    try { setChain(await scriptsOnChain(force)); setChainError(null); }
    catch (e) { setChainError((e as Error).message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const community = chain ? chain.filter((c) => !isStarterToken(c.id)) : null;
  const ids = community ? community.map((c) => c.id).join(",") : "";

  useEffect(() => {
    if (!ids) return;
    let alive = true;
    (async () => {
      const found = await Promise.all(ids.split(",").map((id) => api.scriptForToken(id).catch(() => null)));
      if (!alive) return;
      const known = found.filter((t): t is TokenScript => !!t);
      setScripts(Object.fromEntries(known.map((t) => [t.token_id, t])));
      const bts = await Promise.all(known.filter((t) => t.kind === "changed" && t.base).map(async (t): Promise<Backtested | null> => {
        try {
          const r = await api.backtestDaily(t.base!, t.params ?? {}, 730);
          return { id: t.token_id, doc: `A changed ${t.base_name ?? t.base}.`, uses_perps: false, record_return: r.metrics.total_return, record_max_drawdown: r.metrics.max_drawdown, daily_returns: r.daily_returns, daily_start: r.daily_start, periods: {}, params: r.params };
        } catch { return null; } // backend offline: the row says "no record yet"
      }));
      if (alive) setBacktests(bts.filter((x): x is Backtested => x !== null));
    })();
    return () => { alive = false; };
  }, [ids]);

  const rows = (community ?? []).map((c) => ({
    id: c.id,
    chain: c as ScriptOnChain | null,
    bt: backtests.find((b) => b.id === c.id) ?? null,
    kind: scripts[c.id]?.kind ?? null,
    script: scripts[c.id] ?? null,
  }));
  const startersHidden = chain && community ? chain.length - community.length : 0;
  return { rows, chain, startersHidden, chainError, loading: chain === null && !chainError, reload: () => load(true) };
}

export type LeaderRow = ReturnType<typeof useLeaderboard>["rows"][number];
