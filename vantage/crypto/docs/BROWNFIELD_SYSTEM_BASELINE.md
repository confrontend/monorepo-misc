# Vantage Crypto — Brownfield System Baseline

Date: 2026-08-24

This document describes the system that exists in code today. It is a baseline for future
changes, not a product plan and not a claim that every historical `progress.md` proposal was
implemented.

## Scope and source of truth

The runtime source of truth is the TypeScript server, the SQLite schema/migrations, the shared
copy-trade/domain modules, and the React UI. `progress.md` is an append-only engineering log.
Research documents and Spec Kit artifacts are explanatory or prospective unless they explicitly
point to an implemented symbol and are confirmed by the code.

The system is local-first. Provider responses are fetched only from explicit fetch/import actions;
most page reads calculate views from SQLite. Raw provider payloads and archives are retained where
the relevant ingestion path supports provenance.

## Runtime topology

```text
GMGN browser/API capture ─┐
                          ├─> src/* ingestion/normalization ─> SQLite + archives
Dune API/import files ────┘                                  │
                                                             ├─> copy-trade reports
                                                             ├─> delayed-copy simulation
                                                             ├─> scrutiny/decision outputs
                                                             └─> Pattern Discovery export/Decision Lab
                                                                    │
                                                        src/scripts/server.ts HTTP API
                                                                    │
                                                        ui/main.tsx + ui/components
```

### Process and entry points

- `src/scripts/server.ts` is the Node HTTP entry point. It opens the database, reconciles stale
  runs, dispatches API routes, and serves the built UI.
- `ui/main.tsx` is the browser entry point. It selects the active hash-routed CopyTrade tab and
  calls the local API. Shared presentation primitives live under `ui/components`.
- `src/platform/db/client.ts` resolves `.data/crypto-research.sqlite`, creates the data directory,
  and applies migrations from `src/platform/db/schema.ts`.
- `src/platform/db/diagnostics.ts` records request-level diagnostics; archive helpers retain raw
  source provenance under `.data/archive`.

## Main data flows

### GMGN roster and wallet history

1. A roster is refreshed or imported through the `/api/copytrade/roster/*` routes.
2. `src/copytrade/screening/roster.ts` persists versioned roster snapshots and selected scope.
3. `src/copytrade/screening/fetch.ts` walks wallet activity pages, applies the GMGN request
   spacing, stores trades/stats, records per-wallet coverage and resumable fetch-run state.
4. `src/copytrade/screening/statsFetch.ts` stores 30-day wallet statistics.
5. `src/copytrade/simulation/copySimulation.ts` reads saved trades and builds the local report;
   it does not fetch Dune prices.

Important safety rules include explicit period scope, persisted run status, duplicate trade
identity, truncation/history-failure markers, and a 15-second copier-delay assumption. A page
reload reads the saved state; it does not make a provider request merely to render the table.

### Dune delayed-copy simulation

1. `src/copytrade/simulation/copySimulation.ts` derives eligible buy/sell targets and the delayed
   timestamps from saved GMGN trades.
2. `src/copytrade/simulation/copySimulationDune.ts` deduplicates identical token/time targets,
   plans batches, submits SQL, polls execution, and stores a result for every requested target,
   including explicit no-match results.
3. `src/copytrade/simulation/duneScheduler.ts` and the server routes manage resumability,
   cancellation, status, and reconciliation of late Dune results.
4. The simulation report joins persisted leg results into round trips and exposes coverage,
   copied return, cost, gas, hold-time, and liquidity-size-band proxy results.

The Dune result is a price-match proxy, not historical pool liquidity. `/api/copytrade/liquidity-impact`
is explicitly a trade-size/liquidity-impact proxy.

### Production 30-day decision

`src/copytrade/scrutiny/decisionEngine.ts` contains the pure shared 30-day verdict function.
`src/copytrade/scrutiny/evaluate.ts`, `candidateScrutiny.ts`, `historicalConsistency.ts`, and
`copyCandidates.ts` produce the evidence consumed by that decision. The server assembles saved
evidence; the UI renders it and explains the reason. Fetching, triage, and the final verdict are
separate responsibilities.

The current decision vocabulary is `Tested candidate`, `Watch`, `Needs data`,
`Historical / stale`, `Not copyable`, and `Historical screen failed`. Freshness is an exact
30-day evidence rule; it is not a generic “some stats were recently fetched” timestamp.

### Scrutiny

