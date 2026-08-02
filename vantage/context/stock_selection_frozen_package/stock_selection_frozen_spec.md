# Stock-Selection Automation — Frozen Specification

**Status:** FROZEN. Do not alter any threshold, group definition, or label rule below until the
sample requirements in Section 11 are met. Any change made before then invalidates the
forward-tracking cycle and must restart the sample count from zero.

**Frozen date:** [fill in on implementation start]
**Minimum freeze period:** 90 days AND 30–50 unique stock-event episodes (whichever is later)

---

## 1. Purpose

Danelfin (or an equivalent ranking source) is used **only as an eligibility filter** — it
answers "which stocks should we examine?" It is not scored and does not count as evidence
toward a decision.

Every candidate that clears eligibility is scored on three **separate evidence groups**
(described as "separate" rather than "independent" since Context evidence such as a guidance
change can still influence the Earnings group's analyst-revision data with a lag; this overlap
is acknowledged, not eliminated — see Section 14): Earnings, Market, Context. Each group
produces a score of −1, 0, or +1. The scores combine into one of four labels:
**Confirm / Mixed / Reject / Wait**.

---

## 2. Group scoring definitions

### 2.1 Earnings

| Score | Condition |
|---|---|
| +1 | Latest reported EPS beat estimate **AND** next-quarter EPS estimate rose over the trailing 30 days |
| 0 | Results or revisions are mixed or flat |
| −1 | Latest reported EPS missed estimate **OR** next-quarter EPS estimate fell over the trailing 30 days |

### 2.2 Market

Excess return = stock's 3-month total return minus SPY's 3-month total return.

| Score | Condition |
|---|---|
| +1 | Price > 50-day MA, **AND** 50-day MA > 200-day MA, **AND** excess return ≥ +2% |
| 0 | Neither the +1 condition nor the −1 condition is met |
| −1 | Price < 200-day MA, **OR** excess return < −5%, **OR** high-volume breakdown triggers |

**Excess return band boundaries (frozen, no gaps/overlaps):**
- +1: excess return ≥ +2% (inclusive lower bound, unbounded above)
- 0: −5% ≤ excess return < +2%
- −1: excess return < −5%

**High-volume breakdown definition:** stock closes below its 200-day moving average on volume
≥ 1.5× its trailing 30-day average daily volume.

### 2.3 Context

| Score | Condition |
|---|---|
| +1 | Company raised formal guidance, **OR** a meaningful open-market insider cluster occurred |
| 0 | Guidance maintained **AND** no material event |
| −1 | Guidance cut, **OR** serious investigation begins, **OR** accounting/restatement issue, **OR** unexpected senior-executive (CEO/CFO) departure, **OR** comparable major negative event |

**Meaningful insider cluster definition:** at least 2 different officers/directors, each
purchasing at least US$50,000 in open-market stock, within a 5-trading-day window.

---

## 3. Record-keeping requirement

For every group score assigned to every episode, store the **exact underlying fact** that
produced it (e.g., "next-Q EPS estimate rose from $1.02 to $1.04 over 30 days," not just
"Earnings = +1"). This is required to later detect duplicated evidence across groups (e.g., a
guidance raise that also drove the Earnings-group revision).

---

## 4. Missing-data policy

Missing data must never be treated as neutral (score 0). A missing required input is a
different condition entirely from a genuinely neutral/flat reading, and conflating the two
would let episodes receive a real label (Confirm/Mixed/Reject/Wait) built on absent evidence.

**Required inputs, by group:**
- Earnings: latest actual EPS vs. estimate, and the EPS-estimate value from 30 days prior. The
  30-days-prior lookup uses the most recent `estimate_snapshots` row dated on or before
  `as_of_date − 30 calendar days`, accepting a snapshot up to **5 calendar days** older than
  that target date (i.e., any snapshot in `[as_of_date − 35, as_of_date − 30]`). If no snapshot
  falls in that window, the 30-day-prior estimate is treated as missing and the episode routes
  to `insufficient_data_cases` — do not fall back to an older snapshot outside this tolerance,
  and do not silently skip the revision check.
- Market: at least 200 trading days of price history, current price, 50/200-day MAs, SPY return
  over the same 3-month window, 30-day average volume
- Context: guidance status as of the applicable window (Section 5), insider-transaction data
  for the applicable window, material-event data for the applicable window
