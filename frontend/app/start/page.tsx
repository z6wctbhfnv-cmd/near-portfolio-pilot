"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Mark } from "@/components/Logo";
import { useWallet } from "@/components/wallet";
import { VoiceButton } from "@/components/VoiceButton";
import { SignFlow, liveError } from "@/components/SignFlow";
import { examples, parseRules } from "@/lib/demo";
import { api, ApiError, setCurrentPilotId, type Mandate, type ParseResult, type StrategyRef } from "@/lib/api";
import { LIMIT_EXAMPLES, PRESETS, applyLimits, parseLimit, presetOf, presetPatch, type Limit, type Preset } from "@/lib/limits";
import { createPasskey, forgetPasskey, fullAccessKeys, NEP366_MISSING, passkeySupported, savedPasskey, type Owner, type OwnerAction, type PasskeyOwner } from "@/lib/owner";
import { RISK_NOTICE } from "@/lib/config";
import { STARTER_NAMES } from "@/lib/starters";

const money = (n: number | null | undefined) => (n == null ? "—" : `$${n.toLocaleString("en-US")}`);
const DAY: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

/** Turns the mandate into readable rule rows. */
function rowsFrom(m: Mandate, s: StrategyRef) {
  const w = s.params.weights ?? {};
  const mix = Object.entries(w).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(" · ");
  return [
    { k: "Weekly limit", v: money(m.budget.weekly_usd) },
    { k: "Daily limit", v: money(m.budget.daily_usd) },
    { k: "Largest single trade", v: money(m.max_trade_usd) },
    { k: "Trades an hour", v: m.max_actions_per_hour ? `up to ${m.max_actions_per_hour}` : "—" },
    { k: "Risk", v: m.risk[0].toUpperCase() + m.risk.slice(1) },
    { k: "Assets", v: [...m.assets, m.stable].join(", ") },
    { k: "Strategy", v: `${STARTER_NAMES[s.id] ?? s.id}${mix ? ` · ${mix}` : ""}` },
    ...(m.owner_approval ? [{ k: "Approval", v: "You approve every trade" }] : []),
    ...(m.timelock_minutes ? [{ k: "Delay", v: `${m.timelock_minutes} min before each trade` }] : []),
    ...(m.schedule ? [{ k: "When", v: `${m.schedule.days.map((d) => DAY[d] ?? d).join(", ")} · ${m.schedule.start}–${m.schedule.end} ${m.schedule.time_zone}` }] : []),
    { k: "Withdrawals", v: "Your wallet only" },
  ];
}

const stopText = (s?: { enabled: boolean; max_drawdown: number }) =>
  !s || s.enabled ? `Sell to cash at −${Math.round((s?.max_drawdown ?? 0.2) * 100)}% from the peak` : "Off";

type Mode = "paper" | "live";
const TERMS = [
  ["owner", "I accept the NEAR Intents Agent API Owner Terms."],
  ["outlayer", "I accept OutLayer’s terms: the agent wallet runs in its enclave."],
  ["risk", "I read the risk notice above and can lose everything I deposit."],
] as const;

