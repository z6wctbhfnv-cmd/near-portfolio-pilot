"use client";
import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Line } from "@/components/motion";
import { VoiceButton } from "@/components/VoiceButton";
import { NftActionSheet, useNftWallet, type NftAction } from "@/components/nftWallet";
import { api, ApiError } from "@/lib/api";
import { NFT } from "@/lib/config";
import { EXAMPLE_SCRIPT, IDEAS, checkScript, sha256 } from "@/lib/scriptCheck";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56);

/** Backend errors for the draft call, in plain words. */
function draftError(e: unknown) {
  if (e instanceof ApiError) {
    if (e.code === "offline") return "The dolya backend is offline, so NEAR AI can’t draft right now. You can still write the script yourself below.";
    if (e.code === "not_configured") return "The backend has no NEAR AI key yet, so it can’t draft. Write the script yourself below, or start from the example.";
    if (e.code === "ai_unavailable") return `NEAR AI didn’t answer: ${e.message.replace(/^NEAR AI is unavailable:\s*/, "")}`;
    return e.message;
  }
  return (e as Error).message;
}

export default function Create() {
  const { accountId } = useNftWallet();
  const [idea, setIdea] = useState("");
  const [code, setCode] = useState(EXAMPLE_SCRIPT);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [check, setCheck] = useState<{ problems: string[]; hash: string } | null>(null);
  const [name, setName] = useState("");
  const [action, setAction] = useState<NftAction | null>(null);

  const draft = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await api.draftScript(idea);
      setCode(r.code); setCheck(null);
      setNote({ ok: true, text: `Drafted by ${r.model} on NEAR AI. Read it before you mint: the model only drafts.` });
      if (!name) setName(idea.split(/\s+/).slice(0, 4).join(" "));
    } catch (e) { setNote({ ok: false, text: draftError(e) }); }
    finally { setBusy(false); }
  };

  const runCheck = async () => {
    const problems = checkScript(code);
    setCheck({ problems, hash: problems.length ? "" : await sha256(code) });
  };

  const id = `${slug(name) || "my-script"}@v1`;
  const mint = () => check?.hash && setAction({
    title: "Mint your script",
    method: "mint_strategy",
    deposit: "0.1",
    gas: "100",
    args: { info: { strategy_id: id, code_hash: check.hash, author: "<your testnet account>" }, title: name || id, description: idea.slice(0, 200) || "A dolya script" },
    build: (author) => ({ info: { strategy_id: id, code_hash: check.hash, author }, title: name || id, description: idea.slice(0, 200) || "A dolya script" }),
    why: "Creates one NFT for this exact code. You become its author and holder. Only the hash goes on chain; the code stays with you. You pay the storage out of the 0.1 NEAR and get the rest back.",
  });

  return (
    <main className="mx-auto max-w-[760px] px-4 pb-24 sm:px-6">
      <div className="flex items-start justify-between gap-4 pt-10">
        <div className="min-w-0">
          <h1 className="display text-[clamp(1.4rem,7vw,3.4rem)]"><Line>Write a script</Line></h1>
          <p className="mt-3 max-w-[46ch] text-[18px] text-dim">Describe a trading idea in plain words. NEAR AI drafts the code, dolya checks it, and you mint it as an NFT that others can copy.</p>
        </div>
        <img src="/3d/sparkle.png" alt="" className="h-20 w-20 shrink-0 sm:h-28 sm:w-28" />
      </div>

      {/* 1. idea */}
      <div className="card mt-8 p-5">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="idea" className="text-[17px] font-bold">1. Your idea</label>
          <VoiceButton onText={setIdea} />
        </div>
        <textarea id="idea" value={idea} onChange={(e) => setIdea(e.target.value)} rows={3} placeholder="e.g. Buy BTC when it is above its 100-day average, hold cash otherwise"
          className="mt-3 w-full resize-none rounded-[16px] bg-card2 px-4 py-3 text-[17px] leading-snug outline-none focus:ring-2 focus:ring-yel" />
        <div className="no-scrollbar -mx-1 mt-2 flex gap-2 overflow-x-auto px-1">
          {IDEAS.map((x) => (
            <button key={x} onClick={() => setIdea(x)} className={`shrink-0 rounded-full px-3 py-1.5 text-[13px] font-semibold ${idea === x ? "bg-yel text-white" : "bg-card2"}`}>{x}</button>
          ))}
        </div>
        <motion.button whileTap={{ scale: 0.97 }} onClick={draft} disabled={busy || idea.trim().length < 3} className="btn btn-yel mt-4 w-full">
          {busy ? <motion.span className="h-5 w-5 rounded-full border-[3px] border-white border-t-transparent" animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.7, ease: "linear" }} /> : "Draft with NEAR AI"}
        </motion.button>
        <AnimatePresence>
          {note && (
            <motion.p initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} role="status"
              className={`mt-3 rounded-[14px] px-3 py-2 text-[14px] ${note.ok ? "bg-[#e8f7ee] text-up" : "bg-[#fdecea] text-down"}`}>{note.text}</motion.p>
          )}
        </AnimatePresence>
      </div>

      {/* 2. code */}
      <div className="card mt-3 p-5">
        <p className="text-[17px] font-bold">2. The script</p>
        <p className="mt-1 text-[14px] text-dim">One Python function, <code>def target(daily)</code>, that returns target weights. No imports, no files.</p>
        <textarea value={code} onChange={(e) => { setCode(e.target.value); setCheck(null); }} rows={11} spellCheck={false}
          className="mt-3 w-full resize-y rounded-[16px] bg-ink px-4 py-3 font-mono text-[13px] leading-relaxed text-white/90 outline-none focus:ring-2 focus:ring-yel" />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <motion.button whileTap={{ scale: 0.95 }} onClick={runCheck} className="rounded-[14px] bg-card2 px-4 py-2.5 text-[15px] font-semibold">Check it</motion.button>
          {check && (check.problems.length
            ? <span className="text-[14px] text-down">✕ {check.problems.join("; ")}</span>
            : <span className="text-[14px] text-up">✓ Passes the checks · hash <span className="font-mono">{check.hash.slice(0, 12)}…</span></span>)}
        </div>
        <p className="mt-3 text-[13px] text-dim">Backtesting your own code isn’t open yet: the backend backtests only the built-in strategies today.</p>
      </div>

      {/* 3. mint */}
      <div className="card mt-3 p-5">
        <p className="text-[17px] font-bold">3. Mint it</p>
        <p className="mt-1 text-[14px] text-dim">One NFT per script, on NEAR {NFT.network}. Free apart from storage. The record starts with its first live week.</p>
        <label className="mt-3 block text-[14px] text-dim" htmlFor="sname">Name</label>
        <input id="sname" value={name} onChange={(e) => setName(e.target.value)} placeholder="BTC trend" className="mt-1 w-full rounded-[14px] bg-card2 px-4 py-3 text-[17px] outline-none focus:ring-2 focus:ring-yel" />
        <p className="mt-1 text-[13px] text-dim">NFT id: <span className="font-mono">{id}</span></p>
        <motion.button whileTap={{ scale: 0.97 }} onClick={mint} disabled={!check?.hash} className="btn btn-yel mt-4 w-full">Mint on {NFT.network}</motion.button>
        {!check?.hash && <p className="mt-2 text-center text-[13px] text-dim">Check the script first.</p>}
        {accountId && <p className="mt-2 text-center text-[13px] text-dim">You’ll sign as {accountId}.</p>}
      </div>

      <p className="mt-6 text-center text-[14px] text-dim">Others copy it from the <Link href="/leaderboard" className="font-semibold text-yel underline">leaderboard</Link> and pay you a share of their new profit.</p>
      <NftActionSheet action={action} onClose={() => setAction(null)} />
    </main>
  );
}
