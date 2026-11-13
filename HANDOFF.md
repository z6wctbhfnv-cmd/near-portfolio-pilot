# Handoff

## Where the project stands (13 Nov 2026, the full dolya)

Branch `dolya-full` joins the backend gap work and the dolya site, puts every backend feature on the site, and makes a fresh clone runnable with no setup. Nothing in it moved real money or wrote on chain.

**Run it:** `npm run setup`, then `npm run tour` (9 steps, exit code 0), `npm test`, `npm run dev`. The README has the "do X, see Y" tables.

| Checked | Result |
|---|---|
| Backend | `npm test`: 89 tests against fakes (Agent API, NEAR RPC, OutLayer, NEAR AI, Hyperliquid testnet, market data) |
| Judge tour | `npm run tour`: 9/9 steps on live public prices and testnet reads, about a minute |
| NFT contract | `cargo test`: 63 tests (9 new for offers); `cargo near build non-reproducible-wasm --no-abi` builds |
| Strategies | `cargo test`: 10 tests |
| Secrets | The history of every branch scanned for keys and tokens: only test dummies and `.env.example` |
| Site | Every screen at 12 widths from 320 to 1920 px: no horizontal overflow, no clipped or unrevealed headline, no console errors; flows walked in a headless browser |

**New since the gap PRs**

- Site: no invented balances (an empty state and a one-click paper portfolio); dashboard cards for the health check, copying, fees and the swarm; copy from the leaderboard; price tasks run by the backend; a Strategy NFTs section on the landing page; engine backtests for the copyable scripts on the leaderboard.
- Backend: `follow` / `unfollow` (paper), `GET /v1/scripts/:token/gate`, referrer, price tasks with a watcher, a daily option on backtests, a price-source fallback chain, the strategy NFT contract defaulting to the testnet deployment.
- Contract: offers held in escrow (`make_offer`, `cancel_offer`, `accept_offer`, views `offers`, `offer_of`), stored under new prefixes so the deployed contract upgrades without a migration.
- Repo: root `npm run setup | tour | test | dev`.

**Still open, and whose move it is**

| What | Who | Why it matters |
|---|---|---|
| Merge `dolya-full` into `main` and make the repository public | Repo owner | Judges clone the default branch; a private repo cannot be judged |
| Upgrade the testnet contract `pilot-nft2-14805.testnet` to the repo's build | Whoever holds its key | Offers and on-chain fee crediting are in the code but not in the deployed contract |
| Creator bonds ($100 of test USDC per script) on testnet | The scripts' holder `pilot-author-10734.testnet` | Until then the chain says copying is closed, and the site copies on paper only |
| Partner key for the Agent API, a small deposit | Owner | Live mode has only ever run against a fake API |
| NEAR AI key | Owner | Without it the rule-based fallbacks answer |
| Demo video, X post, submission form | Owner | See [docs/SUBMISSION.md](docs/SUBMISSION.md) and [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) |

The sections below are the earlier handoffs, kept for their detail.

---

## Backend gap work, 13 Nov 2026

Six backend items from the gap list. Nothing here moved real money, sent a live request, or wrote on chain (testnet included); only testnet views were read.

## Checked for real

| What | How |
|---|---|
| Backend | `npm test`: 82 tests (44 before, all now running with the WASM built; 38 new) against fakes of the Agent API, NEAR RPC and Hyperliquid testnet |
| NFT contract | `cargo test`: 54 tests, 12 new for `record_fee_payment` and the liabilities counter, including a withdrawal settling during the balance check |
| Strategies | `cargo test`: 10 tests; `npm run build:wasm` gives the same bytes as `backend/wasm/pilot-strategies.wasm` |
| Python | `pytest`: 94 tests pass on the Mac's Python 3.9. `test_agent_llm.py` and `test_tasks.py` need Python 3.10+ and were not run |
| Hyperliquid signing | Address, action hash and signature equal the official Python SDK's (0.24.0) on two orders, one with a builder fee (`backend/test/hl-vectors.json`) |
| Testnet contract state | `pilot-nft2-14805.testnet` holds 0 USDC, no bonds and no fee balances, so the contract upgrade needs no migration |

## The gap claims, checked

