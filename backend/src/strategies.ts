/**
 * The strategy catalogue on the backend side: parameter schemas, safe bounds and defaults.
 * The decision logic itself lives only in the Rust/WASM module (strategies/), so a backtest,
 * a paper run and a TEE run all execute the same code.
 */
import { z } from "zod";

const weightMap = z
  .record(z.string().regex(/^[A-Z0-9]{2,10}$/), z.number().min(0).max(1))
  .refine((w) => Object.values(w).reduce((a, b) => a + b, 0) <= 1 + 1e-9, "weights must sum to at most 1")
  .refine((w) => Object.keys(w).length > 0, "at least one asset");

const common = {
  stable: z.enum(["USDC", "USDT"]).default("USDC"),
  band: z.number().min(0.01).max(0.5).default(0.05),
  min_trade_usd: z.number().min(1).max(100_000).default(5),
  max_turnover: z.number().gt(0).max(1).default(1),
  /** Hours between decisions. The scheduler runs a pilot when this much time has passed. */
  every_hours: z.number().min(1).max(24 * 31).default(24),
};

export const STRATEGY_SCHEMAS = {
  rebalance: z.object({ ...common, weights: weightMap }),
  trend: z.object({
    ...common,
    weights: weightMap,
    sma_days: z.number().int().min(5).max(200).default(50),
    off_fraction: z.number().min(0).max(1).default(0.25),
  }),
  vol_target: z.object({
    ...common,
    weights: weightMap,
    target_vol: z.number().min(0.05).max(2).default(0.5),
    lookback: z.number().int().min(10).max(180).default(30),
    max_scale: z.number().min(0).max(1).default(1),
  }),
  dca: z.object({
    ...common,
    buy: weightMap,
    amount_usd: z.number().min(1).max(100_000).default(20),
    every_days: z.number().int().min(1).max(90).default(7),
  }),
  momentum: z.object({
    ...common,
    weights: weightMap,
    lookback_days: z.number().int().min(5).max(365).default(60),
    top_k: z.number().int().min(1).max(10).default(2),
  }),
  mean_reversion: z.object({
    ...common,
    weights: weightMap,
    trend_days: z.number().int().min(10).max(400).default(100),
    dip_days: z.number().int().min(1).max(30).default(3),
    dip: z.number().min(0.01).max(0.5).default(0.06),
  }),
  breakout: z
    .object({
      ...common,
      weights: weightMap,
      entry_days: z.number().int().min(5).max(300).default(55),
      exit_days: z.number().int().min(2).max(200).default(20),
    })
    .refine((p) => p.exit_days < p.entry_days, "exit_days must be smaller than entry_days"),
  dip_buy: z.object({
    ...common,
    weights: weightMap,
    window_days: z.number().int().min(5).max(200).default(30),
    sensitivity: z.number().min(0).max(20).default(4),
    max_scale: z.number().min(1).max(3).default(2),
  }),
  stress_rotation: z
    .object({
      ...common,
      weights: weightMap,
      signal: z.string().regex(/^[A-Z0-9]{2,10}$/).default("BTC"),
      trend_days: z.number().int().min(10).max(300).default(50),
      vol_days: z.number().int().min(5).max(120).default(30),
      year_days: z.number().int().min(60).max(730).default(365),
    })
    .refine((p) => p.signal in p.weights, "signal must be one of the basket's assets"),
} as const;

export type StrategyId = keyof typeof STRATEGY_SCHEMAS;
export const STRATEGY_IDS = Object.keys(STRATEGY_SCHEMAS) as StrategyId[];

