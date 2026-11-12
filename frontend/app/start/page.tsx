"use client";
import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Mark } from "@/components/Logo";
import { useWallet } from "@/components/wallet";
import { examples, parseRules } from "@/lib/demo";
import { api, ApiError, setCurrentPilotId, type ParseResult } from "@/lib/api";

const titles = ["How should we handle your money?", "Here’s what we understood", "Sign your rules"];
const money = (n: number | null | undefined) => (n == null ? "—" : `$${n.toLocaleString("en-US")}`);

/** Turns the backend's parsed mandate into readable rule rows. */
function rowsFrom(p: ParseResult) {
  const m = p.mandate, w = p.strategy.params.weights ?? {};
  const mix = Object.entries(w).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(" · ");
  return [
    { k: "Weekly limit", v: money(m.budget.weekly_usd) },
    { k: "Daily limit", v: money(m.budget.daily_usd) },
    { k: "Largest single trade", v: money(m.max_trade_usd) },
    { k: "Risk", v: m.risk[0].toUpperCase() + m.risk.slice(1) },
    { k: "Assets", v: [...m.assets, m.stable].join(", ") },
    { k: "Strategy", v: `${p.strategy.id === "rebalance" ? "Constant mix" : p.strategy.id}${mix ? ` · ${mix}` : ""}` },
    { k: "Withdrawals", v: "Your wallet only" },
  ];
}

const stopText = (s?: { enabled: boolean; max_drawdown: number }) =>
  !s || s.enabled ? `Sell to cash at −${Math.round((s?.max_drawdown ?? 0.2) * 100)}% from the peak` : "Off";

