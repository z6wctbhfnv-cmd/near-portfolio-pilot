"""Owner rules, mirrored from the NEAR Intents Agent API policy.

The real limits are enforced by the Agent API (see docs.agentsonintents.com, "Policies & Limits").
This module applies the same rules in the simulator and in the pilot before it sends a request,
so a refused action never reaches the API. Error codes match the API's `errors[].code`.
"""
from __future__ import annotations

from dataclasses import dataclass, field

DAY_MS = 86_400_000
HOUR_MS = 3_600_000


@dataclass
class Policy:
    """Subset of the Agent API policy the pilot relies on. Amounts in USD."""

    actions: tuple[str, ...] = ("swap",)  # add "perp" to allow perps; nothing leaves the wallet either way
    # The vault share must be listed too, or the agent could buy it but never sell it back.
    assets: frozenset[str] = frozenset({"USDC", "BTC", "ETH", "SOL", "NEAR", "XAUT", "VAULT_USDC"})
    per_transaction_usd: float = 1_000.0
    daily_usd: float = 5_000.0  # Agent API `budget.daily_usd`: gross swap volume per period
    max_actions_per_hour: int | None = 20
    destinations: frozenset[str] = frozenset()  # empty + mode "only" = nothing can be sent out
    frozen: bool = False
    # Perps (Hyperliquid via near.com / NEAR Intents). The agent trades with a Hyperliquid API wallet,
    # which can open and close positions but cannot withdraw, so the "nothing leaves" rule still holds.
    perp_assets: frozenset[str] = frozenset({"BTC", "ETH", "SOL", "NEAR"})
    max_leverage: float = 2.0  # gross perp notional / portfolio equity
    max_perp_notional_usd: float | None = None  # per-asset cap on |position|; None = only leverage applies

    def to_hyperliquid(self) -> dict:
        """Limits the pilot enforces before every Hyperliquid order (the venue itself only knows margin)."""
        return {
            "wallet": "api-wallet (trade only, no withdrawals)",
            "markets": sorted(self.perp_assets),
            "max_gross_leverage": self.max_leverage,
            "max_position_usd": self.max_perp_notional_usd,
            "max_order_usd": self.per_transaction_usd,
            "margin_mode": "cross, collateral USDC",
            "frozen": self.frozen,
        }

    def to_agent_api(self, asset_ids: dict[str, str]) -> dict:
        """Render the Agent API `policy` object. `asset_ids` maps symbols to NEAR Intents asset ids."""
        return {
            "frozen": self.frozen,
            "actions": [a for a in self.actions if a != "perp"],  # perps go to Hyperliquid, not the Agent API
            "confidential": True,
            "owner_approval": False,
            "assets": sorted(asset_ids[a] for a in self.assets),
            "limits": {},
            "max_actions_per_hour": self.max_actions_per_hour,
            "destinations": {"mode": "only", "list": sorted(self.destinations)},
            "budget": {"daily_usd": f"{self.daily_usd:.2f}", "weekly_usd": None, "monthly_usd": None},
            "timelock_ms": 0,
        }


@dataclass
class Decision:
    ok: bool
    code: str | None = None  # Agent API error code when refused
    reason: str = ""


