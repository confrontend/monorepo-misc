# Implementation Plan: Centralized Evidence and Calculation Contracts

## Modules

- `src/copytrade/evidence/historicalEvidenceContext.ts`: pure point-in-time context and cutoff
  helpers.
- `src/copytrade/evidence/walletEvidenceSnapshot.ts`: explicit evidence namespaces and provenance.
- `src/copytrade/simulation/canonicalCopiedBuyOutcome.ts`: pure copied-buy aggregation and
  diagnostics.
- `src/copytrade/calculationVersions.ts`: version manifest for feature, score, outcome, and PIT
  policies.
- Existing consumers receive compatibility adapters or version metadata only where it can be
  added without changing their public behavior.

## Verification

- Unit tests for context boundaries, explicit namespace construction, aggregation edge cases, and
  version manifest stability.
- Existing server/UI builds and full Node test suite.
- `npm run arch:check` and `git diff --check`.
- Append implementation decisions and verification results to `progress.md`.

## Rollout

Implement the pure contracts first, then integrate only the highest-confidence consumers. Keep
legacy fields available until parity tests demonstrate that each downstream surface can migrate.
