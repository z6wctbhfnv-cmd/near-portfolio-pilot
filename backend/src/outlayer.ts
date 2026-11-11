/**
 * OutLayer HTTPS client: runs the strategy module inside an Intel TDX enclave and returns the
 * output with a link to the execution's attestation.
 *
 * POST /call/{owner}/{project} with `X-Payment-Key: owner:nonce:secret` and `{ input }`. The
 * project is this repo's strategies/ crate, which OutLayer builds from GitHub.
 */

export type OutLayerCall = {
  call_id?: string;
  status?: "pending" | "completed" | "failed";
  output?: Record<string, unknown> | null;
  error?: string | null;
  compute_cost?: string | null;
  instructions?: number | null;
  time_ms?: number | null;
  poll_url?: string | null;
  attestation_url?: string | null;
};

export class OutLayerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
    readonly terminal?: boolean,
  ) {
    super(message);
  }
}

export class OutLayerClient {
  constructor(
    private readonly opts: { baseUrl: string; paymentKey?: string; project?: string; fetch?: typeof fetch; timeoutMs?: number },
  ) {}

  get configured() {
    return Boolean(this.opts.paymentKey && this.opts.project);
  }

  private get f() {
    return this.opts.fetch ?? fetch;
  }

  private url(path: string) {
    return `${this.opts.baseUrl.replace(/\/$/, "")}${path}`;
  }

  /** Runs the strategy on OutLayer. Polls a call the API answers as pending. */
  async run(input: Record<string, unknown>): Promise<OutLayerCall & { output: Record<string, unknown> }> {
    if (!this.opts.paymentKey || !this.opts.project) throw new Error("OutLayer is not configured (OUTLAYER_PAYMENT_KEY, OUTLAYER_PROJECT)");
    const [owner, project] = this.opts.project.split("/");
    if (!owner || !project) throw new Error("OUTLAYER_PROJECT must look like owner.near/project");
    const res = await this.f(this.url(`/call/${encodeURIComponent(owner)}/${encodeURIComponent(project)}`), {
      method: "POST",
      headers: { "content-type": "application/json", "x-payment-key": this.opts.paymentKey },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
    });
    let call = (await res.json().catch(() => ({}))) as OutLayerCall & { reason?: string; terminal?: boolean };
    if (res.status === 408 && call.call_id) {
      call = await this.poll(call.call_id);
    } else if (!res.ok) {
      throw new OutLayerError(call.error ?? `OutLayer ${res.status}`, res.status, call.reason, call.terminal);
    }
    if (call.status === "pending" && call.call_id) call = await this.poll(call.call_id);
    if (call.status !== "completed" || !call.output) {
      throw new OutLayerError(call.error ?? `OutLayer call ${call.status ?? "failed"}`, 200);
    }
    return call as OutLayerCall & { output: Record<string, unknown> };
  }

  async poll(callId: string, { intervalMs = 2_000, maxMs = 180_000 } = {}): Promise<OutLayerCall> {
    const until = Date.now() + maxMs;
    while (Date.now() < until) {
      const res = await this.f(this.url(`/calls/${encodeURIComponent(callId)}`), {
        headers: { "x-payment-key": this.opts.paymentKey ?? "" },
        signal: AbortSignal.timeout(30_000),
      });
      const call = (await res.json().catch(() => ({}))) as OutLayerCall;
      if (!res.ok) throw new OutLayerError(call.error ?? `OutLayer poll ${res.status}`, res.status);
      if (call.status && call.status !== "pending") return call;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new OutLayerError(`OutLayer call ${callId} still pending after ${maxMs} ms`, 408);
  }

  /** Public attestation record of one execution (TDX quote, code and input/output hashes). */
  async attestation(callId: string): Promise<unknown> {
    const res = await this.f(this.url(`/attestations/by-call/${encodeURIComponent(callId)}`), { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new OutLayerError(`attestation ${res.status}`, res.status);
    return res.json();
  }
}
