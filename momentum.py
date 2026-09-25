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
    symbols = [c["symbol"] for c in fmp("sp500-constituent")]
    quotes = batch_quotes(symbols)
    ranked = sorted(quotes.values(), key=lambda q: q.get("marketCap") or 0, reverse=True)
    universe = [{"symbol": q["symbol"], "marketCap": q["marketCap"]} for q in ranked[:top]]
    (DATA / "universe.json").write_text(json.dumps(universe, indent=2))
    return [(u["symbol"], u["marketCap"] or 0) for u in universe]


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
    closes = [c for d, c in history if d <= quote_day]
    if closes and history[-1][0] == quote_day:
        closes = closes[:-1]
    return closes + [quote["price"]]


def daily_log_returns(prices, lookback=LOOKBACK):
    """The last `lookback` daily log returns, ending at P_now."""
    if len(prices) < lookback + 1:
        return None
    window = prices[-(lookback + 1):]
    return [math.log(b / a) for a, b in zip(window, window[1:])]


def score(rets, window=LOOKBACK, skip=0, vol_adjust=False):
    """Annualized sum of daily log returns over the last `window` sessions,
    excluding the most recent `skip`: sum * 252 / n, n = window - skip (factor 1
    for the plain 12-month window). With vol_adjust, divided by the annualized
    sample std dev of those same daily returns, stdev * sqrt(252).
    The page's JavaScript mirrors this exactly."""
    if len(rets) < window:
        return None
    r = rets[len(rets) - window:len(rets) - skip]
    ann_return = sum(r) * TRADING_DAYS / len(r)
    if vol_adjust:
        return ann_return / (statistics.stdev(r) * math.sqrt(TRADING_DAYS))
    return ann_return


def load_returns(top=None):
    """{ticker: up to 252 most recent daily log returns ending at P_now}, in
    market-cap order (largest first). Tickers with shorter history keep what they
    have and are left out of any window longer than that."""
    return {s: daily_log_returns(p, len(p) - 1) for s, p in load_prices(top)[0].items()}


def load_prices(top=None):
    """({ticker: up to 253 most recent prices ending at P_now}, {ticker: market cap}),
    both in market-cap order."""
    (DATA / "history").mkdir(parents=True, exist_ok=True)
    caps = dict(load_universe(top))
    symbols = list(caps)
    with ThreadPoolExecutor(max_workers=8) as ex:
        histories = dict(zip(symbols, ex.map(load_history, symbols)))
    quotes = load_quotes(symbols)

    out = {}
    for s in symbols:
        if s not in quotes or not histories[s]:
            continue
        prices = price_series(histories[s], quotes[s])[-(LOOKBACK + 1):]
        if len(prices) < 2:
            continue
        if len(prices) <= LOOKBACK:
            print(f"note {s}: only {len(prices) - 1} sessions of history", file=sys.stderr)
        out[s] = prices
    return out, {s: caps[s] for s in out}


def zscores(values):
    """Cross-sectional z-scores (sample std dev); all 0 if there are < 2 values."""
    if len(values) < 2:
        return [0.0] * len(values)
    m, sd = statistics.mean(values), statistics.stdev(values)
    return [(v - m) / sd if sd else 0.0 for v in values]


