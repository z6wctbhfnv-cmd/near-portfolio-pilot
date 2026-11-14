/**
 * Changed starter scripts. Everyone starts with the same nine starter strategies; a user changes
 * one (its parameters) and mints the result as their own script NFT. Such a script is one of the
 * engine's strategies plus a fixed set of parameters, so dolya's runner executes it exactly:
 *
 *   code_hash = sha256("dolya-script-v1\n" + canonical JSON of { base, params })
 *
 * The contract stores only the hash. The backend keeps the script itself (base + params) in the
 * `scripts` table, so a copier's pilot can run it; anyone can recompute the hash and check it.
 */
import { createHash } from "node:crypto";
import type { App } from "./app.js";
import { json, parse } from "./db.js";
import { isStrategyId, parseStrategyParams, STRATEGY_INFO, type StrategyId } from "./strategies.js";

export const SCRIPT_PREFIX = "dolya-script-v1\n";

/** JSON with object keys sorted at every level, so equal scripts give equal bytes. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export type Script = { code_hash: string; base: StrategyId; base_name: string; params: Record<string, unknown>; name: string | null };

export function scriptHash(base: string, params: Record<string, unknown>): string {
  return createHash("sha256").update(SCRIPT_PREFIX + canonical({ base, params })).digest("hex");
}

/** Validates a changed starter (filling defaults), stores it and returns its code hash. */
export async function registerScript(app: App, base: string, params: unknown, name?: string | null): Promise<Script> {
  if (!isStrategyId(base)) throw new Error(`unknown starter script: ${base}`);
  const full = parseStrategyParams(base, params);
  const code_hash = scriptHash(base, full);
  await app.db
    .prepare("INSERT OR IGNORE INTO scripts (code_hash, base, params_json, name, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(code_hash, base, json(full)!, name ?? null, Date.now());
  return { code_hash, base, base_name: STRATEGY_INFO[base].name, params: full, name: name ?? null };
}

export async function scriptByHash(app: App, codeHash: string): Promise<Script | null> {
  const row = (await app.db.prepare("SELECT code_hash, base, params_json, name FROM scripts WHERE code_hash = ?").get(codeHash.toLowerCase())) as
    | { code_hash: string; base: string; params_json: string; name: string | null }
    | undefined;
  if (!row || !isStrategyId(row.base)) return null;
  return { code_hash: row.code_hash, base: row.base, base_name: STRATEGY_INFO[row.base].name, params: parse(row.params_json, {}), name: row.name };
}

/** The changed starter a script NFT stands for, looked up by the code hash the contract stores. */
export async function scriptForToken(app: App, tokenId: string): Promise<Script | null> {
  if (!app.nft.contract) return null;
  const info = await app.nft.strategyInfo(tokenId);
  return info ? scriptByHash(app, info.code_hash) : null;
}
