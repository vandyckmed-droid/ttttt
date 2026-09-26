#!/usr/bin/env python3
"""Maintenance tool: (re)build the app's data bundle. Run by hand, never on a schedule.

    FMP_API_KEY=... python3 tools/build_data.py universe   # data/universe.json
    FMP_API_KEY=... python3 tools/build_data.py history    # data/history.json (seed)
    FMP_API_KEY=... python3 tools/build_data.py all

universe: S&P 500 constituents (FMP) plus S&P MidCap 400 (Wikipedia list), each
          resolved through tools/taxonomy.py to a sector and peer group.
history:  ~3 years of daily closes per ticker, aligned to one session calendar,
          stored compactly (integer cents, delta-coded). The app extends this
          seed incrementally in the browser when the user presses Refresh.

Raw per-symbol downloads are cached in .cache/history/ so a re-encode does not
re-download. Python 3.9+, standard library only.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from html.parser import HTMLParser
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).parent))
from taxonomy import classify  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = ROOT / ".cache" / "history"
BASE = "https://financialmodelingprep.com/stable"
SP400_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_400_companies"
NY = ZoneInfo("America/New_York")
HISTORY_DAYS = 3 * 365 + 40      # enough calendar days for ~780 sessions
MIN_SESSION_COVERAGE = 0.5      # a date is a session if at least half the tickers traded


def fmp(endpoint, **params):
    params["apikey"] = os.environ["FMP_API_KEY"]
    url = f"{BASE}/{endpoint}?{urllib.parse.urlencode(params)}"
    for attempt in range(6):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 5:
                raise
            time.sleep(10 * (attempt + 1))
        except (urllib.error.URLError, TimeoutError):
            if attempt == 5:
                raise
            time.sleep(3 * (attempt + 1))


# ---- universe ---------------------------------------------------------------

class WikiTables(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tables, self.table, self.row, self.cell = [], None, None, None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "table":
            self.table = {"id": attrs.get("id", ""), "rows": []}
        elif tag == "tr" and self.table is not None:
            self.row = []
        elif tag in ("td", "th") and self.row is not None:
            self.cell = ""

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.cell is not None:
            self.row.append(self.cell.strip())
            self.cell = None
        elif tag == "tr" and self.row is not None:
            self.table["rows"].append(self.row)
            self.row = None
        elif tag == "table" and self.table is not None:
            self.tables.append(self.table)
            self.table = None

    def handle_data(self, data):
        if self.cell is not None:
            self.cell += data


def load_sp400():
    """[{symbol, name, sector, industry}] from Wikipedia's S&P 400 constituents table."""
    req = urllib.request.Request(SP400_URL, headers={"User-Agent": "sp900-momentum/1.0 (github.com/vandyckmed-droid/ttttt)"})
    with urllib.request.urlopen(req, timeout=30) as r:
        html = r.read().decode("utf-8")
    parser = WikiTables()
    parser.feed(html)
    table = next(t for t in parser.tables if t["id"] == "constituents")
    head = [h.lower() for h in table["rows"][0]]
    col = {k: next(i for i, h in enumerate(head) if k in h) for k in ("symbol", "security", "sector", "sub-industry")}
    rows = [{"symbol": r[col["symbol"]].replace(".", "-"), "name": r[col["security"]], "sector": r[col["sector"]],
             "industry": r[col["sub-industry"]]} for r in table["rows"][1:] if len(r) > max(col.values())]
    if len(rows) < 350:
        raise ValueError(f"only {len(rows)} S&P 400 rows parsed")
    return rows