def rank(returns, window="12m", w6=0.5, skip=0, vol_adjust=False, include=None, zscore=False):
    """Rank the stocks in `include` (all when None), best first. A blend is the
    weighted sum of the 6M and 12M scores; with zscore, each window's scores are
    first converted to z-scores across the ranked stocks (so the blend weighs the
    windows equally in dispersion) and the result is shown in z units."""
    parts = [("6m", w6), ("12m", 1 - w6)] if window == "blend" else [(window, 1.0)]
    rows = []
    for s, r in returns.items():
        if include is not None and s not in include:
            continue
        comps = [score(r, WINDOWS[w], skip, vol_adjust) for w, _ in parts]
        if None not in comps:
            rows.append((s, comps))
    cols = [[c[j] for _, c in rows] for j in range(len(parts))]
    if zscore:
        cols = [zscores(col) for col in cols]
    scored = [(s, sum(wt * cols[j][i] for j, (_, wt) in enumerate(parts))) for i, (s, _) in enumerate(rows)]
    return sorted(scored, key=lambda x: x[1], reverse=True)


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
main{max-width:560px;margin:0 auto;padding:24px 16px 40px}
header{position:relative;text-align:center;padding:52px 0 20px}
h1{font-size:28px;font-weight:700;letter-spacing:-.01em;margin:0 0 6px}
.gear{position:absolute;top:0;right:0;width:46px;height:46px;border:0;border-radius:14px;background:var(--chip);color:var(--fg);cursor:pointer;display:grid;place-items:center}
.sum{margin:0;color:var(--muted);font-size:17px;letter-spacing:.02em}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{background:var(--chip);color:var(--muted);font-weight:400;font-size:15px;text-align:left;padding:10px 14px;white-space:nowrap}
th:first-child{border-radius:10px 0 0 10px}th:last-child{border-radius:0 10px 10px 0}
td{padding:12px 14px;border-bottom:1px solid var(--line)}
th:nth-child(1),td:nth-child(1){width:4.2em}
th:last-child,td:last-child{text-align:right}
.empty{color:var(--muted);text-align:center!important;padding:28px}
tr.q td{border-bottom:0}
tr.qr td{padding:18px 0;border-bottom:0}  /* room above and below the divider */
.ql{display:flex;align-items:center;gap:12px;color:var(--fg);opacity:.75;font-size:15px;font-weight:500;letter-spacing:.02em}
.ql::before,.ql::after{content:"";flex:1;height:2px;background:currentColor;opacity:.8}
.ql:empty::after{display:none}
.asof{color:var(--muted);font-size:12px;text-align:center;margin:16px 0 0}
.scrim{position:fixed;inset:0;background:rgba(0,0,0,.3);opacity:0;pointer-events:none;transition:opacity .2s}
.sheet{position:fixed;left:0;right:0;bottom:0;max-width:560px;margin:0 auto;background:var(--sheet);border-radius:24px 24px 0 0;
  padding:10px 20px calc(28px + env(safe-area-inset-bottom));max-height:90vh;overflow:auto;transform:translateY(105%);transition:transform .25s ease;
  box-shadow:0 -4px 24px rgba(0,0,0,.1)}
.open .scrim{opacity:1;pointer-events:auto}.open .sheet{transform:none}
.grip{width:40px;height:5px;border-radius:3px;background:var(--line);margin:0 auto 14px}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.top h2{font-size:28px;margin:0}
.x{width:40px;height:40px;border:0;border-radius:50%;background:var(--chip);color:var(--fg);font-size:20px;line-height:1;cursor:pointer}
.lbl{color:var(--muted);margin:0 0 10px}
.row{display:grid;grid-template-columns:1fr 55%;align-items:center;gap:12px;margin-top:18px}
.row .lbl{margin:0}
.seg{display:grid;grid-auto-columns:1fr;grid-auto-flow:column;background:var(--chip);border-radius:12px;padding:3px;gap:3px}
.seg button{border:0;background:none;color:var(--muted);font:inherit;padding:9px 0;border-radius:10px;cursor:pointer}
.seg button[aria-pressed=true]{background:var(--sel);color:var(--fg);font-weight:500;box-shadow:var(--shadow)}
.seg button:focus-visible{outline:2px solid var(--pos);outline-offset:1px}
"""

# Mirrors score()/rank() above. DATA is [[ticker, bucket, prices], ...]
# in market-cap order; daily log returns are derived exactly as daily_log_returns().
JS = """
const $=id=>document.getElementById(id),b=document.body;
const R=DATA.map(([t,c,p])=>[t,c,p.slice(1).map((v,i)=>Math.log(v/p[i]))]);
const store={get(k,d){try{const v=localStorage.getItem(k);return v===null?d:v}catch(e){return d}},set(k,v){try{localStorage.setItem(k,v)}catch(e){}}};
function score(r,win,skip,vol){
  if(r.length<win)return null;
  const x=r.slice(r.length-win,r.length-skip),n=x.length,sum=x.reduce((a,v)=>a+v,0),ann=sum*YEAR/n;
  if(!vol)return ann;
  const m=sum/n,sd=Math.sqrt(x.reduce((a,v)=>a+(v-m)**2,0)/(n-1));
  return ann/(sd*Math.sqrt(YEAR));
}
const S={caps:new Set(store.get("caps",BUCKETS.join(",")).split(",").filter(c=>BUCKETS.includes(c))),
  wins:new Set(store.get("wins","12m").split(",").filter(w=>w in WIN)),vol:store.get("vol","0")==="1",skip:store.get("skip","0")==="1",z:store.get("z","0")==="1",
  theme:store.get("theme","auto")};
