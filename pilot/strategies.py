"""Deterministic strategies for the crypto sleeve. No LLM, no randomness.

Each strategy sees daily closes up to and including the decision day and returns target weights
over CRYPTO + "USDC" that sum to 1. Each one would be minted as a strategy NFT (id = name@version).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

CRYPTO = ("BTC", "ETH", "SOL", "NEAR")


def _normalize(w: dict[str, float]) -> dict[str, float]:
    w = {k: max(0.0, v) for k, v in w.items()}
    risky = sum(v for k, v in w.items() if k != "USDC")
    if risky > 1:
        w = {k: (v / risky if k != "USDC" else 0.0) for k, v in w.items()}
        risky = 1.0
    w["USDC"] = 1.0 - risky
    return w


@dataclass(frozen=True)
class Strategy:
    name: str
    version: str = "v1"

    @property
    def id(self) -> str:
        return f"{self.name}@{self.version}"

    def target(self, daily: pd.DataFrame) -> dict[str, float]:  # pragma: no cover - interface
        raise NotImplementedError


@dataclass(frozen=True)
class HoldRebalance(Strategy):
    """Fixed weights, rebalanced. The baseline every other strategy must beat."""

    name: str = "hold-rebalance"
    weights: tuple[tuple[str, float], ...] = (("BTC", 0.5), ("ETH", 0.3), ("SOL", 0.2))

    def target(self, daily):
        return _normalize(dict(self.weights))


@dataclass(frozen=True)
class TrendFilter(Strategy):
    """Hold an asset only while its close is above its moving average; otherwise cash."""

    name: str = "trend-sma"
    window: int = 100
    weights: tuple[tuple[str, float], ...] = (("BTC", 0.5), ("ETH", 0.3), ("SOL", 0.2))

    def target(self, daily):
        w = {}
        for a, base in self.weights:
            s = daily[a]
            w[a] = base if len(s) >= self.window and s.iloc[-1] > s.iloc[-self.window:].mean() else 0.0
        return _normalize(w)


@dataclass(frozen=True)
class MomentumRotation(Strategy):
    """Hold the top-k assets by past return, only if that return is positive."""

    name: str = "momentum-top2"
    lookback: int = 60
    k: int = 2

    def target(self, daily):
        if len(daily) <= self.lookback:
            return _normalize({})
        ret = daily[list(CRYPTO)].iloc[-1] / daily[list(CRYPTO)].iloc[-1 - self.lookback] - 1
        top = [a for a in ret.sort_values(ascending=False).index[: self.k] if ret[a] > 0]
        return _normalize({a: 1.0 / self.k for a in top})


@dataclass(frozen=True)
class DipAverager(Strategy):
    """Averaging in: base weight scaled up when price is below its average, down when above."""

    name: str = "dip-averager"
    window: int = 30
    base: float = 0.5
    weights: tuple[tuple[str, float], ...] = (("BTC", 0.6), ("ETH", 0.4))

    def target(self, daily):
        w = {}
        for a, share in self.weights:
            s = daily[a]
            if len(s) < self.window:
                w[a] = self.base * share
                continue
            dev = s.iloc[-1] / s.iloc[-self.window:].mean() - 1  # e.g. -0.10 = 10% below average
            scale = float(np.clip(1 - 4 * dev, 0.0, 2.0))  # 10% below -> 1.4x, 10% above -> 0.6x
            w[a] = self.base * share * scale
        return _normalize(w)


@dataclass(frozen=True)
class VolTarget(Strategy):
    """BTC/ETH sized to a target annualised volatility."""

    name: str = "vol-target"
    target_vol: float = 0.35
    window: int = 30

    def target(self, daily):
        if len(daily) <= self.window:
            return _normalize({"BTC": 0.3, "ETH": 0.2})
        r = daily[["BTC", "ETH"]].pct_change().iloc[-self.window:]
        port = 0.6 * r["BTC"] + 0.4 * r["ETH"]
        vol = float(port.std() * np.sqrt(365))
        lev = min(1.0, self.target_vol / vol) if vol > 0 else 1.0
        return _normalize({"BTC": 0.6 * lev, "ETH": 0.4 * lev})


def catalog() -> list[Strategy]:
    """The strategies the pilot can hire. In the product each one is an NFT with on-chain history."""
    return [HoldRebalance(), TrendFilter(), MomentumRotation(), DipAverager(), VolTarget()]
