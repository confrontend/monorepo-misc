# Frozen specification: ETF rating trust and persistence research

Status: frozen before the first Python ETF research result was generated.

This document defines two different questions. They are separate correction families and must never
be combined into one pass/fail label.

Prior evidence is known. Before this specification was written, the TypeScript ETF Discovery screen
had already shown descriptive holdout results and a separate experimental clustered analysis. This
is therefore a frozen durable implementation contract, not a claim of blind pre-registration.

## 1. Universe

- Include only tickers whose normalized SQLite metadata has `tickers.fund_type = 'ETF'`.
- Restrict prices, rating events, tested trades, matched pools, and placebo draws to those ETFs.
- A usable observation requires a finite positive adjusted price and one canonical Quant rating.
- The imported universe may be survivor-filtered. No result may be called survivorship-bias-free.

## 2. Time split

- `validation_end` is the latest usable ETF price date.
- `validation_start` is 365 calendar days before `validation_end`.
- Only signals dated on or after `validation_start` are tested by these families.
- A trade whose complete exit is unavailable is dropped, never shortened.

The earlier period remains available to the exploratory ETF Discovery screen. The Python families
below do not use it to choose a rule; they test their entire frozen grids in the validation year and
correct for every declared cell.

## 3. Shared execution

- The signal date is not tradable.
- Entry is the first usable ETF record strictly after the signal date.
- The target exit is `entry + hold_days` calendar days.
- Exit is the usable ETF record closest to the target within plus or minus seven calendar days.
- Ties choose the earlier record. If no record is within the tolerance, drop the trade.
- SPY return uses its adjusted close on the exact entry and exit sessions. Missing benchmark coverage
  drops the trade.
- One signal is emitted per continuous qualifying rating episode for one grid cell.
- Results are gross of commissions, spread, slippage, taxes, liquidity constraints, and market impact.

## 4. Family A: rating trust versus SPY

Question: **Do ETFs selected by a bullish Quant rating outperform simply owning SPY?**

Grid: 2 rating definitions x 3 holds = 6 cells.

- `strong_buy`: rating is Strong Buy only.
- `bullish_plus`: rating is Buy or Strong Buy.
- Holds: 30, 90, and 180 calendar days.
- Signal: the first observed transition from outside the rating definition into it. An ETF already
  qualifying on its first observed row is left-censored and does not create an invented transition.
- Primary outcome: `ETF adjusted return - SPY adjusted return` for the same entry and exit sessions.

This family owns the main ETF trust verdict. A persistence result may not override it.

## 5. Family B: persistence improvement versus bullish ETFs

Question: **After an ETF is already bullish, does waiting for that rating to persist improve the
selection beyond other ETFs carrying the same bullish rating?**

Grid: 2 rating definitions x 4 persistence windows x 3 holds = 24 cells.

- Rating definitions: `strong_buy` and `bullish_plus` as above.
- Persistence: 30, 60, 90, and 180 calendar days.
- Holds: 30, 90, and 180 calendar days.
- Signal: the first usable date in a continuous qualifying episode whose calendar age reaches the
  persistence requirement.
- Matching pool: other ETFs qualifying for the same rating definition on the signal date. The signal
  ETF is excluded. Each pool ETF uses the same next-record entry and calendar-hold exit rule.
- Primary outcome: signal ETF adjusted return minus the arithmetic mean return of that matching pool.
- ETF-minus-SPY return remains a descriptive column, but it is not this family's inferential outcome.

Failure in Family B means only that waiting did not improve an already-bullish selection. It does not
mean the rating failed to beat SPY.

## 6. Statistical rules

Apply these rules independently to each family:

- Minimum 15 distinct ETF ticker clusters per cell.
- Test the primary outcome with `wild_cluster_bootstrap_t`, clustered by ETF ticker, using the shared
  pipeline's 4,999 Rademacher replications and CR1 correction.
- Compute descriptive ticker-cluster percentile confidence intervals for the mean.
- Apply Holm and Benjamini-Hochberg corrections over every declared cell in that family. Untestable
  cells remain in exported output and carry no displayed inferential values; p=1 is used only for the
  frozen correction burden.
- A cell clears the statistical bar when `|t| >= 3.0` and Holm p `< 0.05`.
- A positive clearing cell is evidence for the family hypothesis. A negative clearing cell is
  evidence against it; it must not be labeled a winner.

## 7. Diagnostics

- Run the shared concentration diagnostic on every clearing cell and on the largest-|t| testable cell,
  even when no cell clears.
- Family A placebo: choose random ETFs from the ETF universe on the real signal dates and apply the
  identical timing; compare mean ETF-minus-SPY return.
- Family B placebo: choose random ETFs from the matching bullish ETF pool on each real signal date and
  apply identical timing; compare mean excess over that pool.
- Use 2,000 deterministic placebo simulations. Report observed mean, random median, 5th/95th
  percentiles, and empirical p.
- A positive statistical result that does not separate from placebo is not a reliable rating-specific
  edge.

## 8. Required outputs and UI language

Write:

- `research/report/etf_rating_trust_results.csv`
- `research/report/etf_persistence_results.csv`
- `research/report/etf_rating_trust_concentration.csv`
- `research/report/etf_persistence_concentration.csv`
- `research/report/etf_rating_trust_placebo.csv`
- `research/report/etf_persistence_placebo.csv`
- `research/report/etf_meta.json`

Research Lab must display two independent headlines:

1. `Bullish ETF ratings vs SPY`: supported, evidence against, or no reliable evidence.
2. `Persistence improvement vs bullish ETF pool`: adds value, evidence against, or no reliable edge.

Each section must state `N of M cells clear the statistical bar`, show the full grid, show the
strongest-cell diagnostics, and retain the survivor-universe and gross-of-costs warnings.

Each cell also reports `absolute_loss_rate`: the fraction of trades where the ETF's own return was
negative, independent of SPY or the bullish pool. This is purely descriptive -- it does not feed the
discovery bar, the correction, or either headline verdict -- because `beat_spy_rate`/`beat_pool_rate`
only measure relative outperformance and can look strong even when the ETF itself lost money, as long
as it lost less than the benchmark did.

ETF Discovery remains the fast descriptive 24-rule holdout screen. Its practical winner is
exploratory and cannot replace either Python Research verdict.
