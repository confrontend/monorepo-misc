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

## Project progress and agent handoff

Before changing the project, an agent should read [`progress.md`](progress.md).
It is the running handoff log for work that has already happened: recent steps,
files inspected or changed, decisions and their reasons, test results, known
errors, and the next suggested step. This helps an agent continue from the
current state instead of repeating completed investigation.

`progress.md` is append-only. After every meaningful action, add a short entry
with the date/time, action, files, decision, test result, unresolved items, and
next step. Never delete or rewrite earlier entries, and never put API keys,
tokens, passwords, or other secrets in the log.

## Run the tests

```bash
python -m pytest tests/ -v
```

255 tests, all passing, including:
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
- Episode-trigger detection processing every pending trigger in one call
  (not just the earliest), including two distinct trigger events dated on
  the identical calendar day (`tests/test_episodes.py`).
## UI

A small dashboard (React + TypeScript, `ui/`) sits on top of a read/trigger
HTTP API (FastAPI, `api/main.py`) that wraps the existing `src/` modules --
no decision logic lives in either layer. It shows the episode list (with
ticker/decision filters), a detail panel per episode (score breakdown, entry
price, all resolved outcome horizons, the same text report `cli.py report`
prints), and the insufficient-data-cases queue. The browser can trigger
real-data ingestion, candidate discovery, and insufficient-data retries.

A third control, "Live ingestion" (top right), fetches real price/earnings
data for a comma-separated list of tickers -- see "Live ingestion" below. A
second control, "Candidates", is where
candidate discovery lives: "Fetch Danelfin Trade Ideas" discovers eligible
tickers automatically (no tickers to type in, with optional Market/Direction/
Asset type/Min AI score/Result limit filters and a preview table of results),
and "Add manually" is the fallback for a ticker you already know about and
don't want to depend on Danelfin for -- see "Candidate selection" below.

Easiest way to run both together, from `stock_selection_system/ui/`:

```bash
npm install      # first time only
npm run dev:all  # starts the FastAPI backend (:8000) AND the Vite dev server (:5173)
```

`dev:all` (`ui/scripts/dev-all.mjs`) is a small Node script with no extra
dependencies -- it spawns `uvicorn` and `vite` directly, prefixes their
output with `[BE]`/`[FE]`, and stops both on Ctrl+C or if either one dies.
It launches uvicorn with `--app-dir ..`, so it works correctly even though
it's invoked from inside `ui/` rather than `stock_selection_system/`.

Prefer two separate terminals? That still works:

```bash
# Terminal 1 -- API (defaults to stock_selection.db in stock_selection_system/;
# override with STOCK_SELECTION_DB)
uvicorn api.main:app --reload --port 8000

# Terminal 2 -- UI
cd ui && npm run dev
```

Either way, open `http://localhost:5173`. The Vite dev server proxies
`/api/*` to the FastAPI server (`ui/vite.config.ts`), so there's no CORS
setup needed in dev. `npm run build` produces a static `ui/dist/` you can
serve separately if you want a single deployed artifact later.

`api/main.py` is intentionally read-mostly: its POST endpoints call existing
pipeline functions rather than reimplementing anything. Running
`src.pipeline.run_daily_cycle()` against live data from the UI isn't wired
up yet, since that requires a real `PriceDataSource` (see below) -- it's a
natural next endpoint to add once one exists.

When running in development, diagnostic events are also stored in the separate
SQLite database `diagnostics/diagnostics.db`. This is only an operational log,
separate from `stock_selection.db`; it retains 30 days of events and is
gitignored. Console output is unchanged. Query it with, for example:

```sql
SELECT ts, level, logger_name, message, module, function, line, extra_json
FROM diagnostic_events
WHERE level = 'ERROR' AND ts >= '2026-08-02T00:00:00+00:00'
ORDER BY ts;
```

## Wiring up real data

`src/ingestion/alpha_vantage.py` and `src/ingestion/danelfin.py` are ready to
use once you have API keys. Create a local `.env` file and fill in your keys:

```bash
touch .env
# then edit .env:
#   ALPHA_VANTAGE_API_KEY=...
#   DANELFIN_API_KEY=...
#   EODHD_API_KEY=...
```

The clients call `load_dotenv()` on import, so `.env` is picked up
automatically. `.env` is gitignored and must never be committed.

