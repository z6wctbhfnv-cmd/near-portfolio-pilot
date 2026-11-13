"use client";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { checkNearAiKey, listen, nearAiKey, recordAndTranscribe, setNearAiKey, voiceSupported } from "@/lib/voice";
import { Sheet } from "./ui";

/**
 * Mic button. Tap to talk: the browser's speech recognition fills the text as you speak.
 * With the owner's own NEAR AI key and "private voice" on, it records 6 seconds and Whisper on NEAR AI transcribes.
 */
export function VoiceButton({ onText, onFinal, className = "" }: { onText: (t: string) => void; onFinal?: (t: string) => void; className?: string }) {
  const [state, setState] = useState<"idle" | "listening" | "recording">("idle");
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  const [settings, setSettings] = useState(false);
  const [privateOn, setPrivateOn] = useState(false);
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => {
    setSupported(voiceSupported());
    try { setPrivateOn(!!nearAiKey() && localStorage.getItem("dolya.voice.private") === "1"); } catch { /* blocked */ }
  }, [settings]);

  const tap = async () => {
    setError(null);
    if (state !== "idle") { stop.current?.(); return; }
    if (privateOn) {
      setState("recording");
      try {
        const t = (await recordAndTranscribe()).trim();
        if (t) { onText(t); onFinal?.(t); }
      } catch (e) { setError((e as Error).message); }
      finally { setState("idle"); }
      return;
    }
    if (!supported) { setError("Voice needs Chrome, Edge or Safari. Or turn on private voice."); return; }
    setState("listening");
    try {
      stop.current = listen({
        onText: (t, final) => { onText(t); if (final) { stop.current = null; setState("idle"); onFinal?.(t); } },
        onEnd: () => { stop.current = null; setState("idle"); },
        onError: (e) => { stop.current = null; setState("idle"); setError(e === "not-allowed" ? "Microphone access was blocked." : e === "no-speech" ? "Didn’t hear anything." : `Voice: ${e}`); },
      });
    } catch (e) { setState("idle"); setError((e as Error).message); }
  };

  const on = state !== "idle";
  return (
    <span className={`relative inline-flex items-center gap-1 ${className}`}>
      <motion.button type="button" onClick={tap} whileTap={{ scale: 0.9 }} aria-pressed={on}
        aria-label={on ? "Stop listening" : "Speak"} title={privateOn ? "Private voice: Whisper on NEAR AI" : "Speak"}
        className={`relative grid h-11 w-11 place-items-center rounded-full transition-colors ${on ? "bg-down text-white" : "bg-card2 text-ink hover:bg-cream"}`}>
        {on && <motion.span className="absolute inset-0 rounded-full bg-down" initial={{ scale: 1, opacity: 0.5 }} animate={{ scale: 1.6, opacity: 0 }} transition={{ repeat: Infinity, duration: 1.2 }} />}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden className="relative">
          <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
        </svg>
      </motion.button>
      <button type="button" onClick={() => setSettings(true)} className="text-[12px] font-semibold text-dim hover:text-ink">{privateOn ? "private" : "voice"}</button>
      <AnimatePresence>
        {(error || state === "recording") && (
          <motion.span initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} role="status"
            className="absolute right-0 top-[calc(100%+6px)] z-10 w-max max-w-[260px] rounded-[12px] bg-ink px-3 py-2 text-[13px] text-white shadow-lg">
            {state === "recording" ? "Recording 6 seconds…" : error}
          </motion.span>
        )}
      </AnimatePresence>
      <VoiceSettings open={settings} onClose={() => setSettings(false)} />
    </span>
  );
}

function VoiceSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [key, setKey] = useState("");
  const [has, setHas] = useState(false);
  const [priv, setPriv] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setHas(!!nearAiKey()); setMsg(null); setKey("");
    try { setPriv(localStorage.getItem("dolya.voice.private") === "1"); } catch { /* blocked */ }
  }, [open]);
  const savePriv = (v: boolean) => { setPriv(v); try { localStorage.setItem("dolya.voice.private", v ? "1" : "0"); } catch { /* blocked */ } };
  const connect = async () => {
    setMsg("Checking the key…");
    const ok = await checkNearAiKey(key.trim()).catch(() => false);
    if (!ok) { setMsg("NEAR AI didn’t accept this key."); return; }
    setNearAiKey(key.trim()); setHas(true); savePriv(true); setMsg("Connected. Private voice is on.");
  };
  return (
    <Sheet open={open} onClose={onClose}>
      <h3 className="display text-[26px]">Voice</h3>
      <p className="mt-2 text-[16px] leading-snug text-ink/80">By default your browser turns speech into text (Chrome uses Google, Safari uses Apple). For private voice, add your own NEAR AI key: dolya records here and Whisper on NEAR AI transcribes. NEAR AI bills your account directly; the key stays in this browser.</p>
      <div className="mt-4 rounded-[18px] bg-card2 p-4">
        <p className="text-[15px] font-semibold">{has ? "NEAR AI key connected" : "NEAR AI key"}</p>
        <div className="mt-2 flex gap-2">
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={has ? "•••••• replace" : "Paste your key"} autoComplete="off" className="min-w-0 flex-1 rounded-[12px] bg-white px-3 py-2 text-[15px] outline-none focus:ring-2 focus:ring-yel" />
          <button onClick={connect} disabled={key.trim().length < 8} className="rounded-[12px] bg-yel px-4 font-semibold text-white disabled:opacity-40">{has ? "Replace" : "Connect"}</button>
        </div>
        {has && (
          <div className="mt-3 flex items-center justify-between">
            <label className="flex items-center gap-2 text-[15px]"><input type="checkbox" checked={priv} onChange={(e) => savePriv(e.target.checked)} className="h-5 w-5 accent-[#ff7a00]" /> Private voice (Whisper on NEAR AI)</label>
            <button onClick={() => { setNearAiKey(""); setHas(false); savePriv(false); }} className="text-[14px] font-semibold text-down">Forget key</button>
          </div>
        )}
        {msg && <p className="mt-2 text-[14px] text-dim" role="status">{msg}</p>}
      </div>
    </Sheet>
  );
}
