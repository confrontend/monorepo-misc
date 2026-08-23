# Progress Log

- Date and time: 2026-08-18
- Step completed: Added Yahoo Finance chart OHLC refresh path for stored tickers and SPY; sync now fetches/cache 1-minute and daily bars server-side, then recalculates outcomes.
- Files changed: `src/providers/market-data.ts`, `src/scripts/server.ts`, `tests/outcomes.test.ts`.
- Decision: Use public Yahoo chart data without sending the Unusual Whales API key; failed symbols/timeframes are returned as safe errors and never replaced with mock prices.
- Test result: `npm test` passed (8/8).
- Limitation: Yahoo 1-minute retention/rate limits may leave older events without intraday outcomes; the API reports those as missing data.

- Date and time: 2026-08-18 11:37:12 -07:00
- Step completed: Created the initial Unusual Whales project shell.
- Files inspected or changed: Project-level configuration, agent instructions, source, UI, tests, documentation, and placeholder integration directories.
- Decision made and reason: Reused the shared TypeScript/Node.js, React/Vite, and SQLite stack from the Seeking Alpha backtest and Crypto/GMGN projects while excluding provider-specific implementation and secrets.
- Agent name and model: Codex GPT-5
- Test result: Pending dependency lock generation and build/test verification.
- Errors or unresolved items: The Unusual Whales data source, authorization method, schema, and first research question are intentionally undecided.
- Next step: Generate the dependency lockfile and verify the clean scaffold.

- Date and time: 2026-08-18 11:40:49 -07:00
- Step completed: Generated the dependency lockfile, installed dependencies, built the server and UI, ran the database test, and smoke-tested the built application.
- Files inspected or changed: `package-lock.json`, generated local `node_modules/`, `dist/`, `dist-ui/`, and `.data/unusual-whales.sqlite` (all generated directories/data are ignored except the lockfile).
- Decision made and reason: Kept the default sibling-project ports (UI 5173 and API 4173); used API port 4273 only for the smoke test because another local project already occupied 4173.
- Agent name and model: Codex GPT-5
- Test result: `npm test` passed (server TypeScript build, Vite production build, 1/1 SQLite test); runtime `/api/health` returned ready/connected and `/` returned HTTP 200 with the expected title.
- Errors or unresolved items: Offline-only lock generation missed an uncached package and default port 4173 was already in use during the smoke test; both were handled without project changes. The source contract and first research question remain intentionally open.
- Next step: Add a small redacted Unusual Whales fixture and define its source/schema contract before implementing collection.

- Date and time: 2026-08-18 (current task)
- Step completed: Inspected the reusable Crypto/GMGN and Seeking Alpha backtesting architecture, checked local attachments, reviewed the official Unusual Whales API documentation, and wrote the Phase 1 signal-discovery plan.
- Files inspected or changed: `docs/PHASE1_SIGNAL_DISCOVERY_PLAN.md`, existing sibling project schemas, ingestion, outcome, discovery, research, and UI modules.
- Decision made and reason: Constrain Phase 1 to provider-defined call-sweep events plus underlying-stock outcomes; keep thresholds, overlap, cost, split, and minimum-N policies explicit and preregistered before outcome review.
- Agent name and model: Codex GPT-5
- Test result: Planning/documentation only; no implementation or data fetch was run.
- Errors or unresolved items: No Unusual Whales fixture or entitlement is available locally. Exact event availability semantics, historical coverage, response retention, and cost data must be confirmed before collection.
- Next step: Review the plan, then supply access or a redacted historical export and one representative response fixture.

- Date and time: 2026-08-18 (current task)
- Step completed: Recolored the initial UI shell with a light blue ocean-inspired theme.
- Files inspected or changed: `ui/styles.css`.
- Decision made and reason: Replaced the dark green palette with pale aqua backgrounds, white cards, navy typography, and teal/blue accents to match the Unusual Whales ocean theme while preserving readable contrast.
- Agent name and model: Codex GPT-5
- Test result: UI rebuild pending.
- Errors or unresolved items: None.
- Next step: Rebuild the UI and visually review the light theme.

- Date and time: 2026-08-18 (current task)
- Step completed: Rebuilt the production UI after the theme change.
- Files inspected or changed: Generated `dist-ui/` assets (ignored build output).
- Decision made and reason: Kept the light ocean palette in the existing shell; no layout or behavior changes were needed.
- Agent name and model: Codex GPT-5
- Test result: `npm run build:ui` passed.
- Errors or unresolved items: None.
- Next step: Launch the local UI when visual browser review is desired.

- Date and time: 2026-08-18 (current task)
- Step completed: Read the supplied Unusual Whales API research, compared it with official API documentation, and documented the local API-key file location.
- Files inspected or changed: `.env.example`, `README.md`, `docs/PHASE1_SIGNAL_DISCOVERY_PLAN.md`, and attached research text.
- Decision made and reason: Use `.secrets/unusualwhales/unusual-whales-api-key.txt`, matching the existing GMGN server-side secret-file convention; keep the key out of `.env`, source, UI, database, and logs.
- Agent name and model: Codex GPT-5
- Test result: Documentation-only update; no API request was made and no secret was read.
- Errors or unresolved items: The attachment’s exact endpoint/field and subscription-retention claims still require validation against the user’s account and a redacted response fixture. The current shell has no API client yet.
- Next step: Add the credential-status reader and a single read-only option-trades probe only after the key file and account entitlement are confirmed.

- Date and time: 2026-08-18 (current task)
- Step completed: Created the empty ignored API-key file for local setup and verified it is zero bytes.
- Files inspected or changed: `.secrets/unusualwhales/unusual-whales-api-key.txt`.
- Decision made and reason: Keep the file empty and let the user enter the credential locally; no key or placeholder is stored by the project.
- Agent name and model: Codex GPT-5
- Test result: File exists with length 0 bytes.
- Errors or unresolved items: None.
- Next step: User can paste the API key into the file; then implement the server-side credential check.

- Date and time: 2026-08-18 (current task)
- Step completed: Integrated the parallel backend and final-UI workstreams.
- Files inspected or changed: `src/providers/unusualwhales.ts`, `src/scripts/server.ts`, `src/scripts/probe.ts`, `ui/main.tsx`, `ui/styles.css`, package scripts, and internal tests.
- Decision made and reason: Keep API probing server-side and keep the UI focused on final signal discovery/backtesting output; no draft or test controls are exposed.
- Agent name and model: Codex GPT-5
- Test result: `npm test` passed: TypeScript build, Vite build, and 4/4 internal tests.
- Errors or unresolved items: The local key file remains empty, so no live API request has been made. Historical ingestion and outcome calculation are the next implementation phase.
- Next step: Add the first verified historical option-trades import and underlying-price outcome pipeline after the key is entered.

- Date and time: 2026-08-18 (current task)
- Step completed: Verified the configured API key with a live read-only request, added idempotent recent call-sweep ingestion, persisted raw and normalized observations, exposed a real data summary/sync API, and connected the final dashboard to actual collection status.
- Files inspected or changed: `src/db/client.ts`, `src/providers/unusualwhales.ts`, `src/providers/unusualwhales-ingest.ts`, `src/scripts/server.ts`, `src/scripts/sync-unusual-whales.ts`, `ui/main.tsx`, `ui/styles.css`, `package.json`, and ingestion/provider tests.
- Decision made and reason: Fetch only provider-filtered call trades marked `intermarket_sweep`, exclude canceled trades, retain raw responses and stable source IDs, and show collected-event counts without inventing return metrics before price outcomes exist.
- Agent name and model: Codex GPT-5
- Test result: Live API probe returned HTTP 200; live sync received and inserted 100/100 records across 22 tickers; `npm test` passed 5/5; runtime summary returned the stored counts and landing page HTTP 200.
- Errors or unresolved items: Underlying stock and SPY bars, horizon outcomes, overlap removal, cost estimates, and chronological validation are not implemented yet. Port 4273 was occupied during smoke testing, so the temporary verification server used 4373.
- Next step: Fetch/cache underlying and SPY bars for the 100 stored events and calculate the first mature +5m/+30m/+1h outcomes.

- Date and time: 2026-08-18 (current task)
- Step completed: Diagnosed the UI's `Method not allowed` sync error as a local API port collision and assigned the Unusual Whales backend to port 4273.
- Files inspected or changed: `vite.config.ts`, `src/scripts/server.ts`, `.env.example`, and `README.md`.
- Decision made and reason: Keep the UI on 5173 and use a distinct API port, 4273, because another sibling application is already serving port 4173.
- Agent name and model: Codex GPT-5
- Test result: Rebuild pending.
- Errors or unresolved items: The running Vite process may require restart to reload its proxy configuration.
- Next step: Rebuild, verify the summary and sync routes through the corrected proxy, then refresh the UI.

- Date and time: 2026-08-18 (current task)
- Step completed: Found a second local port collision on UI port 5173 and assigned the Unusual Whales UI to fixed port 5273.
- Files inspected or changed: `vite.config.ts`, `.claude/launch.json`, and `README.md`.
- Decision made and reason: Use dedicated ports 5273 (UI) and 4273 (API) with strict Vite port binding so the app cannot silently connect to sibling-project processes.
- Agent name and model: Codex GPT-5
- Test result: Runtime proxy verification pending.
- Errors or unresolved items: Existing browser tabs on port 5173 point to the old process and must be replaced with port 5273.
- Next step: Start the current UI on 5273 and verify live summary data through its proxy.

- Date and time: 2026-08-18 (current task)
- Step completed: Restarted the current Unusual Whales backend with API network access and verified the exact UI proxy summary and POST sync routes.
- Files inspected or changed: Runtime processes only; no additional source changes.
- Decision made and reason: Keep the authorized backend running on 4273 and serve the UI on 5273 so both ports are isolated from sibling apps.
- Agent name and model: Codex GPT-5
- Test result: UI-proxied `GET /api/signals/summary` returned JSON; UI-proxied `POST /api/signals/sync` returned HTTP 200 and inserted 100 new observations. Database now contains 200 call-sweep events across 44 tickers. Full test suite previously passed 5/5 after the port fix.
- Errors or unresolved items: Existing tabs on 5173 still point at the conflicting old process.
- Next step: Open or refresh `http://localhost:5273`; then build the stock/SPY outcome pipeline.

- Date and time: 2026-08-18 (current task)
- Step completed: Defined two parallel implementation plans with non-overlapping file ownership and a fixed backend-to-UI summary contract.
- Files inspected or changed: `docs/PARALLEL_AGENT_IMPLEMENTATION_PLAN.md` and current ingestion/UI architecture.
- Decision made and reason: Backend owns real bar/outcome computation; UI owns only final presentation, preventing agents from modifying the same files or inventing data independently.
- Agent name and model: Codex GPT-5
- Test result: Planning/documentation only; parallel implementation not yet started.
- Errors or unresolved items: Exact underlying-bar coverage may vary by ticker and API retention; the backend must expose explicit exclusions rather than fill gaps.
- Next step: Start both bounded implementation tracks in parallel, then run one integrated live sync.

- Date and time: 2026-08-18 (current task)
- Step completed: Replaced the placeholder shell with the final focused signal-discovery dashboard UI.
- Files inspected or changed: `ui/main.tsx`, `ui/styles.css`.
- Decision made and reason: Kept the interface light, ocean-inspired, and evidence-first: large call sweeps, fixed outcome horizons, readiness state, and methodology caveats are visible; no mock metrics, draft controls, or testing controls are exposed.
- Test result: UI production build passed.
- Errors or unresolved items: Metrics remain intentionally empty until authorized historical events and matching underlying/SPY bars are ingested.
- Next step: Connect the server-side source contract and populate verified observations.

- Date and time: 2026-08-18 (current task)
- Step completed: Added the server-only Unusual Whales credential reader and bounded read-only option-trades probe.
- Files inspected or changed: `src/providers/unusualwhales.ts`, `src/scripts/probe-unusual-whales.ts`, `src/scripts/server.ts`, `tests/unusualwhales-provider.test.ts`, and `package.json`.
- Decision made and reason: Read the ignored key file at request time, send it only as a Bearer header, cap probe requests at 10 rows, request the documented 15-minute delay, and return only sanitized status metadata.
- Agent name and model: Codex GPT-5
- Test result: `npm test` passed (server/UI builds plus 3 provider/database tests).
- Errors or unresolved items: The local key file is still empty, so the live read-only probe returned the sanitized configuration error `Unusual Whales API key is not configured`; account entitlement and exact historical response shape remain unconfirmed.
- Next step: Run the probe once and capture a redacted response contract before implementing historical ingestion.

