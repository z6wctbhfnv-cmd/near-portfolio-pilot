//! Deterministic portfolio strategies.
//!
//! One pure function, [`run`], turns a JSON input (portfolio, prices, price history, strategy
//! parameters and the strategy's saved state) into a JSON decision (target weights and the swaps
//! that reach them). There is no clock, randomness, network or file access: the same input always
//! gives the same output, so a run on OutLayer's TEE and a local backtest of the same `.wasm`
//! agree byte for byte.
//!
//! Every map is a `BTreeMap`, so iteration and output order are sorted and stable.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Strategy ids this module implements, with a one-line description each.
pub const STRATEGIES: &[(&str, &str)] = &[
    ("rebalance", "Hold fixed target weights; rebalance when any weight drifts past the band."),
    ("dca", "Buy a fixed USD amount of chosen assets from the stablecoin every N days."),
    ("trend", "Hold each risk asset at full weight above its moving average, cut it below."),
    ("vol_target", "Scale the risk basket so its recent volatility matches a target."),
    ("momentum", "Hold the strongest assets by recent return, only while that return is positive."),
    ("mean_reversion", "Buy short pullbacks inside an uptrend; stay out of downtrends."),
    ("breakout", "Hold an asset after it makes a new N-day high; leave after a new M-day low."),
    ("dip_buy", "Hold more of an asset when it trades below its average, less when above."),
    ("stress_rotation", "Hold the basket in calm markets; move to the stablecoin when the market is stressed."),
];

#[derive(Debug, Clone, Deserialize)]
pub struct Holding {
    pub symbol: String,
    pub units: f64,
    pub price: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Input {
    pub strategy: String,
    #[serde(default)]
    pub params: Value,
    /// Decision time, unix milliseconds. Supplied by the caller; the module never reads a clock.
    pub now_ms: u64,
    /// Opaque state the previous run returned (for example the time of the last DCA buy).
    #[serde(default)]
    pub state: Value,
    pub portfolio: Vec<Holding>,
    /// Daily closes per symbol, oldest first; the last value is the most recent close.
    #[serde(default)]
    pub history: BTreeMap<String, Vec<f64>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Trade {
    pub sell: String,
    pub buy: String,
    pub usd: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Output {
    pub ok: bool,
    pub engine_version: String,
    pub strategy: String,
    pub input_sha256: String,
    pub total_usd: f64,
    pub current_weights: BTreeMap<String, f64>,
    pub target_weights: BTreeMap<String, f64>,
    pub rebalance: bool,
    pub trades: Vec<Trade>,
    pub state: Value,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorOutput {
    pub ok: bool,
    pub engine_version: String,
    pub input_sha256: String,
    pub error: String,
}

/// Common knobs every strategy accepts.
#[derive(Debug, Clone)]
struct Common {
    stable: String,
    band: f64,
    min_trade_usd: f64,
    max_turnover: f64,
    sell_unmanaged: bool,
}

fn num(params: &Value, key: &str, default: f64) -> Result<f64, String> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(v) => v
            .as_f64()
            .filter(|x| x.is_finite())
            .ok_or_else(|| format!("param `{key}` must be a finite number")),
    }
}

fn text(params: &Value, key: &str, default: &str) -> Result<String, String> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(default.to_string()),
        Some(Value::String(s)) if !s.is_empty() => Ok(s.clone()),
        _ => Err(format!("param `{key}` must be a non-empty string")),
    }
}

fn flag(params: &Value, key: &str, default: bool) -> Result<bool, String> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Bool(b)) => Ok(*b),
        _ => Err(format!("param `{key}` must be true or false")),
    }
}

fn weights(params: &Value, key: &str) -> Result<BTreeMap<String, f64>, String> {
    let obj = params
        .get(key)
        .and_then(Value::as_object)
        .ok_or_else(|| format!("param `{key}` must be an object of symbol -> weight"))?;
    let mut out = BTreeMap::new();
    for (sym, w) in obj {
        let w = w
            .as_f64()
            .filter(|x| x.is_finite() && *x >= 0.0 && *x <= 1.0)
            .ok_or_else(|| format!("weight of `{sym}` must be between 0 and 1"))?;
        if w > 0.0 {
            out.insert(sym.clone(), w);
        }
    }
    let sum: f64 = out.values().sum();
    if sum > 1.0 + 1e-9 {
        return Err(format!("weights in `{key}` sum to {sum:.4}, more than 1"));
    }
    Ok(out)
}

fn common(params: &Value) -> Result<Common, String> {
    let c = Common {
        stable: text(params, "stable", "USDC")?,
        band: num(params, "band", 0.05)?,
        min_trade_usd: num(params, "min_trade_usd", 5.0)?,
        max_turnover: num(params, "max_turnover", 1.0)?,
        sell_unmanaged: flag(params, "sell_unmanaged", false)?,
    };
    if !(0.0..=0.5).contains(&c.band) {
        return Err("param `band` must be between 0 and 0.5".into());
    }
    if c.min_trade_usd < 0.0 {
        return Err("param `min_trade_usd` must not be negative".into());
    }
    if !(c.max_turnover > 0.0 && c.max_turnover <= 1.0) {
        return Err("param `max_turnover` must be in (0, 1]".into());
    }
    Ok(c)
}

