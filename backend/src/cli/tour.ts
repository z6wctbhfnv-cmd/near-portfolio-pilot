/**
 * The judge tour: one command that walks the whole product path and shows the result of every step.
 *
 *   npm run tour            (from the repo root or from backend/)
 *
 * It boots the real backend in this process with a throwaway in-memory database and calls the same
 * HTTP routes the site calls. Prices and history are live public data; the strategy NFT data is read
 * from the testnet contract. Everything trades on paper: no keys, no wallet, no money.
 * Exit code 0 = every step did what it says.
 */
import { buildApp, tick } from "../app.js";
import { loadConfig, loadDotEnv } from "../config.js";
import { openDb } from "../db.js";
import { buildServer } from "../server.js";

process.env.NODE_ENV ??= "test"; // quiet request logs
loadDotEnv();
const cfg = loadConfig({ ...process.env, DATABASE_PATH: ":memory:", SCHEDULER_ENABLED: "false", LIVE_EXECUTION: "false", FEE_PAYMENTS_ENABLED: "false", HL_PERPS_ENABLED: "false", NEAR_PRIVATE_KEY: "" });
const app = buildApp(cfg, { db: openDb(":memory:") });
const server = buildServer(app);

type Json = Record<string, any>;
async function call(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown): Promise<Json> {
  const res = await server.inject({ method, url, payload: payload as never });
  const body = res.json() as Json;
  if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode} ${body?.error?.code ?? ""}: ${body?.error?.message ?? ""}`);
  return body;
}

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const usd = (n: number | null | undefined) => (n == null ? "n/a" : `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct = (x: number | null | undefined) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const say = (s = "") => console.log(s);
const see = (s: string) => console.log(`     ${s}`);
function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`expected: ${what}`);
}

const RULES = "Careful: NEAR, BTC and ETH. Max $300 a day, $50 per trade.";
let passed = 0;
const steps: Array<[string, string, () => Promise<void>]> = [];
const step = (title: string, does: string, fn: () => Promise<void>) => steps.push([title, does, fn]);

let pilotId = "";
let strategy: { id: string; params: Json } = { id: "", params: {} };
let mandate: Json = {};

step("Say it: rules in plain words become exact limits", "POST /v1/mandate/parse", async () => {
  const r = await call("POST", "/v1/mandate/parse", { text: RULES });
  mandate = r.mandate;
  strategy = r.strategy;
  see(`you wrote    "${RULES}"`);
  see(`understood   risk ${r.mandate.risk}; assets ${r.mandate.assets.join(", ")} + ${r.mandate.stable}; ${usd(r.mandate.budget.daily_usd)} a day; ${usd(r.mandate.max_trade_usd)} a trade ${dim(`(by ${r.source === "ai" ? `NEAR AI, ${r.model}` : "the built-in rule parser; set NEARAI_API_KEY for NEAR AI"})`)}`);
  see(`policy       actions ${JSON.stringify(r.policy.actions)}, destinations ${r.policy.destinations.mode} ${JSON.stringify(r.policy.destinations.list)}, budget ${usd(Number(r.policy.budget.daily_usd))}/day`);
  see(`strategy     ${r.strategy.id} ${JSON.stringify(r.strategy.params.weights ?? r.strategy.params.buy)}`);
  check(JSON.stringify(r.policy.actions) === '["swap"]', "the policy allows swaps only");
  check(r.policy.destinations.mode === "only" && r.policy.destinations.list.length === 0, "the policy has no destination: funds cannot leave the wallet");
  check(r.mandate.max_trade_usd === 50 && r.mandate.budget.daily_usd === 300, "the limits match the words");
});

