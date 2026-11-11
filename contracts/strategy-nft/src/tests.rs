use super::*;
use near_sdk::mock::MockAction;
use near_sdk::serde_json;
use near_sdk::test_utils::{accounts, get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, NearToken};

const T0_MS: u64 = 1_760_000_000_000;

fn hash(c: char) -> String {
    std::iter::repeat(c).take(64).collect()
}

fn contract_id() -> AccountId {
    "pilot.testnet".parse().unwrap()
}
fn owner() -> AccountId {
    accounts(0)
}
fn recorder() -> AccountId {
    accounts(1)
}
fn minter() -> AccountId {
    accounts(2)
}
fn stranger() -> AccountId {
    accounts(3)
}

fn set_ctx(predecessor: AccountId, deposit: NearToken) {
    let ctx = VMContextBuilder::new()
        .current_account_id(contract_id())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .attached_deposit(deposit)
        .block_timestamp(T0_MS * 1_000_000)
        .block_height(1234)
        .build();
    testing_env!(ctx);
}

fn setup() -> Contract {
    set_ctx(owner(), NearToken::from_yoctonear(0));
    let mut c = Contract::new(owner());
    c.add_recorder(recorder());
    c
}

fn strategy(wasm: &str) -> StrategyInfo {
    StrategyInfo {
        strategy_id: "momentum-rotation".into(),
        version: "1.0.0".into(),
        wasm_sha256: wasm.into(),
        source_url: "https://github.com/example/strategies/tree/v1".into(),
        outlayer_project: Some("pilot/momentum".into()),
        params_json: r#"{"lookback_days":30,"assets":["NEAR","BTC","ETH","USDC"]}"#.into(),
    }
}

fn token_meta() -> TokenMetadata {
    TokenMetadata { title: Some("Momentum rotation".into()), ..Default::default() }
}

fn mint(c: &mut Contract, token_id: &str, wasm: &str) -> Token {
    set_ctx(minter(), NearToken::from_near(1));
    c.mint_strategy(token_id.into(), minter(), token_meta(), strategy(wasm))
}

fn run(run_id: &str, ts: u64, ret_bps: i64, wasm: &str) -> RunRecordInput {
    RunRecordInput {
        run_id: run_id.into(),
        timestamp_ms: ts,
        engine: "outlayer".into(),
        input_sha256: hash('1'),
        output_sha256: hash('2'),
        attestation_ref: Some("call_123".into()),
        wasm_sha256: wasm.into(),
        period_return_bps: ret_bps,
        equity_usd_e6: 10_000_000_000,
    }
}

fn record(c: &mut Contract, token_id: &str, input: RunRecordInput) -> u64 {
    set_ctx(recorder(), NearToken::from_millinear(100));
    c.record_run(token_id.into(), input)
}

fn pilot_events(event: &str) -> Vec<serde_json::Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<serde_json::Value>(j).unwrap())
        .filter(|v| v["standard"] == "pilot" && v["event"] == event)
        .collect()
}

/// Sum of transfers to `to` created during the current call.
fn refunded_to(to: &AccountId) -> u128 {
    get_created_receipts()
        .iter()
        .filter(|r| &r.receiver_id == to)
        .flat_map(|r| r.actions.iter())
        .map(|a| match a {
            MockAction::Transfer { deposit, .. } => deposit.as_yoctonear(),
            _ => 0,
        })
        .sum()
}

// ---------------------------------------------------------------- init / admin

#[test]
fn init_sets_metadata_owner_and_recorders() {
    let c = setup();
    let m = c.nft_metadata();
    assert_eq!(m.spec, "nft-1.0.0");
    assert_eq!(m.name, "NEAR Portfolio Pilot Strategies");
    assert_eq!(m.symbol, "PILOT");
    assert_eq!(c.get_owner(), owner());
    assert_eq!(c.get_recorders(), vec![recorder()]);
    assert!(c.is_recorder(recorder()));
}

#[test]
fn owner_can_remove_recorder() {
    let mut c = setup();
    set_ctx(owner(), NearToken::from_yoctonear(0));
    assert!(c.add_recorder(stranger()));
    assert!(!c.add_recorder(stranger()));
    assert!(c.remove_recorder(recorder()));
    assert_eq!(c.get_recorders(), vec![stranger()]);
}

#[test]
#[should_panic(expected = "Only the contract owner can call this method")]
fn non_owner_cannot_add_recorder() {
    let mut c = setup();
    set_ctx(stranger(), NearToken::from_yoctonear(0));
    c.add_recorder(stranger());
}

