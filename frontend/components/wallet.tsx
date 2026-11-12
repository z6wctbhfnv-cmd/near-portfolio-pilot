"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { WalletSelector } from "@near-wallet-selector/core";
import type { WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import "@near-wallet-selector/modal-ui/styles.css";

type Ctx = { accountId: string | null; ready: boolean; connect: () => void; disconnect: () => Promise<void> };
const WalletCtx = createContext<Ctx>({ accountId: null, ready: false, connect: () => {}, disconnect: async () => {} });

export const useWallet = () => useContext(WalletCtx);

/** NEAR wallet connection (Meteor, HERE, Intear, MyNearWallet) through the official wallet selector. */
export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [selector, setSelector] = useState<WalletSelector | null>(null);
  const [modal, setModal] = useState<WalletSelectorModal | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);

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
      const read = () => setAccountId(sel.store.getState().accounts.find((a) => a.active)?.accountId ?? null);
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

  return <WalletCtx.Provider value={{ accountId, ready: !!modal, connect, disconnect }}>{children}</WalletCtx.Provider>;
}
