# Outcome calculation and improvement proposal

**Status:** Proposed for independent review  
**Prepared:** 2026-08-13  
**Scope:** GMGN signal-to-Dune outcome measurement and the Patterns report  
**Implementation status:** This document describes the current implementation and proposes changes. It does not implement them.

## 1. Review objective

This report documents, in reproducible terms:

1. how a captured GMGN signal becomes a Dune price query;
2. how the application interprets Dune rows;
3. how it calculates returns and signal-type verdicts;
4. what the current SQLite evidence shows for signal type 7;
5. which shortcomings are data-availability problems and which are application problems; and
6. the proposed corrections and their acceptance criteria.

The intended reviewer should verify the claims against the cited code and the append-only records in `.data/crypto-research.sqlite` before approving implementation.

## 2. Executive assessment

The application currently preserves the underlying evidence well, and its basic return formula is straightforward. It correctly excludes future checkpoints and exact same-trade comparisons from return calculations.

The central workflow defect is in measurement scheduling: the UI calls a signal “complete” when checkpoint rows with the expected labels exist, even when those rows contain no usable prices or were measured before their target times. Dune's left join normally creates every checkpoint row regardless of whether a trade was found. As a result, a failed or premature measurement can be permanently skipped by **Measure All** unless the user manually selects and measures it again.

The current Patterns verdict is also too confident for sparse, selectively available data. It requires 10 fresh rows and 10 distinct tokens, but it has no minimum coverage requirement. For Type 7, only 31 of 1,249 captured signals have genuine +3h comparisons, and all 31 come from the older August 11 subset. The 1,218 newer August 13 signals contribute no genuine outcomes. A verdict calculated from that subset must not be interpreted as a verdict on all captured Type 7 signals.

## 3. Current data flow

```text
GMGN browser event
  -> normalize and append to gmgn_signals
  -> select signal IDs in the UI
  -> submit batches of at most 25 signals to Dune
  -> store query, raw response, timestamps, archive path and SHA-256
  -> interpret raw checkpoint rows
  -> merge completed runs, newest run wins per signal
  -> classify each horizon as missing, stale or fresh
  -> calculate per-type descriptive statistics and verdict
```

### 3.1 Signal timestamp and identity

The browser importer maps GMGN's `sig_t_at` field to `trigger_at` and `sig_t` to `signal_type` in [`src/gmgn/browserImport.ts`](../src/gmgn/browserImport.ts#L32-L48). The normalizer uses `observed_at` when supplied, otherwise `trigger_at`, and converts it to UTC ISO format in [`src/gmgn/ingest.ts`](../src/gmgn/ingest.ts#L40-L51) and [`src/gmgn/ingest.ts`](../src/gmgn/ingest.ts#L67-L70).

Therefore, checkpoint times are based on the GMGN event time. They are not based on the browser-import time, the Dune-request time, or the current time when the table is viewed.

### 3.2 Configured checkpoints

