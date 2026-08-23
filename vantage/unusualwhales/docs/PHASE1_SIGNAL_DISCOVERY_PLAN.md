# Unusual Whales signal discovery: Phase 1 plan

Status: planning only. This document does not authorize a collector, a trading rule, or a profitability claim.

## 1. What the existing projects teach us

### Reusable from Crypto / GMGN

- Append-only SQLite migrations with raw source payloads retained alongside normalized fields.
- Stable source identity and SHA-256 provenance so repeated polls/uploads do not inflate observations.
- Explicit capture windows, pagination/gap diagnostics, ingestion latency, validation errors, and archived source files.
- Outcome runs and immutable pattern snapshots, so a displayed result can be tied to the exact input and methodology version.
- A local Node API plus React/Vite UI, with automated tests around normalization, ingestion, data quality, and research summaries.

### Reusable from Seeking Alpha backtesting

- A source-file import layer that detects input kinds and records a data version before analysis.
- A separate analysis module rather than calculations embedded in UI components.
- Chronological train/holdout boundaries, incomplete-horizon exclusion, explicit overlap handling, benchmark-relative returns, concentration diagnostics, and placebo controls.
- A dedicated Signal Discovery view that labels descriptive screens as exploratory and keeps validation evidence visible.
- Prespecified research documents and generated metadata/reports, rather than an opaque “best strategy” button.

### Deliberately not copied

GMGN collectors, Dune SQL, Solana-specific schemas, Seeking Alpha rating semantics, and existing winner thresholds are provider-specific. They are useful patterns, not Unusual Whales assumptions.

## 2. Context and current API evidence

No Unusual Whales-specific attachment or fixture is present in the repository or available attachment cache. The available local `context/` files concern the unrelated stock-selection project.

The official API documentation currently lists:

- `GET /api/option-trades`, with time-bounded pagination (`newer_than` / `older_than`), a maximum page size of 500, call/put filtering, premium/volume/OI/DTE filters, sweep/report flags, aggregation controls, and a `force_15_min_delay` option.
- `GET /api/option-contract/{id}/historic`, which is daily contract history rather than a substitute for timestamped tape events.
- `GET /api/stock/{ticker}/ohlc/{candle_size}`, supporting `1m`, `5m`, `10m`, `15m`, `30m`, `1h`, `4h`, `1d`, and `1w` candles with UTC start/end times.
- Full-market historical option trades as a separately priced dataset. Access, retention, rate limits, and whether the account includes the needed history must be confirmed before implementation.

