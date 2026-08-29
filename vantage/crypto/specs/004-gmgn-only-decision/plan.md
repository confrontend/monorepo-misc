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
