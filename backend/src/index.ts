import { buildApp, startScheduler } from "./app.js";
import { describeConfig, loadConfig, loadDotEnv } from "./config.js";
import { buildServer } from "./server.js";

loadDotEnv();
const cfg = loadConfig();
const app = buildApp(cfg);
const server = buildServer(app);

server.log.info({ config: describeConfig(cfg) }, "NEAR Portfolio Pilot backend");
if (!app.wasm.available()) server.log.warn("strategy WASM not found: run `npm run build:wasm` (backtests and local runs need it)");
if (cfg.LIVE_EXECUTION) server.log.warn("LIVE_EXECUTION is ON: live pilots send real swaps on NEAR Intents mainnet");

const stop = cfg.SCHEDULER_ENABLED ? startScheduler(app, Math.min(cfg.TICK_MINUTES, 5) * 60_000) : () => undefined;
await server.listen({ port: cfg.PORT, host: cfg.HOST });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    stop();
    await server.close();
    app.db.close();
    process.exit(0);
  });
}
