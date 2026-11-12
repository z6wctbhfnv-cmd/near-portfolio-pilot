// Owner sign-in: passkey (WebAuthn, no extension) or a NEAR wallet (wallet selector from a CDN, no build).
// The Agent API accepts both owner types. Nothing here sees private keys.

const WS = "10.1.4";
const STORE = "pilot.owner";

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export function currentOwner() {
  try {
    return JSON.parse(localStorage.getItem(STORE) || "null");
  } catch {
    return null;
  }
}

function save(owner) {
  try {
    if (owner) localStorage.setItem(STORE, JSON.stringify(owner));
    else localStorage.removeItem(STORE);
  } catch {
    /* private mode: owner lives for this page only */
  }
  return owner;
}

export function passkeySupported() {
  return !!(window.PublicKeyCredential && navigator.credentials?.create);
}

/** Create a passkey for this site. Returns the Agent API `owner` object for type "passkey". */
export async function createPasskey() {
  if (!passkeySupported()) throw new Error("This browser does not support passkeys.");
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "Pilot", id: location.hostname },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "pilot-owner", displayName: "Pilot owner" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256 (P-256), the only type the Agent API accepts
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      attestation: "none",
      timeout: 120_000,
    },
  });
  const spki = cred.response.getPublicKey?.();
  if (!spki) throw new Error("This device did not return a P-256 public key.");
  return save({
    type: "passkey",
    credential_id: b64u(cred.rawId),
    public_key: b64u(spki),
    rp_id: location.hostname,
    origin: location.origin,
  });
}

/**
 * Sign an Agent API intent with the passkey. `payload.challenge` is base64url (from generate-intent).
 * Returns `signed_data` for submit-intent: { credential: AuthenticationResponseJSON }.
 */
export async function signWithPasskey(owner, payload) {
  const a = await navigator.credentials.get({
    publicKey: {
      challenge: unb64u(payload.challenge),
      rpId: payload.rpId || owner.rp_id,
      allowCredentials: [{ type: "public-key", id: unb64u(owner.credential_id) }],
      userVerification: "required",
      timeout: payload.timeout || 120_000,
    },
  });
  return {
    credential: {
      id: a.id,
      rawId: b64u(a.rawId),
      type: a.type,
      response: {
        clientDataJSON: b64u(a.response.clientDataJSON),
        authenticatorData: b64u(a.response.authenticatorData),
        signature: b64u(a.response.signature),
        userHandle: a.response.userHandle ? b64u(a.response.userHandle) : undefined,
      },
      clientExtensionResults: a.getClientExtensionResults?.() || {},
      authenticatorAttachment: a.authenticatorAttachment || undefined,
    },
  };
}

// --- NEAR wallets --------------------------------------------------------------------------
let selectorPromise = null;

async function selector() {
  if (!selectorPromise) {
    selectorPromise = (async () => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = `https://cdn.jsdelivr.net/npm/@near-wallet-selector/modal-ui@${WS}/styles.css`;
      document.head.append(css);
      const [{ setupWalletSelector }, { setupModal }, { setupMeteorWallet }, { setupMyNearWallet }, { setupIntearWallet }] = await Promise.all([
        import(`https://esm.sh/@near-wallet-selector/core@${WS}`),
        import(`https://esm.sh/@near-wallet-selector/modal-ui@${WS}`),
        import(`https://esm.sh/@near-wallet-selector/meteor-wallet@${WS}`),
        import(`https://esm.sh/@near-wallet-selector/my-near-wallet@${WS}`),
        import(`https://esm.sh/@near-wallet-selector/intear-wallet@${WS}`),
      ]);
      const sel = await setupWalletSelector({
        network: "mainnet",
        modules: [setupMeteorWallet(), setupMyNearWallet(), setupIntearWallet()],
      });
      const modal = setupModal(sel, { theme: "light", description: "The wallet that will own your Pilot agent." });
      return { sel, modal };
    })().catch((e) => {
      selectorPromise = null;
      throw e;
    });
  }
  return selectorPromise;
}

/** Opens the wallet picker; resolves with the Agent API `owner` object for type "near". */
export async function connectNearWallet() {
  const { sel, modal } = await selector();
  const existing = sel.store.getState().accounts?.[0];
  if (existing) return save(nearOwner(existing));
  modal.show();
  return new Promise((resolve, reject) => {
    const sub = sel.store.observable.subscribe((state) => {
      const acc = state.accounts?.[0];
      if (acc) {
        sub.unsubscribe();
        modal.hide();
        resolve(save(nearOwner(acc)));
      }
    });
    setTimeout(() => {
      sub.unsubscribe();
      reject(new Error("No wallet connected."));
    }, 180_000);
  });
}

function nearOwner(acc) {
  return { type: "near", account_id: acc.accountId, public_key: acc.publicKey || null };
}

/** NEP-413 signature for non-creation intents. Creation needs NEP-366, which only some wallets support. */
export async function signWithNear(payload) {
  const { sel } = await selector();
  const wallet = await sel.wallet();
  if (!wallet.signMessage) throw new Error("This wallet cannot sign messages. Try Meteor or use a passkey.");
  const res = await wallet.signMessage({ message: payload.message, recipient: payload.recipient, nonce: Uint8Array.from(atob(payload.nonce), (c) => c.charCodeAt(0)) });
  return { public_key: res.publicKey, signature: res.signature };
}

/**
 * Sign an Agent API owner intent (`owner_action.intent` from the Pilot backend) and return the
 * `signed_data` for submit. The payload is signed exactly as returned, never rebuilt or reordered.
 */
export async function signIntent(owner, intent) {
  switch (intent.standard) {
    case "webauthn":
      return { ...intent, ...(await signWithPasskey(owner, intent.payload)) };
    case "nep413":
      return { ...intent, ...(await signWithNear(intent.payload)) };
    case "nep366": {
      const { sel } = await selector();
      const wallet = await sel.wallet();
      if (!wallet.signDelegateActions) throw new Error("This wallet cannot sign a delegate action (NEP-366). Try Meteor or use a passkey.");
      const res = await wallet.signDelegateActions({ delegateActions: [intent.payload] });
      return { ...intent, signed_delegate: res.signedDelegateActions[0] };
    }
    default:
      throw new Error(`Unsupported signature type: ${intent.standard}`);
  }
}

export async function disconnect() {
  const owner = currentOwner();
  if (owner?.type === "near" && selectorPromise) {
    try {
      const { sel } = await selector();
      await (await sel.wallet()).signOut();
    } catch {
      /* wallet already gone */
    }
  }
  save(null);
}

export function shortOwner(owner) {
  if (!owner) return "";
  if (owner.type === "near") return owner.account_id.length > 22 ? owner.account_id.slice(0, 8) + "…" + owner.account_id.slice(-8) : owner.account_id;
  return "Passkey · " + owner.credential_id.slice(0, 6);
}
