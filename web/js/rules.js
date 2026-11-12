// Plain-words rules -> mandate + Agent API policy. Port of pilot/rules.py (kept in sync by tests).
// In the product a NEAR AI model drafts the rules; this parser validates what the owner signs.
import { defaultPolicy, toAgentApi, fmt } from "./policy.js";

const PCT = String.raw`(\d{1,3}(?:[.,]\d+)?)\s*%`;
const MONEY = String.raw`\$?\s*(\d[\d,\s]*(?:\.\d+)?)\s*(k)?\s*(?:usd|usdc|\$|dollars?)?`;
const ACCOUNT = String.raw`([a-z0-9_\-]+(?:\.[a-z0-9_\-]+)*\.(?:near|tg)|0x[a-f0-9]{40}|[a-f0-9]{64})`;
const STABLE = String.raw`(?:stable(?:coin)?s?|usdc|usdt|cash|стейбл\S*|кэш)`;
const GOLD = String.raw`(?:gold|xaut|paxg|золот\S*)`;
const CRYPTO_ALL = String.raw`(?:crypto|крипт\S*)`;
// Single coins count towards the crypto part: "40% NEAR, 30% BTC" is 70% crypto.
const CRYPTO_COINS = String.raw`(?:btc|bitcoin|eth|ether\S*|sol|solana|near)`;

const num = (s) => Number(s.replace(",", ".").replace(/\s/g, ""));
const money = (m) => Number(m[1].replace(/[,\s]/g, "")) * (m[2] ? 1000 : 1);

function weight(text, asset) {
  for (const pat of [`${PCT}\\s*(?:in|into|to|of|on|в|на)?\\s*(?:the\\s+)?${asset}`, `${asset}\\s*[:\\-–]?\\s*${PCT}`]) {
    const m = text.match(new RegExp(pat, "u"));
    if (m) return num(m[1]) / 100;
  }
  return null;
}

// Every "<n>% <asset>" / "<asset> <n>%" mention, each number counted once (by its position).
function weights(text, asset) {
  const found = new Map();
  for (const pat of [`${PCT}\\s*(?:in|into|to|of|on|в|на)?\\s*(?:the\\s+)?${asset}`, `${asset}\\s*[:\\-–]?\\s*${PCT}`]) {
    for (const m of text.matchAll(new RegExp(pat, "gu"))) found.set(m.index + m[0].indexOf(m[1]), num(m[1]) / 100);
  }
  return [...found.values()];
}

const first = (t, ...pats) => {
  for (const p of pats) {
    const m = t.match(new RegExp(p, "u"));
    if (m) return m;
  }
  return null;
};

