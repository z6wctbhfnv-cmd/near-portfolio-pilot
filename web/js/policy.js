// Owner policy checks, mirrored from pilot/policy.py and the NEAR Intents Agent API.
// The real limits are enforced by the Agent API; the browser uses this to explain and to demo.

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

export const ASSET_IDS = {
  USDC: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  BTC: "nep141:btc.omft.near",
  ETH: "nep141:eth.omft.near",
  SOL: "nep141:sol.omft.near",
  NEAR: "nep141:wrap.near",
  XAUT: "nep141:eth-0x68749665ff8d2d112fa859aa293f07a622782f38.omft.near",
  VAULT_USDC: "nep141:eth-0xaf08e292d62df255f7953665a44ed65f0380aa60.omft.near",
};

export function defaultPolicy(over = {}) {
  return {
    actions: ["swap"],
    assets: Object.keys(ASSET_IDS),
    perTransactionUsd: 1000,
    dailyUsd: 12000,
    maxActionsPerHour: 20,
    destinations: [],
    frozen: false,
    ...over,
  };
}

/** Same order of checks and the same error codes as the Agent API. */
export function check(policy, { action, assetFrom, usd, destination = null }) {
  if (policy.frozen) return refuse("wallet_frozen", "agent is frozen by the owner");
  if (!policy.actions.includes(action)) return refuse("policy_action_denied", `action '${action}' is not allowed`);
  if (destination !== null && !policy.destinations.includes(destination))
    return refuse("policy_denied", `destination '${destination}' is not in the allow-list`);
  if (!policy.assets.includes(assetFrom)) return refuse("policy_denied", `asset '${assetFrom}' is not listed`);
  if (usd > policy.perTransactionUsd + 1e-9)
    return refuse("policy_limit_exceeded", `$${fmt(usd)} > per-transaction $${fmt(policy.perTransactionUsd)}`);
  if (usd > policy.dailyUsd + 1e-9) return refuse("spend_budget_exceeded", `daily budget $${fmt(policy.dailyUsd)}`);
  return { ok: true };
}

/** The Agent API `policy` object the owner signs. */
export function toAgentApi(policy) {
  const list = policy.destinations.map((d) => ({ action: "withdraw", chain: "near", address: d, memo: null }));
  return {
    frozen: policy.frozen,
    actions: [...policy.actions],
    confidential: true,
    owner_approval: false,
    assets: policy.assets.map((a) => ASSET_IDS[a]).sort(),
    limits: {},
    max_actions_per_hour: policy.maxActionsPerHour,
    destinations: { mode: "only", list },
    budget: { daily_usd: policy.dailyUsd.toFixed(2), weekly_usd: null, monthly_usd: null },
    timelock_ms: 0,
  };
}

// --- attack demo: what a prompt-injected agent would send ---------------------------------
const ACCOUNT = /(0x[a-fA-F0-9]{6,40}|[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.(?:near|tg)|[A-HJ-NP-Za-km-z1-9]{32,44})/;
// An amount needs a "$" before it or a currency after it, so digits inside an address never count.
const AMOUNT = /\$\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(?:usd|usdc|dollars?)\b/i;

export function interpret(instruction) {
  const t = instruction.trim();
  const low = t.toLowerCase();
  const dest = t.match(ACCOUNT);
  const amt = t.match(AMOUNT);
  const usd = amt ? Number((amt[1] ?? amt[2]).replaceAll(",", "")) : null;
  if (/\b(send|transfer|withdraw|move|drain|pay)\b/.test(low) && dest) {
    const action = /\.(near|tg)$/.test(dest[1]) ? "transfer" : "withdraw";
    return { action, asset: "USDC", usd: usd ?? 10_000, destination: dest[1] };
  }
  const m = low.match(/\b(buy|swap|sell)\b.*?\b(btc|eth|sol|near|xaut|usdc|pepe|[a-z]{3,6})\b/);
  if (m) {
    const asset = m[2].toUpperCase();
    const selling = m[1] === "sell";
    return { action: "swap", assetFrom: selling ? asset : "USDC", assetTo: selling ? "USDC" : asset, usd: usd ?? 500 };
  }
  return { action: "none", note: "no money movement in this instruction" };
}

export function checkAttempt(attempt, policy) {
  if (attempt.action === "none") return { allowed: true, http: 200, body: { note: attempt.note } };
  const d = attempt.action === "swap"
    ? check(policy, { action: "swap", assetFrom: attempt.assetFrom, usd: attempt.usd })
    : check(policy, { action: attempt.action, assetFrom: attempt.asset, usd: attempt.usd, destination: attempt.destination });
  if (d.ok) return { allowed: true, http: 202, body: { status: "QUEUED", note: "within the signed policy" } };
  return { allowed: false, http: 403, body: { errors: [{ status: "403", code: d.code, detail: d.reason }] } };
}

function refuse(code, reason) {
  return { ok: false, code, reason };
}

export function fmt(n, digits = 0) {
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