if(!["auto","light","dark"].includes(S.theme))S.theme="auto";
if(!S.wins.size)S.wins.add("12m");
const save=()=>{store.set("theme",S.theme);store.set("caps",[...S.caps].join(","));store.set("wins",[...S.wins].join(","));store.set("vol",S.vol?"1":"0");store.set("skip",S.skip?"1":"0");store.set("z",S.z?"1":"0")};
function apply(){
  const skip=S.skip?SKIP:0,vol=S.vol,wins=["6m","12m"].filter(w=>S.wins.has(w));
  if(S.theme==="auto")delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=S.theme;
  document.querySelectorAll("[data-theme-opt]").forEach(x=>x.setAttribute("aria-pressed",x.dataset.themeOpt===S.theme));
  document.querySelectorAll("[data-cap]").forEach(x=>x.setAttribute("aria-pressed",S.caps.has(x.dataset.cap)));
  document.querySelectorAll("[data-win]").forEach(x=>x.setAttribute("aria-pressed",S.wins.has(x.dataset.win)));
  document.querySelectorAll("[data-vol]").forEach(x=>x.setAttribute("aria-pressed",String(x.dataset.vol==="1")===String(vol)));
  document.querySelectorAll("[data-skip]").forEach(x=>x.setAttribute("aria-pressed",String(x.dataset.skip==="1")===String(S.skip)));
  const pool=R.filter(([,c])=>S.caps.has(c));
  document.querySelectorAll("[data-z]").forEach(x=>x.setAttribute("aria-pressed",String(x.dataset.z==="1")===String(S.z)));
  $("sum").textContent=[pool.length,wins.map(w=>parseInt(w)).join("/"),...(vol?["VOL"]:[]),...(skip?["S"+SKIP]:[]),...(S.z?["Z"]:[])].join(" \\u2022 ");
  $("col").innerHTML=(S.z?"Z-score":"")+(S.z?(vol?" (Ret / &sigma;)":" (Ann. Return)"):vol?"Ann. Return / &sigma;":"Ann. Log Return");
  // Mirrors rank(): per-window scores, optionally z-scored across the pool, then averaged.
  const rows=[];for(const [t,,r] of pool){const c=wins.map(w=>score(r,WIN[w],skip,vol));if(!c.includes(null))rows.push([t,c])}
  let cols=wins.map((_,j)=>rows.map(([,c])=>c[j]));
  if(S.z)cols=cols.map(col=>{const k=col.length;if(k<2)return col.map(()=>0);
    const m=col.reduce((a,v)=>a+v,0)/k,sd=Math.sqrt(col.reduce((a,v)=>a+(v-m)**2,0)/(k-1));return col.map(v=>sd?(v-m)/sd:0)});
  const ranked=rows.map(([t],i)=>[t,cols.reduce((a,col)=>a+col[i]/wins.length,0)]).sort((a,c)=>c[1]-a[1]);
  const fmt=v=>(v>=0?"+":"\\u2212")+(vol||S.z?Math.abs(v).toFixed(2):(Math.abs(v)*100).toFixed(1)+"%");
  // Percentile lines: the line labelled Pk sits below the stocks at or above the
  // k-th percentile (e.g. P95 = top 5% above the line).
  const n=ranked.length,q={};
  for(const k of PCTS){const c=Math.round(n*(1-k/100));if(c>0&&c<n)q[c-1]="P"+k}
  // Value text colour follows the distribution: its percentile in the current
  // ranking, green at the top through neutral at the median to red at the bottom
  // (sqrt easing so colour builds quickly away from the median).
  const grad=i=>{const t=n>1?1-i/(n-1):1,end=t>=.5?"--pos":"--neg";
    return `color-mix(in oklab,var(${end}) ${Math.round(Math.sqrt(Math.abs(t-.5)*2)*100)}%,var(--mid))`};
  $("rows").innerHTML=n?ranked.map(([t,v],i)=>`<tr${q[i]?" class=q":""}><td>${i+1}</td><td>${t}</td><td style="color:${grad(i)}">${fmt(v)}</td></tr>`+
    (q[i]?`<tr class=qr><td><div class=ql></div></td><td><div class=ql>${q[i]}</div></td><td><div class=ql></div></td></tr>`:"")).join("")
    :`<tr><td colspan=3 class=empty>${S.caps.size?"No stocks in the selected market caps.":"Select at least one market cap."}</td></tr>`;
}
document.querySelectorAll("[data-cap]").forEach(x=>x.onclick=()=>{const c=x.dataset.cap;S.caps.has(c)?S.caps.delete(c):S.caps.add(c);save();apply()});
document.querySelectorAll("[data-win]").forEach(x=>x.onclick=()=>{const w=x.dataset.win;
  if(S.wins.has(w)){if(S.wins.size>1)S.wins.delete(w)}else S.wins.add(w);save();apply()});
