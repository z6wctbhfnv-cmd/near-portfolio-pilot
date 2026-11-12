//! Strategy NFTs for NEAR Portfolio Pilot.
//!
//! One token = one script. Each token is a strategy (`name@version`) bound to its code:
//! - `code_hash`: sha256 of the script (source + parameters). A hash can be minted only once, so one
//!   script has exactly one NFT, and every checkpoint must name the current hash: a track record can
//!   never be moved to different code. The holder may change the code (`update_script`): the record
//!   then restarts from zero and the change date is public. The code itself stays private;
//! - an append-only record of weekly checkpoints. Each checkpoint stores the strategy's equity index
//!   and a hash over the Agent API execution proofs for that week, so the history is a live
//!   track record rather than a backtest.
//!
//! Agents follow scripts, not the other way round: an agent account calls `follow` to run a script and
//! `unfollow` to stop. The NFT never controls an agent's wallet, so selling the NFT cannot hand anyone
//! access to followers' funds; it sells the income stream and the history.
//!
//! Anyone can mint a script NFT for free (the minter pays only the storage it uses). The minter is the
//! author and first holder.
//!
//! Fees, paid in a whitelisted token (USDC) with `ft_transfer_call` to this contract:
//! - a follower pays 5% of its new profit to the NFT holder and 0.25% to Pilot (the treasury);
//! - the holder trading its own script pays only the 0.25% to Pilot;
//! - if the payer was referred, 0.1% of profit (out of Pilot's 0.25%) goes to the referrer.
//! The pilot computes the amount weekly (profit above the agent's previous peak) and sends
//! `5.25%` or `0.25%` of it; the contract splits it and credits balances, which the holder, the
//! referrer and the treasury withdraw when they like. NFT sales pay no referral. This keeps the agent's policy simple: its only allowed
//! destination is this contract.
//!
//! Two ways a fee arrives:
//! - `ft_transfer_call` from the payer's own wallet (`ft_on_transfer` splits it at once);
//! - a NEAR Intents Agent API agent cannot attach a `msg` (its withdraw and transfer calls have no
//!   such field), so it withdraws plain USDC to this contract (`ft_transfer`, no callback) and the
//!   recorder then names the payer and the script with `record_fee_payment`. The contract reads its
//!   own token balance and credits at most the part that is not already owed to anyone
//!   (`liabilities`), once per payment `reference`. The recorder can misname a payer but cannot
//!   credit money that never arrived.
//!
//! The current holder receives the author's share of fees (`revenue_receiver`). Selling the NFT sells
//! that income and the history with it. Only the `recorder` (the pilot's account) may append
//! checkpoints, and checkpoints can never be edited or removed.

use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
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
use near_sdk::store::{IterableSet, LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue};

