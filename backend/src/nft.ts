/**
 * Strategy NFT recorder for contracts/strategy-nft (deployed on testnet as pilot-nft2-14805.testnet).
 *
 * One NFT = one script, bound to its `code_hash`. For a WASM strategy the script is the module plus
 * the strategy id inside it: code_hash = sha256("<wasm_sha256>:<strategy_id>"). Authors mint the NFT
 * themselves (`mint_strategy` must be called by the author); the backend only appends checkpoints.
 *
 * Once per period the backend appends one checkpoint per NFT: the average period return of every
 * pilot that ran that script, compounded onto the last on-chain equity index. Only the contract's
 * `recorder` may append, and `append_checkpoint` takes no deposit, so a function-call key limited to
 * that method is enough. Optional: without STRATEGY_NFT_CONTRACT, NEAR_ACCOUNT_ID and
 * NEAR_PRIVATE_KEY, runs stay local with nft_status "unpublished".
 */
import { createHash } from "node:crypto";
import { Account, type KeyPairString } from "near-api-js";
import { copiedCapitalUsd } from "./copying.js";
import type { Db } from "./db.js";
import { logEvent } from "./db.js";

export type Checkpoint = {
  period_end_ms: number;
  /** Equity index scaled by 1e6 (1_000_000 = start value), as a decimal string (U128). */
  equity_index: string;
  proofs_hash: string;
  executions: number;
  code_hash: string;
  followers: number;
};

export type StrategyInfo = { strategy_id: string; code_hash: string; author: string };

const TGAS = 1_000_000_000_000n;
export const PERIOD_MS = 7 * 86_400_000;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The NFT identity of a WASM strategy: the module hash plus the strategy id inside it. */
export const scriptCodeHash = (wasmSha256: string, strategyId: string) => sha256(`${wasmSha256.toLowerCase()}:${strategyId}`);

export class NftPublisher {
  private account: Account | null = null;
  private tokenCache = new Map<string, { token: string | null; at: number }>();

  constructor(
    private readonly opts: { contract?: string; accountId?: string; privateKey?: string; rpcUrl: string; fetch?: typeof fetch },
  ) {}

  get configured() {
    return Boolean(this.opts.contract && this.opts.accountId && this.opts.privateKey);
  }

  get contract() {
    return this.opts.contract ?? null;
  }

  private acct(): Account {
    if (!this.configured) throw new Error("NFT recorder is not configured");
    this.account ??= new Account(this.opts.accountId!, this.opts.rpcUrl, this.opts.privateKey as KeyPairString);
    return this.account;
  }

