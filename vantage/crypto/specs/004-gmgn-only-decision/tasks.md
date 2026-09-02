# Tasks: GMGN-only Decision Engine

- [x] T001 Inventory Decision Lab, Wallet Data, Pattern Research, and Dune call sites.
- [x] T002 Rewrite Decision Lab scoring and candidacy to GMGN-only behavior.
- [x] T003 Update domain tests for GMGN-only scoring and gates.
- [x] T004 Move roster/GMGN controls into Decision Lab.
- [x] T005 Move Dune controls and add Pattern Research staleness indicator.
- [x] T006 Remove Wallet Data navigation and update default routing.
- [x] T007 Run build, tests, architecture check, and browser smoke checks.

## Amendment tasks: authoritative-only Decision Lab

- [x] T008 Remove the Discovered Rules selector, request parameter, and response mode state.
- [x] T009 Remove server/report adaptation branches and shared Winner Policy mode code.
- [x] T010 Update tests and API catalog; verify no active Discovered Rules references remain.
- [x] T011 Run build, tests, and `npm run arch:check`.

## Amendment tasks: Winner Policy v2.1 wallet maturity

- [x] T012 Verify provider provenance for `copytrade_wallet_stats.created_at_ts`.
- [x] T013 Add shared wallet-age penalty and wire PIT-safe age signals into both evaluators.
- [x] T014 Add boundary/parity tests and update UI/API score breakdown types.
- [x] T015 Run build, full tests, and architecture checks.
