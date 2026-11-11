from dataclasses import dataclass

import numpy as np
import pandas as pd

from pilot.engine import daily_closes
from pilot.health import check
from pilot.policy import HOUR_MS
from pilot.strategies import Strategy, catalog

T0 = 1_735_689_600_000


def daily(days=200):
    idx = T0 + np.arange(days * 24) * HOUR_MS
    m = 1 + 0.001 * np.arange(days * 24) / 24 + 0.02 * np.sin(np.arange(days * 24) / 200)
    p = pd.DataFrame({"BTC": 50_000 * m, "ETH": 3_000 * m, "SOL": 100 * m, "NEAR": 5 * m, "XAUT": 2_500.0}, index=idx)
    return daily_closes(p, pd.DataFrame({a: 0.00001 for a in ("BTC", "ETH", "SOL", "NEAR")}, index=idx))


@dataclass(frozen=True)
class Crashes(Strategy):
    name: str = "crashes"

    def target(self, d):
        raise ZeroDivisionError("boom")


@dataclass(frozen=True)
class BadWeights(Strategy):
    name: str = "bad"

    def target(self, d):
        return {"BTC": float("nan"), "USDC": 1.0}


def test_healthy_catalog_passes():
    d = daily()
    rep = check(int(d.index[-1]), d, catalog())
    assert all(rep.status(s.id) != "stop" for s in catalog())


def test_crash_bad_weights_and_stale_data_stop_the_script():
    d = daily()
    rep = check(int(d.index[-1]) + 48 * HOUR_MS, d, [Crashes(), BadWeights()])
    assert rep.status("crashes@v1") == "stop" and rep.status("bad@v1") == "stop"
    assert any(f.check == "stale_data" for f in rep.findings)


def test_live_drift_and_refusals_are_reported():
    d = daily()
    s = catalog()[0]
    rep = check(int(d.index[-1]), d, [s], live_week={s.id: -0.06}, sim_week={s.id: 0.01}, refused={s.id: 2})
    checks = {f.check: f.severity for f in rep.findings}
    assert checks["drift"] == "stop" and checks["refused"] == "warn"
