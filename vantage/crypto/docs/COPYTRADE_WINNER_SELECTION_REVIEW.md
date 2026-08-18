# CopyTrade winner selection: current process, limitations, and independent review brief

**Status:** Review requested — descriptive documentation only  
**Prepared:** 2026-08-15  
**Scope:** `src/copytrade/roster.ts`, `src/copytrade/fetch.ts`, `src/copytrade/evaluate.ts`, and the CopyTrade UI

## Implementation update — 2026-08-15

The code-level recommendations from this review have now been incorporated into methodology
`copytrade-evaluation-v3`:

- positive verdicts are labelled **Screen pass**;
- truncated wallets are **Descriptive only — not comparable**;
- exact leaderboard request provenance is stored append-only;
- rank history and top-five membership are reported from repeated captures;
- weekly/monthly performance and profit concentration are reported;
- results excluding the best trade and best token are included;
- historical wallet performance and the unavailable copy simulation are separate report sections.

The remaining limitations require future observations rather than another scoring change:
rank persistence is uninformative until multiple leaderboard captures exist, walk-forward testing
requires trades after a frozen selection time, and copy simulation requires preregistered execution
assumptions or measured execution evidence.

## Executive summary

The application currently identifies a “winner” as a wallet whose stored, completed sell trades meet a small set of deterministic rules. It does **not** predict future performance, simulate real copy execution, or prove that the wallet will remain a top trader.

The current process is useful for screening, but the largest limitation is roster selection: the app evaluates the newest captured GMGN leaderboard, while the historical trades may cover a different period. A wallet can therefore look successful over a short favorable interval even if it was not consistently ranked near the top. Rank persistence, rolling performance, execution delay, and out-of-sample validation are not yet part of the winner decision.

## 1. Current data flow

### 1.1 Selecting the wallets

1. A GMGN wallet-rank response is captured by the browser extension and stored as an append-only `gmgn_wallet_rank_snapshots` row.
2. The snapshot retains the raw payload plus query context such as `window` and `orderby`.
3. `syncCopyTradeRoster()` reads the newest snapshot and stores the ranked wallets in `copytrade_wallets`. Older snapshots remain in the database.
4. `listRosterWallets()` scopes the active roster to the newest snapshot and orders by GMGN rank.
5. The UI’s **Top traders** selector chooses N rows from that current roster (currently 25, 50, 100, or 250).

Important consequence: the app does not independently reproduce GMGN’s internal ranking formula or win-rate filter. If the GMGN page was filtered to `win rate > 50%` before capture, that filtered roster is evaluated; the app does not apply that rule itself.

### 1.2 Fetching history

For the selected roster, the app calls GMGN’s official read-only portfolio activity endpoint through the project-local `gmgn-cli` package. It requests buy and sell activity serially, stores raw activity payloads, and preserves history in SQLite.

The UI’s **Period** selector requests a 7-, 30-, or 90-day window. Fetches are append-only and idempotent: overlapping pages are counted as duplicates rather than inserted again. Each wallet has a 200-request ceiling. If the ceiling is reached, the wallet is marked `truncated` and only the newest fetched slice is available.

### 1.3 Constructing measurable trades

- Buys are retained to estimate holding time and risk context.
- Sells are the evaluation unit.
- A sell is usable only when both proceeds (`cost_usd`) and its supplied cost basis (`buy_cost_usd`) are numeric and positive.
- Return is `(proceeds - cost basis) / cost basis`.
- Sells without a usable cost basis are retained and counted as excluded; they are never silently treated as zero return.
- The history span is computed from usable completed sells, not from unrelated or malformed rows.

This is a realized-trade analysis of the target wallet. It is not a copy-trading simulation: it excludes the copier’s entry delay, slippage, priority fees, failed transactions, GMGN fees, and liquidity effects.

## 2. Current winner rules

The rules are defined in `src/copytrade/evaluate.ts`:

| Rule | Current requirement |
|---|---:|
| Completed usable sells | At least 100 |
| Usable history span | At least 7 days |
| Typical outcome | Median return must be positive |
| Risk flags | None; any risk flag blocks a positive verdict |
| Requested history coverage | Must not be truncated |