## Proposed position monitoring and sell-candidate alerts

The initial Danelfin suggestion and validation are not the end of the
workflow. Once a validated episode leads to a human purchase, the position
must continue to be monitored. A later disappearance from Danelfin's
suggestion list, combined with deteriorating evidence in a newer episode,
should create a **sell-candidate alert** linked to the original episode ID.

The intended interpretation is:

```text
Danelfin suggestion + successful validation
  -> Confirm decision -> human purchase
  -> later successful Danelfin fetch no longer includes the ticker
  -> newer episode shows deterioration
  -> flag the position as a sell candidate for human review
```

Important rules for this future workflow:

- A failed or rate-limited Danelfin fetch must not count as a disappearance.
- A short absence should be monitored; a sustained absence (for example,
  about 10 successful observation days) is meaningful evidence.
- A sell-candidate alert must be a new, linked event. It must not rewrite the
  original Confirm decision, entry, or outcome history.
- The alert is a human-review signal, not an automatic sell order.
- The exact persistence window, deterioration conditions, position record, and
  alert lifecycle still need to be formalized before implementation.

This is a proposed extension to the frozen specification, not behavior that
the current implementation provides yet.

`src/ingestion/base.py` has idempotent upsert helpers (`upsert_candidate`,
`upsert_estimate_snapshot`, `upsert_earnings_history`, `upsert_price_signal`,
`upsert_security_metadata`) that use the schema's UNIQUE constraints so
re-running ingestion for an already-ingested day is a safe no-op/update.
`src/ingestion/manual_events.py` has manual-entry and CSV-import functions for
`guidance_events`, `insider_purchases`, `material_events`, and
`earnings_calendar` (per the spec, these start as manual/CSV entry points).

## EODHD price integration and diagnostic

The UI's **EODHD Test** page and `POST /api/actions/test-eodhd` endpoint run a
separate, read-only provider diagnostic. It tests EODHD daily prices for the
candidate and SPY, and reports provider capabilities and diagnostics. It never
writes the database or runs scoring. Set `EODHD_API_KEY` in `.env` to run it;
the diagnostic redacts the key from logs, errors, and returned payloads.

For a live daily run across a watchlist, call `src.pipeline.run_daily_cycle()`
with your own `PriceDataSource` (see below) from a scheduler.

## Live ingestion

With `.env` filled in (above), the UI's "Live ingestion" control (or
`POST /api/actions/ingest-live`) fetches real data for a comma-separated
ticker list and an as-of date, then runs the normal trigger-detection/scoring
pipeline against it -- so a live-ingested ticker shows up under Episodes or
Insufficient-Data-Cases. `src/ingestion/live.py`
is the orchestration layer, taking a separate client per concern:
`src/ingestion/eodhd.py` for daily price history, `src/ingestion/alpha_vantage.py`
for earnings/estimates/calendar, and `src/ingestion/danelfin.py` for candidates.

**Prices use EODHD.** EODHD is queried for both the candidate and SPY with a
450-calendar-day window, then the application requires at least 200 trading
bars before writing `price_signals` (including MA200). Alpha Vantage is not used
for prices because its free daily endpoint cannot provide enough history.

That same real run also surfaced two client bugs, now fixed (with regression
tests in `tests/test_alpha_vantage.py`): Alpha Vantage's rate-limit/premium
responses use a top-level `"Information"` key that `_get()` wasn't checking
for, so a rate-limited/gated call silently looked identical to "no data
available" instead of raising; and `get_earnings_calendar()` fed that same
kind of error response (JSON, not the expected CSV) straight into
`csv.DictReader`, producing a confusing crash several layers away
(`time data 'f' does not match format`) instead of a clear error at the
source.

What's live-verified vs. best-effort, from actually calling these APIs with
real keys while building this:

- **EODHD (`get_daily`)** -- daily OHLCV for the ticker and SPY, feeds
  `price_signals` (ma_50/ma_200/avg_volume_30d/return_3m/spy_return_3m).
  The client requests 450 calendar days and the live path requires 200
  trading bars before writing the signal.
- `EARNINGS` (Alpha Vantage, free tier) -- reported quarters only, feeds
  `earnings_history`.
