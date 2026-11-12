/** HTTP API (Fastify). Every route the web UI and the IronClaw skill use. */
import cors from "@fastify/cors";
import { AgentApiError, AgentApiRequestError, type GenerateIntentRequest, type OwnerWallet, type SignedData } from "@near-intents-agent-api/sdk";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ConfigError, NotFound } from "./agent.js";
import { type App, applyIntentResult, tick } from "./app.js";
import { backtest } from "./backtest.js";
import { describeConfig } from "./config.js";
import { json, parse } from "./db.js";
import { compilePolicy, type Mandate, MandateSchema, parseMandate, strategyForMandate } from "./mandate.js";
import { scriptCodeHash } from "./nft.js";
import { catalog, isStrategyId, parseStrategyParams, STRATEGY_IDS, type StrategyId } from "./strategies.js";
import { DEFAULT_UNIVERSE, universeBySymbol } from "./tokens.js";

const DAY = 86_400_000;
export const RISK_NOTICE =
  "The Agent API is an experimental, mainnet-only beta. You and your users may lose all assets used with it, or lose access to them. It is operated by NEAR Technologies Limited. NEAR Portfolio Pilot is an unaudited hackathon prototype; read DISCLAIMER.md.";
const PUBLIC = new Set(["/health", "/v1/config", "/v1/cron"]);

const SCRIPT_PROMPT = `You write trading scripts for Pilot. Output ONLY Python code, no prose, no markdown fences.
Exactly one function: def target(daily):
- daily is a pandas DataFrame of daily closes, columns BTC, ETH, SOL, NEAR, XAUT, plus funding columns
  "BTC-FUND", "ETH-FUND", "SOL-FUND", "NEAR-FUND" (funding a long paid that day). Rows end today.
- Return a dict of weights. Spot keys: BTC, ETH, SOL, NEAR, USDC (>= 0, spot + USDC = 1).
  Perp keys: BTC-PERP, ETH-PERP, SOL-PERP, NEAR-PERP (signed, negative = short, |w| <= 1).
- Use only \`np\`, \`math\`, built-ins like min/max/len/sum/abs. No imports, no files, no lambda, no classes.
- Deterministic. Handle short history (return {"USDC": 1.0}).`;

const stripFences = (t: string) => (t.match(/```(?:python)?\n([\s\S]*?)```/)?.[1] ?? t).trim() + "\n";

/** The id an owner is known by: NEAR account, EVM address or passkey credential id. */
const ownerKey = (o: unknown) => {
  const x = o as { type?: string; account_id?: string; address?: string; credential_id?: string } | undefined;
  return (x?.type === "near" ? x.account_id : x?.type === "evm" ? x.address?.toLowerCase() : x?.credential_id) ?? "";
};

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const OwnerSchema = z.union([
  z.object({ type: z.literal("near"), account_id: z.string().min(2), public_key: z.string().startsWith("ed25519:") }),
  z.object({ type: z.literal("evm"), address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), chain_id: z.number().int(), public_key: z.string() }),
  z.object({ type: z.literal("passkey"), credential_id: z.string(), public_key: z.string(), rp_id: z.string(), origin: z.string().url() }),
]);

const StrategyBody = z.object({ id: z.enum(STRATEGY_IDS as [StrategyId, ...StrategyId[]]), params: z.record(z.string(), z.unknown()).default({}) });

const CreatePilot = z
  .object({
    name: z.string().min(1).max(80),
    mode: z.enum(["paper", "live"]).default("paper"),
    text: z.string().max(4000).optional(),
    mandate: z.unknown().optional(),
    strategy: StrategyBody.optional(),
    initial_usd: z.number().positive().max(10_000_000).default(1000),
    owner: OwnerSchema.optional(),
    accepted_terms: z.boolean().optional(),
    review_auto_apply: z.boolean().default(false),
  })
  .refine((b) => b.mode === "paper" || b.owner, { message: "a live pilot needs `owner`", path: ["owner"] })
  .refine((b) => b.mode === "paper" || b.accepted_terms === true, {
    message: "a live pilot needs `accepted_terms: true` after the owner was shown the Owner Terms, OutLayer's terms and the risk notice",
    path: ["accepted_terms"],
  });

