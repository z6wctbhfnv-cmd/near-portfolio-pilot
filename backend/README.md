# Backend

TypeScript on Node 24: Fastify, `node:sqlite` and the official `@near-intents-agent-api/sdk`. Start it with `npm start`; the configuration is in `../.env.example`.

## Routes

Every response is JSON. Errors look like `{ "error": { "code", "message", ... } }`. Agent API errors keep their own `code` and `layer`. When `PILOT_API_TOKEN` is set, every route except `/health` and `/v1/config` needs `Authorization: Bearer <token>`.

### Meta
| Method | Path | |
|---|---|---|
| GET | `/health` | liveness, whether the WASM is built |
| GET | `/v1/config` | what is configured (no secret values) |
| GET | `/v1/network` | Agent API dependency status |
| GET | `/v1/universe` | managed assets with live price and decimals |
| GET | `/v1/strategies` | catalogue with JSON Schema for each strategy's parameters |
| POST | `/v1/strategies/:id/backtest` | `{params, days?, to?, initial_usd?, cost_bps?}` → metrics, buy-and-hold benchmark, equity curve |

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
| GET | `/v1/pilots/:id/nft` | strategy NFT token id, the on-chain history if configured, and local run records |

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

## Scheduler

Every few minutes the scheduler does four things:
- runs pilots whose `every_hours` has passed;
- reconciles open live swaps: it polls `correlation_id`s, and replays `retry_pending` under the same key only while `LIVE_EXECUTION=true`;
- follows submitted owner intents to their end;
- runs weekly reviews.

Set `SCHEDULER_ENABLED=false` to turn it off.

## Tests

`npm test` runs 34 tests against in-process fakes of the Agent API, OutLayer, NEAR AI and Binance. Nothing goes over the network. `npm run smoke` makes read-only calls to the real services.
