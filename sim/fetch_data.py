"""Download hourly closes for the pilot's assets from Binance public klines (no API key).

Usage: python3 sim/fetch_data.py [--days 730] [--out data/prices_1h.csv]
Writes one CSV: ts (UTC ms) + one close column per asset.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

import pandas as pd

# Pilot asset -> Binance spot symbol. XAUT is gold (tokenized), available on NEAR Intents.
SYMBOLS = {
    "BTC": "BTCUSDT",
    "ETH": "ETHUSDT",
    "SOL": "SOLUSDT",
    "NEAR": "NEARUSDT",
    # Binance lists XAUTUSDT only since 2026-03; PAXG tracks the same gold price with a longer history.
    "XAUT": "PAXGUSDT",
}
URL = "https://api.binance.com/api/v3/klines?symbol={s}&interval=1h&startTime={t}&limit=1000"
HOUR_MS = 3_600_000


def fetch_symbol(symbol: str, start_ms: int, end_ms: int) -> pd.Series:
    rows: list[list] = []
    t = start_ms
    while t < end_ms:
        for attempt in range(5):
            try:
                with urllib.request.urlopen(URL.format(s=symbol, t=t), timeout=20) as r:
                    batch = json.loads(r.read())
                break
            except Exception as exc:  # network hiccup: back off and retry
                if attempt == 4:
                    raise RuntimeError(f"{symbol}: failed at {t}: {exc}") from exc
                time.sleep(2 ** attempt)
        if not batch:
            break
        rows.extend(batch)
        t = batch[-1][0] + HOUR_MS
        time.sleep(0.15)  # stay well under public rate limits
    s = pd.Series({int(r[0]): float(r[4]) for r in rows if r[0] < end_ms}, name=symbol)
    return s.sort_index()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=730)
    ap.add_argument("--out", default="data/prices_1h.csv")
    a = ap.parse_args()
    end = int(time.time() // 3600 * 3600 * 1000)
    start = end - a.days * 24 * HOUR_MS
    cols = {}
    for asset, sym in SYMBOLS.items():
        s = fetch_symbol(sym, start, end)
        print(f"{asset:5} {sym:9} {len(s):6} bars  {pd.to_datetime(s.index[0], unit='ms')} .. {pd.to_datetime(s.index[-1], unit='ms')}")
        cols[asset] = s
    df = pd.DataFrame(cols)
    df.index.name = "ts"
    # Assets listed later than `start` get leading NaNs; keep rows where every asset has a price.
    full = df.dropna()
    gaps = (full.index.to_series().diff() > HOUR_MS).sum()
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    full.to_csv(out)
    print(f"saved {out}: {len(full)} rows, {len(df) - len(full)} dropped (missing asset), {gaps} gaps > 1h")
    return 0


if __name__ == "__main__":
    sys.exit(main())
