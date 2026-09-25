#!/usr/bin/env python3
"""Rank the ~100 largest S&P 500 stocks by raw 12-month log return.

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
    data/universe.json        top-N constituents by market cap
    data/history/<SYM>.csv    daily closes (date,close), ascending
    data/quotes.json          latest quote per symbol (kept separate from history)

Usage:  FMP_API_KEY=... python3 momentum.py [--top 100] [--window 12m|6m|blend [--w6 0.5]] [--skip] [--vol] [--html index.html]
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
WINDOWS = {"12m": LOOKBACK, "6m": 126}
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
    r = rets[len(rets) - window:len(rets) - skip]
    ann_return = sum(r) * TRADING_DAYS / len(r)
    if vol_adjust:
        return ann_return / (statistics.stdev(r) * math.sqrt(TRADING_DAYS))
    return ann_return


def load_returns(top=100):
    """{ticker: last 252 daily log returns ending at P_now}, universe order."""
    (DATA / "history").mkdir(parents=True, exist_ok=True)
    symbols = load_universe(top)
    with ThreadPoolExecutor(max_workers=8) as ex:
        histories = dict(zip(symbols, ex.map(load_history, symbols)))
    quotes = load_quotes(symbols)

    out = {}
    for s in symbols:
        if s not in quotes or not histories[s]:
            continue
        rets = daily_log_returns(price_series(histories[s], quotes[s]))
        if rets is None:
            print(f"skip {s}: fewer than {LOOKBACK} sessions of history", file=sys.stderr)
            continue
        out[s] = rets
    return out


def blend_score(rets, w6=0.5, skip=0, vol_adjust=False):
    """Weighted blend of the annualized 6M and 12M scores (weights sum to 1)."""
    return (w6 * score(rets, WINDOWS["6m"], skip, vol_adjust)
            + (1 - w6) * score(rets, WINDOWS["12m"], skip, vol_adjust))


def rank(returns, window="12m", w6=0.5, skip=0, vol_adjust=False):
    if window == "blend":
        f = lambda r: blend_score(r, w6, skip, vol_adjust)
    else:
        f = lambda r: score(r, WINDOWS[window], skip, vol_adjust)
    return sorted(((s, f(r)) for s, r in returns.items()), key=lambda x: x[1], reverse=True)


GEAR = ('<svg width=22 height=22 viewBox="0 0 24 24" fill=currentColor><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 '
        '7.4 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.2 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 '
        '1.7 1l.4 2.6h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>')

CSS = """
:root{--bg:#f5f5f7;--fg:#111418;--muted:#6e737b;--card:#fff;--chip:#eeeef0;--line:#e6e6e9;--sheet:#fff;--knob:#fff;
  --on:#2fa85a;--pos:#1e9e4a;--neg:#d23b30}
@media (prefers-color-scheme:dark){:root{--bg:#0e0f11;--fg:#f2f2f4;--muted:#9a9ea6;--card:#18191c;--chip:#232428;--line:#2a2b30;
  --sheet:#18191c;--knob:#f2f2f4;--on:#30b35f;--pos:#3ccf70;--neg:#ff6b60}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.4 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",system-ui,sans-serif}
main{max-width:560px;margin:0 auto;padding:40px 16px 48px}
header{display:grid;grid-template-columns:1fr auto;column-gap:12px;margin-bottom:20px}
h1{font-size:clamp(28px,9vw,36px);font-weight:700;letter-spacing:-.02em;margin:0 0 6px}
.gear{width:44px;height:44px;border:0;border-radius:12px;background:var(--chip);color:var(--fg);cursor:pointer;display:grid;place-items:center}
.sub{grid-column:1/-1;color:var(--muted);margin:0}
.sub small{font-size:13px}
.tbl{background:var(--card);border-radius:16px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.04)}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{color:var(--muted);font-weight:400;font-size:15px;text-align:left;padding:14px 16px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:13px 16px;border-bottom:1px solid var(--line)}
td:first-child{color:var(--muted)}
th:nth-child(1),td:nth-child(1){width:4.5em}
th:last-child,td:last-child{text-align:right}
tr:last-child td{border-bottom:0}
.pos{color:var(--pos)}.neg{color:var(--neg)}
.scrim{position:fixed;inset:0;background:rgba(0,0,0,.25);opacity:0;pointer-events:none;transition:opacity .2s}
.sheet{position:fixed;left:0;right:0;bottom:0;max-width:560px;margin:0 auto;background:var(--sheet);border-radius:22px 22px 0 0;
  padding:10px 20px calc(28px + env(safe-area-inset-bottom));max-height:88vh;overflow:auto;transform:translateY(105%);transition:transform .25s ease;
  box-shadow:0 -4px 24px rgba(0,0,0,.08)}
.open .scrim{opacity:1;pointer-events:auto}.open .sheet{transform:none}
.grip{width:40px;height:5px;border-radius:3px;background:var(--line);margin:0 auto 18px}
.sheet h2{font-size:28px;margin:0 0 20px}
.lbl{font-size:18px;margin:0 0 12px}
.seg{display:grid;grid-template-columns:repeat(3,1fr);background:var(--chip);border-radius:12px;padding:3px;gap:3px}
.seg button{border:0;background:none;color:var(--fg);font:inherit;padding:9px 0;border-radius:10px;cursor:pointer}
.seg button[aria-pressed=true]{background:var(--on);color:#fff;font-weight:500}
.weights{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:18px}
.weights .w{display:flex;gap:8px}
.weights>.t{white-space:nowrap}
.chipin b{font-weight:500}
.chipin{display:flex;align-items:center;gap:8px;background:var(--chip);border-radius:12px;padding:8px 10px}
.chipin span{color:var(--muted);font-size:14px}
.chipin input{width:3ch;border:0;background:none;color:var(--fg);font:inherit;font-weight:500;text-align:right;padding:0}
.chipin input:focus{outline:none}.chipin:focus-within{box-shadow:0 0 0 2px var(--on)}
.opt{display:grid;grid-template-columns:1fr auto;align-items:center;gap:2px 12px;padding:18px 0;border-top:1px solid var(--line)}
.opt:first-of-type{margin-top:18px}
.opt .t{font-size:18px}.opt .d{color:var(--muted);font-size:14px}
.sw{grid-row:1/3;grid-column:2;position:relative;width:51px;height:31px}
.sw input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}
.sw span{position:absolute;inset:0;border-radius:31px;background:var(--line);transition:background .2s;pointer-events:none}
.sw span:after{content:"";position:absolute;top:2px;left:2px;width:27px;height:27px;border-radius:50%;background:var(--knob);
  box-shadow:0 2px 4px rgba(0,0,0,.2);transition:transform .2s}
.sw input:checked+span{background:var(--on)}.sw input:checked+span:after{transform:translateX(20px)}
.sw input:focus-visible+span{outline:2px solid var(--on);outline-offset:2px}
"""

# Mirrors score()/blend_score() above.
JS = """
const $=id=>document.getElementById(id),b=document.body;
const store={get(k,d){try{const v=localStorage.getItem(k);return v===null?d:v}catch(e){return d}},set(k,v){try{localStorage.setItem(k,v)}catch(e){}}};
function score(r,win,skip,vol){
  const x=r.slice(r.length-win,r.length-skip),n=x.length,sum=x.reduce((a,v)=>a+v,0),ann=sum*YEAR/n;
  if(!vol)return ann;
  const m=sum/n,sd=Math.sqrt(x.reduce((a,v)=>a+(v-m)**2,0)/(n-1));
  return ann/(sd*Math.sqrt(YEAR));
}
let mode=store.get("window","12m");if(!["12m","6m","blend"].includes(mode))mode="12m";
let w6=Math.min(100,Math.max(0,parseInt(store.get("w6","50"))||0));
$("skip").checked=store.get("skip21","0")==="1";$("vol").checked=store.get("volAdj","0")==="1";
function apply(){
  const skip=$("skip").checked?SKIP:0,vol=$("vol").checked;
  document.querySelectorAll(".seg button").forEach(x=>x.setAttribute("aria-pressed",x.dataset.w===mode));
  $("weights").hidden=mode!=="blend";$("w6").value=w6;$("w12").value=100-w6;
  $("endpoint").textContent=skip?`Endpoint P[t-${SKIP}] (skip ${SKIP} days).`:"Latest available price used.";
  $("col").innerHTML=vol?"Ann. Return / &sigma;":"Ann. Log Return";
  const f=r=>mode==="blend"?w6/100*score(r,WIN["6m"],skip,vol)+(1-w6/100)*score(r,WIN["12m"],skip,vol):score(r,WIN[mode],skip,vol);
  const ranked=Object.entries(DATA).map(([t,r])=>[t,f(r)]).sort((a,c)=>c[1]-a[1]);
  const fmt=v=>(v>=0?"+":"\\u2212")+(vol?Math.abs(v).toFixed(2):(Math.abs(v)*100).toFixed(1)+"%");
  $("rows").innerHTML=ranked.map(([t,v],i)=>`<tr><td>${i+1}</td><td>${t}</td><td class=${v>=0?"pos":"neg"}>${fmt(v)}</td></tr>`).join("");
}
document.querySelectorAll(".seg button").forEach(x=>x.onclick=()=>{mode=x.dataset.w;store.set("window",mode);apply()});
for(const [id,other] of [["w6",false],["w12",true]])$(id).oninput=e=>{
  const v=parseInt(e.target.value);if(isNaN(v))return;
  const c=Math.min(100,Math.max(0,v));w6=other?100-c:c;store.set("w6",w6);
  $(other?"w6":"w12").value=other?w6:100-w6;apply();
};
for(const [id,k] of [["skip","skip21"],["vol","volAdj"]])$(id).onchange=e=>{store.set(k,e.target.checked?"1":"0");apply()};
apply();
$("gear").onclick=()=>b.classList.add("open");
$("scrim").onclick=()=>b.classList.remove("open");
document.onkeydown=e=>{if(e.key==="Escape")b.classList.remove("open")};
"""


def render_html(returns, as_of):
    n = len(returns)
    data = json.dumps({s: [round(x, 6) for x in r] for s, r in returns.items()}, separators=(",", ":"))
    consts = f"const DATA={data},SKIP={SKIP},YEAR={TRADING_DAYS},WIN={json.dumps(WINDOWS)};"
    return f"""<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Return Ranker</title><style>{CSS}</style></head><body><main>
<header><h1>Return Ranker</h1><button class=gear id=gear aria-label=Settings>{GEAR}</button>
<p class=sub>Top ~{n} S&amp;P 500 by market cap<br><span id=endpoint>Latest available price used.</span><br><small>As of {as_of}</small></p></header>
<div class=tbl><table><thead><tr><th>Rank</th><th>Ticker</th><th id=col>Ann. Log Return</th></tr></thead><tbody id=rows></tbody></table></div></main>
<div class=scrim id=scrim></div>
<section class=sheet role=dialog aria-label=Settings><div class=grip></div><h2>Settings</h2>
<p class=lbl>Return window</p>
<div class=seg role=group aria-label="Return window"><button data-w=12m>12M</button><button data-w=6m>6M</button><button data-w=blend>Blend</button></div>
<div class=weights id=weights><span class=t>Blend weights</span><div class=w>
<label class=chipin><span>6M</span><b><input id=w6 inputmode=numeric maxlength=3 aria-label="6M weight">%</b></label>
<label class=chipin><span>12M</span><b><input id=w12 inputmode=numeric maxlength=3 aria-label="12M weight">%</b></label></div></div>
<label class=opt><span class=t>Skip {SKIP} trading days</span><span class=sw><input type=checkbox id=skip><span></span></span>
<span class=d>Use P[t-{SKIP}] as endpoint.</span></label>
<label class=opt><span class=t>Volatility adjust</span><span class=sw><input type=checkbox id=vol><span></span></span>
<span class=d>Divide by sigma over the same window.</span></label></section>
<script>{consts}{JS}</script></body></html>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=100)
    ap.add_argument("--window", choices=[*WINDOWS, "blend"], default="12m", help="lookback window")
    ap.add_argument("--w6", type=float, default=0.5, help="6M weight for --window blend (12M gets 1 - w6)")
    ap.add_argument("--skip", action="store_true", help=f"skip the last {SKIP} sessions")
    ap.add_argument("--vol", action="store_true", help="divide by annualized std dev of daily log returns (same window)")
    ap.add_argument("--html", metavar="PATH", help="also write the ranking as a static HTML page")
    args = ap.parse_args()
    if not os.environ.get("FMP_API_KEY"):
        sys.exit("FMP_API_KEY is not set")

    returns = load_returns(args.top)
    ranked = rank(returns, args.window, args.w6, SKIP if args.skip else 0, args.vol)
    print(f"{'Rank':>4}  {'Ticker':<6}  {'score':>10}")
    for i, (s, r) in enumerate(ranked, 1):
        print(f"{i:>4}  {s:<6}  {r:>10.4f}")
    if args.html:
        as_of = datetime.now(NY).strftime("%b %-d, %Y %-I:%M %p %Z")
        Path(args.html).write_text(render_html(returns, as_of))


if __name__ == "__main__":
    main()
