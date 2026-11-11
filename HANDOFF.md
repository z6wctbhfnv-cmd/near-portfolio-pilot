# Handoff: backend, 11–12 Nov 2026

Branch `backend`. What works, what was checked and how, and what still needs the owner.

## Checked for real

| What | How |
|---|---|
| Strategy logic (Rust) | `cargo test` in `strategies/`: 10 tests |
| WASM build and the same output in two runtimes | `npm run build:wasm`; a test compares our in-process WASI shim with `node:wasi`, byte for byte |
| Backend | `npm test`: 31 tests against fakes of the Agent API, OutLayer, NEAR AI and Binance |
| Public endpoints | `npm run smoke`: Agent API `/health`, `/v1/network`, `/v1/tokens` (all 7 universe assets are listed and priced), NEAR AI model list, WASM |
| Server on real data | Started locally on public prices. Rules parsed from Russian text, a paper pilot created, run (3 paper fills), valued, reviewed; a backtest over HTTP |
| NFT contract | `cargo test` in `contracts/strategy-nft/`: 29 tests. `cargo near build non-reproducible-wasm` produces a 333 KB wasm |

Backtests on real daily closes (Binance), 10 Nov 2024 → 10 Nov 2026, starting from 1000 USDC, with 30 bps cost per swap. Default parameters, no tuning, so this is in-sample and only illustrative:

| Strategy | Return | Max drawdown | Buy & hold, same weights |
|---|---|---|---|
| rebalance, 20% each NEAR/BTC/ETH | +5.7% | 42.7% | −13.7% |
| trend, SMA 50, same weights | +32.2% | 28.0% | −13.7% |
| vol_target, 30% each, 50% target vol | +5.1% | 49.8% | −20.5% |
| dca, 20 USD/week into NEAR+BTC | −3.6% | 57.5% | −16.4% |

## Not checked (needs keys or the owner)

1. **Live Agent API.** No partner key was available, so owner intents, grants, dry quotes and swaps were tested against a fake that follows the docs and OpenAPI. Next steps:
   - Put the key in `.env` and run `npm run smoke` (checks `whoami`).
   - Create a live pilot with a small amount; the owner signs in a NEAR wallet.
   - Watch the dry quotes while `LIVE_EXECUTION=false`.
   - Only then set `LIVE_EXECUTION=true`.
2. **The owner's wallet signing** is a frontend job. The backend returns `owner_action.intent` and takes `signed_data` back (see the "Signing" section of the SDK README).
3. **OutLayer.**
   - The `strategies/` crate is not registered as an OutLayer project yet, and there is no payment key.
   - The client and the fallback are tested against a fake.
   - The run record stores the hash of the LOCALLY built wasm. OutLayer compiles its own binary from GitHub, so for OutLayer runs the code hash in the attestation (`attestation.record`) is what counts.
4. **Strategy NFT.**
   - The contract is not deployed. The deploy commands are in `contracts/strategy-nft/README.md`; it locks about 3.3 NEAR of storage.
   - The publisher needs a **full-access** key, because `record_run` attaches a storage deposit. Use a dedicated account holding a small amount of NEAR and add it with `add_recorder`.
   - Publishing was not run on-chain.
5. **NEAR AI.** No key, so the rule-based fallbacks ran. The default model `deepseek/deepseek-v3.2` is confirmed to be in NEAR AI's live model list.

## Limitations

- Live runs use daily closes plus the current price as the latest point. Paper fills use catalogue prices minus `PAPER_COST_BPS`, not real quotes (a paper pilot has no agent to quote against).
- One process with SQLite (`data/`). For more than one instance, the database and the scheduler need a lock.
- `NEAR_INTENTS_PARTNER_KEY` from the template is not used yet.
- `DISCLAIMER.md` mentions "the license in this repository", but there is no LICENSE file. That choice is the owner's.
- Web UI: not done.

## Toolchain on this Mac

- Node 24.22.3 via nvm (the SDK needs Node 24+).
- The `wasm32-wasip1` and `wasm32-unknown-unknown` targets on the default nightly.
- Rust 1.86.0 for the contract; cargo-near 0.22.0 is in `~/.cargo/bin`.
