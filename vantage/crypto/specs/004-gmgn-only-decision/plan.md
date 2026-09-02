# Implementation Plan: GMGN-only Decision Engine

1. Inventory current Decision Lab Dune dependencies, Wallet Data route/state, and Pattern
   Research controls before moving UI code.
2. Update `experimentalDecision.ts` so component scores, evidence, and candidacy are GMGN-only;
   retain Dune simulation only as optional diagnostics.
3. Update tests for GMGN median edge, GMGN copyability, non-Dune evidence, and the new candidacy
   rule.
4. Move roster import and GMGN refresh controls into Decision Lab and Dune controls into Pattern
   Research; remove the Wallet Data tab and default to Decision Lab.
5. Add Pattern Research discovery staleness presentation without adding a new scheduler.
6. Run build, full tests, `npm run arch:check`, and browser smoke checks. Append results to
   `progress.md`.

## Amendment plan: remove experimental Decision Lab mode

1. Remove the Decision Lab mode selector/state and stop sending `winnerPolicyMode`.
2. Remove server validation/branching and the report adaptation helper; keep authoritative
   evaluation as the sole response path.
3. Remove the unused shared mode type/branch and update API documentation and tests.
4. Run focused tests, full build, and architecture checks; verify no active references remain.

## Amendment plan: Winner Policy v2.1 wallet maturity

1. Verify `created_at_ts` is normalized from GMGN `common.created_at` and is distinct from local
   `fetched_at`.
2. Add a shared point-in-time wallet-age penalty and evidence field to Winner Policy v2, preserving
   existing proof gates and Dune profitability scores.
3. Supply wallet age from both Decision Lab and Live Evaluation using each evaluator's timestamp
   and effective period; expose the deduction in existing score breakdowns.
4. Add boundary tests for 7 days, half-period, period length, missing age, and parity across tabs.
