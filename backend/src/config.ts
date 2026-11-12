import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = resolve(here, "..");
export const REPO_ROOT = resolve(BACKEND_ROOT, "..");

/** Load KEY=VALUE lines from the repo's .env (then backend/.env) without overriding real env. */
export function loadDotEnv(paths = [resolve(REPO_ROOT, ".env"), resolve(BACKEND_ROOT, ".env")]) {
  for (const p of paths) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1]!;
      let value = m[2]!;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

const bool = z
  .string()
  .optional()
  .transform((v) => v === "1" || v?.toLowerCase() === "true" || v?.toLowerCase() === "yes");
const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const schema = z.object({
  PORT: z.coerce.number().int().default(8787),
  HOST: z.string().default("127.0.0.1"),
  PILOT_API_TOKEN: optional,
  /** Comma-separated browser origins allowed to call the API, e.g. https://pilot.example.com. */
  CORS_ORIGINS: optional,
  /** Comma-separated owners (NEAR account, EVM address, passkey credential id) allowed to create live pilots. */
  LIVE_OWNERS: optional,
  PILOT_MASTER_KEY: optional,
  DATABASE_PATH: z.string().default(resolve(REPO_ROOT, "data/pilot.sqlite")),
  /** Turso / libSQL URL (libsql://...). When set it wins over DATABASE_PATH: needed on Vercel. */
  DATABASE_URL: optional,
  DATABASE_AUTH_TOKEN: optional,
  /** Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" to /api/cron. */
  CRON_SECRET: optional,

  NEAR_INTENTS_AGENT_API_URL: z.string().default("https://api.demo.agentsonintents.com"),
  NEAR_INTENTS_AGENT_API_KEY: optional,
  /**
   * 1Click partner key (JWT from partners.near-intents.org). The Agent API does not take it: its swap
   * body has no app-fee or partner field, so Pilot cannot add a spot fee there (see docs/REVENUE.md).
   */
  NEAR_INTENTS_PARTNER_KEY: optional,
  /** Master switch for real swaps. Off by default: everything runs as paper trading. */
  LIVE_EXECUTION: bool,
  MAX_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(300).default(100),
  PAPER_COST_BPS: z.coerce.number().min(0).max(500).default(30),

  NEARAI_API_KEY: optional,
  NEARAI_BASE_URL: z.string().default("https://cloud-api.near.ai/v1"),
  NEARAI_MODEL: z.string().default("deepseek/deepseek-v3.2"),

  STRATEGY_ENGINE: z.enum(["local", "outlayer", "auto"]).default("auto"),
  // The committed build in backend/wasm (same bytes as `npm run build:wasm`, see its sha256), else the local build.
  STRATEGY_WASM_PATH: z
    .string()
    .default(
      existsSync(resolve(BACKEND_ROOT, "wasm/pilot-strategies.wasm"))
        ? resolve(BACKEND_ROOT, "wasm/pilot-strategies.wasm")
        : resolve(REPO_ROOT, "strategies/target/wasm32-wasip1/release/pilot-strategies.wasm"),
    ),
  OUTLAYER_API_URL: z.string().default("https://api.outlayer.ai"),
  OUTLAYER_PAYMENT_KEY: optional,
  /** `owner/project` of the deployed strategy module, e.g. `pilot.near/portfolio-strategies`. */
  OUTLAYER_PROJECT: optional,

  NEAR_ACCOUNT_ID: optional,
  NEAR_PRIVATE_KEY: optional,
  NEAR_RPC_URL: z.string().default("https://rpc.mainnet.fastnear.com"),
  STRATEGY_NFT_CONTRACT: optional,

  /**
   * Weekly copy fees (5% of new profit to the NFT holder by default, 0.25% to Pilot). The ledger is
   * always computed; paper pilots pay from paper USDC. Live pilots send the payment only when this is
   * on, LIVE_EXECUTION is on, and the owner signed a policy with the fee destination.
   */
  FEE_PAYMENTS_ENABLED: bool,
  /** The fee token as an Agent API asset id; its NEP-141 contract must be a fee token of the NFT contract. */
  FEE_ASSET_ID: z.string().default("nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"),
  /** Below this a week's fee is not sent; the profit carries over to the next week (the peak stays). */
  MIN_FEE_USD: z.coerce.number().min(0).default(1),
  /**
   * Who may run a copied script whose holder's bond is below max($100, 1% of copiers' capital):
   * "live" blocks live pilots and warns paper ones (default), "all" blocks both, "off" only warns.
   */
  BOND_GATE: z.enum(["live", "all", "off"]).default("live"),
  /** Report copiers' capital to the NFT contract weekly (set_copied_capital). An on-chain write: off by default. */
  NFT_REPORT_COPIED_CAPITAL: bool,

  /** Perps on Hyperliquid TESTNET only (there is no mainnet switch). Off by default. */
  HL_PERPS_ENABLED: bool,
  /** API wallet key for the Hyperliquid testnet account: it can trade but cannot withdraw. */
  HL_TESTNET_PRIVATE_KEY: optional,
  /** The account the API wallet trades for (its address), when the key is an API wallet. */
  HL_ACCOUNT_ADDRESS: optional,
  /** Pilot's builder address; orders then carry a 0.05% builder fee (the account must approve it once). */
  HL_BUILDER_ADDRESS: optional,
  HL_MAX_LEVERAGE: z.coerce.number().min(0).max(3).default(1),
  HL_MAX_ORDER_USD: z.coerce.number().min(1).default(200),
  HL_SLIPPAGE: z.coerce.number().min(0.001).max(0.05).default(0.01),

  HISTORY_API_URL: z.string().default("https://data-api.binance.vision"),
  SCHEDULER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === undefined || v === "1" || v.toLowerCase() === "true"),
  TICK_MINUTES: z.coerce.number().min(1).default(60),
  REVIEW_EVERY_DAYS: z.coerce.number().min(1).default(7),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // The Turso integration on Vercel provides TURSO_DATABASE_URL / TURSO_AUTH_TOKEN.
  env = { ...env, DATABASE_URL: env.DATABASE_URL || env.TURSO_DATABASE_URL, DATABASE_AUTH_TOKEN: env.DATABASE_AUTH_TOKEN || env.TURSO_AUTH_TOKEN };
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Bad configuration: ${issues}`);
  }
  return parsed.data;
}

/** What is configured, without any secret values. */
export function describeConfig(c: Config) {
  return {
    agent_api_url: c.NEAR_INTENTS_AGENT_API_URL,
    agent_api_key: Boolean(c.NEAR_INTENTS_AGENT_API_KEY),
    live_execution: c.LIVE_EXECUTION,
    near_ai: { configured: Boolean(c.NEARAI_API_KEY), model: c.NEARAI_MODEL },
    strategy_engine: c.STRATEGY_ENGINE,
    outlayer: { configured: Boolean(c.OUTLAYER_PAYMENT_KEY && c.OUTLAYER_PROJECT), project: c.OUTLAYER_PROJECT ?? null },
    nft: { contract: c.STRATEGY_NFT_CONTRACT ?? null, publisher: c.NEAR_ACCOUNT_ID ?? null, can_publish: Boolean(c.STRATEGY_NFT_CONTRACT && c.NEAR_ACCOUNT_ID && c.NEAR_PRIVATE_KEY), report_copied_capital: c.NFT_REPORT_COPIED_CAPITAL },
    fees: { payments_enabled: c.FEE_PAYMENTS_ENABLED, asset_id: c.FEE_ASSET_ID, min_fee_usd: c.MIN_FEE_USD, bond_gate: c.BOND_GATE },
    perps: { enabled: c.HL_PERPS_ENABLED, network: "hyperliquid-testnet", key: Boolean(c.HL_TESTNET_PRIVATE_KEY), builder: c.HL_BUILDER_ADDRESS ?? null },
    scheduler: { enabled: c.SCHEDULER_ENABLED, tick_minutes: c.TICK_MINUTES, review_every_days: c.REVIEW_EVERY_DAYS },
    api_token_required: Boolean(c.PILOT_API_TOKEN),
    live_owners_restricted: Boolean(c.LIVE_OWNERS),
  };
}
