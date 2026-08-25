# Tasks: Pattern Discovery Rule Evidence

**Input**: [spec.md](spec.md), [plan.md](plan.md)

## Phase 1 — Shared contracts and table capability

- [x] T001 Export/reuse the existing `weightCategoryForFeature` mapping through `crypto/src/copytrade/decisionCategories.ts` without changing promotion logic.
- [x] T002 Reuse the shared `crypto/ui/components/DataTable.tsx` with opt-in table-local sorting/filtering controls, preserving existing callers.
- [x] T003 [P] Add requested report field types and legacy-safe presentation strings to `crypto/ui/strings.ts` and the UI type surface.

## Phase 2 — Evidence table

- [x] T004 Create `crypto/ui/components/PatternDiscoveryRuleEvidence.tsx` using the shared DataTable, existing category helper, current report fields, and explicit missing-value fallbacks.
- [x] T005 Add all requested evidence columns, status/stability/promotion distinctions, positive/negative effect styling, and concise legend copy.
- [x] T006 Wire row clicks from the evidence component to the existing `PatternDiscoveryRuleDialog` selection in `crypto/ui/main.tsx`.

## Phase 3 — Verification and handoff

- [x] T007 Run the relevant Pattern Discovery tests and confirm legacy parser behavior remains intact; UI behavior is covered by the successful browser build.
- [x] T008 Run UI build, full tests, and `npm run arch:check`; all passed.
- [x] T009 Review the diff and append implementation, test results, errors, and next step to `crypto/progress.md`.
