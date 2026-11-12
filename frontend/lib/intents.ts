// One owner action, start to end: sign the intent unchanged, submit it, follow it to a final status.
import type { Wallet } from "@near-wallet-selector/core";
import { api, type IntentStatus } from "./api";
import { signIntent, type Owner, type OwnerAction } from "./owner";

const FINAL = new Set(["SUCCESS", "FAILED", "REFUNDED", "NEEDS_REVIEW"]);

/** Plain words for every Agent API status. */
export const STATUS_WORDS: Record<string, string> = {
  PENDING_SIGNATURE: "Waiting for your signature",
  PENDING_APPROVAL: "Waiting for your approval vote",
  PENDING_DEPOSIT: "Waiting for a deposit",
  QUEUED: "Queued",
  PROCESSING: "Processing",
  SUCCESS: "Done",
  FAILED: "Failed",
  REFUNDED: "Refunded",
  UNCERTAIN: "Outcome not known yet, still checking",
  NEEDS_REVIEW: "Stopped for a manual check",
};

export const statusText = (s: IntentStatus) =>
  `${STATUS_WORDS[s.status] ?? s.status}${s.failure_code ? ` (${s.failure_code})` : ""}`;

/**
 * Sign → submit → poll. The status is long-polled with the same correlation id until it is final;
 * UNCERTAIN keeps polling the same id and is never resubmitted.
 */
export async function signAndSubmit(
  action: OwnerAction,
  owner: Owner,
  wallet: (() => Promise<Wallet>) | undefined,
  onStatus: (s: IntentStatus, phase: "signing" | "submitted" | "polling" | "final") => void,
): Promise<IntentStatus> {
  onStatus({ status: "PENDING_SIGNATURE" }, "signing");
  const signed = await signIntent(owner, action.intent, wallet);
  let s = await api.submitIntent(action.correlation_id, signed as Record<string, unknown>);
  onStatus(s, "submitted");
  for (let i = 0; i < 40 && !FINAL.has(s.status); i++) {
    onStatus(s, "polling");
    s = (await api.intentStatus(action.correlation_id, 20_000)).status;
  }
  onStatus(s, "final");
  return s;
}
