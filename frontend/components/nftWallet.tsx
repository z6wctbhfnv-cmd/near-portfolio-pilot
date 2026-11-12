"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { WalletSelector } from "@near-wallet-selector/core";
import { motion } from "framer-motion";
import { NFT, explorerAccount } from "@/lib/config";
import { clearChainCache } from "@/lib/chain";
import { Sheet } from "./ui";

/**
 * A second wallet connection, only for the strategy NFT contract. The NFT contract is on testnet while
 * the owner's main wallet (wallet.tsx) is on mainnet, so this one has its own selector, its own
 * storage prefix and its own small picker (the modal-ui is a singleton and belongs to the main wallet).
 */

type Module = { id: string; name: string; icon: string };
export type NftCall = { method: string; args: Record<string, unknown>; deposit: string; gas?: string };
type Ctx = {
  accountId: string | null;
  modules: Module[];
  ready: boolean;
  signIn: (id: string) => Promise<void>;
  signOut: () => Promise<void>;
  call: (c: NftCall) => Promise<unknown>;
};
const NftCtx = createContext<Ctx>({ accountId: null, modules: [], ready: false, signIn: async () => {}, signOut: async () => {}, call: async () => undefined });
export const useNftWallet = () => useContext(NftCtx);

const prefixed = (p: string) => ({
  getItem: async (k: string) => { try { return localStorage.getItem(p + k); } catch { return null; } },
  setItem: async (k: string, v: string) => { try { localStorage.setItem(p + k, v); } catch { /* blocked */ } },
  removeItem: async (k: string) => { try { localStorage.removeItem(p + k); } catch { /* blocked */ } },
});

/** "0.01" NEAR -> yoctoNEAR as bigint, without floating point. */
export function nearToYoctoBig(near: string) {
  const [w, f = ""] = near.split(".");
  return BigInt(w || "0") * 10n ** 24n + BigInt((f + "0".repeat(24)).slice(0, 24) || "0");
}

export function NftWalletProvider({ children }: { children: React.ReactNode }) {
  const [selector, setSelector] = useState<WalletSelector | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [modules, setModules] = useState<Module[]>([]);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      const [{ setupWalletSelector }, { setupMeteorWallet }, { setupMyNearWallet }] = await Promise.all([
        import("@near-wallet-selector/core"),
        import("@near-wallet-selector/meteor-wallet"),
        import("@near-wallet-selector/my-near-wallet"),
      ]);
      const sel = await setupWalletSelector({
        network: NFT.network,
        modules: [setupMeteorWallet(), setupMyNearWallet()],
        allowMultipleSelectors: true,
        storage: prefixed(`dolya.nft.${NFT.network}:`),
      });
      setSelector(sel);
      const read = () => {
        const s = sel.store.getState();
        setAccountId(s.accounts.find((a) => a.active)?.accountId ?? null);
        setModules(s.modules.map((m) => ({ id: m.id, name: m.metadata.name, icon: m.metadata.iconUrl })));
      };
      read();
      const sub = sel.store.observable.subscribe(read);
      unsub = () => sub.unsubscribe();
    })().catch((e) => console.error("testnet wallet selector failed", e));
    return () => unsub?.();
  }, []);

  const signIn = useCallback(async (id: string) => {
    if (!selector) throw new Error("Wallets are still loading.");
    const w = await selector.wallet(id);
    // No contractId: no function-call key is added to the account, so signing in writes nothing on chain.
    await (w as unknown as { signIn: (p: Record<string, unknown>) => Promise<unknown> }).signIn({});
  }, [selector]);

  const signOut = useCallback(async () => {
    if (!selector) return;
    await (await selector.wallet()).signOut();
  }, [selector]);

  const call = useCallback(async ({ method, args, deposit, gas = "50" }: NftCall) => {
    if (!selector) throw new Error("Wallets are still loading.");
    const [{ actionCreators }] = await Promise.all([import("@near-js/transactions")]);
    const w = await selector.wallet();
    const out = await w.signAndSendTransaction({
      receiverId: NFT.contract,
      actions: [actionCreators.functionCall(method, args, BigInt(gas) * 10n ** 12n, nearToYoctoBig(deposit))],
    });
    clearChainCache();
    return out;
  }, [selector]);

  return <NftCtx.Provider value={{ accountId, modules, ready: !!selector, signIn, signOut, call }}>{children}</NftCtx.Provider>;
}

/** The exact near-cli-rs command for the same call, for people who prefer the terminal. */
export function cliCommand({ method, args, deposit, gas = "50" }: NftCall, signer = "<you>.testnet") {
  return `near contract call-function as-transaction ${NFT.contract} ${method} json-args '${JSON.stringify(args)}' prepaid-gas '${gas} Tgas' attached-deposit '${deposit} NEAR' sign-as ${signer} network-config ${NFT.network} sign-with-keychain send`;
}

