"""Export simulation results as static JSON for the web app (web/data/).

Usage: python3 sim/run_sim.py && python3 sim/export_web.py
The site is static (any host), so the browser reads these files instead of calling a server.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "results"
OUT = ROOT / "web" / "data"


def main() -> int:
    if not (RESULTS / "report.json").exists():
        print("run `python3 sim/run_sim.py` first", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    report = json.loads((RESULTS / "report.json").read_text())

    eq = pd.read_csv(RESULTS / "equity.csv", index_col=0)
    daily = eq.iloc[::24]  # hourly -> daily points keeps the file small
    equity = {"ts": [int(x) for x in daily.index],
              "series": {c: [round(float(v), 2) for v in daily[c]] for c in daily.columns}}

    events = [json.loads(line) for line in (RESULTS / "chronicle.jsonl").read_text().splitlines()]
    keep = [e for e in events if e["kind"] != "trade"]
    trades = [e for e in events if e["kind"] == "trade"]
    keep += trades[-60:]  # recent rebalances only, the rest is noise for the UI
    keep.sort(key=lambda e: e["ts"])
    for e in keep:
        e.pop("targets", None)

    (OUT / "report.json").write_text(json.dumps(report, separators=(",", ":")))
    (OUT / "equity.json").write_text(json.dumps(equity, separators=(",", ":")))
    (OUT / "chronicle.json").write_text(json.dumps(keep, separators=(",", ":"), ensure_ascii=False))
    sizes = {p.name: f"{p.stat().st_size / 1024:.0f} KB" for p in OUT.glob("*.json")}
    print(f"exported {len(equity['ts'])} daily points, {len(keep)} events -> {OUT}  {sizes}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
