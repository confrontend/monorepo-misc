# Crypto early-winner research: V1 data infrastructure

This package creates a trustworthy local dataset for later research into early Solana token cohorts and GMGN signals. V1 only captures and preserves source observations. It does not decide whether a token or signal is good.

It uses the same core data stack as `seekingalpha/backtest`: TypeScript on Node.js 22+ and SQLite through the built-in `node:sqlite` module. The default database is `.data/crypto-research.sqlite` and is intentionally excluded from Git.

The later CopyTrade research surface (roster screening, Dune delayed-copy simulation, Pattern Discovery, Decision Lab, and Live Evaluation) is documented in [docs/BROWNFIELD_SYSTEM_BASELINE.md](docs/BROWNFIELD_SYSTEM_BASELINE.md), not below — this file covers only the original V1 capture/import workflow.

## Local UI

The normal workflow is UI-only after the local app is started. Use the IDE's Run/Debug action for the single `dev` npm task (or run `npm run dev` once); it starts the API and Vite UI together and watches both for changes. Open `http://localhost:5173`.

For a built, non-watching run, use the `start` npm task and open `http://localhost:4173`.

The UI provides:

- a Dune CSV/JSON file picker that persists tokens and row-level audit records to SQLite;
- a GMGN raw-event JSON capture form;
- live counts, timestamp ranges, and signal-type breakdowns;
- recent import history with archive status.

Every new Dune upload is written to `.data/crypto-research.sqlite` and archived to `.data/archive/dune-batch-*.zip`. Each ZIP contains the original upload and a `manifest.json` with the batch ID, SHA-256, counts, and archive timestamp. Duplicate content is not reprocessed or re-archived.

## Setup

```bash
cd crypto
npm install
npm test
```

Node 22.5 or newer is required because the project uses `node:sqlite`.

## Database schema

Schema changes are append-only migrations tracked by SQLite's `PRAGMA user_version`.

- `tokens`: one row per unique Solana token address. It stores `token_address`, `symbol`, `first_trade_time`, `first_dex`, `first_tx`, `source`, `imported_at`, the complete source row in `raw_payload`, and explicit `validation_errors`. `first_trade_time` is stored exactly as supplied by Dune so source formatting and fractional precision are not lost.
- `gmgn_signals`: one append-only row per captured observation, including the normalized V1 fields, the complete `raw_payload`, UTC `captured_at`, measurable `ingestion_latency_ms`, and `validation_errors`. Missing normalized fields are nullable so an unfamiliar event is preserved rather than discarded.
- `dune_import_batches`: source-level provenance, SHA-256 idempotency, complete raw file content, status, timestamps, and import counters.
- `dune_import_records`: an audit row for every parsed Dune row, including duplicates and malformed rows.
- `gmgn_browser_import_batches`: idempotent browser-export provenance, complete raw upload, import counters, failure state, and ZIP archive hash.

Application-generated timestamps use ISO 8601 UTC (`Z`). GMGN `observed_at` values are normalized to UTC. Dune first-trade values are retained verbatim because they are historical source facts; their complete source rows are also retained.

## Import a Dune cohort (UI)

Export the historical Solana cohort query as CSV or JSON. JSON may be an array or an object with a `data`, `rows`, or `result` array.

Choose the export in the **Import historical tokens** card. The importer recognizes common Dune column names for address, symbol, first trade, DEX, and transaction. The result summary and archive path appear immediately in the activity list. Reimporting identical file content is a no-op. A changed export also cannot overwrite an existing token address: that row is recorded as skipped in the audit log.

The HTTP service accepts only local browser uploads and writes to the configured local database; it does not send source data to a remote service.

## Database statistics (UI)

The dashboard reports token and GMGN counts, earliest/latest token first-trade times, earliest/latest GMGN observed and captured times, and signal counts grouped by type. A refresh button reads directly from SQLite.

