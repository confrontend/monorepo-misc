# Task: add tail-aware (mean + extreme-gain) scoring alongside the existing median gates

Read `CLAUDE.md` first and follow it, including the append-only `progress.md` entry.

You own `src/copytrade/copySimulation.ts`, `src/copytrade/copyCandidates.ts`,
`src/scripts/server.ts`, `ui/main.tsx`, `ui/styles.css`, and the matching test files.

---

## Why this exists

This project deliberately uses **median** everywhere, for a good reason recorded in `progress.md`:
an early bug showed a group at +111% average while its median was −44%, so averages were banned
as misleading. That decision was correct **for judging whether a wallet is skilled**.

It is the wrong metric for a different question: **what an equal-position-size copier actually
earns**. With equal $ per trade, portfolio return is the arithmetic mean of per-trade returns,
not the median. Memecoin returns are heavily right-skewed, so a wallet can have a negative median
and still be strongly profitable.

This was measured live on real copy-simulation data (737 simulated round trips across 6 wallets)
and the gap is large, not theoretical:

| Wallet   | Median | Mean (equal-weight) | Trades >+100% | Max    |
| -------- | ------ | ------------------- | ------------- | ------ |
| DxM1hfY8 | −4.5%  | **+51.4%**          | 17            | +1137% |
| H9TMtTxB | −3.8%  | **+30.1%**          | 17            | +683%  |
| 7JFSAQbo | +52.6% | **+88.6%**          | 55            | +554%  |
| 4BdKaxN8 | −17.9% | −5.2%               | 9             | +505%  |
| FAicXNV5 | −3.3%  | −1.2%               | 5             | +280%  |
| ENkZtLj1 | −5.5%  | −9.1%               | 0             | +23%   |

Pooled: **median −3.5%, mean +25.7%, 103 of 737 trades over +100%.** The current median-only
gate rejects DxM1hfY8 and H9TMtTxB, which are the second- and third-best wallets by the metric
that matches how a copier would actually trade them.

**The goal is to report both, not to replace median with mean.** Median answers "is this wallet
skilled / is the typical copy profitable"; mean answers "would equal-size copying have made
money". They disagree here and both are true. Any design that drops median, or that silently
switches the headline number to mean, is wrong.

---

## What to build

### 1. Tail metrics in the copy simulation report (`copySimulation.ts`)

`CopySimulationWalletReport` currently carries `simulatedMedianReturnPercent`,
`walletMedianReturnPercent`, `worstSimulatedReturnPercent`, etc. Add, computed over the **same
`simulated`-status population** the existing medians use (never a different subset):

- `simulatedMeanReturnPercent: number | null` — arithmetic mean of `simulatedReturnPercent`.
  This is the equal-position-size portfolio return per trade. Null when nothing was simulated.
- `walletMeanReturnPercent: number | null` — same for the wallet's own returns, so the
  delay/fee cost can be compared on the mean as well as the median.
- `tradesAbove100Percent: number` and `tradesAbove300Percent: number` — counts of simulated
  trades clearing those thresholds. Counts, not percentages, so a small sample can't hide behind
  a ratio.
- `bestSimulatedReturnPercent: number | null` — the mirror of the existing
  `worstSimulatedReturnPercent`. The report currently shows the worst case and not the best,
  which structurally hides exactly the tail this task is about.
- `tailShareOfMeanPercent: number | null` — what share of the total summed return comes from
  trades above +100%. **This is the honesty check on the mean**: 95% means one or two trades are
  carrying everything and the mean is fragile; 40% across many winners is a real distribution.
  Null when the summed return is ≤ 0 (the share is meaningless then — do not emit a negative or
  > 100% figure, and do not clamp it into looking sane).

Constants for the thresholds (`TAIL_THRESHOLD_PERCENT = 100`, `EXTREME_TAIL_THRESHOLD_PERCENT =
300`) next to the existing tunables, not inline numbers.

### 2. Surface it on candidates (`copyCandidates.ts`)

