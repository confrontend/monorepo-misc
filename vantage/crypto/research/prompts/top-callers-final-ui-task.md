# Task (Frontend): Top Callers — implement the "final UI" decision-view redesign

You are the **frontend** agent. This is a visual/structural redesign of an already-working page —
no backend, schema, or API work is needed or in scope. You own `ui/main.tsx` and `ui/styles.css`
only. Do not touch `src/`, `src/scripts/server.ts`, `src/db/schema.ts`, or any file under `tests/`.

Read `CLAUDE.md` first and follow it, including the append-only `progress.md` entry.

---

## What exists today

The Top Callers page (`#copytrade/top-callers` in `ui/main.tsx`) already works end-to-end against
a real backend: GMGN leaderboard capture, per-wallet caller history fetch, Dune checkpoint
measurement, and a best-caller ranking — all backed by real data, not mocked. The current layout
is an "outcome overview" (verdict-first cards, metrics grid, checkpoint timeline, evidence
sample, then a collapsed "Raw data and collection controls" `<details>` section).

**This task is not "build Top Callers"** — it's "restyle and restructure the existing page to
match a specific approved mockup," reusing all existing state, handlers, and API calls. If you
find yourself writing a new `fetch()` call or a new piece of derived state that already exists
(check `topCallerLeaderboard`, `topCallerEvaluation`, `topCallerDetail`, `topCallerRunStatus`,
`runTopCallerWorkflow`, `collectTopCaller`, `toggleTopCallerTracking` and the derived variables
computed inside the `copyTradeSubTab === 'top-callers'` render block), you are duplicating logic
that already exists — reuse it instead.

## The target design

`ui-mockups/top-callers-final-ui.html` is the approved reference — a static HTML/CSS mockup, not
real React. Open it and use its structure, copy, and visual language as the target:

- One dominant workflow action ("Run caller research" / "Run complete caller research" — keep
  the existing button and its `runTopCallerWorkflow` handler, just restyle the surrounding panel
  to match `.tc-run` in the mockup).
- A status/scope bar showing real counts: captured / included / not included / Dune measured
  (`.tc-status` + `.tc-scope` in the mockup). Compute these from real data — `topCallerLeaderboard`
  for captured/included/not-included (tracked vs. total rows), `topCallerEvaluation` for how many
  have `measuredCallCount > 0`. Do not invent placeholder numbers.
- A "best measured caller" section (`.tc-best`) — this already exists as
  `top-caller-best-summary`; restyle it to match, keep its underlying ranking logic
  (`rankedEvaluations`/`bestEvaluation`) untouched.
