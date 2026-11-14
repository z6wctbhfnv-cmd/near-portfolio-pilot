"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Line } from "@/components/motion";
import { VoiceButton } from "@/components/VoiceButton";
import { Area } from "@/components/Area";
import { Change } from "@/components/ui";
import { NftActionSheet, useNftWallet, type NftAction } from "@/components/nftWallet";
import { api, ApiError, type Backtest } from "@/lib/api";
import { NFT } from "@/lib/config";
import { EXAMPLE_SCRIPT, IDEAS, checkScript, sha256 } from "@/lib/scriptCheck";
import { STARTERS, starter, type Starter } from "@/lib/starters";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56);
const ASSETS = ["NEAR", "BTC", "ETH", "SOL"];

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

/** Percent per asset from a starter's weights (or the weekly-buys split). */
const mixOf = (s: Starter) => {
  const w = (s.params.weights ?? s.params.buy ?? {}) as Record<string, number>;
  return Object.fromEntries(ASSETS.map((a) => [a, Math.round((w[a] ?? 0) * 100)]));
};
const knobsOf = (s: Starter) => Object.fromEntries(s.knobs.map((k) => [k.key, Number(s.params[k.key] ?? k.min)]));

type Result = { ret: number; dd: number; hold: number | null; curve: number[]; trades: number | null; period: string };
function readBacktest(b: Backtest): Result {
  const x = b as Record<string, unknown>;
  const m = (x.metrics ?? {}) as Record<string, number>;
  const h = (x.benchmark_hold ?? null) as Record<string, number> | null;
  const eq = (x.equity_curve ?? []) as Array<number | { usd?: number; v?: number; value?: number; total_usd?: number }>;
  const curve = eq.map((p) => (typeof p === "number" ? p : p.usd ?? p.v ?? p.value ?? p.total_usd ?? 0)).filter((v) => v > 0);
  const per = x.period as { from?: string; to?: string } | undefined;
  const act = x.activity as { trades?: number } | undefined;
  return { ret: (m.total_return ?? 0) * 100, dd: -Math.abs((m.max_drawdown ?? 0) * 100), hold: h && typeof h.total_return === "number" ? h.total_return * 100 : null, curve, trades: act?.trades ?? null, period: per?.from && per?.to ? `${per.from} → ${per.to}` : "" };
}