## 2026-08-20 — Native PostgreSQL historical worker

- Step completed: Added a PostgreSQL-native historical worker for streamed call/put full-tape data and daily dark-pool data, with PostgreSQL import batches, per-day coverage, bounded option-trade writes, progress checkpoints, cancellation checks, and queued/retryable `uw_job_runs` state helpers.
- Files inspected or changed: `src/providers/postgres-historical-backfill.ts`, `src/scripts/postgres-backfill-worker.ts`, `src/diagnostics.ts`, `src/db/postgres-ingestion.ts`.
- Decision made and reason: Kept SQLite as the default and isolated the cutover work to new worker code plus PostgreSQL persistence helpers; server routing, market-data, outcome, UI, and existing tests were not changed.
- Agent name and model: Codex GPT-5.
- Test result: `npm test` passed 55/55; server and UI builds passed.
- Errors or unresolved items: The worker is not wired into `server.ts` or the production queue yet; market-bar refresh and PostgreSQL outcome persistence remain separate integration hooks. No full PostgreSQL cutover is claimed.
- Next step: Wire the existing PostgreSQL-mode backfill route/queue to `runPostgresHistoricalWorker`, then add PostgreSQL market-data and outcome stages in their separately owned files.

Final goal check: This enables reproducible historical Call/Put/Dark Pool collection in PostgreSQL, which supplies the event history needed to test repeatable, backtestable signals. The project remains on track, with routing and downstream market/outcome integration explicitly still pending.
## 2026-08-18 — Backend outcomes track

- Added schema v3 tables for cached market bars and per-event horizon outcomes.
- Added deterministic outcome engine for +5m/+30m/+1h/+1d/+3d with first-bar-at/after-event convention, maturity checks, per-symbol non-overlap, SPY excess returns, and 10/25/50 bps-per-side cost scenarios.
- Extended `/api/signals/summary` with the documented `outcomes` contract and refreshes outcomes after sync.
- Added fixture tests for mature returns, benchmark joins, overlap exclusion, costs, and future-outcome protection.
- `npm test` passes: 7/7.
- Remaining live-data limitation: the cache requires authorized underlying OHLC ingestion; no mock price values are used.

## 2026-08-18 — Backend price refresh and live verification

- Added server-side Yahoo Finance chart refresh for cached 1-minute/daily OHLCV bars for stored tickers plus SPY; wired POST `/api/signals/sync` to ingest events, refresh prices, and recalculate outcomes.
- Added safe per-symbol market-data failure reporting and Yahoo response normalization coverage.
- `npm test` passes: 8/8.
- Live sync completed with 100 new events and 7,167 cached bars; unavailable symbols were reported explicitly (BRKB and SPXW returned HTTP 404).
- Live summary now contains measured +5m and +30m outcomes; longer horizons remain immature because the current events are too recent.

## 2026-08-18 — Summary contract compatibility fix

- Added `scope` and `coverage` objects to `GET /api/signals/summary` while preserving the existing flat fields and `outcomes` data.
- This matches the final UI parser and removes the unexpected-shape error.
- `npm test` passes: 8/8; live summary now includes coverage fields and measured outcome counts.

- Date and time: 2026-08-18 12:34:05 -07:00
- Step completed: Implemented Plan 2 (UI research dashboard) against the agreed `/api/signals/summary` contract.
- Files inspected or changed: Changed `ui/main.tsx` and `ui/styles.css` only. Read-only inspection of `src/scripts/server.ts`, `src/research/outcomes.ts`, and `src/providers/unusualwhales-ingest.ts` to check the live response shape. No backend, test, or database file was edited.
- Decision made and reason: Replaced the previous visual mockup, whose metrics were hardcoded em dashes and whose horizon selector had no state, with a data-driven dashboard. All values are parsed defensively: a metric renders only when the API supplies a finite number, so a missing field shows an em dash and can never appear as 0. The UI performs no research calculation.
- Agent name and model: Claude Code, Opus 5
- Test result: `npx tsc -p tsconfig.ui.json --noEmit` clean; `npm run build:ui` passed; `npm test` passed 8/8. Verified in-browser against a scratchpad mock serving the agreed contract: sync flow (loading state, received/inserted counts), all five horizons, all five data-status states, null-field em dashes, failed sync, unreachable API, malformed JSON, unexpected shape, and a 375px viewport with no horizontal overflow.
- Errors or unresolved items: Integration blocker. `/api/signals/summary` currently returns the flat shape `{totalEvents, callSweepEvents, distinctTickers, earliestExecutedAt, latestExecutedAt, latestImport, outcomes}`. The agreed contract requires `{scope, coverage, outcomes}`. The `outcomes` block already matches field-for-field; only the `scope` and `coverage` wrapper is missing, so the UI reports an unexpected shape instead of inventing coverage values. Deriving coverage in the UI was rejected because per-horizon counts are not coverage-level counts.
- Next step: Backend agent wraps the summary response in `scope` and `coverage` per Plan 1 step 8, then rerun the integration checks.

## 2026-08-18 — Breadth-first signal inventory foundation

- Chose Plan A: backend breadth-first signal inventory and standardized comparison foundation. The separate UI comparison-table plan was not started.
- Added `src/research/signal-catalog.ts` with simple, point-in-time definitions for call sweeps, put sweeps, repeated sweeps, dark-pool blocks, flow imbalance, OI spikes, GEX/gamma, ETF flow, insider activity, and Congress activity.
- Added `docs/BREADTH_FIRST_SIGNAL_INVENTORY.md` documenting source endpoints, feasibility, direction, and timing limitations.
- Added catalog tests; `npm test` passes: 10/10.
- Contribution to signal discovery: establishes a common source inventory before threshold tuning, making unsuitable or look-ahead-prone datasets visible instead of forcing them into the Call Sweep pipeline.
- Plan status: still following breadth-first methodology.
- Highest-value next step: verify the limited/candidate endpoint shapes with small read-only API probes, then implement one generic normalized-event adapter for Put Sweeps and Dark Pool Blocks.

## 2026-08-18 — Standardized breadth-first comparison API

- Implemented my selected backend plan: added `GET /api/signals/comparison` in `src/research/comparison.ts`.
- The response now contains one standardized row for every catalog signal, including direction, feasibility, raw/independent/mature/usable coverage, available horizons, outcome metrics, cost scenarios, and limitations.
- Call Sweeps use the existing real outcome engine; all other sources are explicitly marked unavailable until normalized historical ingestion exists. No metrics are fabricated.
- Added comparison contract tests; `npm test` passes: 11/11.
- Live endpoint verified with 10 signal rows, 500 stored Call Sweep events, and real +5m Call Sweep outcomes.
- Contribution to signal discovery: creates the common comparison surface needed to see which data sources deserve depth-first research.
- Plan status: breadth-first; the separate UI comparison-table plan remains unstarted.
- Highest-value next step: use read-only probes to verify Put Sweep and Dark Pool endpoint response shapes, then add their minimal normalized ingestion adapters.

## 2026-08-18 — Backend diagnostics and operational logging

- Reviewed the backend and identified the missing debugging layer: import batches existed, but sync operations and market-refresh failures were not persisted in one place.
- Added schema v4 table `uw_operation_logs` for processing/completed/failed operation records with safe JSON details and errors.
- Added read-only `GET /api/diagnostics` exposing schema version, row counts, latest import status, outcome exclusion reasons, validation-error counts, and the latest 20 operation records. It never exposes credentials or raw API keys.
- Wrapped `POST /api/signals/sync` with durable operation logging, including market-data failure details.
- Updated README route documentation and added diagnostics tests.
- `npm test` passes: 12/12.
- Contribution to signal discovery: failed or incomplete collection and outcome work can now be diagnosed instead of silently producing blank comparisons.
- Plan status: still breadth-first; no UI work or new signal provider was started.
- Highest-value next step: run one sync, inspect `/api/diagnostics`, and use the recorded failures to guide Put Sweep/Dark Pool adapter work.

- Added durable logging for the Unusual Whales provider probe route as well, including sanitized status/field metadata and failure text.
- Backend review result: import batches, operation logs, validation errors, outcome exclusion reasons, and market refresh failures are now inspectable through `/api/diagnostics`; no credentials or raw secrets are returned.

## 2026-08-18 — First-results visibility fix

- Live API review confirmed the backend has real observations: 600 Call Sweep events and 199 usable `+5m` outcomes. The table appeared empty because the UI defaulted to `+1d`, which is not mature for the newly collected events; other signal families correctly have zero ingested events so far.
- Changed the comparison dashboard default horizon to `+5m`; longer horizons remain selectable.
- `npm run build:ui` passes.

## 2026-08-18 — Automatic evidence summary

- Added a backend-generated `leader` summary to the comparison response and a visible dashboard banner.
- The system now automatically evaluates the preferred `+1d` horizon first, requiring at least 30 usable observations and a non-negative 25 bps/side after-cost result before naming a candidate.
- If those rules are not met, it may show an early descriptive leader only when the shorter-horizon result also clears the sample and after-cost guard; otherwise it clearly says `No reliable leader yet`.
- Current live state correctly reports no reliable leader because +1d outcomes are not mature and short-horizon after-cost results are negative.
- This prevents the user from needing to inspect every horizon while preserving the no-overfitting/no-premature-winner methodology.

## 2026-08-18 — Parallel Put Sweep and Dark Pool breadth expansion

- Two agents worked in parallel on isolated provider modules: Put Sweep ingestion and Dark Pool normalization.
- Added Put Sweep ingestion using the shared option-trade schema, provider filtering, raw payload preservation, deduplication, cancellation handling, and tests.
- Added Dark Pool normalization/fetching with documented field aliases, validation errors, deduplication, safe HTTP errors, and tests.
- Integrated both into the sync route. Put Sweeps now enter the shared outcome engine with bearish direction adjustment; Dark Pool records are persisted in `uw_dark_pool_trades` and appear with real coverage while price/direction outcome treatment remains explicitly unavailable.
- Live sync completed on a network-enabled backend: 100 Put Sweeps inserted and 100 Dark Pool records inserted. Existing Call Sweeps remained at 600.
- `npm test` passes: 19/19.
- Contribution to signal discovery: the comparison now has real historical coverage for three signal families instead of only Call Sweeps.
- Plan status: breadth-first; no threshold optimization or strategy selection was added.
- Highest-value next step: wait for the new Put Sweep/Dark Pool events to mature, then implement Dark Pool direction/price outcomes and add the next timestamp-safe flow source (Market Tide or repeated sweeps).

## 2026-08-18 — Historical backfill workflow

- Implemented a separate historical backfill control in the UI with date range, Call Sweep/Put Sweep selection, progress, success, validation, and error states. Recent sync remains separate.
- Added `POST /api/signals/backfill` with date validation, request caps, date-by-date full-tape retrieval, local signal/date filtering, deduplication, import-batch persistence, price refresh, and outcome recalculation.
- The provider diagnosis showed that `/api/option-trades` only serves the latest trading day; the backfill now targets `/api/option-trades/full-tape/:date`.
- Increased the full-tape request timeout to 120 seconds because historical files are large.
- Automated tests pass: 22/22.
- Live verification reached the correct full-tape route but the first two-day download exceeded the original timeout; the workflow records this failure rather than claiming data was downloaded. The exact full-tape response size/entitlement still needs one successful mature-date verification.
- Contribution to signal discovery: users can now request historical mature data directly from the application instead of waiting for recent events to age.
- Plan status: still breadth-first; no strategy optimization was added.
- Highest-value next step: verify one small full-tape date successfully, then use the backfill button for a mature multi-day range and inspect the resulting comparison rows.

## 2026-08-18 — Historical backfill progress indicator

- Added an indeterminate animated progress bar and live elapsed timer to the historical backfill UI.
- While a large range such as three months is downloading, the user now sees `Downloading historical data…`, elapsed `MM:SS`, and a clear explanation that completion waits for download, price refresh, and outcome calculation.
- This is intentionally indeterminate until the backend exposes per-day job progress; it does not invent a percentage.
- `npm test` passes: 22/22.

## 2026-08-18 — Historical duplicate-download guard

- Added schema v6 table `uw_historical_coverage` keyed by signal type and trading date.
- Historical backfill now skips dates already marked completed, retries failed/processing dates, and still uses unique provider IDs as a second deduplication guard.
- Backfill responses now report skipped dates; diagnostics exposes historical coverage by signal/status.
- `npm test` passes: 22/22.
- This prevents repeated three-month requests from re-downloading dates already stored in the database.

## 2026-08-18 — Breadth-first signal comparison dashboard (UI)

