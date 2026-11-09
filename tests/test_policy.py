import pytest

from pilot.policy import DAY_MS, HOUR_MS, Mandate, Policy, PolicyState

T0 = 1_700_000_000_000


def state(**kw) -> PolicyState:
    return PolicyState(Policy(**kw), period_start=T0)


def test_allows_a_normal_swap():
    assert state().check(T0, "swap", "USDC", "BTC", 500).ok


def test_frozen_agent_refuses_everything():
    d = state(frozen=True).check(T0, "swap", "USDC", "BTC", 1)
    assert (d.ok, d.code) == (False, "wallet_frozen")


def test_withdraw_is_not_an_allowed_action():
    d = state().check(T0, "withdraw", "USDC", "USDC", 10, destination="attacker.near")
    assert d.code == "policy_action_denied"


def test_destination_must_be_listed():
    s = state(actions=("swap", "withdraw"), destinations=frozenset({"owner.near"}))
    assert s.check(T0, "withdraw", "USDC", "USDC", 10, destination="owner.near").ok
    assert s.check(T0, "withdraw", "USDC", "USDC", 10, destination="attacker.near").code == "policy_denied"


def test_cannot_sell_unlisted_asset_but_can_buy_it():
    s = state(assets=frozenset({"USDC"}))
    assert s.check(T0, "swap", "USDC", "PEPE", 10).ok
    assert s.check(T0, "swap", "PEPE", "USDC", 10).code == "policy_denied"


def test_per_transaction_limit():
    assert state(per_transaction_usd=100).check(T0, "swap", "USDC", "BTC", 100.01).code == "policy_limit_exceeded"


def test_daily_budget_counts_gross_volume_and_resets_on_fixed_period():
    s = state(daily_usd=1000, per_transaction_usd=1000)
    s.record(T0, 900)
    assert s.check(T0 + HOUR_MS, "swap", "USDC", "BTC", 200).code == "spend_budget_exceeded"
    assert s.check(T0 + HOUR_MS, "swap", "USDC", "BTC", 100).ok
    assert s.check(T0 + DAY_MS, "swap", "USDC", "BTC", 1000).ok  # new period, whole cap is back


def test_actions_per_hour():
    s = state(max_actions_per_hour=2)
    s.record(T0, 1)
    s.record(T0 + 1, 1)
    assert s.check(T0 + 2, "swap", "USDC", "BTC", 1).code == "policy_action_limit_exceeded"
    assert s.check(T0 + HOUR_MS + 2, "swap", "USDC", "BTC", 1).ok


def test_agent_api_policy_shape():
    p = Policy(daily_usd=200).to_agent_api({a: f"nep141:{a.lower()}" for a in Policy().assets})
    assert p["actions"] == ["swap"]
    assert p["destinations"] == {"mode": "only", "list": []}  # nothing can leave the wallet
    assert p["budget"]["daily_usd"] == "200.00"
    assert set(p) >= {"frozen", "actions", "confidential", "owner_approval", "assets", "limits",
                      "max_actions_per_hour", "destinations", "budget", "timelock_ms"}


def test_mandate_weights_must_sum_to_one():
    with pytest.raises(ValueError):
        Mandate(stable_weight=0.5, gold_weight=0.5, crypto_weight=0.5)
