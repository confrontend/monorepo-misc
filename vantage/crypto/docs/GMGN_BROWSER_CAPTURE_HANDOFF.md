# Handoff: consume GMGN browser-extension captures

## Investigation sampling (separate from signal capture)

The extension also has an opt-in **Start investigation sampling** button. It does not change
the normal `gmgn_captures` signal stream or its export. While enabled, it samples fetch/XHR and
GMGN WebSocket traffic into a separate local store, grouped by transport, method, and URL. Each
unique endpoint keeps up to five representative samples, including the page URL, direction,
status, request payload, and response/message payload (payloads are capped at 50,000 characters).
Use **Export investigation JSON** to create a separate file for endpoint review; use **Clear
investigation data** to discard it. This is deliberately a discovery aid, not a permanent source
or a scraper. Version 0.8.1 redacts common authorization/access-token fields before storage;
older exports may still contain such values and must not be shared without review or revocation.

**Status:** The normal signal-import handoff remains implemented; investigation sampling is implemented in extension version 0.8.1.
**Context:** This is a deliberate, explicit exception to the "no website scraping" rule in
`docs/GMGN_CAPTURE_NEXT_STEP_REVIEW.md` and to GMGN's own bundled CLI skill doc (which says
the public OpenAPI CLI is "the only correct method"). The reason: the public
`market signal` OpenAPI endpoint and the website's live "SkyEye Signal" panel are different
systems — the public endpoint has repeatedly returned `[]` for the unfiltered SOL query even
during periods of heavy on-screen signal activity (verified directly against the real CLI in
this session; see prior investigation). The user has chosen to capture the website's own
internal API responses (`/vas/api/v1/token-signal/v2`) from their own logged-in browser
session via a Chrome extension, and import the export into this app. Do not silently drop
this distinction — every signal ingested this way must remain visibly tagged as coming from
the browser side-channel, not the sanctioned CLI.

## What already exists (do not rebuild)

- `storeGmgnSignal` / `normalizeGmgnSignal` in `src/gmgn/ingest.ts` — already accepts events
  shaped exactly like GMGN's `token-signal` response items (`id`, `token_address`,
  `signal_type`, `trigger_at`, `trigger_mc`, `first_trigger_mc`, `market_cap`, `ath`,
  `signal_times`, `signal_times_by_type`, `cur_data`, `data`). It takes `source` and `chain`
  as options and dedups on the `(source, chain, source_event_id)` unique index already in
  `src/db/schema.ts`. **Do not modify this function** — call it as-is with
  `{ capturedAt, source: 'gmgn-browser-extension', chain: event.data?.chain ?? 'sol' }`.
- `zipStored` / `readZipEntries` in `src/dune/archive.ts` — generic ZIP writer/reader already
  used by both the Dune importer and `gmgn/capture.ts`. Reuse it for archiving the uploaded
  browser-export file, same pattern as `archiveDuneSource`.
- `importDuneContent` in `src/dune/importer.ts` — read this first as the reference
  implementation for "hash the upload, dedup by file hash, insert a batch row, insert one
  audit row per unit, archive the file." Mirror its structure, don't copy its Dune-specific
  logic.
- `logDiagnostic` in `src/db/diagnostics.ts` — log import outcomes through this, same as every
  other mutating route in `src/scripts/server.ts` already does via the `respond()` wrapper.

## Export file schema (produced by the browser extension — see `extension/`)

```typescript
interface GmgnBrowserExport {
  formatVersion: 1;
  exportedAt: string; // ISO 8601 UTC
  extensionVersion: string;
  source: 'gmgn-browser-extension';
  captures: GmgnBrowserCapture[];
}

interface GmgnBrowserCapture {
  capturedAt: string; // ISO 8601 UTC
  requestPath: string; // path only, no query string (query carries device_id/fp_did/client_id — browser fingerprint IDs, already stripped by the extension before export)
  status: number;
  responseBody: unknown; // raw parsed JSON: { code: number, reason: string, message: string, data: RawGmgnEvent[] }
}
```