- Date and time: 2026-08-18 13:52:45 -07:00
- Step completed: Replaced the single-signal UI presentation with a breadth-first comparison screen showing every signal type the backend returns.
- Files inspected or changed: Changed `ui/main.tsx` and `ui/styles.css` only. Read-only inspection of `src/scripts/server.ts`, `src/research/comparison.ts`, `src/research/signal-catalog.ts`, `src/research/outcomes.ts`, `docs/PARALLEL_AGENT_IMPLEMENTATION_PLAN.md`, and `progress.md`. No backend, test, schema, or package file was edited.
- Decision made and reason: Pointed the screen at `GET /api/signals/comparison`, which the backend agent had already added and which matches the standardized `SignalComparisonResponse` field for field. The earlier handoff note still named `/api/signals/summary`; reading `src/research/comparison.ts` showed the newer route is the real contract, so no route was invented and no fallback shape was added. Rows are ordered ready > candidate > limited > blocked with a stable sort, so backend order is preserved inside each group and nothing is ever ranked by return, win rate, or after-cost figures. `N` uses `coverage.independentEvents`, with raw, mature, and usable shown as separate figures. Metrics render only from finite numbers, so a missing value shows an em dash and can never appear as 0. The table shows the 25 bps per side scenario labeled as estimated; 10/25/50 bps live in an expandable row detail, each labeled estimated. Backend limitations render verbatim; the derived `Limited history` and `Timing risk` chips are grouping cues over that same text and never restate it more strongly. The UI performs no research calculation - only formatting, sorting, and counting.
- Agent name and model: Claude Code, Opus 5
- Test result: `npx tsc -p tsconfig.ui.json --noEmit` clean; `npm run build:ui` passed. Verified against the live API on port 4273: 10 catalog rows, Call Sweeps showing 339 independent / 274 mature / 199 usable / 500 raw / 92 tickers with real +5m, +30m, and +1h outcomes, and `+1d` and `+3d` correctly reporting no price outcomes yet. Also verified against a scratchpad mock covering full data, partial data, signals with coverage but no outcomes, empty signal list, malformed payload (non-array, truncated JSON, non-JSON body, HTTP 500, row missing `signalId`), and network failure. Checked all five horizons, row-detail expansion, status ordering, and layout at 375px, 768px, and 1265px: the full table fits a desktop card, narrow screens scroll inside the component only, no page-level horizontal overflow, and no clipped cells. Mock stopped and deleted afterwards. Did not run `npm test`, because it rebuilds the server and the backend agent is editing `src/` in parallel.
- Errors or unresolved items: One correctness fix found during live integration: the backend returns a placeholder outcome block with `status: "unavailable"` for every horizon, so counting non-null outcomes made the banner claim every signal had reported a result while all metrics were em dashes. Horizon coverage now counts only outcomes whose status is not `unavailable`. Open question for the user: the brief did not name the endpoint, so `/api/signals/comparison` was chosen from the backend source; confirm that is the intended contract owner. Note also that `coverage.independentEvents` and `matureEvents` are coverage-level fields and therefore do not vary by horizon, while the per-horizon sample size appears in the row detail.
- Next step: Once normalized ingestion exists for Put Sweeps and Dark Pool Blocks, confirm their rows populate coverage and outcomes without UI changes; no UI work is required for that.

Final Goal Check: The goal remains determining whether Unusual Whales data contains repeatable, backtestable signals. This screen contributes by making data readiness comparable across all ten catalog sources at once, so effort goes to sources with clean history instead of the single source that happened to be built first. The project is on track, and the screen deliberately answers which signals deserve research rather than which signal to trade.

## 2026-08-18 — Dark Pool adapter

- Date and time: 2026-08-18 14:00 -07:00
- Step completed: Added an isolated Dark Pool fetch/normalization adapter with deduplication, raw-payload preservation, timestamp parsing, cancellation handling, validation errors, and sanitized provider failures.
- Files inspected or changed: `src/providers/dark-pool.ts`, `tests/dark-pool.test.ts`.
- Decision made and reason: Accept the documented `data` response envelope from `/api/darkpool/recent` (or `/api/darkpool/{ticker}` via an endpoint option), with conservative aliases for ticker, execution time, price, size, and notional fields. Unsupported envelopes fail explicitly instead of fabricating historical records.
- Agent name and model: Codex.
- Test result: `npm test` passed, 15/15 tests.
- Errors or unresolved items: The adapter is not yet wired into the database or sync route; provider-specific field aliases should be confirmed against a live Dark Pool response before persistence.
- Next step: Integrate this normalized result into the shared event storage/outcome pipeline after confirming the live endpoint shape.

Final Goal Check: This adds a second backtestable UW signal family to the breadth-first path while preserving source evidence and timing quality. The project remains on track; integration and live verification are the highest-value next steps.

## 2026-08-18 — Historical backfill controls

- Date and time: 2026-08-18
- Step completed: Added a separate UI section for date-bounded historical backfills, with signal selection for Call Sweeps and Put Sweeps, loading/completion/error states, and comparison refresh after a successful request.
- Files inspected or changed: `ui/main.tsx`, `ui/styles.css`.
- Decision made and reason: Historical downloads use `POST /api/signals/backfill` with `{ from, to, signals }`; recent sync remains a separate action so the user can distinguish current feed collection from mature historical research.
- Agent name and model: Codex.
- Test result: `npm run build:ui` passed.
- Errors or unresolved items: The UI assumes the backend backfill route accepts `call_sweeps` and `put_sweeps`; no mock results were added.
- Next step: Verify the backend route end-to-end with a mature date range and confirm real inserted counts and updated outcome metrics.

Final Goal Check: This gives the breadth-first discovery workflow a direct way to load already-mature historical events instead of waiting several days. The project remains on the breadth-first plan; backend route verification is the highest-value next step.

## 2026-08-18 — Historical backfill backend

- Date and time: 2026-08-18
- Step completed: Added bounded historical Call Sweep and Put Sweep backfill with date validation, pagination/cursor fallback, range filtering, shared raw import batches, deduplication, and automatic market refresh/outcome recalculation through `POST /api/signals/backfill`.
- Files inspected or changed: `src/providers/historical-backfill.ts`, `src/scripts/server.ts`, `tests/historical-backfill.test.ts`.
- Decision made and reason: Support both `signalTypes` and the UI’s `signals` aliases; use provider cursors when present and oldest-event fallback otherwise, while independently enforcing event bounds to prevent out-of-range records or look-ahead.
- Agent name and model: Codex.
- Test result: `npm test` passed, 22/22 tests.
- Errors or unresolved items: Unusual Whales historical cursor/date parameter semantics are not confirmed against a documented historical fixture; the adapter records assumptions and filters returned timestamps defensively. Live backfill still needs to be run with a mature range.
- Next step: Run the new button/route against a mature date range and verify real historical rows, price coverage, and non-empty +1d/+3d comparison metrics.

Final Goal Check: This enables immediate mature historical outcomes across multiple UW signal families, which is necessary to compare signals for repeatable after-cost behavior. The project remains on the breadth-first plan; live verification and then adding the next feasible signal source are the highest-value steps.

## 2026-08-18 — Multi-source historical backfill UI

- Date and time: 2026-08-18
- Step completed: Replaced the Call/Put-only selector with checkboxes for every signal catalog source, defaulting to Call and Put Sweeps and showing each source's readiness status. Added per-source completion/unavailable result rows and backend error display.
- Files inspected or changed: `ui/main.tsx`, `ui/styles.css`.
- Decision made and reason: The UI sends the selected canonical signal IDs to `POST /api/signals/backfill`; sources without a verified backend adapter are visibly marked unavailable rather than showing fake counts or metrics.
- Agent name and model: Codex.
- Test result: `npm run build:ui` passed.
- Errors or unresolved items: The current backend adapter executes Call and Put Sweeps only; other selected catalog sources are reported unavailable until their adapters exist. The backend does not yet return per-source counts, so aggregate counts are shown while unsupported sources are labeled explicitly.
- Next step: Add verified historical adapters for the next feasible source and extend the backfill response with per-source counts/status.

Final Goal Check: This makes the breadth-first workflow visible and selectable across the entire signal catalog without pretending unsupported sources have data. The project remains on the breadth-first plan; adding the next verified adapter and per-source backend progress is the highest-value next step.

## 2026-08-18 — Multi-source historical backfill backend

- Date and time: 2026-08-18
- Step completed: Extended historical backfill to return standardized per-signal results, support Dark Pool historical persistence through the shared coverage ledger, and report unverified sources as unsupported without network calls.
- Files inspected or changed: `src/providers/historical-backfill.ts`, `src/scripts/server.ts`, `tests/historical-backfill.test.ts`.
- Decision made and reason: Only Call Sweeps, Put Sweeps, and the date-addressable Dark Pool adapter make requests. Repeated sweeps, flow imbalance, OI, GEX, ETF flow, insider, and Congress sources remain explicit unsupported statuses until point-in-time historical endpoints are verified.
- Agent name and model: Codex.
- Test result: `npm test` passed, 24/24 tests.
- Errors or unresolved items: The Dark Pool historical path uses a date-addressable endpoint convention and still needs live provider verification; no unsupported source is queried or given fabricated metrics.
- Next step: Run a selected multi-source backfill from the UI and inspect per-signal statuses and diagnostics.

Final Goal Check: This enables breadth-first backfill selection and honest source-by-source coverage, which is required before signal comparison. The project remains on the breadth-first plan; live verification of the Dark Pool historical endpoint is the highest-value next step.

## 2026-08-18 — Multi-source backfill integration verification

- Integrated the all-source checkbox UI with the backend `signalResults` response shape so each selected source displays its own completed, unsupported, partial, or failed status.
- Supported historical adapters currently make requests for Call Sweeps, Put Sweeps, and Dark Pool Blocks. All other catalog sources are selectable but return explicit unsupported reasons without network calls.
- `npm test` passes: 24/24; UI and server builds pass.
- Project remains breadth-first. The next high-value step is live verification of a mature historical range and then adding the next source only when its historical timing is confirmed.

## 2026-08-18 — Live backfill status reporting

- Added UI polling of `/api/diagnostics` during historical backfill.
- The backfill panel now reports server state plus completed, processing, and failed source-day counts every five seconds, alongside elapsed time and the indeterminate progress bar.
- Live inspection currently shows the active operation as `processing`, with one Call Sweep day failed and one Put Sweep day still processing; this is now visible rather than hidden behind a timer.
- `npm test` passes: 24/24.

## 2026-08-18 — Live failure diagnosis in backfill UI

- Extended diagnostics coverage rows with error messages and added UI polling display for the actual failed source/date reason.
- The active live attempt currently reports: Call Sweep day still processing; Put Sweep timed out; Dark Pool historical request returned HTTP 422.
- `npm test` passes: 24/24.

## 2026-08-18 — Verified and corrected Unusual Whales API requests

- Compared provider requests with the official Unusual Whales OpenAPI documentation.
- Fixed the option probe to use the documented `ticker_symbol` parameter.
- Fixed historical Dark Pool backfill to use `/api/darkpool/recent?date=YYYY-MM-DD` instead of an undocumented date path.
- Removed undocumented filters and cursor pagination from Full Tape requests; each historical date is now requested using the documented `/api/option-trades/full-tape/{date}` route and filtered locally.
- Updated regression tests; `npm test` passes: 24/24, with server and UI builds passing.

## 2026-08-18 — Second API verification

- Rechecked the official Darkpool documentation and found one remaining mismatch: the documented maximum `limit` is 200, not 500.
- Capped both recent and historical Darkpool requests at 200 to prevent provider HTTP 422 responses.
- `npm test` passes: 24/24, with server and UI builds passing.

## 2026-08-18 — Post-fix run

- Rebuilt and ran the application checks after the API corrections.
- Local diagnostics endpoint responded HTTP 200.
- Full test suite remains green: 24/24.
- A direct provider probe could not connect from this execution environment (`fetch failed` before an HTTP response), so live provider verification still requires running the probe from the user’s normal network environment.

## 2026-08-18 — Live backfill verification after restart

- The HTTP 500 was traced to the previously running server process, which still had the old API code, plus several duplicate historical jobs left as processing records.
- Restarted the Unusual Whales server on port 4273 with the corrected code.
- Ran a one-day Dark Pool historical backfill through the live app: HTTP 200, 200 records received and inserted, no API error.

## 2026-08-18 — Backfill cancellation and market-day guards