fn round_to(x: f64, decimals: i32) -> f64 {
    let m = 10f64.powi(decimals);
    let r = (x * m).round() / m;
    if r == 0.0 {
        0.0 // normalise -0.0
    } else {
        r
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Simple moving average of the last `n` closes, if there are at least `n`.
pub fn sma(closes: &[f64], n: usize) -> Option<f64> {
    if n == 0 || closes.len() < n {
        return None;
    }
    let tail = &closes[closes.len() - n..];
    Some(tail.iter().sum::<f64>() / n as f64)
}

/// Annualised volatility (365-day year) of daily log returns over the last `n` returns.
pub fn annual_vol(closes: &[f64], n: usize) -> Option<f64> {
    if n < 2 || closes.len() < n + 1 {
        return None;
    }
    let tail = &closes[closes.len() - n - 1..];
    let rets: Vec<f64> = tail.windows(2).map(|w| (w[1] / w[0]).ln()).collect();
    let mean = rets.iter().sum::<f64>() / rets.len() as f64;
    let var = rets.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / (rets.len() - 1) as f64;
    Some(var.sqrt() * 365f64.sqrt())
}

/// Turn current values and target weights into a list of swaps.
///
/// Over-weight assets are sold and under-weight ones bought, paired greedily in symbol order so
/// the result is deterministic. Pairs below `min_trade_usd` are dropped; when the total sold
/// exceeds `max_turnover` of the portfolio, every trade is scaled down by the same factor.
pub fn plan_trades(
    values: &BTreeMap<String, f64>,
    targets: &BTreeMap<String, f64>,
    total: f64,
    min_trade_usd: f64,
    max_turnover: f64,
) -> Vec<Trade> {
    let mut sells: Vec<(String, f64)> = Vec::new();
    let mut buys: Vec<(String, f64)> = Vec::new();
    let mut symbols: Vec<&String> = values.keys().chain(targets.keys()).collect();
    symbols.sort();
    symbols.dedup();
    for sym in symbols {
        let cur = values.get(sym).copied().unwrap_or(0.0);
        let tgt = targets.get(sym).copied().unwrap_or(0.0) * total;
        let d = tgt - cur;
        if d < -1e-9 {
            sells.push((sym.clone(), -d));
        } else if d > 1e-9 {
            buys.push((sym.clone(), d));
        }
    }
    let mut trades = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < sells.len() && j < buys.len() {
        let amt = sells[i].1.min(buys[j].1);
        if amt > 0.0 {
            trades.push(Trade { sell: sells[i].0.clone(), buy: buys[j].0.clone(), usd: amt });
        }
        sells[i].1 -= amt;
        buys[j].1 -= amt;
        if sells[i].1 <= 1e-9 {
            i += 1;
        }
        if buys[j].1 <= 1e-9 {
            j += 1;
        }
    }
    let sold: f64 = trades.iter().map(|t| t.usd).sum();
    let cap = max_turnover * total;
    let scale = if sold > cap && sold > 0.0 { cap / sold } else { 1.0 };
    trades
        .into_iter()
        .map(|t| Trade { usd: round_to(t.usd * scale, 2), ..t })
        .filter(|t| t.usd >= min_trade_usd && t.usd > 0.0)
        .collect()
}

struct Book {
    values: BTreeMap<String, f64>,
    total: f64,
    unmanaged: Vec<String>,
}

fn book(input: &Input, managed: &[String], c: &Common) -> Result<Book, String> {
    let mut values = BTreeMap::new();
    let mut unmanaged = Vec::new();
    for h in &input.portfolio {
        if !(h.units.is_finite() && h.units >= 0.0) {
            return Err(format!("units of `{}` must be a non-negative number", h.symbol));
        }
        if !(h.price.is_finite() && h.price > 0.0) {
            return Err(format!("price of `{}` must be a positive number", h.symbol));
        }
        let v = h.units * h.price;
        if !c.sell_unmanaged && !managed.iter().any(|m| m == &h.symbol) {
            if v > 0.0 {
                unmanaged.push(h.symbol.clone());
            }
            continue;
        }
        *values.entry(h.symbol.clone()).or_insert(0.0) += v;
    }
    let total = values.values().sum();
    Ok(Book { values, total, unmanaged })
}

fn weights_of(values: &BTreeMap<String, f64>, total: f64) -> BTreeMap<String, f64> {
    values
        .iter()
        .map(|(k, v)| (k.clone(), if total > 0.0 { round_to(v / total, 6) } else { 0.0 }))
        .collect()
}

fn with_stable(mut risk: BTreeMap<String, f64>, stable: &str) -> BTreeMap<String, f64> {
    let used: f64 = risk.values().sum();
    let rest = (1.0 - used).max(0.0);
    *risk.entry(stable.to_string()).or_insert(0.0) += rest;
    risk.retain(|_, w| *w > 1e-12);
    risk
}

struct Decision {
    targets: BTreeMap<String, f64>,
    force_trades: Option<Vec<Trade>>,
    state: Value,
    notes: Vec<String>,
}

fn decide_rebalance(input: &Input, c: &Common) -> Result<Decision, String> {
    let w = weights(&input.params, "weights")?;
    Ok(Decision {
        targets: with_stable(w, &c.stable),
        force_trades: None,
        state: input.state.clone(),
        notes: vec![],
    })
}

fn decide_trend(input: &Input, c: &Common) -> Result<Decision, String> {
    let w = weights(&input.params, "weights")?;
    let n = num(&input.params, "sma_days", 50.0)?;
    let off = num(&input.params, "off_fraction", 0.25)?;
    if !(2.0..=400.0).contains(&n) || n.fract() != 0.0 {
        return Err("param `sma_days` must be a whole number from 2 to 400".into());
    }
    if !(0.0..=1.0).contains(&off) {
        return Err("param `off_fraction` must be between 0 and 1".into());
    }
    let mut notes = Vec::new();
    let mut risk = BTreeMap::new();
    for (sym, weight) in w {
        let closes = input.history.get(&sym).map(Vec::as_slice).unwrap_or(&[]);
        let scaled = match (sma(closes, n as usize), closes.last()) {
            (Some(avg), Some(last)) if *last >= avg => {
                notes.push(format!("{sym}: close {last:.6} >= SMA{n} {avg:.6}, risk on"));
                weight
            }
            (Some(avg), Some(last)) => {
                notes.push(format!("{sym}: close {last:.6} < SMA{n} {avg:.6}, cut to {off}"));
                weight * off
            }
            _ => {
                notes.push(format!("{sym}: fewer than {n} closes, treated as risk off"));
                weight * off
            }
        };
        risk.insert(sym, scaled);
    }
    Ok(Decision { targets: with_stable(risk, &c.stable), force_trades: None, state: input.state.clone(), notes })
}

fn decide_vol_target(input: &Input, c: &Common) -> Result<Decision, String> {
    let w = weights(&input.params, "weights")?;
    let target_vol = num(&input.params, "target_vol", 0.5)?;
    let lookback = num(&input.params, "lookback", 30.0)?;
    let max_scale = num(&input.params, "max_scale", 1.0)?;
    if !(0.01..=3.0).contains(&target_vol) {
        return Err("param `target_vol` must be between 0.01 and 3".into());
    }
    if !(5.0..=365.0).contains(&lookback) || lookback.fract() != 0.0 {
        return Err("param `lookback` must be a whole number from 5 to 365".into());
    }
    if !(0.0..=1.0).contains(&max_scale) {
        return Err("param `max_scale` must be between 0 and 1".into());
    }
    let n = lookback as usize;
    let wsum: f64 = w.values().sum();
    // Basket index: weighted sum of each asset's price relative to its first close in the window.
    let mut basket: Option<Vec<f64>> = None;
    for (sym, weight) in &w {
        let closes = input.history.get(sym).map(Vec::as_slice).unwrap_or(&[]);
        if closes.len() < n + 1 {
            basket = None;
            break;
        }
        let tail = &closes[closes.len() - n - 1..];
        let base = tail[0];
        let rel: Vec<f64> = tail.iter().map(|p| p / base * weight / wsum.max(1e-12)).collect();
        basket = Some(match basket {
            None => rel,
            Some(acc) => acc.iter().zip(rel.iter()).map(|(a, b)| a + b).collect(),
        });
        if basket.is_none() {
            break;
        }
    }
    let mut notes = Vec::new();
    let scale = match basket.as_deref().and_then(|b| annual_vol(b, n)) {
        Some(vol) if vol > 0.0 => {
            let s = (target_vol / vol).min(max_scale);
            notes.push(format!("basket vol {:.4} vs target {target_vol}: scale {:.4}", vol, s));
            s
        }
        _ => {
            notes.push(format!("not enough history for {n}-day volatility, holding stable"));
            0.0
        }
    };
    let risk = w.into_iter().map(|(k, v)| (k, v * scale)).collect();
    Ok(Decision { targets: with_stable(risk, &c.stable), force_trades: None, state: input.state.clone(), notes })
}

fn decide_dca(input: &Input, c: &Common, book: &Book) -> Result<Decision, String> {
    let buy = weights(&input.params, "buy")?;
    let amount = num(&input.params, "amount_usd", 20.0)?;
    let every_days = num(&input.params, "every_days", 7.0)?;
    if !(amount > 0.0 && amount <= 1_000_000.0) {
        return Err("param `amount_usd` must be in (0, 1000000]".into());
    }
    if !(every_days >= 1.0 && every_days <= 365.0) {
        return Err("param `every_days` must be from 1 to 365".into());
    }
    let wsum: f64 = buy.values().sum();
    if wsum <= 0.0 {
        return Err("param `buy` needs at least one weight above 0".into());
    }
    let last = input.state.get("last_buy_ms").and_then(Value::as_u64);
    let period_ms = (every_days * 86_400_000.0) as u64;
    let due = match last {
        None => true,
        Some(t) => input.now_ms >= t.saturating_add(period_ms),
    };
    let mut notes = Vec::new();
    let mut state = input.state.clone();
    let mut trades = Vec::new();
    let stable_usd = book.values.get(&c.stable).copied().unwrap_or(0.0);
    if !due {
        notes.push("not due yet".into());
    } else if stable_usd < c.min_trade_usd.max(0.01) {
        notes.push(format!("{} balance {:.2} USD is too low to buy", c.stable, stable_usd));
    } else {
        let spend = amount.min(stable_usd);
        if spend < amount {
            notes.push(format!("only {spend:.2} of {amount:.2} USD available"));
        }
        for (sym, w) in &buy {
            if sym == &c.stable {
                continue;
            }
            let usd = round_to(spend * w / wsum, 2);
            if usd >= c.min_trade_usd && usd > 0.0 {
                trades.push(Trade { sell: c.stable.clone(), buy: sym.clone(), usd });
            }
        }
        if !trades.is_empty() {
            let mut obj = state.as_object().cloned().unwrap_or_default();
            obj.insert("last_buy_ms".into(), json!(input.now_ms));
            state = Value::Object(obj);
        }
    }
    // Targets after the planned buys, for display.
    let mut after = book.values.clone();
    for t in &trades {
        *after.entry(t.sell.clone()).or_insert(0.0) -= t.usd;
        *after.entry(t.buy.clone()).or_insert(0.0) += t.usd;
    }
    let targets = weights_of(&after, book.total);
    Ok(Decision { targets, force_trades: Some(trades), state, notes })
}

fn whole(params: &Value, key: &str, default: f64, lo: f64, hi: f64) -> Result<usize, String> {
    let n = num(params, key, default)?;
    if !(lo..=hi).contains(&n) || n.fract() != 0.0 {
        return Err(format!("param `{key}` must be a whole number from {lo} to {hi}"));
    }
    Ok(n as usize)
}

fn ranged(params: &Value, key: &str, default: f64, lo: f64, hi: f64) -> Result<f64, String> {
    let n = num(params, key, default)?;
    if !(lo..=hi).contains(&n) {
        return Err(format!("param `{key}` must be between {lo} and {hi}"));
    }
    Ok(n)
}

fn closes_of<'a>(input: &'a Input, sym: &str) -> &'a [f64] {
    input.history.get(sym).map(Vec::as_slice).unwrap_or(&[])
}