The configured horizons are `signal`, `+5m`, `+15m`, `+30m`, `+1h`, and `+3h`. They are declared in [`src/dune/outcomes.ts`](../src/dune/outcomes.ts#L12-L22).

Adding a checkpoint adds a row to the same SQL execution. It does not create a separate Dune API request for each checkpoint.

### 3.3 Dune price query

For each signal and checkpoint, the generated SQL:

1. reads both purchased-token and sold-token sides from `dex_solana.trades`;
2. calculates `price_usd` as `amount_usd / token_amount`;
3. discards trades without positive USD value or token amount;
4. considers trades at or before the checkpoint and within the preceding 24 hours;
5. chooses the latest matching trade; and
6. resolves same-second ties with transaction ID and outer/inner instruction indexes.

The query is generated in [`src/dune/outcomes.ts`](../src/dune/outcomes.ts#L24-L28). The deterministic ordering key is:

```sql
ORDER BY
  t.block_time DESC,
  t.tx_id DESC,
  t.outer_instruction_index DESC,
  t.inner_instruction_index DESC
```

This ordering corrected an earlier nondeterministic same-second selection problem. It makes repeat executions choose the same stored trade row when the underlying data is unchanged.

### 3.4 Request size and persistence

The backend reads at most 25 supplied IDs for an execution in [`src/dune/outcomes.ts`](../src/dune/outcomes.ts#L92-L97). The UI divides Measure All into sequential batches of 25 in [`ui/main.tsx`](../ui/main.tsx#L372-L385).

Each run stores:

- signal IDs;
- exact SQL;
- Dune execution ID;
- status;
- complete raw result;
- archive path and SHA-256;
- requested and completed timestamps.

The schema is defined in [`src/db/schema.ts`](../src/db/schema.ts#L237-L253). Completion persists the raw response before returning interpreted rows in [`src/dune/outcomes.ts`](../src/dune/outcomes.ts#L109-L114).

No prior Dune run is overwritten. However, the read model chooses one displayed timeline per signal, as described below.

### 3.5 Premature-checkpoint interpretation

The application compares each checkpoint's target time with the Dune run's `completed_at`. If the target is later than completion—or either timestamp cannot be parsed—the checkpoint is treated as pending. Its interpreted price and matched-trade provenance are returned as `null`, but the stored raw result remains unchanged. See [`src/dune/outcomes.ts`](../src/dune/outcomes.ts#L40-L62) and [`src/dune/outcomes.ts`](../src/dune/outcomes.ts#L64-L89).

The interpreted statuses are:

| Condition | Status |
|---|---|
| Target time is later than run completion | `checkpoint not yet reached` |
| Target has elapsed but no qualifying Dune trade exists | `not available` |
| Target has elapsed and a price exists | `received` |

### 3.6 Combining multiple executions

On refresh, the API reads every completed run from oldest to newest. For each signal ID, the newest completed run replaces the entire older timeline in the in-memory map. This behavior is in [`src/dune/outcomes.ts`](../src/dune/outcomes.ts#L126-L143).

Consequences:

- all historical raw runs remain auditable;
- the displayed calculation uses only the newest run for a signal;
- it does not choose the best available result separately for each checkpoint;
- a newer incomplete timeline can displace older usable interpreted checkpoints.

### 3.7 Missing, stale and fresh comparisons

For each horizon, Patterns compares its checkpoint with the `signal` checkpoint in [`src/db/patterns.ts`](../src/db/patterns.ts#L45-L58):

| Classification | Current rule |
|---|---|
| Missing | Baseline or target is absent/null, or baseline price is zero |
| Stale | Baseline and target matched the exact same trade timestamp |
| Fresh | Both prices exist and the matched timestamps differ |

The return calculation for a fresh row is:

```text
return % = ((target price - signal price) / signal price) * 100
```

An exact same-trade comparison is excluded rather than treated as a 0% return. That is a defensible choice: reusing one old trade does not prove the token's price remained unchanged.

### 3.8 Aggregate statistics

Only fresh comparisons contribute to the following statistics in [`src/db/patterns.ts`](../src/db/patterns.ts#L60-L98):

- `upCount`: returns strictly greater than zero;
- `upPct`: `upCount / fresh count * 100`;
- average: arithmetic mean of fresh returns;
- median: nearest-rank 50th percentile using `ceil(n * 0.5) - 1` after sorting;
- p25: nearest-rank 25th percentile;
- worst and best: minimum and maximum fresh returns;
- distinct tokens: unique token addresses among fresh comparisons.

Missing and stale rows are excluded from all return denominators.

### 3.9 Current verdict logic

A group is considered mechanically `reliable` when it has at least 10 fresh comparisons and at least 10 distinct tokens. The verdict then follows [`src/db/patterns.ts`](../src/db/patterns.ts#L73-L80):

| Condition | Verdict |
|---|---|
| Reliability threshold not met | `insufficient data` |
| Median > 0, at least 50% up, average >= 0 | `promising but fragile` |
| Median > 0 and at least 50% up, but average < 0 | `mixed` |
| Otherwise | `weak` |

This is descriptive logic, not a statistical significance test or proof of predictive value.

## 4. Verified Type 7 database evidence

The following read-only audit was performed against `.data/crypto-research.sqlite` on 2026-08-13. Counts were reconstructed from `gmgn_signals` and the raw JSON in every completed `dune_outcome_runs` row, applying the same pending/stale/fresh rules as the application.

### 4.1 Capture and measurement coverage

| Measure | Count |
|---|---:|
| Captured Type 7 signals | 1,249 |
| Distinct Type 7 token addresses | 1,133 |
| Type 7 signals submitted to Dune at least once | 1,249 |
| Type 7 signals never submitted | 0 |
| Measured exactly once | 1,218 |
| Measured exactly twice | 19 |
| Measured three or more times | 12 |
| Type 7-related Dune runs | 96 |
| Completed Type 7-related runs | 94 |
| Raw Type 7 checkpoint rows across completed runs | 7,693 |
| Completed-run archives present | 94 of 94 |
| Archive hashes matching files on disk | 94 of 94 |

### 4.2 Latest interpreted outcome coverage

| Horizon | Missing | Stale | Fresh | Distinct fresh tokens |
|---|---:|---:|---:|---:|
| +5m | 1,080 | 140 | 29 | 23 |
| +15m | 1,080 | 139 | 30 | 24 |
| +30m | 1,090 | 128 | 31 | 25 |
| +1h | 1,150 | 68 | 31 | 25 |
| +3h | 1,218 | 0 | 31 | 25 |

The missing counts decompose further:

- 1,080 signals have no usable signal-time baseline price in their newest run;
- an additional 10 are pending at +30m;
- an additional 70 are pending at +1h;
- an additional 138 are pending at +3h.

No Type 7 +5m or +15m checkpoint was pending in its newest run. Their low fresh counts therefore cannot be explained by checkpoint age alone.

### 4.3 Temporal selection effect

The 31 Type 7 signals captured on August 11 had usable signal-time prices. The newer August 13 group contained 1,218 signals, but only 138 had baseline prices and none produced a fresh +5m comparison:

| Observation period | Signals | Baseline price available | Fresh +5m |
|---|---:|---:|---:|
| 2026-08-11 | 31 | 31 | 29 |
| 2026-08-13 | 1,218 | 138 | 0 |

All 29 fresh +5m and all 31 fresh +3h Type 7 comparisons currently come from August 11. The large new import has not contributed to the Type 7 return statistics.

This temporal break is consistent with Dune indexing lag or incomplete coverage for very recent GMGN tokens, but the stored evidence alone cannot distinguish among:

- delayed Dune ingestion;
- tokens or venues not represented by qualifying `dex_solana.trades` rows;
- a mismatch between GMGN's event-time semantics and the trades visible to the query.

It is not accurate to label all 1,080 baseline failures simply “too fresh.” That hypothesis needs a later controlled retry to confirm it.

### 4.4 Current Type 7 descriptive results

These values use only fresh comparisons:

| Horizon | Fresh | Up % | Average | Median | P25 | Worst | Best |
|---|---:|---:|---:|---:|---:|---:|---:|
| +5m | 29 | 75.86% | -2.83% | 0.91% | 0.21% | -83.07% | 59.49% |
| +15m | 30 | 73.33% | 7.48% | 2.07% | -0.45% | -82.69% | 192.42% |
| +30m | 31 | 67.74% | -7.06% | 2.92% | -14.56% | approximately -100% | 57.91% |
| +1h | 31 | 67.74% | -5.55% | 5.19% | -27.04% | approximately -100% | 126.25% |
| +3h | 31 | 61.29% | -3.36% | 13.51% | -45.32% | approximately -100% | 98.22% |

These results describe a small, older, highly selected subset. They do not support a conclusion about the full Type 7 population.

## 5. Problems requiring correction

### P0: Row presence is incorrectly treated as successful completion

The UI's Measure All planner considers a signal complete when every configured label exists, without examining status, price, target time, or matched trade. See [`ui/main.tsx`](../ui/main.tsx#L372-L377).

Because the Dune query uses a left join, it normally returns each label even when no trade exists. Thus all 1,249 Type 7 signals appear structurally complete while 1,080 have no baseline price.

**Impact:** Recent missing or premature measurements are skipped indefinitely by Measure All. Waiting for Dune to catch up does not trigger a retry.

### P0: Verdict reliability ignores coverage and temporal selection

The current reliability gate uses only fresh-row count and distinct-token count. It does not consider:

- fresh comparisons as a percentage of captured or measured signals;
- whether observations cover multiple independent capture windows;
- whether one older period supplies all usable data;
- Dune availability differences between older and newer tokens.

**Impact:** Type 7 satisfies the code's minimum sample rule with 31 rows and 25 tokens even though only 2.5% of its 1,249 signals are fresh at +3h and every one is from August 11.

### P1: “Fresh” does not enforce proximity to the checkpoint

The SQL accepts the latest trade within 24 hours before a checkpoint. Patterns calls the comparison fresh whenever its matched timestamp differs from the baseline's timestamp.

**Impact:** A different but old trade may count as a checkpoint observation even if it is not reasonably close to the checkpoint. The report does not expose `checkpoint target - matched trade time`.

### P1: Newest run replaces the entire timeline

The current merge selects the latest completed run per signal, not the latest usable observation per checkpoint.

**Impact:** A later incomplete measurement can displace an earlier usable interpreted checkpoint in the live report, even though both raw runs remain preserved.

### P1: Repeated signals are not an independent sample

The report displays distinct token count, but every signal remains a separate return observation. Repeated Type 7 events for one token can therefore influence aggregate statistics more than a token observed once.

**Impact:** Standard signal-level medians and up percentages may overstate the effective independent sample size.

### P2: Missingness is too coarsely reported

The Patterns calculation combines absent rows, null baseline prices, null target prices, pending checkpoints and malformed values into `missing`.

**Impact:** A reviewer cannot tell from the Patterns table whether to wait, retry, change the Dune query, or reject a token as uncovered.

## 6. Proposed improvements

### 6.1 Move measurement planning to the backend

Create a backend measurement planner that calculates eligibility from persisted run data. The UI should request a plan rather than infer completeness from label presence.

Recommended checkpoint states:

- `not_measured`;
- `pending_target_time`;
- `awaiting_source_indexing`;
- `no_qualifying_trade`;
- `stale_same_trade`;
- `usable`;
- `invalid_evidence`.

The planner should return both a state and a reason for every signal/checkpoint.

### 6.2 Make retries selective and rate-limit aware

Measure All should submit only work that can improve the dataset:

- never re-fetch a usable checkpoint by default;
- do not fetch before the checkpoint target time;
- retry missing baselines and elapsed missing targets only after a configurable indexing-delay interval;
- cap retries per signal/checkpoint;
- record the retry reason and previous run ID;
- permit a forced manual remeasurement for audit purposes.

This addresses Dune rate limits while allowing recent data to become usable after indexing catches up.

### 6.3 Normalize checkpoint observations without discarding raw evidence

Add an append-only normalized observation table keyed by run, signal and checkpoint. Suggested fields:

- `run_id`;
- `signal_id`;
- `checkpoint_label`;
- `target_at`;
- `raw_price_usd`;
- `matched_trade_at`;
- transaction/instruction provenance;
- `interpretation_status`;
- `interpreted_at`;
- calculation-version identifier.

The original `raw_result` and archive must remain authoritative and unchanged. The normalized table is an index over that evidence, not a replacement for it.

### 6.4 Use a checkpoint-level canonical-selection rule

For the live report, select a canonical observation separately for each signal/checkpoint. Prefer the newest valid usable observation; otherwise expose the newest failure state. Return its `run_id` so every displayed value can be traced to raw evidence.

Saved Pattern snapshots should retain the exact selected run/checkpoint provenance and calculation version.

### 6.5 Add checkpoint-distance quality control

Calculate:

```text
trade age at checkpoint = checkpoint target time - matched trade time
```

The reviewer should preregister an acceptable maximum age for each horizon. Until that threshold is approved, the UI should display the age distribution and distinguish:

- a genuinely near-checkpoint trade;
- a different but old trade;
- the exact same trade reused from baseline.

### 6.6 Make verdicts coverage-aware

Before emitting any directional verdict, require all of the following:

- minimum fresh comparisons;
- minimum distinct tokens;
- minimum fresh coverage percentage;
- more than one independent capture window/date;
- acceptable missingness and checkpoint-trade-age rates;
- an explicitly selected independence rule.

If any gate fails, the verdict must remain `insufficient coverage`, even if the observed median is positive.

Suggested separation:

- **Data verdict:** sufficient/insufficient coverage and provenance quality.
- **Observed outcome:** descriptive median, P25, up percentage and tail loss.
- **Research verdict:** withheld until the preregistered statistical contract is satisfied.

### 6.7 Define the unit of analysis

Before inferential analysis, choose and version one primary unit:

- first eligible signal per token and signal type;
- first eligible signal per token across all types; or
- all signals with clustered/token-level uncertainty handling.

The UI may still show all raw signals, but it should not imply that repeated signals from the same token are independent observations.

### 6.8 Expand missingness diagnostics

Patterns should report, per type and horizon:

- captured;
- submitted;
- baseline missing;
- target pending;
- target elapsed but unavailable;
- stale same trade;
- usable within approved trade-age threshold;
- distinct usable tokens;
- retry eligible;
- retry exhausted.

This would make “why are there only 31?” answerable directly in the UI.

## 7. Recommended implementation order

1. **Correct the backend completeness/retry model.** This prevents further avoidable Dune usage and allows recent observations to mature.
2. **Add coverage diagnostics and checkpoint provenance.** Verify that retries improve recent August 13 coverage.
3. **Change the canonical merge to checkpoint level.** Preserve run IDs for auditability.
4. **Add coverage gates and an explicit data verdict.** Do not alter outcome labels retroactively without a calculation-version bump.
5. **Preregister checkpoint-age and independence rules.** Only then revise the research verdict logic.

## 8. Acceptance criteria

An implementation should not be approved unless the reviewer can demonstrate all of the following with automated tests and one persisted-data audit:

1. A checkpoint row with `price_usd = null` is not considered successfully measured.
2. A future checkpoint is not submitted before its target time and becomes retry-eligible afterward.
3. A missing recent checkpoint can be retried after the indexing delay.
4. A usable checkpoint is not re-fetched by normal Measure All.
5. Retrying one checkpoint does not remove older raw runs or archives.
6. Every displayed price and return identifies its source run and matched trade.
7. Canonical selection happens per checkpoint, with deterministic rules.
8. A low-coverage group cannot receive a directional quality verdict.
9. Repeated signals expose their distinct-token count and follow the approved unit-of-analysis rule.
10. Pattern snapshots record the calculation version, parameters and exact provenance set.
11. API credentials do not enter SQLite, diagnostic output, raw payloads or archives.
12. The full test suite and production build pass.

## 9. Questions for the independent reviewer

1. Is the proposed retry distinction between `awaiting_source_indexing` and `no_qualifying_trade` observable enough, or should both remain one state until a second failed measurement?
2. What indexing-delay schedule minimizes Dune usage without making the dataset unnecessarily stale?
3. Should canonical selection prefer the newest usable checkpoint or the earliest run that first produced a usable checkpoint?
4. What maximum checkpoint-to-trade age is defensible for +5m, +15m, +30m, +1h and +3h?
5. Should the primary analysis use first signal per token, or retain repeated signals with token-level clustering?
6. What minimum coverage percentage and number of capture dates should be required before a directional verdict is displayed?
7. Should `mixed`, `weak`, and `promising but fragile` remain UI descriptions, or be replaced entirely by preregistered statistical outcomes?

## 10. Review recommendation

Approve the evidence-preservation and deterministic-trade-selection portions of the current design. Do not approve the current completeness planner or treat the current Type 7 verdict as representative.

The first implementation should be the backend, rate-limit-aware measurement planner and expanded missingness report. Outcome scoring should remain unchanged until that correction has produced a broader, independently reviewed coverage sample.

## 11. Implementation update

The first approved slice has now been implemented without deleting or rewriting historical evidence:

- [`src/dune/planner.ts`](../src/dune/planner.ts) provides a versioned `measurement-plan-v2` with retry eligibility and stepped backoff;
- [`src/scripts/server.ts`](../src/scripts/server.ts) exposes `GET /api/dune/measurement-plan`;
- **Measure All** consumes backend eligibility instead of checkpoint-label presence;
- Dune interpreted results now carry source run IDs and matched-trade age in seconds;
- the all-runs read model selects the earliest valid observation independently per checkpoint and uses later runs to fill unresolved checkpoints;
- Patterns is versioned as `signal-type-return-breakdown-v3`, uses the first signal per token/type as its analysis unit, reports matured-signal coverage and capture dates, and refuses its reliability gate unless coverage and temporal gates pass;
- trade age is exposed diagnostically but is deliberately not filtered until a preregistered empirical threshold is approved.

The raw Dune runs and archives remain append-only. The implementation is covered by the planner and canonical-selection tests, and the full test suite currently passes.
