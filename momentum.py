#!/usr/bin/env python3
"""Rank the ~100 largest S&P 500 stocks by raw 12-month log return.

    R_12m = ln(P_now / P_252)

P_now  = most recent available price (FMP quote)
P_252  = close 252 trading sessions before the P_now session (FMP daily history)

Data is stored under data/:
    data/universe.json        top-N constituents by market cap
    data/history/<SYM>.csv    daily closes (date,close), ascending
    data/quotes.json          latest quote per symbol (kept separate from history)

Usage:  FMP_API_KEY=... python3 momentum.py [--top 100] [--serve]
"""
import argparse
import csv
import json
import math
import os
import sys
import time
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


def rank(top=100):
    (DATA / "history").mkdir(parents=True, exist_ok=True)
    symbols = load_universe(top)
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
    return results


def render_html(results, as_of):
    rows = "\n".join(
        f"<tr><td>{i}</td><td>{s}</td><td class={'pos' if r >= 0 else 'neg'}>{r:.4f}</td></tr>"
        for i, (s, r) in enumerate(results, 1)
    )
    return f"""<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>12M Return Ranking</title><style>
body{{font:14px/1.4 system-ui,sans-serif;max-width:420px;margin:24px auto;padding:0 16px;background:#fff;color:#111}}
table{{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}}
th,td{{padding:4px 8px;border-bottom:1px solid #eee;text-align:left}}
th:last-child,td:last-child{{text-align:right}}
.pos{{color:#137333}}.neg{{color:#b3261e}}small{{color:#666}}
@media (prefers-color-scheme:dark){{body{{background:#111;color:#eee}}th,td{{border-color:#333}}
.pos{{color:#6dd58c}}.neg{{color:#f28b82}}small{{color:#999}}}}
</style></head><body>
<h2>12-month log return</h2>
<small>Top {len(results)} S&amp;P 500 by market cap &middot; ln(P_now / P_252) &middot; updated {as_of}</small>
<table><thead><tr><th>Rank</th><th>Ticker</th><th>12m log return</th></tr></thead>
<tbody>{rows}</tbody></table></body></html>"""


def serve(top, refresh_minutes):
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    page = {"html": "<p>Loading&hellip; refresh in a few seconds.</p>"}

    def refresh():
        while True:
            try:
                results = rank(top)
                as_of = datetime.now(NY).strftime("%Y-%m-%d %H:%M %Z")
                page["html"] = render_html(results, as_of)
                print(f"refreshed {len(results)} tickers at {as_of}", flush=True)
            except Exception as e:  # keep serving the last good page
                print(f"refresh failed: {e}", file=sys.stderr, flush=True)
            time.sleep(refresh_minutes * 60)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = page["html"].encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    threading.Thread(target=refresh, daemon=True).start()
    port = int(os.environ.get("PORT", 8000))
    print(f"serving on :{port}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=100)
    ap.add_argument("--serve", action="store_true", help="run a web server showing the ranking")
    ap.add_argument("--refresh-minutes", type=int, default=15)
    args = ap.parse_args()
    if not os.environ.get("FMP_API_KEY"):
        sys.exit("FMP_API_KEY is not set")

    if args.serve:
        serve(args.top, args.refresh_minutes)
        return

    print(f"{'Rank':>4}  {'Ticker':<6}  {'12m log return':>14}")
    for i, (s, r) in enumerate(rank(args.top), 1):
        print(f"{i:>4}  {s:<6}  {r:>14.4f}")


if __name__ == "__main__":
    main()
