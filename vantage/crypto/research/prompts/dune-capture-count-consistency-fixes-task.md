# Task: Fix three verified count/labelling inconsistencies in Dune Capture

Source: `docs/MEASUREMENT_LOGIC_CONSISTENCY_AUDIT.md` (findings A1, A2, B1). All three were verified against the live `.data/crypto-research.sqlite`; the numbers quoted below are real, not hypothetical. Re-verify them yourself before and after your change — the database moves as measurements run.

## Essential context: two separate concerns, do not merge them

This is the single most important thing to understand before touching anything, and a previous suggestion to "unify" these was explicitly rejected by the user:

- **Dune Capture (`src/dune/planner.ts`, `src/dune/prescreen.ts`) answers exactly one timing question: has 24 hours passed since the signal's `observed_at`?** Nothing else. A signal captured an hour ago is not ready to fetch, because the data does not exist yet. That gate is already implemented and working correctly — leave it alone.
- **Patterns (`src/db/patterns.ts`) answers a completely different question at analysis time: is this stored data clean enough to measure a return from?** That is where `TRADE_AGE_POLICY`, the lifetime-first-per-token+type dedup, and the stale/missing classification belong.

**Do not port Patterns' quality filters into the planner, and do not port the planner's timing rule into Patterns.** They are different jobs. The bug below is that one word (`usable`) was reused across both, not that the two definitions need to agree.

---

## Fix 1 — delete the dead `byHorizon` block  (was audit finding B1)

`computeMeasurementPlan` in `src/dune/planner.ts:201` builds a `byHorizon` array whose `usable` field counts every matured checkpoint where Dune returned a price, applying neither the trade-age policy nor the dedup that Patterns applies. It therefore reports roughly double what the analysis accepts (verified at +3h: `byHorizon.usable` 867 vs `patterns.overall.nFresh` 389).

Verified before writing this task: **`byHorizon` is never rendered in the UI and never influences any fetch decision.** It is computed in the planner, returned in the plan payload, declared in the `MeasurementPlan` type in both `src/dune/planner.ts` and `ui/main.tsx:57` — and then nothing reads it. `grep -rn byHorizon tests/` returns nothing, so no test depends on it either.

Delete it: the computation in `planner.ts`, the field in both `MeasurementPlan` type declarations, and the entry in the returned plan object. This removes a misleading number rather than trying to reconcile two things that legitimately differ.

Because the plan is cached as JSON in `measurement_plan_cache` and the cache key includes `MEASUREMENT_PLAN_VERSION`, **bump the version** (currently `measurement-plan-v9`) so previously cached plans carrying the old shape are discarded. `tests/dune-planner.test.ts` asserts the version string in one place; update it.

## Fix 2 — "— up to date" appears while thousands of signals need fetching  (audit finding A1)

`ui/main.tsx:1164`'s `measurement-summary` paragraph appends `— up to date` when `unmeasured === 0 && inFlight === 0`. `unmeasured` maps to `unmeasuredCount`, which is only `byState.not_measured`.

Verified live: it currently renders **"11662 with stored outcome · 0 never measured — up to date"** while the tile directly above it says **3,346 ready to re-fetch**, and only **893** signals are actually `complete`.

Two things are wrong and both should be fixed:

1. **The "up to date" condition.** It must not claim up-to-date while there is actionable work. At minimum it must also require the screened retry queue (`retryQueueSignalIds`) to be empty. Consider whether pending unverified data should also block the claim.
2. **`measuredCount` / "with stored outcome" = 11,662.** That figure is `signals.length - not_measured - too_fresh - in_flight`, so it counts every `retry_eligible` and `elapsed_but_unavailable` signal as having a stored outcome — including the 3,346 whose stored data is *entirely* premature/unverified (verified: 100% of the queue has premature checkpoints and none has usable data). Saying 11,662 "have a stored outcome" next to a button offering to re-fetch 3,346 of them is contradictory.

The honest figures already exist in the plan: `byState.complete` (893 genuinely done), `retryQueueSignalIds.length` (3,346 actionable), `byState.elapsed_but_unavailable` (6,744 waiting). Use judgement on exact copy, but the invariant is: **no number or phrase on this page may imply work is finished while the queue is non-empty.**

## Fix 3 — retry tile subtext claims a subset larger than its set  (audit finding A2)

`ui/main.tsx:1144` renders the headline from `retryReady` (= `retryQueueSignalIds.length`, **3,346**) and then the subtext "(**4,023** of these get their first fair post-buffer check)" from `neverMaturelyAttemptedCount`.

`neverMaturelyAttemptedCount` is tallied in `computeMeasurementPlan`'s per-signal loop over signals in `byState.retry_eligible` (**4,025**), which is a *different, larger* population than the screened queue — the queue additionally drops 679 repeat observations of a token+type already represented. A subset cannot exceed its set.

Fix the denominator, not the wording: compute the premature-subset count over `retryQueueSignalIds` rather than over `retry_eligible` state. Note the ordering constraint — `retryQueueSignalIds` is produced later in `computeMeasurementPlan` than the per-signal loop that currently does the tally, so the count needs to be derived after the queue exists (or intersected with it).

The **per-signal-type path has the identical bug**: in `ui/main.tsx` the per-type branch sets `retryReady: selectedRetryCount` (queue-filtered) but reads `neverMaturelyAttempted` from `item.neverMaturelyAttempted` (state-based). Fix both branches consistently.

Worth knowing: right now **100% of the queue (3,346 of 3,346) has premature data**, so once corrected this sub-claim is temporarily redundant. It will stop being redundant as genuinely-unavailable signals re-enter the queue, so keep the count rather than deleting the line — but consider hiding it when it equals the headline.

Four assertions in `tests/dune-planner.test.ts` reference `neverMaturelyAttemptedCount` / `neverMaturelyAttempted` (lines ~50, ~52, ~134, ~149). Changing the population it is computed over **will** change what those fixtures assert. Update them deliberately and make sure each still tests its original intent — do not just adjust numbers until green.

---

## Also update

`docs/MEASUREMENT_LOGIC_CONSISTENCY_AUDIT.md` ranks B1 as "high" and offers "make `byHorizon` adopt the Patterns definition" as a suggested option. Both are now wrong: the field is dead and unrendered, and merging the two definitions was explicitly rejected. Correct that finding to reflect the delete-it resolution and its true (low) severity.

## Constraints

- **Do not change the 24h buffer, retry delays, prescreen policy, or `stateFor`.** These fixes are display/labelling and one miscounted denominator. If you believe a capture-policy change is warranted, stop and report it rather than bundling it in.
- **Do not merge the planner's and Patterns' definitions of usable data**, in either direction — see the context section above.
- Verify against the live database before and after, and state the real before/after numbers in your report. Do not rely on the figures in this document being current.
- `npx tsc -b --noEmit` and `npx tsc -p tsconfig.ui.json --noEmit` clean; full `npm test` green (133 tests at time of writing).
- Confirm the result in the running UI, not just in tests — the whole class of bug being fixed here is "the numbers on screen contradict each other," which only a live check can actually prove resolved.
- Append to `progress.md` per `CLAUDE.md` (date/time, step, files, decision + reason, agent name/model, test result, errors/unresolved, next step).
