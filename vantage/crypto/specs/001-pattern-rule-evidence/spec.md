# Feature Specification: Pattern Discovery Rule Evidence

**Feature Branch**: `001-pattern-rule-evidence`

**Created**: 2026-08-24

**Status**: Ready for planning

**Input**: Add a complete per-rule evidence section to the Pattern Discovery UI without changing discovery or Decision Lab calculations.

## User Scenarios & Testing

### User Story 1 - Compare rule evidence (Priority: P1)

As a researcher reviewing a Pattern Discovery report, I need to compare every discovered rule's discovery and validation evidence in one table so that I can distinguish associations that were found from evidence that repeated.

**Why this priority**: The current summary omits per-rule fields needed to assess evidence quality.

**Independent Test**: Load a report containing candidate, survivor, rejected, and legacy rules, then confirm the table exposes all rules and the requested evidence fields without changing the report.

**Acceptance Scenarios**:

1. **Given** a current report with rules in multiple feature families, **When** the Pattern Discovery results are displayed, **Then** every rule appears under Edge, Consistency, Robustness, or Copyability according to the existing Decision Lab mapping.
2. **Given** a rule with discovery and validation fields, **When** the user scans the table, **Then** name, condition, effects, samples, wallet/group counts, historical blocks/survivors, status, p/q-values, weighting, and promoted/stable state are visible or shown as — when absent.
3. **Given** a user clicks a table row, **When** the row is selected, **Then** the existing rule detail dialog opens for that same rule.

### User Story 2 - Filter and sort evidence (Priority: P2)

As a researcher, I need to filter and sort the evidence table so that I can focus on a category, status, or effect direction.

**Why this priority**: A complete report can contain many rules and requires readable comparison.

**Independent Test**: Apply the category/status filter and sort by numeric evidence columns; verify only the matching rows remain and sort order is deterministic.

**Acceptance Scenarios**:

1. **Given** a populated table, **When** the user filters or sorts it, **Then** the table updates without a new data request or discovery recalculation.

### User Story 3 - Interpret evidence safely (Priority: P3)

As a researcher, I need concise definitions beside the table so that I do not mistake validation survivors for a success-rate percentage or effect size for guaranteed profit.

**Why this priority**: The report is evidence for research decisions and must preserve its statistical limitations.

**Independent Test**: Review the legend with a report missing newer fields and confirm it uses “Validated”/“Did not validate” rather than an invented rate.

**Acceptance Scenarios**:

1. **Given** missing legacy fields, **When** the table renders, **Then** it shows — and does not infer unsupported metrics.

### Edge Cases

- Reports may omit wallet counts, p-values/q-values, weighting, or historical details; those cells show —.
- Rules with unknown feature names remain visible and use an explicit unknown category fallback rather than being silently dropped.
- A report with no rules shows the shared table empty state.
- Negative and positive effects remain visually distinct without changing their values.

## Requirements

### Functional Requirements

- **FR-001**: The UI MUST render one evidence row for each rule in the existing Pattern Discovery report.
- **FR-002**: The UI MUST group each row using the existing Decision Lab feature-to-category mapping.
- **FR-003**: Each row MUST expose rule name, category, condition, discovery/validation effects, discovery/validation samples, available wallet and independence-group counts, historical validation blocks/survivors, validation status, available p/q-values, weighting method, and promoted/stable state.
- **FR-004**: The UI MUST display missing report fields as — and MUST NOT calculate a success rate from survivor counts alone.
- **FR-005**: The UI MUST provide category/status filtering, sortable comparison columns, positive/negative effect styling, a concise evidence legend, and row-click access to the existing detail dialog.
- **FR-006**: The UI MUST read only existing report fields and MUST NOT alter discovery, validation, promotion, category scoring, point-in-time, or leakage behavior.
- **FR-007**: User-facing copy for this section MUST be centralized with the existing UI strings.

### Key Entities

- **Pattern rule evidence row**: A presentation of one report pattern and its existing discovery, validation, independence, stability, and promotion metadata.
- **Decision Lab category**: The existing category assigned from a rule feature for Edge, Consistency, Robustness, or Copyability.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Every report rule is represented exactly once in the evidence section, including rules with legacy or missing fields.
- **SC-002**: A user can filter by category/status and sort by at least the displayed effect, sample, and status fields without a new data request or recalculation.
- **SC-003**: No UI label describes a validation survivor as a percentage success rate unless that percentage is explicitly present in the report.
- **SC-004**: Existing row-click detail behavior remains available for every displayed rule.

## Assumptions

- The strict 100% report is the existing report shown in the Pattern Discovery section; no new API or calculation is needed.
- “Promoted” is represented by existing report-level eligibility fields when present; otherwise the UI distinguishes validation survivor and historical stability without inventing cross-coverage promotion.
- A feature with no category mapping remains visible with an explicit unknown category fallback rather than being omitted.
- Existing shared table and dialog components remain the interaction primitives.
