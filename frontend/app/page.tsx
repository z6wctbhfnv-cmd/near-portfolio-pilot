"use client";
import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Line, Reveal, ease } from "@/components/motion";
import { Float3D } from "@/components/Float3D";
import { Chevron } from "@/components/WalletButton";
import { Logo } from "@/components/Logo";
import { moves } from "@/lib/demo";

const rules = ["max $150 a week", "NEAR stays at 30%", "acts only past 5% drift", "money goes to your wallet only", "check-in every Sunday", "freeze any time"];

const steps = [
  { img: "bubble", t: "Say it", d: "Write how your money should be handled, the way you’d tell a friend." },
  { img: "shield", t: "Sign it", d: "We turn your words into exact limits. You read them and sign once from your NEAR wallet." },
  { img: "sparkle", t: "Read it", d: "Strategies work inside those limits. Every move, and every skipped one, comes with a reason." },
];

const faq = [
  { img: "wallet", q: "Where is my money kept?", a: "In your own NEAR Intents wallet. Dolya never holds your funds and can’t send them anywhere except back to you." },
  { img: "shield", q: "What stops a strategy from going wild?", a: "Your signed rules. The wallet itself enforces the limits, so a strategy simply can’t spend more or trade bigger than you allowed." },
  { img: "lock", q: "How do I stop everything?", a: "Tap Freeze. All strategies pause at once and nothing trades until you resume." },
  { img: "sparkle", q: "What does the AI actually do?", a: "Once a week it reviews your strategies against your rules and explains what it saw. It can’t move money on its own." },
  { img: "blocks", q: "What is a strategy NFT?", a: "A strategy (a script) minted as an NFT on NEAR. It carries a public weekly record of how the script did. The code stays private: the NFT holds only its hash. Whoever holds the NFT earns its copy fees." },
  { img: "arrow", q: "What does copying cost?", a: "5% of your new profit goes to the strategy’s holder and 0.25% to dolya, weekly, and only while your portfolio is above its previous peak. No new profit, no fee." },
  { img: "question", q: "Does it cost anything else?", a: "Running your own rules is free: real trades pay only the normal network and swap fees. This is a hackathon build; start with paper money." },
];

const social = [
  { img: "blocks", t: "Every strategy is an NFT", d: "Its weekly record is public on NEAR. The code stays private: the NFT holds only its hash." },
  { img: "balance", t: "Copy in one tap", d: "Your agent follows the script inside your own signed limits. It can never trade bigger than you allowed." },
  { img: "arrow", t: "Creators earn 5%", d: "Of copiers’ new profit, and only above their previous peak. No profit, no fee." },
  { img: "wallet", t: "Sell it, income included", d: "Buy a script or offer your own price. The record and the copy fees move with the NFT." },
];

const fade = (d: number) => ({ initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { delay: d, duration: 0.7, ease } });

function Accordion({ items }: { items: { id: string; icon: React.ReactNode; title: string; sub?: string; right?: React.ReactNode; body: React.ReactNode }[] }) {
  const [open, setOpen] = useState<string | null>(items[0]?.id ?? null);
  return (
    <div className="flex flex-col gap-2">
      {items.map((it) => {
        const isOpen = open === it.id;
        return (
          <motion.div layout key={it.id} transition={{ layout: { duration: 0.35, ease } }}
            className={`overflow-hidden rounded-[22px] transition-colors duration-300 ${isOpen ? "bg-card2" : "bg-card hover:bg-[#fffaf5]"}`}>
            <motion.button layout="position" onClick={() => setOpen(isOpen ? null : it.id)} aria-expanded={isOpen}
              className="flex w-full items-center gap-4 p-4 text-left">
              {it.icon}
              <span className="min-w-0 flex-1">
                <span className="block text-[17px] font-semibold">{it.title}</span>
                {it.sub && <span className="block text-[14px] text-dim">{it.sub}</span>}
              </span>
              {it.right}
              <Chevron open={isOpen} />
            </motion.button>
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div key="body" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.35, ease }}>
                  <div className="px-4 pb-5 pl-[76px] pr-14">{it.body}</div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        );
      })}
    </div>
  );
}

