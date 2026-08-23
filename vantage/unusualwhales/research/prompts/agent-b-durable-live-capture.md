# Agent B — Make live capture durable, because the 72-hour window is unrecoverable

Read `CLAUDE.md` and `AGENTS.md` first and follow them, including the append-only `progress.md` entry.

**You own:** `src/providers/*`, `src/infra/*`, `src/db/*` (migrations), and their tests.
**You must not touch:** `src/research/*` or anything under `ui/`. Agent A owns the research layer.

---

## Why this track exists, and why it is time-sensitive

Unusual Whales retains live-stream data for roughly **72 hours**. Anything not captured inside
that window is gone permanently — no backfill, no paid recovery, nothing. Every hour this is not
running is history that can never be reconstructed.

This is the one item on the roadmap where **delay has a permanent cost**. Every other proposed
feature can be built later against data that still exists. This one cannot.

`src/providers/live-stream-events.ts` already exists with a `LiveStreamEvent` shape. Read it
first and establish precisely what is and is not already working before writing anything — the
consolidated recommendation that prompted this work listed live capture as "missing" when a
module was already present, so verify rather than assume.

## What "durable" has to mean

A capture process that silently dies at 2am and is noticed three days later has lost three days
of irreplaceable data. Durability here is not a nice-to-have; it is the entire feature.

### 1. Survives restarts and disconnects
- Reconnect with backoff on socket drop; never exit the process on a recoverable error.
- On startup, resume rather than assume a clean slate.
- A crash must be visible, not silent.

### 2. Records its own coverage, append-only
This project's sibling learned this the hard way: a table keyed `PRIMARY KEY (wallet, chain,
period)` with `ON CONFLICT DO UPDATE` silently destroyed every prior observation, and because the
upstream endpoint could not look backward, those snapshots were unrecoverable
(`crypto/progress.md`). Do not repeat that shape here.

Capture **coverage windows** — when the stream was genuinely connected and receiving — as
append-only rows. A heartbeat is required: without one, a dead socket that never emits an error
is indistinguishable from a quiet market. The sibling project's
`gmgn_browser_coverage_windows` (started_at / ended_at / last_heartbeat_at / closed_reason) is a
working precedent for the shape.

Store raw payloads intact. Parse into typed columns only where a field is needed now; keep the
untouched payload so fields nobody has thought about yet are still recoverable later.

### 3. Reports honestly what it holds
A read path that answers: which topics are being captured, since when, with what gaps, and how
many events per topic. A gap must be visible as a gap — never interpolated, never presented as
continuous coverage.

## Topics to persist

Per the source roadmap: option trades + NBBO, IV, Delta, Gamma, Vega, Flow Alerts, Greek Flow,
DTE/interval flow, live GEX, stock tape, lit vs TRF/dark-pool trades, and filings.

**Verify each topic actually exists and what it returns before wiring it.** Do not add a
subscription for a topic whose payload shape you have not seen. One captured-and-redacted sample
per topic, committed as a fixture, is worth more than a guessed schema — this monorepo has been
burned before by assuming a payload shape from documentation rather than a real response.

## Requirements

- **Capture only. No analysis, no signal derivation, no scoring.** Derived signals (delta-flow
  imbalance, IV expansion, vega imbalance, and the rest of the roadmap's list) are Agent A's
  domain and a later phase. Mixing them in here couples irreplaceable capture to changeable
  analysis.
- **Never fabricate history.** Streamed data begins the moment capture starts. It must be
  impossible for a later reader to mistake stream-derived data for historical backfill — tag the
  provenance explicitly at the row level.
- Respect rate limits and reconnect politely; do not hammer on failure.
- No credentials in any stored payload, log, or archive.

## Tests

1. A dropped connection reconnects and opens a **new** coverage window rather than silently
   extending the old one.
2. A missed heartbeat closes the window with a reason, so the gap is recorded rather than hidden.
3. Re-processing the same event does not duplicate it (stable dedup on `sourceEventId`).
4. Coverage rows are append-only — a second run never overwrites the first run's record.
5. Stream-provenance rows are distinguishable from historical-backfill rows.

## Verification

- `npm test` fully green. Confirm your own starting baseline first rather than trusting a number
  written here.
- Run real capture for a sustained period and report **actual** event counts per topic and the
  real coverage windows recorded — not a synthetic fixture run.
- Deliberately kill and restart the process mid-capture, and show that the gap appears in the
  coverage record.

## Out of scope

No research, correction, backtesting, or reporting logic. No UI. Do not change existing historical
providers or their schemas — this is additive capture alongside them.

Append your `progress.md` entry before finishing.