export function compileRules(text, portfolioUsd = 10_000) {
  const t = text.toLowerCase();
  const warnings = [];
  // "40% crypto" wins; otherwise single coins are added up ("40% NEAR, 30% BTC" -> 70% crypto).
  let crypto = weight(t, CRYPTO_ALL);
  if (crypto === null) {
    const coins = weights(t, CRYPTO_COINS);
    if (coins.length) crypto = coins.reduce((a, b) => a + b, 0);
    if (coins.length > 1) warnings.push(`the coins you listed add up to ${pct(crypto)} crypto; how it is split between them is up to the strategy scripts.`);
  }
  const w = { stable: weight(t, STABLE), gold: weight(t, GOLD), crypto };
  const given = Object.values(w).filter((v) => v !== null).reduce((a, b) => a + b, 0);
  if (given > 1 + 1e-9) throw new Error(`weights add up to ${Math.round(given * 100)}%, more than 100%`);
  const missing = Object.keys(w).filter((k) => w[k] === null);
  const rest = 1 - given;
  if (missing.length) {
    const target = missing.includes("stable") ? "stable" : missing[0];
    for (const k of missing) w[k] = 0;
    w[target] = rest;
    if (rest > 1e-9) warnings.push(`${pct(rest)} not assigned in your rules was put into ${target === "stable" ? "stablecoins" : target}.`);
  } else if (Math.abs(rest) > 1e-9) {
    w.stable += rest;
    warnings.push(`weights added up to ${pct(1 - rest)}; the remaining ${pct(rest)} goes to stablecoins.`);
  }

  let dd = 0.1;
  const ddm = first(t, `(?:drawdown|draw-down|loss|lose|просадк\\S*|убыт\\S*)[^\\d%]{0,30}${PCT}`, `${PCT}[^\\d%]{0,20}(?:drawdown|loss|просадк\\S*)`);
  if (ddm) dd = num(ddm[1]) / 100;
  else warnings.push("no drawdown limit found: using 10%.");
  if (dd < 0.02 || dd > 0.5) throw new Error("drawdown limit must be between 2% and 50%");
  // "never below 90% of the peak" / "от максимума" / "ever" -> one floor from the all-time peak.
  const ddMode = /(?:all[- ]time|\bever\b|never (?:lose|fall|drop)|from (?:the )?(?:all-time )?peak|от максимума|никогда не (?:теря|пада|опуска))/.test(t) ? "from_peak" : "episode";

  const dm = first(t, `${MONEY}\\s*(?:per day|a day|daily|/day|в день|за день)`, `(?:daily|per day|в день)[^\\d$]{0,25}${MONEY}`);
  let daily = dm ? money(dm) : null;
  const pm = first(t, `${MONEY}\\s*(?:per (?:trade|transaction|swap)|за сделку)`, `(?:per (?:trade|transaction|swap)|за сделку)[^\\d$]{0,25}${MONEY}`);
  let perTx = pm ? money(pm) : null;

  const destinations = [];
  const actions = ["swap"];
  const wm = first(t, `(?:withdraw|send|вывод\\S*)[^.]{0,40}?only\\s+to\\s+${ACCOUNT}`, `(?:только\\s+на)\\s+${ACCOUNT}`);
  if (wm) {
    destinations.push(wm[1]);
    actions.push("withdraw");
  } else if (!/never send|no withdraw|nothing (?:leaves|out)|никуда не выводить|не выводить/u.test(t)) {
    warnings.push("no withdrawal rule found: the agent can only swap, nothing can leave the wallet.");
  }

  // The daily budget also counts emergency sells, so it must cover a full exit (see docs/SIM_FINDINGS.md).
  if (daily === null) daily = Math.round(portfolioUsd * 1.2 * 100) / 100;
  else if (daily < portfolioUsd)
    warnings.push(`daily budget $${fmt(daily)} is below the portfolio value $${fmt(portfolioUsd)}: in a crash the drawdown stop could not sell everything in one day.`);
  if (perTx === null) perTx = Math.round(Math.max(100, Math.min(daily, portfolioUsd * 0.1)) * 100) / 100;

  // Nothing recognised at all: refuse rather than sign a policy the owner never wrote.
  const understood = given > 0 || ddm || dm || pm || wm || /never send|no withdraw|nothing (?:leaves|out)|никуда не выводить|не выводить/u.test(t);
  if (!understood) throw new Error("couldn't find any rule in this text. Try: “40% crypto, max drawdown 10%, $500 a day”");

  const r4 = (x) => Math.round(x * 1e4) / 1e4;
  const mandate = { stable_weight: r4(w.stable), gold_weight: r4(w.gold), crypto_weight: r4(1 - r4(w.stable) - r4(w.gold)), max_drawdown: dd, drawdown_mode: ddMode };
  const policy = defaultPolicy({ actions, perTransactionUsd: perTx, dailyUsd: daily, destinations });
  const summary = [
    `${pct(mandate.stable_weight)} in stablecoins earning vault yield`,
    `${pct(mandate.gold_weight)} in gold (XAUT)`,
    `${pct(mandate.crypto_weight)} in crypto, managed by strategy scripts`,
    ddMode === "from_peak"
      ? `Never below ${pct(1 - dd)} of the all-time peak: at the floor sell everything to USDC and freeze; after you resume, risk shrinks with the buffer left`
      : `If the portfolio falls ${pct(dd)} from its peak: sell everything to USDC and freeze until you resume; the limit restarts after each resume`,
    `At most $${fmt(perTx)} per swap and $${fmt(daily)} of swaps per day`,
    destinations.length ? `Withdrawals only to ${destinations.join(", ")}` : "The agent can only swap: no transfers or withdrawals",
    "You can freeze the agent at any moment; freezing is never delayed",
  ];
  return { mandate, policy, apiPolicy: toAgentApi(policy), summary, warnings };
}

function pct(x) {
  return `${Math.round(x * 100)}%`;
}

// Your own limits, added in words through the agent. The NEAR Intents policy only knows budgets and
// destinations, so these are checked by your agent before every action and signed along with the policy.

