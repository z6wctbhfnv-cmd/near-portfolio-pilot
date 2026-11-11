//! NEAR Portfolio Pilot — Strategy NFT contract.
//!
//! Every token is a deterministic portfolio strategy (a WASM module that runs
//! in a TEE on OutLayer or locally). The token carries:
//! * the strategy description (`StrategyInfo`, including the WASM sha256),
//! * an append-only history of verified runs (`RunRecord`, one `store::Vector`
//!   per token), written by whitelisted "recorder" accounts,
//! * aggregate performance stats (compounded return, peak, max drawdown),
//! * the history of older strategy versions, so old runs stay explainable.
//!
//! NEP-171 (core), NEP-177 (metadata) and NEP-181 (enumeration) come from
//! `near-contract-standards`.

use std::collections::HashMap;

use near_contract_standards::non_fungible_token::core::{
    NonFungibleTokenCore, NonFungibleTokenResolver,
};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::events::NftMint;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{
    refund_deposit_to_account, NonFungibleToken, Token, TokenId,
};
use near_sdk::collections::LazyOption;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableSet, LookupMap, Vector};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, CryptoHash, PanicOnDefault, PromiseOrValue,
};

#[cfg(test)]
mod tests;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

pub const CONTRACT_NAME: &str = "NEAR Portfolio Pilot Strategies";
pub const CONTRACT_SYMBOL: &str = "PILOT";

pub const EVENT_STANDARD: &str = "pilot";
pub const EVENT_VERSION: &str = "1.0.0";

pub const ENGINE_OUTLAYER: &str = "outlayer";
pub const ENGINE_LOCAL: &str = "local";

pub const MAX_PARAMS_JSON_BYTES: usize = 4 * 1024;
pub const MAX_TOKEN_ID_BYTES: usize = 128;
pub const MAX_RUN_ID_BYTES: usize = 128;
pub const MAX_SHORT_FIELD_BYTES: usize = 128; // strategy_id, version
pub const MAX_URL_BYTES: usize = 512; // source_url, outlayer_project, attestation_ref
pub const MAX_RUNS_PAGE: u64 = 100;

/// 1 basis point = 1/10_000.
pub const BPS: i128 = 10_000;
/// Internal fixed-point precision of the equity index (1.0 == 1e12).
/// Exposed views are scaled down to 1e6 (`*_index_e6`).
pub const INDEX_ONE_E12: i128 = 1_000_000_000_000;
const E12_TO_E6: i128 = 1_000_000;

// Error messages (kept as constants so tests can match them).
pub const ERR_TOKEN_EXISTS: &str = "Token already exists";
pub const ERR_NO_TOKEN: &str = "Token not found";
pub const ERR_NOT_OWNER: &str = "Only the contract owner can call this method";
pub const ERR_NOT_TOKEN_OWNER: &str = "Only the token owner can update the strategy";
pub const ERR_NOT_RECORDER: &str = "Only recorders can record runs";
pub const ERR_DUPLICATE_RUN: &str = "run_id already recorded for this token";
pub const ERR_TS_BACKWARDS: &str = "timestamp_ms is older than the last recorded run";
pub const ERR_HASH_MISMATCH: &str = "wasm_sha256 does not match the strategy's current wasm_sha256";
pub const ERR_BAD_ENGINE: &str = "engine must be \"outlayer\" or \"local\"";
pub const ERR_RETURN_TOO_LOW: &str = "period_return_bps must be >= -10000";
pub const ERR_SAME_VERSION: &str = "new version must differ from the current version";
pub const ERR_INDEX_OVERFLOW: &str = "equity index overflow";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    NftOwners,
    NftTokenMetadata,
    NftEnumeration,
    ContractMetadata,
    Recorders,
    Strategies,
    RunIds,
    Runs { token_hash: CryptoHash },
}

/// Strategy description supplied at mint time. `version`, `wasm_sha256` and
/// `source_url` are the *current* version; older ones live in the version
/// history (see `get_versions`).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct StrategyInfo {
    pub strategy_id: String,
    pub version: String,
    /// 64 hex chars; stored lowercase.
    pub wasm_sha256: String,
    pub source_url: String,
    pub outlayer_project: Option<String>,
    /// Strategy parameters as a JSON string, max 4 KB.
    pub params_json: String,
}