- `EARNINGS_ESTIMATES` (Alpha Vantage, free tier) -- gives *both* the
  current and 30-days-ago consensus EPS estimate for an upcoming quarter in
  one call, which is exactly what `required_inputs.py`'s estimate-revision
  tolerance window needs; a single ingestion run writes two
  `estimate_snapshots` rows (`as_of_date` and `as_of_date - 30 days`) from
  it.
- `EARNINGS_CALENDAR` (Alpha Vantage, free tier, but returns **CSV**, not
  JSON) -- feeds `earnings_calendar` (the Wait-rule "earnings within 5 days"
  input).
- **Danelfin (`ingest_candidates`)** -- the sandbox this was built in
  couldn't reach `apirest.danelfin.com` at all, so `DanelfinClient`'s
  response-shape parsing is best-effort/unverified. It's wired up and
  defensive (a batch failure or an unrecognized row is reported as a warning,
  not raised), but if it errors against the real API, the field-extraction in
  `ingest_candidates()` (`src/ingestion/live.py`) is the place to fix.

Alpha Vantage's free tier is 25 requests/day, 5/minute -- a single
`ingest_price_and_earnings()` call fires 3 Alpha Vantage requests
(earnings/estimates/calendar) back-to-back with no throttling, so a
handful of tickers in one run can burn most of a day's quota; a rate-limited
response now raises clearly (see above) instead of silently looking like "no
data."

Live ingestion deliberately does **not** write to `context_ingestion_coverage`
-- Context data (guidance/insider/material events) has no live source per the
spec, so auto-marking coverage here would silently defeat the missing-data
protection described above ("Context 'required inputs'"). Use the separate
"Mark context reviewed" button (or `POST /api/actions/mark-context-reviewed`)
once you've actually checked those sources for a ticker/date -- most
freshly-live-ingested tickers will sit in Insufficient-Data-Cases (missing
just the context group) until you do.

It also does not fetch entry prices or track outcomes -- that still needs a
real `PriceDataSource` (see "Wiring up real data" above), which isn't wired
into the UI yet.

## Candidate selection

Three ways to get a ticker into `candidates` (all `src/ingestion/candidate_selection.py`,
all on-demand only -- no scheduler/background job anywhere in this workflow,
every one of them runs exactly once, synchronously, only when called):

1. **Automatic discovery -- Danelfin Trade Ideas (primary, no tickers needed).**
2. Evaluating already-known tickers against Danelfin's per-ticker ranking.
3. Manual fallback (no Danelfin at all).

### Automatic discovery: Danelfin Trade Ideas

`fetch_trade_ideas_candidates()` is what actually lets the system discover
candidates on its own -- you don't type ticker symbols in. It calls
`DanelfinClient.get_trade_ideas()` (`GET https://apirest.danelfin.com/v3/trade-ideas`,
authenticated via the `x-api-key` header, **no ticker parameter**) and
upserts every discovered ticker into `candidates` with
`source='danelfin_trade_ideas'`.

```bash
python cli.py fetch-trade-ideas --db stock_selection.db --as-of 2026-02-02 --market us --direction long --limit 100
```

```bash
curl -X POST localhost:8000/api/actions/fetch-trade-ideas \
  -H 'Content-Type: application/json' \
  -d '{"as_of_date": "2026-02-02", "market": "us", "direction": "long", "limit": 100}'
```

...or the "Fetch Danelfin Trade Ideas" button inside the UI's "Candidates" panel
(with Market / Direction / Asset type / Min AI score / Result limit filters,
all optional, and a preview table of every fetched idea afterward).

Supported optional filters: `market`, `direction`, `asset_type`, `aiscore`,
`fundamental`, `technical`, `sentiment`, `sector`, `industry`, `market_cap`,
`limit`, `offset`. `get_trade_ideas()` paginates internally -- it fetches
pages of `limit` items starting at `offset`, incrementing by `limit`, until
a page comes back short (the last page) or a `max_pages` safety cap is hit,
and returns every item found across all fetched pages. There's no `as_of`
filter on the Trade Ideas API itself -- treat a fetch as the latest
available snapshot as of whenever you run it; `as_of_date` is only used for
the `candidates.date` column you're writing into.

**Response shape is LIVE-CONFIRMED** (a real account's response was pasted
back after an initial defensive-guess version of the parser failed on it,
and the parser was fixed and locked in with a regression test against the
real payload -- `tests/test_danelfin.py`). A real response looks like:

```json
{
  "2026-08-01": {
    "ATI": {"aiscore": 7, "fundamental": 5, "technical": 8, "sentiment": 7,
             "sector": "industrials", "industry": "aerospace-defense", "win_rate_1y": 0.94, ...},
    "HWM": {"aiscore": 7, "fundamental": 7, "technical": 5, ...}
  },
  "total": 318, "limit": 100, "offset": 0
}
```

-- keyed by snapshot date, then by ticker, NOT a list. Two things worth
knowing if you're reading raw responses yourself: the score fields are
`aiscore`/`fundamental`/`technical` (no `_score` suffix), and there is **no
`rank`, `expected_return`, or `direction` field in a real response** despite
those being plausible-sounding names -- `candidates.source_rank`,
`expected_return`, and `direction` are therefore `NULL` for every
Trade-Ideas-sourced row today. Every other field Danelfin returns
(`sector`/`industry` for stocks, `focus`/`aum` for ETFs/funds,
`win_rate_1m/3m/6m/1y`, `alpha_win_rate_*`, `avg_perf_*`, `avg_alpha_*`,
`market_cap`, `average_volume_3m`, `signals_days`, ...) isn't individually
normalized into its own column, but rides along intact as JSON in
`candidates.raw_source_data`. `_extract_trade_idea_items()`
(`src/ingestion/danelfin.py`) also still tolerates a bare list or a dict
wrapping a list under `data`/`items`/`results`/`trade_ideas`/`tradeIdeas`,
as a fallback for a different endpoint version or filter combination
shaping the response differently -- and returns `[]` (not an error) for a
validly-shaped envelope with zero results, raising only if the shape
doesn't match anything recognized at all.

Every record Danelfin returns is classified independently and reported,
never silently dropped: a valid record with a ticker is normalized (scores
mapped as above; the full raw record kept as JSON in
`candidates.raw_source_data` for traceability) and upserted ->
**successful**; a structurally-fine record with no recognizable ticker field
-> **skipped**; a malformed record (not even an object) or a database error
during the upsert -> **failed**, with a clear reason either way. If the
Trade Ideas fetch itself fails entirely (network error, auth failure,
missing `DANELFIN_API_KEY`, an unrecognized response shape), that's reported
as a top-level warning instead of raising, with zero records processed.
Idempotent, same as the other two paths below: a ticker appearing twice in
one fetch (e.g. under two different ideas) still ends up as exactly one
`candidates` row (later record wins), and re-running the same fetch updates
existing rows in place via `candidates`' `UNIQUE(date, ticker, source)`
constraint.

**Rate limits (LIVE-CONFIRMED, another real-account bug fix):** Danelfin can
429 a back-to-back pagination request -- a real account's second request
(offset=100, right after a successful offset=0) was rate-limited. Fixed in
`DanelfinClient.get_trade_ideas()`: a small delay is inserted between page
requests (`request_delay_seconds`, default 0.5s -- a defensive guess, not a
documented Danelfin limit); a 429 on any single page is retried once after
waiting (honoring a `Retry-After` header if Danelfin sends one); and if a
LATER page still fails after that, pagination stops there and the pages
already fetched successfully are returned rather than discarded, with a
`result.warnings` entry noting the fetch was truncated. Only a failure on
the *first* page (nothing fetched yet at all) is still a hard failure. See
`tests/test_danelfin.py`'s 429-handling tests and
`tests/test_trade_ideas.py::test_partial_pagination_result_is_processed_and_reported_as_a_warning`.

### Evaluating already-known tickers

A separate, standalone, on-demand workflow --
`src/ingestion/candidate_selection.py:select_candidates()` -- fetches
Danelfin eligibility-filter data for a watchlist you already know and stores
it in `candidates`, and nothing else (no price/earnings fetch, no
episode-trigger detection). Unlike Trade Ideas discovery above, this
evaluates tickers you supply; it does not discover anything on its own.
It's distinct from "Live ingestion"'s bundled candidates step (which exists
for convenience when you want everything for a ticker at once).

```bash
python cli.py select-candidates --db stock_selection.db --tickers ATI,MSFT --as-of 2026-02-02
```