- Added a visible Stop download button wired to `/api/signals/backfill/cancel` with an abort signal propagated into Full Tape and Dark Pool requests.
- Added a server-side single-backfill guard so repeated clicks are rejected instead of creating duplicate multi-hour downloads.
- Full Tape now skips weekends and treats provider market-closed responses as completed skipped dates rather than failing the entire run.
- On restart, interrupted operations/imports/coverage rows are marked failed with an explicit restart message instead of remaining falsely processing.
- Stopped the prior fetch; already inserted events remain in SQLite.
- `npm test` passes: 39/39; UI stop control is present in the built bundle; no active backfill remains.

- Date and time: 2026-08-18 (current task)
- Step completed: Fixed both confirmed defects in the historical-backfill feature: `/api/option-trades/full-tape/:date` was being parsed as JSON when the live API actually returns a ~1.4 GB single-entry ZIP archive (DEFLATE-compressed CSV) per trading day, and the dark-pool historical path requested `limit=500` against a documented and enforced max of 200.
- Files inspected or changed: Added `src/providers/full-tape-csv.ts` (new streaming ZIP-local-entry + DEFLATE + CSV row reader, scoped to this one confirmed API shape, not a general ZIP parser) and `tests/full-tape-csv.test.ts`. Rewrote the call/put-sweep branch of `src/providers/historical-backfill.ts` to stream real rows via the new module instead of `response.json()`; extended `src/providers/dark-pool.ts` with an optional `date` query parameter; added a truncation warning when a dark-pool day returns exactly the 200-record cap (that endpoint has no offset/pagination, so a day at the cap can no longer be confirmed complete and is now flagged instead of silently reported as done); removed now-dead code (`recordsFrom`, `nextCursorFrom`, unused `PAGE_SIZE`/`epochSeconds`) left over from the incorrect JSON-pagination assumption; corrected the `assumptions` array, which previously described a response format that was never actually true. Rewrote `tests/historical-backfill.test.ts` to build real DEFLATE-compressed ZIP fixtures instead of mocking a `{data:[...]}` JSON envelope — the old mocks exactly matched what the code wanted rather than what the API returns, which is why `npm test` passed while every live run failed.
- Decision made and reason: Verified the real wire format directly against the live API before writing any fix (range-request probes confirmed `content-type: application/zip`, ZIP magic bytes, a single `{date}-option_trades.csv` DEFLATE entry, the exact 40-column CSV header, and that `report_flags` carries `{intermarket_sweep}` as a Postgres array literal) rather than guessing from the code or docs alone. Chose a narrow, purpose-built ZIP reader over a general-purpose library or npm dependency because exactly one entry with no data-descriptor is the only case that needs to be handled, and Node's `zlib.createInflateRaw()` was confirmed (by direct test) to end cleanly on the trailing ZIP central directory, so no central-directory parsing is needed at all. Reused the dark-pool module's already-correct 200-record clamp for the day loop where it made sense, and added an explicit non-fatal warning for the truncation case rather than a new coverage-status value, since the existing `errors: string[]` field already exists for exactly this kind of caveat.
- Test result: `npm test` passes 35/35 (up from 26; the two prior full-tape tests were rewritten with real ZIP fixtures rather than dropped). Also verified against the live Unusual Whales API directly (not just tests): a capped run (20 MB decompressed) against real 2026-08-14 data streamed, parsed, and inserted 934 real intermarket-sweep call rows into a throwaway SQLite database in 1.7s (previously this call failed every time in production with "aborted due to timeout"); an uncapped dark-pool run for the same day returned HTTP 200 with 200 real records inserted and correctly flagged the day as possibly-truncated (previously HTTP 422 every time).
- Errors or unresolved items: A full, unbounded 366-day full-tape backfill has not been run (each day is ~1.4 GB; a full year would be hundreds of GB and was judged impractical to actually execute as part of this fix). The 20 MB-capped live run proves the parsing and insertion path is correct; a longer live run to build a real multi-day dataset is a reasonable next step but was not performed here to avoid an unbounded, uncoordinated bandwidth/time cost. The dark-pool endpoint's lack of pagination is a real, permanent data-completeness ceiling (not just a bug) — a day above 200 dark-pool block trades cannot be made complete through this endpoint at all; this is now surfaced rather than hidden, but not solved.
- Agent name and model: Claude Code, Sonnet 5
- Final Goal Check: the final goal is determining whether Unusual Whales data contains repeatable, backtestable signals that could make money. This fix is a prerequisite, not a result: a signal can't be evaluated on historical data the pipeline can't actually collect, and the prior code silently failed on every real historical request while tests reported it as working. The project is on track, but this also reinforces that the test suite alone was not proof of correctness against the real provider — future provider-facing code in this project should be checked against a live response before its test fixtures are written, not after.
- Next step: Run a longer live historical backfill (multiple mature days) to build a real dataset large enough for the comparison dashboard's coverage/outcome metrics to reflect genuine sample sizes, and decide on an explicit day-count/bandwidth budget for that run given the ~1.4 GB/day cost.