/// Default follower fee to the NFT holder, in basis points of profit. The holder may set 0..=10%.
pub const HOLDER_FEE_BPS: u128 = 500;
pub const MAX_HOLDER_FEE_BPS: u16 = 1_000;
/// A fee increase takes effect only after this notice, so copiers can stop copying first.
pub const FEE_NOTICE_MS: u64 = 7 * 24 * 3_600 * 1_000;
/// Author bond ("skin in the game"), like Hyperliquid's vault-leader minimum: to be copied, the holder
/// keeps at least max(MIN_BOND, BOND_BPS of the copiers' capital) locked here, in USD stablecoin units
/// (6 decimals). It cannot be withdrawn below that while anyone copies the script.
pub const MIN_BOND: u128 = 100_000_000; // $100
pub const BOND_BPS: u128 = 100; // 1% of copiers' capital
/// Max size of the public parameter schema a holder may publish for copiers (JSON).
pub const MAX_PARAMS_BYTES: usize = 4_096;
/// Pilot's fee, in basis points of profit, paid by followers and holders alike.
pub const PLATFORM_FEE_BPS: u128 = 25;
/// Part of the platform fee that goes to whoever referred the payer, in basis points of profit.
pub const REFERRAL_FEE_BPS: u128 = 10;
/// Pilot's share of an NFT sale price, in basis points; the seller gets the rest (99.5%).
pub const SALE_FEE_BPS: u128 = 50;
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_RESOLVE: Gas = Gas::from_tgas(10);
const GAS_BALANCE_OF: Gas = Gas::from_tgas(5);
const GAS_ON_BALANCE: Gas = Gas::from_tgas(25);
/// A fee payment's reference, e.g. "sha256:<hex of the fee terms>", as the Agent API allows.
const MAX_REFERENCE_LEN: usize = 128;

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct FeeMsg {
    token_id: TokenId,
    /// true: this transfer is the holder's bond, not a fee payment
    #[serde(default)]
    bond: bool,
}

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
    ByCodeHash,
    Followers,
    FollowerSet { token_hash: Vec<u8> },
    Following,
    FeeTokens,
    Balances,
    FeesPaid,
    Listings,
    Referrers,
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
    /// the script that produced this period; must equal the token's `code_hash`
    pub code_hash: String,
    /// how many agents ran the script during the period
    pub followers: u32,
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
    by_code_hash: LookupMap<String, TokenId>,
    followers: LookupMap<TokenId, IterableSet<AccountId>>,
    /// agent -> the script it runs (one at a time; the pilot blends scripts across agents)
    following: LookupMap<AccountId, TokenId>,
    /// receives the platform fee
    treasury: AccountId,
    /// fungible tokens accepted as fees (e.g. USDC)
    fee_tokens: IterableSet<AccountId>,
    /// (account, fee token) -> withdrawable amount
    balances: LookupMap<(AccountId, AccountId), u128>,
    /// script -> total fees its holders have earned, per fee token
    fees_paid: LookupMap<(TokenId, AccountId), u128>,
    /// script -> sale price in yoctoNEAR
    listings: LookupMap<TokenId, u128>,
    /// account -> who referred it (set once, by the account itself)
    referrers: LookupMap<AccountId, AccountId>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, recorder: AccountId, treasury: AccountId, fee_tokens: Vec<AccountId>) -> Self {
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
            by_code_hash: LookupMap::new(StorageKey::ByCodeHash),
            followers: LookupMap::new(StorageKey::Followers),
            following: LookupMap::new(StorageKey::Following),
            treasury,
            fee_tokens: {
                let mut set = IterableSet::new(StorageKey::FeeTokens);
                set.extend(fee_tokens);
                set
            },
            balances: LookupMap::new(StorageKey::Balances),
            fees_paid: LookupMap::new(StorageKey::FeesPaid),
            listings: LookupMap::new(StorageKey::Listings),
            referrers: LookupMap::new(StorageKey::Referrers),
            owner,
            recorder,
        }
    }

    /// Mint a script NFT. Open to anyone and free apart from storage: the caller is the author and the
    /// first holder, attaches a deposit for the storage the listing uses, and gets the rest back.
    #[payable]
    pub fn mint_strategy(&mut self, info: StrategyInfo, title: String, description: String) -> Token {
        let author = env::predecessor_account_id();
        require!(info.author == author, "author must be the caller");
        require!(!info.strategy_id.is_empty() && info.strategy_id.len() <= 64, "strategy_id must be 1..64 chars");
        let before = env::storage_usage();
        require!(is_hex_hash(&info.code_hash), "code_hash must be 64 hex chars");
        let token_id: TokenId = info.strategy_id.clone();
        require!(self.strategies.get(&token_id).is_none(), "strategy already listed");
        require!(self.by_code_hash.get(&info.code_hash).is_none(), "this script already has an NFT");
        let meta = TokenMetadata {
            title: Some(title),
            description: Some(description),
            ..Default::default()
        };
        let token = self.tokens.internal_mint_with_refund(token_id.clone(), author.clone(), Some(meta), None);
        self.records.insert(
            token_id.clone(),
            Vector::new(StorageKey::Record { token_hash: env::sha256(token_id.as_bytes()) }),
        );
        self.followers.insert(
            token_id.clone(),
            IterableSet::new(StorageKey::FollowerSet { token_hash: env::sha256(token_id.as_bytes()) }),
        );
        self.by_code_hash.insert(info.code_hash.clone(), token_id.clone());
        self.strategies.insert(token_id, info);
        self.strategies.flush();
        self.records.flush();
        self.followers.flush();
        self.by_code_hash.flush();
        charge_storage(before, &author);
        token
    }

    /// Append one period's result. Append-only: history can never be rewritten.
    pub fn append_checkpoint(&mut self, token_id: TokenId, checkpoint: Checkpoint) {
        require!(env::predecessor_account_id() == self.recorder, "only the recorder can append");
        require!(is_hex_hash(&checkpoint.proofs_hash), "proofs_hash must be 64 hex chars");
        let info = self.strategies.get(&token_id).unwrap_or_else(|| env::panic_str("unknown strategy"));
        require!(checkpoint.code_hash == info.code_hash, "checkpoint was produced by a different script");
        let record = self.records.get_mut(&token_id).unwrap_or_else(|| env::panic_str("unknown strategy"));
        if let Some(last) = record.get(record.len().saturating_sub(1)) {
            require!(checkpoint.period_end_ms > last.period_end_ms, "checkpoints must move forward in time");
        }
        record.push(checkpoint);
    }

    /// The calling agent starts running this script. Switching scripts moves the agent over.
    /// The agent pays for the storage it adds (about 0.003 NEAR); the unused deposit is refunded,
    /// so nobody can fill the contract's storage at its expense.
    #[payable]
    pub fn follow(&mut self, token_id: TokenId) {
        require!(self.strategies.get(&token_id).is_some(), "unknown strategy");
        let before = env::storage_usage();
        let agent = env::predecessor_account_id();
        if self.tokens.owner_by_id.get(&token_id) != Some(agent.clone()) {
            let (bond, required) = self.bond_status(token_id.clone());
            require!(bond.0 >= required.0, "not open for copying: the holder's bond is below the minimum");
        }
        if let Some(prev) = self.following.get(&agent).cloned() {
            if let Some(set) = self.followers.get_mut(&prev) {
                set.remove(&agent);
            }
        }
        self.followers.get_mut(&token_id).unwrap().insert(agent.clone());
        self.following.insert(agent.clone(), token_id);
        self.followers.flush();
        self.following.flush();
        charge_storage(before, &agent);
    }

    /// Withdraw all of the caller's fee balance in `fee_token`. Re-credited if the transfer fails
    /// (for example when the receiver is not registered with the token contract).
    pub fn withdraw_fees(&mut self, fee_token: AccountId) -> Promise {
        let who = env::predecessor_account_id();
        let key = (who.clone(), fee_token.clone());
        let amount = self.balances.remove(&key).unwrap_or(0);
        require!(amount > 0, "nothing to withdraw");
        Promise::new(fee_token.clone())
            .function_call(
                "ft_transfer".to_string(),
                near_sdk::serde_json::json!({"receiver_id": who, "amount": U128(amount), "memo": "pilot fees"})
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_FT_TRANSFER,
            )
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "resolve_withdraw".to_string(),
                    near_sdk::serde_json::json!({"who": who, "fee_token": fee_token, "amount": U128(amount)})
                        .to_string()
                        .into_bytes(),
                    NearToken::from_yoctonear(0),
                    GAS_RESOLVE,
                ),
            )
    }

    #[private]
    pub fn resolve_withdraw(&mut self, who: AccountId, fee_token: AccountId, amount: U128) -> bool {
        let ok = matches!(env::promise_result_checked(0, 0), Ok(_));
        if ok {
            // The tokens have left: only now do they stop being owed.
            add_liability(&fee_token, -(amount.0 as i128));
        } else {
            // Still owed (withdraw_fees never lowered the liability): give the balance back only.
            let key = (who, fee_token);
            let cur = self.balances.get(&key).copied().unwrap_or(0);
            self.balances.insert(key, cur + amount.0);
        }
        ok
    }

    /// Put the script NFT up for sale at `price` (yoctoNEAR). The seller pays the listing's storage.
    #[payable]
    pub fn list_for_sale(&mut self, token_id: TokenId, price: U128) {
        let seller = env::predecessor_account_id();
        let owner = self.tokens.owner_by_id.get(&token_id).unwrap_or_else(|| env::panic_str("unknown strategy"));
        require!(owner == seller, "only the holder can sell");
        require!(price.0 > 0, "price must be positive");
        let before = env::storage_usage();
        self.listings.insert(token_id, price.0);
        self.listings.flush();
        charge_storage(before, &seller);
    }

    pub fn delist(&mut self, token_id: TokenId) {
        let owner = self.tokens.owner_by_id.get(&token_id).unwrap_or_else(|| env::panic_str("unknown strategy"));
        require!(owner == env::predecessor_account_id(), "only the holder can delist");
        self.listings.remove(&token_id);
    }

    /// Buy a listed script NFT. Attach at least the price; the seller gets 99.5%, Pilot 0.5%,
    /// any excess is refunded. History, followers and future fees move to the buyer; the author stays.
    #[payable]
    pub fn buy(&mut self, token_id: TokenId) {
        let buyer = env::predecessor_account_id();
        let price = self.listings.remove(&token_id).unwrap_or_else(|| env::panic_str("not for sale"));
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= price, format!("attach at least {} yoctoNEAR", price));
        let seller = self.tokens.owner_by_id.get(&token_id).unwrap();
        require!(buyer != seller, "already yours");
        self.tokens.internal_transfer(&seller, &buyer, &token_id, None, Some("pilot sale".to_string()));
        self.release_bond(&token_id, &seller);
        let fee = price * SALE_FEE_BPS / 10_000;
        Promise::new(seller.clone()).transfer(NearToken::from_yoctonear(price - fee)).detach();
        if fee > 0 {
            Promise::new(self.treasury.clone()).transfer(NearToken::from_yoctonear(fee)).detach();
        }
        if deposit > price {
            Promise::new(buyer.clone()).transfer(NearToken::from_yoctonear(deposit - price)).detach();
        }
        env::log_str(&format!("sold {token_id} from {seller} to {buyer} for {price} yoctoNEAR"));
    }

    /// The holder replaces the script's code. The record restarts from zero (old checkpoints are no longer
    /// served), the version goes up and the change time is stored, so copiers and buyers see "changed on
    /// <date>". The code itself never goes on chain: only its new hash. Followers stay subscribed; their
    /// agents see the new version and ask their owners before continuing.
    #[payable]
    pub fn update_script(&mut self, token_id: TokenId, code_hash: String) {
        let who = env::predecessor_account_id();
        let owner = self.tokens.owner_by_id.get(&token_id).unwrap_or_else(|| env::panic_str("unknown strategy"));
        require!(owner == who, "only the holder can change the script");
        require!(is_hex_hash(&code_hash), "code_hash must be 64 hex chars");
        require!(self.by_code_hash.get(&code_hash).is_none(), "this script already has an NFT");
        let before = env::storage_usage();
        let mut info = self.strategies.get(&token_id).cloned().unwrap();
        self.by_code_hash.remove(&info.code_hash);
        info.code_hash = code_hash.clone();
        self.by_code_hash.insert(code_hash, token_id.clone());
        self.strategies.insert(token_id.clone(), info);
        let version = self.script_version(token_id.clone()).0 + 1;
        // A fresh, empty record under a new storage prefix; the old one is simply no longer referenced.
        let prefix = env::sha256(format!("{token_id}#v{version}").as_bytes());
        self.records.insert(token_id.clone(), Vector::new(StorageKey::Record { token_hash: prefix }));
        env::storage_write(&version_key(&token_id), &version.to_le_bytes());
        env::storage_write(&changed_key(&token_id), &env::block_timestamp_ms().to_le_bytes());
        self.strategies.flush();
        self.records.flush();
        self.by_code_hash.flush();
        charge_storage(before, &who);
        env::log_str(&format!("script {token_id} changed to version {version}; record restarted"));
    }

    /// (version, unix ms of the last change; 0 = never changed since mint).
    pub fn script_version(&self, token_id: TokenId) -> (u32, u64) {
        let v = env::storage_read(&version_key(&token_id)).map(|b| u32::from_le_bytes(b.try_into().unwrap())).unwrap_or(1);
        let t = env::storage_read(&changed_key(&token_id)).map(|b| u64::from_le_bytes(b.try_into().unwrap())).unwrap_or(0);
        (v, t)
    }

    /// The holder sets the copy fee, 0..=10% of copiers' new profit. Lowering applies at once; raising
    /// applies after FEE_NOTICE_MS, so every copier can stop copying before paying more.
    pub fn set_copy_fee(&mut self, token_id: TokenId, bps: u16) {
        let owner = self.tokens.owner_by_id.get(&token_id).unwrap_or_else(|| env::panic_str("unknown strategy"));
        require!(owner == env::predecessor_account_id(), "only the holder can set the fee");
        require!(bps <= MAX_HOLDER_FEE_BPS, "fee must be 0..=10%");
        let (current, _, _) = self.copy_fee(token_id.clone());
        if bps <= current {
            env::storage_write(&fee_key(&token_id), &bps.to_le_bytes());
            env::storage_remove(&fee_next_key(&token_id));
        } else {
            let at = env::block_timestamp_ms() + FEE_NOTICE_MS;
            let mut v = bps.to_le_bytes().to_vec();
            v.extend_from_slice(&at.to_le_bytes());
            env::storage_write(&fee_next_key(&token_id), &v);
        }
    }

    /// (fee in effect now in bps, announced fee in bps or 0, unix ms when it takes effect or 0).
    pub fn copy_fee(&self, token_id: TokenId) -> (u16, u16, u64) {
        let current = env::storage_read(&fee_key(&token_id))
            .map(|b| u16::from_le_bytes(b.try_into().unwrap()))
            .unwrap_or(HOLDER_FEE_BPS as u16);
        match env::storage_read(&fee_next_key(&token_id)) {
            Some(b) => {
                let next = u16::from_le_bytes(b[0..2].try_into().unwrap());
                let at = u64::from_le_bytes(b[2..10].try_into().unwrap());
                if env::block_timestamp_ms() >= at { (next, 0, 0) } else { (current, next, at) }
            }
            None => (current, 0, 0),
        }
    }

    /// The holder publishes which parameters copiers may tune, as JSON, e.g.
    /// [{"name":"target_vol","label":"Target volatility","min":0.1,"max":1.0,"default":0.4}].
    /// Only names, ranges and defaults are public; the code stays private.
    pub fn set_open_params(&mut self, token_id: TokenId, schema: String) {
        let owner = self.tokens.owner_by_id.get(&token_id).unwrap_or_else(|| env::panic_str("unknown strategy"));
        require!(owner == env::predecessor_account_id(), "only the holder can publish parameters");
        require!(schema.len() <= MAX_PARAMS_BYTES, "parameter schema is too large");
        require!(near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(&schema).map(|v| v.is_array()).unwrap_or(false), "schema must be a JSON array");
        env::storage_write(&params_key(&token_id), schema.as_bytes());
    }

    pub fn open_params(&self, token_id: TokenId) -> String {
        env::storage_read(&params_key(&token_id)).map(|b| String::from_utf8(b).unwrap_or_default()).unwrap_or_else(|| "[]".into())
    }

    /// The recorder reports the copiers' total capital in USD units (6 decimals), weekly.
    pub fn set_copied_capital(&mut self, token_id: TokenId, usd: U128) {
        require!(env::predecessor_account_id() == self.recorder, "only the recorder");
        env::storage_write(&capital_key(&token_id), &usd.0.to_le_bytes());
    }

    /// (bond held, bond required) in USD units. Copying is open while held >= required.
    pub fn bond_status(&self, token_id: TokenId) -> (U128, U128) {
        let held: u128 = self.fee_tokens.iter().map(|t| read_u128(&bond_key(&token_id, t))).sum();
        let capital = read_u128(&capital_key(&token_id));
        (U128(held), U128(MIN_BOND.max(capital * BOND_BPS / 10_000)))
    }

    /// The holder takes bond back. While anyone copies the script, it may not fall below the required level.
    pub fn withdraw_bond(&mut self, token_id: TokenId, fee_token: AccountId, amount: U128) -> Promise {
        let who = env::predecessor_account_id();
        let owner = self.tokens.owner_by_id.get(&token_id).unwrap_or_else(|| env::panic_str("unknown strategy"));
        require!(owner == who, "only the holder");
        let k = bond_key(&token_id, &fee_token);
        let cur = read_u128(&k);
        require!(amount.0 > 0 && amount.0 <= cur, "not that much bond in this token");
        let (held, required) = self.bond_status(token_id.clone());
        if self.follower_count(token_id.clone()) > 0 {
            require!(held.0 - amount.0 >= required.0, "copiers follow this script: the bond cannot go below the minimum");
        }
        env::storage_write(&k, &(cur - amount.0).to_le_bytes());
        add_liability(&fee_token, -(amount.0 as i128));
        self.credit(&who, &fee_token, amount.0);
        self.withdraw_fees(fee_token)
    }

    /// A sold or transferred script's bond goes back to the old holder (as a withdrawable balance);
    /// the new holder must bond again before new copiers can join.
    fn release_bond(&mut self, token_id: &TokenId, old_holder: &AccountId) {
        let tokens: Vec<AccountId> = self.fee_tokens.iter().cloned().collect();
        for t in tokens {
            let k = bond_key(token_id, &t);
            let amt = read_u128(&k);
            if amt > 0 {
                env::storage_remove(&k);
                add_liability(&t, -(amt as i128));
                self.credit(old_holder, &t, amt);
            }
        }
    }

    /// Hide or show the script on Pilot's leaderboard. Holder only. The NFT and its record stay on chain
    /// either way; this is a display preference. Kept in raw storage so the contract state layout (and
    /// existing deployments) need no migration.
    #[payable]
    pub fn set_hidden(&mut self, token_id: TokenId, hidden: bool) {
        let who = env::predecessor_account_id();
        let owner = self.tokens.owner_by_id.get(&token_id).unwrap_or_else(|| env::panic_str("unknown strategy"));
        require!(owner == who, "only the holder can hide or show");
        let key = hidden_key(&token_id);
        if hidden {
            let before = env::storage_usage();
            env::storage_write(&key, &[1]);
            charge_storage(before, &who);
        } else {
            env::storage_remove(&key);
        }
    }

    pub fn is_hidden(&self, token_id: TokenId) -> bool {
        env::storage_has_key(&hidden_key(&token_id))
    }

    pub fn sale_price(&self, token_id: TokenId) -> Option<U128> {
        self.listings.get(&token_id).map(|p| U128(*p))
    }

    /// Record who referred the caller. Once only, never yourself; the caller pays the storage.
    #[payable]
    pub fn set_referrer(&mut self, referrer: AccountId) {
        let me = env::predecessor_account_id();
        require!(referrer != me, "cannot refer yourself");
        require!(self.referrers.get(&me).is_none(), "referrer already set");
        require!(self.referrers.get(&referrer) != Some(&me), "no referral loops");
        let before = env::storage_usage();
        self.referrers.insert(me.clone(), referrer);
        self.referrers.flush();
        charge_storage(before, &me);
    }

    pub fn referrer_of(&self, account: AccountId) -> Option<AccountId> {
        self.referrers.get(&account).cloned()
    }

    pub fn set_treasury(&mut self, treasury: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
        self.treasury = treasury;
    }

    pub fn add_fee_token(&mut self, token: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
        self.fee_tokens.insert(token);
    }

    fn credit(&mut self, who: &AccountId, fee_token: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let key = (who.clone(), fee_token.clone());
        let cur = self.balances.get(&key).copied().unwrap_or(0);
        self.balances.insert(key, cur + amount);
        add_liability(fee_token, amount as i128);
    }

    /// Split a fee payment. Returns (holder part, platform part incl. referral).
    fn split_fee(&mut self, payer: &AccountId, token_id: &TokenId, fee_token: &AccountId, amount: u128) -> (u128, u128) {
        let holder = self.tokens.owner_by_id.get(token_id).unwrap_or_else(|| env::panic_str("unknown strategy"));
        let fee = self.copy_fee(token_id.clone()).0 as u128;
        let (to_holder, to_platform) = if *payer == holder || fee == 0 {
            // the holder on its own script, or a free script: only the platform fee is due, and the
            // payment is expected to be just that (0.25% of profit)
            (0, amount)
        } else {
            let h = amount * fee / (fee + PLATFORM_FEE_BPS);
            (h, amount - h)
        };
        self.credit(&holder, fee_token, to_holder);
        let to_referrer = match self.referrers.get(payer).cloned() {
            Some(r) => {
                let part = to_platform * REFERRAL_FEE_BPS / PLATFORM_FEE_BPS;
                self.credit(&r, fee_token, part);
                part
            }
            None => 0,
        };
        let treasury = self.treasury.clone();
        self.credit(&treasury, fee_token, to_platform - to_referrer);
        let key = (token_id.clone(), fee_token.clone());
        let paid = self.fees_paid.get(&key).copied().unwrap_or(0);
        self.fees_paid.insert(key, paid + to_holder);
        (to_holder, to_platform)
    }

    /// The calling agent stops running its script.
    pub fn unfollow(&mut self) {
        let agent = env::predecessor_account_id();
        let prev = self.following.remove(&agent).unwrap_or_else(|| env::panic_str("not following any script"));
        if let Some(set) = self.followers.get_mut(&prev) {
            set.remove(&agent);
        }
    }

    pub fn set_recorder(&mut self, recorder: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
        self.recorder = recorder;
    }

    /// A fee paid by an Agent API agent: the agent withdrew `amount` of `fee_token` to this contract with
    /// a plain transfer, so nothing told the contract who paid. The recorder names the payer (the
    /// owner's NEAR account, so referrals and "own script" work as with `ft_transfer_call`) and the
    /// script. The contract checks its own balance and credits at most the unowed surplus, once per
    /// `reference`. No deposit: a function-call key can call it; the contract pays the marker's storage.
    pub fn record_fee_payment(&mut self, payer: AccountId, token_id: TokenId, fee_token: AccountId, amount: U128, reference: String) -> Promise {
        require!(env::predecessor_account_id() == self.recorder, "only the recorder can record payments");
        require!(self.fee_tokens.contains(&fee_token), "token not accepted for fees");
        require!(self.strategies.get(&token_id).is_some(), "unknown strategy");
        require!(amount.0 > 0, "amount must be positive");
        require!(
            !reference.is_empty() && reference.len() <= MAX_REFERENCE_LEN && reference.bytes().all(|b| (0x21..=0x7e).contains(&b)),
            "reference must be 1..128 printable characters"
        );
        require!(!env::storage_has_key(&payment_key(&reference)), "payment already recorded");
        Promise::new(fee_token.clone())
            .function_call(
                "ft_balance_of".to_string(),
                near_sdk::serde_json::json!({ "account_id": env::current_account_id() }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_BALANCE_OF,
            )
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_fee_balance".to_string(),
                    near_sdk::serde_json::json!({
                        "payer": payer, "token_id": token_id, "fee_token": fee_token, "amount": amount, "reference": reference,
                    })
                    .to_string()
                    .into_bytes(),
                    NearToken::from_yoctonear(0),
                    GAS_ON_BALANCE,
                ),
            )
    }

    /// Callback of `record_fee_payment`. Returns the amount credited (0 = nothing).
    ///
    /// The surplus check guards against bugs and a careless recorder; it is not a proof of who paid.
    /// While a `withdraw_fees` transfer is in flight its amount is still counted as owed, so the surplus
    /// can only be understated then, never overstated.
    #[private]
    pub fn on_fee_balance(&mut self, payer: AccountId, token_id: TokenId, fee_token: AccountId, amount: U128, reference: String) -> U128 {
        let balance: u128 = match env::promise_result_checked(0, 100) {
            Ok(bytes) => match near_sdk::serde_json::from_slice::<U128>(&bytes) {
                Ok(b) => b.0,
                Err(_) => {
                    env::log_str(&format!("fee {reference}: unreadable balance"));
                    return U128(0);
                }
            },
            Err(_) => {
                env::log_str(&format!("fee {reference}: balance read failed"));
                return U128(0);
            }
        };
        if env::storage_has_key(&payment_key(&reference)) {
            env::log_str(&format!("fee {reference}: already recorded"));
            return U128(0);
        }
        let surplus = balance.saturating_sub(self.liabilities(fee_token.clone()).0);
        let credited = amount.0.min(surplus);
        if credited == 0 {
            env::log_str(&format!("fee {reference}: nothing unowed on the balance, nothing credited"));
            return U128(0);
        }
        self.split_fee(&payer, &token_id, &fee_token, credited);
        env::storage_write(&payment_key(&reference), &credited.to_le_bytes());
        env::log_str(&format!("fee {reference}: {credited} of {} credited for {token_id}, paid by {payer}", amount.0));
        U128(credited)
    }

    /// The amount credited for a recorded payment, or None if it was never recorded.
    pub fn fee_payment(&self, reference: String) -> Option<U128> {
        env::storage_read(&payment_key(&reference)).map(|b| U128(u128::from_le_bytes(b.try_into().unwrap())))
    }

    /// What the contract owes in `fee_token`: withdrawable balances, bonds, and withdrawals in flight.
    pub fn liabilities(&self, fee_token: AccountId) -> U128 {
        U128(read_u128(&liability_key(&fee_token)))
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

    /// Which NFT a script belongs to, by its hash. Lets anyone check running code against the catalog.
    pub fn token_by_code_hash(&self, code_hash: String) -> Option<TokenId> {
        self.by_code_hash.get(&code_hash).cloned()
    }

    pub fn followers(&self, token_id: TokenId, from_index: Option<u32>, limit: Option<u32>) -> Vec<AccountId> {
        let Some(set) = self.followers.get(&token_id) else { return vec![] };
        let from = from_index.unwrap_or(0) as usize;
        let lim = limit.unwrap_or(50).min(200) as usize;
        set.iter().skip(from).take(lim).cloned().collect()
    }

    pub fn follower_count(&self, token_id: TokenId) -> u32 {
        self.followers.get(&token_id).map(|s| s.len()).unwrap_or(0)
    }

    pub fn following(&self, agent: AccountId) -> Option<TokenId> {
        self.following.get(&agent).cloned()
    }

    pub fn fee_balance(&self, account: AccountId, fee_token: AccountId) -> U128 {
        U128(self.balances.get(&(account, fee_token)).copied().unwrap_or(0))
    }

    /// Fees the holders of this script have earned in total, in `fee_token`.
    pub fn fees_earned(&self, token_id: TokenId, fee_token: AccountId) -> U128 {
        U128(self.fees_paid.get(&(token_id, fee_token)).copied().unwrap_or(0))
    }

    pub fn fee_terms(&self) -> near_sdk::serde_json::Value {
        near_sdk::serde_json::json!({
            "follower_to_holder_bps": HOLDER_FEE_BPS as u64,
            "platform_bps": PLATFORM_FEE_BPS as u64,
            "referral_bps_of_platform": REFERRAL_FEE_BPS as u64,
            "sale_fee_bps": SALE_FEE_BPS as u64,
            "treasury": self.treasury,
            "fee_tokens": self.fee_tokens.iter().collect::<Vec<_>>(),
        })
    }

    pub fn recorder(&self) -> AccountId {
        self.recorder.clone()
    }
}

