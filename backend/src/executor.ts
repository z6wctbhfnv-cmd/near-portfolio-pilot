/**
 * Turns a strategy's trades into swaps.
 *
 * Paper mode fills at catalogue prices minus a cost and moves the pilot's paper holdings.
 * Live mode follows the Agent API's rules to the letter:
 *  - readiness first (dependencies operational, policy APPLIED + synced, not frozen);
 *  - a dry quote for every swap; any warning blocks it (the live call would be refused, or the fee
 *    is too high);
 *  - the Idempotency-Key is written to the database BEFORE the request is sent;
 *  - retryable errors and lost responses are retried later with the SAME key and body
 *    (reconcile), never a new one; UNCERTAIN is polled, never resubmitted;
 *  - a new key only after a refusal that is documented as sending nothing.
 * And on top of all that, nothing real is sent unless LIVE_EXECUTION=true.
 */
import { type AgentApi, AgentApiError, AgentApiRequestError, type QuoteResponse } from "@near-intents-agent-api/sdk";
import { randomUUID } from "node:crypto";
import type { AgentGateway } from "./agent.js";
import { type Db, json, logEvent, parse } from "./db.js";
import { DEFAULT_UNIVERSE, fromAtomic, type TokenCatalog, usdToAtomic } from "./tokens.js";

export type Trade = { sell: string; buy: string; usd: number };

export type ExecutionRow = {
  id: string;
  pilot_id: string;
  run_id: string | null;
  kind: "paper" | "live";
  idempotency_key: string;
  sell_symbol: string;
  buy_symbol: string;
  usd: number;
  request_json: string;
  quote_json: string | null;
  status: string;
  correlation_id: string | null;
  response_json: string | null;
  error_code: string | null;
  error: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
};

/** Statuses the reconciler still follows. */
export const OPEN_STATUSES = ["sent", "retry_pending", "QUEUED", "PROCESSING", "PENDING_APPROVAL", "UNCERTAIN"];
/** Refusals documented as "nothing was sent": safe to try again later under a NEW key. */
const NOTHING_SENT = new Set([
  "wallet_busy",
  "spend_budget_exceeded",
  "spend_price_unavailable",
  "policy_limit_exceeded",
  "policy_action_limit_exceeded",
  "policy_usage_unavailable",
  "insufficient_balance",
  "unsupported_token",
  "policy_schedule_denied",
  "provider_refused",
  "route_unavailable",
  "amount_too_low",
  "policy_not_ready",
  "wallet_frozen",
  "policy_action_denied",
  "policy_asset_denied",
  "policy_transaction_limit_exceeded",
  "validation_failed",
]);

export type ExecutorDeps = {
  db: Db;
  gateway: AgentGateway;
  catalog: TokenCatalog;
  liveExecution: boolean;
  maxSlippageBps: number;
  paperCostBps: number;
  /** Max time to wait for each live swap to settle inside a run (it is reconciled later anyway). */
  settleWaitMs?: number;
};

export type LiveLimits = { maxTradeUsd: number | null; remainingBudgetUsd: number | null };

export class Executor {
  constructor(private readonly d: ExecutorDeps) {}

