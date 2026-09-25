#!/usr/bin/env python3
"""Rank S&P 500 stocks (any market-cap rank range) by 12-month log return.

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

Usage:  FMP_API_KEY=... python3 momentum.py [--range 1-100] [--window 12m|6m|blend [--w6 0.5]] [--skip] [--vol] [--html index.html]
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
    return [u["symbol"] for u in universe]


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
    return {s: daily_log_returns(p, len(p) - 1) for s, p in load_prices(top).items()}


def load_prices(top=None):
    """{ticker: up to 253 most recent prices ending at P_now}, market-cap order."""
    (DATA / "history").mkdir(parents=True, exist_ok=True)
    symbols = load_universe(top)
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
    return out


def blend_score(rets, w6=0.5, skip=0, vol_adjust=False):
    """Weighted blend of the annualized 6M and 12M scores (weights sum to 1)."""
    s6, s12 = score(rets, WINDOWS["6m"], skip, vol_adjust), score(rets, WINDOWS["12m"], skip, vol_adjust)
    return None if s6 is None or s12 is None else w6 * s6 + (1 - w6) * s12


def rank(returns, window="12m", w6=0.5, skip=0, vol_adjust=False, lo=1, hi=None):
    """Rank the stocks whose market-cap rank is in [lo, hi] (1 = largest)."""
    if window == "blend":
        f = lambda r: blend_score(r, w6, skip, vol_adjust)
    else:
        f = lambda r: score(r, WINDOWS[window], skip, vol_adjust)
    pool = list(returns.items())[lo - 1:hi]
    scored = [(s, v) for s, v in ((s, f(r)) for s, r in pool) if v is not None]
    return sorted(scored, key=lambda x: x[1], reverse=True)


GEAR = ('<svg width=22 height=22 viewBox="0 0 24 24" fill=currentColor><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 '
        '7.4 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.2 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 '
        '1.7 1l.4 2.6h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>')

CSS = """
:root{--bg:#f5f5f7;--fg:#111418;--muted:#6e737b;--chip:#ebebee;--line:#e3e3e6;--sheet:#fff;--knob:#fff;
  --on:#2a9d4f;--onbg:#e6f4ea;--pos:#1e9e4a;--neg:#d23b30}
@media (prefers-color-scheme:dark){:root{--bg:#0e0f11;--fg:#f2f2f4;--muted:#9a9ea6;--chip:#232428;--line:#2a2b30;
  --sheet:#18191c;--knob:#f2f2f4;--on:#30b35f;--onbg:#1d3325;--pos:#3ccf70;--neg:#ff6b60}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.4 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",system-ui,sans-serif}
main{max-width:560px;margin:0 auto;padding:40px 16px 48px}
header{display:grid;grid-template-columns:1fr auto;column-gap:12px;margin-bottom:20px}
h1{font-size:clamp(28px,9vw,36px);font-weight:700;letter-spacing:-.02em;margin:0 0 6px}
.gear{width:44px;height:44px;border:0;border-radius:12px;background:var(--chip);color:var(--fg);cursor:pointer;display:grid;place-items:center}
.sub{grid-column:1/-1;margin:0;font-size:18px;color:var(--muted)}
.sub span{font-size:15px}.sub small{font-size:12px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{background:var(--chip);color:var(--muted);font-weight:400;font-size:15px;text-align:left;padding:10px 14px;white-space:nowrap}
th:first-child{border-radius:10px 0 0 10px}th:last-child{border-radius:0 10px 10px 0}
td{padding:12px 14px;border-bottom:1px solid var(--line)}
th:nth-child(1),td:nth-child(1){width:4.2em}
th:last-child,td:last-child{text-align:right}
.pos{color:var(--pos)}.neg{color:var(--neg)}
.empty{color:var(--muted);text-align:center!important;padding:28px}
.scrim{position:fixed;inset:0;background:rgba(0,0,0,.25);opacity:0;pointer-events:none;transition:opacity .2s}
.sheet{position:fixed;left:0;right:0;bottom:0;max-width:560px;margin:0 auto;background:var(--sheet);border-radius:22px 22px 0 0;
  padding:10px 20px calc(24px + env(safe-area-inset-bottom));max-height:90vh;overflow:auto;transform:translateY(105%);transition:transform .25s ease;
  box-shadow:0 -4px 24px rgba(0,0,0,.08)}
.open .scrim{opacity:1;pointer-events:auto}.open .sheet{transform:none}
.grip{width:40px;height:5px;border-radius:3px;background:var(--line);margin:0 auto 14px}
.top{display:flex;justify-content:space-between;align-items:center;padding-bottom:12px;border-bottom:1px solid var(--line)}
.top h2{font-size:28px;margin:0}
.done{border:0;border-radius:10px;background:var(--onbg);color:var(--on);font:inherit;font-weight:600;padding:8px 16px;cursor:pointer}
.sec{padding:18px 0;border-bottom:1px solid var(--line)}.sec:last-child{border-bottom:0}
.lbl{margin:0 0 14px;font-weight:500;display:flex;justify-content:space-between}
.lbl output{color:var(--muted);font-weight:400}
.dual{position:relative;height:28px}
.dual .track,.dual .fill{position:absolute;top:12px;height:5px;border-radius:3px}
.dual .track{left:0;right:0;background:var(--chip)}.dual .fill{background:var(--on)}
.dual input{position:absolute;inset:0;width:100%;margin:0;background:none;pointer-events:none;-webkit-appearance:none;appearance:none}
.dual input::-webkit-slider-thumb{-webkit-appearance:none;pointer-events:auto;width:28px;height:28px;border-radius:50%;background:var(--knob);
  box-shadow:0 1px 4px rgba(0,0,0,.25);border:0;cursor:pointer}
.dual input::-moz-range-thumb{pointer-events:auto;width:28px;height:28px;border-radius:50%;background:var(--knob);box-shadow:0 1px 4px rgba(0,0,0,.25);border:0;cursor:pointer}
.dual input::-moz-range-track{background:none}
.ends{display:flex;justify-content:space-between;color:var(--muted);font-size:14px;margin-top:4px}
.seg{display:grid;grid-template-columns:repeat(3,1fr);background:var(--chip);border-radius:12px;padding:3px;gap:3px}
.seg button{border:0;background:none;color:var(--fg);font:inherit;padding:9px 0;border-radius:10px;cursor:pointer}
.seg button[aria-pressed=true]{background:var(--on);color:#fff;font-weight:500}
.wts{margin-top:16px}.wts p{margin:0 0 10px}
.wbar{position:relative;height:40px;border-radius:12px;background:var(--chip);display:flex;align-items:center;font-variant-numeric:tabular-nums}
.wbar .h{flex:1;display:flex;justify-content:center;gap:10px;pointer-events:none}.wbar .h span{color:var(--muted);font-size:14px;align-self:center}
.wbar input{position:absolute;inset:0;width:100%;margin:0;opacity:0;cursor:pointer}
.wbar .k{position:absolute;top:6px;width:28px;height:28px;margin-left:-14px;border-radius:50%;background:var(--knob);box-shadow:0 1px 4px rgba(0,0,0,.25);pointer-events:none}
.opt{display:grid;grid-template-columns:1fr auto;align-items:center;gap:2px 12px}
.opt .t{font-weight:500}.opt .d{color:var(--muted);font-size:14px}
.sw{grid-row:1/3;grid-column:2;position:relative;width:51px;height:31px}
.sw input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}
.sw span{position:absolute;inset:0;border-radius:31px;background:var(--line);transition:background .2s;pointer-events:none}
.sw span:after{content:"";position:absolute;top:2px;left:2px;width:27px;height:27px;border-radius:50%;background:var(--knob);
  box-shadow:0 2px 4px rgba(0,0,0,.2);transition:transform .2s}
.sw input:checked+span{background:var(--on)}.sw input:checked+span:after{transform:translateX(20px)}
.sw input:focus-visible+span,.dual input:focus-visible,.wbar input:focus-visible+.k{outline:2px solid var(--on);outline-offset:2px}
"""

# Mirrors score()/blend_score()/rank() above. DATA is [[ticker, prices], ...] in
# market-cap order; daily log returns are derived exactly as daily_log_returns().
JS = """
const $=id=>document.getElementById(id),b=document.body,N=DATA.length;
const R=DATA.map(([t,p])=>[t,p.slice(1).map((v,i)=>Math.log(v/p[i]))]);
const store={get(k,d){try{const v=localStorage.getItem(k);return v===null?d:v}catch(e){return d}},set(k,v){try{localStorage.setItem(k,v)}catch(e){}}};
const int=(v,lo,hi,d)=>{v=parseInt(v);return isNaN(v)?d:Math.min(hi,Math.max(lo,v))};
function score(r,win,skip,vol){
  if(r.length<win)return null;
  const x=r.slice(r.length-win,r.length-skip),n=x.length,sum=x.reduce((a,v)=>a+v,0),ann=sum*YEAR/n;
  if(!vol)return ann;
  const m=sum/n,sd=Math.sqrt(x.reduce((a,v)=>a+(v-m)**2,0)/(n-1));
  return ann/(sd*Math.sqrt(YEAR));
}
let mode=store.get("window","12m");if(!["12m","6m","blend"].includes(mode))mode="12m";
let w6=int(store.get("w6","50"),0,100,50),lo=int(store.get("lo","1"),1,N,1),hi=int(store.get("hi","100"),1,N,Math.min(100,N));
if(lo>hi)[lo,hi]=[1,Math.min(100,N)];
$("skip").checked=store.get("skip21","0")==="1";$("vol").checked=store.get("volAdj","0")==="1";
$("lo").max=$("hi").max=N;$("nmax").textContent=N;
function apply(){
  const skip=$("skip").checked?SKIP:0,vol=$("vol").checked;
  $("lo").value=lo;$("hi").value=hi;$("lo").style.zIndex=lo>N/2?2:1;
  $("fill").style.left=((lo-1)/(N-1)*100)+"%";$("fill").style.right=((N-hi)/(N-1)*100)+"%";
  $("rng").textContent=`${lo}\\u2013${hi}`;
  $("univ").textContent=`S&P 500 \\u2022 ${hi-lo+1} stocks (${lo}\\u2013${hi})`;
  document.querySelectorAll(".seg button").forEach(x=>x.setAttribute("aria-pressed",x.dataset.w===mode));
  $("wts").hidden=mode!=="blend";$("w").value=w6;$("p6").textContent=w6+"%";$("p12").textContent=(100-w6)+"%";
  $("knob").style.left=`calc(14px + ${w6/100} * (100% - 28px))`;
  $("endpoint").textContent=skip?`Endpoint P[t\\u2212${SKIP}] (skip ${SKIP} days).`:"Latest available price used.";
  $("col").innerHTML=vol?"Ann. Return / &sigma;":"Ann. Log Return";
  const f=r=>{if(mode!=="blend")return score(r,WIN[mode],skip,vol);
    const a=score(r,WIN["6m"],skip,vol),c=score(r,WIN["12m"],skip,vol);return a===null||c===null?null:w6/100*a+(1-w6/100)*c};
  const ranked=R.slice(lo-1,hi).map(([t,r])=>[t,f(r)]).filter(x=>x[1]!==null).sort((a,c)=>c[1]-a[1]);
  const fmt=v=>(v>=0?"+":"\\u2212")+(vol?Math.abs(v).toFixed(2):(Math.abs(v)*100).toFixed(1)+"%");
  $("rows").innerHTML=ranked.length?ranked.map(([t,v],i)=>`<tr><td>${i+1}</td><td>${t}</td><td class=${v>=0?"pos":"neg"}>${fmt(v)}</td></tr>`).join("")
    :"<tr><td colspan=3 class=empty>No stocks with enough history in this range.</td></tr>";
}
$("lo").oninput=e=>{lo=Math.min(int(e.target.value,1,N,1),hi);store.set("lo",lo);apply()};
$("hi").oninput=e=>{hi=Math.max(int(e.target.value,1,N,N),lo);store.set("hi",hi);apply()};
$("w").oninput=e=>{w6=int(e.target.value,0,100,50);store.set("w6",w6);apply()};
document.querySelectorAll(".seg button").forEach(x=>x.onclick=()=>{mode=x.dataset.w;store.set("window",mode);apply()});
for(const [id,k] of [["skip","skip21"],["vol","volAdj"]])$(id).onchange=e=>{store.set(k,e.target.checked?"1":"0");apply()};
apply();
const close=()=>b.classList.remove("open");
$("gear").onclick=()=>b.classList.add("open");$("scrim").onclick=close;$("done").onclick=close;
document.onkeydown=e=>{if(e.key==="Escape")close()};
"""

def render_html(prices, as_of):
    """The page embeds each ticker's prices (not rounded returns) so the browser's
    scores match Python's exactly."""
    data = json.dumps([[s, p] for s, p in prices.items()], separators=(",", ":"))
    consts = f"const DATA={data},SKIP={SKIP},YEAR={TRADING_DAYS},WIN={json.dumps(WINDOWS)};"
    return f"""<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Return Ranker</title><style>{CSS}</style></head><body><main>
<header><h1>Return Ranker</h1><button class=gear id=gear aria-label=Settings>{GEAR}</button>
<p class=sub><span id=univ></span><br><span id=endpoint></span><br><small>As of {as_of}</small></p></header>
<table><thead><tr><th>#</th><th>Ticker</th><th id=col>Ann. Log Return</th></tr></thead><tbody id=rows></tbody></table></main>
<div class=scrim id=scrim></div>
<section class=sheet role=dialog aria-label=Settings><div class=grip></div>
<div class=top><h2>Settings</h2><button class=done id=done>Done</button></div>
<div class=sec><p class=lbl>Universe (S&amp;P 500 rank) <output id=rng></output></p>
<div class=dual><div class=track></div><div class=fill id=fill></div>
<input type=range id=lo min=1 step=1 aria-label="Largest market-cap rank to include">
<input type=range id=hi min=1 step=1 aria-label="Smallest market-cap rank to include"></div>
<div class=ends><span>1</span><span id=nmax></span></div></div>
<div class=sec><p class=lbl>Lookback window</p>
<div class=seg role=group aria-label="Lookback window"><button data-w=12m>12M</button><button data-w=6m>6M</button><button data-w=blend>12M + 6M</button></div>
<div class=wts id=wts><p>Weights (12M + 6M)</p><div class=wbar>
<div class=h><span>6M</span><b id=p6></b></div><div class=h><span>12M</span><b id=p12></b></div>
<input type=range id=w min=0 max=100 step=5 aria-label="6M weight"><div class=k id=knob></div></div></div></div>
<div class=sec><label class=opt><span class=t>Volatility adjust (&divide; stdev)</span><span class=sw><input type=checkbox id=vol><span></span></span>
<span class=d>Divide by the standard deviation of daily log returns over the same window.</span></label></div>
<div class=sec><label class=opt><span class=t>Skip {SKIP} trading days</span><span class=sw><input type=checkbox id=skip><span></span></span>
<span class=d>Use P[t&minus;{SKIP}] as the endpoint.</span></label></div></section>
<script>{consts}{JS}</script></body></html>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--range", default="1-100", help="market-cap ranks to include, e.g. 1-100 (1 = largest)")
    ap.add_argument("--window", choices=[*WINDOWS, "blend"], default="12m", help="lookback window")
    ap.add_argument("--w6", type=float, default=0.5, help="6M weight for --window blend (12M gets 1 - w6)")
    ap.add_argument("--skip", action="store_true", help=f"skip the last {SKIP} sessions")
    ap.add_argument("--vol", action="store_true", help="divide by annualized std dev of daily log returns (same window)")
    ap.add_argument("--html", metavar="PATH", help="also write the ranking as a static HTML page")
    args = ap.parse_args()
    if not os.environ.get("FMP_API_KEY"):
        sys.exit("FMP_API_KEY is not set")

    lo, hi = map(int, args.range.split("-"))
    prices = load_prices()
    returns = {s: daily_log_returns(p, len(p) - 1) for s, p in prices.items()}
    ranked = rank(returns, args.window, args.w6, SKIP if args.skip else 0, args.vol, lo, hi)
    print(f"{'Rank':>4}  {'Ticker':<6}  {'score':>10}")
    for i, (s, r) in enumerate(ranked, 1):
        print(f"{i:>4}  {s:<6}  {r:>10.4f}")
    if args.html:
        as_of = datetime.now(NY).strftime("%b %-d, %Y %-I:%M %p %Z")
        Path(args.html).write_text(render_html(prices, as_of))


if __name__ == "__main__":
    main()
