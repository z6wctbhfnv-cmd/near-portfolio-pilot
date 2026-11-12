"""Simulation of the pilot: strategies, weekly review (the supervisor), owner policy and circuit breaker.

Everything is causal: a decision at time t uses prices up to t only. The same review and policy code
is meant to run live; only the price source and the executor change.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .fees import HighWaterMark
from .policy import DAY_MS, Decision, Mandate, Policy, PolicyState
from .strategies import CRYPTO, FUND, SPOT, Strategy, perp

HOURS_PER_YEAR = 8760


@dataclass
class Costs:
    fee: float = 0.002  # 1Click's share with a partner key (20 bps)
    spread: float = 0.0005  # solver spread assumption
    pilot_spot_fee: float = 0.001  # Pilot's app fee on spot swaps (1Click appFees; 1Click keeps its 20 bps)
    perp_fee: float = 0.00045  # Hyperliquid base taker fee
    perp_spread: float = 0.0002  # half-spread + slippage on liquid perp books
    pilot_perp_fee: float = 0.0005  # Pilot's Hyperliquid builder code fee on perps

    @property
    def per_swap(self) -> float:
        return self.fee + self.spread + self.pilot_spot_fee

    @property
    def per_perp(self) -> float:
        return self.perp_fee + self.perp_spread + self.pilot_perp_fee


@dataclass
class ReviewRules:
    """The supervisor's rules.

    mode "risk" (default): a risk manager. A script is hired once it has 8 weeks of paper record and is
    not in a deep drawdown; it is fired only for breaking a risk rule (drawdown above `hard_drawdown`),
    never for one weak month. Capital is split by inverse volatility, so calmer scripts get more,
    regardless of recent returns. This avoids hiring at peaks and firing at bottoms.

    mode "performance": the first version, kept for comparison. Hires on 8-week Sharpe, fires on weak
    Sharpe plus drawdown, splits capital by Sharpe. In the simulation it chased recent winners.
    """

    mode: str = "risk"

    window_days: int = 56  # judge on the last 8 weeks
    # No incubator: a script is backtested on past years before it is minted and can run at once.
    # The simulation only needs a few weeks of data to measure a script's risk at the start.
    min_history_days: int = 14
    promote_sharpe: float = 0.5
    demote_sharpe: float = 0.0
    demote_drawdown: float = 0.15
    hard_drawdown: float = 0.25
    cooldown_days: int = 28  # a retired strategy may re-enter the incubator after this
    probation_days: int = 28
    probation_cap: float = 0.2
    max_weight: float = 0.6
    # Owner tuning (set by hand or from plain words, see pilot/tuning.py)
    pinned: tuple[str, ...] = ()  # run only these scripts, equal weight, no hiring or firing
    excluded: tuple[str, ...] = ()  # never hire these
    allow_perps: bool = True  # False: scripts that trade perps are never hired
    max_record_drawdown: float | None = None  # never hire a script whose 8-week drawdown is above this

    # Who picks the scripts:
    #   "auto"   - the agent picks and sizes (pinned, if any, behaves like "pick")
    #   "pick"   - the owner picks which scripts may run (`pinned`); the agent sizes them
    #   "manual" - the owner sets every share (`manual_weights`); the agent only watches errors and the stop
    select: str = "auto"
    manual_weights: tuple[tuple[str, float], ...] = ()
    # How the agent sizes scripts:
    #   "balanced" - expected return per unit of risk, shrunk toward zero, with a penalty for scripts that
    #                move together
    #   "return"   - expected return per unit of volatility, no correlation penalty
    #   "calm"     - inverse volatility: calmer scripts get more (default; best in the simulation)
    #   "equal"    - the same share for each
    allocation: str = "calm"
    allocation_window_days: int = 180  # history used to estimate return, volatility and correlation
    review_every_days: int = 7  # automatic review at most once a day (>= 1)
    script_caps: tuple[tuple[str, float], ...] = ()  # per-script maximum share
    script_stops: tuple[tuple[str, float], ...] = ()  # per-script stop: pause if its drawdown over the window exceeds this
    script_settings: tuple = ()  # (script id, TradingSettings): how each script trades for this owner

    def __post_init__(self) -> None:
        if self.select not in ("auto", "pick", "manual"):
            raise ValueError("select must be auto, pick or manual")
        if self.allocation not in ("balanced", "return", "calm", "equal"):
            raise ValueError("allocation must be balanced, return, calm or equal")
        if not 1 <= int(self.review_every_days) <= 90:
            raise ValueError("review_every_days must be 1..90: the agent reviews at most once a day")
        if self.select == "manual":
            total = sum(w for _, w in self.manual_weights)
            if total > 1 + 1e-9 or any(w < 0 for _, w in self.manual_weights):
                raise ValueError(f"manual shares must be >= 0 and sum to at most 100%, got {total:.0%}")


@dataclass
class Event:
    ts: int
    kind: str  # trade | refused | review | breaker | resume
    text: str
    data: dict = field(default_factory=dict)


def shadow_returns(strategy: Strategy, daily: pd.DataFrame, costs: Costs) -> pd.Series:
    """Paper record of one strategy on daily closes, net of costs and perp funding. Index = day the return lands."""
    rets = daily[list(SPOT)].pct_change().fillna(0.0)
    keys = [*SPOT, *(perp(a) for a in CRYPTO)]
    w_prev = {k: 0.0 for k in keys}
    out = []
    for i in range(len(daily) - 1):
        w = strategy.target(daily.iloc[: i + 1])
        turnover_spot = sum(abs(w.get(a, 0.0) - w_prev[a]) for a in SPOT)
        turnover_perp = sum(abs(w.get(perp(a), 0.0) - w_prev[perp(a)]) for a in CRYPTO)
        r_next = w.get("XAUT", 0.0) * rets["XAUT"].iloc[i + 1]
        for a in CRYPTO:
            r = rets[a].iloc[i + 1]
            wp = w.get(perp(a), 0.0)
            fund = daily[a + FUND].iloc[i + 1] if a + FUND in daily else 0.0
            r_next += w.get(a, 0.0) * r + wp * r - wp * fund  # longs pay positive funding, shorts receive it
        out.append(r_next - turnover_spot * costs.per_swap - turnover_perp * costs.per_perp)
        w_prev = {k: w.get(k, 0.0) for k in keys}
    return pd.Series(out, index=daily.index[1:], name=strategy.id)


def _sharpe(r: pd.Series) -> float:
    sd = r.std()
    return float(r.mean() / sd * np.sqrt(365)) if sd > 0 else 0.0


def _max_dd(r: pd.Series) -> float:
    eq = (1 + r).cumprod()
    return float((1 - eq / eq.cummax()).max()) if len(eq) else 0.0


class Supervisor:
    """Weekly review. Decides which strategies get capital and how much, and says why."""

    def __init__(self, strategies: list[Strategy], rules: ReviewRules, variants: dict[str, Strategy] | None = None):
        self.rules = rules
        self.strategies = {s.id: s for s in strategies}
        # What actually trades: the copier's tuned variant (open parameters) when there is one. Records and
        # reviews stay on the holder's defaults, which is what the public record measures.
        self.trade_with = {sid: (variants or {}).get(sid, s) for sid, s in self.strategies.items()}
        self.settings = dict(rules.script_settings)
        self.state = {s.id: "incubator" for s in strategies}
        self.since: dict[str, int] = {s.id: 0 for s in strategies}
        self.alloc: dict[str, float] = {}

    def eligible(self, sid: str) -> bool:
        r = self.rules
        return sid not in r.excluded and (r.allow_perps or not self.strategies[sid].uses_perps)

    def _stopped(self, ts: int, sid: str, records: dict[str, pd.Series]) -> float | None:
        """The script's drawdown if it broke the owner's per-script stop, else None."""
        stop = dict(self.rules.script_stops).get(sid)
        if stop is None:
            return None
        hist = records[sid][records[sid].index < ts].iloc[-self.rules.window_days:]
        dd = _max_dd(hist)
        return dd if dd > stop else None

    def review(self, ts: int, records: dict[str, pd.Series]) -> list[Event]:
        r, events, scores = self.rules, [], {}
        before = dict(self.alloc)
        select = "pick" if (r.select == "auto" and r.pinned) else r.select
        if select == "manual":
            alloc = {}
            for sid, w in r.manual_weights:
                if sid not in self.strategies or w <= 0:
                    continue
                dd = self._stopped(ts, sid, records)
                if dd is not None:
                    events.append(Event(ts, "review", f"paused {sid}: its drawdown {dd:.1%} broke your stop for this script", {}))
                    continue
                alloc[sid] = w
                self.state[sid] = "active"
            self.alloc = alloc
            events += self._explain(ts, before, records, "your manual shares")
            return events
        if select == "pick":
            pins = [p for p in r.pinned if p in self.strategies]
            ok = []
            for p in pins:
                dd = self._stopped(ts, p, records)
                if dd is not None:
                    events.append(Event(ts, "review", f"paused {p}: its drawdown {dd:.1%} broke your stop for this script", {}))
                else:
                    ok.append(p)
                    self.state[p] = "active"
            for sid in self.strategies:
                if sid not in ok:
                    self.state[sid] = "retired" if sid in pins else "incubator"
            self.alloc = self._allocate(ts, {p: 1.0 for p in ok}, records, force=ok)
            events += self._explain(ts, before, records, "scripts you picked")
            return events
        for sid, rec in records.items():
            hist = rec[rec.index < ts]
            win = hist.iloc[-r.window_days:]
            sh, dd = _sharpe(win), _max_dd(win)
            scores[sid] = sh
            st = self.state[sid]
            facts = {"sharpe_8w": round(sh, 2), "drawdown_8w": round(dd, 3), "days": len(hist)}
            if st == "active" and not self.eligible(sid):
                self._set(sid, "retired", ts)
                events.append(Event(ts, "review", f"removed {sid}: excluded by the owner's settings", facts))
                continue
            if st == "active" and self._stopped(ts, sid, records) is not None:
                self._set(sid, "retired", ts)
                events.append(Event(ts, "review", f"paused {sid}: its drawdown {dd:.1%} broke your stop for this script", facts))
                continue
            if st == "incubator" and not self.eligible(sid):
                continue
            ok_dd = r.max_record_drawdown is None or dd <= r.max_record_drawdown
            vol = float(win.std() * np.sqrt(365)) if len(win) > 1 else 0.0
            facts["vol_8w"] = round(vol, 3)
            if r.mode == "risk":
                scores[sid] = 1.0 / max(vol, 0.02)  # inverse volatility; floor avoids all-in on cash-like scripts
                if st == "incubator" and len(hist) >= r.min_history_days and dd < r.demote_drawdown and ok_dd:
                    self._set(sid, "active", ts)
                    events.append(Event(ts, "review", f"hired {sid}: drawdown {dd:.1%} within limits", facts))
                elif st == "active" and dd > r.hard_drawdown:
                    self._set(sid, "retired", ts)
                    events.append(Event(ts, "review", f"fired {sid}: risk rule broken, 8-week drawdown {dd:.1%} > {r.hard_drawdown:.0%}", facts))
                elif st == "retired" and ts - self.since[sid] >= r.cooldown_days * DAY_MS:
                    self._set(sid, "incubator", ts)
                    events.append(Event(ts, "review", f"{sid} back to the incubator after cooldown", facts))
                continue
            if st == "incubator" and len(hist) >= r.min_history_days and sh > r.promote_sharpe and dd < r.demote_drawdown and ok_dd:
                self._set(sid, "active", ts)
                events.append(Event(ts, "review", f"hired {sid}: 8-week Sharpe {sh:.2f}, drawdown {dd:.1%}", facts))
            elif st == "active" and (dd > r.hard_drawdown or (sh < r.demote_sharpe and dd > r.demote_drawdown)):
                self._set(sid, "retired", ts)
                events.append(Event(ts, "review", f"fired {sid}: 8-week Sharpe {sh:.2f}, drawdown {dd:.1%}", facts))
            elif st == "retired" and ts - self.since[sid] >= r.cooldown_days * DAY_MS:
                self._set(sid, "incubator", ts)
                events.append(Event(ts, "review", f"{sid} back to the incubator after cooldown", facts))
        if r.mode == "risk":
            self.alloc = self._allocate(ts, scores, records)
        else:
            self.alloc = self._allocate_legacy(ts, scores)
        events += self._explain(ts, before, records, "the agent's review")
        return events

    def _stats(self, ts: int, records: dict[str, pd.Series], sids: list[str]) -> tuple[dict, dict, pd.DataFrame]:
        """Shrunk annual return and annual volatility per script, and their correlation, over the window."""
        win = self.rules.allocation_window_days
        frame = pd.DataFrame({s: records[s][records[s].index < ts].iloc[-win:] for s in sids}).fillna(0.0)
        n = len(frame)
        mu, vol = {}, {}
        for s in sids:
            x = frame[s]
            m = float(x.mean() * 365) if n else 0.0
            mu[s] = m * n / (n + 365)  # shrink toward zero: short histories are trusted less
            vol[s] = max(float(x.std() * np.sqrt(365)) if n > 1 else 0.0, 0.02)
        corr = frame.corr().fillna(0.0) if n > 2 and len(sids) > 1 else pd.DataFrame(0.0, index=sids, columns=sids)
        return mu, vol, corr

    def _allocate(self, ts: int, scores: dict[str, float], records: dict[str, pd.Series], force: list[str] | None = None) -> dict[str, float]:
        r = self.rules
        active = force if force is not None else [s for s, st in self.state.items() if st == "active"]
        if not active:
            self._facts = {}
            return {}
        mu, vol, corr = self._stats(ts, records, active)
        raw = {}
        for s in active:
            others = [o for o in active if o != s]
            crowd = float(np.mean([max(corr.at[s, o], 0.0) for o in others])) if others else 0.0
            if r.allocation == "equal":
                raw[s] = 1.0
            elif r.allocation == "calm":
                raw[s] = 1.0 / vol[s]
            elif r.allocation == "return":
                raw[s] = max(mu[s], 0.0) / vol[s]
            else:  # balanced: return per unit of variance, penalised when it moves with the others
                raw[s] = max(mu[s], 0.0) / vol[s] ** 2 / (1.0 + crowd)
        self._facts = {s: {"ret": mu[s], "vol": vol[s]} for s in active}
        raw = {s: v for s, v in raw.items() if v > 0}
        if not raw and force:
            raw = {s: 1.0 for s in force}  # the owner picked these: run them in equal shares rather than sit in cash
        if not raw:
            return {}
        total = sum(raw.values())
        caps = dict(r.script_caps)
        default_cap = 1.0 if force is not None else r.max_weight  # scripts the owner picked are capped only by per-script caps
        alloc = {s: min(v / total, caps.get(s, default_cap)) for s, v in raw.items()}
        # Capped weight that cannot be redistributed stays in USDC rather than being forced elsewhere.
        return {s: v for s, v in alloc.items() if v > 1e-4}

    def _explain(self, ts: int, before: dict[str, float], records, why: str) -> list[Event]:
        """One plain sentence per share that changed by 2 points or more, plus the full allocation."""
        out = []
        facts = getattr(self, "_facts", {})
        prev = getattr(self, "_prev_facts", {})
        for sid in sorted(set(before) | set(self.alloc)):
            a, b = before.get(sid, 0.0), self.alloc.get(sid, 0.0)
            if abs(b - a) < 0.02:
                continue
            verb = "raised" if b > a else "cut"
            reason = why
            f, g = facts.get(sid), prev.get(sid)
            if f and g:
                dv = (f["vol"] - g["vol"]) / g["vol"]
                dr = f["ret"] - g["ret"]
                if abs(dv) > abs(dr) and abs(dv) > 0.1:
                    reason = f"its volatility {'rose' if dv > 0 else 'fell'} to {f['vol']:.0%} a year"
                elif abs(dr) > 0.01:
                    reason = f"its expected return {'rose' if dr > 0 else 'fell'} to {f['ret']:+.0%} a year"
            elif b == 0:
                reason = "it no longer passes the review" if why == "the agent's review" else why
            out.append(Event(ts, "review", f"{verb} {sid} from {a:.0%} to {b:.0%}: {reason}", {}))
        self._prev_facts = facts
        out.append(Event(ts, "review", "allocation " + (", ".join(f"{k} {v:.0%}" for k, v in self.alloc.items()) or "none: crypto sleeve in USDC"),
                         {"alloc": dict(self.alloc)}))
        return out

    def blend(self, daily: pd.DataFrame) -> dict[str, float]:
        """Sleeve weights: allocation-weighted mix of active strategies' targets."""
        w = {a: 0.0 for a in (*SPOT, "USDC", *(perp(a) for a in CRYPTO))}
        if not self.alloc:
            w["USDC"] = 1.0
            return w
        for sid, share in self.alloc.items():
            target = self.trade_with[sid].target(daily)
            if sid in self.settings:
                target = self.settings[sid].apply(target, daily)
            for a, x in target.items():
                w[a] = w.get(a, 0.0) + share * x
        return w

    def _set(self, sid: str, state: str, ts: int) -> None:
        self.state[sid], self.since[sid] = state, ts

    def _allocate_legacy(self, ts: int, scores: dict[str, float]) -> dict[str, float]:
        """The first (performance-chasing) sizing, kept for comparison."""
        r = self.rules
        active = [s for s, st in self.state.items() if st == "active"]
        cap_score = 3.0
        raw = {s: min(max(scores.get(s, 0.0), 0.0), cap_score) for s in active}
        raw = {s: v for s, v in raw.items() if v > 0}
        if not raw:
            return {}
        total = sum(raw.values())
        alloc = {s: v / total for s, v in raw.items()}
        for s in alloc:  # caps: probation for newcomers, max weight for everyone
            cap = r.probation_cap if ts - self.since[s] < r.probation_days * DAY_MS else r.max_weight
            alloc[s] = min(alloc[s], cap)
        total = sum(alloc.values())
        # Capped weight that cannot be redistributed stays in USDC rather than being forced elsewhere.
        return {s: v for s, v in alloc.items()} if total <= 1 else {s: v / total for s, v in alloc.items()}


