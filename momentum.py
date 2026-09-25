#!/usr/bin/env python3
"""Rank the ~100 largest S&P 500 stocks by raw 12-month log return.

    R_12m = ln(P_now / P_252)

P_now  = most recent available price (FMP quote; intraday while the market is open)
P_252  = close 252 trading sessions before the P_now session (FMP daily history)

Computed as the sum of daily log returns. With skip (--skip / page toggle) the
sum excludes the most recent 21 sessions and is annualized: ln(P_21 / P_252) * 252/231.
With --vol / the page toggle, it is divided by the annualized sample std dev of the
same daily returns (stdev * sqrt(252)).

Data is stored under data/:
    data/universe.json        top-N constituents by market cap
    data/history/<SYM>.csv    daily closes (date,close), ascending
    data/quotes.json          latest quote per symbol (kept separate from history)

Usage:  FMP_API_KEY=... python3 momentum.py [--top 100] [--skip] [--vol] [--html index.html]
"""
import argparse
import csv
import json
import math
import os
import statistics
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = "https://financialmodelingprep.com/stable"
LOOKBACK = 252
SKIP = 21
TRADING_DAYS = 252  # annualization factor
MODES = ("full_raw", "skip_raw", "full_vol", "skip_vol")
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


def price_series(history, quote):
    """Daily closes ending at the quote. The quote is the newest session: it is
    appended if its session is newer than the last close, otherwise it replaces
    that close (so an intraday quote is used while the market is open)."""
    quote_day = datetime.fromtimestamp(quote["timestamp"], NY).date().isoformat()
    closes = [c for d, c in history if d <= quote_day]
    if closes and history[-1][0] == quote_day:
        closes = closes[:-1]
    return closes + [quote["price"]]


def daily_log_returns(prices, skip=0):
    """Daily log returns from P_252 to P_now, optionally excluding the most
    recent `skip` sessions (i.e. ending at the close `skip` sessions ago)."""
    if len(prices) < LOOKBACK + 1:
        return None
    window = prices[-(LOOKBACK + 1):len(prices) - skip]
    return [math.log(b / a) for a, b in zip(window, window[1:])]


def log_return_12m(prices, skip=0, vol_adjust=False):
    """Annualized sum of daily log returns over the window: sum * 252 / n, where
    n is the number of daily returns (252 with no skip, so the factor is 1).
    With vol_adjust, divided by the annualized sample std dev of those same
    daily returns, stdev * sqrt(252)."""
    rets = daily_log_returns(prices, skip)
    if rets is None:
        return None
    ann_return = sum(rets) * TRADING_DAYS / len(rets)
    if vol_adjust:
        return ann_return / (statistics.stdev(rets) * math.sqrt(TRADING_DAYS))
    return ann_return


def rank(top=100):
    """Returns {mode: [(ticker, value), ...]} best first, for every combination
    of skip (full/skip) and volatility adjustment (raw/vol)."""
    (DATA / "history").mkdir(parents=True, exist_ok=True)
    symbols = load_universe(top)
    with ThreadPoolExecutor(max_workers=8) as ex:
        histories = dict(zip(symbols, ex.map(load_history, symbols)))
    quotes = load_quotes(symbols)

    out = {m: [] for m in MODES}
    for s in symbols:
        if s not in quotes or not histories[s]:
            continue
        prices = price_series(histories[s], quotes[s])
        if len(prices) < LOOKBACK + 1:
            print(f"skip {s}: fewer than {LOOKBACK} sessions of history", file=sys.stderr)
            continue
        for m in MODES:
            out[m].append((s, log_return_12m(prices, SKIP if m.startswith("skip") else 0, m.endswith("vol"))))
    for v in out.values():
        v.sort(key=lambda x: x[1], reverse=True)
    return out


