# ttttt

Rank S&P 500 stocks (any market-cap rank range) by annualized log return.

    R_12m = ln(P_now / P_252)

- `P_now` — latest FMP quote price
- `P_252` — split-adjusted close 252 trading sessions before the `P_now` session

## Run

    FMP_API_KEY=... python3 momentum.py [--range 1-100]

Python 3.9+, stdlib only. Output: Rank, Ticker, 12m log return.

- Returns are summed daily log returns. `P_now` is the live quote, so it is intraday while the market is open.
- `--window 6m` uses the last 126 sessions instead of 252, annualized (× 252/126, or × 252/105 with skip).
- `--window blend --w6 0.5` blends the two annualized scores: w6·score₆ₘ + (1 − w6)·score₁₂ₘ.
- `--vol` divides by the annualized sample std dev (× √252) of the same daily log returns (Settings toggle on the page).
- `--skip` excludes the most recent 21 sessions and annualizes the 231-day window: ln(P_21 / P_252) × 252/231. On the web page this is the Settings toggle.
- `--range 1-100` picks market-cap ranks to rank (1 = largest); on the page this is the Universe slider.
- `--html PATH` writes the page. It embeds each ticker's recent prices for all ~500 constituents and scores/ranks in the browser, so the Settings toggles re-rank instantly.

## Web page

https://vandyckmed-droid.github.io/ttttt/ — rebuilt by `.github/workflows/refresh.yml` every 15 min during
US market hours and daily after close. Requires the repo secret `FMP_API_KEY`. Daily closes are fetched once per New York day (cached in
`data/history`, and by `actions/cache` in the workflow); intraday runs only fetch batch quotes.

## Data (written to `data/`, git-ignored)

- `universe.json` — S&P 500 constituents (`/stable/sp500-constituent`) ranked by market cap from `/stable/batch-quote`, top N kept
- `history/<SYM>.csv` — daily closes from `/stable/historical-price-eod/light` (~420 calendar days)
- `quotes.json` — latest quote per symbol (`/stable/batch-quote`), stored separately from history