step("Try it on history before any money moves", "POST /v1/strategies/:id/backtest (1 year of real daily prices)", async () => {
  const r = await call("POST", `/v1/strategies/${strategy.id}/backtest`, { params: strategy.params, days: 365 });
  see(`period       ${r.period.from} → ${r.period.to}, ${r.cost_bps} bps cost per swap`);
  see(`strategy     return ${pct(r.metrics.total_return)}, max drawdown ${pct(r.metrics.max_drawdown)}, ${r.activity.trades} trades`);
  see(`buy & hold   return ${pct(r.benchmark_hold.total_return)}, max drawdown ${pct(r.benchmark_hold.max_drawdown)}`);
  see(dim("a backtest is hypothetical: past results do not predict future ones"));
  check(r.metrics.days > 300 && r.activity.strategy_errors === 0, "a full year simulated by the WASM strategy with no errors");
});

step("Start a paper portfolio and get a reason for every move", "POST /v1/pilots, POST /v1/pilots/:id/run", async () => {
  const c = await call("POST", "/v1/pilots", { name: "Judge tour", mode: "paper", mandate, strategy, initial_usd: 1000 });
  pilotId = c.pilot.id;
  const run = await call("POST", `/v1/pilots/${pilotId}/run`);
  check(run.status === "ok", `the run finished ok (${run.error ?? ""})`);
  see(`engine       ${run.engine} WASM ${String(run.wasm_sha256).slice(0, 12)}… (the binary built to run in OutLayer's TEE)`);
  see(`why          ${(run.output.notes ?? []).join("; ")}`);
  for (const t of run.output.trades as Json[]) see(`wanted       ${t.sell} → ${t.buy} ${usd(t.usd)}`);
  for (const e of run.executions as Json[]) see(`done         ${e.sell_symbol} → ${e.buy_symbol} ${usd(e.usd)} ${e.status}${e.error_code ? ` (${e.error_code})` : ""}`);
  const filled = (run.executions as Json[]).filter((e) => e.status === "paper_filled");
  check(filled.length > 0, "at least one paper trade filled");
  check(filled.every((e) => e.usd <= 50.01), "no trade is larger than the $50 the rules allow");
  const wanted = (run.output.trades as Json[]).reduce((a, t) => a + t.usd, 0);
  const done = filled.reduce((a, e) => a + e.usd, 0);
  if (done + 1 < wanted) see(green(`your rules won: the strategy wanted ${usd(wanted)}, the limits let ${usd(done)} through; the rest follows on later runs`));
  const pf = await call("GET", `/v1/pilots/${pilotId}/portfolio`);
  see(`portfolio    ${usd(pf.total_usd)}: ${(pf.rows as Json[]).map((r) => `${r.symbol} ${usd(r.usd)}`).join(", ")}`);
});

step("Copy a strategy NFT: your agent follows it inside your own rules", "GET /v1/scripts/:token/gate, POST /v1/pilots/:id/follow, GET /v1/pilots/:id/fees", async () => {
  const token = "wasm-trend@v1";
  const gate = await call("GET", `/v1/scripts/${encodeURIComponent(token)}/gate`);
  see(`on chain     ${token} on ${cfg.STRATEGY_NFT_CONTRACT ?? "(no contract configured)"}: holder ${gate.holder ?? "n/a"}, bond ${usd(gate.held_usd)} of ${usd(gate.required_usd)} required`);
  see(`copy gate    ${gate.open ? "open" : "closed"}: ${gate.reason}`);
  const f = await call("POST", `/v1/pilots/${pilotId}/follow`, { token_id: token });
  check(f.pilot.following?.token_id === token && f.pilot.strategy.id === "trend", "the pilot now runs the copied script");
  see(`following    ${f.pilot.following.token_id} → strategy ${f.pilot.strategy.id}`);
  see(`note         ${f.note}`);
  const run = await call("POST", `/v1/pilots/${pilotId}/run`);
  check(run.status === "ok" && run.input.strategy === "trend", "a run of the copied script finished ok");
  see(`copied run   ${(run.output.notes ?? []).slice(0, 3).join("; ")}`);
  const fees = await call("GET", `/v1/pilots/${pilotId}/fees`);
  const holderBps = (fees.estimate?.payment_bps ?? fees.terms.holder_bps_default + fees.terms.platform_bps) - fees.terms.platform_bps;
  see(`fees         ${holderBps / 100}% of new profit to the NFT holder + ${fees.terms.platform_bps / 100}% to dolya, weekly, only above the previous peak`);
  if (fees.estimate) see(`this week    value ${usd(fees.estimate.equity_usd)}, peak ${usd(fees.estimate.peak_usd)}, new profit ${usd(fees.estimate.profit_usd)} → fee ${usd(fees.estimate.fee_usd)}`);
  check(fees.terms.platform_bps === 25, "platform fee is 0.25%");
  const bad = await server.inject({ method: "POST", url: `/v1/pilots/${pilotId}/follow`, payload: { token_id: "donchian-breakout@v1" } });
  check(bad.statusCode === 409, "a research-only script is refused with a reason");
  see(`refused      donchian-breakout@v1: ${(bad.json() as Json).error.message}`);
});

