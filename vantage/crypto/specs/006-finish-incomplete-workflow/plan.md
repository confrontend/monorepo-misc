# Implementation Plan: Finish Incomplete Data Workflows

## Summary

Add explicit, server-authoritative finish and cancel transitions for incomplete Data workflow runs.
The existing schema already supports `completed_with_warnings` and `abandoned`, so the change can
preserve captured evidence without a migration. Extend the status contract and Data tab controls,
then use the now-unblocked UI to create the currently selected-wallet run.

## Technical Context

- TypeScript Node HTTP server with SQLite persistence.
- React Data tab with Zustand-backed UI state and a server-authored status contract.
- Existing workflow run statuses include `completed_with_warnings` and `abandoned`.
- Existing production-job lock enumerates owned and external provider jobs.
- Existing tests use in-memory SQLite and Node's built-in test runner.

## Constitution Check

- Centralized lifecycle logic remains in `src/copytrade/data/dataWorkflowOrchestrator.ts` and
  `dataWorkflowRunStore.ts`; the UI consumes the contract and does not infer safety.
- No provider behavior, scoring rule, or evidence calculation changes.
- No migration is needed because the existing schema already permits the terminal statuses.
- New route and state transitions receive contract tests; build, lint, and architecture checks run.
- New UI copy is placed in `ui/strings.ts`.

## Design

1. Add a shared closeability predicate based on the persisted run, persisted step statuses, and
   owned production jobs. A finish/cancel request is rejected while a step or owned provider job
   is active. Unrelated external jobs remain visible and continue to block starting a new run.
2. Add `finishDataWorkflow` and `cancelDataWorkflow` server actions. Finish changes the run to
   `completed_with_warnings` and changes unexecuted/paused steps to
   `completed_with_warnings` with explicit “not run” warnings. Cancel changes the run to the
   existing terminal `abandoned` status. Both preserve all evidence and are idempotent for their
   own terminal status.
3. Add `finish` and `cancel` action states to the status response. The `start` action becomes
   allowed after a terminal run is closed, while readiness continuation remains available only
   for legacy/normal completed runs that were not explicitly closed.
4. Add POST routes and UI buttons with clear labels. The status header will distinguish a ready,
   running, paused, finished-with-warnings, and cancelled workflow. The create button remains
   disabled until the server says it is allowed.
5. After verification, refresh the Data tab, finish Run #15, confirm the selected roster in the
   wallet chooser, and create the new run through the existing UI. Do not initiate Dune unless the
   normal coverage prerequisite becomes true.

## Project Structure

### Documentation (this feature)

- `spec.md`
- `plan.md`
- `tasks.md`
- `checklists/requirements.md`

### Source Code

- `src/copytrade/data/dataWorkflowRunStore.ts` — close-safe persistence helper/status typing.
- `src/copytrade/data/dataWorkflowOrchestrator.ts` — action states and close transitions.
- `src/scripts/server.ts` — finish/cancel routes.
- `src/apiCatalog.ts` — public route catalog entries.
- `ui/components/data/dataWorkflowTypes.ts` — client contract types.
- `ui/components/data/DataWorkflow.tsx` — lifecycle controls and mutations.
- `ui/components/data/dataWorkflowUiState.ts` — terminal/active presentation selectors.
- `ui/strings.ts` — new user-facing workflow copy.
- `tests/data-workflow-actions-contract.test.ts` — action and transition coverage.
- `tests/data-workflow-run-store.test.ts` — persistence/idempotency coverage.

## Complexity Tracking

No constitution exception required. The existing `abandoned` terminal status and warning-capable
step status avoid a schema migration and keep lifecycle ownership in the current modules.
