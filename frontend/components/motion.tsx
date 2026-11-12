"use client";
import { motion, type HTMLMotionProps } from "framer-motion";

export const ease = [0.16, 1, 0.3, 1] as const;

/** Slides a line up from behind a mask. Padded on all sides so descenders and overhangs (j, g, y) are never clipped. */
export function Line({ children, delay = 0, className = "" }: { children: React.ReactNode; delay?: number; className?: string }) {
  return (
    <span className={`-mx-[0.12em] -mb-[0.14em] block overflow-hidden whitespace-nowrap px-[0.12em] pb-[0.14em] ${className}`}>
      <motion.span className="block" initial={{ y: "110%" }} whileInView={{ y: 0 }} viewport={{ once: true }}
        transition={{ duration: 0.9, delay, ease }}>
        {children}
      </motion.span>
    </span>
  );
}

/** Lifts a block when it scrolls in. Never hides content at rest. */
export function Reveal({ delay = 0, ...props }: HTMLMotionProps<"div"> & { delay?: number }) {
  return (
    <motion.div initial={{ y: 28, opacity: 0.001 }} whileInView={{ y: 0, opacity: 1 }} viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: 0.8, delay, ease }} {...props} />
  );
}
