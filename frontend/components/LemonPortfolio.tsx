"use client";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

/**
 * The hero object: a lemon cross-section whose segments are the portfolio.
 * Every few seconds a strategy acts, a segment changes size, and the reason is written out.
 */

const ASSETS = [
  { sym: "USDC", tone: "#ffdd2d" },
  { sym: "NEAR", tone: "#ffe873" },
  { sym: "ETH", tone: "#ffd21a" },
  { sym: "BTC", tone: "#fff0a0" },
];

const STEPS = [
  { alloc: [45, 26, 16, 13], hit: -1, chip: "watching", title: "All inside your rules", why: "Nothing to do. Every holding sits within 4 points of its target." },
  { alloc: [41, 30, 16, 13], hit: 1, chip: "swap", title: "400 USDC → 71.4 NEAR", why: "NEAR fell to 26%. Your target is 30%, so it bought back to target." },
  { alloc: [39, 30, 16, 15], hit: 3, chip: "buy", title: "$120 of BTC", why: "Your weekly buy. Same amount, same day, whatever the price did." },
  { alloc: [39, 30, 16, 15], hit: 2, chip: "skip", title: "Left ETH alone", why: "ETH drifted 3%. You said act only past 5%, and the fee would eat the gain." },
];

const C = 200, R = 158, IR = 16, GAP = 3.2; // degrees between segments

const pt = (r: number, deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return `${(C + r * Math.cos(a)).toFixed(2)} ${(C + r * Math.sin(a)).toFixed(2)}`;
};

/** Same command structure for every segment, so framer can morph between sizes. */
function wedge(a0: number, a1: number) {
  const s = a0 + GAP / 2, e = a1 - GAP / 2;
  return `M${pt(IR, s)} L${pt(R, s)} A${R} ${R} 0 0 1 ${pt(R, e)} L${pt(IR, e)} A${IR} ${IR} 0 0 0 ${pt(IR, s)} Z`;
}

export function LemonPortfolio() {
  const [i, setI] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % STEPS.length), 3800);
    return () => clearInterval(id);
  }, []);
  const step = STEPS[i];

  let acc = 0;
  const segs = step.alloc.map((p) => { const a0 = acc; acc += (p / 100) * 360; return [a0, acc] as const; });
  const focus = hover ?? step.hit;

  return (
    <div className="relative mx-auto w-full max-w-[520px]">
      <motion.svg viewBox="0 0 400 400" className="w-full overflow-visible"
        initial={{ scale: 0.6, rotate: -120, opacity: 0 }} animate={{ scale: 1, rotate: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 60, damping: 14, delay: 0.15 }}>
        <motion.g animate={{ rotate: 360 }} transition={{ duration: 160, repeat: Infinity, ease: "linear" }} style={{ originX: "200px", originY: "200px" }}>
          <circle cx={C} cy={C} r={192} fill="#ffdd2d" />
          <circle cx={C} cy={C} r={178} fill="#fff6cc" />
          <circle cx={C} cy={C} r={166} fill="#fff6cc" />
          {segs.map(([a0, a1], k) => (
            <motion.path key={ASSETS[k].sym}
              initial={false}
              animate={{ d: wedge(a0, a1), fill: focus === k ? "#ffffff" : ASSETS[k].tone }}
              transition={{ type: "spring", stiffness: 90, damping: 16 }}
              onMouseEnter={() => setHover(k)} onMouseLeave={() => setHover(null)}
              className="cursor-pointer" />
          ))}
          {/* juice cells */}
          {segs.map(([a0, a1], k) => {
            const mid = (a0 + a1) / 2;
            return [0.45, 0.7].map((f, j) => (
              <motion.circle key={`${k}-${j}`} r={j ? 5 : 3.5} fill="#fff6cc" opacity={0.7}
                initial={false} animate={{ cx: C + R * f * Math.cos(((mid - 90 + (j ? 6 : -5)) * Math.PI) / 180), cy: C + R * f * Math.sin(((mid - 90 + (j ? 6 : -5)) * Math.PI) / 180) }}
                transition={{ type: "spring", stiffness: 90, damping: 16 }} pointerEvents="none" />
            ));
          })}
          <circle cx={C} cy={C} r={12} fill="#fff6cc" />
        </motion.g>
      </motion.svg>

      {/* Legend */}
      <div className="mt-6 grid grid-cols-4 gap-2">
        {ASSETS.map((a, k) => (
          <button key={a.sym} onMouseEnter={() => setHover(k)} onMouseLeave={() => setHover(null)}
            className={`rounded-[14px] px-3 py-2 text-left transition-colors ${focus === k ? "bg-ink text-black" : "bg-card text-ink"}`}>
            <span className="block text-[13px] opacity-70">{a.sym}</span>
            <motion.span key={step.alloc[k]} initial={{ y: 8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="num block text-[20px] font-semibold">{step.alloc[k]}%</motion.span>
          </button>
        ))}
      </div>

      {/* Reason */}
      <div className="mt-2 min-h-[132px] rounded-[20px] bg-card p-5">
        <AnimatePresence mode="wait">
          <motion.div key={i} initial={{ opacity: 0, y: 12, filter: "blur(6px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={{ opacity: 0, y: -10, filter: "blur(6px)" }} transition={{ duration: 0.45 }}>
            <div className="flex items-center gap-2">
              <span className={`rounded-full px-2.5 py-1 text-[12px] font-bold ${step.hit === -1 || step.chip === "skip" ? "bg-card2 text-ink" : "bg-yel text-black"}`}>{step.chip}</span>
              <span className="text-[17px] font-semibold text-white">{step.title}</span>
            </div>
            <p className="mt-3 text-[16px] leading-snug text-white/80">
              <span className="font-semibold text-yel">why? </span>
              {step.why.split(" ").map((w, k) => (
                <motion.span key={k} className="inline-block whitespace-pre" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + k * 0.03 }}>{w} </motion.span>
              ))}
            </p>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
