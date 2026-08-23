# Graph Report - unusualwhales  (2026-08-20)

## Corpus Check
- 71 files · ~53,277 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 568 nodes · 927 edges · 32 communities (21 shown, 11 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 27 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `61e7894d`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- main.tsx
- outcomes.ts
- put-sweeps.ts
- postgres-historical-backfill.ts
- Progress Log
- historical-backfill.ts
- server.ts
- historical-adapters.ts
- scripts
- Unusual Whales signal discovery: Phase 1 plan
- research/postgres-outcomes.ts
- devDependencies
- market-data.ts
- compilerOptions
- compilerOptions
- Unusual Whales Research
- production-queue.ts
- Parallel implementation plan: real Phase 1 results
- migrate-sqlite-to-postgres.mjs
- replace-postgres-outcomes.mjs
- AGENTS.md
- rebuild-outcomes.mjs
- .agents/README.md
- BREADTH_FIRST_SIGNAL_INVENTORY.md
- docs/README.md
- extension/README.md
- infra/README.md
- prompts/README.md
- research/README.md
- providers/README.md
- fixtures/README.md

## God Nodes (most connected - your core abstractions)
1. `server` - 29 edges
2. `Progress Log` - 28 edges
3. `runPostgresHistoricalWorker()` - 26 edges
4. `backfillHistoricalSignals()` - 19 edges
5. `App()` - 18 edges
6. `normalizeDarkPoolRecords()` - 15 edges
7. `readUnusualWhalesApiKey()` - 15 edges
8. `createDatabase()` - 13 edges
9. `refreshPostgresOutcomes()` - 13 edges
10. `compilerOptions` - 13 edges

## Surprising Connections (you probably didn't know these)
- `makeDb()` --calls--> `createDatabase()`  [EXTRACTED]
  tests/outcomes.test.ts → src/db/client.ts
- `collectRows()` --calls--> `streamFullTapeCsvRows()`  [EXTRACTED]
  tests/full-tape-csv.test.ts → src/providers/full-tape-csv.ts
- `server` --calls--> `startPostgresOperation()`  [EXTRACTED]
  src/scripts/server.ts → src/diagnostics.ts
- `server` --calls--> `finishPostgresOperation()`  [EXTRACTED]
  src/scripts/server.ts → src/diagnostics.ts
- `normalizeDarkPool()` --calls--> `normalizeDarkPoolRecords()`  [EXTRACTED]
  src/providers/historical-adapters.ts → src/providers/dark-pool.ts

## Import Cycles
- None detected.

## Communities (32 total, 11 thin omitted)

### Community 0 - "main.tsx"
Cohesion: 0.05
Nodes (61): ActiveHistoricalDay, ApiUnreachableError, App(), BackendInfo, BACKFILL_CATALOG, BACKFILL_LABEL, BackfillProgress, BackfillResult (+53 more)

### Community 1 - "outcomes.ts"
Cohesion: 0.06
Nodes (47): createDatabase(), defaultDatabasePath, HistoricalSignalType, integer(), jsonArray(), normalizedTimestamp(), RawRecord, readSignalDataSummary() (+39 more)

### Community 2 - "put-sweeps.ts"
Cohesion: 0.09
Nodes (26): PostgresImportBatch, PostgresIngestionRepository, PostgresOptionTradeInput, integer(), json(), Raw, SweepKind, syncRecentSweepsToPostgres() (+18 more)

### Community 3 - "postgres-historical-backfill.ts"
Cohesion: 0.10
Nodes (31): claimPostgresOperation(), CountRow, finishPostgresHistoricalCoverage(), finishPostgresOperation(), jsonObject(), OperationStatus, PostgresJobStatus, PostgresQueryResult (+23 more)

### Community 4 - "Progress Log"
Cohesion: 0.05
Nodes (38): 2026-08-18 — Automatic evidence summary, 2026-08-18 — Backend diagnostics and operational logging, 2026-08-18 — Backend outcomes track, 2026-08-18 — Backend price refresh and live verification, 2026-08-18 — Backfill cancellation and market-day guards, 2026-08-18 — Breadth-first signal comparison dashboard (UI), 2026-08-18 — Breadth-first signal inventory foundation, 2026-08-18 — Dark Pool adapter (+30 more)

### Community 5 - "historical-backfill.ts"
Cohesion: 0.09
Nodes (28): RFC-4180, FullTapeCsvRow, FullTapeStreamOptions, parsePostgresArrayLiteral(), splitCsvLine(), streamFullTapeCsvRows(), decodedBytes(), remainingEntryBytes() (+20 more)

### Community 6 - "server.ts"
Cohesion: 0.11
Nodes (27): checkPostgresReadiness(), configuredDatabaseBackend(), DatabaseBackend, databaseBackendStatus(), getPostgresPool(), postgresResearchPool(), cancelPostgresOperation(), count() (+19 more)

### Community 7 - "historical-adapters.ts"
Cohesion: 0.10
Nodes (26): booleanValue(), DarkPoolFetchOptions, DarkPoolFetchResult, DarkPoolRecord, fetchRecentDarkPool(), first(), normalizeDarkPoolRecords(), normalizedTimestamp() (+18 more)

### Community 8 - "scripts"
Cohesion: 0.07
Nodes (29): bullmq, ioredis, dependencies, bullmq, ioredis, pg, react, react-dom (+21 more)

### Community 9 - "Unusual Whales signal discovery: Phase 1 plan"
Cohesion: 0.07
Nodes (27): 1. What the existing projects teach us, 2. Context and current API evidence, 3. Smallest useful Phase 1, 4. Proposed Phase 1 data model, 5. Pipeline, 6. Statistical and research gates, 7. UI and output, 8. Required now / useful later / unnecessary complexity (+19 more)

### Community 10 - "research/postgres-outcomes.ts"
Cohesion: 0.12
Nodes (13): PostgresOutcomeBar, PostgresOutcomeCheckpoint, PostgresOutcomeRepository, PostgresOutcomeRow, PostgresOutcomeTrade, Queryable, Horizon, durations (+5 more)

### Community 11 - "devDependencies"
Cohesion: 0.11
Nodes (19): concurrently, devDependencies, concurrently, tsx, @types/node, @types/pg, @types/react, @types/react-dom (+11 more)

### Community 12 - "market-data.ts"
Cohesion: 0.18
Nodes (13): PostgresMarketDataRepository, PostgresMarketDataWriter, validBar(), fetchYahooBars(), MarketRefreshResult, normalizeYahooChart(), refreshMarketPrices(), refreshMarketPricesPostgres() (+5 more)

### Community 13 - "compilerOptions"
Cohesion: 0.11
Nodes (17): DOM, DOM.Iterable, ui/**/*.ts, ui/**/*.tsx, vite/client, compilerOptions, jsx, lib (+9 more)

### Community 14 - "compilerOptions"
Cohesion: 0.11
Nodes (17): src/**/*.ts, tests/**/*.ts, compilerOptions, declaration, forceConsistentCasingInFileNames, lib, module, moduleResolution (+9 more)

### Community 15 - "Unusual Whales Research"
Cohesion: 0.29
Nodes (6): API key, Current boundary, Project structure, Setup, Technology stack, Unusual Whales Research

### Community 16 - "production-queue.ts"
Cohesion: 0.29
Nodes (4): HistoricalJobPayload, historicalQueue, productionPostgres, redisConnection

### Community 17 - "Parallel implementation plan: real Phase 1 results"
Cohesion: 0.33
Nodes (5): Agent 1 — backend and outcomes, Agent 2 — final UI, Coordination boundary, Final outcome for this step, Parallel implementation plan: real Phase 1 results

### Community 18 - "migrate-sqlite-to-postgres.mjs"
Cohesion: 0.33
Nodes (3): pool, sqlite, tables

### Community 19 - "replace-postgres-outcomes.mjs"
Cohesion: 0.33
Nodes (4): columns, pool, sqlite, total

## Knowledge Gaps
- **253 isolated node(s):** `name`, `version`, `private`, `type`, `description` (+248 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **11 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `refreshPostgresOutcomes()` connect `research/postgres-outcomes.ts` to `postgres-historical-backfill.ts`, `server.ts`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **Why does `backfillHistoricalSignals()` connect `historical-backfill.ts` to `outcomes.ts`, `put-sweeps.ts`, `server.ts`, `historical-adapters.ts`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **Why does `normalizeDarkPoolRecords()` connect `historical-adapters.ts` to `postgres-historical-backfill.ts`, `historical-backfill.ts`?**
  _High betweenness centrality (0.012) - this node is a cross-community bridge._
- **Are the 5 inferred relationships involving `runPostgresHistoricalWorker()` (e.g. with `.beginBatch()` and `.ensureSchema()`) actually correct?**
  _`runPostgresHistoricalWorker()` has 5 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _253 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `main.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.050724637681159424 - nodes in this community are weakly interconnected._
- **Should `outcomes.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05734767025089606 - nodes in this community are weakly interconnected._