/**
 * Storage on libSQL: a local SQLite file (or :memory: in tests) for development, and Turso when
 * DATABASE_URL is a libsql:// URL (serverless deploys such as Vercel, where the disk does not last).
 * Every query is async; the prepare(sql).get/all/run shape mirrors the old node:sqlite API.
 */
import { type Client, createClient, type InValue } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pilots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  agent_id TEXT,
  status TEXT NOT NULL,              -- draft | pending_owner | active | frozen | archived
  mode TEXT NOT NULL,                -- paper | live
  owner_json TEXT,
  mandate_json TEXT,
  policy_json TEXT,
  strategy_id TEXT NOT NULL,
  strategy_params_json TEXT NOT NULL,
  strategy_state_json TEXT NOT NULL DEFAULT '{}',
  paper_holdings_json TEXT,          -- symbol -> units, paper mode only
  review_auto_apply INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER,
  next_review_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pilots_agent ON pilots(agent_id) WHERE agent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS owner_intents (
  correlation_id TEXT PRIMARY KEY,
  pilot_id TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  agent_id TEXT,
  generated_json TEXT NOT NULL,
  submitted_at INTEGER,
  last_status_json TEXT,
  meta_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  pilot_id TEXT NOT NULL,
  label TEXT NOT NULL,
  token_enc TEXT NOT NULL,
  commitment TEXT NOT NULL,
  correlation_id TEXT,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,               -- pending | active | revoked
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  pilot_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  engine TEXT NOT NULL,               -- local | outlayer
  wasm_sha256 TEXT,
  input_sha256 TEXT,
  output_sha256 TEXT,
  input_json TEXT,
  output_json TEXT,
  attestation_json TEXT,
  status TEXT NOT NULL,               -- ok | error | skipped
  error TEXT,
  total_usd REAL,
  nft_status TEXT,                    -- unpublished | queued | published (in a weekly checkpoint)
  nft_tx TEXT
);
CREATE INDEX IF NOT EXISTS runs_pilot ON runs(pilot_id, started_at);

CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  pilot_id TEXT NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL,                 -- paper | live
  idempotency_key TEXT NOT NULL UNIQUE,
  sell_symbol TEXT NOT NULL,
  buy_symbol TEXT NOT NULL,
  usd REAL NOT NULL,
  request_json TEXT NOT NULL,
  quote_json TEXT,
  status TEXT NOT NULL,               -- prepared | blocked | paper_filled | sent | <Agent API status>
  correlation_id TEXT,
  response_json TEXT,
  error_code TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS executions_pilot ON executions(pilot_id, created_at);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pilot_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  total_usd REAL NOT NULL,
  holdings_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_pilot ON snapshots(pilot_id, ts);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  pilot_id TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  metrics_json TEXT NOT NULL,
  source TEXT NOT NULL,               -- ai | rules
  model TEXT,
  summary TEXT NOT NULL,
  risk_flags_json TEXT NOT NULL,
  proposals_json TEXT NOT NULL,
  status TEXT NOT NULL,               -- proposed | applied | dismissed | no_change
  created_at INTEGER NOT NULL,
  applied_at INTEGER
);

CREATE TABLE IF NOT EXISTS price_history (
  symbol TEXT NOT NULL,
  day INTEGER NOT NULL,               -- unix ms at 00:00 UTC
  close REAL NOT NULL,
  PRIMARY KEY (symbol, day)
);

-- Strategy NFT checkpoints already appended (or found on chain), one per script and period.
CREATE TABLE IF NOT EXISTS nft_checkpoints (
  code_hash TEXT NOT NULL,
  period_end_ms INTEGER NOT NULL,
  token_id TEXT NOT NULL,
  tx TEXT,
  PRIMARY KEY (code_hash, period_end_ms)
);

-- Weekly copy-fee ledger: one row per pilot, script NFT and week. Payments follow the swap rules:
-- the key is stored before the request, retries replay it, and nothing is charged twice.
CREATE TABLE IF NOT EXISTS fee_ledger (
  id TEXT PRIMARY KEY,
  pilot_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  period_end_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- paper | live
  payer TEXT,                         -- owner's NEAR account (referrals, own script), else the agent
  holder TEXT,
  payer_is_holder INTEGER NOT NULL DEFAULT 0,
  equity_usd REAL NOT NULL,
  hwm_usd REAL NOT NULL,              -- the peak before this week, deposits added
  deposits_usd REAL NOT NULL DEFAULT 0,
  profit_usd REAL NOT NULL,
  holder_bps INTEGER NOT NULL,
  payment_bps INTEGER NOT NULL,
  fee_usd REAL NOT NULL,
  amount_atomic TEXT,
  hwm_after_usd REAL,                 -- the new peak once the week is final
  idempotency_key TEXT NOT NULL UNIQUE,
  reference TEXT NOT NULL,
  request_json TEXT,
  quote_json TEXT,
  status TEXT NOT NULL,               -- no_profit | carried | blocked | paper_paid | prepared | refused | sent | <Agent API status>
  correlation_id TEXT,
  response_json TEXT,
  error_code TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  record_status TEXT,                 -- live only: pending | recorded (the NFT contract credited the split)
  credited_atomic TEXT,
  record_tx TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (pilot_id, token_id, period_end_ms)
);
CREATE INDEX IF NOT EXISTS fee_ledger_pilot ON fee_ledger(pilot_id, period_end_ms);

