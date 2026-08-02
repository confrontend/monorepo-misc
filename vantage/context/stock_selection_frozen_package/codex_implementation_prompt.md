# Implementation Prompt — Stock-Selection Candidate Validation & Tracking System

Copy everything below into Codex (or an equivalent coding agent) as the task prompt.

---

## Task

Build a prototype system for 5–10 watchlist stocks that ingests candidate and financial data,
computes a frozen scoring rule, and produces a permanently stored, non-editable decision record
per stock-event episode. This is a **candidate-validation and tracking system**, not a
prediction model. Do not build or connect any brokerage execution.

## Scope for this prototype

- Language/stack: [fill in — e.g., Python, with SQLite for storage]
- Data sources to integrate first: [fill in — e.g., Danelfin free API for eligibility,
  Alpha Vantage for EPS/estimates/earnings history, a price-data source for OHLCV]
- Test case: run the full pipeline end-to-end on ticker **ATI** first before adding other
  watchlist stocks.
- Do not automate brokerage execution at this stage.

## Core flow (implement in this order)

```text
External APIs and manual context
              |
      Raw data ingestion
              |
  Validation and normalization
              |
 Missing required information?
       |-- Yes --> insufficient_data_cases / insufficient_data_fields (no reviews row written)
       |-- No
              |
 Earnings / Market / Context scores
              |
 Frozen decision engine
              |
 Immutable reviews row (decision_timestamp_utc; NO entry price yet)
              |
 Applicable entry session opens (next_market_open_after)
              |
 Append-only episode_entries row (entry_date, stock/spy/sector entry OPENS, frozen sector benchmark)
              |
 7/30/90/180 trading-day outcome rows, open-to-close returns (recommendation_outcomes)
              |
 Performance reports
```

## Database schema (implement all tables exactly)

Every episode-related table links via `episode_id` (not ticker+date — two distinct triggering
events can occur for the same stock on the same date).

**Enable foreign-key enforcement.** SQLite does not enforce foreign keys by default — every
connection must run `PRAGMA foreign_keys = ON;` before executing any of the DDL or DML below,
or the `FOREIGN KEY` clauses declared in this schema will be silently ignored.

