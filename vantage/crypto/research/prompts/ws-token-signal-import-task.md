# Implementation task: normalize WebSocket `token_signal` events into `gmgn_signals`

You are implementing a backend change to this local SQLite research app (`vantage/crypto`). Read `CLAUDE.md` first and follow its `progress.md` logging rules exactly (append-only, log after every meaningful action, no secrets).

## Background

The GMGN browser-capture extension (`extension/`) already captures GMGN's REST API responses (see `extension/content-main.js`'s `TARGET_PATHS`) and imports them into the `gmgn_signals` table via `src/gmgn/browserImport.ts` -> `src/gmgn/ingest.ts`'s `storeGmgnSignal`/`normalizeGmgnSignal`.

We just confirmed, via a real 5-minute "test mode" capture (unfiltered WebSocket sniffing, also in `content-main.js`), that GMGN's *live* signal feed is not delivered over REST at all — it's pushed over a WebSocket at `wss://ws.gmgn.ai/v2/ws?...`. Messages on that socket are JSON objects shaped like `{ "channel": "<name>", "data": [...] }`. The channel we care about is `"token_signal"`.

A separate task is making the extension capture this channel permanently (not just in test mode). **Do not depend on that task's implementation details or exact `requestPath` tagging** — detect eligibility purely from the payload shape (`capture.responseBody?.channel === 'token_signal'`), so this work is decoupled and can land independently.

## The real, unfiltered shape (verified against an actual capture)

`responseBody.data` is an array. **Most items are just live price/stat ticks for tokens already visible on screen — not new signals.** Only import items that have a `sig_t` field. A real tick item (skip these):

```json
{ "c": "sol", "d": { "a": "3JLTNKH78VMd3j7kQkHDC7RqdasCAGwsLQdm3BBLpump", "mc": 2181.0772, "nm": "Cat Wif Helmet", "...": "many more abbreviated fields" }, "sig_op_t": "create" }
```

A real new-signal item (import these):

```json
{
  "c": "sol",
  "d": {
    "a": "3JLTNKH78VMd3j7kQkHDC7RqdasCAGwsLQdm3BBLpump",
    "mc": 2181.0772,
    "nm": "Cat Wif Helmet",
    "p": 0.0000021810772,
    "lq": 1.189213228,
    "hd": 1
  },
  "sig_ath": 2652.5669,
  "sig_ft_t": true,
  "sig_ftm": 2181.0772,
  "sig_id": "2d7a607d-9c62-4fee-bf70-213c1a66e15f",
  "sig_op_t": "create",
  "sig_t": 10,
  "sig_t_at": 1786596894,
  "sig_tms": 2,
  "sig_tms_t": { "7": 1, "10": 1 },
  "sig_token_ftm": 0
}
```

