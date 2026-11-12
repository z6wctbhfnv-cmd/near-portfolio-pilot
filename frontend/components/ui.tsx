"use client";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { holdings, moves, series, stories, total, usd, type Move } from "@/lib/demo";
import { Mark } from "./Logo";

export const spring = { type: "spring", stiffness: 420, damping: 34 } as const;

const KNOWN = ["near", "usdc", "eth", "btc"];
export function Coin({ sym, size = 44 }: { sym: string; bg?: string; fg?: string; size?: number }) {
  const s = sym.toLowerCase();
  if (!KNOWN.includes(s)) {
    return <span className="grid shrink-0 place-items-center rounded-full bg-card2 font-bold text-yel-deep" style={{ width: size, height: size, fontSize: size * 0.32 }}>{sym.slice(0, 2)}</span>;
  }
  return <img src={`/tokens/${s}.svg`} alt={sym} width={size} height={size} className="shrink-0 rounded-full" style={{ width: size, height: size }} />;
}

export function Change({ v, className = "" }: { v: number; className?: string }) {
  const c = v > 0 ? "text-up" : v < 0 ? "text-down" : "text-dim";
  return <span className={`num ${c} ${className}`}>{v > 0 ? "+" : ""}{v.toFixed(1)}%</span>;
}

/** Round action button with a caption, as in wallet apps. */
export function Action({ icon, label, onClick, active = false }: { icon: React.ReactNode; label: string; onClick?: () => void; active?: boolean }) {
  return (
    <motion.button onClick={onClick} whileHover={{ y: -3 }} whileTap={{ scale: 0.9 }} transition={{ type: "spring", stiffness: 400, damping: 15 }} className="flex flex-col items-center gap-2">
      <span className={`grid h-14 w-14 place-items-center rounded-full text-[22px] transition-colors ${active ? "bg-yel text-white" : "bg-card2 text-ink"}`}>{icon}</span>
      <span className="text-[13px] text-ink/80">{label}</span>
    </motion.button>
  );
}