/// Charge the caller for the storage added since `before` out of the attached deposit, refund the rest.
fn charge_storage(before: u64, payer: &AccountId) {
    let added = env::storage_usage().saturating_sub(before) as u128;
    let cost = env::storage_byte_cost().saturating_mul(added);
    let deposit = env::attached_deposit();
    require!(deposit >= cost, format!("attach at least {} yoctoNEAR for storage", cost.as_yoctonear()));
    let refund = deposit.saturating_sub(cost);
    if !refund.is_zero() {
        Promise::new(payer.clone()).transfer(refund).detach();
    }
}

#[near]
impl FungibleTokenReceiver for Contract {
    /// Fee payment: `msg` = {"token_id": "<script id>"}. Only whitelisted fee tokens are accepted.
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let fee_token = env::predecessor_account_id();
        require!(self.fee_tokens.contains(&fee_token), "token not accepted for fees");
        let m: FeeMsg = near_sdk::serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("msg must be {\"token_id\": ...}"));
        if m.bond {
            let holder = self.tokens.owner_by_id.get(&m.token_id).unwrap_or_else(|| env::panic_str("unknown strategy"));
            if holder != sender_id {
                return PromiseOrValue::Value(amount); // only the holder bonds; refund anyone else
            }
            let k = bond_key(&m.token_id, &fee_token);
            let cur = read_u128(&k);
            env::storage_write(&k, &(cur + amount.0).to_le_bytes());
            add_liability(&fee_token, amount.0 as i128);
            return PromiseOrValue::Value(U128(0));
        }
        self.split_fee(&sender_id, &m.token_id, &fee_token, amount.0);
        PromiseOrValue::Value(U128(0))
    }
}

