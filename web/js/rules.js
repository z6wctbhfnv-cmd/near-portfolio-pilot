// Plain-words rules -> mandate + Agent API policy. Port of pilot/rules.py (kept in sync by tests).
// In the product a NEAR AI model drafts the rules; this parser validates what the owner signs.
import { defaultPolicy, toAgentApi, fmt } from "./policy.js";

const PCT = String.raw`(\d{1,3}(?:[.,]\d+)?)\s*%`;
const MONEY = String.raw`\$?\s*(\d[\d,\s]*(?:\.\d+)?)\s*(k)?\s*(?:usd|usdc|\$|dollars?)?`;
const ACCOUNT = String.raw`([a-z0-9_\-]+(?:\.[a-z0-9_\-]+)*\.(?:near|tg)|0x[a-f0-9]{40}|[a-f0-9]{64})`;
const STABLE = String.raw`(?:stable(?:coin)?s?|usdc|usdt|cash|стейбл\S*|кэш)`;
const GOLD = String.raw`(?:gold|xaut|paxg|золот\S*)`;
const CRYPTO = String.raw`(?:crypto|btc|bitcoin|eth|ether\S*|sol|solana|крипт\S*)`;

const num = (s) => Number(s.replace(",", ".").replace(/\s/g, ""));
const money = (m) => Number(m[1].replace(/[,\s]/g, "")) * (m[2] ? 1000 : 1);

function weight(text, asset) {
  for (const pat of [`${PCT}\\s*(?:in|into|to|of|on|в|на)?\\s*(?:the\\s+)?${asset}`, `${asset}\\s*[:\\-–]?\\s*${PCT}`]) {
    const m = text.match(new RegExp(pat, "u"));
    if (m) return num(m[1]) / 100;
  }
  return null;
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
  const w = { stable: weight(t, STABLE), gold: weight(t, GOLD), crypto: weight(t, CRYPTO) };
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

  const r4 = (x) => Math.round(x * 1e4) / 1e4;
  const mandate = { stable_weight: r4(w.stable), gold_weight: r4(w.gold), crypto_weight: r4(1 - r4(w.stable) - r4(w.gold)), max_drawdown: dd };
  const policy = defaultPolicy({ actions, perTransactionUsd: perTx, dailyUsd: daily, destinations });
  const summary = [
    `${pct(mandate.stable_weight)} in stablecoins earning vault yield`,
    `${pct(mandate.gold_weight)} in gold (XAUT)`,
    `${pct(mandate.crypto_weight)} in crypto, managed by strategy scripts`,
    `If the portfolio falls ${pct(dd)} from its peak: sell everything to USDC and freeze until you resume`,
    `At most $${fmt(perTx)} per swap and $${fmt(daily)} of swaps per day`,
    destinations.length ? `Withdrawals only to ${destinations.join(", ")}` : "The agent can only swap: no transfers or withdrawals",
    "You can freeze the agent at any moment; freezing is never delayed",
  ];
  return { mandate, policy, apiPolicy: toAgentApi(policy), summary, warnings };
}

function pct(x) {
  return `${Math.round(x * 100)}%`;
}
