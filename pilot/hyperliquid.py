"""Perp executor for Hyperliquid (the venue behind perps on near.com).

Every order passes the owner's policy first (`PolicyState.check_perp`); a refused order never reaches
the venue. Testnet by default; mainnet needs `testnet=False` *and* `live=True`.

The key used here should be a Hyperliquid API wallet: it can place and cancel orders for the account
but cannot withdraw, which keeps the "nothing leaves the wallet" rule for perps.

Usage (testnet, needs HL_TESTNET_PRIVATE_KEY in .env and mock USDC from the testnet faucet):
    .venv/bin/python -m pilot.hyperliquid status
    .venv/bin/python -m pilot.hyperliquid order BTC -50     # short $50 of BTC, dry run
    .venv/bin/python -m pilot.hyperliquid order BTC -50 --send
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from .policy import Decision, Policy, PolicyState

TESTNET_URL = "https://api.hyperliquid-testnet.xyz"
# Pilot's builder code fee on perps: 0.05% = 5 bps. Hyperliquid counts builder fees in tenths of a bp,
# caps them at 0.1% on perps, and charges them only after the owner approves Pilot once from the main
# wallet (approve_builder_fee). The builder address needs >= 100 USDC in its perps account.
PILOT_BUILDER_FEE_TENTHS_BPS = 50
MAINNET_URL = "https://api.hyperliquid.xyz"


def load_env(path: str = ".env") -> None:
    p = Path(path)
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


@dataclass
class OrderResult:
    sent: bool
    decision: Decision
    request: dict
    response: dict | None = None


class HyperliquidExecutor:
    def __init__(self, policy: Policy, private_key: str | None = None, testnet: bool = True, live: bool = False,
                 slippage: float = 0.01):
        if not testnet and not live:
            raise ValueError("mainnet requires live=True")
        from eth_account import Account
        from hyperliquid.exchange import Exchange
        from hyperliquid.info import Info

        self.url = TESTNET_URL if testnet else MAINNET_URL
        self.info = Info(self.url, skip_ws=True)
        self.wallet = Account.from_key(private_key) if private_key else None
        self.exchange = Exchange(self.wallet, self.url) if self.wallet else None
        self.state = PolicyState(policy, period_start=int(time.time() * 1000))
        self.slippage = slippage
        builder = os.environ.get("PILOT_HL_BUILDER")  # set once Pilot's builder account exists
        self.builder = {"b": builder.lower(), "f": PILOT_BUILDER_FEE_TENTHS_BPS} if builder else None

    @property
    def address(self) -> str | None:
        return self.wallet.address if self.wallet else None

    def account(self) -> dict:
        s = self.info.user_state(self.address)
        positions = {p["position"]["coin"]: float(p["position"]["szi"]) for p in s.get("assetPositions", [])}
        return {"equity": float(s["marginSummary"]["accountValue"]),
                "gross_notional": float(s["marginSummary"]["totalNtlPos"]), "positions": positions}

    def mid(self, coin: str) -> float:
        return float(self.info.all_mids()[coin])

    def order(self, coin: str, usd: float, send: bool = False) -> OrderResult:
        """usd > 0 buys, < 0 sells `|usd|` of notional at market (IOC limit with slippage)."""
        acct = self.account()
        px = self.mid(coin)
        cur = acct["positions"].get(coin, 0.0) * px
        after = cur + usd
        reducing = abs(after) < abs(cur) - 1e-9 and cur * after >= 0
        gross_after = acct["gross_notional"] - abs(cur) + abs(after)
        now = int(time.time() * 1000)
        d = self.state.check_perp(now, coin, abs(usd), gross_after, abs(after), acct["equity"], reducing)
        meta = self.info.meta()
        decimals = next(a["szDecimals"] for a in meta["universe"] if a["name"] == coin)
        size = round(abs(usd) / px, decimals)
        req = {"coin": coin, "is_buy": usd > 0, "size": size, "mid": px, "reduce_only": reducing, "builder": self.builder,
               "network": self.url, "policy": d.code or "ok"}
        if not d.ok or not send:
            return OrderResult(False, d, req)
        if self.exchange is None:
            raise RuntimeError("no private key")
        if size <= 0:
            return OrderResult(False, Decision(False, "size_too_small", "rounds to zero"), req)
        resp = self.exchange.market_open(coin, usd > 0, size, None, self.slippage, builder=self.builder) if not reducing else \
            self.exchange.market_close(coin, size, None, self.slippage, builder=self.builder)
        self.state.record(now, abs(usd)) if not reducing else None
        return OrderResult(True, d, req, resp)


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    o = sub.add_parser("order")
    o.add_argument("coin")
    o.add_argument("usd", type=float)
    o.add_argument("--send", action="store_true")
    a = ap.parse_args()
    load_env()
    key = os.environ.get("HL_TESTNET_PRIVATE_KEY")
    policy = Policy(actions=("swap", "perp"), per_transaction_usd=200, daily_usd=1_000, max_leverage=1.0)
    ex = HyperliquidExecutor(policy, key, testnet=True)
    if a.cmd == "status":
        print(json.dumps({"address": ex.address, **ex.account(), "limits": policy.to_hyperliquid()}, indent=2))
    else:
        r = ex.order(a.coin.upper(), a.usd, send=a.send)
        print(json.dumps({"sent": r.sent, "decision": r.decision.__dict__, "request": r.request, "response": r.response}, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
