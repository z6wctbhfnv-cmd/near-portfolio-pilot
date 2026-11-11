/** Minimal client for NEAR AI Cloud (OpenAI-compatible chat completions). */

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export class NearAiClient {
  constructor(
    private readonly opts: { apiKey?: string; baseUrl: string; model: string; fetch?: typeof fetch; timeoutMs?: number },
  ) {}

  get configured() {
    return Boolean(this.opts.apiKey);
  }
  get model() {
    return this.opts.model;
  }

  async chat(messages: ChatMessage[], { temperature = 0.1, maxTokens = 1500 } = {}): Promise<string> {
    if (!this.opts.apiKey) throw new Error("NEARAI_API_KEY is not set");
    const f = this.opts.fetch ?? fetch;
    const res = await f(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify({ model: this.opts.model, messages, temperature, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`NEAR AI ${res.status}: ${text.slice(0, 300)}`);
    const body = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") throw new Error("NEAR AI returned no content");
    return content;
  }

  /** Asks for JSON and returns the first JSON object in the answer (code fences tolerated). */
  async chatJson(messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number }): Promise<unknown> {
    const content = await this.chat(messages, opts);
    return extractJson(content);
  }

  /** GET /model/list: ids of the models the cloud currently serves. */
  async listModels(): Promise<string[]> {
    const f = this.opts.fetch ?? fetch;
    const res = await f(`${this.opts.baseUrl.replace(/\/$/, "")}/model/list`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`NEAR AI model list ${res.status}`);
    const body = (await res.json()) as { models?: Array<{ modelId?: string; id?: string }> };
    return (body.models ?? []).map((m) => m.modelId ?? m.id ?? "").filter(Boolean);
  }
}

export function extractJson(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : content;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model answer");
  return JSON.parse(candidate.slice(start, end + 1));
}