/** Story circles with a yellow ring for unseen ones. */
export function Stories({ size = 72 }: { size?: number }) {
  const [seen, setSeen] = useState<string[]>([]);
  return (
    <div className="no-scrollbar -mx-1 flex gap-3 overflow-x-auto px-1 py-1">
      {stories.map((s) => {
        const isSeen = seen.includes(s.id);
        return (
          <button key={s.id} onClick={() => setSeen((x) => [...x, s.id])} className="press shrink-0 text-left">
            <span className={`block rounded-[22px] p-[3px] ${isSeen ? "bg-line" : "bg-yel"}`}>
              <span className="block rounded-[19px] border-[3px] border-bg p-2.5 text-[12px] font-semibold leading-tight"
                style={{ background: s.bg, color: s.fg, width: size + 18, height: size + 18 }}>
                {s.title}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Area chart with range pills. */
export function Chart({ height = 140, data: all = series }: { height?: number; data?: Record<string, number[]> }) {
  const [range, setRange] = useState("1M");
  const data = all[range] ?? all["1M"];
  const { line, area, up, delta } = useMemo(() => {
    const w = 320, h = height, min = Math.min(...data), max = Math.max(...data);
    const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - 8 - ((v - min) / (max - min || 1)) * (h - 24)]);
    const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    return { line, area: `${line} L${w} ${h} L0 ${h} Z`, up: data[data.length - 1] >= data[0], delta: ((data[data.length - 1] - data[0]) / data[0]) * 100 };
  }, [data, height]);
  const col = up ? "var(--color-up)" : "var(--color-down)";
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-[15px] text-dim">Over {range === "1D" ? "a day" : range === "1W" ? "a week" : range === "1M" ? "a month" : "a year"}</span>
        <Change v={delta} className="text-[15px] font-semibold" />
      </div>
      <svg viewBox={`0 0 320 ${height}`} className="mt-3 w-full" style={{ height }} preserveAspectRatio="none">
        <defs>
          <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={col} stopOpacity=".28" />
            <stop offset="1" stopColor={col} stopOpacity="0" />
          </linearGradient>
        </defs>
        <motion.path d={area} fill="url(#fill)" initial={false} animate={{ d: area }} transition={{ duration: 0.5, ease: [0.3, 0.7, 0.2, 1] }} />
        <motion.path d={line} fill="none" stroke={col} strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
          initial={false} animate={{ d: line }} transition={{ duration: 0.5, ease: [0.3, 0.7, 0.2, 1] }} />
      </svg>
      <div className="mt-3 grid grid-cols-4 gap-1 rounded-[14px] bg-card2 p-1">
        {Object.keys(all).map((r) => (
          <button key={r} onClick={() => setRange(r)} className="relative h-9 rounded-[11px] text-[14px] font-semibold">
            {range === r && <motion.span layoutId="range" transition={spring} className="absolute inset-0 rounded-[11px] bg-yel" />}
            <span className={`relative ${range === r ? "text-white" : "text-dim"}`}>{r}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function AssetRow({ h, onClick }: { h: { sym: string; name: string; amount: string; usd: number; change: number }; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="press flex w-full items-center gap-3 rounded-[18px] px-2 py-2.5 text-left hover:bg-card2/60">
      <Coin sym={h.sym} />
      <span className="min-w-0 flex-1">
        <span className="block text-[17px] font-semibold">{h.name}</span>
        <span className="block text-[14px] text-dim">{h.amount}</span>
      </span>
      <span className="text-right">
        <span className="num block text-[17px] font-semibold">{usd(h.usd)}</span>
        <Change v={h.change} className="block text-[14px]" />
      </span>
    </button>
  );
}

const kindIcon: Record<Move["kind"], string> = { swap: "⇄", hold: "‖", buy: "+", review: "✓" };

export function MoveRow({ m, onClick }: { m: Move; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="press flex w-full items-center gap-3 rounded-[18px] px-2 py-2.5 text-left hover:bg-card2/60">
      <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-full text-[18px] font-bold ${m.kind === "hold" || m.kind === "review" ? "bg-card2 text-ink" : "bg-yel text-white"}`}>{kindIcon[m.kind]}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[17px] font-semibold">{m.title}</span>
        <span className="block truncate text-[14px] text-dim">{m.strategy} · {m.when}</span>
      </span>
      {m.amount && <span className="num text-[16px] font-semibold text-up">{m.amount}</span>}
    </button>
  );
}

/** Bottom sheet on phones, centred dialog on desktop. */
/** Bottom sheet on phones, centred dialog on desktop. Portalled to <body> so page transforms can't misplace it. */
export function Sheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    setMounted(true);
    const mq = window.matchMedia("(min-width: 640px)");
    const on = () => setDesktop(mq.matches);
    on(); mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", key);
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", key); };
  }, [open, onClose]);
  if (!mounted) return null;
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.button aria-label="Close" className="absolute inset-0 bg-ink/40 backdrop-blur-[3px]" onClick={onClose} />
          <motion.div role="dialog" aria-modal
            className="relative max-h-[88svh] w-full max-w-[520px] overflow-y-auto rounded-t-[28px] bg-card p-5 pb-[max(2rem,env(safe-area-inset-bottom))] shadow-[0_30px_80px_-30px_rgba(80,30,0,.5)] sm:rounded-[28px] sm:p-7"
            initial={desktop ? { opacity: 0, scale: 0.94, y: 20 } : { y: "100%" }}
            animate={desktop ? { opacity: 1, scale: 1, y: 0 } : { y: 0 }}
            exit={desktop ? { opacity: 0, scale: 0.96, y: 10 } : { y: "100%" }}
            transition={{ type: "spring", stiffness: 380, damping: 34 }}
            drag={desktop ? false : "y"} dragConstraints={{ top: 0, bottom: 0 }} dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={(_, i) => { if (i.offset.y > 100) onClose(); }}>
            {desktop
              ? <button onClick={onClose} aria-label="Close" className="press absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full bg-card2 text-[18px] text-dim hover:text-ink">×</button>
              : <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-line" />}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export function MoveDetail({ m }: { m: Move }) {
  return (
    <div>
      <p className="text-[14px] text-dim">{m.when}</p>
      <h3 className="display mt-2 text-[30px]">{m.title}</h3>
      {m.amount && <p className="num mt-1 text-[20px] font-semibold text-up">{m.amount}</p>}
      <div className="mt-5 rounded-[18px] bg-yel p-4 text-white">
        <p className="text-[13px] font-semibold opacity-70">Why it happened</p>
        <p className="mt-1 text-[17px] leading-snug">{m.why}</p>
      </div>
      <div className="mt-3 divide-y divide-line rounded-[18px] bg-card2">
        {[["Rule", m.rule], ["Strategy", m.strategy], ["Run", "Verified in enclave"]].map(([k, v]) => (
          <div key={k} className="flex justify-between px-4 py-3.5 text-[16px]"><span className="text-dim">{k}</span><span>{v}</span></div>
        ))}
      </div>
    </div>
  );
}

/** The wallet screen used inside the landing-page phone and as the real dashboard. */
export function WalletScreen({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState<Move | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <div className="card p-5">
        <div className="flex items-center justify-between">
          <span className="text-[15px] text-dim">you.near</span>
          <Mark size={28} />
        </div>
        <p className="display num mt-3 text-[44px]">{usd(total)}</p>
        <p className="mt-1 text-[15px]"><span className="num font-semibold text-up">+$412</span> <span className="text-dim">this month</span></p>
        <div className="mt-5 grid grid-cols-4">
          <Action icon="+" label="Add" active />
          <Action icon="⇄" label="Swap" />
          <Action icon="≡" label="Rules" />
          <Action icon="❄" label="Freeze" />
        </div>
      </div>
      {!compact && <div className="card p-5"><Chart /></div>}
      <div className="card p-3">
        <p className="px-2 pb-1 pt-1 text-[20px] font-bold">Assets</p>
        {holdings.slice(0, compact ? 3 : 4).map((h) => <AssetRow key={h.sym} h={h} />)}
      </div>
      {!compact && (
        <div className="card p-3">
          <p className="px-2 pb-1 pt-1 text-[20px] font-bold">Moves, explained</p>
          {moves.map((m) => <MoveRow key={m.id} m={m} onClick={() => setOpen(m)} />)}
          <Sheet open={!!open} onClose={() => setOpen(null)}>{open && <MoveDetail m={open} />}</Sheet>
        </div>
      )}
    </div>
  );
}
