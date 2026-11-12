/**
 * Weekly copy fees on new profit, with a high-water mark per pilot and script.
 *
 * The fee model is the strategy NFT contract's (contracts/strategy-nft, header comment):
 * - a follower pays the holder's copy fee (5% by default, 0..10%, read from `copy_fee`) of its new
 *   profit to the NFT holder, plus 0.25% to Pilot;
 * - the holder running its own script pays only Pilot's 0.25%;
 * - a referrer gets 0.1% of profit OUT OF Pilot's 0.25% (the contract splits that, not us).
 * "New profit" is value above the previous peak after fees, with deposits added to the peak, so a
 * deposit is never charged and a loss must be won back before any fee is due again.
 *
 * How a live agent pays: the Agent API has no `ft_transfer_call` (its withdraw and transfer bodies
 * carry no `msg`), so the agent withdraws USDC on chain `near` to the NFT contract, the only
 * destination its signed policy allows, and the recorder then names the payer and the script with
 * `record_fee_payment`. The contract credits at most what it holds and does not already owe; the
 * recorder is trusted to name the right payer and script.
 *
 * Payments follow the swap executor's rules: the Idempotency-Key and the exact body are stored before
 * the request, retryable failures replay the same key, UNCERTAIN is polled, a new key only after a
 * refusal documented as sending nothing, and nothing real moves unless FEE_PAYMENTS_ENABLED and
 * LIVE_EXECUTION are both on.
 */
import { type AgentApi, AgentApiError, AgentApiRequestError } from "@near-intents-agent-api/sdk";
import { createHash, randomUUID } from "node:crypto";
import type { AgentGateway } from "./agent.js";
import { type Db, json, logEvent, parse } from "./db.js";
import { NOTHING_SENT, OPEN_STATUSES } from "./executor.js";
import { type NftPublisher, PERIOD_MS, scriptCodeHash } from "./nft.js";
import type { Pilot, Pilots } from "./pilots.js";
import { DEFAULT_UNIVERSE, type TokenCatalog } from "./tokens.js";

export const PLATFORM_FEE_BPS = 25;
export const REFERRAL_FEE_BPS = 10;
export const DEFAULT_HOLDER_FEE_BPS = 500;
export const MAX_HOLDER_FEE_BPS = 1_000;

export type FeeComputation = {
  hwm_usd: number;
  profit_usd: number;
  payment_bps: number;
  fee_usd: number;
  holder_usd: number;
  platform_usd: number;
};

/**
 * One week's fee. `hwm` is the peak after last week's fee; `deposits` raise it, so new money is not
 * profit. Rounded down to whole micro-dollars (USDC has 6 decimals).
 */
export function computeFee(i: { equity: number; hwm: number; deposits: number; holderBps: number; payerIsHolder: boolean }): FeeComputation {
  if (!Number.isFinite(i.equity) || !Number.isFinite(i.hwm) || i.hwm < 0) throw new Error("equity and peak must be finite");
  if (i.holderBps < 0 || i.holderBps > MAX_HOLDER_FEE_BPS) throw new Error(`copy fee ${i.holderBps} bps outside 0..${MAX_HOLDER_FEE_BPS}`);
  const hwm = i.hwm + Math.max(0, i.deposits);
  const profit = Math.max(0, i.equity - hwm);
  const holderBps = i.payerIsHolder ? 0 : i.holderBps;
  const paymentBps = holderBps + PLATFORM_FEE_BPS;
  const micro = (x: number) => Math.floor(x * 1e6 + 1e-6) / 1e6;
  const fee = micro((profit * paymentBps) / 10_000);
  // The contract splits the payment as amount * holder / (holder + platform).
  const holder = micro((fee * holderBps) / paymentBps);
  return { hwm_usd: hwm, profit_usd: profit, payment_bps: paymentBps, fee_usd: fee, holder_usd: holder, platform_usd: micro(fee - holder) };
}

/** The peak after a week is final: lowered by the fee only when it was paid. */
export function nextPeak(c: FeeComputation, equity: number, paid: boolean) {
  return paid ? equity - c.fee_usd : c.hwm_usd;
}