export default function Start() {
  const { accountId, publicKey, connect } = useWallet();
  const [step, setStep] = useState(0);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [amount, setAmount] = useState(1000);

  // review: preset + limits on top of what the backend read
  const [preset, setPreset] = useState<Preset | null>(null);
  const [limits, setLimits] = useState<Limit[]>([]);
  const [limitText, setLimitText] = useState("");
  const [limitMsg, setLimitMsg] = useState<string | null>(null);
  const [compiled, setCompiled] = useState<{ strategy: StrategyRef; warnings: string[] } | null>(null);

  // start: paper or live
  const [mode, setMode] = useState<Mode>("paper");
  const [ownerKind, setOwnerKind] = useState<"passkey" | "near">("passkey");
  const [passkey, setPasskey] = useState<PasskeyOwner | null>(null);
  const [keys, setKeys] = useState<string[] | null>(null);
  const [nearKey, setNearKey] = useState<string>("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [terms, setTerms] = useState<Record<string, boolean>>({});

  // sign: the live owner actions
  const [pilotId, setPilotId] = useState<string | null>(null);
  const [action, setAction] = useState<OwnerAction | null>(null);
  const [grant, setGrant] = useState<OwnerAction | null>(null);
  const [grantBusy, setGrantBusy] = useState(false);
  const [done, setDone] = useState<Mode | null>(null);

  useEffect(() => { setPasskey(savedPasskey()); }, []);

  // The mandate actually shown and signed: backend read → preset → limits in words.
  const mandate = useMemo<Mandate | null>(() => {
    if (!parsed) return null;
    const base = preset ? { ...parsed.mandate, ...presetPatch(preset, amount, parsed.mandate.budget) } : parsed.mandate;
    return applyLimits(base, limits);
  }, [parsed, preset, limits, amount]);
  const mandateKey = JSON.stringify(mandate);

  // Recompile when the owner changed something, so the strategy and warnings match what is signed.
  useEffect(() => {
    if (!mandate || (!preset && !limits.some((l) => l.patch))) { setCompiled(null); return; }
    let alive = true;
    const t = setTimeout(() => {
      api.compile(mandate).then((c) => alive && setCompiled({ strategy: c.strategy, warnings: c.warnings })).catch((e) => alive && setLimitMsg(liveError(e)));
    }, 250);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mandateKey]);

  // The NEAR owner's key: the wallet signs owner messages with a full-access key.
  useEffect(() => {
    if (mode !== "live" || ownerKind !== "near" || !accountId) return;
    setKeys(null); setKeyError(null);
    fullAccessKeys(accountId)
      .then((k) => { setKeys(k); setNearKey(k.includes(publicKey ?? "") ? publicKey! : k[0] ?? ""); })
      .catch((e) => { setKeys([]); setKeyError(`Couldn’t read your keys from mainnet (${(e as Error).message.slice(0, 60)}).`); });
  }, [mode, ownerKind, accountId, publicKey]);

  const strategy = compiled?.strategy ?? parsed?.strategy;
  const rows = mandate && strategy ? rowsFrom(mandate, strategy) : parseRules(text).map((r) => ({ k: r.k, v: r.v }));
  // The parser's "filled in" notes describe its own defaults; a preset replaces those, so they'd mislead.
  const notes = parsed ? [...(preset ? [] : parsed.notes), ...(compiled?.warnings ?? parsed.warnings)] : [];
  const owner: Owner | null = ownerKind === "passkey" ? passkey : accountId && nearKey ? { type: "near", account_id: accountId, public_key: nearKey } : null;
  const termsOk = TERMS.every(([k]) => terms[k]);
  const live = mode === "live";
  const total = live ? 4 : 3;
  const titles = ["How should we handle your money?", "Here’s what we understood", live ? "Who owns it" : "Start your pilot", "Sign your rules"];

  const understand = async () => {
    setBusy(true); setError(null); setPreset(null); setLimits([]); setCompiled(null);
    try { setParsed(await api.parse(text)); }
    catch (e) { setParsed(null); setError(e instanceof ApiError && e.code === "offline" ? "Backend is offline, so this is a local preview of your rules." : (e as Error).message); }
    finally { setBusy(false); setStep(1); }
  };

  const addLimit = (t: string) => {
    if (!parsed || !mandate) { setLimitMsg("Limits need the backend to read your rules first."); return; }
    try {
      const l = parseLimit(t, mandate);
      setLimits((xs) => [...xs.filter((x) => x.label !== l.label), l]);
      setLimitText("");
      setLimitMsg(l.enforced ? `Added to your rules: ${l.label}.` : `Saved: ${l.label}. dolya can’t enforce this kind of limit yet, so it isn’t part of what you sign.`);
    } catch (e) { setLimitMsg((e as Error).message); }
  };

  const startPaper = async () => {
    setBusy(true); setError(null);
    try {
      // Create from the mandate the owner just reviewed, not from the text again: a second AI read
      // could differ from what was shown (and takes another 10–20 s).
      const name = accountId ? `${accountId} pilot` : "My pilot";
      const r = await api.createPilot(mandate ? { name, mandate, initial_usd: amount } : { name, text, initial_usd: amount });
      setCurrentPilotId(r.pilot.id, r.pilot_key);
      setDone("paper");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const createLive = async () => {
    if (!owner || !mandate) return;
    setBusy(true); setError(null);
    try {
      const r = await api.createPilot({ name: owner.type === "near" ? `${owner.account_id} pilot` : "My pilot", mode: "live", mandate, owner, accepted_terms: true, initial_usd: amount });
      if (!r.owner_action) throw new Error("The backend created the pilot but sent nothing to sign.");
      setCurrentPilotId(r.pilot.id, r.pilot_key);
      setPilotId(r.pilot.id);
      setAction(r.owner_action);
      setStep(3);
    } catch (e) { setError(liveError(e)); }
    finally { setBusy(false); }
  };

  const askGrant = async () => {
    if (!pilotId) return;
    setGrantBusy(true); setError(null);
    try { setGrant((await api.grant(pilotId)).owner_action); }
    catch (e) { setError(liveError(e)); }
    finally { setGrantBusy(false); }
  };

  const next = step === 0 ? understand : step === 1 ? () => setStep(2) : live ? createLive : startPaper;
  const nextDisabled = busy || (step === 0 && text.trim().length < 8) || (step === 2 && live && (!owner || !termsOk || !mandate));
  const nextLabel = step === 0 ? "Continue" : step === 1 ? "Looks right" : live ? "Create and sign" : "Start my pilot";

  if (done) {
    return (
      <main className="mx-auto max-w-[600px] px-4 pb-36 pt-16 text-center sm:px-6">
        <motion.div className="mx-auto w-fit" initial={{ scale: 0.3, rotate: -90 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 200, damping: 12 }}>
          <Mark size={130} />
        </motion.div>
        <h1 className="display mt-8 text-[40px]">You’re all set</h1>
        <p className="mx-auto mt-3 max-w-[34ch] text-[17px] text-dim">{done === "paper"
          ? "Your pilot is live in paper mode. Every move will show up in your portfolio with a reason."
          : "Your agent wallet exists under the rules you signed, and the runner may trade inside them. Fund it next; nothing moves before that."}</p>
        <div className="mt-8 flex flex-col gap-2">
          <Link href="/dashboard" className="btn btn-yel">Open portfolio</Link>
          <Link href="/strategies" className="btn btn-gray">Browse strategies</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-[600px] px-4 pb-36 sm:px-6">
      <div className="mt-6 flex items-center gap-3">
        <motion.button whileTap={{ scale: 0.9 }} onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0 || step === 3} aria-label="Back"
          className="grid h-11 w-11 place-items-center rounded-full bg-card text-[18px] shadow-sm disabled:opacity-0">←</motion.button>
        <div className="flex flex-1 gap-1.5">
          {Array.from({ length: total }, (_, i) => (
            <div key={i} className="h-1.5 flex-1 overflow-hidden rounded-full bg-card2">
              <motion.div className="h-full rounded-full bg-yel" initial={false} animate={{ width: i <= step ? "100%" : "0%" }} transition={{ duration: 0.4 }} />
            </div>
          ))}
        </div>
        <span className="num w-10 text-right text-[14px] text-dim">{step + 1}/{total}</span>
      </div>

      <AnimatePresence mode="wait">
        <motion.div key={step} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={{ duration: 0.25 }}>
          <div className="mt-8 flex items-start justify-between gap-4">
            <h1 className="display text-[clamp(1.9rem,6vw,2.6rem)]">{titles[step]}</h1>
            <img src={`/3d/${["bubble", "shield", live ? "lock" : "wallet", "wallet"][step]}.png`} alt="" className="h-20 w-20 shrink-0" />
          </div>

          {step === 0 && (
            <>
              <p className="mt-3 text-[17px] text-dim">Write it, or say it. English or Russian. Nothing is signed until the last step.</p>
              <div className="card mt-6 p-1 focus-within:ring-2 focus-within:ring-yel">
                <div className="flex items-center justify-between px-4 pt-3">
                  <label htmlFor="rules" className="text-[13px] text-dim">Your words</label>
                  <VoiceButton onText={setText} />
                </div>
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

              {parsed && (
                <div className="mt-6 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Preset">
                  {PRESETS.map((p) => {
                    const on = (preset ?? (mandate ? presetOf(mandate) : null)) === p.id;
                    return (
                      <motion.button key={p.id} role="radio" aria-checked={on} aria-label={`${p.name}: ${p.line}`} whileTap={{ scale: 0.96 }} onClick={() => setPreset(on ? null : p.id)}
                        className={`relative flex flex-col items-start rounded-[20px] p-3 text-left transition-colors sm:p-4 ${on ? "bg-yel text-white" : "bg-card shadow-sm hover:bg-card2"}`}>
                        <img src={`/3d/${p.img}.png`} alt="" className="h-10 w-10" />
                        <span className="mt-2 text-[16px] font-bold">{p.name}</span>
                        <span className={`text-[12px] leading-tight ${on ? "text-white/85" : "text-dim"}`}>{p.line}</span>
                      </motion.button>
                    );
                  })}
                </div>
              )}
              {preset && <p className="mt-2 text-[13px] text-dim">Scaled to a ${amount.toLocaleString("en-US")} pilot. Tap again to go back to what you wrote.</p>}

              <div className="card mt-3 divide-y divide-line px-5">
                {rows.map((r, i) => (
                  <motion.div key={r.k} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}
                    className="flex items-center justify-between gap-4 py-4">
                    <span className="text-[15px] text-dim">{r.k}</span>
                    <motion.span key={r.v} initial={{ opacity: 0.3 }} animate={{ opacity: 1 }} className="text-right text-[17px] font-semibold">{r.v}</motion.span>
                  </motion.div>
                ))}
              </div>
              {parsed && mandate && (
                <div className="card mt-3 flex items-center justify-between gap-4 px-5 py-4">
                  <div className="min-w-0">
                    <p className="text-[15px] text-dim">Safety stop</p>
                    <p className="text-[17px] font-semibold">{stopText(mandate.drawdown_stop)}</p>
                  </div>
                  <button type="button" role="switch" aria-checked={mandate.drawdown_stop?.enabled ?? true} aria-label="Safety stop"
                    onClick={() => setLimits((xs) => [...xs.filter((x) => !x.label.startsWith("Safety stop")), { label: `Safety stop ${(mandate.drawdown_stop?.enabled ?? true) ? "off" : "on"}`, enforced: true, patch: { drawdown_stop: { max_drawdown: mandate.drawdown_stop?.max_drawdown ?? 0.2, enabled: !(mandate.drawdown_stop?.enabled ?? true) } } }])}
                    className={`relative h-8 w-14 shrink-0 rounded-full transition-colors ${(mandate.drawdown_stop?.enabled ?? true) ? "bg-yel" : "bg-card2"}`}>
                    <span className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all ${(mandate.drawdown_stop?.enabled ?? true) ? "left-7" : "left-1"}`} />
                  </button>
                </div>
              )}

              <div className="card mt-3 p-5">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[17px] font-bold">Add a limit in words</p>
                  <VoiceButton onText={setLimitText} onFinal={addLimit} />
                </div>
                <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); addLimit(limitText); }}>
                  <label htmlFor="limit" className="sr-only">New limit</label>
                  <input id="limit" value={limitText} onChange={(e) => setLimitText(e.target.value)} placeholder="$50 per trade · never buy SOL · stop at 15%" autoComplete="off"
                    className="min-w-0 flex-1 rounded-[14px] bg-card2 px-4 py-3 text-[16px] outline-none focus:ring-2 focus:ring-yel" />
                  <motion.button whileTap={{ scale: 0.95 }} type="submit" disabled={!limitText.trim()} className="rounded-[14px] bg-yel px-4 font-semibold text-white disabled:opacity-40">Add</motion.button>
                </form>
                <div className="no-scrollbar -mx-1 mt-2 flex gap-2 overflow-x-auto px-1">
                  {LIMIT_EXAMPLES.map((x) => <button key={x} onClick={() => addLimit(x)} className="shrink-0 rounded-full bg-card2 px-3 py-1.5 text-[13px] font-semibold">{x}</button>)}
                </div>
                {limitMsg && <p className="mt-3 text-[14px] text-dim" role="status">{limitMsg}</p>}
                {limits.length > 0 && (
                  <ul className="mt-3 flex flex-col gap-2">
                    {limits.map((l) => (
                      <motion.li layout key={l.label} initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="flex items-center gap-3 rounded-[14px] bg-card2 px-3 py-2.5">
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${l.enforced ? "bg-up text-white" : "bg-white text-dim"}`}>{l.enforced ? "signed" : "not enforced yet"}</span>
                        <span className="min-w-0 flex-1 text-[15px]">{l.label}</span>
                        <button onClick={() => setLimits((xs) => xs.filter((x) => x !== l))} aria-label={`Remove ${l.label}`} className="text-[18px] text-dim hover:text-down">×</button>
                      </motion.li>
                    ))}
                  </ul>
                )}
              </div>

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
              <div className="mt-6 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Money">
                {([["paper", "Paper money", "Watch it work. Nothing real moves.", "sparkle"], ["live", "My wallet", "Real funds, mainnet beta. You sign.", "wallet"]] as const).map(([k, t, d, img]) => (
                  <motion.button key={k} role="radio" aria-checked={mode === k} aria-label={t} whileTap={{ scale: 0.97 }} onClick={() => setMode(k)} disabled={k === "live" && !parsed}
                    className={`flex flex-col items-start rounded-[22px] p-4 text-left transition-colors disabled:opacity-40 ${mode === k ? "bg-yel text-white" : "bg-card shadow-sm hover:bg-card2"}`}>
                    <img src={`/3d/${img}.png`} alt="" className="h-11 w-11" />
                    <span className="mt-2 text-[17px] font-bold">{t}</span>
                    <span className={`text-[13px] leading-tight ${mode === k ? "text-white/85" : "text-dim"}`}>{d}</span>
                  </motion.button>
                ))}
              </div>
              {!parsed && <p className="mt-2 text-[13px] text-dim">A real wallet needs the backend to read your rules first.</p>}

              {!live && (
                <>
                  <div className="card mt-3 p-5">
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

              {live && (
                <>
                  <p className="mt-5 text-[15px] font-semibold">The owner signs the rules and is the only one who can change or freeze them.</p>
                  <div className="mt-2 grid grid-cols-2 gap-1 rounded-[16px] bg-card2 p-1">
                    {([["passkey", "Passkey"], ["near", "NEAR wallet"]] as const).map(([k, l]) => (
                      <button key={k} onClick={() => setOwnerKind(k)} className="relative h-10 rounded-[12px] text-[15px] font-semibold">
                        {ownerKind === k && <motion.span layoutId="owner-kind" className="absolute inset-0 rounded-[12px] bg-white shadow-sm" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}
                        <span className="relative">{l}{k === "passkey" ? " · works now" : ""}</span>
                      </button>
                    ))}
                  </div>

                  {ownerKind === "passkey" ? (
                    <div className="card mt-3 p-5">
                      {passkey ? (
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-[15px]">Passkey <b>{passkey.credential_id.slice(0, 8)}</b> on this device</p>
                          <button onClick={() => { forgetPasskey(); setPasskey(null); }} className="text-[14px] font-semibold text-dim">Use another</button>
                        </div>
                      ) : (
                        <>
                          <p className="text-[15px] leading-snug">Face ID, Touch ID or your device PIN. No seed phrase. Lose every device with this passkey and nobody can change your agent’s rules, including us.</p>
                          <motion.button whileTap={{ scale: 0.97 }} disabled={!passkeySupported()} className="btn btn-gray mt-3 w-full"
                            onClick={() => createPasskey().then(setPasskey).catch((e) => setError(liveError(e)))}>Create a passkey</motion.button>
                          {!passkeySupported() && <p className="mt-2 text-[13px] text-dim">This browser doesn’t support passkeys.</p>}
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="card mt-3 p-5">
                      {!accountId ? (
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-[15px]">Connect the NEAR account that will own the agent.</p>
                          <motion.button whileTap={{ scale: 0.95 }} onClick={connect} className="shrink-0 rounded-[12px] bg-yel px-3 py-2 text-[14px] font-semibold text-white">Connect</motion.button>
                        </div>
                      ) : (
                        <>
                          <p className="text-[15px]">Owner <b className="break-all">{accountId}</b></p>
                          {keys === null ? <p className="mt-2 text-[14px] text-dim">Reading your keys…</p>
                            : keys.length > 1 ? (
                              <label className="mt-2 block text-[14px] text-dim">Key your wallet signs with
                                <select value={nearKey} onChange={(e) => setNearKey(e.target.value)} className="mt-1 w-full rounded-[12px] bg-card2 px-3 py-2 font-mono text-[13px] text-ink outline-none">
                                  {keys.map((k) => <option key={k} value={k}>{k.slice(0, 20)}…{k.slice(-6)}</option>)}
                                </select>
                              </label>
                            ) : keys.length === 1 ? <p className="mt-2 font-mono text-[13px] text-dim">{keys[0].slice(0, 24)}…</p>
                            : <p className="mt-2 text-[14px] text-down">{keyError ?? "This account has no full-access key, so it can’t sign as an owner."}</p>}
                          <p className="mt-3 rounded-[14px] bg-cream/70 px-3 py-2 text-[13px] leading-snug">{NEP366_MISSING}</p>
                        </>
                      )}
                    </div>
                  )}

                  <div className="card mt-3 p-5">
                    <p className="text-[17px] font-bold">Before you sign</p>
                    <p className="mt-2 rounded-[16px] bg-card2 p-4 text-[14px] leading-snug">{RISK_NOTICE}</p>
                    <div className="mt-3 flex flex-col gap-2">
                      {TERMS.map(([k, l]) => (
                        <label key={k} className="flex cursor-pointer items-start gap-3 rounded-[14px] px-1 py-1.5 text-[15px] leading-snug">
                          <input type="checkbox" checked={!!terms[k]} onChange={(e) => setTerms((t) => ({ ...t, [k]: e.target.checked }))} className="mt-0.5 h-5 w-5 shrink-0 accent-[#ff7a00]" />
                          {l}
                        </label>
                      ))}
                    </div>
                    <p className="mt-2 text-[13px] text-dim">You fund the agent wallet after it’s created. Until then nothing can trade.</p>
                  </div>
                </>
              )}
            </>
          )}

          {step === 3 && action && (
            <div className="mt-6 flex flex-col gap-3">
              {owner && <SignFlow action={action} owner={owner} onDone={(s) => { if (s.status === "SUCCESS") askGrant(); }} />}
              {grantBusy && <p className="card p-5 text-[15px] text-dim">Preparing the runner’s access…</p>}
              {grant && owner && <SignFlow action={grant} owner={owner} onDone={(s) => { if (s.status === "SUCCESS") setDone("live"); }} />}
              <p className="text-center text-[13px] text-dim">You can also finish signing later from your portfolio.</p>
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
            <motion.button whileTap={{ scale: 0.97 }} className="btn btn-yel w-full" disabled={nextDisabled} onClick={next}>
              {busy ? <motion.span className="h-5 w-5 rounded-full border-[3px] border-white border-t-transparent" animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.7, ease: "linear" }} /> : nextLabel}
            </motion.button>
          </div>
        </div>
      )}
    </main>
  );
}
