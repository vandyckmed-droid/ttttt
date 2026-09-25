#!/usr/bin/env python3
"""Rank S&P 500 stocks (filtered by market-cap bucket) by annualized log return.

    R_12m = ln(P_now / P_252)

P_now  = most recent available price (FMP quote; intraday while the market is open)
P_252  = close 252 trading sessions before the P_now session (FMP daily history)

Computed as the sum of daily log returns. With skip (--skip / page toggle) the
sum excludes the most recent 21 sessions and is annualized: ln(P_21 / P_252) * 252/231.
With --vol / the page toggle, it is divided by the annualized sample std dev of the
same daily returns (stdev * sqrt(252)). --window 6m uses the last 126 sessions
instead (annualized by 252/126, or 252/105 with skip); --window blend --w6 W blends
the two: W * score_6m + (1 - W) * score_12m.

Data is stored under data/:
    data/universe.json        all constituents, ordered by market cap
    data/history/<SYM>.csv    daily closes (date,close), ascending
    data/quotes.json          latest quote per symbol (kept separate from history)

Usage:  FMP_API_KEY=... python3 momentum.py [--caps mega,large,mid,small] [--window 12m|6m|blend [--w6 0.5]] [--skip] [--vol] [--html index.html]
"""
import argparse
import csv
import json
import math
import os
import statistics
import sys
import time
import urllib.error
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
WINDOWS = {"12m": LOOKBACK, "6m": 126}
# Market-cap buckets (name, floor in USD), largest first. The S&P 500 may have
# nothing in some buckets (typically Small); an empty bucket just ranks nothing.
CAP_BUCKETS = (("mega", 200e9), ("large", 10e9), ("mid", 2e9), ("small", 0))
DATA = Path(__file__).parent / "data"
NY = ZoneInfo("America/New_York")


def fmp(endpoint, **params):
    params["apikey"] = os.environ["FMP_API_KEY"]
    url = f"{BASE}/{endpoint}?{urllib.parse.urlencode(params)}"
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 4:
                raise
            time.sleep(15 * (attempt + 1))  # rate limited: back off and retry


def batch_quotes(symbols):
    quotes = {}
    for i in range(0, len(symbols), 100):
        for q in fmp("batch-quote", symbols=",".join(symbols[i:i + 100])):
            quotes[q["symbol"]] = q
    return quotes


def load_universe(top=None):
    """S&P 500 constituents ordered by market cap, largest first (optionally top N)."""
    info = {c["symbol"]: c for c in fmp("sp500-constituent")}
    quotes = batch_quotes(list(info))
    ranked = sorted(quotes.values(), key=lambda q: q.get("marketCap") or 0, reverse=True)
    universe = [{"symbol": q["symbol"], "marketCap": q["marketCap"] or 0, "name": info[q["symbol"]].get("name", ""),
                 "sector": info[q["symbol"]].get("sector", ""), "industry": info[q["symbol"]].get("subSector", "")}
                for q in ranked[:top]]
    (DATA / "universe.json").write_text(json.dumps(universe, indent=2))
    return universe


def cap_bucket(market_cap):
    return next(name for name, floor in CAP_BUCKETS if market_cap >= floor)


def load_history(symbol):
    """Daily closes, fetched at most once per New York calendar day: closes only
    change once a day, and the live quote covers the current session."""
    path = DATA / "history" / f"{symbol}.csv"
    today = datetime.now(NY).date()
    if path.exists() and datetime.fromtimestamp(path.stat().st_mtime, NY).date() == today:
        with path.open(newline="") as f:
            return [(d, float(c)) for d, c in list(csv.reader(f))[1:]]
    start = (today - timedelta(days=420)).isoformat()
    rows = fmp("historical-price-eod/light", symbol=symbol, **{"from": start})
    rows = sorted((r["date"], r["price"]) for r in rows)
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
    closes = [(d, c) for d, c in history if d <= quote_day]
    if closes and history[-1][0] == quote_day:
        closes = closes[:-1]
    return closes + [(quote_day, quote["price"])]


SESSION_OPEN, BAR_MINUTES, BARS_PER_DAY = 9 * 60 + 30, 5, 78


def load_intraday(symbol):
    """5-minute closes for the most recent session with bars, as
    [date, first bar index, [closes...]] (index 0 = 9:30, 77 = 15:55; gaps are
    None). Returns None if FMP has nothing recent."""
    today = datetime.now(NY).date()
    try:
        rows = fmp("historical-chart/5min", symbol=symbol, **{"from": (today - timedelta(days=6)).isoformat(),
                                                              "to": today.isoformat()})
    except urllib.error.HTTPError:
        return None
    if not rows:
        return None
    day = max(r["date"][:10] for r in rows)
    bars = {}
    for r in rows:
        if r["date"][:10] != day:
            continue
        hh, mm = int(r["date"][11:13]), int(r["date"][14:16])
        i = (hh * 60 + mm - SESSION_OPEN) // BAR_MINUTES
        if 0 <= i < BARS_PER_DAY:
            bars[i] = round(r["close"], 4)
    if not bars:
        return None
    lo, hi = min(bars), max(bars)
    return [day, lo, [bars.get(i) for i in range(lo, hi + 1)]]


def load_intraday_all(symbols):
    """{ticker: intraday}, fetched with modest concurrency (one call per ticker)."""
    with ThreadPoolExecutor(max_workers=4) as ex:
        out = dict(zip(symbols, ex.map(load_intraday, symbols)))
    return {s: v for s, v in out.items() if v}


def daily_log_returns(prices, lookback=LOOKBACK):
    """The last `lookback` daily log returns, ending at P_now."""
    if len(prices) < lookback + 1:
        return None
    window = prices[-(lookback + 1):]
    return [math.log(b / a) for a, b in zip(window, window[1:])]


def r_squared(r):
    """R² of the least-squares line through log price vs. time over the window:
    log price is the running sum of the daily log returns, starting at 0."""
    y = [0.0]
    for v in r:
        y.append(y[-1] + v)
    n = len(y)
    mk, my = (n - 1) / 2, sum(y) / n
    sxy = sum((k - mk) * (v - my) for k, v in enumerate(y))
    sxx = sum((k - mk) ** 2 for k in range(n))
    syy = sum((v - my) ** 2 for v in y)
    return sxy * sxy / (sxx * syy) if syy else 0.0


def score(rets, window=LOOKBACK, skip=0, vol_adjust=False, r2=False):
    """Annualized sum of daily log returns over the last `window` sessions,
    excluding the most recent `skip`: sum * 252 / n, n = window - skip (factor 1
    for the plain 12-month window). With vol_adjust, divided by the annualized
    sample std dev of those same daily returns, stdev * sqrt(252). With r2, the
    result is multiplied by the R² of the log-price trend over the same window.
    The page's JavaScript mirrors this exactly."""
    if len(rets) < window:
        return None
    r = rets[len(rets) - window:len(rets) - skip]
    out = sum(r) * TRADING_DAYS / len(r)
    if vol_adjust:
        out /= statistics.stdev(r) * math.sqrt(TRADING_DAYS)
    return out * r_squared(r) if r2 else out


def load_returns(top=None):
    """{ticker: up to 252 most recent daily log returns ending at P_now}, in
    market-cap order (largest first). Tickers with shorter history keep what they
    have and are left out of any window longer than that."""
    return {s: daily_log_returns(p, len(p) - 1) for s, p in load_prices(top)[0].items()}


def load_prices(top=None):
    """({ticker: up to 253 most recent prices ending at P_now}, {ticker: market cap},
    {ticker: {name, sector, industry}}, [the 253 session dates those prices sit on]),
    all in market-cap order. Every ticker's prices align to the tail of the dates."""
    (DATA / "history").mkdir(parents=True, exist_ok=True)
    universe = load_universe(top)
    caps = {u["symbol"]: u["marketCap"] for u in universe}
    meta = {u["symbol"]: {k: u[k] for k in ("name", "sector", "industry")} for u in universe}
    symbols = list(caps)
    with ThreadPoolExecutor(max_workers=8) as ex:
        histories = dict(zip(symbols, ex.map(load_history, symbols)))
    quotes = load_quotes(symbols)

    out, dates = {}, []
    for s in symbols:
        if s not in quotes or not histories[s]:
            continue
        series = price_series(histories[s], quotes[s])[-(LOOKBACK + 1):]
        if len(series) < 2:
            continue
        if len(series) <= LOOKBACK:
            print(f"note {s}: only {len(series) - 1} sessions of history", file=sys.stderr)
        out[s] = [c for _, c in series]
        if len(series) > len(dates):
            dates = [d for d, _ in series]
    return out, {s: caps[s] for s in out}, {s: meta[s] for s in out}, dates