`CopyCandidateWithSurvival` already carries `simulatedMedianReturnPercent` and
`copySimulationCoverageRatePercent`. Add `simulatedMeanReturnPercent`, `tradesAbove100Percent`,
and `tailShareOfMeanPercent`, plumbed from the same simulation input the median already comes
from (`CopySimulationSurvivalInput` — extend it rather than adding a second lookup).

### 3. Do NOT change the copy-survival gate's pass/fail rule in this task

`computeCopyCandidates` currently requires `simulatedMedianReturnPercent > 0` to survive. **Leave
that rule exactly as it is.** Adding a mean-based OR-condition would change who counts as a
Winner, and that decision needs its own review with the numbers visible first — which is what
this task exists to provide. Report the new metrics; do not let them gate anything yet. Say so
explicitly in your `progress.md` entry.

### 4. UI (`ui/main.tsx`, `ui/styles.css`)

On the Copy Simulation winner cards (the `copy-sim-detail-grid` region), add alongside the
existing median comparison:

- **Mean (equal size)** — the copier mean, with the same positive/negative colouring the median
  uses.
- **Big wins** — e.g. `17 trades >+100%` (and the >+300% count in the tooltip).
- **Tail concentration** — `tailShareOfMeanPercent`, rendered with a plain-language tooltip:
  the mean depends on a few extreme winners, and a high share means it's fragile.

Add one short explanatory line to the Copy Simulation section (reuse `InfoTip`, matching the
existing pattern) stating plainly: _median is the typical copy; mean is what equal-size copying
would have returned; they can disagree and both are real._ Do not bury this — the whole point is
that a reader currently sees only half the picture.

Every numeric field is nullable — render `null` as an em dash, never `0`.

---

## Requirements

- Same population, always. Every new metric is computed over the `status === 'simulated'` trades,
  the identical set the existing medians use. Do not quietly include `missing_entry_match` or
  `not_yet_queried` trades to inflate a count.
- Never present the mean as the single headline number. Median and mean appear together
  everywhere, or the change has made things worse rather than better.
- No new API routes. `GET /api/copytrade/copy-simulation` and `/api/copytrade/winners` already
  return these objects; the new fields ride along.
- No changes to how the simulation itself fetches or matches Dune data.

## Tests (append to `tests/copytrade-copy-simulation.test.ts` and `copytrade-copy-candidates.test.ts`)

1. A wallet whose returns are mostly small losses plus a few large winners reports a **negative
   median and a positive mean** — the exact real shape of DxM1hfY8. Assert both, in one test, so
   the divergence is the thing under test.
2. `tailShareOfMeanPercent` correctly identifies a fragile mean: a fixture where one +2000% trade
   dominates reports a share near 100%, while a fixture with many moderate winners reports a much
   lower share.
3. `tailShareOfMeanPercent` is `null` (not negative, not clamped) when the summed return is ≤ 0.
4. Tail counts only include `simulated` trades — a `not_yet_queried` or `missing_entry_match`
   trade with a large `walletReturnPercent` must not be counted.
5. The copy-survival gate still passes/fails exactly as before — a wallet with a negative median
   and a strongly positive mean is still **not** a Winner after this change. This is the
   regression test that proves the gate was left alone.

## Verification

- `npx tsc -b --noEmit` and `npx tsc -p tsconfig.ui.json --noEmit` clean.
- `npm test` green; confirm your starting baseline count first rather than trusting a number
  written here.
- `npm run build:ui` clean.
- Verify against the **real database**, not just fixtures: `computeCopySimulationReport` for
  `DxM1hfY8FQ8dNGrucuJzhJcF8KRbjk8WBwrgKvQ9spPv` should report roughly median −4.5% / mean +51%
  / 17 trades >+100%, and `7JFSAQbodH8otbLx1K6hzjT3CU7k71VmpReLu4mMNYrV` roughly median +52.6% /
  mean +88.6% / 55 trades. Paste the real output into your progress entry.
- Live-check the Winners tab renders the new fields with real data and no console errors.

## Out of scope

Do not change the copy-survival gate, the median definition, the delay/fee/slippage assumptions,
or anything about Dune fetching. Do not add a "best of median-or-mean" ranking — that is a
selection decision to be made after seeing these numbers, not part of exposing them.

Append your `progress.md` entry before finishing.
