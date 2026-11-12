"""Download hourly perp funding rates from Hyperliquid's public info API (no API key).

Perps on near.com run on Hyperliquid and are funded through NEAR Intents, so Hyperliquid funding is
the cost a Pilot perp position actually pays. Funding is charged every hour on Hyperliquid.

Usage: python3 sim/fetch_funding.py [--prices data/prices_1h.csv] [--out data/funding_1h.csv]
Writes one CSV aligned to the price file: ts (UTC ms) + one hourly funding-rate column per asset.
A positive rate means longs pay shorts.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

import pandas as pd

URL = "https://api.hyperliquid.xyz/info"
COINS = ("BTC", "ETH", "SOL", "NEAR")
HOUR_MS = 3_600_000


def fetch_coin(coin: str, start_ms: int, end_ms: int) -> pd.Series:
    rows: dict[int, float] = {}
    t = start_ms
    while t < end_ms:
        body = json.dumps({"type": "fundingHistory", "coin": coin, "startTime": t, "endTime": end_ms}).encode()
        for attempt in range(5):
            try:
                req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=20) as r:
                    batch = json.loads(r.read())
                break
            except Exception as exc:  # network hiccup or rate limit: back off and retry
                if attempt == 4:
                    raise RuntimeError(f"{coin}: failed at {t}: {exc}") from exc
                time.sleep(2 ** attempt)
        if not batch:
            break
        for x in batch:
            rows[int(x["time"]) // HOUR_MS * HOUR_MS] = float(x["fundingRate"])
        nxt = int(batch[-1]["time"]) + 1
        if nxt <= t:
            break
        t = nxt
        time.sleep(0.2)
    return pd.Series(rows, name=coin).sort_index()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", default="data/prices_1h.csv")
    ap.add_argument("--out", default="data/funding_1h.csv")
    a = ap.parse_args()
    idx = pd.read_csv(a.prices, index_col=0).index
    start, end = int(idx[0]), int(idx[-1]) + HOUR_MS
    cols = {}
    for coin in COINS:
        s = fetch_coin(coin, start, end)
        print(f"{coin:5} {len(s):6} hours  mean {s.mean() * 24 * 365:+.1%}/yr")
        cols[coin] = s
    # Missing hours (venue gaps) count as zero funding rather than inventing a rate.
    df = pd.DataFrame(cols).reindex(idx).fillna(0.0)
    df.index.name = "ts"
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(out)
    print(f"saved {out}: {len(df)} rows")
    return 0


if __name__ == "__main__":
    sys.exit(main())
