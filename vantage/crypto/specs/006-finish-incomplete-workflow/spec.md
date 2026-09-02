# Feature Specification: Finish Incomplete Data Workflows

**Feature Branch**: `006-finish-incomplete-workflow`

**Created**: 2026-08-31

**Status**: Ready for planning

**Input**: User description: "Add a safe Finish or Cancel incomplete workflow action for persisted Data tab runs, expose truthful lifecycle status, and allow starting the selected wallet fetch after the stale run is closed."

## User Scenarios & Testing _(mandatory)_

<!--
  IMPORTANT: User stories should be PRIORITIZED as user journeys ordered by importance.
  Each user story/journey must be INDEPENDENTLY TESTABLE - meaning if you implement just ONE of them,
  you should still have a viable MVP (Minimum Viable Product) that delivers value.

  Assign priorities (P1, P2, P3, etc.) to each story, where P1 is the most critical.
  Think of each story as a standalone slice of functionality that can be:
  - Developed independently
  - Tested independently
  - Deployed independently
  - Demonstrated to users independently
-->

### User Story 1 - Close an incomplete workflow (Priority: P1)

As a Data tab user, I want to finish or cancel a persisted workflow that has no running step and cannot continue, so that the UI reflects reality and I can create a new run without losing already captured evidence.

**Why this priority**: A stale active marker currently blocks new work even when no provider job is running.

**Independent Test**: Create a run whose completed steps leave a prerequisite unsatisfied, reload the Data tab, finish it, and verify the run is terminal and a new run can be created.

**Acceptance Scenarios**:

1. **Given** a saved active workflow with no running step, **When** the user chooses Finish incomplete workflow, **Then** the workflow becomes a terminal completed-with-warnings state, retains all saved step results, and no longer blocks creation of a new run.
2. **Given** a saved active or paused workflow with no running provider job, **When** the user chooses Cancel workflow, **Then** the workflow becomes cancelled, retained evidence remains readable, and the UI explains that a new run may be created.
3. **Given** a workflow step or underlying provider job is running, **When** the user views lifecycle controls, **Then** Finish and Cancel cannot falsely claim the job has stopped; the existing stop/pause behavior remains the only available control until the job reaches a safe boundary.

---

### User Story 2 - Show truthful lifecycle state (Priority: P2)

As a user, I want the workflow summary and controls to distinguish an active running job from an idle workflow waiting for a prerequisite, so that I know what action is safe.

**Why this priority**: The current combination of `active`, `ready_for_step`, and disabled controls is misleading.

**Independent Test**: Inspect the Data tab for running, ready, paused, finished, and cancelled fixtures and verify each state has matching labels, controls, and disabled explanations.

**Acceptance Scenarios**:

1. **Given** no step or provider job is running, **When** the Data tab loads, **Then** it labels the workflow as ready/waiting and exposes the appropriate finish/cancel action rather than describing it as an active job.
2. **Given** a terminal workflow, **When** the Data tab loads, **Then** it shows the terminal result and enables creation of a new workflow.

---

### User Story 3 - Start the selected wallet fetch (Priority: P3)

As a user, I want to create a new run for the wallets currently selected in the Data tab after the old incomplete run is closed, so that the fetch scope is explicit and does not silently expand to the full roster.

**Why this priority**: The user has approved a targeted fetch and needs confidence that only the selected wallets are sent to the workflow.

**Independent Test**: Select a known wallet subset, close the old workflow, create a run, and verify the saved roster snapshot and first fetch request contain exactly that subset.

**Acceptance Scenarios**:

1. **Given** a terminal prior workflow and a selected wallet subset, **When** the user creates a new run, **Then** the new run is created for exactly that subset and the UI shows the selected count and target history window.
2. **Given** an existing active or paused workflow, **When** the user attempts to create a new run, **Then** creation remains disabled until the existing workflow is safely resumed, finished, or cancelled.

---

[Add more user stories as needed, each with an assigned priority]

### Edge Cases

<!--
  ACTION REQUIRED: The content in this section represents placeholders.
  Fill them out with the right edge cases.
-->