/// Momentum: rank the basket by return over `lookback_days`; hold the `top_k` best, each at an equal
/// share of the basket's total weight, and only while its return is positive.
fn decide_momentum(input: &Input, c: &Common) -> Result<Decision, String> {
    let w = weights(&input.params, "weights")?;
    let lookback = whole(&input.params, "lookback_days", 60.0, 5.0, 365.0)?;
    let k = whole(&input.params, "top_k", 2.0, 1.0, 10.0)?;
    let budget: f64 = w.values().sum();
    let mut notes = Vec::new();
    let mut ranked: Vec<(String, f64)> = Vec::new();
    for sym in w.keys() {
        let cl = closes_of(input, sym);
        if cl.len() > lookback {
            let r = cl[cl.len() - 1] / cl[cl.len() - 1 - lookback] - 1.0;
            notes.push(format!("{sym}: {:+.1}% over {lookback} days", r * 100.0));
            ranked.push((sym.clone(), r));
        } else {
            notes.push(format!("{sym}: fewer than {} closes, left out", lookback + 1));
        }
    }
    // Highest return first; ties by symbol so the order is stable.
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    let mut risk = BTreeMap::new();
    for (sym, r) in ranked.into_iter().take(k) {
        if r > 0.0 {
            risk.insert(sym, budget / k as f64);
        }
    }
    if risk.is_empty() {
        notes.push("no asset with a positive return in the top, all in the stablecoin".into());
    }
    Ok(Decision { targets: with_stable(risk, &c.stable), force_trades: None, state: input.state.clone(), notes })
}

