"""Perps: policy limits, hourly mark-to-market, funding, de-risking under freeze, and script hashes."""
from dataclasses import dataclass

import numpy as np
import pandas as pd

from pilot.engine import Costs, ReviewRules, run, shadow_returns, daily_closes
from pilot.policy import HOUR_MS, Mandate, Policy, PolicyState
from pilot.strategies import CRYPTO, FundingCarry, Strategy, TrendFilter, TrendLongShort, catalog, perp

T0 = 1_735_689_600_000
ALWAYS = ReviewRules(min_history_days=0, promote_sharpe=-1e9, demote_sharpe=-1e9, demote_drawdown=9, hard_drawdown=9,
                     probation_cap=1.0, max_weight=1.0)
ALL_CRYPTO = Mandate(stable_weight=0.0, gold_weight=0.0, crypto_weight=1.0, max_drawdown=0.9)
PERPS = Policy(actions=("swap", "perp"), per_transaction_usd=1e9, daily_usd=1e9)


def prices(days: int, slope: float = 0.0) -> pd.DataFrame:
    n = days * 24
    idx = T0 + np.arange(n) * HOUR_MS
    mult = 1 + slope * np.arange(n) / 24
    base = {"BTC": 50_000.0, "ETH": 3_000.0, "SOL": 100.0, "NEAR": 5.0, "XAUT": 2_500.0}
    return pd.DataFrame({a: v * (mult if a in CRYPTO else 1.0) for a, v in base.items()}, index=idx)


def funding(p: pd.DataFrame, hourly: float) -> pd.DataFrame:
    return pd.DataFrame({a: hourly for a in CRYPTO}, index=p.index)


@dataclass(frozen=True)
class ShortBTC(Strategy):
    name: str = "short-btc"

    def target(self, daily):
        return {"USDC": 1.0, perp("BTC"): -0.5}


# --- policy ------------------------------------------------------------------------------------

def test_perps_are_off_by_default():
    d = PolicyState(Policy()).check_perp(T0, "BTC", 100, 100, 100, 10_000)
    assert d.code == "policy_action_denied"


def test_leverage_cap_refuses_opening():
    s = PolicyState(Policy(actions=("swap", "perp"), max_leverage=2.0))
    assert s.check_perp(T0, "BTC", 500, 19_000, 500, 10_000).ok
    assert s.check_perp(T0, "BTC", 500, 21_000, 500, 10_000).code == "leverage_exceeded"


def test_unlisted_perp_market_refused():
    s = PolicyState(Policy(actions=("swap", "perp")))
    assert s.check_perp(T0, "PEPE", 100, 100, 100, 10_000).code == "policy_denied"


def test_frozen_agent_can_still_close_but_not_open():
    s = PolicyState(Policy(actions=("swap", "perp"), frozen=True))
    assert s.check_perp(T0, "BTC", 100, 0, 0, 10_000, reducing=True).ok
    assert s.check_perp(T0, "BTC", 100, 100, 100, 10_000).code == "wallet_frozen"


def test_agent_api_policy_never_lists_perp():
    assert "perp" not in Policy(actions=("swap", "perp")).to_agent_api({a: a for a in Policy().assets})["actions"]


# --- engine ------------------------------------------------------------------------------------

def test_short_perp_profits_when_price_falls():
    p = prices(40, slope=-0.01)
    res = run(p, [ShortBTC()], mandate=ALL_CRYPTO, policy=PERPS, rules=ALWAYS)
    assert res.metrics["perp_trades"] > 0
    assert res.metrics["end_equity"] > res.metrics["start_equity"]


def test_short_receives_positive_funding():
    p = prices(40)
    base = run(p, [ShortBTC()], mandate=ALL_CRYPTO, policy=PERPS, rules=ALWAYS, funding=funding(p, 0.0))
    paid = run(p, [ShortBTC()], mandate=ALL_CRYPTO, policy=Policy(actions=("swap", "perp"), per_transaction_usd=1e9, daily_usd=1e9),
               rules=ALWAYS, funding=funding(p, 0.0001))
    assert paid.metrics["funding_usd"] > 0
    assert paid.metrics["end_equity"] > base.metrics["end_equity"]


def test_perp_orders_refused_without_permission():
    p = prices(20, slope=-0.01)  # falling, so the short earns a record and gets capital
    res = run(p, [ShortBTC()], mandate=ALL_CRYPTO, policy=Policy(per_transaction_usd=1e9, daily_usd=1e9), rules=ALWAYS)
    assert res.metrics["perp_trades"] == 0
    assert any(e.kind == "refused" and e.data.get("code") == "policy_action_denied" for e in res.events)


