/** Asset universe, token catalogue cache and exact atomic-amount conversions. */

export type UniverseAsset = {
  symbol: string;
  asset_id: string;
  /** Binance spot symbol for daily history, or null for a USD stablecoin (price 1). */
  history_symbol: string | null;
  stable: boolean;
};

/**
 * Assets the pilot manages by default. `asset_id`s are the exact NEAR Intents ids from
 * GET /v1/tokens; decimals and live prices always come from that catalogue at runtime.
 */
export const DEFAULT_UNIVERSE: UniverseAsset[] = [
  { symbol: "USDC", asset_id: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", history_symbol: null, stable: true },
  { symbol: "USDT", asset_id: "nep141:usdt.tether-token.near", history_symbol: null, stable: true },
  { symbol: "NEAR", asset_id: "nep141:wrap.near", history_symbol: "NEARUSDT", stable: false },
  { symbol: "BTC", asset_id: "nep141:btc.omft.near", history_symbol: "BTCUSDT", stable: false },
  { symbol: "ETH", asset_id: "nep141:eth.omft.near", history_symbol: "ETHUSDT", stable: false },
  { symbol: "SOL", asset_id: "nep141:sol.omft.near", history_symbol: "SOLUSDT", stable: false },
  { symbol: "ZEC", asset_id: "nep141:zec.omft.near", history_symbol: "ZECUSDT", stable: false },
];

export function universeBySymbol(symbol: string, universe = DEFAULT_UNIVERSE) {
  return universe.find((a) => a.symbol === symbol.toUpperCase());
}
export function universeByAssetId(assetId: string, universe = DEFAULT_UNIVERSE) {
  return universe.find((a) => a.asset_id === assetId);
}

export type TokenInfo = {
  asset_id: string;
  symbol: string;
  decimals: number;
  blockchain: string;
  price: number | null;
  price_updated_at?: string | null;
  price_expires_at?: string | null;
};

/** Parses a decimal string or number into an exact atomic bigint, rounding down. */
export function toAtomic(amount: string | number, decimals: number): bigint {
  let s = typeof amount === "number" ? amount.toFixed(Math.min(decimals + 2, 20)) : amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`not a non-negative decimal: ${amount}`);
  const [whole, frac = ""] = s.split(".") as [string, string?];
  const f = (frac ?? "").slice(0, decimals).padEnd(decimals, "0");
  s = `${whole}${f}`.replace(/^0+(?=\d)/, "");
  return BigInt(s === "" ? "0" : s);
}

/** Formats atomic units as an exact decimal string without trailing zeros. */
export function fromAtomic(raw: bigint | string, decimals: number): string {
  const v = typeof raw === "string" ? BigInt(raw) : raw;
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const s = abs.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Atomic amount of a token worth `usd` at `price`, rounded down. */
export function usdToAtomic(usd: number, price: number, decimals: number): bigint {
  if (!(usd > 0) || !(price > 0)) return 0n;
  const units = usd / price;
  // Two guard digits past the last atomic unit, then truncate: never rounds up into more than `usd`.
  return toAtomic(units.toFixed(Math.min(decimals + 2, 20)), decimals);
}

export function atomicToNumber(raw: bigint | string, decimals: number): number {
  return Number(fromAtomic(raw, decimals));
}

/** In-memory cache of GET /v1/tokens (public endpoint). */
export class TokenCatalog {
  private cache: { at: number; tokens: TokenInfo[] } | null = null;

  constructor(
    private readonly fetchTokens: () => Promise<TokenInfo[]>,
    private readonly ttlMs = 60_000,
  ) {}

  async all(force = false): Promise<TokenInfo[]> {
    if (!force && this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.tokens;
    const tokens = await this.fetchTokens();
    this.cache = { at: Date.now(), tokens };
    return tokens;
  }

  async get(assetId: string): Promise<TokenInfo | undefined> {
    return (await this.all()).find((t) => t.asset_id === assetId);
  }

  /** Token info for each universe symbol, with a usable (unexpired) price or null. */
  async universe(universe = DEFAULT_UNIVERSE): Promise<Array<UniverseAsset & { token: TokenInfo | null; price: number | null }>> {
    const tokens = await this.all();
    const now = Date.now();
    return universe.map((a) => {
      const token = tokens.find((t) => t.asset_id === a.asset_id) ?? null;
      const fresh = token?.price_expires_at ? Date.parse(token.price_expires_at) > now : true;
      const price = token && token.price !== null && token.price > 0 && fresh ? token.price : null;
      return { ...a, token, price };
    });
  }
}
