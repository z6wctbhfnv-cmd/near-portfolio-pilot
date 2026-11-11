// The owner's own NEAR AI Cloud key: the agent's model and private voice run on the owner's account and
// are billed by NEAR AI to the owner directly. Pilot takes nothing and never sees the key: it stays in
// this browser and goes only to cloud-api.near.ai (private inference in a TEE).

const BASE = "https://cloud-api.near.ai/v1";
const KEY = "pilot.nearai";

// Private: hosted by NEAR AI itself inside a TEE; nobody, NEAR AI included, can read the prompts.
// Not private: NEAR AI forwards the request to the model's maker (Anthropic, OpenAI, Google).
// Prices: USD per million tokens, input / output (cloud-api.near.ai/v1/models, Nov 2026).
export const MODELS = [
  ["z-ai/glm-5.3-flash", "GLM 5.3 Flash · $0.08 / $0.50", true],
  ["Qwen/Qwen3.8-27B", "Qwen 3.8 27B · $0.04 / $1.35", true],
  ["Qwen/Qwen3.6-35B-A3B-FP8", "Qwen 3.6 35B · $0.17 / $1.10 · strict JSON", true],
  ["deepseek-ai/DeepSeek-V4.1-Flash-1017", "DeepSeek V4.1 Flash · $0.30 / $1.20 · stronger reasoning", true],
  ["anthropic/claude-haiku-5-5", "Claude Haiku 5.5 · $0.10 / $0.50", false],
  ["google/gemini-2.5-flash-lite", "Gemini 2.5 Flash Lite · $0.10 / $0.40", false],
  ["openai/gpt-5-mini", "GPT-5 mini · $0.25 / $2.00", false],
  ["anthropic/claude-sonnet-5-5", "Claude Sonnet 5.5 · $2 / $10", false],
];

export const isPrivate = (model) => !!MODELS.find((m) => m[0] === model)?.[2];

export function settings() {
  try {
    return { key: "", model: MODELS[0][0], voice: false, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { key: "", model: MODELS[0][0], voice: false };
  }
}

export function save(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode: lives for this page only */ }
}

const SYSTEM = `You are the owner's portfolio agent in Pilot on NEAR. You cannot move money yourself.
Turn the owner's message into exactly one JSON object, nothing else:
- trade now:   {"type":"trade","side":"buy"|"sell","asset":"BTC|ETH|SOL|NEAR|XAUT","usd":number}
- a task:      {"type":"task","text":"<the task in plain English, e.g. if BTC below 60000 buy $500 / buy $50 of ETH every friday>"}
- settings:    {"type":"tune","text":"<settings in plain English, e.g. only trend-longshort; no perps; max 40% per script>"}
- otherwise:   {"type":"answer","text":"<short answer in the owner's language>"}
Never invent amounts. If the amount or asset is missing, answer with a question.
Never recommend other people's scripts. Never suggest withdrawals or transfers.
Owner context (private): `;

// One message -> the model's raw action. The caller validates it exactly like parser output.
export async function interpret(message, context) {
  const s = settings();
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.key}` },
    body: JSON.stringify({ model: s.model, temperature: 0, max_tokens: 300,
      messages: [{ role: "system", content: SYSTEM + JSON.stringify(context).slice(0, 4000) }, { role: "user", content: message.slice(0, 2000) }] }),
  });
  if (!r.ok) throw new Error(r.status === 401 ? "NEAR AI key rejected" : r.status === 402 ? "NEAR AI balance is empty" : `NEAR AI ${r.status}`);
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content || "";
  const m = text.match(/\{[\s\S]*\}/);
  try {
    const out = m ? JSON.parse(m[0]) : null;
    if (out && ["trade", "task", "tune", "answer"].includes(out.type)) return { ...out, usage: j.usage };
  } catch { /* fall through */ }
  return { type: "answer", text: text.slice(0, 500), usage: j.usage };
}

// Private voice: record in the browser, transcribe with Whisper on NEAR AI (not Google, not Apple).
export async function recordAndTranscribe(seconds = 6, lang = "en") {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream);
  const chunks = [];
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
  const r = await fetch(`${BASE}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${settings().key}` }, body: form });
  if (!r.ok) throw new Error(`Whisper ${r.status}`);
  return (await r.json()).text || "";
}

// The model list is public, so a real check needs an authenticated call: one token on a cheap model
// (a few millionths of a dollar, billed to the owner's account).
export async function checkKey(key) {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "z-ai/glm-5.3-flash", messages: [{ role: "user", content: "ok" }], max_tokens: 1 }),
  });
  return r.ok;
}
