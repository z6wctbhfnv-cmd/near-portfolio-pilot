# dolya

**Your moves, explained. Copy, create, earn.** Built at NEAR HACKATHON, November 2026.

dolya ("доля": a share, a slice) lets you tell software how to handle your crypto in plain words, sign those rules once, and then read a reason for every move it makes. Strategies are NFTs with a public record: you can copy one, write your own, or buy one together with the income it earns.

1. **Say it.** "Careful: NEAR, BTC and ETH. Max $300 a day, $50 per trade." becomes exact limits.
2. **Sign it.** The limits become a NEAR Intents Agent API policy that the owner signs once. It allows swaps only and has no destination, so funds cannot leave the wallet, whatever the software or an AI does.
3. **Read it.** Deterministic strategy scripts trade inside those limits. Every move, and every skipped one, comes with a reason.
4. **Copy it.** Every strategy is an NFT on NEAR. Copiers pay its holder 5% of their new profit, only above their previous peak. The holder keeps a bond. The NFT can be sold, or bought with an offer, and the income goes with it.

The project was first named NEAR Portfolio Pilot; code and the contract still use "pilot" in names.

## Try it in five minutes

You need **Node 22 or 24** (`nvm install 24 && nvm use 24`; both are tested) and nothing else: no keys, no wallet, no Rust (the strategy WASM is committed). Everything below trades **paper money** on live public prices and reads strategy NFTs from NEAR testnet.

```bash
git clone https://github.com/z6wctbhfnv-cmd/near-portfolio-pilot && cd near-portfolio-pilot
npm run setup     # installs backend/ and frontend/ dependencies
npm run tour      # walks the whole product path in about a minute; exit code 0 = every step did what it says
npm test          # 91 backend tests against in-process fakes, no network
npm run dev       # backend on http://127.0.0.1:8787, site on http://localhost:3000
```

### `npm run tour`: do X, see Y

The tour boots the real backend in one process with a throwaway database and calls the same HTTP routes the site calls. Each step prints what it does, what it sees, and asserts it.

| # | It does | You see |
|---|---|---|
| 1 | Sends the rules sentence to `POST /v1/mandate/parse` | The limits it understood, and the policy: `actions ["swap"], destinations only []` |
| 2 | Backtests the chosen strategy on one year of real daily prices | Return and max drawdown next to buy-and-hold |
| 3 | Creates a paper portfolio and runs it | The strategy wanted about $300; the rules cap a trade at $50, so $150 went through: `your rules won` |
| 4 | Reads `wasm-trend@v1` from the testnet contract and copies it | Holder and bond from chain, the pilot now runs the copied script, fee terms 5% + 0.25%; a research-only script is refused with a reason |
| 5 | Runs the daily health check | Findings, and the owner's question when something needs a decision |
| 6 | Adds the task "if BTC below $X buy $25" and runs one scheduler tick | The task fired once at the live price; another task keeps waiting |
| 7 | Puts two scripts in one wallet (a swarm) and runs | Each script agent's sleeve and what the main agent netted |
| 8 | Runs the weekly review | A summary and bounded proposals (NEAR AI with a key, a rule-based reviewer without) |
| 9 | Pauses the pilot and ticks the scheduler | 0 new runs while paused |

It ends with `9/9 steps passed`.

### The site: do X, see Y

Run `npm run dev` and open http://localhost:3000.