fn bond_key(token_id: &str, fee_token: &AccountId) -> Vec<u8> {
    [b"bond:".as_slice(), token_id.as_bytes(), b":", fee_token.as_bytes()].concat()
}

fn liability_key(fee_token: &AccountId) -> Vec<u8> {
    [b"owed:".as_slice(), fee_token.as_bytes()].concat()
}

/// Liabilities live in raw storage, like bonds and fees, so existing deployments need no state
/// migration. A deployment that already holds balances must start from a fresh contract.
fn add_liability(fee_token: &AccountId, delta: i128) {
    let k = liability_key(fee_token);
    let cur = read_u128(&k) as i128;
    let next = cur + delta;
    require!(next >= 0, "liabilities cannot go negative");
    env::storage_write(&k, &(next as u128).to_le_bytes());
}

fn payment_key(reference: &str) -> Vec<u8> {
    [b"paid:".as_slice(), reference.as_bytes()].concat()
}

fn capital_key(token_id: &str) -> Vec<u8> {
    [b"capital:".as_slice(), token_id.as_bytes()].concat()
}

fn read_u128(key: &[u8]) -> u128 {
    env::storage_read(key).map(|b| u128::from_le_bytes(b.try_into().unwrap())).unwrap_or(0)
}

fn fee_key(token_id: &str) -> Vec<u8> {
    [b"fee:".as_slice(), token_id.as_bytes()].concat()
}