```sql
PRAGMA foreign_keys = ON;

-- Candidates: eligibility list only, not scored
CREATE TABLE candidates (
    candidate_id INTEGER PRIMARY KEY,
    date DATE,
    ticker TEXT,
    source TEXT,
    source_rank TEXT,
    ai_score REAL,
    technical_score REAL,
    fundamental_score REAL,
    expected_return REAL,
    UNIQUE (date, ticker, source)
);

-- Estimate snapshots: daily stored EPS/revenue estimates, used to compute revisions ourselves.
-- UNIQUE constraint makes re-running ingestion for the same day a safe no-op/upsert rather than
-- creating duplicate observations.
CREATE TABLE estimate_snapshots (
    snapshot_id INTEGER PRIMARY KEY,
    date DATE,
    ticker TEXT,
    fiscal_period TEXT,
    eps_estimate REAL,
    revenue_estimate REAL,
    analyst_count INTEGER,
    source TEXT,
    UNIQUE (date, ticker, fiscal_period, source)
);

-- Earnings history: actuals vs. estimates
CREATE TABLE earnings_history (
    ticker TEXT,
    report_date DATE,
    fiscal_period TEXT,
    actual_eps REAL,
    estimated_eps REAL,
    eps_surprise REAL,
    actual_revenue REAL,
    estimated_revenue REAL,
    UNIQUE (ticker, report_date, fiscal_period)
);

-- Price signals: daily technicals. Includes fields required by score_market().
-- UNIQUE (date, ticker) makes re-running the daily price update idempotent.
CREATE TABLE price_signals (
    date DATE,
    ticker TEXT,
    close REAL,
    volume INTEGER,
    avg_volume_30d REAL,            -- required for high_volume_breakdown
    ma_50 REAL,
    ma_200 REAL,
    return_3m REAL,
    return_6m REAL,
    return_12m REAL,
    spy_return_3m REAL,             -- SPY's own 3-month return, stored explicitly
    excess_return_3m REAL,          -- return_3m - spy_return_3m, stored explicitly (not derived ad hoc)
    high_volume_breakdown BOOLEAN,  -- precomputed: close < ma_200 AND volume >= 1.5 * avg_volume_30d
    spy_relative_return REAL,
    UNIQUE (date, ticker)
);

-- Security metadata: fixes the sector benchmark mapping ahead of time, so outcome measurement
-- never selects a benchmark after the fact based on which one looks best.
CREATE TABLE security_metadata (
    ticker TEXT PRIMARY KEY,
    company_name TEXT,
    sector TEXT,
    industry TEXT,
    sector_benchmark_ticker TEXT    -- e.g. ATI -> XLI or a more specific aerospace/defense ETF
);

-- Context inputs: these feed score_context() and the Wait rule. May be populated manually at first.
CREATE TABLE guidance_events (
    event_id INTEGER PRIMARY KEY,
    ticker TEXT,
    event_date DATE,
    guidance_direction TEXT,        -- 'raised' / 'maintained' / 'cut'
    detail TEXT,
    source TEXT
);

CREATE TABLE insider_purchases (
    purchase_id INTEGER PRIMARY KEY,
    ticker TEXT,
    transaction_date DATE,
    insider_name TEXT,
    insider_title TEXT,
    purchase_value_usd REAL,
    transaction_type TEXT,          -- must be 'open-market' to qualify for clustering
    source TEXT
);

CREATE TABLE material_events (
    event_id INTEGER PRIMARY KEY,
    ticker TEXT,
    event_date DATE,
    event_type TEXT,                -- 'M&A' / 'CEO_departure' / 'CFO_departure' /
                                     -- 'investigation' / 'accounting_issue' /
                                     -- 'contract_win' / 'contract_loss' / other
    polarity TEXT,                  -- 'positive' / 'negative'
    detail TEXT,
    source TEXT
);

CREATE TABLE earnings_calendar (
    ticker TEXT,
    scheduled_report_date DATE,
    confirmed BOOLEAN,
    source TEXT
);

-- Insufficient-data audit: one CASE per episode attempt (not one row per missing field --
-- see insufficient_data_fields below). A case does NOT count toward the 30-50 episode sample
-- and NEVER produces a reviews row directly (insufficient_data is not a valid reviews.decision
-- value). Preserves enough context to complete the review later as the SAME original episode,
-- exactly once, only after ALL of its missing fields are resolved.
CREATE TABLE insufficient_data_cases (
    audit_id INTEGER PRIMARY KEY,
    ticker TEXT,
    as_of_date DATE,
    checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    episode_trigger TEXT,           -- the ORIGINAL trigger that made this stock eligible for review
    eligibility_date DATE,          -- the date that original trigger occurred
    source_candidate_id INTEGER,    -- FK to candidates.candidate_id
    resolved BOOLEAN DEFAULT FALSE, -- set true once a reviews row is eventually created from this
    resolved_episode_id TEXT,       -- the episode_id of the reviews row that resolved this, if any
    retry_after DATE,               -- optional: when to attempt rescoring again
    FOREIGN KEY (source_candidate_id) REFERENCES candidates(candidate_id)
);

-- Prevents a repeated ingestion run from spawning a second unresolved case for the same
-- underlying episode intent while an earlier one is still open. Only one unresolved case may
-- exist per (ticker, source_candidate_id, episode_trigger, eligibility_date) at a time.
CREATE UNIQUE INDEX unique_unresolved_audit_case
ON insufficient_data_cases (
    ticker,
    source_candidate_id,
    episode_trigger,
    eligibility_date
)
WHERE resolved = FALSE;

-- One-to-many: every missing field for a given case. A case is only eligible to resolve once
-- every row here for that audit_id is confirmed available.
CREATE TABLE insufficient_data_fields (
    field_id INTEGER PRIMARY KEY,
    audit_id INTEGER,               -- FK to insufficient_data_cases.audit_id
    missing_group TEXT,             -- 'earnings' / 'market' / 'context' / 'wait_check'
    missing_field TEXT,             -- e.g. 'eps_estimate_30d_ago', 'ma_200', 'scheduled_report_date'
    UNIQUE (audit_id, missing_group, missing_field),
    FOREIGN KEY (audit_id) REFERENCES insufficient_data_cases(audit_id)
);

-- Reviews: one row per scored episode. IMMUTABLE the instant it is written.
-- Deliberately does NOT contain entry_date or any entry price -- those are not knowable yet
-- at decision time (they depend on the applicable session's open). See episode_entries.
CREATE TABLE reviews (
    episode_id TEXT PRIMARY KEY,    -- e.g. UUID
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    decision_timestamp_utc TIMESTAMP, -- exact moment the decision was computed
    rule_version TEXT,              -- version tag of the frozen spec in effect at scoring time
    review_date DATE,
    ticker TEXT,
    episode_trigger TEXT,           -- which Section 10 trigger created this episode (or the
                                     -- preserved original trigger if resolving an
                                     -- insufficient_data_cases case)
    resolved_from_audit_id INTEGER, -- NULL unless this review resolves a prior
                                     -- insufficient_data_cases.audit_id
    corrects_episode_id TEXT,       -- NULL unless this episode is a correction of a prior one
    earnings_score INTEGER,         -- -1, 0, or 1
    earnings_fact TEXT,             -- exact underlying fact, referencing source table row(s)
    market_score INTEGER,
    market_fact TEXT,
    context_score INTEGER,
    context_fact TEXT,
    total_score INTEGER,
    red_flag BOOLEAN,
    earnings_within_5d BOOLEAN,
    decision TEXT,                  -- Confirm / Mixed / Reject / Wait  (never 'insufficient_data')
    confidence TEXT,
    explanation TEXT,
    FOREIGN KEY (resolved_from_audit_id) REFERENCES insufficient_data_cases(audit_id),
    FOREIGN KEY (corrects_episode_id) REFERENCES reviews(episode_id)
);

-- Episode entries: append-only. Exactly one row per episode, written only once the applicable
-- entry session has actually opened (see next_market_open_after logic below). This resolves the
-- immutability-vs-future-price conflict: reviews is frozen at decision time; entry prices are
-- recorded separately, later, once they exist. All three entry prices are OPENS (not closes),
-- to match the frozen open-to-close return calculation. The sector benchmark ticker is copied
-- here and frozen for this episode's entire outcome-tracking lifetime -- if security_metadata
-- is later updated for this ticker, this episode keeps using the benchmark it entered with.
CREATE TABLE episode_entries (
    episode_id TEXT PRIMARY KEY,    -- one row per episode; also FK to reviews.episode_id
    entry_date DATE,                -- the applicable trading session's date
    stock_entry_open REAL,
    spy_entry_open REAL,
    sector_entry_open REAL,
    sector_benchmark_ticker TEXT,   -- frozen copy of security_metadata.sector_benchmark_ticker
                                     -- as of entry time; never re-looked-up later
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (episode_id),
    FOREIGN KEY (episode_id) REFERENCES reviews(episode_id)
);

-- Recommendation outcomes: append-only at the ROW level. One new row per measurement horizon
-- per episode -- never an update to an existing row. Returns are OPEN-to-CLOSE, matching the
-- frozen entry-price rule: entry prices come from episode_entries (opens), exit prices are
-- closes on exit_date. Do NOT fetch closes for both dates -- that would silently compute
-- close-to-close returns instead of the frozen open-to-close calculation.
CREATE TABLE recommendation_outcomes (
    outcome_id INTEGER PRIMARY KEY,
    episode_id TEXT,                -- links back to reviews.episode_id / episode_entries.episode_id
    measurement_date DATE,
    horizon_days INTEGER,           -- 7, 30, 90, or 180 (trading days)
    exit_date DATE,                 -- the trading-day date this horizon resolved on
    stock_exit_close REAL,
    spy_exit_close REAL,
    sector_exit_close REAL,
    stock_return REAL,              -- (stock_exit_close / episode_entries.stock_entry_open) - 1
    spy_return REAL,                -- (spy_exit_close / episode_entries.spy_entry_open) - 1
    sector_return REAL,             -- (sector_exit_close / episode_entries.sector_entry_open) - 1
    recommendation_result TEXT,
    UNIQUE (episode_id, horizon_days),
    FOREIGN KEY (episode_id) REFERENCES reviews(episode_id)
);
```