@dataclass
class SimResult:
    equity: pd.Series
    events: list[Event]
    metrics: dict
    records: dict[str, pd.Series]
    supervisor: "Supervisor | None" = None
    final_targets: dict[str, float] = field(default_factory=dict)
    alloc_history: dict[int, dict[str, float]] = field(default_factory=dict)  # day stamp -> allocation used


def daily_closes(prices: pd.DataFrame, funding: pd.DataFrame | None = None) -> pd.DataFrame:
    """Daily closes, plus "<ASSET>-FUND" = funding a long paid over that day (sum of hourly rates)."""
    idx = pd.to_datetime(prices.index, unit="ms", utc=True)
    d = prices.set_axis(idx).resample("1D").last().dropna()
    if funding is not None:
        f = funding.reindex(prices.index).fillna(0.0).set_axis(idx).resample("1D").sum()
        for a in f.columns:
            d[a + FUND] = f[a].reindex(d.index).fillna(0.0)
    d.index = (d.index.astype("int64") // 1_000_000) + DAY_MS  # stamp = when the daily close is known
    return d


def run(prices: pd.DataFrame, strategies: list[Strategy], mandate: Mandate | None = None,
        policy: Policy | None = None, costs: Costs | None = None, rules: ReviewRules | None = None,
        start_equity: float = 10_000.0, resume_after_days: int = 7,
        funding: pd.DataFrame | None = None, charge_fees: bool = True, tasks: list | None = None,
        variants: dict[str, Strategy] | None = None) -> SimResult:
    """Hourly simulation. `prices`: index = bar open time (UTC ms), columns = assets, values = close.

    `funding`: same index, columns = perp assets, hourly funding rate (positive = longs pay). Perp
    positions are marked to market every hour: PnL and funding settle into USDC, which is also margin.
    """
    mandate, policy, costs, rules = mandate or Mandate(), policy or Policy(), costs or Costs(), rules or ReviewRules()
    daily = daily_closes(prices, funding)
    fund = funding.reindex(prices.index).fillna(0.0) if funding is not None else None
    records = {s.id: shadow_returns(s, daily, costs) for s in strategies}
    sup = Supervisor(strategies, rules, variants)
    pstate = PolicyState(policy, period_start=int(prices.index[0]))
    units = {a: 0.0 for a in prices.columns}
    units["USDC"] = start_equity
    hourly_yield = (1 + mandate.stable_apy) ** (1 / HOURS_PER_YEAR) - 1
    events: list[Event] = []
    eq_out, peak, frozen_since, fees = [], start_equity, None, 0.0
    stats = {"trades": 0, "refused": 0, "volume_usd": 0.0, "perp_trades": 0, "perp_volume_usd": 0.0,
             "funding_usd": 0.0, "max_leverage": 0.0}
    stats.update({"author_fees_usd": 0.0, "platform_fees_usd": 0.0, "pilot_trade_fees_usd": 0.0})
    hwm = HighWaterMark(start_equity)
    pos = {a: 0.0 for a in CRYPTO}  # perp size in coins, signed
    last_px: dict[str, float] = {}

    def value(px) -> dict[str, float]:
        v = {a: units[a] * px[a] for a in prices.columns}
        v["USDC"] = units["USDC"]
        return v

    def swap(ts, px, asset, usd_delta) -> None:
        """usd_delta > 0 buys `asset` with USDC, < 0 sells it. Split by per-transaction limit."""
        nonlocal fees
        left = abs(usd_delta)
        while left > 1.0:
            chunk = min(left, policy.per_transaction_usd)
            src, dst = ("USDC", asset) if usd_delta > 0 else (asset, "USDC")
            d: Decision = pstate.check(ts, "swap", src, dst, chunk)
            if not d.ok:
                stats["refused"] += 1
                events.append(Event(ts, "refused", f"swap {src}->{dst} ${chunk:,.0f} refused: {d.code}", {"code": d.code}))
                return
            cost = chunk * costs.per_swap
            if usd_delta > 0:
                units["USDC"] -= chunk
                units[asset] += (chunk - cost) / px[asset]
            else:
                units[asset] -= chunk / px[asset]
                units["USDC"] += chunk - cost
            pstate.record(ts, chunk)
            fees += cost
            stats["pilot_trade_fees_usd"] += chunk * costs.pilot_spot_fee
            stats["trades"] += 1
            stats["volume_usd"] += chunk
            left -= chunk

    def gross(px) -> float:
        return sum(abs(pos[a]) * px[a] for a in pos)

    def perp_trade(ts, px, asset, usd_delta) -> None:
        """usd_delta > 0 buys perp notional, < 0 sells. Chunks by the per-transaction limit."""
        nonlocal fees
        left = abs(usd_delta)
        sign = 1.0 if usd_delta > 0 else -1.0
        while left > 1.0:
            chunk = min(left, policy.per_transaction_usd)
            cur = pos[asset] * px[asset]
            after = cur + sign * chunk
            reducing = abs(after) < abs(cur) - 1e-9 and cur * after >= 0
            eq = sum(value(px).values())
            g_after = gross(px) - abs(cur) + abs(after)
            d = pstate.check_perp(ts, asset, chunk, g_after, abs(after), eq, reducing)
            if not d.ok:
                stats["refused"] += 1
                side = "buy" if sign > 0 else "sell"
                events.append(Event(ts, "refused", f"perp {side} {asset} ${chunk:,.0f} refused: {d.code}", {"code": d.code}))
                return
            cost = chunk * costs.per_perp
            pos[asset] += sign * chunk / px[asset]
            units["USDC"] -= cost
            if not reducing:
                pstate.record(ts, chunk)
            fees += cost
            stats["pilot_trade_fees_usd"] += chunk * costs.pilot_perp_fee
            stats["perp_trades"] += 1
            stats["perp_volume_usd"] += chunk
            left -= chunk

    def rebalance(ts, px, targets) -> None:
        v = value(px)
        eq = sum(v.values())
        drift = max(abs(v.get(a, 0) / eq - targets.get(a, 0)) for a in v)
        drift = max([drift] + [abs(pos[a] * px[a] / eq - targets.get(perp(a), 0.0)) for a in pos])
        if drift < mandate.rebalance_band:
            return
        pdeltas = {a: targets.get(perp(a), 0.0) * eq - pos[a] * px[a] for a in pos}
        for a, dlt in pdeltas.items():  # shrink perps first: frees margin and lowers leverage
            cur = pos[a] * px[a]
            if abs(dlt) > 1.0 and abs(cur + dlt) < abs(cur):
                perp_trade(ts, px, a, dlt)
        deltas = {a: targets.get(a, 0) * eq - v[a] for a in prices.columns}
        for a in sorted(deltas, key=deltas.get):  # sells (negative) first, then buys
            if abs(deltas[a]) > 1.0:
                swap(ts, px, a, deltas[a])
        eq = sum(value(px).values())  # fees moved equity: recompute what is still missing
        for a in pos:  # then open or grow perps
            cur = pos[a] * px[a]
            dlt = targets.get(perp(a), 0.0) * eq - cur
            if abs(dlt) > 1.0 and abs(cur + dlt) >= abs(cur):
                perp_trade(ts, px, a, dlt)
        events.append(Event(ts, "trade", f"rebalanced, max drift {drift:.1%}", {"targets": {k: round(x, 4) for k, x in targets.items()}}))

    day_ts = set(int(x) for x in daily.index)
    last_targets: dict[str, float] = {}
    alloc_hist: dict[int, dict[str, float]] = {}
    for ts, row in prices.iterrows():
        ts = int(ts)
        px = row.to_dict()
        units["USDC"] *= 1 + hourly_yield
        for a in pos:  # hourly mark-to-market and funding for open perps
            if pos[a] != 0.0:
                units["USDC"] += pos[a] * (px[a] - last_px[a])
                if fund is not None and a in fund.columns:
                    paid = pos[a] * px[a] * float(fund.at[ts, a])
                    units["USDC"] -= paid
                    stats["funding_usd"] -= paid  # positive = funding earned
        last_px = {a: px[a] for a in pos}
        eq = sum(value(px).values())
        if eq > 0:
            stats["max_leverage"] = max(stats["max_leverage"], gross(px) / eq)
        if gross(px) > 0 and units["USDC"] < 0.05 * gross(px):
            # Margin call: USDC (the collateral) is below 5% of perp notional. Close perps before the venue does.
            events.append(Event(ts, "breaker", f"perp margin low (USDC ${units['USDC']:,.0f}, notional ${gross(px):,.0f}): perps closed", {}))
            for a in pos:
                if pos[a] != 0.0:
                    perp_trade(ts, px, a, -pos[a] * px[a])
        peak = max(peak, eq)
        floor = peak * (1 - mandate.max_drawdown)
        if mandate.drawdown_mode == "from_peak" and eq < floor:
            risk_scale = 0.0
        elif mandate.drawdown_mode == "from_peak":
            risk_scale = min(1.0, (eq - floor) / (peak * mandate.max_drawdown))  # share of the buffer left
        else:
            risk_scale = 1.0
        if mandate.drawdown_mode != "off" and frozen_since is None and eq < floor:
            events.append(Event(ts, "breaker", f"drawdown {1 - eq / peak:.1%} > {mandate.max_drawdown:.0%}: all to USDC, agent frozen", {"equity": eq}))
            for a in pos:  # close perps first, reducing orders are always allowed
                if pos[a] != 0.0:
                    perp_trade(ts, px, a, -pos[a] * px[a])
            for a in prices.columns:
                if units[a] > 0:
                    swap(ts, px, a, -units[a] * px[a])
            frozen_since = ts
            policy.frozen = True
        if frozen_since is not None and ts - frozen_since >= resume_after_days * DAY_MS:
            policy.frozen = False
            frozen_since = None
            if mandate.drawdown_mode == "episode":
                peak = eq  # the limit restarts from here; "from_peak" keeps the all-time peak
            events.append(Event(ts, "resume", f"owner resumed after {resume_after_days} days (simulated owner decision)"))
        for task in tasks or []:  # owner tasks: conditional and recurring orders, still under the policy
            if frozen_since is not None:
                break
            order = task.due(ts, px)
            if order and order.asset in px:
                usd_amt = order.usd if order.side == "buy" else min(order.usd, units[order.asset] * px[order.asset])
                if usd_amt > 1.0:
                    events.append(Event(ts, "task", f"task: {order.side} ${usd_amt:,.0f} {order.asset} ({order.reason})", {}))
                    swap(ts, px, order.asset, usd_amt if order.side == "buy" else -usd_amt)
        if ts in day_ts and frozen_since is None:
            hist = daily[daily.index <= ts]
            day_no = (ts - int(daily.index[0])) // DAY_MS
            if day_no % max(1, int(rules.review_every_days)) == 0:
                if charge_fees:  # last week's fees on new profit, before the next allocation
                    fc = hwm.charge(sum(value(px).values()), dict(sup.alloc))
                    if fc.total > 0:
                        units["USDC"] -= fc.total
                        stats["author_fees_usd"] += sum(fc.to_holders.values())
                        stats["platform_fees_usd"] += fc.to_platform
                        events.append(Event(ts, "fee", f"fees on ${fc.profit:,.0f} new profit: ${sum(fc.to_holders.values()):,.2f} to script holders, ${fc.to_platform:,.2f} to Pilot",
                                            {"to_holders": {k: round(v, 2) for k, v in fc.to_holders.items()}}))
                events.extend(sup.review(ts, records))
            sleeve = sup.blend(hist)
            alloc_hist[ts] = dict(sup.alloc)
            k = risk_scale  # 1.0 normally; below 1 in "from_peak" mode once part of the buffer is used
            targets = {a: k * mandate.crypto_weight * sleeve.get(a, 0.0) for a in CRYPTO}
            targets.update({perp(a): k * mandate.crypto_weight * sleeve.get(perp(a), 0.0) for a in CRYPTO})
            targets["XAUT"] = k * (mandate.gold_weight + mandate.crypto_weight * sleeve.get("XAUT", 0.0))
            targets["USDC"] = 1.0 - sum(v for a, v in targets.items() if not a.endswith("-PERP"))
            last_targets = targets
            rebalance(ts, px, targets)
        eq_out.append((ts, sum(value(px).values())))

    equity = pd.Series(dict(eq_out), name="equity")
    return SimResult(equity, events, metrics(equity, fees, stats, start_equity), records, sup, last_targets, alloc_hist)


def metrics(equity: pd.Series, fees: float, stats: dict, start: float) -> dict:
    r = equity.pct_change().dropna()
    years = (equity.index[-1] - equity.index[0]) / (DAY_MS * 365)
    total = equity.iloc[-1] / start - 1
    return {
        "start_equity": start,
        "end_equity": round(float(equity.iloc[-1]), 2),
        "total_return": round(float(total), 4),
        "cagr": round(float((1 + total) ** (1 / years) - 1), 4) if years > 0 else None,
        "max_drawdown": round(float((1 - equity / equity.cummax()).max()), 4),
        # A riskless series (cash in a vault) has no meaningful Sharpe: report None, not infinity.
        "sharpe": round(float(r.mean() / r.std() * np.sqrt(HOURS_PER_YEAR)), 2) if r.std() > 1e-7 else None,
        "fees_usd": round(fees, 2),
        **{k: (round(v, 2) if isinstance(v, float) else v) for k, v in stats.items()},
    }


def buy_and_hold(prices: pd.DataFrame, weights: dict[str, float], start: float = 10_000.0, stable_apy: float = 0.0) -> pd.Series:
    """Benchmark: buy once at the start, never trade."""
    p0 = prices.iloc[0]
    hours = np.arange(len(prices))
    eq = sum(start * w * prices[a] / p0[a] for a, w in weights.items() if a != "USDC")
    eq = eq + start * weights.get("USDC", 0.0) * (1 + stable_apy) ** (hours / HOURS_PER_YEAR)
    return pd.Series(np.asarray(eq), index=prices.index, name="buy_and_hold")
