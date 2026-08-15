# GMGN → Dune pre-screen for cost control

**Status:** Proposed for review; not implemented

**Purpose:** Reduce paid Dune executions without silently deleting GMGN observations or changing the research population. This document describes a deterministic pre-screen that runs after GMGN import and before the Dune measurement planner.

## Executive recommendation

Do not use a single “looks promising” score to decide what reaches Dune. That would use an unvalidated proxy, select on the outcome we are trying to measure, and make the resulting Patterns report biased.

Instead, keep every GMGN row in SQLite, assign it a transparent measurement disposition, and send only the **research-priority queue** to Dune:

1. remove exact duplicates (already handled by the GMGN source identity index);
2. reject only rows that cannot form a valid historical query;
3. collapse highly repeated observations into a token-level measurement unit;
4. stratify the remaining queue by signal type and capture date;
5. measure a fixed core sample from every stratum, then spend the remaining budget on priority strata;
6. retain a small random audit sample from every excluded stratum so the filter can be tested.

This saves calls while preserving an estimate of what the filter may be missing.

## What the current code does

The browser importer normalizes GMGN events into `gmgn_signals` and preserves the complete `raw_payload`. The normalized fields currently available are:

- `token_address`, `signal_type`, `observed_at`, and `captured_at`;
- `market_cap` / `query_market_cap`;
- `trigger_at`, `trigger_mc`, `first_trigger_mc`;
- `triggering_wallet`, `raw_wallet_labels`, `source_url`;
- `chain`, `source`, `source_event_id`, `signal_times`, `signal_times_by_type`;
- query-time `query_ath` and `query_cur_data`.

Missing optional fields are retained and logged as validation issues; they are not currently reasons to discard a row.

The measurement planner currently considers every signal with a non-null `token_address` and `observed_at`. It protects signals that are already complete, waiting for a future checkpoint, retry-delayed, or in-flight. `Measure eligible` therefore avoids duplicate Dune work **after** a signal has entered the outcome pipeline, but it does not yet apply a research-priority filter before the first query.

The Dune query is submitted in batches. A batch is the cost unit, and each batch scans the distinct token set represented in its IDs. The main cost lever is therefore fewer batches and fewer distinct tokens—not merely fewer repeated rows inside a batch.

## Proposed disposition states

These are collection states, not financial judgments:

| Disposition | Meaning | Dune action |
|---|---|---|
| `eligible_core` | Valid, non-duplicate, priority observation selected for the core sample | Submit |
| `eligible_audit` | Randomly selected from a normally excluded stratum | Submit |
| `deferred_repeat` | Observation is not the lifetime-first token/type research unit; raw row remains stored | Do not submit in the core queue |
| `deferred_budget` | Valid row outside the current budget after core and audit quotas are filled | Do not submit now |
| `invalid_for_query` | Missing/invalid token address, signal type, or UTC observation time | Do not submit; retain and explain |
| `already_measured` | Existing outcome is complete; retry/in-flight status is tracked separately by the measurement planner | Do not submit |

`deferred_*` must remain re-evaluable. A later budget increase, new capture window, or changed cooldown should be able to promote a deferred row without re-importing it.

## Safe first-stage rules

These rules do not use Dune outcomes, returns, or future prices, so they are suitable for the first implementation.

### 1. Hard data-validity gate

Require (with the current ingestion contract):

- a non-empty token address; strict base58 validation is intentionally deferred because the existing importer treats addresses as opaque source values and older fixtures use placeholders;
- a recognized numeric `signal_type`;
- a valid UTC `observed_at` (prefer GMGN `trigger_at`, as the importer already does);
- a supported chain (`sol` for this project).

Rows failing this gate remain immutable in `gmgn_signals` with `invalid_for_query` and an explicit reason. Never silently drop them.

Do not require `market_cap`, wallet labels, triggering wallet, or source URL for the core gate. They are optional in the current feed and requiring them would systematically remove otherwise queryable signals.

### 2. Exact and semantic duplicate control

The existing `(source, chain, source_event_id)` identity index should remain the first line of defense. Add a second, explicit research-unit rule aligned with `src/db/patterns.ts`'s `firstByTokenType` behavior:

- group by `token_address + signal_type`;
- sort by `observed_at`;
- submit only the **single lifetime-first observation** for the core research queue;
- keep every later observation as `deferred_repeat`, with later observations eligible only for the audit sample or an explicitly versioned secondary study.

This prevents a token that fires the same type repeatedly—whether minutes or hours apart—from consuming Dune calls for observations that the current Patterns report will later discard. It must not delete the rows or claim that the later signals did not happen. A cooldown may still be useful for operational throttling, but it must not define the core research unit unless Patterns is changed and versioned to use the same unit.

For aggregate research, also report a token-cluster count. Repeated signals from one token are correlated and should not be counted as independent evidence.

### 3. Cohort linkage as a priority, not a hard exclusion

Signals matching an imported Dune cohort address can be placed in the core queue. Unmatched signals should not be discarded: keep a bounded audit sample and retain the remainder as `deferred_budget`.

This is important because cohort linkage is useful for the planned research question but is not proof that an unmatched signal is invalid. A hard exclusion would answer a narrower question without recording that the population changed.

### 4. Stratified budget allocation

Allocate the Dune budget across:

