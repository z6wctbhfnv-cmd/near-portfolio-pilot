"""NEAR AI Cloud (private inference in a TEE, OpenAI-compatible API) for the two language tasks:

- draft a script from the owner's idea (`draft_script`);
- draft agent settings from the owner's words (`draft_tuning`).

The model only drafts. Scripts go through `scriptgen.check_source` and a backtest; settings go through
`tuning.tune` / `tuning.set_params`. The owner confirms the checked result, never raw model output.

Needs NEARAI_API_KEY in .env (see docs/SETUP_KEYS.md, section 4). stdlib only.
"""
from __future__ import annotations

import json
import os
import re
import urllib.request

from .scriptgen import UnsafeScript, check_source

BASE_URL = os.environ.get("NEARAI_BASE_URL", "https://cloud-api.near.ai/v1")
MODEL = os.environ.get("NEARAI_MODEL", "z-ai/glm-5.3-flash")  # hosted by NEAR AI in a TEE: private

SCRIPT_PROMPT = """You write trading scripts for Pilot. Output ONLY Python code, no prose, no markdown fences.
Exactly one function: def target(daily):
- daily is a pandas DataFrame of daily closes, columns BTC, ETH, SOL, NEAR, XAUT, plus funding columns
  "BTC-FUND", "ETH-FUND", "SOL-FUND", "NEAR-FUND" (funding a long paid that day). Rows end today.
- Return a dict of weights. Spot keys: BTC, ETH, SOL, NEAR, USDC (>= 0, spot + USDC = 1).
  Perp keys: BTC-PERP, ETH-PERP, SOL-PERP, NEAR-PERP (signed, negative = short, |w| <= 1).
- Use only `np`, `math`, built-ins like min/max/len/sum/abs. No imports, no files, no lambda, no classes.
- Deterministic. Handle short history (return {"USDC": 1.0}).
"""


def _chat(messages: list[dict], api_key: str | None = None, timeout: int = 60) -> str:
    key = api_key or os.environ.get("NEARAI_API_KEY")
    if not key:
        raise RuntimeError("NEARAI_API_KEY is not set (docs/SETUP_KEYS.md, section 4)")
    body = json.dumps({"model": MODEL, "messages": messages, "temperature": 0}).encode()
    req = urllib.request.Request(f"{BASE_URL}/chat/completions", data=body,
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())["choices"][0]["message"]["content"]


def _strip_fences(text: str) -> str:
    m = re.search(r"```(?:python)?\n(.*?)```", text, re.S)
    return (m.group(1) if m else text).strip() + "\n"


def draft_script(idea: str, api_key: str | None = None, attempts: int = 2) -> str:
    """Idea in words -> checked script source. Retries once with the checker's complaint."""
    messages = [{"role": "system", "content": SCRIPT_PROMPT}, {"role": "user", "content": idea[:1000]}]
    last = ""
    for _ in range(attempts):
        code = _strip_fences(_chat(messages, api_key))
        try:
            check_source(code)
            return code
        except (UnsafeScript, SyntaxError) as e:
            last = str(e)
            messages += [{"role": "assistant", "content": code},
                         {"role": "user", "content": f"Rejected by the checker: {last}. Fix it, code only."}]
    raise UnsafeScript(f"model could not produce a valid script: {last}")
