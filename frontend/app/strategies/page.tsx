"use client";
import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Change, Sheet, spring } from "@/components/ui";
import { Line } from "@/components/motion";
import { Area } from "@/components/Area";
import { useStrategies, type StrategyCard } from "@/lib/useStrategies";

const filters = ["All", "Low risk", "Best return", "Smallest dip"];

export default function Strategies() {
  const { cards, live, activeId, use } = useStrategies();
  const [filter, setFilter] = useState("All");
  const [open, setOpen] = useState<StrategyCard | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const list = [...cards]
    .filter((s) => filter !== "Low risk" || s.risk === "Low")
    .sort((a, b) => (filter === "Best return" ? b.ret - a.ret : filter === "Smallest dip" ? b.dd - a.dd : 0));

  const choose = async (c: StrategyCard) => {
    setBusy(true); setNote(null);
    try {
      const r = await use(c);
      if (r === "no_pilot") setNote("Set your rules first, then pick a strategy for your pilot.");
      else setOpen(null);
    } catch (e) { setNote((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <main className="mx-auto max-w-[1200px] px-4 pb-20 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-6 pt-10">
        <div className="min-w-0">
          <h1 className="display text-[clamp(2.4rem,7vw,4rem)]"><Line>Strategies</Line></h1>
          <p className="mt-3 max-w-[50ch] text-[18px] text-dim">The {cards.length} starter scripts everyone gets. Run one as it is, or change its settings in <Link href="/create" className="font-semibold text-yel">Write your own</Link> and mint your version. {live && cards.some((c) => c.source === "backtest") ? "Charts are backtests over the last 90 days on real prices, after swap costs." : ""} Whatever you pick still can’t break your rules.</p>
        </div>
        <div className="no-scrollbar -mx-4 flex max-w-[calc(100%+2rem)] gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          {filters.map((f) => (
            <motion.button key={f} onClick={() => setFilter(f)} whileTap={{ scale: 0.94 }} className="relative h-11 shrink-0 rounded-[14px] px-4 text-[15px] font-semibold">
              <span className="absolute inset-0 rounded-[14px] bg-card shadow-sm" />
              {filter === f && <motion.span layoutId="filter" transition={spring} className="absolute inset-0 rounded-[14px] bg-yel" />}
              <span className={`relative transition-colors ${filter === f ? "text-white" : "text-ink"}`}>{f}</span>
            </motion.button>
          ))}
        </div>
      </div>

      <motion.div layout className="mt-10 grid gap-4 md:grid-cols-2">
        <AnimatePresence mode="popLayout">
          {list.map((s, i) => {
            const on = activeId === s.id;
            return (
              <motion.button layout key={s.id} onClick={() => { setNote(null); setOpen(s); }}
                initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95 }}
                transition={{ ...spring, delay: i * 0.05 }} whileHover="hover" whileTap={{ scale: 0.99 }}
                className={`card group relative min-w-0 overflow-hidden p-6 text-left transition-shadow hover:shadow-[0_24px_50px_-24px_rgba(150,70,0,.45)] sm:p-7 ${on ? "ring-2 ring-yel" : ""}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${s.risk === "Low" ? "bg-card2 text-yel-deep" : "bg-yel text-white"}`}>{s.risk} risk</span>
                      {on && <span className="rounded-full bg-up px-2.5 py-1 text-[12px] font-semibold text-white">Running</span>}
                    </div>
                    <h2 className="display mt-4 text-[clamp(1.5rem,5vw,1.9rem)]">{s.name}</h2>
                    <p className="mt-2 max-w-[30ch] text-[16px] leading-snug text-dim">{s.tagline}</p>
                  </div>
                  <motion.img src={`/3d/${s.img}.png`} alt="" className="-mr-3 -mt-3 h-24 w-24 shrink-0 sm:h-32 sm:w-32"
                    variants={{ hover: { rotate: -8, scale: 1.1, y: -6 } }} transition={{ type: "spring", stiffness: 260, damping: 12 }} />
                </div>
                <div className="mt-4"><Area data={s.curve} id={s.id} /></div>
                <div className="mt-4 grid grid-cols-3 gap-2">
                  <div className="rounded-[16px] bg-card2 p-3"><p className="text-[12px] text-dim">90 days</p>{s.source === "backtest" ? <Change v={s.ret} className="mt-1 block text-[18px] font-bold sm:text-[20px]" /> : <p className="mt-1 text-[18px] font-bold text-dim sm:text-[20px]">—</p>}</div>
                  <div className="rounded-[16px] bg-card2 p-3"><p className="text-[12px] text-dim">Worst dip</p>{s.source === "backtest" ? <p className="num mt-1 text-[18px] font-bold text-down sm:text-[20px]">{s.dd.toFixed(1)}%</p> : <p className="mt-1 text-[18px] font-bold text-dim sm:text-[20px]">—</p>}</div>
                  <div className="rounded-[16px] bg-card2 p-3"><p className="text-[12px] text-dim">Just holding</p>{s.bench === null ? <p className="mt-1 text-[18px] font-bold text-dim sm:text-[20px]">—</p> : <Change v={s.bench} className="mt-1 block text-[18px] font-bold sm:text-[20px]" />}</div>
                </div>
                <div className="mt-5 flex items-center justify-between text-[15px] font-semibold">
                  <span className="text-dim">{s.source === "backtest" ? "Backtest · 30 bps per swap" : s.source === "loading" ? "Backtesting…" : "No backtest right now"}</span>
                  <span className="flex items-center gap-1 text-yel">Details <span className="transition-transform group-hover:translate-x-1">→</span></span>
                </div>
              </motion.button>
            );
          })}
        </AnimatePresence>
      </motion.div>

      <p className="mt-8 text-[13px] text-dim">Past results don’t promise future ones.</p>

      <Sheet open={!!open} onClose={() => setOpen(null)}>
        {open && (
          <div>
            <div className="flex items-center gap-4">
              <img src={`/3d/${open.img}.png`} alt="" className="h-20 w-20" />
              <div className="min-w-0">
                <h3 className="display text-[24px]">{open.name}</h3>
                <p className="text-[14px] text-dim">{open.risk} risk · {open.source === "backtest" ? "90-day backtest" : open.source === "loading" ? "backtesting…" : "no backtest right now"}</p>
              </div>
            </div>
            <p className="mt-4 text-[17px] leading-snug">{open.tagline}</p>
            <div className="mt-4 rounded-[18px] bg-card2 p-4"><Area data={open.curve} id={`s-${open.id}`} h={100} /></div>
            <motion.button whileTap={{ scale: 0.97 }} className="btn btn-yel mt-5 w-full" disabled={busy || activeId === open.id} onClick={() => choose(open)}>
              {activeId === open.id ? "Already running" : busy ? "Switching…" : "Use this strategy"}
            </motion.button>
            {note && <p className="mt-3 text-center text-[14px] text-down" role="alert">{note} {note.startsWith("Set your rules") && <Link href="/start" className="font-semibold text-yel underline">Set rules</Link>}</p>}
            <p className="mt-3 text-center text-[13px] text-dim">Starts on the next run, inside your rules.</p>
            <Link href={`/create?base=${open.id}`} className="mt-4 block text-center text-[15px] font-semibold text-yel">Change its settings and mint your own →</Link>
          </div>
        )}
      </Sheet>
    </main>
  );
}
