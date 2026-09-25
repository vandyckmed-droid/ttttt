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
  On the page, tap the value column header to sort (desc, asc, off) and long-press it for a Raw / Z-score / Percentile (100% = top) / Rank menu.
- `--r2` multiplies each window's score by the R² of a straight-line fit to its log price over that window
  (Settings → × R²). Blends apply it per window before combining.
- `--vol` divides by the annualized sample std dev (× √252) of the same daily log returns (Settings toggle on the page).
- `--skip` excludes the most recent 21 sessions and annualizes the 231-day window: ln(P_21 / P_252) × 252/231. On the web page this is the Settings toggle.
- `--caps mega,large` limits the universe to market-cap buckets: Mega ≥ $200B, Large $10–200B, Mid $2–10B, Small < $2B.
  On the page these are the Universe buttons (multi-select). A bucket may be empty (the S&P 500 rarely has Small caps).
- `--html PATH` writes the page. It embeds each ticker's recent prices for all ~500 constituents and scores/ranks in the browser, so the Settings toggles re-rank instantly. Divider lines labelled P95/P75/P50/P25/P5 mark the percentile cut-offs of the current ranking, and value text is coloured by percentile (green → neutral → red). Settings → Appearance switches Auto/Light/Dark. When a setting changes the ranking, moved rows briefly show ▲n/▼n next to the ticker. A bottom tab bar switches between Rank (the list) and Lab, an experimentation view; Lab currently shows a heatmap of the running 21-session cumulative log return for every name above P95. Tap a row for a per-ticker view: company, sector · industry, price, day change, and a 1D (5-min bars) / 1W / 1M / 3M / 6M / 1Y chart. Settings → Today adds a column with each stock's latest price change vs the prior close; tap its header to sort, long-press to switch to the 5-trading-day log return (5D).

## Web page

https://vandyckmed-droid.github.io/ttttt/ — rebuilt by `.github/workflows/refresh.yml` every 15 min during
US market hours and daily after close (the ↻ button pulls the newest build in place). Paste your own FMP key under Settings → Live quotes and ↻ also overlays live quotes for all tickers and live 5-minute bars for the open chart; the key is kept only in that browser's localStorage, never in the page or repo. Requires the repo secret `FMP_API_KEY`. Daily closes are fetched once per New York day (cached in
`data/history`, and by `actions/cache` in the workflow); intraday runs only fetch batch quotes.

## Data (written to `data/`, git-ignored)

- `universe.json` — S&P 500 constituents (`/stable/sp500-constituent`) ranked by market cap from `/stable/batch-quote`, top N kept
- `history/<SYM>.csv` — daily closes from `/stable/historical-price-eod/light` (~420 calendar days)
- `quotes.json` — latest quote per symbol (`/stable/batch-quote`), stored separately from history
