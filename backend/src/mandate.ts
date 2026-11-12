/**
 * The owner's mandate: "how my money should be managed", in plain words → a structured mandate →
 * an Agent API policy the owner signs, plus the strategy that runs inside it.
 *
 * The policy is deliberately narrow: swaps only (no transfer, no withdraw), so even a fully
 * compromised backend cannot move funds out of the owner's agent account.
 */
import type { Policy } from "@near-intents-agent-api/sdk";
import { z } from "zod";
import type { NearAiClient } from "./nearai.js";
import { parseStrategyParams, STRATEGY_IDS, type StrategyId } from "./strategies.js";
import { DEFAULT_UNIVERSE, type TokenInfo, usdToAtomic } from "./tokens.js";

const RISK_SYMBOLS = DEFAULT_UNIVERSE.filter((a) => !a.stable).map((a) => a.symbol) as [string, ...string[]];
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export const MandateSchema = z.object({
  risk: z.enum(["low", "medium", "high"]).default("medium"),
  assets: z.array(z.enum(RISK_SYMBOLS)).min(1).max(5).default(["NEAR", "BTC", "ETH"]),
  stable: z.enum(["USDC", "USDT"]).default("USDC"),
  budget: z
    .object({
      daily_usd: z.number().positive().max(1_000_000).nullable().default(100),
      weekly_usd: z.number().positive().max(1_000_000).nullable().default(null),
      monthly_usd: z.number().positive().max(10_000_000).nullable().default(null),
    })
    .prefault({}),
  max_trade_usd: z.number().min(1).max(1_000_000).default(50),
  max_actions_per_hour: z.number().int().min(1).max(100).default(6),
  owner_approval: z.boolean().default(false),
  timelock_minutes: z.number().int().min(0).max(60 * 24 * 30).default(0),
  schedule: z
    .object({
      time_zone: z.string().min(1).default("UTC"),
      days: z.array(z.enum(DAYS)).min(1),
      start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      end: z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/),
    })
    .nullable()
    .default(null),
  strategy: z
    .object({ id: z.enum(STRATEGY_IDS as [StrategyId, ...StrategyId[]]), params: z.record(z.string(), z.unknown()).default({}) })
    .nullable()
    .default(null),
});
export type Mandate = z.infer<typeof MandateSchema>;

const ASSET_WORDS: Array<[string, RegExp]> = [
  ["NEAR", /\bnear\b|\bнир\b|\bнеар\b/i],
  ["BTC", /\bbtc\b|bitcoin|биткоин|биток|\bбтк\b/i],
  ["ETH", /\beth\b|ethereum|ether\b|эфир|\bэth\b/i],
  ["SOL", /\bsol\b|solana|солан/i],
  ["ZEC", /\bzec\b|zcash|зкеш|зкэш/i],
];

const MONEY = String.raw`\$?\s*(\d+(?:[.,]\d+)?)\s*(?:\$|usd|долл\w*|бакс\w*)?`;

function money(text: string, after: RegExp): number | null {
  const m = text.match(new RegExp(`${MONEY}\\s*(?:${after.source})`, "i"));
  return m ? Number(m[1]!.replace(",", ".")) : null;
}

/**
 * Deterministic fallback parser (English and Russian keywords). It never invents numbers: anything
 * it cannot find keeps the schema's safe default, and every guess is listed in `notes`.
 */
