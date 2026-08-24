# Task: Investigate and fix possible indexing-lag bias in "received" Dune checkpoints

## Background (read this before touching anything)

This project measures Solana GMGN signal outcomes via Dune SQL (`src/dune/outcomes.ts`, `measureDuneOutcomes`/`sqlFor`). Each signal gets up to 6 checkpoints (`signal, +5m, +15m, +30m, +1h, +3h`). The matching SQL is:

```sql
... LEFT JOIN normalized_trades t
  ON t.token_address = c.token_address
  AND t.block_time <= c.target_at
  AND t.block_time > c.target_at - INTERVAL '24' HOUR
... row_number() OVER (PARTITION BY c.signal_id, c.checkpoint ORDER BY t.block_time DESC, ...) AS rn
... WHERE rn = 1
```

This picks the **latest trade Dune has currently indexed** before each checkpoint's target time — not necessarily the true latest real trade, if Dune's own indexing pipeline hasn't caught up yet at query time.

Earlier this session (2026-08-14) we found and fixed a related but distinct problem: most of this project's ~11,662 historical signals had their **first-ever Dune query fired within minutes of capture**, long before a 24h observation buffer was introduced (see `progress.md` entries from today, `src/dune/prescreen.ts`'s `MIN_SIGNAL_AGE_MS`, `src/dune/planner.ts`'s `stateFor`). That fix only affects **whether/when a new Dune request is sent** — it does nothing to checkpoints that already came back `received` under the old, premature-query regime.

## The open question

A checkpoint's `result.status` is `'received'` once Dune returns _any_ matched trade — there is no check for whether Dune's indexing was actually complete at query time. Once `received`, a checkpoint is **never re-verified or retried** — only `'not available'` checkpoints go through the retry queue (`src/dune/planner.ts`'s `stateFor`). The existing safeguards in `src/db/patterns.ts`'s `classifyComparison` (`TRADE_AGE_POLICY`, the "stale" same-trade-reused check) only look at the _distance between the matched trade and the checkpoint target time_ — neither one can detect "this trade was the latest Dune had indexed at query time, but a truer/later trade existed and got indexed afterward."

So it's plausible that a meaningful number of `received` checkpoints currently feeding `computeSignalPatternReport` (the Patterns tab) are based on an incomplete view of trades, silently skewing the median/average returns the Patterns tab reports — but this has **not been empirically confirmed**, only established as a real mechanism.

## What to do

**Step 1 — measure it, don't assume it.** Before writing any fix:

- Pick a real, meaningful sample of signals whose first Dune query happened while they were young (e.g. `requested_at - observed_at < 6h` — use the same query pattern as `signalIdsWithRuns` in `src/dune/planner.ts`, or query `dune_outcome_runs` directly) and whose checkpoints came back `received`.
- Re-run the _exact same_ `sqlFor` query for a sample of those signals now (they're all well past 24h old at this point) and diff the results against what's stored: same `matched_trade_at`/`matched_tx_id`/`price_usd`, or different?
- If the values are consistently identical, the risk is theoretical and not real in practice for this dataset (Dune's indexing may complete fast enough that it doesn't matter within the timeframe these checkpoints were queried) — report that finding and stop; do not build a fix for a problem that doesn't reproduce.
- If values _do_ differ for a non-trivial fraction, quantify: how many signals affected, how large the price/return deltas are, and whether they're large enough to matter (e.g. would they flip a group's `reliable`/`verdict` classification in `computeSignalPatternReport`).

**Step 2 — only if Step 1 finds a real effect**, design a fix. Some directions to consider (pick based on what Step 1 actually shows, don't default to the most complex option):

- Add a lightweight re-verification pass: for `received` checkpoints whose _matching_ query happened before the signal was 24h old, re-query once and update in place if the result changed, similar in spirit to `reconcileStuckRuns` but for `received`-not-`not available` data.
- Or: track per-checkpoint whether it was queried while premature, and let `computeSignalPatternReport` exclude/flag those from `fresh` until re-verified — conservative, no new Dune cost, but shrinks sample sizes.
- Whatever you choose, follow this project's established evidence-first, no-silent-defaults conventions (see `src/db/patterns.ts`'s existing comments on `classifyComparison`/`TRADE_AGE_POLICY` for the house style) and this repo's `CLAUDE.md` progress-logging rule.

## Constraints

- Do not touch the 24h-buffer/retry logic already shipped today (`src/dune/prescreen.ts`, `src/dune/planner.ts`) — this is a separate, downstream data-quality question about checkpoints that already came back `received`, not about when new queries are sent.
- Do not add a fix without Step 1's empirical evidence in hand — this project has repeatedly found that assumed timing/data problems didn't match reality once actually measured (see today's `progress.md` history), and an unnecessary fix here would add Dune API cost for no benefit.
- Any new Dune queries you run for Step 1's investigation are read-only measurements — do not modify `dune_outcome_runs` or any stored outcome as part of investigation, only as part of an approved Step 2 fix.
- Update `progress.md` per this repo's `CLAUDE.md` convention (append-only, with agent name/model, files touched, decision + reason, test results, next step).