/// Mean reversion: hold an asset at its weight when it is above its `trend_days` average (an
/// uptrend) and fell more than `dip` over the last `dip_days`; otherwise stay out.
fn decide_mean_reversion(input: &Input, c: &Common) -> Result<Decision, String> {
    let w = weights(&input.params, "weights")?;
    let trend = whole(&input.params, "trend_days", 100.0, 10.0, 400.0)?;
    let dip_days = whole(&input.params, "dip_days", 3.0, 1.0, 30.0)?;
    let dip = ranged(&input.params, "dip", 0.06, 0.01, 0.5)?;
    let mut notes = Vec::new();
    let mut risk = BTreeMap::new();
    for (sym, weight) in w {
        let cl = closes_of(input, &sym);
        match (sma(cl, trend), cl.len() > dip_days) {
            (Some(avg), true) => {
                let last = cl[cl.len() - 1];
                let r = last / cl[cl.len() - 1 - dip_days] - 1.0;
                if last > avg && r < -dip {
                    notes.push(format!("{sym}: {:+.1}% in {dip_days} days inside an uptrend, buy the dip", r * 100.0));
                    risk.insert(sym, weight);
                } else if last <= avg {
                    notes.push(format!("{sym}: below its {trend}-day average, stay out"));
                } else {
                    notes.push(format!("{sym}: {:+.1}% in {dip_days} days, no dip to buy", r * 100.0));
                }
            }
            _ => notes.push(format!("{sym}: fewer than {trend} closes, stay out")),
        }
    }
    Ok(Decision { targets: with_stable(risk, &c.stable), force_trades: None, state: input.state.clone(), notes })
}