def zscores(values):
    """Cross-sectional z-scores (sample std dev); all 0 if there are < 2 values."""
    if len(values) < 2:
        return [0.0] * len(values)
    m, sd = statistics.mean(values), statistics.stdev(values)
    return [(v - m) / sd if sd else 0.0 for v in values]


def rank(returns, window="12m", w6=0.5, skip=0, vol_adjust=False, include=None, zscore=False, r2=False):
    """Rank the stocks in `include` (all when None), best first. A blend is the
    weighted sum of the 6M and 12M scores; with zscore, each window's scores are
    first converted to z-scores across the ranked stocks (so the blend weighs the
    windows equally in dispersion) and the result is shown in z units."""
    parts = [("6m", w6), ("12m", 1 - w6)] if window == "blend" else [(window, 1.0)]
    rows = []
    for s, r in returns.items():
        if include is not None and s not in include:
            continue
        comps = [score(r, WINDOWS[w], skip, vol_adjust, r2) for w, _ in parts]
        if None not in comps:
            rows.append((s, comps))
    cols = [[c[j] for _, c in rows] for j in range(len(parts))]
    if zscore:
        cols = [zscores(col) for col in cols]
    scored = [(s, sum(wt * cols[j][i] for j, (_, wt) in enumerate(parts))) for i, (s, _) in enumerate(rows)]
    return sorted(scored, key=lambda x: x[1], reverse=True)


SORT = ('<svg width=10 height=16 viewBox="0 0 10 16" aria-hidden=true><path class=up d="M5 1l4 5H1z"/>'
        '<path class=dn d="M5 15l4-5H1z"/></svg>')

REFRESH = ('<svg width=20 height=20 viewBox="0 0 24 24" fill=none stroke=currentColor stroke-width=2.2 stroke-linecap=round '
           'stroke-linejoin=round><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg>')

GEAR = ('<svg width=22 height=22 viewBox="0 0 24 24" fill=currentColor><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 '
        '7.4 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.2 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 '
        '1.7 1l.4 2.6h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>')

# Theme tokens. --pos/--mid/--neg are the ends and middle of the value gradient.
LIGHT = ("--bg:#f5f5f7;--fg:#111418;--muted:#6e737b;--chip:#e9e9ec;--sel:#fff;--line:#e3e3e6;--sheet:#fff;"
         "--pos:#0f9d47;--mid:#8a8f97;--neg:#d8342a;--shadow:0 1px 3px rgba(0,0,0,.12);color-scheme:light")
DARK = ("--bg:#0b0b0c;--fg:#f2f2f4;--muted:#8e9299;--chip:#1c1c1f;--sel:#3a3a3e;--line:#26262a;--sheet:#161618;"
        "--pos:#3ee07a;--mid:#8e9299;--neg:#ff5f55;--shadow:none;color-scheme:dark")

# Appearance: Auto follows the OS; Light/Dark set data-theme on <html>.
CSS = f"""
:root{{{LIGHT}}}
@media (prefers-color-scheme:dark){{:root:not([data-theme=light]){{{DARK}}}}}
:root[data-theme=dark]{{{DARK}}}
:root[data-theme=light]{{{LIGHT}}}
""" + """*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.4 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",system-ui,sans-serif}
:root{--tabh:calc(52px + env(safe-area-inset-bottom))}
main{max-width:560px;margin:0 auto;padding:12px 16px calc(var(--tabh) + 16px)}
.open main{padding-bottom:calc(var(--sheet-h,50vh) + var(--tabh) + 16px)}  /* keep the content scrollable above the sheet */
/* Bottom tab bar: Rank (the list) and Lab (experiments) */
.tabs{position:fixed;left:0;right:0;bottom:0;z-index:15;height:var(--tabh);padding-bottom:env(safe-area-inset-bottom);
  background:var(--sheet);border-top:1px solid var(--line);display:flex;justify-content:center;gap:8px}
.tabs button{flex:1;max-width:280px;border:0;background:none;color:var(--muted);font:inherit;font-size:12px;font-weight:500;cursor:pointer;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px}
.tabs button .ico{font-size:20px;line-height:1}
.tabs button[aria-selected=true]{color:var(--fg)}
body[data-tab=lab] #ranktab,body:not([data-tab=lab]) #lab{display:none}
/* Lab: 21-day cumulative log-return heatmap */
.labh{margin:6px 0 10px}.labh h2{font-size:17px;margin:0}.labh p{margin:2px 0 0;color:var(--muted);font-size:13px}
.hm{display:grid;grid-template-columns:3.4em repeat(var(--cols,21),1fr) 4.1em;gap:2px;font-size:12px;font-variant-numeric:tabular-nums;position:relative}
.hm .rl{color:var(--fg);font-weight:500;display:flex;align-items:center;cursor:pointer;padding-right:4px;overflow:hidden}
.hm .rv{color:var(--muted);display:flex;align-items:center;justify-content:flex-end;padding-left:4px}
.hm .cl{color:var(--muted);font-size:10px;text-align:center;overflow:visible;white-space:nowrap}
.hm .c{height:18px;border-radius:3px;background:var(--chip)}
.hm .c.on{outline:2px solid var(--fg);outline-offset:-1px}
.lg{display:flex;align-items:center;gap:8px;margin:12px 0 0;font-size:12px;color:var(--muted)}
.lg .bar{flex:1;height:10px;border-radius:5px;background:linear-gradient(90deg,var(--neg),var(--chip),var(--pos))}
/* Correlation matrix + dendrogram */
.cm{display:grid;grid-template-columns:44px 3.4em repeat(var(--n,1),1fr);gap:1px;font-size:12px;position:relative;align-items:stretch}
.cm .cl{writing-mode:vertical-rl;transform:rotate(180deg);font-size:9px;color:var(--muted);text-align:left;line-height:1;padding:2px 0;height:34px;overflow:hidden}
.cm .c{height:16px;border-radius:2px;background:var(--chip);min-width:0}
.cm .c.self{background:var(--line)}
.cm .c.on{outline:2px solid var(--fg);outline-offset:-1px}
.cm .rl{height:16px;line-height:16px;font-weight:500;cursor:pointer;overflow:hidden;padding-right:3px}
.cm .dg{grid-column:1;position:relative}
.cm .dg svg{position:absolute;inset:0;width:100%;height:100%}
.cm .dg path{fill:none;stroke:var(--muted);stroke-width:1.2}
.labsec{margin-top:26px}
.hmtip{position:absolute;z-index:3;background:var(--sheet);border:1px solid var(--line);border-radius:8px;padding:4px 8px;font-size:12px;
  white-space:nowrap;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.12);transform:translate(-50%,-110%)}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:4px 0 12px}
h1{font-size:22px;font-weight:700;letter-spacing:-.01em;margin:0}
.gear{flex:none;width:40px;height:40px;border:0;border-radius:12px;background:var(--chip);color:var(--fg);cursor:pointer;display:grid;place-items:center}
.gear[aria-expanded=true]{background:var(--sel);box-shadow:var(--shadow)}
.sum{margin:2px 0 0;color:var(--muted);font-size:14px;letter-spacing:.02em}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{background:var(--chip);color:var(--muted);font-weight:400;font-size:15px;text-align:left;padding:10px 14px;white-space:nowrap}
th:first-child{border-radius:10px 0 0 10px}th:last-child{border-radius:0 10px 10px 0}
#col{border-radius:0 10px 10px 0}.today #col{border-radius:0}
td{padding:10px 14px;border-bottom:1px solid var(--line)}
th:last-child,td:last-child,.num{text-align:right}
.today th,.today td{padding-left:10px;padding-right:10px}
.sortb{border:0;background:none;color:inherit;font:inherit;padding:0;cursor:pointer;display:inline-flex;align-items:center;gap:6px;
  -webkit-user-select:none;user-select:none;-webkit-touch-callout:none;touch-action:manipulation}
.sortb.held{opacity:.5}
#tday,#colth{position:relative}
.menu{position:absolute;right:8px;top:calc(100% + 6px);z-index:5;min-width:9em;background:var(--sheet);border:1px solid var(--line);border-radius:12px;
  padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.18);text-align:left;font-weight:400}
.menu button{display:flex;justify-content:space-between;align-items:center;gap:12px;width:100%;border:0;background:none;color:var(--fg);font:inherit;
  font-size:15px;padding:9px 12px;border-radius:8px;cursor:pointer;text-align:left}
.menu button[aria-checked=true]{background:var(--chip);font-weight:500}
.menu button[aria-checked=true]::after{content:"\\2713";color:var(--pos)}
.menu button:focus-visible{outline:2px solid var(--pos)}
.sortb svg path{fill:currentColor;opacity:.35}.sortb[data-dir=desc] .dn,.sortb[data-dir=asc] .up{opacity:1}
.mv{display:inline-block;overflow:hidden;white-space:nowrap;vertical-align:bottom;font-size:13px;font-weight:600;
  max-width:5em;margin-right:8px;animation:mv 4.5s ease forwards}
.mv-up{color:var(--pos)}.mv-dn{color:var(--neg)}
@keyframes mv{0%,70%{opacity:1;max-width:5em;margin-right:8px}100%{opacity:0;max-width:0;margin-right:0}}
@media (prefers-reduced-motion:reduce){.mv{animation-duration:6s;animation-timing-function:steps(1,end)}}
.up-c{color:var(--pos)}.dn-c{color:var(--neg)}.fl-c{color:var(--mid)}
.empty{color:var(--muted);text-align:center!important;padding:28px}
tr.q td{border-bottom:0}
tr.qr td{padding:18px 0;border-bottom:0}  /* room above and below the divider */
.ql{display:flex;align-items:center;gap:12px;color:var(--fg);opacity:.75;font-size:15px;font-weight:500;letter-spacing:.02em}
.ql::before,.ql::after{content:"";flex:1;height:2px;background:currentColor;opacity:.8}
.ql:empty::after{display:none}
.asof{color:var(--muted);font-size:12px;margin:2px 0 0}
.hbtns{display:flex;gap:8px;flex:none}
@keyframes spin{to{transform:rotate(360deg)}}
.gear.busy svg{animation:spin .8s linear infinite}
.gear.ok{color:var(--pos)}.gear.err{color:var(--neg)}
tbody tr[data-t]{cursor:pointer}tbody tr[data-t]:active td{background:var(--chip)}
/* Per-ticker detail view */
.detail{position:fixed;inset:0;z-index:20;background:var(--bg);overflow:auto;padding:12px 16px calc(24px + env(safe-area-inset-bottom));
  transform:translateY(100%);transition:transform .25s ease;visibility:hidden}
.detail.on{transform:none;visibility:visible}
.dtop{display:flex;align-items:center;gap:12px;margin-bottom:10px}
.dtop .x{flex:none}
.dname{font-size:14px;color:var(--muted);margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dtick{font-size:22px;font-weight:700;margin:0;letter-spacing:-.01em}
.dsec{color:var(--muted);font-size:13px;margin:0 0 12px}
.dprice{font-size:34px;font-weight:700;letter-spacing:-.02em;margin:0;font-variant-numeric:tabular-nums}
.dchg{font-size:16px;font-weight:500;margin:2px 0 4px;font-variant-numeric:tabular-nums}
.drank{color:var(--muted);font-size:14px;margin:0 0 12px}
.chart{position:relative;margin:0 -4px}
.chart svg{display:block;width:100%;height:220px;touch-action:none}
.chart .ln{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.chart .ar{opacity:.12}
.chart .ref{stroke:var(--muted);stroke-width:1;stroke-dasharray:3 4;opacity:.7}
.chart g[hidden]{display:none}  /* the hidden attribute alone does not hide SVG */
.chart .hair{stroke:var(--fg);stroke-width:1;opacity:.5}
.chart .dot{stroke:var(--bg);stroke-width:2}
.chart text{fill:var(--muted);font-size:11px}
.tip{position:absolute;top:2px;left:0;background:var(--sheet);border:1px solid var(--line);border-radius:8px;padding:4px 8px;font-size:12px;
  white-space:nowrap;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.12);transform:translateX(-50%)}
.tip b{font-variant-numeric:tabular-nums}
.hz{display:flex;justify-content:space-between;align-items:baseline;margin:6px 0 8px;font-size:14px}
.hz .hzc{font-weight:500;font-variant-numeric:tabular-nums}
.hz .hzl{color:var(--muted)}
.dnote{color:var(--muted);font-size:12px;margin:14px 0 0}
/* Compact, non-modal settings panel: no dimming, the table stays visible and
   scrollable above it so rank moves can be watched while toggling. */
.sheet{position:fixed;left:0;right:0;bottom:var(--tabh);max-width:560px;margin:0 auto;background:var(--sheet);border-radius:18px 18px 0 0;
  padding:8px 14px calc(12px + env(safe-area-inset-bottom));max-height:55vh;overflow:auto;transform:translateY(105%);transition:transform .25s ease;
  box-shadow:0 -6px 24px rgba(0,0,0,.18);border-top:1px solid var(--line)}
.open .sheet{transform:none}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.top h2{font-size:17px;margin:0}
.x{width:30px;height:30px;border:0;border-radius:50%;background:var(--chip);color:var(--fg);font-size:14px;line-height:1;cursor:pointer}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 10px}
.grid .full{grid-column:1/-1}
.keyrow{display:flex;gap:6px}
.keyrow input{flex:1;min-width:0;border:0;border-radius:10px;background:var(--chip);color:var(--fg);font:inherit;font-size:14px;padding:7px 10px}
.keyrow button{border:0;border-radius:10px;background:var(--chip);color:var(--fg);font:inherit;font-size:14px;padding:7px 12px;cursor:pointer}
.keyrow button.pri{background:var(--sel);box-shadow:var(--shadow)}
.keyst{font-size:12px;color:var(--muted);margin:4px 0 0;min-height:1em}.keyst.ok{color:var(--pos)}.keyst.err{color:var(--neg)}
.lbl{color:var(--muted);font-size:12px;letter-spacing:.03em;margin:0 0 4px}
.seg{display:grid;grid-auto-columns:1fr;grid-auto-flow:column;background:var(--chip);border-radius:10px;padding:2px;gap:2px}
.seg button{border:0;background:none;color:var(--muted);font:inherit;font-size:14px;padding:6px 0;border-radius:8px;cursor:pointer}
.seg button[aria-pressed=true]{background:var(--sel);color:var(--fg);font-weight:500;box-shadow:var(--shadow)}
.seg button:focus-visible{outline:2px solid var(--pos);outline-offset:1px}
"""