Verdict precedence is:

1. `flagged` — the wallet has a risk flag, including GMGN’s `wash_trader` tag or an unknown-risk marker.
2. `incomplete` — the requested history was truncated by the request ceiling.
3. `thin` — fewer than 100 completed sells or less than 7 usable days.
4. `no` — enough data exists, but the median return is not positive.
5. `yes` — all rules pass.

The `yes` label means **“passes this descriptive data screen.”** It does not mean “safe,” “profitable to copy,” or “expected to win in the future.”

## 3. Reported metrics and how they are combined

For each wallet the report shows:

- completed-trade count;
- win rate, defined as the share of usable sells with positive return;
- median return, used for the verdict;
- average return, withheld when coverage is truncated;
- equal-weight `$100` portfolio result;
- a secondary compounded result, explicitly not treated as the headline;
- covered days and truncation state;
- risk evidence such as fast round trips, missing cost basis, median hold time, wallet age, and funding source when available.

The report also returns two different aggregate views:

- **Trade-weighted:** every trade contributes; high-volume wallets dominate.
- **Wallet-weighted:** each wallet contributes one observation; this better answers how a typical selected wallet performed.

Both are retained because they answer different questions. Neither corrects for selection bias or execution friction.

## 4. What the current process does well

- Preserves raw source data and append-only history.
- Separates duplicate rows from malformed rows.
- Keeps incomplete coverage visible instead of presenting it as a clean winner.
- Uses median as the primary typical-outcome statistic, reducing sensitivity to extreme outliers.
- Reports both trade-weighted and wallet-weighted aggregates.
- Keeps the active report scoped to the newest roster, avoiding accidental inclusion of wallets that have dropped out.
- Stores methodology version and report scope in snapshots.
- Fails closed on unknown risk metadata rather than treating unknown as clean.

## 5. Discovered limitations

### 5.1 Current rank is not rank persistence

The app stores historical leaderboard snapshots, but the winner evaluation uses the newest snapshot as the active roster. It does not currently calculate:

- how many days a wallet stayed in the top 5, 25, or 50;
- how often it entered or left the leaderboard;
- rank volatility;
- whether its performance occurred before or after it became highly ranked;
- whether the wallet was successful for only a short burst.

A wallet that was excellent for two weeks can therefore pass a 7-day minimum and appear in a 90-day report without proving 90 days of stable performance.

### 5.2 Selection and hindsight bias

Evaluating today’s top wallets over their historical trades is a form of hindsight selection. Wallets that failed and disappeared may not be in the current roster, while successful survivors are overrepresented. This can make historical results look better than a real-time selection process would have been.

### 5.3 No prospective or chronological holdout

The report does not reserve a future period that was not used to select the wallet. A wallet can pass using the same history later used to describe its result. There is no walk-forward test such as “select at date T, then evaluate only trades after T.”

### 5.4 Real copying is not modeled

The report uses the target wallet’s realized sells and cost basis. It does not model:

- detection latency;
- transaction submission delay;
- worse entry price;
- slippage and liquidity;
- priority fees, tips, and GMGN fees;
- failed or partially filled copy orders;
- token filters or wallet balance constraints.

Therefore, the current result is an upper-bound description of the target wallet’s own activity, not an estimate of copier PnL.

### 5.5 Truncation and high-volume-wallet bias

The 200-request wallet ceiling protects rate limits but means the busiest wallets may be represented by only their newest slice. Truncated wallets are marked incomplete and their average-based figures are withheld, but median and win rate can still describe a non-random recent slice. This can make comparisons between low-volume and high-volume wallets uneven.

### 5.6 The 100-trade and 7-day thresholds are screening gates, not statistical proof

Passing the minimum thresholds does not establish confidence, significance, or stability. The current logic does not calculate confidence intervals, multiple-testing adjustments, bootstrap uncertainty, or a minimum number of independent calendar periods.

### 5.7 No explicit regime or subperiod consistency test

A positive full-period median can conceal a large loss in the latest week or a result driven by one short market regime. Results are not currently split into weekly/monthly blocks with a consistency requirement.

## 6. What “winner” should mean in a stronger system

The term should be separated into three labels:

