import pytest

from pilot.engine import ReviewRules, Supervisor
from pilot.strategies import catalog
from pilot.tuning import set_params, tune

KNOWN = [s.id for s in catalog()]


def test_pin_by_short_name():
    t = tune("only trend-longshort", KNOWN)
    assert t.rules.pinned == ("trend-longshort@v1",)


def test_exclude_and_no_perps_in_russian():
    t = tune("никогда не бери momentum-top2. без фьючерсов", KNOWN)
    assert t.rules.excluded == ("momentum-top2@v1",)
    assert t.rules.allow_perps is False


def test_drawdown_window_and_cap():
    t = tune("skip scripts with drawdown over 20%; judge on 12 weeks; max 40% per script", KNOWN)
    assert t.rules.max_record_drawdown == 0.20
    assert t.rules.window_days == 84
    assert t.rules.max_weight == 0.40


def test_unknown_text_changes_nothing():
    t = tune("make me rich", KNOWN)
    assert t.rules == ReviewRules() and t.warnings


def test_sliders_are_range_checked():
    assert set_params(ReviewRules(), max_weight=0.3).rules.max_weight == 0.3
    with pytest.raises(ValueError):
        set_params(ReviewRules(), max_weight=3)
    with pytest.raises(ValueError):
        set_params(ReviewRules(), leverage=10)


def test_supervisor_respects_pin_and_no_perps():
    import pandas as pd
    strategies = catalog()
    sup = Supervisor(strategies, tune("only funding-carry", KNOWN).rules)
    sup.review(0, {s.id: pd.Series(dtype=float) for s in strategies})
    assert sup.alloc == {"funding-carry@v1": 1.0}
    sup2 = Supervisor(strategies, tune("no perps", KNOWN).rules)
    assert not sup2.eligible("trend-longshort@v1") and sup2.eligible("donchian-breakout@v1")