/// Argument of `record_run`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RunRecordInput {
    /// Unique per token.
    pub run_id: String,
    /// Must be >= the previous record's timestamp_ms.
    pub timestamp_ms: u64,
    /// "outlayer" | "local"
    pub engine: String,
    pub input_sha256: String,
    pub output_sha256: String,
    /// OutLayer call_id or tx hash.
    pub attestation_ref: Option<String>,
    /// Must equal the token's current StrategyInfo.wasm_sha256.
    pub wasm_sha256: String,
    pub period_return_bps: i64,
    pub equity_usd_e6: u64,
}

/// A stored run record (the input plus who/when recorded it on-chain).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct RunRecord {
    /// Position in this token's run list (0-based).
    pub index: u64,
    pub run_id: String,
    pub timestamp_ms: u64,
    pub engine: String,
    pub input_sha256: String,
    pub output_sha256: String,
    pub attestation_ref: Option<String>,
    pub wasm_sha256: String,
    /// Strategy version label that was current when the run was recorded.
    pub strategy_version: String,
    pub period_return_bps: i64,
    pub equity_usd_e6: u64,
    pub recorder_id: AccountId,
    pub block_height: u64,
    pub block_timestamp_ms: u64,
}

/// One strategy version. Runs with index in `[from_run_index, to_run_index)`
/// were recorded under this version.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct VersionEntry {
    pub version: String,
    pub wasm_sha256: String,
    pub source_url: String,
    pub from_run_index: u64,
    /// Exclusive. `None` for the current version.
    pub to_run_index: Option<u64>,
    pub activated_at_ms: u64,
    /// `None` for the current version.
    pub retired_at_ms: Option<u64>,
}

/// Internal aggregate state. The equity index is the single source of truth;
/// cumulative return and drawdown are derived from it.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct StatsState {
    pub runs_count: u64,
    pub first_ts: u64,
    pub last_ts: u64,
    /// Compounded equity index, 1.0 == 1e12. Never negative.
    pub index_e12: i128,
    pub peak_index_e12: i128,
    pub max_drawdown_bps: u32,
    pub last_equity_usd_e6: u64,
}

impl Default for StatsState {
    fn default() -> Self {
        Self {
            runs_count: 0,
            first_ts: 0,
            last_ts: 0,
            index_e12: INDEX_ONE_E12,
            peak_index_e12: INDEX_ONE_E12,
            max_drawdown_bps: 0,
            last_equity_usd_e6: 0,
        }
    }
}

impl StatsState {
    /// Compounds one period return into the index:
    /// index' = index * (10_000 + r) / 10_000, i.e. (1+c)(1+r) - 1 for the
    /// cumulative return. Integer (i128) fixed-point only, no floats.
    pub fn apply(&mut self, timestamp_ms: u64, period_return_bps: i64, equity_usd_e6: u64) {
        require!(period_return_bps >= -10_000, ERR_RETURN_TOO_LOW);
        let factor = BPS + period_return_bps as i128; // >= 0
        self.index_e12 = self
            .index_e12
            .checked_mul(factor)
            .unwrap_or_else(|| env::panic_str(ERR_INDEX_OVERFLOW))
            / BPS;
        if self.index_e12 > self.peak_index_e12 {
            self.peak_index_e12 = self.index_e12;
        }
        if self.peak_index_e12 > 0 {
            let dd = (self.peak_index_e12 - self.index_e12) * BPS / self.peak_index_e12;
            let dd = dd.clamp(0, BPS) as u32;
            if dd > self.max_drawdown_bps {
                self.max_drawdown_bps = dd;
            }
        }
        if self.runs_count == 0 {
            self.first_ts = timestamp_ms;
        }
        self.last_ts = timestamp_ms;
        self.last_equity_usd_e6 = equity_usd_e6;
        self.runs_count += 1;
    }

    /// (index - 1) in basis points, truncated toward zero.
    pub fn cumulative_return_bps(&self) -> i64 {
        let bps = (self.index_e12 - INDEX_ONE_E12) * BPS / INDEX_ONE_E12;
        i64::try_from(bps).unwrap_or(i64::MAX)
    }