// ---------------------------------------------------------------------- mint

#[test]
fn mint_creates_token_strategy_and_events() {
    let mut c = setup();
    // Uppercase hash is accepted and stored lowercase.
    let token = mint(&mut c, "strat-1", &hash('A'));
    assert_eq!(token.owner_id, minter());
    assert_eq!(token.token_id, "strat-1");

    let view = c.get_strategy("strat-1".into()).unwrap();
    assert_eq!(view.owner_id, minter());
    assert_eq!(view.strategy.wasm_sha256, hash('a'));
    assert_eq!(view.strategy.strategy_id, "momentum-rotation");
    assert_eq!(view.metadata.unwrap().title.unwrap(), "Momentum rotation");
    assert_eq!(view.stats.runs_count, 0);
    assert_eq!(view.stats.first_ts, None);
    assert_eq!(view.stats.index_e6, U128(1_000_000));
    assert_eq!(view.stats.peak_index_e6, U128(1_000_000));
    assert_eq!(view.minted_at_ms, T0_MS);
    assert_eq!(view.versions_count, 1);

    assert_eq!(c.nft_total_supply(), U128(1));
    assert_eq!(c.nft_supply_for_owner(minter()), U128(1));
    assert_eq!(c.nft_tokens(None, None).len(), 1);
    assert_eq!(c.nft_token("strat-1".into()).unwrap().owner_id, minter());

    let logs = get_logs();
    assert!(logs.iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"nft_mint\"")));
    let ev = pilot_events("strategy_minted");
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["version"], "1.0.0");
    assert_eq!(ev[0]["data"][0]["token_id"], "strat-1");
}

#[test]
fn mint_charges_storage_and_refunds_excess() {
    let mut c = setup();
    let deposit = NearToken::from_near(1).as_yoctonear();
    set_ctx(minter(), NearToken::from_near(1));
    let mut s = strategy(&hash('a'));
    s.params_json = "x".repeat(MAX_PARAMS_JSON_BYTES); // 4 KB of params
    c.mint_strategy("big".into(), minter(), token_meta(), s);
    let refund = refunded_to(&minter());
    assert!(refund > 0 && refund < deposit, "refund {refund}");
    let charged = deposit - refund;
    // Must at least cover the 4 KB params blob.
    let byte_cost = env::storage_byte_cost().as_yoctonear();
    assert!(charged >= MAX_PARAMS_JSON_BYTES as u128 * byte_cost, "charged {charged}");
}

#[test]
#[should_panic(expected = "Must attach")]
fn mint_with_tiny_deposit_panics() {
    let mut c = setup();
    set_ctx(minter(), NearToken::from_yoctonear(1));
    c.mint_strategy("strat-1".into(), minter(), token_meta(), strategy(&hash('a')));
}

#[test]
#[should_panic(expected = "Token already exists")]
fn duplicate_token_panics() {
    let mut c = setup();
    mint(&mut c, "strat-1", &hash('a'));
    mint(&mut c, "strat-1", &hash('b'));
}

#[test]
#[should_panic(expected = "wasm_sha256 must be 64 hex characters")]
fn mint_rejects_bad_hash() {
    let mut c = setup();
    mint(&mut c, "strat-1", "abc123");
}

#[test]
#[should_panic(expected = "params_json must be <= 4096 bytes")]
fn mint_rejects_oversized_params() {
    let mut c = setup();
    set_ctx(minter(), NearToken::from_near(1));
    let mut s = strategy(&hash('a'));
    s.params_json = "x".repeat(MAX_PARAMS_JSON_BYTES + 1);
    c.mint_strategy("strat-1".into(), minter(), token_meta(), s);
}

// ---------------------------------------------------------------- record_run

#[test]
fn record_run_stores_record_and_emits_event() {
    let mut c = setup();
    mint(&mut c, "strat-1", &hash('a'));
    let idx = record(&mut c, "strat-1", run("r1", T0_MS, 150, &hash('A')));
    assert_eq!(idx, 0);

    let runs = c.get_runs("strat-1".into(), None, None);
    assert_eq!(runs.len(), 1);
    let r = &runs[0];
    assert_eq!(r.index, 0);
    assert_eq!(r.run_id, "r1");
    assert_eq!(r.wasm_sha256, hash('a'));
    assert_eq!(r.strategy_version, "1.0.0");
    assert_eq!(r.recorder_id, recorder());
    assert_eq!(r.block_height, 1234);
    assert_eq!(r.attestation_ref.as_deref(), Some("call_123"));
    assert_eq!(c.get_run("strat-1".into(), "r1".into()).unwrap(), r.clone());

    let ev = pilot_events("run_recorded");
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["standard"], "pilot");
    assert_eq!(ev[0]["version"], "1.0.0");
    let d = &ev[0]["data"][0];
    assert_eq!(d["token_id"], "strat-1");
    assert_eq!(d["run_id"], "r1");
    assert_eq!(d["index"], 0);
    assert_eq!(d["period_return_bps"], 150);
    assert_eq!(d["cumulative_return_bps"], 150);

    // Recorder paid storage and got the rest back.
    let refund = refunded_to(&recorder());
    let deposit = NearToken::from_millinear(100).as_yoctonear();
    assert!(refund > 0 && refund < deposit);
}

