// Owner tasks by text or voice, ported from web/js/command.js.
// - Scheduled buys ("buy $50 of ETH every friday") become real: the pilot switches to the backend's
//   `dca` strategy (PUT /v1/pilots/:id/strategy), which buys on schedule inside the signed rules.
// - Conditional tasks ("if BTC below 60000 buy $500") are saved in this browser only. In web/ they were
//   too: nothing on the backend watches prices for them yet, and the UI says so.
const ASSETS: Record<string, string> = { btc: "BTC", bitcoin: "BTC", биткоин: "BTC", биток: "BTC", eth: "ETH", ether: "ETH", эфир: "ETH", sol: "SOL", solana: "SOL", near: "NEAR", нир: "NEAR", zec: "ZEC" };
const DAYS: Record<string, number> = { monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6, понедельник: 0, вторник: 1, сред: 2, четверг: 3, пятниц: 4, суббот: 5, воскресен: 6 };
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const asset = (t: string) => Object.entries(ASSETS).find(([k]) => new RegExp(`(^|[^a-zа-я])${k}`, "u").test(t))?.[1] ?? null;
const side = (t: string) => (/(^|\s)(sell|продай|продавай)/u.test(t) ? "sell" : /(^|\s)(buy|купи|покупай|докупай)/u.test(t) ? "buy" : null);
const num = (s: string, k?: string) => parseFloat(s.replace(/[,\s]/g, "")) * (k ? 1000 : 1);

function usd(t: string) {
  const m = t.match(/\$\s*(\d[\d,\s]*(?:\.\d+)?)\s*(k|к)?/u) ?? t.match(/(\d[\d,\s]*(?:\.\d+)?)\s*(k|к)?\s*(?:\$|usd|usdc|долл|бакс)/u);
  return m ? num(m[1], m[2]) : null;
}

export type Task =
  | { kind: "conditional"; asset: string; op: "<" | ">"; price: number; side: "buy" | "sell"; usd: number; id?: number }
  | { kind: "recurring"; asset: string; side: "buy" | "sell"; usd: number; weekday: number | null; everyDays: number; id?: number };

export function parseTask(text: string): Task {
  const t = text.toLowerCase();
  const a = asset(t), s = side(t), u = usd(t);
  if (!a || !s || !u) throw new Error("Say the coin, buy or sell, and a dollar amount, e.g. “if BTC below 60000 buy $500” or “buy $50 of ETH every friday”.");
  const c = t.match(/(below|under|less than|ниже|меньше|above|over|more than|выше|больше)\s*\$?\s*(\d[\d,\s]*(?:\.\d+)?)\s*(k|к)?/u);
  if (c && /(^|\s)(if|when|если|когда)(\s|$)/u.test(t)) {
    return { kind: "conditional", asset: a, op: /^(below|under|less|ниже|меньше)/u.test(c[1]) ? "<" : ">", price: num(c[2], c[3]), side: s, usd: u };
  }
  if (/every|each|каждый|каждую|каждое|ежедневно|daily|weekly|monthly|ежемесячно|еженедельно/u.test(t)) {
    const wd = Object.entries(DAYS).find(([k]) => t.includes(k))?.[1] ?? null;
    const everyDays = /day|daily|ежедневно|каждый день/u.test(t) && wd === null ? 1 : /month|ежемесячно|месяц/u.test(t) ? 30 : 7;
    return { kind: "recurring", asset: a, side: s, usd: u, weekday: wd, everyDays };
  }
  throw new Error("Say when: “if BTC below 60000 …” or “… every friday”.");
}

export function describeTask(x: Task) {
  const amt = `$${x.usd.toLocaleString("en-US")}`;
  if (x.kind === "conditional") return `When ${x.asset} is ${x.op === "<" ? "below" : "above"} $${x.price.toLocaleString("en-US")}: ${x.side} ${amt} once`;
  const when = x.everyDays === 1 ? "every day" : x.everyDays === 30 ? "every month" : x.weekday == null ? "every week" : `every ${DAY_NAMES[x.weekday]}`;
  return `${x.side === "buy" ? "Buy" : "Sell"} ${amt} of ${x.asset} ${when}`;
}

/** The dca strategy params for a recurring buy. The backend's dca only buys, and it has no weekday: it counts days. */
export function dcaParams(x: Extract<Task, { kind: "recurring" }>) {
  return { buy: { [x.asset]: 1 }, amount_usd: x.usd, every_days: x.everyDays };
}

const KEY = "dolya.tasks";
export function loadTasks(): Task[] { try { return JSON.parse(localStorage.getItem(KEY) ?? "[]"); } catch { return []; } }
export function saveTasks(t: Task[]) { try { localStorage.setItem(KEY, JSON.stringify(t)); } catch { /* blocked */ } }