- Wait check: a confirmed or estimated next earnings date

**Rule:** if any required input for a group is missing, do not compute a score for that group,
and do not issue Confirm, Mixed, Reject, or Wait for the episode, and do not create a `reviews`
row. `insufficient_data` is **not** a valid value of `reviews.decision` — it is recorded only in
a separate audit structure (see implementation prompt), which does not count toward the 30–50
episode sample in Section 11.

**One case per episode, not one row per missing field:** a single stock-episode with multiple
missing inputs (e.g., a missing 30-day-old estimate *and* a missing SPY return) must be recorded
as **one** audit case, not one row per missing field. If each missing field created its own
independent audit row, each could later resolve on its own and produce multiple `reviews` rows
for what should be a single episode. The audit structure therefore separates the case
(one per episode attempt) from its missing-field list (one-to-many), so that resolving a case
can only ever produce exactly one `reviews` row.

**Retry authorization:** when a stock is first found eligible but fails the required-inputs
check, the audit case must preserve enough information to later complete the review as a
continuation of that same original episode intent, once all missing data becomes available.
Specifically, the audit case stores:
- `episode_trigger`: the trigger (per Section 10) that made the stock eligible for review in
  the first place
- `eligibility_date`: the date that trigger occurred
- `source_candidate_id`: a reference to the originating candidate/eligibility record

When the missing data later becomes available, the resulting `reviews` row is written using the
**preserved original `episode_trigger` and `eligibility_date`** — not a new "data became
available" trigger type. This avoids inventing a tenth episode-trigger category and keeps
episode counting anchored to the original triggering event. A case only resolves once **all** of
its listed missing fields are available. The `reviews` row includes a reference back to the
resolved audit case for traceability.

**Preventing duplicate unresolved cases:** a repeated ingestion run must not create a second
unresolved audit case for the same underlying episode intent (same ticker, same originating
candidate, same trigger, same eligibility date) while an earlier one is still open. At most one
unresolved case may exist per `(ticker, source_candidate_id, episode_trigger, eligibility_date)`
combination at any time; this is enforced at the schema level (see implementation prompt), not
by application-level deduplication logic alone.

---

## 5. Context time window

"Relevant window" for Context-group inputs is frozen as:

- **Guidance and material events:** since the most recent earnings release. On a stock's first
  review, if no prior earnings release exists in the system yet, use the trailing 90 calendar
  days instead.
- **Insider cluster:** the 5-trading-day clustering window (Section 2.3) must complete within
  the trailing 30 calendar days of the review date. An insider cluster that completed more than
  30 calendar days ago does not count as current Context evidence.

**Conflict rule:** if both positive and negative Context evidence exist within the applicable
window (e.g., guidance was raised earlier in the window but a negative material event occurred
later in the same window), **negative evidence overrides positive evidence**. The Context score
is −1 whenever any qualifying negative condition is present, regardless of any positive
condition also present in the same window.

---

## 6. Trading-calendar consistency

Every trading-day-based rule in this specification — the 5-trading-day earnings window, the
5-trading-day insider clustering window, the entry-price timing, and the 7/30/90/180
trading-day outcome horizons — must be computed from a **single shared trading-calendar source**
(one module/service), not recalculated independently in each function. This calendar must
correctly account for weekends, U.S. market holidays, and any exceptional market closures. Using
inconsistent trading-day math across functions would silently break the frozen thresholds above
without appearing as a rule change.

**Entry timing must be timestamp-aware, not date-only.** A function that only takes a date (e.g.
"next session after this date") is ambiguous for a decision made before that day's market open —
it would incorrectly skip an entire trading day that hasn't happened yet. The frozen rule is:

- If `decision_timestamp_utc` falls **before** that calendar day's market open → use **that
  day's** open as the entry price (assuming it is a trading day; otherwise the next available
  session's open).
- If `decision_timestamp_utc` falls **at or after** that day's market open → use the **next**
  trading session's open.
- If the applicable day is a weekend or holiday → use the next available trading session's open.

This requires a timestamp-aware calendar function, not a date-only one — see implementation
prompt for the exact function signature.

---

## 7. Forward-return timing

