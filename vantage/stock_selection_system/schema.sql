-- Stock-Selection Candidate Validation & Tracking System
-- Schema per context/codex_implementation_prompt.md and stock_selection_frozen_spec.md.
-- Every episode-related table links via episode_id (not ticker+date -- two distinct
-- triggering events can occur for the same stock on the same date).
--
-- IMPORTANT: SQLite does not enforce foreign keys by default. Every connection
-- must run `PRAGMA foreign_keys = ON;` before executing DDL/DML (see src/db.py).

PRAGMA foreign_keys = ON;

-- Candidates: eligibility list only, not scored
CREATE TABLE IF NOT EXISTS candidates (
    candidate_id INTEGER PRIMARY KEY,
    date DATE,
    ticker TEXT,
    source TEXT,
    source_rank TEXT,
    ai_score REAL,
    technical_score REAL,
    fundamental_score REAL,
    expected_return REAL,
    direction TEXT,          -- e.g. 'long'/'short', from sources like Danelfin Trade Ideas that
                              -- provide one; NULL for sources that don't (manual, plain Danelfin
                              -- ranking). Eligibility metadata only -- never read by scoring.
    raw_source_data TEXT,    -- JSON-serialized raw record from the source API, kept for
                              -- traceability/debugging when a source's schema is unverified or
                              -- richer than the normalized columns above capture. Eligibility
                              -- metadata only -- never read by scoring.
    UNIQUE (date, ticker, source)
);

