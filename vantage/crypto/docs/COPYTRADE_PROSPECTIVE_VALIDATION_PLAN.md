# CopyTrade prospective validation and copy-simulation plan

**Status:** Proposed for review  
**Prepared:** 2026-08-15  
**Primary goal:** determine whether wallets selected from GMGN at a known time remain useful to copy afterward, without using future information in their selection.

## Human Feedback

The current historical analysis is valuable and should remain a first-class result. Looking at today’s top traders and their previous 90 days of GMGN activity can answer:

> Were these traders already making successful trades earlier, or did they become successful only recently?

This can be evaluated now from the data already stored. The report should compare an earlier part of the history with the most recent ranking period—for example, the prior 60 days versus the latest 30 days—and show weekly/monthly consistency, losses, missing coverage, and dependence on one token or trade. A trader who performed well in both periods is stronger historical evidence than one whose result comes only from a recent burst.

This is different from the prospective question:

- **Historical consistency:** “Are today’s top traders also successful in their earlier stored history?” This does not require waiting for new data.
- **Walk-forward selection:** “If we had frozen GMGN’s top 25 at an earlier date, would those selected traders have succeeded afterward?” This requires a leaderboard snapshot from that earlier date, or future snapshots collected from now on.

The application should not treat the need for future leaderboard snapshots as a reason to discard or delay the historical-consistency analysis. It should report both tracks with different labels: historical evidence can be shown now; prospective selection evidence remains pending until the required dated snapshots exist.

**Why an early-vs-recent split is not just re-testing the same selection bias.** GMGN's leaderboard ranks by 30-day PnL (`reported_pnl_30d` in the stored roster). A period drawn from *before* that 30-day window — for example days 31–90 back — sits mostly outside the window that got the wallet noticed in the first place. It is not a fully independent sample (the wallet was still chosen with some knowledge of its longer track record), but performing well in a period the ranking metric does not directly reward is meaningfully harder to fake than performing well in the window that does. State this reasoning in the report itself so a reader understands why the early period counts as evidence, not decoration.

**Data-depth check before this can run as described.** Verified against the live database: only **14 of 25** currently-fetched wallets have ≥60 days of stored trade history, and only **9 of 25** have the full ≥90 days a 60-vs-30 split implies; **6 of 25** have under 30 days total (as little as 5.7 days). The report must gate on this explicitly per wallet — an `insufficient historical depth` outcome, in the same spirit as the existing `thin` verdict — rather than silently computing a two-period comparison over 6 days of data as if it meant the same thing as one computed over 90. Where depth is short of a fixed split, prefer a wallet-relative split (e.g. first half vs. second half of *available* history) over silently lowering the bar, and label which one was used.

## 1. What already exists

The application already has most of the collection foundation:

- append-only GMGN leaderboard snapshots;
- an append-only table for exact leaderboard request provenance;
- the official GMGN wallet-activity fetch path;
- a growing SQLite history of wallet activities for the current roster (the exact count is intentionally read from the live summary rather than frozen in this plan);
- target-wallet timestamps, prices, amounts, gas and DEX-cost fields, transaction hashes, and raw payloads;
- weekly/monthly historical performance, profit concentration, rank history, and the **Screen pass** label;
- SQLite persistence, immutable result snapshots, stop controls, progress reporting, and coverage/truncation records;
- a reusable period-aggregation primitive (`performanceByPeriod`/`summarizeTrades` in `evaluate.ts`) that already buckets a wallet's completed trades by week/month — the historical-consistency split below is two more calls to the same primitive over two timestamp-filtered slices, not a new aggregation engine.

The live database currently has only **two** leaderboard snapshots, both from 2026-08-14. It has **zero** rows in `gmgn_wallet_rank_capture_provenance`, because those snapshots predate the provenance feature. They must remain preserved but be labelled **legacy — filter not proven**. Their missing query parameters must never be guessed or reconstructed.

The current historical wallet report remains useful as a screen. It is not a walk-forward test and is not a simulated copier result.

