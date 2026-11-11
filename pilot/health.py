"""Daily health check of every running script, run by the main agent.

A script's code is fixed by its hash, so its logic is reviewed once, when a version is minted. What can
go wrong day to day is how it runs. Each day the agent checks, per script:

- crash:        the script raised an error
- bad_weights:  NaN, unknown keys, spot not summing to 1, or a perp weight above 1
- stale_data:   the newest price is older than `stale_hours`
- turnover:     today's change in weights is far above the script's own normal (a possible bug)
- drift:        live result differs from the script's simulation over the last week (needs live fills)
- slippage:     average live slippage above the assumption the record was built on
- refused:      the policy refused this script's orders

Each finding has a severity. "stop" pauses the script for this agent until the owner looks;
"warn" is shown on the Agent page. Nothing here can widen what the policy allows.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .strategies import CRYPTO, PERP, Strategy

ALLOWED = {*CRYPTO, "XAUT", "USDC", *(a + PERP for a in CRYPTO)}


@dataclass
class Finding:
    script: str
    check: str
    severity: str  # ok | warn | stop
    detail: str


@dataclass
class HealthReport:
    ts: int
    findings: list[Finding] = field(default_factory=list)

    def status(self, script: str) -> str:
        sev = [f.severity for f in self.findings if f.script == script]
        return "stop" if "stop" in sev else "warn" if "warn" in sev else "ok"

    def as_dict(self) -> dict:
        scripts = sorted({f.script for f in self.findings})
        return {"ts": self.ts, "scripts": {s: {"status": self.status(s),
                                               "findings": [f.__dict__ for f in self.findings if f.script == s and f.severity != "ok"]}
                                           for s in scripts}}


def _weights_problem(w: dict) -> str | None:
    if not isinstance(w, dict):
        return "not a dict"
    bad = [k for k in w if k not in ALLOWED]
    if bad:
        return f"unknown keys {bad}"
    if any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in w.values()):
        return "NaN or non-number weight"
    spot = sum(v for k, v in w.items() if not k.endswith(PERP))
    if abs(spot - 1) > 1e-6:
        return f"spot weights sum to {spot:.3f}, not 1"
    if any(abs(v) > 1 + 1e-9 for k, v in w.items() if k.endswith(PERP)):
        return "perp weight above 1"
    return None


def check(ts: int, daily: pd.DataFrame, scripts: list[Strategy], *, stale_hours: float = 26.0,
          live_week: dict[str, float] | None = None, sim_week: dict[str, float] | None = None,
          slippage: dict[str, float] | None = None, assumed_slippage: float = 0.0005,
          refused: dict[str, int] | None = None) -> HealthReport:
    rep = HealthReport(ts)
    age_h = (ts - int(daily.index[-1])) / 3_600_000
    for s in scripts:
        sid = s.id
        add = lambda c, sev, d: rep.findings.append(Finding(sid, c, sev, d))  # noqa: E731
        if age_h > stale_hours:
            add("stale_data", "stop", f"newest price is {age_h:.0f} h old")
        try:
            w_now = s.target(daily)
            w_prev = s.target(daily.iloc[:-1]) if len(daily) > 2 else w_now
        except Exception as e:  # noqa: BLE001 - any crash is a finding, never a crash of the agent
            add("crash", "stop", f"{type(e).__name__}: {e}")
            continue
        prob = _weights_problem(w_now)
        if prob:
            add("bad_weights", "stop", prob)
            continue
        # Turnover today vs the script's own typical day over the last 60 days.
        keys = set(w_now) | set(w_prev)
        today = sum(abs(w_now.get(k, 0) - w_prev.get(k, 0)) for k in keys)
        hist = []
        for i in range(2, min(62, len(daily) - 1)):
            a, b = s.target(daily.iloc[: len(daily) - i + 1]), s.target(daily.iloc[: len(daily) - i])
            hist.append(sum(abs(a.get(k, 0) - b.get(k, 0)) for k in set(a) | set(b)))
        typical = float(np.percentile(hist, 95)) if hist else 0.0
        if today > max(0.5, 3 * typical):
            add("turnover", "warn", f"weights moved {today:.2f} today vs {typical:.2f} on a busy day")
        if live_week and sim_week and sid in live_week and sid in sim_week:
            gap = live_week[sid] - sim_week[sid]
            if abs(gap) > 0.02:
                add("drift", "warn" if abs(gap) < 0.05 else "stop", f"live {live_week[sid]:+.1%} vs simulated {sim_week[sid]:+.1%} this week")
        if slippage and sid in slippage and slippage[sid] > 2 * assumed_slippage:
            add("slippage", "warn", f"average slippage {slippage[sid]:.2%} vs {assumed_slippage:.2%} assumed")
        if refused and refused.get(sid, 0) > 0:
            add("refused", "warn", f"{refused[sid]} orders refused by the policy")
        add("all", "ok", "")
    return rep
