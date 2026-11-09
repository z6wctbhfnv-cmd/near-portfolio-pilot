# NEAR Portfolio Pilot

Built at the NEAR Hackathon, November 2026. Work in progress.

You describe in plain words how your money should be managed and sign the rules once. Deterministic strategy scripts then run the portfolio in your own NEAR Intents agent wallet. A single AI agent reviews them weekly, and every action stays inside your signed policy.

- **Rules you sign:** NEAR Intents Agent API policy — limits, USD budget, allowed destinations, freeze.
- **Strategies:** WASM code running in a TEE on OutLayer, with an attestation for every run.
- **Strategy catalog:** each strategy is an NFT carrying its verified on-chain history.
- **Interface:** an IronClaw skill, with near.com as the integration target.

Read [DISCLAIMER.md](DISCLAIMER.md) before using this with real funds.

## Status

- [ ] Strategy scripts and simulation on historical data
- [ ] Agent API integration (policy, swaps, dry quotes)
- [ ] OutLayer strategy runner
- [ ] Strategy NFT contract (NEP-171)
- [ ] IronClaw skill and weekly review
- [ ] Web UI and demo

## Setup

```bash
cp .env.example .env   # fill in your own keys; .env is git-ignored
```