export function parseMandateRules(text: string): { mandate: Mandate; notes: string[] } {
  const t = text.toLowerCase();
  const notes: string[] = [];
  const raw: Record<string, unknown> = {};

  if (/conservative|careful|safe|low risk|осторожн|консерват|без риска|низк\w* риск|надёжн|надежн/.test(t)) raw.risk = "low";
  else if (/aggressive|high risk|risky|агрессив|рискованн|высок\w* риск|максимальн/.test(t)) raw.risk = "high";
  else notes.push("risk level not stated: medium");

  const assets = ASSET_WORDS.filter(([, re]) => re.test(text)).map(([s]) => s);
  if (assets.length) raw.assets = assets;
  else notes.push("no assets named: NEAR, BTC, ETH");

  if (/usdt|tether|тезер/.test(t)) raw.stable = "USDT";

  const daily = money(t, /(?:a|per|\/)\s*day|daily|в день|в сутки|за день|ежедневно/);
  const weekly = money(t, /(?:a|per|\/)\s*week|weekly|в неделю|за неделю/);
  const monthly = money(t, /(?:a|per|\/)\s*month|monthly|в месяц|за месяц/);
  const perTrade = money(t, /(?:a|per)\s*(?:trade|swap|order)|за сделку|за раз|на сделку|за одну сделку/);
  raw.budget = { daily_usd: daily ?? 100, weekly_usd: weekly, monthly_usd: monthly };
  if (daily === null) notes.push("no daily budget stated: 100 USD a day");
  if (perTrade !== null) raw.max_trade_usd = perTrade;
  else notes.push("no per-trade cap stated: 50 USD");

  if (/approv|confirm|ask me|подтвержд|спрашива|с моего согласия|согласу/.test(t)) raw.owner_approval = true;
  if (/weekdays|business days|будн|рабочие дни/.test(t)) {
    raw.schedule = { time_zone: "UTC", days: ["mon", "tue", "wed", "thu", "fri"], start: "00:00", end: "24:00" };
  }

  // "40% NEAR", "NEAR 40%", "40% в NEAR"
  const weights: Record<string, number> = {};
  for (const [sym, re] of ASSET_WORDS) {
    const name = re.source;
    const a = t.match(new RegExp(`(\\d{1,3})\\s*%\\s*(?:in|into|в|на)?\\s*(?:${name})`, "i"));
    const b = t.match(new RegExp(`(?:${name})\\s*[-—:=]?\\s*(\\d{1,3})\\s*%`, "i"));
    const pct = Number((a ?? b)?.[1]);
    if (pct > 0 && pct <= 100) weights[sym] = pct / 100;
  }

  const dcaAmount = money(t, /(?:a|per|every|each)\s*week|еженедельно|каждую неделю|в неделю/);
  const wantsDca = /\bdca\b|dollar.?cost|усредн|каждую неделю покупа|buy every|докупа/.test(t);
  if (wantsDca) {
    const buyAssets = (raw.assets as string[] | undefined) ?? ["NEAR", "BTC", "ETH"];
    raw.strategy = {
      id: "dca",
      params: {
        buy: Object.fromEntries(buyAssets.map((s) => [s, 1 / buyAssets.length])),
        amount_usd: dcaAmount ?? 20,
        every_days: /every day|каждый день|ежедневно/.test(t) ? 1 : 7,
      },
    };
  } else if (Object.keys(weights).length) {
    raw.strategy = { id: "rebalance", params: { weights } };
    raw.assets = Object.keys(weights);
  }

  const mandate = MandateSchema.parse(raw);
  return { mandate, notes };
}

const RISK_SHARE = { low: 0.3, medium: 0.6, high: 0.9 } as const;

/** The strategy a mandate runs: its explicit choice, or a default for its risk level. */
export function strategyForMandate(m: Mandate): { id: StrategyId; params: Record<string, unknown> } {
  const base = { stable: m.stable, min_trade_usd: Math.min(5, m.max_trade_usd) };
  if (m.strategy) {
    const params = { ...base, ...m.strategy.params };
    return { id: m.strategy.id, params: parseStrategyParams(m.strategy.id, params) };
  }
  const share = RISK_SHARE[m.risk];
  const weights = Object.fromEntries(m.assets.map((s) => [s, Number((share / m.assets.length).toFixed(6))]));
  if (m.risk === "low") return { id: "rebalance", params: parseStrategyParams("rebalance", { ...base, weights, band: 0.05 }) };
  if (m.risk === "medium") return { id: "trend", params: parseStrategyParams("trend", { ...base, weights, sma_days: 50, off_fraction: 0.25 }) };
  return { id: "vol_target", params: parseStrategyParams("vol_target", { ...base, weights, target_vol: 0.6, lookback: 30 }) };
}

/**
 * Compile a mandate into the complete Agent API policy. Per-asset limits are a second fence
 * behind the USD budget: twice the USD caps at today's price, so normal price moves do not trip
 * them but a runaway agent still stops.
 */