Each `responseBody.data[]` entry is one raw GMGN signal event — pass it directly to
`storeGmgnSignal` unmodified. Do not reshape it; the whole point of this app is that the raw
payload is always preserved (`raw_payload` column already stores it via the existing
ingestion path).

## What to build

1. **New schema migration** in `src/db/schema.ts` (append-only, follow the existing migration
   array pattern exactly): a `gmgn_browser_import_batches` table mirroring
   `dune_import_batches` (id, source_sha256 UNIQUE, raw_source, status, imported/skipped/error
   counts, archive_path, archive_sha256, timestamps). Do not reuse `dune_import_batches` —
   keep the audit trail for this side-channel visibly separate.

2. **New module** `src/gmgn/browserImport.ts`, exporting
   `importGmgnBrowserCapture(database, sourceName, rawFileContent, now?)`:
   - Hash the raw file content (SHA-256); if a batch with that hash already exists, return
     `{ duplicateFile: true, ... }` without reprocessing (exact same idempotency contract as
     `importDuneContent`).
   - Parse and validate the top-level shape (`formatVersion === 1`, `captures` is an array).
     On malformed input, record a failed batch row and throw/return an error summary — never
     silently accept a different shape.
   - Insert a `processing` batch row, then for every `capture` in `captures`, for every event
     in `capture.responseBody?.data ?? []`, call `storeGmgnSignal(database, event, {
capturedAt: new Date(capture.capturedAt), source: 'gmgn-browser-extension', chain:
event.data?.chain ?? 'sol' })`. Track imported (newly stored) vs. skipped (duplicate)
     counts from each call's `.duplicate` flag — same accounting style as `gmgn/capture.ts`.
   - Archive the raw uploaded file via `zipStored` with a `manifest.json` (batch id, source
     hash, counts, archived-at) — identical shape to `archiveDuneSource`'s manifest.
   - Mark the batch `completed` (or `failed` with the error message on exception, matching
     `importDuneContent`'s try/catch/rollback shape).

3. **New route** in `src/scripts/server.ts`: `POST /api/gmgn/import-browser-capture`, same
   body shape as `/api/import-dune` (`{ name, content }`), calling the function above through
   the existing `respond()` wrapper so it's automatically diagnostic-logged.

4. **New UI panel** in `ui/main.tsx`, styled like the existing "01 · DUNE COHORT" card:
   eyebrow `GMGN BROWSER IMPORT`, a file picker (`accept=".json,application/json"`), and the
   same inline status pattern used for Dune imports (`N signals imported this session`,
   `Last import "<file>": +N imported · S skipped · errors E`). Place it in the workflow
   section (before the "Reference & diagnostics" divider), not after — it's an action, not a
   read-only view.

5. **Tests**: `tests/gmgn-browser-import.test.ts`, mirroring `tests/dune-importer.test.ts`'s
   structure — valid export imports correctly, duplicate-file re-upload is a no-op, malformed
   top-level shape is rejected with a clear error and recorded as failed (not silently
   dropped), an event missing required fields is still stored with `validation_errors`
   populated (never discarded — this app's core invariant), and re-importing an export that
   overlaps a previous one skips only the duplicate `(source, chain, source_event_id)` rows,
   not the whole file.

6. **Docs**: add a short section to `README.md` under a new heading (e.g. "Import a GMGN
   browser capture (UI)") explaining the provenance distinction (`gmgn-browser-extension` vs
   `gmgn-cli` source tag) and linking back to this file and to
   `docs/GMGN_CAPTURE_NEXT_STEP_REVIEW.md` for why the exception exists.

## Explicit non-goals for this step

Same list as the rest of this app: no scoring, no trading, no return calculations, no
inferring wallet identities beyond what's already in the raw payload. This is capture and
storage only.
