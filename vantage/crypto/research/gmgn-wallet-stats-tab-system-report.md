# System report: GMGN Wallet Stats tab

**Purpose of this document.** A factual description of how the "CopyTrade · GMGN wallet stats"
tab currently works, written for an external reviewer to audit for logical gaps — contradictions,
double-counted or mismatched assumptions, and reasoning errors. It is not a design spec and it
does not argue that the current design is correct. Where the author already knows of an issue,
it is listed in [Section 8](#8-known-open-issues-already-tracked-do-not-re-report) so the review
effort goes toward finding _new_ problems.

Everything below is verified against the code at time of writing (2026-08-22), not written from
memory. File and approximate line references are given so a claim can be checked directly rather
than trusted.

The system's absolute boundary, unrelated to any of the below: this codebase never executes
trades, connects wallets, or signs transactions. Everything described here is descriptive
research over historical data.

---

## 1. What data exists, and where it comes from

Three independent data sources feed this tab, fetched by three independent actions:

| Source                     | What it provides                                                                                                | Fetched by                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| GMGN roster/leaderboard    | Which 100 wallets are being tracked, their rank                                                                 | "Fetch top 100" (roster half)  |
| GMGN trade history         | Every individual buy/sell GMGN reports for a wallet                                                             | "Fetch top 100" (history half) |
| GMGN wallet stats (7d/30d) | Wallet-level aggregate: realized PnL, win rate, buy/sell counts, avg hold time                                  | "Fetch top 100" (stats half)   |
| Dune `dex_solana.trades`   | An independent, delayed price for a _specific_ trade, used to simulate what a copier ~15s later would have paid | "Fetch Dune (N)"               |

All GMGN data is stored append-only where it matters (`copytrade_wallet_stats_events`) alongside
a fast-read "latest" cache (`copytrade_wallet_stats`) — a later fetch cannot destroy an earlier
observation. Dune matches are stored in `copytrade_copy_simulation_runs`/matched-trade tables and
are cumulative: once a trade is matched, it stays matched.

**"Fetch top 100" always fetches the full 100-wallet roster.** It has no concept of skipping a
wallet based on any verdict computed elsewhere in this tab — every button click re-covers the
whole cohort (`src/copytrade/fetch.ts`, `MAX_REQUESTS_PER_WALLET = Infinity`,
`DAILY_TRADE_INSERT_CAP = Infinity` — no application-imposed caps at all currently).

**"Fetch Dune (N)"** is scoped by `researchWalletAddresses` (`ui/main.tsx`, ~line 2627), which is
the full roster (excluding wallets whose GMGN history fetch outright failed, `historyFailed`)
minus two independent exclusion sets:

1. Manual per-row checkboxes in the "Show activity table" panel (persisted to `localStorage`
   across sessions).
2. An opt-in "Skip wallets triage rejected" checkbox (not persisted — resets every session), which
   folds in whatever `eliminationReport.eliminated` currently holds. See Section 5.

Both exclusion sources feed the _same_ set, and a manual re-check on a row overrides either
source identically — there is only one override path, not two.

---

## 2. The main decision table's own scoring model (independent of Section 5)

This tab computes a per-wallet verdict entirely in the browser, from data already fetched and
cached — this is a **separate computation from the "elimination triage" described in Section 5**,
built at a different time, using different source data and different thresholds. Both exist
simultaneously in this tab today. **This is the single most important structural fact in this
report** — see Section 7.

### 2.1 The copy-viability model ("delay" / `copyDelayRows`, `ui/main.tsx` ~line 2707)

For each wallet, computed from the most recently loaded Dune simulation:

```
sim = copySimulation30d[wallet] ?? copySimulation[wallet]
```

`copySimulation30d` is populated only after "Fetch Dune" runs with `periodDays: 30`.
`copySimulation` (no period bound — i.e. the wallet's _entire_ stored history) is populated by a
`useEffect` that is explicitly gated to **not** run while the active sub-tab is `wallet-stats`
(`ui/main.tsx` ~line 2282: `if (!WALLET_STATS_ONLY && copyTradeSubTab !== 'wallet-stats')`). So on
this tab, the fallback value of `sim` — used whenever `copySimulation30d` has no entry for a
wallet — is whatever `copySimulation` happened to hold from a _previous visit to a different
tab_, or `undefined` if none. This fallback is silent: nothing in the UI indicates whether a given
row's `sim` came from the 30-day fetch or from stale full-history data left over from elsewhere.

From `sim`, several derived values:

- `coverage` = `sim.copiedTrades / sim.roundTripsConsidered * 100`, rounded to one decimal.
- `edge` = `simulatedMedianReturnPercent / walletMedianReturnPercent * 100` (only when the
  wallet's own median is positive and finite).
- `delayShare` = `assumedCopierDelaySeconds (15) / medianHoldSeconds * 100`.
- `impossible` = `delayShare >= 100` (the assumed 15-second copy delay is longer than or equal to
  the wallet's typical hold — a copy could not plausibly land in time).
- `fragile` = `delayShare >= 25 && !impossible`.
- `survivedDelay` = `portfolioRealizedPnlUsd > 0 && gasCostComplete === true && coverage >= 100`.

Note `survivedDelay` requires **exactly the ≥100% coverage bar** the elimination triage moved away
from in Section 5 (previously 100%, now 90% + a hidden-loss check there). This model was not
updated when that threshold changed.

### 2.2 The verdict (`unifiedTraderRows`, `ui/main.tsx` ~line 2736)

```
enoughEvidence = coverage === 100 && roundTripsConsidered >= 30 && gasCostComplete === true
freshStats     = newest GMGN stats fetch (7d or 30d) is <= 24h old
historyIncomplete = row.truncated || row.historyFailed || 'requested history window incomplete' in failedRules
historicalPositive = historical30dPnl > 0

verdict =
  historyIncomplete           -> "Needs data"
  delay.impossible            -> "Not copyable"
  !hasStats || !enoughEvidence -> "Needs data"
  !freshStats                 -> "Historical / stale"
  delay.survivedDelay && historicalPositive -> "Tested candidate"
  historicalPositive          -> "Watch"
  else                        -> "Historical screen failed"
```

`enoughEvidence` requires **exactly 100% coverage**, not "at least 30". This is a second,
independent place in the codebase requiring exact 100% coverage (the first is `survivedDelay`
above; a third is the Winners feature, `copyCandidates.ts:258`,
`sim.coverageRatePercent === 100`). All three are separate literal comparisons, not references
to one shared constant.

`sample >= 30` uses `sim.roundTripsConsidered` — this is the _count of round trips the local
database has stored for the wallet in the requested period_, not the count of round trips Dune
successfully priced. A wallet can satisfy `sample >= 30` with `roundTripsConsidered = 30` and
`copiedTrades = 0` (0% coverage) simultaneously; `enoughEvidence` only passes because of the
separate `coverage === 100` clause, but the two thresholds are checking different populations
(considered vs. copied) without either being derived from the other.

### 2.3 Presentation-layer decision states (`ui/main.tsx`, `DECISION_STATES`/`decisionStateFor`)

The six-value `verdict` above is collapsed to four reader-facing states for the "Final decision
panel" and the canonical table's Decision column:

```
'Tested candidate'                        -> passed  ("Passed all tests")
'Watch'                                   -> watch   ("Watch")
'Needs data' | 'Historical / stale'       -> needs_data ("Needs more data")
everything else (incl. 'Not copyable',
  'Historical screen failed')             -> rejected ("Rejected")
```

The finer six-value reason remains available as a hover tooltip on the Decision cell
(`verdictTooltip`). No other part of the UI reads the four-state collapse; it exists only in this
one table and the summary panel above it.

### 2.4 Ranking for the "30-Day Decision Winner" card (`winnerRankedRows`)

The single wallet shown in the hero card at the top of the tab is chosen by:

```
priority = 0 if verdict == 'Tested candidate', 1 if 'Watch', 2 if 'Needs data', 3 else
sort by: priority asc, then portfolioRealizedPnlUsd desc, then simulatedMeanReturnPercent desc,
         then coverage desc, then GMGN rank asc, then name asc
primary30dWinner = first row with verdict === 'Tested candidate' in this order, or null
```

This is a **fourth** independent ranking rule in the tab (alongside the verdict itself, the
elimination triage's sort, and the manually sortable table columns), used only to pick the single
headline wallet.

### 2.5 The evidence-bar filter (independent of all of the above)

Two user-adjustable number inputs, default `minCopiedTrades = 30`, `minCoveragePercent = 70`
(`ui/main.tsx`, reset button values). A row is shown only if:

```
sim.roundTripsConsidered >= minCopiedTrades AND coverage >= minCoveragePercent
```

This is a **third, independently-adjustable threshold pair**, layered on top of the verdict
(which already has its own hard-coded `coverage === 100, sample >= 30`). A wallet can have verdict
`"Tested candidate"` and still be hidden from the visible table by these bars if the user has
raised `minCoveragePercent` above 100 (not possible, capped) or `minCopiedTrades` above the
wallet's `roundTripsConsidered`. The "N below the evidence bars" count reflects this filter only,
not the verdict.

---

## 3. Data freshness

Two unrelated freshness concepts exist:

1. **`freshStats`** (Section 2.2): binary, feeds the verdict directly. `<= 24h` old = fresh,
   otherwise the wallet is forced to `"Historical / stale"` regardless of any other computed
   result.
2. **The new "Data freshness" column** (`freshnessLabel`, `ui/main.tsx`): a human string ("2h
   ago", "3d ago") shown per row, independently computed from the _same_ underlying `fetchedAt`
   value, using the same 24-hour boundary to decide whether to render it in a warning color.

These two use the identical timestamp and the identical 24h cutoff, so they should never visibly
disagree — but they are two separate code paths computing the same threshold, not one shared
function.

**No freshness concept exists for the Dune data.** A wallet's `coverage`/`sim` values carry no
visible "as of" timestamp anywhere in this tab. A Dune simulation run three days ago and one run
three minutes ago are indistinguishable in the decision table.

---

## 4. Data quality facts this system has already established

These are not part of the tab's logic — they are prior findings from this project that a reviewer
should treat as ground truth when judging whether a given threshold is defensible:

- Median Dune coverage across the cohort is ~54.5%; coverage gaps are not random. Dune fails to
  match thin, newly-launched tokens, and this project measured (pooled across the whole cohort)
  that unmatched trades are ~2x more likely to be >100% winners (20.5% vs 12.1%).
- That same pooled statistic does **not** hold per-wallet: measured live, the median per-wallet
  gap in big-win rate between matched and unmatched trades is 0.0pp, and the loss-rate gap runs
  the _opposite_ direction from the pooled figure in most wallets (68 of 93 wallets have unmatched
  trades that lose _more_ often, not less). The pooled number is likely dominated by a handful of
  very-high-volume wallets (a Simpson's-paradox shape). **The elimination triage's own
  user-facing intro text (Section 5) still references the pooled 2x figure as a reason it exists**
  — it is directionally true as motivation but should not be read as a per-wallet estimate.
- GMGN's own `avg_holding_period` field, from the same stats endpoint this tab reads for
  `medianHoldSeconds`-adjacent figures, was separately found to diverge from the true measured
  median hold time by three to four orders of magnitude in at least one verified case. This tab's
  `hold`/`delayShare`/`impossible`/`fragile` values are computed from **locally stored trade
  data**, not from that specific unreliable GMGN field — but this is worth an explicit check by a
  reviewer, not an assumption.

---

## 5. The elimination triage ("Advanced diagnostics" → "Which wallets can we stop chasing?")

A server-computed, second and independent judgment system, added later than the main decision
table and using its own thresholds. Route: `GET /api/copytrade/elimination`
(`src/scripts/server.ts`). Core logic: `src/copytrade/eliminationFilter.ts`.

### 5.1 Inputs

- `computeCopyTradeReport(periodDays: 30, traderLimit, rosterSnapshotId)` — note this is **30
  days**, chosen specifically to match GMGN's own PnL snapshot (Section 5.3 explains why).
- `computeCopySimulationReport(walletAddresses, periodDays: 30)` — the Dune simulation, **also
  explicitly bounded to 30 days**. (An earlier version of this endpoint omitted `periodDays`
  entirely, which `readRecentRoundTrips` treats as "no cutoff at all" — i.e. the wallet's full
  stored history. That bug was found and fixed; flagged here only so a reviewer checking git
  history understands why an unbounded-window comparison might appear in past commits.)

This computation is **entirely independent of `copySimulation`/`copySimulation30d` in Section 2**
— it is not the same `sim` objects, not cached the same way, and computed server-side on demand
(button click) rather than client-side from whatever happens to be loaded in React state.

### 5.2 The `trustworthy` gate (`eliminationFilter.ts`, `computeEliminationReport`)

```
trustworthy =
  !row.truncated
  && row.historyFailed !== true
  && row.trades >= ELIMINATION_MIN_TRADES        (= 50)
  && duneCoveragePercent !== null
  && duneCoveragePercent >= TRUSTED_DUNE_COVERAGE_PERCENT   (= 90)
  && roundTripsConsidered >= ELIMINATION_MIN_DUNE_ROUND_TRIPS  (= 10)
  && coverageGap.hiddenLossRisk === 'negligible'
```

`ELIMINATION_MIN_TRADES = 50` is a **deliberate fork** from `RULES.minTrades = 100`, the
constant used by the candidacy gates (`computeCopyCandidates`) and by the main decision table's
own screen (`computeCopyTradeReport`'s `RULES.minTrades`). The two numbers are intentionally
different and this is documented in-code as intentional, not an oversight — but it means "enough
trades" means 50 in one part of this tab and 100 in another, on the same underlying `trades`
field, for the same wallets, at the same time.

### 5.3 Why 30 days, specifically

GMGN's realized-PnL figure is only ever published as a rolling 7d/30d window — there is no
arbitrary-date-range query available from GMGN. Since that figure cannot be widened, every other
input to this triage (GMGN trade history period, Dune simulation period) was narrowed to match it
at 30 days, rather than the reverse. This is **not** the same period the main decision table's own
`enoughEvidence`/`survivedDelay` logic uses for its `sim` — that logic uses whatever period
`copySimulation30d` (or its `copySimulation` fallback) happens to hold, per Section 2.1.

### 5.4 The hidden-loss risk check (`assessCoverageGap`, `src/copytrade/candidateScrutiny.ts`)

Answers "does this wallet's Dune coverage gap actually matter for losing money?" without
inventing a copier price for unmatched trades:

```
shownLossRate = % of MATCHED trades where wallet's own return < 0
trueLossRate  = % of ALL trades (matched + unmatched) where wallet's own return < 0
                (uses GMGN's own per-trade return, which exists for every trade
                 whether or not Dune matched it)
understated   = trueLossRate - shownLossRate

hiddenLossRisk =
  no comparable trades at all           -> 'unknown'
  understated > 10pp (HIGH bar)         -> 'high'
  understated > 3pp  (MODERATE bar)     -> 'moderate'
  else                                  -> 'negligible'
```

Deliberately asymmetric: a wallet whose unmatched trades look _better_ than its matched ones
(negative `understated`) is always `'negligible'`, never flagged — the reasoning given in-code is
that this direction can only cost a missed opportunity, not a loss. **A reviewer should check
whether that asymmetry is actually consistent with the stated goal** ("not guaranteed profit" —
Section 6) if the goal is ever read more broadly than pure downside protection.

A wallet with **zero unmatched trades** (100% coverage) is treated as `'negligible'` risk with
`understated = 0` by construction — this was a real bug found and fixed during development (an
earlier version required _both_ a matched and unmatched population to exist, which made a fully
covered wallet return `'unknown'` and therefore never `trustworthy`).

### 5.5 What "needs Dune" counts (`survivorsNeedingDune`)

```
survivorsNeedingDune = surviving wallets where
  !trustworthy AND (duneMissedTrades === null OR duneMissedTrades > 0)
```

Two failure modes this was built to avoid (both previously present, both fixed): (a) a wallet
above the 90% coverage floor but with non-negligible hidden-loss risk being excluded from this
count even though more Dune data would resolve it; (b) a wallet with `duneMissedTrades === 0`
(nothing left to fetch) being counted anyway because its blocker is trade count, not coverage.

### 5.6 The refetch-time estimate (`estimateDuneRefetchDuration`)

Reads the last 20 completed rows from `copytrade_copy_simulation_runs`, computes
`totalWallClockSeconds / totalTargetsAcrossThoseRuns`, and multiplies by
`measuredDuneTargetsRemaining`. Falls back to a seeded rate (2,941s / 150 targets — one specific
historical run) only when zero completed runs exist. This estimate assumes future Dune batches
will move at the same rate as the last 20 — it does not account for GMGN's or Dune's own rate
limiting varying over time, nor for the batches possibly targeting harder-to-match tokens than the
sample it was measured on.

### 5.7 Persistence

The triage result is **not** recomputed live — it is a snapshot, cached in `localStorage`
(`vantage.crypto.elimination-report`), restored on page load, and only refreshed when the user
clicks "Run triage" again. The UI compares the snapshot's `generatedAt` against the most recent
GMGN screening / Dune run timestamps it has in memory and shows a warning banner
("Out of date — GMGN or Dune data has been fetched since this triage ran") when the snapshot
predates them — but this comparison only fires against timestamps already loaded into the current
page session; it cannot detect that a fetch happened in a different browser tab or session.

---

## 6. The "Final decision panel" and canonical table (top of the tab)

Built on top of the Section 2 verdict, not the Section 5 triage:

- Four state tiles (Passed all tests / Watch / Rejected / Needs more data), counts computed from
  `decisionStateFor(verdict)` across `unifiedTraderRows` — **not** filtered by the evidence bars
  (Section 2.5), so these counts can disagree with what the table below actually displays if the
  bars have been moved from their defaults.
- "Last updated" reads `visibleWalletScreenSummary.lastFetchedAt` — the GMGN screening fetch time,
  not the Dune fetch time and not the elimination triage's `generatedAt`. Three different
  "last updated" concepts exist across this one tab (screening time, Dune run time, triage
  `generatedAt`), each surfaced in a different place, none cross-referenced with the others.
- Fixed text: "Passed tests, not guaranteed profit."
- The canonical table's **Decision** and **Data freshness** columns are the four-state collapse
  and the per-row freshness label described in Sections 2.3 and 3.

---

## 7. The core structural fact: two independent judgment systems, not fully reconciled

|                         | Main decision table (Section 2)                                                                        | Elimination triage (Section 5)                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Where computed          | Client, from whatever `copySimulation`/`copySimulation30d` is in React state                           | Server, on-demand from a fresh DB query                                                                              |
| Trade-count minimum     | 100 (`RULES.minTrades`, shared with candidacy)                                                         | 50 (deliberately forked)                                                                                             |
| Dune coverage bar       | Exactly 100% (three separate literal checks: `enoughEvidence`, `survivedDelay`, and Winners' own gate) | 90% + a hidden-loss risk check                                                                                       |
| Round-trip sample floor | 30 (`sample >= 30`)                                                                                    | 10 (`ELIMINATION_MIN_DUNE_ROUND_TRIPS`)                                                                              |
| Period                  | Whatever `copySimulation30d` holds, falling back silently to unbounded `copySimulation`                | Explicitly 30 days everywhere                                                                                        |
| Freshness check         | Yes (`freshStats`, 24h, feeds the verdict)                                                             | Yes (`ELIMINATION_STATS_MAX_AGE_HOURS = 24`, gates only the PnL-based elimination reason, not the other two reasons) |
| Persistence             | Not cached; recomputed on every render from current React state                                        | Cached in `localStorage`, explicit "Run" action, explicit staleness banner                                           |
| Output                  | Six-value verdict, collapsed to four states for display                                                | Trustworthy/eliminated + a separate hidden-loss reading per surviving wallet                                         |

**A wallet can therefore simultaneously be `"Tested candidate"` in the main table (100% coverage,
30+ round trips, fresh stats, positive historical and copy result) and appear as `"Rejected"` or
`"Needs more data"` under the triage's own `trustworthy` computation** (different trade-count
floor, different coverage semantics, different period), or the reverse. Nothing in the UI states
this can happen or reconciles the two when it does. A reviewer should check whether this is
intended (two deliberately different questions — "is this wallet currently good" vs. "is this
wallet worth continuing to spend Dune budget on") or an unintentional drift from one system being
updated without the other.

---

## 8. Known open issues already tracked (do not re-report)

Recorded in `progress.md` across this project's history; listed here so review effort is not
spent rediscovering them:

- Every numeric threshold in the elimination triage (50 trades, 90% coverage, 10 round trips, 24h
  staleness, the 10pp/3pp hidden-loss bars, the -20% "strongly negative PnL" bar) is a reasoned
  judgment call, explicitly **not** calibrated against any realized trading outcome.
- Silent GMGN omissions — rows GMGN's API simply never returns, not flagged `truncated` or
  `historyFailed` — are a known, unmeasured risk. Per-wallet counts of malformed rows and daily-cap
  skips exist in the schema (`malformed_rows`, `daily_capped_rows` on
  `copytrade_wallet_coverage`/`_events`) but are not yet read by any API route or surfaced in any
  UI.
- Winners, Scrutiny, and Pattern Discovery remain separate sub-tabs, not folded into the same
  "Advanced diagnostics" collapse as the elimination triage — a partial, not complete,
  implementation of the "one canonical view" goal this tab is being restructured toward.
- The assumed copier delay (`DEFAULT_COPIER_DELAY_SECONDS = 15`) that both `delayShare`/
  `impossible`/`fragile` (Section 2.1) and the triage's `hold_time_shorter_than_copy_delay`
  elimination reason (Section 5) depend on has never been measured against a real fill — it is an
  assumption, used identically in both systems, but neither system flags it as such to the reader
  at the point of use.

---

## 9. Suggested angle for the external review

Given Section 7, the highest-value review questions are likely:

1. For a wallet that disagrees between the two systems (Section 7's table), which one should a
   human trust, and does the UI make that disagreement visible anywhere today? (As documented
   above: no.)
2. Is the `copySimulation`/`copySimulation30d` fallback (Section 2.1) safe, or should a row with
   no `copySimulation30d` entry show "not measured" rather than silently falling back to
   possibly-stale, possibly-differently-scoped data?
3. Do the three independent "100% coverage required" checks (`enoughEvidence`, `survivedDelay`,
   Winners' gate) ever need to move together, and if one changes (as `TRUSTED_DUNE_COVERAGE_PERCENT`
   already did once, in the triage only) should the others be revisited too?
4. Is the asymmetric hidden-loss risk definition (Section 5.4) — never penalizing a wallet whose
   gap looks better than reality — actually the right call given the stated goal is avoiding
   losses specifically, or does it leave a different kind of blind spot (e.g. overstating a
   wallet's edge, which could still lead to over-allocating capital to it)?
