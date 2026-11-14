/**
 * The nine starter scripts every user gets. Each is one strategy in dolya's WASM engine. Users run
 * them as they are, or change one (its settings) and mint the result as their own script NFT; only
 * those changed or new scripts appear on the leaderboard.
 */

export type Knob = { key: string; label: string; min: number; max: number; step: number; hint?: string };
export type Starter = {
  id: string;
  name: string;
  img: string;
  risk: "Low" | "Medium";
  tagline: string;
  /** Default settings used for the strategies page backtest and as the starting point to change. */
  params: Record<string, unknown>;
  /** The script's own settings a user can change (besides the asset mix). */
  knobs: Knob[];
};

const MIX = { NEAR: 0.2, BTC: 0.2, ETH: 0.2 };

export const STARTERS: Starter[] = [
  { id: "rebalance", name: "Constant mix", img: "balance", risk: "Low", tagline: "Holds your mix at target. Trades only when the drift is worth the fee.",
    params: { weights: MIX, band: 0.05 },
    knobs: [{ key: "band", label: "Trade when a weight drifts by", min: 0.01, max: 0.5, step: 0.01, hint: "share of the portfolio" }] },
  { id: "trend", name: "Trend filter", img: "arrow", risk: "Medium", tagline: "Rides assets that trade above their average and steps out when they fall below.",
    params: { weights: MIX, sma_days: 50, off_fraction: 0.25 },
    knobs: [{ key: "sma_days", label: "Average, days", min: 5, max: 200, step: 1 }, { key: "off_fraction", label: "Kept below the average", min: 0, max: 1, step: 0.05, hint: "share of the asset's weight" }] },
  { id: "vol_target", name: "Volatility target", img: "blocks", risk: "Medium", tagline: "Takes more risk when markets are calm, less when they get wild.",
    params: { weights: { NEAR: 0.3, BTC: 0.3, ETH: 0.3 }, target_vol: 0.5, lookback: 30, max_scale: 1 },
    knobs: [{ key: "target_vol", label: "Target yearly volatility", min: 0.05, max: 2, step: 0.05 }, { key: "lookback", label: "Measured over, days", min: 10, max: 180, step: 1 }, { key: "max_scale", label: "Most of the mix held", min: 0, max: 1, step: 0.05 }] },
  { id: "dca", name: "Weekly buys", img: "calendar", risk: "Low", tagline: "Buys a fixed amount on a schedule. Boring on purpose.",
    params: { buy: { NEAR: 0.5, BTC: 0.5 }, amount_usd: 20, every_days: 7 },
    knobs: [{ key: "amount_usd", label: "Buy, $", min: 1, max: 1000, step: 1 }, { key: "every_days", label: "Every, days", min: 1, max: 90, step: 1 }] },
  { id: "momentum", name: "Momentum", img: "sparkle", risk: "Medium", tagline: "Holds the strongest assets of the last weeks, only while they are rising.",
    params: { weights: MIX, lookback_days: 60, top_k: 2 },
    knobs: [{ key: "lookback_days", label: "Strength measured over, days", min: 5, max: 365, step: 1 }, { key: "top_k", label: "Assets held", min: 1, max: 10, step: 1 }] },
  { id: "mean_reversion", name: "Dip in an uptrend", img: "bubble", risk: "Medium", tagline: "Buys short pullbacks of assets that are rising overall. Never fights a downtrend.",
    params: { weights: MIX, trend_days: 100, dip_days: 3, dip: 0.06 },
    knobs: [{ key: "trend_days", label: "Uptrend = above the average of, days", min: 10, max: 400, step: 1 }, { key: "dip_days", label: "Dip measured over, days", min: 1, max: 30, step: 1 }, { key: "dip", label: "Dip size", min: 0.01, max: 0.5, step: 0.01, hint: "share of the price" }] },
  { id: "breakout", name: "Breakout", img: "lock", risk: "Medium", tagline: "Joins an asset when it breaks to a new high and leaves when it breaks to a new low.",
    params: { weights: MIX, entry_days: 55, exit_days: 20 },
    knobs: [{ key: "entry_days", label: "New high of, days", min: 5, max: 300, step: 1 }, { key: "exit_days", label: "New low of, days", min: 2, max: 200, step: 1 }] },
  { id: "dip_buy", name: "Buy the dip", img: "wallet", risk: "Low", tagline: "Holds more of an asset when it trades below its average, less when above.",
    params: { weights: MIX, window_days: 30, sensitivity: 4, max_scale: 2 },
    knobs: [{ key: "window_days", label: "Average, days", min: 5, max: 200, step: 1 }, { key: "sensitivity", label: "How hard it leans", min: 0, max: 20, step: 0.5 }, { key: "max_scale", label: "At most × the weight", min: 1, max: 3, step: 0.1 }] },
  { id: "stress_rotation", name: "Stress rotation", img: "shield", risk: "Low", tagline: "Holds the mix in calm markets and moves to the stablecoin when BTC is stressed.",
    params: { weights: { BTC: 0.3, ETH: 0.2, NEAR: 0.2 }, signal: "BTC", trend_days: 50, vol_days: 30, year_days: 365 },
    knobs: [{ key: "trend_days", label: "Stressed below the average of, days", min: 10, max: 300, step: 1 }, { key: "vol_days", label: "Volatility over, days", min: 5, max: 120, step: 1 }, { key: "year_days", label: "Compared with the last, days", min: 60, max: 730, step: 1 }] },
];

export const STARTER_NAMES: Record<string, string> = Object.fromEntries(STARTERS.map((s) => [s.id, s.name]));
export const strategyName = (id: string) => STARTER_NAMES[id] ?? id;
export const starter = (id: string) => STARTERS.find((s) => s.id === id) ?? null;

/** The script NFTs the team minted for the starters and the research engine. Not shown on the leaderboard. */
export const STARTER_TOKENS = new Set([
  "wasm-rebalance@v1", "wasm-trend@v1", "wasm-vol-target@v1", "wasm-dca@v1",
  "donchian-breakout@v1", "eth-btc-relative@v1", "funding-carry@v1", "funding-reversion@v1", "gold-crypto-rotation@v1",
  "hold-rebalance@v1", "mean-reversion@v1", "momentum-top2@v1", "trend-longshort@v1", "vol-target@v1",
]);
export const isStarterToken = (id: string) => STARTER_TOKENS.has(id);

/** Starter params rebuilt around a pilot's own assets (same share of the portfolio in risk). */
export function paramsForAssets(id: string, assets: string[], share = 0.6): Record<string, unknown> {
  const s = starter(id);
  const list = assets.length ? assets : ["NEAR", "BTC", "ETH"];
  const each = Number((Math.min(0.9, share) / list.length).toFixed(4));
  const weights = Object.fromEntries(list.map((a) => [a, each]));
  const own = Object.fromEntries(Object.entries(s?.params ?? {}).filter(([k]) => k !== "weights" && k !== "buy"));
  if (id === "dca") return { ...own, buy: Object.fromEntries(list.map((a) => [a, Number((1 / list.length).toFixed(4))])) };
  if (id === "stress_rotation") return { ...own, weights, signal: list.includes("BTC") ? "BTC" : list[0] };
  return { ...own, weights };
}
