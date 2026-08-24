# Fix task: raw GMGN endpoint import bugs, then build UI integration

You are fixing and extending existing backend code in this local SQLite research app
(`vantage/crypto`). Read `CLAUDE.md` first and follow its `progress.md` logging rules exactly
(append-only, log after every meaningful action, no secrets).

## Context

`src/db/schema.ts`, `src/gmgn/rawSnapshot.ts`, `src/gmgn/radar.ts`, `src/gmgn/walletRank.ts`,
`src/gmgn/smartmoney.ts`, `src/gmgn/twitter.ts`, and the routing added to
`src/gmgn/browserImport.ts` already implement steps 1-2 of
`research/prompts/gmgn-radar-smartmoney-social-capture-task.md` (store radar/wallet-rank/smart-
money/Twitter captures from the browser extension into four new tables). This was reviewed
against the real capture file `gmgn-browser-capture-2026-08-14T05-20-44-554Z.json` and against
`npx tsc -b --noEmit` (clean) and `npm test` (90/90 passing). **Despite that, two real bugs were
found and reproduced by testing against a realistically-shaped capture instead of trusting the
existing code/tests** — fix both before building any UI on top of this data.

## Bug 1 (confirmed, reproduced): query-string-derived fields are always null in real captures

`browserImport.ts`'s `captureUrl()` builds a URL from `capture.requestUrl ?? capture.requestPath`
and the raw-endpoint routing then reads `url.searchParams.get('type' | 'period' | 'chain' |
'window' | 'orderby' | 'has_token')` to populate each snapshot's metadata columns. **Real
captures never have a query string in `requestPath`, and never have a `requestUrl` field at
all** — `extension/content-main.js`'s `emit()` function deliberately strips the query string
before ever posting a capture (see its comment: "query string ... intentionally dropped"), and
this was independently confirmed by inspecting a real downloaded export directly: every capture
object has exactly the keys `capturedAt`, `requestPath` (path only), `responseBody`, `status` —
no query string, no `requestUrl`.

