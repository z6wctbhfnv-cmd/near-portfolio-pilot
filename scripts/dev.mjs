#!/usr/bin/env node
// Starts the whole product locally: the backend (paper mode, no keys needed) and the dolya site.
//   npm run dev        → backend on http://127.0.0.1:8787, site on http://localhost:3000
// Ctrl+C stops both. Ports: BACKEND_PORT and SITE_PORT.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const dir of ["backend", "frontend"]) {
  if (!existsSync(resolve(root, dir, "node_modules"))) {
    console.error(`Dependencies are missing in ${dir}/. Run: npm run setup`);
    process.exit(1);
  }
}
const backendPort = process.env.BACKEND_PORT ?? "8787";
const sitePort = process.env.SITE_PORT ?? "3000";
const api = `http://127.0.0.1:${backendPort}`;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [];
function run(name, cwd, args, env) {
  const child = spawn(npm, args, { cwd: resolve(root, cwd), env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const tag = `[${name}] `;
  const pipe = (stream, out) => stream.on("data", (b) => out.write(String(b).split("\n").filter(Boolean).map((l) => tag + l).join("\n") + "\n"));
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => { if (!stopping) { console.error(`${tag}stopped (code ${code}); stopping the rest`); stop(1); } });
  children.push(child);
}
let stopping = false;
function stop(code = 0) {
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

run("backend", "backend", ["start"], { PORT: backendPort, HOST: "127.0.0.1", LOG_LEVEL: process.env.LOG_LEVEL ?? "warn" });
run("site", "frontend", ["exec", "--", "next", "dev", "-p", sitePort], { NEXT_PUBLIC_API_BASE: api });

const up = async (url) => { try { return (await fetch(url)).ok; } catch { return false; } };
for (let i = 0; i < 240 && !stopping; i++) {
  // The site's first page compiles on demand, so the first answer can take a while.
  if ((await up(`${api}/health`)) && (await up(`http://localhost:${sitePort}/`))) {
    console.log(`\n  dolya is running (paper mode: no keys, no money)\n  site     http://localhost:${sitePort}\n  backend  ${api}\n  Open the site → Portfolio → "Start with $1,000 of paper money".\n  Ctrl+C stops both.\n`);
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
