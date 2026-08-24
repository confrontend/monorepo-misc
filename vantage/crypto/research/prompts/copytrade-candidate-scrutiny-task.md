# Task: a "Scrutiny" sub-tab that interrogates individual top candidates

Read `CLAUDE.md` and `AGENTS.md` first and follow them, including the append-only `progress.md`
entry before you finish.

**You own:** a new `src/copytrade/candidateScrutiny.ts`, its route in `src/scripts/server.ts`, a new
sub-tab in `ui/main.tsx`, and a new `tests/copytrade-candidate-scrutiny.test.ts`.

**You must not change:** `computeCopyCandidates`, `computeCopyTradeReport`, the copy-simulation
engine, any Dune query shape, or any existing gate constant. This feature is **additive and
read-only over data that already exists**. If you believe an existing gate is wrong, write it in
your progress entry as a recommendation — do not change it here.

---

## Why this exists

The pipeline currently ends at a ranked table: a handful of wallets clear every gate and are
labelled candidates. There is no view that asks _why_ a specific candidate looks good, and the
project has repeatedly produced candidates that passed every gate and were still artefacts:

- a "+819%" winner resting on **four** round trips;
- a "+34.3%" top caller whose entire edge came from **one repeatedly-traded token** — strip it and
  the wallet goes slightly negative;
- a wallet ranked as a live 30-day candidate while it had been **idle for 22 days**;
- a wallet with a **negative median and a strongly positive mean**, i.e. an edge that exists only
  if you catch its rare outliers.

Every check below exists because it caught one of those. None are speculative.

The stated end goal is to eventually trust this enough to commit small amounts of real money. That
raises the bar on this view specifically: it is the last thing a human reads before deciding. It
must make a fragile candidate _look_ fragile.

## The one design rule that must not be broken

**This view scrutinises candidates individually. It must never re-rank them.**

Deepening data for the top few and then comparing them against the other ~110 wallets on shallow
data rewards wallets for having more data, not for performing better. So:

- Every verdict is about **one wallet against fixed thresholds**, never against the other candidates.
- No leaderboard, no ordering by score, no "best candidate" designation.
- **Do not emit a composite scrutiny score.** Collapsing ten checks into one number recreates
  exactly the failure this view exists to expose. Ten independent verdicts, shown side by side.

---

## Phase 0 — inventory before you write. Report, then build.

Most of what these checks need is already implemented. Duplicating it is how the two
implementations drift and start disagreeing in the UI. Before writing feature code, confirm by
reading and list what you will reuse versus what genuinely needs to be new:

| Need                                         | Existing thing to check first                                                                                         |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| median / mean / summarize                    | `summarizeTrades`, `median`, `mean` in `src/copytrade/evaluate.ts`                                                    |
| token concentration                          | `computeProfitConcentration` in `src/copytrade/evaluate.ts` (around line 446)                                         |
| hold time per sell                           | `holdSecondsPerSell` in `src/copytrade/evaluate.ts` (around line 528)                                                 |
| dormancy                                     | `daysSinceLastTrade` / `dormant` / `DORMANT_AFTER_DAYS` in `src/copytrade/copyCandidates.ts`                          |
| tail metrics                                 | `simulatedMeanReturnPercent`, `tailShareOfMeanPercent`, `TAIL_THRESHOLD_PERCENT` in `src/copytrade/copySimulation.ts` |
| out-of-sample split                          | `splitByDate`, `suggestSplitDate` in `src/stats/holdout.ts`                                                           |
| confidence interval / sign test / correction | `bootstrapMedianCI`, `signTest`, `holmCorrection` in `src/stats/inference.ts` (holmCorrection around line 104)        |

Note that `holmCorrection` lives in `src/stats/inference.ts`, **not** `src/db/patterns.ts` — an
earlier task document in this monorepo states the wrong path. Verify before citing it anywhere.

Report anything in that table that does not exist or does not fit, rather than silently writing a
second copy of it.

---

## The checks

Each renders as **pass / fail / insufficient** with the number behind it. `insufficient` means not
enough matured data to judge, and **must be visually distinct from `fail`** — this distinction has
already been got wrong elsewhere in the monorepo and is not optional.

1. **Dormancy** — days since last completed trade. Reuse the existing field; do not recompute.
2. **Coverage, both denominators** — Dune-matched share within the scoring window _and_ across the
   wallet's full history. Show both. A candidate reading 161/161 in-window can sit at ~36% of its
   full history, and only the second number tells you how much is unmeasured.
3. **Coverage bias direction** — of the trades that are not Dune-matched, how do they differ? This
   project has measured that unmatched trades are roughly twice as likely to be >100% winners
   (20.5% vs 12.1%), because Dune fails to match thin new tokens. State whether this wallet's gap
   looks like that, and therefore whether its measured return is likely conservative or optimistic.
4. **Token concentration** — largest single token's share of total profit, plus the wallet's median
   with that token removed. The recomputed-without figure is the check; the share alone is not
   enough.
5. **Repeat-entry dependence** — median return on tokens the wallet entered more than once versus
   tokens entered exactly once. A wallet whose edge lives entirely in re-entries is running a
   position-adding strategy that a naive mirror-copier does not reproduce.
