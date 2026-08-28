# Implementation Plan: Live Evaluation (GMGN-30d-only wallet estimate)

## Decided assumptions (spec leaves these open — recorded here, not invented mid-code)

- **Pass/Reject/Insufficient-Evidence cutoff**: requires `evidenceLevel === 'complete'` and a non-null `estimatedOverallScore`; then `>= 50` → `pass`, `< 50` → `reject` (50 is the existing neutral midpoint every component-score formula in `experimentalDecision.ts` already centers on). Anything else → `insufficient_evidence`.
- **Correlation-kind promoted rules can produce a bonus, not just a penalty** (Decision Lab's mechanism only ever subtracts). Mirrors the existing penalty formula exactly, sign-following: `100 * effect * percentileRank`, clamped so a component can't exceed 100.
- **Condition-evaluator scope**: model `threshold` (`>=`,`>`,`<=`,`<`) and `correlation` shapes generically for any promoted pattern on the GMGN-safe `prior_wallet_*` vocabulary not already claimed by the hyperactivity/fast-trading families. `bucket`/`lower`-`upper` and `information` (mutual-information) shapes go to `rulesUnavailable` (reason `condition-shape-not-modeled`) — no existing scoring convention for either anywhere in this codebase.
- **Reference population for correlation percentile-rank**: `computeCopyTradeReport(database, {periodDays:30, traderLimit:100}).rows` — the same population `computeHistoricalHyperactivityPenalty` already uses.

## Modules

### `src/copytrade/liveEvaluation.ts` (new)

`computeLiveEvaluation(database, walletAddress, options?): LiveEvaluationResult` — pure, synchronous, reads only `copytrade_trades` / `copytrade_wallet_stats` / `copytrade_wallets` (for `gmgn_tags`, optional) / `copytrade_report_cache`. No Dune import anywhere in this file. Never imports the comparison module (see Leakage guarantee below).

Reused unmodified (already exported): `robustnessScore`, `computeHistoricalHyperactivityPenalty`, `computeFastTradingPenalty`, `readExperimentalDecisionPromotedRules`, `readExperimentalDecisionWeighting`, type `ExperimentalDecisionPromotedRules` (`src/copytrade/experimentalDecision.ts`); `performanceByPeriod`, `computeProfitConcentration`, `holdSecondsPerSell`, `median`, `mean`, `RULES`, `STARTING_CAPITAL_USD` (`src/copytrade/scrutiny/evaluate.ts`); `readPatternDiscoveryDataFingerprint`, `readPatternDiscoveryCache`, `readLatestPatternDiscoveryCache`, `patternDiscoveryCacheKey`, `MAX_PATTERN_DISCOVERY_WALLETS` (`src/copytrade/discovery/patternDiscovery.ts`); `PATTERN_DISCOVERY_COVERAGE_THRESHOLDS` (`patternDiscoveryRunner.ts`); `weightCategoryForFeature` (`src/copytrade/decisionCategories.ts`).

Newly exported (add `export` only, zero behavior change; verified currently private): `clamp`, `positiveReturnScore`, `holdScore`, `consistencyScore` (`experimentalDecision.ts`); `readGmgnAggregate` (`evaluate.ts`); `HYPERACTIVITY_FEATURES`, `FAST_TRADING_FEATURE` (`experimentalDecision.ts`).

New functions:
1. `buildLiveGmgnWalletRow(database, walletAddress, {chain, periodDays})` — direct SQL for one address; does not use `computeCopyTradeReport` (roster-scoped, silently skips non-roster wallets).
2. `readCurrentWalletFeatures(database, walletAddress, {chain})` — **new export inside `patternDiscovery.ts`** (reuses the private `PreEventAccumulator` class, so it must live in that file). Same query as `readPreEventFeatures` minus the "strictly before" cutoff (all stored trades), skips `addTokenEntryContext`, calls `accumulator.snapshot('')`. Return type restricted to `prior_wallet_*` fields only.
3. `estimateHistoricalProfitabilityScore(medianReturnPercent)` — `positiveReturnScore` applied to the wallet's own realized GMGN median return. Labeled `historicalProfitability`, never "Edge".
4. `estimateGmgnCopyabilityScore(holdSeconds, fastTradingPenalty, hyperactivityPenalty)` — hold-time term only; `null` if `holdSeconds` is `null`. Does not touch `computeCopyabilityScore`.
5. `applyPromotedGmgnRules(promotedPatterns, walletFeatures, referenceRows)` — the generic evaluator (scope above); returns `rulesApplied` / `rulesUnavailable`.
6. `renormalizeWeights(baseWeights, availableCategories)` — `w / sum(available)`, `null` (never an equal split) if nothing is available.
7. `deriveLiveEvaluationVerdict(evidenceLevel, estimatedOverallScore)` — the cutoff above.
8. `parseLiveEvaluationRequest(payload)` — pure request validator using a newly-exported `SOL_ADDRESS_PATTERN`/`isSolWalletAddress` from `src/copytrade/screening/roster.ts`.

Orchestration wrapper (kept out of the pure compute path so scoring tests never touch it): `ensureLiveGmgnEvidence(database, walletAddress, options)` — freshness-checks `copytrade_wallet_stats.fetched_at` (same pattern as `statsFetch.ts`'s `isFresh()`), guards on `hasActiveFetchRun`, and on a miss `await runCopyTradeFetch(database, runId, {limit:1, periodDays:30, chain:'sol', walletAddresses:[walletAddress]})` directly (confirmed zero Dune references in `fetch.ts`; roster-independent via `walletAddresses`). A cold wallet's activity walk is rate-limited (~5s/request) and can take a while — v1 awaits it synchronously with a loading state; polling is a documented future improvement.

### `src/copytrade/liveEvaluationHistory.ts` (separate module — history boundary)

`recordEvaluationHistory` appends normalized Live or Decision Lab rows, `readEvaluationHistory`
returns them in insertion order, and `computeEvaluationTrend` compares only scores. Decision Lab
fields are mapped into the shared Live Evaluation component vocabulary. `liveEvaluation.ts` never
imports this module or `computeExperimentalDecisionReport`; the architecture rule preserves that
boundary.

### API — `POST /api/live-evaluation`

The route validates the address, computes from stored GMGN evidence, appends a Live history row,
attaches its trend, and responds 200. `GET /api/live-evaluation/history` returns the full ordered
timeline with each entry's trend. Automatic Live fetching remains out of scope.

### UI

`ui/types.ts` — add `'live-evaluation'` to `CopyTradeSubTab`. `ui/App.tsx` — extend the subtab whitelist, add one nav button, one render line, one import — same pattern as the other four subtabs. New `ui/components/LiveEvaluation.tsx`, self-contained (own `useState`, button-triggered POST via the existing `api<T>(url, init?)` helper, which already forwards to `fetch(url, init)`). New `liveEvaluation` string namespace in `ui/strings.ts`, including the exact required disclaimer text.

Renders: address input + Evaluate button; disclaimer banner; score and status strip; evaluation
history timeline with source, date, score, verdict, and score direction; positive/risk reasons;
30-day GMGN stats; and applied Pattern Discovery rules.

## Tests — new `tests/live-evaluation.test.ts`

Mirrors `tests/copytrade-experimental-decision.test.ts` (in-memory SQLite via `openDatabase(':memory:')`; seed a fake promoted profile via `writePatternDiscoveryCache`/`patternDiscoveryCacheKey`/`readPatternDiscoveryDataFingerprint`, no real Python engine invocation). No test in this repo exercises `server.ts`'s HTTP layer directly, so address validation (`parseLiveEvaluationRequest`) is unit-tested as a pure function, matching this codebase's actual convention.

Covers the acceptance scenarios from `spec.md`, including history persistence, first-entry behavior,
cross-source trend comparison, live-to-live comparison, no-Dune-call behavior, scoring rules,
missing/stale profiles, unsupported rules, malformed addresses, and determinism.

## Safety

`liveEvaluation.ts` never imports anything under `src/dune/`, never imports
`liveEvaluationHistory.ts`, and never reads a `decisionLab:*` cache key. Decision Lab's own module,
cache keys, and output are untouched. Missing/unavailable data is always surfaced through
`profileLoadStatus` / `evidenceLevel` / `rulesUnavailable`, never null-coalesced into a fabricated
default.

## Verification

`npx tsc -p tsconfig.json --noEmit`; `npx tsc -p tsconfig.ui.json --noEmit` (only the two pre-existing, already-documented errors permitted); `npm run arch:check` (including the new forbidden-import rule); `npm test` (full suite, no regressions); `npm run build:ui`; live check in the dev server against a cold wallet, an existing Decision-Lab wallet, and a malformed address; `git diff --check`; append the outcome to `progress.md`.

## Amendment — evaluation history replacement

The original side-by-side Decision Lab comparison is superseded by an append-only
`copytrade_evaluation_history` migration and `liveEvaluationHistory.ts`. Live Evaluation records
the current read-only result; the Decision Lab route records wallets only inside its genuine
recompute callback. The API and UI consume one insertion-ordered timeline and use only score
direction (`better`, `worse`, `unchanged`, or `unknown`) for trend display. Automatic Live fetch
behavior remains explicitly out of scope.
