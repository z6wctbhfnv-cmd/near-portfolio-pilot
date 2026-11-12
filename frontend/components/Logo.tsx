"use client";
import { motion } from "framer-motion";

/** 3D orange segment, rendered in the studio and saved as /3d/segment.png. */
export function Mark({ size = 32, animate = false, tilt = 0 }: { size?: number; animate?: boolean; tilt?: number; tone?: string }) {
  return (
    <motion.img src="/3d/segment.png" alt="" width={size} height={size} draggable={false}
      style={{ width: size, height: size }}
      initial={animate ? { scale: 0.3, rotate: tilt - 40, opacity: 0 } : false}
      animate={{ scale: 1, rotate: tilt, opacity: 1 }}
      whileHover={{ rotate: tilt + 12, scale: 1.08 }}
      transition={{ type: "spring", stiffness: 260, damping: 14 }} />
  );
}

export function Logo({ light = false }: { light?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 ${light ? "text-white" : "text-ink"}`}>
      <Mark size={40} />
      <span className="display text-[22px] leading-none">dolya</span>
    </span>
  );
}