/** The NEAR account an owner signs with, or null (EVM and passkey owners have none). */
export function ownerNearAccount(owner: unknown): string | null {
  const o = owner as { type?: string; account_id?: string } | null;
  return o?.type === "near" && o.account_id ? o.account_id : null;
}

export type FeeRow = {
  id: string;
  pilot_id: string;
  token_id: string;
  period_end_ms: number;
  kind: "paper" | "live";
  payer: string | null;
  holder: string | null;
  payer_is_holder: number;
  equity_usd: number;
  hwm_usd: number;
  deposits_usd: number;
  profit_usd: number;
  holder_bps: number;
  payment_bps: number;
  fee_usd: number;
  amount_atomic: string | null;
  hwm_after_usd: number | null;
  idempotency_key: string;
  reference: string;
  request_json: string | null;
  quote_json: string | null;
  status: string;
  correlation_id: string | null;
  response_json: string | null;
  error_code: string | null;
  error: string | null;
  attempts: number;
  record_status: string | null;
  credited_atomic: string | null;
  record_tx: string | null;
  created_at: number;
  updated_at: number;
};

/** Final for the peak: nothing more will happen to this week's fee. */
const SETTLED = new Set(["no_profit", "carried", "paper_paid", "SUCCESS"]);
/** Nothing was sent: the week can be computed again under a new key. */
const RETRYABLE_LOCAL = new Set(["blocked", "refused", "FAILED", "REFUNDED"]);

export type FeeLedgerDeps = {
  db: Db;
  pilots: Pilots;
  gateway: AgentGateway;
  catalog: TokenCatalog;
  nft: NftPublisher;
  paymentsEnabled: boolean;
  liveExecution: boolean;
  feeAssetId: string;
  minFeeUsd: number;
};

export class FeeLedger {
  constructor(private readonly d: FeeLedgerDeps) {}

  get feeToken() {
    return this.d.feeAssetId.replace(/^nep141:/, "");
  }

  /** The policy destination fees need: a withdraw on chain `near` to the NFT contract, no memo. */
  destination() {
    return this.d.nft.contract ? { action: "withdraw" as const, chain: "near", address: this.d.nft.contract, memo: null } : null;
  }

  list(pilotId: string) {
    return this.d.db.prepare("SELECT * FROM fee_ledger WHERE pilot_id = ? ORDER BY period_end_ms DESC, created_at DESC").all<FeeRow>(pilotId);
  }

  get(id: string) {
    return this.d.db.prepare("SELECT * FROM fee_ledger WHERE id = ?").get<FeeRow>(id);
  }

  peaks(pilotId: string) {
    return this.d.db.prepare("SELECT token_id, hwm_usd, since_ms, updated_at FROM fee_hwm WHERE pilot_id = ?").all(pilotId);
  }