`src/copytrade/scrutiny/candidateScrutiny.ts` runs independent saved-evidence checks such as
dormancy, Dune coverage/bias, concentration, repeat-entry dependence, buy/sell behavior, and
related guardrails. The Scrutiny tab consumes the current CopyTrade roster and opens row detail
dialogs; it does not own a separate roster or provider-fetch pipeline.

### Pattern Discovery and Decision Lab

`src/copytrade/discovery/patternDiscovery.ts` is the read-only SQLite adapter. It creates a
point-in-time export with pre-event features, aggregates multiple exits into one original buy
entry, and records the selected coverage semantics. The isolated shared engine lives under
`research/shared-pattern-discovery` and is invoked by
`src/copytrade/discovery/patternDiscoveryRunner.ts`.

The production discovery run uses the fixed grid
`50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100` percent. Each level uses the same export,
discovery, chronological validation, wallet-balanced weighting, historical-stability checks,
and promotion logic. Report/export caching is in SQLite (`copytrade_report_cache`) and is keyed
by engine/version, period, threshold, run parameters, and a fingerprint of persisted evidence.

`src/copytrade/experimentalDecision.ts` is explicitly read-only and separate from the production
verdict. It uses only promoted/stable discovery patterns for adaptive weights; otherwise its
visible neutral state is `25/25/25/25` because evidence is insufficient. It must not silently
change production verdicts.

## Persistence and contracts

The migration history in `src/platform/db/schema.ts` is authoritative for tables and compatibility.
The major families are:

- source capture/import audit: `gmgn_signals`, browser-import batches/windows, Dune imports,
  diagnostics, archives;
- CopyTrade: wallets, trades, fetch runs, per-wallet coverage/events, wallet stats/events,
  roster provenance, report caches;
- Dune simulation: copy-simulation runs and target/match payloads;
- analysis: consistency, elimination, scrutiny inputs, Pattern Discovery and Decision Lab cache
  data.

The API catalog in `src/apiCatalog.ts` is the human-facing contract index. The live route behavior
is in `src/scripts/server.ts`; when the two differ, the route and tests are authoritative and the
catalog should be corrected.

## Business and safety rules currently encoded

- The decision horizon is 30 days.
- The default copier delay is 15 seconds.
- Dune matching uses the same five-minute acceptance/search window as the simulation.
- Dune leg coverage is distinct from fully matched round-trip coverage; the decision and table
  use the shared simulation evidence rather than planner-only submitted-leg counts.
- Missing, stale, truncated, failed, or insufficient evidence is not converted into a positive
  result or silently treated as zero.
- Multiple exits from one entry are collapsed for Pattern Discovery independence.
- Wallet-balanced discovery prevents high-volume wallets from dominating solely by row count.
- Pattern promotion requires validation and chronological historical stability across the fixed
  coverage grid.
- Provider secrets remain outside source control and are never written to progress logs.

## Known limitations and technical debt

- The UI still has a large orchestration surface in `ui/main.tsx`; shared components exist, but
  more state and route-specific presentation could be extracted incrementally.
- The Python test dependency is not available in every bundled runtime, so Python tests may be
  unavailable even when `py_compile` and Node tests pass.
- Existing historical reports and older research notes can describe superseded 7-day, 90-day,
  or fixed-threshold behavior. They are retained as history and must not override current code.
- Dune coverage is price-match evidence, not a guarantee that every real market event was
  observed; no-match and unqueried are intentionally separate states.
- Historical GMGN API/provider omissions, malformed rows, and provider-side incomplete history
  remain data-quality risks where the source does not expose an independent completeness count.
- `graphify-out` is generated knowledge-graph output and can lag the working tree; architecture
  conclusions must be checked against current source and `npm run arch:check`.

## Confirmed outstanding work

These are follow-up items, not silently implemented by this baseline:

- improve Python test/runtime provisioning so the shared discovery test suite runs consistently;
- continue reducing UI orchestration in small, behavior-preserving slices;
- keep API catalog examples synchronized with route changes;
- add/maintain tests when changing decision, simulation, coverage, or provenance rules;
- treat future Pattern Discovery changes as Spec Kit proposals first, then promote only after
  evidence and validation review.

## Verification performed for this baseline

- Graphify fast-path architecture query was run against `graphify-out/graph.json`.
- `npm run arch:check` passed: 96 modules and 267 dependencies, no violations.
- Current code and `progress.md` were traced for roster, simulation, scrutiny, discovery, and UI
  paths. Serena is configured in `.mcp.json`; this execution environment did not expose a
  callable Serena MCP server, so direct symbol tracing plus dependency-cruiser were used instead.
- No application runtime behavior was changed by this documentation task.
