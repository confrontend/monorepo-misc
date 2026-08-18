# Task (Backend): Top Callers — capture, checkpoint, and evaluate GMGN callers

You are the **backend** agent. A **frontend** agent is working in parallel from
`top-callers-frontend-task.md`. You own the server, database, and analysis. You must **not**
touch `ui/main.tsx` or `ui/styles.css` — those belong to the frontend agent.

Read `CLAUDE.md` first and follow it, including the append-only `progress.md` entry.

---

## Hard precondition — do not skip this

`research/prompts/top-callers-research.md` must have already been run and its report reviewed
before you write any capture code. That research confirms the real endpoint shapes, the
canonical Callout source, whether any field drifts live, and the actual dedup grain — this task
was written before that evidence existed, so every GMGN field path below is a **placeholder**,
not a verified fact.

**If that research has not been completed, stop and say so instead of guessing field names.**
If it has, read its final report first and adjust anything below that it contradicts — the
research output is authoritative over this task description.

---

## Goal

Answer: **which GMGN Top Callers are worth following, and how did their actual calls perform —
measured independently, not just by GMGN's own reported multiplier?**

1. **Capture** the leaderboard daily (rank, metrics, capture time, exact filters/ordering used).
2. **Capture** each tracked caller's Callouts (token, call price/mc, timestamp, message).
3. **Measure** each Callout at fixed checkpoints: +1h, +6h, +24h, +3d, +7d — using Dune as the
   trusted historical price source, the same way `src/dune/outcomes.ts` already does for
   signals. Store GMGN's own reported multiplier/profit fields too, but never substitute them
   for the independently measured value.
4. **Evaluate** each tracked caller: call count, win rate, median return, consistency — gated by
   sample size the same way `computeSignalPatternReport` already gates pattern verdicts.

---

## Reuse existing patterns — do not invent parallel ones

- **Rate-limit pacing**: reuse `waitForGmgnRequest` from `src/copytrade/fetch.ts`. Do not build a
  second pacing mechanism. This project has been banned by GMGN's leaky-bucket limiter more than
  once this session at surprisingly low request volumes — treat every new endpoint as capable of
  triggering the same ban until proven otherwise.
- **Checkpoint measurement**: reuse the checkpoint list, "only request newly matured checkpoints"
  logic, and premature-invalidation handling already built in `src/dune/outcomes.ts`. That module
  exists specifically because early checkpoint measurements on unindexed Dune data change on
  re-run — do not re-learn that lesson by reimplementing checkpoints from scratch.
- **Reliability gating**: reuse `MIN_RELIABLE_SAMPLE = 10` from `src/db/patterns.ts` (also reused
  for the CopyTrade liquidity-band work) rather than inventing a new threshold. Mirror its
  `MIN_CAPTURE_DATES` gate too for "how many distinct capture dates before ranking a caller."
- **Measured vs. proxied**: mirror `src/copytrade/copySimulation.ts`'s explicit separation of a
  wallet's own reported return from the independently simulated one. Every outcome row must keep
  GMGN's self-reported multiplier and the Dune-measured return in separate fields, never merged.
- **Archiving**: `src/gmgn/archives.ts`'s `zipStored` + SHA-256 + manifest pattern for raw
  responses, same as every other GMGN capture in this project.
- **Credentials**: reuse `src/gmgn/credentials.ts`. The API key must never reach SQLite, logs, or
  an archived payload.

---

## Schema (`src/db/schema.ts`, new append-only migrations)

Field names inside `raw_payload`-derived columns are placeholders pending the research report —
adjust them to match confirmed real fields, but do not change the shape of what's append-only.