### Enforcing immutability at the database level

Do not rely on application-level discipline alone. Add triggers rejecting any `UPDATE` or
`DELETE` on `reviews` and on `recommendation_outcomes`:

```sql
CREATE TRIGGER prevent_reviews_update
BEFORE UPDATE ON reviews
BEGIN
    SELECT RAISE(ABORT, 'reviews rows are immutable; insert a new episode referencing corrects_episode_id instead');
END;

CREATE TRIGGER prevent_reviews_delete
BEFORE DELETE ON reviews
BEGIN
    SELECT RAISE(ABORT, 'reviews rows are immutable; corrections must be new episodes');
END;

CREATE TRIGGER prevent_outcomes_update
BEFORE UPDATE ON recommendation_outcomes
BEGIN
    SELECT RAISE(ABORT, 'recommendation_outcomes rows are append-only; insert a new row per horizon instead');
END;

CREATE TRIGGER prevent_outcomes_delete
BEFORE DELETE ON recommendation_outcomes
BEGIN
    SELECT RAISE(ABORT, 'recommendation_outcomes rows are append-only and may not be deleted');
END;

CREATE TRIGGER prevent_entries_update
BEFORE UPDATE ON episode_entries
BEGIN
    SELECT RAISE(ABORT, 'episode_entries rows are append-only once entry prices are recorded');
END;

CREATE TRIGGER prevent_entries_delete
BEFORE DELETE ON episode_entries
BEGIN
    SELECT RAISE(ABORT, 'episode_entries rows are append-only and may not be deleted');
END;
```