-- Estimate snapshots: daily stored EPS/revenue estimates, used to compute revisions ourselves.
-- UNIQUE constraint makes re-running ingestion for the same day a safe no-op/upsert rather than
-- creating duplicate observations.
CREATE TABLE IF NOT EXISTS estimate_snapshots (
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
CREATE TABLE IF NOT EXISTS earnings_history (
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
CREATE TABLE IF NOT EXISTS price_signals (
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
CREATE TABLE IF NOT EXISTS security_metadata (
    ticker TEXT PRIMARY KEY,
    company_name TEXT,
    sector TEXT,
    industry TEXT,
    sector_benchmark_ticker TEXT    -- e.g. ATI -> XLI or a more specific aerospace/defense ETF
);

-- Context inputs: these feed score_context() and the Wait rule. May be populated manually at first.
CREATE TABLE IF NOT EXISTS guidance_events (
    event_id INTEGER PRIMARY KEY,
    ticker TEXT,
    event_date DATE,
    guidance_direction TEXT,        -- 'raised' / 'maintained' / 'cut'
    detail TEXT,
    source TEXT
);

CREATE TABLE IF NOT EXISTS insider_purchases (
    purchase_id INTEGER PRIMARY KEY,
    ticker TEXT,
    transaction_date DATE,
    insider_name TEXT,
    insider_title TEXT,
    purchase_value_usd REAL,
    transaction_type TEXT,          -- must be 'open-market' to qualify for clustering
    source TEXT
);

CREATE TABLE IF NOT EXISTS material_events (
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

CREATE TABLE IF NOT EXISTS earnings_calendar (
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
CREATE TABLE IF NOT EXISTS insufficient_data_cases (
    audit_id INTEGER PRIMARY KEY,
    ticker TEXT,
    as_of_date DATE,
    checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    episode_trigger TEXT,           -- the ORIGINAL trigger that made this stock eligible for review
    eligibility_date DATE,          -- the date that original trigger occurred
    source_candidate_id INTEGER,    -- FK to candidates.candidate_id
    trigger_source_table TEXT,      -- the specific source row this trigger came from (e.g.
                                     -- 'earnings_history', 'guidance_events', 'material_events',
                                     -- 'candidates'), so that once this case resolves, the SAME
                                     -- consumed_triggers row can be recorded that would have been
                                     -- recorded at the time of the original (failed) detection --
                                     -- otherwise this specific event row would still look
                                     -- "unconsumed" and detect_episode_trigger could surface it
                                     -- again as a brand-new trigger after resolution.
    trigger_source_row_id INTEGER,  -- rowid/primary key within trigger_source_table
    resolved BOOLEAN DEFAULT FALSE, -- set true once a reviews row is eventually created from this
    resolved_episode_id TEXT,       -- the episode_id of the reviews row that resolved this, if any
    retry_after DATE,               -- optional: when to attempt rescoring again
    FOREIGN KEY (source_candidate_id) REFERENCES candidates(candidate_id)
);

-- Prevents a repeated ingestion run from spawning a second unresolved case for the same
-- underlying episode intent while an earlier one is still open. Only one unresolved case may
-- exist per (ticker, source_candidate_id, episode_trigger, eligibility_date, trigger_source_table,
-- trigger_source_row_id) at a time.
--
-- trigger_source_table/trigger_source_row_id are part of the key for the same reason
-- consumed_triggers is keyed on source event identity rather than just a date: two DISTINCT
-- same-day trigger events (e.g. two separate guidance_events rows, both dated 2026-01-12, both
-- becoming 'guidance_change' episode attempts) would otherwise collide on
-- (ticker, episode_trigger, eligibility_date) alone and get merged into ONE audit case -- even
-- though they are two separate episode intents with two different underlying source rows. That
-- would silently drop one of them: resolving the merged case only ever writes ONE reviews row
-- (resolved_episode_id is a single column), so the second event's episode would never get
-- created.
--
-- NOTE: SQL UNIQUE constraints treat NULL as distinct from every other value, including
-- another NULL -- two unresolved rows that both have a NULL source_candidate_id (or NULL
-- trigger_source_table/trigger_source_row_id, e.g. force_rescore()/record_correction(), which
-- aren't tied to a specific source event row) would NOT collide under a plain column-list
-- index, silently defeating the "at most one" guarantee. COALESCE(..., sentinel) closes that
-- gap for every nullable column in the key.
CREATE UNIQUE INDEX IF NOT EXISTS unique_unresolved_audit_case
ON insufficient_data_cases (
    ticker,
    COALESCE(source_candidate_id, -1),
    episode_trigger,
    eligibility_date,
    COALESCE(trigger_source_table, ''),
    COALESCE(trigger_source_row_id, -1)
)
WHERE resolved = FALSE;

-- One-to-many: every missing field for a given case. A case is only eligible to resolve once
-- every row here for that audit_id is confirmed available.
CREATE TABLE IF NOT EXISTS insufficient_data_fields (
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
CREATE TABLE IF NOT EXISTS reviews (
    episode_id TEXT PRIMARY KEY,    -- e.g. UUID
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    decision_timestamp_utc TIMESTAMP, -- exact moment the decision was computed
    rule_version TEXT,              -- version tag of the frozen spec in effect at scoring time
    review_date DATE,
    ticker TEXT,
    episode_trigger TEXT,           -- which Section 10 trigger created this episode (or the
                                     -- preserved original trigger if resolving an
                                     -- insufficient_data_cases case)
    eligibility_date DATE,          -- the date the triggering event itself occurred (NOT the
                                     -- same as review_date/decision_timestamp_utc, which is when
                                     -- this episode was scored). Added beyond the literal spec
                                     -- schema for audit/reporting purposes. Episode-trigger
                                     -- detection itself does NOT use this as a cursor -- see
                                     -- consumed_triggers below and episodes.py:detect_episode_trigger.
                                     -- A date-only cursor (MAX(eligibility_date)) would silently
                                     -- and permanently skip a second distinct trigger event dated
                                     -- on the SAME day as an already-consumed one, since "greater
                                     -- than the cursor date" excludes same-day events once the
                                     -- cursor advances to that date.
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

-- A case resolves into AT MOST ONE reviews row. SQLite's default NULL handling is exactly
-- what's wanted here: NULLs (the vast majority of reviews, which don't resolve any audit case)
-- are treated as distinct from each other and never collide, while two non-NULL values pointing
-- at the same audit_id are rejected. This is defense in depth alongside the atomic
-- write-then-mark-resolved transaction in required_inputs.retry_insufficient_data().
CREATE UNIQUE INDEX IF NOT EXISTS unique_resolved_from_audit_id
ON reviews (resolved_from_audit_id);

-- Context ingestion coverage: tracks, per ticker, the latest date through which
-- guidance_events/insider_purchases/material_events ingestion has been CONFIRMED complete --
-- even on days where zero new events were found. Without this, check_required_inputs() cannot
-- tell "we checked and there was genuinely no news" from "we never checked this window at all,"
-- and would treat the latter as a valid 0-eligible Context signal -- exactly the "missing data
-- treated as neutral" failure Section 4 prohibits. Ingestion (or the demo seed) must call
-- mark_context_coverage() after each check, even when it finds nothing to insert.
CREATE TABLE IF NOT EXISTS context_ingestion_coverage (
    ticker TEXT PRIMARY KEY,
    covered_through DATE NOT NULL,
    checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Consumed triggers: records, per specific source event ROW (not just a date), that it has
-- already been turned into an episode (or an insufficient_data_cases audit row -- see
-- trigger_source_table/trigger_source_row_id above). detect_episode_trigger() uses this to
-- decide "has THIS event already produced an episode," rather than "is this event dated after
-- some threshold" -- the latter (a date-only cursor) permanently drops any second distinct
-- trigger event that lands on the SAME calendar date as an already-consumed one, which
-- conflicts with the spec's requirement that distinct same-date events produce distinct
-- episodes. 'candidates' rows use candidate_id as source_row_id; 'earnings_history' rows (no
-- surrogate key) use SQLite's implicit rowid; 'guidance_events'/'material_events' use
-- event_id.
CREATE TABLE IF NOT EXISTS consumed_triggers (
    consumed_id INTEGER PRIMARY KEY,
    ticker TEXT,
    source_table TEXT,              -- 'candidates' / 'earnings_history' / 'guidance_events' / 'material_events'
    source_row_id INTEGER,
    episode_trigger TEXT,
    eligibility_date DATE,
    episode_id TEXT,                -- the reviews row this consumption produced, if any (may be
                                     -- NULL if consumption was recorded via an insufficient_data_cases
                                     -- path that hasn't resolved yet -- not currently used that way,
                                     -- reserved for future use)
    consumed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (ticker, source_table, source_row_id)
);

-- Episode entries: append-only. Exactly one row per episode, written only once the applicable
-- entry session has actually opened (see next_market_open_after logic below). This resolves the
-- immutability-vs-future-price conflict: reviews is frozen at decision time; entry prices are
-- recorded separately, later, once they exist. All three entry prices are OPENS (not closes),
-- to match the frozen open-to-close return calculation. The sector benchmark ticker is copied
-- here and frozen for this episode's entire outcome-tracking lifetime -- if security_metadata
-- is later updated for this ticker, this episode keeps using the benchmark it entered with.
CREATE TABLE IF NOT EXISTS episode_entries (
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
CREATE TABLE IF NOT EXISTS recommendation_outcomes (
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

-- ---------------------------------------------------------------------------
-- Enforcing immutability at the database level (not application convention).
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS prevent_reviews_update
BEFORE UPDATE ON reviews
BEGIN
    SELECT RAISE(ABORT, 'reviews rows are immutable; insert a new episode referencing corrects_episode_id instead');
END;

CREATE TRIGGER IF NOT EXISTS prevent_reviews_delete
BEFORE DELETE ON reviews
BEGIN
    SELECT RAISE(ABORT, 'reviews rows are immutable; corrections must be new episodes');
END;

CREATE TRIGGER IF NOT EXISTS prevent_outcomes_update
BEFORE UPDATE ON recommendation_outcomes
BEGIN
    SELECT RAISE(ABORT, 'recommendation_outcomes rows are append-only; insert a new row per horizon instead');
END;

CREATE TRIGGER IF NOT EXISTS prevent_outcomes_delete
BEFORE DELETE ON recommendation_outcomes
BEGIN
    SELECT RAISE(ABORT, 'recommendation_outcomes rows are append-only and may not be deleted');
END;

CREATE TRIGGER IF NOT EXISTS prevent_entries_update
BEFORE UPDATE ON episode_entries
BEGIN
    SELECT RAISE(ABORT, 'episode_entries rows are append-only once entry prices are recorded');
END;

CREATE TRIGGER IF NOT EXISTS prevent_entries_delete
BEFORE DELETE ON episode_entries
BEGIN
    SELECT RAISE(ABORT, 'episode_entries rows are append-only and may not be deleted');
END;
