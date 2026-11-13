"use client";
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { VoiceButton } from "./VoiceButton";
import { api, type PriceTask } from "@/lib/api";
import { dcaParams, describeTask, parseTask, type Task } from "@/lib/tasks";

const EXAMPLES = ["if BTC below 60000 buy $50", "buy $50 of ETH every friday", "если NEAR выше 5 продай $40"];

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const describeRow = (t: PriceTask) => `When ${t.asset} is ${t.op === "<" ? "below" : "above"} ${usd(t.price)}: ${t.side} ${usd(t.usd)} once`;

/**
 * Tasks by text or voice, run by the backend:
 * - price-triggered ("if BTC below 60000 buy $500"): the scheduler watches the price and trades once,
 *   inside the signed limits;
 * - scheduled buys ("buy $50 of ETH every friday"): the pilot switches to the Weekly buys strategy.
 */
export function TasksCard({ pilotId, onChanged }: { pilotId: string | null; onChanged?: () => void }) {
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<Task | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tasks, setTasks] = useState<PriceTask[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!pilotId) return setTasks([]);
    try { setTasks(await api.tasks(pilotId)); } catch { /* backend offline: the card says so on save */ }
  }, [pilotId]);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  const read = (t: string) => {
    setMsg(null);
    try { setDraft(parseTask(t)); } catch (e) { setDraft(null); setMsg({ ok: false, text: (e as Error).message }); }
  };

  const confirm = async () => {
    if (!draft || !pilotId) return;
    setBusy(true);
    try {
      if (draft.kind === "conditional") {
        await api.addTask(pilotId, { asset: draft.asset, op: draft.op, price: draft.price, side: draft.side, usd: draft.usd, text });
        setMsg({ ok: true, text: "Watching. When the price crosses, your pilot makes this trade once, inside your rules." });
        await load();
      } else if (draft.side === "buy") {
        await api.setStrategy(pilotId, { id: "dca", params: dcaParams(draft) });
        const p = dcaParams(draft);
        const every = p.every_days === 1 ? "day" : `${p.every_days} days`;
        const note = draft.weekday != null ? " It counts days from now, so it won’t wait for that weekday." : "";
        setMsg({ ok: true, text: `Done. Your pilot now buys $${p.amount_usd} of ${draft.asset} every ${every}, inside your rules. It replaced the previous strategy.${note}` });
        onChanged?.();
      } else {
        setMsg({ ok: false, text: "Scheduled sells aren’t supported by the strategy engine. Use a price task instead, e.g. “if NEAR above 5 sell $40”." });
        return;
      }
      setDraft(null); setText("");
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); }
  };

  const cancel = async (id: string) => {
    if (!pilotId) return;
    try { await api.cancelTask(pilotId, id); await load(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };

  const active = tasks.filter((t) => t.status === "active");
  const done = tasks.filter((t) => t.status === "done" || t.status === "failed").slice(0, 3);
  return (
    <div className="card p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[14px] text-dim">Tasks</p>
          <p className="display mt-2 text-[24px]">Tell it what to do</p>
        </div>
        <img src="/3d/calendar.png" alt="" className="h-16 w-16 shrink-0" />
      </div>
      {!pilotId ? (
        <p className="mt-3 text-[15px] text-dim">Start a portfolio first, then give it tasks like “if BTC below 60000 buy $50”.</p>
      ) : (
        <>
          <form className="mt-4 flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); read(text); }}>
            <label htmlFor="task" className="sr-only">Task</label>
            <input id="task" value={text} onChange={(e) => setText(e.target.value)} placeholder="if BTC below 60000 buy $50" autoComplete="off"
              className="min-w-0 flex-1 rounded-[14px] bg-card2 px-4 py-3 text-[16px] outline-none focus:ring-2 focus:ring-yel" />
            <VoiceButton onText={setText} onFinal={read} />
          </form>
          <div className="no-scrollbar -mx-1 mt-2 flex gap-2 overflow-x-auto px-1">
            {EXAMPLES.map((x) => <button key={x} onClick={() => { setText(x); read(x); }} className="shrink-0 rounded-full bg-card2 px-3 py-1.5 text-[13px] font-semibold">{x}</button>)}
          </div>
        </>
      )}

      <AnimatePresence>
        {draft && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-3 rounded-[18px] bg-cream/60 p-4">
            <p className="text-[16px] font-semibold">{describeTask(draft)}</p>
            <p className="mt-1 text-[14px] leading-snug text-ink/75">
              {draft.kind === "conditional" ? "Your pilot checks the price every few minutes and makes this trade once when it crosses. Your trade and budget limits still apply."
                : draft.side === "buy" ? "This switches your pilot to the Weekly buys strategy. It buys on schedule from your stablecoins, inside your limits."
                : "Scheduled sells aren’t supported. Try a price task instead."}
            </p>
            <div className="mt-3 flex gap-2">
              <motion.button whileTap={{ scale: 0.95 }} onClick={confirm} disabled={busy} className="rounded-[12px] bg-yel px-4 py-2 text-[15px] font-semibold text-white disabled:opacity-50">{busy ? "Saving…" : draft.kind === "conditional" ? "Start watching" : "Switch my pilot"}</motion.button>
              <button onClick={() => setDraft(null)} className="rounded-[12px] px-3 py-2 text-[15px] font-semibold text-dim">Cancel</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {msg && <p role="status" className={`mt-3 rounded-[14px] px-3 py-2 text-[14px] ${msg.ok ? "bg-[#e8f7ee] text-up" : "bg-[#fdecea] text-down"}`}>{msg.text}</p>}

      {(active.length > 0 || done.length > 0) && (
        <ul className="mt-4 flex flex-col gap-2">
          {active.map((t) => (
            <li key={t.id} className="flex items-center gap-3 rounded-[14px] bg-card2 px-3 py-2.5">
              <span className="shrink-0 rounded-full bg-yel px-2 py-0.5 text-[11px] font-bold text-white">watching</span>
              <span className="min-w-0 flex-1 text-[15px]">{describeRow(t)}</span>
              <button aria-label="Cancel task" onClick={() => cancel(t.id)} className="text-[18px] text-dim hover:text-down">×</button>
            </li>
          ))}
          {done.map((t) => (
            <li key={t.id} className="flex items-center gap-3 rounded-[14px] bg-card2/60 px-3 py-2.5">
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${t.status === "done" ? "bg-[#e8f7ee] text-up" : "bg-[#fdecea] text-down"}`}>{t.status === "done" ? "done" : "hit a limit"}</span>
              <span className="min-w-0 flex-1 text-[14px] text-dim">{describeRow(t)}{t.fired_price ? ` · at ${usd(t.fired_price)}` : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
