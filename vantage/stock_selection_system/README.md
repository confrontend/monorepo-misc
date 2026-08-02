# Stock-Selection Candidate Validation & Tracking System

A prototype implementation of `context/codex_implementation_prompt.md` and the
frozen spec it references (`context/stock_selection_frozen_spec.md`). This is
a **candidate-validation and forward-tracking system**, not a prediction
model, and it does **not** connect to any brokerage or place trades.

Every candidate that clears eligibility is scored on three separate evidence
groups (Earnings, Market, Context), each -1/0/+1, combining into one of four
labels: **Confirm / Mixed / Reject / Wait**. Decisions are written once as
immutable rows, entry prices and forward outcomes (7/30/90/180 trading days)
are recorded separately as they become knowable, and nothing is ever edited
or deleted after the fact -- corrections are new rows, not edits.

## Setup

```bash
pip install -r requirements.txt
```

Python 3.10+. Uses `pandas_market_calendars` (NYSE calendar, correctly
handles weekends/holidays/exceptional closures) as the single shared
trading-calendar source required by the spec.

## Run the tests

```bash
python -m pytest tests/ -v
```

248 tests, all passing, including:
- The acceptance gate from the implementation prompt: all 27 (earnings,
  market, context) score combinations crossed with red_flag and
  earnings_within_5d (108 cases) map to exactly one label
  (`tests/test_decide_all_combinations.py`).
- Database-level immutability/append-only enforcement, including the
  `reviews.resolved_from_audit_id` uniqueness guard
  (`tests/test_db_schema.py`).
- The missing-data audit flow: one case per episode (not one per missing
  field), partial resolution rejected, duplicate unresolved cases blocked,
  atomic retry resolution (`tests/test_required_inputs.py`).
- Episode-trigger detection processing every pending trigger in one call,
  not just the earliest (`tests/test_episodes.py`).
- Full end-to-end run on synthetic ATI data: score -> decide -> immutable
  review -> entry pricing -> all four outcome horizons
  (`tests/test_pipeline_ati_demo.py`).

## Run the required ATI end-to-end demo

The implementation prompt requires running the full pipeline end-to-end on
ticker ATI first. Since this environment has no live Danelfin/Alpha Vantage
API keys, the demo uses a deterministic, seeded synthetic dataset (a
plausible ATI-like uptrend, a beat-and-raise earnings scenario, one
guidance-raise Context event) instead:

```bash
python cli.py demo-ati --db /tmp/stock_selection.db --as-of 2026-02-02
```

This ingests the synthetic data, detects the `first_eligibility` trigger,
scores all three groups, writes an immutable `reviews` row, records the entry
price, fast-forwards through all four outcome horizons, and prints a
human-readable report.

## Wiring up real data

`src/ingestion/alpha_vantage.py` and `src/ingestion/danelfin.py` are ready to
use once you have API keys:

```bash
export ALPHA_VANTAGE_API_KEY=...
export DANELFIN_API_KEY=...
```

`src/ingestion/base.py` has idempotent upsert helpers (`upsert_candidate`,
`upsert_estimate_snapshot`, `upsert_earnings_history`, `upsert_price_signal`,
`upsert_security_metadata`) that use the schema's UNIQUE constraints so
re-running ingestion for an already-ingested day is a safe no-op/update.
`src/ingestion/manual_events.py` has manual-entry and CSV-import functions for
`guidance_events`, `insider_purchases`, `material_events`, and
`earnings_calendar` (per the spec, these start as manual/CSV entry points).

For a live daily run across a watchlist, call `src.pipeline.run_daily_cycle()`
with your own `PriceDataSource` (see below) from a scheduler.

## Project layout

```
schema.sql                          All tables, UNIQUE constraints, immutability triggers
src/trading_calendar.py             The single shared trading-calendar module (Section 6)
src/scoring.py                      score_earnings, score_market, score_context, decide()
src/required_inputs.py              check_required_inputs(), insufficient-data audit flow
src/episodes.py                     Episode-trigger detection (Section 10), reviews writer
src/price_source.py                 PriceDataSource interface (see "Design decisions" below)
src/jobs/entry_price_job.py         Records entry opens once the session has opened
src/jobs/outcome_tracking_job.py    Records 7/30/90/180-day open-to-close outcomes
src/reports.py                      Human-readable report renderer
src/pipeline.py                     Orchestration (run_daily_cycle, run_ati_demo)
src/ingestion/                      Alpha Vantage / Danelfin clients, manual-event CSV import,
                                     idempotent upserts, synthetic ATI demo seed
tests/                              248 tests covering every module above
cli.py                              init-db / demo-ati / report commands
```

## Design decisions worth knowing about

