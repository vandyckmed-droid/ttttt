# ttttt

Minimal prototype: rank the ~100 largest S&P 500 stocks by raw 12-month log return.

    R_12m = ln(P_now / P_252)

- `P_now` — latest FMP quote price
- `P_252` — split-adjusted close 252 trading sessions before the `P_now` session

## Run

    FMP_API_KEY=... python3 momentum.py [--top 100]

Python 3.9+, stdlib only. Output: Rank, Ticker, 12m log return.

## Data (written to `data/`, git-ignored)

- `universe.json` — S&P 500 constituents (`/stable/sp500-constituent`) ranked by market cap from `/stable/batch-quote`, top N kept
- `history/<SYM>.csv` — daily closes from `/stable/historical-price-eod/light` (~420 calendar days)
- `quotes.json` — latest quote per symbol (`/stable/batch-quote`), stored separately from history
