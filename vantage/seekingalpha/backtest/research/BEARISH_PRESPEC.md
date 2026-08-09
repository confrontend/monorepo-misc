# Bearish-rating research specification

Status: frozen for the first durable implementation on 2026-08-06, before the implementation was run.

This document defines how the application will test whether Seeking Alpha `Sell` and `Strong Sell` ratings contain a usable short signal. The code must not silently change these rules. A future methodology change requires a new version of this document and a newly generated report.

## Important disclosure

This is not a blind pre-registration. Exploratory transition results were already inspected before this document was written. Those exploratory results suggested that stocks in the current survivor-only export rose on average after bearish transitions and that naive fixed-horizon shorts lost money before costs. The purpose of this specification is to prevent further researcher discretion while building the permanent analysis, not to erase that prior knowledge.

The existing bullish persistence grid is a different, previously run family. Its results and multiplicity correction remain unchanged.

## Question

Two separate hypotheses are tested:

1. **Bearish transition family:** What happened after a stock newly crossed into a bearish rating?
2. **Bearish persistence family:** What happened after a stock had remained bearish for a sustained period?

These are separate families because they describe different signals and have different entry rules. Their p-values are corrected separately. Neither family is pooled with the existing bullish grid.

## Data and rating mapping

- Stock return data: daily adjusted closing prices from `historical_prices`.
- Benchmark: daily adjusted SPY closes from `benchmark_prices`.
- Rating events: point-in-time `ticker_changes` rows.
- Rating tiers:
  - `very_bearish` = Strong Sell = 1
  - `bearish` = Sell = 2
  - `neutral` = Hold = 3
  - `bullish` = Buy = 4
  - `very_bullish` = Strong Buy = 5
- `-`, missing, and unknown ratings are excluded.
- Ratings are forward-filled only after their timestamp; no rating is backfilled before it was observed.
- Adjusted closes are used because a short investor is economically affected by splits and dividends. Results remain gross of borrow fees, locate fees, slippage, commissions, margin costs, and forced buy-ins.

## Shared execution rules

- The rating date is a signal date, never an executable close.
- Entry is the first available stock-market session strictly after the signal date.
- Holds are 30, 90, or 180 **calendar days** from the entry session.
- Exit is the first available stock session on or after `entry date + hold days`.
- Stock and SPY adjusted closes must both exist on the actual entry and exit dates.
- A trade is incomplete and excluded when its target horizon does not fit inside the available data. The analysis must report, per cell, the number of candidate signals, completed trades, incomplete trades, and overlapping signals skipped.
- The code must never substitute the last available price before the target horizon. This prevents a 60-day observation near the dataset end from being mislabeled as a 180-day observation.
- Only one trade per ticker may be open within one test cell. A new qualifying signal before the existing fixed-horizon exit is counted as an overlap and skipped. This prevents one company from being shorted repeatedly for the same continuing episode.

## Outcomes

Every rule is tested against both outcomes below. They are two tests inside the same correction family.

### Raw short return

```text
raw short return = -(stock adjusted return)
```

This is the gross profit or loss from shorting one dollar of stock, before implementation costs. Positive is good for the short; negative means the stock rose and the short lost money.

### SPY-hedged short return

```text
SPY-hedged short return = SPY return - stock return
```

This represents shorting the stock while holding an equal notional amount of SPY. Positive means the bearish stock underperformed SPY. It is not the same as an outright profitable short.

## Family 1: transition into bearish

### Signals

- `sell_or_strong_sell`: the prior known tier is above 2 and the new tier is 2 or below.
- `strong_sell_only`: the new tier is 1 and the prior known tier is not 1.
- The first observed rating for a ticker is not a transition because no prior rating is known.

### Frozen grid

```text
2 signal definitions x 3 holds x 2 outcomes = 12 tests
```

There is no lookback parameter in this family.

## Family 2: persistent bearish rating

### Signals

- `sell_or_strong_sell`: every observed trading day in the trailing window has tier 2 or below.
- `strong_sell_only`: every observed trading day in the trailing window has tier 1.
- The signal occurs only on the first day the full trailing window qualifies. Continuing qualifying days do not create repeated signals.
- If the rating later stops qualifying and then a complete qualifying window forms again, a new signal may be created, subject to the no-overlap rule.
- No dip/relief tolerance is included in this first family. Persistence is strict.

### Frozen grid

```text
2 signal definitions x 4 lookbacks x 3 holds x 2 outcomes = 48 tests
```

Lookbacks are 3, 6, 12, and 18 trading-month approximations: 63, 126, 252, and 378 trading observations.

## Statistical rules

- Unit shown in the table: completed trade.
- Dependence control: ticker-cluster wild bootstrap-t; all observations from one ticker remain in the same cluster.
- Minimum testable sample: 15 unique ticker clusters. Thinner cells are reported but not tested.
- Null hypothesis: mean outcome is zero.
- Test: two-sided.
- Discovery display bar: `|t| >= 3.0` and Holm-corrected `p < 0.05`.
- Benjamini-Hochberg adjusted p-values are exported as secondary information but do not control the headline.
- Transition-family Holm scope: all 12 transition tests.
- Persistence-family Holm scope: all 48 persistence tests.
- Cells below the 15-cluster floor have no inferential p-value. They remain in the declared correction burden as `p=1`, while their own raw/adjusted p-values remain undisplayed and their status remains untestable.
- A statistically negative mean is evidence against the short rule, not a profitable discovery.
- Each row must show completed trades and unique ticker clusters. Sample-size claims may not use the total signal count in place of the completed count for that horizon.

## Diagnostics

For the strongest testable cell in each family, selected by absolute t-statistic whether positive or negative:

- Run a concentration check showing whether a few observations dominate the result.
- Run 2,000 random-ticker placebo simulations with the same entry/exit dates and the same outcome definition.
- Report the observed mean, random median, random 5th-95th percentile, and empirical two-sided extremeness rate.
- Placebo and concentration results are diagnostics. They do not undo the family-wide Holm correction.

## Universe audit and interpretation limit

The report must include:

- The global last stock-price date.
- The number and names of ticker series ending more than 30 calendar days before that date.
- A warning when essentially all real tickers survive to the dataset end, because that is evidence of a survivor-filtered export.

The audit is evidence, not proof, that delisted securities are omitted. Proving provider behavior requires querying known delisted symbols or obtaining a point-in-time historical universe.

The strongest permitted conclusion from this dataset is scoped to observed survivors:

> Among companies that survived and remained covered in this export, bearish ratings did or did not produce profitable fixed-horizon shorts under the tested gross-return rules.

The analysis must not claim market-wide short performance, because missing bankruptcies, acquisitions, going-private events, ticker changes, and delisted securities can materially change a short backtest. A point-in-time universe and delisting returns are required for that claim.

## Output contract

The run writes:

- `bearish_transition_results.csv`
- `bearish_persistence_results.csv`
- `bearish_transition_concentration.csv`
- `bearish_persistence_concentration.csv`
- `bearish_transition_placebo.csv`
- `bearish_persistence_placebo.csv`
- `bearish_meta.json`

The React Research lab must present bearish results separately from bullish results and must explain, in plain language:

- positive raw short return = an outright short made money before costs;
- positive hedged short return = the stock lagged SPY;
- a stock may lag SPY while still rising, so the two outcomes can disagree;
- incomplete horizons were dropped rather than truncated;
- survivor-only conclusions do not cover companies missing from the export.
