"use client";
import { useEffect, useState } from "react";
import { api, currentPilotId, type Backtest } from "./api";
import { strategies as demo } from "./demo";

export type StrategyCard = {
  id: string; name: string; tagline: string; img: string; risk: "Low" | "Medium";
  ret: number; dd: number; bench: number | null; curve: number[]; params: Record<string, unknown>; source: "backtest" | "demo";
};

const WEIGHTS = { NEAR: 0.2, BTC: 0.2, ETH: 0.2 };
/** What each backend strategy looks like in the UI, with the params we backtest it on. */
const META: Record<string, { img: string; risk: "Low" | "Medium"; tagline: string; params: Record<string, unknown> }> = {
  rebalance: { img: "balance", risk: "Low", tagline: "Holds your mix at target. Trades only when the drift is worth the fee.", params: { weights: WEIGHTS } },
  trend: { img: "arrow", risk: "Medium", tagline: "Rides assets that trade above their average and steps out when they fall below.", params: { weights: WEIGHTS, sma_days: 50 } },
  vol_target: { img: "blocks", risk: "Medium", tagline: "Takes more risk when markets are calm, less when they get wild.", params: { weights: { NEAR: 0.3, BTC: 0.3, ETH: 0.3 }, target_vol: 0.5 } },
  dca: { img: "calendar", risk: "Low", tagline: "Buys a fixed amount on a schedule. Boring on purpose.", params: { buy: { NEAR: 0.5, BTC: 0.5 }, amount_usd: 20, every_days: 7 } },
};

const DEMO_OF: Record<string, string> = { rebalance: "calm", trend: "trend", vol_target: "stable", dca: "dca" };

const demoCards: StrategyCard[] = demo.map((s) => ({
  id: s.id, name: s.name, tagline: s.tagline, img: { calm: "balance", dca: "calendar", trend: "arrow", stable: "blocks" }[s.id] ?? "sparkle",
  risk: s.risk === "Low" ? "Low" : "Medium", ret: s.ret, dd: s.dd, bench: null, curve: s.spark, params: {}, source: "demo",
}));

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
  const [cards, setCards] = useState<StrategyCard[]>(demoCards);
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
            return { id: s.id, name: s.name, tagline: meta.tagline, img: meta.img, risk: meta.risk, ...r, params: meta.params, source: "backtest" };
          } catch {
            const d = demo.find((x) => x.id === DEMO_OF[s.id]) ?? demo[0];
            return { id: s.id, name: s.name, tagline: meta.tagline, img: meta.img, risk: meta.risk, ret: d.ret, dd: d.dd, bench: null, curve: d.spark, params: meta.params, source: "demo" };
          }
        }));
        if (!alive) return;
        setCards(out); setLive(true);
        const pid = currentPilotId();
        if (pid) setActiveId((await api.pilot(pid)).strategy.id);
      } catch { /* backend offline: keep demo cards */ }
    })();
    return () => { alive = false; };
  }, []);

  const use = async (card: StrategyCard) => {
    const pid = currentPilotId();
    if (!pid || !live) return "no_pilot" as const;
    const p = await api.pilot(pid);
    const params = card.id === "dca" ? card.params : { ...card.params, weights: p.strategy.params.weights ?? card.params.weights };
    await api.setStrategy(pid, { id: card.id, params });
    setActiveId(card.id);
    return "ok" as const;
  };

  return { cards, live, activeId, use };
}
