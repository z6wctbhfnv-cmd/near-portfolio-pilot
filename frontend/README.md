# Dolya frontend

Next.js 15 app for NEAR Portfolio Pilot, branded **dolya**. It talks to the Pilot backend in `../backend`.

```bash
npm install
npm run dev            # http://localhost:3000
```

Start the backend in another terminal (`cd ../backend && npm start`, port 8787). Point the app at another backend with `NEXT_PUBLIC_API_BASE=https://…`.

## What talks to what

| Screen | Backend |
|---|---|
| Rules (`/start`) | `POST /v1/mandate/parse`, then `POST /v1/pilots` (paper) |
| Portfolio (`/dashboard`) | pilot, portfolio, runs, snapshots, reviews; Run now, Freeze/Resume (`PATCH paused`), Review now |
| Strategies (`/strategies`) | `GET /v1/strategies`, a 90-day `backtest` per card, `PUT /v1/pilots/:id/strategy` |
| Connect wallet | NEAR wallet selector (Meteor, HERE, Intear, MyNearWallet), mainnet |
| Leaderboard (`/leaderboard`) | NFT contract on testnet over RPC (read-only); backtests from `public/backtests.json` (exported from `../web/data/report.json`) |
| Write a script (`/create`) | `POST /v1/scripts/draft`; mint with `mint_strategy` from a testnet wallet |
| Live owner (`/start`, `/dashboard`) | `POST /v1/pilots` (live), `/grants`, `/policy`, `/freeze`, `/unfreeze`, `/v1/intents/:cid/submit`, `GET /v1/intents/:cid`, `GET /v1/pilots/:id/intents` |
| Tasks (`/dashboard`) | `PUT /v1/pilots/:id/strategy` with `dca` for scheduled buys |

The pilot this browser follows is kept in `localStorage` (`dolya.pilot`). With no pilot, or with the backend offline, the screens show demo data and say so.

Two wallets: the owner's main wallet is on **mainnet** (the Agent API is mainnet-only). Script NFTs live on **testnet** (`pilot-nft2-14805.testnet`), so NFT actions use a second, testnet wallet connection (Meteor or MyNearWallet) with its own storage prefix. Every NFT call opens a confirmation sheet with the method, arguments, deposit and the same call for near-cli; nothing is sent until the person signs in their wallet. Meteor and MyNearWallet keep one session per browser whatever the network, so the testnet picker greys out the wallet the mainnet session uses, the testnet selector is only created on `/leaderboard`, `/create` or when an NFT sheet opens, and each side ignores an account from the other network.

Override the NFT contract with `NEXT_PUBLIC_NFT_CONTRACT`, `NEXT_PUBLIC_NFT_NETWORK`, `NEXT_PUBLIC_NFT_RPC`, `NEXT_PUBLIC_NFT_EXPLORER`, `NEXT_PUBLIC_NFT_FEE_TOKEN`.

## Status

Checked in the browser at desktop width and at 375 px, against testnet reads and a local backend with no keys (paper mode). No transaction was signed or sent while testing.

| Feature | State |
|---|---|
| **Leaderboard** | Done. All script NFTs from the contract: holder, copiers, copy fee, bond, sale price, version label (`v2 · changed 10 Nov 2026` shows on real data), simulated-checkpoint label. Returns, worst dip and return/dip come from backtests and are labelled as demo data. Periods, % or $, sort, spot-only and profitable-only filters. |
| **NFT market: list, delist, buy** | Done in the UI, testnet wallet signs. Gated: holder tools work only for the holder's account; others see them in a labelled demo view. Not signed during testing. |
| **Copy a script (`follow`)** | Blocked. `follow` is signed by the copier's *agent* account, which lives on mainnet, while the NFT contract is on testnet; and every holder bond is $0 of the $100 minimum, so the contract refuses followers today. The sheet shows the fee, bond and open parameters (copier's values saved in this browser) and says "coming soon". Needs a backend route. |
| **Holder's copy fee (0–10%), open parameters, hide** | Done (`set_copy_fee`, `set_open_params`, `set_hidden`). |
| **New script version** | Done (`update_script` from code or hash; "vN · changed <date>" label; the record restarts). |
| **Referrals** | Minimal on purpose, mechanics TBD. `?ref=<account>` is remembered (first link wins); the invited person can record it with `set_referrer`; an invite link with a copy button. No payout UI. |
| **Presets and limits in words** | Done. Careful / Balanced / Bold set real mandate fields (risk, per-trade cap, daily budget, trades per hour, safety stop) and keep the owner's weekly/monthly limits. Limits in words map onto mandate fields (per trade, per day/week/month, trades per hour, safety stop, approval, delay, weekdays, which assets) and are signed. Limits with no mandate field (cap per asset, minimum stablecoins, leverage, daily loss stop) are shown as "not enforced yet". |
| **Voice** | Done. Browser speech recognition (Chrome, Edge, Safari) on the rules, limits, tasks and script idea. Optional private voice: Whisper on NEAR AI with the owner's own key, kept in this browser (ported from `web/`). |
| **Tasks** | Partly. Scheduled buys are real: they switch the pilot to the backend's `dca` strategy (it counts days, not weekdays). Price-triggered tasks ("if BTC below 60k, buy") are saved in this browser only and labelled "not running yet"; `web/` never ran them either. |
| **AI writes the script** | Done: idea → `/v1/scripts/draft` → static checks → sha256 → `mint_strategy`. The backend needs `NEARAI_API_KEY`; without it the page says so and the owner can write the code. Backtesting user code is not available (the backend backtests only built-in strategies). |
| **Live pilot, signed by the owner** | Wired end to end: Owner Terms, OutLayer terms and the risk notice before signing → `POST /v1/pilots` (live, reviewed mandate, `accepted_terms`) → the Agent API preview → sign → submit → poll (UNCERTAIN keeps polling the same id) → runner grant → sign → submit → poll. The dashboard lists pending signatures and offers grant, re-sign rules, freeze and unfreeze; Freeze on a live pilot pauses the runner and asks for the signed freeze. Not run against the real Agent API: the backend has no partner key here, and it answers 503, which the page explains. |
| **Passkey owner** | Done (ported from `web/`). The only owner that can sign every step today. |
| **NEAR wallet owner** | Partly. NEP-413 steps (grant, policy update) sign with `signMessage`. `agent_create`, freeze and unfreeze need NEP-366 delegate actions, which none of the four wallets in wallet-selector 10 implements; the page says so and points to a passkey. |
| **AI paid from NEAR staking rewards** | Not built. `web/` only mentions it in one line of text; there is no code for it anywhere in the repo. |

Not wired yet: deposits into the agent wallet, and the NEAR AI "ask" screen from `../web`.

## Brand assets

- Headings and logo use **RoadRadio**. It is not on a font CDN: put `RoadRadio-Bold.woff2` in `public/fonts/`. Until then Unbounded is used.
- The 3D objects in `public/3d/` are rendered by the dev-only page `/studio` (three.js) and saved through `/api/save`. To add one, write a builder in `app/studio/page.tsx` and open `/studio?only=<name>`.
- Token icons in `public/tokens/` come from `cryptocurrency-icons` and `@web3icons/core`.
