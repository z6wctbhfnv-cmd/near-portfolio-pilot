/**
 * Backtests a strategy with the real WASM module on cached daily closes.
 * Usage: npm run backtest -- <strategy> '<params json>' [days=365] [cost_bps=30] [initial_usd=1000]
 * Example: npm run backtest -- trend '{"weights":{"NEAR":0.3,"BTC":0.3}}' 730
 */
import { backtest } from "../backtest.js";
import { loadConfig, loadDotEnv } from "../config.js";
import { openDb } from "../db.js";
import { PriceHistory } from "../history.js";
import { isStrategyId } from "../strategies.js";
import { StrategyWasm } from "../wasm.js";

loadDotEnv();
const cfg = loadConfig();
const [id = "rebalance", paramsJson = '{"weights":{"NEAR":0.3,"BTC":0.3}}', days = "365", cost = String(cfg.PAPER_COST_BPS), initial = "1000"] = process.argv.slice(2);
if (!isStrategyId(id)) throw new Error(`unknown strategy ${id}`);
const db = openDb(cfg.DATABASE_PATH);
const wasm = new StrategyWasm(cfg.STRATEGY_WASM_PATH);
const to = Date.now() - 86_400_000;
const r = await backtest(wasm, new PriceHistory(db, cfg.HISTORY_API_URL), {
  strategy: id,
  params: JSON.parse(paramsJson),
  from: to - Number(days) * 86_400_000,
  to,
  initial_usd: Number(initial),
  cost_bps: Number(cost),
});
const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(2)}%`);
console.log(`${r.strategy} ${r.period.from} → ${r.period.to}, cost ${r.cost_bps} bps, wasm ${r.engine.wasm_sha256.slice(0, 12)}`);
console.log(`params ${JSON.stringify(r.params)}`);
for (const [name, m] of [["strategy", r.metrics], ["buy & hold", r.benchmark_hold]] as const) {
  console.log(`${name.padEnd(11)} end ${m.end_usd.toFixed(2)}  return ${pct(m.total_return)}  CAGR ${pct(m.cagr)}  maxDD ${pct(m.max_drawdown)}  vol ${pct(m.ann_vol)}  sharpe ${m.sharpe ?? "n/a"}`);
}
console.log(`trades ${r.activity.trades}, turnover ${r.activity.turnover_usd} USD, fees ${r.activity.fees_usd} USD, strategy errors ${r.activity.strategy_errors}`);
db.close();