# Mirrors score()/rank() above. DATA is [[ticker, bucket, prices], ...]
# in market-cap order; daily log returns are derived exactly as daily_log_returns().
JS = """
const $=id=>document.getElementById(id),b=document.body;
// [ticker, cap bucket, daily log returns, change of the latest price vs the prior close]
// [ticker, cap bucket, daily log returns, {d1: latest change vs prior close,
//  d5: 5-trading-day log return ln(P_now / P_5 sessions ago)}]
let DATA,META,DATES,INTRA,R,PX={};
function setPayload(P){PAYLOAD=P;DATA=P.data;META=P.meta||{};DATES=P.dates||[];INTRA=P.intra||{};PX={};
  R=DATA.map(([t,c,p])=>{const L=p.length;PX[t]=p;return[t,c,p.slice(1).map((v,i)=>Math.log(v/p[i])),
    {d1:p[L-1]/p[L-2]-1,d5:L>5?Math.log(p[L-1]/p[L-6]):null}]});
  $("asof").textContent="As of "+P.asOf;}
setPayload(PAYLOAD);
const store={get(k,d){try{const v=localStorage.getItem(k);return v===null?d:v}catch(e){return d}},set(k,v){try{localStorage.setItem(k,v)}catch(e){}}};
function r2of(x){  // mirrors r_squared()
  const y=[0];for(const v of x)y.push(y[y.length-1]+v);
  const n=y.length,mk=(n-1)/2,my=y.reduce((a,v)=>a+v,0)/n;
  let sxy=0,sxx=0,syy=0;y.forEach((v,k)=>{sxy+=(k-mk)*(v-my)});for(let k=0;k<n;k++)sxx+=(k-mk)**2;for(const v of y)syy+=(v-my)**2;
  return syy?sxy*sxy/(sxx*syy):0;
}
function score(r,win,skip,vol,r2){
  if(r.length<win)return null;
  const x=r.slice(r.length-win,r.length-skip),n=x.length,sum=x.reduce((a,v)=>a+v,0);
  let out=sum*YEAR/n;
  if(vol){const m=sum/n,sd=Math.sqrt(x.reduce((a,v)=>a+(v-m)**2,0)/(n-1));out/=sd*Math.sqrt(YEAR)}
  return r2?out*r2of(x):out;
}
const S={caps:new Set(store.get("caps",BUCKETS.join(",")).split(",").filter(c=>BUCKETS.includes(c))),
  wins:new Set(store.get("wins","12m").split(",").filter(w=>w in WIN)),vol:store.get("vol","0")==="1",r2:store.get("r2","0")==="1",skip:store.get("skip","0")==="1",disp:store.get("disp",store.get("z","0")==="1"?"z":"raw"),today:store.get("today","0")==="1",dmode:store.get("dmode","d1")==="d5"?"d5":"d1",sort:"",sortCol:"",
  theme:store.get("theme","auto")};
if(!["auto","light","dark"].includes(S.theme))S.theme="auto";
if(!["raw","z","pct","rank"].includes(S.disp))S.disp="raw";
if(!S.wins.size)S.wins.add("12m");
const save=()=>{store.set("theme",S.theme);store.set("caps",[...S.caps].join(","));store.set("wins",[...S.wins].join(","));store.set("vol",S.vol?"1":"0");store.set("r2",S.r2?"1":"0");store.set("skip",S.skip?"1":"0");store.set("disp",S.disp);store.set("today",S.today?"1":"0");store.set("dmode",S.dmode)};
// Rank-move badges: after a settings change, rows whose rank moved show a
// temporary ▲n / ▼n next to the ticker (CSS fades them out).
let prevRank=null,lastRank={},labNames=[];
const LABN=21;  // Lab heatmap window (sessions)
const CW={"1M":21,"3M":63,"6M":126,"1Y":252};let cw=store.get("cw","3M");if(!(cw in CW))cw="3M";let lastCorr=null;
const fmtDate=d=>{const [y,m,dd]=d.split("-");return new Date(+y,m-1,+dd).toLocaleDateString(undefined,{month:"short",day:"numeric"})};
function apply(){
  const skip=S.skip?SKIP:0,vol=S.vol,wins=["6m","12m"].filter(w=>S.wins.has(w));
  if(S.theme==="auto")delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=S.theme;
  document.querySelectorAll("[data-theme-opt]").forEach(x=>x.setAttribute("aria-pressed",x.dataset.themeOpt===S.theme));
  document.querySelectorAll("[data-cap]").forEach(x=>x.setAttribute("aria-pressed",S.caps.has(x.dataset.cap)));
  document.querySelectorAll("[data-win]").forEach(x=>x.setAttribute("aria-pressed",S.wins.has(x.dataset.win)));
  document.querySelectorAll("[data-r2]").forEach(x=>x.setAttribute("aria-pressed",String(x.dataset.r2==="1")===String(S.r2)));
  document.querySelectorAll("[data-vol]").forEach(x=>x.setAttribute("aria-pressed",String(x.dataset.vol==="1")===String(vol)));
  document.querySelectorAll("[data-skip]").forEach(x=>x.setAttribute("aria-pressed",String(x.dataset.skip==="1")===String(S.skip)));
  const pool=R.filter(([,c])=>S.caps.has(c));
  // Display: Raw value, Z-score (a blend z-scores each window first, as rank()
  // with zscore=True), percentile (100% = top) or rank position.
  const Z=S.disp==="z";
  document.querySelectorAll("[data-disp]").forEach(x=>x.setAttribute("aria-checked",x.dataset.disp===S.disp));
  $("sum").textContent=[pool.length,wins.map(w=>parseInt(w)).join("/"),...(vol?["VOL"]:[]),...(S.r2?["R\\u00b2"]:[]),...(skip?["S"+SKIP]:[]),
    ...({z:["Z"],pct:["%"],rank:["RANK"]}[S.disp]||[])].join(" \\u2022 ");
  document.querySelectorAll("[data-today]").forEach(x=>x.setAttribute("aria-pressed",String(x.dataset.today==="1")===String(S.today)));
  $("tbl").classList.toggle("today",S.today);$("tday").hidden=!S.today;if(!S.today&&S.sortCol==="day")S.sort="";if(!S.sort)S.sortCol="";
  $("sortday").dataset.dir=S.sortCol==="day"?S.sort:"";$("colbtn").dataset.dir=S.sortCol==="val"?S.sort:"";
  $("daylbl").textContent=S.dmode==="d5"?"5D":"Today";
  $("sortday").setAttribute("aria-label",(S.dmode==="d5"?"Sort by 5-day log return":"Sort by today's change")+"; long-press to switch");
  $("col").innerHTML={z:"Z-score",pct:"Percentile",rank:"Rank"}[S.disp]||
    (S.r2?(vol?"Ret / &sigma; &times; R&sup2;":"Ann. Ret &times; R&sup2;"):vol?"Ann. Return / &sigma;":"Ann. Log Return");
  // Mirrors rank(): per-window scores, optionally z-scored across the pool, then averaged.
  const rows=[],chg={};for(const [t,,r,d] of pool){const c=wins.map(w=>score(r,WIN[w],skip,vol,S.r2));if(!c.includes(null)){rows.push([t,c]);chg[t]=d[S.dmode]}}
  let cols=wins.map((_,j)=>rows.map(([,c])=>c[j]));
  if(Z)cols=cols.map(col=>{const k=col.length;if(k<2)return col.map(()=>0);
    const m=col.reduce((a,v)=>a+v,0)/k,sd=Math.sqrt(col.reduce((a,v)=>a+(v-m)**2,0)/(k-1));return col.map(v=>sd?(v-m)/sd:0)});
  const ranked=rows.map(([t],i)=>[t,cols.reduce((a,col)=>a+col[i]/wins.length,0)]).sort((a,c)=>c[1]-a[1]);
  const sgn=v=>(v>=0?"+":"\\u2212"),m=ranked.length;
  const fmt=(v,i)=>S.disp==="rank"?String(i+1):S.disp==="pct"?Math.floor(m>1?100*(1-i/(m-1)):100)+"%":
    sgn(v)+(vol||Z?Math.abs(v).toFixed(2):(Math.abs(v)*100).toFixed(1)+"%");
  // Percentile lines: the line labelled Pk sits below the stocks at or above the
  // k-th percentile (e.g. P95 = top 5% above the line).
  const n=ranked.length,q={};
  for(const k of PCTS){const c=Math.round(n*(1-k/100));if(c>0&&c<n)q[c-1]="P"+k}
  // Value text colour follows the distribution: its percentile in the current
  // ranking, green at the top through neutral at the median to red at the bottom
  // (sqrt easing so colour builds quickly away from the median).
  const grad=i=>{const t=n>1?1-i/(n-1):1,end=t>=.5?"--pos":"--neg";
    return `color-mix(in oklab,var(${end}) ${Math.round(Math.sqrt(Math.abs(t-.5)*2)*100)}%,var(--mid))`};
  // Rows keep their momentum rank (#) and colour; sorting by Today only reorders
  // them, and the percentile lines are shown only in rank order.
  const order=ranked.map((x,i)=>[...x,i]);
  // Missing values (short history) always sort last.
  // Value column: rank order is already score-desc, so "asc" just reverses it.
  if(S.sortCol==="val"&&S.sort==="asc")order.reverse();
  const cv=t=>chg[t]===null?(S.sort==="desc"?-Infinity:Infinity):chg[t];
  if(S.sortCol==="day"&&S.sort)order.sort((a,c)=>S.sort==="desc"?cv(c[0])-cv(a[0]):cv(a[0])-cv(c[0]));
  const line=S.sort?{}:q,ncol=S.today?3:2;  // percentile lines only in rank order
  const day=d=>d===null?`<td class="num fl-c">\\u2014</td>`:`<td class="num ${d>0?"up-c":d<0?"dn-c":"fl-c"}">${d>=0?"+":"\\u2212"}${Math.abs(d*100).toFixed(2)}%</td>`;
  const rk={};ranked.forEach(([t],i)=>rk[t]=i);
  const mv=t=>{if(!prevRank||!(t in prevRank))return"";const d=prevRank[t]-rk[t];
    return d?`<span class="mv ${d>0?"mv-up":"mv-dn"}">${d>0?"\\u25b2":"\\u25bc"}${Math.abs(d)}</span>`:""};
  lastRank={};ranked.forEach(([t,v],i)=>lastRank[t]=[i,fmt(v,i)]);
  $("rows").innerHTML=n?order.map(([t,v,i])=>`<tr data-t="${t}"${line[i]?" class=q":""}><td>${mv(t)}${t}</td><td class=num style="color:${grad(i)}">${fmt(v,i)}</td>${S.today?day(chg[t]):""}</tr>`+
    (line[i]?`<tr class=qr><td><div class=ql>${line[i]}</div></td>`+`<td><div class=ql></div></td>`.repeat(ncol-1)+`</tr>`:"")).join("")
    :`<tr><td colspan=${ncol} class=empty>${S.caps.size?"No stocks in the selected market caps.":"Select at least one market cap."}</td></tr>`;
  prevRank=rk;
  labNames=ranked.slice(0,Math.round(n*0.05)).map(([t])=>t);renderLab();
}
document.querySelectorAll("[data-cap]").forEach(x=>x.onclick=()=>{const c=x.dataset.cap;S.caps.has(c)?S.caps.delete(c):S.caps.add(c);save();apply()});
document.querySelectorAll("[data-win]").forEach(x=>x.onclick=()=>{const w=x.dataset.win;
  if(S.wins.has(w)){if(S.wins.size>1)S.wins.delete(w)}else S.wins.add(w);save();apply()});
document.querySelectorAll("[data-theme-opt]").forEach(x=>x.onclick=()=>{S.theme=x.dataset.themeOpt;save();apply()});
document.querySelectorAll("[data-today]").forEach(x=>x.onclick=()=>{S.today=x.dataset.today==="1";save();apply()});
// Header buttons: a long press (500 ms) fires onLong and suppresses the
// following click; a plain tap fires onTap.
function longPress(btn,onLong,onTap){let timer=null,longPressed=false;
  const cancel=()=>{clearTimeout(timer);timer=null;btn.classList.remove("held")};
  btn.addEventListener("pointerdown",()=>{longPressed=false;btn.classList.add("held");
    timer=setTimeout(()=>{longPressed=true;cancel();onLong();if(navigator.vibrate)navigator.vibrate(10)},500)});
  ["pointerup","pointerleave","pointercancel"].forEach(ev=>btn.addEventListener(ev,cancel));
  btn.addEventListener("contextmenu",e=>e.preventDefault());
  btn.onclick=e=>{if(longPressed){longPressed=false;e.preventDefault();return}if(onTap)onTap()};}
// Today: tap cycles the sort (desc, asc, off); long-press switches today's
// change <-> 5-day log return without sorting.
// Tapping a sortable header cycles desc -> asc -> off; only one column sorts at a time.
const cycleSort=col=>{S.sort=S.sortCol===col?{"":"desc",desc:"asc",asc:""}[S.sort]:"desc";S.sortCol=S.sort?col:"";apply()};
longPress($("sortday"),()=>{S.dmode=S.dmode==="d5"?"d1":"d5";save();apply()},()=>cycleSort("day"));
// Value column: long-press opens the display menu (Raw / Z / % / Rank).
const menuOpen=o=>{$("dispmenu").hidden=!o;$("colbtn").setAttribute("aria-expanded",o)};
longPress($("colbtn"),()=>menuOpen($("dispmenu").hidden),()=>cycleSort("val"));
document.addEventListener("pointerdown",e=>{if(!$("colth").contains(e.target))menuOpen(false)});
document.querySelectorAll("[data-disp]").forEach(x=>x.onclick=()=>{S.disp=x.dataset.disp;save();apply();menuOpen(false)});
document.querySelectorAll("[data-r2]").forEach(x=>x.onclick=()=>{S.r2=x.dataset.r2==="1";save();apply()});
document.querySelectorAll("[data-vol]").forEach(x=>x.onclick=()=>{S.vol=x.dataset.vol==="1";save();apply()});
document.querySelectorAll("[data-skip]").forEach(x=>x.onclick=()=>{S.skip=x.dataset.skip==="1";save();apply()});
apply();
// ---- Lab: cumulative 21-day log return, day by day, for every name above P95.
function renderLab(){const el=$("hm");if(!el)return;
  const names=labNames.filter(t=>PX[t]&&PX[t].length>LABN);
  $("labsub").textContent=names.length?`${names.length} names above P95 · running sum of daily log returns over the last ${LABN} sessions · ${$("sum").textContent}`:"No names above P95 in the current universe.";
  if(!names.length){el.innerHTML="";renderCorr([]);return}
  const rows=names.map(t=>{const p=PX[t],L=p.length,base=p[L-1-LABN];let c=0;return[t,p.slice(L-LABN).map(v=>Math.log(v/base))]});
  const all=rows.flatMap(r=>r[1].map(Math.abs)).sort((a,c)=>a-c),vmax=all[Math.floor(all.length*.95)]||1e-9;
  const ds=DATES.slice(DATES.length-LABN);
  const col=v=>`color-mix(in oklab,var(${v>=0?"--pos":"--neg"}) ${Math.round(Math.min(1,Math.abs(v)/vmax)*100)}%,var(--chip))`;
  const p=v=>(v>=0?"+":"−")+Math.abs(v*100).toFixed(1)+"%";
  el.style.setProperty("--cols",LABN);
  el.innerHTML=`<div></div>`+ds.map((d,i)=>`<div class=cl>${i%5===0||i===LABN-1?fmtDate(d).replace(/^\w+ /,""):""}</div>`).join("")+`<div class=cl>${LABN}D</div>`+
    rows.map(([t,cs])=>`<div class=rl data-t="${t}">${t}</div>`+cs.map((v,i)=>`<div class=c data-t="${t}" data-i="${i}" style="background:${col(v)}" title="${t} ${fmtDate(ds[i])} ${p(v)}"></div>`).join("")+`<div class=rv style="color:${cs[cs.length-1]>=0?"var(--pos)":"var(--neg)"}">${p(cs[cs.length-1])}</div>`).join("");
  $("lgmin").textContent="−"+(vmax*100).toFixed(0)+"%";$("lgmax").textContent="+"+(vmax*100).toFixed(0)+"%";
  el.onclick=e=>{const c=e.target.closest(".c"),r=e.target.closest(".rl");if(r){showDetail(r.dataset.t);return}
    el.querySelectorAll(".c.on").forEach(x=>x.classList.remove("on"));const old=el.querySelector(".hmtip");if(old)old.remove();
    if(!c)return;c.classList.add("on");const t=c.dataset.t,i=+c.dataset.i,v=rows.find(r=>r[0]===t)[1][i];
    const tip=document.createElement("div");tip.className="hmtip";tip.innerHTML=`${t} · ${fmtDate(ds[i])} · <b>${p(v)}</b>`;
    tip.style.left=(c.offsetLeft+c.offsetWidth/2)+"px";tip.style.top=c.offsetTop+"px";el.appendChild(tip)};
  renderCorr(names)}
// ---- Correlation clusters of the P95 names: Pearson correlation of daily
// log returns over a window, distance = 1 - rho, average-linkage (UPGMA)
// hierarchical clustering, rows arranged by optimal leaf ordering
// (Bar-Joseph et al. 2001: adjacent-leaf distance sum minimised over all
// 2^(n-1) flips of the dendrogram).
function pearson(a,c){const n=a.length;let ma=0,mc=0;for(let i=0;i<n;i++){ma+=a[i];mc+=c[i]}ma/=n;mc/=n;
  let sxy=0,sxx=0,syy=0;for(let i=0;i<n;i++){const x=a[i]-ma,y=c[i]-mc;sxy+=x*y;sxx+=x*x;syy+=y*y}return sxx&&syy?sxy/Math.sqrt(sxx*syy):0}
function upgma(D){const n=D.length;let nodes=D.map((_,i)=>({leaf:i,size:1,dist:0}));let d=D.map(r=>r.slice());
  while(nodes.length>1){let bi=0,bj=1,best=Infinity;
    for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++)if(d[i][j]<best){best=d[i][j];bi=i;bj=j}
    const A=nodes[bi],B=nodes[bj],m={l:A,r:B,size:A.size+B.size,dist:best};
    const nd=[];for(let k=0;k<nodes.length;k++)if(k!==bi&&k!==bj)nd.push((A.size*d[k][bi]+B.size*d[k][bj])/m.size);
    nodes=nodes.filter((_,k)=>k!==bi&&k!==bj);d=d.filter((_,k)=>k!==bi&&k!==bj).map(r=>r.filter((_,k)=>k!==bi&&k!==bj));
    nodes.push(m);d.forEach((r,k)=>r.push(nd[k]));d.push(nd.concat([0]))}
  return nodes[0]}
function olo(node,D){  // -> {leaves, M: "u,w" -> {c, ord}} best orderings by (leftmost, rightmost) leaf
  if(node.leaf!==undefined)return{leaves:[node.leaf],M:{[node.leaf+","+node.leaf]:{c:0,ord:[node.leaf]}}};
  const A=olo(node.l,D),B=olo(node.r,D),M={};
  for(const [X,Y] of [[A,B],[B,A]])for(const u of X.leaves)for(const w of Y.leaves){let best=null;
    for(const m of X.leaves){const a=X.M[u+","+m];if(!a)continue;for(const k of Y.leaves){const bb=Y.M[k+","+w];if(!bb)continue;
      const c=a.c+D[m][k]+bb.c;if(!best||c<best.c)best={c,ord:a.ord.concat(bb.ord)}}}
    M[u+","+w]=best}
  return{leaves:A.leaves.concat(B.leaves),M}}
function bestOrder(root,D){const r=olo(root,D);let best=null;for(const k in r.M)if(!best||r.M[k].c<best.c)best=r.M[k];return best.ord}
function renderCorr(names){const el=$("cm");if(!el)return;const W=CW[cw];
  document.querySelectorAll("[data-cw]").forEach(x=>x.setAttribute("aria-pressed",x.dataset.cw===cw));
  const use=names.filter(t=>PX[t].length>W);
  $("cmsub").textContent=use.length>=3?`${use.length} names above P95 · Pearson ρ of daily log returns, last ${W} sessions · distance 1−ρ · average linkage · optimal leaf order`:"Need at least 3 names with enough history.";
  if(use.length<3){el.innerHTML="";return}
  const rets=use.map(t=>{const p=PX[t],L=p.length;return p.slice(L-W-1).map((v,i,a)=>i?Math.log(v/a[i-1]):null).slice(1)});
  const n=use.length,C=use.map((_,i)=>use.map((_,j)=>i===j?1:pearson(rets[i],rets[j]))),D=C.map(r=>r.map(v=>1-v));
  const root=upgma(D),ord=bestOrder(root,D);
  const off=[];for(let i=0;i<n;i++)for(let j=0;j<n;j++)if(i!==j)off.push(Math.abs(C[i][j]));off.sort((a,c)=>a-c);const vmax=off[Math.floor(off.length*.95)]||1;
  const col=v=>`color-mix(in oklab,var(${v>=0?"--pos":"--neg"}) ${Math.round(Math.min(1,Math.abs(v)/vmax)*100)}%,var(--chip))`;
  // dendrogram: leaves at the right edge, merge height ∝ distance
  const rowH=17,pos={};ord.forEach((li,k)=>pos[li]=k*rowH+rowH/2);const maxd=root.dist||1,DW=44;
  const xOf=nd=>DW-2-(nd.dist/maxd)*(DW-6);let paths="";
  const walk=nd=>{if(nd.leaf!==undefined)return{y:pos[nd.leaf],x:DW};const a=walk(nd.l),b=walk(nd.r),x=xOf(nd),y=(a.y+b.y)/2;
    paths+=`M${a.x} ${a.y}H${x}V${b.y}H${b.x}`;return{y,x}};
  const top=walk(root);paths+=`M${top.x} ${top.y}H2`;
  el.style.setProperty("--n",n);
  el.innerHTML=`<div></div><div></div>`+ord.map(j=>`<div class=cl>${use[j]}</div>`).join("")+
    `<div class=dg style="grid-row:2 / span ${n}"><svg viewBox="0 0 ${DW} ${n*rowH}" preserveAspectRatio="none"><path d="${paths}"/></svg></div>`+
    ord.map(i=>`<div class=rl data-t="${use[i]}">${use[i]}</div>`+ord.map(j=>`<div class="c${i===j?" self":""}" data-i="${i}" data-j="${j}" style="${i===j?"":"background:"+col(C[i][j])}"></div>`).join("")).join("");
  $("cmmin").textContent="−"+vmax.toFixed(2);$("cmmax").textContent="+"+vmax.toFixed(2);
  el.onclick=e=>{const c=e.target.closest(".c"),r=e.target.closest(".rl");if(r){showDetail(r.dataset.t);return}
    el.querySelectorAll(".c.on").forEach(x=>x.classList.remove("on"));const old=el.querySelector(".hmtip");if(old)old.remove();
    if(!c)return;c.classList.add("on");const i=+c.dataset.i,j=+c.dataset.j;
    const tip=document.createElement("div");tip.className="hmtip";tip.innerHTML=`${use[i]} × ${use[j]} · ρ <b>${C[i][j].toFixed(2)}</b>`;
    tip.style.left=(c.offsetLeft+c.offsetWidth/2)+"px";tip.style.top=c.offsetTop+"px";el.appendChild(tip)};
  lastCorr={use,C,ord}}
document.querySelectorAll("[data-cw]").forEach(x=>x.onclick=()=>{cw=x.dataset.cw;store.set("cw",cw);renderCorr(labNames.filter(t=>PX[t]))});
// ---- Tabs
const setTab=t=>{b.dataset.tab=t;store.set("tab",t);document.querySelectorAll("[data-tab]").forEach(x=>x.setAttribute("aria-selected",x.dataset.tab===t));if(t==="lab")renderLab()};
document.querySelectorAll("[data-tab]").forEach(x=>x.onclick=()=>setTab(x.dataset.tab));
setTab(store.get("tab","rank")==="lab"?"lab":"rank");
const setOpen=o=>{b.classList.toggle("open",o);$("gear").setAttribute("aria-expanded",o);
  if(o)document.documentElement.style.setProperty("--sheet-h",$("sheet").offsetHeight+"px")};
const close=()=>setOpen(false);
$("gear").onclick=()=>setOpen(!b.classList.contains("open"));$("close").onclick=close;
document.onkeydown=e=>{if(e.key==="Escape"){if(b.classList.contains("dopen"))closeDetail();else{close();menuOpen(false)}}};

// Refresh: pull the latest published data.json (the GitHub Action rebuilds it
// every few minutes during market hours) and re-rank in place; rows that moved
// get the usual ▲/▼ badges.
// ---- Live quotes with a personal FMP key. The key lives only in this
// browser's localStorage (never in the page or the repo); without one, refresh
// just pulls the latest published build.
const FMP="https://financialmodelingprep.com/stable/";
const getKey=()=>store.get("fmpKey","");
const nyDate=ts=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(ts*1000));
const nyNow=()=>new Date().toLocaleString("en-US",{timeZone:"America/New_York",month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit",timeZoneName:"short"}).replace(/,(?=[^,]*$)/,"");
async function fmp(path,params){const u=new URL(FMP+path);for(const k in params)u.searchParams.set(k,params[k]);u.searchParams.set("apikey",getKey());
  const r=await fetch(u);if(r.status===401||r.status===403)throw new Error("FMP rejected the key");if(!r.ok)throw new Error("FMP "+r.status);return r.json()}
// Overlay live quotes on the payload, the same way price_series() does: a quote
// from a newer session is appended, one from the latest session replaces it.
async function liveQuotes(P){const syms=P.data.map(x=>x[0]),q={};
  for(let i=0;i<syms.length;i+=100)for(const x of await fmp("batch-quote",{symbols:syms.slice(i,i+100).join(",")}))q[x.symbol]=x;
  const last=P.dates[P.dates.length-1];let newDay=null;
  for(const x of Object.values(q)){const d=nyDate(x.timestamp);if(d>last&&(!newDay||d>newDay))newDay=d}
  if(newDay){P.dates.push(newDay);for(const row of P.data)row[2].push(row[2][row[2].length-1])}
  for(const row of P.data){const x=q[row[0]];if(!x||!(x.price>0))continue;const d=nyDate(x.timestamp),p=row[2];
    if(d===P.dates[P.dates.length-1])p[p.length-1]=x.price}
  P.asOf=nyNow()+" · live";return Object.keys(q).length}
async function liveIntraday(t){const today=nyDate(Date.now()/1000),from=new Date(Date.now()-6*864e5).toISOString().slice(0,10);
  const rows=await fmp("historical-chart/5min",{symbol:t,from,to:today});if(!rows.length)return null;
  const day=rows.reduce((m,r)=>r.date.slice(0,10)>m?r.date.slice(0,10):m,"");const bars={};
  for(const r of rows){if(r.date.slice(0,10)!==day)continue;const i=Math.floor((+r.date.slice(11,13)*60+ +r.date.slice(14,16)-570)/5);if(i>=0&&i<BARS)bars[i]=r.close}
  const ks=Object.keys(bars).map(Number);if(!ks.length)return null;const lo=Math.min(...ks),hi=Math.max(...ks);
  return[day,lo,Array.from({length:hi-lo+1},(_,j)=>bars[lo+j]??null)]}
$("refresh").onclick=async()=>{const btn=$("refresh");if(btn.classList.contains("busy"))return;
  btn.classList.add("busy");btn.classList.remove("ok","err");
  try{let P=PAYLOAD;try{const r=await fetch("data.json?_="+Date.now(),{cache:"no-store"});if(r.ok){const Q=await r.json();if(Q.asOf!==PAYLOAD.asOf.replace(" · live",""))P=Q}}catch(e){}
    let msg="Updated "+P.asOf;
    if(getKey()){P=JSON.parse(JSON.stringify(P));const n=await liveQuotes(P);msg=`Live quotes for ${n} tickers · ${P.asOf}`;
      if(cur){const it=await liveIntraday(cur).catch(()=>null);if(it)P.intra[cur]=it}}
    else if(P===PAYLOAD)msg="Already up to date ("+P.asOf+") — add an FMP key in Settings for live quotes";
    setPayload(P);apply();if(cur)showDetail(cur,true);btn.classList.add("ok");btn.title=msg}
  catch(e){btn.classList.add("err");btn.title="Refresh failed: "+e.message;$("keyst").textContent=e.message;$("keyst").className="keyst err"}
  finally{btn.classList.remove("busy");setTimeout(()=>btn.classList.remove("ok","err"),1500)}};
// Key entry (Settings). Save tests the key with one quote call.
const keyStatus=(m,c)=>{$("keyst").textContent=m;$("keyst").className="keyst "+(c||"")};
const showKeyState=()=>{const k=getKey();$("fmpkey").value="";$("fmpkey").placeholder=k?"Key saved ("+k.slice(0,4)+"…)":"Paste FMP API key";keyStatus(k?"Live quotes on. Stored only in this browser.":"Optional: refresh pulls live FMP quotes with your key.")};
$("keysave").onclick=async()=>{const k=$("fmpkey").value.trim();if(!k){keyStatus("Enter a key first.","err");return}
  store.set("fmpKey",k);keyStatus("Checking…");try{await fmp("quote",{symbol:"AAPL"});showKeyState();keyStatus("Key works. Live quotes on. Stored only in this browser.","ok")}
  catch(e){store.set("fmpKey","");showKeyState();keyStatus(e.message,"err")}};
$("keyclear").onclick=()=>{store.set("fmpKey","");showKeyState();keyStatus("Key removed.")};
showKeyState();

// Per-ticker view: tap a row. Horizons: 1D = today's 5-minute bars vs the prior
// close; the rest are daily closes vs the first close in the window.
const HZ={"1D":0,"1W":5,"1M":21,"3M":63,"6M":126,"1Y":252};
let cur=null,liveIntraCache={},hz=store.get("hz","1D");if(!(hz in HZ))hz="1D";
const money=v=>v>=1000?v.toLocaleString(undefined,{maximumFractionDigits:2}):v.toFixed(2);
const pct=v=>(v>=0?"+":"−")+Math.abs(v*100).toFixed(2)+"%";
const sgnMoney=v=>(v>=0?"+":"−")+money(Math.abs(v));
const barTime=i=>{const m=570+i*5,h=Math.floor(m/60),mm=m%60;return`${(h+11)%12+1}:${String(mm).padStart(2,"0")}`};
function series(t){  // -> {xs:[label...], ys:[price|null...], ref, refLabel, n(total slots)}
  const p=PX[t];if(!p)return null;
  if(hz==="1D"){const it=INTRA[t];if(!it)return null;const [day,start,cl]=it;
    const ys=Array(BARS).fill(null);cl.forEach((v,i)=>ys[start+i]=v);
    return{xs:ys.map((_,i)=>barTime(i)),ys,ref:p[p.length-2],refLabel:"prev close",label:fmtDate(day),n:BARS}}
  const k=Math.min(HZ[hz],p.length-1),ys=p.slice(p.length-1-k),ds=DATES.slice(DATES.length-1-k);
  return{xs:ds.map(fmtDate),ys,ref:ys[0],refLabel:fmtDate(ds[0]),label:fmtDate(ds[0])+" – "+fmtDate(ds[ds.length-1]),n:ys.length}}
function drawChart(t){
  const box=$("chart"),W=box.clientWidth||360,H=220,padT=22,padB=18,padL=4,padR=4,sr=series(t);
  if(!sr){box.innerHTML=`<svg viewBox="0 0 ${W} ${H}"><text x="${W/2}" y="${H/2}" text-anchor="middle">No intraday data yet</text></svg>`;$("hzc").textContent="";return}
  const vals=sr.ys.filter(v=>v!==null),last=vals[vals.length-1],up=last>=sr.ref;
  let lo=Math.min(...vals,sr.ref),hi=Math.max(...vals,sr.ref);if(hi===lo){hi+=.5;lo-=.5}
  const pad=(hi-lo)*.08;lo-=pad;hi+=pad;
  const X=i=>padL+i/(sr.n-1)*(W-padL-padR),Y=v=>padT+(hi-v)/(hi-lo)*(H-padT-padB);
  let d="",area="",pen=false,firstX=null,lastX=null;
  sr.ys.forEach((v,i)=>{if(v===null){pen=false;return}const x=X(i),y=Y(v);d+=(pen?"L":"M")+x.toFixed(1)+" "+y.toFixed(1);pen=true;if(firstX===null)firstX=x;lastX=x});
  if(firstX!==null)area=d.replace(/M/g,"L").replace(/^L/,"M")+`L${lastX.toFixed(1)} ${Y(lo).toFixed(1)}L${firstX.toFixed(1)} ${Y(lo).toFixed(1)}Z`;
  const col=up?"var(--pos)":"var(--neg)",ry=Y(sr.ref);
  // (SVG built through innerHTML: keep every attribute quoted, or "/>" is misparsed.)
  box.innerHTML=`<svg viewBox="0 0 ${W} ${H}" id="csvg"><path class="ar" d="${area}" fill="${col}"/>
<line class="ref" x1="0" x2="${W}" y1="${ry.toFixed(1)}" y2="${ry.toFixed(1)}"/>
<text x="${W-padR}" y="${(ry-4).toFixed(1)}" text-anchor="end">${money(sr.ref)} ${sr.refLabel}</text>
<text x="${padL}" y="14">${money(hi)}</text><text x="${padL}" y="${H-padB+13}">${money(lo)}</text>
<text x="${W/2}" y="${H-2}" text-anchor="middle">${sr.label}</text>
<path class="ln" d="${d}" stroke="${col}"/><g id="hover" hidden><line class="hair" y1="${padT}" y2="${H-padB}"/><circle class="dot" r="4" fill="${col}"/></g></svg><div class="tip" id="tip" hidden></div>`;
  const chg=last/sr.ref-1;$("hzc").textContent=`${sgnMoney(last-sr.ref)} (${pct(chg)})`;$("hzc").style.color=col;
  const svg=$("csvg"),hov=$("hover"),tip=$("tip");
  const move=e=>{const r=svg.getBoundingClientRect(),fx=(e.clientX-r.left)/r.width*W;let i=Math.round((fx-padL)/(W-padL-padR)*(sr.n-1));
    i=Math.max(0,Math.min(sr.n-1,i));let j=i,k=i;while(j>=0&&sr.ys[j]===null)j--;while(k<sr.n&&sr.ys[k]===null)k++;
    if(j<0&&k>=sr.n)return;i=(j<0||(k<sr.n&&k-i<i-j))?k:j;const x=X(i),y=Y(sr.ys[i]);
    hov.hidden=false;hov.querySelector("line").setAttribute("x1",x);hov.querySelector("line").setAttribute("x2",x);
    const c=hov.querySelector("circle");c.setAttribute("cx",x);c.setAttribute("cy",y);
    tip.hidden=false;tip.innerHTML=`${sr.xs[i]} <b>${money(sr.ys[i])}</b>`;tip.style.left=Math.max(50,Math.min(W-50,x))/W*100+"%"};
  svg.onpointermove=move;svg.onpointerdown=move;svg.onpointerleave=()=>{hov.hidden=true;tip.hidden=true}}
function showDetail(t,keep){cur=t;
  if(getKey()&&!keep&&!(liveIntraCache[t]>Date.now()-6e4)){liveIntraCache[t]=Date.now();
    liveIntraday(t).then(it=>{if(it){INTRA[t]=it;if(cur===t)drawChart(t)}}).catch(()=>{})}const p=PX[t],m=META[t]||["","",""],L=p.length,d1=p[L-1]-p[L-2];
  $("dtick").textContent=t;$("dname").textContent=m[0];$("dsec").textContent=[m[1],m[2]].filter(Boolean).join(" · ");
  $("dprice").textContent=money(p[L-1]);const c=$("dchg");c.textContent=`${sgnMoney(d1)} (${pct(d1/p[L-2])}) today`;c.style.color=d1>=0?"var(--pos)":"var(--neg)";
  const lr=lastRank[t];$("drank").textContent=lr?`Rank #${lr[0]+1} of ${Object.keys(lastRank).length} · ${lr[1]} · ${$("sum").textContent}`:"Not in the current universe";
  document.querySelectorAll("[data-hz]").forEach(x=>x.setAttribute("aria-pressed",x.dataset.hz===hz));$("hzl").textContent=hz;
  drawChart(t);if(!keep){b.classList.add("dopen");$("detail").classList.add("on");$("dclose").focus()}}
const closeDetail=()=>{b.classList.remove("dopen");$("detail").classList.remove("on");cur=null};
$("rows").onclick=e=>{const tr=e.target.closest("tr[data-t]");if(tr)showDetail(tr.dataset.t)};
$("dclose").onclick=closeDetail;
document.querySelectorAll("[data-hz]").forEach(x=>x.onclick=()=>{hz=x.dataset.hz;store.set("hz",hz);if(cur)showDetail(cur,true)});
addEventListener("resize",()=>{if(cur)drawChart(cur)});
"""