```sql
CREATE TABLE top_caller_collection_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                -- 'leaderboard' | 'callout_history' | 'checkpoint'
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,              -- running | completed | failed | rate_limited | cancelled
  requests_made INTEGER NOT NULL DEFAULT 0,
  rate_limited_until TEXT,
  error TEXT
);

CREATE TABLE top_caller_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES top_caller_collection_runs(id),
  captured_at TEXT NOT NULL,
  period TEXT,                       -- exact GMGN filter value, verbatim
  ordering TEXT,
  filters_json TEXT,                 -- every filter param sent, verbatim
  raw_payload TEXT NOT NULL,
  archive_path TEXT,
  archive_sha256 TEXT
);

CREATE TABLE top_caller_snapshot_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES top_caller_snapshots(id),
  caller_key TEXT NOT NULL,          -- stable caller identity — exact source TBD by research
  rank_position INTEGER NOT NULL,
  call_count INTEGER,
  reported_avg_multiplier TEXT,      -- verbatim TEXT, GMGN's own number
  reported_best_multiplier TEXT,
  reported_hit_rate_2x_pct TEXT,
  raw_payload TEXT NOT NULL
);
CREATE INDEX idx_top_caller_snapshot_rows_caller ON top_caller_snapshot_rows(caller_key);

CREATE TABLE top_caller_tracked (
  caller_key TEXT PRIMARY KEY,
  tracked_at TEXT NOT NULL,
  untracked_at TEXT             -- NULL while actively tracked; set, never deleted, on untrack
);

CREATE TABLE top_caller_callouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_key TEXT NOT NULL,
  token_address TEXT NOT NULL,
  token_symbol TEXT,
  call_timestamp INTEGER NOT NULL,   -- Unix seconds, from source
  call_price_usd TEXT,
  call_market_cap_usd TEXT,
  message TEXT,                      -- display-only reference text, never treated as advice
  reported_multiplier TEXT,          -- GMGN's own number at capture time
  source_call_id TEXT,               -- when the source provides one; primary dedup key
  raw_payload TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE     -- source_call_id if present, else caller|token|call_timestamp
);
CREATE INDEX idx_top_caller_callouts_caller ON top_caller_callouts(caller_key, call_timestamp);
CREATE INDEX idx_top_caller_callouts_token ON top_caller_callouts(token_address);

CREATE TABLE top_caller_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  callout_id INTEGER NOT NULL REFERENCES top_caller_callouts(id),
  checkpoint TEXT NOT NULL,          -- '1h' | '6h' | '24h' | '3d' | '7d'
  requested_at_ts INTEGER NOT NULL,  -- call_timestamp + checkpoint offset
  status TEXT NOT NULL,              -- 'measured' | 'no_trade_in_window' | 'not_yet_matured' | 'query_failed'
  measured_price_usd TEXT,           -- Dune-measured, independent of GMGN
  measured_return_pct REAL,
  matched_trade_at TEXT,
  gap_seconds INTEGER,
  dune_run_id INTEGER,               -- ties back to whatever run table you use for the Dune query
  computed_at TEXT NOT NULL,
  UNIQUE(callout_id, checkpoint)
);
```

Add every new table name to the expected list in `tests/schema.test.ts` (alphabetical).

---

## Dedup — apply exactly this fallback order

1. If the source provides a stable per-call ID, that alone is the dedup key.
2. Otherwise `caller_key|token_address|call_timestamp`, using the **exact timestamp precision the
   source returns**, never truncated to a coarser grain — confirm from the research report
   whether a caller can legitimately call the same token twice in one day before assuming this
   fallback is safe.

Insert with `INSERT OR IGNORE` on `dedup_key`, mirroring `copytrade_trades`.

---

## Checkpoints — only request what's newly matured

For each tracked caller's callout, a checkpoint's `requested_at_ts` is only queryable once real
time has passed it. Follow `src/dune/outcomes.ts`'s existing pattern: only submit a Dune batch
for checkpoints that are both unmeasured and already matured, and treat an early-queried result
as provisional per that module's premature-invalidation logic — do not build a second version of
that logic here.

---

## Evaluation

Per tracked caller, gated by `MIN_RELIABLE_SAMPLE` measured callouts and `MIN_CAPTURE_DATES`
distinct call dates (reused from `patterns.ts`, not reinvented):

- `callCount`, `measuredCallCount` (has at least one non-`not_yet_matured` outcome)
- `winRatePercent` — share of measured callouts with `measured_return_pct > 0` at a chosen
  checkpoint (default `24h`; make the checkpoint a parameter, not hardcoded)