The decision itself and its eventual entry price are **not known at the same moment** — the
entry price depends on the applicable session's open (per the timestamp-aware rule in Section
6), which does not exist yet when the decision is written. Because `reviews` is immutable
immediately upon being written (Section 12), `entry_date` and entry prices **must not live in
the `reviews` table**. They belong in a separate append-only table populated once the entry
session has actually opened (see implementation prompt for `episode_entries`).

Frozen rules:
- `decision_timestamp_utc`: the exact timestamp the episode's decision was computed and written
  into `reviews`. This is recorded immediately and is part of the immutable row.
- `entry_date`: the trading session whose open applies, determined by the timestamp-aware rule
  in Section 6. Recorded separately, once that session has actually opened.
- **Entry prices, all recorded as opens, not closes:** `stock_entry_open`, `spy_entry_open`, and
  `sector_entry_open` — the opening price of the stock, SPY, and the episode's designated sector
  benchmark, all on `entry_date`. All three are recorded together in `episode_entries` once
  known.
- **Sector benchmark is permanently fixed per episode at entry time.** The ticker looked up from
  `security_metadata.sector_benchmark_ticker` at entry time is copied into `episode_entries` as
  `sector_benchmark_ticker` and used for that episode's entire outcome-tracking lifetime (up to
  180 trading days). If `security_metadata` is later updated for that ticker (e.g., a sector
  reclassification), already-open episodes must keep using the benchmark they were entered
  with — never the current lookup value at outcome-measurement time.
- Outcomes are measured at the close after 7, 30, 90, and 180 **trading days** (per the shared
  trading calendar in Section 6) from `entry_date`. `entry_date` itself is **day 0**, not day 1
  — the 7-trading-day outcome is the close of the 7th trading session *after* `entry_date`,
  computed as `add_trading_days(entry_date, 7)`, not the close of `entry_date` plus 6 more
  sessions or any other off-by-one variant. The same applies to the 30/90/180-day horizons.
