# Task (Frontend): Top Callers — show honest pause/retry state, never imply endless auto-retry

You are the **frontend** agent. A **backend** agent is working in parallel from
`top-callers-refetch-hardening-task.md`, which adds a bounded pause → one automatic retry →
permanent-pause state machine for GMGN collection runs. You own `ui/main.tsx` and
`ui/styles.css` only. Do not touch `src/`, `src/scripts/server.ts`, `src/db/schema.ts`, or any
file under `tests/`.

Read `CLAUDE.md` first and follow it, including the append-only `progress.md` entry.

---

## Why this exists

Today, when a Top Callers collection run hits a GMGN rate limit, the UI shows a generic "failed"
or "rate limited" status and the user has to notice, wait, and manually re-click — which silently
restarts the whole per-wallet loop from the top. The backend is adding a real pause/retry state
machine to fix the restart-from-scratch problem; this task is making that state **visible and
honest** in the UI, matching the exact behavior the backend now guarantees: one bounded automatic
retry, then a permanent pause that requires an explicit user action.

**Do not imply infinite or silent auto-retry anywhere in this UI.** The whole point of this
change is to stop treating a cooldown as a reason to keep trying — the interface must say plainly
when the system is waiting, when it retried once, and when it has stopped and is waiting for you.

---

## API contract — CODE AGAINST THIS EXACTLY (the backend implements it)

```
GET /api/top-callers/collect/status?kind=<kind>
→ existing fields you already consume (`running`, `runId`, `walletTotal`, `walletDone`,
  `rateLimitedUntil`, `message`), PLUS:
  { ...,
    status: "idle" | "running" | "paused" | "completed" | "failed" | "rate_limited" | "cancelled",
    retryCount: number,
    nextRetryAt: string | null,   // ISO, only meaningful when status === "paused"
  }

POST /api/top-callers/resume
   body: { runId?: number }   // omit to target the most recent 'paused' run
→ { runId: number, status: "running" }
   404 if no paused run exists.
```

Extend `TopCallerCollectionStatus` in `ui/main.tsx` with `retryCount: number` and
`nextRetryAt: string | null`, and widen its `status` union to include `"paused"`.

---

## What to build

### 1. A real "paused" state, distinct from "failed" and from "running"

Wherever the current running/rate-limit banners live (the `.top-caller-operation-loading` block
and the compact per-kind status line inside "Advanced evidence and manual controls" — find both
by searching for `runningKind` and `topCallerRunStatus` in `ui/main.tsx`), add a third visual
state for `status === "paused"`:

- Headline: **"Paused by GMGN — {walletDone} / {walletTotal} wallets complete."** Use the real
  numbers, never round or omit them.
- A live countdown to `nextRetryAt` (reuse the existing `topCallerClockMs`/interval-tick pattern
  already used elsewhere in this file for other countdowns — search for how `gmgnCooldownSeconds`
  is computed from a stored `rateLimitedUntil` and mirror that approach for `nextRetryAt`).
- State the retry budget honestly based on `retryCount`:
  - `retryCount === 0`: "Will retry automatically at {time}."
  - `retryCount >= 1`: **"Automatic retry used. Paused until you resume it."** — do not show a
    countdown or imply another automatic attempt is coming, because per the backend contract
    there isn't one.
- **Never show a spinner for the "waiting for a scheduled retry" state** — a spinner implies
  active work happening right now, which is misleading while genuinely idle and waiting. Reserve
  the spinner for `status === "running"` only.

### 2. A "Resume collection" button

- Visible only when `status === "paused"` and `retryCount >= 1` (i.e., the automatic retry budget
  is exhausted and nothing further will happen without you). While `retryCount === 0` and a
  countdown is still live, do not show a Resume button — the system is already going to retry on
  its own; a button here would be confusing (resume from what, exactly?).
- `onClick`: `POST /api/top-callers/resume`, then resume the same polling loop
  (`loadTopCallerStatus`) already used for other collection kinds. Handle the 404 case (no paused
  run — e.g. it was already resumed or cancelled from elsewhere) by refreshing status rather than
  showing a raw error.
- Disable while the request is in flight; standard busy-label pattern already used by this file's
  other buttons (see `leaderboardRunning ? 'Capturing…' : ...` for the exact idiom to match).

### 3. Update the orchestrator's own stage text

`runTopCallerWorkflow`'s `runCollectionAndWait` helper currently throws when a collection
`!status.running` and `status.status !== 'completed'`. A `'paused'` status is not a hard failure
in the old sense — it means "waiting on a scheduled retry, or waiting on you." Update the
orchestrator to:
- Treat `'paused'` as "still in progress, but idle" — keep polling (the backend will flip it back
  to `'running'` on its own bounded retry, or the user can intervene), rather than immediately
  throwing and setting `topCallerWorkflowStage` to a generic "stopped" message.
- Surface the same paused/retry-budget messaging from section 1 in `topCallerWorkflowStage` while
  paused, so the orchestrator's own status line agrees with the raw-controls banner instead of
  contradicting it.
- Only actually stop polling and report a real failure if the run reaches a genuinely terminal
  state (`'failed'`, `'cancelled'`) or the paused run's retry budget is exhausted **and** the user
  hasn't resumed it — do not spin forever; a reasonable stopping point is once `retryCount >= 1`
  and no resume has happened, at which point show the same "needs Resume" messaging and let the
  user act, rather than the orchestrator polling indefinitely with nothing to report.

### 4. Show `retryCount` and the last-known message honestly everywhere progress is shown

- In the compact per-kind status line (`Leaderboard`/`History`/`Dune` · running/idle/etc.), append
  `· 1 retry used` when `retryCount > 0`, for any status, not just while paused — a completed run
  that needed a retry along the way is worth knowing about even after it finishes.
- ETA: this app doesn't currently compute a "time remaining" ETA for the callouts stage beyond
  the N-of-M progress bar. If you find or add one, it must say **"ETA unavailable while
  rate-limited"** instead of a number whenever `status === "paused"` or `"rate_limited"` — never
  extrapolate a normal-conditions ETA across a pause.

---

## Requirements

- Every numeric/nullable field renders as an em dash or a clear sentence, never `0`, `NaN`, or a
  blank cell where a real value is genuinely absent.
- Reuse existing classes/patterns (`.top-caller-operation-loading`, `.top-caller-status-bar`,
  `.loading-spinner`, the busy-label button idiom) rather than inventing new visual language for
  a state this close to ones that already exist.
- Do not change any request shape beyond the two additions in the contract above. If something
  you want isn't in the contract, ask — don't derive it client-side or guess at a shape.

## Verification required before you report done

- `npx tsc -p tsconfig.ui.json --noEmit` clean, `npm run build:ui` clean.
- Verify **live in the browser**, not only by reading code. Since triggering a real GMGN rate
  limit on demand is unreliable, use the browser console to POST directly to
  `/api/top-callers/collect` and then manually update a run's row via the already-running dev
  server's database (or ask the backend agent for a way to simulate a `'paused'` state) so you
  can actually see all three states rendered: running, paused-with-countdown-and-no-button,
  paused-with-Resume-button.
- Confirm the orchestrator's stage text and the raw-controls banner never contradict each other
  while paused.
- Confirm clicking "Resume collection" actually changes the run back to `running` and the button
  disappears once it's running again.

## Out of scope

No backend logic, no new computation, no new routes beyond calling the two contracted above. If
the backend's pause/retry behavior itself seems wrong once you see it running, say so — don't
work around it client-side.

Append your `progress.md` entry before finishing.