## 2. Source responsibilities

| Need | Preferred source | Role |
|---|---|---|
| Who ranked at time T and under which filters | GMGN browser capture | Freeze the roster and exact leaderboard request as it appeared at selection time. |
| Target wallet's later buys and sells | Official GMGN wallet activity | Detect and preserve future wallet actions, including source transaction identifiers and raw payloads. |
| On-chain trade, fee, and landed success verification | Dune Solana tables | Retrospective verification after a freshness buffer; batch many transactions into one execution. |
| Approximate copier price after a delay | Dune Solana DEX trades | Select a deterministic qualifying trade at or after the simulated copier time. This is a proxy, not a historical GMGN route quote. |
| Live route, price-impact, and quote evidence | Optional GMGN Trade API | Prospective shadow quotes only, if separate access is approved. Never required for the first simulation and never used to place an order. |
| Attempts that never reached the chain | Local prospective telemetry | Dune cannot observe these; until captured, model them only as explicit sensitivity assumptions. |

Dune is deliberately not the live detector. It is the delayed validation and enrichment source. The implemented prescreen currently requires a **24-hour minimum signal age** before a first Dune submission (`MIN_SIGNAL_AGE_HOURS = 24`). This plan reuses that real rule; it does not claim that a three-day buffer exists. The rule was selected from the project's recovery evidence: recovered checkpoints had a median 18.6-hour gap, a maximum observed gap of 33.6 hours, and first-attempt success was already 98.4% at a 6–24-hour delay. Any change to 24 hours must be versioned and preregistered.

## 3. Data and code needed by open item

| Open item | Code change | New data required |
|---|---|---|
| Historical consistency (early vs. recent) | Two-slice aggregation reusing `performanceByPeriod`, a per-wallet depth gate, and a distinct **Historically consistent** label. | None — computed from trades already stored. |
| Walk-forward testing | Immutable experiment/cohort tables, a **Freeze selection** action, and a future-only evaluator that rejects every trade at or before selection time. | Time must pass after each frozen selection so later trades exist. |
| More independent leaderboard snapshots | Capture-health UI, legacy-provenance label, and a fixed capture protocol. Existing provenance storage can be reused. | Repeated GMGN captures using exactly the same filter and ordering. |
| Realistic copy simulation | Reuse `copytrade_trades.observed_timestamp`/`fetched_at` with explicit live-poll provenance, add Dune validation/enrichment, a versioned simulation engine, cost assumptions, fill/miss rules, and separate reports. | Empirical detection delays, mature Dune trade evidence, and optionally prospective GMGN quotes. |
| Older snapshots lack exact provenance | Label and quarantine them from formal experiments. Do not modify their raw evidence. | This cannot be repaired retroactively. Formal testing begins with the first fully provenanced capture. |

## 4. Implementation plan

### Phase 0a — historical consistency report (build first; no new data required)

This is the one item in this plan that depends on nothing else here — no frozen roster, no future snapshot, no waiting. It should ship before Phase 0.

#### Code

1. Add `computeHistoricalConsistency(wallet trades, splitPoint)` reusing `performanceByPeriod`/`summarizeTrades`: aggregate the early slice and the recent slice separately (median, win rate, weekly/monthly consistency, profit concentration — the same fields already shown for the whole-period report).
2. Per wallet, first check available depth:
   - `< 30 days` total → `insufficient historical depth`, no comparison computed.
   - `>= 30 days` and `< 90 days` → wallet-relative split (first half vs. second half of available history); label the actual split point used.
   - `>= 90 days` → the fixed 60-vs-30 split described above.
3. Surface both periods' verdicts side by side (e.g. "early: screen pass, recent: screen pass" vs. "early: thin, recent: screen pass") rather than collapsing them into one number — the point of this report is to show whether the two periods agree, not to average them away.
4. Persist each computed comparison the same way existing results are snapshotted, so a historical-consistency claim is reproducible from the same stored trades later.

