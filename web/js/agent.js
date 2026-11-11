// Agent settings: which scripts run, how the review picks them, and the owner's own scripts.
// Mirrors pilot/tuning.py (words -> settings) and pilot/scriptgen.py (static script checks).
// The agent never trades; these settings only change which scripts get capital and how much.

// select: "auto" (agent picks and sizes) | "pick" (owner picks, agent sizes) | "manual" (owner sets shares)
// allocation: "calm" | "equal" | "return" | "balanced"; reviewEvery: days between automatic reviews (>= 1)
// caps / stops: per-script max share and per-script drawdown stop; removed: scripts taken off this agent
export const DEFAULTS = {
  select: "auto", pinned: [], excluded: [], weights: {}, allowPerps: true, maxWeight: 0.6, maxRecordDrawdown: null,
  windowWeeks: 8, allocation: "calm", reviewEvery: 7, caps: {}, stops: {}, removed: [],
  // What the agent does on its own (the owner chooses):
  onProblem: "pause",        // serious daily-check finding: "pause" and tell | "ask" and wait | "notify" only
  onScriptChange: "pause",   // a copied script got a new version: "pause" until confirmed | "continue" and tell | "unfollow"
  paused: [], pausedByAgent: [], keepRunning: [], ackVersions: {},
};

export const PRESETS = {
  careful: ["Careful", { allowPerps: false, maxWeight: 0.3, maxRecordDrawdown: 0.15, allocation: "calm", reviewEvery: 7 }],
  balanced: ["Balanced", { allowPerps: true, maxWeight: 0.6, maxRecordDrawdown: null, allocation: "calm", reviewEvery: 7 }],
  bold: ["Bold", { allowPerps: true, maxWeight: 1, maxRecordDrawdown: null, allocation: "return", reviewEvery: 1 }],
};
export const presetOf = (s) => Object.keys(PRESETS).find((k) => Object.entries(PRESETS[k][1]).every(([f, v]) => s[f] === v)) || null;

export const ON_PROBLEM = [["pause", "Pause it and tell me"], ["ask", "Ask me, keep running meanwhile"], ["notify", "Only tell me"]];
export const ON_CHANGE = [["pause", "Pause until I confirm"], ["continue", "Keep copying and tell me"], ["unfollow", "Stop copying"]];

export const ALLOCATIONS = [
  ["calm", "Calm first", "Calmer scripts get more (inverse volatility). Best in our 2-year simulation."],
  ["equal", "Equal", "The same share for every running script."],
  ["return", "Return per risk", "More to scripts with higher past return per unit of volatility. Tends to chase recent winners."],
  ["balanced", "Balanced", "Return per risk, minus scripts that move together. Weakest in our simulation; offered for comparison."],
];

export const REVIEWS = [[1, "Every day"], [7, "Every week"], [14, "Every 2 weeks"], [30, "Every month"]];

const PCT = /(\d{1,3}(?:[.,]\d+)?)\s*%/;

