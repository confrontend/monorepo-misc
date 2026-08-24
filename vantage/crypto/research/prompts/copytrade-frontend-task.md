# Task (Frontend): CopyTrade page — fetch, progress, and the "$100 became" verdict table

You are the **frontend** agent. A **backend** agent is working in parallel from
`copytrade-backend-task.md`. You own `ui/main.tsx` and `ui/styles.css` only. You must **not**
touch `src/`, `src/scripts/server.ts`, `src/db/schema.ts`, or any file under `tests/`.

Read `CLAUDE.md` first and follow it, including the append-only `progress.md` entry.

---

## Goal

One page that lets the user: **fetch top-trader trade data, see it land in the database, and
read whether those traders are actually worth copying** — headlined by what $100 would have
become.

The backend does all computation. You render what it returns and add nothing of your own.

---

## Work independently of the backend

The backend may not be finished when you start. **Do not wait for it.** Build against the
contract below, and develop with a local stub (a `const USE_STUB = false` flag plus a sample
payload is fine) so you can style and verify the page immediately. Remove or default the stub
off before you finish.

---

## API contract — CODE AGAINST THIS EXACTLY (the backend implements it)

```
GET /api/copytrade/summary
→ { traders: number, trades: number, historyDays: number,
    verifiedPercent: number | null, lastRunAt: string | null }

POST /api/copytrade/fetch
   body: { limit: number, periodDays: number }
→ { runId: number, status: "running" }
   409 if a run is already active.

POST /api/copytrade/fetch/stop
→ { stopped: boolean, runId: number | null }
   stopped:false means nothing was running — treat as success, not an error.
   The run halts within about one request; keep polling until running:false.

GET /api/copytrade/fetch/status
→ { running: boolean, runId: number | null, walletDone: number, walletTotal: number,
    tradesFetched: number, rateLimitedUntil: string | null,
    status: "idle" | "running" | "completed" | "failed" | "rate_limited" | "cancelled",
    message: string }

GET /api/copytrade/results?periodDays=<n>&limit=<n>
   Both optional. `limit` scopes the report to the top N of the current roster — pass the
   same trader count the user selected, or the table will show wallets they excluded.
→ { computedAt: string, startingCapitalUsd: 100, periodDays: number,
    rows: Array<{
      walletAddress: string, name: string | null, trades: number,
      winRatePercent: number | null, medianReturnPercent: number | null,
      averageReturnPercent: number | null, endingCapitalUsd: number | null,
      verdict: "yes" | "no" | "thin" | "flagged",
      riskFlags: string[], failedRules: string[],
      excludedNoCostBasis: number,
      endingCapitalUsdCompounded: number | null,
      truncated: boolean, coveredDays: number | null,
      needsDuneBackfill: boolean, unreliableReason: string | null,
      riskEvidence: {
        fastRoundTripPercent: number | null, noCostBasisPercent: number | null,
        medianHoldSeconds: number | null, fundedByAddress: string | null,
        walletAgeDays: number | null
      },
      riskNotes: string[]
    }>,
    overall: { trades: number, winRatePercent: number | null,
               medianReturnPercent: number | null, averageReturnPercent: number | null,
               endingCapitalUsd: number | null, endingCapitalUsdCompounded: number | null,
               unreliableReason: string | null },
    rules: { minTrades: number, minDays: number, requiresPositiveMedian: boolean } }

POST /api/copytrade/results/snapshot
→ { snapshotId: number, computedAt: string }
```

### Truncated wallets — do not paper over this

When a wallet's history is too large for the paged API, the fetch stops at a per-wallet request
cap and only its newest trades are stored. Those wallets come back with `truncated: true`, and
the server deliberately returns `null` for `averageReturnPercent`, `endingCapitalUsd`, and
`endingCapitalUsdCompounded` — a newest-N sample biases every mean-based figure, while the
median and win rate stay valid.

- Render those nulls as em dashes like any other null. **Never** substitute a computed value.
- Show `unreliableReason` next to the row (tooltip or inline note) so the blank is explained.
- Show `coveredDays` whenever it is materially less than `periodDays`; a wallet measured over
  14 hours must not look like a 30-day result.
- `needsDuneBackfill: true` marks wallets whose full history needs a different source. Surface
  it as a quiet marker, not an error.
- `overall.unreliableReason` is set when any truncated wallet contributes; the pooled average
  and `$100` are null in that case too.

**Every numeric field is nullable.** Render `null` as an em dash (`—`), never as `0`, `NaN`,
`$0`, or a blank cell. This repo has shipped bugs where a missing value was displayed as a real
one — treat that as the primary failure mode to avoid.

---

## Layout to build

A new top-level nav item **CopyTrade**, a sibling of the existing **Signal** item, routed at
`#copytrade`. Follow the existing `section-nav` underline pattern in `ui/styles.css` — do not
introduce a new visual language. It is a single page; no subtabs.

