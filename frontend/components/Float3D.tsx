"use client";
import { motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import { useEffect } from "react";

/** A 3D object image that bobs gently and leans toward the cursor. */
export function Float3D({ src, size, depth = 1, delay = 0, rotate = 0, className = "", bob = 12 }:
  { src: string; size: number; depth?: number; delay?: number; rotate?: number; className?: string; bob?: number }) {
  const mx = useMotionValue(0), my = useMotionValue(0);
  const sx = useSpring(mx, { stiffness: 60, damping: 15 }), sy = useSpring(my, { stiffness: 60, damping: 15 });
  const x = useTransform(sx, (v) => v * 18 * depth), y = useTransform(sy, (v) => v * 14 * depth);
  const rotY = useTransform(sx, (v) => v * 10 * depth);

  useEffect(() => {
    const onMove = (e: PointerEvent) => { mx.set(e.clientX / window.innerWidth - 0.5); my.set(e.clientY / window.innerHeight - 0.5); };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [mx, my]);

  return (
    <motion.div className={`pointer-events-none select-none ${className}`} style={{ x, y, rotateY: rotY, width: size, height: size }}
      initial={{ opacity: 0, scale: 0.4, rotate: rotate - 25 }} animate={{ opacity: 1, scale: 1, rotate }}
      transition={{ delay, type: "spring", stiffness: 110, damping: 12 }}>
      <motion.img src={src} alt="" draggable={false} className="h-full w-full drop-shadow-[0_30px_30px_rgba(120,40,0,0.25)]"
        animate={{ y: [0, -bob, 0] }} transition={{ duration: 5 + delay * 2, repeat: Infinity, ease: "easeInOut", delay }} />
    </motion.div>
  );
}