`UNIQUE (episode_id, horizon_days)` on `recommendation_outcomes` and `UNIQUE (episode_id)` on
`episode_entries` guarantee at most one row per episode per horizon (and per episode overall,
respectively), combined with the triggers above to make each guarantee enforceable at the schema
level rather than relying on the ingestion scripts always behaving correctly.

## Trading calendar module (build first — everything else depends on it)

Implement one shared module used by every trading-day-dependent calculation in this system.
Do not let `score_earnings`, `score_context`, the entry-price step, or the outcome tracker each
compute trading days independently — inconsistent trading-day math across functions would
silently break the frozen 5-day and 7/30/90/180-day thresholds without looking like a rule
change.

```python
class TradingCalendar:
    def is_trading_day(self, date) -> bool: ...
    def next_market_open_after(self, timestamp_utc) -> tuple[date, datetime]:
        """
        Returns (entry_date, market_open_timestamp) for the applicable entry session.
        Rules (frozen):
        - If timestamp_utc is before that calendar day's market open, and that day is a
          trading day, use THAT day's open.
        - If timestamp_utc is at or after that day's market open, use the NEXT trading
          session's open.
        - If the applicable day is a weekend/holiday, roll forward to the next available
          trading session's open.
        Do not use a date-only "next_session(date)" function for this -- it cannot
        distinguish a decision made before today's open (which should use today) from one
        made after today's open (which should use tomorrow).
        """
        ...
    def add_trading_days(self, date, n: int) -> date:
        """Returns the date of the n-th trading session strictly after `date`. `date` itself
        is day 0 and is never counted toward n -- add_trading_days(entry_date, 7) returns the
        7th trading session after entry_date, not entry_date plus 6 more sessions."""
        ...
    def trading_days_between(self, start_date, end_date) -> int: ...
    def sessions_in_window(self, start_date, end_date) -> list[date]: ...
```

Must correctly account for weekends, U.S. market holidays, and exceptional closures (use a
maintained exchange-calendar library rather than hand-rolling holiday logic). All of the
following must call into this single module:
- the 5-trading-day earnings window check
- the 5-trading-day insider-cluster window
- computing the entry session via `next_market_open_after(decision_timestamp_utc)`
- computing each `recommendation_outcomes.exit_date` as `add_trading_days(entry_date, horizon_days)`