The **Cohort ↔ GMGN coverage** panel joins signals to cohort tokens by exact `token_address`. It reports matched and unmatched signals, cohort tokens with and without signals, and capture validation issues. Unmatched signals remain in the database; the join is a quality view, not a filter.

## GMGN capture foundation (UI)

Paste a captured event into the **Save a raw observation** card. It calls `storeGmgnSignal(database, rawEvent, options)` through the local service. A future browser, network, or API adapter can pass a raw event directly to the same function. The function normalizes only the documented V1 field names, records missing or invalid fields, calculates latency when an observed timestamp exists, and always stores the full JSON payload.

No scraper is included because the exact GMGN source and event contract have not been established. Keeping capture adapters outside this persistence function prevents an unverified source assumption from entering the research dataset.

### GMGN browser-capture export

When the official CLI returns an empty result but the authorized GMGN Signal UI visibly contains events, use the browser-capture extension described in [docs/GMGN_BROWSER_CAPTURE_HANDOFF.md](docs/GMGN_BROWSER_CAPTURE_HANDOFF.md). Choose its version-1 JSON export in **Import website signal evidence**. The importer validates the provenance envelope, tags each event `source = gmgn-browser-extension`, deduplicates by the same source identity as CLI events, preserves the complete raw upload, and archives the upload plus manifest as a ZIP. This is an explicit evidence-import path; the application does not scrape GMGN or invent missing fields.

### GMGN credential readiness

The server checks that the local API credential file exists at `.secrets/gmgn/gmgn-api-key.txt` when a fetch or watch session starts. The secret is never sent to the browser, SQLite, logs, or ZIP archives. The project pins the official `gmgn-cli` package locally. **Fetch once** performs one read-only `gmgn-cli market signal --chain sol --raw` request, stores the result, and reports the capture outcome in one action.

**Fetch GMGN signals** preserves the complete response and writes a ZIP archive under `.data/archive/gmgn/`. GMGN source events are identified by `source + chain + source_event_id`: a repeated event is counted but not inserted as another signal row, while the distinct poll archive is always retained. Watch mode is a separate optional control for repeated polling.

The command-line importer and stats command remain available for developer diagnostics, but they are not required for normal data collection.

## Proposed next step

The review-ready GMGN capture plan is documented in [docs/GMGN_CAPTURE_NEXT_STEP_REVIEW.md](docs/GMGN_CAPTURE_NEXT_STEP_REVIEW.md). It is intentionally a proposal: automatic collection should wait for a real redacted GMGN response fixture and authorization review.

The broader review-only roadmap is in [docs/FUTURE_IMPLEMENTATION_PLAN_REVIEW.md](docs/FUTURE_IMPLEMENTATION_PLAN_REVIEW.md). It sequences capture hardening, deduplication, UI watch mode, data-quality views, and a prospective research-contract revision without authorizing analysis or trading work.

## Prospective research contract (review only)

The proposed [research-question-v2.md](research/research-question-v2.md) contract defines how a future study could compare signals prospectively once collection coverage is proven. It requires an explicit UTC collector boundary and a verified exposure window; an absent database row is never treated as proof that a historical token had no signal. The immutable metadata is available in `src/research/questionV2.ts`. This remains a proposal and does not calculate returns, label winners, score signals, or evaluate strategies.

## Exploratory scoring (UI)

The **Scoring** menu shows `exploratory-data-readiness-v1`: a transparent 0–8 score for how much supporting data exists for each captured signal. Dune cohort matching contributes two points; first-trade time, DEX, transaction, signal timestamp, temporal ordering, and signal market cap contribute the remaining checks. This is a data-completeness/provenance experiment, not a profitability score. Its weights are provisional and must be preregistered before outcome analysis.

## Explicitly out of scope

V1 does **not** implement trading, alerts, strategy evaluation or optimization, or autonomous GMGN scraping. The Dune outcome timeline is a raw, signal-anchored measurement path; it does not by itself label signals as winners or losers. Collection (`db`, `dune`, `gmgn`, and `models`) remains separate from future strategy analysis.