#[test]
#[should_panic(expected = "Must attach")]
fn record_run_with_tiny_deposit_panics() {
    let mut c = setup();
    mint(&mut c, "strat-1", &hash('a'));
    set_ctx(recorder(), NearToken::from_yoctonear(1));
    c.record_run("strat-1".into(), run("r1", T0_MS, 0, &hash('a')));
}

#[test]
#[should_panic(expected = "Only recorders can record runs")]
fn non_recorder_rejected() {
    let mut c = setup();
    mint(&mut c, "strat-1", &hash('a'));
    set_ctx(stranger(), NearToken::from_millinear(100));
    c.record_run("strat-1".into(), run("r1", T0_MS, 0, &hash('a')));
}

#[test]
#[should_panic(expected = "Only recorders can record runs")]
fn removed_recorder_rejected() {
    let mut c = setup();
    mint(&mut c, "strat-1", &hash('a'));
    set_ctx(owner(), NearToken::from_yoctonear(0));
    c.remove_recorder(recorder());
    record(&mut c, "strat-1", run("r1", T0_MS, 0, &hash('a')));
}

#[test]
#[should_panic(expected = "Token not found")]
fn record_on_unknown_token_rejected() {
    let mut c = setup();
    record(&mut c, "nope", run("r1", T0_MS, 0, &hash('a')));
}

#[test]
#[should_panic(expected = "wasm_sha256 does not match")]
fn hash_mismatch_rejected() {
    let mut c = setup();
    mint(&mut c, "strat-1", &hash('a'));
    record(&mut c, "strat-1", run("r1", T0_MS, 0, &hash('b')));
}

#[test]
#[should_panic(expected = "run_id already recorded for this token")]
fn duplicate_run_id_rejected() {
    let mut c = setup();
    mint(&mut c, "strat-1", &hash('a'));
    record(&mut c, "strat-1", run("r1", T0_MS, 0, &hash('a')));
    record(&mut c, "strat-1", run("r1", T0_MS + 1, 0, &hash('a')));
}

#[test]
fn same_run_id_allowed_on_different_tokens() {
    let mut c = setup();
    mint(&mut c, "strat-1", &hash('a'));
    mint(&mut c, "strat-2", &hash('b'));
    record(&mut c, "strat-1", run("r1", T0_MS, 0, &hash('a')));
    record(&mut c, "strat-2", run("r1", T0_MS, 0, &hash('b')));
    assert_eq!(c.get_stats("strat-1".into()).unwrap().runs_count, 1);
    assert_eq!(c.get_stats("strat-2".into()).unwrap().runs_count, 1);
}

#[test]
#[should_panic(expected = "timestamp_ms is older than the last recorded run")]
fn timestamp_going_backwards_rejected() {
    let mut c = setup();
    mint(&mut c, "strat-1", &hash('a'));
    record(&mut c, "strat-1", run("r1", T0_MS, 0, &hash('a')));
    // Equal timestamp is fine.
    record(&mut c, "strat-1", run("r2", T0_MS, 0, &hash('a')));
    record(&mut c, "strat-1", run("r3", T0_MS - 1, 0, &hash('a')));
}

#[test]
#[should_panic(expected = "engine must be")]
fn bad_engine_rejected() {
    let mut c = setup();
    mint(&mut c, "strat-1", &hash('a'));
    let mut r = run("r1", T0_MS, 0, &hash('a'));
    r.engine = "docker".into();
    record(&mut c, "strat-1", r);
}

#[test]
#[should_panic(expected = "period_return_bps must be >= -10000")]
fn return_below_minus_100_percent_rejected() {
    let mut c = setup();
    mint(&mut c, "strat-1", &hash('a'));
    record(&mut c, "strat-1", run("r1", T0_MS, -10_001, &hash('a')));
}