-- The fee peak (high-water mark) per pilot and script, measured after fees as paid.
CREATE TABLE IF NOT EXISTS fee_hwm (
  pilot_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  hwm_usd REAL NOT NULL,
  since_ms INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (pilot_id, token_id)
);

-- Daily script health check: findings, and the owner's answer to "Pause / Keep running".
CREATE TABLE IF NOT EXISTS health_checks (
  id TEXT PRIMARY KEY,
  pilot_id TEXT NOT NULL,
  day INTEGER NOT NULL,               -- unix ms at 00:00 UTC
  status TEXT NOT NULL,               -- ok | warn | stop
  findings_json TEXT NOT NULL,
  question_json TEXT,                 -- null when there is nothing to ask
  answer TEXT,                        -- pause | keep
  answered_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (pilot_id, day)
);

-- Hyperliquid testnet orders. The client order id (cloid) is stored before sending, so a lost answer
-- is looked up by cloid instead of sending a second order.
CREATE TABLE IF NOT EXISTS perp_orders (
  id TEXT PRIMARY KEY,
  pilot_id TEXT NOT NULL,
  run_id TEXT,
  cloid TEXT NOT NULL UNIQUE,
  coin TEXT NOT NULL,
  usd REAL NOT NULL,                  -- signed: > 0 buys, < 0 sells
  request_json TEXT NOT NULL,
  status TEXT NOT NULL,               -- blocked | prepared | sent | filled | resting | error | unknown
  response_json TEXT,
  error_code TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scripts (
  code_hash TEXT PRIMARY KEY,
  base TEXT NOT NULL,
  params_json TEXT NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  pilot_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  op TEXT NOT NULL,                   -- "<" | ">"
  price REAL NOT NULL,
  side TEXT NOT NULL,                 -- buy | sell
  usd REAL NOT NULL,
  status TEXT NOT NULL,               -- active | done | failed | cancelled
  text TEXT,
  fired_at INTEGER,
  fired_price REAL,
  result_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_pilot ON tasks(pilot_id, status);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pilot_id TEXT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT
);
`;

type Row = Record<string, unknown>;
const toArgs = (args: unknown[]) => args.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v)) as InValue[];

export class Db {
  private readonly ready: Promise<void>;

  constructor(private readonly client: Client, local: boolean) {
    this.ready = (async () => {
      if (local) await client.execute("PRAGMA foreign_keys = ON");
      await client.executeMultiple(SCHEMA);
      // Columns added after the first release: add them to databases created before.
      for (const sql of [
        "ALTER TABLE pilots ADD COLUMN risk_since INTEGER",
        // A swarm pilot follows several scripts at once (see swarm.ts); null = one strategy.
        "ALTER TABLE pilots ADD COLUMN swarm_json TEXT",
        "ALTER TABLE pilots ADD COLUMN swarm_state_json TEXT",
        // Copying a script NFT (social.ts): {token_id, strategy_id, since}; null = the pilot's own strategy.
        "ALTER TABLE pilots ADD COLUMN following_json TEXT",
        // Who referred this owner (NEAR account), recorded on chain by the agent once live.
        "ALTER TABLE pilots ADD COLUMN referrer TEXT",
        // sha256 of the pilot key handed to its creator once; every pilot route needs the key.
        "ALTER TABLE pilots ADD COLUMN key_hash TEXT",
      ]) {
        try {
          await client.execute(sql);
        } catch {
          /* already there */
        }
      }
    })();
  }

  private async exec(sql: string, args: unknown[]) {
    await this.ready;
    return this.client.execute({ sql, args: toArgs(args) });
  }

  prepare(sql: string) {
    return {
      get: async <T = Row>(...args: unknown[]): Promise<T | undefined> => {
        const r = await this.exec(sql, args);
        return r.rows[0] ? (Object.fromEntries(r.columns.map((c, i) => [c, r.rows[0]![i]])) as T) : undefined;
      },
      all: async <T = Row>(...args: unknown[]): Promise<T[]> => {
        const r = await this.exec(sql, args);
        return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])) as T);
      },
      run: async (...args: unknown[]) => {
        const r = await this.exec(sql, args);
        return { changes: r.rowsAffected };
      },
    };
  }

  /** Several writes in one round trip (e.g. a block of price history). */
  async batch(stmts: Array<{ sql: string; args: unknown[] }>) {
    await this.ready;
    if (stmts.length) await this.client.batch(stmts.map((s) => ({ sql: s.sql, args: toArgs(s.args) })), "write");
  }

  close() {
    this.client.close();
  }
}

/** ":memory:", a file path, or a libsql:// / https:// Turso URL (with authToken). */
export function openDb(path: string, authToken?: string): Db {
  const remote = /^(libsql|https?|wss?):\/\//.test(path);
  if (!remote && path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const url = remote ? path : path === ":memory:" ? ":memory:" : `file:${path}`;
  return new Db(createClient({ url, ...(authToken ? { authToken } : {}), intMode: "number" }), !remote);
}

export const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
export function parse<T = unknown>(s: unknown, fallback: T): T {
  if (typeof s !== "string" || s === "") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export async function logEvent(db: Db, pilotId: string | null, level: "info" | "warn" | "error", message: string, data?: unknown) {
  await db.prepare("INSERT INTO events (pilot_id, ts, level, message, data_json) VALUES (?, ?, ?, ?, ?)").run(
    pilotId,
    Date.now(),
    level,
    message,
    json(data),
  );
}
