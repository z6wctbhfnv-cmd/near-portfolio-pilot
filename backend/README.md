# Backend

TypeScript on Node 24: Fastify, libSQL (a local SQLite file, or Turso) and the official `@near-intents-agent-api/sdk`. Start it with `npm start`; the configuration is in `../.env.example`. Every setting is optional: with none, it runs paper portfolios on live public prices and reads strategy NFTs from the testnet contract.

`npm run tour` walks the whole product path against this backend in one process and asserts every step (see the root README).

## Routes

Every response is JSON. Errors look like `{ "error": { "code", "message", ... } }`. Agent API errors keep their own `code` and `layer`. **Access.** `POST /v1/pilots` returns a `pilot_key` once (only its hash is stored). Every route of that pilot, and its runs, executions, reviews, intents, fee ledger entries and health checks, needs `X-Pilot-Key: <key>`; anything else gets 401. `GET /v1/pilots` (all pilots) is operator-only. `PILOT_API_TOKEN` is the operator token: `Authorization: Bearer <token>` opens every route. Pilots created before keys existed stay open.

### Meta
| Method | Path | |
|---|---|---|
| GET | `/health` | liveness, whether the WASM is built |
| GET | `/v1/config` | what is configured (no secret values) |
| GET | `/v1/network` | Agent API dependency status |
| GET | `/v1/universe` | managed assets with live price and decimals, and `source`: where the prices came from (the Agent API host, the production host, or the spot-price fallback) |
| GET | `/v1/strategies` | catalogue with JSON Schema for each strategy's parameters |
| POST | `/v1/scripts/draft` | `{idea}` → `{code, model}`: a user script drafted by NEAR AI (503 without `NEARAI_API_KEY`); the web app checks it, nothing runs it here |
| POST | `/v1/strategies/:id/backtest` | `{params, days?, to?, initial_usd?, cost_bps?, daily?}` → metrics, buy-and-hold benchmark, equity curve; with `daily: true` also `daily_start` and one return per day in `daily_returns` |

### Rules
| Method | Path | |
|---|---|---|
| POST | `/v1/mandate/parse` | `{text}` → mandate, policy to sign, strategy, warnings, notes (NEAR AI, or the rule parser as fallback) |
| POST | `/v1/mandate/compile` | `{mandate}` → policy + strategy |

### Pilots
| Method | Path | |
|---|---|---|
| POST | `/v1/pilots` | paper: `{name, text \| mandate \| strategy, initial_usd}`. Live: also `{mode:"live", owner, accepted_terms:true}`, and the answer carries an `owner_action` to sign |
| GET | `/v1/pilots`, `/v1/pilots/:id` | the pilot; for live pilots also the agent and its current policy |
| PATCH | `/v1/pilots/:id` | `{name?, review_auto_apply?, paused?}` |
| PUT | `/v1/pilots/:id/strategy` | `{id, params}`; on a live pilot it is checked against the signed policy's assets |
| GET | `/v1/pilots/:id/portfolio` | holdings valued in USD (paper holdings, or Agent API balances) |
| POST | `/v1/pilots/:id/run` | run one decision now |
| GET | `/v1/pilots/:id/runs`, `/v1/runs/:id` | each run with its input, output, engine, attestation and executions |
| GET | `/v1/pilots/:id/executions` | swaps; `blocked` and `refused` carry `error_code` |
| POST | `/v1/executions/:id/refresh` | re-read one swap's status |
| GET | `/v1/pilots/:id/snapshots`, `/events` | value history, log |
| GET | `/v1/pilots/:id/nft` | the script's `code_hash`, its NFT (found by hash), the weekly on-chain record, and local run records |

### Reviews
| Method | Path | |
|---|---|---|
| POST | `/v1/pilots/:id/review` | review now: `{period_days?}` |
| GET | `/v1/pilots/:id/reviews` | |
| POST | `/v1/reviews/:id/apply`, `/dismiss` | apply the bounded proposals, or dismiss them |

### Owner actions (live pilots)
Each of these returns `owner_action` = the Agent API's `generate-intent` answer. The owner's wallet signs `owner_action.intent.payload` unchanged. Then:

| Method | Path | |
|---|---|---|
| POST | `/v1/intents/:correlation_id/submit` | `{signed_data}`; when the intent settles, the pilot is updated (active, frozen, new policy, grant active) |
| GET | `/v1/intents/:correlation_id?wait_ms=` | status (long-poll up to 30 s) |
| POST | `/v1/pilots/:id/grants` | runner grant `{label?, ttl_days?}`; the `ngt_` token is kept AES-GCM-encrypted |
| POST | `/v1/pilots/:id/policy` | `{text \| mandate}` → `policy_update` with `expected_revision` |
| POST | `/v1/pilots/:id/freeze`, `/unfreeze`, `/archive` | |
| POST | `/v1/pilots/:id/deposit` | `{origin_asset, amount?}` → deposit address and `risk_notice` |
| GET | `/v1/pilots/:id/balances`, `/history`, `/intents` | |

