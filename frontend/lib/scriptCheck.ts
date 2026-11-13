// Static checks on a user script, ported from web/js/agent.js (which mirrors pilot/scriptgen.py).
// The full check (AST, restricted run, backtest) belongs to the backend; this catches the obvious.
const BANNED: [RegExp, string][] = [
  [/^\s*(import|from)\s/m, "imports are not allowed"],
  [/__\w+__/, "dunder names are not allowed"],
  [/\.\s*_\w/, "private attributes are not allowed"],
  [/\b(open|exec|eval|compile|globals|locals|getattr|setattr|vars|input|lambda|class)\b/, "this keyword or function is not allowed"],
  [/\.(to_csv|to_pickle|to_json|to_parquet|eval|query|pipe|apply|applymap|map|load|save|tofile|fromfile)\s*\(/, "this method is not allowed"],
];

export function checkScript(src: string) {
  const problems: string[] = [];
  if (!src.trim()) return ["the script is empty"];
  if (src.length > 4000) problems.push("longer than 4,000 characters");
  if (!/^def target\(\s*\w+\s*\):/m.test(src)) problems.push("a script is exactly one function: def target(daily)");
  if ((src.match(/^def\s/gm) ?? []).length > 1) problems.push("only one function is allowed");
  if (/^[^\s#d]/m.test(src.replace(/^def target.*$/m, ""))) problems.push("code outside the function is not allowed");
  for (const [re, why] of BANNED) if (re.test(src)) problems.push(why);
  const keys = [...src.matchAll(/["']([A-Z]+(?:-PERP)?)["']\s*:/g)].map((m) => m[1]);
  const allowed = new Set(["BTC", "ETH", "SOL", "NEAR", "USDC", "BTC-PERP", "ETH-PERP", "SOL-PERP", "NEAR-PERP"]);
  const bad = keys.filter((k) => !allowed.has(k));
  if (bad.length) problems.push(`unknown weight keys: ${[...new Set(bad)].join(", ")}`);
  return problems;
}

export async function sha256(text: string) {
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

export const IDEAS = [
  "Buy BTC when it is above its 100-day average, hold cash otherwise",
  "Short ETH when it drops below its 30-day average",
  "Keep 50% NEAR and 50% USDC, rebalance when off by 10%",
];
