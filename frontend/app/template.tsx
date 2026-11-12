"use client";
import { motion } from "framer-motion";

/** Runs on every route change: the new page rises in softly. */
export default function Template({ children }: { children: React.ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 18, filter: "blur(3px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}>
      {children}
    </motion.div>
  );
}