def build_payload(prices, caps, as_of, meta=None, dates=None, intra=None):
    """Everything the page needs. It is embedded in the HTML and also written as
    data.json so the page's refresh button can pull a newer build in place."""
    return {"asOf": as_of, "data": [[s, cap_bucket(caps[s]), p] for s, p in prices.items()],
            "meta": {s: [m["name"], m["sector"], m["industry"]] for s, m in (meta or {}).items()},
            "dates": dates or [], "intra": intra or {}}


def render_html(prices, caps, as_of, meta=None, dates=None, intra=None):
    """The page embeds each ticker's prices (not rounded returns) so the browser's
    scores match Python's exactly, plus its market-cap bucket."""
    payload = json.dumps(build_payload(prices, caps, as_of, meta, dates, intra), separators=(",", ":"))
    buckets = [name for name, _ in CAP_BUCKETS]
    consts = (f"let PAYLOAD={payload};const SKIP={SKIP},YEAR={TRADING_DAYS},WIN={json.dumps(WINDOWS)},"
              f"BUCKETS={json.dumps(buckets)},PCTS=[95,75,50,25,5],BARS={BARS_PER_DAY};")
    cap_buttons = "".join(f"<button data-cap={n}>{n.title()}</button>" for n in buckets)
    hz_buttons = "".join(f"<button data-hz={h}>{h}</button>" for h in ("1D", "1W", "1M", "3M", "6M", "1Y"))
    return f"""<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Return Ranker</title><style>{CSS}</style></head><body><main>
<header><div><h1>Return Ranker</h1><p class=sum id=sum></p><p class=asof id=asof></p></div><div class=hbtns>
<button class=gear id=refresh aria-label="Refresh prices" title="Refresh prices">{REFRESH}</button>
<button class=gear id=gear aria-label=Settings aria-expanded=false aria-controls=sheet>{GEAR}</button></div></header>
<div id=ranktab><table id=tbl><thead><tr><th>Ticker</th><th id=colth class=num><button class=sortb id=colbtn aria-haspopup=menu aria-expanded=false aria-controls=dispmenu
 title="Tap to sort, long-press to change display" data-dir=""><span id=col>Ann. Log Return</span>{SORT}</button>
<div class=menu id=dispmenu role=menu aria-label=Display hidden><button role=menuitemradio data-disp=raw>Raw</button><button role=menuitemradio data-disp=z>Z-score</button><button role=menuitemradio data-disp=pct>Percentile</button><button role=menuitemradio data-disp=rank>Rank</button></div></th>
<th id=tday class=num hidden><button class=sortb id=sortday data-dir="" aria-label="Sort by today's change" title="Tap to sort, long-press for 5-day"><span id=daylbl>Today</span>{SORT}</button></th></tr></thead><tbody id=rows></tbody></table>
</div>
<section id=lab aria-label=Lab><div class=labh><h2>21D cumulative log return</h2><p id=labsub></p></div>
<div class=hm id=hm></div>
<div class=lg><span id=lgmin></span><span class=bar></span><span id=lgmax></span></div>
<p class=dnote>Each cell is the log return from the close 21 sessions ago to that day's close (the latest price for today); the right column is the full 21-day figure. Colour saturates at the 95th percentile of the grid. Tap a cell for the value, a ticker for its chart.</p>
<div class="labh labsec"><h2>Correlation clusters</h2><p id=cmsub></p></div>
<div class=seg role=group aria-label="Correlation window" style="margin-bottom:10px"><button data-cw=1M>1M</button><button data-cw=3M>3M</button><button data-cw=6M>6M</button><button data-cw=1Y>1Y</button></div>
<div class=cm id=cm></div>
<div class=lg><span id=cmmin></span><span class=bar></span><span id=cmmax></span></div>
<p class=dnote>Rows and columns follow the dendrogram's optimal leaf order, so neighbours are the most correlated pairs; the tree on the left shows the average-linkage merges (further left = merged at a larger 1−ρ). Colour saturates at the 95th percentile of |ρ| off the diagonal. Tap a cell for ρ, a ticker for its chart.</p></section>
</main>
<nav class=tabs aria-label=Views><button data-tab=rank aria-selected=true><span class=ico>&#9776;</span>Rank</button><button data-tab=lab aria-selected=false><span class=ico>&#9879;</span>Lab</button></nav>
<section class=detail id=detail role=dialog aria-modal=true aria-labelledby=dtick>
<div class=dtop><button class=x id=dclose aria-label="Close">&#x2715;</button><div style="min-width:0"><p class=dtick id=dtick></p><p class=dname id=dname></p></div></div>
<p class=dsec id=dsec></p>
<p class=dprice id=dprice></p><p class=dchg id=dchg></p><p class=drank id=drank></p>
<div class=hz><span class=hzl id=hzl></span><span class=hzc id=hzc></span></div>
<div class=chart id=chart></div>
<div class=seg role=group aria-label=Horizon style="margin-top:10px">{hz_buttons}</div>
<p class=dnote>1D shows 5-minute bars for the latest session against the prior close; other horizons use daily closes and the latest price. Tap or drag the chart to read values.</p>
</section>
<section class=sheet id=sheet role=region aria-label=Settings>
<div class=top><h2>Settings</h2><button class=x id=close aria-label="Close settings">&#x2715;</button></div>
<div class=grid>
<div class=full><p class=lbl>Universe</p><div class=seg role=group aria-label="Market cap">{cap_buttons}</div></div>
<div><p class=lbl>Blend</p><div class=seg role=group aria-label=Blend><button data-win=6m>6M</button><button data-win=12m>12M</button></div></div>
<div><p class=lbl>Skip</p><div class=seg role=group aria-label=Skip><button data-skip=0>None</button><button data-skip=1>{SKIP}</button></div></div>
<div><p class=lbl>Volatility</p><div class=seg role=group aria-label=Volatility><button data-vol=0>Off</button><button data-vol=1>On</button></div></div>
<div><p class=lbl>&times; R&sup2;</p><div class=seg role=group aria-label="Multiply by R squared"><button data-r2=0>Off</button><button data-r2=1>On</button></div></div>
<div><p class=lbl>Today</p><div class=seg role=group aria-label="Today's change"><button data-today=0>Off</button><button data-today=1>On</button></div></div>
<div><p class=lbl>Appearance</p><div class=seg role=group aria-label=Appearance><button data-theme-opt=auto>Auto</button><button data-theme-opt=light>Light</button><button data-theme-opt=dark>Dark</button></div></div>
<div class=full><p class=lbl>Live quotes (FMP key)</p><div class=keyrow><input id=fmpkey type=password autocomplete=off spellcheck=false aria-label="FMP API key"><button class=pri id=keysave>Save</button><button id=keyclear>Clear</button></div><p class=keyst id=keyst></p></div>
</div>
</section>
<script>{consts}{JS}</script></body></html>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--caps", default="mega,large,mid,small", help="market-cap buckets to include (comma-separated)")
    ap.add_argument("--window", choices=[*WINDOWS, "blend"], default="12m", help="lookback window")
    ap.add_argument("--w6", type=float, default=0.5, help="6M weight for --window blend (12M gets 1 - w6)")
    ap.add_argument("--skip", action="store_true", help=f"skip the last {SKIP} sessions")
    ap.add_argument("--vol", action="store_true", help="divide by annualized std dev of daily log returns (same window)")
    ap.add_argument("--r2", action="store_true", help="multiply each window's score by the R² of its log-price trend")
    ap.add_argument("--z", action="store_true", help="show cross-sectional z-scores (blend z-scores each window first)")
    ap.add_argument("--html", metavar="PATH", help="also write the ranking as a static HTML page (+ data.json)")
    ap.add_argument("--no-intraday", action="store_true", help="skip the per-ticker intraday bars in --html")
    args = ap.parse_args()
    if not os.environ.get("FMP_API_KEY"):
        sys.exit("FMP_API_KEY is not set")

    prices, caps, meta, dates = load_prices()
    returns = {s: daily_log_returns(p, len(p) - 1) for s, p in prices.items()}
    wanted = set(args.caps.split(","))
    include = {s for s, c in caps.items() if cap_bucket(c) in wanted}
    ranked = rank(returns, args.window, args.w6, SKIP if args.skip else 0, args.vol, include, args.z, args.r2)
    print(f"{'Rank':>4}  {'Ticker':<6}  {'score':>10}")
    for i, (s, r) in enumerate(ranked, 1):
        print(f"{i:>4}  {s:<6}  {r:>10.4f}")
    if args.html:
        as_of = datetime.now(NY).strftime("%b %-d, %Y %-I:%M %p %Z")
        intra = {} if args.no_intraday else load_intraday_all(list(prices))
        out = Path(args.html)
        out.write_text(render_html(prices, caps, as_of, meta, dates, intra))
        out.with_name("data.json").write_text(json.dumps(build_payload(prices, caps, as_of, meta, dates, intra),
                                                         separators=(",", ":")))


if __name__ == "__main__":
    main()
