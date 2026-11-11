"""Deterministic strategies for the crypto sleeve. No LLM, no randomness.

Each strategy sees daily closes up to and including the decision day and returns target weights
over CRYPTO + "USDC" that sum to 1, plus optional signed perp weights under "<ASSET>-PERP"
(negative = short). Perp weights are notional as a share of the sleeve; their margin sits in USDC.

Each strategy is one script, and one script is one strategy NFT: the NFT stores `code_hash`, a sha256
over the strategy's source and parameters. Change a line or a parameter and the hash changes, so it is
a new script and needs a new NFT; an old track record can never be claimed by different code.
"""
from __future__ import annotations

import hashlib
import inspect
from dataclasses import dataclass, fields

import numpy as np
import pandas as pd

CRYPTO = ("BTC", "ETH", "SOL", "NEAR")
SPOT = (*CRYPTO, "XAUT")  # assets a script may hold spot; gold is the defensive asset
PERP = "-PERP"  # target key suffix for a perp position, e.g. "BTC-PERP"
FUND = "-FUND"  # daily frame column suffix: funding paid by longs over that day, e.g. "BTC-FUND"


def perp(asset: str) -> str:
    return asset + PERP


def _normalize(w: dict[str, float]) -> dict[str, float]:
    perps = {k: max(-1.0, min(1.0, v)) for k, v in w.items() if k.endswith(PERP)}
    w = {k: max(0.0, v) for k, v in w.items() if not k.endswith(PERP)}
    risky = sum(v for k, v in w.items() if k != "USDC")
    if risky > 1:
        w = {k: (v / risky if k != "USDC" else 0.0) for k, v in w.items()}
        risky = 1.0
    w["USDC"] = 1.0 - risky
    w.update(perps)
    return w


@dataclass(frozen=True)
class Strategy:
    name: str
    version: str = "v1"

    @property
    def id(self) -> str:
        return f"{self.name}@{self.version}"

    @property
    def code_hash(self) -> str:
        """sha256 (hex) of the script: class source plus every parameter value. The NFT is bound to it."""
        src = inspect.getsource(type(self))
        params = ";".join(f"{f.name}={getattr(self, f.name)!r}" for f in fields(self) if f.compare)
        return hashlib.sha256(f"{src}\n{params}".encode()).hexdigest()

    @property
    def uses_perps(self) -> bool:
        return False

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


@dataclass(frozen=True)
class TrendLongShort(Strategy):
    """Time-series momentum, long or short. Each asset's signal is the average sign of its 20, 60 and
    120-day returns; size is scaled to a target volatility, so calm trends get more, wild ones less.
    The family with the strongest evidence in crypto, after costs."""

    name: str = "trend-longshort"
    horizons: tuple[int, ...] = (20, 60, 120)
    target_vol: float = 0.40
    vol_window: int = 30
    assets: tuple[str, ...] = ("BTC", "ETH", "SOL")
    short_size: float = 0.5  # shorts at half size: crypto's long-run drift is up

    @property
    def uses_perps(self) -> bool:
        return True

    def target(self, daily):
        if len(daily) <= max(self.horizons):
            return _normalize({})
        w = {}
        per = 1.0 / len(self.assets)
        for a in self.assets:
            s = daily[a]
            sig = float(np.mean([np.sign(s.iloc[-1] / s.iloc[-1 - h] - 1) for h in self.horizons]))
            vol = float(s.pct_change().iloc[-self.vol_window:].std() * np.sqrt(365))
            size = per * min(1.0, self.target_vol / vol) if vol > 0 else 0.0
            if sig > 0:
                w[a] = size * sig
            elif sig < 0:
                w[perp(a)] = size * sig * self.short_size
        return _normalize(w)


@dataclass(frozen=True)
class FundingCarry(Strategy):
    """Delta-neutral: hold spot and short the same amount of perp while funding pays shorts.

    Price moves cancel out; the position earns the funding rate. It exits when the recent average
    funding falls below `min_apr`, so it never pays to hold the hedge.
    """

    name: str = "funding-carry"
    lookback: int = 7
    min_apr: float = 0.08
    size: float = 0.45  # per asset; spot + its margin must fit in the sleeve
    assets: tuple[str, ...] = ("BTC", "ETH")

    @property
    def uses_perps(self) -> bool:
        return True

    def target(self, daily):
        w = {}
        picked = []
        for a in self.assets:
            col = a + FUND
            if col not in daily or len(daily) < self.lookback:
                continue
            apr = float(daily[col].iloc[-self.lookback:].mean()) * 365
            if apr > self.min_apr:
                picked.append(a)
        for a in picked:
            w[a] = self.size
            w[perp(a)] = -self.size
        return _normalize(w)