/// Breakout (Donchian): an asset is held from its latest close at a new `entry_days` high until a
/// later close at a new `exit_days` low. Looks back over `3 * entry_days` closes.
fn decide_breakout(input: &Input, c: &Common) -> Result<Decision, String> {
    let w = weights(&input.params, "weights")?;
    let entry = whole(&input.params, "entry_days", 55.0, 5.0, 300.0)?;
    let exit = whole(&input.params, "exit_days", 20.0, 2.0, 200.0)?;
    if exit >= entry {
        return Err("param `exit_days` must be smaller than `entry_days`".into());
    }
    let mut notes = Vec::new();
    let mut risk = BTreeMap::new();
    for (sym, weight) in w {
        let all = closes_of(input, &sym);
        if all.len() < entry + 1 {
            notes.push(format!("{sym}: fewer than {} closes, stay out", entry + 1));
            continue;
        }
        let cl = &all[all.len().saturating_sub(entry * 3)..];
        // Days since the latest close at a new high / low (0 = the last close).
        let since = |n: usize, high: bool| -> Option<usize> {
            (0..cl.len()).find(|&k| {
                let i = cl.len() - 1 - k;
                if i + 1 < n {
                    return false;
                }
                let win = &cl[i + 1 - n..=i];
                if high {
                    cl[i] >= win.iter().cloned().fold(f64::MIN, f64::max)
                } else {
                    cl[i] <= win.iter().cloned().fold(f64::MAX, f64::min)
                }
            })
        };
        match (since(entry, true), since(exit, false)) {
            (Some(h), low) if low.map_or(true, |l| h < l) => {
                notes.push(format!("{sym}: new {entry}-day high {h} days ago, holding"));
                risk.insert(sym, weight);
            }
            (_, Some(l)) => notes.push(format!("{sym}: new {exit}-day low {l} days ago, out")),
            _ => notes.push(format!("{sym}: no breakout yet, out")),
        }
    }
    Ok(Decision { targets: with_stable(risk, &c.stable), force_trades: None, state: input.state.clone(), notes })
}

/// Dip buying: each asset's weight is scaled by how far it trades from its `window`-day average,
/// `1 - sensitivity * deviation`, kept between 0 and `max_scale`. If the total passes 100%, every
/// asset is scaled down by the same factor.
fn decide_dip_buy(input: &Input, c: &Common) -> Result<Decision, String> {
    let w = weights(&input.params, "weights")?;
    let window = whole(&input.params, "window_days", 30.0, 5.0, 200.0)?;
    let sens = ranged(&input.params, "sensitivity", 4.0, 0.0, 20.0)?;
    let max_scale = ranged(&input.params, "max_scale", 2.0, 1.0, 3.0)?;
    let mut notes = Vec::new();
    let mut risk = BTreeMap::new();
    for (sym, weight) in w {
        let cl = closes_of(input, &sym);
        let scale = match (sma(cl, window), cl.last()) {
            (Some(avg), Some(last)) => {
                let dev = last / avg - 1.0;
                let s = (1.0 - sens * dev).clamp(0.0, max_scale);
                notes.push(format!("{sym}: {:+.1}% vs its {window}-day average, weight x{s:.2}", dev * 100.0));
                s
            }
            _ => {
                notes.push(format!("{sym}: fewer than {window} closes, base weight"));
                1.0
            }
        };
        risk.insert(sym, weight * scale);
    }
    let total: f64 = risk.values().sum();
    if total > 1.0 {
        for v in risk.values_mut() {
            *v /= total;
        }
    }
    Ok(Decision { targets: with_stable(risk, &c.stable), force_trades: None, state: input.state.clone(), notes })
}

/// Stress rotation: hold the basket while the `signal` asset is calm; move everything to the
/// stablecoin when it trades below its `trend_days` average or its `vol_days` volatility is in the
/// top quarter of the past `year_days`.
fn decide_stress_rotation(input: &Input, c: &Common) -> Result<Decision, String> {
    let w = weights(&input.params, "weights")?;
    let signal = text(&input.params, "signal", "BTC")?;
    let trend = whole(&input.params, "trend_days", 50.0, 10.0, 300.0)?;
    let vol_days = whole(&input.params, "vol_days", 30.0, 5.0, 120.0)?;
    let year = whole(&input.params, "year_days", 365.0, 60.0, 730.0)?;
    if !w.contains_key(&signal) {
        return Err(format!("param `signal` must be one of the basket's assets, got `{signal}`"));
    }
    let cl = closes_of(input, &signal);
    let mut notes = Vec::new();
    let below = match (sma(cl, trend), cl.last()) {
        (Some(avg), Some(last)) => *last < avg,
        _ => {
            notes.push(format!("{signal}: fewer than {trend} closes, treated as stressed"));
            true
        }
    };
    // Rolling volatility of daily returns, one value per day over the past year.
    let rets: Vec<f64> = cl.windows(2).map(|p| p[1] / p[0] - 1.0).collect();
    let vols: Vec<f64> = if rets.len() >= vol_days {
        (vol_days..=rets.len())
            .map(|end| {
                let s = &rets[end - vol_days..end];
                let m = s.iter().sum::<f64>() / s.len() as f64;
                (s.iter().map(|r| (r - m).powi(2)).sum::<f64>() / (s.len() - 1).max(1) as f64).sqrt()
            })
            .collect()
    } else {
        vec![]
    };
    let hist = &vols[vols.len().saturating_sub(year)..];
    let high_vol = if hist.len() > 60 {
        let mut sorted = hist.to_vec();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let q = sorted[((sorted.len() - 1) as f64 * 0.75).round() as usize];
        *hist.last().unwrap() > q
    } else {
        false
    };
    let stressed = below || high_vol;
    if below {
        notes.push(format!("{signal}: below its {trend}-day average, stressed"));
    }
    if high_vol {
        notes.push(format!("{signal}: {vol_days}-day volatility in the top quarter of the past year, stressed"));
    }
    let risk = if stressed {
        notes.push("stress: basket moved to the stablecoin".into());
        BTreeMap::new()
    } else {
        notes.push(format!("{signal}: calm, holding the basket"));
        w
    };
    Ok(Decision { targets: with_stable(risk, &c.stable), force_trades: None, state: input.state.clone(), notes })
}