```bash
curl -X POST localhost:8000/api/actions/fetch-candidates \
  -H 'Content-Type: application/json' \
  -d '{"tickers": ["ATI", "MSFT"], "as_of_date": "2026-02-02"}'
```

This one isn't currently exposed as its own UI button (the UI leads with
Trade Ideas discovery + the manual fallback below) -- the CLI/API paths
above still work.

**Per spec Section 1, Danelfin is an eligibility filter only.** Nothing this
workflow writes is ever read by `score_earnings`/`score_market`/
`score_context`/`decide()` (`src/scoring.py`) -- `select_candidates()` only
ever calls `upsert_candidate()`, and none of the frozen scoring functions
reference the `candidates` table or any Danelfin field at all (guarded by a
regression test, `test_danelfin_scores_never_feed_the_frozen_scoring_functions`
in `tests/test_candidate_selection.py`). A new `candidates` row's only
downstream effect is that `episodes.py:detect_episode_trigger()` can pick it
up as a `first_eligibility` trigger the next time an episode run processes
that ticker.

Per ticker, independently: a request failure (network error, bad HTTP
status, unparseable response) is recorded as a **failure** with a clear
message and does NOT abort the rest of the batch; an empty/`None` response
(Danelfin has nothing for that ticker today) is recorded as **skipped**, not
an error; `rank`/`ai_score`/`technical_score`/`fundamental_score`/
`expected_return` are each read defensively and left `NULL` if
absent/unparseable (`ticker` is the only required field); a database error
during the upsert itself is also caught and reported as a failure rather
than raised. The result reports `requested`/`successful`/`skipped`/`failed`
(with a per-ticker error message for each failure) plus their counts.
Re-running the same request is idempotent through `candidates`' existing
`UNIQUE(date, ticker, source)` constraint (`ON CONFLICT ... DO UPDATE`) --
rows get updated in place, never duplicated.