document.querySelectorAll("[data-theme-opt]").forEach(x=>x.onclick=()=>{S.theme=x.dataset.themeOpt;save();apply()});
document.querySelectorAll("[data-z]").forEach(x=>x.onclick=()=>{S.z=x.dataset.z==="1";save();apply()});
document.querySelectorAll("[data-vol]").forEach(x=>x.onclick=()=>{S.vol=x.dataset.vol==="1";save();apply()});
document.querySelectorAll("[data-skip]").forEach(x=>x.onclick=()=>{S.skip=x.dataset.skip==="1";save();apply()});
apply();
const close=()=>b.classList.remove("open");
$("gear").onclick=()=>b.classList.add("open");$("scrim").onclick=close;$("close").onclick=close;
document.onkeydown=e=>{if(e.key==="Escape")close()};
"""


def render_html(prices, caps, as_of):
    """The page embeds each ticker's prices (not rounded returns) so the browser's
    scores match Python's exactly, plus its market-cap bucket."""
    data = json.dumps([[s, cap_bucket(caps[s]), p] for s, p in prices.items()], separators=(",", ":"))
    buckets = [name for name, _ in CAP_BUCKETS]
    consts = (f"const DATA={data},SKIP={SKIP},YEAR={TRADING_DAYS},WIN={json.dumps(WINDOWS)},"
              f"BUCKETS={json.dumps(buckets)},PCTS=[95,75,50,25,5];")
    cap_buttons = "".join(f"<button data-cap={n}>{n.title()}</button>" for n in buckets)
    return f"""<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Return Ranker</title><style>{CSS}</style></head><body><main>
<header><button class=gear id=gear aria-label=Settings>{GEAR}</button><h1>Return Ranker</h1><p class=sum id=sum></p></header>
<table><thead><tr><th>#</th><th>Ticker</th><th id=col>Ann. Log Return</th></tr></thead><tbody id=rows></tbody></table>
<p class=asof>As of {as_of}</p></main>
<div class=scrim id=scrim></div>
<section class=sheet role=dialog aria-label=Settings><div class=grip></div>
<div class=top><h2>Settings</h2><button class=x id=close aria-label=Close>&#x2715;</button></div>
<p class=lbl>Universe</p><div class=seg role=group aria-label="Market cap">{cap_buttons}</div>
<div class=row><p class=lbl>Blend</p><div class=seg role=group aria-label=Blend><button data-win=6m>6M</button><button data-win=12m>12M</button></div></div>
<div class=row><p class=lbl>Volatility</p><div class=seg role=group aria-label=Volatility><button data-vol=0>Off</button><button data-vol=1>On</button></div></div>
<div class=row><p class=lbl>Skip</p><div class=seg role=group aria-label=Skip><button data-skip=0>None</button><button data-skip=1>{SKIP}</button></div></div>
<div class=row><p class=lbl>Z-score</p><div class=seg role=group aria-label=Z-score><button data-z=0>Off</button><button data-z=1>On</button></div></div>
<div class=row><p class=lbl>Appearance</p><div class=seg role=group aria-label=Appearance><button data-theme-opt=auto>Auto</button><button data-theme-opt=light>Light</button><button data-theme-opt=dark>Dark</button></div></div>
</section>
<script>{consts}{JS}</script></body></html>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--caps", default="mega,large,mid,small", help="market-cap buckets to include (comma-separated)")
    ap.add_argument("--window", choices=[*WINDOWS, "blend"], default="12m", help="lookback window")
    ap.add_argument("--w6", type=float, default=0.5, help="6M weight for --window blend (12M gets 1 - w6)")
    ap.add_argument("--skip", action="store_true", help=f"skip the last {SKIP} sessions")
    ap.add_argument("--vol", action="store_true", help="divide by annualized std dev of daily log returns (same window)")
    ap.add_argument("--z", action="store_true", help="show cross-sectional z-scores (blend z-scores each window first)")
    ap.add_argument("--html", metavar="PATH", help="also write the ranking as a static HTML page")
    args = ap.parse_args()
    if not os.environ.get("FMP_API_KEY"):
        sys.exit("FMP_API_KEY is not set")

    prices, caps = load_prices()
    returns = {s: daily_log_returns(p, len(p) - 1) for s, p in prices.items()}
    wanted = set(args.caps.split(","))
    include = {s for s, c in caps.items() if cap_bucket(c) in wanted}
    ranked = rank(returns, args.window, args.w6, SKIP if args.skip else 0, args.vol, include, args.z)
    print(f"{'Rank':>4}  {'Ticker':<6}  {'score':>10}")
    for i, (s, r) in enumerate(ranked, 1):
        print(f"{i:>4}  {s:<6}  {r:>10.4f}")
    if args.html:
        as_of = datetime.now(NY).strftime("%b %-d, %Y %-I:%M %p %Z")
        Path(args.html).write_text(render_html(prices, caps, as_of))


if __name__ == "__main__":
    main()
