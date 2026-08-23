# Phase 0 readiness report: shared pattern-discovery engine

Date: 2026-08-21  
Scope: read-only inspection of `unusualwhales` and `crypto`  
Decision: **do not start Phase 1 yet**

## Executive decision

Build against Unusual Whales first, after review. Defer GMGN blind discovery until its outcome
coverage and selection bias are repaired. The two projects must remain separate: no shared rows,
cross-project features, models, caches, or reports.

GMGN is not ready for blind discovery. The local database has 18,878 captured signal rows, but
the delegated inspection found all 18,878 carry validation issues (primarily missing optional
fields), zero signal types 14–16, five CLI polls with zero events, and browser-only capture for
the stored signal population. The task's verified prior analysis reports median Dune coverage of
about 54.5%, non-random missingness (unmatched trades are about twice as likely to be >100%
winners), and a roster survivorship boundary at 2026-08-14. Those conditions are sufficient to
defer discovery rather than risk confident nonsense.

## 0.1 Real feature and outcome inventory

### Unusual Whales

Evidence inspected:

- `unusualwhales/src/research/signal-catalog.ts` registers ten signal families: call sweeps,
  put sweeps, repeated sweeps/hits, dark-pool blocks, call/put flow imbalance, open-interest
  spikes, GEX/gamma, market/ETF flow, insider activity, and congressional activity.
- `unusualwhales/src/research/option-features.ts` derives `volume_oi_ratio`, `spread_pct`,
  `moneyness_pct`, `dte_days`, `side_score`, implied volatility, delta, gamma, vega, and
  `is_opening_trade`. It derives DTE from `expiry - executedAt`, not from current time.
- Live SQLite tables in `unusualwhales/.data/unusual-whales.sqlite` include 6,527,084 option
  trades, 591,843 signal events, 240,815 event-outcome rows, 81,044 market bars, 196 historical
  coverage rows, and 100 import batches. The option outcome table contains horizons `+5m`,
  `+30m`, `+1h`, `+1d`, and `+3d`.
- Current live SQLite outcome counts, by option-trade horizon, are:

  | Horizon | Outcome rows | Usable rows | Usable / rows |
  |---|---:|---:|---:|
  | +5m | 6,527,006 | 136,260 | 2.09% |
  | +30m | 6,527,006 | 43,594 | 0.67% |
  | +1h | 6,527,006 | 26,343 | 0.40% |
  | +1d | 6,527,006 | 42,007 | 0.64% |
  | +3d | 6,527,006 | 23,667 | 0.36% |

  `usable` means a non-null outcome timestamp and return with no exclusion reason; it is not
  treated as zero when absent. Event-level outcome coverage is lower in the current database:
  for `+1d`, 48,163 event-outcome rows contain 5,958 usable rows.

### GMGN / crypto

Evidence inspected:

- `crypto/src/db/schema.ts` defines `gmgn_signals`, token/cohort tables, Dune import/audit tables,
  outcome-run archives, browser coverage windows, copy-trade trades and coverage, and top-caller
  callout/outcome tables.
- `crypto/src/gmgn/ingest.ts`, `crypto/src/gmgn/polls.ts`, and the research contract preserve
  source timestamps, capture timestamps, ingestion latency, poll bounds, gaps, and archive
  provenance.
- Live SQLite `crypto/.data/crypto-research.sqlite` contains 18,878 `gmgn_signals`, 281,805
  tokens, 503,156 copy-trade trades, 113 wallet-coverage rows, 8,318 top-caller callouts, and
  48,488 top-caller outcomes. The stored GMGN signal range is
  `2026-08-10T17:06:30Z`–`2026-08-14T21:00:13Z`.
- The data does not currently expose one clean, project-wide normalized signal/outcome table
  suitable for the proposed engine. Dune results are retained as raw run payloads and need a
  project-local export contract before any discovery run.
- Existing project evidence says the intended GMGN horizons include `5m/10m/15m/30m/45m/1h/6h/24h/3d/7d`,
  but the captured signal population and outcome coverage are not complete enough to assume all
  horizons are available for every event.

## 0.2 Point-in-time safety allow-list

The engine must receive only project-exported, allow-listed fields. It must not infer safety from
column names or silently coerce rejected fields.

### Proposed initial UW allow-list

| Feature | Status | One-line justification |
|---|---|---|
| `signal_type` | allow | Signal classification is stored with the event/import record. |
| `underlying_symbol` / `symbol` | allow | Instrument identity is present on the event. |
| `premium`, `size`, `price` | allow | Trade payload values are observed at the provider event. |
| `open_interest`, `volume` | allow with provenance | Values are in the captured trade payload; export must retain provider timing. |
| `nbbo_bid`, `nbbo_ask` | allow | Quote values are captured with the trade. |
| `strike`, `underlying_price`, `expiry` | allow | Contract/event fields are captured before outcome measurement. |
| `executed_at` / `event_at` / `observable_at` | allow | Event-time ordering and entry timing are explicit. |
| derived `dte_days` | allow | Derived only as `expiry - executed_at`; never from current time. |
| derived spread/moneyness/volume-OI/side-score | allow | Deterministic transforms of allow-listed event-time fields. |
| `report_flags`, `tags` | allow with provenance | Captured labels are knowable at event time; raw semantics remain auditable. |

Reject by default: `captured_at`/`retrieved_at` as predictive features, any post-event market bar,
any outcome/checkpoint/return field used as a feature, recalculated “current” values, provider
fields whose timestamp is later than the event, and any field without a one-line timing
justification. `dte` computed from “now” is specifically rejected.

### Proposed initial GMGN allow-list

