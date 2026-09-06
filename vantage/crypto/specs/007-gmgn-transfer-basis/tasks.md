# Tasks: Conservative GMGN Transfer Cost Basis

## Phase 1 — Shared accounting

- [x] T001 Create `src/copytrade/accounting/transferInventory.ts` with event canonicalization and chronological known/unknown lot resolution.
- [x] T002 Add resolver result types for known-basis quantity, unknown-basis quantity, excluded reasons, and transfer caution counts.

## Phase 2 — Ingestion and consumers

- [x] T003 Update GMGN history request arguments to include transfer event types and preserve raw event spelling.
- [x] T004 Update persistence/import typing so canonical `transfer_in` is stored without rewriting raw payload provenance.
- [x] T005 Replace duplicated sell-return logic in `scrutiny/evaluate.ts`, `features/walletFeatureEngine.ts`, and `scrutiny/candidateScrutiny.ts` with the resolver.
- [x] T006 Make copy simulation consume the same resolver while retaining unmatched/uncertain diagnostics.
- [x] T007 Add neutral transfer and uncertain-basis evidence to screening and Winner Policy inputs without adding an automatic rejection.

## Phase 3 — Tests and verification

- [x] T008 Add normal buy→sell regression test.
- [x] T009 Add TX In→sell exclusion test.
- [x] T010 Add buy + TX In → sell conservative allocation test.
- [x] T011 Add partial transfer-in + partial sell test.
- [x] T012 Add TX In with no sell test.
- [x] T013 Run build, targeted tests, and `npm run arch:check`; append results to `progress.md`.
