# Task: estimate the daily-cap gap instead of only detecting it

Read `CLAUDE.md` and `AGENTS.md` first and follow them, including the append-only `progress.md`
entry before you finish.

**You own:** `src/copytrade/fetch.ts` (additive only — see constraints), `src/db/schema.ts` (one
additive migration), `src/copytrade/eliminationFilter.ts`, its route in `src/scripts/server.ts`,
`ui/main.tsx` (the elimination panel only), and new/updated tests.

**You must not change:** the Dune coverage gate itself, the copy-simulation engine, any Dune query
shape, or the candidate-selection gates in `copyCandidates.ts`/`evaluate.ts`. This is additive: a
new, narrow, second path to `trustworthy`, never a change to the existing one.

---

## Why this exists

`GET /api/copytrade/elimination` currently reports, against the live 100-wallet cohort: **0
eliminated, 98 of 100 survivors still need Dune coverage.** Almost the entire cohort is stuck
"undecided" because `computeEliminationReport` in `src/copytrade/eliminationFilter.ts` only ever
trusts a wallet at exactly 100% Dune coverage (`TRUSTED_DUNE_COVERAGE_PERCENT`, line 28). Below
that, a wallet just sits there — the panel was deliberately built conservative, refusing to guess
whether a gap is safe.

The origin idea, from the user directly: *"we mark wallets with missing data as non-candidates
because we fear an important trade happened during the gap — but if we have the wallet's general
liquidity, or its P&L before and after that range, we can estimate whether a huge gain or loss
happened, and if not, trust that we didn't miss much."*

That idea does **not** apply uniformly to every kind of gap in this project — a prior review
(see `progress.md`, 2026-08-22) worked out exactly where it does and doesn't fit. Read that
history before writing code, because it rules out two tempting but wrong places to apply this:

1. **Dune-unmatched trades** (median coverage 54.5%) — this is a scattered, per-trade gap, not a
   bounded window, and it has already been measured as *biased*: unmatched trades are ~2x more
   likely to be >100% winners (20.5% vs 12.1%) than matched ones, because Dune fails to match
   thin, newly-launched tokens — exactly where outsized moves happen. A before/after estimate
   cannot fix a biased-missingness problem; it would need a per-trade liquidity proxy, which is a
   different, larger effort. **Do not attempt this here.**
2. **GMGN older-history truncation** — paging walks newest→oldest with no skipping
   (`fetch.ts:750` area), so a truncated wallet is missing everything *older* than a cutoff. There
   is no "after" side to bracket against. Before/after comparison structurally does not apply.

**The one gap shape this idea genuinely fits**: the **daily insert cap**
(`DAILY_TRADE_INSERT_CAP`, `createDailyCapTracker` in `fetch.ts`). On a very high-volume day, some
of that day's real trades are deliberately not stored past a per-day sampling limit. This is a
single, dated, bounded hole with real trade data immediately before and after it — exactly the
shape the user's idea describes. This task builds the estimator for **this gap only**.

---

## Phase 0 — a real gap in what's persisted today. Fix it first.

The daily-cap tracker (`fetch.ts:269`, `DailyCapTracker.countsByDay: Map<string, number>`) knows
**which exact calendar day(s)** got capped, keyed by ISO date string. But only the aggregate count
across the whole wallet/run (`daily_capped_rows`, added in the 2026-08-22 fetch-audit-diagnostics
migration) is currently persisted — the specific date(s) are computed in memory and then thrown
away. **You cannot build a before/after estimator without the date.** Verify this yourself against
current `fetch.ts` before proceeding, rather than trusting this description if the code has moved.

Add a new append-only table (additive migration, following the existing pattern in
`src/db/schema.ts`) recording one row per `(wallet_address, chain, day)` that was capped, with the
count of rows skipped that day. This is small, dated, and precise — do not fold it into the
existing aggregate columns, which lose the date entirely.

---

## Phase 1 — the estimator

For a wallet with one or more capped days, and otherwise-good Dune coverage everywhere else
(define and justify a threshold — e.g. "100% coverage on every day except the capped one(s)"),
estimate whether the capped day plausibly hid a result-changing trade:

- Pull the nearest `copytrade_wallet_stats_events` snapshots bracketing the capped day. **Be
  explicit about the real limitation here and do not paper over it**: GMGN's stats endpoint only
  exposes **rolling 7d/30d windows**, not an arbitrary date range (confirmed in prior sessions;
  also recall `avg_holding_period` from this same endpoint was previously found unreliable by 3-4
  orders of magnitude — treat every field from it with the same skepticism, not just the ones this
  task happens to use).
  - `copytrade_wallet_stats_events` is fetched sporadically, not on a schedule that lines up with
    capped days — a snapshot close enough in time to bracket a specific day tightly may simply not
    exist. If it doesn't, the estimate is **`insufficient`**, not a guess.