def test_leverage_stays_under_the_cap():
    p = prices(30, slope=-0.01)
    res = run(p, [ShortBTC()], mandate=ALL_CRYPTO, rules=ALWAYS,
              policy=Policy(actions=("swap", "perp"), per_transaction_usd=1e9, daily_usd=1e9, max_leverage=0.3))
    assert res.metrics["max_leverage"] <= 0.31  # the over-cap order is refused whole, not filled partly
    assert any(e.data.get("code") == "leverage_exceeded" for e in res.events)


# --- strategies --------------------------------------------------------------------------------

def test_funding_carry_is_delta_neutral_and_waits_for_funding():
    p = prices(30)
    hot = daily_closes(p, funding(p, 0.0001))  # ~88% APR
    cold = daily_closes(p, funding(p, 0.0))
    w = FundingCarry().target(hot)
    assert w["BTC"] == -w[perp("BTC")] > 0
    assert perp("BTC") not in FundingCarry().target(cold)


def test_carry_record_earns_funding_in_a_flat_market():
    p = prices(60)
    rec = shadow_returns(FundingCarry(), daily_closes(p, funding(p, 0.0001)), Costs())
    assert (1 + rec).prod() > 1.05


def test_trend_longshort_shorts_below_average():
    p = prices(150, slope=-0.003)
    w = TrendLongShort().target(daily_closes(p))
    assert w[perp("BTC")] < 0 and w.get("BTC", 0.0) == 0.0


# --- script binding (NFT) ----------------------------------------------------------------------

def test_code_hash_changes_with_parameters_and_is_stable():
    assert TrendFilter().code_hash == TrendFilter().code_hash
    assert TrendFilter().code_hash != TrendFilter(window=50).code_hash
    assert len(TrendFilter().code_hash) == 64


def test_every_script_in_the_catalog_has_a_unique_hash():
    hashes = [s.code_hash for s in catalog()]
    assert len(set(hashes)) == len(hashes)


def test_rebalance_does_not_churn_perps():
    """Regression: shrinking then growing in one rebalance used to replay a stale delta."""
    p = prices(40, slope=-0.01)
    res = run(p, [ShortBTC()], mandate=ALL_CRYPTO, policy=PERPS, rules=ALWAYS)
    assert res.metrics["perp_volume_usd"] < 3 * res.metrics["start_equity"]


# --- fees --------------------------------------------------------------------------------------

def test_fees_only_on_new_profit_and_split_5_and_0_25():
    from pilot.fees import HighWaterMark
    h = HighWaterMark(10_000)
    c = h.charge(11_000, {"a@v1": 1.0})
    assert round(c.to_holders["a@v1"], 6) == 50.0 and round(c.to_platform, 6) == 2.5
    assert h.charge(10_500, {"a@v1": 1.0}).total == 0  # below the peak: nothing
    assert h.charge(10_947, {"a@v1": 1.0}).total == 0  # peak is 10_947.50 after fees
    assert round(h.charge(11_947.5, {"a@v1": 1.0}).profit, 6) == 1_000


def test_own_script_pays_only_pilot():
    from pilot.fees import HighWaterMark
    c = HighWaterMark(10_000).charge(11_000, {"mine@v1": 1.0}, own=frozenset({"mine@v1"}))
    assert c.to_holders == {} and round(c.to_platform, 6) == 2.5


def test_referral_takes_0_1_out_of_pilots_share():
    from pilot.fees import HighWaterMark
    c = HighWaterMark(10_000).charge(11_000, {"a@v1": 1.0}, referred=True)
    assert round(c.to_referrer, 6) == 1.0 and round(c.to_platform, 6) == 1.5 and round(c.total, 6) == 52.5


def test_catalog_is_ten_distinct_systems():
    from pilot.strategies import catalog
    ids = [s.id for s in catalog()]
    assert len(ids) == 10 and len(set(ids)) == 10
    assert "dip-averager@v1" not in ids and "trend-sma@v1" not in ids


def test_new_scripts_return_valid_weights():
    from pilot.strategies import catalog
    p = prices(400, slope=0.001)
    d = daily_closes(p, funding(p, 0.0002))
    for s in catalog():
        w = s.target(d)
        spot = sum(v for k, v in w.items() if not k.endswith("-PERP"))
        assert abs(spot - 1) < 1e-9, s.id
        assert all(abs(v) <= 1 for v in w.values()), s.id


def test_per_script_copy_fee():
    import pytest
    from pilot.fees import HighWaterMark
    c = HighWaterMark(10_000).charge(11_000, {"a@v1": 0.5, "b@v1": 0.5}, rates={"a@v1": 0.10, "b@v1": 0.0})
    assert round(c.to_holders["a@v1"], 6) == 50.0 and "b@v1" not in c.to_holders
    with pytest.raises(ValueError):
        HighWaterMark(10_000).charge(11_000, {"a@v1": 1.0}, rates={"a@v1": 0.2})
