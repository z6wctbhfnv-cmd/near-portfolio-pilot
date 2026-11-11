"""Precompute agent-setting variants for the Agent screen's history preview (web/data/variants.json).

Each variant is one full simulation with different review settings: the default risk manager, the old
performance review, no perps, and each script pinned alone. The static site shows the variant that
matches the owner's settings, so the preview is a real simulation, not an estimate.

Usage: python3 sim/export_variants.py
"""
from __future__ import annotations

import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from pilot.engine import ReviewRules, run  # noqa: E402
from pilot.policy import Mandate, Policy  # noqa: E402
from pilot.strategies import catalog  # noqa: E402


def one(args):
    key, kw = args
    prices = pd.read_csv(ROOT / "data/prices_1h.csv", index_col=0)
    funding = pd.read_csv(ROOT / "data/funding_1h.csv", index_col=0)
    policy = Policy(actions=("swap", "perp"), per_transaction_usd=1_000.0, daily_usd=12_000.0, max_leverage=1.0)
    res = run(prices, catalog(), mandate=Mandate(), policy=policy, funding=funding, rules=ReviewRules(**kw))
    m = res.metrics
    daily = res.equity.iloc[::24]
    return key, {"settings": kw, "return": m["total_return"], "max_drawdown": m["max_drawdown"], "sharpe": m["sharpe"],
                 "author_fees_usd": m["author_fees_usd"], "perp_trades": m["perp_trades"],
                 "equity": [round(float(x), 2) for x in daily]}


def main() -> int:
    jobs = [("risk", {}), ("performance", {"mode": "performance"}), ("no-perps", {"allow_perps": False}),
            ("alloc:equal", {"allocation": "equal"}), ("alloc:return", {"allocation": "return"}),
            ("alloc:balanced", {"allocation": "balanced"}), ("review:1", {"review_every_days": 1}),
            ("review:30", {"review_every_days": 30})]
    jobs += [(f"pin:{s.id}", {"pinned": (s.id,)}) for s in catalog()]
    with ProcessPoolExecutor() as ex:
        out = dict(ex.map(one, jobs))
    for v in out.values():
        v["settings"] = {k: list(x) if isinstance(x, tuple) else x for k, x in v["settings"].items()}
    path = ROOT / "web/data/variants.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    for k, v in out.items():
        print(f"{k:28} {v['return']:+7.1%}  maxDD {v['max_drawdown']:5.1%}")
    print(f"saved {path} ({path.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
