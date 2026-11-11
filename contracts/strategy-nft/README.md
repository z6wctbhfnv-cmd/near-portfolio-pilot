# strategy-nft — NEAR Portfolio Pilot strategy NFTs

A NEAR smart contract (Rust, `near-sdk` 5.27 + `near-contract-standards`) where **every NFT is a deterministic portfolio strategy** and carries its **verified run history on-chain**.

- Each token stores a `StrategyInfo`: id, version, the strategy WASM's `wasm_sha256`, source URL, optional OutLayer project, and params JSON (max 4 KB).
- Whitelisted **recorder** accounts (the backend) append a `RunRecord` after every strategy run (OutLayer TEE or local). Each run must use the token's current WASM hash.
- The contract keeps aggregate **stats** per token: run count, first and last timestamp, compounded cumulative return, equity index, peak, and max drawdown.
- The token owner can publish a **new strategy version**. The old version goes into a version history, so earlier runs stay explainable, and later runs must carry the new hash.
- Standards: NEP-171 (core), NEP-177 (metadata, spec `nft-1.0.0`, name `NEAR Portfolio Pilot Strategies`, symbol `PILOT`), NEP-181 (enumeration) and NEP-297 events. NEP-178 approvals are not enabled.

## Layout

| Path | What |
|---|---|
| `src/lib.rs` | Contract |
| `src/tests.rs` | Unit tests (`testing_env!`) |
| `rust-toolchain.toml` | Pins Rust **1.86.0** with wasm32 target (see Build) |
| `Cargo.toml` / `Cargo.lock` | Standalone crate. It has its own `[workspace]`, so a future root workspace won't absorb it |

## Methods

### Init and admin

| Method | Kind | Who | Notes |
|---|---|---|---|
| `new(owner_id)` | init | deployer | Sets the contract owner and the built-in NFT contract metadata |
| `add_recorder(account_id) -> bool` | call | contract owner | `false` if the account is already a recorder |
| `remove_recorder(account_id) -> bool` | call | contract owner | `false` if the account was not a recorder |
| `get_recorders() -> Vec<AccountId>` | view | | |
| `is_recorder(account_id) -> bool` | view | | |
| `get_owner() -> AccountId` | view | | Contract owner |

### Strategy NFTs

| Method | Kind | Who | Notes |
|---|---|---|---|
| `mint_strategy(token_id, receiver_id, token_metadata, strategy) -> Token` | call, **payable** | anyone | Caller pays all storage (NFT + strategy record); the excess deposit is refunded. Panics `Token already exists` if the token exists |
| `record_run(token_id, record) -> u64` | call, **payable** | recorders | Returns the new run's index. Recorder pays storage; the excess is refunded |
| `update_strategy_version(token_id, version, wasm_sha256, source_url)` | call, **payable** | token owner | Retires the current version to history. The new `version` label must differ. Attach a deposit to cover storage growth; the excess is refunded |
| `get_strategy(token_id) -> Option<StrategyView>` | view | | Strategy info + stats + owner + token metadata |
| `get_runs(token_id, from_index?, limit?) -> Vec<RunRecord>` | view | | Oldest first. `limit` defaults to 100 and is capped at 100. Unknown token returns `[]` |
| `get_run(token_id, run_id) -> Option<RunRecord>` | view | | Lookup by `run_id` |
| `get_stats(token_id) -> Option<RunStats>` | view | | |
| `get_versions(token_id) -> Vec<VersionEntry>` | view | | Oldest first; the **last entry is the current version** (`to_run_index` = `retired_at_ms` = `null`) |

### NEP-171 / 177 / 181 (from near-contract-standards)

`nft_transfer` (1 yocto), `nft_transfer_call` (1 yocto), `nft_token`, `nft_resolve_transfer` (private), `nft_metadata`, `nft_total_supply`, `nft_tokens`, `nft_supply_for_owner`, `nft_tokens_for_owner`.

When the NFT is transferred, the right to update the strategy version moves with it.

## JSON interface (for the backend and frontend)

All `u64`/`i64` fields are **plain JSON numbers**. The only string-encoded integers are `index_e6` and `peak_index_e6` (`U128`).

Hashes (`wasm_sha256`, `input_sha256`, `output_sha256`) must be **64 hex chars**. Uppercase is accepted; the contract stores them lowercase and compares the WASM hash case-insensitively.

### `mint_strategy` args