- `medianReturnPercent` — median, not average, at the same checkpoint (median-vs-average has
  already burned this project once in the CopyTrade evaluation; do not repeat it)
- `reliable: boolean` — false below the sample/date gates; still return the raw numbers, never
  hide them, exactly like every other reliability flag in this project

Every numeric field nullable — `null` for "not computable," never `0`.

---

## API contract — IMPLEMENT EXACTLY (the frontend is coded against this)

```
GET /api/top-callers/leaderboard
→ { snapshot: { capturedAt: string, period: string | null } | null,
    rows: Array<{ callerKey: string, rankPosition: number, callCount: number | null,
                   reportedAvgMultiplier: string | null, reportedBestMultiplier: string | null,
                   reportedHitRate2xPct: string | null, tracked: boolean }> }

POST /api/top-callers/track      body: { callerKey: string }  → { tracked: true }
POST /api/top-callers/untrack    body: { callerKey: string }  → { tracked: false }

POST /api/top-callers/collect
   body: { kind: "leaderboard" | "callouts" | "checkpoints" }
→ { runId: number, status: "running" }   409 if a run of that kind is already active.

GET /api/top-callers/collect/status?kind=<kind>
→ { running: boolean, runId: number | null, status: "idle" | "running" | "completed" |
    "failed" | "rate_limited" | "cancelled", requestsMade: number,
    rateLimitedUntil: string | null, message: string }

GET /api/top-callers/callers
→ { checkpoint: "24h", rows: Array<{
      callerKey: string, callCount: number, measuredCallCount: number,
      winRatePercent: number | null, medianReturnPercent: number | null, reliable: boolean }> }

GET /api/top-callers/callers/:callerKey
→ { callerKey: string,
    callouts: Array<{ id: number, tokenAddress: string, tokenSymbol: string | null,
      callTimestamp: string, callPriceUsd: string | null, message: string | null,
      reportedMultiplier: string | null,
      outcomes: Array<{ checkpoint: string, status: string,
        measuredReturnPct: number | null, gapSeconds: number | null }> }> }
```

Every numeric/nullable field returns `null`, never `0` or a guess. An empty database returns a
valid, well-formed empty payload, not a 500.

---

## Requirements

- **The `message` field is display-only reference text.** Never score, rank, or filter on it.
  Never present it as advice — this repeats the project's standing "descriptive research only,
  never trading instructions" boundary.
- **Do not auto-track the full leaderboard.** Tracking starts empty; a caller is measured only
  after an explicit track action, mirroring how CopyTrade moved from broad discovery fetches to
  scoped wallet-specific ones after repeated rate-limit pain this session.
- A collection failure must not corrupt partial progress — persist rows as you go, the same way
  `runCopyTradeFetch` does, so a mid-run 429 loses nothing already fetched.
- Never store the API key, cookies, or session tokens in any column.

## Tests

- Dedup: a repeated callout fetch does not create duplicate rows; a fallback-keyed callout with a
  distinct-enough timestamp is not incorrectly collapsed with another real call.
- Checkpoints: an unmatured checkpoint is never queried; a matured one that later finds a better
  match is handled per the reused premature-invalidation logic, not a new one.
- Evaluation: median vs. average on an outlier-heavy fixture; the `reliable` gate flips only at
  the sample/date thresholds; an unmeasured caller returns nulls, never zeros.
- Track/untrack round-trips correctly and is idempotent.

## Verification before you report done

- `npx tsc -b --noEmit` clean, `npm test` fully green, no existing test regressed.
- If the research report's endpoints are confirmed reachable, run one real low-volume capture and
  report actual row counts — do not report synthetic numbers as if they were live.
- Curl every route and paste real responses into your `progress.md` entry.

## Out of scope

No UI. No trading. No scoring beyond the win-rate/median described above. No auto-scheduling.
Do not track more than a small manually-selected set of callers in this pass.

Append your `progress.md` entry before finishing.
