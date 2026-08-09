# Seeking Alpha Quant Rating pipeline — reusable analysis

Everything from the chat analysis, consolidated into one script. Tested
end-to-end against the original dataset and reproduces every number
(t-stats, concentration breakdown, placebo p-value) exactly.

## Files

- `spy_series_2023-07-31_2026-08-03.csv` — **superseded, kept for reference.**
  The reconstructed SPY series, built via the equation-solving reconstruction
  plus a real-price anchor. Real Yahoo adjusted closes for exactly the same
  window turned out to already be on disk (`benchmark/SPY.json`, now imported
  into `benchmark_prices`), and the two disagree on 15 of 755 days — by up to
  5.95% on 2025-04-08, with the rest under 1.2%. The pipeline now reads the
  real series from the database by default. The original 11-close spot check
  was consistent with this: 740 of 755 days match to eight decimal places, so
  the reconstruction is right almost everywhere and wrong in a few
  poorly-constrained spots.
- `pipeline.py` — the library: data loading, rating timeline, stock bullish
  persistence screens, bearish transition/persistence screens, ETF rating-trust and persistence screens, cluster-robust
  wild bootstrap-t, Holm/BH correction, concentration checks, and placebo tests.
- `BEARISH_PRESPEC.md` — the frozen bearish methodology and interpretation limits.
- `ETF_PRESPEC.md` — the frozen ETF rating-vs-SPY and persistence-vs-bullish-pool methodology.
- `test_bearish_pipeline.py` — focused tests for transition detection, persistence,
  next-session entry, complete horizons, and universe-end auditing.
- `test_etf_pipeline.py` — focused tests for ETF transitions, calendar persistence,
  next-session entry, bounded exits, and complete horizons.
- `run_analysis.py` — CLI that runs all five research families and writes their reports.

## Wiring it into `seekingalpha/backtest/input/3-year`

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

The folder as it actually exists holds **raw API dumps** (`raw_*.json`) and
sometimes derived CSV exports, so `load_price_and_rating_data()` reads three
shapes and merges whatever it finds.

**Raw JSON dump** (the durable one — read this by preference). A list of
capture records, each `{_slug, _kind: "prices" | "changes", body: {data: [...]}}`
exactly as returned by the API. Price attributes supply `close`,
`div_adj_factor`, `as_of_date`; change attributes supply `createdAt`,
`newRating`, optionally `sectorDisplay`. Verified to reproduce the derived
CSVs exactly (same 166,933 price rows / 223 tickers / 6,999 rating events,
same grid results), so it is safe to keep only the JSON.

**Flat CSV exports**, if present:

- a **prices** CSV — `slug` (or `ticker_slug`), `as_of_date`, `close`,
  `div_adj_factor`
- a **changes** CSV — `slug` (or `ticker_slug`), `createdAt` (or
  `created_at`), `newRating` (or `new_rating`), and optionally
  `sectorDisplay`/`sector_display`

Files are recognised by their contents, not their names, so the timestamped
export filenames don't need to follow any convention; extra columns are
ignored. All three paths produce identical frames, so everything downstream
(timeline, screens, stats) is unchanged either way, and you can mix them in
one folder — duplicate ticker/date rows are dropped on merge.

If a file in the folder can't be used, the run says which file and why
rather than failing with a bare "no data found".

If a future export uses some third schema, the fix is still entirely inside
`load_price_and_rating_data()` / `_read_csv_export()` — downstream code only
ever sees a `prices` DataFrame (`ticker, as_of_date, adj_close`) and a
`changes` DataFrame (`ticker, created_at, new_rating`).

## Running it

**Normally you don't.** Open the app (`npm run dev`), go to Persistence screens,
and press **Run analysis**. The server spawns this script, tracks it as a job,
and reloads the page when it finishes. Both `--input` and `--spy` default to the
app's database, `.data/vantage.sqlite`, which the Data tab's Import button fills.
On Windows, the button first uses `.venv/Scripts/python.exe` when present, otherwise it launches
the workspace `.venv/bin/python` through WSL. This avoids the Microsoft Store `python` alias and
keeps the UI run on the same pandas/numpy environment used by development.

The command line still works, for debugging or for running against files that
haven't been imported:

```bash
cd seekingalpha/backtest/research
python run_analysis.py --out report/                    # uses the app database
python run_analysis.py --input ../input/3-year \
  --spy spy_series_2023-07-31_2026-08-03.csv --out report/   # or raw files
```

The run is intentionally slower than the original bullish-only script because it now includes 60
corrected bearish tests, 30 corrected ETF tests, and their diagnostics. Outputs:

- `report/full_results.csv` — every cut in the grid, Holm/BH-corrected,
  flagged `testable` (≥15 clusters) and `discovered_rule` (t≥3 AND
  Holm p<0.05 — nothing has cleared this bar yet on this data).
- `report/top_candidate_concentration.csv` — for whichever cut has the
  strongest t-stat, how much of its mean comes from the top 1/2/3/5/8
  trades. This is what caught the "5 stocks are carrying 33 trades" issue.
- `report/top_candidate_placebo.csv` — random-ticker-same-dates control,
  to separate "the rating picked well" from "this universe/period was hot."
- `report/run_meta.json` — the thresholds and grid this run actually used
  (read straight off the constants below), plus dataset counts and the top
  candidate. The dashboard reads its pass/fail bar from here rather than
  hardcoding a second copy, so the displayed bar can never describe a
  different run than the displayed results.
- `report/bearish_transition_results.csv` — 12 transition tests: two signals,
  three calendar-day holds, and raw/hedged short outcomes.
- `report/bearish_persistence_results.csv` — 48 strict-persistence tests: two
  signals, four lookbacks, three holds, and two outcomes.
- `report/bearish_*_concentration.csv` and `report/bearish_*_placebo.csv` —
  diagnostics on the strongest testable cell in each bearish family.
- `report/bearish_meta.json` — frozen execution rules, correction scopes,
  family summaries, top candidates, and the universe end-date audit.
- `report/etf_rating_trust_results.csv` — six tests of newly bullish ETF ratings versus SPY.
- `report/etf_persistence_results.csv` — 24 tests of persistence-qualified ETFs versus a matching
  bullish ETF pool.
- `report/etf_*_concentration.csv` and `report/etf_*_placebo.csv` — strongest-cell diagnostics for
  each ETF family.
- `report/etf_meta.json` — frozen ETF execution rules, separate correction scopes, summaries, top
  candidates, ten chronological examples from the strongest rating-trust cell, data bounds, and
  interpretation metadata.

## Where this shows up in the app

The React app's **Research lab** renders all five report families. It is
served by `/api/research` in `vite.config.ts`, which re-reads
`research/report/` on every request — so re-running the command above and
refreshing the browser is enough to update the page. No rebuild, no server
restart, no code change, including when the grid or the thresholds change.

If `report/` is missing the tab says so and prints the command to run.

## ETF families

Read `ETF_PRESPEC.md` before changing these families. The primary ETF question is whether newly
bullish-rated ETFs beat SPY over matched 30/90/180-day windows. The secondary question is whether
waiting for 30/60/90/180 days of continuous bullish persistence adds value over other ETFs with the
same bullish rating. They are separate six-cell and 24-cell Holm/BH families. Both use the final
365 days, next-observed-session entry, the closest complete exit within seven days of the calendar
target, at least 15 ETF clusters, and 4,999 wild cluster bootstrap-t repetitions. ETF Discovery in
the React app remains exploratory; these Python reports are the formal corrected evidence.

## Bearish families

The bearish analysis is separate from the older bullish grid. Read
`BEARISH_PRESPEC.md` before changing it. In short:

- Transition means newly crossing into Sell/Strong Sell; it has no lookback.
- Persistence means remaining strictly bearish for 3/6/12/18 months.
- Both enter on the next available session and exit after a complete
  30/90/180 calendar-day horizon.
- Incomplete right-edge trades are dropped, never shortened.
- Raw short return asks whether the stock fell. SPY-hedged short return asks
  whether it lagged SPY. These can disagree.
- The 12 transition tests are one Holm family; the 48 persistence tests are a
  second Holm family. Neither changes the bullish family.
- Thin cells stay in that declared family as `p=1` for correction purposes,
  but their own p-values remain blank and they remain untestable.
- Results are gross and survivor-only. The report audits series end dates but
  cannot reconstruct delisted companies absent from the export.

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
