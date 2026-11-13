// Voice input, ported from web/js/command.js and web/js/nearai.js.
// - Browser speech recognition (Chrome sends audio to Google, Safari to Apple). Works with no setup.
// - Private voice: record here and transcribe with Whisper on NEAR AI, with the owner's own NEAR AI key.
//   The key stays in this browser and goes only to cloud-api.near.ai; NEAR AI bills the owner directly.

type Rec = { lang: string; interimResults: boolean; maxAlternatives: number; start(): void; stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null };

const Recognition = () => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

export const voiceSupported = () => !!Recognition();
export const speechLang = () => (typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ru") ? "ru-RU" : "en-US");

/** Starts listening; returns a stop function. onText gets the running transcript and whether it is final. */
export function listen({ lang = speechLang(), onText, onEnd, onError }: { lang?: string; onText: (t: string, final: boolean) => void; onEnd?: () => void; onError?: (e: string) => void }) {
  const R = Recognition();
  if (!R) throw new Error("Voice needs Chrome, Edge or Safari.");
  const r = new R();
  r.lang = lang;
  r.interimResults = true;
  r.maxAlternatives = 1;
  r.onresult = (e) => {
    const all = Array.from(e.results);
    onText(all.map((x) => x[0].transcript).join(" "), all[all.length - 1].isFinal);
  };
  r.onerror = (e) => onError?.(e.error);
  r.onend = () => onEnd?.();
  r.start();
  return () => r.stop();
}

/* ---------- private voice: Whisper on NEAR AI, with the owner's own key ---------- */
const BASE = "https://cloud-api.near.ai/v1";
const KEY = "dolya.nearai";

export function nearAiKey(): string {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}").key ?? ""; } catch { return ""; }
}
export function setNearAiKey(key: string) {
  try { if (key) localStorage.setItem(KEY, JSON.stringify({ key })); else localStorage.removeItem(KEY); } catch { /* blocked */ }
}

/** One token on a cheap model: proves the key works (a few millionths of a dollar on the owner's account). */
export async function checkNearAiKey(key: string) {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "z-ai/glm-5.3-flash", messages: [{ role: "user", content: "ok" }], max_tokens: 1 }),
  });
  return r.ok;
}

/** Records up to `seconds`, then transcribes with Whisper on NEAR AI. */
export async function recordAndTranscribe(seconds = 6, lang = speechLang().slice(0, 2)) {
  const key = nearAiKey();
  if (!key) throw new Error("Add your NEAR AI key first.");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  const done = new Promise((res) => (rec.onstop = res));
  rec.start();
  await new Promise((res) => setTimeout(res, seconds * 1000));
  rec.stop();
  await done;
  stream.getTracks().forEach((t) => t.stop());
  const form = new FormData();
  form.append("file", new Blob(chunks, { type: rec.mimeType || "audio/webm" }), "voice.webm");
  form.append("model", "openai/whisper-large-v3");
  form.append("language", lang);
  const r = await fetch(`${BASE}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
  if (!r.ok) throw new Error(r.status === 401 ? "NEAR AI didn’t accept the key." : r.status === 402 ? "Your NEAR AI balance is empty." : `Whisper answered ${r.status}.`);
  return ((await r.json()).text as string) ?? "";
}
