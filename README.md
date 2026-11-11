# NEAR Portfolio Pilot

Built at the NEAR Hackathon, November 2026. Work in progress.

You describe in plain words how your money should be managed and sign the rules once. Deterministic strategy scripts then run the portfolio in your own NEAR Intents agent wallet. A single AI agent reviews them weekly, and every action stays inside your signed policy.

- **Rules you sign:** NEAR Intents Agent API policy — swap-only, nothing can leave the wallet, daily USD budget, freeze at any time.
- **Perps (opt-in):** Hyperliquid perpetuals, as offered on near.com and funded through NEAR Intents. The agent uses a Hyperliquid API wallet that can trade but cannot withdraw. Gross leverage cap (1x in the demo), per-order and per-position limits, hourly funding in the books; closing a position is always allowed, even when frozen.
- **Strategies:** deterministic code (no LLM per trade), planned to run as WASM in a TEE on OutLayer with an attestation per run.
- **Strategy NFTs, one per script:** each NEP-171 token is bound to the sha256 of its script (source + parameters). A hash can be minted once, and every checkpoint must carry the same hash, so a record can't move to other code. Agents `follow` a script (paying their own storage); the NFT never controls their wallets. The holder receives the author's share.
- **Interface:** an IronClaw skill, with near.com as the integration target.

Read [DISCLAIMER.md](DISCLAIMER.md) before using this with real funds. Simulated results are hypothetical.

## Try it in 3 commands (no keys, no funds)

```bash
python3 sim/fetch_data.py --days 730   # 2 years of hourly prices from Binance public API
python3 sim/fetch_funding.py           # hourly perp funding from Hyperliquid (skip and use --no-perps for spot only)
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
| `pilot/strategies.py` | Script catalog: hold-rebalance, trend filter, momentum, dip averager, vol target; with perps: trend long/short, funding carry. `code_hash` per script |
| `pilot/engine.py` | Weekly review (supervisor), circuit breaker, hourly simulation without look-ahead; perps marked to market hourly with funding |
| `sim/fetch_funding.py` | Hourly funding history from Hyperliquid's public API |
| `pilot/agent_api.py` | NEAR Intents Agent API client (stdlib only; swaps are dry-run by default) |
| `contracts/strategy-nft` | NEP-171 strategy NFT contract (Rust, near-sdk 5.30) with unit tests |
| `docs/` | Setup of keys, simulation findings, demo script |

## Status

- [x] Strategy scripts and simulation on historical data
- [x] Owner policy compiled to the Agent API format; read-only client checked against mainnet
- [x] Strategy NFT contract with tests (`cd contracts/strategy-nft && cargo test`): bound to script hashes, agents follow scripts
- [x] Perps in policy, engine and two scripts (simulation; live orders not wired yet)
- [x] NFT contract on testnet: [`pilot-nft2-14805.testnet`](https://testnet.nearblocks.io/address/pilot-nft2-14805.testnet), 10 scripts minted by `pilot-author-10734.testnet` (open mint), one agent following `trend-longshort@v1`. The 4 checkpoints per script are simulated (proofs_hash all zeros), not live results
- [x] Fees: followers pay 5% of new profit to the script's NFT holder + 0.1% to Pilot; holders pay 0.1% only (`pilot/fees.py`, contract `ft_on_transfer`)
- [x] Agent tuning: plain words or sliders -> review settings (`pilot/tuning.py`); user scripts checked and backtested before minting (`pilot/scriptgen.py`)
- [ ] Hyperliquid testnet orders (`pilot/hyperliquid.py` ready; account needs mock USDC)
- [ ] Agent creation and signing flow (needs keys, see [docs/SETUP_KEYS.md](docs/SETUP_KEYS.md))
- [ ] OutLayer strategy runner
- [ ] IronClaw skill and weekly AI review
- [ ] Web UI and demo video ([docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md))

## Setup

```bash
cp .env.example .env   # fill in your own keys; .env is git-ignored
```