function ids(text, known) {
  const out = [];
  for (const raw of text.match(/[a-z0-9][a-z0-9-]*@v\d+|[a-z0-9]+(?:-[a-z0-9]+)+/g) || []) {
    const id = raw.includes("@") ? raw : known.find((k) => k.split("@")[0] === raw);
    if (id && known.includes(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

// Plain words -> changes. Returns { settings, changes, warnings }; nothing applies until the owner confirms.
export function tune(text, known, base = DEFAULTS) {
  const s = { ...base, pinned: [...base.pinned], excluded: [...base.excluded] };
  const changes = [], warnings = [];
  for (const raw of text.toLowerCase().split(/[.;\n]/)) {
    const c = raw.trim();
    if (!c) continue;
    const found = ids(c, known);
    let m;
    if (/\b(only|just|pin)\b|только/.test(c) && found.length) {
      s.pinned = found; changes.push(`run only ${found.join(", ")} (no hiring or firing)`);
    } else if (/\b(never|don'?t|exclude|without|skip|ban)\b|никогда|не (?:бери|используй)|исключи|без /.test(c) && found.length) {
      s.excluded = [...new Set([...s.excluded, ...found])]; changes.push(`never hire ${found.join(", ")}`);
    } else if (/\b(no|without|disable)\s+(perps?|futures|leverage)\b|без (?:фьючерс|перп|плеч)|не (?:торгуй|используй) (?:фьючерс|перп)/.test(c)) {
      s.allowPerps = false; changes.push("no scripts that trade perps");
    } else if (/\b(allow|enable|use)\s+(perps?|futures)\b|(?:разреши|включи) (?:фьючерс|перп)/.test(c)) {
      s.allowPerps = true; changes.push("scripts with perps allowed");
    } else if (/drawdown|просадк/.test(c) && (m = c.match(PCT))) {
      s.maxRecordDrawdown = parseFloat(m[1].replace(",", ".")) / 100; changes.push(`skip scripts whose 8-week drawdown is above ${m[1]}%`);
    } else if ((m = c.match(/(\d{1,2})\s*(?:weeks?|недел)/)) && /judge|window|оцен|смотр|окно/.test(c)) {
      const w = +m[1];
      if (w < 2 || w > 52) { warnings.push(`${w} weeks is outside 2..52, ignored`); continue; }
      s.windowWeeks = w; changes.push(`judge scripts on the last ${w} weeks`);
    } else if (/\b(max|at most|up to)\b|не больше|максимум/.test(c) && /script|strategy|скрипт|стратег/.test(c) && (m = c.match(PCT))) {
      s.maxWeight = Math.min(1, parseFloat(m[1].replace(",", ".")) / 100); changes.push(`at most ${m[1]}% of capital per script`);
    }
  }
  if (!changes.length) warnings.push("Nothing recognised, settings unchanged. Try: “only trend-longshort”, “no perps”, “skip scripts with drawdown over 20%”.");
  return { settings: s, changes, warnings };
}

// Which precomputed simulation matches these settings, and whether the match is exact.
export function variantFor(s, variants) {
  if (s.select !== "manual" && s.pinned.length === 1 && variants[`pin:${s.pinned[0]}`]) return { key: `pin:${s.pinned[0]}`, exact: true };
  const base = s.select === "auto" && !s.pinned.length && !s.excluded.length && !s.removed?.length && s.maxWeight === 0.6
    && s.maxRecordDrawdown == null && s.windowWeeks === 8 && !Object.keys(s.caps || {}).length && !Object.keys(s.stops || {}).length;
  const def = s.allocation === "calm" && s.reviewEvery === 7;
  if (base && def && !s.allowPerps) return { key: "no-perps", exact: true };
  if (base && s.allowPerps && s.allocation !== "calm" && s.reviewEvery === 7 && variants[`alloc:${s.allocation}`]) return { key: `alloc:${s.allocation}`, exact: true };
  if (base && s.allowPerps && s.allocation === "calm" && variants[`review:${s.reviewEvery}`]) return { key: `review:${s.reviewEvery}`, exact: true };
  if (base && def) return { key: "risk", exact: true };
  return { key: s.allowPerps ? "risk" : "no-perps", exact: false };
}

// Static checks matching pilot/scriptgen.py. The real check (AST + restricted run + backtest) runs on Pilot's side.
const BANNED = [
  [/^\s*(import|from)\s/m, "imports are not allowed"],
  [/__\w+__/, "dunder names are not allowed"],
  [/\.\s*_\w/, "private attributes are not allowed"],
  [/\b(open|exec|eval|compile|globals|locals|getattr|setattr|vars|input|lambda|class)\b/, "this keyword or function is not allowed"],
  [/\.(to_csv|to_pickle|to_json|to_parquet|eval|query|pipe|apply|applymap|map|load|save|tofile|fromfile)\s*\(/, "this method is not allowed"],
];

export function checkScript(src) {
  const problems = [];
  if (!src.trim()) return ["empty script"];
  if (src.length > 4000) problems.push("longer than 4,000 characters");
  if (!/^def target\(\s*\w+\s*\):/m.test(src)) problems.push("a script is exactly one function: def target(daily)");
  const defs = src.match(/^def\s/gm) || [];
  if (defs.length > 1) problems.push("only one function is allowed");
  if (/^[^\s#d]/m.test(src.replace(/^def target.*$/m, ""))) problems.push("code outside the function is not allowed");
  for (const [re, why] of BANNED) if (re.test(src)) problems.push(why);
  const keys = [...src.matchAll(/["']([A-Z]+(?:-PERP)?)["']\s*:/g)].map((m) => m[1]);
  const allowed = new Set(["BTC", "ETH", "SOL", "NEAR", "USDC", "BTC-PERP", "ETH-PERP", "SOL-PERP", "NEAR-PERP"]);
  const bad = keys.filter((k) => !allowed.has(k));
  if (bad.length) problems.push(`unknown weight keys: ${[...new Set(bad)].join(", ")}`);
  return problems;
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const EXAMPLE_SCRIPT = `def target(daily):
    # Long BTC above its 50-day average, small short below it.
    s = daily["BTC"]
    if len(s) < 50:
        return {"USDC": 1.0}
    if s.iloc[-1] > s.iloc[-50:].mean():
        return {"BTC": 0.6, "USDC": 0.4}
    return {"BTC-PERP": -0.3, "USDC": 1.0}
`;

export function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("pilot.agent") || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export function save(s) {
  try {
    localStorage.setItem("pilot.agent", JSON.stringify(s));
  } catch {
    /* private mode: settings live for this page only */
  }
}