- signal type;
- capture date (UTC date);
- optionally cohort-matched vs unmatched.

Suggested starting allocation per run:

- one core quota for every signal type with at least one valid lifetime-first row;
- prioritize capture-date diversity before adding more same-date tokens; target at least 3 independent UTC capture dates where available, matching the current Patterns reliability gate;
- only one lifetime-first observation per token/type in the core quota;
- reserve 10–20% of the total budget for random audit rows from deferred strata;
- spend the remaining budget proportionally to the number of valid clusters, not raw signal-row count.

The exact numbers are configuration, not a discovered truth. They must be recorded with each measurement run. The current report constants (`MIN_RELIABLE_SAMPLE = 10`, `MIN_CAPTURE_DATES = 3`) should be referenced rather than inventing a quota that can fill with 20 observations from one day and still fail the date-diversity requirement.

### 5. Time and maturity gate

Do not spend a call on a checkpoint that cannot yet mature. The existing planner already marks future checkpoints as pending; the pre-screen should use that state to avoid submitting a brand-new observation when the only desired horizon is still in the future.

This should be a scheduling decision, not an exclusion. Once the signal or its selected horizon becomes eligible, it can be promoted.

### 6. First-pass screening versus retries

The pre-screen controls **new first-pass submissions**. It must not hide or reset the existing measurement state machine:

- `complete` stays complete and is never resubmitted;
- `pending_target_time` stays pending until its target matures;
- `retry_eligible` may be resubmitted only if the original signal was in the core or audit queue and the retry policy allows it;
- `retry_exhausted` remains visible and is not promoted by a fresh pre-screen run without an explicit operator decision;
- `in_flight` / timed-out runs must go through reconciliation, never through a second submission;
- an unavailable checkpoint after a completed run is not silently converted into a new `eligible_core` row.

The disposition should therefore include the planner state and run IDs, or reference them, rather than collapsing all of these cases into `already_measured`.

## Rules that should not be used yet

Do not pre-screen using:

- historical return, median return, price change, ATH, or any Dune-derived outcome;
- a wallet label as proof that a signal is good or bad;
- a market-cap threshold chosen because it improves an existing result;
- `query_ath`, `cur_data`, or query-time market cap as if they were trigger-time facts;
- a signal-type allowlist based only on the current Patterns table;
- “only type 7” or any other type-specific filter without an audit sample.

These rules would create outcome-dependent selection bias. They can be evaluated later as explicitly versioned research hypotheses, but they should not control the first measurement dataset.

## Why a small audit sample is mandatory

If only selected rows reach Dune, the resulting returns describe the selected queue, not all GMGN signals. A fixed random audit sample gives us an estimate of:

- how many deferred rows would have had usable Dune trades;
- whether the filter disproportionately removes a signal type or capture date;
- whether repeated-observation collapsing changes the observed outcome distribution;
- whether “unmatched cohort” rows are systematically different.

The audit sample should be selected with a deterministic seed and store its rule version, stratum, and selection reason. It must not be chosen by looking at future outcomes.

## Proposed implementation shape

Add a read-only planner layer before `buildMeasurementPlan`/`measureDuneOutcomes`:

1. `src/dune/prescreen.ts` computes a disposition for every `gmgn_signals` row using only GMGN fields, cohort linkage, prior Dune-run state, and current time.
2. Persist the decision and rule version in an append-only table (for example `dune_measurement_prescreen`) rather than overwriting the signal.
3. Extend the measurement plan with counts by disposition, type, date, and cohort match.
4. Make the Dune submit path consume only `eligible_core` + `eligible_audit` IDs.
5. Add a UI summary showing `captured → valid → core → audit → deferred → already measured` before the user starts a run.
6. Store the exact budget, cooldown, seed, and rule version with the Dune run archive.

The planner must be idempotent: recomputing it with the same database state, current-time bucket, and seed produces the same IDs. A new GMGN import should add new dispositions; it must not rewrite historical raw observations.

## Review questions for the next agent

1. Is a 30-minute token/type cooldown appropriate, or should it be 15 minutes / one signal per token per UTC hour?
2. Should the core unit be the first signal per token/type, or the first signal per token across all types? The latter saves more calls but prevents fair type comparisons.
3. What per-run Dune budget is acceptable, and should the audit reserve be fixed at 10%, 15%, or 20%?
4. Should unmatched cohort rows receive a guaranteed audit quota or only a proportional quota?
5. Should malformed optional fields remain eligible (recommended) while only required-field failures are excluded?
6. What minimum number of independent capture dates is required before a type receives more than its core quota, and should date diversity always outrank additional same-date tokens?
7. Is the deterministic audit seed persisted in the run archive and visible in the UI?

## Acceptance criteria before implementation

- Every imported GMGN row remains queryable and has exactly one disposition with a reason.
- No Dune outcome, return, or future price is read by the pre-screen.
- Lifetime-first token/type selection reduces submitted IDs without deleting source rows; any operational cooldown is separate from the research unit.
- Every signal type and capture date with valid observations receives either core or audit representation when budget allows.
- Re-running the same pre-screen is idempotent and creates no duplicate Dune execution.
- The UI clearly reports the number deferred by each rule and the number submitted to Dune.
- The full raw GMGN payload and the pre-screen decision/version are both archived for review.
