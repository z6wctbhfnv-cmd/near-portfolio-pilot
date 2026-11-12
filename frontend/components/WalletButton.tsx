"use client";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useWallet } from "./wallet";

const short = (id: string) => (id.length > 22 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id);

export function WalletButton() {
  const { accountId, ready, connect, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  if (!accountId) {
    return (
      <motion.button onClick={connect} disabled={!ready} whileHover={{ y: -2 }} whileTap={{ scale: 0.95 }}
        className="btn btn-yel group !h-11 !rounded-[14px] !px-4 !text-[15px]">
        <motion.img src="/3d/wallet.png" alt="" className="-ml-1 h-7 w-7" whileHover={{ rotate: -12 }} />
        Connect wallet
      </motion.button>
    );
  }
  return (
    <div ref={ref} className="relative">
      <motion.button onClick={() => setOpen((o) => !o)} whileTap={{ scale: 0.96 }}
        className="flex h-11 items-center gap-2 rounded-[14px] bg-card px-3 text-[15px] font-semibold shadow-sm">
        <span className="h-2.5 w-2.5 rounded-full bg-up" />
        {short(accountId)}
        <Chevron open={open} />
      </motion.button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, y: -6, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.96 }}
            transition={{ type: "spring", stiffness: 420, damping: 30 }}
            className="absolute right-0 top-[52px] w-56 origin-top-right rounded-[18px] bg-card p-2 shadow-[0_20px_40px_-16px_rgba(120,40,0,.35)]">
            <p className="px-3 pb-2 pt-1 text-[13px] text-dim">Connected</p>
            <button onClick={() => { setOpen(false); disconnect(); }} className="press w-full rounded-[12px] px-3 py-2.5 text-left text-[15px] font-medium text-down hover:bg-card2">Disconnect</button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Animated chevron: a rounded tile that rotates and fills when open. */
export function Chevron({ open, className = "" }: { open: boolean; className?: string }) {
  return (
    <motion.span animate={{ rotate: open ? 180 : 0, backgroundColor: open ? "var(--color-yel)" : "var(--color-card2)" }}
      transition={{ type: "spring", stiffness: 380, damping: 22 }}
      className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${className}`}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
        <motion.path d="M2.5 4.5 6 8l3.5-3.5" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
          animate={{ stroke: open ? "#ffffff" : "var(--color-ink)" }} />
      </svg>
    </motion.span>
  );
}