step("Daily health check asks the owner: Pause or Keep running", "POST /v1/pilots/:id/health/check", async () => {
  const h = await call("POST", `/v1/pilots/${pilotId}/health/check`, {});
  check(Array.isArray(h.findings) && h.findings.length > 0, "the check produced findings");
  see(`status       ${h.status}`);
  for (const f of (h.findings as Json[]).slice(0, 4)) see(`${String(f.severity).padEnd(12)} ${f.detail}`);
  see(h.question ? `question     ${h.question.text} [${h.question.options.map((o: Json) => o.label).join(" / ")}]` : dim("nothing needs the owner's decision today"));
});

step("A task in words: the backend watches the price and trades once", "POST /v1/pilots/:id/tasks, then one scheduler tick", async () => {
  await call("POST", `/v1/pilots/${pilotId}/unfollow`, {});
  const t = await call("POST", `/v1/pilots/${pilotId}/tasks`, { asset: "BTC", op: "<", price: 10_000_000, side: "buy", usd: 25, text: "if BTC below 10,000,000 buy $25" });
  see(`task         when BTC < $10,000,000: buy $25 once ${dim("(a condition that holds now, so the tour can show it firing)")}`);
  const far = await call("POST", `/v1/pilots/${pilotId}/tasks`, { asset: "BTC", op: "<", price: 1, side: "buy", usd: 25 });
  await app.pilots.update(pilotId, { next_run_at: Date.now() + 3_600_000 });
  await tick(app);
  const tasks = (await call("GET", `/v1/pilots/${pilotId}/tasks`)).data as Json[];
  const fired = tasks.find((x) => x.id === t.id)!;
  check(fired.status === "done" && fired.fired_price > 0, "the task fired once and is done");
  check(tasks.find((x) => x.id === far.id)!.status === "active", "a task whose price was not reached keeps waiting");
  see(`fired        at BTC ${usd(fired.fired_price)} → ${fired.result?.[0]?.status} ${usd(fired.result?.[0]?.usd)}`);
  see("waiting      when BTC < $1: still watching");
  await call("DELETE", `/v1/pilots/${pilotId}/tasks/${far.id}`);
});

