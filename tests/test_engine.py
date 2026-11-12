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


def _two_crashes(h):
    # up 60 days, -15% over 5 days, flat 20 days, up 10 days, -15% again
    d = h / 24
    up = 1 + 0.004 * np.minimum(d, 60)
    a = np.where(d < 60, up, up * np.maximum(0.85, 1 - 0.03 * (d - 60)))
    b = np.where(d < 85, a, a * (1 + 0.004 * np.minimum(d - 85, 10)))
    return np.where(d < 95, b, b * np.maximum(0.85, 1 - 0.03 * (d - 95)))


def test_from_peak_mode_keeps_the_all_time_floor():
    p = prices(130, _two_crashes)
    always = ReviewRules(min_history_days=0, promote_sharpe=-1e9, demote_sharpe=-1e9, demote_drawdown=9, hard_drawdown=9,
                         probation_cap=1.0, max_weight=1.0, mode="performance")
    kw = dict(policy=Policy(per_transaction_usd=1e9, daily_usd=1e9), rules=always, resume_after_days=7)
    ep = run(p, [HoldRebalance()], mandate=Mandate(stable_weight=0.0, gold_weight=0.0, crypto_weight=1.0, max_drawdown=0.10), **kw)
    fp = run(p, [HoldRebalance()], mandate=Mandate(stable_weight=0.0, gold_weight=0.0, crypto_weight=1.0, max_drawdown=0.10,
                                                    drawdown_mode="from_peak"), **kw)
    assert fp.metrics["max_drawdown"] <= ep.metrics["max_drawdown"] + 1e-9
    assert fp.metrics["max_drawdown"] < 0.125


def test_drawdown_mode_is_validated():
    import pytest
    with pytest.raises(ValueError):
        Mandate(drawdown_mode="sometimes")


def _recs(n=200, seed=1):
    rng = np.random.default_rng(seed)
    days = T0 + np.arange(1, n + 1) * DAY_MS
    return {
        "a@v1": pd.Series(rng.normal(0.001, 0.01, n), index=days),
        "b@v1": pd.Series(rng.normal(0.0005, 0.03, n), index=days),
    }


@dataclass(frozen=True)
class _S(Strategy):
    name: str = "a"

    def target(self, daily):
        return {"USDC": 1.0}


def test_manual_mode_uses_owner_shares_and_per_script_stop():
    recs = _recs()
    rules = ReviewRules(select="manual", manual_weights=(("a@v1", 0.3), ("b@v1", 0.5)), script_stops=(("b@v1", 0.01),))
    sup = Supervisor([_S("a"), _S("b")], rules)
    events = sup.review(int(list(recs["a@v1"].index)[-1]) + DAY_MS, recs)
    assert sup.alloc == {"a@v1": 0.3}
    assert any("paused b@v1" in e.text for e in events)


def test_allocation_methods_and_explanations():
    recs = _recs()
    ts = int(list(recs["a@v1"].index)[-1]) + DAY_MS
    calm = Supervisor([_S("a"), _S("b")], ReviewRules(min_history_days=0, max_weight=1.0))
    calm.review(ts, recs)
    assert calm.alloc["a@v1"] > calm.alloc["b@v1"]  # calmer script gets more
    eq = Supervisor([_S("a"), _S("b")], ReviewRules(min_history_days=0, max_weight=1.0, allocation="equal"))
    events = eq.review(ts, recs)
    assert abs(eq.alloc["a@v1"] - eq.alloc["b@v1"]) < 1e-9
    assert any(e.text.startswith("raised a@v1 from 0% to") for e in events)


def test_review_rules_validation():
    import pytest
    with pytest.raises(ValueError):
        ReviewRules(review_every_days=0)
    with pytest.raises(ValueError):
        ReviewRules(select="manual", manual_weights=(("a@v1", 0.7), ("b@v1", 0.6)))