The frozen spec is detailed but not 100% self-contained; here's where this
implementation had to make a judgment call, each documented in-line where the
decision lives in code:

- **`price_signals` has no `open` column, but entry prices must be opens
  (Section 7).** Rather than bolting an undocumented column onto the frozen
  schema, the entry-price and outcome-tracking jobs pull opens/closes from a
  pluggable `PriceDataSource` at the moment they're needed; `episode_entries`
  and `recommendation_outcomes` (both spec tables) are where those values get
  durably recorded. See `src/price_source.py`.
- **NULL handling in the partial unique index.** SQL treats NULL as distinct
  from every other NULL, so a literal `UNIQUE (ticker, source_candidate_id,
  episode_trigger, eligibility_date) WHERE resolved = FALSE` index would let
  two unresolved cases with a NULL `source_candidate_id` coexist, silently
  defeating the "at most one unresolved case" guarantee. Fixed with
  `COALESCE(source_candidate_id, -1)` in `schema.sql`.
- **"The decision label changes" (Section 10 trigger #4) is circular if
  treated as a routine daily detector** -- you'd need to score a stock to know
  its label changed, but Section 10 says routine re-checks of an unchanged
  stock must not create an episode. Resolved by keeping the other 7 triggers
  as the routine daily detection path (`detect_episode_trigger`) and exposing
  `force_rescore()` as an explicit, operator-invoked action that only creates
  an episode if the freshly computed label actually differs from the last one.
- **Context "required inputs" (missing-data policy).** The spec requires
  confirming guidance/insider/material-event data *coverage* for the window,
  not just checking for the presence of rows (zero rows could mean "no news"
  or "not yet ingested"). `context_ingestion_coverage` (schema.sql) tracks,
  per ticker, the latest date through which ingestion is confirmed complete;
  `mark_context_coverage()` (`src/ingestion/base.py`) must be called after
  every ingestion check, even when it finds nothing, and
  `check_required_inputs()` routes to `insufficient_data_cases` when
  coverage hasn't reached `as_of_date`.
- **Insider-cluster "completion date"** is defined as the date the 2nd
  distinct qualifying insider's purchase lands within the rolling
  5-trading-day window (the earliest point the +1 condition is actually
  observable), not the forced end of a fixed 5-day span. See
  `src/scoring.py:_find_qualifying_insider_cluster`.
- **`decision_timestamp_utc` defaults to `as_of_date` + wall-clock time**, not
  pure wall-clock `now()`, so that backtest/demo runs against a past
  `as_of_date` don't accidentally push entry-price lookups months into the
  future while still preserving the pre-open/post-open distinction that
  matters for `next_market_open_after()`. See `src/episodes.py:_write_review`.

## Fixed after code review

A follow-up review caught six real issues, all fixed:

- **Trigger events could be permanently skipped.** `run_episode()` used to
  process only the earliest pending trigger per call and advance the cursor
  to `as_of_date`; a second trigger landing in the same processing gap would
  never surface again. `reviews` now carries its own `eligibility_date`
  column, the cursor is `MAX(eligibility_date)` across a ticker's episodes,
  and `run_episode()` loops until no trigger remains pending, returning
  `list[str]` instead of `Optional[str]`.
- **Retry resolution wasn't atomic.** Writing the `reviews` row and marking
  the audit case resolved were two separate commits; a crash between them
  could let a later retry create a second `reviews` row for the same case.
  `_write_review()` now takes `commit=False` so `retry_insufficient_data()`
  can commit both writes together, and `reviews.resolved_from_audit_id`
  carries a UNIQUE index as a second line of defense.
- **Context coverage gaps were read as "no news."** See the
  `context_ingestion_coverage` entry above.
- **`score_market()` recomputed `high_volume_breakdown`** instead of
  consuming the value `price_signals` already stores, contrary to the
  implementation prompt. It's now a required parameter, sourced from
  `ResolvedInputs.high_volume_breakdown`.
- **The 200-trading-day check counted raw rows,** which would accept
  non-trading-day rows from a bad upstream feed. It now validates each date
  against `TradingCalendar.is_trading_day()`.
- **Outcome tracking was date-only.** It could record a "closing price"
  mid-session. `run_outcome_tracking_job()` now takes a UTC-aware `now=`
  and, via the new `TradingCalendar.session_close()`, requires the actual
  close timestamp to have passed before treating a same-day exit as resolved.

## Out of scope (per the implementation prompt)

- Brokerage/order execution of any kind -- this system never places trades.
- Paid API tiers -- Alpha Vantage/Danelfin free tiers only; verify field
  availability and rate limits before live use (spec Section 14).
- A second candidate source beyond the primary eligibility source.
- Any manual override for the earnings-window Wait rule.
