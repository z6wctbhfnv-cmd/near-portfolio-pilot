/** Daily close history for backtests and for strategies that need a lookback (trend, vol_target). */
import type { Db } from "./db.js";
import { DEFAULT_UNIVERSE } from "./tokens.js";

export const DAY_MS = 86_400_000;
export const dayStart = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;

type Kline = [number, string, string, string, string, ...unknown[]];

export class PriceHistory {
  constructor(
    private readonly db: Db,
    private readonly baseUrl: string,
    private readonly f: typeof fetch = fetch,
  ) {}

  /** Downloads daily klines from Binance's public market-data API into the cache. */
  async sync(symbol: string, fromMs: number, toMs = Date.now()): Promise<number> {
    const u = DEFAULT_UNIVERSE.find((a) => a.symbol === symbol);
    if (!u) throw new Error(`unknown symbol ${symbol}`);
    if (!u.history_symbol) return 0; // stablecoin: priced at 1
    let start = dayStart(fromMs);
    const end = dayStart(toMs);
    let inserted = 0;
    const sql = "INSERT OR REPLACE INTO price_history (symbol, day, close) VALUES (?, ?, ?)";
    while (start <= end) {
      const url = `${this.baseUrl.replace(/\/$/, "")}/api/v3/klines?symbol=${u.history_symbol}&interval=1d&startTime=${start}&limit=1000`;
      const res = await this.f(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`history ${u.history_symbol} ${res.status}`);
      const rows = (await res.json()) as Kline[];
      if (!rows.length) break;
      const batch = [];
      for (const r of rows) {
        const day = dayStart(r[0]);
        // Only closed days: today's candle is still moving.
        if (day >= dayStart(Date.now())) continue;
        batch.push({ sql, args: [symbol, day, Number(r[4])] });
        inserted++;
      }
      await this.db.batch(batch);
      const last = dayStart(rows[rows.length - 1]![0]);
      if (last <= start) break;
      start = last + DAY_MS;
      if (rows.length < 1000) break;
    }
    return inserted;
  }

  /** Makes sure the cache covers [fromMs, today) for each symbol; downloads what is missing. */
  async ensure(symbols: string[], fromMs: number): Promise<void> {
    const yesterday = dayStart(Date.now()) - DAY_MS;
    for (const s of symbols) {
      const u = DEFAULT_UNIVERSE.find((a) => a.symbol === s);
      if (!u?.history_symbol) continue;
      const row = (await this.db.prepare("SELECT MIN(day) AS lo, MAX(day) AS hi FROM price_history WHERE symbol = ?").get<{ lo: number | null; hi: number | null }>(s))!;
      if (row.lo === null || row.lo > dayStart(fromMs)) await this.sync(s, fromMs);
      else if (row.hi === null || row.hi < yesterday) await this.sync(s, row.hi ?? fromMs);
    }
  }

  /** Closes for [fromMs, toMs] inclusive, oldest first. Stablecoins are 1. */
  async closes(symbol: string, fromMs: number, toMs: number): Promise<Array<{ day: number; close: number }>> {
    const u = DEFAULT_UNIVERSE.find((a) => a.symbol === symbol);
    if (u?.stable) {
      const out = [];
      for (let d = dayStart(fromMs); d <= dayStart(toMs); d += DAY_MS) out.push({ day: d, close: 1 });
      return out;
    }
    return this.db
      .prepare("SELECT day, close FROM price_history WHERE symbol = ? AND day >= ? AND day <= ? ORDER BY day")
      .all<{ day: number; close: number }>(symbol, dayStart(fromMs), dayStart(toMs));
  }

  /** Last `n` closes up to and including `toMs`, oldest first (for live runs). */
  async lastCloses(symbol: string, n: number, toMs = Date.now()): Promise<number[]> {
    if (n <= 0) return [];
    const rows = await this.db
      .prepare("SELECT close FROM price_history WHERE symbol = ? AND day <= ? ORDER BY day DESC LIMIT ?")
      .all<{ close: number }>(symbol, dayStart(toMs), n);
    return rows.map((r) => r.close).reverse();
  }

  /** Inserts closes directly (tests and offline fixtures). */
  async load(symbol: string, rows: Array<{ day: number; close: number }>) {
    const sql = "INSERT OR REPLACE INTO price_history (symbol, day, close) VALUES (?, ?, ?)";
    await this.db.batch(rows.map((r) => ({ sql, args: [symbol, dayStart(r.day), r.close] })));
  }
}
