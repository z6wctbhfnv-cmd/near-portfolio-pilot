import numpy as np
import pandas as pd
import pytest

from pilot.engine import daily_closes
from pilot.policy import HOUR_MS
from pilot.scriptgen import UnsafeScript, UserScript, backtest, check_source

GOOD = '''
def target(daily):
    s = daily["BTC"]
    if len(s) < 20:
        return {"USDC": 1.0}
    if s.iloc[-1] > s.iloc[-20:].mean():
        return {"BTC": 0.6, "USDC": 0.4}
    return {"BTC-PERP": -0.3, "USDC": 1.0}
'''


def prices(days=120):
    idx = 1_735_689_600_000 + np.arange(days * 24) * HOUR_MS
    m = 1 + 0.002 * np.arange(days * 24) / 24
    return pd.DataFrame({"BTC": 50_000 * m, "ETH": 3_000 * m, "SOL": 100 * m, "NEAR": 5 * m, "XAUT": 2_500.0}, index=idx)


def test_good_script_backtests_and_hashes():
    s = UserScript(name="my-trend", source=GOOD)
    r = backtest(s, daily_closes(prices()))
    assert r["uses_perps"] and len(r["code_hash"]) == 64 and r["return"] > 0


@pytest.mark.parametrize("src", [
    "import os\ndef target(daily):\n    return {}",
    "def target(daily):\n    return __import__('os').system('x')",
    "def target(daily):\n    return daily.__class__",
    "def target(daily):\n    open('/etc/passwd')\n    return {}",
    "def target(daily):\n    daily.to_csv('/tmp/x')\n    return {}",
    "def target(daily):\n    return eval('1')",
    "x = 1\ndef target(daily):\n    return {}",
    "class A: pass",
    "def target(daily):\n    return (lambda: 1)()",
])
def test_unsafe_scripts_are_rejected(src):
    with pytest.raises((UnsafeScript, NameError, SyntaxError)):
        s = UserScript(name="bad", source=src)
        check_source(src)
        s.target(daily_closes(prices(5)))


def test_output_keys_are_checked():
    s = UserScript(name="bad", source="def target(daily):\n    return {'DOGE': 1.0}")
    with pytest.raises(UnsafeScript):
        s.target(daily_closes(prices(5)))


def test_hash_changes_with_any_edit():
    assert UserScript(source=GOOD).code_hash != UserScript(source=GOOD.replace("20", "21")).code_hash


def test_nearai_draft_retries_with_checker_feedback(monkeypatch):
    from pilot import nearai
    replies = iter(["```python\nimport os\ndef target(daily):\n    return {}\n```", GOOD])
    seen = []
    monkeypatch.setattr(nearai, "_chat", lambda msgs, key=None: (seen.append(msgs[-1]["content"]), next(replies))[1])
    code = nearai.draft_script("trend on BTC", api_key="x")
    assert "def target" in code and "import" not in code
    assert "Rejected by the checker" in seen[-1]
