import type { DatabaseSync } from 'node:sqlite';
import { reconcileStaleCopySimulationRuns } from './copySimulationDune.js';

type ActiveRun = {
  id: number;
  status: string;
  requestedAt: string;
  executionId: string | null;
  tradeRefs: string;
  duneState: string | null;
  duneStatusPayload: string | null;
  duneLastStatusAt: string | null;
};

const countRefs = (raw: string): number => {
  try {
    const refs = JSON.parse(raw) as unknown;
    return Array.isArray(refs) ? refs.length : 0;
  } catch {
    return 0;
  }
};

/** Reconciles and projects the durable Dune run state over process-local progress. */
export const readPersistedCopySimulationStatus = (
  database: DatabaseSync,
  liveState: Record<string, unknown>,
): Record<string, unknown> => {
  const orphanedRuns = reconcileStaleCopySimulationRuns(database);
  if (orphanedRuns > 0) {
    const recoveredAt = new Date().toISOString();
    database
      .prepare(
        `UPDATE copytrade_dune_fetch_audits
         SET completed_at = ?, status = 'failed',
             message = 'Dune fetch expired before an execution was recorded.'
         WHERE status = 'running' AND completed_at IS NULL`,
      )
      .run(recoveredAt);
    const remainingActive = database
      .prepare(
        `SELECT 1 FROM copytrade_copy_simulation_runs
         WHERE status IN ('submitted', 'running', 'timed_out') LIMIT 1`,
      )
      .get();
    if (!remainingActive)
      database.prepare('DELETE FROM copytrade_copy_simulation_leases WHERE singleton_id = 1').run();
  }

  const latestAudit = database
    .prepare(
      `SELECT id, requested_at AS requestedAt, completed_at AS completedAt,
       mode, wallet_count AS walletCount, planned_targets AS plannedTargets,
       submitted_targets AS submittedTargets, stored_targets AS storedTargets,
       failed_targets AS failedTargets, remaining_targets AS remainingTargets,
       status, message FROM copytrade_dune_fetch_audits ORDER BY id DESC LIMIT 1`,
    )
    .get() as { requestedAt?: string; plannedTargets?: number; status?: string } | undefined;
  const activeRun = database
    .prepare(
      `SELECT id, status, requested_at AS requestedAt, execution_id AS executionId,
              trade_refs AS tradeRefs, dune_last_state AS duneState,
              dune_status_payload AS duneStatusPayload, dune_last_status_at AS duneLastStatusAt
       FROM copytrade_copy_simulation_runs
       WHERE status IN ('submitted', 'running', 'timed_out')
       ORDER BY id DESC LIMIT 1`,
    )
    .get() as ActiveRun | undefined;
  if (!activeRun) return { ...liveState, audit: latestAudit ?? null };

  const boundary = latestAudit?.requestedAt ?? activeRun.requestedAt;
  const priorRuns = database
    .prepare(
      `SELECT status, trade_refs AS tradeRefs FROM copytrade_copy_simulation_runs
       WHERE requested_at >= ? AND id <= ?`,
    )
    .all(boundary, activeRun.id) as Array<{ status: string; tradeRefs: string }>;
  const completed = priorRuns
    .filter((run) => run.status === 'completed')
    .reduce((sum, run) => sum + countRefs(run.tradeRefs), 0);
  const failed = priorRuns
    .filter((run) => run.status === 'failed')
    .reduce((sum, run) => sum + countRefs(run.tradeRefs), 0);
  const batchesRun = priorRuns.filter(
    (run) => run.status === 'completed' || run.status === 'failed',
  ).length;
  const planned = Number(latestAudit?.plannedTargets) || 0;
  let duneCost: number | null = null;
  if (activeRun.duneStatusPayload) {
    try {
      const payload = JSON.parse(activeRun.duneStatusPayload) as Record<string, unknown>;
      duneCost =
        typeof payload.execution_cost_credits === 'number' ? payload.execution_cost_credits : null;
    } catch {
      // Preserve status visibility even if the diagnostic payload is malformed.
    }
  }
  return {
    ...liveState,
    running: true,
    targetsTotal: planned,
    targetsProcessed: completed,
    batchesRun,
    currentBatch: batchesRun + 1,
    batchesTotal: planned ? Math.ceil(planned / 150) : 0,
    storedTargets: completed,
    failedTargets: failed,
    remainingTargets: Math.max(0, planned - completed - failed),
    duneExecutionId: activeRun.executionId,
    duneState: activeRun.duneState,
    duneExecutionCostCredits: duneCost,
    duneLastStatusAt: activeRun.duneLastStatusAt,
    duneRequestPhase: 'status_received',
    message: `Dune query ${batchesRun + 1} of ${planned ? Math.ceil(planned / 150) : '?'} is executing · ${countRefs(activeRun.tradeRefs)} targets`,
    audit: latestAudit ?? null,
  };
};
