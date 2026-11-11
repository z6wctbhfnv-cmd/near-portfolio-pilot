/**
 * Strategy NFT (NEP-171) publisher: mints a token for a strategy listing and appends every run
 * to its on-chain history (contracts/strategy-nft). Optional: without NEAR_ACCOUNT_ID,
 * NEAR_PRIVATE_KEY and STRATEGY_NFT_CONTRACT, runs stay local with nft_status "unpublished".
 */
import { Account, type KeyPairString } from "near-api-js";

export type RunRecordInput = {
  run_id: string;
  timestamp_ms: number;
  engine: string;
  input_sha256: string;
  output_sha256: string;
  attestation_ref: string | null;
  wasm_sha256: string;
  period_return_bps: number;
  equity_usd_e6: number;
};

export type StrategyInfo = {
  strategy_id: string;
  version: string;
  wasm_sha256: string;
  source_url: string;
  outlayer_project: string | null;
  params_json: string;
};

const TGAS = 1_000_000_000_000n;
/** Storage deposits; the contract refunds what it does not use. */
const MINT_DEPOSIT = 100_000_000_000_000_000_000_000n; // 0.1 NEAR (≈0.01 used + up to 0.041 for 4 KB params)
const RECORD_DEPOSIT = 10_000_000_000_000_000_000_000n; // 0.01 NEAR (≈0.005 used)
const VERSION_DEPOSIT = 10_000_000_000_000_000_000_000n; // 0.01 NEAR (≈0.0016 used)

export class NftPublisher {
  private account: Account | null = null;

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
    if (!this.configured) throw new Error("NFT publisher is not configured");
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

  private async call(method: string, args: Record<string, unknown>, deposit: bigint): Promise<string> {
    const res = (await this.acct().callFunctionRaw({
      contractId: this.opts.contract!,
      methodName: method,
      args,
      deposit,
      gas: 100n * TGAS,
    })) as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } };
    return res.transaction?.hash ?? res.transaction_outcome?.id ?? "unknown";
  }

  /** Mints the strategy token if it does not exist yet. Returns the tx hash, or null if it existed. */
  async ensureToken(tokenId: string, receiverId: string, title: string, info: StrategyInfo): Promise<string | null> {
    const existing = await this.view<unknown>("get_strategy", { token_id: tokenId }).catch(() => null);
    if (existing) return null;
    return this.call(
      "mint_strategy",
      {
        token_id: tokenId,
        receiver_id: receiverId,
        token_metadata: { title, description: `NEAR Portfolio Pilot strategy ${info.strategy_id} v${info.version}`, issued_at: String(Date.now()) },
        strategy: info,
      },
      MINT_DEPOSIT,
    );
  }

  /**
   * Makes sure the token exists and points at the code that produced this run: mints it (owned
   * by the publisher account) or rolls its version forward when the WASM hash changed.
   */
  async prepareToken(tokenId: string, title: string, info: StrategyInfo): Promise<string | null> {
    const existing = await this.view<{ strategy?: { wasm_sha256?: string } } | null>("get_strategy", { token_id: tokenId }).catch(() => null);
    if (!existing) return this.ensureToken(tokenId, this.opts.accountId!, title, info);
    if (existing.strategy?.wasm_sha256 && existing.strategy.wasm_sha256 !== info.wasm_sha256) {
      // The contract keeps old versions so earlier runs stay explainable; each label must be new.
      return this.call(
        "update_strategy_version",
        { token_id: tokenId, version: info.version, wasm_sha256: info.wasm_sha256, source_url: info.source_url },
        VERSION_DEPOSIT,
      );
    }
    return null;
  }

  async recordRun(tokenId: string, record: RunRecordInput): Promise<string> {
    return this.call("record_run", { token_id: tokenId, record }, RECORD_DEPOSIT);
  }

  async history(tokenId: string, fromIndex = 0, limit = 50) {
    const [strategy, runs] = await Promise.all([
      this.view("get_strategy", { token_id: tokenId }),
      this.view("get_runs", { token_id: tokenId, from_index: fromIndex, limit }),
    ]);
    return { token_id: tokenId, strategy, runs };
  }
}
