"use client";
import { useEffect, useState } from "react";
import { api, currentPilotId, type Backtest } from "./api";
import { STARTERS, STARTER_NAMES, paramsForAssets } from "./starters";

export type StrategyCard = {
  id: string; name: string; tagline: string; img: string; risk: "Low" | "Medium";
  ret: number; dd: number; bench: number | null; curve: number[]; params: Record<string, unknown>; source: "backtest" | "loading" | "none";
};

/** What each starter looks like in the UI, with the params we backtest it on (lib/starters.ts). */
const META: Record<string, { img: string; risk: "Low" | "Medium"; tagline: string; params: Record<string, unknown> }> =
  Object.fromEntries(STARTERS.map((x) => [x.id, { img: x.img, risk: x.risk, tagline: x.tagline, params: x.params }]));

/** The nine starters before their backtests answer: no numbers until there are real ones. */
const startCards = (source: "loading" | "none"): StrategyCard[] =>
  STARTERS.map((x) => ({ id: x.id, name: STARTER_NAMES[x.id] ?? x.id, tagline: x.tagline, img: x.img, risk: x.risk, ret: 0, dd: 0, bench: null, curve: [1, 1], params: x.params, source }));

/** Reads metrics from a backtest answer without depending on exact field names. */
function readBacktest(b: Backtest) {
  const m = (b.metrics ?? b) as Record<string, number>;
  const pick = (...k: string[]) => { for (const x of k) if (typeof m[x] === "number") return m[x]; return undefined; };
  const pct = (v: number | undefined) => (v === undefined ? 0 : Math.abs(v) <= 5 ? v * 100 : v);
  const ret = pct(pick("total_return", "return", "return_pct", "total_return_pct"));
  const dd = -Math.abs(pct(pick("max_drawdown", "max_drawdown_pct", "drawdown")));
  const bm = ((b as Record<string, unknown>).benchmark_hold ?? b.benchmark ?? {}) as Record<string, number>;
  const bench = typeof bm.total_return === "number" ? pct(bm.total_return) : null;
  const eq = ((b as Record<string, unknown>).equity_curve ?? b.equity ?? []) as Array<number | { usd?: number; v?: number; value?: number; total_usd?: number }>;
  const curve = eq.map((p) => (typeof p === "number" ? p : p.usd ?? p.v ?? p.value ?? p.total_usd ?? 0)).filter((v) => v > 0);
  const step = Math.max(1, Math.floor(curve.length / 40));
  return { ret, dd, bench, curve: curve.filter((_, i) => i % step === 0 || i === curve.length - 1) };
}

export function useStrategies() {
  const [cards, setCards] = useState<StrategyCard[]>(() => startCards("loading"));
  const [live, setLive] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cat = await api.strategies();
        const out = await Promise.all(cat.map(async (s): Promise<StrategyCard> => {
          const meta = META[s.id] ?? { img: "sparkle", risk: "Medium" as const, tagline: s.description, params: {} };
          try {
            const r = readBacktest(await api.backtest(s.id, meta.params, 90));
            if (r.curve.length < 2) throw new Error("empty backtest");
            return { id: s.id, name: STARTER_NAMES[s.id] ?? s.name, tagline: meta.tagline, img: meta.img, risk: meta.risk, ...r, params: meta.params, source: "backtest" };
          } catch {
            // No backtest right now: show the card without numbers rather than invent any.
            return { id: s.id, name: STARTER_NAMES[s.id] ?? s.name, tagline: meta.tagline, img: meta.img, risk: meta.risk, ret: 0, dd: 0, bench: null, curve: [1, 1], params: meta.params, source: "none" };
          }
        }));
        if (!alive) return;
        setCards(out); setLive(true);
        const pid = currentPilotId();
        if (pid) setActiveId((await api.pilot(pid)).strategy.id);
      } catch { if (alive) setCards(startCards("none")); /* backend offline: cards without numbers */ }
    })();
    return () => { alive = false; };
  }, []);

  const use = async (card: StrategyCard) => {
    const pid = currentPilotId();
    if (!pid || !live) return "no_pilot" as const;
    const p = await api.pilot(pid);
    // Keep the pilot's own assets: its weights when it has them, else an even split of its mandate assets.
    const own = p.strategy.params.weights;
    let params: Record<string, unknown>;
    if (card.id !== "dca" && own && Object.keys(own).length) {
      params = { ...card.params, weights: own };
      if (card.id === "stress_rotation") params.signal = "BTC" in own ? "BTC" : Object.keys(own)[0];
    } else params = paramsForAssets(card.id, p.mandate?.assets ?? []);
    await api.setStrategy(pid, { id: card.id, params });
    setActiveId(card.id);
    return "ok" as const;
  };

  return { cards, live, activeId, use };
}
