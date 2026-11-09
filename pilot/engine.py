"""Simulation of the pilot: strategies, weekly review (the supervisor), owner policy and circuit breaker.

Everything is causal: a decision at time t uses prices up to t only. The same review and policy code
is meant to run live; only the price source and the executor change.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .policy import DAY_MS, Decision, Mandate, Policy, PolicyState
from .strategies import CRYPTO, Strategy

HOURS_PER_YEAR = 8760


@dataclass
class Costs:
    fee: float = 0.002  # 1Click fee without a partner key
    spread: float = 0.0005  # solver spread assumption

    @property
    def per_swap(self) -> float:
        return self.fee + self.spread


@dataclass
class ReviewRules:
    """The supervisor's rules. Alexander's idea: cut losers, try newcomers, keep the rest."""

    window_days: int = 56  # judge on the last 8 weeks
    min_history_days: int = 56  # incubator: no capital before 8 weeks of paper record
    promote_sharpe: float = 0.5
    demote_sharpe: float = 0.0
    demote_drawdown: float = 0.15
    hard_drawdown: float = 0.25
    cooldown_days: int = 28  # a retired strategy may re-enter the incubator after this
    probation_days: int = 28
    probation_cap: float = 0.2
    max_weight: float = 0.6


@dataclass
class Event:
    ts: int
    kind: str  # trade | refused | review | breaker | resume
    text: str
    data: dict = field(default_factory=dict)


def shadow_returns(strategy: Strategy, daily: pd.DataFrame, costs: Costs) -> pd.Series:
    """Paper record of one strategy on daily closes, net of swap costs. Index = day the return lands."""
    rets = daily[list(CRYPTO)].pct_change().fillna(0.0)
    w_prev = {a: 0.0 for a in CRYPTO}
    out = []
    for i in range(len(daily) - 1):
        w = strategy.target(daily.iloc[: i + 1])
        turnover = sum(abs(w.get(a, 0.0) - w_prev[a]) for a in CRYPTO)
        r_next = sum(w.get(a, 0.0) * rets[a].iloc[i + 1] for a in CRYPTO)
        out.append(r_next - turnover * costs.per_swap)
        w_prev = {a: w.get(a, 0.0) for a in CRYPTO}
    return pd.Series(out, index=daily.index[1:], name=strategy.id)


def _sharpe(r: pd.Series) -> float:
    sd = r.std()
    return float(r.mean() / sd * np.sqrt(365)) if sd > 0 else 0.0


def _max_dd(r: pd.Series) -> float:
    eq = (1 + r).cumprod()
    return float((1 - eq / eq.cummax()).max()) if len(eq) else 0.0


class Supervisor:
    """Weekly review. Decides which strategies get capital and how much, and says why."""

    def __init__(self, strategies: list[Strategy], rules: ReviewRules):
        self.rules = rules
        self.strategies = {s.id: s for s in strategies}
        self.state = {s.id: "incubator" for s in strategies}
        self.since: dict[str, int] = {s.id: 0 for s in strategies}
        self.alloc: dict[str, float] = {}

    def review(self, ts: int, records: dict[str, pd.Series]) -> list[Event]:
        r, events, scores = self.rules, [], {}
        for sid, rec in records.items():
            hist = rec[rec.index < ts]
            win = hist.iloc[-r.window_days:]
            sh, dd = _sharpe(win), _max_dd(win)
            scores[sid] = sh
            st = self.state[sid]
            facts = {"sharpe_8w": round(sh, 2), "drawdown_8w": round(dd, 3), "days": len(hist)}
            if st == "incubator" and len(hist) >= r.min_history_days and sh > r.promote_sharpe and dd < r.demote_drawdown:
                self._set(sid, "active", ts)
                events.append(Event(ts, "review", f"hired {sid}: 8-week Sharpe {sh:.2f}, drawdown {dd:.1%}", facts))
            elif st == "active" and (dd > r.hard_drawdown or (sh < r.demote_sharpe and dd > r.demote_drawdown)):
                self._set(sid, "retired", ts)
                events.append(Event(ts, "review", f"fired {sid}: 8-week Sharpe {sh:.2f}, drawdown {dd:.1%}", facts))
            elif st == "retired" and ts - self.since[sid] >= r.cooldown_days * DAY_MS:
                self._set(sid, "incubator", ts)
                events.append(Event(ts, "review", f"{sid} back to the incubator after cooldown", facts))
        self.alloc = self._allocate(ts, scores)
        events.append(Event(ts, "review", "allocation " + (", ".join(f"{k} {v:.0%}" for k, v in self.alloc.items()) or "none: crypto sleeve in USDC"),
                            {"alloc": dict(self.alloc)}))
        return events

    def blend(self, daily: pd.DataFrame) -> dict[str, float]:
        """Sleeve weights: allocation-weighted mix of active strategies' targets."""
        w = {a: 0.0 for a in (*CRYPTO, "USDC")}
        if not self.alloc:
            w["USDC"] = 1.0
            return w
        for sid, share in self.alloc.items():
            for a, x in self.strategies[sid].target(daily).items():
                w[a] = w.get(a, 0.0) + share * x
        return w

    def _set(self, sid: str, state: str, ts: int) -> None:
        self.state[sid], self.since[sid] = state, ts

    def _allocate(self, ts: int, scores: dict[str, float]) -> dict[str, float]:
        r = self.rules
        active = [s for s, st in self.state.items() if st == "active"]
        raw = {s: min(max(scores.get(s, 0.0), 0.0), 3.0) for s in active}
        raw = {s: v for s, v in raw.items() if v > 0}
        if not raw:
            return {}
        total = sum(raw.values())
        alloc = {s: v / total for s, v in raw.items()}
        for s in alloc:  # caps: probation for newcomers, max weight for everyone
            cap = r.probation_cap if ts - self.since[s] < r.probation_days * DAY_MS else r.max_weight
            alloc[s] = min(alloc[s], cap)
        total = sum(alloc.values())
        # Capped weight that cannot be redistributed stays in USDC rather than being forced elsewhere.
        return {s: v for s, v in alloc.items()} if total <= 1 else {s: v / total for s, v in alloc.items()}