#### Acceptance gate

- Every wallet's report states which split it used (fixed 60/30, relative half-split, or insufficient depth) — never a silent default.
- A wallet whose early and recent periods disagree is visibly flagged, not just numerically averaged into one figure.
- This report never claims or implies prospective/walk-forward validity — it is explicitly historical-only, labelled as such in the UI (see the new Phase 5 label below).

### Phase 0 — start trustworthy collection now

#### Code

1. Add a provenance status to leaderboard reads:
   - `provenanced` when an exact request row exists;
   - `legacy_unprovenanced` when it does not.
2. Prevent `legacy_unprovenanced` snapshots from becoming formal walk-forward cohorts.
3. Add a small capture-health panel showing:
   - latest snapshot time;
   - exact window, order, filters, request path, and a filter hash;
   - number of independent capture dates;
   - time since the last capture;
   - number of legacy snapshots.
4. Keep the current raw snapshots and rank-history view unchanged.

#### Data protocol

1. Choose one GMGN leaderboard configuration and freeze it for the pilot.
2. Capture that exact leaderboard at least once every 24 hours. A 6-hour cadence is useful if it remains operationally easy, but consistency matters more than volume.
3. Preserve the full top 25 even if the practical copying target is the top 5. This gives the experiment a primary group (ranks 1–5) and a comparison group (ranks 6–25).
4. Do not compare captures produced with different filter hashes as if they were one history.

#### Acceptance gate

- At least one fully provenanced snapshot can be reproduced from its saved raw payload and request metadata.
- The UI clearly distinguishes the two legacy snapshots.
- No inferred filter is attached to old data.

### Phase 1 — implement the walk-forward experiment core

#### Schema

Add append-only records equivalent to:

```text
copytrade_experiments
  id
  selected_at_utc
  leaderboard_snapshot_id
  leaderboard_provenance_id
  filter_hash
  primary_top_n
  roster_top_n
  evaluation_windows_json
  methodology_version
  status
  created_at

copytrade_experiment_wallets
  experiment_id
  wallet_address
  rank_at_selection
  selected_group
  captured_source_fields_json
  created_at
```

Foreign keys and uniqueness constraints must make a frozen roster immutable. A later leaderboard snapshot must never alter an earlier experiment.

#### Workflow

1. Add **Freeze this roster** to a fully provenanced GMGN snapshot.
2. Save ranks 1–25; mark ranks 1–5 as the primary practical group.
3. Use a fixed weekly cohort cadence for the pilot so hundreds of overlapping daily cohorts do not create false independence. Continue daily leaderboard collection for rank history.
4. Evaluate only GMGN trades satisfying:

```text
trade timestamp > selected_at_utc
trade timestamp <= selected_at_utc + evaluation window
```

5. Show 7-day, 30-day, and 90-day states as `pending`, `matured`, or `insufficient coverage`. Never use a partial window as a completed result.
6. Preserve the existing historical **Screen pass** report separately.

#### Tests

- a pre-selection trade can never enter a forward result;
- a roster remains unchanged after newer snapshots arrive;
- a legacy snapshot cannot be frozen;
- evaluation windows remain pending until their UTC end time;
- duplicate freezes are idempotent;
- results can be reproduced from the saved snapshot, provenance, trades, and methodology version.

#### Acceptance gate

- A reviewer can select an experiment and reproduce exactly who was selected, why, and which future trades were included.
- The UI never calls a historical screen a forward result.

### Phase 2 — measure real detection delay

Historical GMGN trade timestamps describe when the target wallet acted. They do not tell us when this application first learned about the action. The current schema already has both pieces for each inserted trade: `copytrade_trades.observed_timestamp` is the source trade time and `copytrade_trades.fetched_at` is the first local insert time. The insert uses `INSERT OR IGNORE`, so a duplicate re-fetch does not replace the original trade row or its original `fetched_at`.

