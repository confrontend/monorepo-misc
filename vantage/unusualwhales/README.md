# Unusual Whales Research

This folder is the empty starting shell for an Unusual Whales research application. It mirrors the reusable engineering foundation of the sibling `seekingalpha` and `crypto` projects without copying their source-specific collectors, datasets, credentials, or analysis conclusions.

## Technology stack

- Node.js 22.5+ and strict TypeScript
- React 18 with Vite
- A local Node HTTP API
- SQLite through Node's built-in `node:sqlite` module
- Node's built-in test runner
- Local-first `.data/` and `.secrets/` directories, excluded from Git

## Project structure

```text
unusualwhales/
|-- .agents/        Future project-specific agent skills
|-- .claude/        Local launch configuration
|-- docs/           Architecture, source-contract, and handoff notes
|-- extension/      Optional browser-capture integration
|-- research/       Prespecified questions, experiments, and prompts
|-- src/
|   |-- db/         SQLite persistence
|   |-- models/     Shared domain types
|   |-- providers/  Source-specific adapters
|   `-- scripts/    API and command entry points
|-- tests/          Automated tests and fixtures
`-- ui/             React dashboard
```

## Setup

```bash
cd unusualwhales
npm install
npm test
npm run dev
```

The development command starts the API on `http://localhost:4273` and the Vite UI on `http://localhost:5273`.

Useful API routes:

- `GET /api/health` — basic process/database health.
- `GET /api/diagnostics` — read-only operational diagnostics: schema version, row counts, latest import, outcome exclusion reasons, validation-error counts, and recent sync operation status/details. It never returns credentials or raw API keys.
- `GET /api/signals/summary` — current Call Sweep coverage and horizon outcomes.
- `GET /api/signals/comparison` — breadth-first standardized rows for the catalog signal families.
- `GET /api/research/stream/status` — forward-only stream capture counts and latest capture time.
- `POST /api/research/option-features/refresh` — rebuild persisted option microstructure features.
- `POST /api/signals/sync` — ingest events, refresh prices, and recalculate outcomes; each run is recorded in diagnostics.

## API key

Create this local file and put only the Unusual Whales API key on one line:

```text
.secrets/unusualwhales/unusual-whales-api-key.txt
```

The `.secrets/` directory is Git-ignored. The provider reads this file server-side and exposes only sanitized credential status. Never put the key in React code, SQLite, logs, screenshots, or chat.

## Current boundary

No Unusual Whales page extraction, authenticated request, alert ingestion, options-flow schema, backtest, scoring model, or trading action is implemented. Those decisions should start with a documented source contract and a small redacted fixture.
