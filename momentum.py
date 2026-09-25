#!/usr/bin/env python3
"""Rank the ~100 largest S&P 500 stocks by raw 12-month log return.

    R_12m = ln(P_now / P_252)

P_now  = most recent available price (FMP quote)
P_252  = close 252 trading sessions before the P_now session (FMP daily history)

Data is stored under data/:
    data/universe.json        top-N constituents by market cap
    data/history/<SYM>.csv    daily closes (date,close), ascending
    data/quotes.json          latest quote per symbol (kept separate from history)

Usage:  FMP_API_KEY=... python3 momentum.py [--top 100]
"""
import argparse
import csv
import json
import math
import os
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = "https://financialmodelingprep.com/stable"
LOOKBACK = 252
DATA = Path(__file__).parent / "data"
NY = ZoneInfo("America/New_York")


def fmp(endpoint, **params):
    params["apikey"] = os.environ["FMP_API_KEY"]
    url = f"{BASE}/{endpoint}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)


def batch_quotes(symbols):
    quotes = {}
    for i in range(0, len(symbols), 100):
        for q in fmp("batch-quote", symbols=",".join(symbols[i:i + 100])):
            quotes[q["symbol"]] = q
    return quotes


def load_universe(top):
    symbols = [c["symbol"] for c in fmp("sp500-constituent")]
    quotes = batch_quotes(symbols)
    ranked = sorted(quotes.values(), key=lambda q: q.get("marketCap") or 0, reverse=True)
    universe = [{"symbol": q["symbol"], "marketCap": q["marketCap"]} for q in ranked[:top]]
    (DATA / "universe.json").write_text(json.dumps(universe, indent=2))
    return [u["symbol"] for u in universe]


def load_history(symbol):
    start = (date.today() - timedelta(days=420)).isoformat()
    rows = fmp("historical-price-eod/light", symbol=symbol, **{"from": start})
    rows = sorted((r["date"], r["price"]) for r in rows)
    path = DATA / "history" / f"{symbol}.csv"
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "close"])
        w.writerows(rows)
    return rows


def load_quotes(symbols):
    quotes = {
        s: {"price": q["price"], "timestamp": q["timestamp"]}
        for s, q in batch_quotes(symbols).items()
    }
    (DATA / "quotes.json").write_text(json.dumps(quotes, indent=2))
    return quotes


def log_return_12m(history, quote):
    """ln(P_now / P_252). If the quote's session is newer than the last stored
    close, the quote is its own session; otherwise it is the last close's session."""
    quote_day = datetime.fromtimestamp(quote["timestamp"], NY).date().isoformat()
    closes = [c for d, c in history if d <= quote_day]
    now_idx = len(closes) if closes and quote_day > history[-1][0] else len(closes) - 1
    base_idx = now_idx - LOOKBACK
    if base_idx < 0:
        return None
    return math.log(quote["price"] / closes[base_idx])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=100)
    args = ap.parse_args()
    if not os.environ.get("FMP_API_KEY"):
        sys.exit("FMP_API_KEY is not set")

    (DATA / "history").mkdir(parents=True, exist_ok=True)
    symbols = load_universe(args.top)
    with ThreadPoolExecutor(max_workers=8) as ex:
        histories = dict(zip(symbols, ex.map(load_history, symbols)))
    quotes = load_quotes(symbols)

    results = []
    for s in symbols:
        if s in quotes and histories[s]:
            r = log_return_12m(histories[s], quotes[s])
            if r is not None:
                results.append((s, r))
            else:
                print(f"skip {s}: fewer than {LOOKBACK} sessions of history", file=sys.stderr)
    results.sort(key=lambda x: x[1], reverse=True)

    print(f"{'Rank':>4}  {'Ticker':<6}  {'12m log return':>14}")
    for rank, (s, r) in enumerate(results, 1):
        print(f"{rank:>4}  {s:<6}  {r:>14.4f}")


if __name__ == "__main__":
    main()
