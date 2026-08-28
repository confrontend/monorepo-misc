# Implementation Plan: Pattern Discovery Rule Evidence

**Branch**: `001-pattern-rule-evidence` | **Date**: 2026-08-24 | **Spec**: [spec.md](spec.md)

## Summary

Add a focused evidence-table component to the existing strict Pattern Discovery report view. Extend the report presentation type only for fields already emitted by current and legacy reports, reuse the existing Decision Lab feature category mapping through a shared export, and enhance the shared DataTable with opt-in sortable/filterable behavior. Preserve the current rule dialog and row selection.

## Technical Context

**Language/Version**: TypeScript, React, existing crypto UI build
**Primary Dependencies**: Existing React UI components; no new dependencies
**Storage**: None; report payload remains unchanged
**Testing**: Existing Node test runner and UI build; architecture check
**Target Platform**: Existing local browser UI
**Project Type**: Local-first web application
**Constraints**: Legacy-safe optional fields; no new calculations or API calls; point-in-time and leakage behavior unchanged
**Scale/Scope**: One Pattern Discovery report section and shared table capability

## Constitution Check

- Evidence/provenance: PASS — values are read from the saved report and missing values remain missing.
- Shared decision logic: PASS — category mapping is exported from its existing implementation; no duplicate mapping.
- UI strings: PASS — new copy is added to `ui/strings.ts`.
- Architecture: PASS — focused UI component and existing DataTable are reused; run `npm run arch:check`.
- Brownfield baseline: PASS — current source, not retrospective specs, defines the report and category contracts.

## Design

### Existing contracts confirmed

- `ui/main.tsx` receives the report from the existing Pattern Discovery API response and owns the selected rule state.
- `src/copytrade/experimentalDecision.ts` owns `weightCategoryForFeature`, used by Decision Lab promotion; it will be exported without changing its behavior.
- `ui/components/PatternDiscoveryRuleDialog.tsx` already renders a selected rule and remains the detail surface.
- `ui/components/DataTable.tsx` is the shared table primitive and will gain opt-in sort/filter controls so existing callers are unaffected.
- Report fields observed in current artifacts include `effect`, `validation.effect_vs_all`, `discovery_sample_size`, `validation.sample_size`, `p_value`, `q_value`, `discovery_independence_groups`, `validation.independence_groups`, `historical_stability.blocks`, `historical_stability.surviving_blocks`, `validationStatus`, and `weighting`.

### Presentation rules

- Keep every rule, including rejected/insufficient and legacy rows.
- Use `Validated` only for an explicit validation survivor and `Did not validate` otherwise; never derive a percentage from survivor/block counts.
- Show historical stability and promoted state as separate fields.
- Use `—` for absent optional values.
- Use the existing condition rendering helper behavior in the dialog or a focused shared presentation helper, without discovery computation.

## Project Structure

```text
crypto/
├── src/copytrade/experimentalDecision.ts
├── ui/main.tsx
├── ui/strings.ts
├── ui/components/DataTable.tsx
├── ui/components/PatternDiscoveryRuleDialog.tsx
├── ui/components/PatternDiscoveryPromotedPatterns.tsx
└── specs/001-pattern-rule-evidence/
    ├── spec.md
    ├── plan.md
    ├── tasks.md
    └── checklists/requirements.md
```

**Structure Decision**: Keep the large page orchestration in place for the existing state/dialog wiring, while extracting the new table into a focused component. Shared table behavior belongs in `DataTable`; category business mapping remains in the domain module.

## Verification Plan

- Build the UI with the existing npm script.
- Run relevant Pattern Discovery and UI-facing tests available in `crypto/tests`.
- Run `npm run arch:check`.
- Verify report objects without newer optional fields render `—`, retain all rows, and do not trigger API/discovery calls.
- Append implementation and verification results to `crypto/progress.md`.

## Complexity Tracking

No constitution violations or new dependencies.
