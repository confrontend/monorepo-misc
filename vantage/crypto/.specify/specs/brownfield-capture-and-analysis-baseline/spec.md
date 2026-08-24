# Retrospective specification: Capture and analysis baseline

> Retrospective baseline. It separates implemented behavior from future research proposals.

## Current behavior

- GMGN browser capture and file imports normalize provider payloads and retain import/archive
  provenance in SQLite.
- Dune file imports and API measurements retain raw results and run status.
- Signal reports, integrity/quality diagnostics, Pattern Discovery, and Decision Lab are derived
  views over persisted local evidence.
- Pattern Discovery uses pre-event features, one row per original entry, wallet-balanced weighting,
  chronological validation, and the fixed 11-level coverage grid.
- Decision Lab adaptive weighting is experimental and only consumes promoted/stable discovery
  patterns; neutral 25/25/25/25 is an insufficient-evidence fallback.

## Not implied by this baseline

- No future feature, new provider, new score, or new fetch behavior is approved here.
- Historical proposals in `research/prompts` and prior `progress.md` entries must be reconciled
  against current code before implementation.

## Acceptance evidence

- `src/gmgn/capture/`
- `src/dune/`
- `src/copytrade/discovery/`
- `src/copytrade/experimentalDecision.ts`
- `research/shared-pattern-discovery/`
