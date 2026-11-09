"""Run the pilot on history and compare with simple benchmarks.

Usage: python3 sim/run_sim.py [--prices data/prices_1h.csv] [--out results]
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
    ap.add_argument("--out", default="results")
    ap.add_argument("--equity", type=float, default=10_000.0)
    a = ap.parse_args()

    prices = pd.read_csv(a.prices, index_col=0)
    mandate = Mandate()  # 50% USDC vault, 10% gold, 40% crypto sleeve, max drawdown 10%
    policy = Policy(per_transaction_usd=1_000.0, daily_usd=a.equity * 1.2)
    res = run(prices, catalog(), mandate=mandate, policy=policy, start_equity=a.equity)

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
        "assumptions": {"swap_cost": 0.0025, "stable_apy": mandate.stable_apy, "note": "hypothetical simulation, not real results"},
        "pilot": res.metrics,
        "benchmarks": {k: metrics(v, 0.0, {}, a.equity) for k, v in bench.items() if k != "pilot"},
        "year1": {k: segment(v, int(prices.index[0]), mid) for k, v in bench.items()},
        "year2": {k: segment(v, mid, end) for k, v in bench.items()},
        "event_counts": pd.Series([e.kind for e in res.events]).value_counts().to_dict(),
    }

    sup = res.supervisor
    report["final_targets"] = {k: round(v, 4) for k, v in res.final_targets.items()}
    report["strategies"] = []
    for s in catalog():
        rec = res.records[s.id]
        weekly = (1 + rec).cumprod().iloc[::7]
        last8 = rec.iloc[-56:]
        report["strategies"].append({
            "id": s.id,
            "kind": type(s).__name__,
            "doc": (type(s).__doc__ or "").strip(),
            "state": sup.state[s.id],
            "allocation": round(sup.alloc.get(s.id, 0.0), 4),
            "record_return": round(float((1 + rec).prod() - 1), 4),
            "record_max_drawdown": round(float((1 - (1 + rec).cumprod() / (1 + rec).cumprod().cummax()).max()), 4),
            "sharpe_8w": round(float(last8.mean() / last8.std() * (365 ** 0.5)), 2) if last8.std() > 0 else 0.0,
            "weekly_index": [round(float(x), 4) for x in weekly],
            "hires": sum(1 for e in res.events if e.text.startswith(f"hired {s.id}")),
            "fires": sum(1 for e in res.events if e.text.startswith(f"fired {s.id}")),
        })

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    pd.DataFrame(bench).to_csv(out / "equity.csv")
    with (out / "chronicle.jsonl").open("w") as f:
        for e in res.events:
            f.write(json.dumps({"ts": e.ts, "time": str(pd.to_datetime(e.ts, unit="ms")), "kind": e.kind, "text": e.text, **e.data}, ensure_ascii=False) + "\n")

    def line(name, m):
        sh = "  n/a" if m["sharpe"] is None else f"{m['sharpe']:5.2f}"
        return f"{name:28} return {m['total_return']:+7.1%}  maxDD {m['max_drawdown']:6.1%}  sharpe {sh}"

    print(line("pilot", res.metrics), f" fees ${res.metrics['fees_usd']:,.0f}  trades {res.metrics['trades']}  refused {res.metrics['refused']}")
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
