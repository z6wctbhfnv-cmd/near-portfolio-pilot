"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, useMotionValueEvent, useScroll } from "framer-motion";
import { useState } from "react";
import { Logo } from "./Logo";
import { WalletButton } from "./WalletButton";

const links = [
  { href: "/dashboard", label: "Portfolio" },
  { href: "/strategies", label: "Strategies" },
  { href: "/start", label: "Rules" },
];

export function Nav() {
  const path = usePathname();
  const onHero = path === "/";
  const { scrollY } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  useMotionValueEvent(scrollY, "change", (y) => setScrolled(y > 40));
  const light = false; void onHero; void scrolled;
  if (path.startsWith("/studio")) return null;

  return (
    <header className={`sticky top-0 z-40 transition-colors duration-300 ${light ? "bg-yel" : "bg-bg/85 backdrop-blur-xl"}`}>
      <div className="mx-auto flex h-[72px] max-w-[1200px] items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" aria-label="dolya home"><Logo light={light} /></Link>
        <nav className={`hidden items-center gap-1 rounded-[16px] p-1 md:flex ${light ? "bg-white/15" : "bg-card2"}`}>
          {links.map((l) => {
            const active = path.startsWith(l.href);
            return (
              <Link key={l.href} href={l.href} className="relative rounded-[12px] px-4 py-2 text-[15px] font-medium">
                {active && <motion.span layoutId="nav" className="absolute inset-0 rounded-[12px] bg-card shadow-sm" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}
                <span className={`relative transition-colors ${active ? "text-ink" : light ? "text-white/85 hover:text-white" : "text-dim hover:text-ink"}`}>{l.label}</span>
              </Link>
            );
          })}
        </nav>
        <WalletButton />
      </div>
    </header>
  );
}