That existing timestamp pair is not yet a latency measurement: the current CopyTrade fetch is a historical backfill over a whole period, so its `fetched_at` means “when the backfill imported this row,” not “how quickly a continuous collector would have detected it.” Only rows first seen by a dedicated live-poll run can contribute to empirical detection latency.

#### Code

1. Reuse the existing trade row rather than creating a duplicate observation table. Add capture-mode/run provenance to the fetch run and, if needed, a `first_seen_run_id` on the trade row:

```text
copytrade_fetch_runs
  ...existing fields...
  capture_mode             -- historical_backfill | continuous_poll
  poll_id

copytrade_trades
  ...existing fields...
  first_seen_run_id
```

2. Stand up an explicit continuous-poll mode for frozen experiment wallets, prioritizing the primary top 5. Do not reinterpret historical-backfill `fetched_at` values as live latency.
3. Preserve the first receipt time and first live-poll run ID. Later duplicate polls may update coverage evidence but must not replace the first receipt.
4. Report p50, p90, and worst observed detection latency, plus poll gaps and failures.
5. Use rate-limit backoff and the existing start/stop/progress conventions. This remains read-only collection and performs no trade.

The existing GMGN signal watch mode is deliberately disabled (`GMGN_WATCH_MODE_ENABLED = false`) because unattended polling was not yet considered ready. CopyTrade polling should therefore be treated as a separate, explicitly reviewed collector with its own stop control, error handling, and pilot gate—not silently enabled as a side effect of this plan.

#### Data needed

- Prospective GMGN activity observations while the collector is running.
- Several days of observations before the first latency assumption can be evidence-based.

#### Acceptance gate

- Detection delay comes from saved source and receipt timestamps, not a guessed constant.
- Poll gaps and downtime are visible rather than silently treated as zero delay.

### Phase 3 — add batched, delayed Dune verification

#### Code

1. Wait at least **24 hours** after the observed trade before the first Dune submission, matching the implemented prescreen buffer. Keep the source-age decision visible per row; do not silently submit fresh observations. A longer delay may be piloted later, but it is a versioned policy change rather than an existing fact.
2. Submit mature experiment transactions in batches, grouped by transaction hashes, wallets, and bounded time ranges—not one paid execution per trade.
3. Use Solana DEX trade data to preserve actual legs, amounts, USD value, project/route, transaction ID, and deterministic instruction ordering.
4. Use Solana transaction and fee data to verify landed success/error and network/priority fees.
5. For a simulated delay, deterministically choose the first qualifying market trade at or after:

```text
collector_received_at_utc + configured_processing_delay
```

6. Persist the Dune execution ID, exact SQL and hash, raw result/archive hash, requested/completed times, and interpretation version.
7. Reuse completed or still-running executions and reconcile timed-out executions before paying for a duplicate query.

#### Important limitation

The delayed DEX trade is an executable-price proxy. It is not proof that a $100 copy would receive that exact fill. Dune does not provide a universal historical pool-reserve state for every Solana route, and it cannot observe an attempted order that never reached the chain.

#### Acceptance gate

- Dune work is deduplicated, batched, at least 24 hours mature, and reproducible.
- Every simulated price links to exact on-chain trade provenance.
- Missing trades remain missing and are never treated as zero return.

### Phase 4 — implement copy simulation v1

Keep two reports side by side:

1. **Target-wallet future performance** — what the selected wallet actually earned after time T.
2. **Simulated copier performance** — what a delayed, fee-paying copier might have earned.

#### Preregistered simulation inputs

- fixed starting bankroll and per-position sizing;
- maximum concurrent positions;
- p50 and conservative p90 detection-delay scenarios from Phase 2;
- processing delay;
- entry and exit price rule;
- platform fee, network fee, priority fee, and tip handling;
- maximum acceptable slippage/price impact;
- maximum age of the proxy trade;
- partial/missing-liquidity rule;
- failed or missed-order rule;
- proportional sell behavior and remaining-balance handling.

Store these as a versioned configuration, not UI-only state. Do not tune them after viewing which values make a wallet win.