def render_html(results, as_of):
    def rows(res):
        return "".join(
            f"<tr><td>{i}</td><td>{s}</td><td>{r:.2f}</td></tr>" for i, (s, r) in enumerate(res, 1)
        )

    n = len(results["full_raw"])
    bodies = "".join(f"<tbody id={m}>{rows(results[m])}</tbody>" for m in MODES)
    return f"""<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>12M Return Ranker</title><style>
:root{{--bg:#f7f7f6;--fg:#111418;--muted:#6b7078;--card:#efefee;--line:#e2e2e0;--sheet:#fff;--knob:#fff;--on:#34c759}}
@media (prefers-color-scheme:dark){{:root{{--bg:#111214;--fg:#f2f2f2;--muted:#9a9ea5;--card:#1c1d20;--line:#2a2b2f;--sheet:#1c1d20;--knob:#f2f2f2;--on:#30d158}}}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--fg);font:17px/1.4 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",system-ui,sans-serif}}
main{{max-width:560px;margin:0 auto;padding:40px 0 48px}}
header,.card{{margin:0 16px}}
header{{display:grid;grid-template-columns:1fr auto;column-gap:12px}}
h1{{font-size:clamp(24px,7.6vw,34px);font-weight:700;letter-spacing:-.02em;margin:0 0 8px}}
.gear{{width:44px;height:44px;border:0;border-radius:12px;background:var(--card);color:var(--fg);cursor:pointer;display:grid;place-items:center}}
.sub{{grid-column:1/-1;color:var(--muted);margin:0 0 20px}}
.card{{background:var(--card);border-radius:14px;padding:14px 16px;font-size:clamp(12px,3.4vw,14px);color:var(--muted);line-height:1.8}}
.card b{{color:var(--fg);font-weight:500;opacity:.8}}
table{{width:100%;border-collapse:collapse;margin-top:20px;font-variant-numeric:tabular-nums}}
th{{background:var(--card);color:var(--muted);font-weight:500;font-size:15px;text-align:left;padding:14px 20px;white-space:nowrap}}
td{{padding:14px 20px;border-bottom:1px solid var(--line)}}
th:nth-child(1),td:nth-child(1){{width:4.5em}}
th:last-child,td:last-child{{text-align:right}}
tr:last-child td{{border-bottom:0}}
body:not(.skip) .when-skip,body.skip .when-full,body:not(.vol) .when-vol,body.vol .when-raw{{display:none}}
.opt+.opt{{margin-top:18px;padding-top:18px;border-top:1px solid var(--line)}}
.scrim{{position:fixed;inset:0;background:rgba(0,0,0,.25);opacity:0;pointer-events:none;transition:opacity .2s}}
.sheet{{position:fixed;left:0;right:0;bottom:0;max-width:560px;margin:0 auto;background:var(--sheet);border-radius:22px 22px 0 0;padding:10px 20px calc(28px + env(safe-area-inset-bottom));transform:translateY(105%);transition:transform .25s ease}}
.open .scrim{{opacity:1;pointer-events:auto}}.open .sheet{{transform:none}}
.grip{{width:40px;height:5px;border-radius:3px;background:var(--line);margin:0 auto 18px}}
.sheet h2{{font-size:24px;margin:0 0 14px;padding-bottom:14px;border-bottom:1px solid var(--line)}}
.opt{{display:grid;grid-template-columns:1fr auto;align-items:center;gap:2px 12px}}
.opt .t{{font-size:18px}}.opt .o{{color:var(--muted);font-size:14px}}
.opt p{{grid-column:1/-1;color:var(--muted);font-size:14px;margin:8px 0 0}}
.sw{{grid-row:1/3;grid-column:2;position:relative;width:51px;height:31px}}
.sw input{{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}}
.sw span{{position:absolute;inset:0;border-radius:31px;background:var(--line);transition:background .2s;pointer-events:none}}
.sw span:after{{content:"";position:absolute;top:2px;left:2px;width:27px;height:27px;border-radius:50%;background:var(--knob);box-shadow:0 2px 4px rgba(0,0,0,.2);transition:transform .2s}}
.sw input:checked+span{{background:var(--on)}}.sw input:checked+span:after{{transform:translateX(20px)}}
.sw input:focus-visible+span{{outline:2px solid var(--on);outline-offset:2px}}
</style></head><body><main>
<header><h1>12M Return Ranker</h1>
<button class=gear id=gear aria-label=Settings><svg width=22 height=22 viewBox="0 0 24 24" fill=currentColor><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.2 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg></button>
<p class=sub>Top ~{n} S&amp;P 500 by market cap<br><span class=when-full>Latest available price used</span><span class=when-skip>Skipping most recent {SKIP} trading days</span><br><small>As of {as_of}</small></p></header>
<div class=card><b>Universe:</b> ~{n} largest S&amp;P 500 companies<br>
<b>Prices:</b> daily historical prices (separate from latest quote)<br>
<b>Metric:</b> <span class=when-full>raw 12-month log return = ln(P<sub>now</sub> / P<sub>252</sub>)</span><span class=when-skip>ln(P<sub>{SKIP}</sub> / P<sub>252</sub>) &times; 252/{LOOKBACK - SKIP} (annualized)</span><span class=when-vol> &divide; annualized &sigma; of daily log returns (same window, &times; &radic;252)</span></div>
<table><thead><tr><th>Rank</th><th>Ticker</th><th><span class=when-raw><span class=when-full>Raw 12M Log Return</span><span class=when-skip>Ann. Log Return</span></span><span class=when-vol>Ann. Return / Ann. &sigma;</span></th></tr></thead>
{bodies}</table></main>
<div class=scrim id=scrim></div>
<section class=sheet role=dialog aria-label=Settings><div class=grip></div><h2>Settings</h2>
<label class=opt><span class=t>Skip {SKIP} trading days</span><span class=sw><input type=checkbox id=skip><span></span></span>
<span class=o>Optional</span><p>Use prior close instead of the most recent {SKIP} trading sessions.</p></label>
<label class=opt><span class=t>Divide by volatility</span><span class=sw><input type=checkbox id=vol><span></span></span>
<span class=o>Optional</span><p>Divide by the annualized standard deviation of daily log returns over the same window.</p></label></section>
<script>
const b=document.body,opts={{skip:"skip21",vol:"volAdj"}};
const apply=()=>{{
  for(const id in opts)b.classList.toggle(id,document.getElementById(id).checked);
  const m=(b.classList.contains("skip")?"skip":"full")+"_"+(b.classList.contains("vol")?"vol":"raw");
  document.querySelectorAll("tbody").forEach(t=>t.hidden=t.id!==m);
}};
for(const id in opts){{
  const cb=document.getElementById(id);
  try{{cb.checked=localStorage.getItem(opts[id])==="1"}}catch(e){{}}
  cb.onchange=()=>{{apply();try{{localStorage.setItem(opts[id],cb.checked?"1":"0")}}catch(e){{}}}};
}}
apply();
document.getElementById("gear").onclick=()=>b.classList.add("open");
document.getElementById("scrim").onclick=()=>b.classList.remove("open");
document.onkeydown=e=>{{if(e.key==="Escape")b.classList.remove("open")}};
</script></body></html>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=100)
    ap.add_argument("--skip", action="store_true", help=f"print ranking skipping the last {SKIP} sessions")
    ap.add_argument("--vol", action="store_true", help="divide by std dev of daily log returns (same window)")
    ap.add_argument("--html", metavar="PATH", help="also write the ranking as a static HTML page")
    args = ap.parse_args()
    if not os.environ.get("FMP_API_KEY"):
        sys.exit("FMP_API_KEY is not set")

    results = rank(args.top)
    print(f"{'Rank':>4}  {'Ticker':<6}  {'12m log return':>14}")
    mode = ("skip" if args.skip else "full") + ("_vol" if args.vol else "_raw")
    for i, (s, r) in enumerate(results[mode], 1):
        print(f"{i:>4}  {s:<6}  {r:>14.4f}")
    if args.html:
        as_of = datetime.now(NY).strftime("%b %-d, %Y %-I:%M %p %Z")
        Path(args.html).write_text(render_html(results, as_of))


if __name__ == "__main__":
    main()
