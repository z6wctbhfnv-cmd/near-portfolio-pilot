/**
 * NEAR Intents Agent API gateway: public reads, owner intents (generate → owner signs → submit →
 * status) with every step persisted, grants, and the pre-execution readiness check.
 */
import {
  type AgentApi,
  AgentApiError,
  createAgentApi,
  createGrantCredential,
  type GenerateIntentRequest,
  type NetworkView,
  type PolicyView,
  type SignedData,
} from "@near-intents-agent-api/sdk";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { type Db, json, logEvent, parse } from "./db.js";
import type { SecretBox } from "./secrets.js";
import { DEFAULT_UNIVERSE, type TokenInfo } from "./tokens.js";

/** The production Agent API. Its token list is public, like the demo host's. */
const PROD_AGENT_API = "https://api.agentsonintents.com";
/** Decimals of the universe assets on NEAR Intents, for the last-resort price source. */
const FALLBACK_DECIMALS: Record<string, number> = { USDC: 6, USDT: 6, NEAR: 24, BTC: 8, ETH: 18, SOL: 9, ZEC: 8 };

export class ConfigError extends Error {
  readonly code = "not_configured";
}

const TERMINAL = new Set(["SUCCESS", "FAILED", "REFUNDED"]);

export class AgentGateway {
  private client: AgentApi | null = null;

  constructor(
    private readonly cfg: Pick<Config, "NEAR_INTENTS_AGENT_API_URL" | "NEAR_INTENTS_AGENT_API_KEY"> & Partial<Pick<Config, "HISTORY_API_URL">>,
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly f: typeof fetch = fetch,
  ) {}

  get hasKey() {
    return Boolean(this.cfg.NEAR_INTENTS_AGENT_API_KEY);
  }

  /** SDK client under the partner API key. Throws when no key is configured. */
  api(): AgentApi {
    if (!this.cfg.NEAR_INTENTS_AGENT_API_KEY) throw new ConfigError("NEAR_INTENTS_AGENT_API_KEY is not set");
    this.client ??= createAgentApi({ apiKey: this.cfg.NEAR_INTENTS_AGENT_API_KEY, baseUrl: this.cfg.NEAR_INTENTS_AGENT_API_URL, fetch: this.f });
    return this.client;
  }

  private async publicGet<T>(path: string): Promise<T> {
    const res = await this.f(`${this.cfg.NEAR_INTENTS_AGENT_API_URL.replace(/\/$/, "")}${path}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Agent API ${path} ${res.status}`);
    return (await res.json()) as T;
  }

  /** Where the last token list came from: an Agent API host, or the spot-price fallback. */
  priceSource: string | null = null;