fn fee_next_key(token_id: &str) -> Vec<u8> {
    [b"feenext:".as_slice(), token_id.as_bytes()].concat()
}

fn params_key(token_id: &str) -> Vec<u8> {
    [b"params:".as_slice(), token_id.as_bytes()].concat()
}

fn version_key(token_id: &str) -> Vec<u8> {
    [b"version:".as_slice(), token_id.as_bytes()].concat()
}

fn changed_key(token_id: &str) -> Vec<u8> {
    [b"changed:".as_slice(), token_id.as_bytes()].concat()
}

fn hidden_key(token_id: &str) -> Vec<u8> {
    [b"hidden:".as_slice(), token_id.as_bytes()].concat()
}

fn is_hex_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

// NEP-171 core, approvals and enumeration, delegated to the standard implementation.
#[near]
impl NonFungibleTokenCore for Contract {
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        self.listings.remove(&token_id); // a listing never survives a change of holder
        if let Some(old) = self.tokens.owner_by_id.get(&token_id) {
            self.release_bond(&token_id, &old);
        }
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
        self.listings.remove(&token_id);
        if let Some(old) = self.tokens.owner_by_id.get(&token_id) {
            self.release_bond(&token_id, &old);
        }
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

    fn bond(c: &mut Contract, holder: AccountId, amount: u128) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(usdc()).build());
        let _ = c.ft_on_transfer(holder, U128(amount), r#"{"token_id":"trend-sma@v1","bond":true}"#.into());
    }

    fn setup() -> Contract {
        ctx(accounts(0), 0);
        let mut c = Contract::new(accounts(0), accounts(1), accounts(5), vec![usdc()]);
        ctx(accounts(2), 100);
        c.mint_strategy(
            StrategyInfo { strategy_id: "trend-sma@v1".into(), code_hash: HASH.into(), author: accounts(2) },
            "Trend SMA".into(),
            "Hold above the 100-day average".into(),
        );
        bond(&mut c, accounts(2), MIN_BOND);
        c
    }

    fn cp(t: u64) -> Checkpoint {
        Checkpoint { period_end_ms: t, equity_index: U128(1_010_000), proofs_hash: HASH.into(), executions: 3,
                     code_hash: HASH.into(), followers: 1 }
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
    #[should_panic(expected = "author must be the caller")]
    fn cannot_mint_in_someone_elses_name() {
        let mut c = setup();
        ctx(accounts(3), 100);
        c.mint_strategy(
            StrategyInfo { strategy_id: "x@v1".into(), code_hash: OTHER.into(), author: accounts(4) },
            "x".into(),
            "x".into(),
        );
    }

    #[test]
    fn anyone_can_mint_their_own_script() {
        let mut c = setup();
        ctx(accounts(3), 100);
        c.mint_strategy(
            StrategyInfo { strategy_id: "mine@v1".into(), code_hash: OTHER.into(), author: accounts(3) },
            "mine".into(),
            "mine".into(),
        );
        assert_eq!(c.revenue_receiver("mine@v1".into()), Some(accounts(3)));
    }

    #[test]
    #[should_panic(expected = "for storage")]
    fn mint_without_storage_deposit_fails() {
        let mut c = setup();
        ctx(accounts(3), 0);
        c.mint_strategy(
            StrategyInfo { strategy_id: "mine@v1".into(), code_hash: OTHER.into(), author: accounts(3) },
            "mine".into(),
            "mine".into(),
        );
    }

    fn usdc() -> AccountId {
        "usdc.testnet".parse().unwrap()
    }

    fn pay(c: &mut Contract, payer: AccountId, amount: u128) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(usdc()).build());
        let _ = c.ft_on_transfer(payer, U128(amount), r#"{"token_id":"trend-sma@v1"}"#.into());
    }

    #[test]
    fn follower_fee_splits_5_to_holder_and_0_25_to_pilot() {
        let mut c = setup();
        // follower made $1000 profit: pays 5.25% = $52.50 (USDC, 6 decimals)
        pay(&mut c, accounts(4), 52_500_000);
        assert_eq!(c.fee_balance(accounts(2), usdc()).0, 50_000_000);
        assert_eq!(c.fee_balance(accounts(5), usdc()).0, 2_500_000);
        assert_eq!(c.fees_earned("trend-sma@v1".into(), usdc()).0, 50_000_000);
    }

    #[test]
    fn holder_pays_only_the_platform_fee() {
        let mut c = setup();
        pay(&mut c, accounts(2), 2_500_000); // 0.25% of $1000
        assert_eq!(c.fee_balance(accounts(2), usdc()).0, 0);
        assert_eq!(c.fee_balance(accounts(5), usdc()).0, 2_500_000);
    }

    #[test]
    fn fees_follow_the_nft_after_a_sale() {
        let mut c = setup();
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(2))
            .attached_deposit(NearToken::from_yoctonear(1))
            .build());
        c.nft_transfer(accounts(3), "trend-sma@v1".into(), None, None);
        pay(&mut c, accounts(4), 52_500_000);
        assert_eq!(c.fee_balance(accounts(3), usdc()).0, 50_000_000);
        assert_eq!(c.fee_balance(accounts(2), usdc()).0, MIN_BOND); // only the returned bond, no fees
    }

    #[test]
    #[should_panic(expected = "token not accepted for fees")]
    fn unknown_tokens_are_refused() {
        let mut c = setup();
        testing_env!(VMContextBuilder::new().predecessor_account_id(accounts(4)).build());
        let _ = c.ft_on_transfer(accounts(4), U128(1), r#"{"token_id":"trend-sma@v1"}"#.into());
    }

    #[test]
    #[should_panic(expected = "nothing to withdraw")]
    fn empty_withdraw_fails() {
        let mut c = setup();
        ctx(accounts(2), 0);
        let _ = c.withdraw_fees(usdc());
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

    const OTHER: &str = "b4f1c0de00000000000000000000000000000000000000000000000000000002";

    #[test]
    #[should_panic(expected = "this script already has an NFT")]
    fn one_script_one_nft() {
        let mut c = setup();
        ctx(accounts(3), 100);
        c.mint_strategy(
            StrategyInfo { strategy_id: "trend-sma@v1-copy".into(), code_hash: HASH.into(), author: accounts(3) },
            "copy".into(),
            "same code, new name".into(),
        );
    }

    #[test]
    #[should_panic(expected = "checkpoint was produced by a different script")]
    fn record_must_come_from_the_bound_script() {
        let mut c = setup();
        ctx(accounts(1), 0);
        let mut bad = cp(1);
        bad.code_hash = OTHER.into();
        c.append_checkpoint("trend-sma@v1".into(), bad);
    }

    #[test]
    fn script_lookup_by_hash() {
        let c = setup();
        assert_eq!(c.token_by_code_hash(HASH.into()), Some("trend-sma@v1".to_string()));
        assert_eq!(c.token_by_code_hash(OTHER.into()), None);
    }

    #[test]
    fn agents_follow_switch_and_unfollow() {
        let mut c = setup();
        ctx(accounts(2), 100);
        c.mint_strategy(
            StrategyInfo { strategy_id: "carry@v1".into(), code_hash: OTHER.into(), author: accounts(2) },
            "Carry".into(),
            "Funding carry".into(),
        );
        testing_env!(VMContextBuilder::new().predecessor_account_id(usdc()).build());
        let _ = c.ft_on_transfer(accounts(2), U128(MIN_BOND), r#"{"token_id":"carry@v1","bond":true}"#.into());
        ctx(accounts(4), 10);
        c.follow("trend-sma@v1".into());
        ctx(accounts(5), 10);
        c.follow("trend-sma@v1".into());
        assert_eq!(c.follower_count("trend-sma@v1".into()), 2);
        ctx(accounts(4), 10);
        c.follow("carry@v1".into()); // switching moves the agent
        assert_eq!(c.follower_count("trend-sma@v1".into()), 1);
        assert_eq!(c.following(accounts(4)), Some("carry@v1".to_string()));
        c.unfollow();
        assert_eq!(c.follower_count("carry@v1".into()), 0);
        assert_eq!(c.following(accounts(4)), None);
    }

    #[test]
    fn selling_the_nft_keeps_followers_running() {
        let mut c = setup();
        ctx(accounts(4), 10);
        c.follow("trend-sma@v1".into());
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(2))
            .attached_deposit(NearToken::from_yoctonear(1))
            .build());
        c.nft_transfer(accounts(3), "trend-sma@v1".into(), None, None);
        assert_eq!(c.followers("trend-sma@v1".into(), None, None), vec![accounts(4)]);
        assert_eq!(c.revenue_receiver("trend-sma@v1".into()), Some(accounts(3)));
    }

    #[test]
    #[should_panic(expected = "unknown strategy")]
    fn cannot_follow_unlisted_script() {
        let mut c = setup();
        ctx(accounts(4), 10);
        c.follow("nope@v1".into());
    }

    #[test]
    #[should_panic(expected = "for storage")]
    fn follow_without_storage_deposit_fails() {
        let mut c = setup();
        ctx(accounts(4), 0);
        c.follow("trend-sma@v1".into());
    }

    fn list(c: &mut Contract, price: u128) {
        ctx(accounts(2), 100);
        c.list_for_sale("trend-sma@v1".into(), U128(price));
    }

    #[test]
    fn buyer_gets_the_nft_and_fees_after_buying() {
        let mut c = setup();
        list(&mut c, 1_000);
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(3))
            .attached_deposit(NearToken::from_yoctonear(1_000))
            .build());
        c.buy("trend-sma@v1".into());
        assert_eq!(c.revenue_receiver("trend-sma@v1".into()), Some(accounts(3)));
        assert_eq!(c.sale_price("trend-sma@v1".into()), None);
        assert_eq!(c.strategy_info("trend-sma@v1".into()).unwrap().author, accounts(2));
    }

    #[test]
    #[should_panic(expected = "attach at least")]
    fn underpaying_fails() {
        let mut c = setup();
        list(&mut c, 1_000);
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(3))
            .attached_deposit(NearToken::from_yoctonear(999))
            .build());
        c.buy("trend-sma@v1".into());
    }

    #[test]
    #[should_panic(expected = "only the holder can sell")]
    fn only_holder_lists() {
        let mut c = setup();
        ctx(accounts(3), 100);
        c.list_for_sale("trend-sma@v1".into(), U128(1));
    }

    #[test]
    #[should_panic(expected = "not for sale")]
    fn transfer_cancels_listing() {
        let mut c = setup();
        list(&mut c, 1_000);
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(2))
            .attached_deposit(NearToken::from_yoctonear(1))
            .build());
        c.nft_transfer(accounts(4), "trend-sma@v1".into(), None, None);
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(3))
            .attached_deposit(NearToken::from_yoctonear(1_000))
            .build());
        c.buy("trend-sma@v1".into());
    }

    #[test]
    fn sale_split_is_99_5_and_0_5() {
        assert_eq!(1_000_000u128 * SALE_FEE_BPS / 10_000, 5_000);
    }

    #[test]
    fn referrer_gets_0_1_out_of_pilots_0_25() {
        let mut c = setup();
        ctx(accounts(4), 10);
        c.set_referrer(accounts(1));
        pay(&mut c, accounts(4), 52_500_000);
        assert_eq!(c.fee_balance(accounts(2), usdc()).0, 50_000_000);
        assert_eq!(c.fee_balance(accounts(1), usdc()).0, 1_000_000);
        assert_eq!(c.fee_balance(accounts(5), usdc()).0, 1_500_000);
    }

    #[test]
    #[should_panic(expected = "referrer already set")]
    fn referrer_is_set_once() {
        let mut c = setup();
        ctx(accounts(4), 10);
        c.set_referrer(accounts(1));
        ctx(accounts(4), 10);
        c.set_referrer(accounts(3));
    }

    #[test]
    #[should_panic(expected = "cannot refer yourself")]
    fn no_self_referral() {
        let mut c = setup();
        ctx(accounts(4), 10);
        c.set_referrer(accounts(4));
    }

    #[test]
    fn holder_hides_and_shows() {
        let mut c = setup();
        ctx(accounts(2), 10);
        c.set_hidden("trend-sma@v1".into(), true);
        assert!(c.is_hidden("trend-sma@v1".into()));
        ctx(accounts(2), 0);
        c.set_hidden("trend-sma@v1".into(), false);
        assert!(!c.is_hidden("trend-sma@v1".into()));
    }

    #[test]
    #[should_panic(expected = "only the holder can hide or show")]
    fn others_cannot_hide() {
        let mut c = setup();
        ctx(accounts(3), 10);
        c.set_hidden("trend-sma@v1".into(), true);
    }

    #[test]
    fn holder_changes_script_and_record_restarts() {
        let mut c = setup();
        ctx(accounts(1), 0);
        c.append_checkpoint("trend-sma@v1".into(), cp(1));
        assert_eq!(c.record("trend-sma@v1".into(), None, None).len(), 1);
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(2))
            .attached_deposit(NearToken::from_millinear(10))
            .block_timestamp(5_000_000_000)
            .build());
        c.update_script("trend-sma@v1".into(), OTHER.into());
        assert_eq!(c.record("trend-sma@v1".into(), None, None).len(), 0);
        assert_eq!(c.script_version("trend-sma@v1".into()), (2, 5_000));
        assert_eq!(c.token_by_code_hash(OTHER.into()), Some("trend-sma@v1".to_string()));
        assert_eq!(c.token_by_code_hash(HASH.into()), None);
        // the next checkpoint must come from the new code
        ctx(accounts(1), 0);
        let mut next = cp(2);
        next.code_hash = OTHER.into();
        c.append_checkpoint("trend-sma@v1".into(), next);
        assert_eq!(c.record("trend-sma@v1".into(), None, None).len(), 1);
    }

    #[test]
    #[should_panic(expected = "only the holder can change the script")]
    fn others_cannot_change_script() {
        let mut c = setup();
        ctx(accounts(3), 10);
        c.update_script("trend-sma@v1".into(), OTHER.into());
    }

    #[test]
    fn unchanged_script_is_version_one() {
        let c = setup();
        assert_eq!(c.script_version("trend-sma@v1".into()), (1, 0));
    }

    #[test]
    fn holder_lowers_fee_at_once_and_raises_after_notice() {
        let mut c = setup();
        ctx(accounts(2), 0);
        c.set_copy_fee("trend-sma@v1".into(), 200);
        assert_eq!(c.copy_fee("trend-sma@v1".into()), (200, 0, 0));
        testing_env!(VMContextBuilder::new().predecessor_account_id(accounts(2)).block_timestamp(1_000_000_000).build());
        c.set_copy_fee("trend-sma@v1".into(), 900);
        assert_eq!(c.copy_fee("trend-sma@v1".into()), (200, 900, 1_000 + FEE_NOTICE_MS));
        testing_env!(VMContextBuilder::new().block_timestamp((1_000 + FEE_NOTICE_MS) * 1_000_000).build());
        assert_eq!(c.copy_fee("trend-sma@v1".into()).0, 900);
    }

    #[test]
    #[should_panic(expected = "fee must be 0..=10%")]
    fn fee_above_ten_percent_is_refused() {
        let mut c = setup();
        ctx(accounts(2), 0);
        c.set_copy_fee("trend-sma@v1".into(), 1_001);
    }

    #[test]
    fn custom_fee_changes_the_split() {
        let mut c = setup();
        ctx(accounts(2), 0);
        c.set_copy_fee("trend-sma@v1".into(), 1_000); // a raise: in force after the notice
        // follower made $1000: pays 10% + 0.25% = $102.50, once the notice has passed
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(usdc())
            .block_timestamp((FEE_NOTICE_MS + 1) * 1_000_000)
            .build());
        let _ = c.ft_on_transfer(accounts(4), U128(102_500_000), r#"{"token_id":"trend-sma@v1"}"#.into());
        assert_eq!(c.fee_balance(accounts(2), usdc()).0, 100_000_000);
        assert_eq!(c.fee_balance(accounts(5), usdc()).0, 2_500_000);
    }

    #[test]
    fn holder_publishes_open_params() {
        let mut c = setup();
        ctx(accounts(2), 0);
        c.set_open_params("trend-sma@v1".into(), r#"[{"name":"target_vol","min":0.1,"max":1,"default":0.4}]"#.into());
        assert!(c.open_params("trend-sma@v1".into()).contains("target_vol"));
    }

    #[test]
    #[should_panic(expected = "schema must be a JSON array")]
    fn params_must_be_a_json_array() {
        let mut c = setup();
        ctx(accounts(2), 0);
        c.set_open_params("trend-sma@v1".into(), "not json".into());
    }

    #[test]
    #[should_panic(expected = "not open for copying")]
    fn no_bond_no_copying() {
        let mut c = setup();
        ctx(accounts(1), 0);
        c.set_copied_capital("trend-sma@v1".into(), U128(50_000_000_000)); // $50k copied -> $500 required
        ctx(accounts(4), 10);
        c.follow("trend-sma@v1".into());
    }

    #[test]
    fn bond_of_one_percent_opens_copying() {
        let mut c = setup();
        ctx(accounts(1), 0);
        c.set_copied_capital("trend-sma@v1".into(), U128(50_000_000_000));
        bond(&mut c, accounts(2), 400_000_000); // total $500
        assert_eq!(c.bond_status("trend-sma@v1".into()), (U128(500_000_000), U128(500_000_000)));
        ctx(accounts(4), 10);
        c.follow("trend-sma@v1".into());
        assert_eq!(c.follower_count("trend-sma@v1".into()), 1);
    }

    #[test]
    #[should_panic(expected = "the bond cannot go below the minimum")]
    fn bond_is_locked_while_copied() {
        let mut c = setup();
        ctx(accounts(4), 10);
        c.follow("trend-sma@v1".into());
        ctx(accounts(2), 0);
        let _ = c.withdraw_bond("trend-sma@v1".into(), usdc(), U128(1));
    }

    #[test]
    fn non_holder_bond_is_refunded_and_sale_returns_bond() {
        let mut c = setup();
        testing_env!(VMContextBuilder::new().predecessor_account_id(usdc()).build());
        let back = c.ft_on_transfer(accounts(4), U128(5), r#"{"token_id":"trend-sma@v1","bond":true}"#.into());
        assert!(matches!(back, PromiseOrValue::Value(U128(5))));
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(2))
            .attached_deposit(NearToken::from_yoctonear(1))
            .build());
        c.nft_transfer(accounts(3), "trend-sma@v1".into(), None, None);
        assert_eq!(c.bond_status("trend-sma@v1".into()).0, U128(0));
        assert_eq!(c.fee_balance(accounts(2), usdc()).0, MIN_BOND);
    }

    // --- fees paid by Agent API agents (plain withdraw + record_fee_payment) ------------------

    fn nft() -> AccountId {
        "nft.testnet".parse().unwrap()
    }

    /// The callback runs as the contract itself, with the token's `ft_balance_of` answer as its result.
    fn balance_answer(result: near_sdk::PromiseResult) {
        testing_env!(
            VMContextBuilder::new().current_account_id(nft()).predecessor_account_id(nft()).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![result],
        );
    }

    fn balance_is(raw: u128) {
        balance_answer(near_sdk::PromiseResult::Successful(format!("\"{raw}\"").into_bytes()));
    }

    fn record(c: &mut Contract, payer: AccountId, amount: u128, reference: &str) -> u128 {
        c.on_fee_balance(payer, "trend-sma@v1".into(), usdc(), U128(amount), reference.into()).0
    }

    #[test]
    fn liabilities_follow_bonds_fees_and_withdrawals() {
        let mut c = setup(); // holder bonded MIN_BOND
        assert_eq!(c.liabilities(usdc()).0, MIN_BOND);
        pay(&mut c, accounts(4), 52_500_000);
        assert_eq!(c.liabilities(usdc()).0, MIN_BOND + 52_500_000);
        // The holder withdraws fees: still owed until the transfer resolves.
        ctx(accounts(2), 0);
        let _ = c.withdraw_fees(usdc());
        assert_eq!(c.liabilities(usdc()).0, MIN_BOND + 52_500_000);
        // It failed: the balance comes back, the liability is not counted twice.
        balance_answer(near_sdk::PromiseResult::Failed);
        assert!(!c.resolve_withdraw(accounts(2), usdc(), U128(50_000_000)));
        assert_eq!(c.fee_balance(accounts(2), usdc()).0, 50_000_000);
        assert_eq!(c.liabilities(usdc()).0, MIN_BOND + 52_500_000);
        // Second try succeeds: now it is no longer owed.
        ctx(accounts(2), 0);
        let _ = c.withdraw_fees(usdc());
        balance_answer(near_sdk::PromiseResult::Successful(vec![]));
        assert!(c.resolve_withdraw(accounts(2), usdc(), U128(50_000_000)));
        assert_eq!(c.liabilities(usdc()).0, MIN_BOND + 2_500_000);
        // A sale returns the bond to the old holder as a balance: still owed, same total.
        testing_env!(VMContextBuilder::new().predecessor_account_id(accounts(2)).attached_deposit(NearToken::from_yoctonear(1)).build());
        c.nft_transfer(accounts(3), "trend-sma@v1".into(), None, None);
        assert_eq!(c.liabilities(usdc()).0, MIN_BOND + 2_500_000);
    }

    #[test]
    fn bond_withdrawal_keeps_liabilities_until_it_leaves() {
        let mut c = setup();
        bond(&mut c, accounts(2), 50); // more than the minimum, nobody copies
        ctx(accounts(2), 0);
        let _ = c.withdraw_bond("trend-sma@v1".into(), usdc(), U128(50));
        assert_eq!(c.liabilities(usdc()).0, MIN_BOND + 50);
        balance_answer(near_sdk::PromiseResult::Successful(vec![]));
        assert!(c.resolve_withdraw(accounts(2), usdc(), U128(50)));
        assert_eq!(c.liabilities(usdc()).0, MIN_BOND);
    }

    #[test]
    #[should_panic(expected = "only the recorder can record payments")]
    fn only_the_recorder_records_payments() {
        let mut c = setup();
        ctx(accounts(4), 0);
        let _ = c.record_fee_payment(accounts(4), "trend-sma@v1".into(), usdc(), U128(1), "sha256:ab".into());
    }

    #[test]
    #[should_panic(expected = "token not accepted for fees")]
    fn recorded_payments_need_a_fee_token() {
        let mut c = setup();
        ctx(accounts(1), 0);
        let _ = c.record_fee_payment(accounts(4), "trend-sma@v1".into(), accounts(3), U128(1), "sha256:ab".into());
    }

    #[test]
    #[should_panic(expected = "reference must be")]
    fn references_are_printable() {
        let mut c = setup();
        ctx(accounts(1), 0);
        let _ = c.record_fee_payment(accounts(4), "trend-sma@v1".into(), usdc(), U128(1), "has space".into());
    }

    #[test]
    fn recorder_starts_a_balance_check() {
        let mut c = setup();
        ctx(accounts(1), 0);
        let _ = c.record_fee_payment(accounts(4), "trend-sma@v1".into(), usdc(), U128(52_500_000), "sha256:01".into());
        let receipts = near_sdk::test_utils::get_created_receipts();
        assert_eq!(receipts.len(), 2);
        assert_eq!(receipts[0].receiver_id, usdc());
    }

    #[test]
    fn agent_fee_splits_like_a_direct_payment() {
        let mut c = setup();
        // The agent withdrew $52.50 to the contract; the contract already owes the bond.
        balance_is(MIN_BOND + 52_500_000);
        assert_eq!(record(&mut c, accounts(4), 52_500_000, "sha256:01"), 52_500_000);
        assert_eq!(c.fee_balance(accounts(2), usdc()).0, 50_000_000);
        assert_eq!(c.fee_balance(accounts(5), usdc()).0, 2_500_000);
        assert_eq!(c.fees_earned("trend-sma@v1".into(), usdc()).0, 50_000_000);
        assert_eq!(c.fee_payment("sha256:01".into()), Some(U128(52_500_000)));
        assert_eq!(c.liabilities(usdc()).0, MIN_BOND + 52_500_000);
    }

    #[test]
    fn a_payment_is_recorded_once() {
        let mut c = setup();
        balance_is(MIN_BOND + 52_500_000);
        assert_eq!(record(&mut c, accounts(4), 52_500_000, "sha256:01"), 52_500_000);
        // Same reference again (a retry after a lost answer): nothing more is credited.
        balance_is(MIN_BOND + 52_500_000);
        assert_eq!(record(&mut c, accounts(4), 52_500_000, "sha256:01"), 0);
        assert_eq!(c.fee_balance(accounts(2), usdc()).0, 50_000_000);
        ctx(accounts(1), 0);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = c.record_fee_payment(accounts(4), "trend-sma@v1".into(), usdc(), U128(1), "sha256:01".into());
        }));
        assert!(r.is_err(), "a recorded reference is refused up front");
    }

    #[test]
    fn the_recorder_cannot_credit_money_that_never_arrived() {
        let mut c = setup();
        // Only the bond is on the balance: nothing unowed.
        balance_is(MIN_BOND);
        assert_eq!(record(&mut c, accounts(4), 52_500_000, "sha256:01"), 0);
        assert_eq!(c.fee_balance(accounts(2), usdc()).0, 0);
        assert_eq!(c.fee_payment("sha256:01".into()), None, "can be recorded later, once the money is there");
        // Part of it arrived (the withdrawal fee came out of the amount): credit only that.
        balance_is(MIN_BOND + 52_000_000);
        assert_eq!(record(&mut c, accounts(4), 52_500_000, "sha256:01"), 52_000_000);
        assert_eq!(c.liabilities(usdc()).0, MIN_BOND + 52_000_000);
    }

    #[test]
    fn failed_balance_read_credits_nothing() {
        let mut c = setup();
        balance_answer(near_sdk::PromiseResult::Failed);
        assert_eq!(record(&mut c, accounts(4), 52_500_000, "sha256:01"), 0);
        assert_eq!(c.fee_payment("sha256:01".into()), None);
    }

    #[test]
    fn recorded_payer_gets_referral_and_own_script_rules() {
        let mut c = setup();
        ctx(accounts(4), 10);
        c.set_referrer(accounts(1));
        balance_is(MIN_BOND + 52_500_000);
        assert_eq!(record(&mut c, accounts(4), 52_500_000, "sha256:01"), 52_500_000);
        assert_eq!(c.fee_balance(accounts(1), usdc()).0, 1_000_000);
        assert_eq!(c.fee_balance(accounts(5), usdc()).0, 1_500_000);
        // The holder's own agent pays only Pilot's 0.25%: $2.50 on $1000 of profit.
        balance_is(MIN_BOND + 52_500_000 + 2_500_000);
        assert_eq!(record(&mut c, accounts(2), 2_500_000, "sha256:02"), 2_500_000);
        assert_eq!(c.fee_balance(accounts(2), usdc()).0, 50_000_000);
        assert_eq!(c.fee_balance(accounts(5), usdc()).0, 4_000_000);
    }
}
