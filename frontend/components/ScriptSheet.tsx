"use client";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Area } from "./Area";
import { Change } from "./ui";
import { NftActionSheet, useNftWallet, type NftAction } from "./nftWallet";
import { offersOn, type Offer, nearToYocto, yoctoToNearExact, periodStats, recordChange, scriptTitle, simulatedRecord, yoctoToNear, type OpenParam } from "@/lib/chain";
import { NFT, explorerAccount } from "@/lib/config";
import { sha256 } from "@/lib/scriptCheck";
import type { LeaderRow } from "@/lib/useLeaderboard";
import { api, currentPilotId } from "@/lib/api";

const day = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const pctFee = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;
const short = (s: string, n = 10) => (s.length > n * 2 + 8 ? `${s.slice(0, n)}…${s.slice(-8)}` : s);

/** The script's own image: same object family as the strategies page. */
export const scriptImg = (id: string) => {
  const k = id.split("@")[0];
  if (/rebalance/.test(k)) return "balance";
  if (/trend|momentum|breakout|donchian/.test(k)) return "arrow";
  if (/vol|carry|funding/.test(k)) return "blocks";
  if (/dca|dip/.test(k)) return "calendar";
  if (/gold|relative|reversion/.test(k)) return "pie";
  return "sparkle";
};

/** Version label: "v1 · since mint", or "v3 · changed 12 Nov 2026" once the holder replaced the code. */
export const versionLabel = (v: number, at: number) => (v > 1 && at ? `v${v} · changed ${day(at)}` : `v${v} · since mint`);

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-4 px-4 py-3 text-[15px]"><span className="shrink-0 text-dim">{k}</span><span className="min-w-0 text-right font-semibold">{children}</span></div>;
}

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="mt-6">
      <p className="text-[17px] font-bold">{title}</p>
      {sub && <p className="mt-0.5 text-[14px] text-dim">{sub}</p>}
      <div className="mt-2">{children}</div>
    </div>
  );
}

const TUNED = "dolya.tuned";
const readTuned = (): Record<string, Record<string, number>> => { try { return JSON.parse(localStorage.getItem(TUNED) ?? "{}"); } catch { return {}; } };