- A finish request must be rejected while a step is running or while an underlying provider job is still active.
- Repeating finish or cancel on a terminal workflow must be idempotent and must not create another run or erase evidence.
- A restart with an active workflow but no recoverable job must expose the finish/cancel action rather than leaving the run permanently locked.
- A failed workflow may be cancelled/closed without converting its failure into a successful data-complete result.
- A new run must snapshot the selected wallets at creation time; later roster changes must not alter its scope.

## Requirements _(mandatory)_

<!--
  ACTION REQUIRED: The content in this section represents placeholders.
  Fill them out with the right functional requirements.
-->

### Functional Requirements

- **FR-001**: The system MUST expose a finish action for an incomplete workflow only when no workflow step or underlying provider job is running.
- **FR-002**: The system MUST expose a cancel action for an incomplete workflow only when no workflow step or underlying provider job is running, and it MUST preserve captured evidence.
- **FR-003**: Finishing an incomplete workflow MUST produce a terminal completed-with-warnings result that records why the workflow ended before all planned steps completed.
- **FR-004**: Cancelling an incomplete workflow MUST produce a terminal cancelled result and MUST record the cancellation reason.
- **FR-005**: Finish and cancel operations MUST be idempotent and MUST reject unsafe transitions without changing the workflow state.
- **FR-006**: The status contract MUST distinguish a persisted workflow lifecycle status from the presence of a currently running underlying job.
- **FR-007**: The Data tab MUST render lifecycle controls and disabled explanations from the shared status contract, without inferring running state from stale step counters.
- **FR-008**: The create-run action MUST remain disabled while an unfinished workflow exists and MUST become enabled after a terminal finish/cancel transition.
- **FR-009**: A newly created run MUST persist exactly the wallet addresses selected by the user at confirmation time.
- **FR-010**: Starting the new run MUST use the existing explicit workflow fetch pipeline and MUST NOT start Dune outcome collection unless its existing prerequisite is satisfied.

_Example of marking unclear requirements:_

- **FR-006**: System MUST authenticate users via [NEEDS CLARIFICATION: auth method not specified - email/password, SSO, OAuth?]
- **FR-007**: System MUST retain user data for [NEEDS CLARIFICATION: retention period not specified]

### Key Entities _(include if feature involves data)_

- **Workflow lifecycle**: The durable state of one Data tab run, including active, paused, terminal, and incomplete-with-warnings outcomes.
- **Workflow step**: One ordered capture/verification/outcome/readiness operation and its saved progress/result.
- **Selected wallet scope**: The immutable wallet set captured for a run at creation time.
- **Underlying provider job**: A GMGN or Dune operation whose live activity controls whether a workflow may be safely finished or cancelled.

## Success Criteria _(mandatory)_

<!--
  ACTION REQUIRED: Define measurable success criteria.
  These must be technology-agnostic and measurable.
-->

### Measurable Outcomes

- **SC-001**: After a restart, 100% of workflows with no running step expose a safe terminal action or a clear finished state; none remains indefinitely blocked as an active workflow.
- **SC-002**: A user can close an incomplete workflow and create a new selected-scope run in no more than two deliberate actions after the Data tab loads.
- **SC-003**: Terminal workflows retain 100% of previously saved step evidence and wallet scope.
- **SC-004**: A targeted new run sends no wallet outside its confirmed selected scope.
- **SC-005**: Lifecycle API tests cover running, ready, paused, completed-with-warnings, cancelled, unsafe transition, and repeated-transition cases.

## Assumptions

<!--
  ACTION REQUIRED: The content in this section represents placeholders.
  Fill them out with the right assumptions based on reasonable defaults
  chosen when the feature description did not specify certain details.
-->

- The user is the local operator and has authority to close their own local workflow runs.
- Finish is an evidence-preserving closure, not a claim that missing provider evidence exists.
- Cancel does not delete trades, metadata, coverage, Dune outcomes, archives, or roster snapshots.
- Existing pause/stop behavior remains responsible for interrupting live provider work.
- No new provider integration or database migration is required unless the current schema cannot represent the terminal transition.