fn managed_symbols(input: &Input, c: &Common) -> Result<Vec<String>, String> {
    let key = if input.strategy == "dca" { "buy" } else { "weights" };
    let mut syms: Vec<String> = weights(&input.params, key)?.into_keys().collect();
    syms.push(c.stable.clone());
    syms.sort();
    syms.dedup();
    Ok(syms)
}

/// Run one decision. `raw` is the exact input bytes (hashed into the output for audit).
pub fn run(raw: &[u8]) -> Result<Output, (String, String)> {
    let input_sha256 = sha256_hex(raw);
    let fail = |e: String| (input_sha256.clone(), e);
    let input: Input = serde_json::from_slice(raw).map_err(|e| fail(format!("bad input: {e}")))?;
    if !STRATEGIES.iter().any(|(id, _)| *id == input.strategy) {
        return Err(fail(format!("unknown strategy `{}`", input.strategy)));
    }
    let c = common(&input.params).map_err(fail)?;
    let managed = managed_symbols(&input, &c).map_err(fail)?;
    let book = book(&input, &managed, &c).map_err(fail)?;
    let decision = match input.strategy.as_str() {
        "rebalance" => decide_rebalance(&input, &c),
        "trend" => decide_trend(&input, &c),
        "vol_target" => decide_vol_target(&input, &c),
        "dca" => decide_dca(&input, &c, &book),
        "momentum" => decide_momentum(&input, &c),
        "mean_reversion" => decide_mean_reversion(&input, &c),
        "breakout" => decide_breakout(&input, &c),
        "dip_buy" => decide_dip_buy(&input, &c),
        "stress_rotation" => decide_stress_rotation(&input, &c),
        _ => unreachable!(),
    }
    .map_err(fail)?;

    let current = weights_of(&book.values, book.total);
    let mut notes = decision.notes;
    if !book.unmanaged.is_empty() {
        notes.push(format!("left untouched (not managed): {}", book.unmanaged.join(", ")));
    }
    let (rebalance, trades) = match decision.force_trades {
        Some(t) => (!t.is_empty(), t),
        None => {
            let mut drift: f64 = 0.0;
            let mut syms: Vec<&String> = current.keys().chain(decision.targets.keys()).collect();
            syms.sort();
            syms.dedup();
            for s in syms {
                let d = (current.get(s).copied().unwrap_or(0.0) - decision.targets.get(s).copied().unwrap_or(0.0)).abs();
                drift = drift.max(d);
            }
            if book.total <= 0.0 {
                notes.push("portfolio is empty".into());
                (false, vec![])
            } else if drift > c.band {
                notes.push(format!("max drift {:.4} > band {}", drift, c.band));
                let t = plan_trades(&book.values, &decision.targets, book.total, c.min_trade_usd, c.max_turnover);
                (!t.is_empty(), t)
            } else {
                notes.push(format!("max drift {:.4} within band {}", drift, c.band));
                (false, vec![])
            }
        }
    };
    Ok(Output {
        ok: true,
        engine_version: ENGINE_VERSION.to_string(),
        strategy: input.strategy.clone(),
        input_sha256,
        total_usd: round_to(book.total, 2),
        current_weights: current,
        target_weights: decision.targets.into_iter().map(|(k, v)| (k, round_to(v, 6))).collect(),
        rebalance,
        trades,
        state: decision.state,
        notes,
    })
}

/// Run and always produce one JSON value (errors included), as OutLayer expects on stdout.
pub fn run_to_json(raw: &[u8]) -> String {
    match run(raw) {
        Ok(out) => serde_json::to_string(&out).expect("output serialises"),
        Err((input_sha256, error)) => serde_json::to_string(&ErrorOutput {
            ok: false,
            engine_version: ENGINE_VERSION.to_string(),
            input_sha256,
            error,
        })
        .expect("error serialises"),
    }
}

