# Implementation Plan: Conservative GMGN Transfer Cost Basis

**Branch**: `007-gmgn-transfer-basis` | **Date**: 2026-09-06 | **Spec**: [spec.md](spec.md)

## Summary

Introduce one shared, chronological inventory resolver for GMGN buys, incoming transfers, and sells. Canonicalize transfer event names, request transfer events from the production history fetch, preserve raw provenance, and make all profitability consumers use known-cost inventory only. Unknown transfer-backed sell portions remain explicitly unproven and contribute no PnL.

## Technical Context

**Language/Version**: TypeScript, Node.js 22

**Primary Dependencies**: Node `node:sqlite`, existing GMGN CLI/client, Node test runner

**Storage**: Existing append-only SQLite `copytrade_trades`; additive provenance/canonical event fields only if required

**Testing**: `npm run build`, targeted `node --test dist/tests/*.test.js`, `npm run arch:check`

**Target Platform**: Local Node API and React UI

**Project Type**: Local-first web application

**Performance Goals**: No additional provider calls beyond the existing history walk; deterministic O(rows) accounting per wallet

**Constraints**: Never infer cost from a sell-level `buy_cost_usd` without a proven buy lot; preserve existing buy/sell results; transfer-in is caution only

**Scale/Scope**: Existing GMGN wallet history and Dune simulation flows; no Winner Policy threshold changes

## Constitution Check

- Shared business logic: one resolver reused by evaluator, feature snapshots, candidate screening, and copy simulation.
- Append-only persistence: no destructive migration; raw payloads remain intact.
- Test coverage: required five transfer scenarios plus regression buy/sell coverage.
- UI strings: no new user-facing copy required for the core fix.

## Design

1. Add a focused `transferInventory` domain module that normalizes event types and resolves chronological lots. Known buy lots carry cost; transfer lots carry unknown basis. A sell is split across lots; only known-basis portions can produce return observations. If any unknown portion is consumed, the sell carries an uncertainty flag.
2. Update `storeActivityPage` and the official GMGN fetch arguments to recognize transfer events while retaining the raw event string in `raw_payload`.
3. Replace duplicated sell-return checks in `evaluate.ts`, `walletFeatureEngine.ts`, and candidate scrutiny with resolver output. Keep copy simulation's unmatched-sell diagnostics and feed it the same resolved inventory.
4. Surface transfer and unknown-basis counts as evidence; do not add a rejection rule.
5. Add focused unit/integration tests for the five required scenarios and existing buy/sell parity.

## Project Structure

```text
src/copytrade/
├── accounting/transferInventory.ts   # shared event normalization and lot resolution
├── screening/fetch.ts                 # provider request and persistence boundary
├── scrutiny/evaluate.ts               # report metrics
├── features/walletFeatureEngine.ts   # feature metrics
└── simulation/copySimulation.ts      # delayed-copy lot pairing

tests/
├── transfer-inventory.test.ts
├── copytrade.test.ts
└── copytrade-copy-simulation.test.ts
```

**Structure Decision**: Keep the resolver in a focused domain module under `src/copytrade/accounting`; all consumers depend on it, and no UI or route owns accounting rules.

## Complexity Tracking

None. The change removes duplicated accounting decisions rather than adding a parallel workflow.