## Decision logic to implement (frozen — see attached spec doc for full detail)

Implement exactly the rules in `stock_selection_frozen_spec.md`. Key points to encode as pure,
testable functions (not inline in the ingestion script):

0. **`check_required_inputs(ticker, as_of_date) -> (ok: bool, missing: list)`**

   Before any group is scored, verify all required inputs exist per the frozen spec's
   missing-data policy:
   - Earnings: latest actual EPS vs. estimate, and the EPS-estimate value from 30 days prior.
     The 30-day-prior lookup must use the most recent `estimate_snapshots` row dated on or
     before `as_of_date − 30 calendar days`, accepting a snapshot up to 5 calendar days older
     than that target (i.e., anywhere in `[as_of_date − 35, as_of_date − 30]`). If no snapshot
     falls in that window, treat the 30-day-prior estimate as missing — do not fall back to an
     older snapshot outside the tolerance, and do not skip the revision check silently.
   - Market: ≥200 trading days of price history, current price, both MAs, SPY 3-month return,
     30-day average volume
   - Context: guidance/material-event data covering the applicable window (see function 3
     below), insider-transaction data for the trailing 30 calendar days
   - Wait check: a confirmed or estimated next earnings date

   If `ok` is False, do **not** call any scoring function and do **not** write a `reviews` row.
   Instead write **one** row to `insufficient_data_cases` (populating `episode_trigger`,
   `eligibility_date`, and `source_candidate_id` from the event that made this stock eligible
   for review right now) and **one row per missing field** to `insufficient_data_fields`
   referencing that case's `audit_id` — never a separate case per missing field.

0a. **`retry_insufficient_data()`** — a periodic job that, for each unresolved row in
    `insufficient_data_cases`, checks whether **every** row in `insufficient_data_fields` for
    that `audit_id` is now satisfied (re-run `check_required_inputs()` and confirm none of the
    originally-missing fields are still missing — do not resolve a case if only some of its
    missing fields have become available). When a case fully resolves, run the scoring
    pipeline using the **preserved** `episode_trigger` and `eligibility_date` from the case row
    (not a new "data became available" trigger), write exactly **one** resulting `reviews` row
    with `resolved_from_audit_id` set to the case's `audit_id`, and mark the case
    `resolved = TRUE` with `resolved_episode_id` set. This one-case-per-episode design (rather
    than one audit row per missing field) is what guarantees a case can only ever produce one
    `reviews` row.

1. **`score_earnings(latest_actual_eps, latest_estimated_eps, eps_estimate_30d_ago,
   eps_estimate_now) -> (score, fact_string)`**
   - +1 if beat AND next-quarter estimate rose over 30 days
   - −1 if missed OR next-quarter estimate fell over 30 days
   - 0 otherwise
   - Only called after `check_required_inputs` passes. `eps_estimate_30d_ago` must already have
     been resolved via the tolerance-window lookup described above (function 0) — this function
     itself does not search for a snapshot; it assumes the caller already validated one exists
     within `[as_of_date − 35, as_of_date − 30]`.