```
  1 · FETCH
  ┌───────────────────────────────────────────────────────────────────────────────┐
  │  Top traders   [ 100 ▾ ]     Period  [ 30 days ▾ ]                            │
  │             [  Fetch trades  ]     ⟳ wallet 7/25 · 48,203 trades              │
  │  leaderboard → GMGN API (trades) → saved to SQLite                            │
  └───────────────────────────────────────────────────────────────────────────────┘

  2 · STORED
  ┌────────────┬────────────┬────────────┬────────────┐
  │     25     │   48,203   │   31 days  │   Aug 14   │
  │  traders   │   trades   │   history  │  last run  │
  └────────────┴────────────┴────────────┴────────────┘

  3 · IF YOU HAD COPIED THEM — $100 start, 30 days

  Trader          Trades   Win%   Median   Average    $100 →     Copy?
  ──────────────  ──────  ─────  ───────  ─────────  ────────  ──────────
  cented           8,440  51.2%   +0.4%     +1.9%      $141     ✓ yes
  Cupsey           6,880  47.8%   −0.6%     +3.1%       $71     ✗ no
  chingchong      22,309  25.4%   −4.8%    +18.2%       $12     ✗ flagged
  ──────────────  ──────  ─────  ───────  ─────────  ────────  ──────────
  ALL 25          47,704  48.0%   −0.5%     +2.2%       $66

  Copy? rules — all four must pass
    100+ trades · 7+ days · positive median · no risk flag

  [ save snapshot ]
```

### Requirements

- **`$100 →` is the headline column.** Give it the strongest visual weight in the row.
  Green above $100, red below, neutral at exactly $100 or `null`.
- **When median and average disagree in sign, say so.** Render a warning line beneath the
  table naming the wallets affected, e.g.
  _"chingchong: average +18.2% but $100 → $12. One large win hides many losses. Median is the
  honest number."_ Derive this from the returned values; do not hardcode names.
- **Verdict cell** shows the icon plus label, and on hover/title lists `failedRules` in plain
  words. Do not print raw rule identifiers to the user.
- **Risk flags** render as small chips next to the trader name.
- **`riskNotes` is why a wallet was flagged** — render the array as plain sentences in an
  expandable detail under the row. It is already written for a reader; do not rephrase it, and
  do not drop its first line, which states that GMGN does not publish its criteria.
  `riskEvidence` holds the same numbers if you want them in columns.
  **Do not present this evidence as proof of wash trading.** Measured live, it does not
  separate flagged from unflagged wallets — two untagged wallets scored _higher_ on fast round
  trips than three tagged ones. It is context for a human, not a detector.
- **Reuse existing CSS classes.** `.quality-grid` / `.quality-metric` for the stat tiles,
  the existing table wrapper pattern for the table. Only add new classes where nothing fits.
- **Sorting:** clicking a column header sorts. Attach `onClick` per header declaratively —
  **never** wire handlers by DOM position with `querySelectorAll` + an index array. That exact
  approach silently misattached handlers here twice already (`progress.md` entries 41 and 71).
- **Nulls sort last** in ascending order.

### Fetch progress behavior

- `Fetch trades` POSTs, then polls `GET /api/copytrade/fetch/status` about every 2 seconds
  while `running` is true. Stop polling when it is not.
- Disable the button while a run is active; a 409 means a run already exists — start polling
  rather than showing an error.
- **While a run is active, the Fetch button becomes a Stop button** (`POST /api/copytrade/fetch/stop`).
  Keep polling after stopping — the run ends within roughly one request, and `status` becomes
  `cancelled`. Present that as a normal outcome, not a failure: everything already fetched is
  kept, and its `message` says how much.
- If `status` is `rate_limited`, show `rateLimitedUntil` as a readable local time and explain
  that retrying early makes the wait longer. Do not auto-retry.
- Refresh the summary tiles and the results table when a run completes.
- The page must survive a browser reload mid-run: on mount, poll status once and resume the
  polling loop if a run is still active. SQLite is the source of truth; React state is a cache.

---

## Verification required before you report done

- `npx tsc -p tsconfig.ui.json --noEmit` clean, `npm run build` clean.
- Verify **live in the browser** against the running dev server, not only by reading code.
  Confirm the page is actually visible — this app's routed/focused view CSS has hidden new
  sections three separate times (`progress.md` entries 84 and 106). Check
  `getComputedStyle(el).display` on your new section rather than trusting a screenshot.
- Confirm an empty database renders the empty state cleanly with no `NaN`, `$0`, or `undefined`.
- Confirm every column sorts and the indicator lands on the clicked header.

## Out of scope

No data fetching logic of your own, no computation, no new API routes, no schema.
If a number you want is not in the contract, ask — do not derive it client-side.

Append your `progress.md` entry before finishing.
