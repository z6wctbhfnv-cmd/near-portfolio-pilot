"use client";
import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Action, AssetRow, Chart, MoveDetail, MoveRow, Sheet } from "@/components/ui";
import { useWallet } from "@/components/wallet";
import { usePilot } from "@/lib/usePilot";
import { usd, type Move } from "@/lib/demo";

const STRAT: Record<string, string> = { rebalance: "Constant mix", trend: "Trend filter", vol_target: "Volatility target", dca: "Weekly buys" };

export default function Dashboard() {
  const [open, setOpen] = useState<Move | null>(null);
  const [tab, setTab] = useState<"assets" | "mix">("assets");
  const { accountId, connect } = useWallet();
  const { view, error, busy, runNow, togglePause, reviewNow, toggleStop } = usePilot();
  const { pilot, total, holdings, moves, series, reviews, paused, live } = view;
  const m = pilot?.mandate;
  const rules = m
    ? [m.budget.weekly_usd && `Max $${m.budget.weekly_usd} a week`, m.budget.daily_usd && `Max $${m.budget.daily_usd} a day`, m.max_trade_usd && `Trades up to $${m.max_trade_usd}`, `${[...m.assets, m.stable].join(", ")} only`, m.drawdown_stop?.enabled === false ? "No safety stop" : `Cash out at −${Math.round((m.drawdown_stop?.max_drawdown ?? 0.2) * 100)}%`, "Your wallet only", "Freeze any time"].filter(Boolean) as string[]
    : ["Max $150 a week", "NEAR at 30% ± 4", "Act past 5% drift", "Cash out at −20%", "Your wallet only", "Freeze any time"];
  const review = reviews[0];

  return (
    <main className="mx-auto max-w-[1200px] px-4 pb-16 pt-6 sm:px-6">
      {!live && (
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
          className="mb-4 flex flex-col gap-3 rounded-[22px] bg-card2 p-4 sm:flex-row sm:items-center">
          <img src="/3d/sparkle.png" alt="" className="h-12 w-12 shrink-0" />
          <p className="flex-1 text-[16px]"><b>This is a demo portfolio.</b> Set your rules to start your own pilot with paper money.{error ? <span className="block text-[13px] text-dim">Backend: {error}</span> : null}</p>
          <Link href="/start" className="btn btn-yel !h-11 shrink-0 !text-[15px]">Set my rules</Link>
        </motion.div>
      )}

      <AnimatePresence>
        {paused && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="mb-4 flex items-center gap-3 rounded-[20px] bg-down p-4 text-white">
              <img src="/3d/lock.png" alt="" className="h-10 w-10" />
              <p className="flex-1 text-[16px] font-semibold">Everything is frozen. No trades until you resume.</p>
              <motion.button whileTap={{ scale: 0.95 }} onClick={togglePause} className="rounded-[12px] bg-white px-4 py-2 text-[15px] font-semibold text-down">Resume</motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grid gap-3 lg:grid-cols-[1.15fr_1fr]">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="card p-6">
            {accountId
              ? <p className="truncate text-[20px] font-semibold text-ink">{accountId}</p>
              : <button onClick={connect} className="text-[20px] font-semibold text-ink underline decoration-yel decoration-2 underline-offset-4 hover:text-yel">Connect wallet</button>}
            <motion.p key={total} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="display num mt-3 text-[clamp(2.4rem,9vw,3.5rem)]">{usd(Math.round(total * 100) / 100)}</motion.p>
            <p className="mt-1 text-[16px] text-dim">{live ? `${pilot?.mode === "live" ? "Live" : "Paper"} pilot · ${STRAT[pilot!.strategy.id] ?? pilot!.strategy.id}` : <><span className="num font-semibold text-up">+$412 · 3.9%</span> this month</>}</p>
            <div className="mt-6 grid grid-cols-4 sm:max-w-[420px]">
              <Action icon={busy === "run" ? "…" : "▶"} label="Run now" active onClick={live ? runNow : undefined} />
              <Action icon="⇄" label="Strategy" onClick={() => location.assign("/strategies")} />
              <Action icon="≡" label="Rules" onClick={() => location.assign("/start")} />
              <Action icon="❄" label={paused ? "Resume" : "Freeze"} onClick={live ? togglePause : undefined} />
            </div>
            {live && error && <p className="mt-4 rounded-[14px] bg-[#fdecea] px-3 py-2 text-[14px] text-down" role="alert">{error}</p>}
          </div>
          <div className="card p-6"><Chart height={170} data={series} /></div>

          <div className="card p-3">
            <div className="mx-2 mt-2 grid w-fit grid-cols-2 gap-1 rounded-[14px] bg-card2 p-1">
              {(["assets", "mix"] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)} className="relative h-9 rounded-[11px] px-4 text-[15px] font-semibold sm:px-5">
                  {tab === t && <motion.span layoutId="tab" className="absolute inset-0 rounded-[11px] bg-yel" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}
                  <span className={`relative ${tab === t ? "text-white" : "text-dim"}`}>{t === "assets" ? "Assets" : "Mix vs target"}</span>
                </button>
              ))}
            </div>
            <AnimatePresence mode="wait">
              <motion.div key={tab} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={{ duration: 0.2 }} className="mt-2">
                {tab === "assets" ? holdings.map((h) => <AssetRow key={h.sym} h={h} />) : (
                  <div className="space-y-4 px-2 py-3">
                    {holdings.map((h) => {
                      const pct = total ? Math.round((h.usd / total) * 100) : 0;
                      const off = Math.abs(pct - h.target) > 4;
                      return (
                        <div key={h.sym}>
                          <div className="flex justify-between text-[15px]"><span className="font-semibold">{h.sym}</span><span className="num text-dim">{pct}% · target {h.target}%</span></div>
                          <div className="relative mt-2 h-3 rounded-full bg-card2">
                            <motion.div className={`h-full rounded-full ${off ? "bg-down" : "bg-yel"}`} initial={{ width: 0 }} animate={{ width: `${Math.min(100, pct)}%` }} transition={{ duration: 0.7, ease: [0.2, 0.8, 0.2, 1] }} />
                            <span className="absolute -top-1 h-5 w-0.5 rounded bg-ink" style={{ left: `${Math.min(100, h.target)}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <div className="card p-3">
            <p className="px-2 pt-2 text-[22px] font-bold">Moves, explained</p>
            <div className="mt-2">
              {moves.length === 0 && (
                <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
                  <img src="/3d/bubble.png" alt="" className="h-20 w-20" />
                  <p className="text-[16px] text-dim">No moves yet. The first run happens on schedule, or tap <b className="text-ink">Run now</b>.</p>
                </div>
              )}
              {moves.map((mv, i) => (
                <motion.div key={mv.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 + i * 0.05 }}>
                  <MoveRow m={mv} onClick={() => setOpen(mv)} />
                </motion.div>
              ))}
            </div>
            {moves[0] && (
              <div className="mx-2 mb-2 mt-3 rounded-[18px] bg-yel p-4 text-white">
                <p className="text-[13px] font-semibold opacity-80">Latest reason</p>
                <p className="mt-1 text-[16px] leading-snug">{moves[0].why}</p>
              </div>
            )}
          </div>

          <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }} whileHover="hover" className="card relative overflow-hidden p-6">
            <p className="text-[14px] text-dim">Running strategy</p>
            <p className="display mt-2 pr-28 text-[24px]">{pilot ? STRAT[pilot.strategy.id] ?? pilot.strategy.id : "Calm Rebalance"}</p>
            <p className="mt-1 max-w-[24ch] text-[15px] text-dim">{pilot ? `Next run ${new Date(pilot.next_run_at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "Next check in 6 hours. 412 verified runs."}</p>
            <Link href="/strategies" className="mt-4 inline-flex items-center gap-1 text-[15px] font-semibold text-yel">Change strategy <span>→</span></Link>
            <motion.img src="/3d/balance.png" alt="" className="absolute -bottom-3 -right-2 h-32 w-32" variants={{ hover: { rotate: -8, scale: 1.08 } }} transition={{ type: "spring", stiffness: 260, damping: 12 }} />
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.32 }} className="card p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[14px] text-dim">{pilot?.mode === "live" ? "Your signed rules" : "Your rules"}</p>
                <p className="display mt-2 text-[24px]">{rules.length} rules · all kept</p>
              </div>
              <img src="/3d/shield.png" alt="" className="h-16 w-16" />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {rules.map((r, k) => (
                <motion.span key={r} initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.4 + k * 0.04, type: "spring", stiffness: 300, damping: 18 }}
                  className="rounded-full bg-card2 px-3 py-1.5 text-[14px] font-medium">{r}</motion.span>
              ))}
            </div>
            {live && m && (
              <button type="button" onClick={toggleStop} disabled={busy === "stop"}
                className="mt-4 text-[15px] font-semibold text-yel disabled:opacity-50">
                {m.drawdown_stop?.enabled === false ? "Turn the safety stop on" : "Turn the safety stop off"}
              </button>
            )}
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.38 }} className="card p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[14px] text-dim">Weekly AI review</p>
                <p className="display mt-2 text-[24px]">{review ? (review.status === "no_change" ? "All good" : "Has ideas") : "Not yet"}</p>
              </div>
              <img src="/3d/sparkle.png" alt="" className="h-16 w-16" />
            </div>
            <p className="mt-3 text-[16px] leading-snug text-ink/80">{review?.summary ?? "Once a week the reviewer checks your strategy against your rules and explains what it saw."}</p>
            {live && (
              <motion.button whileTap={{ scale: 0.96 }} onClick={reviewNow} disabled={busy === "review"} className="mt-4 inline-flex items-center gap-1 text-[15px] font-semibold text-yel disabled:opacity-50">
                {busy === "review" ? "Reviewing…" : "Review now →"}
              </motion.button>
            )}
          </motion.div>
        </div>
      </div>
      <Sheet open={!!open} onClose={() => setOpen(null)}>{open && <MoveDetail m={open} />}</Sheet>
    </main>
  );
}