@dataclass(frozen=True)
class MeanReversion(Strategy):
    """Buy short pullbacks inside an uptrend: long when an asset is above its 100-day average but fell
    more than `dip` over 3 days; out once the bounce is done. Never fights a downtrend."""

    name: str = "mean-reversion"
    trend: int = 100
    lookback: int = 3
    dip: float = 0.06
    assets: tuple[str, ...] = ("BTC", "ETH", "SOL")

    def target(self, daily):
        if len(daily) < self.trend:
            return _normalize({})
        w = {}
        for a in self.assets:
            s = daily[a]
            up = s.iloc[-1] > s.iloc[-self.trend:].mean()
            r = s.iloc[-1] / s.iloc[-1 - self.lookback] - 1
            if up and r < -self.dip:
                w[a] = 1.0 / len(self.assets)
        return _normalize(w)


@dataclass(frozen=True)
class EthBtcRelative(Strategy):
    """Market-neutral ETH vs BTC: long the stronger of the two over 30 days on spot, short the weaker
    by the same amount on perps. Bets on relative strength, not on a return to an old ratio."""

    name: str = "eth-btc-relative"
    lookback: int = 30
    size: float = 0.4

    @property
    def uses_perps(self) -> bool:
        return True

    def target(self, daily):
        if len(daily) <= self.lookback:
            return _normalize({})
        ratio = daily["ETH"] / daily["BTC"]
        strong, weak = ("ETH", "BTC") if ratio.iloc[-1] > ratio.iloc[-1 - self.lookback] else ("BTC", "ETH")
        return _normalize({strong: self.size, perp(weak): -self.size})


@dataclass(frozen=True)
class GoldCryptoStress(Strategy):
    """Crypto in calm markets, gold in stress. Stress = BTC below its 50-day average or its 30-day
    volatility in the top quarter of the past year. Moves to gold (XAUT), not to cash."""

    name: str = "gold-crypto-rotation"
    trend: int = 50
    vol_window: int = 30
    year: int = 365

    def target(self, daily):
        if len(daily) < self.trend + 1:
            return _normalize({})
        s = daily["BTC"]
        vol = s.pct_change().rolling(self.vol_window).std()
        hist = vol.iloc[-self.year:].dropna()
        stressed = s.iloc[-1] < s.iloc[-self.trend:].mean() or (len(hist) > 60 and vol.iloc[-1] > hist.quantile(0.75))
        return _normalize({"XAUT": 0.8} if stressed else {"BTC": 0.5, "ETH": 0.3})


@dataclass(frozen=True)
class DonchianBreakout(Strategy):
    """Breakout: long when price makes a 55-day high, out when it makes a 20-day low (the classic
    turtle rule), BTC, ETH and SOL. Catches crypto's big moves; quiet in ranges."""

    name: str = "donchian-breakout"
    entry: int = 55
    exit: int = 20
    assets: tuple[str, ...] = ("BTC", "ETH", "SOL")

    def target(self, daily):
        if len(daily) < self.entry + 1:
            return _normalize({})
        w = {}
        for a in self.assets:
            s = daily[a].iloc[-(self.entry * 3):]
            hi = s.rolling(self.entry).max()
            lo = s.rolling(self.exit).min()
            since_high = next((k for k in range(len(s)) if s.iloc[-1 - k] >= hi.iloc[-1 - k]), None)
            since_low = next((k for k in range(len(s)) if s.iloc[-1 - k] <= lo.iloc[-1 - k]), None)
            if since_high is not None and (since_low is None or since_high < since_low):
                w[a] = 1.0 / len(self.assets)
        return _normalize(w)


@dataclass(frozen=True)
class FundingReversion(Strategy):
    """Fade crowded perps: when longs pay extreme funding (3-day average above 30%/yr) go small short;
    when shorts pay (below -10%/yr) go small long. Flat otherwise. Different from carry: it bets on the
    crowd unwinding, not on collecting funding."""

    name: str = "funding-reversion"
    lookback: int = 3
    hot_apr: float = 0.30
    cold_apr: float = -0.10
    size: float = 0.3
    assets: tuple[str, ...] = ("BTC", "ETH", "SOL")

    @property
    def uses_perps(self) -> bool:
        return True

    def target(self, daily):
        w = {}
        for a in self.assets:
            col = a + FUND
            if col not in daily or len(daily) < self.lookback:
                continue
            apr = float(daily[col].iloc[-self.lookback:].mean()) * 365
            if apr > self.hot_apr:
                w[perp(a)] = -self.size / len(self.assets)
            elif apr < self.cold_apr:
                w[perp(a)] = self.size / len(self.assets)
        return _normalize(w)


def catalog(perps: bool = True) -> list[Strategy]:
    """The starting scripts. Each is a different system and a strategy NFT bound to its `code_hash`.
    hold-rebalance is the baseline every other script has to beat."""
    spot: list[Strategy] = [HoldRebalance(), MomentumRotation(), MeanReversion(), GoldCryptoStress(),
                            DonchianBreakout(), VolTarget()]
    with_perps: list[Strategy] = [TrendLongShort(), FundingCarry(), EthBtcRelative(), FundingReversion()]
    return spot + (with_perps if perps else [])
