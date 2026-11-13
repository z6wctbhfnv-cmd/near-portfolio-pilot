"use client";
import { useCallback, useEffect, useState } from "react";
import { api, currentPilotId, setCurrentPilotId, type Pilot, type Portfolio, type Review } from "./api";
import type { Move } from "./demo";

export type Holding = { sym: string; name: string; amount: string; usd: number; change: number; target: number };
export type PilotView = {
  live: boolean;                 // true = data from the backend
  pilot: Pilot | null;
  total: number;
  holdings: Holding[];
  moves: Move[];
  series: Record<string, number[]>;
  reviews: Review[];
  paused: boolean;
};

const NAMES: Record<string, string> = { USDC: "USD Coin", USDT: "Tether", NEAR: "NEAR", BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", ZEC: "Zcash" };
const STRAT: Record<string, string> = { rebalance: "Constant mix", trend: "Trend filter", vol_target: "Volatility target", dca: "Weekly buys" };

const when = (t: number) => {
  const d = new Date(t), now = new Date();
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `Today, ${time}`;
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${time}`;
};

const fmtUnits = (u: number, sym: string) => `${u >= 1000 ? Math.round(u).toLocaleString("en-US") : Number(u.toPrecision(4))} ${sym}`;

/** Backend errors in plain words, without file paths. */
export function friendlyError(e: string) {
  if (/wasm/i.test(e) && /(ENOENT|missing|not built)/i.test(e)) return "The strategy engine isn’t installed on this server yet.";
  if (/rate|429/.test(e)) return "The price service asked us to slow down.";
  if (/timeout|ETIMEDOUT|fetch failed/i.test(e)) return "A price or trading service didn’t answer in time.";
  return e.replace(/[A-Z]:\\[^\s']+|\/[\w./-]{12,}/g, "…").slice(0, 140) + (e.length > 140 ? "…" : "") + (e.endsWith(".") ? "" : ".");
}

/** Strategy engine notes in plain words. */
function humanNote(n: string) {
  const d = n.match(/max drift ([\d.]+) > band ([\d.]+)/);
  if (d) return `your mix was ${Math.round(+d[1] * 100)} points off target, more than the ${Math.round(+d[2] * 100)} you allow`;
  const t = n.match(/^(\w+): close [\d.]+ (>=|<) SMA(\d+)/);
  if (t) return `${t[1]} is ${t[2] === ">=" ? "above" : "below"} its ${t[3]}-day average`;
  return n;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Turns one backend run into a readable move with a reason. */
function runToMove(r: Record<string, any>, pilot: Pilot): Move {
  const out = r.output ?? {};
  const trades: { sell: string; buy: string; usd: number }[] = out.trades ?? [];
  const execs: Record<string, any>[] = r.executions ?? [];
  const blocked = execs.filter((e) => e.status === "blocked" || e.status === "refused");
  const notes: string[] = (out.notes ?? []).map(humanNote);
  const strategy = STRAT[pilot.strategy.id] ?? pilot.strategy.id;
  // What computed the decision. "Attested" only when the run really went through OutLayer's TEE.
  const code = typeof r.wasm_sha256 === "string" ? ` · WASM ${r.wasm_sha256.slice(0, 10)}…` : "";
  const run = r.engine === "outlayer" ? `OutLayer TEE, attested${code}` : `This server${code}`;
  const budget = pilot.mandate.budget.weekly_usd;
  const rule = budget ? `Max $${budget} a week` : pilot.mode === "live" ? "Inside your signed limits" : "Inside your limits";
  if (r.status === "error") {
    return { id: r.id, when: when(r.started_at), kind: "review", title: "Run skipped", why: `${friendlyError(String(r.error ?? ""))} Nothing moved, your money is where it was.`, rule, strategy, run };
  }
  if (!trades.length) {
    return { id: r.id, when: when(r.started_at), kind: "hold", title: "Held, no trade",
      why: notes[0] ? `Checked the market: ${notes.join("; ")}. Everything sits inside your target, so nothing was traded.` : "Every holding is within its target band, so trading would only cost fees.", rule, strategy, run };
  }
  const t = trades[0];
  const wanted = trades.reduce((s, x) => s + x.usd, 0);
  const filled = execs.filter((e) => !blocked.includes(e)).reduce((s, e) => s + (Number(e.usd) || 0), 0);
  const done = execs.length ? filled : wanted;
  const capped = execs.length > 0 && done + 1 < wanted;
  const limit = pilot.mandate.max_trade_usd;
  const title = trades.length === 1 ? `${t.sell} → ${t.buy}` : `${trades.length} swaps`;
  const cause = notes.length ? cap(notes.join("; ")) : "Your mix drifted from its target";
  const why = blocked.length && !done
    ? `Wanted to move $${wanted.toFixed(0)}, but every swap hit a limit (${blocked.map((b) => b.error_code ?? "blocked").join(", ")}). Your rules won.`
    : capped
      ? `${cause}. The strategy wanted to move $${wanted.toFixed(0)}, but your rules cap a trade${limit ? ` at $${limit}` : ""}, so it moved $${done.toFixed(0)} now and will finish over the next runs.`
      : `${cause}, so ${strategy.toLowerCase()} moved $${done.toFixed(0)} back toward your target.`;
  return { id: r.id, when: when(r.started_at), kind: blocked.length && !done ? "hold" : "swap", title, amount: `$${done.toFixed(0)}`, why, rule: capped && limit ? `Trades up to $${limit}` : rule, strategy, run };
}

function seriesFrom(snaps: { ts?: number; total_usd?: number }[], fallback: number) {
  const pts = snaps.filter((s) => typeof s.total_usd === "number").map((s) => s.total_usd as number);
  if (pts.length < 2) return { "1D": [fallback, fallback], "1W": [fallback, fallback], "1M": [fallback, fallback], "1Y": [fallback, fallback] };
  const tail = (n: number) => pts.slice(-n);
  return { "1D": tail(24), "1W": tail(7 * 24), "1M": tail(30 * 24), "1Y": pts };
}

/** No pilot yet: nothing invented, the dashboard shows an empty state instead. */
const empty: PilotView = {
  live: false, pilot: null, total: 0, holdings: [], moves: [],
  series: { "1D": [0, 0], "1W": [0, 0], "1M": [0, 0], "1Y": [0, 0] }, reviews: [], paused: false,
};

export function usePilot() {
  const [view, setView] = useState<PilotView>(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const id = currentPilotId();
    if (!id) { setView(empty); setLoading(false); return; }
    try {
      const [pilot, pf, runs, snaps, reviews] = await Promise.all([
        api.pilot(id), api.portfolio(id), api.runs(id).catch(() => []), api.snapshots(id).catch(() => []), api.reviews(id).catch(() => []),
      ]);
      const weights = pilot.strategy.params.weights ?? {};
      const p = pf as Portfolio;
      const holdings: Holding[] = p.rows.map((r) => ({
        sym: r.symbol, name: NAMES[r.symbol] ?? r.symbol, amount: fmtUnits(r.units, r.symbol), usd: r.usd, change: 0,
        target: Math.round((weights[r.symbol] ?? (r.symbol === pilot.mandate.stable ? 1 - Object.values(weights).reduce((a, b) => a + b, 0) : 0)) * 100),
      }));
      setView({
        live: true, pilot, total: p.total_usd, holdings,
        moves: (runs as Record<string, any>[]).slice().sort((a, b) => b.started_at - a.started_at).map((r) => runToMove(r, pilot)),
        series: seriesFrom(snaps as { total_usd?: number }[], p.total_usd),
        reviews: reviews as Review[],
        paused: pilot.status === "paused" || pilot.status === "frozen",
      });
      setError(null);
    } catch (e) {
      if ((e as { code?: string }).code === "offline") { setView(empty); setError("Can’t reach the dolya server right now."); return; }
      if ((e as { status?: number }).status === 404) setCurrentPilotId(null);
      setView(empty);
      setError((e as Error).message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try { await fn(); await load(); setError(null); }
    catch (e) { setError(friendlyError((e as Error).message)); }
    finally { setBusy(null); }
  }, [load]);

  const id = view.pilot?.id;
  /** One click: a paper portfolio with $1,000 of paper money and balanced default rules. */
  const startPaper = () => act("start", async () => {
    const r = await api.createPilot({ name: "My paper portfolio", mode: "paper", text: "Balanced: NEAR, BTC and ETH. Max $300 a day, $100 per trade.", initial_usd: 1000 });
    setCurrentPilotId(r.pilot.id);
    await api.run(r.pilot.id).catch(() => undefined);
  });
  return {
    view, loading, error, busy, reload: load, startPaper,
    runNow: () => id && act("run", () => api.run(id)),
    togglePause: () => id && act("pause", () => api.patchPilot(id, { paused: !view.paused })),
    reviewNow: () => id && act("review", () => api.review(id)),
    toggleStop: () => id && act("stop", () => api.patchPilot(id, { drawdown_stop: { enabled: !(view.pilot?.mandate.drawdown_stop?.enabled ?? true) } })),
  };
}