```json
{
  "token_id": "momentum-rotation-v1",
  "receiver_id": "alice.testnet",
  "token_metadata": { "title": "Momentum rotation", "description": "…", "media": null },
  "strategy": {
    "strategy_id": "momentum-rotation",
    "version": "1.0.0",
    "wasm_sha256": "<64 hex>",
    "source_url": "https://github.com/…/tree/v1",
    "outlayer_project": "owner/momentum",
    "params_json": "{\"lookback_days\":30}"
  }
}
```

Limits:
- `token_id`: 1–128 bytes.
- `strategy_id` and `version`: 1–128 bytes.
- `source_url` and `outlayer_project`: up to 512 bytes.
- `params_json`: up to 4096 bytes. The contract checks only its length, not whether it is valid JSON.

### `record_run` args

```json
{
  "token_id": "momentum-rotation-v1",
  "record": {
    "run_id": "2026-11-11T12:00:00Z",
    "timestamp_ms": 1762862400000,
    "engine": "outlayer",
    "input_sha256": "<64 hex>",
    "output_sha256": "<64 hex>",
    "attestation_ref": "<OutLayer call_id or tx hash>",
    "wasm_sha256": "<64 hex, must equal the token's current wasm_sha256>",
    "period_return_bps": 125,
    "equity_usd_e6": 10012500000
  }
}
```

`record_run` rejects the run in these cases:
- the caller is not a recorder (`Only recorders can record runs`)
- unknown token (`Token not found`)
- duplicate `run_id` for this token (`run_id already recorded for this token`)
- `timestamp_ms` lower than the previous run's (an equal timestamp is allowed)
- `engine` is not `outlayer` or `local`
- a hash is not 64 hex chars
- `wasm_sha256` does not equal the current one (`wasm_sha256 does not match …`)
- `period_return_bps < -10000`
- `run_id` longer than 128 bytes, or `attestation_ref` longer than 512 bytes

The same `run_id` may be used on different tokens.

A stored `RunRecord` holds the input fields plus:
- `index` (0-based)
- `strategy_version` (the version label at record time)
- `recorder_id`
- `block_height`
- `block_timestamp_ms`

### `RunStats`

```json
{
  "runs_count": 2, "first_ts": 1762862400000, "last_ts": 1762862460000,
  "cumulative_return_bps": -1200, "index_e6": "880000", "peak_index_e6": "1100000",
  "max_drawdown_bps": 2000, "last_equity_usd_e6": 8800000000
}
```

`first_ts`, `last_ts` and `last_equity_usd_e6` are `null` until the first run.

### Stats math

All arithmetic is integer (no floats). The stats are built on an equity index, kept in `i128` with 1e12 precision and starting at 1.0. In views it appears scaled to 1e6, so it starts at `1_000_000`.

On each run:
- `index = index * (10000 + period_return_bps) / 10000`. This is the compounding `(1+c)(1+r)-1`.
- `peak = max(peak, index)`.
- `drawdown = (peak - index) * 10000 / peak`. `max_drawdown_bps` is the maximum drawdown seen so far.
- `cumulative_return_bps = (index - 1) * 10000`, truncated toward zero.

Example: +10% and then −20% gives `cumulative_return_bps = -1200` and `max_drawdown_bps = 2000`.

### Events (NEP-297, `EVENT_JSON:` logs)

- Library `nep171` / `nft_mint` on mint, and `nft_transfer` on transfer.
- `{"standard":"pilot","version":"1.0.0","event":"run_recorded","data":[{...}]}`. The data object holds:
  - `token_id`, `run_id`, `index`, `timestamp_ms`, `engine`
  - `wasm_sha256`, `input_sha256`, `output_sha256`, `attestation_ref`
  - `period_return_bps`, `equity_usd_e6`
  - `cumulative_return_bps`, `max_drawdown_bps`
  - `recorder_id`
- `pilot` / `strategy_minted`: `token_id`, `owner_id`, `strategy_id`, `version`, `wasm_sha256`.
- `pilot` / `strategy_version_updated`: `token_id`, `old_version`, `old_wasm_sha256`, `version`, `wasm_sha256`, `source_url`, `from_run_index`.
- `pilot` / `recorder_added` and `recorder_removed`: `account_id`.

### Storage deposits

Measured in unit tests at 1e19 yocto per byte:

