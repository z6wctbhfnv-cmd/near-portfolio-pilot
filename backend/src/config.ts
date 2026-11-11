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
  PILOT_MASTER_KEY: optional,
  DATABASE_PATH: z.string().default(resolve(REPO_ROOT, "data/pilot.sqlite")),

  NEAR_INTENTS_AGENT_API_URL: z.string().default("https://api.demo.agentsonintents.com"),
  NEAR_INTENTS_AGENT_API_KEY: optional,
  NEAR_INTENTS_PARTNER_KEY: optional,
  /** Master switch for real swaps. Off by default: everything runs as paper trading. */
  LIVE_EXECUTION: bool,
  MAX_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(300).default(100),
  PAPER_COST_BPS: z.coerce.number().min(0).max(500).default(30),

  NEARAI_API_KEY: optional,
  NEARAI_BASE_URL: z.string().default("https://cloud-api.near.ai/v1"),
  NEARAI_MODEL: z.string().default("deepseek/deepseek-v3.2"),

  STRATEGY_ENGINE: z.enum(["local", "outlayer", "auto"]).default("auto"),
  STRATEGY_WASM_PATH: z
    .string()
    .default(resolve(REPO_ROOT, "strategies/target/wasm32-wasip1/release/pilot-strategies.wasm")),
  OUTLAYER_API_URL: z.string().default("https://api.outlayer.ai"),
  OUTLAYER_PAYMENT_KEY: optional,
  /** `owner/project` of the deployed strategy module, e.g. `pilot.near/portfolio-strategies`. */
  OUTLAYER_PROJECT: optional,

  NEAR_ACCOUNT_ID: optional,
  NEAR_PRIVATE_KEY: optional,
  NEAR_RPC_URL: z.string().default("https://rpc.mainnet.fastnear.com"),
  STRATEGY_NFT_CONTRACT: optional,

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
    nft: { contract: c.STRATEGY_NFT_CONTRACT ?? null, publisher: c.NEAR_ACCOUNT_ID ?? null, can_publish: Boolean(c.STRATEGY_NFT_CONTRACT && c.NEAR_ACCOUNT_ID && c.NEAR_PRIVATE_KEY) },
    scheduler: { enabled: c.SCHEDULER_ENABLED, tick_minutes: c.TICK_MINUTES, review_every_days: c.REVIEW_EVERY_DAYS },
    api_token_required: Boolean(c.PILOT_API_TOKEN),
  };
}
