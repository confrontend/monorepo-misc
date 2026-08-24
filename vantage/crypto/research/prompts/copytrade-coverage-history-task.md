# Task: append-only per-run coverage history for CopyTrade

Read `CLAUDE.md` first and follow it, including the append-only `progress.md` entry.

## Parallel work in progress — stay in your lane

Another agent is editing **`src/copytrade/evaluate.ts`** and **`ui/main.tsx`** right now.

**You own `src/db/schema.ts` and `src/copytrade/fetch.ts`.** Do not edit `evaluate.ts` or
`ui/main.tsx` — not even a type import tweak. If you believe a change is needed there, stop and
say so rather than making it. `tests/copytrade.test.ts` is shared: only _append_ new tests at
the end, never reorder or modify existing ones.

## The problem

`copytrade_wallet_coverage` records how a wallet's fetch ended — requests used, whether it hit
the per-wallet request cap, and why it stopped. It has `PRIMARY KEY (wallet_address, chain)`
and its writer uses `ON CONFLICT ... DO UPDATE`, so **every run destroys the previous run's
record**. See `recordCoverage` in `src/copytrade/fetch.ts`.

That is wrong for this project. Coverage is an observation about a point in time: "on
2026-08-15, fetching 30 days of this wallet hit the cap after 200 requests". Overwriting it
means you can never answer "was this wallet truncated when that snapshot was taken?", which is
exactly the question a frozen result snapshot exists to support. Every other observation table
here is append-only for this reason.

## What to build

### 1. New append-only table (`src/db/schema.ts`, new migration at the END of the array)

Never edit an already-applied migration — read the comment around the
`gmgn_smartmoney_wallet_stats` rebuild migration for what that costs.

```sql
CREATE TABLE copytrade_wallet_coverage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES copytrade_fetch_runs(id),
  wallet_address TEXT NOT NULL,
  chain TEXT NOT NULL,
  requested_period_days INTEGER,
  requests_used INTEGER NOT NULL,
  truncated INTEGER NOT NULL,
  stop_reason TEXT,
  oldest_held_ts INTEGER,     -- watermark AFTER this run's work
  newest_held_ts INTEGER,
  observed_at TEXT NOT NULL
);
CREATE INDEX idx_copytrade_coverage_events_wallet
  ON copytrade_wallet_coverage_events(wallet_address, chain, observed_at);
CREATE INDEX idx_copytrade_coverage_events_run
  ON copytrade_wallet_coverage_events(run_id);
```

Add the table name to the expected list in `tests/schema.test.ts` (alphabetical).

### 2. Write one event per wallet per run (`src/copytrade/fetch.ts`)

`recordCoverage` currently upserts the latest-state row. Keep that behaviour — it is a useful
cache and `evaluate.ts` reads it, and **you must not change `evaluate.ts`** — but _also_ insert
one immutable event row alongside it.

Capture the watermarks as they stand after that wallet's paging finishes. There is already a
`readWatermark(database, walletAddress, chain)` helper in the same file — reuse it, do not
write a second query.

### 3. Read path (`src/copytrade/fetch.ts`)

```ts
export const listWalletCoverageHistory = (
  database: DatabaseSync,
  options: { walletAddress?: string; chain?: string; runId?: number; limit?: number },
) => // newest first, limit clamped like src/gmgn/rawEndpointReads.ts does
```

Follow the clamping pattern in `src/gmgn/rawEndpointReads.ts` (`DEFAULT_LIMIT`/`MAX_LIMIT`)
rather than inventing another one.

**Do not add an HTTP route.** Route wiring in `src/scripts/server.ts` risks colliding with the
other agent's work; the read function is the deliverable and a route can be added later.

## Requirements

- The event row must be written even when a wallet ends `cancelled` or `request_cap` — those
  are the outcomes most worth having a history of.
- A failure writing the event must not abort the fetch. Trades are the point; wrap it.
- Never store credentials. The API key must not reach any column.

## Tests (append to the end of `tests/copytrade.test.ts`)

1. Two runs over the same wallet produce **two** event rows, while the latest-state row still
   holds only the newer values.
2. A truncated run's event records `truncated = 1` and its `stop_reason`, and a later
   non-truncated run does **not** rewrite that earlier row.
3. `listWalletCoverageHistory` filters by wallet and by run, returns newest first, and clamps
   an absurd limit.
4. Watermarks on the event reflect the trades actually held at that point.

## Verification before reporting done

- `npx tsc -b --noEmit` clean, `npm run build` clean.
- `npm test` fully green. The suite is at **163/163** — it must not regress, and every existing
  test must still pass unmodified.
- Confirm the migration applies to the real `.data/crypto-research.sqlite` by starting the
  server once, and report the resulting `PRAGMA user_version`.
- Report real row counts from a live fetch if you run one; do not report synthetic numbers as
  if they were live.

## Out of scope

No changes to how coverage affects verdicts or reporting. No HTTP route. No UI. No changes to
the request cap, the watermark paging logic, or the stop mechanism.

Append your `progress.md` entry before finishing.
