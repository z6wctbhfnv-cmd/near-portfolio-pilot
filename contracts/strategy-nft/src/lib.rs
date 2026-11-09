//! Strategy NFTs for NEAR Portfolio Pilot.
//!
//! Each token is one strategy (`name@version`). It carries:
//! - `code_hash`: sha256 of the strategy's WASM on OutLayer, so anyone can check which code ran;
//! - an append-only record of weekly checkpoints. Each checkpoint stores the strategy's equity index
//!   and a hash over the Agent API execution proofs for that week, so the history is a live
//!   track record rather than a backtest.
//!
//! The current holder receives the author's share of fees (`revenue_receiver`). Selling the NFT sells
//! that income and the history with it. Only the `recorder` (the pilot's account) may append
//! checkpoints, and checkpoints can never be edited or removed.

use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::{
    NonFungibleToken, NonFungibleTokenApproval, NonFungibleTokenEnumeration, Token, TokenId,
};
use std::collections::HashMap;
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::collections::LazyOption;
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault, Promise, PromiseOrValue};

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    NonFungibleToken,
    Metadata,
    TokenMetadata,
    Enumeration,
    Approval,
    Strategies,
    Records,
    Record { token_hash: Vec<u8> },
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub struct StrategyInfo {
    /// e.g. "trend-sma@v1"
    pub strategy_id: String,
    /// sha256 of the strategy WASM published on OutLayer (hex)
    pub code_hash: String,
    /// account of the original author, kept for attribution even after the NFT is sold
    pub author: AccountId,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub struct Checkpoint {
    /// end of the period, unix ms
    pub period_end_ms: u64,
    /// equity index scaled by 1e6 (1_000_000 = start value)
    pub equity_index: U128,
    /// sha256 (hex) over the Agent API execution proofs of the period
    pub proofs_hash: String,
    pub executions: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    recorder: AccountId,
    tokens: NonFungibleToken,
    metadata: LazyOption<NFTContractMetadata>,
    strategies: LookupMap<TokenId, StrategyInfo>,
    records: LookupMap<TokenId, Vector<Checkpoint>>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, recorder: AccountId) -> Self {
        let metadata = NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "NEAR Portfolio Pilot Strategies".to_string(),
            symbol: "NPPS".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        };
        Self {
            tokens: NonFungibleToken::new(
                StorageKey::NonFungibleToken,
                owner.clone(),
                Some(StorageKey::TokenMetadata),
                Some(StorageKey::Enumeration),
                Some(StorageKey::Approval),
            ),
            metadata: LazyOption::new(StorageKey::Metadata, Some(&metadata)),
            strategies: LookupMap::new(StorageKey::Strategies),
            records: LookupMap::new(StorageKey::Records),
            owner,
            recorder,
        }
    }

    /// Mint a strategy NFT to its author. Only the contract owner lists strategies (curated catalog).
    #[payable]
    pub fn mint_strategy(&mut self, info: StrategyInfo, title: String, description: String) -> Token {
        require!(env::predecessor_account_id() == self.owner, "only the owner can list strategies");
        require!(is_hex_hash(&info.code_hash), "code_hash must be 64 hex chars");
        let token_id: TokenId = info.strategy_id.clone();
        require!(self.strategies.get(&token_id).is_none(), "strategy already listed");
        let meta = TokenMetadata {
            title: Some(title),
            description: Some(description),
            ..Default::default()
        };
        // The standard's mint refunds unused deposit and panics if storage is not covered.
        let token = self.tokens.internal_mint(token_id.clone(), info.author.clone(), Some(meta));
        self.records.insert(
            token_id.clone(),
            Vector::new(StorageKey::Record { token_hash: env::sha256(token_id.as_bytes()) }),
        );
        self.strategies.insert(token_id, info);
        token
    }

    /// Append one period's result. Append-only: history can never be rewritten.
    pub fn append_checkpoint(&mut self, token_id: TokenId, checkpoint: Checkpoint) {
        require!(env::predecessor_account_id() == self.recorder, "only the recorder can append");
        require!(is_hex_hash(&checkpoint.proofs_hash), "proofs_hash must be 64 hex chars");
        let record = self.records.get_mut(&token_id).unwrap_or_else(|| env::panic_str("unknown strategy"));
        if let Some(last) = record.get(record.len().saturating_sub(1)) {
            require!(checkpoint.period_end_ms > last.period_end_ms, "checkpoints must move forward in time");
        }
        record.push(checkpoint);
    }

    pub fn set_recorder(&mut self, recorder: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
        self.recorder = recorder;
    }

    // --- views ---------------------------------------------------------------------------
    pub fn strategy_info(&self, token_id: TokenId) -> Option<StrategyInfo> {
        self.strategies.get(&token_id).cloned()
    }

    pub fn record(&self, token_id: TokenId, from_index: Option<u32>, limit: Option<u32>) -> Vec<Checkpoint> {
        let Some(r) = self.records.get(&token_id) else { return vec![] };
        let from = from_index.unwrap_or(0);
        let lim = limit.unwrap_or(52).min(200);
        (from..r.len().min(from.saturating_add(lim))).filter_map(|i| r.get(i).cloned()).collect()
    }

    /// Who receives the author's share of fees now: the current NFT holder.
    pub fn revenue_receiver(&self, token_id: TokenId) -> Option<AccountId> {
        self.tokens.owner_by_id.get(&token_id)
    }

    pub fn recorder(&self) -> AccountId {
        self.recorder.clone()
    }
}