@dataclass
class PolicyState:
    """Counters the Agent API keeps per agent. Budget periods are fixed from `period_start`, not rolling."""

    policy: Policy
    period_start: int = 0
    spent_usd: float = 0.0
    actions: list[int] = field(default_factory=list)

    def check(self, now_ms: int, action: str, asset_from: str, asset_to: str, usd: float,
              destination: str | None = None) -> Decision:
        p = self.policy
        if p.frozen:
            return Decision(False, "wallet_frozen", "agent is frozen by the owner")
        if action not in p.actions:
            return Decision(False, "policy_action_denied", f"action '{action}' is not allowed")
        if destination is not None and destination not in p.destinations:
            return Decision(False, "policy_denied", f"destination '{destination}' is not in the allow-list")
        # The Agent API lets a swap *buy* any asset but refuses selling an unlisted one.
        if asset_from not in p.assets:
            return Decision(False, "policy_denied", f"asset '{asset_from}' is not listed")
        if usd > p.per_transaction_usd + 1e-9:
            return Decision(False, "policy_limit_exceeded", f"${usd:,.2f} > per-transaction ${p.per_transaction_usd:,.2f}")
        self._roll(now_ms)
        if self.spent_usd + usd > p.daily_usd + 1e-9:
            return Decision(False, "spend_budget_exceeded",
                            f"daily budget ${p.daily_usd:,.2f}, already ${self.spent_usd:,.2f}")
        recent = [t for t in self.actions if now_ms - t < HOUR_MS]
        if p.max_actions_per_hour is not None and len(recent) >= p.max_actions_per_hour:
            return Decision(False, "policy_action_limit_exceeded", "too many actions this hour")
        return Decision(True)

    def check_perp(self, now_ms: int, asset: str, usd: float, gross_after: float, position_after: float,
                   equity: float, reducing: bool = False) -> Decision:
        """One perp order of `usd` notional. `gross_after` / `position_after` are |notional| after the fill.

        Orders that only shrink exposure are always allowed unless the agent is frozen, so the pilot can
        always de-risk, even over budget. Opening risk must respect every limit.
        """
        p = self.policy
        if p.frozen and not reducing:
            return Decision(False, "wallet_frozen", "agent is frozen by the owner")
        if reducing:
            return Decision(True)
        if "perp" not in p.actions:
            return Decision(False, "policy_action_denied", "action 'perp' is not allowed")
        if asset not in p.perp_assets:
            return Decision(False, "policy_denied", f"perp market '{asset}' is not listed")
        if usd > p.per_transaction_usd + 1e-9:
            return Decision(False, "policy_limit_exceeded", f"${usd:,.2f} > per-transaction ${p.per_transaction_usd:,.2f}")
        if equity <= 0 or gross_after / equity > p.max_leverage + 1e-9:
            return Decision(False, "leverage_exceeded", f"gross leverage {gross_after / max(equity, 1e-9):.2f}x > {p.max_leverage:.2f}x")
        if p.max_perp_notional_usd is not None and position_after > p.max_perp_notional_usd + 1e-9:
            return Decision(False, "position_limit_exceeded", f"{asset} position ${position_after:,.0f} > ${p.max_perp_notional_usd:,.0f}")
        self._roll(now_ms)
        if self.spent_usd + usd > p.daily_usd + 1e-9:
            return Decision(False, "spend_budget_exceeded",
                            f"daily budget ${p.daily_usd:,.2f}, already ${self.spent_usd:,.2f}")
        recent = [t for t in self.actions if now_ms - t < HOUR_MS]
        if p.max_actions_per_hour is not None and len(recent) >= p.max_actions_per_hour:
            return Decision(False, "policy_action_limit_exceeded", "too many actions this hour")
        return Decision(True)

    def record(self, now_ms: int, usd: float) -> None:
        self._roll(now_ms)
        self.spent_usd += usd
        self.actions = [t for t in self.actions if now_ms - t < HOUR_MS] + [now_ms]

    def _roll(self, now_ms: int) -> None:
        while now_ms >= self.period_start + DAY_MS:
            self.period_start += DAY_MS
            self.spent_usd = 0.0


@dataclass
class Mandate:
    """What the owner asked for in plain words, as numbers."""

    stable_weight: float = 0.5  # USDC parked in a yield vault token
    gold_weight: float = 0.1  # XAUT
    crypto_weight: float = 0.4  # managed by strategies (BTC, ETH, SOL, NEAR or cash)
    max_drawdown: float = 0.10  # breach -> everything to USDC, freeze until the owner resumes
    # "episode": the limit applies to each fall; after the owner resumes, the peak restarts.
    # "from_peak": never below (1 - max_drawdown) of the all-time peak; after resuming, risk is scaled
    #              down to the buffer that is left, so a second fall cannot break the floor.
    drawdown_mode: str = "episode"
    rebalance_band: float = 0.03  # trade only when an asset drifts more than this share of equity
    stable_apy: float = 0.04  # assumption for the vault token yield, not a promise

    def __post_init__(self) -> None:
        total = self.stable_weight + self.gold_weight + self.crypto_weight
        if abs(total - 1) > 1e-9:
            raise ValueError(f"mandate weights must sum to 1, got {total}")
        if self.drawdown_mode not in ("episode", "from_peak"):
            raise ValueError("drawdown_mode must be 'episode' or 'from_peak'")
