// The owner of a live pilot signs Agent API owner intents. Two kinds of owner work here:
// - a NEAR wallet (mainnet). NEP-413 message signatures work in Meteor, HERE, Intear and MyNearWallet.
//   NEP-366 delegate actions (agent_create, freeze, unfreeze) need wallet support none of them has yet.
// - a passkey (WebAuthn, Face ID / Touch ID / device PIN). Signs every intent type. Ported from web/js/wallet.js.
// Nothing here sees a private key, and the payload is always signed exactly as the backend returned it.
import type { Wallet } from "@near-wallet-selector/core";
import { MAINNET_RPC } from "./config";

export type NearOwner = { type: "near"; account_id: string; public_key: string };
export type PasskeyOwner = { type: "passkey"; credential_id: string; public_key: string; rp_id: string; origin: string };
export type Owner = NearOwner | PasskeyOwner;

export type Intent =
  | { standard: "nep413"; payload: { message: string; recipient: string; nonce: string } }
  | { standard: "nep366"; payload: { receiverId: string; actions: unknown[] } }
  | { standard: "webauthn"; payload: { challenge: string; rpId?: string; allowCredentials?: { id: string; type: string }[]; timeout?: number; userVerification?: string } }
  | { standard: "eip712"; payload: unknown };

export type OwnerAction = {
  correlation_id: string;
  type: string;
  agent_id?: string;
  status?: string;
  expires_at?: string;
  intent: Intent;
  preview?: { summary?: string; policy?: unknown };
};

const b64u = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

/* ---------- passkey ---------- */
const PASSKEY = "dolya.owner.passkey";

export function savedPasskey(): PasskeyOwner | null {
  try { return JSON.parse(localStorage.getItem(PASSKEY) ?? "null"); } catch { return null; }
}
export function forgetPasskey() { try { localStorage.removeItem(PASSKEY); } catch { /* blocked */ } }

export const passkeySupported = () => typeof window !== "undefined" && !!(window.PublicKeyCredential && navigator.credentials?.create);

/** Creates a passkey for this site and returns the Agent API owner object for it. */
export async function createPasskey(): Promise<PasskeyOwner> {
  if (!passkeySupported()) throw new Error("This browser doesn’t support passkeys.");
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "dolya", id: location.hostname },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "dolya-owner", displayName: "dolya owner" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256 (P-256), the only type the Agent API accepts
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      attestation: "none",
      timeout: 120_000,
    },
  })) as PublicKeyCredential;
  const spki = (cred.response as AuthenticatorAttestationResponse).getPublicKey?.();
  if (!spki) throw new Error("This device didn’t return a P-256 public key.");
  const owner: PasskeyOwner = { type: "passkey", credential_id: b64u(cred.rawId), public_key: b64u(spki), rp_id: location.hostname, origin: location.origin };
  try { localStorage.setItem(PASSKEY, JSON.stringify(owner)); } catch { /* lives for this page only */ }
  return owner;
}

async function signWithPasskey(owner: PasskeyOwner, p: Extract<Intent, { standard: "webauthn" }>["payload"]) {
  const allow = p.allowCredentials?.length ? p.allowCredentials : [{ id: owner.credential_id, type: "public-key" }];
  const a = (await navigator.credentials.get({
    publicKey: {
      challenge: unb64u(p.challenge),
      rpId: p.rpId ?? owner.rp_id,
      allowCredentials: allow.map((c) => ({ type: "public-key" as const, id: unb64u(c.id) })),
      userVerification: (p.userVerification as UserVerificationRequirement) ?? "required",
      timeout: p.timeout ?? 120_000,
    },
  })) as PublicKeyCredential;
  const r = a.response as AuthenticatorAssertionResponse;
  return {
    id: a.id,
    rawId: b64u(a.rawId),
    type: a.type,
    response: {
      clientDataJSON: b64u(r.clientDataJSON),
      authenticatorData: b64u(r.authenticatorData),
      signature: b64u(r.signature),
      userHandle: r.userHandle ? b64u(r.userHandle) : undefined,
    },
    clientExtensionResults: a.getClientExtensionResults?.() ?? {},
    authenticatorAttachment: (a.authenticatorAttachment as string | null) ?? undefined,
  };
}

