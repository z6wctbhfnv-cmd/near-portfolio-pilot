// Answers grounded in the chronicle. Port of pilot/explain.py `ask`: it only quotes logged events.
const STOP = new Set("why what when how did the a an is was were of to in on for and or does do my it this that".split(" "));
const KINDS = {
  breaker: ["drawdown", "stop", "breaker", "crash", "freeze", "frozen"],
  refused: ["refused", "blocked", "denied", "budget", "limit"],
  review: ["fired", "hired", "review", "strategy", "strategies", "allocation", "incubator"],
  trade: ["trade", "rebalance", "sold", "bought", "sell", "buy"],
};

export function ask(question, events, limit = 8) {
  const q = question.toLowerCase();
  const words = new Set((q.match(/[a-z0-9@-]+/g) || []).filter((w) => !STOP.has(w) && w.length > 2));
  const kinds = new Set(Object.entries(KINDS).filter(([, ks]) => ks.some((k) => q.includes(k))).map(([k]) => k));
  const month = q.match(/(20\d\d)-(\d\d)/);
  const scored = [];
  for (const e of events) {
    const text = e.text.toLowerCase();
    if (month && !e.time.startsWith(month[0])) continue;
    let s = [...words].reduce((acc, w) => acc + (text.includes(w) ? 2 : 0), 0) + (kinds.has(e.kind) ? 3 : 0);
    if (e.kind === "review" && text.startsWith("allocation") && !q.includes("allocation")) s -= 2;
    if (s > 0) scored.push([s, e]);
  }
  scored.sort((a, b) => b[0] - a[0] || b[1].ts - a[1].ts);
  const hits = scored.slice(0, limit).map(([, e]) => e);
  if (!hits.length) return { answer: "No logged event matches this question. Pilot only answers from its own records.", events: [] };
  return { answer: `${hits.length} logged event${hits.length > 1 ? "s" : ""} match. Each line is quoted from the chronicle.`, events: hits };
}