2. **`score_market(price, ma_50, ma_200, excess_return_3m, volume, avg_volume_30d) ->
   (score, fact_string)`**
   - Compute `high_volume_breakdown = (price < ma_200) AND (volume >= 1.5 * avg_volume_30d)`
   - +1 if `price > ma_50 AND ma_50 > ma_200 AND excess_return_3m >= 0.02`
   - −1 if `price < ma_200 OR excess_return_3m < -0.05 OR high_volume_breakdown`
   - 0 if neither the +1 nor the −1 condition is met (this includes cases like mixed MAs with
     excess return outside [−5%, +2%) in either direction — the 0 branch is "neither of the
     other two," not a narrower band-based condition)
   - Excess return bands are half-open: [+2%, ∞) → +1 eligible; [−5%, +2%) → 0 eligible;
     (−∞, −5%) → −1 eligible. Implement with exact inequality operators as specified — do not
     round the boundary.

3. **`score_context(ticker, as_of_date, last_earnings_release_date, guidance_events: list,
   insider_purchases: list, material_events: list) -> (score, fact_string)`**
   - **Window logic:** if `last_earnings_release_date` is not null, the applicable window for
     `guidance_events` and `material_events` is `[last_earnings_release_date, as_of_date]`. If
     null (first review, no prior earnings on file), use `[as_of_date - 90 calendar days,
     as_of_date]` instead.
   - For `insider_purchases`, only consider a cluster "current" if the 5-trading-day clustering
     window it completed in falls within the trailing 30 calendar days of `as_of_date` (use the
     `TradingCalendar` module for the 5-trading-day part; the 30-day recency check is calendar
     days).
   - Query `guidance_events` within the applicable window; `guidance_direction = 'raised'` or
     `'cut'` drives the guidance component.
   - Insider cluster check: query `insider_purchases` where `transaction_type = 'open-market'`,
     group by 5-trading-day rolling window (subject to the 30-day recency rule above); a
     cluster qualifies if it contains ≥2 distinct `insider_name` identities each with
     `purchase_value_usd` ≥ $50,000.
   - Query `material_events` within the applicable window for entries with `polarity =
     'negative'` and `event_type` in {investigation, accounting_issue, CEO_departure,
     CFO_departure} or equivalent.
   - **Conflict rule:** if both a positive condition (guidance raised or qualifying insider
     cluster) and a negative condition (guidance cut or qualifying negative material event) are
     present in the window, negative overrides — return −1. Check for negative conditions
     first in code, and only check positive conditions if no negative condition was found.
   - −1 if guidance cut OR a matching negative material event exists (checked first)
   - +1 if guidance raised OR a qualifying insider cluster exists (checked only if no −1
     condition applies)
   - 0 otherwise
   - `fact_string` must cite the specific source row(s) used (e.g., `guidance_events.event_id`
     or `insider_purchases.purchase_id` list), not just a restated score.

4. **`check_earnings_within_5d(ticker, as_of_date, earnings_calendar) -> bool`**
   - Query `earnings_calendar` for the nearest `scheduled_report_date` ≥ `as_of_date`; use
     `TradingCalendar.trading_days_between()` to check if it falls within 5 trading days.

5. **`decide(earnings_score, market_score, context_score, red_flag, earnings_within_5d) ->
   (decision, confidence)`**

   `red_flag` is not a separate input to derive independently — it is computed directly from
   the Context score:

   ```python
   red_flag = (context_score == -1)
   ```

   Every Context −1 condition (guidance cut, investigation, accounting/restatement issue,
   unexpected CEO/CFO departure, or comparable major negative event) already qualifies as a
   red flag per the frozen spec — there is no partial or graded version of this rule. Do not
   introduce a separate red-flag scoring path; derive it from `context_score` at call time.

   Implement the decision sequence exactly — order matters and must not be reordered or
   short-circuited differently:

   ```python
   def decide(earnings_score, market_score, context_score, red_flag, earnings_within_5d):
       if red_flag:
           return ("Reject", "Reject")
       if earnings_within_5d:
           return ("Wait", "Wait")
       total = earnings_score + market_score + context_score
       if total <= -1:
           return ("Reject", "Reject")
       if total >= 2:
           return ("Confirm", "Confirm")
       if {earnings_score, market_score} == {1, -1}:  # opposite signs
           return ("Mixed", "Mixed")
       return ("Mixed", "Mixed")  # total is 0 or 1, same-sign or neutral case
   ```

   Note the `total <= -1` check is placed **before** the `total >= 2` check and **before** the
   opposite-signs check. This ordering is required so that an opposite-sign combination with a
   total of −1 (e.g., earnings=+1, market=−1, context=−1) correctly resolves to Reject, per the
   frozen spec's carve-out ("opposite signs → Mixed, unless total or red-flag causes Reject").

   Write unit tests covering **all 27 combinations** of (earnings_score, market_score,
   context_score) ∈ {−1,0,1}³, crossed with red_flag ∈ {True, False} and earnings_within_5d ∈
   {True, False}, and assert each maps to exactly one label per the frozen spec. This test
   suite is the acceptance gate for this function — do not consider the decision engine done
   until all combinations pass.

## Episode-trigger logic

Implement a function that checks, for a given ticker on a given date, whether any of the
Section 10 triggers fired since the last recorded episode for that ticker:
first eligibility, earnings release, formal guidance change, decision-label change, M&A
announcement, CEO/CFO departure, regulatory investigation start, or major contract win/loss.
If none fired, do not create a new `reviews` row for that ticker on that date. (A delayed
completion of an `insufficient_data` case is not a new trigger — see function 0a above.)

## Entry-price recording

Implement a scheduled job (run frequently — at minimum around each session's open) that:
- Finds all `reviews` rows without a corresponding `episode_entries` row, and for each, calls
  `TradingCalendar.next_market_open_after(decision_timestamp_utc)` to determine the applicable
  `entry_date`.
- Only proceeds once that session has actually opened (i.e., `entry_date`'s market open
  timestamp is now in the past).
- Fetches the **opening** price of the stock, of SPY, and of the ticker's current
  `security_metadata.sector_benchmark_ticker` on `entry_date`.
- Inserts one `episode_entries` row containing `entry_date`, `stock_entry_open`,
  `spy_entry_open`, `sector_entry_open`, and `sector_benchmark_ticker` (the value looked up
  *right now*, permanently frozen into this row — never re-looked-up later). Never updates an
  existing row.

## Outcome tracking

Implement a scheduled job that:
- For each `episode_entries` row, uses `TradingCalendar.add_trading_days(entry_date, horizon)`
  for horizon in [7, 30, 90, 180] to compute each `exit_date`. `entry_date` is day 0, not day 1
  — `add_trading_days(entry_date, 7)` must return the 7th trading session *after* `entry_date`
  (i.e., `entry_date` itself is not counted toward the 7). Do not implement an off-by-one
  variant that counts `entry_date` as the first of the 7 days.
- Once `exit_date` has passed, fetches the **closing** price of the stock, of SPY, and of the
  benchmark named in that episode's own `episode_entries.sector_benchmark_ticker` (not a fresh
  lookup from `security_metadata`) on `exit_date`.
- Computes returns **open-to-close**, per the frozen spec:
  `stock_return = stock_exit_close / stock_entry_open - 1` (and the equivalent for SPY and
  sector, each using their own entry-open and exit-close). Do not fetch closes for both the
  entry and exit dates — that would compute close-to-close returns, which the frozen spec does
  not use.
- Inserts one `recommendation_outcomes` row per horizon (respecting `UNIQUE (episode_id,
  horizon_days)`) — never update an existing horizon's row.

## Non-negotiable constraints

- `reviews` rows are **immutable** the instant they are written — no code path may update or
  delete a row, enforced by database triggers. `reviews` never contains `entry_date` or any
  entry price. A correction to a past episode is a **new row** in `reviews` with
  `corrects_episode_id` set to the original `episode_id`.
- `episode_entries` and `recommendation_outcomes` are **append-only** — enforced by both a
  uniqueness constraint and update/delete-blocking triggers, not by application convention.
- `insufficient_data_cases` / `insufficient_data_fields` are never a value of `reviews.decision`.
  Insufficient-data cases live only in those two tables until resolved, and a case resolves into
  **at most one** `reviews` row — never multiple rows from the same case, and never a partial
  resolution while some of the case's listed fields are still missing.
- Every `reviews` row must carry a unique `episode_id` and a `rule_version` tag identifying
  which version of the frozen spec was in effect when it was scored.
- No thresholds, group definitions, or the decision table may be changed in code without also
  updating `stock_selection_frozen_spec.md`, incrementing `rule_version`, and restarting the
  freeze-period sample count, per Section 13 of the spec.
- No manual override path for skipping the earnings-window Wait rule during the first
  forward-testing cycle. Do not implement a bypass flag for this in v1.
- All trading-day math goes through the single `TradingCalendar` module, including its
  timestamp-aware `next_market_open_after()` — no ad hoc recalculation elsewhere.
- Sector benchmark for each episode is fixed at entry time into `episode_entries` and reused
  for that episode's entire outcome-tracking lifetime — never re-looked-up from
  `security_metadata` at outcome-measurement time.
- All outcome returns are **open-to-close** (entry open, exit close) — never close-to-close.
- No automated trade placement of any kind.

## Deliverables for this prototype

1. The `TradingCalendar` module, built and unit-tested first (weekends, holidays, at least one
   exceptional-closure case, both branches of `next_market_open_after` — pre-open and
   post-open decisions, and the day-zero convention for `add_trading_days`: entry_date counts
   as day 0, so `add_trading_days(entry_date, 7)` must return the 7th session strictly after
   entry_date), since every other component depends on it.
2. Ingestion scripts that populate `candidates`, `estimate_snapshots`, `earnings_history`,
   `price_signals`, and `security_metadata` from the chosen data sources, storing daily
   snapshots (the UNIQUE constraints make re-running ingestion idempotent — upsert on conflict
   rather than erroring). `price_signals` must compute and store `avg_volume_30d`,
   `spy_return_3m`, `excess_return_3m`, and `high_volume_breakdown` directly — do not compute
   these ad hoc inside `score_market()`.
3. Manual-entry (or later automated) population paths for `guidance_events`,
   `insider_purchases`, `material_events`, and `earnings_calendar`. These may start as simple
   CSV-import or manual-form entry points; automation can come later.
4. `check_required_inputs()`, `retry_insufficient_data()`, the three scoring functions,
   `check_earnings_within_5d()`, and the `decide()` function (exact sequence as specified
   above), each unit-tested per above. Include tests confirming that:
   - a missing required input routes to `insufficient_data_cases`/`insufficient_data_fields`
     (never to a `reviews` row);
   - a case with multiple missing fields only resolves once *all* of them are available, and
     produces exactly **one** `reviews` row using the originally preserved trigger — not one
     row per field;
   - a repeated ingestion run for the same ticker/candidate/trigger/eligibility_date does not
     create a second unresolved audit case (relies on `unique_unresolved_audit_case`);
   - the 30-day-prior estimate lookup correctly accepts a snapshot within
     `[as_of_date − 35, as_of_date − 30]` and correctly treats the estimate as missing when no
     snapshot falls in that window (test both the in-tolerance and out-of-tolerance cases);
   - `red_flag` is correctly derived as `context_score == -1` at the point `decide()` is called,
     not computed by a separate, potentially inconsistent code path.
5. Episode-trigger detection logic that writes new `reviews` rows — each with a fresh
   `episode_id`, `rule_version`, and `decision_timestamp_utc` — only when a Section 10 trigger
   fires and all required inputs are present.
6. The entry-price recording job (writes `episode_entries` with all three entry-open prices and
   the frozen `sector_benchmark_ticker`, once the applicable session per
   `next_market_open_after` has opened).
7. A simple readable report generator (plain text or markdown) that renders one `reviews` row
   (joined with `episode_entries` if it exists yet) into a human-readable evidence summary, in
   the style of:

   ```
   ATI  (episode_id: 8f3a...)
   Decision: WAIT
   Confidence: WAIT
   Earnings score: 0 (mixed revisions)
   Market score: +1 (price above both MAs, excess return +6% vs SPY)
   Context score: +1 (raised FY guidance on 2026-07-15, guidance_events.event_id=42)
   Reason: Earnings release within 5 trading days; re-evaluate after results.
   ```

8. The outcome-tracking job described above, computing open-to-close returns using each
   episode's frozen entry prices and frozen sector benchmark, inserting
   `recommendation_outcomes` rows only, never touching `reviews` or `episode_entries`.

## Explicitly out of scope for this prototype

- Brokerage/order execution of any kind
- Paid API integrations (use free tiers only initially)
- A second candidate source beyond the primary eligibility source
- Any manual override UI for the earnings-window Wait rule
