# Collection Limits and Queue-Drain Review

**Status:** Proposed for review  
**Date:** 2026-08-17  
**Scope:** GMGN capture, Top Caller collection, Dune checkpoint measurement, signal outcome measurement, and Copy Simulation

## Executive summary

The application has several limits. Most are intentional protections against rate limits, oversized requests, runaway jobs, or uncontrolled Dune cost. One limit is now a product-design problem: Top Caller checkpoint collection stops after 15 Dune batches and requires the user to click again, even though the durable queue still contains work.

The recommendation is not to remove every limit. Keep limits on each individual request, but replace repeated manual clicks with a persistent, observable background queue that drains eligible work until the queue is empty, paused, stopped, or failed.

## What is intentionally limited

### GMGN request spacing

src/gmgn/rateLimit.ts applies one process-wide five-second spacing between server-side GMGN request starts. This was added after GMGN documented a one-request-per-five-seconds limit and the application encountered temporary 429 bans.

**Decision:** keep this unchanged. It protects the API key and applies across leaderboard, wallet history, signal capture, and probe calls in this Node process. Browser-extension traffic and separately started processes remain outside this gate.

### GMGN cooldown and retry state

Top Caller and CopyTrade fetches preserve rate-limit reset times, pause safely, and avoid immediately retrying after a 429. Top Caller collection also has a bounded automatic retry and an explicit Resume path.

**Decision:** keep the cooldown and bounded retry behavior. Do not replace it with an unbounded client-side retry loop.

### GMGN wallet-history request cap

src/copytrade/fetch.ts has a per-wallet request cap. A history can therefore be truncated, but the run stores truncation information and a stop reason.

**Decision:** keep the cap. Improve the UI so “truncated” always has a visible resume/re-fetch action and never looks like a complete history.

### Dune query-size limits

The Dune paths use bounded request sizes:

- Top Caller checkpoints: up to 300 checkpoint targets per Dune batch (src/copytrade/topCallerCheckpoints.ts).
- Copy Simulation: up to 300 target legs per Dune batch (src/copytrade/copySimulationDune.ts).
- Ordinary signal outcomes: up to 25 signal IDs per request (src/dune/outcomes.ts).

These limits keep SQL payloads and query work bounded. They are not evidence that only that many records exist.

**Decision:** keep the per-query limits. Do not replace them with one giant query.

### Dune prescreen budget

src/dune/prescreen.ts currently selects at most 500 signal IDs for a safe pass. The prescreen retains every row in SQLite and records why rows were selected, deferred, already measured, too fresh, or invalid.

**Decision:** keep the budget as an explicit cost-control policy until a separate budget decision is approved. The UI must show the real queue counts and must not imply that the remaining rows were deleted.

### Freshness buffer

The Dune planner uses a 24-hour minimum signal-age buffer before first measurement. This exists because very early historical queries frequently had no indexed trade yet.

**Decision:** keep the buffer as a correctness rule. It is separate from request-rate limiting and should be displayed as “waiting for maturity,” not as a failed fetch.

### Copy Simulation sample limits

src/copytrade/copySimulation.ts limits the simulation to the most recent 150 round trips per wallet and up to 15 Dune batches per invocation. This bounds a simulation to a defined research sample and prevents a single run from becoming unbounded.

**Decision:** retain the 150-round-trip research scope unless the methodology changes. The 15-batch invocation cap can remain as a worker safety bound only if the UI automatically schedules continuation and reports remaining targets.

## The problematic limit

### Top Caller checkpoint collection

src/copytrade/topCallers.ts currently loops only while:

~~~text
batches < MAX_CHECKPOINT_BATCHES_PER_RUN
~~~

with MAX_CHECKPOINT_BATCHES_PER_RUN = 15 and up to 300 targets per batch. Therefore one click can process at most 4,500 targets. When the queue is larger, the run completes with work still pending and the user must click again.

This is a real safety guard, but it was sized like the smaller Copy Simulation workflow and does not match the observed Top Caller backlog. It creates the wrong user contract: “Measure Dune checkpoints” sounds like a complete operation, but actually means “process up to 15 pages.”

