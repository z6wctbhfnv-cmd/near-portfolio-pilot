// Referrals, kept minimal on purpose: the payout mechanics are still TBD.
// A ?ref=<account> link is remembered in this browser (first link wins). The invited person can then
// record it on the NFT contract with `set_referrer`; the contract later gives the referrer 0.1% of the
// fees that person pays (out of Pilot's 0.25%).
const KEY = "dolya.ref";
const ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export const validAccount = (s: string) => ACCOUNT.test(s);

export function storedRef(): { ref: string; at: number } | null {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "null"); } catch { return null; }
}

/** Call once on page load (in an effect): remembers the first valid ?ref= this browser sees. */
export function captureRef() {
  try {
    const ref = new URLSearchParams(location.search).get("ref")?.trim().toLowerCase();
    if (ref && validAccount(ref) && !storedRef()) localStorage.setItem(KEY, JSON.stringify({ ref, at: Date.now() }));
  } catch { /* storage blocked */ }
}

export function clearRef() { try { localStorage.removeItem(KEY); } catch { /* blocked */ } }

export const inviteLink = (account: string) => `${location.origin}/?ref=${encodeURIComponent(account)}`;