step("Agent swarm: several scripts share one wallet", "PUT /v1/pilots/:id/swarm, POST /v1/pilots/:id/run", async () => {
  const w = Object.fromEntries((mandate.assets as string[]).map((a) => [a, Number((0.6 / mandate.assets.length).toFixed(4))]));
  await call("PUT", `/v1/pilots/${pilotId}/swarm`, { scripts: [{ key: "mix", id: "rebalance", params: { weights: w } }, { key: "trend", id: "trend", params: { weights: w } }], allocation: "equal" });
  const run = await call("POST", `/v1/pilots/${pilotId}/run`);
  check(run.status === "ok" && Array.isArray(run.output.agents) && run.output.agents.length === 2, "the swarm run finished with two script agents");
  for (const a of run.output.agents as Json[]) see(`agent ${String(a.key).padEnd(6)} ${a.strategy}, sleeve ${usd(a.value_usd)}, wants ${(a.trades ?? []).length} trade(s)${a.skipped ? `, skipped: ${a.skipped}` : ""}`);
  const crossed = Object.entries(run.output.plan?.crossed ?? {}).filter(([, v]) => Number(v) > 0.005);
  see(`main agent   netted ${crossed.length ? crossed.map(([a, v]) => `${usd(Number(v))} of ${a}`).join(", ") : "nothing"} inside the wallet; sent ${(run.output.trades ?? []).length} net trade(s); dropped ${(run.output.plan?.dropped ?? []).length} outside the policy`);
  const s = await call("GET", `/v1/pilots/${pilotId}/swarm`);
  see(`split        ${(s.state?.sleeves as Json[] | undefined)?.map((x) => `${x.key} ${usd(x.value_usd)}`).join(", ") ?? "starts on the next run"}`);
  await call("DELETE", `/v1/pilots/${pilotId}/swarm`);
});

step("Weekly review: one AI agent reads the week, it cannot trade", "POST /v1/pilots/:id/review", async () => {
  const r = await call("POST", `/v1/pilots/${pilotId}/review`, {});
  check(typeof r.summary === "string" && r.summary.length > 10, "the review has a summary");
  see(`by           ${r.source === "ai" ? `NEAR AI (${r.model})` : "the rule-based reviewer (set NEARAI_API_KEY for NEAR AI)"}`);
  see(`summary      ${r.summary}`);
  see(`proposals    ${r.proposals.accepted.length} accepted, ${r.proposals.rejected.length} rejected ${dim("(only whitelisted parameters, at most ±25%, applied only if the owner agrees)")}`);
});

step("Freeze: one tap and nothing trades", "PATCH /v1/pilots/:id {paused: true}, then one scheduler tick", async () => {
  const before = ((await call("GET", `/v1/pilots/${pilotId}/runs`)).data as Json[]).length;
  const p = await call("PATCH", `/v1/pilots/${pilotId}`, { paused: true });
  check(p.pilot.status === "paused", "the pilot is paused");
  await app.pilots.update(pilotId, { next_run_at: Date.now() - 1 });
  await tick(app);
  const after = ((await call("GET", `/v1/pilots/${pilotId}/runs`)).data as Json[]).length;
  check(after === before, "a paused pilot is not run by the scheduler");
  see(`paused       scheduler tick ran: ${after - before} new runs`);
  const manual = await server.inject({ method: "POST", url: `/v1/pilots/${pilotId}/run` });
  see(`manual run   ${manual.statusCode === 200 ? "allowed (the owner asked for it)" : `refused: ${(manual.json() as Json).error?.message}`}`);
  await call("PATCH", `/v1/pilots/${pilotId}`, { paused: false });
  see("resumed      the pilot is active again");
});

const started = Date.now();
say(bold("\ndolya judge tour") + dim("  paper money, live public prices, strategy NFTs read from NEAR testnet\n"));
if (!app.wasm.available()) {
  say(red("The strategy WASM is missing (backend/wasm/pilot-strategies.wasm). Run `npm run build:wasm` in backend/."));
  process.exit(1);
}
let failed = false;
for (let i = 0; i < steps.length; i++) {
  const [title, does, fn] = steps[i]!;
  say(bold(`${String(i + 1).padStart(2)}. ${title}`));
  say(dim(`     do  ${does}`));
  try {
    await fn();
    passed++;
    say(green("     ✓ ok\n"));
  } catch (e) {
    failed = true;
    say(red(`     ✗ ${(e as Error).message}\n`));
    if (!pilotId && i >= 2) break; // nothing later can work without the pilot
  }
}
say(bold(`${passed}/${steps.length} steps passed`) + dim(` in ${((Date.now() - started) / 1000).toFixed(1)} s. Prices from ${app.gateway.priceSource ?? "n/a"}.`));
await server.close();
process.exit(failed ? 1 : 0);