The current UI does disclose that a safety limit exists, but it does not provide a durable remaining-count workflow or a completion estimate. The user therefore experiences an apparently finished run that is not finished.

There is also a progress-accounting defect in the active Top Caller checkpoint path: while the loop is running, requests_made is written as batches + 1; the final completion update writes batches. This can show one extra batch during execution.

## Similar patterns found elsewhere

### Copy Simulation

Copy Simulation also has a 15-batch invocation cap. Its API returns exhausted: true when more targets remain, and the UI says to run again. This is more explicit than Top Caller, but it is still a multi-click continuation model.

### Ordinary signal outcome measurement

The server accepts 25 IDs per Dune request. The UI batches selected IDs and can submit multiple requests, while the prescreen limits a safe pass to 500 selected IDs. This is a deliberate cost and query-size policy, but the queue should be presented as a continuing job with processed/remaining counts.

### GMGN history collection

CopyTrade history collection has a per-wallet request cap and persists pages as they arrive. This is a deliberate API protection. It is acceptable only because truncation and the reason for stopping are retained and surfaced.

## Rate-limit and cost impact of a fix

Changing Top Caller checkpoint continuation does **not** increase GMGN traffic: those checkpoint requests go to Dune, not GMGN.

It can increase Dune traffic and cost if implemented as an unthrottled loop. A naive “remove the cap and loop forever” implementation could create:

- too many Dune queries in a short period;
- Dune rate limits or query timeouts;
- an uninterruptible server job;
- unclear cost exposure.

Therefore the safe architecture is:

1. Keep the 300-target Dune batch size.
2. Create a durable collection job with a queue count.
3. Process batches sequentially with a configurable Dune delay/backoff.
4. Persist progress after every completed batch.
5. Pause on Dune timeout/rate-limit and schedule retry according to the reset/backoff time.
6. Check a durable Stop flag before every next batch.
7. Finish only when the eligible queue is empty, then show “Queue empty.”
8. On server restart, resume only a job whose state and next retry time are unambiguous.

This changes the number of manual clicks, not the size of an individual request.

## Proposed implementation boundary

### Backend

- Replace the Top Caller 15-batch user-visible stop with a durable queue-drain worker.
- Keep a separate internal safety limit for one worker slice, if needed, but automatically schedule the next slice.
- Add durable fields for queued, processed, remaining, paused, rate_limited_until, stopped, failed, and completed.
- Correct the requests_made off-by-one update.
- Ensure claims are atomic and completed outcomes remain immutable.

### UI

Show one operation panel with:

~~~text
Dune checkpoint collection
Processed 4,500 / 51,730
Remaining 47,230
Batch 15 · up to 300 targets
Status: running / paused / stopped / complete
Estimated next retry: ...
[Stop]
~~~

The button should start or resume the queue. It should not require the user to know how many internal batches exist.

### Unchanged behavior

- GMGN five-second limiter.
- GMGN cooldown and bounded retry rules.
- Dune per-query target sizes.
- 24-hour maturity buffer.
- Append-only raw archives and SQLite history.
- Explicit Copy Simulation sample methodology.

## Acceptance criteria

1. One click starts a queue and does not falsely report completion while eligible work remains.
2. The UI shows exact processed and remaining counts from durable state.
3. Stop prevents the next batch; the current request may finish.
4. Rate-limit or timeout pauses the queue without losing completed batches.
5. Resume continues from unprocessed targets without duplicate submission.
6. A completed run says “Queue empty” and reports zero remaining eligible targets.
7. GMGN request spacing remains at least five seconds.
8. Dune request size remains bounded and all raw responses remain archived.
9. Existing complete outcomes are not re-requested.
10. Tests cover empty queue, one batch, multiple batches, stop, timeout, rate-limit pause/resume, restart, and the progress counter.

## Review decision requested

Approve or reject the following design direction:

> Keep individual request limits for safety, but replace repeated manual clicks with a durable, rate-aware queue-drain job that transparently processes all eligible work until empty or explicitly stopped.

No implementation is included in this report.
