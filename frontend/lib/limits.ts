// Presets and "limits in words". Everything that maps onto a mandate field goes into the rules the owner
// signs (the backend compiles the mandate into the Agent API policy and also checks it before every trade).
// Limits the mandate has no field for are kept in this browser and say so: nothing enforces them yet.
import type { Mandate } from "./api";

export const RISKY = ["NEAR", "BTC", "ETH", "SOL", "ZEC"] as const;

export type Preset = "careful" | "balanced" | "bold";
export const PRESETS: { id: Preset; name: string; line: string; img: string }[] = [
  { id: "careful", name: "Careful", line: "Small trades, stop at −10%", img: "shield" },
  { id: "balanced", name: "Balanced", line: "Medium trades, stop at −20%", img: "balance" },
  { id: "bold", name: "Bold", line: "Bigger trades, stop at −30%", img: "arrow" },
];

const round = (n: number) => Math.max(5, Math.round(n / 5) * 5);

/** A preset as mandate fields, scaled to the amount the pilot starts with. Weekly and monthly limits the owner wrote stay. */
export function presetPatch(p: Preset, amount: number, keep?: Mandate["budget"]): Partial<Mandate> {
  const out = presetBase(p, amount);
  return keep ? { ...out, budget: { ...out.budget!, weekly_usd: keep.weekly_usd, monthly_usd: keep.monthly_usd } } : out;
}

function presetBase(p: Preset, amount: number): Partial<Mandate> {
  const a = Math.max(100, amount);
  if (p === "careful") return { risk: "low", max_trade_usd: round(a * 0.05), budget: { daily_usd: round(a * 0.15), weekly_usd: null, monthly_usd: null }, max_actions_per_hour: 4, drawdown_stop: { enabled: true, max_drawdown: 0.1 } };
  if (p === "balanced") return { risk: "medium", max_trade_usd: round(a * 0.1), budget: { daily_usd: round(a * 0.3), weekly_usd: null, monthly_usd: null }, max_actions_per_hour: 6, drawdown_stop: { enabled: true, max_drawdown: 0.2 } };
  return { risk: "high", max_trade_usd: round(a * 0.25), budget: { daily_usd: round(a * 0.6), weekly_usd: null, monthly_usd: null }, max_actions_per_hour: 12, drawdown_stop: { enabled: true, max_drawdown: 0.3 } };
}

export function presetOf(m: Mandate): Preset | null {
  const r = m.risk, d = m.drawdown_stop?.max_drawdown;
  if (r === "low" && d === 0.1) return "careful";
  if (r === "medium" && d === 0.2) return "balanced";
  if (r === "high" && d === 0.3) return "bold";
  return null;
}

export type Limit = { label: string; enforced: boolean; patch?: Partial<Mandate> };