  /**
   * The token list with USD prices. GET /v1/tokens is public (no key). If the configured host is
   * down (the hackathon's demo host is temporary), the production host is asked; if both are down,
   * spot prices for the universe come from the public market-data API, so paper portfolios, the
   * site and backtests keep working. Live swaps never run on fallback prices: their readiness check
   * needs the Agent API itself.
   */
  async tokens(): Promise<TokenInfo[]> {
    const errors: string[] = [];
    const hosts = [...new Set([this.cfg.NEAR_INTENTS_AGENT_API_URL.replace(/\/$/, ""), PROD_AGENT_API])];
    for (const host of hosts) {
      try {
        const res = await this.f(`${host}/v1/tokens`, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { data?: TokenInfo[] };
        if (!Array.isArray(body.data) || !body.data.length) throw new Error("empty token list");
        this.priceSource = host;
        return body.data;
      } catch (e) {
        errors.push(`${host}: ${(e as Error).message}`);
      }
    }
    try {
      const tokens = await this.spotTokens();
      this.priceSource = "spot prices (fallback)";
      return tokens;
    } catch (e) {
      errors.push(`spot fallback: ${(e as Error).message}`);
    }
    throw new Error(`no price source answered: ${errors.join("; ")}`);
  }

  /** Universe assets priced from public spot tickers; stablecoins count as $1. */
  private async spotTokens(): Promise<TokenInfo[]> {
    const base = (this.cfg.HISTORY_API_URL ?? "https://data-api.binance.vision").replace(/\/$/, "");
    const pairs = DEFAULT_UNIVERSE.filter((a) => a.history_symbol).map((a) => a.history_symbol!);
    const res = await this.f(`${base}/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(pairs))}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()) as Array<{ symbol: string; price: string }>;
    const px = new Map(rows.map((r) => [r.symbol, Number(r.price)]));
    const now = Date.now();
    const out: TokenInfo[] = [];
    for (const a of DEFAULT_UNIVERSE) {
      const price = a.stable ? 1 : px.get(a.history_symbol!);
      if (!price || !(price > 0)) continue;
      out.push({
        asset_id: a.asset_id,
        symbol: a.symbol,
        decimals: FALLBACK_DECIMALS[a.symbol] ?? 18,
        blockchain: "near",
        price,
        price_updated_at: new Date(now).toISOString(),
        price_expires_at: new Date(now + 600_000).toISOString(),
      });
    }
    if (out.length < 3) throw new Error("spot prices incomplete");
    return out;
  }

  /** GET /v1/network: public dependency status. */
  network(): Promise<NetworkView> {
    return this.publicGet<NetworkView>("/v1/network");
  }

  // ---------------------------------------------------------------- owner intents

  /** Step 1: prepare an owner intent; the owner's wallet signs `intent.payload` unchanged. */
  async generate(request: GenerateIntentRequest, pilotId: string | null, meta?: unknown) {
    const idempotencyKey = `gen-${randomUUID()}`;
    const generated = await this.api().generateIntent(request as never, { idempotencyKey });
    const now = Date.now();
    const g = generated as unknown as { correlation_id: string; type: string; agent_id?: string };
    await this.db
      .prepare(
        `INSERT INTO owner_intents (correlation_id, pilot_id, type, status, agent_id, generated_json, meta_json, created_at, updated_at)
         VALUES (?, ?, ?, 'PENDING_SIGNATURE', ?, ?, ?, ?, ?)`,
      )
      .run(g.correlation_id, pilotId, g.type, g.agent_id ?? (request as { agent_id?: string }).agent_id ?? null, json(generated), json(meta), now, now);
    await logEvent(this.db, pilotId, "info", `owner intent ${g.type} generated`, { correlation_id: g.correlation_id });
    return generated;
  }

  /** Step 3: submit the wallet's signature. Resubmitting the same signature is safe. */
  async submit(correlationId: string, signedData: SignedData) {
    const row = await this.intentRow(correlationId);
    if (!row) throw new NotFound(`unknown correlation_id ${correlationId}`);
    const status = await this.api().submitIntent({ type: row.type, correlation_id: correlationId, signed_data: signedData } as never);
    await this.db
      .prepare("UPDATE owner_intents SET submitted_at = ?, status = ?, last_status_json = ?, updated_at = ? WHERE correlation_id = ?")
      .run(Date.now(), (status as { status: string }).status, json(status), Date.now(), correlationId);
    return status;
  }

  /** Step 4: read (optionally long-poll) an intent's status and record it. */
  async status(correlationId: string, waitMs = 0) {
    const status = (await this.api().getStatus(correlationId, waitMs > 0 ? { waitMs: Math.min(waitMs, 30_000) } : {})) as {
      status: string;
      type?: string;
    };
    await this.db
      .prepare("UPDATE owner_intents SET status = ?, last_status_json = ?, updated_at = ? WHERE correlation_id = ?")
      .run(status.status, json(status), Date.now(), correlationId);
    return status;
  }

  intentRow(correlationId: string) {
    return this.db
      .prepare("SELECT * FROM owner_intents WHERE correlation_id = ?")
      .get<{ correlation_id: string; pilot_id: string | null; type: string; status: string; agent_id: string | null; generated_json: string; meta_json: string | null }>(correlationId);
  }

  isTerminal(status: string) {
    return TERMINAL.has(status);
  }

  // ---------------------------------------------------------------- grants

  /** Creates a grant token (kept encrypted here) and the owner intent that authorises it. */
  async issueGrant(pilotId: string, agentId: string, label: string, ttlDays: number) {
    const { token, commitment } = createGrantCredential();
    const expiresAt = new Date(Date.now() + ttlDays * 86_400_000).toISOString();
    const generated = await this.generate(
      { type: "grant_issue", agent_id: agentId, label, credential: commitment, expires_at: expiresAt } as GenerateIntentRequest,
      pilotId,
    );
    const id = randomUUID();
    await this.db
      .prepare(
        "INSERT INTO grants (id, pilot_id, label, token_enc, commitment, correlation_id, expires_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
      )
      .run(id, pilotId, label, this.box.seal(token), commitment, (generated as { correlation_id: string }).correlation_id, expiresAt, Date.now());
    return { grant_id: id, commitment, expires_at: expiresAt, generated };
  }

  /** Marks grants active/revoked once their owner intents settle. */
  async settleGrant(correlationId: string, status: string) {
    if (status === "SUCCESS") await this.db.prepare("UPDATE grants SET status = 'active' WHERE correlation_id = ? AND status = 'pending'").run(correlationId);
    if (status === "FAILED" || status === "REFUNDED") await this.db.prepare("UPDATE grants SET status = 'failed' WHERE correlation_id = ?").run(correlationId);
  }

  /** The newest active, unexpired grant client for a pilot, or null. */
  async grantClient(pilotId: string): Promise<AgentApi | null> {
    const row = await this.db
      .prepare("SELECT token_enc, expires_at FROM grants WHERE pilot_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1")
      .get<{ token_enc: string; expires_at: string }>(pilotId);
    if (!row || Date.parse(row.expires_at) <= Date.now()) return null;
    return this.api().forGrant(this.box.open(row.token_enc));
  }

  // ---------------------------------------------------------------- readiness

  /**
   * Everything that must hold before a live swap: the dependencies it needs are operational and
   * the signed policy is applied and synced at the provider and not frozen.
   */
  async readiness(agentId: string): Promise<{ ready: boolean; reasons: string[]; policy: PolicyView | null; network: NetworkView | null }> {
    const reasons: string[] = [];
    let network: NetworkView | null = null;
    let policy: PolicyView | null = null;
    try {
      network = await this.network();
      for (const c of network.status.components) {
        if ((c.id === "one_click" || c.id === "custody") && c.status !== "operational") reasons.push(`${c.id} is ${c.status}${c.reason ? `: ${c.reason}` : ""}`);
      }
    } catch (e) {
      reasons.push(`network status unavailable: ${(e as Error).message}`);
    }
    try {
      policy = await this.api().getPolicy(agentId);
      if (policy.status !== "APPLIED") reasons.push(`policy status is ${policy.status}`);
      if (!policy.provider_policy_synced) reasons.push("policy not yet synced at the provider");
      if (policy.policy?.frozen) reasons.push("agent is frozen");
      if (policy.policy && !policy.policy.actions.includes("swap")) reasons.push("policy does not allow swaps");
    } catch (e) {
      reasons.push(`policy unavailable: ${errorCode(e)}`);
    }
    return { ready: reasons.length === 0, reasons, policy, network };
  }

  pendingIntents(pilotId: string) {
    return this.db
      .prepare("SELECT correlation_id, type, status, created_at FROM owner_intents WHERE pilot_id = ? ORDER BY created_at DESC")
      .all<{ correlation_id: string; type: string; status: string; created_at: number }>(pilotId);
  }

  async generatedOf(correlationId: string) {
    const row = await this.intentRow(correlationId);
    return row ? parse<Record<string, unknown>>(row.generated_json, {}) : null;
  }
}

export class NotFound extends Error {
  readonly code = "not_found";
}

export function errorCode(e: unknown): string {
  if (e instanceof AgentApiError) return e.code;
  if (e instanceof ConfigError) return e.code;
  return (e as Error)?.message ?? String(e);
}