export default function Home() {
  return (
    <main className="overflow-x-clip">
      {/* Hero: fills the first screen, ticker sits on its bottom edge */}
      <section className="px-3 sm:px-4">
        <div className="relative mx-auto flex min-h-[560px] max-w-[1400px] flex-col overflow-hidden rounded-[40px] bg-[radial-gradient(120%_90%_at_80%_20%,#ffa53a_0%,#ff7a00_45%,#f45d00_100%)] text-white lg:min-h-[calc(100svh-88px)]">
          <div className="relative mx-auto grid w-full max-w-[1200px] flex-1 grid-cols-1 items-center gap-2 px-5 py-10 sm:gap-6 sm:px-10 sm:py-12 lg:grid-cols-[1fr_1fr]">
            <div className="relative z-10 min-w-0">
              <h1 className="display text-[clamp(1.75rem,8.2vw,2.6rem)] sm:text-[clamp(2.4rem,4.8vw,3.7rem)]">
                <Line delay={0.05}>Your moves.</Line>
                <Line delay={0.15}>Now explained.</Line>
              </h1>
              <motion.p {...fade(0.4)} className="mt-5 max-w-[34ch] text-[17px] leading-snug text-white/90 sm:mt-6 sm:text-[20px]">
                Tell dolya how to handle your crypto. Sign once. Every move comes with a reason you can actually read.
              </motion.p>
              <motion.div {...fade(0.5)} className="mt-7 flex flex-wrap gap-3 sm:mt-9">
                <Link href="/start" className="btn btn-white min-w-[200px] max-sm:flex-1">Set my rules <span className="arrow">→</span></Link>
                <Link href="/dashboard" className="btn btn-ghost min-w-[200px] max-sm:flex-1">Try with paper money</Link>
              </motion.div>
            </div>

            <div className="relative mx-auto aspect-square w-full max-w-[300px] sm:max-w-[520px]">
              <div aria-hidden className="absolute inset-[6%] rounded-full bg-[radial-gradient(closest-side,rgba(255,240,220,.85),rgba(255,214,170,.35)_55%,transparent)]" />
              <Float3D src="/3d/segment.png" size={460} depth={1.2} delay={0.2} rotate={-6} className="absolute inset-0 m-auto max-w-[88%] max-h-[88%]" />
              <Float3D src="/3d/shield.png" size={96} depth={2} delay={0.5} rotate={12} bob={16} className="absolute right-0 top-0" />
              <Float3D src="/3d/bubble.png" size={88} depth={2.4} delay={0.65} rotate={-10} bob={14} className="absolute left-0 top-[6%]" />
              <Float3D src="/3d/sparkle.png" size={84} depth={2.8} delay={0.8} rotate={8} bob={18} className="absolute bottom-[4%] right-[6%]" />
            </div>
          </div>

          <div className="shrink-0 overflow-hidden border-t border-white/20 py-3.5">
            <div className="marquee flex w-max items-center gap-8 whitespace-nowrap text-[17px] font-medium leading-none text-white/95">
              {[...rules, ...rules, ...rules, ...rules].map((r, k) => (
                <span key={k} className="flex items-center gap-8">{r}<img src="/3d/segment.png" alt="" className="h-6 w-6" /></span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-[1200px] px-4 sm:px-6">
        {/* How it works */}
        <section id="how" className="scroll-mt-24 pt-24">
          <p className="text-[15px] font-semibold text-yel">How it works</p>
          <h2 className="display mt-3 text-[clamp(2rem,4.4vw,3.4rem)]"><Line>Three steps.</Line><Line delay={0.08}><span className="text-dim">No jargon.</span></Line></h2>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {steps.map((s, i) => (
              <Reveal key={s.t} delay={i * 0.08}>
                <motion.div whileHover="hover" initial="rest" animate="rest" className="card h-full overflow-hidden p-7">
                  <div className="flex items-start justify-between">
                    <span className="grid h-9 w-9 place-items-center rounded-full bg-card2 text-[15px] font-bold text-yel">{i + 1}</span>
                    <motion.img src={`/3d/${s.img}.png`} alt="" className="-mr-3 -mt-3 h-28 w-28"
                      variants={{ rest: { rotate: 0, scale: 1, y: 0 }, hover: { rotate: -10, scale: 1.12, y: -6 } }}
                      transition={{ type: "spring", stiffness: 260, damping: 12 }} />
                  </div>
                  <h3 className="display mt-6 text-[26px]">{s.t}</h3>
                  <p className="mt-3 text-[17px] leading-snug text-dim">{s.d}</p>
                </motion.div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* Moves feed */}
        <section className="grid items-start gap-10 pt-28 lg:grid-cols-[1fr_1.15fr]">
          <div className="lg:sticky lg:top-28">
            <p className="text-[15px] font-semibold text-yel">Moves, explained <span className="ml-1 rounded-full bg-card2 px-2 py-0.5 text-[12px] font-semibold text-dim">example</span></p>
            <h2 className="display mt-3 text-[clamp(2rem,4.4vw,3.4rem)]"><Line>No mystery</Line><Line delay={0.08}>trades.</Line></h2>
            <p className="mt-5 max-w-[36ch] text-[19px] leading-snug text-dim">Open any move to see the reason, the rule it followed and the strategy that made it.</p>
            <Float3D src="/3d/pie.png" size={320} depth={1} delay={0.1} rotate={-4} className="mt-4 hidden lg:block" />
          </div>
          <Reveal>
            <Accordion items={moves.map((m) => ({
              id: m.id,
              icon: (
                <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-[16px] text-[18px] font-bold ${m.kind === "hold" || m.kind === "review" ? "bg-cream text-yel-deep" : "bg-yel text-white"}`}>
                  {m.kind === "swap" ? "⇄" : m.kind === "buy" ? "+" : m.kind === "hold" ? "‖" : "✓"}
                </span>
              ),
              title: m.title,
              sub: `${m.strategy} · ${m.when}`,
              right: m.amount ? <span className="num text-[15px] font-semibold text-up">{m.amount}</span> : undefined,
              body: (
                <>
                  <p className="text-[16px] leading-snug"><span className="font-semibold text-yel">Why: </span>{m.why}</p>
                  <div className="mt-3 flex flex-wrap gap-2 text-[13px]">
                    <span className="rounded-full bg-white px-3 py-1">Rule: {m.rule}</span>
                    <span className="rounded-full bg-white px-3 py-1 text-up">✓ Verified run</span>
                  </div>
                </>
              ),
            }))} />
          </Reveal>
        </section>

        {/* Social trading: strategy NFTs */}
        <section id="copy" className="scroll-mt-24 pt-28">
          <p className="text-[15px] font-semibold text-yel">Strategy NFTs</p>
          <h2 className="display mt-3 text-[clamp(2rem,4.4vw,3.4rem)]"><Line>Copy the best.</Line><Line delay={0.08} className="max-sm:hidden"><span className="text-dim">Or be the one they copy.</span></Line><Line delay={0.08} className="sm:hidden"><span className="text-dim">Or be the one</span></Line><Line delay={0.16} className="sm:hidden"><span className="text-dim">they copy.</span></Line></h2>
          <p className="mt-5 max-w-[46ch] text-[19px] leading-snug text-dim">Strategies on dolya are scripts with a public track record. Follow one, write your own with AI, or buy one together with the income it earns.</p>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {social.map((c, i) => (
              <Reveal key={c.t} delay={i * 0.06}>
                <motion.div whileHover="hover" initial="rest" animate="rest" className="card h-full overflow-hidden p-6">
                  <motion.img src={`/3d/${c.img}.png`} alt="" className="-ml-2 h-24 w-24"
                    variants={{ rest: { rotate: 0, scale: 1, y: 0 }, hover: { rotate: -8, scale: 1.1, y: -4 } }}
                    transition={{ type: "spring", stiffness: 260, damping: 12 }} />
                  <h3 className="display mt-4 text-[22px]">{c.t}</h3>
                  <p className="mt-2 text-[16px] leading-snug text-dim">{c.d}</p>
                </motion.div>
              </Reveal>
            ))}
          </div>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/leaderboard" className="btn btn-yel">See the leaderboard <span className="arrow">→</span></Link>
            <Link href="/create" className="btn btn-gray">Write your own</Link>
          </div>
        </section>

        {/* Safety */}
        <section className="grid gap-4 pt-28 md:grid-cols-2">
          <Reveal className="card relative flex min-h-[300px] flex-col overflow-hidden p-8 sm:p-10">
            <h3 className="display max-w-[12ch] text-[30px]">Freeze in one tap</h3>
            <p className="mt-3 max-w-[26ch] text-[17px] text-dim">Everything stops until you say go. No forms, no waiting.</p>
            <Float3D src="/3d/lock.png" size={150} depth={0.8} rotate={8} bob={8} className="absolute bottom-6 right-6" />
          </Reveal>
          <Reveal delay={0.06} className="card relative overflow-hidden p-8 sm:p-10">
            <h3 className="display max-w-[14ch] text-[30px]">Your wallet, your money</h3>
            <p className="mt-3 max-w-[32ch] text-[17px] text-dim">Funds never leave your own NEAR wallet. Each strategy run is verified.</p>
            <div className="mt-8 grid grid-cols-3 gap-2 text-center">
              {[["$150", "weekly limit, e.g."], ["30%", "NEAR target, e.g."], ["24/7", "watching"]].map(([a, b]) => (
                <motion.div key={b} whileHover={{ y: -4 }} className="rounded-[18px] bg-card2 px-2 py-4"><p className="num text-[22px] font-bold">{a}</p><p className="text-[13px] text-dim">{b}</p></motion.div>
              ))}
            </div>
          </Reveal>
        </section>

        {/* FAQ */}
        <section id="faq" className="grid scroll-mt-24 items-start gap-10 pt-28 lg:grid-cols-[1fr_1.15fr]">
          <div className="lg:sticky lg:top-28">
            <p className="text-[15px] font-semibold text-yel">FAQ</p>
            <h2 className="display mt-3 text-[clamp(2rem,4.4vw,3.4rem)]"><Line>Good</Line><Line delay={0.08}>questions.</Line></h2>
            <Float3D src="/3d/question.png" size={260} depth={1} rotate={6} className="mt-6 hidden lg:block" />
          </div>
          <Reveal>
            <Accordion items={faq.map((f, k) => ({
              id: `f${k}`,
              icon: <img src={`/3d/${f.img}.png`} alt="" className="h-12 w-12 shrink-0" />,
              title: f.q,
              body: <p className="text-[16px] leading-snug text-ink/80">{f.a}</p>,
            }))} />
          </Reveal>
        </section>

        {/* CTA */}
        <Reveal className="relative mt-24 overflow-hidden rounded-[40px] bg-[radial-gradient(120%_120%_at_90%_10%,#ffa53a_0%,#ff7a00_50%,#f45d00_100%)] p-10 text-white sm:p-16">
          <h2 className="display max-w-[14ch] text-[clamp(2rem,4.4vw,3.4rem)]">Set your rules in a minute</h2>
          <p className="mt-4 max-w-[34ch] text-[18px] text-white/85">Connect your NEAR wallet and write what you want. That’s it.</p>
          <Link href="/start" className="btn btn-white mt-8">Start now <span className="arrow">→</span></Link>
          <Float3D src="/3d/segment.png" size={300} depth={1} rotate={-12} className="absolute -bottom-6 right-4 hidden sm:block" />
        </Reveal>

        {/* Footer */}
        <footer className="mt-16 grid gap-8 border-t border-line py-12 sm:grid-cols-[1.2fr_1fr_1fr]">
          <div>
            <Logo />
            <p className="mt-3 max-w-[30ch] text-[15px] text-dim">Your moves, now explained. Copy, create, earn. Built at the NEAR Hackathon 2026.</p>
          </div>
          <div className="flex flex-col gap-2 text-[16px]">
            <p className="text-[13px] font-semibold uppercase tracking-wide text-dim">Learn</p>
            <a href="#how" className="w-fit hover:text-yel">How it works</a>
            <a href="#copy" className="w-fit hover:text-yel">Strategy NFTs</a>
            <a href="#faq" className="w-fit hover:text-yel">FAQ</a>
          </div>
          <div className="flex flex-col gap-2 text-[16px]">
            <p className="text-[13px] font-semibold uppercase tracking-wide text-dim">App</p>
            <Link href="/dashboard" className="w-fit hover:text-yel">Portfolio</Link>
            <Link href="/strategies" className="w-fit hover:text-yel">Strategies</Link>
            <Link href="/leaderboard" className="w-fit hover:text-yel">Leaderboard</Link>
            <Link href="/start" className="w-fit hover:text-yel">Set rules</Link>
          </div>
          <p className="text-[13px] text-dim sm:col-span-3">Demo. Not financial advice.</p>
        </footer>
      </div>
    </main>
  );
}