### Copy fees (weekly, on new profit)
| Method | Path | |
|---|---|---|
| GET | `/v1/pilots/:id/fees` | `{terms, peaks, data}`: the fee terms (holder 5% default, Pilot 0.25%, referral 0.1% of profit out of Pilot's share), the high-water mark per script NFT, and one ledger row per week |
| POST | `/v1/pilots/:id/fees/settle` | compute (and pay) the last finished week now; idempotent. Answers `{row}` or `{skipped: reason}` |
| POST | `/v1/fees/:id/refresh` | re-read a live fee payment's status |

A ledger row's `status`: `no_profit`, `carried` (under `MIN_FEE_USD`, charged with a later week), `paper_paid`, `blocked` (with `error_code`: `fees_disabled`, `live_execution_disabled`, `fee_destination_missing`, `insufficient_balance`, `flows_unknown`, …; nothing was sent), then the Agent API's statuses for live payments. `record_status: recorded` means the NFT contract credited the split.

### Author bond
| Method | Path | |
|---|---|---|
| GET | `/v1/pilots/:id/copy-gate` | per script: `token_id`, `holder`, `own`, `held_usd`, `required_usd` (max of $100, 1% of copiers' capital, and the contract's figure), `open`, `reason` |

### Copying, referrer, price tasks
| Method | Path | |
|---|---|---|
| POST | `/v1/pilots/:id/follow` | `{token_id}`: copy a script NFT. A paper pilot switches to that script (the four `wasm-*` scripts run in this engine) and its fee ledger pays the NFT's holder. Answers `{pilot, gate, note}`; the gate is read from the contract. A live copy answers 409 `live_follow_unavailable` (the contract is on testnet, the Agent API is mainnet-only); a research-only script answers 409 `not_runnable` |
| POST | `/v1/pilots/:id/unfollow` | stop copying |
| GET | `/v1/scripts/:token/gate` | the bond gate for any script NFT, no pilot needed: `holder`, `held_usd`, `required_usd`, `open`, `reason` |
| POST | `/v1/pilots/:id/referrer` | `{referrer}`: recorded once (a NEAR account, not yourself) |
| GET, POST | `/v1/pilots/:id/tasks` | price tasks: `{asset, op: "<" \| ">", price, side: "buy" \| "sell", usd, text?}`; refused above the mandate's per-trade cap |
| DELETE | `/v1/pilots/:id/tasks/:task` | cancel a task |

A task fires once, on the first scheduler tick where its condition holds, through the same executor and mandate caps as a strategy run. Its `status`: `active`, `done`, `failed` (every swap hit a limit), `cancelled`. Paused and frozen pilots wait.

### Daily health check
| Method | Path | |
|---|---|---|
| GET | `/v1/pilots/:id/health` | `{latest, data}`: checks, newest first. Each has `status` (ok, warn, stop), `findings` [{check, severity, detail}] and `question` (null, or the text plus `options` `pause` / `keep`) |
| POST | `/v1/pilots/:id/health/check` | run today's check again now |
| POST | `/v1/health/:id/answer` | `{answer: "pause" \| "keep"}`. `pause` pauses the pilot (resume with `PATCH paused:false`); `keep` mutes the same findings for 3 days. 409 if already answered |

Checks: `errors`, `refused`, `schedule`, `stale_data`, `drift` (last week replayed from the real starting position with the same WASM), `slippage` (live fills against quotes), `bond`, `fees`.

### Swarm (several scripts in one wallet)
| Method | Path | |
|---|---|---|
| PUT | `/v1/pilots/:id/swarm` | `{scripts: [{key, id, params, cap?, weight?}], allocation?: "equal" \| "manual" \| "calm", review_every_days?}`, 1–5 scripts; checked against the signed policy |
| GET | `/v1/pilots/:id/swarm` | config, allocation and each sleeve's value |
| DELETE | `/v1/pilots/:id/swarm` | back to one strategy |

A swarm run's `output` has `agents` (each script's sleeve, trades and notes), `plan.crossed` (USD per asset crossed between scripts inside the wallet), `plan.dropped` (trades outside the policy) and the net `trades`.

### Perps (Hyperliquid testnet)
| Method | Path | |
|---|---|---|
| GET | `/v1/pilots/:id/perps` | `{enabled, network, data}`: perp orders with their `cloid` and status |
| GET | `/v1/perps/account` | the testnet account's equity and positions (read only) |

A run's `perp_orders` lists the orders that run placed.

## Scheduler

Every tick the scheduler:
- runs pilots whose `every_hours` has passed;
- reconciles open live swaps: it polls `correlation_id`s, and replays `retry_pending` under the same key only while `LIVE_EXECUTION=true`;
- follows submitted owner intents to their end;
- appends weekly NFT checkpoints (and, with `NFT_REPORT_COPIED_CAPITAL`, copiers' capital);
- runs weekly reviews;
- fires price tasks whose condition holds;
- settles last week's copy fees, follows fee payments in flight, and asks the contract to credit settled ones;
- runs the daily health check for up to 20 pilots (at most 5 drift replays per tick);
- looks up perp orders whose answer was lost, by `cloid`.

Set `SCHEDULER_ENABLED=false` to turn it off. On Vercel, Cron calls `GET /v1/cron` once a day.

## Tests

`npm test` runs 92 tests against in-process fakes of the Agent API, OutLayer, NEAR AI, Binance, the NEAR RPC (NFT views) and Hyperliquid testnet. Nothing goes over the network. The Hyperliquid signing test uses vectors produced by Hyperliquid's official Python SDK (`test/hl-vectors.json`). `npm run smoke` makes read-only calls to the real services.

The tests use the committed WASM in `wasm/`, so they run on a fresh clone without Rust. `npm run build:wasm` rebuilds it from `../strategies` (pinned toolchain; the build is reproducible).

## Prices

The token list with USD prices comes from the Agent API's public `GET /v1/tokens`. If the configured host does not answer, the production host is asked; if neither does, spot prices for the managed assets come from the public market-data API. A list up to an hour old is served if every source fails. Live swaps never run on fallback prices: their readiness check needs the Agent API itself.
