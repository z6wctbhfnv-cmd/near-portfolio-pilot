import pytest

from pilot.rules import compile_rules

DEMO = ("50% in stablecoins earning yield, 10% gold, 40% crypto. "
        "Max drawdown 10%. At most $1,000 per trade. Never send funds out.")


def test_demo_rules():
    c = compile_rules(DEMO)
    m = c.mandate
    assert (m["stable_weight"], m["gold_weight"], m["crypto_weight"]) == (0.5, 0.1, 0.4)
    assert m["max_drawdown"] == 0.10
    assert c.policy["actions"] == ["swap"]
    assert c.policy["destinations"] == {"mode": "only", "list": []}
    assert c.warnings == []


def test_missing_weights_go_to_stablecoins_with_a_warning():
    c = compile_rules("30% crypto, drawdown 15%, never send anything out")
    assert c.mandate["stable_weight"] == 0.7 and c.mandate["crypto_weight"] == 0.3
    assert any("stablecoins" in w for w in c.warnings)


def test_over_100_percent_is_rejected():
    with pytest.raises(ValueError):
        compile_rules("80% crypto and 40% stablecoins")


def test_withdraw_destination_is_listed():
    c = compile_rules("20% gold, withdraw only to alex.near, drawdown 8%")
    assert "withdraw" in c.policy["actions"]
    assert c.policy["destinations"]["list"][0]["address"] == "alex.near"


def test_tight_budget_warns_about_blocked_emergency_exit():
    c = compile_rules("40% crypto, max $500 per day, never send funds out", portfolio_usd=10_000)
    assert any("could not sell everything" in w for w in c.warnings)


def test_russian_rules():
    c = compile_rules("60% в стейблах, 10% золото, 30% крипта, просадка не больше 12%, никуда не выводить")
    assert (c.mandate["stable_weight"], c.mandate["gold_weight"]) == (0.6, 0.1)
    assert c.mandate["max_drawdown"] == 0.12


def test_drawdown_mode_from_words():
    from pilot.rules import compile_rules
    assert compile_rules("50% usdc, 50% crypto, never lose more than 10% from the all-time peak").mandate["drawdown_mode"] == "from_peak"
    assert compile_rules("70% stablecoins, 30% crypto, max drawdown 8%, never send funds out").mandate["drawdown_mode"] == "episode"


def test_single_coins_add_up_to_the_crypto_part():
    c = compile_rules("Осторожно: 40% NEAR, 30% BTC, остальное в USDC, не больше $300 в день")
    assert (c.mandate["stable_weight"], c.mandate["crypto_weight"]) == (0.3, 0.7)
    assert any("add up to 70% crypto" in w for w in c.warnings)
    assert compile_rules("40% NEAR 30% BTC").mandate["crypto_weight"] == 0.7
    assert compile_rules("40% crypto: 20% BTC, 20% ETH").mandate["crypto_weight"] == 0.4


def test_text_with_no_rule_is_refused():
    with pytest.raises(ValueError, match="couldn't find any rule"):
        compile_rules("asdf qwer")


def test_drawdown_stop_defaults_to_20_and_can_be_switched_off():
    assert compile_rules("40% crypto, never send funds out").mandate["max_drawdown"] == 0.2
    assert compile_rules("40% crypto, no stop").mandate["drawdown_mode"] == "off"
    assert compile_rules("40% crypto, без стоп-лосса").mandate["drawdown_mode"] == "off"
    assert compile_rules("40% crypto, drawdown 15%").mandate["max_drawdown"] == 0.15
