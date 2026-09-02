# Feature Specification: Centralized Evidence and Calculation Contracts

**Feature Branch**: `005-centralized-evidence-calculations`
**Created**: 2026-08-30
**Status**: Approved for implementation

## Goal

Create one explicit, reviewable contract for point-in-time wallet evidence and shared
calculation provenance so Decision Lab, Live Evaluation, Pattern Discovery, exports, and
validation cannot silently mix current GMGN aggregates with historical local activity or
duplicate financial calculations.

## Invariants

- Existing score formulas and outcome semantics remain behavior-compatible unless a parity test
  identifies an existing defect; this change is primarily structural.
- Every historical calculation carries an explicit `asOf`, window, cutoff policy, source revision,
  and calculation-version manifest.
- Official GMGN aggregates, locally reconstructed activity features, and delayed-copy outcomes use
  distinct namespaces and provenance.
- Pure calculators do not read SQLite or call providers; database adapters remain at the edges.
- Missing, open, unmatched, and approximate evidence remains explicit and is never converted to a
  fabricated zero or silently treated as an exact value.
- Existing public API/UI behavior is preserved through compatibility adapters where migration is
  incremental.

## Scope

- Add a reusable historical evidence context and explicit wallet evidence snapshot types.
- Add one canonical pure copied-buy outcome aggregation contract for matched exit fragments,
  including diagnostics for missing/open/unmatched evidence.
- Add a calculation-version manifest and provenance helpers used by consumers and exports.
- Add parity and edge-case tests for cutoff handling, namespaces, aggregation, and provenance.
- Route existing consumers through the new contracts where safe without changing production
  Decision Lab, Pattern Discovery, or provider behavior.

## Non-goals

- No provider/API fetch changes, schema migration, UI redesign, or new scoring thresholds.
- No change to Dune matching or GMGN parsing semantics.
- No replacement of all existing response shapes in one release.

## Acceptance criteria

1. A single pure context builder defines the effective period, window start, exclusive cutoff,
   point-in-time inclusion rule, and source revision.
2. A wallet evidence snapshot makes `activity`, `officialGmgn`, `delayedCopy`, and `provenance`
   distinguishable in TypeScript.
3. The canonical copied-buy aggregator deterministically handles multiple exits, partial fills,
   missing buy cost, open positions, and unmatched fragments with diagnostics.
4. Calculation versions are centrally declared and attached to new/updated calculation results.
5. Existing behavior has parity tests and all existing builds/tests plus `arch:check` pass.
