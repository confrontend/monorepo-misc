# Task (Frontend): Top Callers page — leaderboard, tracking, and caller detail

You are the **frontend** agent. A **backend** agent is working in parallel from
`top-callers-backend-task.md`. You own `ui/main.tsx` and `ui/styles.css` only. You must **not**
touch `src/`, `src/scripts/server.ts`, `src/db/schema.ts`, or any file under `tests/`.

Read `CLAUDE.md` first and follow it, including the append-only `progress.md` entry.

---

## Goal

A new **CopyTrade → Top Callers** submenu: current leaderboard, track/untrack control, a feed of
newly captured Callouts, per-caller call count / win rate / median return, and a detail page
showing each call's message, price, and checkpoint returns — with GMGN's own reported multiplier
kept visibly separate from the independently measured return.

The backend does all computation. You render what it returns and add nothing of your own.

---

## Work independently of the backend

The backend may not be finished when you start, and its API contract depends on a research pass
(`top-callers-research.md`) that may still be in progress. **Do not wait.** Build against the
contract below with a local stub (`const USE_STUB = false` flag plus a sample payload), so you
can style and verify the page immediately. Remove or default the stub off before you finish.

---

## API contract — CODE AGAINST THIS EXACTLY (the backend implements it)

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

**Every numeric field is nullable.** Render `null` as an em dash (`—`), never `0`, `NaN`, or a
blank cell — this repo has shipped bugs from exactly that substitution before.

---

## Layout to build

A new sub-nav item **Top Callers** inside the existing CopyTrade section (sibling of Winners,
Historical consistency, Forward validation), routed at `#copytrade/top-callers`. Reuse the
existing `subsection-nav` pattern already used for the other CopyTrade sub-tabs — do not
introduce a new nav style.

```
  TOP CALLERS LEADERBOARD
  ┌──────────────────────────────────────────────────────────────────────┐
  │  Rank  Caller        Calls   Avg×    Best×   Hit 2x%    Track        │
  │  1     caller_a       142    3.1×    41×      38%     [ tracking ]  │
  │  2     caller_b        88    1.8×    12×      21%     [ track ]     │
  └──────────────────────────────────────────────────────────────────────┘
  captured <time> · period <period>          [ Refresh leaderboard ]

  TRACKED CALLERS — measured performance (checkpoint: 24h)
  ┌──────────────────────────────────────────────────────────────────────┐
  │  Caller       Calls  Measured  Win%    Median return   Reliable      │
  │  caller_a      142      96     54%       +6.2%          yes         │
  │  caller_b       88      12     41%       -3.0%      low sample      │
  └──────────────────────────────────────────────────────────────────────┘
  [ Fetch new callouts ]   [ Measure checkpoints ]

  CALLER DETAIL — caller_a
  ┌──────────────────────────────────────────────────────────────────────┐
  │  Token    Called          Price      GMGN ×    1h    6h   24h   3d  7d│
  │  TOKA     Aug 12 14:02   $0.0041      3.1×     +8%  +22%  +6%   —   — │
  │  "thesis message text, shown as reference only"                       │
  └──────────────────────────────────────────────────────────────────────┘
```

### Requirements

- **Track/untrack** is a button per leaderboard row. Optimistically flip local state, then
  reconcile with the response; on failure, revert and show the error inline — do not leave the
  button in a state that disagrees with the server.
- **Tracked callers table** is separate from the raw leaderboard — the leaderboard shows GMGN's
  own reported metrics for everyone; the tracked table shows this app's independently measured
  numbers only for callers actually tracked. Never merge these two into one table — that would
  blur exactly the "GMGN's number vs. our measured number" distinction this feature exists to
  preserve.
- **GMGN's reported multiplier and the measured return must always render as two visibly
  separate values**, never averaged or reconciled into one number. Use distinct columns/labels
  (e.g. "GMGN ×" vs. "Measured return"), not adjacent unlabeled numbers a reader could conflate.
- **`reliable: false` rows** get a visible "low sample" marker (mirrors the existing
  `liquidity-band-unreliable`/pattern-report low-sample styling already in this app) — show the
  real numbers, de-emphasized, never hide them.
- **The `message` field is reference text only.** Render it plainly, quoted, with no styling that
  implies endorsement or a recommendation (no green highlighting, no "signal strength" framing).
- **Checkpoint cells**: `not_yet_matured` → em dash with a subtle "pending" tone, distinct from
  `no_trade_in_window` (also an em dash, but should read differently on hover/title — do not
  make both look identical, they mean different things).
- **Collection controls**: "Fetch new callouts" and "Measure checkpoints" each POST to
  `/api/top-callers/collect` with their own `kind`, then poll
  `/api/top-callers/collect/status?kind=<kind>` every ~2 seconds while running, same pattern as
  the existing CopyTrade fetch progress in `ui/main.tsx`. Each has its own independent
  running/status display — do not let one action's status leak into the other's box (this exact
  cross-contamination bug already happened once in CopyTrade this session; look at how `scope`
  was added to fix it before repeating the mistake here).
- **Reuse existing CSS classes** wherever they already fit (`.copytrade-fetch-box`,
  `.liquidity-band-table*` shape for the tracked-callers table, `.compact-info-line`/`InfoTip`
  for inline explanations). Only add new classes where nothing fits.

---

## Verification required before you report done

- `npx tsc -p tsconfig.ui.json --noEmit` clean, `npm run build:ui` clean.
- Verify **live in the browser** against the running dev server. Confirm the new sub-tab is
  actually visible — this app's routed/focused-view CSS has hidden new sections multiple times
  before; check `getComputedStyle(el).display`, don't trust a screenshot alone.
- Confirm an empty/untracked state renders cleanly: no `NaN`, no `$0`, no `undefined`.
- Confirm track/untrack round-trips correctly against the real (or stubbed) API and the button
  state never disagrees with what the server reports after a refresh.

## Out of scope

No data fetching logic of your own, no computation, no new API routes, no schema. If a number you
want is not in the contract, ask — do not derive it client-side.

Append your `progress.md` entry before finishing.