export type NftAction = NftCall & {
  title: string; why: string; who?: string;
  /** Arguments that depend on the signer (e.g. mint_strategy's author), built once a testnet account is connected. */
  build?: (accountId: string) => Record<string, unknown>;
};

/**
 * Confirmation sheet for one NFT contract call: what it does, the exact method, arguments and deposit,
 * the network, and the CLI equivalent. Nothing is sent until the person taps Sign in their wallet.
 */
export function NftActionSheet({ action, onClose, onDone }: { action: NftAction | null; onClose: () => void; onDone?: () => void }) {
  const { accountId, modules, ready, signIn, signOut, call } = useNftWallet();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [cli, setCli] = useState(false);
  useEffect(() => { setMsg(null); setCli(false); }, [action]);
  const args = action?.build ? (accountId ? action.build(accountId) : action.args) : action?.args;
  const full = action && args ? { ...action, args } : action;

  const send = async () => {
    if (!full) return;
    setBusy(true); setMsg(null);
    try {
      await call(full);
      setMsg({ ok: true, text: "Sent. It can take a few seconds to show here." });
      onDone?.();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message || "The wallet did not send it." });
    } finally { setBusy(false); }
  };

  return (
    <Sheet open={!!action} onClose={onClose}>
      {action && (
        <div>
          <span className="rounded-full bg-card2 px-2.5 py-1 text-[12px] font-semibold text-yel-deep">NEAR {NFT.network}</span>
          <h3 className="display mt-3 text-[26px]">{action.title}</h3>
          <p className="mt-2 text-[16px] leading-snug text-ink/80">{action.why}</p>
          <div className="mt-4 divide-y divide-line rounded-[18px] bg-card2 text-[15px]">
            {[["Contract", NFT.contract], ["Method", action.method], ["Deposit", `${action.deposit} NEAR`], ["Signed by", action.who ?? (accountId ?? "your testnet account")]].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 px-4 py-3"><span className="text-dim">{k}</span><span className="min-w-0 break-all text-right font-semibold">{v}</span></div>
            ))}
            <pre className="no-scrollbar overflow-x-auto px-4 py-3 text-[13px] leading-snug">{JSON.stringify(args, null, 2)}</pre>
          </div>

          {!accountId ? (
            <div className="mt-4">
              <p className="text-[15px] font-semibold">Connect a {NFT.network} wallet to sign</p>
              <p className="mt-1 text-[14px] text-dim">Your main wallet is on mainnet; script NFTs live on {NFT.network}, so this needs a {NFT.network} account.</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {modules.map((m) => (
                  <motion.button key={m.id} whileTap={{ scale: 0.96 }} disabled={!ready}
                    onClick={() => signIn(m.id).catch((e) => setMsg({ ok: false, text: (e as Error).message }))}
                    className="flex items-center gap-2 rounded-[16px] bg-card2 px-3 py-3 text-left text-[15px] font-semibold hover:bg-cream">
                    {m.icon && <img src={m.icon} alt="" className="h-7 w-7 rounded-[8px]" />}{m.name}
                  </motion.button>
                ))}
                {!modules.length && <p className="col-span-2 text-[14px] text-dim">Loading wallets…</p>}
              </div>
            </div>
          ) : (
            <>
              <motion.button whileTap={{ scale: 0.97 }} onClick={send} disabled={busy} className="btn btn-yel mt-5 w-full">
                {busy ? "Waiting for your wallet…" : "Sign in your wallet"}
              </motion.button>
              <p className="mt-2 text-center text-[13px] text-dim">
                Signing as <a href={explorerAccount(accountId)} target="_blank" rel="noreferrer" className="font-semibold text-ink underline">{accountId}</a> ·{" "}
                <button onClick={signOut} className="font-semibold text-yel-deep">switch</button>
              </p>
            </>
          )}
          {msg && <p role="status" className={`mt-3 rounded-[14px] px-3 py-2 text-[14px] ${msg.ok ? "bg-[#e8f7ee] text-up" : "bg-[#fdecea] text-down"}`}>{msg.text}</p>}
          <button onClick={() => setCli((c) => !c)} className="mt-4 text-[14px] font-semibold text-yel-deep">{cli ? "Hide" : "Show"} the same call for near-cli</button>
          {cli && <pre className="no-scrollbar mt-2 overflow-x-auto rounded-[14px] bg-ink p-3 text-[12px] leading-snug text-white/90">{cliCommand(full!, action.who ?? accountId ?? undefined)}</pre>}
        </div>
      )}
    </Sheet>
  );
}