- Compare the realized-PnL delta across the bracketing snapshots against what the wallet's own
  *stored, uncapped* trades from that same window already explain. Only the **unexplained
  remainder** is candidate evidence of a hidden trade.
- Convert the unexplained remainder into a plain magnitude check against the wallet's own typical
  trade size (e.g. compare it to the wallet's median or largest stored `cost_usd` round trip) —
  not an arbitrary fixed dollar threshold, since wallets in this cohort range from $10 to $50k+
  position sizes.
- Output three states, never two: **`small_gap`** (unexplained remainder is not large relative to
  this wallet's own typical trade), **`large_gap`** (it is), and **`insufficient`** (no snapshot
  close enough, or the delta can't be meaningfully isolated). `insufficient` must never render or
  behave like a pass — it is a data-coverage state, exactly the distinction this project has
  gotten wrong before and since fixed elsewhere (see `computeCallerCheckpointBreakdown`'s
  `awaiting_dune_fetch` vs `no_trade_in_window` split in `topCallers.ts` for the precedent to
  follow).

## Phase 2 — wire it into elimination, narrowly

In `computeEliminationReport` (`eliminationFilter.ts:86`), add a **second, explicit path** to
`trustworthy` that is only reachable when:
- Dune coverage is 100% everywhere **except** day(s) covered by a daily cap, and
- every one of those capped days independently resolves to `small_gap` (never `insufficient`,
  never `large_gap` — one bad day disqualifies the whole wallet from this path).

Do not lower `TRUSTED_DUNE_COVERAGE_PERCENT` itself, and do not touch the existing 100%-coverage
path. Add a field to `WalletEliminationEntry` (e.g. `trustworthyVia: 'full_coverage' |
'bounded_gap_estimate' | null`) so the UI and any future reader can always see *why* a wallet was
trusted, not just that it was.

## Requirements

- Descriptive research only, per this project's absolute boundary — no trading, ordering, or
  execution capability of any kind.
- Never treat missing as zero, and never treat `insufficient` as a pass. If you are tempted to
  default an ambiguous case to `small_gap` to make the panel show fewer stuck wallets, don't —
  report the true `insufficient` count instead. A view that shows most wallets as
  `insufficient` right now is an honest outcome, not a bug to tune away.
- Every number in the estimate carries what it's based on (which snapshots, what window, what
  remainder) so a human can audit one wallet's verdict by hand.
- This must remain narrowly scoped to the daily-cap gap shape. Do not generalize it to Dune
  coverage or GMGN truncation — those were explicitly ruled out above for reasons that don't go
  away just because this estimator exists.

## Tests

1. A capped day with tight bracketing snapshots and a small unexplained remainder resolves
   `small_gap`.
2. The same setup with a large unexplained remainder resolves `large_gap`.
3. No snapshot close enough to the capped day resolves `insufficient`, never a default pass.
4. A wallet with two capped days, one `small_gap` and one `large_gap`, is NOT promoted to
   trustworthy via the bounded-gap path (all capped days must clear).
5. `trustworthyVia` correctly distinguishes a wallet trusted via full coverage from one trusted via
   the bounded-gap estimate, and a wallet trusted via neither.
6. The existing 100%-coverage `trustworthy` path and its tests are unchanged (run the existing
   `tests/copytrade-elimination-filter.test.ts` suite and confirm zero regressions).

## Verification

- `npx tsc -b --noEmit` clean.
- `npm test` fully green — record your starting baseline count first (345 passing as of
  2026-08-22) rather than trusting that number if it has since moved.
- `npm run build` (server + UI) clean.
- Run `GET /api/copytrade/elimination` against the real live database and report, in your
  progress entry, real before/after counts: how many of the "98 survivors still need Dune
  coverage" actually have a daily-cap-only gap (as opposed to genuinely low Dune coverage,
  which this task does not touch), and of those, how many resolve `small_gap` vs `large_gap` vs
  `insufficient`. If the number of wallets this actually helps is small, say so plainly — that is
  a valid and useful finding, not a failure of the task.

## Out of scope

No changes to Dune-unmatched-trade handling, no changes to GMGN-truncation handling, no lowering
of `TRUSTED_DUNE_COVERAGE_PERCENT`, no new GMGN/Dune endpoints. If the rolling 7d/30d window
resolution turns out to be too coarse to ever produce anything but `insufficient` in practice, say
so in your findings and recommend against building further on this path rather than loosening the
gates to force a result.

Append your `progress.md` entry before finishing.
