"""Minimal client for the NEAR Intents Agent API (https://docs.agentsonintents.com).

Standard library only. Keys come from the environment (.env), never from code or logs.
The API is a mainnet-only beta: every non-dry action moves real funds.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from decimal import ROUND_DOWN, Decimal
from pathlib import Path

DEFAULT_URL = "https://api.demo.agentsonintents.com"

# Which NEAR Intents asset the pilot trades for each portfolio symbol (checked against GET /v1/tokens).
ASSET_IDS = {
    "USDC": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",  # native USDC on NEAR
    "BTC": "nep141:btc.omft.near",  # native BTC
    "ETH": "nep141:eth.omft.near",
    "SOL": "nep141:sol.omft.near",
    "NEAR": "nep141:wrap.near",
    "XAUT": "nep141:eth-0x68749665ff8d2d112fa859aa293f07a622782f38.omft.near",  # Tether Gold
    "VAULT_USDC": "nep141:eth-0xaf08e292d62df255f7953665a44ed65f0380aa60.omft.near",  # steakUSDC vault share
}


class AgentApiError(RuntimeError):
    def __init__(self, status: int, code: str, detail: str):
        super().__init__(f"{status} {code}: {detail}")
        self.status, self.code, self.detail = status, code, detail


def load_env(path: str | Path = ".env") -> None:
    """Read KEY=VALUE lines into os.environ without overwriting existing values or printing anything."""
    p = Path(path)
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            if v.strip():
                os.environ.setdefault(k.strip(), v.strip())


def to_atomic(amount: float | str | Decimal, decimals: int) -> str:
    """Human amount -> integer string in the asset's smallest unit (rounded down, never up)."""
    q = (Decimal(str(amount)) * (Decimal(10) ** decimals)).to_integral_value(rounding=ROUND_DOWN)
    if q <= 0:
        raise ValueError("amount must be positive after conversion")
    return str(q)


@dataclass
class AgentApi:
    base_url: str = DEFAULT_URL
    api_key: str | None = None
    timeout: float = 30.0

    @classmethod
    def from_env(cls) -> "AgentApi":
        return cls(os.environ.get("NEAR_INTENTS_AGENT_API_URL", DEFAULT_URL),
                   os.environ.get("NEAR_INTENTS_AGENT_API_KEY") or None)

    # --- transport -------------------------------------------------------------------------
    def _req(self, method: str, path: str, body: dict | None = None, *, auth: bool = True,
             grant: str | None = None, idempotency_key: str | None = None) -> dict:
        headers = {"Accept": "application/json"}
        if auth:
            if not self.api_key:
                raise AgentApiError(0, "missing_api_key", "set NEAR_INTENTS_AGENT_API_KEY in .env")
            headers["X-API-Key"] = self.api_key
        if grant:
            headers["X-Grant-Token"] = grant
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base_url.rstrip("/") + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            raise _error(e.code, e.read()) from None

    # --- public ----------------------------------------------------------------------------
    def network(self) -> dict:
        return self._req("GET", "/v1/network", auth=False)

    def tokens(self) -> list[dict]:
        return self._req("GET", "/v1/tokens", auth=False)["data"]

    def resolve(self, symbols=ASSET_IDS) -> dict[str, dict]:
        """Check every asset id the pilot uses still exists, and return its decimals and price."""
        by_id = {t["asset_id"]: t for t in self.tokens()}
        missing = [s for s, aid in symbols.items() if aid not in by_id]
        if missing:
            raise AgentApiError(0, "asset_missing", f"not in /v1/tokens: {missing}")
        return {s: by_id[aid] for s, aid in symbols.items()}

    # --- partner key -----------------------------------------------------------------------
    def whoami(self) -> dict:
        return self._req("GET", "/v1/whoami")

    def quotas(self) -> dict:
        return self._req("GET", "/v1/quotas")

    # --- owner intents: generate -> owner signs `intent.payload` unchanged -> submit --------
    def generate_intent(self, intent: dict, idempotency_key: str | None = None) -> dict:
        return self._req("POST", "/v1/generate-intent", intent, idempotency_key=idempotency_key or _key("intent"))

    def agent_create_intent(self, name: str, owner: dict, policy: dict) -> dict:
        return self.generate_intent({"type": "agent_create", "name": name, "owner": owner, "policy": policy})

    def freeze_intent(self, agent_id: str) -> dict:
        return self.generate_intent({"type": "agent_freeze", "agent_id": agent_id})

    def submit_intent(self, intent_type: str, correlation_id: str, signed_data: dict) -> dict:
        return self._req("POST", "/v1/submit-intent",
                         {"type": intent_type, "correlation_id": correlation_id, "signed_data": signed_data})

    def status(self, correlation_id: str, wait_ms: int = 0) -> dict:
        return self._req("GET", f"/v1/status?correlation_id={correlation_id}&wait_ms={wait_ms}")

    # --- agent actions: partner key + the owner's grant token -------------------------------
    def balances(self, agent_id: str, grant: str) -> dict:
        return self._req("GET", f"/v1/agents/{agent_id}/balances", grant=grant)

    def policy(self, agent_id: str) -> dict:
        return self._req("GET", f"/v1/agents/{agent_id}/policy")

    def swap(self, agent_id: str, grant: str, origin: str, destination: str, amount_atomic: str, *,
             min_amount_out: str | None = None, confidential: bool = True, dry: bool = True,
             idempotency_key: str | None = None, app_fee_bps: int | None = None,
             fee_recipient: str | None = None) -> dict:
        """dry=True (default) returns a quote and the budget check without moving funds.

        Pilot's spot fee (0.10%) follows the 1Click `appFees` model: with a partner key, the submitted fee
        is split with 1Click, which keeps at least 20 bps, so 30 bps total leaves 10 bps to Pilot. The field
        is sent only when a recipient is configured. NOTE: confirm the Agent API field name against its
        spec once the partner key is issued (it mirrors 1Click `appFees`).
        """
        body = {"origin_asset": origin, "destination_asset": destination, "amount": amount_atomic,
                "confidential": confidential, "dry": dry}
        recipient = fee_recipient or os.environ.get("PILOT_FEE_RECIPIENT")
        if recipient and app_fee_bps:
            if not 0 < app_fee_bps <= 500:
                raise ValueError("app fee must be 1..500 bps")
            body["app_fees"] = [{"recipient": recipient, "fee": int(app_fee_bps)}]
        if min_amount_out is not None:
            body["min_amount_out"] = min_amount_out
        return self._req("POST", f"/v1/agents/{agent_id}/swap", body, grant=grant,
                         idempotency_key=idempotency_key or _key("swap"))

    def proof(self, agent_id: str, correlation_id: str) -> dict:
        """Proof of an execution from the attested transparency log."""
        return self._req("GET", f"/v1/agents/{agent_id}/operations/{correlation_id}/proof")


def _key(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex}"


def _error(status: int, raw: bytes) -> AgentApiError:
    try:
        err = json.loads(raw)["errors"][0]
        return AgentApiError(status, err.get("code", "unknown"), err.get("detail") or err.get("title", ""))
    except (ValueError, KeyError, IndexError, TypeError):
        return AgentApiError(status, "http_error", raw[:200].decode(errors="replace"))
