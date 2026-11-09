"""Plain-words rules -> Mandate + Policy.

Deterministic parser for the demo and the tests. In the product a model on NEAR AI Cloud (TEE) drafts
the same structure, and this module validates it: the owner always signs what `compile_rules` returns,
never raw model output.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field

from .agent_api import ASSET_IDS
from .policy import Mandate, Policy

_PCT = r"(\d{1,3}(?:[.,]\d+)?)\s*%"
_MONEY = r"\$?\s*(\d[\d,\s]*(?:\.\d+)?)\s*(k)?\s*(?:usd|usdc|\$|dollars?)?"
_ACCOUNT = r"([a-z0-9_\-]+(?:\.[a-z0-9_\-]+)*\.(?:near|tg)|0x[a-f0-9]{40}|[a-f0-9]{64})"

_STABLE = r"(?:stable(?:coin)?s?|usdc|usdt|cash|стейбл\w*|кэш)"
_GOLD = r"(?:gold|xaut|paxg|золот\w*)"
_CRYPTO = r"(?:crypto|btc|bitcoin|eth|ether\w*|sol|solana|крипт\w*)"


@dataclass
class Compiled:
    mandate: dict
    policy: dict  # Agent API policy object, ready for agent_create
    summary: list[str]
    warnings: list[str] = field(default_factory=list)


def _num(s: str) -> float:
    return float(s.replace(",", ".").replace(" ", ""))


def _money(m: re.Match) -> float:
    v = float(m.group(1).replace(",", "").replace(" ", ""))
    return v * 1000 if m.group(2) else v


def _weight(text: str, asset_re: str) -> float | None:
    for pat in (rf"{_PCT}\s*(?:in|into|to|of|on|в|на)?\s*(?:the\s+)?{asset_re}", rf"{asset_re}\s*[:\-–]?\s*{_PCT}"):
        m = re.search(pat, text)
        if m:
            return _num(m.group(1)) / 100
    return None


def compile_rules(text: str, portfolio_usd: float = 10_000.0) -> Compiled:
    t = text.lower()
    warnings: list[str] = []

    w = {"stable": _weight(t, _STABLE), "gold": _weight(t, _GOLD), "crypto": _weight(t, _CRYPTO)}
    given = {k: v for k, v in w.items() if v is not None}
    if sum(given.values()) > 1 + 1e-9:
        raise ValueError(f"weights add up to {sum(given.values()):.0%}, more than 100%")
    missing = [k for k, v in w.items() if v is None]
    rest = 1 - sum(given.values())
    if missing:
        # The remainder goes to stablecoins first (the safe default), never silently into risk.
        fill = {k: 0.0 for k in missing}
        fill["stable" if "stable" in missing else missing[0]] = rest
        w.update(fill)
        if rest > 1e-9:
            warnings.append(f"{rest:.0%} not assigned in your rules was put into {'stablecoins' if 'stable' in missing else missing[0]}.")
    elif abs(rest) > 1e-9:
        w["stable"] += rest
        warnings.append(f"weights added up to {1 - rest:.0%}; the remaining {rest:.0%} goes to stablecoins.")

    dd = 0.10
    m = re.search(rf"(?:drawdown|draw-down|loss|lose|просадк\w*|убыт\w*)[^\d%]{{0,30}}{_PCT}", t) or \
        re.search(rf"{_PCT}[^\d%]{{0,20}}(?:drawdown|loss|просадк\w*)", t)
    if m:
        dd = _num(m.group(1)) / 100
    else:
        warnings.append("no drawdown limit found: using 10%.")
    if not 0.02 <= dd <= 0.5:
        raise ValueError("drawdown limit must be between 2% and 50%")

    daily = None
    m = re.search(rf"{_MONEY}\s*(?:per day|a day|daily|/day|в день|за день)", t) or \
        re.search(rf"(?:daily|per day|в день)[^\d$]{{0,25}}{_MONEY}", t)
    if m:
        daily = _money(m)
    per_tx = None
    m = re.search(rf"{_MONEY}\s*(?:per (?:trade|transaction|swap)|за сделку)", t) or \
        re.search(rf"(?:per (?:trade|transaction|swap)|за сделку)[^\d$]{{0,25}}{_MONEY}", t)
    if m:
        per_tx = _money(m)

    destinations: list[str] = []
    actions = ["swap"]
    m = re.search(rf"(?:withdraw|send|вывод\w*)[^.]{{0,40}}?only\s+to\s+{_ACCOUNT}", t) or \
        re.search(rf"(?:только\s+на)\s+{_ACCOUNT}", t)
    if m:
        destinations = [m.group(1)]
        actions.append("withdraw")
    elif re.search(r"never send|no withdraw|nothing (?:leaves|out)|никуда не выводить|не выводить", t):
        pass  # swap-only is already the default
    else:
        warnings.append("no withdrawal rule found: the agent can only swap, nothing can leave the wallet.")

    # Finding from the simulation: the budget also counts emergency sells, so it must cover a full exit.
    if daily is None:
        daily = round(portfolio_usd * 1.2, 2)
    elif daily < portfolio_usd:
        warnings.append(
            f"daily budget ${daily:,.0f} is below the portfolio value ${portfolio_usd:,.0f}: "
            "in a crash the drawdown stop could not sell everything in one day.")
    if per_tx is None:
        per_tx = round(max(100.0, min(daily, portfolio_usd * 0.1)), 2)

    mandate = Mandate(stable_weight=round(w["stable"], 4), gold_weight=round(w["gold"], 4),
                      crypto_weight=round(1 - round(w["stable"], 4) - round(w["gold"], 4), 4), max_drawdown=dd)
    policy = Policy(actions=tuple(actions), per_transaction_usd=per_tx, daily_usd=daily,
                    destinations=frozenset(destinations))
    api_policy = policy.to_agent_api(ASSET_IDS)
    if destinations:
        api_policy["destinations"]["list"] = [{"action": "withdraw", "chain": "near", "address": d, "memo": None}
                                              for d in destinations]

    summary = [
        f"{mandate.stable_weight:.0%} in stablecoins earning vault yield",
        f"{mandate.gold_weight:.0%} in gold (XAUT)",
        f"{mandate.crypto_weight:.0%} in crypto, managed by strategy scripts",
        f"If the portfolio falls {dd:.0%} from its peak: sell everything to USDC and freeze until you resume",
        f"At most ${per_tx:,.0f} per swap and ${daily:,.0f} of swaps per day",
        ("Withdrawals only to " + ", ".join(destinations)) if destinations else "The agent can only swap: no transfers or withdrawals",
        "You can freeze the agent at any moment; freezing is never delayed",
    ]
    return Compiled(asdict(mandate), api_policy, summary, warnings)