export const STRATEGY_INFO: Record<StrategyId, { name: string; description: string; history_days: (p: Record<string, unknown>) => number }> = {
  rebalance: {
    name: "Constant mix",
    description: "Hold fixed target weights; rebalance when any weight drifts past the band.",
    history_days: () => 0,
  },
  trend: {
    name: "Trend filter",
    description: "Hold each risk asset at full weight while it trades above its moving average; cut it below.",
    history_days: (p) => Number(p.sma_days ?? 50) + 1,
  },
  vol_target: {
    name: "Volatility target",
    description: "Scale the risk basket so its recent volatility matches the target; the rest sits in the stablecoin.",
    history_days: (p) => Number(p.lookback ?? 30) + 2,
  },
  dca: {
    name: "Dollar-cost averaging",
    description: "Buy a fixed USD amount of the chosen assets from the stablecoin every N days.",
    history_days: () => 0,
  },
  momentum: {
    name: "Momentum",
    description: "Hold the strongest assets by recent return, only while that return is positive; the rest sits in the stablecoin.",
    history_days: (p) => Number(p.lookback_days ?? 60) + 1,
  },
  mean_reversion: {
    name: "Dip in an uptrend",
    description: "Buy short pullbacks of assets that trade above their long average; stay out of downtrends.",
    history_days: (p) => Math.max(Number(p.trend_days ?? 100), Number(p.dip_days ?? 3) + 1) + 1,
  },
  breakout: {
    name: "Breakout",
    description: "Hold an asset after it closes at a new N-day high; leave after it closes at a new M-day low.",
    history_days: (p) => Number(p.entry_days ?? 55) * 3 + 1,
  },
  dip_buy: {
    name: "Buy the dip",
    description: "Hold more of an asset when it trades below its average and less when above.",
    history_days: (p) => Number(p.window_days ?? 30) + 1,
  },
  stress_rotation: {
    name: "Stress rotation",
    description: "Hold the basket while the market is calm; move to the stablecoin when it is under its average or unusually volatile.",
    history_days: (p) => Number(p.year_days ?? 365) + Number(p.vol_days ?? 30) + 2,
  },
};

/**
 * Bounds an AI review may move each numeric parameter within, as a fraction of its current value
 * per review (and never outside the schema's own bounds).
 */
export const REVIEW_TUNABLE: Record<StrategyId, string[]> = {
  rebalance: ["band", "max_turnover"],
  trend: ["band", "sma_days", "off_fraction", "max_turnover"],
  vol_target: ["band", "target_vol", "lookback", "max_scale", "max_turnover"],
  dca: ["amount_usd", "every_days"],
  momentum: ["band", "lookback_days", "max_turnover"],
  mean_reversion: ["band", "trend_days", "dip", "max_turnover"],
  breakout: ["band", "entry_days", "exit_days", "max_turnover"],
  dip_buy: ["band", "window_days", "sensitivity", "max_turnover"],
  stress_rotation: ["band", "trend_days", "vol_days", "max_turnover"],
};
export const MAX_REVIEW_STEP = 0.25;

export function isStrategyId(id: string): id is StrategyId {
  return id in STRATEGY_SCHEMAS;
}

export function parseStrategyParams(id: string, params: unknown) {
  if (!isStrategyId(id)) throw new Error(`unknown strategy: ${id}`);
  const parsed = STRATEGY_SCHEMAS[id].safeParse(params ?? {});
  if (!parsed.success) {
    throw new Error(`invalid ${id} params: ${parsed.error.issues.map((i) => `${i.path.join(".") || "params"} ${i.message}`).join("; ")}`);
  }
  return parsed.data as Record<string, unknown>;
}

/** Symbols a strategy holds (risk assets plus its stablecoin). */
export function strategySymbols(id: StrategyId, params: Record<string, unknown>): string[] {
  const w = (id === "dca" ? params.buy : params.weights) as Record<string, number>;
  return [...new Set([...Object.keys(w), String(params.stable ?? "USDC")])].sort();
}

export function catalog() {
  return STRATEGY_IDS.map((id) => ({
    id,
    ...STRATEGY_INFO[id],
    history_days: undefined,
    params_schema: z.toJSONSchema(STRATEGY_SCHEMAS[id], { io: "input" }),
    review_tunable: REVIEW_TUNABLE[id],
  }));
}