1. **Screen pass:** meets the current data-quality and descriptive rules.
2. **Stable historical candidate:** passes across independent periods and does not rely on a single favorable burst.
3. **Prospective copy candidate:** selected using information available at the decision time and evaluated in a later holdout with realistic execution assumptions.

The current `yes` verdict only supports label 1.

## 7. Recommended improvements

### Priority 1 — make roster history measurable

Add a roster-history report keyed by wallet and snapshot:

- snapshot timestamp;
- rank position;
- GMGN window/order/filter context;
- days observed in the selected top-N set;
- median and win rate per snapshot period;
- entry/exit dates from the top-N roster.

Do not overwrite snapshots. Preserve each captured leaderboard as evidence.

### Priority 2 — add walk-forward evaluation

For each roster snapshot at time T:

- select wallets using only data available at T;
- define a fixed subsequent evaluation window;
- prevent later snapshots from changing the historical selection;
- report results by selection date and aggregate across dates.

This directly addresses hindsight and survivorship bias.

### Priority 3 — require temporal consistency

Before calling a wallet stable, require performance to be evaluated over multiple independent periods, for example:

- at least three capture dates or monthly blocks;
- no single block contributing all positive performance;
- minimum usable trades per block;
- latest-block result reported separately.

The exact thresholds should be preregistered before using them to label winners.

### Priority 4 — model copier friction separately

Add a separate simulation layer, never overwrite the current realized-wallet report. It should use:

- configurable detection delay;
- entry and exit slippage;
- liquidity constraints;
- priority and platform fees;
- failed-order assumptions;
- fixed-size or proportional copy sizing;
- copy-sell behavior.

The result should be labeled **simulated copy outcome**, not target-wallet return.

### Priority 5 — improve uncertainty reporting

Add, preferably in a separate analysis package:

- confidence intervals for median and win rate;
- bootstrap or sign/permutation tests;
- multiple-testing correction when comparing many wallets or filters;
- clustered treatment of repeated trades within wallets;
- sensitivity to excluding fast round trips, transferred-in tokens, and extreme outliers.

No statistical method should turn a biased roster into an unbiased one; uncertainty analysis comes after selection and coverage are fixed.

## 8. Independent review request

Please have an independent reviewer assess the implementation and data—not just this document—using the following questions:

### Reproducibility

1. Can a reviewer reproduce the active roster from a stored snapshot without relying on the current GMGN website?
2. Are the exact GMGN filter, period, chain, ordering, and capture timestamp preserved?
3. Can the reviewer reproduce every included sell and return from raw payloads?

### Selection validity

4. Does evaluating the newest top-N roster against older trades create survivorship or hindsight bias?
5. Is the active roster appropriate for a 7-, 30-, or 90-day claim?
6. Should top-five selection be evaluated separately from broad research comparisons?

### Measurement validity

7. Are cost-basis exclusions, transferred-in tokens, partial sells, and duplicate legs handled correctly?
8. Does truncation change the population in a way that makes median or win-rate comparisons misleading?
9. Are the 100-trade and 7-day gates justified, or are they only operational thresholds?

### Stability

10. Does the wallet remain strong across independent weeks/months and multiple leaderboard snapshots?
11. Is the result driven by one short burst, one token, one market regime, or one extreme trade?
12. Does rank persistence predict anything beyond the current rank itself?

### Real-world copying

13. How much would detection delay, slippage, fees, liquidity, and failed transactions reduce the observed result?
14. What copy-trade configuration and maximum position size would be needed for a fair simulation?
15. Which conclusions remain valid if the target wallet cannot be copied at the same price?

### Required reviewer output

The reviewer should return:

- confirmed defects and severity;
- a list of claims that are supported, unsupported, or not yet testable;
- recommended preregistered thresholds;
- a minimum data collection period;
- a proposed walk-forward evaluation design;
- a clear distinction between “screen pass,” “stable candidate,” and “prospective copy candidate.”

## 9. Current conclusion

The application can currently identify wallets that pass a transparent historical screen. It cannot yet establish that they are durable winners or that copying them will be profitable. The most important next improvement is not a more complicated score: it is preserving and using leaderboard history so that wallet selection is evaluated prospectively and across time.