export default function Start() {
  const { accountId, connect } = useWallet();
  const [step, setStep] = useState(0);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [amount, setAmount] = useState(1000);

  const fallbackRows = parseRules(text).map((r) => ({ k: r.k, v: r.v }));
  const rows = parsed ? rowsFrom(parsed) : fallbackRows;
  const notes = parsed ? [...parsed.notes, ...parsed.warnings] : [];

  const understand = async () => {
    setBusy(true); setError(null);
    try { setParsed(await api.parse(text)); }
    catch (e) { setParsed(null); setError(e instanceof ApiError && e.code === "offline" ? "Backend is offline, so this is a local preview of your rules." : (e as Error).message); }
    finally { setBusy(false); setStep(1); }
  };

  const sign = async () => {
    setBusy(true); setError(null);
    try {
      // Create from the mandate the owner just reviewed, not from the text again: a second AI read
      // could differ from what was shown (and takes another 10–20 s).
      const name = accountId ? `${accountId} pilot` : "My pilot";
      const r = await api.createPilot(parsed ? { name, mandate: parsed.mandate, initial_usd: amount } : { name, text, initial_usd: amount });
      setCurrentPilotId(r.pilot.id);
      setStep(3);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <main className="mx-auto max-w-[600px] px-4 pb-36 sm:px-6">
      {step < 3 && (
        <div className="mt-6 flex items-center gap-3">
          <motion.button whileTap={{ scale: 0.9 }} onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0} aria-label="Back"
            className="grid h-11 w-11 place-items-center rounded-full bg-card text-[18px] shadow-sm disabled:opacity-0">←</motion.button>
          <div className="flex flex-1 gap-1.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-1.5 flex-1 overflow-hidden rounded-full bg-card2">
                <motion.div className="h-full rounded-full bg-yel" initial={false} animate={{ width: i <= step ? "100%" : "0%" }} transition={{ duration: 0.4 }} />
              </div>
            ))}
          </div>
          <span className="num w-10 text-right text-[14px] text-dim">{step + 1}/3</span>
        </div>
      )}

      <AnimatePresence mode="wait">
        <motion.div key={step} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={{ duration: 0.25 }}>
          {step < 3 && (
            <div className="mt-8 flex items-start justify-between gap-4">
              <h1 className="display text-[clamp(1.9rem,6vw,2.6rem)]">{titles[step]}</h1>
              <img src={`/3d/${["bubble", "shield", "wallet"][step]}.png`} alt="" className="h-20 w-20 shrink-0" />
            </div>
          )}

          {step === 0 && (
            <>
              <p className="mt-3 text-[17px] text-dim">Write it like you’d say it. English or Russian. Nothing is signed until step 3.</p>
              <div className="card mt-6 p-1 focus-within:ring-2 focus-within:ring-yel">
                <label htmlFor="rules" className="block px-4 pt-3 text-[13px] text-dim">Your words</label>
                <textarea id="rules" value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="Keep it safe, $150 a week at most…"
                  className="w-full resize-none bg-transparent px-4 pb-3 pt-1 text-[18px] leading-snug outline-none placeholder:text-dim/60" />
              </div>
              <p className="mt-6 text-[15px] font-semibold">Quick start</p>
              <div className="mt-2 flex flex-col gap-2">
                {examples.map((ex) => (
                  <motion.button key={ex} whileTap={{ scale: 0.98 }} onClick={() => setText(ex)}
                    className={`rounded-[18px] p-4 text-left text-[16px] leading-snug transition-colors ${text === ex ? "bg-yel text-white" : "bg-card shadow-sm hover:bg-card2"}`}>{ex}</motion.button>
                ))}
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <p className="mt-3 text-[17px] text-dim">Your wallet will enforce these limits.{parsed ? ` Read by ${parsed.source === "rules" ? "the rule parser" : "NEAR AI"}.` : ""}</p>
              <div className="card mt-6 divide-y divide-line px-5">
                {rows.map((r, i) => (
                  <motion.div key={r.k} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
                    className="flex items-center justify-between gap-4 py-4">
                    <span className="text-[15px] text-dim">{r.k}</span>
                    <span className="text-right text-[17px] font-semibold">{r.v}</span>
                  </motion.div>
                ))}
              </div>
              {parsed && (
                <div className="card mt-3 flex items-center justify-between gap-4 px-5 py-4">
                  <div className="min-w-0">
                    <p className="text-[15px] text-dim">Safety stop</p>
                    <p className="text-[17px] font-semibold">{stopText(parsed.mandate.drawdown_stop)}</p>
                  </div>
                  <button type="button" role="switch" aria-checked={parsed.mandate.drawdown_stop?.enabled ?? true} aria-label="Safety stop"
                    onClick={() => setParsed({ ...parsed, mandate: { ...parsed.mandate, drawdown_stop: { max_drawdown: parsed.mandate.drawdown_stop?.max_drawdown ?? 0.2, enabled: !(parsed.mandate.drawdown_stop?.enabled ?? true) } } })}
                    className={`relative h-8 w-14 shrink-0 rounded-full transition-colors ${(parsed.mandate.drawdown_stop?.enabled ?? true) ? "bg-yel" : "bg-card2"}`}>
                    <span className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all ${(parsed.mandate.drawdown_stop?.enabled ?? true) ? "left-7" : "left-1"}`} />
                  </button>
                </div>
              )}
              {notes.length > 0 && (
                <div className="mt-3 rounded-[18px] bg-card2 p-4 text-[14px] text-ink/80">
                  <p className="font-semibold">Filled in for you</p>
                  <ul className="mt-1 list-disc pl-5">{notes.map((n) => <li key={n}>{n}</li>)}</ul>
                </div>
              )}
            </>
          )}

          {step === 2 && (
            <>
              <p className="mt-3 text-[17px] text-dim">Start with paper money to watch it work. Real funds come next, once your wallet signs the policy.</p>
              <div className="card mt-6 p-5">
                <label htmlFor="amt" className="text-[14px] text-dim">Starting balance (paper)</label>
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-[28px] font-semibold">$</span>
                  <input id="amt" type="number" min={10} step={10} value={amount} onChange={(e) => setAmount(Math.max(10, Number(e.target.value) || 0))}
                    className="num w-full bg-transparent text-[32px] font-semibold outline-none" />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {[100, 500, 1000, 5000].map((v) => (
                    <motion.button key={v} whileTap={{ scale: 0.94 }} onClick={() => setAmount(v)}
                      className={`rounded-full px-3.5 py-1.5 text-[14px] font-semibold ${amount === v ? "bg-yel text-white" : "bg-card2"}`}>${v.toLocaleString("en-US")}</motion.button>
                  ))}
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between gap-3 rounded-[20px] bg-card2 p-4">
                <span className="min-w-0 text-[15px]">{accountId ? <>Signed as <b className="break-all">{accountId}</b></> : "No wallet connected. Paper mode works without one."}</span>
                {!accountId && <motion.button whileTap={{ scale: 0.95 }} onClick={connect} className="shrink-0 rounded-[12px] bg-white px-3 py-2 text-[14px] font-semibold text-yel-deep">Connect</motion.button>}
              </div>
            </>
          )}

          {step === 3 && (
            <div className="pt-16 text-center">
              <motion.div className="mx-auto w-fit" initial={{ scale: 0.3, rotate: -90 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 200, damping: 12 }}>
                <Mark size={130} />
              </motion.div>
              <h1 className="display mt-8 text-[40px]">You’re all set</h1>
              <p className="mx-auto mt-3 max-w-[32ch] text-[17px] text-dim">Your pilot is live in paper mode. Every move will show up in your portfolio with a reason.</p>
              <div className="mt-8 flex flex-col gap-2">
                <Link href="/dashboard" className="btn btn-yel">Open portfolio</Link>
                <Link href="/strategies" className="btn btn-gray">Browse strategies</Link>
              </div>
            </div>
          )}

          <AnimatePresence>
            {error && (
              <motion.p initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} role="alert"
                className="mt-4 rounded-[16px] bg-[#fdecea] px-4 py-3 text-[15px] text-down">{error}</motion.p>
            )}
          </AnimatePresence>
        </motion.div>
      </AnimatePresence>

      {step < 3 && (
        <div className="fixed inset-x-0 bottom-[64px] z-30 bg-gradient-to-t from-bg via-bg to-transparent px-4 pb-4 pt-8 md:bottom-0 md:pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto max-w-[568px]">
            <motion.button whileTap={{ scale: 0.97 }} className="btn btn-yel w-full" disabled={busy || (step === 0 && text.trim().length < 8)}
              onClick={step === 0 ? understand : step === 1 ? () => setStep(2) : sign}>
              {busy ? <motion.span className="h-5 w-5 rounded-full border-[3px] border-white border-t-transparent" animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.7, ease: "linear" }} />
                : step === 0 ? "Continue" : step === 1 ? "Looks right" : "Start my pilot"}
            </motion.button>
          </div>
        </div>
      )}
    </main>
  );
}
