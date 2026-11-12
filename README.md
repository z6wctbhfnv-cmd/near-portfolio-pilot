# NEAR Portfolio Pilot

Built at the NEAR Hackathon, November 2026. Work in progress.

You describe in plain words how your money should be managed and sign the rules once. Deterministic strategy scripts then run the portfolio in your own NEAR Intents agent wallet. A single AI agent reviews them weekly, and every action stays inside your signed policy.

- **Rules you sign:** NEAR Intents Agent API policy — limits, USD budget, allowed destinations, freeze.
- **Strategies:** WASM code running in a TEE on OutLayer, with an attestation for every run.
- **Strategy catalog:** each strategy is an NFT carrying its verified on-chain history.
- **Interface:** an IronClaw skill, with near.com as the integration target.

Read [DISCLAIMER.md](DISCLAIMER.md) before using this with real funds.

## Status

- [x] Strategy scripts and simulation on historical data (`strategies/`, `backend/src/backtest.ts`; research simulation in `pilot/` and `sim/`)
- [x] Agent API integration: policy, owner intents, grants, swaps, dry quotes (`backend/src/agent.ts`, `executor.ts`). Tested against a fake API; live calls need a partner key, see [HANDOFF.md](HANDOFF.md).
- [x] OutLayer strategy runner (`backend/src/outlayer.ts`). Tested against a fake; the project is not registered on OutLayer yet.
- [x] Strategy NFT contract on testnet: [`pilot-nft2-14805.testnet`](https://testnet.nearblocks.io/address/pilot-nft2-14805.testnet). One NFT per script, sale, copy fees, referrals. The backend appends one checkpoint per script per week (`backend/src/nft.ts`). The checkpoints already on chain are simulated (proofs_hash all zeros).
- [x] IronClaw skill (`skill/near-portfolio-pilot/SKILL.md`) and weekly AI review (`backend/src/review.ts`)
- [x] Web app (`web/`): rules, portfolio, strategies, safety, ask. Live mode talks to the backend: it shows the backend's policy, signs the owner intent (passkey, NEP-413 or NEP-366 wallet) and submits it.
- [ ] Hyperliquid testnet orders (`pilot/hyperliquid.py` ready; the account needs mock USDC)
- [ ] Live run with a partner key and a small deposit

## How it fits together

```
 owner's words ──► /v1/mandate/parse (NEAR AI or rule parser)
                        │
                        ▼
                 mandate ──► Agent API policy (swap only, no transfer/withdraw,
                        │     USD budget, per-asset caps, schedule)
                        ▼
      owner signs agent_create + grant in their wallet (backend never holds owner keys)
                        │
   scheduler ──► Runner: holdings + prices + history ──► strategy WASM
                        │        (OutLayer TEE with attestation, or the same .wasm locally)
                        ▼
                 trades ──► Executor
                              paper: fills at catalogue prices minus cost
                              live:  readiness → dry quote → key saved → swap → reconcile
                        │
                        ├──► snapshot, run record ──► strategy NFT (on-chain history)
                        └──► weekly review (NEAR AI): summary + bounded parameter proposals
```

**One strategy binary everywhere.** `strategies/` is a Rust crate compiled to `wasm32-wasip1`. It reads JSON on stdin and writes one JSON value on stdout, which is the OutLayer convention. Three things run that exact `.wasm`: the backtester, paper and live runs, and OutLayer. So the simulation runs the production logic. A test checks that the backend's in-process WASI shim and Node's own WASI give byte-identical output.

**Safety by construction.**
- The policy the owner signs allows only `swap`. Its destination list is `only: []`, so funds can never leave the agent account.
- Live swaps also need `LIVE_EXECUTION=true`, an active owner grant, and a policy that is `APPLIED` and synced.
- Each swap needs a clean dry quote, with no warnings.
- Each swap must also pass the mandate's own per-trade and daily caps.
- Idempotency keys are written to the database before every request. Retries and lost responses replay the same key, and `UNCERTAIN` operations are polled, never resent.
- The AI reviewer can only propose changes to whitelisted parameters. Each change is clamped to ±25% and re-validated.

## Run it

Needs Node 24+ (`.nvmrc`) and rustup; `strategies/rust-toolchain.toml` installs Rust 1.95.0 with the `wasm32-wasip1` target.

```bash
cp .env.example .env            # every key is optional; none = paper mode on public data
cd backend
npm install
npm run build:wasm              # builds strategies/ to WASM
npm run fetch-history           # ~3 years of daily closes (Binance public data) into data/
npm test                        # backend tests, no network
npm run smoke                   # read-only checks against the real services
npm run backtest -- trend '{"weights":{"NEAR":0.2,"BTC":0.2,"ETH":0.2}}' 730
npm start                       # API on http://127.0.0.1:8787
```

A paper pilot in two calls:

```bash
curl -s -XPOST localhost:8787/v1/pilots -H 'content-type: application/json' \
  -d '{"name":"Test","mode":"paper","text":"Careful: NEAR, BTC and ETH, $300 a day","initial_usd":1000}'
curl -s -XPOST localhost:8787/v1/pilots/<id>/run
```

The full route list is in [backend/README.md](backend/README.md).

## Repository

| Path | What |
|---|---|
| `strategies/` | Rust strategies (rebalance, trend, vol_target, dca) → WASI module for OutLayer and local runs. Pinned toolchain; `npm run build:wasm` gives the same sha256 on any machine |
| `backend/` | TypeScript service: API, scheduler, Agent API gateway, executor, backtester, AI review, NFT checkpoints |
| `web/` | Static web app (no build step). Simulation mode by default; live when `web/js/config.js` sets `apiBase` |
| `contracts/strategy-nft/` | NEP-171 strategy NFTs: one per script, append-only weekly record, sale and copy fees |
| `pilot/`, `sim/` | Python research code: simulation on hourly history, perps, fee model, script checker |
| `skill/near-portfolio-pilot/` | IronClaw skill that drives the backend |
| `docs/` | Key setup, simulation findings, demo script |

## License

MIT for `strategies/` and `contracts/` (their own `LICENSE` files), Apache-2.0 for everything else ([LICENSE](LICENSE)).
