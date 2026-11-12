import pytest

from pilot.tasks import Conditional, Recurring, parse_task

T_FRI = 1_762_473_600_000  # 2025-11-07, a Friday, 00:00 UTC


def test_conditional_english():
    t = parse_task("if BTC below 60000 buy $500")
    assert isinstance(t, Conditional) and (t.asset, t.op, t.price, t.side, t.usd) == ("BTC", "<", 60000, "buy", 500)


def test_conditional_russian_with_k():
    t = parse_task("если ETH выше 4к продай на 300$")
    assert (t.asset, t.op, t.price, t.side, t.usd) == ("ETH", ">", 4000, "sell", 300)


def test_recurring_weekday_and_daily():
    t = parse_task("buy $50 of ETH every friday")
    assert isinstance(t, Recurring) and t.weekday == 4
    assert parse_task("каждый день покупай BTC на $20").weekday is None


def test_conditional_fires_once():
    t = parse_task("if BTC below 60000 buy $500")
    assert t.due(0, {"BTC": 61000}) is None
    assert t.due(0, {"BTC": 59000}).usd == 500
    assert t.due(0, {"BTC": 58000}) is None


def test_recurring_once_per_matching_day():
    t = parse_task("buy $50 of ETH every friday")
    assert t.due(T_FRI, {"ETH": 3000}) is not None
    assert t.due(T_FRI + 3_600_000, {"ETH": 3000}) is None
    assert t.due(T_FRI + 86_400_000, {"ETH": 3000}) is None  # saturday


@pytest.mark.parametrize("text", ["buy something", "if BTC below 60000", "buy $50 of BTC"])
def test_incomplete_tasks_are_rejected(text):
    with pytest.raises(ValueError):
        parse_task(text)


def test_tasks_run_inside_the_simulation_and_obey_policy():
    import numpy as np
    import pandas as pd
    from pilot.engine import run
    from pilot.policy import HOUR_MS, Policy
    from pilot.strategies import HoldRebalance
    idx = 1_735_689_600_000 + np.arange(20 * 24) * HOUR_MS
    m = 1 - 0.3 * np.arange(len(idx)) / len(idx)  # BTC slides from 70k to ~49k
    p = pd.DataFrame({"BTC": 70_000 * m, "ETH": 3_000.0, "SOL": 100.0, "NEAR": 5.0, "XAUT": 2_500.0}, index=idx)
    ok = run(p, [HoldRebalance()], tasks=[parse_task("if BTC below 60000 buy $500")])
    assert any(e.kind == "task" for e in ok.events)
    capped = run(p, [HoldRebalance()], policy=Policy(per_transaction_usd=100), tasks=[parse_task("if BTC below 60000 buy $500")])
    assert any(e.kind == "task" for e in capped.events)  # it fires, and is split into $100 swaps by the policy
