"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";

const tabs = [
  { href: "/", label: "Home", img: "segment" },
  { href: "/dashboard", label: "Portfolio", img: "pie" },
  { href: "/strategies", label: "Strategies", img: "arrow" },
  { href: "/start", label: "Rules", img: "shield" },
];

/** Bottom tab bar on phones, like a banking app. */
export function TabBar() {
  const path = usePathname();
  if (path.startsWith("/studio")) return null;
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg/90 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5 backdrop-blur-xl md:hidden">
      <div className="mx-auto grid max-w-[480px] grid-cols-4">
        {tabs.map((t) => {
          const active = t.href === "/" ? path === "/" : path.startsWith(t.href);
          return (
            <Link key={t.href} href={t.href} className="relative flex flex-col items-center gap-0.5 rounded-[14px] py-1.5">
              {active && <motion.span layoutId="tab-bg" className="absolute inset-0 rounded-[14px] bg-card2" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}
              <motion.img src={`/3d/${t.img}.png`} alt="" className="relative h-7 w-7" animate={{ scale: active ? 1.12 : 1, y: active ? -1 : 0 }} transition={{ type: "spring", stiffness: 400, damping: 18 }} />
              <span className={`relative text-[11px] font-semibold ${active ? "text-ink" : "text-dim"}`}>{t.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
