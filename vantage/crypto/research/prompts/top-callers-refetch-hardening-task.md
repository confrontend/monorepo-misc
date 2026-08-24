# Task (Backend): Top Callers — stop refetching known data, and stop treating every GMGN cooldown as an invitation to retry forever

You are the **backend** agent. A **frontend** agent is working in parallel from
`top-callers-resilience-frontend-task.md`, coded against the API contract at the end of this
document. You own `src/copytrade/topCallers.ts`, `src/copytrade/topCallerCheckpoints.ts`,
`src/copytrade/fetch.ts`, `src/db/schema.ts`, `src/scripts/server.ts`, and
`tests/top-callers.test.ts`. Do not touch `ui/main.tsx` or `ui/styles.css`.

Read `CLAUDE.md` first and follow it, including the append-only `progress.md` entry.

---

## Context

This merges two audits of Top Callers' collection system, both verified against real code before
being approved — no guessed gaps:

**Refetch/coverage gaps (audit 1):**

1. Leaderboard capture has no cooldown against accidental rapid re-clicks.
2. Per-wallet backfill silently caps at 1 day even when a wallet's real last-known callout is
   much older — quietly dropping history instead of catching up.
3. Checkpoint dedup only checks _completed_ outcomes, not in-flight claims — no atomic guard
   against two overlapping submissions of the same Dune target.

