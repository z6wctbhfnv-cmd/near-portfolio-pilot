"use client";
import { motion } from "framer-motion";
import { ease } from "./motion";

/** Area chart that reveals left to right; green when the period ends up, red when down. */
export function Area({ data, w = 300, h = 80, id }: { data: number[]; w?: number; h?: number; id: string }) {
  const max = Math.max(...data), min = Math.min(...data);
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - 4 - ((v - min) / (max - min || 1)) * (h - 10)]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const col = data[data.length - 1] >= data[0] ? "var(--color-up)" : "var(--color-down)";
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height: h }} preserveAspectRatio="none">
      <defs>
        <linearGradient id={`g-${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={col} stopOpacity=".22" /><stop offset="1" stopColor={col} stopOpacity="0" /></linearGradient>
        <clipPath id={`c-${id}`}><motion.rect x="0" y="0" height={h} initial={{ width: 0 }} whileInView={{ width: w }} viewport={{ once: true }} transition={{ duration: 1.2, ease }} /></clipPath>
      </defs>
      <g clipPath={`url(#c-${id})`}>
        <path d={`${line} L${w} ${h} L0 ${h} Z`} fill={`url(#g-${id})`} />
        <path d={line} fill="none" stroke={col} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </g>
    </svg>
  );
}