export function compilePolicy(m: Mandate, tokens: TokenInfo[]): { policy: Policy; warnings: string[] } {
  const warnings: string[] = [];
  const symbols = [...new Set([...m.assets, m.stable])];
  const assetIds: string[] = [];
  const perTx: Record<string, string> = {};
  const daily: Record<string, string> = {};
  for (const sym of symbols) {
    const u = DEFAULT_UNIVERSE.find((a) => a.symbol === sym);
    if (!u) throw new Error(`asset ${sym} is not in the universe`);
    assetIds.push(u.asset_id);
    const token = tokens.find((t) => t.asset_id === u.asset_id);
    if (!token) {
      warnings.push(`${sym} (${u.asset_id}) is not in the token list right now; no per-asset limit set`);
      continue;
    }
    if (!token.price || token.price <= 0) {
      warnings.push(`${sym} has no current price; no per-asset limit set`);
      continue;
    }
    perTx[u.asset_id] = usdToAtomic(m.max_trade_usd * 2, token.price, token.decimals).toString();
    if (m.budget.daily_usd) daily[u.asset_id] = usdToAtomic(m.budget.daily_usd * 2, token.price, token.decimals).toString();
  }
  const usd = (v: number | null) => (v === null ? null : v.toFixed(2));
  const policy: Policy = {
    frozen: false,
    actions: ["swap"],
    confidential: false,
    owner_approval: m.owner_approval,
    assets: assetIds,
    limits: {
      ...(Object.keys(perTx).length ? { per_transaction: perTx } : {}),
      ...(Object.keys(daily).length ? { daily } : {}),
    },
    max_actions_per_hour: m.max_actions_per_hour,
    destinations: { mode: "only", list: [] },
    budget: { daily_usd: usd(m.budget.daily_usd), weekly_usd: usd(m.budget.weekly_usd), monthly_usd: usd(m.budget.monthly_usd) },
    timelock_ms: m.timelock_minutes * 60_000,
    ...(m.schedule
      ? { schedule: { mode: "only", time_zone: m.schedule.time_zone, windows: [{ days: m.schedule.days, start: m.schedule.start, end: m.schedule.end }] } }
      : {}),
  } as Policy;
  if (!m.budget.daily_usd && !m.budget.weekly_usd && !m.budget.monthly_usd) warnings.push("no USD budget: spending is capped only by per-asset limits");
  if (m.max_trade_usd > (m.budget.daily_usd ?? Infinity)) warnings.push("max trade is larger than the daily budget");
  return { policy, warnings };
}

const SYSTEM_PROMPT = `You turn an investor's plain-language instructions (any language) into a JSON mandate for an automated crypto portfolio on NEAR Intents.
Return ONLY one JSON object with these optional fields:
{"risk":"low"|"medium"|"high",
 "assets":[subset of ${JSON.stringify(RISK_SYMBOLS)}],
 "stable":"USDC"|"USDT",
 "budget":{"daily_usd":number|null,"weekly_usd":number|null,"monthly_usd":number|null},
 "max_trade_usd":number,
 "max_actions_per_hour":integer,
 "owner_approval":boolean,
 "timelock_minutes":integer,
 "schedule":null|{"time_zone":"IANA zone","days":["mon".."sun"],"start":"HH:MM","end":"HH:MM"},
 "strategy":null|{"id":"rebalance"|"trend"|"vol_target"|"dca","params":{...}}}
Strategy params: rebalance {"weights":{"NEAR":0.4,...}} (weights 0..1, sum <= 1, rest stays in the stablecoin); trend {"weights",...,"sma_days"}; vol_target {"weights","target_vol"}; dca {"buy":{"NEAR":1},"amount_usd","every_days"}.
Rules: never invent amounts the user did not give; omit a field instead. Only use the listed assets. No prose, no comments.`;

/** Plain words → mandate. Uses NEAR AI when configured, otherwise (or on any failure) the rule parser. */
export async function parseMandate(text: string, ai?: NearAiClient) {
  const rules = parseMandateRules(text);
  if (!ai?.configured) return { ...rules, source: "rules" as const };
  try {
    const answer = await ai.chatJson([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text.slice(0, 4000) },
    ]);
    // The AI overrides only the fields it actually stated; everything else comes from the rules.
    // Models often write null for "not stated" instead of omitting the field, so null counts as unstated.
    const known = Object.keys(MandateSchema.shape);
    const stated =
      answer && typeof answer === "object" && !Array.isArray(answer)
        ? Object.fromEntries(Object.entries(answer as Record<string, unknown>).filter(([k, v]) => known.includes(k) && v !== undefined && v !== null))
        : {};
    if (!Object.keys(stated).length) {
      return { ...rules, source: "rules" as const, notes: [...rules.notes, "AI answer rejected: no mandate fields"] };
    }
    const parsed = MandateSchema.safeParse({ ...rules.mandate, ...stated });
    if (!parsed.success) {
      return { ...rules, source: "rules" as const, notes: [...rules.notes, `AI answer rejected: ${parsed.error.issues[0]?.message ?? "invalid"}`] };
    }
    // Validate the AI's strategy params against the real schema; drop them if they don't fit.
    const notes: string[] = [];
    if (parsed.data.strategy) {
      try {
        strategyForMandate(parsed.data);
      } catch (e) {
        notes.push(`AI strategy dropped: ${(e as Error).message}`);
        parsed.data.strategy = null;
      }
    }
    return { mandate: parsed.data, notes, source: "ai" as const, model: ai.model };
  } catch (e) {
    return { ...rules, source: "rules" as const, notes: [...rules.notes, `AI unavailable: ${(e as Error).message}`] };
  }
}
