"use client";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { VoiceButton } from "./VoiceButton";
import { api } from "@/lib/api";
import { dcaParams, describeTask, loadTasks, parseTask, saveTasks, type Task } from "@/lib/tasks";

const EXAMPLES = ["buy $50 of ETH every friday", "if BTC below 60000 buy $500", "купи NEAR на $20 каждый день"];

/**
 * Tasks by text or voice. A scheduled buy switches the pilot to the backend's dca strategy (real).
 * A conditional task is only saved here: nothing on the backend watches prices for it yet.
 */
export function TasksCard({ pilotId, onChanged }: { pilotId: string | null; onChanged?: () => void }) {
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<Task | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setTasks(loadTasks()); }, []);

  const read = (t: string) => {
    setMsg(null);
    try { setDraft(parseTask(t)); } catch (e) { setDraft(null); setMsg({ ok: false, text: (e as Error).message }); }
  };
  const save = (t: Task) => { const next = [...tasks, { ...t, id: Date.now() }]; setTasks(next); saveTasks(next); };

  const confirm = async () => {
    if (!draft) return;
    if (draft.kind === "recurring" && draft.side === "buy" && pilotId) {
      setBusy(true);
      try {
        await api.setStrategy(pilotId, { id: "dca", params: dcaParams(draft) });
        const p = dcaParams(draft);
        const every = p.every_days === 1 ? "day" : `${p.every_days} days`;
        const note = draft.weekday != null ? " The strategy counts days from now, so it won’t wait for that weekday." : "";
        setMsg({ ok: true, text: `Done. Your pilot now buys $${p.amount_usd} of ${draft.asset} every ${every}, inside your rules. It replaced the previous strategy.${note}` });
        setDraft(null); setText(""); onChanged?.();
      } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
      finally { setBusy(false); }
      return;
    }
    save(draft);
    setMsg({ ok: true, text: "Saved in this browser. It doesn’t run yet: the backend has no task runner for this kind of task." });
    setDraft(null); setText("");
  };

  const real = draft?.kind === "recurring" && draft.side === "buy" && !!pilotId;
  return (
    <div className="card p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[14px] text-dim">Tasks</p>
          <p className="display mt-2 text-[24px]">Tell it what to do</p>
        </div>
        <img src="/3d/calendar.png" alt="" className="h-16 w-16 shrink-0" />
      </div>
      <form className="mt-4 flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); read(text); }}>
        <label htmlFor="task" className="sr-only">Task</label>
        <input id="task" value={text} onChange={(e) => setText(e.target.value)} placeholder="buy $50 of ETH every friday" autoComplete="off"
          className="min-w-0 flex-1 rounded-[14px] bg-card2 px-4 py-3 text-[16px] outline-none focus:ring-2 focus:ring-yel" />
        <VoiceButton onText={setText} onFinal={read} />
      </form>
      <div className="no-scrollbar -mx-1 mt-2 flex gap-2 overflow-x-auto px-1">
        {EXAMPLES.map((x) => <button key={x} onClick={() => { setText(x); read(x); }} className="shrink-0 rounded-full bg-card2 px-3 py-1.5 text-[13px] font-semibold">{x}</button>)}
      </div>

      <AnimatePresence>
        {draft && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-3 rounded-[18px] bg-cream/60 p-4">
            <p className="text-[16px] font-semibold">{describeTask(draft)}</p>
            <p className="mt-1 text-[14px] leading-snug text-ink/75">
              {real ? "This switches your pilot to the Weekly buys strategy. It buys on schedule from your stablecoins, inside your signed limits."
                : draft.kind === "recurring" && draft.side === "sell" ? "Scheduled sells aren’t supported by the strategy engine yet. It will be saved here, not run."
                : draft.kind === "recurring" ? "Start a pilot first to make scheduled buys real. For now it will be saved here."
                : "Price-triggered tasks are saved here but don’t run yet: the backend doesn’t watch prices for them."}
            </p>
            <div className="mt-3 flex gap-2">
              <motion.button whileTap={{ scale: 0.95 }} onClick={confirm} disabled={busy} className="rounded-[12px] bg-yel px-4 py-2 text-[15px] font-semibold text-white disabled:opacity-50">{busy ? "Switching…" : real ? "Switch my pilot" : "Save"}</motion.button>
              <button onClick={() => setDraft(null)} className="rounded-[12px] px-3 py-2 text-[15px] font-semibold text-dim">Cancel</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {msg && <p role="status" className={`mt-3 rounded-[14px] px-3 py-2 text-[14px] ${msg.ok ? "bg-[#e8f7ee] text-up" : "bg-[#fdecea] text-down"}`}>{msg.text}</p>}

      {tasks.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2">
          {tasks.map((t) => (
            <li key={t.id} className="flex items-center gap-3 rounded-[14px] bg-card2 px-3 py-2.5">
              <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[11px] font-bold text-dim">not running yet</span>
              <span className="min-w-0 flex-1 text-[15px]">{describeTask(t)}</span>
              <button aria-label="Remove" onClick={() => { const next = tasks.filter((x) => x.id !== t.id); setTasks(next); saveTasks(next); }} className="text-[18px] text-dim hover:text-down">×</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