    pub fn view(&self) -> RunStats {
        let has_runs = self.runs_count > 0;
        RunStats {
            runs_count: self.runs_count,
            first_ts: has_runs.then_some(self.first_ts),
            last_ts: has_runs.then_some(self.last_ts),
            cumulative_return_bps: self.cumulative_return_bps(),
            index_e6: U128((self.index_e12 / E12_TO_E6) as u128),
            peak_index_e6: U128((self.peak_index_e12 / E12_TO_E6) as u128),
            max_drawdown_bps: self.max_drawdown_bps,
            last_equity_usd_e6: has_runs.then_some(self.last_equity_usd_e6),
        }
    }
}

/// Aggregate stats as returned by views.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct RunStats {
    pub runs_count: u64,
    /// `null` until the first run.
    pub first_ts: Option<u64>,
    pub last_ts: Option<u64>,
    /// Compounded: (1+c)(1+r)-1, in bps.
    pub cumulative_return_bps: i64,
    /// Current compounded equity index, starts at 1_000_000 (string-encoded u128).
    pub index_e6: U128,
    /// Highest index seen so far, starts at 1_000_000 (string-encoded u128).
    pub peak_index_e6: U128,
    /// Largest peak-to-trough fall of the index, in bps (0..=10000).
    pub max_drawdown_bps: u32,
    pub last_equity_usd_e6: Option<u64>,
}

/// Per-token strategy data (stored).
#[near(serializers = [borsh])]
pub struct StrategyRecord {
    pub info: StrategyInfo,
    pub stats: StatsState,
    pub minted_at_ms: u64,
    /// Run index from which the current version applies.
    pub version_since_run: u64,
    pub version_since_ms: u64,
    /// Retired versions, oldest first.
    pub version_history: Vec<VersionEntry>,
    pub runs: Vector<RunRecord>,
}

impl StrategyRecord {
    fn current_version_entry(&self) -> VersionEntry {
        VersionEntry {
            version: self.info.version.clone(),
            wasm_sha256: self.info.wasm_sha256.clone(),
            source_url: self.info.source_url.clone(),
            from_run_index: self.version_since_run,
            to_run_index: None,
            activated_at_ms: self.version_since_ms,
            retired_at_ms: None,
        }
    }
}