#### Schema

Add immutable simulation runs and per-action evidence records. Each result must reference the experiment, selected wallet, source action, Dune evidence, configuration version, and reason for any missed fill.

#### Failure modelling

- **Observed landed failure:** use Dune transaction evidence.
- **No qualifying delayed trade:** mark the simulated copy as missed.
- **Never-submitted or dropped request:** report sensitivity scenarios until local order telemetry exists; never present an assumed failure rate as measured.

#### Optional improvement

If GMGN grants separate Trade API access, capture fixed-size prospective shadow quotes for the top 5. Save expected/minimum output, route, price impact, priority fee, latency, and errors. Do not sign or submit. These quotes improve future realism but cannot reconstruct old executions.

#### Acceptance gate

- Target-wallet and copier results cannot be confused in the API or UI.
- Every cost, delay, fill, and failure rule is versioned and reviewable.
- Results include both measured-latency and conservative sensitivity scenarios.

### Phase 5 — make stronger labels only after enough time passes

Use four labels. The first two are backward-looking and available now or soon; the last two are forward-looking and require the walk-forward machinery in Phases 1–4:

| Label | Required evidence |
|---|---|
| **Screen pass** | Current historical descriptive screen. Already implemented. |
| **Historically consistent** | Phase 0a: positive, sufficiently covered performance in both the early and recent slices of a wallet's own already-stored history. Backward-looking only — never presented as, or upgraded into, prospective evidence. |
| **Stable candidate** | Positive, sufficiently covered future performance across multiple independent frozen cohorts and dates. |
| **Prospective copy candidate** | Stable candidate whose copy simulation remains viable after measured delay, costs, misses, and conservative sensitivity assumptions. |

A wallet can be **Historically consistent** without ever becoming a **Stable candidate** (or vice versa) — the two labels are evaluated independently and must never be merged into one composite score, since one is available immediately from stored data and the other necessarily takes weeks to mature; conflating them would let backward-looking evidence quietly stand in for the prospective evidence this plan exists to produce.

The exact minimum number of cohorts, dates, trades, fill rate, and confidence thresholds must be preregistered before the first formal verdict is inspected. A suggested pilot is several weeks of daily captures with independent weekly frozen cohorts; 30- and 90-day claims necessarily take 30 and 90 days to mature.

## 5. Recommended build order

### Build immediately — no dependency on any other phase

0. Phase 0a historical-consistency report, with its per-wallet depth gate. Ships a result the same day; requires no frozen roster, no new collection, and no waiting.

### Build now

1. Phase 0 provenance status and capture-health UI.
2. Phase 1 immutable walk-forward experiments and future-only evaluator.
3. Phase 2 first-seen trade collection for frozen wallets.

These three changes start the evidence clock and prevent further prospective data loss.

### Build when observations mature

4. Phase 3 batched Dune validation after the 24-hour buffer.
5. Phase 4 simulation after enough first-seen observations exist to estimate detection latency.
6. Phase 5 stronger labels only after multiple independent cohorts mature — the **Historically consistent** label can appear as soon as Phase 0a ships; **Stable candidate** and **Prospective copy candidate** still wait on Phases 1–4.

## 6. Explicit non-goals

- Do not rewrite or delete the existing historical screen.
- Do not invent provenance for old snapshots.
- Do not use Dune as a live wallet detector.
- Do not equate a nearby DEX trade with a guaranteed fill.
- Do not sign, submit, or automate a real trade in this research phase.
- Do not tune selection or simulation thresholds against the same future results used to judge success.

## 7. Definition of done

This plan is complete only when a reviewer can start from an immutable, fully provenanced GMGN leaderboard captured at time T and reproduce:

1. the frozen wallet selection;
2. the target wallet actions observed after T;
3. when the collector first saw each action;
4. the delayed Dune on-chain validation;
5. the target-wallet future result;
6. the separately configured simulated-copy result;
7. every exclusion, missing fill, fee, failure assumption, and methodology version.