  private insert(row: Omit<ExecutionRow, "created_at" | "updated_at" | "attempts"> & { attempts?: number }) {
    const now = Date.now();
    this.d.db
      .prepare(
        `INSERT INTO executions (id, pilot_id, run_id, kind, idempotency_key, sell_symbol, buy_symbol, usd, request_json, quote_json, status,
          correlation_id, response_json, error_code, error, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.pilot_id,
        row.run_id,
        row.kind,
        row.idempotency_key,
        row.sell_symbol,
        row.buy_symbol,
        row.usd,
        row.request_json,
        row.quote_json,
        row.status,
        row.correlation_id,
        row.response_json,
        row.error_code,
        row.error,
        row.attempts ?? 0,
        now,
        now,
      );
  }

  private update(id: string, fields: Partial<ExecutionRow>) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.d.db
      .prepare(`UPDATE executions SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => (fields as Record<string, string | number | null>)[k] ?? null), Date.now(), id);
  }

  get(id: string) {
    return this.d.db.prepare("SELECT * FROM executions WHERE id = ?").get(id) as ExecutionRow | undefined;
  }

  // ------------------------------------------------------------------ paper

  /** Fills trades against paper holdings at catalogue prices minus the paper cost. */
  async paper(pilotId: string, runId: string, holdings: Record<string, number>, trades: Trade[]) {
    const prices = await this.prices();
    const cost = this.d.paperCostBps / 10_000;
    const results: ExecutionRow[] = [];
    for (const t of trades) {
      const ps = prices[t.sell];
      const pb = prices[t.buy];
      const id = randomUUID();
      const base = {
        id,
        pilot_id: pilotId,
        run_id: runId,
        kind: "paper" as const,
        idempotency_key: `paper-${id}`,
        sell_symbol: t.sell,
        buy_symbol: t.buy,
        usd: t.usd,
        request_json: json(t)!,
        quote_json: null,
        correlation_id: null,
      };
      if (!ps || !pb) {
        this.insert({ ...base, status: "blocked", response_json: null, error_code: "price_unavailable", error: `no price for ${!ps ? t.sell : t.buy}` });
      } else {
        const sellUnits = Math.min(holdings[t.sell] ?? 0, t.usd / ps);
        const usd = sellUnits * ps;
        if (usd <= 0) {
          this.insert({ ...base, status: "blocked", response_json: null, error_code: "insufficient_balance", error: `no ${t.sell} to sell` });
        } else {
          const got = (usd * (1 - cost)) / pb;
          holdings[t.sell] = (holdings[t.sell] ?? 0) - sellUnits;
          holdings[t.buy] = (holdings[t.buy] ?? 0) + got;
          this.insert({
            ...base,
            usd: Number(usd.toFixed(2)),
            status: "paper_filled",
            response_json: json({ sold_units: sellUnits, bought_units: got, sell_price: ps, buy_price: pb, cost_bps: this.d.paperCostBps }),
            error_code: null,
            error: null,
          });
        }
      }
      results.push(this.get(id)!);
    }
    return results;
  }

  private async prices(): Promise<Record<string, number>> {
    const u = await this.d.catalog.universe();
    return Object.fromEntries(u.filter((a) => a.price).map((a) => [a.symbol, a.price!]));
  }

  // ------------------------------------------------------------------ live

  /**
   * Prepares, checks and (only with LIVE_EXECUTION=true) sends each trade as a swap.
   * `limits` are the mandate's own caps, checked before the API's.
   */
  async live(pilotId: string, runId: string, agentId: string, trades: Trade[], limits: LiveLimits) {
    const results: ExecutionRow[] = [];
    const ready = await this.d.gateway.readiness(agentId);
    const grant = this.d.gateway.grantClient(pilotId);
    const blockAll = !ready.ready ? `not ready: ${ready.reasons.join("; ")}` : !grant ? "no active grant for this pilot" : null;

    let balances: Record<string, bigint> = {};
    if (!blockAll) {
      const b = await this.d.gateway.api().getBalances(agentId, { source: "public" });
      balances = Object.fromEntries(b.balances.map((e) => [e.asset_id, BigInt(e.available_raw)]));
    }
    const remaining = ready.policy?.usage.budget.daily.remaining_usd;
    let budgetLeft = Math.min(
      limits.remainingBudgetUsd ?? Infinity,
      remaining !== null && remaining !== undefined ? Number(remaining) : Infinity,
    );

    for (const t of trades) {
      const id = randomUUID();
      const sellU = DEFAULT_UNIVERSE.find((a) => a.symbol === t.sell);
      const buyU = DEFAULT_UNIVERSE.find((a) => a.symbol === t.buy);
      const base = {
        id,
        pilot_id: pilotId,
        run_id: runId,
        kind: "live" as const,
        idempotency_key: `swap-${id}`,
        sell_symbol: t.sell,
        buy_symbol: t.buy,
        usd: t.usd,
        quote_json: null,
        correlation_id: null,
        response_json: null,
      };
      const block = (code: string, error: string, extra: Partial<ExecutionRow> = {}) => {
        this.insert({ ...base, request_json: json(t)!, status: "blocked", error_code: code, error, ...extra });
        logEvent(this.d.db, pilotId, "warn", `swap ${t.sell}->${t.buy} blocked: ${code}`, { error });
        results.push(this.get(id)!);
      };
      if (blockAll) {
        block(grant ? "not_ready" : "no_grant", blockAll);
        continue;
      }
      if (!sellU || !buyU) {
        block("unknown_asset", `${t.sell} or ${t.buy} is not in the universe`);
        continue;
      }
      if (limits.maxTradeUsd !== null && t.usd > limits.maxTradeUsd + 1e-9) {
        block("mandate_trade_limit", `${t.usd} USD is above the mandate's ${limits.maxTradeUsd} USD per trade`);
        continue;
      }
      if (t.usd > budgetLeft + 1e-9) {
        block("mandate_budget", `${t.usd} USD is above the ${budgetLeft.toFixed(2)} USD left in today's budget`);
        continue;
      }
      const token = await this.d.catalog.get(sellU.asset_id);
      if (!token?.price) {
        block("price_unavailable", `no current price for ${t.sell}`);
        continue;
      }
      let amount = usdToAtomic(t.usd, token.price, token.decimals);
      const available = balances[sellU.asset_id] ?? 0n;
      if (amount > available) amount = available;
      if (amount <= 0n) {
        block("insufficient_balance", `no available ${t.sell}`);
        continue;
      }
      const request = { origin_asset: sellU.asset_id, destination_asset: buyU.asset_id, amount: amount.toString() };

      // Dry quote: any warning means the live call would be refused or is too costly.
      let quote: QuoteResponse;
      try {
        quote = await grant!.swap(agentId, { ...request, dry: true });
      } catch (e) {
        block(e instanceof AgentApiError ? e.code : "quote_failed", (e as Error).message, { request_json: json(request)! });
        continue;
      }
      if (quote.warnings?.length) {
        block(quote.warnings[0]!.code, quote.warnings.map((w) => `${w.code}: ${w.detail}`).join("; "), { request_json: json(request)!, quote_json: json(quote) });
        continue;
      }
      const amountOut = String(quote.quote?.amountOut ?? quote.quote?.amount_out ?? "");
      if (!/^\d+$/.test(amountOut) || amountOut === "0") {
        block("quote_unreadable", "quote has no amountOut", { request_json: json(request)!, quote_json: json(quote) });
        continue;
      }
      const minOut = (BigInt(amountOut) * BigInt(10_000 - this.d.maxSlippageBps)) / 10_000n;
      const live = { ...request, min_amount_out: minOut.toString() };

      // Persist the key and the exact body BEFORE sending.
      this.insert({
        ...base,
        usd: t.usd,
        request_json: json(live)!,
        quote_json: json(quote),
        status: "prepared",
        error_code: null,
        error: null,
      });
      if (!this.d.liveExecution) {
        this.update(id, { status: "blocked", error_code: "live_execution_disabled", error: "LIVE_EXECUTION is off: quote checked, nothing sent" });
        results.push(this.get(id)!);
        continue;
      }
      await this.send(id, agentId, grant!);
      budgetLeft -= t.usd;
      const amountIn = Number(fromAtomic(amount, token.decimals));
      balances[sellU.asset_id] = available - amount;
      logEvent(this.d.db, pilotId, "info", `swap sent ${amountIn} ${t.sell} -> ${t.buy}`, { execution_id: id });
      results.push(this.get(id)!);
    }
    if (this.d.liveExecution && (this.d.settleWaitMs ?? 0) > 0) {
      for (const r of results) if (r.correlation_id) await this.refresh(r.id, this.d.settleWaitMs).catch(() => undefined);
    }
    return results.map((r) => this.get(r.id)!);
  }

  /** Sends (or re-sends) the stored request under its stored key. */
  private async send(id: string, agentId: string, grant: AgentApi) {
    const row = this.get(id)!;
    const body = parse<{ origin_asset: string; destination_asset: string; amount: string; min_amount_out?: string }>(row.request_json, null as never);
    this.update(id, { attempts: row.attempts + 1 });
    try {
      const res = (await grant.swap(agentId, body, { idempotencyKey: row.idempotency_key })) as { correlation_id: string; status: string };
      this.update(id, { status: res.status, correlation_id: res.correlation_id, response_json: json(res), error_code: null, error: null });
    } catch (e) {
      if (e instanceof AgentApiError) {
        if (e.retryable) {
          // May have taken effect: only this key can replay it.
          this.update(id, { status: "retry_pending", error_code: e.code, error: e.message });
        } else if (NOTHING_SENT.has(e.code)) {
          this.update(id, { status: "refused", error_code: e.code, error: e.message });
        } else {
          this.update(id, { status: "needs_attention", error_code: e.code, error: e.message });
        }
      } else if (e instanceof AgentApiRequestError) {
        // Lost response: the request may have reached the API. Replay under the same key later.
        this.update(id, { status: "retry_pending", error_code: "transport_error", error: e.message });
      } else {
        this.update(id, { status: "retry_pending", error_code: "unknown_error", error: (e as Error).message });
      }
    }
  }

  /** Reads one execution's status from the Agent API. */
  async refresh(id: string, waitMs = 0) {
    const row = this.get(id);
    if (!row?.correlation_id) return row;
    const s = (await this.d.gateway.api().getStatus(row.correlation_id, waitMs ? { waitMs: Math.min(30_000, waitMs) } : {})) as {
      status: string;
      failure_code: string | null;
    };
    this.update(id, { status: s.status, response_json: json(s), error_code: s.failure_code ?? null });
    return this.get(id);
  }

  /** Follows open live executions: polls those with a correlation_id, replays retry_pending under the same key. */
  async reconcile(): Promise<{ checked: number; replayed: number }> {
    const rows = this.d.db
      .prepare(`SELECT e.*, p.agent_id FROM executions e JOIN pilots p ON p.id = e.pilot_id WHERE e.kind = 'live' AND e.status IN (${OPEN_STATUSES.map(() => "?").join(",")})`)
      .all(...OPEN_STATUSES) as Array<ExecutionRow & { agent_id: string | null }>;
    let checked = 0;
    let replayed = 0;
    for (const r of rows) {
      try {
        if (r.status === "retry_pending") {
          if (!this.d.liveExecution || !r.agent_id) continue;
          const grant = this.d.gateway.grantClient(r.pilot_id);
          if (!grant) continue;
          await this.send(r.id, r.agent_id, grant);
          replayed++;
        } else if (r.correlation_id) {
          await this.refresh(r.id);
          checked++;
        }
      } catch (e) {
        logEvent(this.d.db, r.pilot_id, "warn", `reconcile ${r.id} failed`, { error: (e as Error).message });
      }
    }
    return { checked, replayed };
  }
}