def build_universe():
    stocks = {}
    for c in fmp("sp500-constituent"):
        stocks[c["symbol"]] = {"name": c.get("name", ""), "sector": c.get("sector", ""), "industry": c.get("subSector", ""), "index": "500"}
    for c in load_sp400():
        stocks.setdefault(c["symbol"], {"name": c["name"], "sector": c["sector"], "industry": c["industry"], "index": "400"})
    out, unmapped, by_group = [], Counter(), Counter()
    for sym in sorted(stocks):
        m = stocks[sym]
        group, sector = classify(m["sector"], m["industry"], sym)
        if not sector:
            raise ValueError(f"{sym}: no sector")
        if group:
            by_group[(sector, group)] += 1
        else:
            unmapped[(sector, m["industry"])] += 1
        out.append({"t": sym, "n": m["name"], "i": m["index"], "s": sector, "g": group})
    DATA.mkdir(exist_ok=True)
    (DATA / "universe.json").write_text(json.dumps({"asOf": date.today().isoformat(), "stocks": out}, separators=(",", ":")) + "\n")
    n500 = sum(1 for s in out if s["i"] == "500")
    print(f"universe: {len(out)} stocks ({n500} S&P 500, {len(out) - n500} S&P 400), "
          f"{len({s['s'] for s in out})} sectors, {len(by_group)} groups, {sum(unmapped.values())} unmapped", file=sys.stderr)
    for (sec, g), n in sorted(by_group.items()):
        print(f"  {n:4d}  {sec} / {g}", file=sys.stderr)
    for (sec, ind), n in sorted(unmapped.items()):
        print(f"  {n:4d}  {sec} / {ind}  (no group: falls back to sector)", file=sys.stderr)
    return out


# ---- history ----------------------------------------------------------------

def fetch_history(symbol, start):
    """{date: close} for one symbol from `start`, cached on disk."""
    path = CACHE / f"{symbol}.json"
    if path.exists():
        return json.loads(path.read_text())
    rows = fmp("historical-price-eod/light", symbol=symbol, **{"from": start})
    out = {r["date"]: r["price"] for r in rows if r.get("price")}
    path.write_text(json.dumps(out))
    return out


def encode(closes, dates):
    """Delta-coded integer cents aligned to `dates`; null marks a missing session.
    [first_cents, d1, d2, ...]: each d is the change in cents from the previous
    *available* close, so a null does not break the chain."""
    out, prev = [], None
    for d in dates:
        c = closes.get(d)
        if c is None:
            out.append(None)
            continue
        cents = round(c * 100)
        out.append(cents if prev is None else cents - prev)
        prev = cents
    return out


def build_history():
    stocks = json.loads((DATA / "universe.json").read_text())["stocks"]
    symbols = [s["t"] for s in stocks]
    CACHE.mkdir(parents=True, exist_ok=True)
    start = (datetime.now(NY).date() - timedelta(days=HISTORY_DAYS)).isoformat()
    done, failed, hist = 0, [], {}

    def one(sym):
        try:
            return sym, fetch_history(sym, start)
        except Exception as e:  # keep the rest of the universe
            return sym, e

    with ThreadPoolExecutor(max_workers=5) as ex:
        for sym, res in ex.map(one, symbols):
            done += 1
            if isinstance(res, Exception):
                failed.append((sym, str(res)))
            else:
                hist[sym] = res
            if done % 100 == 0:
                print(f"  history {done}/{len(symbols)}", file=sys.stderr)
    for sym, err in failed:
        print(f"  failed {sym}: {err}", file=sys.stderr)

    # Session calendar: dates on which at least half the universe has a close.
    count = Counter(d for h in hist.values() for d in h)
    dates = sorted(d for d, n in count.items() if n >= MIN_SESSION_COVERAGE * len(hist))
    px = {sym: encode(h, dates) for sym, h in hist.items()}
    missing = {sym: sum(v is None for v in p) for sym, p in px.items()}
    short = {sym: n for sym, n in missing.items() if n > 0}
    bundle = {"asOf": dates[-1], "dates": dates, "px": px}
    (DATA / "history.json").write_text(json.dumps(bundle, separators=(",", ":")) + "\n")
    size = (DATA / "history.json").stat().st_size
    print(f"history: {len(px)} tickers, {len(dates)} sessions {dates[0]}..{dates[-1]}, {size / 1e6:.1f} MB; "
          f"{len(short)} tickers with gaps (worst {max(short.values()) if short else 0} sessions); {len(failed)} failed", file=sys.stderr)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    if not os.environ.get("FMP_API_KEY"):
        sys.exit("FMP_API_KEY is not set")
    if cmd in ("universe", "all"):
        build_universe()
    if cmd in ("history", "all"):
        build_history()
    if cmd not in ("universe", "history", "all"):
        sys.exit(__doc__)