References: [official API overview](https://api.unusualwhales.com/docs), [option trades](https://api.unusualwhales.com/docs/operations/PublicApi.OptionTradeController.index), [contract history](https://api.unusualwhales.com/docs/operations/PublicApi.OptionContractController.history), and [underlying OHLC](https://api.unusualwhales.com/docs/operations/PublicApi.TickerController.ohlc).

## 3. Smallest useful Phase 1

### One clean signal family

Start with **provider-defined call sweep option trades**, not a hand-tuned “winner” threshold:

1. Ingest the complete historical response for a bounded period and universe.
2. Normalize only rows that are unambiguously calls and have an execution timestamp, underlying ticker, contract identifier, and source trade identity.
3. Preserve the provider’s sweep/report/tag fields and premium as observed. Do not invent a sweep classifier if the source field is absent or ambiguous.
4. Treat premium (for example, `$300k`) as a later, predeclared subgroup dimension. It must not be selected after looking at outcomes.

This is intentionally smaller than “all unusual activity.” Repeated sweeps, dark-pool blocks, put sweeps, imbalance, and volume/OI groups can reuse the same normalized event/outcome machinery later.

### Outcome definition

Phase 1 measures the **underlying stock**, not the option’s mark-to-market return:

- Signal availability: the earliest timestamp at which the event could have been observed under the documented API delay/collector boundary.
- Entry: the first valid underlying 1-minute bar at or after that availability timestamp; never use a bar that ended before the signal was available.
- Horizons: `+5m`, `+30m`, `+1h`, `+1d`, `+3d`. Intraday horizons use UTC candle timestamps; daily horizons use the next valid trading-day convention defined in the methodology version.
- Return: `(exit_price / entry_price) - 1`, with a separately stored SPY return over the same timestamps and `excess_return = stock_return - spy_return`.
- Incomplete, missing, stale, halted, or outside-coverage outcomes are retained with a reason and excluded from the applicable metric denominator.

### Overlap and effective sample size

The raw event count is not the independent N. For each horizon, the primary descriptive unit is the first eligible event for an underlying during a non-overlapping exposure window of that horizon. The report shows both `raw_event_n` and `independent_n`; repeated same-event/aggregated rows are deduplicated by source identity and provider aggregation metadata. A sensitivity view can show all-event results, but it cannot be labeled independent evidence.

The first implementation must also report ticker count, ticker-day cluster count, capture dates, mature outcomes, and fresh outcome coverage. A group with a large raw N but concentrated in a few tickers or dates remains insufficient.

### Cost treatment

Because the requested outcome is the underlying stock, Phase 1 should not pretend to know historical fills unless quote data supports them. Report:

- gross return;
- a conservative, versioned round-trip cost scenario (initially a small table such as 0, 5, 10, and 25 bps per side, subject to review);
- net return under every scenario, with the scenario clearly labeled as an estimate;
- later, replace scenarios with timestamped bid/ask or a documented liquidity/slippage model when available.

No row should be called “after costs” without naming the cost model and version.

## 4. Proposed Phase 1 data model

All timestamps are UTC. Raw provider values remain available as JSON/text; normalized numeric fields are nullable when the source does not provide them.

### `source_files`

`id`, provider, endpoint, request parameters (redacted), retrieved_at, source period, page/cursor, HTTP status, response hash, raw response/archive path, parser version, status, error.

### `option_events`

`id`, `source_file_id`, `source_trade_id`, `event_uid`, `executed_at`, `observed_at`, `availability_at`, `underlying_ticker`, `contract_osi`, `option_type`, `strike`, `expiry`, `dte_at_event`, `premium_usd`, `execution_price`, `contracts`, `bid/ask/mid`, `nbbo_bid`, `nbbo_ask`, `side`, `sweep/report flags`, `trade_codes`, `is_agg`, `is_multi_leg`, `volume`, `open_interest`, `volume_oi_ratio`, `delta`, `implied_volatility`, raw payload, validation errors.

`event_uid` is based on the provider identity plus endpoint/source version. It must not be a hash of only ticker/time/premium, because those can collide.

### `underlying_bars`

`ticker`, `bar_size`, `start_time`, `end_time`, `market_time`, OHLCV, source file, adjustment/corporate-action status. Phase 1 needs 1-minute bars around events and daily bars through the +3d horizon.

### `benchmark_bars`

The same shape for SPY, with source and adjustment metadata. The benchmark series must cover every event/outcome period used in a report.

### `outcome_runs`

`id`, data fingerprint, methodology version, horizons, entry/exit convention, overlap policy, cost model, train/validation/test date boundaries, created_at, status.

### `event_outcomes`

`run_id`, `event_id`, horizon, entry/exit timestamps and prices, stock return, SPY return, excess return, each net-cost scenario, status, exclusion reason, and source bar IDs.

### `discovery_snapshots`

Immutable report JSON plus group dimensions, source run IDs, computation time, and methodology version. This is for reproducibility, not a mutable leaderboard.

## 5. Pipeline

```text
Authorized UW historical export/API
        ↓
Raw response archive + hash + pagination/coverage audit
        ↓
Normalize call-sweep events + validation diagnostics
        ↓
Fetch/cache 1m and daily underlying bars + SPY
        ↓
Join only bars available after each signal timestamp
        ↓
Apply horizon maturity and non-overlap rules
        ↓
Compute gross, excess, and named cost-scenario outcomes
        ↓
Descriptive groups fixed before outcome review
        ↓
Train discovery → chronological validation → locked test
        ↓
Snapshot report and show caveats in UI
```

The first discovery screen should show the unconditional call-sweep group and a small, predeclared set of descriptive slices (for example premium band, DTE band, and volume/OI flag). It should not search arbitrary thresholds or optimize a composite score.

## 6. Statistical and research gates

Before reading validation results, preregister:

- minimum independent event count, distinct tickers, and capture-date coverage;
- minimum fresh-outcome coverage per horizon;
- chronological split rule and embargo/gap around the split;
- overlap policy and whether standard errors are clustered by ticker-day;
- cost scenarios and benchmark definition;
- the exact group dimensions and bins allowed in Phase 1.

Reports should include bootstrap or clustered uncertainty, median and mean, win rate, concentration of returns in the largest observations, and a same-date/ticker control where the available universe supports it. A descriptive group is not a tradable rule until it survives the unseen validation period and a later prospective paper-trading period.

## 7. UI and output

Phase 1 needs three small views:

1. **Data status:** source files, event count, dedup count, date range, tickers, pagination gaps, raw-vs-normalized errors, bar coverage, and mature/fresh outcome coverage.
2. **Signal explorer:** horizon selector and fixed group table with `raw N`, `independent N`, distinct tickers, capture dates, fresh coverage, win rate, median return, average return, median/average SPY excess return, net results under named cost scenarios, confidence interval, concentration note, and status (`insufficient`, `descriptive`, `candidate for validation`).
3. **Methodology/evidence:** event-time convention, overlap policy, split dates, cost model, source IDs, and exclusions. A candidate card must never say “profitable” or “buy.”

The first downloadable report should be CSV/JSON with event-level outcomes plus a frozen summary. Example display copy:

```text
Provider-defined Call Sweeps · +1h · exploratory
Raw N 1,842 · Independent N 731 · 42 tickers · 19 capture dates
Win rate 54.8% · Median +0.18% · Mean +0.41%
Median excess vs SPY +0.07% · Net at 10 bps/side −0.02%
Status: descriptive only; validation not run
```

## 8. Required now / useful later / unnecessary complexity

### Required now

- UW API entitlement or a complete historical export; one redacted fixture;
- confirmation of whether option-trade timestamps are execution time and what delay/availability promise applies;
- a bounded period and universe with pagination/gap audit;
- raw immutable archive and normalized call-sweep schema;
- 1-minute and daily underlying prices plus SPY, with corporate-action/market-hours rules;
- fixed overlap, maturity, cost, minimum-N, and chronological split policies;
- SQLite ingestion/outcome tables, tests for dedup/time joins/look-ahead guards, and the three small UI views.

### Useful later

- put sweeps, dark pool, repeated-event clustering, imbalances, and volume/OI families;
- options mark-to-market outcomes and Greeks-aware normalization;
- richer quote-based slippage and liquidity constraints;
- placebo/universe controls, clustered bootstrap, multiple-testing correction, and prospective paper trading;
- a scheduled collector, WebSocket/Kafka ingestion, alerts, and portfolio simulation after the evidence layer is stable.

### Unnecessary complexity for Phase 1

- machine learning or an automated strategy optimizer;
- a large feature grid or arbitrary threshold search;
- microservices, queues, PostgreSQL, or cloud deployment;
- a browser extension before the API/export contract is known;
- live alerts, broker integration, or trading execution;
- options Greeks/pricing models when the first outcome is only underlying-stock movement.

## 9. Phase 1 acceptance criteria

Phase 1 is complete when one redacted historical dataset can be imported twice without duplicate N, every included event has a traceable source identity and availability timestamp, the five horizons either produce a fresh outcome or an explicit exclusion reason, the UI reproduces the frozen summary, and a chronological validation run can be executed without changing the discovery configuration.
