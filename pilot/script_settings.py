"""Per-script settings an agent's owner applies to a script, own or copied.

Two kinds, matching the product rule "only logic and assets reset a script's record":

1. Open parameters: logic parameters the script's holder chose to expose (name, range, default),
   published on the NFT without the code. A copier may tune them within the ranges. The public record
   stays measured at the holder's defaults; the copier's tuned variant affects only the copier's money.
2. Trading settings (sections 3-5 on the site): size and risk, execution, schedule. They change how the
   script trades for this owner, never the script itself, and never its public record.

The simulation applies what it can model (asset and leverage caps, shorts, a funding guard, minimum
trade). Order type, slippage limit and trading hours apply at live execution.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, fields, replace

from .strategies import FUND, PERP, Strategy


@dataclass(frozen=True)
class OpenParam:
    name: str
    min: float
    max: float
    default: float
    label: str = ""
    step: float | None = None


def parse_schema(schema: str | list) -> list[OpenParam]:
    items = json.loads(schema) if isinstance(schema, str) else schema
    out = []
    for x in items:
        p = OpenParam(str(x["name"]), float(x["min"]), float(x["max"]), float(x["default"]), x.get("label", ""), x.get("step"))
        if not p.min <= p.default <= p.max:
            raise ValueError(f"{p.name}: default outside its range")
        out.append(p)
    return out


def tuned(strategy: Strategy, schema: list[OpenParam], values: dict[str, float]) -> Strategy:
    """The copier's variant: only parameters the holder opened, only inside their ranges."""
    allowed = {p.name: p for p in schema}
    own = {f.name for f in fields(strategy)}
    changes = {}
    for k, v in values.items():
        if k not in allowed:
            raise ValueError(f"'{k}' is not a parameter the holder opened")
        p = allowed[k]
        if not p.min <= float(v) <= p.max:
            raise ValueError(f"{k}={v} outside {p.min}..{p.max}")
        if k not in own:
            raise ValueError(f"script has no parameter '{k}'")
        changes[k] = type(getattr(strategy, k))(v)
    return replace(strategy, **changes) if changes else strategy


@dataclass(frozen=True)
class TradingSettings:
    # Size and risk
    max_asset: float | None = None  # max |weight| of one asset inside this script (share of its capital)
    max_leverage: float | None = None  # max gross perp exposure inside this script
    allow_shorts: bool = True
    position_stop: float | None = None  # applies live: close a position after this loss
    take_profit: float | None = None  # applies live
    trailing_stop: float | None = None  # applies live
    # Execution
    funding_cap_apr: float | None = None  # don't hold long perps while funding (3-day avg) is above this
    min_trade_usd: float = 1.0
    order_type: str = "market"  # market | limit | twap (applies live)
    max_slippage: float = 0.003  # applies live
    # Schedule
    cadence_hours: int = 24  # applies live; the simulation runs on daily closes
    trading_hours_utc: tuple[int, int] = (0, 24)  # applies live

    def __post_init__(self) -> None:
        if self.order_type not in ("market", "limit", "twap"):
            raise ValueError("order_type must be market, limit or twap")
        for name in ("max_asset", "max_leverage", "position_stop", "take_profit", "trailing_stop"):
            v = getattr(self, name)
            if v is not None and not 0 < v <= (3 if name == "max_leverage" else 1):
                raise ValueError(f"{name} out of range")
        if not 1 <= self.cadence_hours <= 168:
            raise ValueError("cadence_hours must be 1..168")
        a, b = self.trading_hours_utc
        if not 0 <= a < b <= 24:
            raise ValueError("trading_hours_utc must be (start, end) with 0 <= start < end <= 24")

    def apply(self, w: dict[str, float], daily=None) -> dict[str, float]:
        """Trim one script's target weights to these settings. Trimmed exposure goes to USDC."""
        w = dict(w)
        for k in list(w):
            if k == "USDC":
                continue
            if k.endswith(PERP) and w[k] < 0 and not self.allow_shorts:
                w[k] = 0.0
            if self.max_asset is not None:
                w[k] = max(-self.max_asset, min(self.max_asset, w[k]))
            if (self.funding_cap_apr is not None and k.endswith(PERP) and w[k] > 0 and daily is not None
                    and k[: -len(PERP)] + FUND in daily and len(daily) >= 3):
                apr = float(daily[k[: -len(PERP)] + FUND].iloc[-3:].mean()) * 365
                if apr > self.funding_cap_apr:
                    w[k] = 0.0
        if self.max_leverage is not None:
            gross = sum(abs(v) for k, v in w.items() if k.endswith(PERP))
            if gross > self.max_leverage:
                f = self.max_leverage / gross
                for k in w:
                    if k.endswith(PERP):
                        w[k] *= f
        spot = sum(v for k, v in w.items() if not k.endswith(PERP) and k != "USDC")
        w["USDC"] = max(0.0, 1.0 - spot)
        return w
