# Unusual Whales backtest report

## System readiness

The research system is usable. The PostgreSQL fixture path passed the complete
fixture workflow: historical ZIP/CSV import, market-bar writes, outcome
calculation, comparison, diagnostics, cancellation, and resume. The full
automated suite has 76 test cases: 72 pass and four live PostgreSQL tests are
skipped by default;
the production SQLite OOS and walk-forward runners and UI build also pass.

SQLite remains the default backend. PostgreSQL is available explicitly through
`UNUSUAL_WHALES_DB_BACKEND=postgres` after configuring `POSTGRES_URL`.

## Breadth inventory

Measured sources:

- Call Sweeps and Put Sweeps: completed full-tape history with durable resumable coverage.
- Flow Imbalance: derived from completed sweep history with point-in-time outcomes.
- Dark Pool Blocks: 4,100 raw; 1,184 usable +1d outcomes after targeted price refresh.
- Open Interest Spikes: 4,400 raw; 1,795 usable +1d outcomes.
- Market/ETF Flow: 27,529 raw; 63 usable +1d outcomes.
- GEX/Gamma: 541,956 raw observations; 722 usable +1d outcomes after first-observation-per-symbol/day control.
- Insider Activity: 9,433 raw; 2,085 usable +1d outcomes.
- Congress Activity: 4,425 raw; 109 usable +1d outcomes.

Repeated Sweeps remains unavailable because no verified historical adapter is
implemented. The other listed families are now imported, outcome-matched, and
reported with their coverage limitations.

## Selection rules

A candidate requires:

- at least 30 usable outcomes;
- mature +1d evidence;
- non-negative estimated net return after 25 bps per side;
- explicit coverage and out-of-sample warnings.

The descriptive in-sample leader is not treated as a strategy recommendation.
All metrics remain exploratory and include explicit maturity, overlap, coverage,
SPY-relative, and cost limitations.

## Frozen holdout result

The full frozen validation now runs all nine selected families with a one-week
embargo and untouched August holdout. Examples from the holdout include Call
Sweeps +1d: 4,050 usable outcomes and +1.16% average return; Put Sweeps +1d:
3,186 usable and -1.37%; GEX +3d: 91 usable and +2.64%; OI +1d: 442 usable and
-0.34%. These figures are descriptive OOS evidence, not a profitability claim.

Conclusion: the system and backtest are operational, resumable, and point-in-
time constrained. The available evidence does not establish a tradable
Unusual Whales strategy; larger forward-collected holdouts and execution-aware
validation are still required.

## Walk-forward validation

The system now supports sequential frozen windows. Each window freezes its
signal selections, horizons, cost assumptions, maturity cutoff, and methodology
fingerprint before the holdout is evaluated. The production command is:

```bash
npm run validate:walk-forward -- docs/examples/walk-forward-config-2026-08.json
```

The configured run completed successfully for two holdout windows across Call
Sweeps, Put Sweeps, and Dark Pool Blocks. It reports risk diagnostics including
return standard deviation, maximum drawdown, profit factor, and estimated net
returns at multiple cost levels. Several +10d/+20d cells are intentionally
`insufficient` because the current data horizon cannot yet mature those outcomes;
the validator preserves that limitation rather than filling it with partial data.

This is now a usable research and validation system, not evidence of a finished
trading strategy. Continued forward capture, more matured sessions, and
execution-aware fill modeling remain necessary before live deployment.