/// `{"catalog": true}` lists the strategies instead of running one.
pub fn catalog_json() -> String {
    let list: Vec<Value> = STRATEGIES.iter().map(|(id, d)| json!({ "id": id, "description": d })).collect();
    json!({ "ok": true, "engine_version": ENGINE_VERSION, "strategies": list }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(v: Value) -> Vec<u8> {
        serde_json::to_vec(&v).unwrap()
    }

    fn port(near_units: f64, usdc: f64) -> Value {
        json!([
            { "symbol": "NEAR", "units": near_units, "price": 4.0 },
            { "symbol": "USDC", "units": usdc, "price": 1.0 }
        ])
    }

    #[test]
    fn rebalance_inside_band_does_nothing() {
        let out = run(&input(json!({
            "strategy": "rebalance", "now_ms": 0,
            "params": { "weights": { "NEAR": 0.5 }, "band": 0.05 },
            "portfolio": port(52.0, 200.0)
        })))
        .unwrap();
        assert!(!out.rebalance);
        assert!(out.trades.is_empty());
        assert_eq!(out.total_usd, 408.0);
    }

    #[test]
    fn rebalance_outside_band_trades_to_target() {
        let out = run(&input(json!({
            "strategy": "rebalance", "now_ms": 0,
            "params": { "weights": { "NEAR": 0.5 } },
            "portfolio": port(100.0, 0.0)
        })))
        .unwrap();
        assert!(out.rebalance);
        assert_eq!(out.trades, vec![Trade { sell: "NEAR".into(), buy: "USDC".into(), usd: 200.0 }]);
        assert_eq!(out.target_weights.get("USDC"), Some(&0.5));
    }

    #[test]
    fn max_turnover_scales_trades() {
        let out = run(&input(json!({
            "strategy": "rebalance", "now_ms": 0,
            "params": { "weights": { "NEAR": 0.5 }, "max_turnover": 0.1 },
            "portfolio": port(100.0, 0.0)
        })))
        .unwrap();
        assert_eq!(out.trades[0].usd, 40.0);
    }

    #[test]
    fn unmanaged_assets_are_left_alone() {
        let out = run(&input(json!({
            "strategy": "rebalance", "now_ms": 0,
            "params": { "weights": { "NEAR": 0.5 } },
            "portfolio": [
                { "symbol": "NEAR", "units": 50.0, "price": 4.0 },
                { "symbol": "USDC", "units": 200.0, "price": 1.0 },
                { "symbol": "DOGE", "units": 1000.0, "price": 0.1 }
            ]
        })))
        .unwrap();
        assert!(out.trades.is_empty());
        assert_eq!(out.total_usd, 400.0);
        assert!(out.notes.iter().any(|n| n.contains("DOGE")));
    }

    #[test]
    fn dca_buys_when_due_and_records_state() {
        let raw = input(json!({
            "strategy": "dca", "now_ms": 1_000,
            "params": { "buy": { "NEAR": 0.5, "BTC": 0.5 }, "amount_usd": 50, "every_days": 7 },
            "portfolio": port(0.0, 500.0)
        }));
        let out = run(&raw).unwrap();
        assert_eq!(out.trades.len(), 2);
        assert_eq!(out.trades[0], Trade { sell: "USDC".into(), buy: "BTC".into(), usd: 25.0 });
        assert_eq!(out.state["last_buy_ms"], json!(1_000));

        let again = run(&input(json!({
            "strategy": "dca", "now_ms": 2_000, "state": { "last_buy_ms": 1_000 },
            "params": { "buy": { "NEAR": 1.0 }, "amount_usd": 50, "every_days": 7 },
            "portfolio": port(0.0, 500.0)
        })))
        .unwrap();
        assert!(again.trades.is_empty());
    }

    #[test]
    fn trend_cuts_below_sma() {
        let falling: Vec<f64> = (0..60).map(|i| 10.0 - i as f64 * 0.1).collect();
        let out = run(&input(json!({
            "strategy": "trend", "now_ms": 0,
            "params": { "weights": { "NEAR": 0.8 }, "sma_days": 20, "off_fraction": 0.25 },
            "portfolio": port(80.0, 80.0),
            "history": { "NEAR": falling }
        })))
        .unwrap();
        assert_eq!(out.target_weights.get("NEAR"), Some(&0.2));
        assert_eq!(out.target_weights.get("USDC"), Some(&0.8));
        assert!(out.rebalance);
    }

    #[test]
    fn vol_target_scales_down_volatile_basket() {
        let wild: Vec<f64> = (0..40).map(|i| if i % 2 == 0 { 10.0 } else { 12.0 }).collect();
        let out = run(&input(json!({
            "strategy": "vol_target", "now_ms": 0,
            "params": { "weights": { "NEAR": 1.0 }, "target_vol": 0.5, "lookback": 30 },
            "portfolio": port(25.0, 0.0),
            "history": { "NEAR": wild }
        })))
        .unwrap();
        let w = *out.target_weights.get("NEAR").unwrap();
        assert!(w > 0.0 && w < 0.2, "weight {w}");
    }

    #[test]
    fn errors_are_json_and_hash_the_input() {
        let raw = br#"{"strategy":"nope","now_ms":0,"portfolio":[]}"#;
        let s = run_to_json(raw);
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["ok"], json!(false));
        assert_eq!(v["input_sha256"], json!(sha256_hex(raw)));
    }

    #[test]
    fn same_input_same_output() {
        let raw = input(json!({
            "strategy": "rebalance", "now_ms": 5,
            "params": { "weights": { "NEAR": 0.3, "BTC": 0.3 } },
            "portfolio": [
                { "symbol": "NEAR", "units": 10.0, "price": 4.0 },
                { "symbol": "BTC", "units": 0.001, "price": 70000.0 },
                { "symbol": "USDC", "units": 100.0, "price": 1.0 }
            ]
        }));
        assert_eq!(run_to_json(&raw), run_to_json(&raw));
    }

    #[test]
    fn rejects_weights_over_one() {
        let r = run(&input(json!({
            "strategy": "rebalance", "now_ms": 0,
            "params": { "weights": { "NEAR": 0.7, "BTC": 0.6 } },
            "portfolio": port(1.0, 1.0)
        })));
        assert!(r.is_err());
    }

    fn two_assets() -> Value {
        json!([
            { "symbol": "BTC", "units": 0.0, "price": 100.0 },
            { "symbol": "ETH", "units": 0.0, "price": 100.0 },
            { "symbol": "USDC", "units": 1000.0, "price": 1.0 }
        ])
    }

    fn line(start: f64, step: f64, n: usize) -> Vec<f64> {
        (0..n).map(|i| start + step * i as f64).collect()
    }

    fn targets(strategy: &str, params: Value, history: Value) -> BTreeMap<String, f64> {
        run(&input(json!({ "strategy": strategy, "now_ms": 0, "params": params, "portfolio": two_assets(), "history": history })))
            .unwrap()
            .target_weights
    }

    #[test]
    fn momentum_holds_only_rising_leaders() {
        let t = targets(
            "momentum",
            json!({ "weights": { "BTC": 0.4, "ETH": 0.4 }, "lookback_days": 10, "top_k": 2 }),
            json!({ "BTC": line(100.0, 1.0, 20), "ETH": line(100.0, -1.0, 20) }),
        );
        assert_eq!(t.get("BTC"), Some(&0.4));
        assert_eq!(t.get("ETH"), None);
        assert_eq!(t.get("USDC"), Some(&0.6));
    }

    #[test]
    fn mean_reversion_buys_a_dip_in_an_uptrend_only() {
        let mut up = line(50.0, 1.0, 120);
        let n = up.len();
        up[n - 1] = up[n - 4] * 0.9; // -10% in 3 days, still above the 100-day average
        let down = line(200.0, -1.0, 120);
        let t = targets(
            "mean_reversion",
            json!({ "weights": { "BTC": 0.5, "ETH": 0.5 } }),
            json!({ "BTC": up, "ETH": down }),
        );
        assert_eq!(t.get("BTC"), Some(&0.5));
        assert_eq!(t.get("ETH"), None);
    }

    #[test]
    fn breakout_holds_after_a_new_high_and_leaves_after_a_new_low() {
        let rising = line(100.0, 1.0, 80);
        let mut fell = line(100.0, 1.0, 70);
        fell.extend(line(150.0, -5.0, 10)); // new 20-day low after the last high
        let t = targets(
            "breakout",
            json!({ "weights": { "BTC": 0.5, "ETH": 0.5 }, "entry_days": 55, "exit_days": 20 }),
            json!({ "BTC": rising, "ETH": fell }),
        );
        assert_eq!(t.get("BTC"), Some(&0.5));
        assert_eq!(t.get("ETH"), None);
    }

    #[test]
    fn dip_buy_leans_into_assets_below_their_average() {
        let mut below = vec![100.0; 30];
        below.push(90.0);
        let mut above = vec![100.0; 30];
        above.push(110.0);
        let t = targets(
            "dip_buy",
            json!({ "weights": { "BTC": 0.3, "ETH": 0.3 }, "window_days": 30 }),
            json!({ "BTC": below, "ETH": above }),
        );
        assert!(t["BTC"] > 0.3 && t["ETH"] < 0.3, "{t:?}");
    }

    #[test]
    fn stress_rotation_goes_to_the_stablecoin_under_its_average() {
        let calm = targets(
            "stress_rotation",
            json!({ "weights": { "BTC": 0.5, "ETH": 0.3 }, "trend_days": 20 }),
            json!({ "BTC": line(100.0, 1.0, 60), "ETH": line(100.0, 1.0, 60) }),
        );
        assert_eq!(calm.get("BTC"), Some(&0.5));
        let stressed = targets(
            "stress_rotation",
            json!({ "weights": { "BTC": 0.5, "ETH": 0.3 }, "trend_days": 20 }),
            json!({ "BTC": line(200.0, -1.0, 60), "ETH": line(100.0, 1.0, 60) }),
        );
        assert_eq!(stressed.get("USDC"), Some(&1.0));
        let bad = run(&input(json!({ "strategy": "stress_rotation", "now_ms": 0,
            "params": { "weights": { "ETH": 0.5 } }, "portfolio": two_assets() })));
        assert!(bad.is_err(), "signal must be in the basket");
    }
}
