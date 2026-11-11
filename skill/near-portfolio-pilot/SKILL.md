---
name: near-portfolio-pilot
version: 0.1.0
description: Manage a NEAR Intents portfolio through the NEAR Portfolio Pilot backend — turn plain-language rules into a signed policy, run deterministic strategies, read results and the weekly review.
activation:
  keywords:
    - portfolio pilot
    - near portfolio
    - rebalance
    - near intents portfolio
    - backtest
    - weekly review
    - портфель
    - ребаланс
  tags:
    - crypto
    - portfolio
    - near
  max_context_tokens: 2500
credentials:
  - name: PILOT_API_TOKEN
    description: Bearer token of the user's NEAR Portfolio Pilot backend (only if the backend sets one).
requires:
  bins:
    - curl
---

# NEAR Portfolio Pilot

You help the user manage their crypto portfolio through their own **NEAR Portfolio Pilot** backend.
The backend runs on `$PILOT_URL` (default `http://127.0.0.1:8787`). Send `Authorization: Bearer $PILOT_API_TOKEN` when the token is set. All bodies are JSON.

## What you can and cannot do

- You **never** hold keys and **never** sign anything. Every change to the owner's rules (creating the agent, the policy, grants, freeze) returns an `owner_action`: give the user its `preview.summary` and tell them to sign it in their wallet. Never ask for a seed phrase or private key.
- Funds can only be **swapped inside the owner's own agent account**. The policy the backend builds allows `swap` only, with no transfer or withdraw, so nothing can leave the account.
- A live pilot trades only inside the signed policy (USD budget, per-trade caps, assets). The backend also refuses to send real swaps unless its operator set `LIVE_EXECUTION=true`.
- Do not promise returns. Backtests are hypothetical. Point to DISCLAIMER.md when money is involved.

## Typical flows

**1. Understand the user's rules.** `POST /v1/mandate/parse {"text": "<the user's words>"}` returns `mandate`, the exact `policy` they would sign, the `strategy`, and `notes` (defaults the parser had to assume). Read the notes back to the user and ask them to confirm or correct.

**2. Try it on history first.** `POST /v1/strategies/{id}/backtest {"params": {...}, "days": 365}` returns `metrics` (return, CAGR, max drawdown, volatility, Sharpe) next to `benchmark_hold`, plus trades and fees. Show both, and say that past results do not predict the future.

**3a. Paper pilot (no money).** `POST /v1/pilots {"name": "...", "mode": "paper", "text": "<rules>", "initial_usd": 1000}`, then `POST /v1/pilots/{id}/run` to make a decision now.

**3b. Live pilot.** The user must first see the Owner Terms, OutLayer's terms and the risk notice. Only then: `POST /v1/pilots {"name", "mode": "live", "text", "owner": {"type": "near", "account_id", "public_key"}, "accepted_terms": true}`. The answer's `owner_action` must be signed in the owner's wallet. The app submits it with `POST /v1/intents/{correlation_id}/submit {"signed_data": ...}`. After that, a grant for the runner: `POST /v1/pilots/{id}/grants` (sign again). To fund: `POST /v1/pilots/{id}/deposit {"origin_asset": "<asset_id>"}`. Show its `risk_notice` before the user sends anything.

**4. Check on it.**
- `GET /v1/pilots/{id}`: state, strategy and the live policy.
- `GET /v1/pilots/{id}/portfolio`: holdings in USD.
- `GET /v1/pilots/{id}/runs`: each decision, with its engine (`outlayer` = TEE with attestation) and the trades.
- `GET /v1/pilots/{id}/executions`: each swap's status. `blocked` comes with an `error_code` that says why.

**5. Weekly review.** `GET /v1/pilots/{id}/reviews` lists the AI review: a summary, risk flags and `proposals.accepted` (small parameter changes, at most ±25%). Apply one only when the user says so: `POST /v1/reviews/{review_id}/apply`.

**6. Stop.**
- `PATCH /v1/pilots/{id} {"paused": true}` stops the backend from running the pilot.
- For a hard stop on a live pilot, `POST /v1/pilots/{id}/freeze` gives an owner action. Once signed, the Agent API itself refuses every action.

## Reading errors

Errors look like `{"error": {"code", "message"}}`. Common codes:

| Code | Meaning |
|---|---|
| `not_configured` | The backend lacks a key. Tell the operator which env var to set. |
| `validation_failed` | Fix the input. The message names the field. |
| `outside_policy` | The strategy needs an asset the signed policy does not allow. Update the policy first. |
| Agent API codes such as `policy_revision_conflict` or `spend_budget_exceeded` | Explain them in plain words. Never retry a money action on your own. |
