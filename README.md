# ttttt

Rank S&P 500 stocks (filtered by market-cap bucket) by annualized log return.

    R_12m = ln(P_now / P_252)

- `P_now` — latest FMP quote price
- `P_252` — split-adjusted close 252 trading sessions before the `P_now` session

## Run

    FMP_API_KEY=... python3 momentum.py [--caps mega,large,mid,small]

Python 3.9+, stdlib only. Output: Rank, Ticker, 12m log return.

- Returns are summed daily log returns. `P_now` is the live quote, so it is intraday while the market is open.
- `--window 6m` uses the last 126 sessions instead of 252, annualized (× 252/126, or × 252/105 with skip).
- `--window blend --w6 0.5` blends (the page's Blend with both 6M and 12M selected is 50/50) the two annualized scores: w6·score₆ₘ + (1 − w6)·score₁₂ₘ.
- `--z` shows cross-sectional z-scores over the ranked stocks. With a blend, each window is z-scored first, then averaged.
  Z-score pipeline per window: raw return → VolAdj → winsorize (1st/99th pct across stocks) → z-score → combine horizons.
  On the page, tap the value column header to sort (desc, asc, off) and long-press it for a Raw / Z-score / Percentile (100% = top) / Rank menu.
- `--r2` multiplies each window's score by the R² of a straight-line fit to its log price over that window
  (Settings → × R²). Blends apply it per window before combining.
- `--vol` uses VolAdj(W) = Σr / (SD(r)·√N) on the exact window's N daily log returns, numerator and denominator on the same observations (a same-window Sharpe-like ratio, no annualization). Settings → Volatility on the page.
- `--skip` excludes the most recent 21 sessions and annualizes the 231-day window: ln(P_21 / P_252) × 252/231. On the web page this is the Settings toggle.
- `--index 500,400` picks the S&P 500 (FMP constituents), the S&P MidCap 400 (parsed from Wikipedia's list, cached daily in `data/sp400.json`) or both; the page's Settings → Index does the same (multi-select).
- `--caps mega,large` limits the universe to market-cap buckets: Mega ≥ $200B, Large $10–200B, Mid $2–10B, Small < $2B.
  On the page these are the Universe buttons (multi-select). A bucket may be empty (the S&P 500 rarely has Small caps).
- `--html PATH` writes the page. It embeds each ticker's recent prices for all ~500 constituents and scores/ranks in the browser, so the Settings toggles re-rank instantly. Divider lines labelled P95/P75/P50/P25/P5 mark the percentile cut-offs of the current ranking, and value text is coloured by percentile (green → neutral → red). Settings → Appearance switches Auto/Light/Dark. When a setting changes the ranking, moved rows briefly show ▲n/▼n next to the ticker. A bottom tab bar switches between Rank (the list) and Lab, an experimentation view; Lab shows, for every name above P95, a heatmap of the running cumulative log return over 1M (daily) / 3M / 6M / 1Y (weekly columns) and a correlation-cluster matrix (Pearson ρ of daily log returns over 1M/3M/6M/1Y, distance 1−ρ, average-linkage clustering, rows in optimal leaf order, with the dendrogram). Tap a row for a per-ticker view: company, sector · industry, price, day change, and a 1D (5-min bars) / 1W / 1M / 3M / 6M / 1Y chart. Settings → Today adds a column with each stock's latest price change vs the prior close; tap its header to sort, long-press to switch to the 5-trading-day log return (5D).

## Web page

https://vandyckmed-droid.github.io/ttttt/ — rebuilt by `.github/workflows/refresh.yml` every 15 min during
US market hours and daily after close (the ↻ button pulls the newest build in place). Paste your own FMP key under Settings → Live quotes and ↻ also overlays live quotes for all tickers and live 5-minute bars for the open chart; the key is kept only in that browser's localStorage, never in the page or repo. Requires the repo secret `FMP_API_KEY`. Daily closes are fetched once per New York day (cached in
`data/history`, and by `actions/cache` in the workflow); intraday runs only fetch batch quotes.

An optional `basket.json` next to the script (`{"asOf": "...", "rows": [[ticker, weight%], ...]}`) is shown on the Lab tab with each name's current rank; it holds tickers and weights only. The names with data are also drawn as a treemap: tile size is the weight share or the risk share (weight × trailing‑1Y daily σ); tile colour is the score, the rank change over the last 21 sessions, the mean correlation with the rest of the basket (relative to the basket average), or the share of basket variance the name contributes against its weight. Published series carry 21 extra sessions (`LAG`) so the page can re-rank as of 21 sessions ago.

### Peer groups and residual pullback

`SECTOR_ALIAS` folds the GICS sector names used by the S&P 400 list into FMP's, giving 11 sectors. `PEER_GROUPS` is a static map from every FMP/GICS industry string to one of 37 peer groups, each with a fixed parent sector (a few industries are re-parented: homebuilders and A&D to Industrials, packaging to Basic Materials, solar to Utilities). An unmapped industry falls back to its sector and is listed by `taxonomy_report()`, which the build prints to stderr. The page carries each name's sector and group.

`residual_pullback()` (mirrored in the page; `--pullback` prints it) computes, per name in the current pool with at least 147 daily returns: ε_t = r_t − leave-one-out mean of its peer group's daily log returns (the group needs ≥ 5 other eligible names in the pool, else the sector; no benchmark if the sector has no other name); Resid21 = Σ ε over the last 21 sessions; σ = SD(ε) over the 126 sessions before that; pullback = −Resid21 / (σ√21). +2 is an unusually large stock-specific fall, −2 an unusually strong relative run-up. Raw and benchmark 21-session returns, σ, the benchmark used and the cross-sectional rank are kept alongside the result. The treemap's Resid colour is the negative of the pullback (green = beat peers) saturating at ±2.

## Ledger prototype (`--ledger PATH`, published as `ledger.html`)

Stage 1 of the "Analytical Ledger" direction: the Rank screen only, built from the same payload and sharing the same stored settings as the main page. Warm paper / night ground, hairlines, no cards, IBM Plex Sans with tabular numerals. Each row is the score rank (fixed under any sort), the ticker (tinted when in the basket), the score with a **score rail** beneath it, and one swappable metric column (ΔRank, Today, 5D, 6M, 12M, VolAdj, R², Resid). The rail is a score axis from P5 (left) to P95 (right); the P25/P50/P75 cuts are reference ticks; a name beyond either end shows an outward cap instead of a marker; in a 6M+12M blend a short tick (6M) and a tall tick (12M) joined by a hairline sit on the rail with the blend as the dot. Full-width cut lines (P95 … P5) appear only while the list is in score order; sorting by the metric column withdraws them. A settings line of tappable tokens replaces the sheet.

## Data (written to `data/`, git-ignored)

- `universe.json` — S&P 500 constituents (`/stable/sp500-constituent`) ranked by market cap from `/stable/batch-quote`, top N kept
- `history/<SYM>.csv` — daily closes from `/stable/historical-price-eod/light` (~420 calendar days)
- `quotes.json` — latest quote per symbol (`/stable/batch-quote`), stored separately from history