export function ScriptSheetBody({ row, days, periodLabel, onChanged }: { row: LeaderRow; days: number; periodLabel: string; onChanged: () => void }) {
  const { accountId } = useNftWallet();
  const c = row.chain, bt = row.bt;
  const isHolder = !!c && accountId === c.holder;
  const [demoHolder, setDemoHolder] = useState(false);
  const holderView = isHolder || demoHolder;
  const [action, setAction] = useState<NftAction | null>(null);
  const [price, setPrice] = useState("");
  const [fee, setFee] = useState(c ? String(c.fee.bps / 100) : "5");
  const [code, setCode] = useState("");
  const [params, setParams] = useState<OpenParam[]>(c?.openParams ?? []);
  const [tuned, setTuned] = useState<Record<string, number>>({});
  useEffect(() => { setTuned(readTuned()[row.id] ?? {}); }, [row.id]);

  const raw = bt ? periodStats(bt, days, c && c.version > 1 ? c.changedAt : 0) : null;
  const restarted = !!raw && raw.days === 0;
  const st = raw && raw.days > 0 ? raw : null;
  const change = c ? recordChange(c.record) : null;
  const bondOk = c ? c.bond.held >= c.bond.required : false;
  const runnable = /^wasm-(rebalance|trend|vol-target|dca)@/.test(row.id);
  const [offers, setOffers] = useState<Offer[] | null | undefined>(undefined);
  const [bid, setBid] = useState("");
  const loadOffers = () => { offersOn(row.id).then(setOffers).catch(() => setOffers(undefined)); };
  useEffect(loadOffers, [row.id]);
  const mine = offers?.find((o) => o.account === accountId);
  const [copy, setCopy] = useState<{ busy: boolean; ok?: boolean; text?: string }>({ busy: false });
  const doCopy = async () => {
    const pid = currentPilotId();
    if (!pid) { setCopy({ busy: false, ok: false, text: "Start a portfolio first (Portfolio → Start with paper money), then copy this script into it." }); return; }
    setCopy({ busy: true });
    try {
      const r = await api.follow(pid, row.id);
      setCopy({ busy: false, ok: true, text: `${r.note} Open Portfolio to see it run.` });
    } catch (e) { setCopy({ busy: false, ok: false, text: (e as Error).message }); }
  };
  const who = c?.holder;

  const tune = (name: string, v: number) => {
    const next = { ...tuned, [name]: v };
    setTuned(next);
    try { localStorage.setItem(TUNED, JSON.stringify({ ...readTuned(), [row.id]: next })); } catch { /* blocked */ }
  };

  const newVersion = async () => {
    const t = code.trim();
    const hash = /^[0-9a-f]{64}$/i.test(t) ? t.toLowerCase() : await sha256(t);
    setAction({ title: `Publish v${(c?.version ?? 1) + 1}`, method: "update_script", args: { token_id: row.id, code_hash: hash }, deposit: "0.01", who,
      why: `Points the NFT at new code. The weekly record restarts from zero and the label becomes “v${(c?.version ?? 1) + 1} · changed ${day(Date.now())}”. Copiers’ agents see the change and ask their owners before following it.` });
  };

  return (
    <div>
      <div className="flex items-center gap-4">
        <img src={`/3d/${scriptImg(row.id)}.png`} alt="" className="h-20 w-20 shrink-0" />
        <div className="min-w-0">
          <h3 className="display text-[24px]">{scriptTitle(row.id)}</h3>
          <p className="truncate text-[14px] text-dim">{row.id}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {c ? <span className="rounded-full bg-[#e8f7ee] px-2.5 py-1 text-[12px] font-semibold text-up">NFT on {NFT.network} ✓</span> : <span className="rounded-full bg-card2 px-2.5 py-1 text-[12px] font-semibold text-dim">not on chain</span>}
        {c && <span className="rounded-full bg-card2 px-2.5 py-1 text-[12px] font-semibold">{versionLabel(c.version, c.changedAt)}</span>}
        {bt?.uses_perps && <span className="rounded-full bg-card2 px-2.5 py-1 text-[12px] font-semibold">perps</span>}
        {c?.hidden && <span className="rounded-full bg-card2 px-2.5 py-1 text-[12px] font-semibold">hidden by holder</span>}
      </div>
      {(bt?.doc || c?.description) && <p className="mt-3 text-[16px] leading-snug">{bt?.doc ?? c?.description}</p>}

      <div className="mt-4 rounded-[18px] bg-card2 p-4">
        {st && st.curve.length > 1 ? <Area data={st.curve} id={`lb-${row.id}`} h={100} /> : <p className="py-6 text-center text-[14px] text-dim">{restarted && c ? `The holder changed the code (${versionLabel(c.version, c.changedAt)}), so the record started again.` : "No backtest for this script yet."}</p>}
        <p className="mt-2 text-[12px] text-dim">{st ? `Backtest · ${periodLabel} · demo data, not live trading` : "Returns appear once it has a record."}</p>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <div className="rounded-[16px] bg-card2 p-3"><p className="text-[12px] text-dim">Return</p>{st ? <Change v={st.roi * 100} className="mt-1 block text-[18px] font-bold" /> : <p className="mt-1 text-[18px] font-bold text-dim">—</p>}</div>
        <div className="rounded-[16px] bg-card2 p-3"><p className="text-[12px] text-dim">Worst dip</p><p className="num mt-1 text-[18px] font-bold text-down">{st ? `${(-st.mdd * 100).toFixed(1)}%` : "—"}</p></div>
        <div className="rounded-[16px] bg-card2 p-3"><p className="text-[12px] text-dim">Copiers</p><p className="num mt-1 text-[18px] font-bold">{c ? c.followers : "—"}</p></div>
      </div>

      {c && (
        <Section title="Record on NEAR" sub={simulatedRecord(c.record) ? "Weekly checkpoints on chain. These are simulated: their execution proofs are all zeros until the scripts trade live." : undefined}>
          <div className="divide-y divide-line rounded-[18px] bg-card2">
            <Row k="Checkpoints">{c.record.length ? `${c.record.length} weeks` : "none yet"}{c.record.length > 0 && simulatedRecord(c.record) && <span className="ml-2 rounded-full bg-cream px-2 py-0.5 text-[12px] text-yel-deep">simulated</span>}</Row>
            {change !== null && <Row k="Change over the record"><Change v={change * 100} /></Row>}
            <Row k="Holder"><a href={explorerAccount(c.holder)} target="_blank" rel="noreferrer" className="underline decoration-yel underline-offset-2">{short(c.holder, 12)}</a></Row>
            {c.author !== c.holder && <Row k="Author">{short(c.author, 12)}</Row>}
            <Row k="Code hash"><span className="font-mono text-[13px]">{short(c.codeHash, 8)}</span></Row>
            <Row k="Fees earned">${c.feesEarned.toFixed(2)}</Row>
          </div>
        </Section>
      )}

      <Section title="Copy it" sub="Your agent follows the script inside your own signed rules and pays the holder a share of new profit, weekly, only above your previous peak.">
        <div className="divide-y divide-line rounded-[18px] bg-card2">
          <Row k="Copy fee">{c ? <>{pctFee(c.fee.bps)} of new profit{c.fee.next ? <span className="block text-[13px] font-normal text-dim">→ {pctFee(c.fee.next)} from {day(c.fee.at)}</span> : null}</> : "5% of new profit"}</Row>
          <Row k="Pilot fee">0.25% of new profit</Row>
          <Row k="Holder’s bond">{c ? <span className={bondOk ? "text-up" : "text-down"}>${c.bond.held.toFixed(0)} of ${c.bond.required.toFixed(0)}</span> : "—"}</Row>
        </div>
        {c && c.openParams.length > 0 ? (
          <div className="mt-3 rounded-[18px] bg-card2 p-4">
            <p className="text-[15px] font-semibold">Settings the holder opened</p>
            {c.openParams.map((p) => {
              const v = tuned[p.name] ?? p.default;
              return (
                <label key={p.name} className="mt-3 block">
                  <span className="flex justify-between text-[14px]"><span>{p.label ?? p.name}</span><b className="num">{v}</b></span>
                  <input type="range" min={p.min} max={p.max} step={p.step ?? (p.max - p.min) / 20} value={v} onChange={(e) => tune(p.name, Number(e.target.value))} className="mt-1 w-full accent-[#ff7a00]" />
                </label>
              );
            })}
            <p className="mt-2 text-[13px] text-dim">Saved in this browser for when copying opens. Your values trade your money only; the public record stays on the holder’s defaults.</p>
          </div>
        ) : <p className="mt-2 text-[14px] text-dim">The holder opened no settings for copiers.</p>}
        <motion.button whileTap={{ scale: 0.97 }} onClick={doCopy} disabled={copy.busy || !runnable}
          className={`btn mt-3 w-full ${runnable ? "btn-yel" : "btn-gray"} disabled:opacity-60`}>
          {copy.busy ? "Copying…" : runnable ? `Copy into my paper portfolio · ${c ? pctFee(c.fee.bps) : "5%"} of new profit` : "Runs in the research engine only"}
        </motion.button>
        {copy.text && <p role="status" className={`mt-2 rounded-[14px] px-3 py-2 text-[14px] ${copy.ok ? "bg-[#e8f7ee] text-up" : "bg-[#fdecea] text-down"}`}>{copy.text}</p>}
        <p className="mt-2 text-[14px] leading-snug text-dim">
          {c && !bondOk ? <>On chain, copying waits until the holder locks a ${c.bond.required.toFixed(0)} bond. </> : null}
          {runnable
            ? "A paper portfolio copies right away. A live copy needs the strategy NFT contract on mainnet, where your agent can sign follow."
            : "dolya’s runner executes the four WASM scripts (rebalance, trend, volatility target, weekly buys); this one runs only in the research engine for now."}
        </p>
      </Section>

      <Section title="Buy it" sub="The NFT carries its record and the copy fees from every copier. The seller gets 99.5%, Pilot 0.5%.">
        {c?.price ? (
          isHolder ? <p className="rounded-[16px] bg-card2 px-4 py-3 text-[15px]">It’s yours, listed for {yoctoToNear(c.price)} NEAR.</p> : (
            <motion.button whileTap={{ scale: 0.97 }} className="btn btn-yel w-full"
              onClick={() => setAction({ title: `Buy ${scriptTitle(row.id)}`, method: "buy", args: { token_id: row.id }, deposit: yoctoToNearExact(c.price!),
                why: `You become the holder: the NFT, its record and its future copy fees move to you. The author stays credited. Any deposit above the price comes back.` })}>
              Buy for {yoctoToNear(c.price)} NEAR
            </motion.button>
          )
        ) : <p className="rounded-[16px] bg-card2 px-4 py-3 text-[15px] text-dim">Not for sale right now.{c ? <> Holder: <b className="text-ink">{short(c.holder, 12)}</b>.</> : null}</p>}

        <div className="mt-3 rounded-[18px] bg-card2 p-4">
          <p className="text-[15px] font-semibold">Offers</p>
          <p className="mt-0.5 text-[13px] leading-snug text-dim">Offer your own price, listed or not. Your NEAR waits in the contract until the holder accepts or you cancel.</p>
          {offers === null ? (
            <p className="mt-3 rounded-[14px] bg-white px-3 py-2 text-[14px] text-dim">Offers open after the NFT contract upgrade (make_offer / accept_offer). The code is ready; the contract owner has to deploy it.</p>
          ) : (
            <>
              {offers && offers.length > 0 ? (
                <ul className="mt-3 flex flex-col gap-2">
                  {offers.slice(0, 6).map((o, k) => (
                    <li key={o.account} className="flex items-center gap-3 rounded-[14px] bg-white px-3 py-2.5">
                      {k === 0 && <span className="shrink-0 rounded-full bg-yel px-2 py-0.5 text-[11px] font-bold text-white">best</span>}
                      <span className="min-w-0 flex-1 truncate text-[14px]">{short(o.account, 12)}</span>
                      <span className="num shrink-0 text-[15px] font-semibold">{yoctoToNear(o.yocto)} NEAR</span>
                      {holderView && o.account !== c?.holder && (
                        <button className="shrink-0 rounded-[10px] bg-yel px-3 py-1.5 text-[13px] font-semibold text-white"
                          onClick={() => setAction({ title: `Sell to ${short(o.account, 10)} for ${yoctoToNear(o.yocto)} NEAR`, method: "accept_offer", args: { token_id: row.id, bidder: o.account, amount: o.yocto }, deposit: "0", who,
                            why: `The NFT, its record and its future copy fees move to ${o.account}. You get 99.5% of ${yoctoToNear(o.yocto)} NEAR, Pilot 0.5%. If they changed the offer meanwhile, the contract refuses and nothing moves.` })}>
                          Accept
                        </button>
                      )}
                      {o.account === accountId && (
                        <button className="shrink-0 rounded-[10px] bg-card2 px-3 py-1.5 text-[13px] font-semibold text-dim"
                          onClick={() => setAction({ title: "Cancel my offer", method: "cancel_offer", args: { token_id: row.id }, deposit: "0",
                            why: "Your offered NEAR and its storage come back to you." })}>
                          Cancel
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : offers ? <p className="mt-3 text-[14px] text-dim">No offers yet.</p> : null}
              {!isHolder && (
                <div className="mt-3 flex gap-2">
                  <input type="number" min={0.01} step={0.5} value={bid} onChange={(e) => setBid(e.target.value)} placeholder={mine ? `Your offer: ${yoctoToNear(mine.yocto)} NEAR` : "Your price in NEAR"}
                    className="num min-w-0 flex-1 rounded-[12px] bg-white px-3 py-2 text-[16px] outline-none focus:ring-2 focus:ring-yel" />
                  <button disabled={!(Number(bid) >= 0.01)} className="rounded-[12px] bg-yel px-4 font-semibold text-white disabled:opacity-40"
                    onClick={() => setAction({ title: `Offer ${Number(bid)} NEAR for ${scriptTitle(row.id)}`, method: "make_offer", args: { token_id: row.id }, deposit: (Number(bid) + 0.005).toFixed(3),
                      why: `${Number(bid)} NEAR is held by the contract until the holder accepts (you get the NFT, its record and its copy fees) or you cancel (it all comes back). About 0.005 NEAR covers the offer’s storage and is returned when the offer ends.${mine ? " This replaces your current offer; the old amount comes back." : ""}` })}>
                    {mine ? "Change" : "Offer"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </Section>

      {c && (
        <Section title="Holder tools" sub={isHolder ? "You hold this script." : "Only the holder can sign these. Connect the holder’s account, or look at them in demo mode."}>
          {!isHolder && (
            <button onClick={() => setDemoHolder((d) => !d)} className="rounded-[12px] bg-card2 px-3 py-2 text-[14px] font-semibold text-yel-deep">
              {demoHolder ? "Back to the copier view" : "Demo: view as the holder"}
            </button>
          )}
          {holderView && (
            <div className="mt-3 flex flex-col gap-3">
              {demoHolder && <p className="rounded-[14px] bg-cream/70 px-3 py-2 text-[13px]">Demo view. From any account other than {short(c.holder, 12)} the contract refuses these calls.</p>}
              <div className="rounded-[18px] bg-card2 p-4">
                <p className="text-[15px] font-semibold">{c.price ? `Listed for ${yoctoToNear(c.price)} NEAR` : "Sell it"}</p>
                <div className="mt-2 flex gap-2">
                  <input type="number" min={0} step={0.5} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Price in NEAR" className="num min-w-0 flex-1 rounded-[12px] bg-white px-3 py-2 text-[16px] outline-none focus:ring-2 focus:ring-yel" />
                  <button disabled={!(Number(price) > 0)} className="rounded-[12px] bg-yel px-4 font-semibold text-white disabled:opacity-40"
                    onClick={() => setAction({ title: `List ${scriptTitle(row.id)} for sale`, method: "list_for_sale", args: { token_id: row.id, price: nearToYocto(Number(price)) }, deposit: "0.01", who,
                      why: `Anyone can then buy it for ${Number(price)} NEAR. You get 99.5%. You pay the listing’s storage out of the 0.01 NEAR and get the rest back.` })}>
                    {c.price ? "Change" : "List"}
                  </button>
                </div>
                {c.price && <button className="mt-2 text-[14px] font-semibold text-down" onClick={() => setAction({ title: "Take it off sale", method: "delist", args: { token_id: row.id }, deposit: "0", who, why: "Removes the listing. Nothing else changes." })}>Delist</button>}
              </div>
              <div className="rounded-[18px] bg-card2 p-4">
                <p className="text-[15px] font-semibold">Copy fee, 0–10%</p>
                <div className="mt-2 flex gap-2">
                  <input type="number" min={0} max={10} step={0.5} value={fee} onChange={(e) => setFee(e.target.value)} className="num w-24 rounded-[12px] bg-white px-3 py-2 text-[16px] outline-none focus:ring-2 focus:ring-yel" />
                  <span className="self-center text-[15px] text-dim">% of new profit</span>
                  <button className="ml-auto rounded-[12px] bg-yel px-4 font-semibold text-white disabled:opacity-40" disabled={!(Number(fee) >= 0 && Number(fee) <= 10)}
                    onClick={() => setAction({ title: `Set the copy fee to ${Number(fee)}%`, method: "set_copy_fee", args: { token_id: row.id, bps: Math.round(Number(fee) * 100) }, deposit: "0", who,
                      why: Number(fee) * 100 > c.fee.bps ? "A raise takes effect after 7 days, so every copier can stop first." : "A cut takes effect at once." })}>
                    Set
                  </button>
                </div>
              </div>
              <div className="rounded-[18px] bg-card2 p-4">
                <p className="text-[15px] font-semibold">New version</p>
                <p className="mt-0.5 text-[13px] text-dim">Now {versionLabel(c.version, c.changedAt)}. Paste the new code or its sha256; only the hash goes on chain.</p>
                <textarea value={code} onChange={(e) => setCode(e.target.value)} rows={3} placeholder="def target(daily): …  or a 64-character hash" className="mt-2 w-full resize-none rounded-[12px] bg-white px-3 py-2 font-mono text-[13px] outline-none focus:ring-2 focus:ring-yel" />
                <button disabled={code.trim().length < 10} onClick={newVersion} className="mt-2 rounded-[12px] bg-yel px-4 py-2 font-semibold text-white disabled:opacity-40">Publish v{c.version + 1}</button>
              </div>
              <OpenParamsEditor params={params} setParams={setParams}
                onSave={() => setAction({ title: "Publish copier settings", method: "set_open_params", args: { token_id: row.id, schema: JSON.stringify(params) }, deposit: "0", who,
                  why: "Copiers will see these names, ranges and defaults as sliders. The code stays private." })} />
              <div className="flex items-center justify-between rounded-[18px] bg-card2 p-4">
                <div><p className="text-[15px] font-semibold">Show on the leaderboard</p><p className="text-[13px] text-dim">Hiding keeps the NFT and its record on chain.</p></div>
                <button className="rounded-[12px] bg-white px-3 py-2 text-[14px] font-semibold text-yel-deep"
                  onClick={() => setAction({ title: c.hidden ? "Show it again" : "Hide it", method: "set_hidden", args: { token_id: row.id, hidden: !c.hidden }, deposit: c.hidden ? "0" : "0.01", who,
                    why: c.hidden ? "Puts the script back on the leaderboard." : "Takes the script off the leaderboard. You can show it again any time." })}>
                  {c.hidden ? "Show" : "Hide"}
                </button>
              </div>
            </div>
          )}
        </Section>
      )}
      <NftActionSheet action={action} onClose={() => setAction(null)} onDone={() => { onChanged(); loadOffers(); }} />
    </div>
  );
}

function OpenParamsEditor({ params, setParams, onSave }: { params: OpenParam[]; setParams: (p: OpenParam[]) => void; onSave: () => void }) {
  const set = (i: number, k: keyof OpenParam, v: string) => setParams(params.map((p, j) => (j === i ? { ...p, [k]: k === "name" || k === "label" ? v : Number(v) } : p)));
  const valid = params.every((p) => p.name && p.min < p.max && p.default >= p.min && p.default <= p.max);
  return (
    <div className="rounded-[18px] bg-card2 p-4">
      <p className="text-[15px] font-semibold">Settings copiers may tune</p>
      {params.map((p, i) => (
        <div key={i} className="mt-2 grid grid-cols-[1fr_auto] gap-2">
          <input value={p.name} onChange={(e) => set(i, "name", e.target.value)} placeholder="name, e.g. target_vol" className="min-w-0 rounded-[10px] bg-white px-3 py-2 text-[14px] outline-none" />
          <button onClick={() => setParams(params.filter((_, j) => j !== i))} className="px-2 text-[14px] font-semibold text-down" aria-label="Remove">×</button>
          <div className="col-span-2 grid grid-cols-3 gap-2">
            {(["min", "max", "default"] as const).map((k) => (
              <label key={k} className="text-[12px] text-dim">{k}<input type="number" value={p[k]} onChange={(e) => set(i, k, e.target.value)} className="num mt-0.5 w-full rounded-[10px] bg-white px-2 py-1.5 text-[14px] text-ink outline-none" /></label>
            ))}
          </div>
        </div>
      ))}
      <div className="mt-3 flex gap-2">
        <button onClick={() => setParams([...params, { name: "", min: 0, max: 1, default: 0.5 }])} className="rounded-[12px] bg-white px-3 py-2 text-[14px] font-semibold">Add a setting</button>
        <button onClick={onSave} disabled={!valid} className="rounded-[12px] bg-yel px-3 py-2 text-[14px] font-semibold text-white disabled:opacity-40">Publish</button>
      </div>
    </div>
  );
}