**Rate-limit resilience gaps (audit 2, confirmed against real code):** 4. **`runGmgnTrackKol` (the leaderboard capture) completely bypasses the shared GMGN request
queue.** `fetchActivityPageRaw` in `fetch.ts` calls `waitForGmgnRequest()` before every
request, and both CopyTrade's roster fetch and Top Callers' wallet-activity fetch go through
it — but `runGmgnTrackKol` calls `execFileAsync` directly with zero pacing or serialization.
This means a leaderboard capture can fire at the exact same moment as an in-flight CopyTrade
or callout fetch against the same account-level rate-limit bucket, with no coordination
between them. Confirmed by reading the code, not assumed. 5. **Diagnostics under-report what actually happens.** The background collection run
(`void startCollectionRun(...).catch(...)` in `server.ts`) only logs to `logDiagnostic` on an
_uncaught_ error at the outer async-void boundary. `startCollectionRun`'s per-wallet loop
catches its own errors internally and just writes the run's own `status`/`error` column — a
rate limit or failure mid-loop never reaches that `.catch()`, so it never appears in the
diagnostics log at all, only in the run's own row (invisible unless you know to poll it). 6. **A retry today means "start an entirely new run from wallet 1."** Individual wallets already
resume cheaply from their own stored watermark (a fully-synced wallet resolves in one fast
request — this is NOT being reopened, see the "already correct" list below), but a fresh
manual click still walks the full tracked list from the top, re-spending real rate-limit
budget re-confirming "nothing new" for every already-synced wallet before it even reaches the
ones that were never fetched. That makes hitting a second 429 more likely, not less. 7. **No bounded automatic retry, no pause/resume state, no permanent-stop guarantee.** Today a
rate limit just fails the run; the user has to notice and manually re-click, which (per #6)
restarts from the top. There is currently **no auto-retry or auto-resume mechanism anywhere in
this codebase** — confirmed by checking every call site of `runTopCallerWorkflow` and
`collectTopCaller`; both are exclusively `onClick`-triggered. This task adds a bounded,
explicit version of automatic retry — not blind retry-until-it-works.

**Already correct — do not "fix" these, they were verified working:**

- Per-wallet resume-by-watermark (`MAX(call_timestamp)` → `knownLatestTimestamp` →
  `fetchWalletActivity`'s cutoff) already avoids re-walking pages already known.
- Checkpoint measurement already skips any `(callout_id, checkpoint)` pair already in
  `top_caller_outcomes`, and skips anything not yet matured.
- The existing `stopCollectionRuns`/`isCollectionRunCancelled` mechanism (user Stop) already
  works and is checked inside the per-wallet loop. Build the new pause/retry state **on top of
  it**, don't replace it — user-initiated Stop must always win over any automatic retry.

---

## Fix 1: leaderboard capture cooldown

- `msSinceLastCollectionStart(database, 'leaderboard')` reading `started_at` from the most recent
  `top_caller_collection_runs` row of that kind.
- **10 seconds**, named `LEADERBOARD_CAPTURE_COOLDOWN_MS` next to the other tunables at the top of
  `topCallers.ts`. Keep it short and explicitly scoped as an anti-double-click debounce, distinct
  from GMGN's own real rate-limit cooldown (`rateLimitedUntil`) — it must never be the thing that
  makes a legitimate retry wait longer than GMGN's own indicated cooldown already requires.
- On rejection in the `POST /api/top-callers/collect` route: `429` with remaining-seconds, in the
  same message style as the existing GMGN rate-limit messages (see `rateLimitResetFromMessage`).
- Only gates `'leaderboard'`.

## Fix 2: per-wallet backfill gap beyond 1 day, reported honestly

- Change `runGmgnWalletActivity`'s cutoff from `Math.max(oneDayAgo, knownLatestTimestamp ?? 0)`
  to `knownLatestTimestamp ?? oneDayAgo` — always walk back to the real watermark, not capped at
  1 day. The existing 10-page loop cap stays as the per-call safety bound; a very stale wallet may
  need more than one collection run to fully catch up, which is fine.
- When the 10-page cap is hit and the oldest fetched row still hasn't reached
  `knownLatestTimestamp`, add `hasGap: boolean` to `FetchWalletActivity`'s return.
- Aggregate gap info across the whole per-wallet loop and report it **once**, at the end, in the
  run's completion message — the count of wallets with a gap and their caller keys, alongside the
  existing inserted/skipped counts. Do not overwrite a shared message field per wallet (that would
  silently lose every wallet's gap info except the last one written).

## Fix 3: checkpoint dedup — atomic claim, correct finalization, ownership-aware cleanup

`collectPendingCheckpointTargets` only excludes pairs already in `top_caller_outcomes` as a
_final_ result. Needs three coordinated pieces:

1. **Atomic claim.** Before submitting to Dune, insert a `'pending'` row per target into
   `top_caller_outcomes` via `INSERT OR IGNORE` on the existing `UNIQUE(callout_id, checkpoint)`
   constraint, with `dune_run_id` set to the **owning `top_caller_collection_runs.id`** (not a
   Dune execution id — that doesn't exist yet at claim time). Only rows this call actually
   inserted (check `changes`, or re-query which keys now own a `'pending'` row with this run's id)
   are targets this run truly claimed — send only those to Dune.
2. **Correct finalization.** `applyCheckpointResults` currently uses `INSERT OR IGNORE`, which
   will silently no-op against the `'pending'` row from step 1 instead of writing the real result.
   Change it to an `UPDATE`/upsert (`ON CONFLICT(callout_id, checkpoint) DO UPDATE`) so it always
   lands on the pending row and sets its real final status.
3. **Ownership-aware stale cleanup.** Before selecting new targets, clear a `'pending'` row only
   when its owning run (via `dune_run_id`) is no longer active — `failed`/`cancelled`, or
   `running` past a timeout. Mirror `reconcileStaleFetchRuns`/`reconcileStuckDuneRuns`'s existing
   shape rather than inventing a new one.

- Comment why this matters even though `hasActiveCollectionRun` already serializes at the run
  level today — this is defense-in-depth for if that lock is ever loosened.

## Fix 4: route the leaderboard capture through the shared GMGN queue

- Export `waitForGmgnRequest` from `fetch.ts` (currently module-private).
- Call it at the top of `runGmgnTrackKol`, before the `execFileAsync` call — the same call site
  pattern `fetchActivityPageRaw` already uses. This is the actual fix for the "Top Callers and
  CopyTrade fetches racing against the same bucket" problem; do not build a second, parallel
  queue — there is exactly one shared queue and everything that calls GMGN must go through it.

## Fix 5: diagnostics for background collection runs

- Log a `logDiagnostic` entry at every terminal transition of a collection run (`completed`,
  `failed`, `rate_limited`, the new `paused`, `cancelled`) — not only on an uncaught error. Add
  this at the point `startCollectionRun` sets each terminal status, not only in `server.ts`'s
  outer `.catch()` (which stays as a last-resort net for anything that still manages to throw
  past the internal handling).
- Each entry: run id, kind, `walletDone`/`walletTotal` at that point, retry count (see Fix 6),
  and elapsed time since `started_at`. Reuse the existing `logDiagnostic`/`readRecentDiagnostics`
  machinery in `db/diagnostics.ts` — no new logging system.

## Fix 6: bounded pause → retry-once → permanent-pause state machine

This is the core new behavior. Scope it precisely — this is "one clean retry after the cooldown
genuinely clears," not a retry loop. GMGN's own docs warn that repeated requests _during_ an
active cooldown extend the ban; retrying once _after_ it clears is not that.

- **Schema** (`src/db/schema.ts`, new migration): add to `top_caller_collection_runs`:
  `retry_count INTEGER NOT NULL DEFAULT 0`, `next_retry_at TEXT`,
  `wallet_snapshot_json TEXT` (the tracked-caller-key list frozen at the run's original start, so
  a resume walks the _same_ list even if tracking changes mid-pause — resuming by `wallet_done`
  as an index into a list that can shift under you is a correctness bug, avoid it).
- **New status value**: add `'paused'` to `CollectionStatus`. A `'callouts'` run that hits a rate
  limit mid-loop transitions to `'paused'` (not `'rate_limited'` as a dead end) with
  `next_retry_at` set from the GMGN-reported reset time, `wallet_snapshot_json` preserving the
  original tracked list, and `wallet_done` at whatever it had actually completed.
- **The bounded retry**: schedule exactly one automatic resume attempt for when `next_retry_at`
  passes, incrementing `retry_count` to `1`. Resuming means continuing the per-wallet loop
  starting at index `wallet_done` **into the stored `wallet_snapshot_json`**, not restarting from
  0 and not recomputing `listTrackedCallerKeys` fresh. If that retry also hits a rate limit,
  transition to a **terminal paused state that does not auto-retry again** — `retry_count` stays
  at `1`, and only an explicit user action (a new `POST /api/top-callers/resume` call, see
  contract below) may attempt again, which itself follows the same one-bounded-retry rule from
  its own new starting point.
- **User Stop always wins.** If `stopCollectionRuns` cancels a `'paused'` run before its scheduled
  retry fires, the scheduled retry must check the run is still `'paused'` (not `'cancelled'`)
  before doing anything — never resurrect a run the user explicitly stopped.
- **Survive a server restart.** Do not rely solely on an in-memory `setTimeout` surviving process
  life. On server startup (near the existing `reconcileStaleFetchRuns` call in `server.ts`), scan
  for `'paused'` runs: if `next_retry_at` is still in the future, re-arm a timer for it; if it's
  already passed (the process was down through it), do **not** silently auto-fire a possibly
  very-late retry — leave it `'paused'` requiring explicit `Resume`, since an unknown amount of
  time may have passed and auto-firing it blind is exactly the "treat every cooldown as an
  invitation to retry" behavior this task exists to stop.
- **Resume must be explicit and start a genuinely new attempt, not stack pauses.** Implement
  `POST /api/top-callers/resume` (`{ runId? }`, defaulting to the most recent `'paused'` run):
  validates the target run is actually `'paused'`, then continues the per-wallet loop from
  `wallet_done` into `wallet_snapshot_json`, resetting `retry_count` to 0 for this new
  user-initiated attempt (a fresh bounded-retry budget, since the user made a deliberate choice
  to try again — don't let stale retry counts from hours ago block a legitimate new attempt).

---

## API contract additions — IMPLEMENT EXACTLY (the frontend is coded against this)

```
GET /api/top-callers/collect/status?kind=<kind>
→ existing fields, PLUS:
  { ...,
    status: "idle" | "running" | "paused" | "completed" | "failed" | "rate_limited" | "cancelled",
    retryCount: number,
    nextRetryAt: string | null,       // ISO, only meaningful when status === "paused"
  }

POST /api/top-callers/resume
   body: { runId?: number }   // omit to target the most recent 'paused' run
→ { runId: number, status: "running" }
   404 if no paused run exists (or the given runId isn't paused).
```

Every other existing route/response shape is unchanged.

---

## Tests to add (`tests/top-callers.test.ts`, append only)

1. Leaderboard cooldown: rejected within the window, allowed after.
2. Backfill resumes toward an old watermark (not capped at 1 day); the aggregated gap message
   names the specific wallet(s) affected across a multi-wallet run.
3. Checkpoint claim race: two overlapping claim attempts on the same target — only one succeeds
   (`changes === 1` vs `0`), and the loser excludes it from its own Dune submission.
4. `applyCheckpointResults` correctly updates a pre-existing `'pending'` row to `'measured'`
   (regression test — this exact bug was caught in review before this task was written).
5. A `'pending'` row owned by a still-`'running'` run is NOT cleared by staleness alone; one owned
   by a `'failed'`/`'cancelled'`/timed-out run IS cleared and becomes eligible again.
6. `runGmgnTrackKol` now calls the shared queue — verify via a test double / spy that
   `waitForGmgnRequest` is invoked before the CLI call.
7. A rate limit mid-`'callouts'`-loop transitions the run to `'paused'` with `next_retry_at` set
   and `wallet_snapshot_json` capturing the original tracked list, not `'rate_limited'`.
8. A stubbed automatic retry after `next_retry_at` resumes from `wallet_done`'s index into the
   stored snapshot, not from 0 — assert the wallets already fetched are never re-requested.
9. A second consecutive rate limit (after the one bounded auto-retry) leaves the run in a terminal
   paused state with `retryCount === 1` and does **not** schedule a second automatic attempt.
10. `stopCollectionRuns` on a `'paused'` run prevents its scheduled retry from reviving it.
11. `POST /api/top-callers/resume` on a `'paused'` run resets `retryCount` to 0 and continues from
    the stored snapshot position; on a non-paused run it 404s.
12. Server-restart simulation: a `'paused'` run whose `next_retry_at` has already passed at
    "startup" is left `'paused'`, not auto-fired.

## Verification before you report done

- `npx tsc -b --noEmit` clean.
- `npm test` fully green. Confirm your own starting baseline count live before you begin (do not
  trust a number written in this document — it will already be stale by the time you read it).
- Confirm the new migration applies cleanly to the real `.data/crypto-research.sqlite` by starting
  the server once, and report the resulting `PRAGMA user_version`.
- For the queue fix (Fix 4): demonstrate it live, not just via a spy test — e.g. trigger a
  leaderboard capture and a callouts fetch back-to-back and confirm via real timing/logs that they
  no longer overlap.
- For diagnostics (Fix 5): trigger a real rate limit (or simulate one via an injectable fetch
  function) and paste the resulting diagnostic log entry into your progress entry.

## Out of scope

No UI changes — the frontend agent owns that from the contract above. No changes to how
checkpoints compute returns or select a checkpoint window. No changes to the per-page pacing
(`WALLET_ACTIVITY_EXTRA_PAGE_DELAY_MS`) fixed in a prior session. Do not build a generic/reusable
retry framework — this is scoped specifically to Top Callers' collection runs.

Append your `progress.md` entry before finishing.
