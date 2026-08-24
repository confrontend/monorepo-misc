# Retrospective specification: CopyTrade research baseline

> Retrospective baseline. This records behavior already present in the code; it is not an
> authorization to redesign the product.

## Purpose

Describe the existing 30-day CopyTrade workflow so future changes can preserve provenance,
period scope, delayed-copy assumptions, and evidence gates.

## Current behavior

- A saved/imported GMGN roster defines the wallet scope.
- GMGN history and 30-day stats are persisted locally with fetch provenance and resumable status.
- Saved trades become delayed-copy Dune targets; Dune results are persisted per target and joined
  into shared round-trip evidence.
- The pure decision engine classifies evidence into the current 30-day verdict states.
- Scrutiny and Pattern Discovery consume saved evidence and do not silently fetch on page load.

## Invariants

- Provider fetches are explicit actions.
- A missing or stale required input cannot become a passing decision.
- Planner counts and decision coverage must not be treated as interchangeable metrics.
- Copy simulation uses the configured 15-second delay and five-minute match acceptance window.
- Changes to these invariants require tests and a progress entry.

## Acceptance evidence

- `src/copytrade/scrutiny/decisionEngine.ts`
- `src/copytrade/simulation/copySimulation.ts`
- `src/copytrade/simulation/copySimulationDune.ts`
- `src/scripts/server.ts`
- `tests/`
