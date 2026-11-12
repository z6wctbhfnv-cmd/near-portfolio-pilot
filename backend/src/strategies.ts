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
