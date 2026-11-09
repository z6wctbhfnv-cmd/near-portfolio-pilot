import os

import pytest

from pilot import agent_api
from pilot.agent_api import ASSET_IDS, AgentApi, AgentApiError, _error, load_env, to_atomic
from pilot.policy import Policy


def test_to_atomic_rounds_down():
    assert to_atomic("1.5", 6) == "1500000"
    assert to_atomic(0.0000019, 6) == "1"
    with pytest.raises(ValueError):
        to_atomic("0.0000001", 6)


def test_error_parses_json_api_document():
    e = _error(403, b'{"errors":[{"code":"spend_budget_exceeded","title":"Budget","detail":"daily cap"}]}')
    assert (e.status, e.code, e.detail) == (403, "spend_budget_exceeded", "daily cap")
    assert _error(500, b"<html>").code == "http_error"


def test_actions_need_a_key():
    with pytest.raises(AgentApiError) as ei:
        AgentApi(api_key=None).whoami()
    assert ei.value.code == "missing_api_key"


def test_resolve_reports_missing_assets(monkeypatch):
    monkeypatch.setattr(AgentApi, "tokens", lambda self: [{"asset_id": ASSET_IDS["USDC"], "decimals": 6, "price": 1}])
    with pytest.raises(AgentApiError) as ei:
        AgentApi().resolve()
    assert ei.value.code == "asset_missing"


def test_policy_uses_real_asset_ids_and_sends_nothing_out():
    p = Policy().to_agent_api(ASSET_IDS)
    assert all(a.startswith(("nep141:", "nep245:")) for a in p["assets"])
    assert p["destinations"]["list"] == []


def test_load_env_does_not_override(tmp_path, monkeypatch):
    f = tmp_path / ".env"
    f.write_text("A_TEST_KEY=from_file\nEMPTY_KEY=\n# comment\n")
    monkeypatch.setenv("A_TEST_KEY", "from_env")
    load_env(f)
    assert os.environ["A_TEST_KEY"] == "from_env"
    assert "EMPTY_KEY" not in os.environ


def test_swap_defaults_to_dry_run(monkeypatch):
    seen = {}

    def fake(self, method, path, body=None, **kw):
        seen.update(body=body, kw=kw)
        return {}

    monkeypatch.setattr(agent_api.AgentApi, "_req", fake)
    AgentApi(api_key="k").swap("a" * 64, "ngt_x", ASSET_IDS["USDC"], ASSET_IDS["ETH"], "1000000")
    assert seen["body"]["dry"] is True and seen["body"]["confidential"] is True
    assert seen["kw"]["grant"] == "ngt_x" and seen["kw"]["idempotency_key"].startswith("swap-")
