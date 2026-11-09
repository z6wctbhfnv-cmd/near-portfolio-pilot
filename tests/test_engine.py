from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from pilot.engine import DAY_MS, Costs, ReviewRules, Supervisor, run
from pilot.policy import HOUR_MS, Mandate, Policy
from pilot.strategies import CRYPTO, HoldRebalance, Strategy

T0 = 1_735_689_600_000  # 2025-01-01 00:00 UTC


def prices(days: int, path=None) -> pd.DataFrame:
    n = days * 24
    idx = T0 + np.arange(n) * HOUR_MS
    base = {"BTC": 50_000.0, "ETH": 3_000.0, "SOL": 100.0, "NEAR": 5.0, "XAUT": 2_500.0}
    mult = np.ones(n) if path is None else path(np.arange(n))
    return pd.DataFrame({a: v * (mult if a in CRYPTO else 1.0) for a, v in base.items()}, index=idx)


def uptrend_then_crash(up_days: int, crash_days: int, floor: float):
    def path(h):
        rng = np.random.default_rng(7)
        up = 1 + 0.002 * h / 24 + 0.01 * np.sin(h / 5) + rng.normal(0, 0.002, len(h))
        top = up[24 * up_days - 1]
        fall = np.maximum(floor, 1 - (h - 24 * up_days) / (24 * crash_days)) * top
        return np.where(h < 24 * up_days, up, fall)
    return path


@dataclass(frozen=True)
class Spy(Strategy):
    """Records the last daily stamp it was shown, to catch look-ahead."""

    name: str = "spy"
    seen: list = field(default_factory=list, hash=False, compare=False)

    def target(self, daily):
        self.seen.append(int(daily.index[-1]))
        return {"BTC": 0.5, "USDC": 0.5}


def test_no_lookahead_in_daily_decisions():
    spy = Spy()
    p = prices(60)
    run(p, [spy], rules=ReviewRules(min_history_days=0, promote_sharpe=-1e9))
    last_bar_close = int(p.index[-1]) + HOUR_MS
    assert spy.seen and max(spy.seen) <= last_bar_close


def test_flat_market_loses_only_fees_and_earns_yield():
    p = prices(30)
    res = run(p, [HoldRebalance()], mandate=Mandate(stable_apy=0.0),
              rules=ReviewRules(min_history_days=0, promote_sharpe=-1e9))
    m = res.metrics
    assert m["end_equity"] <= m["start_equity"]
    assert abs(m["start_equity"] - m["end_equity"] - m["fees_usd"]) < 1.0


def test_circuit_breaker_sells_everything_and_freezes():
    # Crypto drifts up with noise for 70 days (so the strategy earns a positive record and gets hired),
    # then halves over twenty days.
    crash = uptrend_then_crash(70, 20, 0.5)
    p = prices(100, crash)
    mandate = Mandate(stable_weight=0.0, gold_weight=0.0, crypto_weight=1.0, max_drawdown=0.10)
    always = ReviewRules(min_history_days=0, promote_sharpe=-1e9, demote_sharpe=-1e9, demote_drawdown=9, hard_drawdown=9)
    res = run(p, [HoldRebalance()], mandate=mandate, policy=Policy(per_transaction_usd=1e9, daily_usd=1e9),
              rules=always, resume_after_days=1000)
    kinds = [e.kind for e in res.events]
    assert "breaker" in kinds
    assert res.metrics["max_drawdown"] < 0.13  # stopped near the 10% limit instead of riding the crash to -50%


def test_budget_can_block_the_emergency_exit():
    """A tight daily budget also limits the breaker's sells: a real risk to explain to owners."""
    crash = uptrend_then_crash(70, 5, 0.3)
    p = prices(90, crash)
    mandate = Mandate(stable_weight=0.0, gold_weight=0.0, crypto_weight=1.0, max_drawdown=0.10)
    always = ReviewRules(min_history_days=0, promote_sharpe=-1e9, demote_sharpe=-1e9, demote_drawdown=9, hard_drawdown=9)
    res = run(p, [HoldRebalance()], mandate=mandate, policy=Policy(per_transaction_usd=1_000, daily_usd=2_000),
              rules=always, resume_after_days=1000)
    assert any(e.kind == "refused" and e.data.get("code") == "spend_budget_exceeded" for e in res.events)


def test_supervisor_fires_a_strategy_in_deep_drawdown():
    s = HoldRebalance()
    sup = Supervisor([s], ReviewRules(min_history_days=10, promote_sharpe=0.0))
    days = T0 + np.arange(1, 120) * DAY_MS
    noise = np.tile([0.003, -0.001], 60)[:119]
    good = pd.Series(np.r_[np.full(60, 0.004), np.full(59, -0.01)] + noise, index=days)
    sup.review(int(days[60]), {s.id: good})
    assert sup.state[s.id] == "active"
    events = sup.review(int(days[-1]) + DAY_MS, {s.id: good})
    assert sup.state[s.id] == "retired"
    assert any("fired" in e.text for e in events)


def test_costs_default_matches_1click_without_partner_key():
    assert Costs().fee == 0.002