| Do | See |
|---|---|
| **Portfolio** → "Start with $1,000 of paper money" | A paper portfolio near $999 after its first run, and "Moves, explained" with the reason for the first swaps |
| **Rules** → type a sentence → Continue | "Here's what we understood": daily limit, largest trade, assets, "Withdrawals: your wallet only"; presets Careful / Balanced / Bold; a microphone for voice input |
| **Leaderboard** | Strategy NFTs read live from [`pilot-nft2-14805.testnet`](https://testnet.nearblocks.io/address/pilot-nft2-14805.testnet): holder, copiers, copy fee, bond, sale price. Rows marked **copy** run in dolya's own engine and show two-year backtests from it |
| Open "Trend filter" → "Copy into my paper portfolio" | The copy starts on paper; Portfolio now shows "Copying wasm-trend@v1" with the holder's bond from chain, and a Fees card |
| Tasks card → `if BTC below 100000 buy $25` → Start watching | Within a minute the task shows "done" with the price it fired at |
| Agent swarm card → pick two scripts → run | One wallet, two script agents, their sleeves |
| Daily health check → Check now | Findings; a "Pause / Keep running" question when something is off |
| Freeze | A red banner; nothing trades until you resume |
| **Leaderboard** → "Write your own" | Idea → NEAR AI drafts a script → checks → mint as an NFT (needs `NEARAI_API_KEY`; without it the page says so) |

Buying, listing and offers on the leaderboard are real testnet transactions signed in a testnet wallet; nothing is sent without a confirmation sheet that shows the exact call.

## What is real, what is paper, what needs keys

| Piece | State today | Checked by |
|---|---|---|
| Strategies: 4 deterministic scripts in Rust, compiled to one WASI module | Real. The same binary runs backtests, paper runs, live runs and is built for OutLayer's TEE | 10 Rust tests; a test shows byte-identical output under two WASI runtimes |
| Rules → mandate → policy (swaps only, no destination, USD budget, per-asset caps) | Real | Tests, tour step 1 |
| Paper portfolios on live prices, with the mandate's caps enforced | Real | Tests, tour, the site |
| Prices | Agent API token list; falls back to the production host and then to spot tickers, so the demo survives the demo host going away | Test |
| Strategy NFT contract (`contracts/strategy-nft`) | Deployed on **testnet** (an earlier build: mint, weekly record, follow, bond, copy fee, list / buy, referrer). The repo's contract also has fee crediting (`record_fee_payment`) and **offers** (`make_offer`, `accept_offer`, `cancel_offer`); those are unit-tested and not deployed yet | 63 contract tests |
| Leaderboard and market UI | Reads testnet live. Wallet-signed calls are implemented; none was signed during development | Manual, read paths |
| Copying a strategy | Paper: real, with the holder and bond read from chain. Live: waits for the contract on mainnet (the Agent API is mainnet-only) | Tests, tour step 4 |
| Weekly copy fees with a high-water mark | Paper ledger: real. Live payment path: against fakes only | Tests |
| Live trading through the NEAR Intents Agent API | Implemented on the official SDK: owner intents, grants, readiness check, dry quote before every swap, idempotency keys saved before sending, reconcile without new keys. **Tested against a fake API only**: we had no partner key. Off unless `LIVE_EXECUTION=true` | Tests |
| OutLayer TEE runs | Client and fallback implemented, tested against a fake; the module is not registered on OutLayer yet | Test |
| NEAR AI (rules parsing, weekly review, script drafts) | Implemented; without `NEARAI_API_KEY` rule-based fallbacks run and the UI says so | Tests |
| Hyperliquid testnet perps | Implemented, signing matches the official SDK's vectors; off by default; no order was ever sent | Tests |

More detail, including what was never run for real, is in [HANDOFF.md](HANDOFF.md).

## What NEAR does here

- **NEAR Intents Agent API** is the security boundary. The owner signs one policy; the agent wallet itself refuses anything outside it. Our policy allows `swap` only, lists no destination, and carries the USD budget and per-asset caps, so a bug or a prompt injection in our backend cannot move funds out. Every live swap is quoted dry first and sent under a stored idempotency key.
- **A NEAR contract** (NEP-171) makes strategies ownable: one NFT per script, bound to the script's code hash; an append-only weekly record; `follow` for copiers; a creator bond that gates copying; copy fees split between holder, platform and referrer; sale, and offers held in escrow.
- **OutLayer**: strategies are deterministic WASI programs (JSON in, JSON out, no clock, no network), so a TEE run can attest exactly which code produced which decision.
- **NEAR AI Cloud**: turns the owner's words into a mandate, writes the weekly review and drafts new scripts. It never trades: its proposals are whitelisted, clamped to ±25% and applied only if the owner agrees.

## Tracks

NFTs That Do Something · AI Security & Defense · Unstoppable DeFi · AI Swarms · Agent Economy.

## How it fits together

```
 owner's words ──► /v1/mandate/parse (NEAR AI or rule parser)
                        │
                        ▼
                 mandate ──► Agent API policy (swap only, no destination,
                        │     USD budget, per-asset caps, schedule)
                        ▼
      owner signs agent_create + grant (backend never holds owner keys)
                        │
   scheduler ──► Runner: holdings + prices + history ──► strategy WASM
                        │        (OutLayer TEE with attestation, or the same .wasm locally)
                        ▼
                 trades ──► Executor
                              paper: fills at live prices minus cost
                              live:  readiness → dry quote → key saved → swap → reconcile
                        │
                        ├──► snapshot, weekly checkpoint ──► strategy NFT (record on NEAR)
                        ├──► weekly copy fee above the high-water mark ──► NFT holder
                        ├──► daily health check ──► owner: Pause / Keep running
                        └──► weekly review (NEAR AI): summary + bounded proposals
```

**Safety by construction**

- The signed policy allows only `swap` and has no destination. Funds can never leave the agent account. (If live copy fees are turned on, which is off by default, the policy gains exactly one destination: the strategy NFT contract, for the USDC fee.)
- Live swaps also need `LIVE_EXECUTION=true`, an active owner grant, and a policy that is applied and synced.
- Each swap needs a clean dry quote and must fit the mandate's own per-trade and budget caps; a bigger trade is shrunk, not refused forever.
- Idempotency keys are stored before every request. Retries replay the same key; uncertain operations are polled, never resent.
- The health check never pauses by itself and the AI never trades: the owner decides.

## Repository

| Path | What |
|---|---|
| `frontend/` | The dolya site (Next.js): rules, portfolio, strategies, leaderboard and market, script studio |
| `backend/` | TypeScript service: API, scheduler, Agent API gateway, executors, backtester, fees, health, swarm, AI review. Routes in [backend/README.md](backend/README.md) |
| `strategies/` | Rust strategies (rebalance, trend, vol_target, dca) → one WASI module. `backend/wasm/` holds the committed build |
| `contracts/strategy-nft/` | The strategy NFT contract |
| `skill/near-portfolio-pilot/` | An IronClaw skill that drives the backend |
| `pilot/`, `sim/`, `tests/` | Python research code: simulation on hourly history, perps, fee model |
| `web/` | The earlier static prototype of the app, kept for reference |
| `docs/` | Demo script, submission notes, key setup, findings |

Optional checks if you have Rust: `cargo test` in `strategies/` and in `contracts/strategy-nft/`.

To go beyond paper mode, copy `.env.example` to `.env`; every key is optional and described there. Read [DISCLAIMER.md](DISCLAIMER.md) before using real funds: this is an unaudited hackathon build.

## Hackathon notes

- All code in this repository was written during the hackathon; the first commit is dated 9 November 2026. There is no pre-hackathon code.
- Built by a small team working with Claude Code.
- Some of the same people also work on one other, independent entry: Knight's Isle (`z6wctbhfnv-cmd/knights-isle`), an idle island game in Telegram. The rules ask each README to name the other.

## License

MIT for `strategies/` and `contracts/` (their own `LICENSE` files), Apache-2.0 for everything else ([LICENSE](LICENSE)).