1. **Fees not collected:** true. Also, the assumed route did not exist: the Agent API's withdraw and transfer calls carry no `msg`, so an agent cannot `ft_transfer_call`, and the signed policy had no destination at all. The rates follow the contract: 5% to the holder (the holder may set 0–10%, read from `copy_fee`), **0.25% to Pilot**, of which 0.1% of profit goes to a referrer. The note "0.1% Pilot" mixed up the referral share with Pilot's fee.
2. **Bond not enforced:** mostly stale. The contract's `follow` already refuses copying below the bond. But our agents never call `follow`, nobody reported copiers' capital (so the requirement stayed at $100), and a rising requirement never stopped existing copiers. The backend now checks before every run.
3. **No health check:** true for the backend (only `pilot/health.py` existed).
4. **Revenue:** the 1Click app fee is blocked by the Agent API ([docs/REVENUE.md](docs/REVENUE.md)). The builder code is on testnet orders.
5. **Perps:** "the backend understands `*-PERP` weights" was not true: only the AI drafting prompt mentioned them.
6. **Swarm:** true; only the Python simulation had a supervisor.

## How the fee is paid (live)

1. When `FEE_PAYMENTS_ENABLED=true`, a new pilot's policy allows `swap` plus `withdraw`, with exactly one destination: `{withdraw, chain near, address <NFT contract>, memo null}`.
2. Each week the ledger takes value above the peak, after the last fee, with deposits added to the peak. Below `MIN_FEE_USD`, the fee is carried to a later week.
3. The agent previews, then withdraws USDC to the NFT contract under a stored Idempotency-Key, with the swap executor's retry and reconcile rules.
4. Once it settles, the recorder calls `record_fee_payment` and the contract credits the split.
5. If a week is not paid (blocked, refused, failed), the peak stays, so the profit is charged later and never twice.
6. A payment interrupted after its key was stored is replayed under that same key by the reconciler.

**Size limit.** The fee withdrawal counts against the signed policy like a swap: the USD budget and the USDC per-transaction limit (2 x `max_trade_usd`, so $100 with the defaults). A larger fee is refused every week and never paid, and the peak does not move, so nothing is lost but nothing is collected either. Splitting large fees into several payments is not built.

## Works only against fakes, needs the owner

1. **Contract upgrade.** `record_fee_payment` and the liabilities counter are not deployed. Deploying is the owner's call.
2. **Mainnet contract.** The Agent API is mainnet-only, so a live fee can only go to a mainnet NFT contract. The testnet one cannot receive it. That contract must also be storage-registered on mainnet USDC (`storage_deposit`), or the withdrawal is refused.
3. **Recorder key.** The function-call key must also list `record_fee_payment` (and `set_copied_capital` if `NFT_REPORT_COPIED_CAPITAL` is turned on).
4. **Owners re-sign.** Existing agents need a `policy_update` (`POST /v1/pilots/:id/policy`) to get the fee destination. **This changes what the owner signs, from "funds can never leave" to "funds can leave only to the NFT contract, as USDC, within the budget and per-asset limits".** Say so in the UI.
5. **Bonds, a behavior change.** Live pilots on the four built-in scripts now skip every run until `pilot-author-10734.testnet` locks at least $100 of USDC as bond per script (`ft_transfer_call` to the NFT contract with `msg {"token_id", "bond": true}`), or until `BOND_GATE=off`. Paper pilots still run and only report it.
6. **Hyperliquid testnet.** The code is ready behind `HL_PERPS_ENABLED`. A first real testnet order needs a funded testnet account (mock USDC) and the owner's OK. The builder fee needs `approveBuilderFee` from the main wallet first.

## Limitations

- Swarm pilots: no fees per sleeve, no NFT checkpoints and no drift replay yet. They run, net and book trades; the per-script record is in each run's `output.agents`.
- The drift check replays daily closes, so with an every-few-hours script some gap is normal; it warns at 2 points and stops at 5.
- The swarm's books are virtual. Live swaps are booked to the scripts that asked for them at their quoted amounts when sent, and every run first scales the books to the wallet. A swap that settles away from its quote, or has not settled by the next run, is spread pro rata over the sleeves that hold that asset, so live sleeve books are approximate.
- The health check never pauses by itself; only the owner's "Pause" does. The drawdown stop and the bond gate act on their own.
- The fee ledger values deposits at today's price; a deposit it cannot value blocks that week's fee rather than guessing.

## Follow-up found on the way (not fixed)

The current Agent API docs say the agent's account is its **confidential** balance: `confidential: false` is refused with `public_balance_exit_only`, and a deposit address needs `confidential` on in the policy. The backend still compiles `confidential: false`, reads balances with `source: "public"` and asks for deposits with `confidential: false`. Fix this before any live run.

---

# Handoff: backend + web app, 11–12 Nov 2026

Branch `backend` merged with `feat/web-ui`. What works, what was checked and how, and what still needs the owner.

## Checked for real

