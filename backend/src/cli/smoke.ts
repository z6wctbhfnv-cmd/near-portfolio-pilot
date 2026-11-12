/**
 * Read-only smoke test against the real services: Agent API public endpoints, a partner-key call
 * when a key is set, NEAR AI model list, the local WASM. Sends nothing and moves no funds.
 */
import { createAgentApi } from "@near-intents-agent-api/sdk";
import { loadConfig, loadDotEnv } from "../config.js";
import { NearAiClient } from "../nearai.js";
import { DEFAULT_UNIVERSE } from "../tokens.js";
import { StrategyWasm } from "../wasm.js";

loadDotEnv();
const cfg = loadConfig();
const base = cfg.NEAR_INTENTS_AGENT_API_URL.replace(/\/$/, "");
const ok = (name: string, detail: string) => console.log(`ok    ${name}: ${detail}`);
const bad = (name: string, detail: string) => {
  console.log(`FAIL  ${name}: ${detail}`);
  process.exitCode = 1;
};
const skip = (name: string, why: string) => console.log(`skip  ${name}: ${why}`);

try {
  const h = await (await fetch(`${base}/health`)).json();
  ok("agent api /health", JSON.stringify(h));
} catch (e) {
  bad("agent api /health", (e as Error).message);
}
try {
  const n = (await (await fetch(`${base}/v1/network`)).json()) as { network: string; status: { overall: string } };
  ok("agent api /v1/network", `${n.network}, ${n.status.overall}`);
} catch (e) {
  bad("agent api /v1/network", (e as Error).message);
}
try {
  const t = (await (await fetch(`${base}/v1/tokens`)).json()) as { data: Array<{ asset_id: string; price: number | null; decimals: number }> };
  const missing = DEFAULT_UNIVERSE.filter((u) => !t.data.find((x) => x.asset_id === u.asset_id));
  const priced = DEFAULT_UNIVERSE.filter((u) => t.data.find((x) => x.asset_id === u.asset_id)?.price);
  if (missing.length) bad("universe in /v1/tokens", `missing ${missing.map((m) => m.symbol).join(", ")}`);
  else ok("universe in /v1/tokens", `${t.data.length} tokens, ${priced.length}/${DEFAULT_UNIVERSE.length} universe assets priced`);
} catch (e) {
  bad("agent api /v1/tokens", (e as Error).message);
}
if (cfg.NEAR_INTENTS_AGENT_API_KEY) {
  try {
    const me = await createAgentApi({ apiKey: cfg.NEAR_INTENTS_AGENT_API_KEY, baseUrl: base }).whoami();
    ok("agent api /v1/whoami", JSON.stringify(me).slice(0, 200));
  } catch (e) {
    bad("agent api /v1/whoami", (e as Error).message);
  }
} else skip("agent api /v1/whoami", "NEAR_INTENTS_AGENT_API_KEY not set");

const ai = new NearAiClient({ apiKey: cfg.NEARAI_API_KEY, baseUrl: cfg.NEARAI_BASE_URL, model: cfg.NEARAI_MODEL });
try {
  const models = await ai.listModels();
  if (models.includes(cfg.NEARAI_MODEL)) ok("near ai model", `${cfg.NEARAI_MODEL} is served (${models.length} models)`);
  else bad("near ai model", `${cfg.NEARAI_MODEL} not in the ${models.length} served models`);
} catch (e) {
  bad("near ai model list", (e as Error).message);
}
if (ai.configured) {
  try {
    ok("near ai chat", (await ai.chat([{ role: "user", content: "Reply with the word ok." }], { maxTokens: 5 })).trim());
  } catch (e) {
    bad("near ai chat", (e as Error).message);
  }
} else skip("near ai chat", "NEARAI_API_KEY not set");

const wasm = new StrategyWasm(cfg.STRATEGY_WASM_PATH);
if (wasm.available()) ok("strategy wasm", `sha256 ${wasm.wasmSha256}`);
else bad("strategy wasm", `not found at ${cfg.STRATEGY_WASM_PATH}; run npm run build:wasm`);
