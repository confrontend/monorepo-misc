# Tasks: Finish Incomplete Data Workflows

## Phase 1: Setup

- [x] T001 Confirm current workflow schema already supports terminal `completed_with_warnings` and `abandoned` statuses in `src/platform/db/schema.ts`
- [x] T002 Confirm the existing production-job lock is the authoritative source for owned provider jobs in `src/copytrade/data/productionJobLock.ts`

## Phase 2: Foundational

- [x] T003 [P] Confirm the existing run-store terminal-state types and extend the client action contract in `ui/components/data/dataWorkflowTypes.ts`; no duplicate persistence types were needed.
- [x] T004 Confirm existing run-store status persistence is sufficient; cover close-safe/idempotent transitions in `tests/data-workflow-actions-contract.test.ts`.

## Phase 3: User Story 1 — Close an incomplete workflow (Priority: P1)

- [x] T005 [P] [US1] Add finish/cancel action-state derivation and close transitions in `src/copytrade/data/dataWorkflowOrchestrator.ts`
- [x] T006 [P] [US1] Add POST finish/cancel routes in `src/scripts/server.ts` and route catalog entries in `src/apiCatalog.ts`
- [x] T007 [US1] Add action contract tests for safe, unsafe, repeated, finish, and cancel transitions in `tests/data-workflow-actions-contract.test.ts`

## Phase 4: User Story 2 — Show truthful lifecycle state (Priority: P2)

- [x] T008 [P] [US2] Add lifecycle labels and close-control copy to `ui/strings.ts`
- [x] T009 [US2] Render server-authoritative finish/cancel controls and truthful terminal status in `ui/components/data/DataWorkflow.tsx` and `ui/components/data/dataWorkflowUiState.ts`
- [x] T010 [US2] Update client contract types and verify disabled explanations for running and ready states in `ui/components/data/dataWorkflowTypes.ts`

## Phase 5: User Story 3 — Start the selected wallet fetch (Priority: P3)

- [x] T011 [US3] Refresh the Data tab, close Run #15 through the new finish action, and confirm the wallet selection remains scoped before creating a new run through the existing UI
- [x] T012 [US3] Verify the new run's persisted roster scope and status through the Data workflow status endpoint without starting Dune

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T013 Run build, full tests, architecture check, and lint; build/tests/architecture passed, while lint retains unrelated pre-existing repository failures outside this change.
- [x] T014 Append implementation, verification, and unresolved runtime state to `progress.md`; documented Run #15 closure, Run #16 five-wallet fetch result, persisted failure reporting fix, and no automatic retry

## Dependencies & Execution Order

- T001–T002 are complete reconnaissance.
- T003–T004 must precede the orchestrator and route changes.
- T005–T007 implement and test the server contract.
- T008–T010 implement and test the UI contract.
- T011–T012 happen only after the code is built and the server is restarted.
- T013–T014 are final gates.

## Parallel Opportunities

- T003 and T006 can be prepared independently after the persistence contract is agreed.
- T005 and T008 touch separate layers and can be developed independently, but integration waits for both.

## Implementation Strategy

1. Deliver the server transition and contract first so a stale run can be closed safely.
2. Add the UI controls and truthful labels.
3. Verify with automated tests and use the UI to close Run #15 and start the explicitly selected cohort.

## Notes

- “Finish” preserves incomplete evidence and explicitly marks unrun steps as warnings.
- “Cancel” uses the existing `abandoned` terminal status and never deletes saved data.
- No new GMGN or Dune fetch is initiated by the code change itself.