| What | How |
|---|---|
| Strategy logic (Rust) | `cargo test` in `strategies/`: 10 tests |
| WASM build and the same output in two runtimes | `npm run build:wasm`; a test compares our in-process WASI shim with `node:wasi`, byte for byte |
| Backend | `npm test`: 34 tests against fakes of the Agent API, OutLayer, NEAR AI and Binance |
| Public endpoints | `npm run smoke`: Agent API `/health`, `/v1/network`, `/v1/tokens` (all 7 universe assets are listed and priced), NEAR AI model list, WASM |
| Server on real data | Started locally on public prices. Rules parsed from Russian text, a paper pilot created, run (3 paper fills), valued, reviewed; a backtest over HTTP |
| NFT contract | `cargo test` in `contracts/strategy-nft/`: 29 tests. `cargo near build non-reproducible-wasm` produces a 333 KB wasm |

Backtests on real daily closes (Binance), 10 Nov 2024 → 10 Nov 2026, starting from 1000 USDC, with 30 bps cost per swap. Default parameters, no tuning, so this is in-sample and only illustrative. The backtester applies the strategy and the swap cost, but not the mandate's per-trade and daily caps:

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
   - The `strategies/` module is not registered as an OutLayer project yet, and there is no payment key.
   - The client and the fallback are tested against a fake.
   - An OutLayer project version is a published `.wasm` (`WasmUrl`), named by its sha256. GitHub builds are off on OutLayer by default (near-outlayer `PROJECT.md`, "Code sources and builds").
   - So: build with `npm run build:wasm`, put the file on any **public HTTPS** address, and create the project version with the OutLayer CLI or dashboard.
   - The version's hash then equals the `wasm_sha256` the backend records with every run and on the NFT. Keep that exact build file; a rebuild on another machine may give different bytes.
   - The repository is private, so the NFT's `source_url` (`…/tree/main/strategies`) is not publicly verifiable, and it only resolves once `backend` is merged into `main`. Verifiable history needs a public repo or a public mirror of `strategies/`.
4. **Strategy NFT (testnet).**
   - The backend uses the contract already deployed from `feat/web-ui`: `pilot-nft2-14805.testnet`. The older `record_run` contract from `backend` is gone.
   - A script's identity is `sha256("<wasm_sha256>:<strategy_id>")`. Four NFTs were minted for the WASM strategies by `pilot-author-10734.testnet`: `wasm-rebalance@v1`, `wasm-trend@v1`, `wasm-vol-target@v1`, `wasm-dca@v1`, for WASM `ccd95701…6795a`.
   - The recorder key is a function-call key on `pilot-nft2-14805.testnet` limited to `append_checkpoint` (0.25 NEAR gas allowance). It lives in the local `.env` only.
   - The backend appends one checkpoint per script per week. Nothing was appended yet: a checkpoint needs a full week of runs.
   - The WASM build is now reproducible: `npm run build:wasm` strips machine paths, and a build in another directory gave the same sha256. If `strategies/` changes, the hash changes, and the holder must call `update_script` with the new hash.
5. **NEAR AI.** No key, so the rule-based fallbacks ran. The default model `deepseek/deepseek-v3.2` is confirmed to be in NEAR AI's live model list.

## Limitations

- A trade larger than the mandate's per-trade cap or the remaining daily budget is shrunk to fit, so a big rebalance completes over several runs. Paper pilots apply the same caps, counting their own fills of the last 24 hours.
- Live runs use daily closes plus the current price as the latest point. Paper fills use catalogue prices minus `PAPER_COST_BPS`, not real quotes (a paper pilot has no agent to quote against).
- One process with SQLite (`data/`). For more than one instance, the database and the scheduler need a lock.
- `NEAR_INTENTS_PARTNER_KEY` from the template is not used yet.
- Licenses: MIT for `strategies/` and `contracts/`, Apache-2.0 for the rest.
- Web UI: live mode needs `apiBase` in `web/js/config.js` and the owner on `CONFIG.allowlist` (and on `LIVE_OWNERS` in the backend). It shows the backend's compiled policy before signing. Custom limits added on the Rules page are not part of the signed Agent API policy.
- No per-owner authentication on the backend: anyone who reaches it can read and change any pilot. Before a public deployment, set `CORS_ORIGINS` and `LIVE_OWNERS`, and keep paper pilots for the demo.

## Toolchain on this Mac

- Node 25 from Homebrew (the SDK needs Node 24+).
- Rust 1.95.0 pinned in `strategies/` (wasm32-wasip1) and in the contract; near-cli-rs 0.31.1.
