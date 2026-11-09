# NEAR Portfolio Pilot

Built at the NEAR Hackathon, November 2026. Work in progress.

You describe in plain words how your money should be managed and sign the rules once. Deterministic strategy scripts then run the portfolio in your own NEAR Intents agent wallet. A single AI agent reviews them weekly, and every action stays inside your signed policy.

- **Rules you sign:** NEAR Intents Agent API policy — swap-only, nothing can leave the wallet, daily USD budget, freeze at any time.
- **Strategies:** deterministic code (no LLM per trade), planned to run as WASM in a TEE on OutLayer with an attestation per run.
- **Strategy NFTs:** NEP-171 tokens with an append-only, verifiable weekly record. The holder receives the author's share.
- **Interface:** an IronClaw skill, with near.com as the integration target.

Read [DISCLAIMER.md](DISCLAIMER.md) before using this with real funds. Simulated results are hypothetical.

## Try it in 3 commands (no keys, no funds)

```bash
python3 sim/fetch_data.py --days 730   # 2 years of hourly prices from Binance public API
python3 sim/run_sim.py                 # pilot vs benchmarks -> results/report.json, chronicle.jsonl
python3 -m pytest -q                   # policy, engine and Agent API client tests
```

Requires Python 3.11+ with `pandas`, `numpy` and `pytest`. What the simulation found, including where it fails: [docs/SIM_FINDINGS.md](docs/SIM_FINDINGS.md).

## Web app

A static site (no build step, no npm): `web/`. It works in simulation mode on any static host; live actions turn on when `web/js/config.js` points to the Pilot backend.

```bash
python3 sim/run_sim.py && python3 sim/export_web.py   # refresh web/data/*.json
python3 -m http.server 8765 --directory web           # open http://localhost:8765
node --test tests/web/logic.test.mjs                  # browser logic matches the Python core
```

Screens: Portfolio (simulated value vs benchmarks), Rules (plain words -> Agent API policy -> terms -> sign), Strategies (strategy NFTs and their records), Safety (freeze, prompt-injection test), Ask (answers quoted from the decision log). Sign-in with a passkey (WebAuthn) or a NEAR wallet (Meteor, MyNearWallet, Intear).

Read-only check against the live Agent API (it never moves funds):

```bash
python3 sim/agent_api_check.py
```

## Layout

| Path | What |
| --- | --- |
| `pilot/policy.py` | Owner policy mirrored from the Agent API, with the same error codes; mandate (target weights, drawdown stop) |
| `pilot/strategies.py` | Strategy catalog: hold-rebalance, trend filter, momentum, dip averager, vol target |
| `pilot/engine.py` | Weekly review (supervisor), circuit breaker, hourly simulation without look-ahead |
| `pilot/agent_api.py` | NEAR Intents Agent API client (stdlib only; swaps are dry-run by default) |
| `contracts/strategy-nft` | NEP-171 strategy NFT contract (Rust, near-sdk 5.30) with unit tests |
| `docs/` | Setup of keys, simulation findings, demo script |

## Status

- [x] Strategy scripts and simulation on historical data
- [x] Owner policy compiled to the Agent API format; read-only client checked against mainnet
- [x] Strategy NFT contract with tests (`cd contracts/strategy-nft && cargo test`)
- [ ] Agent creation and signing flow (needs keys, see [docs/SETUP_KEYS.md](docs/SETUP_KEYS.md))
- [ ] OutLayer strategy runner
- [ ] IronClaw skill and weekly AI review
- [ ] Web UI and demo video ([docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md))

## Setup

```bash
cp .env.example .env   # fill in your own keys; .env is git-ignored
```