const PCT = String.raw`(\d{1,3}(?:[.,]\d+)?)\s*%`;
const MONEY = String.raw`(?:\$\s*(\d[\d,\s]*(?:\.\d+)?)\s*(k|к)?|(\d[\d,\s]*(?:\.\d+)?)\s*(k|к)?\s*(?:\$|usd[ct]?|dollars?|долл\S*|бакс\S*))`;
const num = (s: string) => Number(s.replace(",", ".").replace(/\s/g, ""));
const money = (m: RegExpMatchArray, i = 1) => {
  const v = m[i] ?? m[i + 2];
  const k = m[i + 1] ?? m[i + 3];
  return Number(String(v).replace(/[,\s]/g, "")) * (k ? 1000 : 1);
};
const ASSET: Record<string, string> = { near: "NEAR", нир: "NEAR", btc: "BTC", bitcoin: "BTC", биткоин: "BTC", биток: "BTC", eth: "ETH", ether: "ETH", ethereum: "ETH", эфир: "ETH", sol: "SOL", solana: "SOL", солана: "SOL", zec: "ZEC", zcash: "ZEC" };
const assetsIn = (t: string) => [...new Set(Object.entries(ASSET).filter(([k]) => new RegExp(`(^|[^a-zа-я])${k}`, "u").test(t)).map(([, v]) => v))];
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** One limit in words → a mandate change (signed) or a browser-only note. Throws when nothing is recognised. */
export function parseLimit(text: string, m: Mandate): Limit {
  const t = text.toLowerCase().trim();
  let x: RegExpMatchArray | null;
  if (!t) throw new Error("Write a limit first.");

  // money per trade / per period
  if ((x = t.match(new RegExp(`${MONEY}[^\\d]{0,12}(?:per|a|each|за|на|в)\\s*(?:trade|swap|transaction|сделк\\S*|обмен\\S*)`, "u"))) ||
      (x = t.match(new RegExp(`(?:trade|swap|сделк\\S*)[^\\d$]{0,25}${MONEY}`, "u")))) {
    const v = money(x); return { label: `Trades up to $${v.toLocaleString("en-US")}`, enforced: true, patch: { max_trade_usd: v } };
  }
  if ((x = t.match(new RegExp(`${MONEY}[^\\d]{0,10}(?:a|per|в|за)\\s*(day|week|month|день|сутки|недел\\S*|месяц)`, "u")))) {
    const v = money(x), p = x[5];
    const key = /day|день|сутки/.test(p) ? "daily_usd" : /week|недел/.test(p) ? "weekly_usd" : "monthly_usd";
    const word = key === "daily_usd" ? "a day" : key === "weekly_usd" ? "a week" : "a month";
    return { label: `Spend at most $${v.toLocaleString("en-US")} ${word}`, enforced: true, patch: { budget: { ...m.budget, [key]: v } } };
  }
  // actions per hour
  if ((x = t.match(/(\d+)\s*(?:trades?|actions?|swaps?|сдел\S*|действ\S*|обмен\S*)\s*(?:an?|per|в|за)\s*(?:hour|час)/u))) {
    const v = Math.min(100, Math.max(1, Number(x[1]))); return { label: `At most ${v} trades an hour`, enforced: true, patch: { max_actions_per_hour: v } };
  }
  // safety stop
  if (/no (?:safety )?stop|without (?:a )?stop|stop off|без стоп|выключ\S* стоп|отключ\S* стоп/u.test(t)) {
    return { label: "No safety stop", enforced: true, patch: { drawdown_stop: { enabled: false, max_drawdown: m.drawdown_stop?.max_drawdown ?? 0.2 } } };
  }
  if ((x = t.match(new RegExp(`(?:stop|drawdown|loss|lose|down|просадк\\S*|убыт\\S*|стоп|минус)[^\\d%]{0,25}${PCT}`, "u"))) && !/day|today|день|сегодня/.test(t)) {
    const v = num(x[1]) / 100;
    if (v < 0.02 || v > 0.9) throw new Error("A safety stop must be between 2% and 90%.");
    return { label: `Sell to cash at −${x[1]}% from the peak`, enforced: true, patch: { drawdown_stop: { enabled: true, max_drawdown: v } } };
  }
  // approval and delay
  if (/ask me|my (?:ok|approval)|confirm each|спрашива\S* меня|с моего (?:ок|одобрения|разрешения)/u.test(t)) {
    return { label: "Every trade waits for your approval", enforced: true, patch: { owner_approval: true } };
  }
  if ((x = t.match(/(?:wait|delay|задержк\S*|жди|подожди)[^\d]{0,15}(\d+)\s*(min|minute|hour|час|мин)/u))) {
    const v = Number(x[1]) * (/hour|час/.test(x[2]) ? 60 : 1);
    return { label: `Wait ${v} minutes before each trade`, enforced: true, patch: { timelock_minutes: Math.min(v, 60 * 24 * 30) } };
  }
  // when
  if (/weekdays|work ?days|по будням|в будни/u.test(t)) return { label: "Trade on weekdays only", enforced: true, patch: { schedule: { time_zone: "UTC", days: DAYS.slice(0, 5), start: "00:00", end: "24:00" } } };
  if (/weekends?|по выходным|в выходные/u.test(t)) return { label: "Trade on weekends only", enforced: true, patch: { schedule: { time_zone: "UTC", days: DAYS.slice(5), start: "00:00", end: "24:00" } } };

  // which assets
  const found = assetsIn(t);
  if (found.length && /\b(?:only|just)\b|только/u.test(t)) {
    return { label: `Trade only ${found.join(", ")}`, enforced: true, patch: { assets: found } };
  }
  if (found.length && /\b(?:never|no|don'?t|ban|avoid|without)\b|никогда|не (?:покупай|бери|торгуй)|без /u.test(t)) {
    const left = m.assets.filter((a) => !found.includes(a));
    if (!left.length) throw new Error("That would leave no asset to trade.");
    return { label: `Never buy ${found.join(", ")}`, enforced: true, patch: { assets: left } };
  }

  // no mandate field for these: kept here, said plainly
  if ((x = t.match(new RegExp(`${PCT}[^\\d]{0,30}(?:one|any|single|одн\\S*|любой)\\s*(?:asset|coin|token|актив\\S*|монет\\S*)`, "u"))) ||
      (x = t.match(new RegExp(`(?:one|any|single|одн\\S*|любой)\\s*(?:asset|coin|token|актив\\S*|монет\\S*)[^\\d]{0,30}${PCT}`, "u")))) {
    return { label: `At most ${x[1]}% in any one asset`, enforced: false };
  }
  if ((x = t.match(new RegExp(`(?:keep|at least|не меньше|минимум|держ\\S*)[^\\d$]{0,20}${PCT}[^.]{0,20}(?:stable|usdc|cash|стейбл|кэш)`, "u")))) {
    return { label: `Keep at least ${x[1]}% in stablecoins`, enforced: false };
  }
  if ((x = t.match(/(?:leverage|плеч\S*)[^\d]{0,20}(\d+(?:[.,]\d+)?)\s*x/u))) return { label: `Leverage at most ${x[1]}x`, enforced: false };
  if ((x = t.match(new RegExp(`${PCT}[^.]{0,25}(?:a day|in a day|today|за день|в день)`, "u")))) return { label: `Stop for the day after a ${x[1]}% loss that day`, enforced: false };
  if ((x = t.match(/(\d+)\s*(?:trades?|сдел\S*)\s*(?:a|per|в|за)\s*(?:day|день)/u))) return { label: `At most ${x[1]} trades a day`, enforced: false };

  throw new Error("Couldn’t turn this into a limit. Try: “$50 per trade”, “$300 a week”, “only NEAR and BTC”, “never buy SOL”, “stop at 15%”, “weekdays only”.");
}

export const LIMIT_EXAMPLES = ["$50 per trade", "$300 a week", "only NEAR and BTC", "never buy SOL", "stop at 15%", "ask me before each trade", "weekdays only", "max 30% in one asset"];

/** Applies limit patches to a mandate, in order. */
export const applyLimits = (m: Mandate, limits: Limit[]) => limits.reduce((acc, l) => (l.patch ? { ...acc, ...l.patch } : acc), m);
