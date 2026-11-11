/** Downloads daily closes for the universe into the local cache. Usage: npm run fetch-history -- [days=1100] */
import { loadConfig, loadDotEnv } from "../config.js";
import { openDb } from "../db.js";
import { PriceHistory } from "../history.js";
import { DEFAULT_UNIVERSE } from "../tokens.js";

loadDotEnv();
const cfg = loadConfig();
const days = Number(process.argv[2] ?? 1100);
const db = openDb(cfg.DATABASE_PATH);
const h = new PriceHistory(db, cfg.HISTORY_API_URL);
for (const a of DEFAULT_UNIVERSE.filter((u) => u.history_symbol)) {
  const n = await h.sync(a.symbol, Date.now() - days * 86_400_000);
  console.log(`${a.symbol.padEnd(5)} ${n} daily closes`);
}
db.close();
