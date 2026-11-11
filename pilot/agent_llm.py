"""The main agent: an LLM on NEAR AI Cloud (TEE) that the owner talks to, by text or voice.

The model turns one owner message into one structured action:
    {"type": "trade", "side": "buy", "asset": "BTC", "usd": 100}
    {"type": "task",  "text": "if BTC below 60000 buy $500"}
    {"type": "tune",  "text": "no perps; max 40% per script"}
    {"type": "answer", "text": "..."}                       (questions, explanations)

It never holds keys and never executes anything itself. Each action is validated by deterministic
code (policy, task parser, tuning parser) and, depending on the owner's choice, either runs at once or
waits for the owner's confirmation. The owner's settings and tasks are sent only to NEAR AI's TEE,
never stored by Pilot in the clear.

Without NEARAI_API_KEY the agent falls back to the deterministic parsers, so the product works
(less flexibly) offline and in tests.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

from .policy import PolicyState
from .tasks import ASSETS, parse_task
from .tuning import tune

SYSTEM = """You are the owner's portfolio agent in Pilot on NEAR. You cannot move money yourself.
Turn the owner's message into exactly one JSON object, nothing else:
- trade now:   {"type":"trade","side":"buy"|"sell","asset":"BTC|ETH|SOL|NEAR|XAUT","usd":number}
- a task:      {"type":"task","text":"<the task in plain English, e.g. if BTC below 60000 buy $500 / buy $50 of ETH every friday>"}
- settings:    {"type":"tune","text":"<settings in plain English, e.g. only trend-longshort; no perps; max 40% per script>"}
- otherwise:   {"type":"answer","text":"<short answer>"}
Never invent amounts. If the amount or asset is missing, answer with a question.
Owner context (private): {context}"""


@dataclass
class Action:
    type: str
    data: dict
    ok: bool
    note: str = ""


def _fallback(message: str) -> dict:
    t = message.lower()
    if re.search(r"\b(if|when|every|each|если|когда|каждый|каждую|каждое|ежедневно)\b", t):
        return {"type": "task", "text": message}
    if re.search(r"\b(only|never|no perps|max|judge|skip|только|никогда|без|не больше)\b", t) and not re.search(r"\b(buy|sell|купи|продай)\b", t):
        return {"type": "tune", "text": message}
    side = "sell" if re.search(r"\b(sell|продай)", t) else "buy" if re.search(r"\b(buy|купи)", t) else None
    asset = next((v for k, v in ASSETS.items() if re.search(rf"\b{k}", t)), None)
    m = re.search(r"\$\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(?:\$|usd|долл)", t)
    if side and asset and m:
        return {"type": "trade", "side": side, "asset": asset, "usd": float((m.group(1) or m.group(2)).replace(",", ""))}
    return {"type": "answer", "text": "Tell me what to buy or sell and for how much, or set a task like 'if BTC below 60000 buy $500'."}


def interpret(message: str, context: dict, known_scripts: list[str], chat=None) -> dict:
    """One owner message -> one raw action dict (from the model, or the fallback parser)."""
    if chat is None:
        return _fallback(message)
    raw = chat([{"role": "system", "content": SYSTEM.replace("{context}", json.dumps(context)[:4000])},
                {"role": "user", "content": message[:2000]}])
    m = re.search(r"\{.*\}", raw, re.S)
    try:
        out = json.loads(m.group(0)) if m else {}
    except json.JSONDecodeError:
        out = {}
    return out if out.get("type") in {"trade", "task", "tune", "answer"} else _fallback(message)


def validate(raw: dict, state: PolicyState, now_ms: int, known_scripts: list[str]) -> Action:
    """Deterministic checks on whatever the model produced. The owner sees this, not the raw output."""
    kind = raw.get("type")
    if kind == "trade":
        side, asset = raw.get("side"), raw.get("asset")
        try:
            usd = float(raw.get("usd"))
        except (TypeError, ValueError):
            return Action("trade", raw, False, "amount missing")
        if side not in ("buy", "sell") or asset not in {"BTC", "ETH", "SOL", "NEAR", "XAUT"} or not 0 < usd <= 1_000_000:
            return Action("trade", raw, False, "unclear trade; nothing sent")
        src, dst = ("USDC", asset) if side == "buy" else (asset, "USDC")
        d = state.check(now_ms, "swap", src, dst, usd)
        return Action("trade", {"side": side, "asset": asset, "usd": usd}, d.ok, d.reason or "within your policy")
    if kind == "task":
        try:
            t = parse_task(str(raw.get("text", "")))
        except ValueError as e:
            return Action("task", raw, False, str(e))
        from .tasks import as_dict
        return Action("task", as_dict(t), True, "task ready")
    if kind == "tune":
        tu = tune(str(raw.get("text", "")), known_scripts)
        return Action("tune", tu.as_dict(), bool(tu.changes), "; ".join(tu.changes or tu.warnings))
    return Action("answer", {"text": str(raw.get("text", ""))[:2000]}, True)
