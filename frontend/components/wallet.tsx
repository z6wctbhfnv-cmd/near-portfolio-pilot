"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Wallet, WalletSelector } from "@near-wallet-selector/core";
import type { WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import "@near-wallet-selector/modal-ui/styles.css";

type Ctx = {
  accountId: string | null;
  /** The key the wallet reported at sign-in, if any. Often a limited key; see lib/owner.ts. */
  publicKey: string | null;
  ready: boolean;
  connect: () => void;
  disconnect: () => Promise<void>;
  /** The connected wallet, for owner signatures (NEP-413 messages, NEP-366 delegate actions). */
  wallet: () => Promise<Wallet>;
};
const WalletCtx = createContext<Ctx>({ accountId: null, publicKey: null, ready: false, connect: () => {}, disconnect: async () => {}, wallet: async () => { throw new Error("No wallet connected."); } });

export const useWallet = () => useContext(WalletCtx);

/** NEAR wallet connection (Meteor, HERE, Intear, MyNearWallet) through the official wallet selector. */
export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [selector, setSelector] = useState<WalletSelector | null>(null);
  const [modal, setModal] = useState<WalletSelectorModal | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      const [{ setupWalletSelector }, { setupModal }, { setupMeteorWallet }, { setupHereWallet }, { setupMyNearWallet }, { setupIntearWallet }] = await Promise.all([
        import("@near-wallet-selector/core"),
        import("@near-wallet-selector/modal-ui"),
        import("@near-wallet-selector/meteor-wallet"),
        import("@near-wallet-selector/here-wallet"),
        import("@near-wallet-selector/my-near-wallet"),
        import("@near-wallet-selector/intear-wallet"),
      ]);
      const sel = await setupWalletSelector({
        network: "mainnet",
        modules: [setupMeteorWallet(), setupHereWallet(), setupIntearWallet(), setupMyNearWallet()],
      });
      setSelector(sel);
      setModal(setupModal(sel, { theme: "light" }));
      const read = () => {
        const a = sel.store.getState().accounts.find((x) => x.active);
        setAccountId(a?.accountId ?? null);
        setPublicKey(a?.publicKey ?? null);
      };
      read();
      const sub = sel.store.observable.subscribe(read);
      unsub = () => sub.unsubscribe();
    })().catch((e) => console.error("wallet selector failed", e));
    return () => unsub?.();
  }, []);

  const connect = useCallback(() => modal?.show(), [modal]);
  const disconnect = useCallback(async () => {
    if (!selector) return;
    const w = await selector.wallet();
    await w.signOut();
  }, [selector]);

  const wallet = useCallback(async () => {
    if (!selector || !accountId) throw new Error("Connect your NEAR wallet first.");
    return selector.wallet();
  }, [selector, accountId]);

  return <WalletCtx.Provider value={{ accountId, publicKey, ready: !!modal, connect, disconnect, wallet }}>{children}</WalletCtx.Provider>;
}