  /** Read-only contract view over JSON-RPC. */
  async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.opts.contract) throw new Error("STRATEGY_NFT_CONTRACT is not set");
    const f = this.opts.fetch ?? fetch;
    const res = await f(this.opts.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "pilot",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: this.opts.contract,
          method_name: method,
          args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json()) as { result?: { result?: number[] }; error?: unknown };
    if (!body.result?.result) throw new Error(`view ${method} failed: ${JSON.stringify(body.error ?? body).slice(0, 300)}`);
    return JSON.parse(Buffer.from(body.result.result).toString("utf8")) as T;
  }

  /** Which NFT holds this script, cached for 10 minutes (mints are rare). */
  async tokenByCodeHash(codeHash: string): Promise<string | null> {
    const hit = this.tokenCache.get(codeHash);
    if (hit && Date.now() - hit.at < 600_000) return hit.token;
    const token = await this.view<string | null>("token_by_code_hash", { code_hash: codeHash });
    this.tokenCache.set(codeHash, { token, at: Date.now() });
    return token;
  }

  /** The whole on-chain record, oldest first (the contract pages at most 200 at a time). */
  async record(tokenId: string): Promise<Checkpoint[]> {
    const out: Checkpoint[] = [];
    for (let from = 0; ; from += 200) {
      const page = await this.view<Checkpoint[]>("record", { token_id: tokenId, from_index: from, limit: 200 });
      out.push(...page);
      if (page.length < 200) return out;
    }
  }

  async appendCheckpoint(tokenId: string, checkpoint: Checkpoint): Promise<string> {
    const res = (await this.acct().callFunctionRaw({
      contractId: this.opts.contract!,
      methodName: "append_checkpoint",
      args: { token_id: tokenId, checkpoint },
      deposit: 0n,
      gas: 50n * TGAS,
    })) as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } };
    return res.transaction?.hash ?? res.transaction_outcome?.id ?? "unknown";
  }

  /** The holder now: who receives the author's share of fees. */
  revenueReceiver(tokenId: string) {
    return this.view<string | null>("revenue_receiver", { token_id: tokenId });
  }

  /** The holder's copy fee in effect now, in basis points of profit (default 500 = 5%). */
  async copyFeeBps(tokenId: string): Promise<number> {
    const [now] = await this.view<[number, number, number]>("copy_fee", { token_id: tokenId });
    return Number(now);
  }

  /** (bond held, bond required) in USD; copying is open while held >= required. */
  async bondStatus(tokenId: string): Promise<{ held_usd: number; required_usd: number }> {
    const [held, required] = await this.view<[string, string]>("bond_status", { token_id: tokenId });
    return { held_usd: Number(held) / 1e6, required_usd: Number(required) / 1e6 };
  }

  /** Atomic amount the contract credited for a fee payment reference, or null if not recorded. */
  async feePayment(reference: string): Promise<string | null> {
    return this.view<string | null>("fee_payment", { reference });
  }

  /**
   * Names the payer of a fee an Agent API agent withdrew to the contract (recorder only). The contract
   * credits at most what actually arrived and is not owed to anyone, once per reference.
   */
  async recordFeePayment(a: { payer: string; tokenId: string; feeToken: string; amount: string; reference: string }): Promise<string> {
    const res = (await this.acct().callFunctionRaw({
      contractId: this.opts.contract!,
      methodName: "record_fee_payment",
      args: { payer: a.payer, token_id: a.tokenId, fee_token: a.feeToken, amount: a.amount, reference: a.reference },
      deposit: 0n,
      gas: 60n * TGAS,
    })) as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } };
    return res.transaction?.hash ?? res.transaction_outcome?.id ?? "unknown";
  }

  /** Reports the copiers' capital (USD) that sets the holder's required bond. Recorder only. */
  async setCopiedCapital(tokenId: string, usd: number): Promise<string> {
    const res = (await this.acct().callFunctionRaw({
      contractId: this.opts.contract!,
      methodName: "set_copied_capital",
      args: { token_id: tokenId, usd: String(Math.max(0, Math.round(usd * 1e6))) },
      deposit: 0n,
      gas: 30n * TGAS,
    })) as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } };
    return res.transaction?.hash ?? res.transaction_outcome?.id ?? "unknown";
  }

  async history(tokenId: string) {
    const [strategy, record] = await Promise.all([this.view<StrategyInfo | null>("strategy_info", { token_id: tokenId }), this.record(tokenId)]);
    return { token_id: tokenId, strategy, record };
  }
}

/**
 * Appends the checkpoint of the last finished period to every NFT whose script ran in it.
 * Idempotent: a period already on chain (or already tried locally) is skipped.
 */