@dataclass
class SimResult:
    equity: pd.Series
    events: list[Event]
    metrics: dict
    records: dict[str, pd.Series]


def daily_closes(prices: pd.DataFrame) -> pd.DataFrame:
    idx = pd.to_datetime(prices.index, unit="ms", utc=True)
    d = prices.set_axis(idx).resample("1D").last().dropna()
    d.index = (d.index.astype("int64") // 1_000_000) + DAY_MS  # stamp = when the daily close is known
    return d


def run(prices: pd.DataFrame, strategies: list[Strategy], mandate: Mandate | None = None,
        policy: Policy | None = None, costs: Costs | None = None, rules: ReviewRules | None = None,
        start_equity: float = 10_000.0, resume_after_days: int = 7) -> SimResult:
    """Hourly simulation. `prices`: index = bar open time (UTC ms), columns = assets, values = close."""
    mandate, policy, costs, rules = mandate or Mandate(), policy or Policy(), costs or Costs(), rules or ReviewRules()
    daily = daily_closes(prices)
    records = {s.id: shadow_returns(s, daily, costs) for s in strategies}
    sup = Supervisor(strategies, rules)
    pstate = PolicyState(policy, period_start=int(prices.index[0]))
    units = {a: 0.0 for a in prices.columns}
    units["USDC"] = start_equity
    hourly_yield = (1 + mandate.stable_apy) ** (1 / HOURS_PER_YEAR) - 1
    events: list[Event] = []
    eq_out, peak, frozen_since, fees = [], start_equity, None, 0.0
    stats = {"trades": 0, "refused": 0, "volume_usd": 0.0}

    def value(px) -> dict[str, float]:
        v = {a: units[a] * px[a] for a in prices.columns}
        v["USDC"] = units["USDC"]
        return v

    def swap(ts, px, asset, usd_delta) -> None:
        """usd_delta > 0 buys `asset` with USDC, < 0 sells it. Split by per-transaction limit."""
        nonlocal fees
        left = abs(usd_delta)
        while left > 1.0:
            chunk = min(left, policy.per_transaction_usd)
            src, dst = ("USDC", asset) if usd_delta > 0 else (asset, "USDC")
            d: Decision = pstate.check(ts, "swap", src, dst, chunk)
            if not d.ok:
                stats["refused"] += 1
                events.append(Event(ts, "refused", f"swap {src}->{dst} ${chunk:,.0f} refused: {d.code}", {"code": d.code}))
                return
            cost = chunk * costs.per_swap
            if usd_delta > 0:
                units["USDC"] -= chunk
                units[asset] += (chunk - cost) / px[asset]
            else:
                units[asset] -= chunk / px[asset]
                units["USDC"] += chunk - cost
            pstate.record(ts, chunk)
            fees += cost
            stats["trades"] += 1
            stats["volume_usd"] += chunk
            left -= chunk

    def rebalance(ts, px, targets) -> None:
        v = value(px)
        eq = sum(v.values())
        drift = max(abs(v.get(a, 0) / eq - targets.get(a, 0)) for a in v)
        if drift < mandate.rebalance_band:
            return
        deltas = {a: targets.get(a, 0) * eq - v[a] for a in prices.columns}
        for a in sorted(deltas, key=deltas.get):  # sells (negative) first, then buys
            if abs(deltas[a]) > 1.0:
                swap(ts, px, a, deltas[a])
        events.append(Event(ts, "trade", f"rebalanced, max drift {drift:.1%}", {"targets": {k: round(x, 4) for k, x in targets.items()}}))

    day_ts = set(int(x) for x in daily.index)
    for ts, row in prices.iterrows():
        ts = int(ts)
        px = row.to_dict()
        units["USDC"] *= 1 + hourly_yield
        eq = sum(value(px).values())
        peak = max(peak, eq)
        if frozen_since is None and eq < peak * (1 - mandate.max_drawdown):
            events.append(Event(ts, "breaker", f"drawdown {1 - eq / peak:.1%} > {mandate.max_drawdown:.0%}: all to USDC, agent frozen", {"equity": eq}))
            for a in prices.columns:
                if units[a] > 0:
                    swap(ts, px, a, -units[a] * px[a])
            frozen_since = ts
            policy.frozen = True
        if frozen_since is not None and ts - frozen_since >= resume_after_days * DAY_MS:
            policy.frozen = False
            frozen_since, peak = None, eq
            events.append(Event(ts, "resume", f"owner resumed after {resume_after_days} days (simulated owner decision)"))
        if ts in day_ts and frozen_since is None:
            hist = daily[daily.index <= ts]
            if pd.Timestamp(ts, unit="ms", tz="UTC").weekday() == 0:
                events.extend(sup.review(ts, records))
            sleeve = sup.blend(hist)
            targets = {a: mandate.crypto_weight * sleeve.get(a, 0.0) for a in CRYPTO}
            targets["XAUT"] = mandate.gold_weight
            targets["USDC"] = mandate.stable_weight + mandate.crypto_weight * sleeve.get("USDC", 0.0)
            rebalance(ts, px, targets)
        eq_out.append((ts, sum(value(px).values())))

    equity = pd.Series(dict(eq_out), name="equity")
    return SimResult(equity, events, metrics(equity, fees, stats, start_equity), records)


def metrics(equity: pd.Series, fees: float, stats: dict, start: float) -> dict:
    r = equity.pct_change().dropna()
    years = (equity.index[-1] - equity.index[0]) / (DAY_MS * 365)
    total = equity.iloc[-1] / start - 1
    return {
        "start_equity": start,
        "end_equity": round(float(equity.iloc[-1]), 2),
        "total_return": round(float(total), 4),
        "cagr": round(float((1 + total) ** (1 / years) - 1), 4) if years > 0 else None,
        "max_drawdown": round(float((1 - equity / equity.cummax()).max()), 4),
        # A riskless series (cash in a vault) has no meaningful Sharpe: report None, not infinity.
        "sharpe": round(float(r.mean() / r.std() * np.sqrt(HOURS_PER_YEAR)), 2) if r.std() > 1e-7 else None,
        "fees_usd": round(fees, 2),
        **{k: (round(v, 2) if isinstance(v, float) else v) for k, v in stats.items()},
    }


def buy_and_hold(prices: pd.DataFrame, weights: dict[str, float], start: float = 10_000.0, stable_apy: float = 0.0) -> pd.Series:
    """Benchmark: buy once at the start, never trade."""
    p0 = prices.iloc[0]
    hours = np.arange(len(prices))
    eq = sum(start * w * prices[a] / p0[a] for a, w in weights.items() if a != "USDC")
    eq = eq + start * weights.get("USDC", 0.0) * (1 + stable_apy) ** (hours / HOURS_PER_YEAR)
    return pd.Series(np.asarray(eq), index=prices.index, name="buy_and_hold")
