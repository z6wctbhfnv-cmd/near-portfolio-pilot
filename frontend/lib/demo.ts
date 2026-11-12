// Demo data. Replaced by the Agent API and OutLayer once those land.
export type Holding = { sym: string; name: string; amount: string; usd: number; change: number; target: number; bg: string; fg: string };

export const holdings: Holding[] = [
  { sym: "USDC", name: "USD Coin", amount: "4 820 USDC", usd: 4820, change: 0.0, target: 45, bg: "#2775ca", fg: "#fff" },
  { sym: "NEAR", name: "NEAR", amount: "562.5 NEAR", usd: 3150, change: -8.1, target: 30, bg: "#ffffff", fg: "#000" },
  { sym: "ETH", name: "Ethereum", amount: "0.52 ETH", usd: 1740, change: 3.2, target: 15, bg: "#627eea", fg: "#fff" },
  { sym: "BTC", name: "Bitcoin", amount: "0.0141 BTC", usd: 1290, change: 1.4, target: 10, bg: "#f7931a", fg: "#fff" },
];

export const total = holdings.reduce((s, h) => s + h.usd, 0);

/** Portfolio value per range, oldest first. */
export const series: Record<string, number[]> = {
  "1D": [10930, 10950, 10920, 10960, 10990, 10970, 11010, 10980, 11000],
  "1W": [10720, 10810, 10760, 10880, 10840, 10910, 11000],
  "1M": [10588, 10640, 10520, 10610, 10700, 10660, 10790, 10830, 10760, 10900, 10950, 11000],
  "1Y": [7400, 7900, 8300, 8100, 8800, 9400, 9100, 9800, 10200, 10050, 10600, 11000],
};

export type Move = {
  id: string; when: string; kind: "swap" | "hold" | "buy" | "review";
  title: string; amount?: string; why: string; rule: string; strategy: string;
};

export const moves: Move[] = [
  { id: "m1", when: "Today, 09:12", kind: "swap", title: "USDC → NEAR", amount: "+71.4 NEAR",
    why: "NEAR fell 8% this week and slipped to 26% of your portfolio. Your target is 30%, so Dolya bought back to target.",
    rule: "Keep NEAR at 30% ± 4", strategy: "Calm Rebalance" },
  { id: "m2", when: "Yesterday, 18:40", kind: "hold", title: "Skipped an ETH trade",
    why: "ETH drifted 3%. Your rule says act only past 5%, and the fee would have eaten the gain.",
    rule: "Act only past 5% drift", strategy: "Calm Rebalance" },
  { id: "m3", when: "10 Nov, 10:03", kind: "buy", title: "Weekly BTC buy", amount: "+0.0013 BTC",
    why: "Your weekly buy. Same amount, same day, whatever the price did.",
    rule: "Max $150 a week", strategy: "Weekly DCA" },
  { id: "m4", when: "9 Nov, 21:00", kind: "review", title: "Weekly check-in",
    why: "The AI reviewer checked both strategies against your rules. Both stayed inside every limit, so nothing changed.",
    rule: "Check-in every Sunday", strategy: "AI reviewer" },
];

export const stories = [
  { id: "s1", title: "How dolya works", bg: "#ffdd2d", fg: "#000" },
  { id: "s2", title: "Your rules", bg: "#2c2c2e", fg: "#fff" },
  { id: "s3", title: "Freeze in 1 tap", bg: "#ff453a", fg: "#fff" },
  { id: "s4", title: "Why AI review?", bg: "#30d158", fg: "#000" },
  { id: "s5", title: "Verified runs", bg: "#627eea", fg: "#fff" },
];

export const strategies = [
  { id: "calm", name: "Calm Rebalance", risk: "Low", ret: 6.1, dd: -2.4, runs: 412, users: 1840, emoji: "≈", bg: "#ffdd2d", fg: "#000",
    tagline: "Holds your mix at target. Trades only when the drift is worth the fee.", spark: [3,4,4,5,5,6,5,6,7,7,8,8] },
  { id: "dca", name: "Weekly DCA", risk: "Low", ret: 9.4, dd: -5.1, runs: 158, users: 3210, emoji: "↻", bg: "#30d158", fg: "#000",
    tagline: "Buys a fixed amount every week. Boring on purpose.", spark: [2,3,3,4,4,4,5,6,6,7,8,9] },
  { id: "trend", name: "Trend Follow", risk: "Medium", ret: 14.2, dd: -11.8, runs: 96, users: 720, emoji: "↗", bg: "#ff9f0a", fg: "#000",
    tagline: "Rides assets that keep rising and steps out when they stall.", spark: [3,5,4,6,8,7,9,8,11,10,12,14] },
  { id: "stable", name: "Stable Park", risk: "Low", ret: 4.3, dd: -0.3, runs: 233, users: 2050, emoji: "$", bg: "#2775ca", fg: "#fff",
    tagline: "Keeps idle cash in stablecoins, ready for the other strategies.", spark: [1,1,2,2,2,3,3,3,4,4,4,4] },
];

export const examples = [
  "Keep it safe. Spend at most $150 a week, mostly NEAR and USDC.",
  "Grow it, but never move more than 10% at once. BTC, ETH and NEAR.",
  "Buy a little NEAR every week. Never send money anywhere but my wallet.",
];

/** Turns plain words into policy lines. A stand-in for the real LLM parser. */
export function parseRules(text: string) {
  const t = text.toLowerCase();
  const budget = t.match(/\$?\s?(\d[\d,]*)\s?(?:usd|dollars)?\s*(?:a|per)\s*(week|month|day)/);
  const pct = t.match(/(\d+)\s?%/);
  const assets = ["near", "usdc", "eth", "btc", "sol"].filter((a) => t.includes(a)).map((a) => a.toUpperCase());
  return [
    { k: "Spending limit", v: budget ? `$${budget[1]} a ${budget[2]}` : "$100 a week", src: !!budget },
    { k: "Largest single move", v: `${pct ? pct[1] : 10}% of portfolio`, src: !!pct },
    { k: "Risk", v: /aggressive|grow|growth|high risk/.test(t) ? "Medium" : "Low", src: /safe|grow|risk|aggressive/.test(t) },
    { k: "Assets", v: assets.length ? assets.join(", ") : "NEAR, USDC", src: assets.length > 0 },
    { k: "Withdrawals", v: "Your wallet only", src: /wallet|withdraw|send/.test(t) },
    { k: "Freeze", v: "Always available", src: false },
  ];
}

export const usd = (n: number) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 });
