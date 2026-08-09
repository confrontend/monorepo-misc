# Seeking Alpha Quant Rating pipeline — reusable analysis

Everything from the chat analysis, consolidated into one script. Tested
end-to-end against the original dataset and reproduces every number
(t-stats, concentration breakdown, placebo p-value) exactly.

## Files

- `spy_series_2023-07-31_2026-08-03.csv` — the validated SPY daily series,
  built once via the equation-solving reconstruction + real-price anchor,
  cross-checked against 11 independent real closes (exact match). This is
  the expensive/fragile part — **you should not need to rebuild it** unless
  you extend the date range past 2023-07-31–2026-08-03.
- `pipeline.py` — the library: data loading, rating timeline, persistence
  screens, cluster-robust wild bootstrap-t, Holm/BH correction, concentration
  check, placebo test.
- `run_analysis.py` — CLI that runs the full grid and writes a report.

## Wiring it into `seekingalpha/backtest/input/3-year/single`

Point `--input` at that folder (or the specific file inside it). The loader
auto-scans for `.sqlite`/`.db` files with `historical_prices` and
`ticker_changes` tables and merges however many it finds — so to add more
data, just drop another file into that folder. Nothing in the code needs
to change for more tickers or more history, as long as:

- `historical_prices` has columns `ticker_slug, as_of_date, close, div_adj_factor`
- `ticker_changes` has columns `ticker_slug, created_at, new_rating, sector_display`
  (previous_rating isn't required by this pipeline — direction/magnitude
  cuts from the earlier episode-CSV analysis aren't part of this grid,
  see "Extending" below if you want those back in)

If your new "single" file uses a different schema (e.g. it's a CSV, not
sqlite, or different column names), the fix is entirely inside
`load_price_and_rating_data()` in `pipeline.py` — everything downstream
(timeline, screens, stats) is schema-agnostic once it gets a `prices`
DataFrame (`ticker, as_of_date, adj_close`) and a `changes` DataFrame
(`ticker, created_at, new_rating`). Send me the file if you want this
wired up exactly rather than guessed at.

## Running it

```bash
cd seekingalpha/backtest
python run_analysis.py \
  --input input/3-year/single \
  --spy path/to/spy_series_2023-07-31_2026-08-03.csv \
  --out report/
```

Takes ~25 seconds end-to-end on the current dataset (182 tickers, 135k
price rows). Outputs:

- `report/full_results.csv` — every cut in the grid, Holm/BH-corrected,
  flagged `testable` (≥15 clusters) and `discovered_rule` (t≥3 AND
  Holm p<0.05 — nothing has cleared this bar yet on this data).
- `report/top_candidate_concentration.csv` — for whichever cut has the
  strongest t-stat, how much of its mean comes from the top 1/2/3/5/8
  trades. This is what caught the "5 stocks are carrying 33 trades" issue.
- `report/top_candidate_placebo.csv` — random-ticker-same-dates control,
  to separate "the rating picked well" from "this universe/period was hot."

## Extending the grid

Edit the constants at the top of `pipeline.py`:

```python
LOOKBACKS_TD = {'3mo': 63, '6mo': 126, '12mo': 252, '18mo': 378}
HOLDS_TD     = {'6mo': 126, '12mo': 252, '18mo': 378}
FLOORS       = {'bullish_plus': ..., 'very_bullish_only': ...}
DIP_TOLS     = {'0pct_strict': 0.0, '1pct_dip': 0.01}
MIN_CLUSTERS = 15
DISCOVERY_T  = 3.0
```

Add a new lookback, hold, floor, or dip-tolerance value and it's
automatically included in both the grid run and the Holm/BH correction —
that's the point of keeping the grid centralized instead of writing one-off
cuts. Anything you add makes the correction slightly more conservative for
everything else, which is correct: it's one growing family of tests, not
several independent ones.

## Extending the date range past 2026-08-03 (or before 2023-07-31)

The cached SPY CSV only covers that window. To extend it: rebuild the
equation-solving reconstruction (episode-level start/end/spy_ret triples →
log-linear system → least squares) over the new range, anchor it to one
real known SPY close, and append to the CSV. This only needs redoing when
the *date range* changes, not when you add more tickers or more rating
history within the existing range.

## Things this does NOT do (by design, matching the chat's methodology)

- Does not test the tier/direction/sector cuts from the original episode-CSV
  analysis (win rate by rating tier, 1/2/3-tier upgrade/downgrade, sector
  splits) — those used the episode dataset directly rather than fixed-horizon
  persistence screens. Straightforward to add as another function in
  `pipeline.py` following the same pattern if you want one script that
  covers both families.
- Does not round up anything below the `DISCOVERY_T`/`ALPHA` bar, regardless
  of how good the mean looks. Check `top_candidate_concentration.csv` before
  trusting any cut's mean — it exists specifically to catch outlier-driven
  results.