6. **Buy/sell composition** — share of scored legs that are entries. Sells were previously being
   scored as wins in the Top Callers path; surface the split so that class of bug is visible rather
   than latent.
7. **Median vs mean divergence** — both figures side by side, flagged when they disagree in sign.
   Median describes the typical trade; the equal-weight mean describes the portfolio outcome. When
   they disagree the wallet is a lottery ticket, and the reader must see that rather than pick
   whichever number was surfaced.
8. **Tail fragility** — share of total return contributed by the top 3 trades, and the count of
   trades above the existing `TAIL_THRESHOLD_PERCENT`. An edge carried by three trades must be
   visibly different from the same average carried by four hundred.
9. **Copyability** — median hold time against `DEFAULT_COPIER_DELAY_SECONDS` (15s). Report the ratio
   explicitly and label the 15s figure as an unverified assumption, because it is one: it has never
   been measured against a real fill. A wallet whose median hold is a fraction of the copy delay is
   not copyable regardless of its returns.
10. **Out-of-sample stability** — split the wallet's own history with `suggestSplitDate` and report
    the early-half and late-half medians separately. Consistency across halves is the single
    strongest evidence available here; a candidate that only worked in its first half is a fitted
    result.
11. **Selection context** — plain text: "this wallet was selected as one of N candidates from M
    wallets scanned." Derive N and M from live data. No correction is applied to the candidate
    ranking today, so the honest mitigation is showing the reader the denominator. Do not attach a
    corrected p-value to the ranking to make this look more rigorous than it is.

---

## Scoped re-fetch

Two buttons, scoped to the pinned candidates only. Both back onto routes that already exist — this
is wiring, not new fetch machinery:

- **Refresh trades (GMGN)** — call `startCopyTradeFetch(database, { walletAddresses, scope: 'single' })`,
  the same way `POST /api/copytrade/fetch/single` already does (`src/scripts/server.ts`, around line
  436). Route new work through the existing in-process rate gate (`src/gmgn/rateLimit.ts`, 5,000 ms
  between request starts). Do not add concurrency and do not weaken that interval.
- **Fill Dune coverage** — `POST /api/copytrade/copy-simulation/run` already accepts a
  `walletAddresses` body override (`src/scripts/server.ts`, around line 763, with the reasoning in
  the comment above it). Reuse it as-is.

This is cheap precisely because it is scoped: the broad fetch problem was ~100 wallets, and three to
five is minutes. Cap the pinned set (5 is reasonable) so it cannot quietly become another full run.

Both buttons must respect the existing in-progress guards and report per-wallet outcomes — which
wallets gained trades, which gained coverage, which returned nothing. "Fetched 0 new trades" has
already confused a reader once; say whether zero meant up to date or nothing came back.

---

## Requirements

- Descriptive research only. No trading, ordering, execution, or copy automation of any kind. Do not
  touch anything the deny-list in `.claude/settings.json` covers.
- Never treat missing as zero. An unmeasured trade is absent, not a 0% return.
- Every figure carries its n. A verdict without a sample size is not shippable.
- Do not change existing tables, gates, or the candidate list itself.
- Keep the existing sub-tabs untouched — this is a fifth entry in `CopyTradeSubTab`
  (`ui/main.tsx`, around line 649), added alongside `research | wallet-stats | forward-validation |
top-callers`. Remember the route parsing near line 655 and the nav buttons near line 3202.

## Tests

Add `tests/copytrade-candidate-scrutiny.test.ts` covering at minimum:

1. A wallet whose profit is dominated by one token reports the concentration check as fail, and the
   without-that-token median is materially lower than the with-it median.
2. A wallet with a negative median and positive mean is flagged as diverging, and neither figure is
   silently dropped in favour of the flattering one.
3. Insufficient and fail are distinguishable in the payload — not the same enum value, not the same
   rendering.
4. A wallet with no Dune coverage yields insufficient for every coverage-dependent check, and is
   never reported as a pass.
5. The out-of-sample split reports both halves, and a wallet with too few dates on one side returns
   insufficient rather than a one-sided number presented as stability.
6. Repeat-entry and single-entry medians are computed over disjoint trade sets that together
   reconstruct the full population.

## Verification

- `npx tsc -b --noEmit` and `npx tsc -p tsconfig.ui.json --noEmit`. `ui/main.tsx` currently carries
  pre-existing typecheck errors from concurrent work — record your starting error count before you
  begin and show you added none. Do not silently inherit the blame, and do not fix them here.
- `npm test` green. Confirm your own baseline first rather than trusting any count written here.
- `npm run build:ui`, then a live browser check.
- Run the view against the real database and paste, into your progress entry, the actual verdicts
  for the current candidates — including any check that came back insufficient. If a candidate
  fails several checks, report that plainly. A view that finds every current candidate fragile is a
  successful outcome, not a bug to tune away.

## Out of scope

No new gates, no changes to candidate selection, no new Dune query shapes, no composite score, no
GMGN endpoints not already in use. If a check needs data the project does not capture, write it as a
recommendation in your findings instead of adding capture here.

Append your `progress.md` entry before finishing.