fn is_hex_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

// NEP-171 core, approvals and enumeration, delegated to the standard implementation.
#[near]
impl NonFungibleTokenCore for Contract {
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        self.tokens.nft_transfer(receiver_id, token_id, approval_id, memo);
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
        self.tokens.nft_resolve_transfer(previous_owner_id, receiver_id, token_id, approved_account_ids)
    }
}

#[near]
impl NonFungibleTokenApproval for Contract {
    #[payable]
    fn nft_approve(&mut self, token_id: TokenId, account_id: AccountId, msg: Option<String>) -> Option<Promise> {
        self.tokens.nft_approve(token_id, account_id, msg)
    }

    #[payable]
    fn nft_revoke(&mut self, token_id: TokenId, account_id: AccountId) {
        self.tokens.nft_revoke(token_id, account_id);
    }

    #[payable]
    fn nft_revoke_all(&mut self, token_id: TokenId) {
        self.tokens.nft_revoke_all(token_id);
    }

    fn nft_is_approved(&self, token_id: TokenId, approved_account_id: AccountId, approval_id: Option<u64>) -> bool {
        self.tokens.nft_is_approved(token_id, approved_account_id, approval_id)
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

    fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Contract {
    fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.get().unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;
    use near_sdk::NearToken;

    const HASH: &str = "a3f1c0de00000000000000000000000000000000000000000000000000000001";

    fn ctx(who: AccountId, deposit_milli: u128) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(who)
            .attached_deposit(NearToken::from_millinear(deposit_milli))
            .build());
    }

    fn setup() -> Contract {
        ctx(accounts(0), 0);
        let mut c = Contract::new(accounts(0), accounts(1));
        ctx(accounts(0), 100);
        c.mint_strategy(
            StrategyInfo { strategy_id: "trend-sma@v1".into(), code_hash: HASH.into(), author: accounts(2) },
            "Trend SMA".into(),
            "Hold above the 100-day average".into(),
        );
        c
    }

    fn cp(t: u64) -> Checkpoint {
        Checkpoint { period_end_ms: t, equity_index: U128(1_010_000), proofs_hash: HASH.into(), executions: 3 }
    }

    #[test]
    fn author_receives_the_nft_and_revenue() {
        let c = setup();
        assert_eq!(c.revenue_receiver("trend-sma@v1".into()), Some(accounts(2)));
        assert_eq!(c.strategy_info("trend-sma@v1".into()).unwrap().author, accounts(2));
    }

    #[test]
    fn recorder_appends_in_time_order() {
        let mut c = setup();
        ctx(accounts(1), 0);
        c.append_checkpoint("trend-sma@v1".into(), cp(1));
        c.append_checkpoint("trend-sma@v1".into(), cp(2));
        assert_eq!(c.record("trend-sma@v1".into(), None, None).len(), 2);
    }

    #[test]
    #[should_panic(expected = "only the recorder can append")]
    fn strangers_cannot_append() {
        let mut c = setup();
        ctx(accounts(3), 0);
        c.append_checkpoint("trend-sma@v1".into(), cp(1));
    }

    #[test]
    #[should_panic(expected = "checkpoints must move forward in time")]
    fn history_cannot_be_rewritten() {
        let mut c = setup();
        ctx(accounts(1), 0);
        c.append_checkpoint("trend-sma@v1".into(), cp(5));
        c.append_checkpoint("trend-sma@v1".into(), cp(5));
    }

    #[test]
    #[should_panic(expected = "only the owner can list strategies")]
    fn only_owner_lists() {
        let mut c = setup();
        ctx(accounts(3), 100);
        c.mint_strategy(
            StrategyInfo { strategy_id: "x@v1".into(), code_hash: HASH.into(), author: accounts(3) },
            "x".into(),
            "x".into(),
        );
    }

    #[test]
    fn transfer_moves_revenue_to_the_buyer() {
        let mut c = setup();
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(2))
            .attached_deposit(NearToken::from_yoctonear(1))
            .build());
        c.nft_transfer(accounts(4), "trend-sma@v1".into(), None, None);
        assert_eq!(c.revenue_receiver("trend-sma@v1".into()), Some(accounts(4)));
        // attribution stays with the original author
        assert_eq!(c.strategy_info("trend-sma@v1".into()).unwrap().author, accounts(2));
    }
}