// ---------------------------------------------------------------------- stats

#[test]
fn stats_compound_and_track_drawdown() {
    let mut c = setup();
    mint(&mut c, "strat-1", &hash('a'));
    record(&mut c, "strat-1", run("r1", T0_MS, 1_000, &hash('a'))); // +10%
    record(&mut c, "strat-1", run("r2", T0_MS + 60_000, -2_000, &hash('a'))); // -20%

    let s = c.get_stats("strat-1".into()).unwrap();
    assert_eq!(s.runs_count, 2);
    assert_eq!(s.first_ts, Some(T0_MS));
    assert_eq!(s.last_ts, Some(T0_MS + 60_000));
    // 1.1 * 0.8 - 1 = -12%
    assert_eq!(s.cumulative_return_bps, -1_200);
    assert_eq!(s.index_e6, U128(880_000));
    assert_eq!(s.peak_index_e6, U128(1_100_000));
    // (1.1 - 0.88) / 1.1 = 20%
    assert_eq!(s.max_drawdown_bps, 2_000);
    assert_eq!(s.last_equity_usd_e6, Some(10_000_000_000));

    // +25% -> 1.1 again: back to the peak, drawdown history kept.
    record(&mut c, "strat-1", run("r3", T0_MS + 120_000, 2_500, &hash('a')));
    let s = c.get_stats("strat-1".into()).unwrap();
    assert_eq!(s.cumulative_return_bps, 1_000);
    assert_eq!(s.index_e6, U128(1_100_000));
    assert_eq!(s.peak_index_e6, U128(1_100_000));
    assert_eq!(s.max_drawdown_bps, 2_000);

    // -100% wipes the index out.
    record(&mut c, "strat-1", run("r4", T0_MS + 180_000, -10_000, &hash('a')));
    let s = c.get_stats("strat-1".into()).unwrap();
    assert_eq!(s.cumulative_return_bps, -10_000);
    assert_eq!(s.index_e6, U128(0));
    assert_eq!(s.max_drawdown_bps, 10_000);
}

#[test]
fn stats_first_loss_counts_as_drawdown_from_start() {
    let mut st = StatsState::default();
    st.apply(1, -500, 0);
    assert_eq!(st.cumulative_return_bps(), -500);
    assert_eq!(st.max_drawdown_bps, 500);
    assert_eq!(st.peak_index_e12, INDEX_ONE_E12);
}

#[test]
fn stats_compounding_has_no_visible_drift() {
    // +1% then -1% repeated 500 times: (1.01*0.99)^500 = 0.9999^500 = 0.95122704627...
    // (exact rational value; the i128 e12 index gives 0.951227045805, error < 1e-9)
    let mut st = StatsState::default();
    for i in 0..500 {
        st.apply(i * 2, 100, 0);
        st.apply(i * 2 + 1, -100, 0);
    }
    // -487.73 bps, truncated toward zero
    assert_eq!(st.cumulative_return_bps(), -487);
    assert_eq!(st.view().index_e6, U128(951_227));
    assert!((st.index_e12 - 951_227_046_271).abs() < 1_000);
}

// ---------------------------------------------------------------- pagination

#[test]
fn get_runs_paginates_and_caps_limit() {
    let mut c = setup();
    mint(&mut c, "strat-1", &hash('a'));
    for i in 0..120u64 {
        record(&mut c, "strat-1", run(&format!("r{i}"), T0_MS + i, 1, &hash('a')));
    }
    let page = c.get_runs("strat-1".into(), Some(0), Some(3));
    assert_eq!(page.iter().map(|r| r.index).collect::<Vec<_>>(), vec![0, 1, 2]);

    let page = c.get_runs("strat-1".into(), Some(10), Some(5));
    assert_eq!(page.len(), 5);
    assert_eq!(page[0].run_id, "r10");
    assert_eq!(page[4].index, 14);

    // limit capped at 100, default also 100
    assert_eq!(c.get_runs("strat-1".into(), None, Some(1_000)).len(), 100);
    assert_eq!(c.get_runs("strat-1".into(), None, None).len(), 100);
    // tail
    let tail = c.get_runs("strat-1".into(), Some(100), Some(100));
    assert_eq!(tail.len(), 20);
    assert_eq!(tail.last().unwrap().index, 119);
    // out of range / zero limit / unknown token
    assert!(c.get_runs("strat-1".into(), Some(120), None).is_empty());
    assert!(c.get_runs("strat-1".into(), Some(0), Some(0)).is_empty());
    assert!(c.get_runs("nope".into(), None, None).is_empty());
    assert!(c.get_strategy("nope".into()).is_none());
    assert!(c.get_stats("nope".into()).is_none());
    assert!(c.get_versions("nope".into()).is_empty());

    assert_eq!(c.get_run("strat-1".into(), "r77".into()).unwrap().index, 77);
    assert!(c.get_run("strat-1".into(), "r999".into()).is_none());
}