export async function publishCheckpoints(db: Db, nft: NftPublisher, now = Date.now(), opts: { reportCapital?: boolean } = {}) {
  if (!nft.configured) return [];
  const periodEnd = Math.floor(now / PERIOD_MS) * PERIOD_MS;
  const periodStart = periodEnd - PERIOD_MS;
  const runs = await db
    .prepare(
      `SELECT r.pilot_id, r.wasm_sha256, r.output_sha256, p.strategy_id FROM runs r JOIN pilots p ON p.id = r.pilot_id
       WHERE r.status = 'ok' AND r.wasm_sha256 IS NOT NULL AND r.started_at >= ? AND r.started_at < ? AND p.swarm_json IS NULL ORDER BY r.started_at`,
    )
    .all<{ pilot_id: string; wasm_sha256: string; output_sha256: string | null; strategy_id: string }>(periodStart, periodEnd);

  // code_hash -> pilots and run output hashes of the period
  const groups = new Map<string, { pilots: Set<string>; outputs: string[] }>();
  for (const r of runs) {
    const h = scriptCodeHash(r.wasm_sha256, r.strategy_id);
    const g = groups.get(h) ?? { pilots: new Set(), outputs: [] };
    g.pilots.add(r.pilot_id);
    if (r.output_sha256) g.outputs.push(r.output_sha256);
    groups.set(h, g);
  }

  const done: Array<{ token_id: string; tx: string }> = [];
  const valueAt = db.prepare("SELECT total_usd FROM snapshots WHERE pilot_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1");
  const firstAfter = db.prepare("SELECT total_usd FROM snapshots WHERE pilot_id = ? AND ts >= ? AND ts < ? ORDER BY ts LIMIT 1");
  for (const [codeHash, g] of groups) {
    const seen = await db.prepare("SELECT 1 FROM nft_checkpoints WHERE code_hash = ? AND period_end_ms = ?").get(codeHash, periodEnd);
    if (seen) continue;
    try {
      const tokenId = await nft.tokenByCodeHash(codeHash);
      if (!tokenId) continue; // nobody minted this script yet
      const record = await nft.record(tokenId);
      const last = record.at(-1);
      if (last && last.period_end_ms >= periodEnd) {
        await db.prepare("INSERT OR IGNORE INTO nft_checkpoints (code_hash, period_end_ms, token_id, tx) VALUES (?, ?, ?, NULL)").run(codeHash, periodEnd, tokenId);
        continue;
      }
      const returns: number[] = [];
      for (const pid of g.pilots) {
        // Start of the period, or the pilot's first value inside it if it started mid-period.
        const start = (await valueAt.get<{ total_usd: number }>(pid, periodStart)) ?? (await firstAfter.get<{ total_usd: number }>(pid, periodStart, periodEnd));
        const end = await valueAt.get<{ total_usd: number }>(pid, periodEnd);
        if (start && end && start.total_usd > 0) returns.push(end.total_usd / start.total_usd - 1);
      }
      if (!returns.length) continue;
      const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
      const prevIndex = last ? Number(last.equity_index) : 1_000_000;
      const ids = [...g.pilots];
      const execs = await db
        .prepare(
          `SELECT id, status FROM executions WHERE pilot_id IN (${ids.map(() => "?").join(",")}) AND created_at >= ? AND created_at < ? ORDER BY id`,
        )
        .all<{ id: string; status: string }>(...ids, periodStart, periodEnd);
      const proofs = [...g.outputs.sort(), ...execs.map((e) => `${e.id}:${e.status}`)].join("\n");
      const checkpoint: Checkpoint = {
        period_end_ms: periodEnd,
        equity_index: String(Math.max(0, Math.round(prevIndex * (1 + avg)))),
        proofs_hash: sha256(proofs),
        executions: execs.length,
        code_hash: codeHash,
        followers: g.pilots.size,
      };
      const tx = await nft.appendCheckpoint(tokenId, checkpoint);
      // The holder's required bond follows copiers' capital: report it (an extra write, off by default).
      if (opts.reportCapital) {
        const strategyId = runs.find((r) => scriptCodeHash(r.wasm_sha256, r.strategy_id) === codeHash)!.strategy_id;
        const holder = await nft.revenueReceiver(tokenId).catch(() => null);
        const capital = await copiedCapitalUsd(db, strategyId, holder);
        await nft.setCopiedCapital(tokenId, capital).catch((e: Error) => logEvent(db, null, "warn", `NFT ${tokenId}: copied capital not reported: ${e.message}`));
      }
      await db.prepare("INSERT OR REPLACE INTO nft_checkpoints (code_hash, period_end_ms, token_id, tx) VALUES (?, ?, ?, ?)").run(codeHash, periodEnd, tokenId, tx);
      await db.prepare(
        `UPDATE runs SET nft_status = 'published', nft_tx = ? WHERE status = 'ok' AND started_at >= ? AND started_at < ? AND pilot_id IN (${ids.map(() => "?").join(",")})`,
      ).run(tx, periodStart, periodEnd, ...ids);
      await logEvent(db, null, "info", `NFT ${tokenId}: checkpoint ${new Date(periodEnd).toISOString()} appended`, { tx, followers: g.pilots.size });
      done.push({ token_id: tokenId, tx });
    } catch (e) {
      await logEvent(db, null, "error", `NFT checkpoint for ${codeHash.slice(0, 12)}: ${(e as Error).message}`);
    }
  }
  return done;
}
