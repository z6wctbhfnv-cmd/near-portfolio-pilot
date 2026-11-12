import numpy as np
import pandas as pd
import pytest

from pilot.engine import ReviewRules, Supervisor, daily_closes
from pilot.policy import HOUR_MS
from pilot.script_settings import TradingSettings, parse_schema, tuned
from pilot.strategies import TrendLongShort

SCHEMA = '[{"name":"target_vol","min":0.1,"max":1,"default":0.4},{"name":"short_size","min":0,"max":1,"default":0.5}]'


def test_copier_tunes_only_open_params_in_range():
    s = TrendLongShort()
    v = tuned(s, parse_schema(SCHEMA), {"target_vol": 0.2})
    assert v.target_vol == 0.2 and v.id == s.id
    with pytest.raises(ValueError):
        tuned(s, parse_schema(SCHEMA), {"target_vol": 3})
    with pytest.raises(ValueError):
        tuned(s, parse_schema(SCHEMA), {"window": 10})  # not opened by the holder


def test_trading_settings_trim_weights():
    w = {"BTC": 0.6, "ETH": 0.2, "USDC": 0.2, "SOL-PERP": -0.5, "ETH-PERP": 0.4}
    t = TradingSettings(max_asset=0.3, allow_shorts=False, max_leverage=0.2).apply(w)
    assert t["BTC"] == 0.3 and t["SOL-PERP"] == 0.0 and abs(t["ETH-PERP"] - 0.2) < 1e-9
    assert abs(t["USDC"] - 0.5) < 1e-9


def test_funding_guard_drops_long_perps_when_funding_is_hot():
    idx = 1_735_689_600_000 + np.arange(10 * 24) * HOUR_MS
    p = pd.DataFrame({"BTC": 50_000.0, "ETH": 3_000.0, "SOL": 100.0, "NEAR": 5.0, "XAUT": 2_500.0}, index=idx)
    d = daily_closes(p, pd.DataFrame({a: 0.0001 for a in ("BTC", "ETH", "SOL", "NEAR")}, index=idx))  # ~88%/yr
    t = TradingSettings(funding_cap_apr=0.3).apply({"BTC-PERP": 0.5, "USDC": 1.0}, d)
    assert t["BTC-PERP"] == 0.0


def test_settings_are_validated():
    with pytest.raises(ValueError):
        TradingSettings(order_type="yolo")
    with pytest.raises(ValueError):
        TradingSettings(trading_hours_utc=(20, 8))


def test_supervisor_trades_the_variant_but_reviews_the_original():
    s = TrendLongShort()
    v = tuned(s, parse_schema(SCHEMA), {"short_size": 0.0})
    sup = Supervisor([s], ReviewRules(select="manual", manual_weights=((s.id, 1.0),)), {s.id: v})
    assert sup.trade_with[s.id].short_size == 0.0 and sup.strategies[s.id].short_size == 0.5