Reproduced directly: importing a capture shaped exactly like a real one (`requestPath:
'/vas/api/v1/radar/detail'`, no query string) results in `chain`/`period`/`category` all stored
as `null` in `gmgn_radar_snapshots`; `gmgn_wallet_rank_snapshots.orderby` is `null` and `window`
is silently masked by the hardcoded `?? '7d'` fallback rather than reflecting reality; and worst
of all, `gmgn_twitter_messages.has_token` is always `null` — which defeats the entire reason
`twitter/messages` was worth capturing in the first place (distinguishing token-linked tweets
from general chatter, per the original handoff prompt's explicit caveat about `has_token`).

**The existing tests in `tests/gmgn-browser-import.test.ts` pass only because their fixtures
invent a `requestPath` with a query string appended** (e.g.
`'/vas/api/v1/radar/detail?chain=sol&period=1d&type=7'`), which does not match the real capture
shape and so never exercises this bug. This is exactly the kind of "verify against real data,
don't invent fixtures" mistake this project's own conventions repeatedly warn about — fix the
fixtures too, not just the code.

**Fix:** the query-derived fields (`chain`, `period`, `category`/`type`, `window`, `orderby`,
`has_token`) are not recoverable from `requestPath` at all in the current capture format. Two
options, pick one and state which in `progress.md`:

1. (Preferred, more accurate) Change `extension/content-main.js` to also capture a redacted query
   string (strip only the known-sensitive keys — `device_id`, `fp_did`, `client_id`, and
   anything matching the existing `sensitiveKey` pattern already in that file — instead of
   dropping the whole query string), store it on the capture as e.g. `requestQuery`, and update
   `browserImport.ts` to read from that field. This requires a new capture from a reloaded
   extension to prove it end-to-end — don't assume without a real sample.
2. (Fallback, only if you have a strong reason to avoid touching the extension) Derive what you
   can from `responseBody` instead of the URL where possible (e.g. `radar/detail`'s category may
   be inferable from context you already have when the capture was made, but there is currently
   no such field in the response body itself — check for one before assuming it exists rather
   than inventing a field). If a field genuinely cannot be recovered without a URL, store it as
   `null` explicitly and document that limitation rather than silently mis-defaulting (fix the
   `?? '7d'` fallback specifically — a wrong-but-plausible-looking default is worse than an
   honest `null`).

Whichever you choose, update `tests/gmgn-browser-import.test.ts`'s fixtures to use real,
query-string-free `requestPath` values (matching what's actually in a real export) so this class
of bug cannot silently reappear.

## Bug 2 (confirmed by reading the code): raw-endpoint counts are conflated with signal counts

In `browserImport.ts`, the `imported`/`skipped` counters are shared across _all_ capture types:

```ts
if (requestPath.includes(ENDPOINT_PATHS.radar)) {
  const result = storeRadarSnapshot(...);
  imported += result.inserted; skipped += result.skipped; // same variables as signal storage below
```

This means a browser-capture upload containing, say, 40 real GMGN signals and 5 radar snapshots
reports `imported: 45` — the radar/wallet-rank/smart-money/Twitter snapshot counts are silently
mixed into what the UI (`ui/main.tsx`'s import-result panel, redesigned recently to be "vivid")
presents as **"N new signals added."** That's now misleading, not vivid — a direct regression
against the reason that panel was redesigned. `BrowserImportResult` needs separate fields:

```ts
export type BrowserImportResult = {
  batchId: number;
  imported: number; // keep meaning "signals" only — do not touch this definition
  skipped: number; // same — signals only
  errors: number;
  issueBreakdown: Record<string, number>;
  otherCaptures: number;
  coverageWindowsImported: number;
  duplicateFile: boolean;
  archivePath: string | null;
  archiveSha256: string | null;
  rawEndpoints: {
    // new
    radar: { imported: number; skipped: number };
    walletRank: { imported: number; skipped: number };
    smartMoney: { imported: number; skipped: number };
    twitter: { imported: number; skipped: number };
  };
};
```

Update `importGmgnBrowserCapture` to track these separately (four more counter variables, or a
small accumulator object) and stop folding raw-endpoint results into the signal `imported`/
`skipped` totals. Update the `duplicateFile` early-return branch too (it currently only
recomputes `otherCaptures` from the stored raw source on a repeat upload — it will need to
recompute the `rawEndpoints` breakdown the same way, or store it on the batch row so it doesn't
need recomputing; your choice, but don't leave it inconsistent between a fresh import and a
duplicate-file re-upload).

## Minor items to note, not necessarily fix

- `extension/content-main.js`'s `TARGET_PATHS` still includes the older
  `/defi/quotation/v1/smartmoney/sol/wallet/` (no `New`) path alongside `walletNew/`.
  `browserImport.ts`'s `ENDPOINT_PATHS.smartMoney` only recognizes `walletNew/` — if the old path
  ever actually fires, its captures silently fall into `otherCaptures`. This matches the original
  handoff prompt's explicit guidance ("only build the parser against `walletNew`'s shape"), so
  it's likely intentional — just confirm in `progress.md` that this is a deliberate, not
  accidental, gap.
- No dedicated unit tests exist for `radar.ts`/`walletRank.ts`/`smartmoney.ts`/`twitter.ts`/
  `rawSnapshot.ts` in isolation — only indirect coverage via `gmgn-browser-import.test.ts`. Add
  direct tests for each store function (malformed `rawPayload`, missing wallet address for
  smart-money, non-array `data` for Twitter) while you're in these files fixing Bug 1/2.

## What to build: UI integration

Once both bugs above are fixed, add read-only visibility for this data. Zero API routes or UI
currently reference any of the four new tables (confirmed via grep across `server.ts` and
`ui/main.tsx`) — this is genuinely new, not an extension of something partial.

### 1. Backend read functions

New module `src/gmgn/rawEndpointReads.ts` (or add to `rawSnapshot.ts` if you prefer one file —
your call), exporting simple, unopinionated read functions, most-recent-first, with a `limit`
parameter (default something reasonable like 50, matching how other list endpoints in this app
behave):

- `listRadarSnapshots(database, limit?)`
- `listWalletRankSnapshots(database, limit?)`
- `listSmartMoneyWalletStats(database, walletAddress?, limit?)` — optionally filterable by
  wallet, since that's the one table where the same entity is captured repeatedly over time and
  a user will plausibly want "show me this wallet's history."
- `listTwitterMessages(database, limit?)`

Each row should include the parsed `raw_payload` (JSON.parse it before returning — don't make
the UI parse a JSON string) alongside the indexed columns. Also add a summary function,
`readRawEndpointSummary(database)`, returning per-type `{ count, latestCapturedAt }` — this is
what a compact status panel needs without fetching full row data.

### 2. Server routes (`src/scripts/server.ts`)

- `GET /api/gmgn/raw-endpoints/summary` → `readRawEndpointSummary`.
- `GET /api/gmgn/raw-endpoints/:type` where `:type` is one of `radar`/`wallet-rank`/
  `smart-money`/`twitter` (reject anything else with 400, matching the existing
  `/api/analysis/patterns/subgroups?property=` validation style already in this file) → the
  matching list function. Accept an optional `?limit=` query param, and for smart-money an
  optional `?wallet=` filter.

### 3. UI (`ui/main.tsx`)

Add a new, collapsed-by-default section (reuse the `<details className="signal-legend">` pattern
already used for the signal-type legend and the "Measurement details" disclosure — don't invent
a new collapse idiom) — something like "Raw endpoint captures (radar / wallet rank / smart money
/ Twitter)". On first expand, fetch the summary route and show four compact stat tiles (reuse the
existing `.quality-metric`-style big-number tile already used elsewhere, e.g. the recently-added
import-result tiles) — count + latest-captured-at per type. Each tile expands (or links to) a
simple paginated/limited table of that type's raw rows — token/wallet/tweet identity columns
plus a raw-JSON toggle, not a fully designed table; this is exploratory raw-data visibility, not
a polished analytics feature, matching how every other "raw data" view in this app is presented
(e.g. the Dune outcome timeline's raw checkpoint display). Also update the browser-import result
panel (`lastBrowserImport` display) to show the new `rawEndpoints` breakdown from Bug 2's fix —
e.g. a small `<small>` line like "3 radar · 1 wallet-rank · 2 smart-money · 5 twitter captured"
alongside the existing new/skipped/issues tiles, so an upload's raw-endpoint yield is visible
immediately without needing to open the new section.

## Explicitly out of scope

- No scoring, ranking, or "this looks promising" framing anywhere in the new UI — purely
  descriptive, matching every other view in this app.
- No cross-linking this data to `gmgn_signals` (e.g. "this wallet's smart-money stats relate to
  signal X") — that inference remains out of scope per the original capture-task prompt.
- No new capture-side (extension) changes beyond Bug 1's fix, if you choose the extension-side
  option for it.
- Don't touch `src/db/patterns.ts` or anything Dune-outcome-related — unrelated to this data.

## Required correctness checks before you consider this done

1. Reproduce Bug 1 first (against a real-shaped fixture, not an invented one with a query
   string) to confirm you understand it, then verify your fix actually populates the previously-
   null fields correctly.
2. Reproduce Bug 2 first (assert that a mixed signal+radar capture's `imported` count currently
   over-counts), then verify your fix reports signal and raw-endpoint counts separately.
3. Run the full suite (`npm test`) and report actual pass/fail counts — not "should pass" — in
   `progress.md`. Update/add tests for both bugs plus the new read functions and routes.
4. `npx tsc -b --noEmit` and `npx tsc -p tsconfig.ui.json --noEmit` both clean.
5. Verify live against the real running dev server and the real capture file
   `gmgn-browser-capture-2026-08-14T05-20-44-554Z.json` (already contains one real smart-money
   capture) — confirm the new UI section renders it correctly. If possible, get one real capture
   each of radar/wallet-rank/Twitter first (see the still-open item in
   `gmgn-radar-smartmoney-social-capture-task.md` about normal-mode confirmation for those three)
   so the UI is checked against real data for all four types, not just smart-money.
