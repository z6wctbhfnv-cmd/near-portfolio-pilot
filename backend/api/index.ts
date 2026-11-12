/**
 * Vercel entry: every request is routed here (vercel.json) and handed to the same Fastify server
 * the local `npm start` runs. Background work runs from Vercel Cron via GET /v1/cron.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

async function start() {
  const s = buildServer(buildApp(loadConfig()));
  await s.ready();
  return s;
}

let server: ReturnType<typeof start> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  server ??= start();
  const s = await server;
  s.server.emit("request", req, res);
}
