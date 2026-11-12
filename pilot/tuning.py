"""Tune the agent: plain words or explicit parameters -> ReviewRules, with a preview on history.

The agent never trades; tuning changes only how it picks scripts and how much capital each gets.
Same split as rules.py: a model may draft the change in the product, but the owner confirms the
structured result this module returns, never raw model output.

Examples (English or Russian):
    "only trend-longshort"                 -> pinned
    "never use momentum-top2"              -> excluded
    "no perps" / "без фьючерсов"           -> allow_perps = False
    "skip scripts with drawdown over 20%"  -> max_record_drawdown = 0.20
    "judge on 12 weeks"                    -> window_days = 84
    "max 40% per script"                   -> max_weight = 0.40
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field, replace

from .engine import ReviewRules

_ID = r"([a-z0-9][a-z0-9\-]*@v\d+|[a-z0-9]+(?:-[a-z0-9]+)+)"
_PCT = r"(\d{1,3}(?:[.,]\d+)?)\s*%"


@dataclass
class Tuning:
    rules: ReviewRules
    changes: list[str]
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {"rules": asdict(self.rules), "changes": self.changes, "warnings": self.warnings}


def _ids(text: str, known: list[str]) -> list[str]:
    out = []
    for raw in re.findall(_ID, text):
        sid = raw if "@" in raw else next((k for k in known if k.split("@")[0] == raw), None)
        if sid in known and sid not in out:
            out.append(sid)
    return out


def tune(text: str, known: list[str], base: ReviewRules | None = None) -> Tuning:
    r = base or ReviewRules()
    t = text.lower()
    changes: list[str] = []
    warnings: list[str] = []

    for clause in re.split(r"[.;\n]|,\s*(?=(?:and|и|но|but)?\s*(?:only|never|no|don|не|без|только|skip|max|judge|оцен))", t):
        c = clause.strip()
        if not c:
            continue
        ids = _ids(c, known)
        if re.search(r"\b(only|just|pin)\b|только", c) and ids:
            r = replace(r, pinned=tuple(ids))
            changes.append("run only " + ", ".join(ids) + " (no hiring or firing)")
        elif re.search(r"\b(never|don'?t|exclude|without|skip|ban)\b|никогда|не (?:бери|используй)|исключи|без ", c) and ids:
            r = replace(r, excluded=tuple(sorted(set(r.excluded) | set(ids))))
            changes.append("never hire " + ", ".join(ids))
        elif re.search(r"\b(no|without|disable)\s+(perps?|futures|leverage)\b|без (?:фьючерс|перп|плеч)\w*|не (?:торгуй|используй) (?:фьючерс|перп)\w*", c):
            r = replace(r, allow_perps=False)
            changes.append("no scripts that trade perps")
        elif re.search(r"\b(allow|enable|use)\s+(perps?|futures)\b|(?:разреши|включи) (?:фьючерс|перп)\w*", c):
            r = replace(r, allow_perps=True)
            changes.append("scripts with perps allowed")
        elif re.search(r"drawdown|просадк", c) and (m := re.search(_PCT, c)):
            v = float(m.group(1).replace(",", ".")) / 100
            r = replace(r, max_record_drawdown=v)
            changes.append(f"skip scripts whose 8-week drawdown is above {v:.0%}")
        elif (m := re.search(r"(\d{1,2})\s*(?:weeks?|недел\w*)", c)) and re.search(r"judge|window|оцен|смотр|окно", c):
            weeks = int(m.group(1))
            if not 2 <= weeks <= 52:
                warnings.append(f"{weeks} weeks is outside 2..52, ignored")
                continue
            r = replace(r, window_days=weeks * 7, min_history_days=max(r.min_history_days, weeks * 7))
            changes.append(f"judge scripts on the last {weeks} weeks")
        elif re.search(r"\b(max|at most|up to)\b|не больше|максимум|до ", c) and re.search(r"script|strategy|скрипт|стратег", c) \
                and (m := re.search(_PCT, c)):
            v = float(m.group(1).replace(",", ".")) / 100
            r = replace(r, max_weight=min(1.0, v))
            changes.append(f"at most {v:.0%} of capital per script")
    if not changes:
        warnings.append("nothing recognised; settings unchanged")
    if r.pinned and r.excluded and set(r.pinned) & set(r.excluded):
        warnings.append("a script is both pinned and excluded: pinned wins")
    if r.pinned and not r.allow_perps:
        warnings.append("pinned scripts run even if they trade perps; unpin to apply 'no perps'")
    return Tuning(r, changes, warnings)


def set_params(base: ReviewRules, **params) -> Tuning:
    """Explicit parameters from the UI sliders. Unknown names are rejected, values are range-checked."""
    allowed = {"window_days": (14, 364), "max_weight": (0.05, 1.0), "probation_cap": (0.0, 1.0),
               "max_record_drawdown": (0.01, 1.0), "promote_sharpe": (-5.0, 5.0), "demote_drawdown": (0.01, 1.0)}
    changes, warnings, r = [], [], base
    for k, v in params.items():
        if k in ("allow_perps",):
            r = replace(r, allow_perps=bool(v))
            changes.append(f"{k} = {bool(v)}")
            continue
        if k in ("pinned", "excluded"):
            r = replace(r, **{k: tuple(v)})
            changes.append(f"{k} = {', '.join(v) or 'none'}")
            continue
        if k not in allowed:
            raise ValueError(f"unknown parameter {k}")
        lo, hi = allowed[k]
        if not lo <= float(v) <= hi:
            raise ValueError(f"{k}={v} outside {lo}..{hi}")
        r = replace(r, **{k: type(getattr(base, k) if getattr(base, k) is not None else 0.0)(v)})
        changes.append(f"{k} = {v}")
    return Tuning(r, changes, warnings)