| Call | Cost | Suggested deposit |
|---|---|---|
| `mint_strategy` with small params | about 0.0098 NEAR | 0.1 NEAR. A 4 KB `params_json` adds about 0.041 NEAR |
| `record_run` | about 0.0049 NEAR | 0.01 NEAR |
| `update_strategy_version` | about 0.0016 NEAR | 0.01 NEAR |

Any deposit above the cost is refunded to the caller in the same transaction. If the deposit is too small, the call panics with `Must attach X to cover storage`.

**The recorder must sign `record_run` with a full-access key.** A function-call access key cannot attach a deposit.

## Build and test

Requirements:
- `rustup`. `rust-toolchain.toml` selects 1.86.0 plus `wasm32-unknown-unknown`. If your rustup does not auto-install it, run `rustup toolchain install 1.86.0 --profile minimal --target wasm32-unknown-unknown`.
- `cargo-near` 0.22.x: `cargo install cargo-near@0.22.0 --locked`. 0.23 needs rustc ≥ 1.95 to install, so build it with a newer toolchain if you want it.

```bash
cd contracts/strategy-nft

# native unit tests (29 tests)
cargo test

# deployable wasm (wasm-opt + embedded ABI)
cargo near build non-reproducible-wasm
# -> target/near/strategy_nft.wasm   (~333 KB)
# -> target/near/strategy_nft_abi.json
```

### Why Rust 1.86 and near-sdk 5.27

- **Newer rustc emits wasm features that nearcore rejects.** cargo-near enforces this: for a near-sdk that targets protocol < 84, it refuses to build with rustc > 1.86. We tried the machine's 1.94 nightly and got `wasm, compiled with rustc 1.94.0-nightly exceeds the max allowed 1.86.0`.
- **near-sdk 5.27.0 is the newest release with MSRV 1.86.** 5.28–5.29 need 1.93 and 5.30 needs 1.95.
- **Cargo.lock is resolved MSRV-aware** (`resolver = "3"`, `rust-version = "1.86"`).
- **The native tests pass on both 1.86.0 and nightly 1.94.** To run them on another toolchain: `cargo +nightly test`.

A plain `cargo build --target wasm32-unknown-unknown --release` also works under the pinned toolchain, but it produces a 617 KB unoptimized wasm. Prefer `cargo near build`: it runs `wasm-opt` and embeds the ABI.

## Deploy (documentation only — nothing below has been run)

Uses near-cli-rs (`near`). Replace the account names.

```bash
CONTRACT=pilot-strategies.testnet
OWNER=pilot-owner.testnet
RECORDER=pilot-recorder.testnet

# deploy + init
near contract deploy $CONTRACT use-file target/near/strategy_nft.wasm \
  with-init-call new json-args "{\"owner_id\":\"$OWNER\"}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send

# allow the backend recorder
near contract call-function as-transaction $CONTRACT add_recorder \
  json-args "{\"account_id\":\"$RECORDER\"}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  sign-as $OWNER network-config testnet sign-with-keychain send

# mint a strategy (anyone)
near contract call-function as-transaction $CONTRACT mint_strategy \
  file-args mint.json prepaid-gas '100 Tgas' attached-deposit '0.1 NEAR' \
  sign-as $OWNER network-config testnet sign-with-keychain send

# record a run (recorder, full-access key)
near contract call-function as-transaction $CONTRACT record_run \
  file-args run.json prepaid-gas '50 Tgas' attached-deposit '0.01 NEAR' \
  sign-as $RECORDER network-config testnet sign-with-keychain send

# views
near contract call-function as-read-only $CONTRACT get_strategy \
  json-args '{"token_id":"momentum-rotation-v1"}' network-config testnet now
near contract call-function as-read-only $CONTRACT get_runs \
  json-args '{"token_id":"momentum-rotation-v1","from_index":0,"limit":50}' network-config testnet now
```

Deploying stakes storage for about 333 KB, roughly 3.4 NEAR, on the contract account.

## Not done / caveats

- The wasm was built, but it has **not been deployed or run in a sandbox**. Only native unit tests exist; there are no near-workspaces integration tests.
- No NEP-178 approvals, so marketplaces that need `nft_approve` won't list these tokens. No burn.
- Recorders are trusted. The contract checks the WASM hash, ordering and uniqueness, but it does not verify the OutLayer TEE attestation on-chain. `attestation_ref` is stored for off-chain verification.
- `add_recorder` has no 1-yocto check. Storage for the recorder set is paid from the contract balance.
