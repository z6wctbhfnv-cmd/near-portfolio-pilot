"use client";
import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Sheet } from "./ui";
import { SignFlow, liveError } from "./SignFlow";
import { api, type PendingIntent, type Pilot } from "@/lib/api";
import { STATUS_WORDS } from "@/lib/intents";
import { ownerLabel, type Owner, type OwnerAction } from "@/lib/owner";

const TYPE: Record<string, string> = { agent_create: "Create the agent", grant_issue: "Runner access", policy_update: "New rules", agent_freeze: "Freeze", agent_unfreeze: "Unfreeze" };

/** Owner actions on a live pilot. Each one is prepared by the backend and signed by the owner. */
export function OwnerPanel({ pilot, freezeAsk, onFreezeAsked }: { pilot: Pilot; freezeAsk?: boolean; onFreezeAsked?: () => void }) {
  const owner = pilot.owner as unknown as Owner | null;
  const [intents, setIntents] = useState<PendingIntent[]>([]);
  const [open, setOpen] = useState<OwnerAction | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api.pilotIntents(pilot.id).then(setIntents).catch(() => {}), [pilot.id]);
  useEffect(() => { load(); }, [load]);

  const start = useCallback(async (label: string, fn: () => Promise<{ owner_action: OwnerAction }>) => {
    setBusy(label); setError(null);
    try { setOpen((await fn()).owner_action); }
    catch (e) { setError(liveError(e)); }
    finally { setBusy(null); }
  }, []);

  // The dashboard's Freeze button asks for the signed freeze too.
  useEffect(() => {
    if (!freezeAsk) return;
    onFreezeAsked?.();
    start("freeze", () => api.ownerAction(pilot.id, "freeze"));
  }, [freezeAsk, onFreezeAsked, pilot.id, start]);

  const resume = async (cid: string) => {
    setBusy(cid); setError(null);
    try {
      const r = await api.intentStatus(cid);
      if (!r.generated) throw new Error("The backend no longer has this request. Start it again.");
      setOpen(r.generated);
    } catch (e) { setError(liveError(e)); }
    finally { setBusy(null); }
  };

  if (!owner) return null;
  const waiting = intents.filter((i) => i.status === "PENDING_SIGNATURE");
  const hasAgent = pilot.status !== "pending_owner";
  return (
    <div className="card p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[14px] text-dim">Owner · {ownerLabel(owner)}</p>
          <p className="display mt-2 text-[24px]">{hasAgent ? "Signed with your key" : "Waiting for your signature"}</p>
        </div>
        <img src="/3d/lock.png" alt="" className="h-16 w-16 shrink-0" />
      </div>
      {waiting.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2">
          {waiting.map((i) => (
            <li key={i.correlation_id} className="flex items-center gap-3 rounded-[14px] bg-cream/60 px-3 py-2.5">
              <span className="min-w-0 flex-1 text-[15px]"><b>{TYPE[i.type] ?? i.type}</b> · {STATUS_WORDS[i.status] ?? i.status}</span>
              <motion.button whileTap={{ scale: 0.95 }} onClick={() => resume(i.correlation_id)} disabled={busy === i.correlation_id} className="rounded-[12px] bg-yel px-3 py-1.5 text-[14px] font-semibold text-white">Sign</motion.button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {[
          ["grant", "Give the runner access", () => api.grant(pilot.id)],
          ["policy", "Re-sign my rules", () => api.policy(pilot.id)],
          ["freeze", "Freeze the wallet", () => api.ownerAction(pilot.id, "freeze")],
          ["unfreeze", "Unfreeze", () => api.ownerAction(pilot.id, "unfreeze")],
        ].map(([k, l, fn]) => (
          <motion.button key={k as string} whileTap={{ scale: 0.95 }} disabled={!hasAgent || !!busy}
            onClick={() => start(k as string, fn as () => Promise<{ owner_action: OwnerAction }>)}
            className="rounded-[12px] bg-card2 px-3 py-2 text-[14px] font-semibold disabled:opacity-40">{busy === k ? "Preparing…" : (l as string)}</motion.button>
        ))}
      </div>
      {!hasAgent && <p className="mt-2 text-[13px] text-dim">These open once the agent exists.</p>}
      {error && <p role="alert" className="mt-3 rounded-[14px] bg-[#fdecea] px-3 py-2 text-[14px] text-down">{error}</p>}
      <Sheet open={!!open} onClose={() => { setOpen(null); load(); }}>
        {open && <SignFlow compact action={open} owner={owner} onDone={() => load()} />}
      </Sheet>
    </div>
  );
}