- Date and time: 2026-08-18 (current task)
- Step completed: Added real diagnostics/logging for historical backfill runs and a genuine determinate progress bar in the UI (previously indeterminate, with no live byte/row data).
- Files inspected or changed: `src/db/client.ts` (schema_version 6->7; added `bytes_received`, `bytes_expected`, `progress_updated_at` to `uw_historical_coverage`, with a guarded `ALTER TABLE` migration for pre-existing databases -- verified against the real project database, not just fresh test fixtures); `src/providers/full-tape-csv.ts` (added an `onBytes` callback reporting raw network chunk sizes); `src/providers/historical-backfill.ts` (throttled progress writer persisting live byte counts during a full-tape download, reading `Content-Length` for the expected total, flushing the final count in a `finally` block even on failure so a partial day shows exactly how far it got); `src/diagnostics.ts` (new `activeHistoricalDay` field: the single currently-processing day with its live counters); `ui/main.tsx` and `ui/styles.css` (real `<div className="progress-fill">` sized by a computed percentage, replacing the indeterminate animation as the default view; client-side day-count denominator computed from the requested date range so the bar has an honest total instead of relying on an all-time aggregate).
- Decision made and reason: Chose per-day byte/row counters over a full async job-queue redesign because the existing day-by-day `uw_historical_coverage` bookkeeping already gave a natural place to persist progress, and the POST request/response cycle didn't need to change. Deliberately did not reuse the existing "N source-days completed" diagnostic text as the progress denominator once I noticed it aggregates across all runs ever (not just the current one); using it for a live percentage would have shown a number ahead of where the current run actually was on a database with history. Instead, the total is computed client-side from the requested date range at submit time, and "days completed" is tracked by watching distinct (signal type, trading date) pairs observed while polling, which needs no new backend concept.
- Test result: `npm test` passes 39/39 (up from 35 -- added a schema-version test asserting the new columns exist on a fresh database, a migration test that recreates a real schema_version-6 database on disk and proves `createDatabase()` adds the columns and preserves the existing row, a diagnostics test for `activeHistoricalDay` including the transition back to `null` once a day completes, and two historical-backfill tests: one confirming `bytes_expected`/`bytes_received` get recorded from a real Content-Length header, one confirming a day that fails mid-download still has its partial byte count persisted instead of staying null. UI: `tsc --noEmit` and `npm run build:ui` both pass. Live verification: ran a real backfill against the production database and polled `/api/diagnostics` every 2s -- `bytesReceived` climbed 1.26MB to 47MB against a real `bytesExpected` of ~1.498GB pulled from the live response's Content-Length header, confirming the whole path (network -> throttled writer -> SQLite -> diagnostics read) works end to end, not just in tests.
- Errors or unresolved items: The live verification run was intentionally stopped partway through (a full day is ~1.4GB and multiple minutes) rather than let it finish, since the mechanism was already proven; this left one `uw_historical_coverage` row for call_sweep/2026-08-13 in `status='processing'` in the real project database. This is expected, self-recovering state -- the next backfill run for that signal type resets it via the existing `ON CONFLICT` clause -- and it is itself a live demonstration of exactly the failure-visibility gap this change closes: `activeHistoricalDay` correctly surfaced this exact stuck row (left over from an earlier, unrelated server restart) before I ever started my own test run. The top-level "day N of M" progress figure is an approximation: it assumes the backend processes exactly one day at a time in a fixed order (true today) and treats a day with no Content-Length header, or a dark-pool day, as a flat 5% "just started" fraction rather than a real sub-day percentage, since dark-pool responses are small enough that finer granularity isn't worth the complexity.
- Agent name and model: Claude Code, Sonnet 5
- Final Goal Check: the final goal is determining whether Unusual Whales data contains repeatable, backtestable signals that could make money. This change doesn't move that question forward directly, but it makes every future historical data-collection run diagnosable after the fact and observable while it's running, which is a precondition for trusting the dataset the eventual signal analysis will run on. The project remains on track; this was infrastructure work in direct service of collecting the historical data the research depends on.
- Next step: Run a real multi-day backfill to completion (now observable end to end) to build a dataset large enough for the comparison dashboard's +1d/+3d outcomes to reflect genuine sample sizes.
# 2026-08-19 01:48 UTC — Resume-safe unattended backfill

- Step completed: Added one-click resume for the last saved historical Call/Put request range; completed coverage days remain skipped, failed/interrupted days retry, and outcomes refresh after completion.
- Files changed: `src/scripts/server.ts`, `src/diagnostics.ts`, `ui/main.tsx`, `src/providers/historical-backfill.ts`.
- Decision: derive the resume range from persisted import metadata so the user does not re-enter dates or redownload completed days.
- Agent/model: Codex, GPT-5.
- Test result: `npm test` passed 39/39; `npm run build` passed; server restarted with the new build and health/diagnostics endpoints responded.
- Errors/unresolved: UW full-tape downloads can still fail for provider/network reasons; those errors remain visible and saved rows are preserved. Unsupported signal families are not queried.
- Next step: use the UI’s `Resume missing Call/Put data` action when coverage shows failed/interrupted days; then review the standardized comparison table.

Final goal check: This makes historical signal data reusable and prevents wasted downloads, directly supporting reliable cross-signal backtesting after costs. The project remains breadth-first; no profitability claim is made.

- Date and time: 2026-08-19 01:48 UTC
- Step completed: Added cooperative event-loop yields during full-tape row ingestion so diagnostics and cancellation remain responsive during very large files.
- Files changed: `src/providers/historical-backfill.ts`, `ui/main.tsx`, generated `dist/` and `dist-ui/`.
- Decision made and reason: Yield every 1,000 processed rows; this preserves synchronous SQLite correctness while allowing the HTTP server to report progress and accept Stop.
- Agent name and model: Codex, GPT-5.
- Test result: Server TypeScript build and UI build passed; server restarted and `/api/health` returned ready/connected.
- Errors or unresolved items: Provider/network failures still require a later resume; they do not invalidate rows already committed.
- Next step: Start the resume action from the UI when ready, then let the coverage and outcome panels complete.

- Date and time: 2026-08-19 01:49 UTC
- Step completed: Changed the existing Unusual Whales diagnostics monitor from every 5 minutes to every 30 minutes.
- Files inspected or changed: Codex automation `unusual-whales-backfill-monitor`; no application source changes.
- Decision made and reason: A 30-minute health check is sufficient and avoids unnecessary background polling while preserving stall/failure visibility.
- Agent name and model: Codex, GPT-5.
- Test result: Automation update confirmed by the Codex app.
- Errors or unresolved items: None.
- Next step: Monitor only every 30 minutes unless the user requests a different cadence.

- Date and time: 2026-08-19 01:50 UTC
- Step completed: Normalized stale weekend coverage failures during historical resume.
- Files inspected or changed: `src/providers/historical-backfill.ts`.
- Decision made and reason: 2026-08-09 was Sunday; old provider 422 rows are now marked as skipped market-closed dates instead of remaining visible as failures.
- Agent name and model: Codex, GPT-5.
- Test result: `npm test` passed 39/39; source/build verified. Running fetch was not restarted.
- Errors or unresolved items: The current run may still display the old Sunday error until it finishes; the genuine Call `fetch failed` remains a retryable provider/network error.
- Next step: Let the current run finish; use Resume after it completes. Restart only when no fetch is active to load this normalization into the running server.

- Date and time: 2026-08-19 01:57 UTC
- Step completed: Prevented overlapping diagnostics requests in the UI.
- Files inspected or changed: `ui/main.tsx`, generated `dist-ui/`.
- Decision made and reason: Use a single in-flight guard, poll active downloads every 5 seconds, and poll persisted status every 15 seconds; queued requests were making the browser appear stuck.
- Agent name and model: Codex, GPT-5.
- Test result: `npm run build:ui` passed.
- Errors or unresolved items: Existing browser tabs must refresh once to load the new UI bundle.
- Next step: Refresh the application; diagnostics should show at most one pending request at a time.

- Date and time: 2026-08-19 02:00 UTC
- Step completed: Added explicit historical activity diagnostics for the provider-request phase.
- Files inspected or changed: `src/diagnostics.ts`, `ui/main.tsx`, generated `dist/` and `dist-ui/`.
- Decision made and reason: Show `requesting_provider_file` before a full-tape response has bytes, rather than presenting an empty active day.
- Agent name and model: Codex, GPT-5.
- Test result: `npm run build` passed.
- Errors or unresolved items: The running download must finish before restarting the server to load the new diagnostics field; existing saved rows are unaffected.
- Next step: After the current operation finishes, restart once and refresh the UI; the provider-wait phase will be explicit.

- Date and time: 2026-08-19 02:03 UTC
- Step completed: Diagnosed and stopped a server-blocking full-tape operation.
- Files inspected or changed: Runtime diagnostics; no data tables deleted. Server process restarted.
- Decision made and reason: Diagnostics and comparison requests were blocked by synchronous full-tape parsing; stop the stuck process to restore control and preserve committed rows.
- Agent name and model: Codex, GPT-5.
- Test result: `/api/health` and `/api/diagnostics` returned successfully after restart.
- Errors or unresolved items: The current backfill was interrupted; a worker-process backfill is still needed for fully responsive unattended downloads.
- Next step: Move historical backfill work off the HTTP server event loop before starting another long-range fetch.

- Date and time: 2026-08-19 02:06 UTC
- Step completed: Made ZIP transfer visibility explicit in the UI and diagnostics.
- Files inspected or changed: `src/diagnostics.ts`, `ui/main.tsx`, generated `dist/` and `dist-ui/`.
- Decision made and reason: Show provider-wait state, compressed bytes received/expected when available, provider-size-unavailable state, matched rows, and last progress update.
- Agent name and model: Codex, GPT-5.
- Test result: `npm run build` passed; server restarted successfully and health returned ready.
- Errors or unresolved items: Full-tape processing can still block diagnostics; a worker-process architecture remains the durable fix.
- Next step: Refresh the UI before the next fetch; do not start another multi-hour run until the worker isolation fix is implemented.

- Date and time: 2026-08-19 02:10 UTC
- Step completed: Added exact historical request visibility to diagnostics and the UI.
- Files inspected or changed: `src/diagnostics.ts`, `ui/main.tsx`, generated `dist/` and `dist-ui/`.
- Decision made and reason: Display request URL/date, provider-wait versus download phase, bytes received/expected, row counts, and progress timestamps instead of only a generic download label.
- Agent name and model: Codex, GPT-5.
- Test result: `npm run build` passed; server health and diagnostics returned successfully after restart.
- Errors or unresolved items: A separate worker is still needed to prevent very large CSV parsing from blocking all HTTP responses.
- Next step: Refresh the browser; the next run will expose the exact provider request and transfer state.

- Date and time: 2026-08-19 02:14 UTC
- Step completed: Removed misleading all-time failure messages from the active download panel and added an explicit diagnostics-unavailable warning.
- Files inspected or changed: `ui/main.tsx`, generated `dist-ui/`.
- Decision made and reason: Never label old coverage errors as current failures; if diagnostics cannot be reached, say that the current request is unverified.
- Agent name and model: Codex, GPT-5.
- Test result: `npm run build` passed; server health returned ready after restart.
- Errors or unresolved items: Worker isolation is still required to prevent diagnostics from becoming unavailable during large-file processing.
- Next step: Refresh the browser; start another fetch only when ready to monitor the new explicit state.

- Date and time: 2026-08-19 02:17 UTC
- Step completed: Confirmed and stopped another day-0 backfill that blocked diagnostics for more than one minute.
- Files inspected or changed: Runtime diagnostics; no saved data removed. Server restarted.
- Decision made and reason: Do not let a non-reporting full-tape request run unattended; preserve existing rows and restore API control.
- Agent name and model: Codex, GPT-5.
- Test result: `/api/health` returned ready after restart.
- Errors or unresolved items: Worker isolation is now a prerequisite for trustworthy unattended historical fetching.
- Next step: Implement the backfill worker before any further long-range download.

- Date and time: 2026-08-19 02:21 UTC
- Step completed: Moved historical backfill execution into a worker thread with responsive API diagnostics and cancellation.
- Files inspected or changed: `src/scripts/backfill-worker.ts`, `src/scripts/server.ts`, `ui/main.tsx`, generated `dist/` and `dist-ui/`.
- Decision made and reason: The HTTP server now launches a worker and returns `202 processing`; the worker owns ZIP parsing, database writes, outcome refresh, and operation completion, while the API remains free to report exact progress.
- Agent name and model: Codex, GPT-5.
- Test result: `npm test` passed 39/39; invalid worker launch returned a recorded validation failure while diagnostics stayed responsive.
- Errors or unresolved items: A real multi-day provider fetch has not been started after worker isolation; provider/network errors remain possible and are recorded.
- Next step: Refresh the UI and start one backfill; monitor the worker’s request URL, phase, bytes, rows, and errors before leaving it unattended.

Final goal check: Worker isolation directly enables trustworthy historical collection for later cross-signal outcome comparison without hiding stalled requests. The project remains breadth-first and makes no profitability claim.

- Date and time: 2026-08-19 02:39 UTC
- Step completed: Added persisted worker phase telemetry for historical backfills.
- Files inspected or changed: `src/diagnostics.ts`, `src/scripts/backfill-worker.ts`, `ui/main.tsx`, generated `dist/` and `dist-ui/`.
- Decision made and reason: The UI now reports whether the worker is fetching historical files, refreshing market prices, or calculating outcomes, even when no provider request is open; this prevents a legitimate post-download phase from looking like a stalled download.
- Agent name and model: Codex, GPT-5.
- Test result: `npm test` passed 39/39.
- Errors or unresolved items: The currently persisted operation began before this telemetry change and still has no phase detail; it should not be trusted as proof of progress.
- Next step: Restart the API with the rebuilt server, then run a short one-day backfill and verify phase changes and provider errors in the UI.

Final goal check: This improves transparent, auditable historical collection needed for broad signal comparison; it does not add strategy logic or profitability claims.

- Date and time: 2026-08-19 02:42 UTC
- Step completed: Restarted the API with the rebuilt worker telemetry and confirmed health.
- Files inspected or changed: `dist/` runtime; no database rows deleted.
- Decision made and reason: The previous operation had no phase telemetry and was interrupted so the new status model can be used cleanly.
- Agent name and model: Codex, GPT-5.
- Test result: `/api/health` returned ready with the SQLite database connected.
- Errors or unresolved items: No new backfill has been started after the restart.
- Next step: Start a short one-day backfill; confirm the UI reports provider request, bytes, and post-download outcome stages before extending the range.

- Date and time: 2026-08-19 05:09 UTC
- Step completed: Added fine-grained progress counters for market-price refresh and outcome calculation.
- Files inspected or changed: `src/providers/market-data.ts`, `src/research/outcomes.ts`, `src/scripts/backfill-worker.ts`, `ui/main.tsx`, generated `dist/` and `dist-ui/`.
- Decision made and reason: Worker telemetry now persists completed/total units and latest symbol/timeframe, so the UI can show percentage and counts instead of only “calculating outcomes.”
- Agent name and model: Codex, GPT-5.
- Test result: `npm test` passed 39/39; API restarted and `/api/health` returned ready.
- Errors or unresolved items: Existing historical operation was already interrupted; the new counters appear on the next backfill.
- Next step: Run a short backfill and verify the counters advance in the UI and `/api/diagnostics`.

- Date and time: 2026-08-19 05:13 UTC
- Step completed: Added adaptive time-remaining estimates to worker progress.
- Files inspected or changed: `src/scripts/backfill-worker.ts`, `ui/main.tsx`, generated `dist/` and `dist-ui/`.
- Decision made and reason: ETA is calculated from the current phase's observed completion rate, with an estimating state until progress exists; it adapts as the rate changes.
- Agent name and model: Codex, GPT-5.
- Test result: `npm test` passed 39/39; API restarted and `/api/health` returned ready.
- Errors or unresolved items: ETA is unavailable during provider waiting or before the first completed unit; it is an estimate, not a guarantee.
- Next step: Observe the next backfill and confirm ETA changes as counters advance.

- Date and time: 2026-08-19 05:16 UTC
- Step completed: Added bounded automatic retry and restart recovery for historical backfills.
- Files inspected or changed: `src/scripts/server.ts`, `ui/main.tsx`, generated `dist/` and `dist-ui/`.
- Decision made and reason: Worker/provider failures retry up to three times with 5s/10s/20s backoff; a server restart can recover the interrupted request once within the retry budget. Each retry is a new operation and is visible in diagnostics/UI; saved days remain skipped.
- Agent name and model: Codex, GPT-5.
- Test result: `npm test` passed 39/39; API restarted and `/api/health` returned ready.
- Errors or unresolved items: Automatic retry cannot overcome a persistent provider/API-key outage after three attempts; manual resume remains available.
- Next step: Run a short backfill and verify retry notices only appear on a real transient failure.

- Date and time: 2026-08-19 05:20 UTC
- Step completed: Corrected retry metadata persistence and stale-progress rendering.
- Files inspected or changed: `src/diagnostics.ts`, `ui/main.tsx`, generated `dist/` and `dist-ui/`.
- Decision made and reason: Operation detail updates now merge instead of replacing the original range/signal parameters, enabling restart recovery; the UI only shows worker phase/progress while the operation is actually processing.
- Agent name and model: Codex, GPT-5.
- Test result: `npm test` passed 39/39; API restarted and `/api/health` returned ready.
- Errors or unresolved items: A previous operation’s stale 45,000-row progress is no longer evidence of current activity and will not be shown as a live stage.
- Next step: Start a new short backfill and verify automatic retry/recovery behavior with live diagnostics.

- Date and time: 2026-08-20 04:40 UTC
- Step completed: Stopped the blocked calculation/server and added durable outcome checkpoints.
- Files inspected or changed: `src/db/client.ts`, `src/research/outcomes.ts`, generated `dist/` and `dist-ui/`.
- Decision made and reason: Outcome processing now checkpoints the sorted event cursor every 200 trades, commits outcome writes in the same batch, and resumes after interruption without restarting the full scan; already-written rows remain persistent and idempotent.
- Agent name and model: Codex, GPT-5.
- Test result: `npm test` passed 41/41, including outcome batch-boundary persistence tests; remaining backend process was stopped.
- Errors or unresolved items: The previous run’s checkpoint may not exist because it started before this change; its saved outcome rows remain valid, but the first checkpointed run should establish the cursor.
- Next step: Start the rebuilt server only when ready, then run/resume the backfill; verify checkpoint progress before leaving it unattended.

- Date and time: 2026-08-20 05:00 UTC
- Step completed: Restarted the backend and triggered the resumable Call/Put backfill remotely.
- Files inspected or changed: Runtime only; operation 39 started with range 2026-07-19 through 2026-08-14.
- Decision made and reason: Used `/api/signals/backfill/resume`, preserving saved signal data and invoking checkpoint-aware outcome processing.
- Agent name and model: Codex, GPT-5.
- Test result: `/api/health` returned ready and resume returned HTTP 202 with `operationId: 39`.
- Errors or unresolved items: Diagnostics became temporarily unresponsive while the worker acquired SQLite write locks; this is a known concurrency limitation still requiring the cached-summary/read-isolation follow-up.
- Next step: Leave the worker running; after calculation completes, verify diagnostics and comparison responses.

- Date and time: 2026-08-20 05:08 UTC
- Step completed: Began stopped-state production migration with PostgreSQL/Redis Compose services, job/checkpoint/snapshot schema, and BullMQ/pg queue client.
- Files inspected or changed: `docker-compose.yml`, `infra/postgres/001_core.sql`, `infra/README.md`, `src/infra/production-queue.ts`, `package.json`, `package-lock.json`.
- Decision made and reason: Keep the API, worker, and containers stopped until migration validation; SQLite remains untouched as the source of truth.
- Agent name and model: Codex, GPT-5.
- Test result: `npm test` passed 41/41 with the new dependencies and checkpoint code compiled.
- Errors or unresolved items: API/worker are intentionally offline; the queue is not wired into request routes and no data migration has run yet.
- Next step: Implement and validate the SQLite-to-PostgreSQL migration and queue-backed worker before restarting the application.

- Date and time: 2026-08-20 05:20 UTC
- Step completed: Started the SQLite-to-PostgreSQL migration after fixing PostgreSQL-array-to-JSON conversion.
- Files inspected or changed: `infra/postgres/002_research.sql`, `scripts/migrate-sqlite-to-postgres.mjs`.
- Decision made and reason: Migration runs detached in resumable `ON CONFLICT DO NOTHING` batches while the API/worker remain offline; current progress is written to `migration.log`.
- Agent name and model: Codex, GPT-5.
- Test result: PostgreSQL/Redis containers healthy; migration reached 318,000 option trades; `npm test` passed 41/41.
- Errors or unresolved items: Full copy of approximately 3.5M option trades and outcome rows is still running; the application has not been restarted.
- Next step: Let migration finish, validate PostgreSQL row counts against SQLite, then wire and test the queue-backed API before restart.

- Date and time: 2026-08-20 04:55 UTC
- Step completed: Fixed the dashboard-appears-stuck-behind-outcome-calculation problem the user diagnosed (SQLite write contention + a live, uncached aggregation on the hot `/api/signals/comparison` read path).
- Files inspected or changed: `src/db/client.ts` (added `PRAGMA busy_timeout = 5000`, added a new `uw_comparison_cache` table, schema_version 7->8 -- the new table needs no special migration since `CREATE TABLE IF NOT EXISTS` is naturally idempotent, unlike the earlier ALTER-COLUMN case); `src/research/outcomes.ts` (`refreshOutcomes` now batches its writes into transactions of 200 trades instead of leaving every one of up to millions of outcome rows as its own autocommit transaction, with rollback-on-error safety); `src/research/comparison.ts` (new `refreshComparisonCache`, `readCachedComparison`, `peekCachedComparison`); `src/scripts/server.ts` (`/api/signals/comparison` now serves the cached row instead of recomputing live; added a guarded `warmComparisonCache()` that launches a background worker rather than ever blocking the main thread); new `src/scripts/comparison-cache-worker.ts` (one-shot worker, same pattern as the existing `backfill-worker.ts`); `tests/database.test.ts`, `tests/diagnostics.test.ts` (schema version bump, busy_timeout assertion, new table assertion), `tests/outcomes.test.ts` (250-trade cross-batch-boundary correctness test), `tests/comparison.test.ts` (cache staleness/refresh test).
- Decision made and reason: Diagnosed three distinct, compounding causes rather than accepting the user's summary at face value -- confirmed by reading the actual code, not by assumption. (1) No `busy_timeout` was set on any connection, so any transient WAL lock contention between the worker's writer connection and the main thread's reader connection threw `SQLITE_BUSY` immediately instead of waiting briefly and retrying. (2) `refreshOutcomes` had zero transaction batching -- on the live database this is up to ~3.5M trades x 5 horizons = ~17.5M individual autocommit writes, each briefly taking the WAL write lock. (3) `/api/signals/comparison` recomputed its full cross-signal aggregation live on every request; measured against the real production data (17,538,615 outcome rows) this took 71.8 seconds cold. Caching decouples the read path entirely from write activity, which is the user's own proposed fix ("cached summaries or a read-only snapshot"); busy_timeout and write batching are defense in depth for cases the cache doesn't cover (e.g. two writers). A real gap was caught mid-implementation: a naive cache-miss fallback to a live compute would have reproduced the exact same 71-second hang on every restart, since the cache table starts empty. Fixed by adding a background warm-up worker (mirroring the existing `backfill-worker.ts` pattern) so a cold cache is reported honestly instead of blocking the request, and by refreshing the cache once at every startup.
- Test result: `npm test` passes 41/41 (up from 39). Live-verified against the real production database (not just synthetic fixtures): gracefully-interrupted the currently-running server (WAL-safe; confirmed zero data loss -- option-trade count identical before/after, 3,507,755), restarted with the fix, and observed: (a) the pre-existing cache row served in 33ms immediately after restart even though the underlying tables are large; (b) `/api/health` responded in 1.7ms while the background warm-up worker was actively recomputing the full 17.5M-row aggregation on a separate thread; (c) the cache correctly updated to a fresh timestamp ~75 seconds later once that background computation finished. This is the exact scenario reported (dashboard read racing a heavy write) reproduced and fixed live, not just unit-tested.
- Errors or unresolved items: Restarting the server to load the fix consumed the historical-backfill operation's last automatic retry slot (it was already on `retryAttempt: 3` of `MAX_BACKFILL_RETRIES: 3` before I touched anything, from prior failures); it is now marked `failed` with no further auto-retry, same as any other restart under the existing design -- a manual "Resume" click will pick it up again using the fixed code. The batched-write path in `refreshOutcomes` has strong targeted unit coverage (a 250-trade test spanning the transaction-batch boundary) but was not separately re-exercised against a live multi-million-row write in this session, since the live verification focused on the reported read-side symptom; the write path itself is unchanged in its per-row logic, only in transaction grouping. Also noted but out of scope: `refreshOutcomes` always recomputes every eligible trade from scratch (no incremental/delta logic), which is a separate, real performance opportunity given the live database already has one outcome row per trade per horizon for all 3.5M trades.
- Agent name and model: Claude Code, Sonnet 5
- Final Goal Check: the final goal is determining whether Unusual Whales data contains repeatable, backtestable signals that could make money. This fix doesn't change any signal or outcome logic, but it removes a real reliability failure (the dashboard becoming unusable during normal, expected write activity) that would otherwise make the comparison screen untrustworthy exactly when there's the most new data to look at. The project remains on track; this was infrastructure work protecting the credibility of the eventual research conclusions, not a shortcut toward one.
- Next step: Use "Resume" in the UI to restart the interrupted Call/Put backfill under the fixed code; watch `/api/signals/comparison` stay responsive throughout instead of appearing stuck.
- Date and time: 2026-08-20 05:38 UTC
- Step completed: Verified progress tracking configuration and cleared a stale Git index lock.
- Files inspected or changed: `.gitignore`, `progress.md`.
- Decision made and reason: `progress.md` was not ignored; staged both files so project progress can be tracked. No commit was created.
- Agent name and model: Codex, GPT-5.
- Test result: Confirmed `progress.md` and `.gitignore` are staged (`A`); no active Git process was present and the stale lock was from 2026-08-17.
- Errors or unresolved items: Changes are staged locally but not committed or pushed.
- Next step: Commit these project-tracking files when the repository owner is ready.

- Date and time: 2026-08-20 05:10 UTC
- Step completed: Reviewed Codex's checkpoint-based incremental resume added to `refreshOutcomes` (src/research/outcomes.ts, new `uw_outcome_checkpoints` table). Review only -- no code changed.
- Files inspected or changed: Read-only review of `src/research/outcomes.ts`, `src/db/client.ts`, `src/scripts/server.ts`, `src/scripts/backfill-worker.ts`, `tests/outcomes.test.ts`. Wrote and ran throwaway reproduction scripts against the real compiled `dist/` module and a direct read-only connection to the production `.data/unusual-whales.sqlite` (no test files or scratch scripts added to the project).
- Decision made and reason: Found two correctness bugs and confirmed both empirically (not just by inspection) against the actual shipped code: (1) the resume query's positional cursor silently skips any newly-backfilled trade that sorts before the checkpoint -- reproduced: a trade inserted after a checkpoint, dated earlier than the cursor, got zero outcome rows and is invisible to every downstream metric; live DB currently shows 0 such gaps (not yet triggered) but is directly reachable via the UI's own "resume missing days" feature. (2) The in-memory `previous` map used to exclude overlapping events resets to empty on every call, but a resumed run never re-sees pre-checkpoint events on the same key -- reproduced: a trade that a single uninterrupted run correctly excludes as `overlapping_event` was instead counted as a fully independent, usable outcome when the identical scenario was split across a checkpoint boundary. This directly contradicts the project's own "non-overlapping event" methodology that the comparison dashboard advertises. Neither bug has any test coverage. Most urgent: the live production database currently holds an ACTIVE checkpoint (AMD, 122,600/3,507,723, updated 2026-08-20T05:04:17Z) that will expose bug #2 on the very next call to `refreshOutcomes` (any regular sync or backfill completion).
- Test result: Two throwaway reproduction scripts (not added to the test suite) both confirmed the bugs against the real `dist/` build. `withFullSet` check against production data: 3,507,723 / 3,507,723 eligible trades currently have all 5 horizons -- no existing gaps from bug #1 yet, but the live stuck checkpoint means bug #2 is one sync away from firing on real data.
- Errors or unresolved items: Not fixed yet -- this was a review at the user's request, not an authorized fix. Recommended direction (not implemented): replace the positional cursor with a content-based "does this trade already have all 5 horizons" check (robust to out-of-order backfills), and seed the overlap-detection map from already-persisted outcome rows at the start of a resumed call instead of starting empty. Immediate low-risk mitigation available: clearing the current stuck checkpoint would force the next run to do a full, correct pass (at the cost of reprocessing time) rather than resuming into the known-bad path.
- Agent name and model: Claude Code, Sonnet 5
- Final Goal Check: the final goal is determining whether Unusual Whales data contains repeatable, backtestable signals that could make money. An unreviewed silent-corruption bug in the outcome-calculation layer would directly undermine that goal by making the independent-event counts and returns feeding the comparison dashboard untrustworthy without any visible sign of it. Surfacing this before it spreads further into the live dataset is squarely in service of the project's goal, not a detour from it.
- Date and time: 2026-08-20 06:14 UTC
- Step completed: Fixed checkpoint resume correctness for historical outcomes.
- Files inspected or changed: `src/research/outcomes.ts`, `tests/outcomes.test.ts`.
- Decision made and reason: Checkpoints now report progress only; every pass rebuilds the full ordered event stream so out-of-order imports cannot be skipped and overlap state survives restarts. Independent-event state now advances on each independent representative event.
- Agent name and model: Codex, GPT-5.
- Test result: `npm test` passed 43/43, including new out-of-order and resume-boundary overlap regressions.
- Errors or unresolved items: Existing derived outcomes created by the old logic must be rebuilt after migration before research results are trusted. API/worker remain stopped while migration runs.
- Next step: Finish PostgreSQL migration, validate counts, then run one clean deterministic outcome rebuild.
- Date and time: 2026-08-20 18:43 UTC
- Step completed: Completed SQLite-to-PostgreSQL migration validation and started the corrected deterministic outcome rebuild.
- Files inspected or changed: `scripts/rebuild-outcomes.mjs`, `outcome-rebuild.log`, `outcome-rebuild-error.log`.
- Decision made and reason: Raw and derived PostgreSQL row counts match SQLite exactly; the API/worker remain offline while all outcome rows are rewritten using the fixed out-of-order and overlap-safe implementation.
- Agent name and model: Codex, GPT-5.
- Test result: Final counts match: imports 76, option trades 3,507,755, dark pool 4,100, market bars 58,209, outcomes 17,538,615. Rebuild started and reached 230,000 / 3,507,723 trades without errors.
- Errors or unresolved items: The clean rebuild is still running; PostgreSQL API/worker cutover is not yet wired.
- Next step: Let the rebuild finish, verify outcome counts/metrics, then complete the PostgreSQL-backed service cutover.
- Date and time: 2026-08-20 19:19 UTC
- Step completed: Replaced PostgreSQL outcome rows with the corrected rebuild, validated all migrated row counts, and started the application server.
- Files inspected or changed: `scripts/replace-postgres-outcomes.mjs`, `replace-outcomes.log`, `server-runtime.log`.
- Decision made and reason: The corrected derived results are now in PostgreSQL and the application is available for review; API and worker were kept offline during the copy and rebuild.
- Agent name and model: Codex, GPT-5.
- Test result: SQLite and PostgreSQL counts match exactly for all five tables; `/api/health` returns ready/connected at `http://localhost:4273`.
- Errors or unresolved items: The current server still reads the SQLite database; full PostgreSQL service cutover remains a later architecture task. Research results are corrected and available now.
- Next step: Open the application and review the comparison/diagnostics results, then complete Postgres-backed request/worker wiring before production deployment.
2026-08-20: Step 0 audit found and fixed a real outcome-matching defect: a daily horizon whose calendar target fell before the next trading session could reuse the same daily bar for entry and outcome, producing false zero returns. Outcome lookup now requires the outcome bar to be strictly after the entry bar; added regression coverage. `npm test` passes 44/44. Persisted historical outcomes must be rebuilt next.
2026-08-20: Completed Step 0 audit and correction. Rebuilt all 17,538,615 SQLite outcome rows with strict post-entry outcome matching, copied all 17,538,615 corrected rows into PostgreSQL, and validated SQLite/PostgreSQL counts (total 17,538,615; usable 127,246; +1d usable 19,139). Restarted the API and refreshed the comparison cache. Put Sweep short-horizon metrics now show non-zero movement (for example +5m direction-adjusted win rate ~79.36%, not the prior artificial 100% zero-return result). Remaining: PostgreSQL is not yet the live API store; signal breadth adapters remain unavailable.
2026-08-20: Started Step 1 (PostgreSQL cutover). Added a single database-backend configuration/status boundary and exposed it through `/api/health`; tests now prove SQLite remains the explicit live backend and PostgreSQL cannot be silently selected. Rebuilt and restarted the server; health reports `configured: sqlite`, `postgresConfigured: false`, `cutoverReady: false`. This is intentionally transparent: the PostgreSQL copy is validated, but live research queries have not been switched yet.
2026-08-20: Continued Step 1. Added bounded PostgreSQL readiness probing (`SELECT 1`) to the shared backend status and `/api/health`; deliberately avoided full-table counts in the hot health path after validating that counting 17.5M outcomes could block requests. `npm test` passes 46/46. Restarted server and verified `127.0.0.1:4273/api/health` reports SQLite as the live backend and PostgreSQL reachable, with cutover still explicitly false.
2026-08-20: Implemented the first real PostgreSQL research read path without changing the plan: `UNUSUAL_WHALES_DB_BACKEND=postgres` now routes `/api/signals/comparison` through PostgreSQL using grouped outcome statistics, direction-aware wins, SPY excess, medians, costs, coverage, and leader selection. Verified against the validated PostgreSQL copy; health confirms PostgreSQL reachable. The full cutover remains in progress because ingestion, diagnostics, backfill workers, and other API routes still use SQLite until their repositories are migrated.

## 2026-08-20 — PostgreSQL ingestion write boundary (parallel Step 1 work)
- Added src/db/postgres-ingestion.ts: transactional, idempotent PostgreSQL option-trade writer preserving raw JSON, validation arrays, batch metadata, and source IDs; schema bootstrap adds ID sequences/defaults for post-migration inserts.
- Provider option types now accept an optional postgresPool without changing SQLite default; exports provide repository access for call/put ingestion wiring during cutover.
- Verification:
pm test passed 46/46. PostgreSQL is not switched on by this change.

2026-08-20: Parallel Step 1 operations persistence boundary implemented in src/diagnostics.ts. Added PostgreSQL uw_job_runs operation lifecycle (start/update/finish/restart-failure), historical coverage byte/row progress persistence, and job-scoped outcome checkpoints. Added two focused tests; npm test passes 48/48. No live backend switch or server integration performed.

## 2026-08-20 — PostgreSQL cutover integration batch
- Added explicit PostgreSQL-only live call/put sync path; no SQLite mixing when UNUSUAL_WHALES_DB_BACKEND=postgres.
- Added PostgreSQL diagnostics summary and explicit 501 for historical backfill/resume until native worker is implemented.
- Verified npm test: 48/48 passing; server build succeeds.
- Remaining: historical backfill, market refresh, outcome refresh, and operation/job persistence must be moved to PostgreSQL before declaring full cutover.

## HANDOFF SNAPSHOT — 2026-08-20

### Verified completed
- Corrected outcome matching: outcome bar must be strictly after entry bar; regression test added.
- Rebuilt and validated 17,538,615 outcome rows; SQLite and PostgreSQL counts match.
- PostgreSQL comparison read path works when `UNUSUAL_WHALES_DB_BACKEND=postgres`.
- PostgreSQL readiness is exposed through `/api/health` using a bounded `SELECT 1` check.
- PostgreSQL recent Call/Put sync path exists and avoids SQLite mixing in postgres mode.
- PostgreSQL operation/progress/checkpoint helper boundary exists (`uw_job_runs`, coverage, checkpoints).
- Historical adapter registry covers all 10 catalog signals. Call/Put/Dark Pool are available; other sources are explicitly unsupported with no fake network calls.
- Full current test suite: `npm test` passes 51/51.

### Current truth (do not overstate)
- SQLite remains the default backend.
- PostgreSQL is not yet the complete live backend.
- Historical backfill/resume in postgres mode returns explicit HTTP 501 until a native PostgreSQL worker is implemented.
- PostgreSQL market-bar writes and PostgreSQL outcome calculation writes are not yet wired.
- Do not claim broad signal profitability; unsupported sources remain unavailable.

### Remaining implementation plan, in order
1. **Native PostgreSQL historical worker**
   - Stream Call/Put/Dark Pool historical data into PostgreSQL.
   - Persist import batches and coverage per day with idempotent keys.
   - Add retry, cancellation, and fine-grained byte/row progress in `uw_job_runs`.
2. **PostgreSQL market-data repository**
   - Store 1m/1d bars in `uw_market_bars`.
   - Preserve Yahoo timing/coverage limitations and failures.
3. **PostgreSQL outcome engine**
   - Calculate outcomes from PostgreSQL trades/bars.
   - Persist every `(trade_id, horizon)` row transactionally.
   - Use strict post-entry matching, non-overlap rules, maturity checks, SPY excess, and costs.
   - Resume from PostgreSQL checkpoints without duplicating rows.
4. **Complete backend cutover**
   - Wire server, workers, diagnostics, sync, backfill, market refresh, outcomes, and comparison to one PostgreSQL service.
   - Make PostgreSQL the default only after end-to-end validation.
5. **Breadth-first historical execution**
   - Run simple comparable tests for Call Sweeps, Put Sweeps, Repeated Sweeps, Dark Pool, Flow Imbalance, OI, GEX, ETF flow, Insider, and Congress.
   - Keep unavailable/insufficient sources visibly marked; never fabricate rows.
6. **Automatic comparison and winner rules**
   - Select leaders only with mature +1d data, minimum N, cost treatment, and explicit warnings.
   - Never declare a tradable strategy from in-sample descriptive results.
7. **Out-of-sample validation**
   - Freeze an untouched time period.
   - Validate only previously selected signal definitions/groups.
   - Report in-sample vs out-of-sample, costs, coverage, and limitations.
8. **Final UI/reliability verification**
   - Show active backend, exact request/response status, progress, retries, errors, saved rows, and remaining work.
   - Verify restart/resume/cancel behavior and no duplicate jobs.

### Handoff command/checks
- Run `npm test` first; expected current result is 51/51.
- Check `GET http://127.0.0.1:4273/api/health`.
- Check `GET http://127.0.0.1:4273/api/diagnostics`.
- Check `GET http://127.0.0.1:4273/api/signals/comparison`.
- Keep `UNUSUAL_WHALES_DB_BACKEND=sqlite` unless the new PostgreSQL worker/repositories have passed end-to-end validation.

## 2026-08-20 — Parallel PostgreSQL cutover implementation and integration

- Completed parallel implementation tracks for the native PostgreSQL historical worker, PostgreSQL market-bar repository, PostgreSQL outcome engine, UI reliability surface, and cutover audit.
- Wired PostgreSQL mode in `src/scripts/server.ts` for recent sync, historical backfill/resume/cancel, market refresh, outcome refresh, durable job diagnostics, and asynchronous worker execution. SQLite remains the default and is unchanged for legacy mode.
- Corrected PostgreSQL comparison coverage so `independentEvents` and `matureEvents` come from measured outcome classifications rather than usable-outcome counts.
- Added `UNUSUAL_WHALES_DB_BACKEND` and `POSTGRES_URL` documentation to `.env.example`.
- Verification: `npm test` passes 56/56; server build and UI production build pass. Isolated server startup on port 4373 succeeded. HTTP smoke requests from a separate PowerShell process did not return reliably in the desktop sandbox, so no live endpoint smoke result is claimed.
- Current truth: PostgreSQL historical → market → outcome code paths are now wired, but PostgreSQL has not been promoted to the default and no live end-to-end PostgreSQL service run was completed in this pass. Keep `UNUSUAL_WHALES_DB_BACKEND=sqlite` until that validation is performed.
- Next step: run the PostgreSQL Docker service and a fixture-backed end-to-end backfill/sync → bars → outcomes → diagnostics → cancel/resume validation; then decide whether the backend is ready for explicit production use.

## 2026-08-20 — Stable plan execution: Steps 1–5 complete

- Adopted one fixed six-step plan and stopped opening new Codex chats. Delegation, when used, remains background sub-agent work inside the current task.
- Step 1 complete: live PostgreSQL fixture E2E passed for historical ZIP/CSV import, market bars, outcomes, comparison, diagnostics, cancellation, and resume. Live PostgreSQL route integration passed 5/5 sequential checks.
- Step 2 complete: fixed repeat-run coverage contamination in the E2E fixture and added scoped PostgreSQL outcome replay for fixture symbols so validation does not scan unrelated multi-million-row history.
- Step 3 complete: added `npm run validate:oos -- <frozen-config.json>`, OOS documentation, example configurations, and bounded SQLite event loading with maximum-horizon overlap lookback.
- Step 4 complete: truthful breadth inventory confirms measured Call Sweeps and Put Sweeps; Dark Pool is imported but not price-matched; Repeated Sweeps, Flow Imbalance, OI, GEX, ETF Flow, Insider, and Congress remain unavailable.
- Step 5 complete: winner rules require minimum 30 usable outcomes, mature +1d evidence, and non-negative estimated 25 bps/side net return. Frozen current-data +1d OOS validation ran for Call and Put Sweeps; both holdouts were insufficient, so no OOS winner or profitability claim is made.
- Verification: full suite passes 68/68 with 4 live PostgreSQL tests skipped by default; live E2E and route tests pass when explicitly enabled. Server/UI builds pass.
- Current step: Step 6 final UI/restart/resume/cancel verification and final report packaging. PostgreSQL remains opt-in; SQLite remains the default.

## 2026-08-20 — Six-step plan complete

- Step 6 complete: guarded SQLite-only restart recovery, added durable PostgreSQL active-job rejection to prevent duplicate historical backfills, and verified live cancel/resume and diagnostics behavior.
- Final verification: `npm test` passes 68/68; live PostgreSQL E2E plus route integration passes 6/6 with `--test-concurrency=1`; server and UI builds pass.
- Added `docs/BACKTEST_FINAL_REPORT.md` with system readiness, breadth counts, winner rules, frozen OOS result, and explicit limitations.
- Final conclusion: the system is usable for Unusual Whales research/backtesting. Current evidence does not establish a profitable tradable strategy: the frozen +1d holdout was insufficient for both Call and Put Sweeps, and unsupported signal families remain excluded.

## 2026-08-20 — PostgreSQL market-data repository/write path
- Added `src/db/postgres-market-data.ts` with transactional, idempotent upserts into `uw_market_bars` keyed by `(symbol,timeframe,observed_at)` and sequence/default bootstrap for new PostgreSQL rows.
- Added `refreshMarketPricesPostgres` in `src/providers/market-data.ts`; it reuses Yahoo 1m/1d fetch/normalization, timing limits, invalid-bar filtering, progress callbacks, and explicit per-symbol/timeframe failures.
- Added focused PostgreSQL writer tests; `npm test` passes 53/53.
- SQLite behavior is unchanged. Server, workers, outcome engine, UI, and full PostgreSQL cutover remain intentionally unwired.

## 2026-08-20 — Follow-up: consolidate active backfill progress UI

- User reports that the active backfill alternates between the detailed byte-progress panel and the compact historical-status panel. This is confusing and makes persisted `put_sweep: fetch failed` history look like a current failure while a Call Sweeps file is still downloading.
- Do not interrupt or restart the active historical download to address this UI issue. The current run is costly and must be allowed to finish first.
- After completion, consolidate the UI into one authoritative active-job panel: current stage/day, byte progress, saved/completed days, remaining work, and errors clearly separated into current versus historical.
- Verify that polling does not alternate between stale summary and live progress payloads.
- Persistence expectation: imported rows and completed per-day coverage are durable; restart recovery reuses the saved range and skips completed days. An interrupted in-flight full-tape day may be downloaded again, but the completed historical range should not be repeated.

## 2026-08-21 — Signal expansion validation

- Audited the unavailable signal families before implementation. The official Unusual Whales documentation exposes options flow, open-interest state, GEX, and filing/flow messages through the streaming topics, but the streaming feed retains only 72 hours. That is insufficient for the completed multi-week historical backtest range.
- Implemented Flow Imbalance as a clearly labeled derived adapter from the completed Call/Put Sweep history: 30-minute mixed windows, normalized premium imbalance, deterministic IDs, persisted coverage, outcomes, comparison metrics, and focused tests. It is sweep-only and is not the provider market-tide feed.
- Do not enable Open Interest Spikes, GEX/Gamma, Market/ETF Flow, Insider Activity, or Congress Activity as historical adapters until a durable historical source/export is verified.
- Current Call Sweeps, Put Sweeps, and Dark Pool history remain unchanged. The unavailable status is currently the truthful and safe result; implementing these six against live-only data would create look-ahead or incomplete-history risk.
- Next expansion requirement: obtain a historical endpoint/export or persist the live stream going forward, then add one adapter at a time with point-in-time tests and a bounded validation run.

## 2026-08-21 — REST breadth expansion

- Preserved the completed Call/Put/Dark Pool history; no expensive full-tape download was restarted.
- Added `uw_signal_events` for non-trade observations with `event_at`, `published_at`, `observable_at`, symbol, outcome symbol, prediction mode, score, raw payload, and validation errors.
- Implemented date-scoped historical adapters for Open Interest Change and Market/ETF Tide with durable per-day coverage, idempotent source IDs, and separate import batches.
- The comparison API now reports both as `candidate` with truthful raw coverage and an explicit remaining limitation: price-outcome matching is not yet wired for the separate event store.
- Verification: 69 tests passed, 4 skipped; server and UI builds pass.
- Next: connect generic events to market-bar outcomes, then add Spot GEX through the same point-in-time path. Insider/Congress remain gated on exact public-availability semantics.

## 2026-08-21 — Generic event outcomes and Dark Pool integration

- Added `uw_signal_event_outcomes` and a generic point-in-time outcome engine for non-trade events. It enforces observable-time entry, horizon maturity, overlap exclusion, SPY-relative returns, and explicit missing-price reasons.
- Materialized the existing 4,100 Dark Pool rows into the generic event model without re-downloading them.
- Live Dark Pool coverage now reports 4,100 raw events, 2,644 independent events, 635 mature events, 349 tickers, and 0 usable price outcomes. The remaining zero is a price-coverage limitation, not missing Dark Pool data.
- Full verification remains green: 69 passed, 4 skipped, 0 failed; server/UI builds pass.

## 2026-08-21 — OI and Market/ETF outcome pass

- Completed a bounded REST backfill for 2026-07-19 through 2026-08-19 without touching the full-tape Call/Put history.
- Imported 4,400 Open Interest events and 27,529 Market/ETF Flow events. Importing is idempotent and date-aware.
- Fixed a generic-event persistence defect discovered during the run: the insert binding omitted `signal_type`; the malformed rows were ignored by SQLite and no provider data was lost. The corrected retry inserted all 31,929 events.
- Calculated generic outcomes and refreshed the live comparison cache.
- Current measured coverage: OI has 4,400 raw, 2,059 independent, 1,961 mature, and 1,795 usable +1d outcomes. Market/ETF Flow has 27,529 raw, 66 independent, 66 mature, and 63 usable +1d outcomes. Both remain `candidate`; these are descriptive results, not profitability claims.
- Verification: 69 tests passed, 4 skipped, 0 failed; server and UI builds pass.

## 2026-08-21 — Dark Pool price-coverage pass

- Diagnosed the previous Dark Pool `0 usable` state: many ticker daily bars and early SPY daily bars were missing, while the Dark Pool events themselves were present.
- Added a targeted generic-event market refresh that fetches only daily bars for the selected signal symbols plus SPY; it does not refresh the full option universe.
- Refreshed 349 symbols and inserted 8,328 daily bars. One Yahoo symbol (`BRKB`) returned HTTP 404 and remains explicitly recorded as a failure.
- Recalculated Dark Pool outcomes. Live coverage now reports 4,100 raw events, 1,187 independent, 1,184 mature, and 1,184 usable +1d outcomes across 349 tickers.
- Descriptive +1d result: 41.2% win rate, +0.24% average return, +1.08% average SPY-relative excess return before estimated costs. At 25 bps/side, the estimated average return is -0.26%; this is not an OOS claim.
- Verification: 69 tests passed, 4 skipped, 0 failed; server/UI builds pass.

## 2026-08-21 — Coverage UI clarity pass

- Added an always-visible coverage legend above the comparison table: raw provider events, independent events, mature events, and usable price outcomes are now explicitly distinguished.
- This addresses the misleading visual interpretation where Dark Pool showed `0 / 0` even though raw events existed; the two prominent columns are now explained as independent and mature outcome samples.
- No data, downloads, or backfill behavior changed.
- Verification: 69 tests passed, 4 skipped, 0 failed; server and UI builds pass.

## 2026-08-21 — Insider and Congress filing pass

- Verified the official filing fields and timing semantics: insider records expose `filing_date` and `transaction_date`; congressional records expose `filed_at_date` and `transaction_date`.
- Added historical adapters for both sources. Events enter the backtest at filing/disclosure time, not transaction time, preventing look-ahead bias.
- Ingested the bounded 2026-07-19 through 2026-08-19 window: 9,433 Insider events and 4,425 Congress events, with no provider errors.
- Calculated outcomes using existing market bars. Insider coverage: 2,085 usable +1d outcomes across 1,806 tickers. Congress coverage: 109 usable +1d outcomes across 98 tickers.
- Descriptive +1d results: Insider +0.29% average return / 51.2% win rate; Congress +0.48% / 56.9% win rate. These remain candidate, sparse, and not OOS profitability claims.
- Verification: 69 tests passed, 4 skipped, 0 failed; server/UI builds pass.

## 2026-08-21 — Spot GEX pass

- Added the official Spot GEX historical adapter using `/api/stock/{ticker}/spot-exposures`.
- Classified GEX as a volatility/regime signal and used `gamma_per_one_percent_move_oi` as its signed score.
- Backfilled the top 50 liquid symbols over 2026-07-19 through 2026-08-19: 541,956 observations, 0 duplicates, 0 provider errors.
- Applied the catalog rule of using the first GEX observation per symbol/day for outcome calculation, producing 5,390 controlled event-outcome rows.
- Live comparison now reports GEX as a candidate with 541,956 raw events, 777 independent events, 755 mature events, and 722 usable +1d outcomes across 49 tickers.
- Descriptive +1d result: 52.8% win rate and +0.31% average return before estimated costs. This is not an OOS or profitability claim.
- Verification: 69 tests passed, 4 skipped, 0 failed; server and UI builds pass.

## 2026-08-21 — Generic-family OOS validation pass

- Added the frozen generic-family OOS configuration at `docs/examples/oos-config-generic-2026-08.json` for Dark Pool, OI, Market/ETF, GEX, Insider, and Congress.
- The read-only validation completed successfully for the 2026-07-20 to 2026-08-01 in-sample window and the untouched 2026-08-08 to 2026-08-19 holdout, with a seven-day embargo and maturity frozen at 2026-08-21.
- Holdout results are descriptive only: Congress +1d had 60 usable outcomes and +1.03% average return; Dark Pool +1d had 330 usable and -0.03%; GEX +3d had 91 usable and +2.64%; Insider +1d had 821 usable and +0.12%; OI +1d had 442 usable and -0.34%; Market/ETF had only 18 usable +1d outcomes and remains insufficient. These are exploratory OOS measurements, not a tradable-profitability claim.
- The all-family OOS configuration correctly exposed a separate scaling issue: loading roughly 6.5 million Call/Put/Flow option events into one in-memory validation array exceeded Node's heap. This did not modify the database or interrupt any download. The next engineering step is a streaming/chunked option-event validator; the generic-family validator is already usable.
- Verification after the validator change: 69 tests passed, 4 skipped, 0 failed; server/UI builds pass.

## 2026-08-21 — Full all-family OOS validator completed

- Replaced the database-backed OOS loader with signal-by-signal, horizon-by-horizon SQLite cursor processing. The validator no longer creates a multi-million-row JavaScript array, so the complete frozen configuration runs within bounded memory.
- Full configuration `docs/examples/oos-config-all-2026-08.json` completed successfully across Call Sweeps, Put Sweeps, Flow Imbalance, Dark Pool, OI, Market/ETF, GEX, Insider, and Congress.
- Holdout examples: Call Sweeps +1d produced 4,050 usable outcomes and +1.16% average return before costs; Put Sweeps +1d produced 3,186 usable outcomes and -1.37%; GEX +3d produced 91 usable and +2.64%; OI +1d produced 442 usable and -0.34%. Results remain frozen exploratory evidence, not an automatically tradable strategy.
- The previous heap failure is resolved without changing the database, historical files, or backfill state.
- Verification: full OOS run completed; `npm test` passes 69/69 with 4 live PostgreSQL tests skipped by default; server/UI builds pass.

## 2026-08-21 — Unified backfill progress UI

- Consolidated the active and persisted historical-backfill states so only one progress panel can render while a job is processing. Polling can no longer alternate between the detailed byte panel and the compact historical-status panel.
- A processing job remains in the live panel even if the client briefly loses its local `backfilling` flag; the persisted worker status is now authoritative.
- Renamed the error display to “Recorded failures in this backfill” so an earlier failed day is not presented as proof that the current provider request failed.
- Updated the final report with current signal breadth and full OOS validation results.
- Verification: 69 tests passed, 4 skipped, 0 failed; server/UI builds pass; diff check is clean.

## 2026-08-21 — Longer horizons and forward-stream foundation

- Extended the canonical outcome set with `+5d`, `+10d`, and `+20d` across SQLite, PostgreSQL, generic event outcomes, OOS validation, comparison responses, and the UI selector.
- These horizons currently use daily market bars and calendar maturity windows. Trading-session-specific target selection is the next refinement before treating the labels as exact “five/ten/twenty sessions.”
- Added durable `uw_stream_events` storage and an idempotent persistence boundary for future Kafka/WebSocket messages. Stream data is kept separate from historical events so the 72-hour provider retention window cannot contaminate the historical backtest.
- Verification: 70 tests passed, 4 skipped, 0 failed; server/UI builds pass.

## 2026-08-21 — Session targets and option feature layer

- Long daily horizons now choose the Nth future daily market bar for `+1d`, `+3d`, `+5d`, `+10d`, and `+20d` instead of simply selecting the first bar after a calendar timestamp. This is implemented in SQLite, generic-event outcomes, and PostgreSQL outcome matching.
- Added `uw_option_features` and a deterministic feature refresh that extracts volume/OI ratio, bid/ask spread, price-side score, moneyness, DTE, opening-trade evidence, and provider IV/delta/gamma/vega when present in raw payloads.
- Added `uw_stream_events` plus idempotent persistence for forward Kafka/WebSocket messages. Transport wiring remains separate because provider stream credentials and connection configuration are deployment-specific.
- Verification: 71 tests passed, 4 skipped, 0 failed; server/UI builds pass.

## 2026-08-21 — Risk-aware OOS metrics

- Extended frozen OOS metrics with return standard deviation, cumulative maximum drawdown, and profit factor alongside average return, win rate, excess return, and cost scenarios.
- These measures are descriptive risk diagnostics only; they do not change candidate-selection rules or imply a portfolio recommendation.
- Verification: 71 tests passed, 4 skipped, 0 failed; server/UI builds pass.

## 2026-08-21 — Feature and stream API/UI exposure

- Added `GET /api/research/stream/status` for forward-capture configuration, message counts, topic counts, and latest capture time.
- Added asynchronous `POST /api/research/option-features/refresh`; it runs in a worker and records durable operation status instead of blocking the API during a large feature rebuild.
- Added a dashboard infrastructure panel showing stream readiness and a feature-refresh control.
- Documented both endpoints in the project README.
- Verification: 71 tests passed, 4 skipped, 0 failed; server/UI builds pass.

## 2026-08-21 — Walk-forward validation and final integration pass

- Added frozen, sequential walk-forward windows with a selection fingerprint so each holdout keeps the signal set and methodology chosen before that holdout.
- Added the production SQLite runner and `npm run validate:walk-forward -- <config>` command. It reuses the bounded-memory OOS cursor instead of loading the option universe into one in-memory array.
- Executed `docs/examples/walk-forward-config-2026-08.json` successfully across Call Sweeps, Put Sweeps, and Dark Pool Blocks for `+1d`, `+3d`, `+5d`, `+10d`, and `+20d`, with 10/25/50 bps-per-side cost scenarios.
- The run produced descriptive holdout metrics where matured outcomes exist. Longer horizons correctly remain `insufficient` where the database does not yet contain enough future daily sessions; this is a data-coverage state, not a failed calculation.
- Verification: 76 test cases, 72 passed, 4 skipped, 0 failed; production walk-forward run exited successfully; server/UI builds pass.
