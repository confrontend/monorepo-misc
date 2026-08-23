# Agent A — Validate what already exists, before anything new is added

Read `CLAUDE.md` and `AGENTS.md` first and follow them, including the append-only `progress.md` entry.

**You own:** `src/research/*` (analysis, correction, reporting) and `tests/*`.
**You must not touch:** `src/providers/*`, `src/infra/*`, or anything under `ui/`. Agent B owns those.

---

## Why this track exists

A consolidated recommendation proposed nine feature additions. Its own closing line contradicted
its ordering: *"don't add dozens of signals before validating the existing promising ones. First
determine whether Call Sweeps' current OOS advantage survives longer history, longer horizons,
and realistic execution costs."* That sentence is correct and this track exists to act on it.

Verified already built, so do not rebuild: walk-forward with frozen sequential windows and a
selection fingerprint, `+1d/+3d/+5d/+10d/+20d` horizons, and 10/25/50 bps-per-side cost
scenarios (`progress.md`, 2026-08-21). Ten signals are registered in
`src/research/signal-catalog.ts`.

## The problem to solve

Ten signals × five horizons × three cost scenarios is **150 result cells**. Ranking 150 cells and
reporting the best one will produce an impressive number even if every signal is noise. Nothing
in `src/research/` currently corrects for this.

This is not hypothetical. In this monorepo's sibling `crypto` project, exactly this pattern
produced a "+819% winner" that rested on four trades, and a "+34.3% top caller" whose entire edge
came from one repeatedly-traded token. Both survived every filter that existed at the time.

## What to build

### 1. Multiple-comparisons correction

The sibling project already implements Holm correction (`crypto/src/db/patterns.ts`,
`holmCorrection`) for the identical problem. Port that approach — do not invent a new method, and
do not copy the file blindly; re-derive it against this project's own result shape.

- Apply across the full grid actually scanned, not per-signal in isolation. The denominator is
  every cell the selection process could have chosen from.
- Report both raw and corrected significance side by side. Never replace the raw number silently.
- Emit the **cell count that was scanned** in the report payload. A reader must be able to see
  that 150 comparisons stood behind a "best" result.

### 2. An honest evidence gate per cell

A cell is reportable only when it has enough matured outcomes to mean anything. Reuse this
project's existing sufficiency notion if one exists; otherwise mirror the sibling's
`MIN_RELIABLE_SAMPLE = 10` and its explicit reason codes rather than a bare boolean.

Critically: distinguish **`insufficient` (not enough matured sessions yet)** from **`tested and
failed`**. The walk-forward run already returns `insufficient` for long horizons because the
database lacks future sessions — that is a data-coverage state, not a negative result, and the
two must never render the same way.

### 3. Answer the actual question, in writing

Produce a short written finding in `research/findings/` that answers, with real numbers:

> Does Call Sweeps' out-of-sample advantage survive longer horizons and realistic execution
> costs, after correcting for how many cells were scanned?

State the sample size and coverage behind every figure quoted. If the answer is "not enough
matured data yet", say exactly that and name what is missing — do not fill the gap with the
horizons that do have data and present it as the answer.

## Requirements

- Descriptive only. Do not add signals, do not change signal definitions, do not alter what is
  captured.
- Never treat missing as zero. An unmatured horizon is absent, not a 0% return.
- Every number in a report carries its `n` and its coverage.
- If correction removes every previously-promising result, that is a valid and important
  finding — report it plainly rather than loosening the gate until something passes.

## Tests

1. Holm correction matches a hand-computed example exactly.
2. Scanning more cells makes it strictly harder for any single cell to survive.
3. A cell with too few matured outcomes reports `insufficient` with a reason, and is never
   counted as a pass.
4. `insufficient` and `tested-and-failed` are distinguishable in the report payload.
5. Raw and corrected significance both appear; corrected never overwrites raw.

## Verification

- `npm test` fully green. Confirm your own starting baseline count first — do not trust a number
  written here; `progress.md` last recorded 76 cases / 72 passed / 4 skipped.
- Server and UI builds pass.
- Re-run `npm run validate:walk-forward -- docs/examples/walk-forward-config-2026-08.json` and
  paste the real before/after significance counts into your progress entry.

## Out of scope

No new signal families. No provider, ingestion, or streaming changes. No UI work. If you believe a
new signal is needed, write it in your findings as a recommendation — do not build it.

Append your `progress.md` entry before finishing.
