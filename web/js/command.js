// Owner commands by text or voice: trades, tasks, settings. Mirrors pilot/agent_llm.py and pilot/tasks.py.
// With the Pilot backend, messages go to the NEAR AI agent first; this parser is the offline fallback,
// and its checks run on whatever the model returns.

const ASSETS = { btc: "BTC", bitcoin: "BTC", "биткоин": "BTC", eth: "ETH", ether: "ETH", "эфир": "ETH", sol: "SOL", solana: "SOL", near: "NEAR", gold: "XAUT", xaut: "XAUT", "золото": "XAUT" };
const DAYS = { monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6, "понедельник": 0, "вторник": 1, "сред": 2, "четверг": 3, "пятниц": 4, "суббот": 5, "воскресен": 6 };
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const asset = (t) => Object.entries(ASSETS).find(([k]) => new RegExp(`(^|[^a-zа-я])${k}`).test(t))?.[1] || null;
const side = (t) => (/(^|\s)(sell|продай|продавай)/.test(t) ? "sell" : /(^|\s)(buy|купи|покупай|докупай)/.test(t) ? "buy" : null);
const num = (s, k) => parseFloat(s.replace(/[,\s]/g, "")) * (k ? 1000 : 1);

function usd(t) {
  const m = t.match(/\$\s*(\d[\d,\s]*(?:\.\d+)?)\s*(k|к)?/) || t.match(/(\d[\d,\s]*(?:\.\d+)?)\s*(k|к)?\s*(?:\$|usd|usdc|долл)/);
  return m ? num(m[1], m[2]) : null;
}

export function parseTask(text) {
  const t = text.toLowerCase();
  const a = asset(t), s = side(t), u = usd(t);
  if (!a || !s || !u) throw new Error("Need an asset, buy or sell, and a dollar amount, e.g. “if BTC below 60000 buy $500”.");
  const c = t.match(/(below|under|less than|ниже|меньше|above|over|more than|выше|больше)\s*\$?\s*(\d[\d,\s]*(?:\.\d+)?)\s*(k|к)?/);
  if (c && /(^|\s)(if|when|если|когда)(\s|$)/.test(t)) {
    const op = /^(below|under|less|ниже|меньше)/.test(c[1]) ? "<" : ">";
    return { kind: "conditional", asset: a, op, price: num(c[2], c[3]), side: s, usd: u };
  }
  if (/every|each|каждый|каждую|каждое|ежедневно|daily|weekly/.test(t)) {
    const wd = Object.entries(DAYS).find(([k]) => t.includes(k))?.[1] ?? null;
    return { kind: "recurring", asset: a, side: s, usd: u, weekday: wd };
  }
  throw new Error("Say when: “if BTC below 60000 …” or “every friday …”.");
}

export function describeTask(x) {
  if (x.kind === "conditional") return `When ${x.asset} is ${x.op === "<" ? "below" : "above"} $${x.price.toLocaleString("en-US")}: ${x.side} $${x.usd.toLocaleString("en-US")} once`;
  return `${x.side === "buy" ? "Buy" : "Sell"} $${x.usd.toLocaleString("en-US")} of ${x.asset} ${x.weekday == null ? "every day" : "every " + DAY_NAMES[x.weekday]}`;
}

// One message -> { type: "trade" | "task" | "tune" | "answer", ... }
export function route(message, { tradeOnly = false } = {}) {
  const t = message.toLowerCase().trim();
  if (!t) return { type: "answer", text: "" };
  if (!tradeOnly && /(^|\s)(if|when|every|each|если|когда|каждый|каждую|каждое|ежедневно)(\s|$)/.test(t)) {
    try { return { type: "task", task: parseTask(message) }; } catch (e) { return { type: "answer", text: e.message }; }
  }
  if (!tradeOnly && /(^|\s)(only|never|no perps|max|judge|skip|только|никогда|без|не больше)(\s|$)/.test(t) && !side(t)) {
    return { type: "tune", text: message };
  }
  const s = side(t), a = asset(t), u = usd(t);
  if (s && a && u) return { type: "trade", side: s, asset: a, usd: u };
  return { type: "answer", text: tradeOnly
    ? "Say what to buy or sell and for how much, e.g. “buy BTC for $100”."
    : "Tell me what to buy or sell and for how much, set a task (“if BTC below 60000 buy $500”, “buy $50 of ETH every friday”) or change settings (“no perps”)." };
}

// Browser speech recognition. Chrome sends audio to Google's servers; Safari uses Apple's.
export function voiceSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function listen({ lang = "en-US", onText, onEnd, onError }) {
  const R = window.SpeechRecognition || window.webkitSpeechRecognition;
  const r = new R();
  r.lang = lang;
  r.interimResults = true;
  r.maxAlternatives = 1;
  r.onresult = (e) => onText([...e.results].map((x) => x[0].transcript).join(" "), e.results[e.results.length - 1].isFinal);
  r.onerror = (e) => onError?.(e.error);
  r.onend = () => onEnd?.();
  r.start();
  return () => r.stop();
}

export function loadTasks() {
  try { return JSON.parse(localStorage.getItem("pilot.tasks") || "[]"); } catch { return []; }
}

export function saveTasks(tasks) {
  try { localStorage.setItem("pilot.tasks", JSON.stringify(tasks)); } catch { /* private mode */ }
}
