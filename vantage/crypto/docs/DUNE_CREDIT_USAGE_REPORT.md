# Dune credit usage report

Generated 2026-09-05 from the local SQLite database.

## Scope and source

This report covers `copytrade_copy_simulation_runs`. Dune's reported
`execution_cost_credits` is stored inside each run's `dune_status_payload`.
The database contains 1,541 executions with a reported cost. This is app-local
usage only; it is not a complete Dune-account statement for queries run outside
Vantage.

## Total usage

| Measure | Value |
| --- | ---: |
| Executions with recorded cost | 1,541 |
| Total reported credits | **4,554.5043** |
| Average per execution | 2.9556 |
| Median per execution | 0.2085 |
| Completed executions | 1,538 · 4,531.8240 credits |
| Failed executions | 3 · 22.6804 credits |
| Minimum execution | 0.0307 credits |
| Maximum execution | 135.9554 credits |

The median is much lower than the average, so a small number of expensive
queries account for a disproportionate share of consumption.

## Cost distribution

| Cost range | Executions | Credits |
| --- | ---: | ---: |
| < 1 credit | 1,126 | 248.9298 |
| 1–<10 credits | 316 | 1,240.1768 |
| 10–<50 credits | 88 | 2,203.0643 |
| 50–<100 credits | 8 | 514.1847 |
| ≥100 credits | 3 | 348.1487 |

The 88 executions costing 10–50 credits consumed 48.36% of all recorded
credits. The three executions costing at least 100 credits consumed 7.64%.
The ten most expensive executions consumed 17.72%.

## Credits per delayed-copy trade target

The requested target list is persisted in `copytrade_copy_simulation_runs.trade_refs`
as a JSON array. Therefore `json_array_length(trade_refs)` gives the exact number
of delayed-copy targets submitted to each costed execution. This is the best
target denominator available in the current schema; there is no separate
`processed_target_count` column.

The same payload also persists `result_metadata.row_count` and
`result_metadata.datapoint_count`, but those are output/result measures, not a
reliable target denominator. A query can return fewer rows than requested (for
example, when no matching trade is found), and datapoints are not one-to-one
with targets.

Across the 1,541 executions with recorded cost:

| Metric | Result |
| --- | ---: |
| Total costed executions | 1,541 |
| Total trade targets | **227,464** |
| Average credits / trade target | **0.020023** |
| Median credits / trade target | **0.001457** |
| P90 credits / trade target | **0.042946** |
| Estimated targets at 2,500 credits — average | **124,856** |
| Estimated targets at 2,500 credits — conservative (P90) | **58,212** |

The average is the weighted total (`4,554.5043 / 227,464`). The median and P90
are calculated per execution after dividing each execution's cost by its own
target count, so unusually small or expensive batches remain visible rather
than being hidden by the aggregate.

### Batch-size efficiency

The planner's normal maximum batch is 150. There are 1,501 executions at that
size, representing 225,150 targets and 4,305.2240 credits:

| Batch size | Executions | Targets | Credits / target (average) | Median | P90 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 150 | 1,501 | 225,150 | 0.019122 | 0.001377 | 0.038323 |
| All sizes | 1,541 | 227,464 | 0.020023 | 0.001457 | 0.042946 |

At the full-batch P90 rate, 2,500 credits supports approximately **65,235**
targets. Smaller batch sizes are too sparse to compare reliably: most sizes
occur once, so their per-target figures are dominated by query-specific scan
cost and are not stable benchmarks.

### Reliability of the capacity estimate

This estimate is **approximate**, not a Dune billing guarantee. The target
counts are exact for submitted copy-simulation targets, but future cost depends
on token activity, time-window width, partition selectivity, retries, and the
mix of batch sizes. The P90 figure is a conservative planning bound based on
historical per-execution normalized cost. It also excludes any Dune workflows
whose costs were not persisted in `copytrade_copy_simulation_runs`.

## Most expensive executions

| Run ID | Credits | Result rows | Datapoints | Execution time |
| ---: | ---: | ---: | ---: | ---: |
| 2537 | 135.9554 | 150 | 750 | 137.5 s |
| 2242 | 109.2731 | 109 | 545 | 150.6 s |
| 2544 | 102.9201 | 149 | 745 | 166.9 s |
| 2551 | 71.5790 | 137 | 685 | 58.7 s |
| 1243 | 69.4613 | 129 | 645 | 47.1 s |
| 2520 | 69.4613 | 149 | 745 | 429.3 s |
| 2246 | 63.9554 | 117 | 585 | 31.1 s |
| 2227 | 63.5319 | 129 | 645 | 113.9 s |
| 2239 | 61.4143 | 113 | 565 | 66.7 s |
| 2243 | 59.7201 | 82 | 410 | 59.3 s |

## Why some executions cost more

The cost is not determined by the number of returned rows alone. The query
uses Dune's `dex_solana.trades` table and dynamically builds a batch-specific
time range and token-address filter. The main likely drivers are:

1. **Bytes scanned in the source table.** A batch covering a broad timestamp
   span and many active token addresses can touch much more partitioned trade
   data, even when the final result has only 100–150 rows.
2. **Batch time-span and token density.** The query scans both bought and sold
   mint columns and uses a `UNION ALL`; dense periods or popular tokens increase
   the scanned input.
3. **Batch shape and query complexity.** Each batch includes a `VALUES` target
   list, matching window, ranking, and per-target nearest-trade ordering. The
   current planner caps batches at 150 targets, but a full batch is still much
   more expensive than a sparse batch.
4. **Retries and historical re-runs.** Every submitted Dune execution costs
   independently. Failed or superseded runs are not free if Dune already
   started executing them.

Execution duration is a diagnostic signal, not the billing formula. The stored
result metadata shows that expensive runs often have similar result-row and
datapoint counts to cheap runs. That means the difference is primarily upstream
scan volume/partition selectivity, not the response size.

## Important accounting limits

- Costs are only included when Dune returned and the app persisted
  `execution_cost_credits`.
- `dune_outcome_runs` does not have a dedicated credit-cost column, so its full
  historical total cannot currently be aggregated reliably from SQLite.
- Archived outcome payloads contain at least 66.8028 credits, but that is a
  partial archive-derived figure and must not be added to the 4,554.5043 total
  without a deduplication/accounting pass.
- This is not the same as the Dune dashboard's account-wide usage number.

## Practical conclusion

The application has enough data to explain its recorded copy-simulation
spend, including expensive outliers. It does not yet have a complete unified
credit ledger across every Dune workflow. The next useful improvement would be
to persist a normalized credit row per execution (workflow, run ID, query ID,
execution ID, cost, status, requested time) and aggregate all workflows from
that ledger.
