"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Change, Sheet, spring } from "@/components/ui";
import { Line } from "@/components/motion";
import { Area } from "@/components/Area";
import { ScriptSheetBody, scriptImg, versionLabel } from "@/components/ScriptSheet";
import { InviteCard } from "@/components/Referral";
import { periodStats, scriptTitle, simulatedRecord, yoctoToNear } from "@/lib/chain";
import { NFT, explorerAccount } from "@/lib/config";
import { useLeaderboard, type LeaderRow } from "@/lib/useLeaderboard";

const PERIODS: [string, number, string][] = [["7d", 7, "7 days"], ["30d", 30, "30 days"], ["90d", 90, "90 days"], ["1y", 365, "1 year"], ["all", 100_000, "2 years"]];
const SORTS: [string, string][] = [["ratio", "Return / dip"], ["roi", "Return"], ["mdd", "Smallest dip"], ["copiers", "Copiers"]];

export default function Leaderboard() {
  const { rows, chain, chainError, loading, reload } = useLeaderboard();
  const [period, setPeriod] = useState("90d");
  const [unit, setUnit] = useState<"pct" | "usd">("pct");
  const [capital, setCapital] = useState(1000);
  const [sort, setSort] = useState("ratio");
  const [spotOnly, setSpotOnly] = useState(false);
  const [positive, setPositive] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const [, days, periodLabel] = PERIODS.find((p) => p[0] === period)!;
  const hidden = rows.filter((r) => r.chain?.hidden).length;

  const list = useMemo(() => {
    const out = rows
      .filter((r) => !r.chain?.hidden)
      .map((r) => {
        const st = r.bt ? periodStats(r.bt, days, r.chain && r.chain.version > 1 ? r.chain.changedAt : 0) : null;
        return { r, st: st && st.days > 0 ? st : null, restarted: !!st && st.days === 0, copiers: r.chain?.followers ?? 0 };
      })
      .filter(({ r, st }) => (!spotOnly || !r.bt?.uses_perps) && (!positive || (st?.roi ?? 0) > 0));
    const key: Record<string, (x: (typeof out)[number]) => number> = {
      ratio: (x) => x.st?.ratio ?? -Infinity, roi: (x) => x.st?.roi ?? -Infinity, mdd: (x) => (x.st ? -x.st.mdd : -Infinity), copiers: (x) => x.copiers,
    };
    return out.sort((a, b) => key[sort](b) - key[sort](a));
  }, [rows, days, sort, spotOnly, positive]);

  const money = (roi: number) => {
    if (unit === "pct") return <Change v={roi * 100} />;
    const v = roi * capital;
    return <span className={`num ${v >= 0 ? "text-up" : "text-down"}`}>{v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(0)}</span>;
  };
  const openRow = rows.find((r) => r.id === open) ?? null;

  return (
    <main className="mx-auto max-w-[1200px] px-4 pb-20 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-6 pt-10">
        <div className="min-w-0">
          <h1 className="display text-[clamp(2.2rem,7vw,4rem)]"><Line>Leaderboard</Line></h1>
          <p className="mt-3 max-w-[52ch] text-[18px] text-dim">Scripts to copy or buy. Every script is an NFT with a public weekly record; its code stays private. Copiers pay the holder a share of new profit.</p>
        </div>
        <Link href="/create" className="btn btn-yel !h-12 shrink-0 !text-[16px]">Write your own <span className="arrow">→</span></Link>
      </div>

      <div className="mt-6 flex flex-wrap gap-2 text-[13px]">
        <a href={explorerAccount(NFT.contract)} target="_blank" rel="noreferrer" className={`rounded-full px-3 py-1.5 font-semibold ${chain ? "bg-[#e8f7ee] text-up" : "bg-card2 text-dim"}`}>
          {chain ? `${chain.length} NFTs on ${NFT.contract} ✓` : loading ? `Reading ${NFT.network}…` : `${NFT.network} unreachable`}
        </a>
        <span className="rounded-full bg-cream px-3 py-1.5 font-semibold text-yel-deep">Returns: backtests (demo) until scripts trade live</span>
        {chain?.some((c) => simulatedRecord(c.record)) && <span className="rounded-full bg-card2 px-3 py-1.5 font-semibold">On-chain checkpoints: simulated</span>}
      </div>
      {chainError && <p className="mt-3 rounded-[14px] bg-[#fdecea] px-3 py-2 text-[14px] text-down">Couldn’t read the NFT contract ({chainError.slice(0, 80)}). Showing backtests only. <button className="font-semibold underline" onClick={reload}>Retry</button></p>}

      {/* controls */}
      <div className="card mt-6 flex flex-col gap-3 p-3 sm:p-4">
        <div className="no-scrollbar -mx-1 flex gap-1 overflow-x-auto px-1">
          {PERIODS.map(([k, , l]) => (
            <button key={k} onClick={() => setPeriod(k)} className="relative h-10 shrink-0 rounded-[12px] px-4 text-[15px] font-semibold">
              {period === k && <motion.span layoutId="lb-period" transition={spring} className="absolute inset-0 rounded-[12px] bg-yel" />}
              <span className={`relative ${period === k ? "text-white" : "text-dim"}`}>{l}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[14px]">
          <div className="grid grid-cols-2 gap-1 rounded-[12px] bg-card2 p-1">
            {(["pct", "usd"] as const).map((u) => (
              <button key={u} onClick={() => setUnit(u)} className="relative h-8 rounded-[9px] px-3 font-semibold">
                {unit === u && <motion.span layoutId="lb-unit" transition={spring} className="absolute inset-0 rounded-[9px] bg-white shadow-sm" />}
                <span className="relative">{u === "pct" ? "Return %" : "Profit $"}</span>
              </button>
            ))}
          </div>
          {unit === "usd" && <label className="flex items-center gap-1 text-dim">on $<input type="number" min={100} step={100} value={capital} onChange={(e) => setCapital(Math.max(100, Number(e.target.value) || 1000))} className="num w-20 rounded-[10px] bg-card2 px-2 py-1 font-semibold text-ink outline-none" /></label>}
          <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort by" className="h-10 rounded-[12px] bg-card2 px-3 font-semibold outline-none">
            {SORTS.map(([k, l]) => <option key={k} value={k}>Sort: {l}</option>)}
          </select>
          {[["Spot only", spotOnly, setSpotOnly], ["Profitable only", positive, setPositive]].map(([l, v, set]) => (
            <button key={l as string} onClick={() => (set as (b: boolean) => void)(!(v as boolean))} aria-pressed={v as boolean}
              className={`h-10 rounded-[12px] px-3 font-semibold transition-colors ${v ? "bg-ink text-white" : "bg-card2 text-ink"}`}>{l as string}</button>
          ))}
        </div>
      </div>

      {/* the board */}
      <div className="mt-4 flex flex-col gap-2">
        <div className="hidden grid-cols-[40px_minmax(0,1.6fr)_120px_100px_90px_80px_110px] gap-3 px-5 text-[13px] font-semibold text-dim md:grid">
          <span>#</span><span>Script</span><span>Last {periodLabel}</span><span>{unit === "pct" ? "Return" : "Profit"}</span><span>Worst dip</span><span>Copiers</span><span className="text-right">For sale</span>
        </div>
        {list.map(({ r, st, restarted, copiers }, i) => (
            <motion.button layout key={r.id} onClick={() => setOpen(r.id)}
              initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: Math.min(i, 10) * 0.03 }}
              whileTap={{ scale: 0.99 }}
              className="card grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 p-4 text-left transition-shadow hover:shadow-[0_24px_50px_-24px_rgba(150,70,0,.45)] md:grid-cols-[40px_minmax(0,1.6fr)_120px_100px_90px_80px_110px] md:px-5">
              <span className={`num grid h-8 w-8 place-items-center rounded-full text-[14px] font-bold ${i < 3 ? "bg-yel text-white" : "bg-card2 text-ink"}`}>{i + 1}</span>
              <span className="flex min-w-0 items-center gap-3">
                <img src={`/3d/${scriptImg(r.id)}.png`} alt="" className="hidden h-11 w-11 shrink-0 sm:block" />
                <span className="min-w-0">
                  <span className="block truncate text-[17px] font-semibold">{scriptTitle(r.id)}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px]">
                    <span className="truncate text-dim">{r.id}</span>
                    {r.chain && <span className="rounded-full bg-[#e8f7ee] px-2 py-0.5 font-semibold text-up">on-chain ✓</span>}
                    {r.chain && r.chain.version > 1 && <span className="rounded-full bg-cream px-2 py-0.5 font-semibold text-yel-deep">{versionLabel(r.chain.version, r.chain.changedAt)}</span>}
                    {r.bt?.uses_perps && <span className="rounded-full bg-card2 px-2 py-0.5 font-semibold">perps</span>}
                  </span>
                </span>
              </span>
              <span className="hidden md:block">{st && st.curve.length > 1 ? <Area data={st.curve} id={`row-${r.id}-${period}`} h={36} w={120} /> : <span className="text-[13px] text-dim">{restarted ? "record restarted" : "no record yet"}</span>}</span>
              <span className="text-right text-[17px] font-bold md:text-left">{st ? money(st.roi) : <span className="text-dim">—</span>}
                <span className="block text-[12px] font-medium text-dim md:hidden">{st ? `dip ${(st.mdd * 100).toFixed(0)}% · ${copiers} copiers` : restarted ? "new version, record restarted" : "no record yet"}</span>
              </span>
              <span className="num hidden text-[16px] font-semibold text-down md:block">{st ? `−${(st.mdd * 100).toFixed(1)}%` : "—"}</span>
              <span className="num hidden text-[16px] font-semibold md:block">{r.chain ? copiers : "—"}</span>
              <span className="hidden text-right text-[15px] font-semibold md:block">{r.chain?.price ? `${yoctoToNear(r.chain.price)} NEAR` : <span className="text-dim">—</span>}</span>
            </motion.button>
          ))}
        {!list.length && <p className="card p-6 text-center text-[16px] text-dim">{loading ? "Loading scripts…" : "No script matches these filters."}</p>}
      </div>
      <p className="mt-4 text-[13px] leading-snug text-dim">
        {periodLabel}. {unit === "usd" ? `Profit on $${capital.toLocaleString("en-US")} copied at the start. ` : ""}“Return / dip” divides the return by the worst drop, so steady scripts beat lucky ones.
        {hidden ? ` ${hidden} script${hidden > 1 ? "s are" : " is"} hidden by the holder.` : ""} Past results don’t promise future ones.
      </p>

      <div className="mt-10 grid gap-3 lg:grid-cols-2">
        <InviteCard />
        <div className="card relative overflow-hidden p-6">
          <p className="text-[14px] text-dim">Your own script</p>
          <p className="display mt-2 pr-24 text-[24px]">Describe it, AI writes it</p>
          <p className="mt-2 max-w-[38ch] text-[15px] leading-snug text-ink/80">NEAR AI drafts the code from your idea. dolya checks it, and you mint it as an NFT. Copiers then pay you a share of their new profit.</p>
          <Link href="/create" className="mt-4 inline-flex items-center gap-1 text-[15px] font-semibold text-yel">Write a script <span>→</span></Link>
          <img src="/3d/sparkle.png" alt="" className="absolute -bottom-3 -right-2 h-28 w-28" />
        </div>
      </div>

      <Sheet open={!!openRow} onClose={() => setOpen(null)}>
        {openRow && <ScriptSheetBody key={openRow.id} row={openRow as LeaderRow} days={days} periodLabel={periodLabel} onChanged={reload} />}
      </Sheet>
    </main>
  );
}