/* ---------- NEAR wallet ---------- */

/** Full-access keys of a mainnet account. The wallet signs owner messages with one of these. */
export async function fullAccessKeys(accountId: string): Promise<string[]> {
  const r = await fetch(MAINNET_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "dolya", method: "query", params: { request_type: "view_access_key_list", finality: "final", account_id: accountId } }),
  });
  const j = await r.json();
  if (j.error || j.result?.error) throw new Error(String(j.error?.data ?? j.result?.error ?? "rpc error"));
  return (j.result.keys as { public_key: string; access_key: { permission: unknown } }[])
    .filter((k) => k.access_key.permission === "FullAccess")
    .map((k) => k.public_key);
}

async function signNep413(wallet: Wallet, p: Extract<Intent, { standard: "nep413" }>["payload"]) {
  // The selector checks Buffer.isBuffer(nonce), so it needs a real Buffer, also in the browser.
  const { Buffer } = await import("buffer");
  const g = globalThis as unknown as { Buffer?: typeof Buffer };
  g.Buffer ??= Buffer;
  if (!("signMessage" in wallet) || !wallet.signMessage) throw new Error("This wallet can’t sign messages (NEP-413). Try Meteor or MyNearWallet, or use a passkey.");
  const res = await wallet.signMessage({ message: p.message, recipient: p.recipient, nonce: g.Buffer!.from(p.nonce, "base64") });
  if (!res) throw new Error("The wallet returned no signature. If it opened a new page, finish there and try again.");
  return { public_key: res.publicKey, signature: res.signature };
}

/** Plain words for "this wallet can't do NEP-366". */
export const NEP366_MISSING =
  "Your NEAR wallet can’t sign this step yet. Creating, freezing and unfreezing an agent needs a NEP-366 delegate-action signature, and none of the wallets in the picker (Meteor, HERE, Intear, MyNearWallet) supports it today. Use a passkey as the owner instead: it signs every step.";

async function signNep366(wallet: Wallet, payload: unknown) {
  // The SDK README's call. No wallet in wallet-selector 10 implements it yet; the selector's own
  // signDelegateAction throws "Method not supported" for all four.
  const w = wallet as unknown as { signDelegateActions?: (p: { delegateActions: unknown[] }) => Promise<{ signedDelegateActions: string[] }> };
  if (typeof w.signDelegateActions !== "function") throw new Error(NEP366_MISSING);
  const res = await w.signDelegateActions({ delegateActions: [payload] });
  return { signed_delegate: res.signedDelegateActions[0] };
}

/** Which standard an owner action needs, in words, before the wallet opens. */
export function canSign(owner: Owner, intent: Intent): string | null {
  if (owner.type === "passkey") return intent.standard === "webauthn" ? null : `This step came back as ${intent.standard}, which a passkey can’t sign.`;
  if (intent.standard === "nep366") return NEP366_MISSING;
  if (intent.standard !== "nep413") return `This step came back as ${intent.standard}, which a NEAR wallet can’t sign.`;
  return null;
}

/** Signs `intent` unchanged and returns `signed_data` for /v1/intents/:cid/submit. */
export async function signIntent(owner: Owner, intent: Intent, wallet?: () => Promise<Wallet>) {
  switch (intent.standard) {
    case "webauthn":
      if (owner.type !== "passkey") throw new Error("This step needs the passkey that owns the pilot.");
      return { ...intent, credential: await signWithPasskey(owner, intent.payload) };
    case "nep413":
      if (!wallet) throw new Error("Connect your NEAR wallet first.");
      return { ...intent, ...(await signNep413(await wallet(), intent.payload)) };
    case "nep366":
      if (!wallet) throw new Error("Connect your NEAR wallet first.");
      return { ...intent, ...(await signNep366(await wallet(), intent.payload)) };
    default:
      throw new Error(`Unsupported signature type: ${intent.standard}`);
  }
}

export const ownerLabel = (o: Owner) => (o.type === "near" ? o.account_id : `Passkey · ${o.credential_id.slice(0, 6)}`);
