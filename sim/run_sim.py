"""Run the pilot on history and compare with simple benchmarks.

Usage: python3 sim/run_sim.py [--prices data/prices_1h.csv] [--funding data/funding_1h.csv] [--no-perps] [--out results]
Prints metrics and writes results/report.json, results/equity.csv, results/chronicle.jsonl.
Simulated results are hypothetical. See DISCLAIMER.md.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pilot.engine import DAY_MS, buy_and_hold, metrics, run  # noqa: E402
from pilot.policy import Mandate, Policy  # noqa: E402
from pilot.strategies import catalog  # noqa: E402


def segment(eq: pd.Series, start_ts: int, end_ts: int) -> dict:
    s = eq[(eq.index >= start_ts) & (eq.index < end_ts)]
    return metrics(s, 0.0, {}, float(s.iloc[0])) if len(s) > 1 else {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", default="data/prices_1h.csv")
    ap.add_argument("--funding", default="data/funding_1h.csv")
    ap.add_argument("--no-perps", action="store_true", help="spot-only catalog and policy, as before perps")
    ap.add_argument("--review", choices=["risk", "performance"], default="risk")
    ap.add_argument("--out", default="results")
    ap.add_argument("--equity", type=float, default=10_000.0)
    a = ap.parse_args()

    prices = pd.read_csv(a.prices, index_col=0)
    perps = not a.no_perps
    funding = None
    if perps:
        if not Path(a.funding).exists():
            print(f"{a.funding} missing: run `python3 sim/fetch_funding.py` (or pass --no-perps)", file=sys.stderr)
            return 1
        funding = pd.read_csv(a.funding, index_col=0)
    strategies = catalog(perps=perps)
    mandate = Mandate()  # 50% USDC vault, 10% gold, 40% crypto sleeve, max drawdown 10%
    policy = Policy(actions=("swap", "perp") if perps else ("swap",), per_transaction_usd=1_000.0,
                    daily_usd=a.equity * 1.2, max_leverage=1.0)
    from pilot.engine import ReviewRules  # noqa: E402
    res = run(prices, strategies, mandate=mandate, policy=policy, start_equity=a.equity, funding=funding,
              rules=ReviewRules(mode=a.review))

    static = {"USDC": 0.5, "XAUT": 0.1, "BTC": 0.2, "ETH": 0.12, "SOL": 0.08}
    bench = {
        "pilot": res.equity,
        "same_weights_buy_and_hold": buy_and_hold(prices, static, a.equity, mandate.stable_apy),
        "all_usdc_vault": buy_and_hold(prices, {"USDC": 1.0}, a.equity, mandate.stable_apy),
        "crypto_only_buy_and_hold": buy_and_hold(prices, {"BTC": 0.5, "ETH": 0.3, "SOL": 0.2}, a.equity),
    }
    mid = int(prices.index[0]) + 365 * DAY_MS
    end = int(prices.index[-1]) + 1
    report = {
        "period": [str(pd.to_datetime(prices.index[0], unit="ms")), str(pd.to_datetime(prices.index[-1], unit="ms"))],
        "review_mode": a.review,
        "assumptions": {"swap_cost": 0.0035, "perp_cost": 0.00115, "pilot_spot_fee": 0.001, "pilot_perp_fee": 0.0005, "perp_venue": "Hyperliquid via near.com (NEAR Intents)",
                        "funding_source": "Hyperliquid hourly funding history" if perps else None,
                        "max_leverage": policy.max_leverage if perps else 0.0,
                        "stable_apy": mandate.stable_apy, "note": "hypothetical simulation, not real results"},
        "policy": {"agent_api": {"actions": [x for x in policy.actions if x != "perp"], "per_transaction_usd": policy.per_transaction_usd,
                                 "daily_usd": policy.daily_usd},
                   "hyperliquid": policy.to_hyperliquid() if perps else None},
        "pilot": res.metrics,
        "benchmarks": {k: metrics(v, 0.0, {}, a.equity) for k, v in bench.items() if k != "pilot"},
        "year1": {k: segment(v, int(prices.index[0]), mid) for k, v in bench.items()},
        "year2": {k: segment(v, mid, end) for k, v in bench.items()},
        "event_counts": pd.Series([e.kind for e in res.events]).value_counts().to_dict(),
    }

    sup = res.supervisor
    report["final_targets"] = {k: round(v, 4) for k, v in res.final_targets.items()}
    report["strategies"] = []
    for s in strategies:
        rec = res.records[s.id]
        weekly = (1 + rec).cumprod().iloc[::7]
        last8 = rec.iloc[-56:]
        report["strategies"].append({
            "id": s.id,
            "kind": type(s).__name__,
            "code_hash": s.code_hash,
            # Logic parameters (private to the holder in the product; shown here for the demo's own scripts).
            "params": {f.name: (list(getattr(s, f.name)) if isinstance(getattr(s, f.name), tuple) else getattr(s, f.name))
                       for f in __import__("dataclasses").fields(s) if f.name not in ("name", "version")},
            "uses_perps": s.uses_perps,
            "followers": 1 if sup.alloc.get(s.id, 0.0) > 0 else 0,  # the demo pilot is the only agent
            "doc": (type(s).__doc__ or "").strip(),
            "state": sup.state[s.id],
            "allocation": round(sup.alloc.get(s.id, 0.0), 4),
            "record_return": round(float((1 + rec).prod() - 1), 4),
            "record_max_drawdown": round(float((1 - (1 + rec).cumprod() / (1 + rec).cumprod().cummax()).max()), 4),
            "sharpe_8w": round(float(last8.mean() / last8.std() * (365 ** 0.5)), 2) if last8.std() > 0 else 0.0,
            "weekly_index": [round(float(x), 4) for x in weekly],
            "daily_returns": [round(float(x), 5) for x in rec],  # for any period on the leaderboard
            "daily_start": int(rec.index[0]),
            # Compounded return over the last N days of the record (backtest before mint, live after).
            "periods": {k: round(float((1 + rec.iloc[-n:]).prod() - 1), 4) for k, n in
                        (("1w", 7), ("1m", 30), ("3m", 91), ("1y", 365), ("2y", len(rec)))},
            # What the demo pilot made or lost with this script: allocation-weighted daily record (paper).
            "pilot_pnl_usd": round(sum(res.alloc_history.get(t, {}).get(s.id, 0.0) * mandate.crypto_weight
                                       * float(res.equity.asof(t - 1)) * float(r)
                                       for t, r in rec.items() if t - DAY_MS in res.alloc_history
                                       for t in [t - DAY_MS]), 2),
            "hires": sum(1 for e in res.events if e.text.startswith(f"hired {s.id}")),
            "fires": sum(1 for e in res.events if e.text.startswith(f"fired {s.id}")),
        })

    # Daily health check on the last day, as the main agent would run it.
    from pilot.engine import daily_closes  # noqa: E402
    from pilot.health import check  # noqa: E402
    daily = daily_closes(prices, funding)
    report["health"] = check(int(daily.index[-1]), daily, strategies).as_dict()

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    # Ready-made arguments for minting each script's NFT and its first checkpoint (see docs/NFT.md).
    weekly_end = int(prices.index[-1]) + 3_600_000
    mint = [{"info": {"strategy_id": s.id, "code_hash": s.code_hash, "author": "AUTHOR_ACCOUNT"},
             "title": s.id, "description": (type(s).__doc__ or "").strip().splitlines()[0],
             "checkpoint": {"period_end_ms": weekly_end,
                            "equity_index": str(int(round(float((1 + res.records[s.id]).prod()) * 1_000_000))),
                            "proofs_hash": "0" * 64, "executions": 0, "code_hash": s.code_hash,
                            "followers": 1 if sup.alloc.get(s.id, 0.0) > 0 else 0}}
            for s in strategies]
    (out / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    (out / "nft_mint.json").write_text(json.dumps(mint, indent=2, ensure_ascii=False))
    pd.DataFrame(bench).to_csv(out / "equity.csv")
    with (out / "chronicle.jsonl").open("w") as f:
        for e in res.events:
            f.write(json.dumps({"ts": e.ts, "time": str(pd.to_datetime(e.ts, unit="ms")), "kind": e.kind, "text": e.text, **e.data}, ensure_ascii=False) + "\n")

    def line(name, m):
        sh = "  n/a" if m["sharpe"] is None else f"{m['sharpe']:5.2f}"
        return f"{name:28} return {m['total_return']:+7.1%}  maxDD {m['max_drawdown']:6.1%}  sharpe {sh}"

    m = res.metrics
    print(line("pilot", m), f" fees ${m['fees_usd']:,.0f}  trades {m['trades']}  refused {m['refused']}")
    if perps:
        print(f"{'':28} fees: ${m['author_fees_usd']:,.2f} to script holders, ${m['platform_fees_usd']:,.2f} to Pilot from profit (0.25%), ${m['pilot_trade_fees_usd']:,.2f} to Pilot from trades (spot 0.10%, perps 0.05%)")
        print(f"{'':28} perps: {m['perp_trades']} orders, ${m['perp_volume_usd']:,.0f} volume, funding {m['funding_usd']:+,.0f} USD, max leverage {m['max_leverage']:.2f}x")
    for st in report["strategies"]:
        print(f"  {st['id']:22} {st['state']:9} alloc {st['allocation']:5.0%}  record {st['record_return']:+7.1%}  maxDD {st['record_max_drawdown']:5.1%}  {st['code_hash'][:12]}")
    for k, m in report["benchmarks"].items():
        print(line(k, m))
    for y in ("year1", "year2"):
        print(f"--- {y}")
        for k, m in report[y].items():
            print(line(k, m))
    print("events:", report["event_counts"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