function body<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new HttpError(400, "validation_failed", r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

export function buildServer(app: App) {
  const server = Fastify({ logger: process.env.NODE_ENV === "test" ? false : { level: "info" }, bodyLimit: 1_000_000 });
  // Browsers may call from CORS_ORIGINS only (comma-separated); unset = any origin (local development).
  const origins = app.cfg.CORS_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean);
  // PATCH and PUT are needed by the web apps (pause/freeze, change strategy); the default allows only GET, HEAD, POST.
  void server.register(cors, { origin: origins?.length ? origins : true, methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] });

  server.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const token = app.cfg.PILOT_API_TOKEN;
    if (!token || PUBLIC.has(req.url.split("?")[0]!) || req.method === "OPTIONS") return;
    const got = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const a = Buffer.from(got);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "missing or wrong bearer token" } });
    }
  });

  server.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    if (err instanceof NotFound) return reply.code(404).send({ error: { code: "not_found", message: err.message } });
    if (err instanceof ConfigError) return reply.code(503).send({ error: { code: "not_configured", message: err.message } });
    if (err instanceof AgentApiError) {
      return reply.code(err.status >= 400 && err.status < 600 ? err.status : 502).send({
        error: { code: err.code, layer: err.layer, message: err.detail ?? err.title, retryable: err.retryable, available_at: err.availableAt, request_id: err.requestId },
      });
    }
    if (err instanceof AgentApiRequestError) return reply.code(502).send({ error: { code: "agent_api_unreachable", message: err.message } });
    if (err.validation || err.statusCode === 400) return reply.code(400).send({ error: { code: "bad_request", message: err.message } });
    server.log.error(err);
    return reply.code(500).send({ error: { code: "internal_error", message: err.message } });
  });

  const pilotOr404 = async (id: string) => {
    const p = await app.pilots.get(id);
    if (!p) throw new NotFound(`pilot ${id} not found`);
    return p;
  };
  const liveAgent = async (id: string) => {
    const p = await pilotOr404(id);
    if (p.mode !== "live" || !p.agent_id) throw new HttpError(409, "no_agent", "this pilot has no Agent API agent (paper pilot, or the owner has not signed agent_create yet)");
    return { pilot: p, agentId: p.agent_id };
  };

  // ------------------------------------------------------------ meta

  server.get("/health", async () => ({ ok: true, wasm: app.wasm.available(), time: new Date().toISOString() }));
  server.get("/v1/config", async () => ({ ...describeConfig(app.cfg), wasm_sha256: app.wasm.available() ? app.wasm.wasmSha256 : null }));
  server.get("/v1/network", async () => app.gateway.network());
  server.get("/v1/universe", async () => {
    const u = await app.catalog.universe();
    return { data: u.map((a) => ({ symbol: a.symbol, asset_id: a.asset_id, stable: a.stable, decimals: a.token?.decimals ?? null, price: a.price, listed: Boolean(a.token) })) };
  });
  server.get("/v1/strategies", async () => ({ data: catalog() }));

  // Background work for serverless deploys: Vercel Cron calls this with "Authorization: Bearer
  // <CRON_SECRET>". Without CRON_SECRET the route is off (the local server runs its own scheduler).
  server.get("/v1/cron", async (req) => {
    const secret = app.cfg.CRON_SECRET;
    const got = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!secret || got.length !== secret.length || !timingSafeEqual(Buffer.from(got), Buffer.from(secret))) {
      throw new HttpError(401, "unauthorized", "cron secret required");
    }
    const started = Date.now();
    await tick(app);
    return { ok: true, ms: Date.now() - started };
  });

  // A user script drafted by NEAR AI from the owner's idea. The model only drafts: the web app
  // checks the code and the owner backtests it before anything is minted. Nothing here runs it.
  server.post("/v1/scripts/draft", async (req) => {
    const b = body(z.object({ idea: z.string().min(3).max(1000) }), req.body);
    if (!app.ai.configured) throw new HttpError(503, "not_configured", "NEARAI_API_KEY is not set");
    let answer: string;
    try {
      answer = await app.ai.chat([{ role: "system", content: SCRIPT_PROMPT }, { role: "user", content: b.idea }], { temperature: 0 });
    } catch (e) {
      // e.g. 402 when the NEAR AI organization has no credits; the owner can still write the script by hand.
      throw new HttpError(503, "ai_unavailable", `NEAR AI is unavailable: ${(e as Error).message.slice(0, 200)}`);
    }
    return { code: stripFences(answer), model: app.ai.model };
  });

  server.post("/v1/strategies/:id/backtest", async (req) => {
    const { id } = req.params as { id: string };
    if (!isStrategyId(id)) throw new NotFound(`unknown strategy ${id}`);
    const b = body(
      z.object({
        params: z.record(z.string(), z.unknown()),
        days: z.number().int().min(14).max(3650).default(365),
        to: z.string().optional(),
        initial_usd: z.number().positive().default(1000),
        cost_bps: z.number().min(0).max(500).default(app.cfg.PAPER_COST_BPS),
      }),
      req.body,
    );
    const to = b.to ? Date.parse(b.to) : Date.now() - DAY;
    if (!Number.isFinite(to)) throw new HttpError(400, "validation_failed", "`to` is not a date");
    if (!app.wasm.available()) throw new HttpError(503, "wasm_missing", "strategy WASM is not built: run `npm run build:wasm`");
    try {
      return await backtest(app.wasm, app.history, { strategy: id, params: b.params, from: to - b.days * DAY, to, initial_usd: b.initial_usd, cost_bps: b.cost_bps });
    } catch (e) {
      throw new HttpError(400, "backtest_failed", (e as Error).message);
    }
  });

  // ------------------------------------------------------------ mandate

  server.post("/v1/mandate/parse", async (req) => {
    const b = body(z.object({ text: z.string().min(3).max(4000) }), req.body);
    const parsed = await parseMandate(b.text, app.ai);
    return { ...parsed, ...(await compileFor(parsed.mandate)) };
  });

  server.post("/v1/mandate/compile", async (req) => {
    const b = body(z.object({ mandate: z.unknown() }), req.body);
    return compileFor(body(MandateSchema, b.mandate));
  });

  async function compileFor(mandate: Mandate) {
    const tokens = await app.catalog.all().catch(() => []);
    const { policy, warnings } = compilePolicy(mandate, tokens);
    let strategy: { id: StrategyId; params: Record<string, unknown> };
    try {
      strategy = strategyForMandate(mandate);
    } catch (e) {
      throw new HttpError(400, "validation_failed", (e as Error).message);
    }
    return { mandate, policy, strategy, warnings: tokens.length ? warnings : [...warnings, "token list unavailable: no per-asset limits"] };
  }

  // ------------------------------------------------------------ pilots

  server.post("/v1/pilots", async (req, reply) => {
    const b = body(CreatePilot, req.body);
    let mandate: Mandate | null = null;
    let notes: string[] = [];
    if (b.text) {
      const parsed = await parseMandate(b.text, app.ai);
      mandate = parsed.mandate;
      notes = parsed.notes;
    } else if (b.mandate) {
      mandate = body(MandateSchema, b.mandate);
    }
    let strategy: { id: StrategyId; params: Record<string, unknown> };
    try {
      strategy = b.strategy ? { id: b.strategy.id, params: parseStrategyParams(b.strategy.id, b.strategy.params) } : mandate ? strategyForMandate(mandate) : (() => {
        throw new Error("give `text`, `mandate` or `strategy`");
      })();
    } catch (e) {
      throw new HttpError(400, "validation_failed", (e as Error).message);
    }
    mandate ??= MandateSchema.parse({});

    if (b.mode === "paper") {
      const stable = String(strategy.params.stable ?? "USDC");
      const p = await app.pilots.create({
        name: b.name,
        mode: "paper",
        status: "active",
        mandate,
        strategy,
        paper_holdings: { [stable]: b.initial_usd },
        review_auto_apply: b.review_auto_apply,
        review_every_days: app.cfg.REVIEW_EVERY_DAYS,
      });
      return reply.code(201).send({ pilot: p, notes });
    }

    // Live: compile the policy and prepare agent_create for the owner's wallet.
    const allow = app.cfg.LIVE_OWNERS?.split(",").map((o) => o.trim()).filter(Boolean);
    if (allow?.length && !allow.includes(ownerKey(b.owner))) {
      throw new HttpError(403, "owner_not_allowed", "live pilots are open by invitation: this owner is not on LIVE_OWNERS");
    }
    app.gateway.api(); // fails fast (503 not_configured) before anything is stored
    const tokens = await app.catalog.all();
    const { policy, warnings } = compilePolicy(mandate, tokens);
    const p = await app.pilots.create({
      name: b.name,
      mode: "live",
      status: "pending_owner",
      owner: b.owner,
      mandate,
      policy,
      strategy,
      review_auto_apply: b.review_auto_apply,
      review_every_days: app.cfg.REVIEW_EVERY_DAYS,
    });
    const evidence = { accepted_terms: true, at: new Date().toISOString(), ip: req.ip, user_agent: req.headers["user-agent"] ?? null };
    let generated;
    try {
      generated = await app.gateway.generate(
        { type: "agent_create", name: b.name, external_user_id: p!.id, owner: b.owner as OwnerWallet, policy } as GenerateIntentRequest,
        p!.id,
        { policy, mandate, terms_evidence: evidence },
      );
    } catch (e) {
      await app.db.prepare("DELETE FROM pilots WHERE id = ?").run(p!.id); // nothing to sign: no half-created pilot
      throw e;
    }
    return reply.code(201).send({ pilot: p, owner_action: generated, warnings, notes });
  });

  server.get("/v1/pilots", async () => ({ data: await app.pilots.list() }));

  server.get("/v1/pilots/:id", async (req) => {
    const p = await pilotOr404((req.params as { id: string }).id);
    let agent: unknown = null;
    let policy: unknown = null;
    if (p.agent_id && app.gateway.hasKey) {
      [agent, policy] = await Promise.all([
        app.gateway.api().getAgent(p.agent_id).catch((e: Error) => ({ error: e.message })),
        app.gateway.api().getPolicy(p.agent_id).catch((e: Error) => ({ error: e.message })),
      ]);
    }
    return { pilot: p, agent, live_policy: policy, intents: await app.gateway.pendingIntents(p.id) };
  });

  server.patch("/v1/pilots/:id", async (req) => {
    const p = await pilotOr404((req.params as { id: string }).id);
    const b = body(
      z.object({
        name: z.string().min(1).max(80).optional(),
        review_auto_apply: z.boolean().optional(),
        paused: z.boolean().optional(),
        // The owner's drawdown stop: switch it off or on, or move the level (2%..90% below the peak).
        drawdown_stop: z.object({ enabled: z.boolean().optional(), max_drawdown: z.number().min(0.02).max(0.9).optional() }).optional(),
      }),
      req.body,
    );
    const mandate = b.drawdown_stop && p.mandate ? { ...p.mandate, drawdown_stop: { ...p.mandate.drawdown_stop, ...b.drawdown_stop } } : null;
    if (b.paused === true && p.status !== "active") throw new HttpError(409, "bad_state", `only an active pilot can be paused (it is ${p.status})`);
    if (b.paused === false && p.status !== "paused") throw new HttpError(409, "bad_state", `only a paused pilot can be resumed (it is ${p.status})`);
    return {
      pilot: await app.pilots.update(p.id, {
        ...(b.name ? { name: b.name } : {}),
        ...(b.review_auto_apply !== undefined ? { review_auto_apply: b.review_auto_apply ? 1 : 0 } : {}),
        // Pausing stops the scheduler from running this pilot. Freezing the agent itself is the owner's
        // own signed action (POST /freeze), which also stops the API from executing anything.
        ...(b.paused === true ? { status: "paused" } : b.paused === false ? { status: "active", next_run_at: Date.now(), risk_since: Date.now() } : {}),
        // Resuming (or changing the stop) restarts the peak, so a stop that fired does not fire again at once.
        ...(mandate ? { mandate_json: JSON.stringify(mandate), risk_since: Date.now() } : {}),
      }),
    };
  });

  server.put("/v1/pilots/:id/strategy", async (req) => {
    const p = await pilotOr404((req.params as { id: string }).id);
    const b = body(StrategyBody, req.body);
    let params: Record<string, unknown>;
    try {
      params = parseStrategyParams(b.id, b.params);
    } catch (e) {
      throw new HttpError(400, "validation_failed", (e as Error).message);
    }
    if (p.mode === "live" && p.policy) {
      const allowed = new Set(((p.policy as { assets: string[] | "any" }).assets === "any" ? DEFAULT_UNIVERSE.map((a) => a.asset_id) : (p.policy as { assets: string[] }).assets));
      const sym = Object.keys((b.id === "dca" ? params.buy : params.weights) as Record<string, number>).concat(String(params.stable));
      const outside = sym.filter((s) => !allowed.has(universeBySymbol(s)?.asset_id ?? ""));
      if (outside.length) throw new HttpError(409, "outside_policy", `the signed policy does not allow ${outside.join(", ")}; update the policy first`);
    }
    return { pilot: await app.pilots.update(p.id, { strategy_id: b.id, strategy_params_json: json(params)!, ...(b.id !== p.strategy.id ? { strategy_state_json: "{}" } : {}) }) };
  });

  server.get("/v1/pilots/:id/portfolio", async (req) => {
    const p = await pilotOr404((req.params as { id: string }).id);
    const { holdings, source } = await app.runner.holdings(p);
    const val = await app.runner.valuation(holdings);
    return { pilot_id: p.id, source, ...val };
  });

  server.post("/v1/pilots/:id/run", async (req) => {
    const p = await pilotOr404((req.params as { id: string }).id);
    if (p.status === "pending_owner") throw new HttpError(409, "bad_state", "the owner has not signed agent_create yet");
    // Freeze means everything stops until the owner resumes, manual runs included.
    if (p.status === "paused" || p.status === "frozen" || p.status === "archived") {
      throw new HttpError(409, "bad_state", `the pilot is ${p.status}: resume it before running`);
    }
    if (p.mode === "live" && !p.agent_id) throw new HttpError(409, "no_agent", "no agent yet");
    if (!app.wasm.available() && !app.outlayer.configured) throw new HttpError(503, "wasm_missing", "strategy WASM is not built: run `npm run build:wasm`");
    try {
      return await app.runner.run(p.id, { reason: "manual" });
    } catch (e) {
      throw new HttpError(409, "run_in_progress", (e as Error).message);
    }
  });

  server.get("/v1/pilots/:id/runs", async (req) => {
    const p = await pilotOr404((req.params as { id: string }).id);
    const limit = Math.min(100, Number((req.query as { limit?: string }).limit ?? 20));
    const rows = await app.db.prepare("SELECT id FROM runs WHERE pilot_id = ? ORDER BY started_at DESC LIMIT ?").all<{ id: string }>(p.id, limit);
    return { data: await Promise.all(rows.map((r) => app.runner.getRun(r.id))) };
  });

  server.get("/v1/runs/:id", async (req) => {
    const r = await app.runner.getRun((req.params as { id: string }).id);
    if (!r) throw new NotFound("run not found");
    return r;
  });

  server.get("/v1/pilots/:id/executions", async (req) => {
    const p = await pilotOr404((req.params as { id: string }).id);
    const rows = await app.db.prepare("SELECT * FROM executions WHERE pilot_id = ? ORDER BY created_at DESC LIMIT 200").all<Record<string, unknown>>(p.id);
    return {
      data: rows.map((e) => ({ ...e, request: parse(e.request_json, null), quote: parse(e.quote_json, null), response: parse(e.response_json, null), request_json: undefined, quote_json: undefined, response_json: undefined })),
    };
  });

  server.post("/v1/executions/:id/refresh", async (req) => {
    const r = await app.executor.refresh((req.params as { id: string }).id);
    if (!r) throw new NotFound("execution not found");
    return r;
  });

  server.get("/v1/pilots/:id/snapshots", async (req) => {
    const p = await pilotOr404((req.params as { id: string }).id);
    const rows = await app.db.prepare("SELECT ts, total_usd, holdings_json FROM snapshots WHERE pilot_id = ? ORDER BY ts DESC LIMIT 500").all<Record<string, unknown>>(p.id);
    return { data: rows.map((s) => ({ ts: s.ts, total_usd: s.total_usd, holdings: parse(s.holdings_json, []) })) };
  });

  server.get("/v1/pilots/:id/events", async (req) => {
    const p = await pilotOr404((req.params as { id: string }).id);
    const rows = await app.db.prepare("SELECT ts, level, message, data_json FROM events WHERE pilot_id = ? ORDER BY id DESC LIMIT 200").all<Record<string, unknown>>(p.id);
    return { data: rows.map((e) => ({ ts: e.ts, level: e.level, message: e.message, data: parse(e.data_json, null) })) };
  });

  // ------------------------------------------------------------ reviews

  server.post("/v1/pilots/:id/review", async (req) => {
    const p = await pilotOr404((req.params as { id: string }).id);
    const b = body(z.object({ period_days: z.number().int().min(1).max(90).optional() }), req.body);
    return app.reviewer.review(p.id, { periodDays: b.period_days });
  });
  server.get("/v1/pilots/:id/reviews", async (req) => ({ data: await app.reviewer.list((await pilotOr404((req.params as { id: string }).id)).id) }));
  server.post("/v1/reviews/:id/apply", async (req) => {
    try {
      return app.reviewer.apply((req.params as { id: string }).id);
    } catch (e) {
      throw new HttpError(409, "bad_state", (e as Error).message);
    }
  });
  server.post("/v1/reviews/:id/dismiss", async (req) => (await app.reviewer.dismiss((req.params as { id: string }).id)) ?? {});

  // ------------------------------------------------------------ owner actions (live)

  server.post("/v1/pilots/:id/grants", async (req, reply) => {
    const { pilot, agentId } = await liveAgent((req.params as { id: string }).id);
    const b = body(z.object({ label: z.string().min(1).max(80).default("Portfolio Pilot runner"), ttl_days: z.number().int().min(1).max(365).default(30) }), req.body);
    const g = await app.gateway.issueGrant(pilot.id, agentId, b.label, b.ttl_days);
    return reply.code(201).send({ grant_id: g.grant_id, expires_at: g.expires_at, owner_action: g.generated });
  });

  server.post("/v1/pilots/:id/policy", async (req, reply) => {
    const { pilot, agentId } = await liveAgent((req.params as { id: string }).id);
    const b = body(z.object({ text: z.string().max(4000).optional(), mandate: z.unknown().optional() }), req.body);
    const mandate = b.text ? (await parseMandate(b.text, app.ai)).mandate : b.mandate ? body(MandateSchema, b.mandate) : pilot.mandate;
    if (!mandate) throw new HttpError(400, "validation_failed", "give `text` or `mandate`");
    const current = await app.gateway.api().getPolicy(agentId);
    if (current.revision === null) throw new HttpError(409, "policy_not_ready", "the current policy has no revision yet");
    const { policy, warnings } = compilePolicy(mandate, await app.catalog.all());
    const generated = await app.gateway.generate(
      { type: "policy_update", agent_id: agentId, policy, expected_revision: current.revision } as GenerateIntentRequest,
      pilot.id,
      { policy, mandate },
    );
    return reply.code(201).send({ owner_action: generated, warnings, cooldowns: current.cooldowns });
  });

  for (const action of ["freeze", "unfreeze", "archive"] as const) {
    server.post(`/v1/pilots/:id/${action}`, async (req, reply) => {
      const { pilot, agentId } = await liveAgent((req.params as { id: string }).id);
      const generated = await app.gateway.generate({ type: `agent_${action}`, agent_id: agentId } as GenerateIntentRequest, pilot.id);
      return reply.code(201).send({ owner_action: generated });
    });
  }

  server.post("/v1/pilots/:id/deposit", async (req) => {
    const { agentId } = await liveAgent((req.params as { id: string }).id);
    const b = body(z.object({ origin_asset: z.string().min(3), amount: z.string().regex(/^\d+$/).optional() }), req.body);
    const deposit = await app.gateway.api().deposit(agentId, { origin_asset: b.origin_asset, ...(b.amount ? { amount: b.amount } : {}), confidential: false });
    // The Agent API asks partners to show the risk notice again before the owner funds the wallet.
    return { ...deposit, risk_notice: RISK_NOTICE };
  });

  server.get("/v1/pilots/:id/balances", async (req) => {
    const { agentId } = await liveAgent((req.params as { id: string }).id);
    return app.gateway.api().getBalances(agentId);
  });

  server.get("/v1/pilots/:id/history", async (req) => {
    const { agentId } = await liveAgent((req.params as { id: string }).id);
    return app.gateway.api().getHistory(agentId, { limit: 50 } as never);
  });

  server.get("/v1/pilots/:id/intents", async (req) => ({ data: await app.gateway.pendingIntents((await pilotOr404((req.params as { id: string }).id)).id) }));

  server.post("/v1/intents/:cid/submit", async (req) => {
    const { cid } = req.params as { cid: string };
    const b = body(z.object({ signed_data: z.record(z.string(), z.unknown()) }), req.body);
    const submitted = await app.gateway.submit(cid, b.signed_data as unknown as SignedData);
    const status = await app.gateway.status(cid, 10_000).catch(() => submitted as { status: string });
    if (app.gateway.isTerminal(status.status)) await applyIntentResult(app, cid, status.status);
    return status;
  });

  server.get("/v1/intents/:cid", async (req) => {
    const { cid } = req.params as { cid: string };
    if (!(await app.gateway.intentRow(cid))) throw new NotFound(`unknown correlation_id ${cid}`);
    const waitMs = Number((req.query as { wait_ms?: string }).wait_ms ?? 0);
    const status = await app.gateway.status(cid, Number.isFinite(waitMs) ? waitMs : 0);
    if (app.gateway.isTerminal(status.status)) await applyIntentResult(app, cid, status.status);
    return { status, generated: await app.gateway.generatedOf(cid) };
  });

  // ------------------------------------------------------------ strategy NFT

  server.get("/v1/pilots/:id/nft", async (req) => {
    const p = await pilotOr404((req.params as { id: string }).id);
    const local = await app.db
      .prepare("SELECT id, started_at, engine, input_sha256, output_sha256, wasm_sha256, total_usd, nft_status, nft_tx FROM runs WHERE pilot_id = ? ORDER BY started_at DESC LIMIT 100")
      .all<{ wasm_sha256: string | null }>(p.id);
    const wasm = local.find((r) => r.wasm_sha256)?.wasm_sha256 ?? null;
    const codeHash = wasm ? scriptCodeHash(wasm, p.strategy.id) : null;
    if (!app.nft.contract || !codeHash) return { code_hash: codeHash, token_id: null, contract: app.nft.contract, on_chain: null, local_runs: local };
    const tokenId = await app.nft.tokenByCodeHash(codeHash).catch(() => null);
    const onChain = tokenId ? await app.nft.history(tokenId).catch((e: Error) => ({ error: e.message })) : null;
    return { code_hash: codeHash, token_id: tokenId, contract: app.nft.contract, on_chain: onChain, local_runs: local };
  });

  return server;
}