export default function Create() {
  const { accountId } = useNftWallet();

  /* ---------- change a starter (the main path) ---------- */
  const [base, setBase] = useState<Starter>(STARTERS[1]);
  const [mix, setMix] = useState<Record<string, number>>(mixOf(STARTERS[1]));
  const [knobs, setKnobs] = useState<Record<string, number>>(knobsOf(STARTERS[1]));
  const [signal, setSignal] = useState("BTC");
  const [checked, setChecked] = useState<{ hash: string; base_name: string } | null>(null);
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [bt, setBt] = useState<Result | null>(null);
  const [btBusy, setBtBusy] = useState(false);
  const [btErr, setBtErr] = useState<string | null>(null);
  const [sname, setSname] = useState("");
  const [action, setAction] = useState<NftAction | null>(null);

  const pick = (s: Starter) => {
    setBase(s); setMix(mixOf(s)); setKnobs(knobsOf(s));
    setSignal(String(s.params.signal ?? "BTC"));
    setChecked(null); setCheckErr(null); setBt(null); setBtErr(null);
  };
  // /create?base=trend opens with that starter picked (from the Strategies page).
  useEffect(() => {
    const b = new URLSearchParams(window.location.search).get("base");
    const s = b ? starter(b) : null;
    if (s) pick(s);
  }, []);

  const changed = () => { setChecked(null); setCheckErr(null); setBt(null); };
  const total = ASSETS.reduce((a, s) => a + (mix[s] || 0), 0);
  const params = useMemo(() => {
    const w = Object.fromEntries(ASSETS.filter((a) => (mix[a] || 0) > 0).map((a) => [a, Number(((mix[a] || 0) / 100).toFixed(4))]));
    const p: Record<string, unknown> = { ...knobs };
    if (base.id === "dca") p.buy = w; else p.weights = w;
    if (base.id === "stress_rotation") p.signal = signal in w ? signal : Object.keys(w)[0] ?? "BTC";
    return p;
  }, [base, mix, knobs, signal]);

  const check = async () => {
    setChecking(true); setCheckErr(null); setChecked(null);
    try { const r = await api.registerScript(base.id, params, sname || undefined); setChecked({ hash: r.code_hash, base_name: r.base_name }); }
    catch (e) { setCheckErr((e as Error).message); }
    finally { setChecking(false); }
  };
  const backtest = async () => {
    setBtBusy(true); setBtErr(null);
    try { setBt(readBacktest(await api.backtest(base.id, params, 365))); }
    catch (e) { setBtErr((e as Error).message); }
    finally { setBtBusy(false); }
  };

  const sid = `${slug(sname) || slug(`my-${base.name}`)}@v1`;
  const settings = base.knobs.map((k) => `${k.key} ${knobs[k.key]}`).join(", ");
  const mintChanged = () => checked && setAction({
    title: "Mint your script",
    method: "mint_strategy",
    deposit: "0.1",
    gas: "100",
    args: { info: { strategy_id: sid, code_hash: checked.hash, author: "<your testnet account>" }, title: sname || sid, description: `A changed ${base.name}: ${settings}`.slice(0, 200) },
    build: (author) => ({ info: { strategy_id: sid, code_hash: checked.hash, author }, title: sname || sid, description: `A changed ${base.name}: ${settings}`.slice(0, 200) }),
    why: "Creates one NFT for this exact script: the starter and your settings. You become its author and holder. Only the hash goes on chain. dolya’s engine runs it for anyone who copies it, and they pay you a share of new profit. You pay the storage out of the 0.1 NEAR and get the rest back.",
  });

  /* ---------- write from scratch (research) ---------- */
  const [idea, setIdea] = useState("");
  const [code, setCode] = useState(EXAMPLE_SCRIPT);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pcheck, setPcheck] = useState<{ problems: string[]; hash: string } | null>(null);
  const [name, setName] = useState("");

  const draft = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await api.draftScript(idea);
      setCode(r.code); setPcheck(null);
      setNote({ ok: true, text: `Drafted by ${r.model} on NEAR AI. Read it before you mint: the model only drafts.` });
      if (!name) setName(idea.split(/\s+/).slice(0, 4).join(" "));
    } catch (e) { setNote({ ok: false, text: draftError(e) }); }
    finally { setBusy(false); }
  };
  const runCheck = async () => {
    const problems = checkScript(code);
    setPcheck({ problems, hash: problems.length ? "" : await sha256(code) });
  };
  const id = `${slug(name) || "my-script"}@v1`;
  const mint = () => pcheck?.hash && setAction({
    title: "Mint your script",
    method: "mint_strategy",
    deposit: "0.1",
    gas: "100",
    args: { info: { strategy_id: id, code_hash: pcheck.hash, author: "<your testnet account>" }, title: name || id, description: idea.slice(0, 200) || "A dolya script" },
    build: (author) => ({ info: { strategy_id: id, code_hash: pcheck.hash, author }, title: name || id, description: idea.slice(0, 200) || "A dolya script" }),
    why: "Creates one NFT for this exact code. You become its author and holder. Only the hash goes on chain; the code stays with you. You pay the storage out of the 0.1 NEAR and get the rest back.",
  });

  return (
    <main className="mx-auto max-w-[760px] px-4 pb-24 sm:px-6">
      <div className="flex items-start justify-between gap-4 pt-10">
        <div className="min-w-0">
          <h1 className="display text-[clamp(1.4rem,7vw,3.4rem)]"><Line>Make your script</Line></h1>
          <p className="mt-3 max-w-[48ch] text-[18px] text-dim">Take one of the 9 starter scripts, change its settings, backtest it and mint it as your NFT. Others copy it from the leaderboard and pay you a share of their new profit.</p>
        </div>
        <img src="/3d/sparkle.png" alt="" className="h-20 w-20 shrink-0 sm:h-28 sm:w-28" />
      </div>

      {/* 1. pick a starter */}
      <div className="card mt-8 p-5">
        <p className="text-[17px] font-bold">1. Pick a starter</p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {STARTERS.map((s) => (
            <button key={s.id} onClick={() => pick(s)} aria-pressed={base.id === s.id}
              className={`flex min-w-0 items-center gap-2 rounded-[14px] px-3 py-2.5 text-left text-[14px] font-semibold transition-colors ${base.id === s.id ? "bg-yel text-white" : "bg-card2 text-ink"}`}>
              <img src={`/3d/${s.img}.png`} alt="" className="h-8 w-8 shrink-0" />
              <span className="min-w-0 leading-tight">{s.name}</span>
            </button>
          ))}
        </div>
        <p className="mt-3 text-[15px] leading-snug text-dim">{base.tagline}</p>
      </div>

      {/* 2. change it */}
      <div className="card mt-3 p-5">
        <p className="text-[17px] font-bold">2. Change its settings</p>
        <p className="mt-1 text-[14px] text-dim">{base.id === "dca" ? "How each buy is split between assets." : "Share of your portfolio per asset. The rest stays in USDC."}</p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {ASSETS.map((a) => (
            <label key={a} className="rounded-[14px] bg-card2 px-3 py-2">
              <span className="text-[13px] text-dim">{a}, %</span>
              <input type="number" min={0} max={100} step={5} value={mix[a] ?? 0} aria-label={`${a} percent`}
                onChange={(e) => { setMix({ ...mix, [a]: Math.max(0, Math.min(100, Number(e.target.value) || 0)) }); changed(); }}
                className="num mt-0.5 w-full bg-transparent text-[18px] font-bold outline-none" />
            </label>
          ))}
        </div>
        <p className={`mt-2 text-[13px] ${total > 100 || total === 0 ? "text-down" : "text-dim"}`}>
          {total === 0 ? "Give at least one asset a share." : total > 100 ? `Shares add up to ${total}%: keep them at 100% or less.` : base.id === "dca" ? `Split: ${total}%` : `${total}% in assets, ${100 - total}% in USDC`}
        </p>
        {base.id === "stress_rotation" && (
          <label className="mt-3 block text-[14px]">
            <span className="text-dim">Stress is read from</span>
            <select value={signal} onChange={(e) => { setSignal(e.target.value); changed(); }} className="ml-2 rounded-[10px] bg-card2 px-2 py-1 font-semibold outline-none">
              {ASSETS.filter((a) => (mix[a] || 0) > 0).map((a) => <option key={a}>{a}</option>)}
            </select>
          </label>
        )}
        <div className="mt-4 flex flex-col gap-3">
          {base.knobs.map((k) => (
            <label key={k.key} className="block">
              <span className="flex justify-between gap-3 text-[14px]"><span>{k.label}{k.hint ? <span className="text-dim"> · {k.hint}</span> : null}</span>
                <input type="number" min={k.min} max={k.max} step={k.step} value={knobs[k.key]} aria-label={k.label}
                  onChange={(e) => { setKnobs({ ...knobs, [k.key]: Number(e.target.value) }); changed(); }}
                  className="num w-24 rounded-[10px] bg-card2 px-2 py-1 text-right font-semibold outline-none" /></span>
              <input type="range" min={k.min} max={k.max} step={k.step} value={knobs[k.key]} onChange={(e) => { setKnobs({ ...knobs, [k.key]: Number(e.target.value) }); changed(); }} className="mt-1 w-full accent-[#ff7a00]" />
            </label>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <motion.button whileTap={{ scale: 0.95 }} onClick={check} disabled={checking || total === 0 || total > 100} className="rounded-[14px] bg-ink px-4 py-2.5 text-[15px] font-semibold text-white disabled:opacity-50">{checking ? "Checking…" : "Check it"}</motion.button>
          <motion.button whileTap={{ scale: 0.95 }} onClick={backtest} disabled={btBusy || total === 0 || total > 100} className="rounded-[14px] bg-card2 px-4 py-2.5 text-[15px] font-semibold disabled:opacity-50">{btBusy ? "Backtesting…" : "Backtest 1 year"}</motion.button>
        </div>
        {checked && <p role="status" className="mt-3 rounded-[14px] bg-[#e8f7ee] px-3 py-2 text-[14px] text-up">✓ dolya’s engine runs this script · hash <span className="font-mono">{checked.hash.slice(0, 12)}…</span></p>}
        {checkErr && <p role="alert" className="mt-3 rounded-[14px] bg-[#fdecea] px-3 py-2 text-[14px] text-down">✕ {checkErr}</p>}
        {btErr && <p role="alert" className="mt-3 rounded-[14px] bg-[#fdecea] px-3 py-2 text-[14px] text-down">Backtest failed: {btErr}</p>}
        {bt && (
          <div className="mt-3 rounded-[18px] bg-card2 p-4">
            {bt.curve.length > 1 && <Area data={bt.curve} id={`bt-${base.id}`} h={80} />}
            <div className="mt-3 grid grid-cols-3 gap-2">
              <div><p className="text-[12px] text-dim">Return</p><Change v={bt.ret} className="mt-0.5 block text-[18px] font-bold" /></div>
              <div><p className="text-[12px] text-dim">Worst dip</p><p className="num mt-0.5 text-[18px] font-bold text-down">{bt.dd.toFixed(1)}%</p></div>
              <div><p className="text-[12px] text-dim">Just holding the mix</p>{bt.hold === null ? <p className="mt-0.5 text-[18px] font-bold text-dim">—</p> : <Change v={bt.hold} className="mt-0.5 block text-[18px] font-bold" />}</div>
            </div>
            <p className="mt-2 text-[12px] text-dim">Backtest on real daily prices{bt.period ? `, ${bt.period}` : ""}, after swap costs{bt.trades !== null ? `, ${bt.trades} trades` : ""}. Past results don’t promise future ones.</p>
          </div>
        )}
      </div>

      {/* 3. mint */}
      <div className="card mt-3 p-5">
        <p className="text-[17px] font-bold">3. Mint it</p>
        <p className="mt-1 text-[14px] text-dim">One NFT per script, on NEAR {NFT.network}. Free apart from storage. The record starts with its first live week.</p>
        <label className="mt-3 block text-[14px] text-dim" htmlFor="sname">Name</label>
        <input id="sname" value={sname} onChange={(e) => setSname(e.target.value)} placeholder={`My ${base.name.toLowerCase()}`} className="mt-1 w-full rounded-[14px] bg-card2 px-4 py-3 text-[17px] outline-none focus:ring-2 focus:ring-yel" />
        <p className="mt-1 text-[13px] text-dim">NFT id: <span className="font-mono">{sid}</span></p>
        <motion.button whileTap={{ scale: 0.97 }} onClick={mintChanged} disabled={!checked} className="btn btn-yel mt-4 w-full">Mint on {NFT.network}</motion.button>
        {!checked && <p className="mt-2 text-center text-[13px] text-dim">Check the script first.</p>}
        {accountId && <p className="mt-2 text-center text-[13px] text-dim">You’ll sign as {accountId}.</p>}
      </div>

      <p className="mt-6 text-center text-[14px] text-dim">Others copy it from the <Link href="/leaderboard" className="font-semibold text-yel underline">leaderboard</Link> and pay you a share of their new profit.</p>

      {/* write from scratch: research only */}
      <details className="card mt-8 p-5">
        <summary className="cursor-pointer text-[17px] font-bold">Write from scratch <span className="text-[14px] font-medium text-dim">· research: dolya’s engine can’t run custom code yet</span></summary>
        <p className="mt-2 text-[14px] text-dim">Describe an idea, NEAR AI drafts Python, dolya checks it, and you can mint it with a public record. Until custom code runs in the engine, nobody can copy it.</p>
        <div className="mt-4 flex items-center justify-between gap-3">
          <label htmlFor="idea" className="text-[15px] font-semibold">Your idea</label>
          <VoiceButton onText={setIdea} />
        </div>
        <textarea id="idea" value={idea} onChange={(e) => setIdea(e.target.value)} rows={3} placeholder="e.g. Buy BTC when it is above its 100-day average, hold cash otherwise"
          className="mt-2 w-full resize-none rounded-[16px] bg-card2 px-4 py-3 text-[17px] leading-snug outline-none focus:ring-2 focus:ring-yel" />
        <div className="no-scrollbar -mx-1 mt-2 flex gap-2 overflow-x-auto px-1">
          {IDEAS.map((x) => (
            <button key={x} onClick={() => setIdea(x)} className={`shrink-0 rounded-full px-3 py-1.5 text-[13px] font-semibold ${idea === x ? "bg-yel text-white" : "bg-card2"}`}>{x}</button>
          ))}
        </div>
        <motion.button whileTap={{ scale: 0.97 }} onClick={draft} disabled={busy || idea.trim().length < 3} className="btn btn-gray mt-3 w-full">
          {busy ? "Drafting…" : "Draft with NEAR AI"}
        </motion.button>
        <AnimatePresence>
          {note && (
            <motion.p initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} role="status"
              className={`mt-3 rounded-[14px] px-3 py-2 text-[14px] ${note.ok ? "bg-[#e8f7ee] text-up" : "bg-[#fdecea] text-down"}`}>{note.text}</motion.p>
          )}
        </AnimatePresence>
        <p className="mt-4 text-[14px] text-dim">One Python function, <code>def target(daily)</code>, that returns target weights. No imports, no files.</p>
        <textarea value={code} onChange={(e) => { setCode(e.target.value); setPcheck(null); }} rows={11} spellCheck={false}
          className="mt-2 w-full resize-y rounded-[16px] bg-ink px-4 py-3 font-mono text-[13px] leading-relaxed text-white/90 outline-none focus:ring-2 focus:ring-yel" />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <motion.button whileTap={{ scale: 0.95 }} onClick={runCheck} className="rounded-[14px] bg-card2 px-4 py-2.5 text-[15px] font-semibold">Check it</motion.button>
          {pcheck && (pcheck.problems.length
            ? <span className="text-[14px] text-down">✕ {pcheck.problems.join("; ")}</span>
            : <span className="text-[14px] text-up">✓ Passes the checks · hash <span className="font-mono">{pcheck.hash.slice(0, 12)}…</span></span>)}
        </div>
        <label className="mt-4 block text-[14px] text-dim" htmlFor="pname">Name</label>
        <input id="pname" value={name} onChange={(e) => setName(e.target.value)} placeholder="BTC trend" className="mt-1 w-full rounded-[14px] bg-card2 px-4 py-3 text-[17px] outline-none focus:ring-2 focus:ring-yel" />
        <p className="mt-1 text-[13px] text-dim">NFT id: <span className="font-mono">{id}</span></p>
        <motion.button whileTap={{ scale: 0.97 }} onClick={mint} disabled={!pcheck?.hash} className="btn btn-gray mt-3 w-full">Mint research script on {NFT.network}</motion.button>
      </details>

      <NftActionSheet action={action} onClose={() => setAction(null)} />
    </main>
  );
}