`DanelfinClient.get_candidate()` (singular, one HTTP call per ticker) is
what gives this true per-ticker isolation -- the older `get_candidates()`
(plural, used by Live Ingestion's bundled step) has no such isolation and
fails the whole batch on the first error; kept as-is for backward
compatibility rather than changing that endpoint's existing, already-shipped
response shape.

### Manual fallback (no Danelfin)

If you already know a ticker you want tracked and don't want to depend on
Danelfin at all -- no API key, no network call -- there's a manual path that
writes straight into the same `candidates` table with `source='manual'`
instead of `'danelfin'`:

```bash
python cli.py add-manual-candidate --db stock_selection.db --tickers ATI,MSFT --as-of 2026-02-02
```

```bash
curl -X POST localhost:8000/api/actions/add-manual-candidate \
  -H 'Content-Type: application/json' \
  -d '{"tickers": ["ATI", "MSFT"], "as_of_date": "2026-02-02"}'
```

...or the "Add manually" fallback inside the UI's "Candidates" panel, next to
the Trade Ideas fetch.

`episodes.py:detect_episode_trigger()` doesn't filter by `source` when
looking up a ticker's earliest `candidates` row -- a manually-added ticker
enters the exact same tracking pipeline (episode-trigger detection, scoring,
Insufficient-Data-Cases) as a Danelfin-sourced one. There are no
rank/score fields to fill in for a manual entry (they're simply left
`NULL`), and `add_manual_candidates()` (`src/ingestion/candidate_selection.py`)
has the same per-ticker isolation and idempotency as the Danelfin path.

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
src/pipeline.py                     Orchestration (run_daily_cycle)
src/ingestion/                      EODHD / Alpha Vantage / Danelfin clients (incl. Trade Ideas
                                     discovery), live.py orchestration, candidate_selection.py
                                     (standalone Danelfin workflows), manual-event CSV import,
                                     idempotent upserts
tests/                              Tests covering the modules above
cli.py                              init-db / report / fetch-trade-ideas /
                                     select-candidates / add-manual-candidate commands
api/main.py                         FastAPI read/trigger API over the same src/ modules
ui/                                 React + TypeScript dashboard (Vite) -- see "UI" below
  scripts/dev-all.mjs               `npm run dev:all` -- runs the API and the Vite dev server together
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
  pure wall-clock `now()`, so historical as-of dates don't accidentally push
  entry-price lookups months into the future while still preserving the
  pre-open/post-open distinction that matters for `next_market_open_after()`.
  See `src/episodes.py:_write_review`.

## Fixed after code review

Three follow-up review rounds caught eleven real issues, all fixed:

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
- **Same-day trigger events were still skipped.** The fix above replaced the
  per-trigger-call cursor, but detection itself was still keyed on
  `MAX(eligibility_date)`: two distinct qualifying events dated on the
  identical calendar day (e.g. an earnings release and a guidance change both
  landing on `2026-01-12`) meant consuming the first advanced the cursor to
  that date, silently and permanently excluding the second (`event_date >
  cursor_date` is false for a same-day event). Detection now tracks
  consumption per source EVENT ROW instead of per date: a new
  `consumed_triggers` table (keyed on `ticker, source_table, source_row_id`)
  records exactly which `candidates` / `earnings_history` / `guidance_events`
  / `material_events` row produced which episode, and
  `detect_episode_trigger()` scans every qualifying row up to `as_of_date`
  (bounded below by the ticker's own first-eligibility date, so events that
  predate the stock ever becoming a candidate still don't retroactively
  trigger) and returns whichever isn't yet consumed. A trigger that fails
  scoring (insufficient data) is deliberately left unconsumed --
  `insufficient_data_cases` now also carries `trigger_source_table`/
  `trigger_source_row_id` so `_is_consumed()` treats it as "still open," and
  `run_episode_for_retry()` finally records its consumption once the retry
  succeeds. See `src/episodes.py:detect_episode_trigger` and
  `tests/test_episodes.py::test_same_day_distinct_trigger_events_each_get_their_own_episode`.
- **API keys could leak into raised error messages.** `AlphaVantageClient._get()`
  included the full request params -- including `apikey` -- in the
  `RuntimeError` it raises on an API error/rate-limit response, which is
  exactly the kind of message that ends up logged, printed in a stack
  trace, or pasted into a bug report. The key is now redacted before the
  message is built (the outgoing request itself still carries the real
  key, obviously -- only the error text is redacted). See
  `tests/test_alpha_vantage.py`.
- **Two distinct same-day trigger events could still merge into one
  insufficient-data case.** The same-day-trigger fix above made
  `detect_episode_trigger()` event-identity-aware, but
  `record_insufficient_data_case()`'s dedup key was still just
  `(ticker, source_candidate_id, episode_trigger, eligibility_date)` --
  missing `trigger_source_table`/`trigger_source_row_id`. Two separate
  `guidance_events` rows landing on the same date would collide into a
  single audit case, which can only ever resolve into ONE `reviews` row
  (`resolved_episode_id` is a single column), silently losing the second
  event. Both the app-level dedup query and the underlying
  `unique_unresolved_audit_case` index now include the source-row identity
  columns (with the same `COALESCE(..., sentinel)` NULL-collision handling
  used for `source_candidate_id`). See
  `tests/test_required_inputs.py::test_distinct_same_day_source_events_get_separate_audit_cases`.
- **An existing database wasn't migrated when the schema changed.**
  `CREATE TABLE IF NOT EXISTS` is a no-op for a table that already exists,
  so a database file from before this fix would never receive new columns
  like `reviews.eligibility_date` or
  `insufficient_data_cases.trigger_source_table`/`trigger_source_row_id`,
  and would keep enforcing `unique_unresolved_audit_case`'s OLD (narrower)
  definition forever, since `CREATE INDEX IF NOT EXISTS` only checks the
  index NAME, not whether its definition is current. `init_db()` now runs
  a small migration step (`src/db.py:_migrate`) that adds any missing
  columns via `ALTER TABLE` and drops any index whose definition may be
  stale so the schema script recreates it fresh -- safe to call repeatedly,
  no data is dropped or rewritten. This bridges "the version immediately
  before this commit," not a full historical migration chain -- see the
  scope note in `init_db()`'s docstring. See
  `tests/test_db_schema.py::test_init_db_migrates_existing_database_missing_new_columns`.

## Out of scope (per the implementation prompt)

- Brokerage/order execution of any kind -- this system never places trades.
- Paid API tiers -- Alpha Vantage/Danelfin free tiers only; verify field
  availability and rate limits before live use (spec Section 14).
- A second candidate source beyond the primary eligibility source.
- Any manual override for the earnings-window Wait rule.
