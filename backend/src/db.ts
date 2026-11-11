import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
  nft_status TEXT,                    -- unpublished | published | failed
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

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pilot_id TEXT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT
);
`;

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
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

export function logEvent(db: Db, pilotId: string | null, level: "info" | "warn" | "error", message: string, data?: unknown) {
  db.prepare("INSERT INTO events (pilot_id, ts, level, message, data_json) VALUES (?, ?, ?, ?, ?)").run(
    pilotId,
    Date.now(),
    level,
    message,
    json(data),
  );
}
