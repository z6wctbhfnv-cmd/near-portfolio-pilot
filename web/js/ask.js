// Answers grounded in the chronicle. Port of pilot/explain.py `ask`: it only quotes logged events.
const STOP = new Set(("why what when which how did the a an is was were of to in on for and or does do my it this that " +
  "you your yours we our us me pilot agent happen happened happens there they them today yesterday please tell explain about with from have has had been can could would should").split(" "));
const KINDS = {
  breaker: ["drawdown", "stop", "breaker", "crash", "freeze", "frozen"],
  refused: ["refused", "blocked", "denied", "budget", "limit"],
  review: ["fired", "hired", "review", "strategy", "strategies", "allocation", "incubator"],
  trade: ["trade", "rebalance", "sold", "bought", "sell", "buy"],
};
// Russian question words -> the English terms the chronicle uses.
const RU = { "просадк": "drawdown", "стоп": "stop", "замороз": "freeze", "отказ": "refused", "лимит": "limit", "уволи": "fired",
  "наня": "hired", "стратег": "strategy", "ревизи": "review", "продал": "sell", "продаж": "sell", "купил": "buy", "покуп": "buy",
  "сделк": "trade", "ребаланс": "rebalance" };

// Names the question asks about: tickers (BTC), capitalised words not at a sentence start (Mars),
// strategy ids (momentum-top2@v1), "...coin". If one of them is nowhere in the records, say so.
function names(question) {
  const out = [];
  for (const m of question.matchAll(/[A-Za-z0-9@-]+/g)) {
    const w = m[0], before = question.slice(0, m.index).trimEnd();
    const sentenceStart = before === "" || /[.!?]$/.test(before);
    if (/^[A-Z0-9]{2,}$/.test(w) && /[A-Z]/.test(w) && !/^20\d\d$/.test(w)) out.push(w.toLowerCase());
    else if (/^[A-Z][a-z]+$/.test(w) && !sentenceStart) out.push(w.toLowerCase());
    else if (/[@]|[a-z]-[a-z0-9]|coin$|token$/i.test(w) && !/^20\d\d-\d\d$/.test(w)) out.push(w.toLowerCase());
  }
  return out.filter((w) => !STOP.has(w));
}

export function ask(question, events, limit = 8) {
  let q = question.toLowerCase();
  for (const [ru, en] of Object.entries(RU)) if (q.includes(ru)) q += " " + en;
  const words = new Set((q.match(/[a-z0-9@-]+/g) || []).filter((w) => !STOP.has(w) && w.length > 2));
  const kinds = new Set(Object.entries(KINDS).filter(([, ks]) => ks.some((k) => q.includes(k))).map(([k]) => k));
  const month = q.match(/(20\d\d)-(\d\d)/);
  const none = { answer: "No logged event matches this question. Pilot only answers from its own records.", events: [] };
  const unknown = names(question).filter((n) => !events.some((e) => e.text.toLowerCase().includes(n)));
  if (unknown.length) return { ...none, answer: `Nothing in Pilot's records mentions ${unknown.map((n) => `“${n}”`).join(", ")}. Pilot only answers from its own records.` };
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
  if (!hits.length) return none;
  return { answer: `${hits.length} logged event${hits.length > 1 ? "s" : ""} match. Each line is quoted from the chronicle.`, events: hits };
}
