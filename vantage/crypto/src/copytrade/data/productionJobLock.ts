import type { DatabaseSync } from 'node:sqlite';
import { asWorkflowRunId, type WorkflowRunId } from './workflowIds.js';

export type ProductionJobKind =
  'data_workflow' | 'gmgn_fetch' | 'dune_simulation' | 'dune_outcomes' | 'pattern_research';

export type ProductionJobRelationship = 'owned' | 'external';

export type ProductionJobBlocker = {
  kind: ProductionJobKind;
  jobRunId: number;
  /** The Data workflow run that owns this job, if any. `dune_outcomes` and `pattern_research`
   *  jobs are never owned -- they belong to subsystems the Data workflow does not control. */
  workflowRunId: WorkflowRunId | null;
  relationship: ProductionJobRelationship;
  status: string;
  label: string;
  stoppable: boolean;
};

export type ProductionJobLock = {
  locked: boolean;
  blockers: ProductionJobBlocker[];
  reason: string | null;
};

const relationshipFor = (
  rowWorkflowRunId: number | null,
  requestingWorkflowRunId: WorkflowRunId | undefined,
): ProductionJobRelationship =>
  rowWorkflowRunId !== null && rowWorkflowRunId === requestingWorkflowRunId ? 'owned' : 'external';

const readBlockers = (
  database: DatabaseSync,
  options: { workflowRunId?: WorkflowRunId } = {},
): ProductionJobBlocker[] => {
  const blockers: ProductionJobBlocker[] = [];
  const workflowRows = database
    .prepare(
      `SELECT id, status FROM copytrade_data_workflow_runs
       WHERE status = 'active' ORDER BY id ASC`,
    )
    .all() as unknown as Array<{ id: number; status: string }>;
  for (const row of workflowRows) {
    const relationship = relationshipFor(row.id, options.workflowRunId);
    blockers.push({
      kind: 'data_workflow',
      jobRunId: row.id,
      workflowRunId: asWorkflowRunId(row.id),
      relationship,
      status: row.status,
      label: `centralized Data workflow #${row.id}`,
      stoppable: false,
    });
  }

  const fetchRows = database
    .prepare(
      `SELECT id, status, workflow_run_id AS workflowRunId FROM copytrade_fetch_runs
       WHERE status = 'running' ORDER BY id ASC`,
    )
    .all() as unknown as Array<{ id: number; status: string; workflowRunId: number | null }>;
  for (const row of fetchRows) {
    const relationship = relationshipFor(row.workflowRunId, options.workflowRunId);
    blockers.push({
      kind: 'gmgn_fetch',
      jobRunId: row.id,
      workflowRunId: row.workflowRunId === null ? null : asWorkflowRunId(row.workflowRunId),
      relationship,
      status: row.status,
      label: `GMGN activity fetch #${row.id}`,
      stoppable: relationship === 'external',
    });
  }

  const simulationRows = database
    .prepare(
      `SELECT id, status, workflow_run_id AS workflowRunId FROM copytrade_copy_simulation_runs
       WHERE status IN ('submitted', 'running', 'timed_out') ORDER BY id ASC`,
    )
    .all() as unknown as Array<{ id: number; status: string; workflowRunId: number | null }>;
  for (const row of simulationRows) {
    const relationship = relationshipFor(row.workflowRunId, options.workflowRunId);
    blockers.push({
      kind: 'dune_simulation',
      jobRunId: row.id,
      workflowRunId: row.workflowRunId === null ? null : asWorkflowRunId(row.workflowRunId),
      relationship,
      status: row.status,
      label: `Dune copy simulation #${row.id}`,
      // No discrete per-batch stop control exists; the workflow's own Pause action is the real
      // stop affordance for an owned batch, and stopping someone else's batch isn't offered here.
      stoppable: false,
    });
  }

  // dune_outcome_runs belongs to a separate live-signal subsystem (src/dune/*), never owned by
  // the Data workflow -- it is always external and never excluded from the lock.
  const outcomeRows = database
    .prepare(
      `SELECT id, status FROM dune_outcome_runs
       WHERE status IN ('submitted', 'running', 'timed_out') ORDER BY id ASC`,
    )
    .all() as unknown as Array<{ id: number; status: string }>;
  for (const row of outcomeRows) {
    blockers.push({
      kind: 'dune_outcomes',
      jobRunId: row.id,
      workflowRunId: null,
      relationship: 'external',
      status: row.status,
      label: `Dune signal-outcome run #${row.id}`,
      stoppable: false,
    });
  }

  const patternRows = database
    .prepare(
      `SELECT id, status FROM copytrade_pattern_discovery_runs
       WHERE status IN ('preparing', 'running') ORDER BY id ASC`,
    )
    .all() as unknown as Array<{ id: number; status: string }>;
  for (const row of patternRows) {
    blockers.push({
      kind: 'pattern_research',
      jobRunId: row.id,
      workflowRunId: null,
      relationship: 'external',
      status: row.status,
      label: `Pattern Research run #${row.id}`,
      stoppable: false,
    });
  }
  return blockers;
};

/**
 * Reads the persistent production jobs that can contend for the same GMGN/Dune evidence.
 * This is deliberately a read-only view: it does not pretend that an in-memory boolean is an
 * inter-process lock, and it does not write stale completion state while rendering a page.
 *
 * `locked`/`reason` only ever reflect `external` blockers -- a workflow's own jobs (identified by
 * `options.workflowRunId`) never lock that same workflow out of its own next action, but they are
 * still returned in `blockers` so callers can build a complete job list (e.g. the Data tab's
 * `jobs[]` contract) from this single enumeration instead of a second parallel query.
 */
export const readProductionJobLock = (
  database: DatabaseSync,
  options: { workflowRunId?: WorkflowRunId } = {},
): ProductionJobLock => {
  const blockers = readBlockers(database, options);
  const external = blockers.filter((blocker) => blocker.relationship === 'external');
  return {
    locked: external.length > 0,
    blockers,
    reason:
      external.length > 0
        ? `Another production job is active: ${external.map((blocker) => blocker.label).join(', ')}. Stop or wait for it to finish before starting this step.`
        : null,
  };
};

export const productionJobDisabledReason = (lock: ProductionJobLock): string | null => lock.reason;
