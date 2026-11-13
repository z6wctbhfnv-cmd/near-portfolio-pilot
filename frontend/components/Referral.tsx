"use client";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { captureRef, clearRef, inviteLink, storedRef } from "@/lib/referral";
import { referrerOf } from "@/lib/chain";
import { NFT } from "@/lib/config";
import { useWallet } from "./wallet";
import { NftActionSheet, useNftWallet, type NftAction } from "./nftWallet";

/** Remembers ?ref= on any page. Renders nothing. */
export function RefCapture() {
  useEffect(() => { captureRef(); }, []);
  return null;
}

/** "Invite friends" card: your link, who invited you, and recording that on chain. */
export function InviteCard() {
  const { accountId: main } = useWallet();
  const { accountId: nft } = useNftWallet();
  const me = nft ?? main;
  const [ref, setRef] = useState<{ ref: string } | null>(null);
  const [onChain, setOnChain] = useState<string | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [action, setAction] = useState<NftAction | null>(null);

  useEffect(() => { setRef(storedRef()); }, []);
  useEffect(() => {
    if (!nft) { setOnChain(undefined); return; }
    referrerOf(nft).then(setOnChain).catch(() => setOnChain(undefined));
  }, [nft]);

  const link = me ? inviteLink(me) : null;
  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* clipboard blocked */ }
  };
  const selfRef = ref && me && ref.ref === me;

  return (
    <div className="card p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[14px] text-dim">Referrals · early</p>
          <p className="display mt-2 text-[24px]">Invite friends</p>
        </div>
        <img src="/3d/bubble.png" alt="" className="h-16 w-16 shrink-0" />
      </div>
      <p className="mt-2 text-[15px] leading-snug text-ink/80">
        When someone you invited pays copy fees, the NFT contract sends you 0.1% of their new profit, out of Pilot’s 0.25%. How payouts reach you is still being decided.
      </p>
      {link ? (
        <div className="mt-4 flex items-center gap-2 rounded-[16px] bg-card2 p-2 pl-4">
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{link}</span>
          <motion.button whileTap={{ scale: 0.94 }} onClick={copy} className="shrink-0 rounded-[12px] bg-white px-3 py-2 text-[14px] font-semibold text-yel-deep">{copied ? "Copied" : "Copy"}</motion.button>
        </div>
      ) : <p className="mt-4 rounded-[16px] bg-card2 px-4 py-3 text-[14px] text-dim">Connect a wallet to get your invite link.</p>}

      {ref && !selfRef && (
        <div className="mt-3 rounded-[16px] bg-cream/60 p-4 text-[14px]">
          <p><b>{ref.ref}</b> invited you.{onChain ? <> Recorded on {NFT.network}: <b>{onChain}</b>.</> : onChain === null ? " Not recorded on chain yet." : ""}</p>
          {onChain === null || onChain === undefined ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <motion.button whileTap={{ scale: 0.95 }} className="rounded-[12px] bg-yel px-3 py-2 font-semibold text-white"
                onClick={() => setAction({ title: "Record who invited you", method: "set_referrer", args: { referrer: ref.ref }, deposit: "0.01", gas: "30",
                  why: `Saves ${ref.ref} as your referrer on the NFT contract. Once only; you pay the few bytes of storage and get the rest of the 0.01 NEAR back.` })}>
                Record on {NFT.network}
              </motion.button>
              <button onClick={() => { clearRef(); setRef(null); }} className="rounded-[12px] px-3 py-2 font-semibold text-dim">Forget it</button>
            </div>
          ) : null}
        </div>
      )}
      <NftActionSheet action={action} onClose={() => setAction(null)} onDone={() => nft && referrerOf(nft).then(setOnChain).catch(() => {})} />
    </div>
  );
}
