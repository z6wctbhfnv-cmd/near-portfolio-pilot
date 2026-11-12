"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useWallet } from "./wallet";
import { ApiError, type IntentStatus } from "@/lib/api";
import { signAndSubmit, statusText } from "@/lib/intents";
import { canSign, ownerLabel, type Owner, type OwnerAction } from "@/lib/owner";

const WHAT: Record<string, string> = {
  agent_create: "Create your agent wallet with these rules",
  grant_issue: "Let the dolya runner trade inside your rules",
  policy_update: "Replace your signed rules",
  agent_freeze: "Freeze your agent",
  agent_unfreeze: "Unfreeze your agent",
};

/** Plain words for errors on the live path. */
export function liveError(e: unknown) {
  if (e instanceof ApiError) {
    if (e.code === "offline") return "The dolya backend is offline.";
    if (e.code === "not_configured") return "Live pilots need the backend’s NEAR Intents partner key, and this server doesn’t have one yet. Paper mode works now.";
    if (e.code === "owner_not_allowed") return "Live pilots are invite-only for now, and this owner isn’t on the list yet.";
    if (e.code === "no_agent") return "This pilot has no agent yet: sign its creation first.";
    if (e.code === "policy_revision_conflict") return "Your rules changed in the meantime. Start again to sign the latest version.";
    return e.message;
  }
  const err = e as Error & { name?: string };
  if (err?.name === "NotAllowedError") return "Signing was cancelled.";
  return err?.message ?? String(e);
}

/**
 * One owner action: what it does, what the backend prepared (the Agent API preview, which ends with the
 * risk notice), then sign → submit → follow the status. The payload is signed unchanged.
 */
export function SignFlow({ action, owner, onDone, compact = false }: { action: OwnerAction; owner: Owner; onDone?: (s: IntentStatus) => void; compact?: boolean }) {
  const { accountId, wallet } = useWallet();
  const [status, setStatus] = useState<IntentStatus | null>(null);
  const [phase, setPhase] = useState<"idle" | "signing" | "submitted" | "polling" | "final">("idle");
  const [error, setError] = useState<string | null>(null);
  const blocker = canSign(owner, action.intent);
  const wrongAccount = owner.type === "near" && accountId !== owner.account_id;

  const go = async () => {
    setError(null);
    try {
      const s = await signAndSubmit(action, owner, wallet, (st, p) => { setStatus(st); setPhase(p); });
      onDone?.(s);
    } catch (e) { setError(liveError(e)); setPhase("idle"); }
  };

  const done = phase === "final" && status?.status === "SUCCESS";
  const working = phase === "signing" || phase === "submitted" || phase === "polling";
  return (
    <div className={compact ? "" : "card p-5"}>
      <p className="text-[13px] font-semibold uppercase tracking-wide text-dim">{action.type.replace(/_/g, " ")}</p>
      <p className="mt-1 text-[19px] font-bold">{WHAT[action.type] ?? action.type}</p>
      {action.preview?.summary && <p className="mt-3 whitespace-pre-line rounded-[16px] bg-card2 p-4 text-[15px] leading-snug">{action.preview.summary}</p>}
      {action.preview?.policy != null && (
        <details className="mt-2 rounded-[16px] bg-card2 px-4 py-3 text-[14px]">
          <summary className="cursor-pointer font-semibold">The exact policy you sign</summary>
          <pre className="no-scrollbar mt-2 max-h-64 overflow-auto text-[12px] leading-snug">{JSON.stringify(action.preview.policy, null, 2)}</pre>
        </details>
      )}
      <p className="mt-3 text-[14px] text-dim">Signed by <b className="text-ink">{ownerLabel(owner)}</b> · {action.intent.standard === "webauthn" ? "passkey" : action.intent.standard.toUpperCase()}</p>
      {blocker && <p className="mt-3 rounded-[14px] bg-cream/70 px-3 py-2 text-[14px] leading-snug">{blocker}</p>}
      {!blocker && wrongAccount && <p className="mt-3 rounded-[14px] bg-cream/70 px-3 py-2 text-[14px]">Connect <b>{owner.type === "near" ? owner.account_id : ""}</b> in your wallet to sign this.</p>}
      {!done && (
        <motion.button whileTap={{ scale: 0.97 }} onClick={go} disabled={working || (!!wrongAccount && !blocker)} className="btn btn-yel mt-4 w-full">
          {working ? (phase === "signing" ? "Waiting for your signature…" : "Sent, following it…") : owner.type === "passkey" ? "Sign with your passkey" : "Sign in your wallet"}
        </motion.button>
      )}
      <AnimatePresence>
        {status && phase !== "signing" && (
          <motion.p initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} role="status"
            className={`mt-3 rounded-[14px] px-3 py-2 text-[14px] ${done ? "bg-[#e8f7ee] text-up" : phase === "final" ? "bg-[#fdecea] text-down" : "bg-card2"}`}>
            {statusText(status)}
          </motion.p>
        )}
        {error && <motion.p initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} role="alert" className="mt-3 rounded-[14px] bg-[#fdecea] px-3 py-2 text-[14px] text-down">{error}</motion.p>}
      </AnimatePresence>
    </div>
  );
}