/// Returned by `get_strategy`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct StrategyView {
    pub token_id: TokenId,
    pub owner_id: AccountId,
    pub metadata: Option<TokenMetadata>,
    pub strategy: StrategyInfo,
    pub stats: RunStats,
    pub minted_at_ms: u64,
    /// Number of versions including the current one.
    pub versions_count: u64,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    tokens: NonFungibleToken,
    metadata: LazyOption<NFTContractMetadata>,
    recorders: IterableSet<AccountId>,
    strategies: LookupMap<TokenId, StrategyRecord>,
    /// (token_id, run_id) -> run index; used to reject duplicate run ids.
    run_ids: LookupMap<(TokenId, String), u64>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        let metadata = NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: CONTRACT_NAME.to_string(),
            symbol: CONTRACT_SYMBOL.to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        };
        metadata.assert_valid();
        Self {
            tokens: NonFungibleToken::new(
                StorageKey::NftOwners,
                owner_id,
                Some(StorageKey::NftTokenMetadata),
                Some(StorageKey::NftEnumeration),
                None::<StorageKey>,
            ),
            metadata: LazyOption::new(StorageKey::ContractMetadata, Some(&metadata)),
            recorders: IterableSet::new(StorageKey::Recorders),
            strategies: LookupMap::new(StorageKey::Strategies),
            run_ids: LookupMap::new(StorageKey::RunIds),
        }
    }

    // ----- contract owner / recorders --------------------------------------

    /// Contract owner only. Returns false if already a recorder.
    pub fn add_recorder(&mut self, account_id: AccountId) -> bool {
        self.assert_contract_owner();
        let added = self.recorders.insert(account_id.clone());
        if added {
            emit_event("recorder_added", json!({ "account_id": account_id }));
        }
        added
    }

    /// Contract owner only. Returns false if it was not a recorder.
    pub fn remove_recorder(&mut self, account_id: AccountId) -> bool {
        self.assert_contract_owner();
        let removed = self.recorders.remove(&account_id);
        if removed {
            emit_event("recorder_removed", json!({ "account_id": account_id }));
        }
        removed
    }

    pub fn get_recorders(&self) -> Vec<AccountId> {
        self.recorders.iter().cloned().collect()
    }

    pub fn is_recorder(&self, account_id: AccountId) -> bool {
        self.recorders.contains(&account_id)
    }

    pub fn get_owner(&self) -> AccountId {
        self.tokens.owner_id.clone()
    }

    // ----- minting -----------------------------------------------------------

    /// Anyone may mint. The caller pays for all storage of the new token
    /// (NFT data + strategy record); the excess deposit is refunded.
    #[payable]
    pub fn mint_strategy(
        &mut self,
        token_id: TokenId,
        receiver_id: AccountId,
        token_metadata: TokenMetadata,
        strategy: StrategyInfo,
    ) -> Token {
        let initial_storage = env::storage_usage();
        require!(
            !token_id.is_empty() && token_id.len() <= MAX_TOKEN_ID_BYTES,
            format!("token_id must be 1..={MAX_TOKEN_ID_BYTES} bytes")
        );
        require!(
            self.tokens.owner_by_id.get(&token_id).is_none()
                && !self.strategies.contains_key(&token_id),
            ERR_TOKEN_EXISTS
        );
        let info = validate_strategy(strategy);
        let now = now_ms();

        let record = StrategyRecord {
            info: info.clone(),
            stats: StatsState::default(),
            minted_at_ms: now,
            version_since_run: 0,
            version_since_ms: now,
            version_history: Vec::new(),
            runs: Vector::new(StorageKey::Runs {
                token_hash: env::sha256_array(token_id.as_bytes()),
            }),
        };
        self.strategies.insert(token_id.clone(), record);
        // `store` collections are write-back: flush so storage_usage sees it.
        self.strategies.flush();

        let token = self.tokens.internal_mint_with_refund(
            token_id,
            receiver_id,
            Some(token_metadata),
            None,
        );

        charge_storage(initial_storage, env::predecessor_account_id());

        NftMint { owner_id: &token.owner_id, token_ids: &[&token.token_id], memo: None }.emit();
        emit_event(
            "strategy_minted",
            json!({
                "token_id": token.token_id,
                "owner_id": token.owner_id,
                "strategy_id": info.strategy_id,
                "version": info.version,
                "wasm_sha256": info.wasm_sha256,
            }),
        );
        token
    }

    // ----- run records -------------------------------------------------------

    /// Recorders only. Appends a run record and updates aggregate stats.
    /// The recorder pays for the added storage; the excess deposit is refunded.
    /// Returns the index of the new record.
    #[payable]
    pub fn record_run(&mut self, token_id: TokenId, record: RunRecordInput) -> u64 {
        let recorder_id = env::predecessor_account_id();
        require!(self.recorders.contains(&recorder_id), ERR_NOT_RECORDER);
        let initial_storage = env::storage_usage();

        require!(
            !record.run_id.is_empty() && record.run_id.len() <= MAX_RUN_ID_BYTES,
            format!("run_id must be 1..={MAX_RUN_ID_BYTES} bytes")
        );
        require!(
            record.engine == ENGINE_OUTLAYER || record.engine == ENGINE_LOCAL,
            ERR_BAD_ENGINE
        );
        let input_sha256 = normalize_sha256(&record.input_sha256, "input_sha256");
        let output_sha256 = normalize_sha256(&record.output_sha256, "output_sha256");
        let wasm_sha256 = normalize_sha256(&record.wasm_sha256, "wasm_sha256");
        if let Some(r) = &record.attestation_ref {
            require!(
                r.len() <= MAX_URL_BYTES,
                format!("attestation_ref must be <= {MAX_URL_BYTES} bytes")
            );
        }
        require!(record.period_return_bps >= -10_000, ERR_RETURN_TOO_LOW);

        let run_key = (token_id.clone(), record.run_id.clone());
        require!(self.strategies.contains_key(&token_id), ERR_NO_TOKEN);
        require!(!self.run_ids.contains_key(&run_key), ERR_DUPLICATE_RUN);

        let (index, stats) = {
            let entry = self
                .strategies
                .get_mut(&token_id)
                .unwrap_or_else(|| env::panic_str(ERR_NO_TOKEN));
            require!(wasm_sha256 == entry.info.wasm_sha256, ERR_HASH_MISMATCH);
            if entry.stats.runs_count > 0 {
                require!(record.timestamp_ms >= entry.stats.last_ts, ERR_TS_BACKWARDS);
            }
            let index = u64::from(entry.runs.len());
            entry
                .stats
                .apply(record.timestamp_ms, record.period_return_bps, record.equity_usd_e6);
            entry.runs.push(RunRecord {
                index,
                run_id: record.run_id.clone(),
                timestamp_ms: record.timestamp_ms,
                engine: record.engine.clone(),
                input_sha256: input_sha256.clone(),
                output_sha256: output_sha256.clone(),
                attestation_ref: record.attestation_ref.clone(),
                wasm_sha256: wasm_sha256.clone(),
                strategy_version: entry.info.version.clone(),
                period_return_bps: record.period_return_bps,
                equity_usd_e6: record.equity_usd_e6,
                recorder_id: recorder_id.clone(),
                block_height: env::block_height(),
                block_timestamp_ms: now_ms(),
            });
            // Inner vector writes its element; the outer map then writes the
            // record (which carries the vector's length).
            entry.runs.flush();
            (index, entry.stats.view())
        };
        self.strategies.flush();
        self.run_ids.insert(run_key, index);
        self.run_ids.flush();

        charge_storage(initial_storage, recorder_id.clone());

        emit_event(
            "run_recorded",
            json!({
                "token_id": token_id,
                "run_id": record.run_id,
                "index": index,
                "timestamp_ms": record.timestamp_ms,
                "engine": record.engine,
                "wasm_sha256": wasm_sha256,
                "input_sha256": input_sha256,
                "output_sha256": output_sha256,
                "attestation_ref": record.attestation_ref,
                "period_return_bps": record.period_return_bps,
                "equity_usd_e6": record.equity_usd_e6,
                "cumulative_return_bps": stats.cumulative_return_bps,
                "max_drawdown_bps": stats.max_drawdown_bps,
                "recorder_id": recorder_id,
            }),
        );
        index
    }

    // ----- versions ----------------------------------------------------------

    /// Token owner only. Retires the current version into the version history
    /// and makes the new one current; later runs must carry the new hash.
    /// Payable: if storage grows, the owner must attach enough to cover it
    /// (excess refunded).
    #[payable]
    pub fn update_strategy_version(
        &mut self,
        token_id: TokenId,
        version: String,
        wasm_sha256: String,
        source_url: String,
    ) {
        let caller = env::predecessor_account_id();
        let owner = self
            .tokens
            .owner_by_id
            .get(&token_id)
            .unwrap_or_else(|| env::panic_str(ERR_NO_TOKEN));
        require!(caller == owner, ERR_NOT_TOKEN_OWNER);
        validate_short("version", &version);
        validate_len("source_url", &source_url, MAX_URL_BYTES);
        let wasm_sha256 = normalize_sha256(&wasm_sha256, "wasm_sha256");
        let initial_storage = env::storage_usage();
        let now = now_ms();

        let old_version = {
            let entry = self
                .strategies
                .get_mut(&token_id)
                .unwrap_or_else(|| env::panic_str(ERR_NO_TOKEN));
            require!(version != entry.info.version, ERR_SAME_VERSION);
            let mut retired = entry.current_version_entry();
            retired.to_run_index = Some(entry.stats.runs_count);
            retired.retired_at_ms = Some(now);
            entry.version_history.push(retired.clone());
            entry.info.version = version.clone();
            entry.info.wasm_sha256 = wasm_sha256.clone();
            entry.info.source_url = source_url.clone();
            entry.version_since_run = entry.stats.runs_count;
            entry.version_since_ms = now;
            retired
        };
        self.strategies.flush();

        charge_storage(initial_storage, caller);

        emit_event(
            "strategy_version_updated",
            json!({
                "token_id": token_id,
                "old_version": old_version.version,
                "old_wasm_sha256": old_version.wasm_sha256,
                "version": version,
                "wasm_sha256": wasm_sha256,
                "source_url": source_url,
                "from_run_index": old_version.to_run_index,
            }),
        );
    }

    // ----- views ---------------------------------------------------------------

    pub fn get_strategy(&self, token_id: TokenId) -> Option<StrategyView> {
        let entry = self.strategies.get(&token_id)?;
        let owner_id = self.tokens.owner_by_id.get(&token_id)?;
        let metadata = self
            .tokens
            .token_metadata_by_id
            .as_ref()
            .and_then(|m| m.get(&token_id));
        Some(StrategyView {
            token_id,
            owner_id,
            metadata,
            strategy: entry.info.clone(),
            stats: entry.stats.view(),
            minted_at_ms: entry.minted_at_ms,
            versions_count: entry.version_history.len() as u64 + 1,
        })
    }

    /// Paginated run history, oldest first. `limit` defaults to and is capped
    /// at 100. Unknown token -> empty list.
    pub fn get_runs(
        &self,
        token_id: TokenId,
        from_index: Option<u64>,
        limit: Option<u64>,
    ) -> Vec<RunRecord> {
        let Some(entry) = self.strategies.get(&token_id) else {
            return Vec::new();
        };
        let len = u64::from(entry.runs.len());
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(MAX_RUNS_PAGE).min(MAX_RUNS_PAGE);
        if from >= len || limit == 0 {
            return Vec::new();
        }
        let to = from.saturating_add(limit).min(len);
        (from..to)
            .filter_map(|i| entry.runs.get(i as u32).cloned())
            .collect()
    }

    /// Single run by its run_id.
    pub fn get_run(&self, token_id: TokenId, run_id: String) -> Option<RunRecord> {
        let index = *self.run_ids.get(&(token_id.clone(), run_id))?;
        self.strategies.get(&token_id)?.runs.get(index as u32).cloned()
    }

    pub fn get_stats(&self, token_id: TokenId) -> Option<RunStats> {
        self.strategies.get(&token_id).map(|e| e.stats.view())
    }

    /// All versions oldest first; the last element is the current version
    /// (`to_run_index` / `retired_at_ms` = null). Unknown token -> empty list.
    pub fn get_versions(&self, token_id: TokenId) -> Vec<VersionEntry> {
        let Some(entry) = self.strategies.get(&token_id) else {
            return Vec::new();
        };
        let mut out = entry.version_history.clone();
        out.push(entry.current_version_entry());
        out
    }
}

