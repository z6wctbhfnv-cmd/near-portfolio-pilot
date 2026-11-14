"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { api, type Fees, type Gate, type HealthCheck, type Pilot, type Swarm } from "@/lib/api";

const usd = (n: number | null | undefined) => (n == null ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct = (bps: number) => `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
const day = (t: number) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const STRAT: Record<string, string> = { rebalance: "Constant mix", trend: "Trend filter", vol_target: "Volatility target", dca: "Weekly buys" };

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setData(await fn()); setError(null); } catch (e) { setError((e as Error).message); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { load(); }, [load]);
  return { data, error, reload: load };
}

function Card({ eyebrow, title, img, children }: { eyebrow: string; title: string; img: string; children: React.ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} className="card p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[14px] text-dim">{eyebrow}</p>
          <p className="display mt-2 text-[24px]">{title}</p>
        </div>
        <img src={`/3d/${img}.png`} alt="" className="h-16 w-16 shrink-0" />
      </div>
      {children}
    </motion.div>
  );
}

/* ------------------------------------------------------------ copying a script */

export function CopyingCard({ pilot, onChanged }: { pilot: Pilot; onChanged: () => void }) {
  const f = pilot.following;
  const gate = useLoad<Gate | null>(() => (f ? api.scriptGate(f.token_id) : Promise.resolve(null)), [f?.token_id]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const stop = async () => {
    setBusy(true);
    try { await api.unfollow(pilot.id); onChanged(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  if (!f) {
    return (
      <Card eyebrow="Social trading" title="Copy a script" img="blocks">
        <p className="mt-3 text-[15px] leading-snug text-dim">Every script is an NFT with a public record. Copy one and your pilot runs it inside your own rules. The script’s holder earns a share of your <b className="text-ink">new</b> profit, only above your previous peak.</p>
        <Link href="/leaderboard" className="btn btn-yel mt-4 !h-11 !text-[15px]">Browse the leaderboard <span className="arrow">→</span></Link>
      </Card>
    );
  }
  const g = gate.data;
  return (
    <Card eyebrow="Social trading" title={`Copying ${f.token_id}`} img="blocks">
      <p className="mt-2 text-[15px] text-dim">Runs {STRAT[f.strategy_id] ?? f.strategy_id} on paper since {day(f.since)}.</p>
      {g && (
        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-[16px] bg-card2 p-3"><p className="text-[12px] text-dim">Holder</p><p className="mt-1 truncate text-[14px] font-semibold">{g.holder ?? "—"}</p></div>
          <div className="rounded-[16px] bg-card2 p-3"><p className="text-[12px] text-dim">Bond held</p><p className="num mt-1 text-[16px] font-bold">{usd(g.held_usd)}</p></div>
          <div className="rounded-[16px] bg-card2 p-3"><p className="text-[12px] text-dim">Required</p><p className="num mt-1 text-[16px] font-bold">{usd(g.required_usd)}</p></div>
        </div>
      )}
      {g && (
        <p className={`mt-3 rounded-[14px] px-3 py-2 text-[14px] ${g.open ? "bg-[#e8f7ee] text-up" : "bg-cream/70 text-ink/80"}`}>
          {g.open ? "Copying is open on chain: " : "On chain this copy would wait: "}{g.reason}.
        </p>
      )}
      {(err || gate.error) && <p className="mt-2 text-[14px] text-down">{err ?? gate.error}</p>}
      <button onClick={stop} disabled={busy} className="mt-4 text-[15px] font-semibold text-yel disabled:opacity-50">{busy ? "Stopping…" : "Stop copying"}</button>
    </Card>
  );
}

/* ------------------------------------------------------------ fees */

const FEE_STATUS: Record<string, string> = {
  paper_paid: "paid (paper)", no_profit: "no new profit", carried: "carried to next week", SUCCESS: "paid", blocked: "blocked", refused: "refused",
};

export function FeesCard({ pilot }: { pilot: Pilot }) {
  const fees = useLoad<Fees>(() => api.fees(pilot.id), [pilot.id, pilot.following?.token_id]);
  const d = fees.data;
  const holderBps = d?.estimate ? d.estimate.payment_bps - (d.terms.platform_bps ?? 25) : d?.terms.holder_bps_default ?? 500;
  return (
    <Card eyebrow="Fees" title={pilot.following ? "You pay only on new profit" : "Your own strategy"} img="balance">
      {!d ? <p className="mt-3 text-[15px] text-dim">{fees.error ? `Fees unavailable: ${fees.error}` : "Loading…"}</p> : (
        <>
          <p className="mt-3 text-[15px] leading-snug text-dim">
            {pilot.following
              ? <>Weekly, on profit above your previous peak: <b className="text-ink">{pct(holderBps)}</b> to the script’s holder and <b className="text-ink">{pct(d.terms.platform_bps)}</b> to dolya. A referrer gets {pct(d.terms.referral_bps_of_platform)} out of dolya’s part, never out of yours.</>
              : <>You run your own strategy, so no holder fee. dolya takes {pct(d.terms.platform_bps)} of new profit only on copied scripts.</>}
          </p>
          {d.estimate && (
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-[16px] bg-card2 p-3"><p className="text-[12px] text-dim">Value now</p><p className="num mt-1 text-[16px] font-bold">{usd(d.estimate.equity_usd)}</p></div>
              <div className="rounded-[16px] bg-card2 p-3"><p className="text-[12px] text-dim">Peak</p><p className="num mt-1 text-[16px] font-bold">{usd(d.estimate.peak_usd)}</p></div>
              <div className="rounded-[16px] bg-card2 p-3"><p className="text-[12px] text-dim">Fee so far</p><p className="num mt-1 text-[16px] font-bold">{usd(d.estimate.fee_usd)}</p></div>
            </div>
          )}
          {d.estimate && d.estimate.profit_usd <= 0 && <p className="mt-2 text-[14px] text-dim">Below the peak: nothing to pay this week.</p>}
          {d.data.length > 0 && (
            <ul className="mt-4 flex flex-col gap-2">
              {d.data.slice(0, 4).map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 rounded-[14px] bg-card2 px-3 py-2.5 text-[14px]">
                  <span>Week to {day(r.period_end_ms)}</span>
                  <span className="num font-semibold">{usd(r.fee_usd)} <span className="font-normal text-dim">· {FEE_STATUS[r.status] ?? r.status}</span></span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[12px] text-dim">{d.terms.payments_enabled ? "Live fees are paid in USDC to the strategy NFT contract." : "Paper ledger: no real money moves."}</p>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------ health */

const SEV: Record<string, string> = { ok: "bg-[#e8f7ee] text-up", warn: "bg-cream text-yel-deep", stop: "bg-[#fdecea] text-down", muted: "bg-card2 text-dim" };

export function HealthCard({ pilot, onChanged }: { pilot: Pilot; onChanged: () => void }) {
  const h = useLoad<{ latest: HealthCheck | null }>(() => api.pilotHealth(pilot.id), [pilot.id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const latest = h.data?.latest ?? null;
  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setErr(null);
    try { await fn(); await h.reload(); onChanged(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  const issues = latest?.findings.filter((f) => f.severity !== "ok") ?? [];
  const title = !latest ? "Not checked yet" : latest.status === "ok" ? "All healthy" : latest.status === "stop" ? "Needs your call" : "Worth a look";
  return (
    <Card eyebrow="Daily health check" title={title} img="shield">
      <p className="mt-3 text-[15px] leading-snug text-dim">Once a day dolya checks the script for errors, stale prices, slippage and drift from its simulation. It never pauses on its own; you decide.</p>
      {latest && (
        <ul className="mt-4 flex flex-col gap-2">
          {(issues.length ? issues : latest.findings.slice(0, 3)).map((f, k) => (
            <li key={k} className="flex items-start gap-3 rounded-[14px] bg-card2 px-3 py-2.5 text-[14px]">
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${SEV[f.severity] ?? SEV.muted}`}>{f.severity}</span>
              <span className="min-w-0 flex-1 leading-snug">{f.detail}</span>
            </li>
          ))}
        </ul>
      )}
      <AnimatePresence>
        {latest?.question && !latest.answer && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-4 rounded-[18px] bg-yel p-4 text-white">
            <p className="text-[16px] font-semibold leading-snug">{latest.question.text}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {latest.question.options.map((o) => (
                <motion.button key={o.id} whileTap={{ scale: 0.95 }} disabled={!!busy} onClick={() => act(o.id, () => api.healthAnswer(latest.id, o.id))}
                  className={`rounded-[12px] px-4 py-2 text-[15px] font-semibold disabled:opacity-60 ${o.id === "pause" ? "bg-white text-yel-deep" : "bg-white/20 text-white"}`}>
                  {busy === o.id ? "…" : o.label}
                </motion.button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {latest?.answer && <p className="mt-3 text-[14px] text-dim">You answered “{latest.answer === "pause" ? "Pause" : "Keep running"}”.</p>}
      {(err || h.error) && <p className="mt-2 text-[14px] text-down">{err ?? h.error}</p>}
      <button onClick={() => act("check", () => api.healthCheck(pilot.id))} disabled={!!busy} className="mt-4 text-[15px] font-semibold text-yel disabled:opacity-50">{busy === "check" ? "Checking…" : "Check now →"}</button>
    </Card>
  );
}

/* ------------------------------------------------------------ swarm */

const SCRIPTS = [
  { id: "rebalance", name: "Constant mix" },
  { id: "trend", name: "Trend filter" },
  { id: "vol_target", name: "Volatility target" },
  { id: "dca", name: "Weekly buys" },
] as const;

export function SwarmCard({ pilot, onChanged }: { pilot: Pilot; onChanged: () => void }) {
  const s = useLoad<Swarm>(() => api.swarm(pilot.id), [pilot.id, pilot.swarm ? JSON.stringify(pilot.swarm) : ""]);
  const [pick, setPick] = useState<string[]>(["rebalance", "trend"]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const assets = pilot.mandate?.assets?.length ? pilot.mandate.assets : ["NEAR", "BTC", "ETH"];
  const params = (id: string) => {
    const w = Object.fromEntries(assets.map((a) => [a, Number((0.6 / assets.length).toFixed(4))]));
    return id === "dca" ? { buy: Object.fromEntries(assets.map((a) => [a, 1 / assets.length])), amount_usd: 20, every_days: 7 } : { weights: w };
  };
  const save = async () => {
    setBusy(true); setErr(null);
    try { await api.setSwarm(pilot.id, { scripts: pick.map((id) => ({ key: id, id, params: params(id) })), allocation: "equal" }); await s.reload(); onChanged(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const clear = async () => {
    setBusy(true); setErr(null);
    try { await api.clearSwarm(pilot.id); await s.reload(); onChanged(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const swarm = s.data?.swarm;
  return (
    <Card eyebrow="Agent swarm" title={swarm ? `${swarm.scripts.length} scripts, one wallet` : "Run several scripts"} img="sparkle">
      <p className="mt-3 text-[15px] leading-snug text-dim">A main agent splits your money between scripts and nets their trades inside your wallet, so two scripts never pay fees to trade against each other. Your signed limits apply to the total.</p>
      {swarm ? (
        <>
          <ul className="mt-4 flex flex-col gap-2">
            {(s.data?.state?.sleeves ?? swarm.scripts.map((x) => ({ key: x.key, cash: false, share: null, value_usd: 0 }))).map((sl) => (
              <li key={sl.key} className="flex items-center justify-between gap-3 rounded-[14px] bg-card2 px-3 py-2.5 text-[14px]">
                <span className="font-semibold">{sl.cash ? "Unassigned cash" : SCRIPTS.find((x) => x.id === sl.key)?.name ?? sl.key}</span>
                <span className="num text-dim">{sl.share != null ? `${Math.round(sl.share * 100)}% · ` : ""}{usd(sl.value_usd)}</span>
              </li>
            ))}
          </ul>
          {s.data?.state?.alloc_reason && <p className="mt-2 text-[13px] text-dim">{s.data.state.alloc_reason}</p>}
          {!s.data?.state && <p className="mt-2 text-[13px] text-dim">The split starts on the next run.</p>}
          <button onClick={clear} disabled={busy} className="mt-4 text-[15px] font-semibold text-yel disabled:opacity-50">Back to one strategy</button>
        </>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            {SCRIPTS.map((x) => {
              const on = pick.includes(x.id);
              return (
                <button key={x.id} onClick={() => setPick(on ? pick.filter((p) => p !== x.id) : [...pick, x.id].slice(0, 5))}
                  className={`rounded-full px-3 py-1.5 text-[14px] font-semibold ${on ? "bg-yel text-white" : "bg-card2 text-ink"}`}>{x.name}</button>
              );
            })}
          </div>
          <motion.button whileTap={{ scale: 0.96 }} onClick={save} disabled={busy || pick.length < 2} className="btn btn-yel mt-4 !h-11 !text-[15px] disabled:opacity-50">
            {busy ? "Saving…" : `Run ${pick.length} scripts together`}
          </motion.button>
        </>
      )}
      {(err || s.error) && <p className="mt-2 text-[14px] text-down">{err ?? s.error}</p>}
    </Card>
  );
}