// ------------------------------------------------------------------ versions

#[test]
fn version_update_keeps_history_and_switches_hash() {
    let mut c = setup();
    mint(&mut c, "strat-1", &hash('a'));
    record(&mut c, "strat-1", run("r1", T0_MS, 100, &hash('a')));
    record(&mut c, "strat-1", run("r2", T0_MS + 1, 100, &hash('a')));

    set_ctx(minter(), NearToken::from_millinear(10));
    c.update_strategy_version(
        "strat-1".into(),
        "2.0.0".into(),
        hash('B'),
        "https://github.com/example/strategies/tree/v2".into(),
    );
    let ev = pilot_events("strategy_version_updated");
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["data"][0]["old_version"], "1.0.0");
    assert_eq!(ev[0]["data"][0]["version"], "2.0.0");

    let info = c.get_strategy("strat-1".into()).unwrap();
    assert_eq!(info.strategy.version, "2.0.0");
    assert_eq!(info.strategy.wasm_sha256, hash('b'));
    assert_eq!(info.versions_count, 2);

    record(&mut c, "strat-1", run("r3", T0_MS + 2, 100, &hash('b')));

    let versions = c.get_versions("strat-1".into());
    assert_eq!(versions.len(), 2);
    assert_eq!(versions[0].version, "1.0.0");
    assert_eq!(versions[0].wasm_sha256, hash('a'));
    assert_eq!(versions[0].from_run_index, 0);
    assert_eq!(versions[0].to_run_index, Some(2));
    assert_eq!(versions[0].retired_at_ms, Some(T0_MS));
    assert_eq!(versions[1].version, "2.0.0");
    assert_eq!(versions[1].from_run_index, 2);
    assert_eq!(versions[1].to_run_index, None);

    let runs = c.get_runs("strat-1".into(), None, None);
    assert_eq!(runs[0].wasm_sha256, hash('a'));
    assert_eq!(runs[0].strategy_version, "1.0.0");
    assert_eq!(runs[2].wasm_sha256, hash('b'));
    assert_eq!(runs[2].strategy_version, "2.0.0");
    // Stats continue across versions.
    assert_eq!(c.get_stats("strat-1".into()).unwrap().runs_count, 3);
}

#[test]
#[should_panic(expected = "wasm_sha256 does not match")]
fn old_hash_rejected_after_version_update() {
    let mut c = setup();
    mint(&mut c, "strat-1", &hash('a'));
    set_ctx(minter(), NearToken::from_millinear(10));
    c.update_strategy_version("strat-1".into(), "2.0.0".into(), hash('b'), "u".into());
    record(&mut c, "strat-1", run("r1", T0_MS, 0, &hash('a')));
}

#[test]
#[should_panic(expected = "Only the token owner can update the strategy")]
fn version_update_by_non_owner_rejected() {
    let mut c = setup();
    mint(&mut c, "strat-1", &hash('a'));
    set_ctx(stranger(), NearToken::from_millinear(10));
    c.update_strategy_version("strat-1".into(), "2.0.0".into(), hash('b'), "u".into());
}

#[test]
#[should_panic(expected = "new version must differ from the current version")]
fn version_update_requires_new_label() {
    let mut c = setup();
    mint(&mut c, "strat-1", &hash('a'));
    set_ctx(minter(), NearToken::from_millinear(10));
    c.update_strategy_version("strat-1".into(), "1.0.0".into(), hash('b'), "u".into());
}

#[test]
fn new_owner_after_transfer_can_update_version() {
    let mut c = setup();
    mint(&mut c, "strat-1", &hash('a'));
    set_ctx(minter(), NearToken::from_yoctonear(1));
    c.nft_transfer(stranger(), "strat-1".into(), None, None);
    assert_eq!(c.get_strategy("strat-1".into()).unwrap().owner_id, stranger());

    set_ctx(stranger(), NearToken::from_millinear(10));
    c.update_strategy_version("strat-1".into(), "2.0.0".into(), hash('c'), "u".into());
    assert_eq!(c.get_strategy("strat-1".into()).unwrap().strategy.wasm_sha256, hash('c'));
}