- `exit_date`: the trading-day date corresponding to each measured horizon.
- **Returns are calculated open-to-close, not close-to-close:**
  ```text
  stock_return  = (stock close on exit_date  / stock_entry_open)  − 1
  spy_return    = (SPY close on exit_date     / spy_entry_open)    − 1
  sector_return = (sector benchmark close on exit_date / sector_entry_open) − 1
  ```
  This matches the frozen entry-price rule (next applicable session's open), which the
  implementation must not silently substitute with a close-to-close calculation. Fetching only
  closing prices for both entry and exit dates would compute the wrong quantity.

---

## 8. Outcome-table enforcement

`recommendation_outcomes` must enforce `UNIQUE (episode_id, horizon_days)` at the schema level,
so at most one row can ever exist per episode per horizon. `episode_entries` must enforce
`UNIQUE (episode_id)`, since an episode has exactly one entry event. In addition to the
immutability trigger specified for `reviews` (Section 12), add equivalent triggers blocking
`UPDATE` and `DELETE` on `recommendation_outcomes` — the append-only guarantee must hold at the
database level for all forward-tracking tables, not by application convention alone.
`episode_entries` permits one INSERT per episode and no subsequent UPDATE/DELETE.

---

## 9. Final decision order (apply in this exact sequence — no exceptions)

1. **Major red flag present → Reject.** Frozen as an explicit rule, not a judgment call:
   `red_flag = (context_score == -1)`. Since every −1 condition in Section 2.3 already
   constitutes a major negative event (guidance cut, serious investigation, accounting/
   restatement issue, unexpected CEO/CFO departure, or a comparable major negative event),
   a Context score of −1 **always** triggers this rule. There is no partial or graded
   red-flag concept — any qualifying negative Context condition is a red flag.
2. **Earnings release within the next 5 trading days → Wait.** No manual override during the
   first forward-testing cycle. Re-evaluate as a new episode after results are released.
3. **Otherwise, apply the numeric rule below.**

### Numeric rule (applies only after Steps 1–2 clear)

| Condition | Label |
|---|---|
| Total score ≥ 2 | **Confirm** *(note: mathematically this can only occur when neither Earnings nor Market is −1, since each group is capped at +1)* |
| Total score is 0 or 1 | **Mixed** |
| Total score ≤ −1 | **Reject** |
| Earnings and Market have opposite signs (one +1, one −1) | **Mixed**, unless the red-flag rule (Step 1) or the resulting total score already forces Reject |

This table is exhaustive: all 27 possible combinations of the three group scores
(3 groups × {−1, 0, +1}) map to exactly one label with no ambiguity.

**Explicit precedence for implementation** (equivalent to, not a change from, the table above):

1. Red flag → Reject
2. Earnings within 5 trading days → Wait
3. Total score ≤ −1 → Reject
4. Total score ≥ 2 → Confirm
5. Earnings and Market opposite signs → Mixed
6. Otherwise (total is 0 or 1) → Mixed

Checking total ≤ −1 before the opposite-signs rule is what correctly sends an opposite-sign
case with total = −1 to Reject, per the carve-out above.

---

## 10. Episode definition (what counts as a new decision)

A **new episode** is created only when one of the following occurs for a given stock:

- The stock first becomes eligible (enters the candidate list)
- Earnings are released
- Formal guidance changes
- The decision label changes
- M&A is announced
- CEO or CFO departs unexpectedly
- An SEC/regulatory investigation begins
- A major contract win or loss materially changes expectations

Routine daily re-checks of an unchanged stock do **not** create a new episode. Multiple
episodes for the same stock are permitted over time but must each be triggered by one of the
events above.

A delayed completion of a previously recorded `insufficient_data` case (Section 4) is **not** a
new, separate trigger category — it is scored using the original `episode_trigger` and
`eligibility_date` preserved in the audit record, and counts as one episode, not two.

Every episode is identified by a unique `episode_id` (not by ticker+date, since two distinct
triggering events could occur for the same stock on the same date). All related records —
`reviews`, `episode_entries`, `recommendation_outcomes`, source-fact tables, and generated
reports — link via `episode_id`.

---

## 11. Sample requirements before relying on results

- At least **30–50 unique stock-event episodes** (excluding `insufficient_data` audit entries
  that have not yet resolved into a scored episode)
- At least **90 days** elapsed
- Episodes span **several sectors**; no single sector may dominate the sample
- For any historical (non-prospective) spot-check: rate each case using only
  timestamped, as-of-the-time information, **save the rating, then only afterward** reveal
  subsequent price/return performance (blind rating, unblind after)

---

## 12. Immutability and versioning

- `reviews` rows are permanently immutable **immediately upon being written** (enforced at the
  database level, not just by convention). Because entry prices are not yet knowable at that
  moment, `reviews` never contains `entry_date` or any entry price — see Section 7. A
  correction to a past episode is recorded as a **new** episode that references the earlier
  `episode_id` via `corrects_episode_id`, never as an edit to the original row.
- `episode_entries` is append-only: exactly one row is inserted per episode, once the
  applicable entry session's open (per the timestamp-aware rule in Section 6) is actually
  known. No row is ever updated or deleted afterward.
- `recommendation_outcomes` is append-only at the row level: each measurement horizon (7/30/90/
  180 trading days) for a given episode is its own new row, added as that horizon elapses. No
  row in any of these three tables is ever updated or deleted after being written.
- Every `reviews` row carries a `rule_version` tag identifying which version of this frozen
  spec was in effect when it was scored.

---

## 13. What must not change during the freeze period

- Group scoring definitions (Section 2)
- The numeric thresholds (excess return bands, volume-breakdown multiple, insider-cluster
  size/dollar/window, Context time windows in Section 5)
- The missing-data gate and retry-authorization rule (Section 4)
- The decision order and numeric rule (Section 9)
- The episode-triggering event list (Section 10)
- The forward-return timing rules, including the entry/exit split and sector-benchmark fixing
  rule (Section 7)

If any of the above is changed before the Section 11 sample requirements are met, restart the
episode count and the 90-day clock from zero, increment `rule_version`, and log the reason for
the change.

---

## 14. Known open items (not blocking implementation, tracked for later review)

- Guidance changes can influence both the Context score and, with a lag, the Earnings score
  (via analyst revisions). This partial overlap is accepted as a minor residual correlation, not
  eliminated. Use the recorded underlying facts (Section 3) to check how often this occurs.
- Danelfin/eligibility-source API field availability and free-tier limits must be reverified
  before the ingestion pipeline is built.
- A second candidate source (e.g., a simple earnings-revision/momentum screen) may be added
  only after the first forward-testing cycle completes — not during it.
