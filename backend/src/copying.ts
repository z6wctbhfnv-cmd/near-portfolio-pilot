/**
 * Copying a script someone else holds, and the author bond that keeps copying open.
 *
 * The contract already refuses `follow` while the holder's bond is below
 * max($100, 1% of copiers' capital). That alone is not enough here:
 * - our agents never call `follow` (that would need a NEAR call action in the signed policy), so the
 *   on-chain check never runs for them;
 * - the contract checks only when an agent joins: when copiers' capital grows later, the required
 *   bond rises but nobody already copying is stopped;
 * - `capital` on chain is only what the recorder last reported (set_copied_capital), possibly nothing.
 * So the backend checks before every run of a copied script, against the larger of the contract's
 * required bond and its own count of copiers' capital, and fails closed when it cannot read the bond.
 */
import type { Db } from "./db.js";
import { parse } from "./db.js";
import { ownerNearAccount } from "./fees.js";
import { type NftPublisher, scriptCodeHash } from "./nft.js";

export const MIN_BOND_USD = 100;
export const BOND_SHARE = 0.01;

export type CopyGate = {
  token_id: string | null;
  holder: string | null;
  /** The owner holds this script's NFT: no bond is needed to run your own script. */
  own: boolean;
  held_usd: number | null;
  required_usd: number | null;
  copied_capital_usd: number | null;
  open: boolean;
  reason: string;
};

export const requiredBond = (copiedCapitalUsd: number) => Math.max(MIN_BOND_USD, BOND_SHARE * copiedCapitalUsd);

/**
 * Capital that copies `strategyId` for someone other than its holder: the latest value of every live
 * pilot running it (single script), plus the allocated share of every live swarm pilot that runs it.
 */
export async function copiedCapitalUsd(db: Db, strategyId: string, holder: string | null): Promise<number> {
  const pilots = await db
    .prepare(
      `SELECT p.id, p.owner_json, p.strategy_id, p.swarm_json, p.swarm_state_json,
         (SELECT total_usd FROM snapshots s WHERE s.pilot_id = p.id ORDER BY ts DESC LIMIT 1) AS value
       FROM pilots p WHERE p.mode = 'live' AND p.status IN ('active','paused','frozen')`,
    )
    .all<{ id: string; owner_json: string | null; strategy_id: string; swarm_json: string | null; swarm_state_json: string | null; value: number | null }>();
  let total = 0;
  for (const p of pilots) {
    if (!p.value) continue;
    if (holder && ownerNearAccount(parse(p.owner_json, null)) === holder) continue;
    const swarm = parse<{ scripts?: Array<{ key: string; id: string }> } | null>(p.swarm_json, null);
    if (swarm?.scripts?.length) {
      const alloc = parse<{ alloc?: Record<string, number> }>(p.swarm_state_json, {}).alloc ?? {};
      for (const s of swarm.scripts) if (s.id === strategyId) total += p.value * (alloc[s.key] ?? 0);
    } else if (p.strategy_id === strategyId) {
      total += p.value;
    }
  }
  return total;
}

/** Whether `owner` may run `strategyId` (from WASM `wasmSha256`) as a copier right now. */
export async function copyGate(db: Db, nft: NftPublisher, owner: unknown, strategyId: string, wasmSha256: string | null): Promise<CopyGate> {
  const base = { token_id: null, holder: null, own: false, held_usd: null, required_usd: null, copied_capital_usd: null };
  if (!nft.contract) return { ...base, open: true, reason: "no strategy NFT contract configured" };
  if (!wasmSha256) return { ...base, open: true, reason: "script hash unknown (WASM not built)" };
  try {
    const tokenId = await nft.tokenByCodeHash(scriptCodeHash(wasmSha256, strategyId));
    if (!tokenId) return { ...base, open: true, reason: "this script has no NFT: nobody to copy from" };
    const holder = await nft.revenueReceiver(tokenId);
    const me = ownerNearAccount(owner);
    if (holder && me === holder) return { ...base, token_id: tokenId, holder, own: true, open: true, reason: "you hold this script's NFT" };
    const [bond, capital] = await Promise.all([nft.bondStatus(tokenId), copiedCapitalUsd(db, strategyId, holder)]);
    const required = Math.max(bond.required_usd, requiredBond(capital));
    const open = bond.held_usd + 1e-9 >= required;
    return {
      token_id: tokenId,
      holder,
      own: false,
      held_usd: bond.held_usd,
      required_usd: required,
      copied_capital_usd: capital,
      open,
      reason: open
        ? `holder bond $${bond.held_usd.toFixed(2)} covers the required $${required.toFixed(2)}`
        : `copying closed: the holder's bond is $${bond.held_usd.toFixed(2)}, below the required $${required.toFixed(2)} (max of $${MIN_BOND_USD} and 1% of copiers' $${capital.toFixed(0)})`,
    };
  } catch (e) {
    // Fail closed: a bond we cannot read is not a bond we can rely on.
    return { ...base, open: false, reason: `bond unknown: ${(e as Error).message}` };
  }
}