impl Contract {
    fn assert_contract_owner(&self) {
        require!(env::predecessor_account_id() == self.tokens.owner_id, ERR_NOT_OWNER);
    }
}

// ---------------------------------------------------------------------------
// NEP-171 / NEP-177 / NEP-181
// ---------------------------------------------------------------------------

#[near]
impl NonFungibleTokenCore for Contract {
    #[payable]
    fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        self.tokens.nft_transfer(receiver_id, token_id, approval_id, memo)
    }

    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        self.tokens.nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenResolver for Contract {
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        self.tokens.nft_resolve_transfer(
            previous_owner_id,
            receiver_id,
            token_id,
            approved_account_ids,
        )
    }
}

#[near]
impl NonFungibleTokenEnumeration for Contract {
    fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }

    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit)
    }

    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }

    fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        self.tokens.nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Contract {
    fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.get().unwrap()
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

/// Requires the attached deposit to cover the storage added since
/// `initial_storage` and refunds the rest to `payer`.
fn charge_storage(initial_storage: u64, payer: AccountId) {
    let used = env::storage_usage().saturating_sub(initial_storage);
    refund_deposit_to_account(used, payer);
}

/// Validates a sha256 hex string (64 hex chars, any case) and returns it lowercase.
fn normalize_sha256(value: &str, field: &str) -> String {
    require!(
        value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()),
        format!("{field} must be 64 hex characters")
    );
    value.to_ascii_lowercase()
}

fn validate_len(field: &str, value: &str, max: usize) {
    require!(value.len() <= max, format!("{field} must be <= {max} bytes"));
}

fn validate_short(field: &str, value: &str) {
    require!(
        !value.is_empty() && value.len() <= MAX_SHORT_FIELD_BYTES,
        format!("{field} must be 1..={MAX_SHORT_FIELD_BYTES} bytes")
    );
}

fn validate_strategy(mut s: StrategyInfo) -> StrategyInfo {
    validate_short("strategy_id", &s.strategy_id);
    validate_short("version", &s.version);
    s.wasm_sha256 = normalize_sha256(&s.wasm_sha256, "wasm_sha256");
    validate_len("source_url", &s.source_url, MAX_URL_BYTES);
    if let Some(p) = &s.outlayer_project {
        validate_len("outlayer_project", p, MAX_URL_BYTES);
    }
    validate_len("params_json", &s.params_json, MAX_PARAMS_JSON_BYTES);
    s
}

/// NEP-297 event: `EVENT_JSON:{"standard":"pilot","version":"1.0.0","event":..,"data":[..]}`
fn emit_event(event: &str, data: Value) {
    let payload = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}
