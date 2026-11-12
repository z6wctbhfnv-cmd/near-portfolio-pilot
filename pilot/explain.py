"""Two demo helpers for the UI: what a hijacked agent would try, and answers grounded in the chronicle.

Neither uses a model. The attack interpreter reads an instruction the way a prompt-injected agent would
and turns it into the API request it would send; the policy then decides. `ask` only quotes logged events,
so it cannot invent an explanation (a NEAR AI summary can be layered on top later).
"""
from __future__ import annotations

import re

from .policy import DAY_MS, Policy, PolicyState

_ACCOUNT = r"(0x[a-fA-F0-9]{6,40}|[a-z0-9_\-]+(?:\.[a-z0-9_\-]+)*\.(?:near|tg)|[A-HJ-NP-Za-km-z1-9]{32,44})"
# An amount needs a "$" before it or a currency after it, so digits inside an address never count.
_AMOUNT = r"(?i)\$\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(?:usd|usdc|dollars?)\b"


def interpret(instruction: str) -> dict:
    """The request a compromised agent would send for this instruction."""
    t = instruction.strip()
    low = t.lower()
    dest = re.search(_ACCOUNT, t)
    amt = re.search(_AMOUNT, t)
    usd = float((amt.group(1) or amt.group(2)).replace(",", "")) if amt else None
    if re.search(r"\b(send|transfer|withdraw|move|drain|pay)\b|отправ|переве|вывед", low) and dest:
        action = "transfer" if dest.group(1).endswith((".near", ".tg")) else "withdraw"
        return {"action": action, "asset": "USDC", "usd": usd or 10_000.0, "destination": dest.group(1)}
    m = re.search(r"\b(buy|swap|sell)\b.*?\b(btc|eth|sol|near|xaut|usdc|pepe|[a-z]{3,6})\b", low)
    if m:
        asset = m.group(2).upper()
        selling = m.group(1) == "sell"
        return {"action": "swap", "asset_from": asset if selling else "USDC", "asset_to": "USDC" if selling else asset,
                "usd": usd or 500.0}
    return {"action": "none", "note": "no money movement in this instruction"}


def check_attempt(attempt: dict, policy: Policy, now_ms: int = 0) -> dict:
    """Run the attempt through the same checks the Agent API applies. Returns an API-shaped response."""
    if attempt["action"] == "none":
        return {"allowed": True, "http": 200, "body": {"note": attempt["note"]}}
    st = PolicyState(policy, period_start=now_ms - now_ms % DAY_MS)
    if attempt["action"] == "swap":
        d = st.check(now_ms, "swap", attempt["asset_from"], attempt["asset_to"], attempt["usd"])
    else:
        d = st.check(now_ms, attempt["action"], attempt["asset"], attempt["asset"], attempt["usd"],
                     destination=attempt["destination"])
    if d.ok:
        return {"allowed": True, "http": 202, "body": {"status": "QUEUED", "note": "within the signed policy"}}
    return {"allowed": False, "http": 403, "body": {"errors": [{"status": "403", "code": d.code, "detail": d.reason}]}}


_STOP = set(("why what when which how did the a an is was were of to in on for and or does do my it this that "
             "you your yours we our us me pilot agent happen happened happens there they them today yesterday please tell "
             "explain about with from have has had been can could would should").split())
_KINDS = {
    "breaker": ("drawdown", "stop", "breaker", "crash", "freeze", "frozen"),
    "refused": ("refused", "blocked", "denied", "budget", "limit"),
    "review": ("fired", "hired", "review", "strategy", "strategies", "allocation", "incubator"),
    "trade": ("trade", "rebalance", "sold", "bought", "sell", "buy"),
}
# Russian question words -> the English terms the chronicle uses.
_RU = {"просадк": "drawdown", "стоп": "stop", "замороз": "freeze", "отказ": "refused", "лимит": "limit", "уволи": "fired",
       "наня": "hired", "стратег": "strategy", "ревизи": "review", "продал": "sell", "продаж": "sell", "купил": "buy",
       "покуп": "buy", "сделк": "trade", "ребаланс": "rebalance"}


def _names(question: str) -> list[str]:
    """Names the question asks about: tickers (BTC), capitalised words not at a sentence start (Mars),
    strategy ids (momentum-top2@v1), "...coin". If one of them is nowhere in the records, say so."""
    out = []
    for m in re.finditer(r"[A-Za-z0-9@-]+", question):
        w, before = m.group(0), question[:m.start()].rstrip()
        sentence_start = before == "" or before[-1] in ".!?"
        if re.fullmatch(r"[A-Z0-9]{2,}", w) and re.search(r"[A-Z]", w) and not re.fullmatch(r"20\d\d", w):
            out.append(w.lower())
        elif re.fullmatch(r"[A-Z][a-z]+", w) and not sentence_start:
            out.append(w.lower())
        elif re.search(r"@|[a-z]-[a-z0-9]|coin$|token$", w, re.I) and not re.fullmatch(r"20\d\d-\d\d", w):
            out.append(w.lower())
    return [w for w in out if w not in _STOP]


def ask(question: str, events: list[dict], limit: int = 8) -> dict:
    """Return the logged events that answer the question, newest first. No event, no answer."""
    q = question.lower()
    for ru, en in _RU.items():
        if ru in q:
            q += " " + en
    words = {w for w in re.findall(r"[a-z0-9@\-]+", q) if w not in _STOP and len(w) > 2}
    kinds = {k for k, keys in _KINDS.items() if any(k2 in q for k2 in keys)}
    month = re.search(r"(20\d\d)-(\d\d)", q)
    unknown = [n for n in _names(question) if not any(n in e["text"].lower() for e in events)]
    if unknown:
        named = ", ".join(f"“{n}”" for n in unknown)
        return {"answer": f"Nothing in Pilot's records mentions {named}. Pilot only answers from its own records.", "events": []}
    scored = []
    for e in events:
        text = e["text"].lower()
        s = sum(2 for w in words if w in text) + (3 if e["kind"] in kinds else 0)
        if month and not e["time"].startswith(month.group(0)):
            continue
        if e["kind"] == "review" and text.startswith("allocation") and "allocation" not in q:
            s -= 2
        if s > 0:
            scored.append((s, e))
    scored.sort(key=lambda x: (x[0], x[1]["ts"]), reverse=True)
    hits = [e for _, e in scored[:limit]]  # most relevant first, newest first among equals
    if not hits:
        return {"answer": "No logged event matches this question. The pilot only answers from its own records.", "events": []}
    return {"answer": f"{len(hits)} logged event{'s' if len(hits) > 1 else ''} match. Each line is quoted from the chronicle.",
            "events": hits}