const ASSET_RE = String.raw`(btc|bitcoin|eth|ether\S*|sol\S*|near|xaut|gold|золот\S*|usdc|usdt)`;
const canon = (a) => ({ bitcoin: "BTC", gold: "XAUT" }[a] || (/^ether/.test(a) ? "ETH" : /^sol/.test(a) ? "SOL" : /^золот/.test(a) ? "XAUT" : a.toUpperCase()));
const assetsIn = (t) => [...new Set([...t.matchAll(new RegExp(ASSET_RE, "gu"))].map((m) => canon(m[1])))];

export function parseCustomRule(text) {
  const t = text.toLowerCase().trim();
  let m;
  if (!t) throw new Error("write a limit first");
  if ((m = t.match(new RegExp(`${PCT}[^\\d]{0,30}(?:one|any|single|одн\\S*|любой)\\s*(?:asset|coin|token|актив\\S*|монет\\S*)`, "u"))) ||
      (m = t.match(new RegExp(`(?:one|any|single|одн\\S*|любой)\\s*(?:asset|coin|token|актив\\S*|монет\\S*)[^\\d]{0,30}${PCT}`, "u"))))
    return { kind: "max_asset_share", value: num(m[1]) / 100, label: `At most ${m[1]}% of the portfolio in any one asset` };
  if ((m = t.match(new RegExp(`(?:leverage|плеч\\S*)[^\\d]{0,20}(\\d+(?:[.,]\\d+)?)\\s*x`, "u"))) || (m = t.match(/(\d+(?:[.,]\d+)?)\s*x\s*(?:leverage|плеч)/u)))
    return { kind: "max_leverage", value: num(m[1]), label: `Perps leverage at most ${m[1]}x` };
  if ((m = t.match(/(\d+)\s*(?:trades?|actions?|сдел\S*|действ\S*)\s*(?:a|per|в|за)\s*(day|hour|день|час)/u)))
    return { kind: /hour|час/.test(m[2]) ? "max_actions_hour" : "max_trades_day", value: Number(m[1]), label: `At most ${m[1]} trades per ${/hour|час/.test(m[2]) ? "hour" : "day"}` };
  if ((m = t.match(new RegExp(`(?:keep|at least|не меньше|минимум|держ\\S*)[^\\d$]{0,20}${PCT}[^.]{0,20}${STABLE}`, "u"))))
    return { kind: "min_stable_share", value: num(m[1]) / 100, label: `Keep at least ${m[1]}% in stablecoins` };
  if ((m = t.match(new RegExp(`(?:down|lose|loses|потер\\S*|минус|упад\\S*)[^\\d]{0,15}${PCT}[^.]{0,20}(?:a day|in a day|today|за день|в день)`, "u"))))
    return { kind: "daily_loss_stop", value: num(m[1]) / 100, label: `Stop trading for the day after a ${m[1]}% loss that day` };
  if ((m = t.match(new RegExp(`${ASSET_RE}[^\\d]{0,25}(?:drops?|falls?|падает|упад\\S*)[^\\d]{0,10}${PCT}`, "u"))))
    return { kind: "pause_on_drop", asset: canon(m[1]), value: num(m[2]) / 100, label: `Pause all scripts if ${canon(m[1])} falls ${m[2]}% in a day` };
  const found = assetsIn(t);
  if (found.length && /\b(?:only|just)\b|только/.test(t))
    return { kind: "allowed_assets", value: found, label: `Trade only ${found.join(", ")}` };
  if (found.length && /\b(?:never|no|don'?t|ban|avoid|without)\b|никогда|не (?:покупай|бери|торгуй)|без /.test(t))
    return { kind: "banned_assets", value: found, label: `Never buy ${found.join(", ")}` };
  throw new Error("couldn't turn this into a limit. Try: “max 30% in one asset”, “5 trades a day”, “never buy SOL”, “stop for the day if down 3%”");
}

export function checkCustom(rules, { asset, shareAfter = 0, tradesToday = 0, actionsHour = 0, leverage = 0, stableAfter = 1, lossToday = 0 }) {
  for (const r of rules) {
    const bad = {
      max_asset_share: shareAfter > r.value, max_leverage: leverage > r.value, max_trades_day: tradesToday >= r.value,
      max_actions_hour: actionsHour >= r.value, min_stable_share: stableAfter < r.value, daily_loss_stop: lossToday >= r.value,
      allowed_assets: asset && asset !== "USDC" && !r.value.includes(asset), banned_assets: asset && r.value.includes(asset),
    }[r.kind];
    if (bad) return { ok: false, rule: r.label };
  }
  return { ok: true };
}

