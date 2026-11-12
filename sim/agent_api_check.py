"""Smoke check against the live Agent API. Read-only: it never moves funds.

Without keys it checks the public endpoints and that every asset the pilot trades exists.
With NEAR_INTENTS_AGENT_API_KEY in .env it also checks the key and quotas.
Usage: python3 sim/agent_api_check.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from pilot.agent_api import ASSET_IDS, AgentApi, AgentApiError, load_env  # noqa: E402
from pilot.policy import Policy  # noqa: E402


def main() -> int:
    load_env(ROOT / ".env")
    api = AgentApi.from_env()
    net = api.network()
    print(f"network {net['network']}, overall {net['status']['overall']}, owners {net['supported_owner_types']}")
    assets = api.resolve()
    for sym, t in assets.items():
        price = t["price"]
        flag = ""
        if sym == "VAULT_USDC" and price is not None and price < 0.01:
            flag = "  <- price looks scaled wrong (vault share should be ~1 USD); the USD budget would undercount it"
        print(f"  {sym:10} {t['blockchain']:5} decimals {t['decimals']:<3} price {price}{flag}")
    policy = Policy(daily_usd=500, per_transaction_usd=200).to_agent_api(ASSET_IDS)
    print("policy the owner would sign:\n" + json.dumps(policy, indent=2))
    if api.api_key:
        try:
            who = api.whoami()
            print("api key ok:", {k: who.get(k) for k in ("partner_id", "name", "key_id") if k in who} or "valid")
            print("quotas:", json.dumps(api.quotas())[:300])
        except AgentApiError as e:
            print("api key check failed:", e.code)
            return 1
    else:
        print("no NEAR_INTENTS_AGENT_API_KEY in .env: skipped key checks (see docs/SETUP_KEYS.md, step 2)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