(`d` has ~80 more abbreviated fields not shown — see a real capture export if you need the full list. `sig_t` values observed so far: 6, 7, 8, 10 — matches the existing 1-21 signal-type legend already used elsewhere in this codebase, e.g. `ui/main.tsx`'s `SIGNAL_TYPE_DESCRIPTIONS`.)

## Field mapping to the existing raw-event shape

`src/gmgn/ingest.ts`'s `normalizeGmgnSignal` already expects a raw event object shaped like the REST endpoint's payload (`token_address`, `signal_type`, `trigger_at`, `market_cap`, `id`, `trigger_mc`, `first_trigger_mc`, `signal_times`, `signal_times_by_type`, `ath`, `cur_data`, plus optional `triggering_wallet`/`raw_wallet_labels`/`source_url`/`observed_at`). **Do not duplicate that normalization logic** — write a small mapper that converts one WS item into that same raw-event shape, then call the existing `storeGmgnSignal` unchanged:

| Raw-event field `storeGmgnSignal` expects | Source in a WS `token_signal` item |
|---|---|
| `token_address` | `item.d.a` |
| `signal_type` | `item.sig_t` |
| `trigger_at` | `item.sig_t_at` (already Unix seconds) |
| `market_cap` | `item.d.mc` |
| `id` | `item.sig_id` |
| `first_trigger_mc` | `item.sig_ftm` |
| `signal_times` | `item.sig_tms` |
| `signal_times_by_type` | `item.sig_tms_t` |
| `ath` | `item.sig_ath` |
| `chain` | `item.c` (top-level, sibling of `d`, not inside `d`) |
| `trigger_mc` | **Unconfirmed** — in one real REST sample, `trigger_mc` equaled `first_trigger_mc` exactly. There is no obvious separate WS field for it. Verify against a larger real capture before deciding; it's acceptable to leave it unset (`null`) if no clean source field exists — `normalizeGmgnSignal` does not treat a missing `trigger_mc` as an error. |
| `observed_at`, `triggering_wallet`, `raw_wallet_labels`, `source_url` | Not present in the WS shape. Leave unset — `normalizeGmgnSignal` already falls back `observed_at` to `trigger_at` and treats the others as optional (logs a warning, not a hard failure), exactly as it already does for some REST-captured events. |

`observedAt`/timestamp handling: `sig_t_at` is Unix **seconds** (same convention `utcTimestampOrNull` already expects for numeric input — see its `< 100_000_000_000` branch). Do not re-convert or reformat it yourself; pass the raw number through and let the existing normalizer handle it, matching how the REST path already does this.

## Where to wire it in

`src/gmgn/browserImport.ts`'s `importGmgnBrowserCapture` currently has one gate:

```ts
if (typeof capture.requestPath !== 'string' || !capture.requestPath.includes(SIGNAL_REQUEST_PATH)) { otherCaptures += 1; continue; }
```

Everything that isn't the REST `token-signal` endpoint currently falls into `otherCaptures` and is never parsed — that gate was added deliberately (see the `progress.md` entry from 2026-08-11 titled "Widened the GMGN browser-capture extension...") after a real bug where ungated captures got blindly pushed through `storeGmgnSignal`, producing garbage null-heavy rows. **Preserve that discipline.** Add a new branch *before* that gate: if `capture.responseBody?.channel === 'token_signal'`, iterate `capture.responseBody.data`, skip any item without a defined `sig_t` (do not count these as errors — they're expected, not malformed), map the rest via the table above, and call the existing `storeGmgnSignal(database, mappedEvent, { capturedAt: new Date(capture.capturedAt), source: 'gmgn-browser-extension', chain: mappedEvent.chain })`. Reuse the existing `imported`/`skipped`/`errors` counters exactly as the REST path already does, so the import summary stays meaningful. Only fall through to the existing `otherCaptures` counting for captures that match neither this nor the REST gate.

## Required correctness checks before you consider this done

1. **Never let a tick item (`sig_t === undefined`) reach `storeGmgnSignal`.** Write a test proving this explicitly — this is the exact class of bug (`SIGNAL_REQUEST_PATH` gating) already fixed once in this file; do not reintroduce a version of it for the new path.
2. Verify the resulting `gmgn_signals` row for a real WS-shaped sample has the same field values a human would expect from the REST-shaped equivalent (token address, signal type, trigger time as a correct ISO timestamp, market cap) — write this as a test, not just a manual check.
3. Confirm the existing REST-shape import path and its tests (`tests/gmgn-browser-import.test.ts`) are unaffected — run the full suite, don't just add new tests.
4. Follow existing test conventions in `tests/gmgn-browser-import.test.ts` (its `exportJson` helper, `openDatabase(':memory:')` pattern) — extend that file rather than starting a new one, and build your fixture from the **real captured shape above**, not an invented one.
5. Run `npx tsc -b --noEmit` and `npm test` and report actual pass/fail counts (not "should pass") in `progress.md`, per this repo's existing standard.
6. If you find the codebase's real capture export files still available locally (check `.data/archive/gmgn-browser/` or ask the user for a fresh WS-inclusive export) and can verify end-to-end against real data rather than only synthetic fixtures, do that and say so explicitly in `progress.md` — this project consistently prefers verification against real captured data over trusting synthetic tests alone.

## Explicitly out of scope

- Do not touch the extension's capture logic (`extension/*.js`) — that's a separate task.
- Do not change `src/db/patterns.ts` or anything analysis-related — once rows land correctly in `gmgn_signals`, the existing Patterns feature already works against them unchanged.
- Do not add a new database table for this — it must land in the existing `gmgn_signals` table via the existing `storeGmgnSignal` path, so it's indistinguishable downstream from REST-captured signals except by whatever provenance fields already exist.
