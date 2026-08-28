# Tasks: Live Evaluation (GMGN-30d-only wallet estimate)

- [ ] T001 Add purely-additive exports (`clamp`, `positiveReturnScore`, `holdScore`, `consistencyScore`, `HYPERACTIVITY_FEATURES`, `FAST_TRADING_FEATURE` in `experimentalDecision.ts`; `readGmgnAggregate` in `evaluate.ts`; `SOL_ADDRESS_PATTERN`/`isSolWalletAddress` in `roster.ts`).
- [ ] T002 Add `readCurrentWalletFeatures` to `patternDiscovery.ts` (reuses `PreEventAccumulator`, restricted to `prior_wallet_*` fields).
- [ ] T003 Create `src/copytrade/liveEvaluation.ts`: `buildLiveGmgnWalletRow`, `estimateHistoricalProfitabilityScore`, `estimateGmgnCopyabilityScore`, `applyPromotedGmgnRules`, `renormalizeWeights`, `deriveLiveEvaluationVerdict`, `parseLiveEvaluationRequest`, `computeLiveEvaluation`, `ensureLiveGmgnEvidence`.
- [x] T004 Replaced the comparison module with `src/copytrade/liveEvaluationHistory.ts`: record/read history, compute trends, and normalize Decision Lab rows.
- [x] T005 Updated `.dependency-cruiser.cjs` to preserve the Live Evaluation boundary against the history module and Dune.
- [x] T006 Updated `POST /api/live-evaluation`, added `GET /api/live-evaluation/history`, and updated `src/apiCatalog.ts`.
- [x] T007 Reworked `tests/live-evaluation.test.ts` for history recording and trend behavior while preserving the scoring tests.
- [ ] T008 Add `'live-evaluation'` to `CopyTradeSubTab` (`ui/types.ts`) and wire the subtab in `ui/App.tsx` (whitelist, nav button, render line, import).
- [x] T009 Updated the `liveEvaluation` string namespace for the history timeline.
- [x] T010 Replaced the side-by-side comparison UI with a wallet evaluation-history timeline and retained score/details sections.
- [x] T011 Updated `docs/BROWNFIELD_SYSTEM_BASELINE.md` for the append-only history design.
- [x] T012 Ran build, architecture check, and full test suite successfully.
- [ ] T013 Live-check in the dev server: first evaluation, repeated evaluation, Decision Lab recomputation, and malformed address.
- [ ] T014 Append implementation and verification results to `progress.md`.