- Outcome-by-checkpoint chart and representative calls (`.tc-content-grid`'s two sections) —
  these already exist (`checkpointRows`, `representative`); restyle only.
- "Inspect a caller" dropdown, explicitly labeled as viewing-only, not affecting the research run
  (`.tc-inspect` — note copies "Viewing only — does not change the research run"; carry that
  exact framing over, it's there specifically to prevent a real confusion a user had earlier this
  project about a similar selector).
- Collapsed "Advanced evidence and manual controls" section (`.tc-advanced` /
  `<details>`) — this already exists as the "Raw data and collection controls" `<details>`; keep
  the collapse-by-default behavior, restyle to match, keep every control inside it working
  (capture leaderboard, fetch caller history, measure checkpoints, the leaderboard table with
  track/untrack, the caller detail table).

## Two states the mockup does NOT design — you must add them anyway

This was flagged and explicitly approved before this task was written: the mockup only shows the
**completed** state (`.tc-status` reads `COMPLETE · 25 callers reviewed...`). It has no visual for
the two states users actually hit most:

### 1. Actively running

While `runTopCallerWorkflow` is executing (`topCallerWorkflowBusy`) or a raw collection is running
(`topCallerRunStatus[kind]?.running`), the status bar must show real progress, not just a static
"running" label:

- For the leaderboard/checkpoints stages: a spinner + the current stage label
  (`topCallerWorkflowStage`, already maintained by the orchestrator).
- For the callouts/history stage specifically: real per-wallet progress —
  `topCallerRunStatus.callouts.walletDone` of `topCallerRunStatus.callouts.walletTotal`, with a
  progress bar. This data already exists (added specifically to fix a real "is this stuck?"
  incident — see `progress.md`, 2026-08-17 entries) and is already wired into
  `topCallerWorkflowStage` during the orchestrator's polling loop and into the raw-controls
  banner (`.top-caller-operation-loading`) — reuse that data and wiring, don't recompute it.
- Base this state's visual on `ui-mockups/top-callers-ux.html`'s `.notice` block (spinner +
  "N of M callers complete · X calls saved"), adapted into the final design's visual language
  (colors, panel style) — that mockup got this state right, the final one just dropped it.

### 2. Rate-limited / partially failed

- GMGN cooldown: the existing `gmgnCoolingDown` derived state and its message (already computed
  from `topCallerRunStatus.leaderboard?.rateLimitedUntil` / `.callouts?.rateLimitedUntil`) must
  remain visible and restyled to fit the new design — do not remove or hide it.
  This case in the status bar should visually match the "problem" tone (like `.tc-status` but
  with a warning color), not the panel's default green success framing.
  It must state the resume time and never suggest retrying immediately.
- Orchestrator failure (`topCallerWorkflowStage` set to a "stopped" message + `topCallerError`
  populated): show which stage it stopped on and that data already fetched is retained — do not
  imply the whole run's progress was lost (it wasn't, per the incremental-persistence fix).
- A run that returns "already in progress" (409) is not a failure — it means another collection
  is genuinely running; treat it the same as the running state above, not as an error banner.

## Requirements

- Reuse the app's existing dark theme tokens/classes where they already fit (e.g., the existing
  `.top-caller-rate-limit`, `.loading-spinner`, `.source-badge` classes) rather than hand-rolling
  new colors that drift from the rest of the app.
- Every numeric field is nullable — render `null`/`undefined` as an em dash, never `0`, `NaN`, or
  a blank cell.
- Do not change any API call, request shape, or response handling. If a number the mockup wants
  isn't already available from existing state, say so and stop — do not derive it with a guess or
  add a new endpoint yourself.
- Keep the "Included/Not included" language from the final mockup — it's clearer than
  "tracked/untracked" and was called out as a specific improvement worth keeping.
- Do not remove any existing functionality from the collapsed advanced section: capture
  leaderboard, fetch caller history, measure checkpoints, per-row track/untrack, and the caller
  detail table must all still work exactly as they do today.

## Verification required before you report done

- `npx tsc -p tsconfig.ui.json --noEmit` clean, `npm run build:ui` clean.
- Verify **live in the browser** against the running dev server — not just by reading code.
- Specifically trigger and observe **both** of the two states above for real, not just the happy
  path:
  1. Click "Run complete caller research" (or a raw "Fetch caller history") and confirm the
     running state shows real, incrementing N-of-M progress — poll `walletDone` a few times and
     confirm the displayed number actually changes, the same way it was verified when the
     underlying data was added (`progress.md`, 2026-08-17).
  2. Trigger or wait for a rate-limited/cooldown state (or start a second collection while one is
     active, which reliably reproduces the "already in progress" case) and confirm it renders
     clearly, with a resume time where applicable, and never as a generic crash/error.
- Confirm an empty/fresh-database state (no leaderboard captured yet) still renders cleanly with
  no `NaN`/`undefined`/blank cells.
- Confirm the collapsed advanced section's controls (track/untrack, each collection button) still
  work exactly as before.

## Out of scope

No new API routes, no schema changes, no changes to `computeCallerEvaluationReport` or any other
backend ranking/evaluation logic. No changes to the orchestrator's actual fetch sequence — only
its presentation.

Append your `progress.md` entry before finishing.