| Feature | Status | One-line justification |
|---|---|---|
| `signal_type` | allow | Source-normalized signal type is stored at capture. |
| `observed_at` / `trigger_at` | allow only when source timestamp is verified | This is the event-time anchor; missing or contradictory timestamps exclude the row. |
| `token_address`, `chain` | allow | Entity identity and chain are part of the captured source record. |
| `market_cap` / `trigger_mc` / `first_trigger_mc` | conditional | Allow only when source-provided at the trigger, not a query-time snapshot. |
| `ingestion_latency_ms` | allow as diagnostic, not market feature | It is knowable at capture but can encode collection conditions rather than signal behavior. |

Reject by default: `query_market_cap`, `query_ath`, `query_cur_data`, current wallet statistics,
post-event rankings, later roster membership, Dune-derived outcomes, and any stats endpoint value
not tied to the event timestamp. `query_cur_data` is a query-time snapshot and is not a signal-time
condition. `avg_holding_period` is rejected until reconciled against transaction-level truth; prior
inspection found it diverged from true median hold by three to four orders of magnitude.

## 0.3 Input cleanliness

### Unusual Whales

Coverage is technically measurable, but the current raw denominator includes many rows with
explicit exclusions or not-yet-mature checkpoints. The `+1d` option-trade usable count is 42,007
of 6,527,006 rows (0.64%); event-level usable count is 5,958 of 48,163 event-outcome rows. This
must be reported as coverage, not treated as a negative return.

Missingness is not yet cleared for discovery. Before export, compare an allow-listed known-at-event
feature (for example premium or notional) between rows with a matured usable outcome and rows
without one, separately by signal family and horizon. The result must include group counts and an
effect-size threshold; “missing at random” must not be assumed.

Survivorship is a concern for any selected signal/entity pool. UW’s historical coverage table
records completed import windows, but a readiness-approved export must prove that symbol inclusion
was not decided using post-window performance. Existing walk-forward/OOS reports are evidence of
a stronger validation design, not proof that every current pool is survivorship-free.

### GMGN

The readiness gate fails. The local database has 18,878 signal rows, all with validation issues;
the delegated targeted tests passed 39/39, but the full read-only TypeScript test run was 319/320
with one schema initialization failure. Five recorded CLI polls received zero events; stored GMGN
signals are browser-extension capture. There are 10 browser coverage windows, 8 still open, and
the project’s own contract states that an absent signal outside a verified exposure window is not
evidence of no signal.

Carry forward the verified bias findings from the task specification: median Dune coverage is
about 54.5%; unmatched trades are about twice as likely to be >100% winners (20.5% versus 12.1%),
while losses are similar (3.5% versus 3.2%); and the current roster survives to 2026-08-14.
Blind discovery should therefore be deferred until coverage is repaired and the population boundary
is frozen prospectively.

## 0.4 Proposed normalized contract

The export contract is project-neutral in shape but project-specific in fields and horizons:

```text
event_id, event_time, entity_id, signal_type,
<project-specific allow-listed features>,
<only horizons actually available for this project>,
benchmark_return, excess_return, net_return_after_costs,
mature, usable, independence_group
```

Rules:

- A missing or unmatured outcome is absent, never zero.
- `mature` means the horizon elapsed under the project’s timestamp rules.
- `usable` additionally requires the project’s outcome-quality checks to pass.
- `independence_group` is supplied by the project; repeated events for one wallet/token or
  overlapping related signals must not be treated as independent by the engine.
- The export must record project name, schema version, source database fingerprint, export time,
  feature allow-list version, and horizon list. These are metadata only and never cross project
  boundaries.

### Real UW row inspected

From `unusualwhales/.data/unusual-whales.sqlite`, `uw_option_trades`:

```text
trade_id=1
signal_type=call_sweep
underlying_symbol=UBER
executed_at=2026-08-18T18:58:24.797Z
captured_at=2026-08-18T19:13:25.209Z
option_type=call
expiry=2026-08-21
strike=76
premium=77.00
price=0.77
size=1
open_interest=3532
volume=1403
nbbo_bid=0.77
nbbo_ask=0.81
derived_dte_days=2.208
report_flags=["intermarket_sweep"]
tags=["bid_side","bearish"]
```

The current feature table has no row for this trade, so derived values that depend on refreshed
features must be absent rather than invented. This row demonstrates the raw event boundary, not a
profitable result.

### Real GMGN row inspected

From `crypto/.data/crypto-research.sqlite`, `gmgn_signals`, safely redacted for identity:

```text
event_id=1
observed_at=2026-08-11T04:59:13Z
captured_at=2026-08-11T04:59:29.721Z
source=gmgn-browser-extension
chain=sol
signal_type=18
market_cap=64995.2710009432
token_address=GDbxC8…pump
triggering_wallet=null
raw_wallet_labels=null
source_url=null
```

This row has no safely verified matured normalized outcome attached in the current export shape;
it must not be sent to the engine as if a missing outcome were zero. Its query-time `cur_data`
payload is rejected as a feature.

## Isolation proof required before Phase 1

The eventual implementation must demonstrate, in tests and run metadata, that:

1. UW exports and GMGN exports use different input paths, output paths, caches, and model files.
2. A run is stamped with exactly one project identifier and refuses mixed project rows.
3. No shared database is opened by the engine.
4. Fitted models are created inside a project/run-specific directory and cannot be reused across
   project identifiers.
5. Reports contain only that project’s rows, counts, and feature names.

## Gate result and next review questions

**Gate status: not approved for Phase 1.** UW is the preferred first consumer, subject to a
project-local export that measures missingness bias and proves the entity pool boundary. GMGN is
deferred until its outcome coverage, missingness mechanism, signal-type coverage, and prospective
roster boundary are repaired.

Review must approve or reject this conclusion and the allow-lists before any shared Python package,
CLI, statistical component, model, or discovery report is implemented.