  private async update(id: string, fields: Partial<FeeRow>) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    await this.d.db
      .prepare(`UPDATE fee_ledger SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => (fields as Record<string, string | number | null>)[k] ?? null), Date.now(), id);
  }

  private async setPeak(pilotId: string, tokenId: string, hwm: number) {
    await this.d.db.prepare("UPDATE fee_hwm SET hwm_usd = ?, updated_at = ? WHERE pilot_id = ? AND token_id = ?").run(hwm, Date.now(), pilotId, tokenId);
  }

  /** The script NFT a pilot ran in the period: from its last successful run with a WASM hash. */
  async scriptOf(pilotId: string, before: number): Promise<{ code_hash: string; token_id: string | null } | null> {
    const run = await this.d.db
      .prepare("SELECT wasm_sha256, input_json FROM runs WHERE pilot_id = ? AND status = 'ok' AND wasm_sha256 IS NOT NULL AND started_at < ? ORDER BY started_at DESC LIMIT 1")
      .get<{ wasm_sha256: string; input_json: string | null }>(pilotId, before);
    const strategy = parse<{ strategy?: string }>(run?.input_json, {}).strategy;
    if (!run || !strategy) return null;
    const codeHash = scriptCodeHash(run.wasm_sha256, strategy);
    return { code_hash: codeHash, token_id: this.d.nft.contract ? await this.d.nft.tokenByCodeHash(codeHash) : null };
  }

  /**
   * Computes, and pays, the fee for the last finished week. Idempotent: one row per pilot, script and
   * week. A week whose payment never left (blocked or refused) is computed again on the next call.
   */
  async settle(pilotId: string, now = Date.now()): Promise<{ row?: FeeRow; skipped?: string }> {
    const p = await this.d.pilots.get(pilotId);
    if (!p) return { skipped: "pilot not found" };
    if (p.status === "draft" || p.status === "pending_owner") return { skipped: `pilot is ${p.status}` };
    const open = await this.d.db
      .prepare(`SELECT id FROM fee_ledger WHERE pilot_id = ? AND status IN (${[...OPEN_STATUSES, "prepared"].map(() => "?").join(",")}) LIMIT 1`)
      .get(pilotId, ...OPEN_STATUSES, "prepared");
    if (open) return { skipped: "a fee payment is still in flight" };

    const periodEnd = Math.floor(now / PERIOD_MS) * PERIOD_MS;
    const periodStart = periodEnd - PERIOD_MS;
    if (!this.d.nft.contract) return { skipped: "STRATEGY_NFT_CONTRACT is not set: no script NFT to pay" };
    if (p.swarm?.scripts.length) return { skipped: "swarm pilots: fees per sleeve are not computed yet" };
    const script = await this.scriptOf(pilotId, periodEnd);
    if (!script) return { skipped: "no run with a known script before the end of the week" };
    if (!script.token_id) return { skipped: "this script has no NFT: nobody to pay" };
    const tokenId = script.token_id;

    const existing = await this.d.db
      .prepare("SELECT * FROM fee_ledger WHERE pilot_id = ? AND token_id = ? AND period_end_ms = ?")
      .get<FeeRow>(pilotId, tokenId, periodEnd);
    if (existing && !RETRYABLE_LOCAL.has(existing.status)) return { row: existing };

    const value = async (sql: string, ...args: unknown[]) => (await this.d.db.prepare(sql).get<{ total_usd: number; ts: number }>(...args)) ?? null;
    const end = await value("SELECT total_usd, ts FROM snapshots WHERE pilot_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1", pilotId, periodEnd);
    if (!end || end.ts < periodStart) return { skipped: "no value recorded in the week" };

    // The peak starts at the value the pilot had when this script's first fee week began.
    let peak = await this.d.db.prepare("SELECT hwm_usd, since_ms FROM fee_hwm WHERE pilot_id = ? AND token_id = ?").get<{ hwm_usd: number; since_ms: number }>(pilotId, tokenId);
    if (!peak) {
      const start =
        (await value("SELECT total_usd, ts FROM snapshots WHERE pilot_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1", pilotId, periodStart)) ??
        (await value("SELECT total_usd, ts FROM snapshots WHERE pilot_id = ? AND ts > ? ORDER BY ts LIMIT 1", pilotId, periodStart));
      if (!start) return { skipped: "no starting value" };
      await this.d.db
        .prepare("INSERT OR IGNORE INTO fee_hwm (pilot_id, token_id, hwm_usd, since_ms, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(pilotId, tokenId, start.total_usd, Math.max(periodStart, start.ts), Date.now());
      peak = { hwm_usd: start.total_usd, since_ms: Math.max(periodStart, start.ts) };
    }
    // Deposits count from where the peak was last set: a week skipped or blocked in between must not
    // turn its deposits into profit.
    const lastFinal = await this.d.db
      .prepare("SELECT MAX(period_end_ms) AS t FROM fee_ledger WHERE pilot_id = ? AND token_id = ? AND hwm_after_usd IS NOT NULL AND period_end_ms < ?")
      .get<{ t: number | null }>(pilotId, tokenId, periodEnd);
    const flowsFrom = lastFinal?.t ?? peak.since_ms;

    const id = existing?.id ?? randomUUID();
    const kind = p.mode;
    let holder: string | null;
    let holderBps: number;
    try {
      [holder, holderBps] = await Promise.all([this.d.nft.revenueReceiver(tokenId), this.d.nft.copyFeeBps(tokenId)]);
    } catch (e) {
      return { skipped: `NFT terms unreadable: ${(e as Error).message}` };
    }
    const payer = ownerNearAccount(p.owner) ?? (kind === "live" ? await this.agentNearAccount(p) : null);
    const payerIsHolder = Boolean(payer && holder && payer === holder);

    let deposits = 0;
    let depositsError: string | null = null;
    if (kind === "live") {
      try {
        deposits = await this.depositsUsd(p, flowsFrom, periodEnd);
      } catch (e) {
        depositsError = (e as Error).message;
      }
    }
    const c = computeFee({ equity: end.total_usd, hwm: peak.hwm_usd, deposits, holderBps, payerIsHolder });
    const reference = `sha256:${createHash("sha256").update(JSON.stringify({ pilot: pilotId, token: tokenId, period_end_ms: periodEnd, fee_usd: c.fee_usd, payer })).digest("hex")}`;
    const decimals = (await this.d.catalog.get(this.d.feeAssetId).catch(() => null))?.decimals ?? 6;
    const amountAtomic = BigInt(Math.floor(c.fee_usd * 10 ** decimals + 1e-6)).toString();
    const row = {
      id,
      pilot_id: pilotId,
      token_id: tokenId,
      period_end_ms: periodEnd,
      kind,
      payer,
      holder,
      payer_is_holder: payerIsHolder ? 1 : 0,
      equity_usd: end.total_usd,
      hwm_usd: c.hwm_usd,
      deposits_usd: deposits,
      profit_usd: c.profit_usd,
      holder_bps: payerIsHolder ? 0 : holderBps,
      payment_bps: c.payment_bps,
      fee_usd: c.fee_usd,
      amount_atomic: amountAtomic,
      hwm_after_usd: null,
      // A new key whenever the week is computed again: the previous attempt sent nothing.
      idempotency_key: `fee-${randomUUID()}`,
      reference,
      status: "computed",
    };
    if (existing) {
      await this.update(id, { ...row, request_json: null, quote_json: null, correlation_id: null, response_json: null, error_code: null, error: null, record_status: null });
    } else {
      const now2 = Date.now();
      const cols = Object.keys(row);
      await this.d.db
        .prepare(`INSERT INTO fee_ledger (${cols.join(", ")}, created_at, updated_at) VALUES (${cols.map(() => "?").join(", ")}, ?, ?)`)
        .run(...Object.values(row), now2, now2);
    }

    const block = async (code: string, error: string, extra: Partial<FeeRow> = {}) => {
      await this.update(id, { status: "blocked", error_code: code, error, ...extra });
      await logEvent(this.d.db, pilotId, "warn", `fee for ${tokenId} blocked: ${code}`, { error, fee_usd: c.fee_usd });
    };
    // Close the week without a payment; the peak never drops below where it was.
    const close = async (status: string, paid: boolean) => {
      const after = nextPeak(c, end.total_usd, paid);
      await this.update(id, { status, hwm_after_usd: after });
      await this.setPeak(pilotId, tokenId, after);
    };

    if (depositsError) {
      await block("flows_unknown", `deposits of the week could not be read, so profit is unknown: ${depositsError}`);
    } else if (c.profit_usd <= 0) {
      await close("no_profit", false);
    } else if (c.fee_usd < this.d.minFeeUsd || amountAtomic === "0") {
      // Too small to send: the profit stays above the peak and is charged with next week's.
      await close("carried", false);
    } else if (kind === "paper") {
      await this.payPaper(p, id, c, end.total_usd, tokenId, block, close);
    } else {
      await this.payLive(p, id, c, amountAtomic, reference, tokenId, block);
    }
    const final = (await this.get(id))!;
    await logEvent(this.d.db, pilotId, "info", `fee week ${new Date(periodEnd).toISOString().slice(0, 10)} for ${tokenId}: ${final.status}`, {
      profit_usd: c.profit_usd,
      fee_usd: c.fee_usd,
      payment_bps: c.payment_bps,
    });
    return { row: final };
  }

  /** Paper pilots pay from their paper stablecoin. */
  private async payPaper(
    p: Pilot,
    id: string,
    c: FeeComputation,
    equity: number,
    tokenId: string,
    block: (code: string, error: string) => Promise<void>,
    close: (status: string, paid: boolean) => Promise<void>,
  ) {
    const stable = String(p.strategy.params.stable ?? "USDC");
    const holdings = { ...(p.paper_holdings ?? {}) };
    if ((holdings[stable] ?? 0) + 1e-9 < c.fee_usd) {
      await block("insufficient_balance", `the fee is ${c.fee_usd} ${stable} and the paper wallet holds ${(holdings[stable] ?? 0).toFixed(2)}; it is retried next week`);
      return;
    }
    holdings[stable] = (holdings[stable] ?? 0) - c.fee_usd;
    await this.d.pilots.update(p.id, { paper_holdings_json: json(holdings) });
    await close("paper_paid", true);
    void equity;
    void tokenId;
  }

  private async agentNearAccount(p: Pilot): Promise<string | null> {
    if (!p.agent_id) return null;
    try {
      const a = (await this.d.gateway.api().getAgent(p.agent_id)) as unknown as { wallet?: { near_account_id?: string } };
      return a.wallet?.near_account_id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * USD deposited into a live agent in [from, to): settled deposits valued at the asset's current
   * price. Throws when a deposit cannot be valued, so no fee is charged on an unknown profit.
   */
  async depositsUsd(p: Pilot, from: number, to: number): Promise<number> {
    if (!p.agent_id) return 0;
    let total = 0;
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const h = (await this.d.gateway.api().getHistory(p.agent_id, { limit: 100, ...(cursor ? { cursor } : {}) })) as unknown as {
        data: Array<{ type: string; status: string; created_at: string; details?: { request?: { origin_asset?: string; asset?: string; amount?: string }; delivered?: string | null; amount_out?: string | null } }>;
        next_cursor: string | null;
      };
      for (const e of h.data) {
        const at = Date.parse(e.created_at);
        if (e.type !== "deposit" || e.status !== "SUCCESS" || !(at >= from && at < to)) continue;
        const asset = e.details?.request?.origin_asset ?? e.details?.request?.asset;
        const raw = e.details?.delivered ?? e.details?.amount_out ?? e.details?.request?.amount;
        const token = asset ? await this.d.catalog.get(asset) : null;
        if (!token?.price || !raw || !/^\d+$/.test(raw)) throw new Error(`deposit ${e.created_at} cannot be valued`);
        total += (Number(raw) / 10 ** token.decimals) * token.price;
      }
      const oldest = h.data.at(-1);
      if (!h.next_cursor || (oldest && Date.parse(oldest.created_at) < from)) break;
      cursor = h.next_cursor;
    }
    return total;
  }

  /** Live: checks, a withdraw preview, the key stored, then (only if allowed) the withdraw itself. */
  private async payLive(p: Pilot, id: string, c: FeeComputation, amount: string, reference: string, tokenId: string, block: (code: string, error: string, extra?: Partial<FeeRow>) => Promise<void>) {
    const dest = this.destination()!;
    if (!this.d.paymentsEnabled) return block("fees_disabled", `fee of ${c.fee_usd} USD computed; FEE_PAYMENTS_ENABLED is off, nothing sent`);
    if (!p.agent_id) return block("no_agent", "the pilot has no agent");
    const ready = await this.d.gateway.readiness(p.agent_id);
    if (!ready.ready) return block("not_ready", ready.reasons.join("; "));
    const grant = await this.d.gateway.grantClient(p.id);
    if (!grant) return block("no_grant", "no active grant for this pilot");
    const pol = ready.policy?.policy as { actions?: string[]; destinations?: { mode: string; list: Array<Record<string, unknown>> }; assets?: string[] | "any" } | undefined;
    const allowed =
      pol?.actions?.includes("withdraw") &&
      pol.destinations?.mode === "only" &&
      pol.destinations.list.some((d) => d.action === "withdraw" && d.chain === "near" && d.address === dest.address && (d.memo ?? null) === null) &&
      (pol.assets === "any" || pol.assets?.includes(this.d.feeAssetId));
    if (!allowed) {
      return block("fee_destination_missing", `the signed policy must allow withdraw of ${this.d.feeAssetId} to ${dest.address} on chain near (no memo): the owner signs a policy update first`);
    }
    const balances = await this.d.gateway.api().getBalances(p.agent_id);
    const available = BigInt(balances.balances.find((b) => b.asset_id === this.d.feeAssetId)?.available_raw ?? "0");
    if (available < BigInt(amount)) return block("insufficient_balance", `the fee needs ${amount} of ${this.d.feeAssetId}, ${available} available; it is retried next week`);

    const body = {
      asset: this.d.feeAssetId,
      amount,
      chain: "near",
      recipient: dest.address,
      reference,
      note: `dolya weekly fee for ${tokenId}: ${c.payment_bps / 100}% of ${c.profit_usd.toFixed(2)} USD new profit`.slice(0, 500),
    };
    let preview: { warnings?: Array<{ code: string; detail?: string }> };
    try {
      // A preview needs its own key: the live body differs, and a shared key would conflict.
      preview = (await grant.withdraw(p.agent_id, { ...body, dry: true } as never, { idempotencyKey: `feeprev-${id}-${Date.now()}` })) as never;
    } catch (e) {
      return block(e instanceof AgentApiError ? e.code : "preview_failed", (e as Error).message, { request_json: json(body) });
    }
    if (preview.warnings?.length) {
      return block(preview.warnings[0]!.code, preview.warnings.map((w) => `${w.code}: ${w.detail ?? ""}`).join("; "), { request_json: json(body), quote_json: json(preview) });
    }
    // The key and the exact body are stored BEFORE anything is sent.
    await this.update(id, { status: "prepared", request_json: json(body), quote_json: json(preview), error_code: null, error: null });
    if (!this.d.liveExecution) {
      await this.update(id, { status: "blocked", error_code: "live_execution_disabled", error: "LIVE_EXECUTION is off: preview checked, nothing sent" });
      return;
    }
    await this.send(id, p.agent_id, grant);
  }

  /** Sends (or re-sends) the stored withdraw under its stored key. */
  private async send(id: string, agentId: string, grant: AgentApi) {
    const row = (await this.get(id))!;
    const body = parse<Record<string, string>>(row.request_json, {});
    await this.update(id, { attempts: row.attempts + 1 });
    try {
      const res = (await grant.withdraw(agentId, body as never, { idempotencyKey: row.idempotency_key })) as unknown as { correlation_id: string; status: string };
      await this.update(id, { status: res.status, correlation_id: res.correlation_id, response_json: json(res), error_code: null, error: null });
      await logEvent(this.d.db, row.pilot_id, "info", `fee sent: ${row.fee_usd} USD to ${body.recipient}`, { fee_id: id, correlation_id: res.correlation_id });
      if (res.status === "SUCCESS") await this.paid(id);
    } catch (e) {
      if (e instanceof AgentApiError) {
        if (e.retryable) await this.update(id, { status: "retry_pending", error_code: e.code, error: e.message });
        else if (NOTHING_SENT.has(e.code)) await this.update(id, { status: "refused", error_code: e.code, error: e.message });
        else await this.update(id, { status: "needs_attention", error_code: e.code, error: e.message });
      } else if (e instanceof AgentApiRequestError) {
        await this.update(id, { status: "retry_pending", error_code: "transport_error", error: e.message });
      } else {
        await this.update(id, { status: "retry_pending", error_code: "unknown_error", error: (e as Error).message });
      }
    }
  }

  /** The withdraw settled: lower the peak by the fee and queue the on-chain attribution. */
  private async paid(id: string) {
    const r = (await this.get(id))!;
    if (r.hwm_after_usd !== null) return;
    const after = r.equity_usd - r.fee_usd;
    await this.update(id, { hwm_after_usd: after, record_status: "pending" });
    await this.setPeak(r.pilot_id, r.token_id, after);
  }

  /** Reads one fee payment's status from the Agent API. */
  async refresh(id: string) {
    const r = await this.get(id);
    if (!r?.correlation_id) return r;
    const s = (await this.d.gateway.api().getStatus(r.correlation_id)) as { status: string; failure_code: string | null };
    await this.update(id, { status: s.status, response_json: json(s), error_code: s.failure_code ?? null });
    if (s.status === "SUCCESS") await this.paid(id);
    return this.get(id);
  }

  /**
   * Follows open payments (poll, or replay retry_pending under the same key while LIVE_EXECUTION is
   * on), then asks the contract to credit every settled payment it has not credited yet. A payment
   * left `prepared` (the process stopped between storing the key and getting an answer) may or may
   * not have been sent, so it is replayed under its stored key too, never under a new one.
   */
  async reconcile(now = Date.now()): Promise<{ checked: number; replayed: number; recorded: number }> {
    let checked = 0;
    let replayed = 0;
    let recorded = 0;
    const rows = await this.d.db
      .prepare(
        `SELECT f.*, p.agent_id FROM fee_ledger f JOIN pilots p ON p.id = f.pilot_id WHERE f.kind = 'live'
         AND (f.status IN (${OPEN_STATUSES.map(() => "?").join(",")}) OR (f.status = 'prepared' AND f.updated_at < ?))`,
      )
      .all<FeeRow & { agent_id: string | null }>(...OPEN_STATUSES, now - 120_000);
    for (const r of rows) {
      try {
        if (r.status === "retry_pending" || r.status === "prepared") {
          if (!this.d.liveExecution || !this.d.paymentsEnabled || !r.agent_id) continue;
          const grant = await this.d.gateway.grantClient(r.pilot_id);
          if (!grant) continue;
          await this.send(r.id, r.agent_id, grant);
          replayed++;
        } else if (r.correlation_id) {
          await this.refresh(r.id);
          checked++;
        }
      } catch (e) {
        await logEvent(this.d.db, r.pilot_id, "warn", `fee reconcile ${r.id} failed`, { error: (e as Error).message });
      }
    }
    const pending = await this.d.db.prepare("SELECT * FROM fee_ledger WHERE status = 'SUCCESS' AND record_status = 'pending'").all<FeeRow>();
    for (const r of pending) {
      try {
        if (await this.record(r)) recorded++;
      } catch (e) {
        await this.update(r.id, { error: `attribution: ${(e as Error).message}` });
      }
    }
    return { checked, replayed, recorded };
  }

  /** Has the contract name the payer of a settled payment. Safe to repeat: one credit per reference. */
  private async record(r: FeeRow): Promise<boolean> {
    let credited = await this.d.nft.feePayment(r.reference);
    if (credited === null) {
      if (!this.d.nft.configured) throw new Error("the NFT recorder is not configured (NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY)");
      if (!r.payer) throw new Error("no payer account to name");
      const tx = await this.d.nft.recordFeePayment({ payer: r.payer, tokenId: r.token_id, feeToken: this.feeToken, amount: r.amount_atomic!, reference: r.reference });
      await this.update(r.id, { record_tx: tx });
      credited = await this.d.nft.feePayment(r.reference);
    }
    if (credited === null) return false; // the money is not on the contract yet: try again later
    await this.update(r.id, { record_status: "recorded", credited_atomic: credited, error: null });
    await logEvent(this.d.db, r.pilot_id, "info", `fee for ${r.token_id} credited on chain: ${credited}`, { fee_id: r.id });
    return true;
  }

  /** Pilots whose last finished week has no final fee row yet. */
  async due(now = Date.now()) {
    const periodEnd = Math.floor(now / PERIOD_MS) * PERIOD_MS;
    return this.d.db
      .prepare(
        `SELECT p.id FROM pilots p WHERE p.status IN ('active','paused','frozen') AND p.created_at < ?
         AND NOT EXISTS (SELECT 1 FROM fee_ledger f WHERE f.pilot_id = p.id AND f.period_end_ms = ?
           AND (f.status NOT IN ('blocked','refused','FAILED','REFUNDED') OR f.updated_at > ?))`,
      )
      // A week that was blocked (nothing sent) is tried again once a day, not on every tick.
      .all<{ id: string }>(periodEnd, periodEnd, now - 86_400_000);
  }
}

/** Whether the asset the fees are paid in is in the universe (for the policy's asset list). */
export function feeAssetSymbol(assetId: string) {
  return DEFAULT_UNIVERSE.find((a) => a.asset_id === assetId)?.symbol ?? null;
}

export { SETTLED as FEE_SETTLED };
