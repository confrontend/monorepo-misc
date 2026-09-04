import type { DatabaseSync } from 'node:sqlite';

export type DataWorkflowStepKey =
  | 'roster'
  | 'wallet_metadata'
  | 'activity_history'
  | 'coverage_verification'
  | 'dune_outcomes'
  | 'readiness';

export const DATA_WORKFLOW_STEP_ORDER: DataWorkflowStepKey[] = [
  'roster',
  'wallet_metadata',
  'activity_history',
  'coverage_verification',
  'dune_outcomes',
  'readiness',
];

export type DataWorkflowRunStatus =
  'active' | 'paused' | 'completed' | 'completed_with_warnings' | 'failed' | 'abandoned';

export type DataWorkflowStepStatus =
  'not_started' | 'running' | 'paused' | 'completed' | 'completed_with_warnings' | 'failed';

export type DataWorkflowRun = {
  id: number;
  chain: string;
  targetDays: number;
  traderLimit: number;
  rosterSnapshotId: number | null;
  rosterWallets: string[];
  status: DataWorkflowRunStatus;
  completenessThresholdPercent: number;
  depthMode: 'requested' | 'maximum_available';
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
};

export type DataWorkflowStep = {
  runId: number;
  stepKey: DataWorkflowStepKey;
  stepOrder: number;
  status: DataWorkflowStepStatus;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  lastSuccessAt: string | null;
  underlyingRunId: number | null;
  underlyingRunKind: string | null;
  recordsTotal: number;
  recordsNew: number;
  walletsTotal: number;
  walletsDone: number;
  walletsFailed: number;
  warnings: string[];
  error: string | null;
};

export type DataWorkflowRunWithSteps = DataWorkflowRun & { steps: DataWorkflowStep[] };

/** Creates a new workflow run plus its six step rows, all `not_started`. The roster is frozen
 *  here (`rosterWallets`) so a later pause/resume can never silently drift onto a different
 *  roster snapshot mid-run. */
export const createDataWorkflowRun = (
  database: DatabaseSync,
  options: {
    chain: string;
    targetDays: number;
    traderLimit: number;
    rosterSnapshotId: number | null;
    rosterWallets: string[];
    completenessThresholdPercent?: number;
    depthMode?: 'requested' | 'maximum_available';
  },
): number => {
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO copytrade_data_workflow_runs
       (chain, target_days, trader_limit, roster_snapshot_id, roster_wallets_json, status,
        completeness_threshold_percent, depth_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    )
    .run(
      options.chain,
      options.targetDays,
      options.traderLimit,
      options.rosterSnapshotId,
      JSON.stringify(options.rosterWallets),
      options.completenessThresholdPercent ?? 90,
      options.depthMode ?? 'requested',
      now,
      now,
    );
  const runId = Number(
    (database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id,
  );
  const insertStep = database.prepare(
    `INSERT INTO copytrade_data_workflow_steps (run_id, step_key, step_order, status, updated_at)
     VALUES (?, ?, ?, 'not_started', ?)`,
  );
  DATA_WORKFLOW_STEP_ORDER.forEach((stepKey, index) => {
    insertStep.run(runId, stepKey, index + 1, now);
  });
  return runId;
};

const parseRun = (row: {
  id: number;
  chain: string;
  targetDays: number;
  traderLimit: number;
  rosterSnapshotId: number | null;
  rosterWalletsJson: string;
  status: string;
  completenessThresholdPercent: number;
  depthMode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
}): DataWorkflowRun => ({
  id: row.id,
  chain: row.chain,
  targetDays: row.targetDays,
  traderLimit: row.traderLimit,
  rosterSnapshotId: row.rosterSnapshotId,
  rosterWallets: (() => {
    try {
      const parsed: unknown = JSON.parse(row.rosterWalletsJson);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  })(),
  status: row.status as DataWorkflowRunStatus,
  completenessThresholdPercent: row.completenessThresholdPercent,
  depthMode: row.depthMode === 'maximum_available' ? 'maximum_available' : 'requested',
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  completedAt: row.completedAt,
  error: row.error,
});

const parseStep = (row: {
  runId: number;
  stepKey: string;
  stepOrder: number;
  status: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  lastSuccessAt: string | null;
  underlyingRunId: number | null;
  underlyingRunKind: string | null;
  recordsTotal: number;
  recordsNew: number;
  walletsTotal: number;
  walletsDone: number;
  walletsFailed: number;
  warningsJson: string;
  error: string | null;
}): DataWorkflowStep => ({
  runId: row.runId,
  stepKey: row.stepKey as DataWorkflowStepKey,
  stepOrder: row.stepOrder,
  status: row.status as DataWorkflowStepStatus,
  startedAt: row.startedAt,
  updatedAt: row.updatedAt,
  completedAt: row.completedAt,
  lastSuccessAt: row.lastSuccessAt,
  underlyingRunId: row.underlyingRunId,
  underlyingRunKind: row.underlyingRunKind,
  recordsTotal: row.recordsTotal,
  recordsNew: row.recordsNew,
  walletsTotal: row.walletsTotal,
  walletsDone: row.walletsDone,
  walletsFailed: row.walletsFailed,
  warnings: (() => {
    try {
      const parsed: unknown = JSON.parse(row.warningsJson);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  })(),
  error: row.error,
});

const RUN_COLUMNS = `id, chain, target_days AS targetDays, trader_limit AS traderLimit,
  roster_snapshot_id AS rosterSnapshotId, roster_wallets_json AS rosterWalletsJson, status,
  completeness_threshold_percent AS completenessThresholdPercent, depth_mode AS depthMode, created_at AS createdAt,
  updated_at AS updatedAt, completed_at AS completedAt, error`;

const STEP_COLUMNS = `run_id AS runId, step_key AS stepKey, step_order AS stepOrder, status,
  started_at AS startedAt, updated_at AS updatedAt, completed_at AS completedAt,
  last_success_at AS lastSuccessAt, underlying_run_id AS underlyingRunId,
  underlying_run_kind AS underlyingRunKind, records_total AS recordsTotal,
  records_new AS recordsNew, wallets_total AS walletsTotal, wallets_done AS walletsDone,
  wallets_failed AS walletsFailed, warnings_json AS warningsJson, error`;

export const readDataWorkflowSteps = (database: DatabaseSync, runId: number): DataWorkflowStep[] =>
  (
    database
      .prepare(
        `SELECT ${STEP_COLUMNS} FROM copytrade_data_workflow_steps WHERE run_id = ? ORDER BY step_order ASC`,
      )
      .all(runId) as unknown[]
  ).map((row) => parseStep(row as Parameters<typeof parseStep>[0]));

export const readDataWorkflowRun = (
  database: DatabaseSync,
  runId: number,
): DataWorkflowRunWithSteps | null => {
  const row = database
    .prepare(`SELECT ${RUN_COLUMNS} FROM copytrade_data_workflow_runs WHERE id = ?`)
    .get(runId) as Parameters<typeof parseRun>[0] | undefined;
  if (!row) return null;
  return { ...parseRun(row), steps: readDataWorkflowSteps(database, runId) };
};

/** The one workflow run a chain's Data tab shows -- there is intentionally no concept of
 *  multiple concurrent workflow runs for the same chain (the combined job lock in
 *  productionJobLock.ts enforces this at the API layer). */
export const readLatestDataWorkflowRun = (
  database: DatabaseSync,
  chain: string,
): DataWorkflowRunWithSteps | null => {
  const row = database
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM copytrade_data_workflow_runs WHERE chain = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(chain) as Parameters<typeof parseRun>[0] | undefined;
  if (!row) return null;
  return { ...parseRun(row), steps: readDataWorkflowSteps(database, row.id) };
};

export const updateDataWorkflowRunStatus = (
  database: DatabaseSync,
  options: {
    runId: number;
    status: DataWorkflowRunStatus;
    error?: string | null;
    completed?: boolean;
  },
): void => {
  const now = new Date().toISOString();
  database
    .prepare(
      `UPDATE copytrade_data_workflow_runs
       SET status = ?, error = ?, updated_at = ?, completed_at = CASE WHEN ? THEN ? ELSE completed_at END
       WHERE id = ?`,
    )
    .run(options.status, options.error ?? null, now, options.completed ? 1 : 0, now, options.runId);
};

export const updateDataWorkflowStep = (
  database: DatabaseSync,
  options: {
    runId: number;
    stepKey: DataWorkflowStepKey;
    status?: DataWorkflowStepStatus;
    startedAt?: string | null;
    underlyingRunId?: number | null;
    underlyingRunKind?: string | null;
    recordsTotal?: number;
    recordsNew?: number;
    walletsTotal?: number;
    walletsDone?: number;
    walletsFailed?: number;
    warnings?: string[];
    error?: string | null;
    /** Stamps last_success_at to now -- callers pass this only when the step just reached a
     *  genuinely successful terminal state (`completed`/`completed_with_warnings`). */
    markSuccess?: boolean;
    markCompletedAt?: boolean;
    /** Clears timestamps when a previously terminal step is invalidated by new evidence. */
    clearLastSuccessAt?: boolean;
    clearCompletedAt?: boolean;
  },
): void => {
  const now = new Date().toISOString();
  const existing = database
    .prepare(
      `SELECT ${STEP_COLUMNS} FROM copytrade_data_workflow_steps WHERE run_id = ? AND step_key = ?`,
    )
    .get(options.runId, options.stepKey) as Parameters<typeof parseStep>[0] | undefined;
  if (!existing)
    throw new Error(`Unknown workflow step ${options.stepKey} for run ${options.runId}`);
  const current = parseStep(existing);
  database
    .prepare(
      `UPDATE copytrade_data_workflow_steps
       SET status = ?, started_at = ?, updated_at = ?, completed_at = ?, last_success_at = ?,
           underlying_run_id = ?, underlying_run_kind = ?, records_total = ?, records_new = ?,
           wallets_total = ?, wallets_done = ?, wallets_failed = ?, warnings_json = ?, error = ?
       WHERE run_id = ? AND step_key = ?`,
    )
    .run(
      options.status ?? current.status,
      options.startedAt !== undefined ? options.startedAt : current.startedAt,
      now,
      options.clearCompletedAt ? null : options.markCompletedAt ? now : current.completedAt,
      options.clearLastSuccessAt ? null : options.markSuccess ? now : current.lastSuccessAt,
      options.underlyingRunId !== undefined ? options.underlyingRunId : current.underlyingRunId,
      options.underlyingRunKind !== undefined
        ? options.underlyingRunKind
        : current.underlyingRunKind,
      options.recordsTotal ?? current.recordsTotal,
      options.recordsNew ?? current.recordsNew,
      options.walletsTotal ?? current.walletsTotal,
      options.walletsDone ?? current.walletsDone,
      options.walletsFailed ?? current.walletsFailed,
      JSON.stringify(options.warnings ?? current.warnings),
      options.error !== undefined ? options.error : current.error,
      options.runId,
      options.stepKey,
    );
};

/** Server-restart recovery for the Data workflow. Must run BEFORE `reconcileStaleFetchRuns`
 *  (fetch.ts) at startup: that reconciler blanket-fails every `copytrade_fetch_runs` row still
 *  `running`, which would otherwise look identical to a genuine failure. This function reads
 *  which underlying fetch runs were active first and marks the workflow/step `paused` with an
 *  explanatory message, so the eventual fetch-run failure is correctly read as "the process
 *  restarted mid-fetch, resume when ready" rather than "the fetch failed." Eager/startup-triggered
 *  (not the Activity Probe's lazy read-triggered equivalent) since a restart should self-heal
 *  proactively rather than wait for the next read. Returns the number of runs reconciled. */
export const reconcileStaleDataWorkflowRuns = (database: DatabaseSync): number => {
  const activeRuns = database
    .prepare(`SELECT id FROM copytrade_data_workflow_runs WHERE status = 'active'`)
    .all() as Array<{ id: number }>;
  const message =
    'Interrupted by a server restart; already-fetched wallets were kept. Resume to continue.';
  for (const { id: runId } of activeRuns) {
    const steps = readDataWorkflowSteps(database, runId);
    const runningStep = steps.find((step) => step.status === 'running');
    // An active run can be idle by design: the sequential Data workflow waits in this state
    // for the user to start its next manual step. Only an actually running step was interrupted
    // by restart and should be converted to paused.
    if (!runningStep) continue;
    updateDataWorkflowRunStatus(database, { runId, status: 'paused', error: message });
    if (runningStep) {
      updateDataWorkflowStep(database, {
        runId,
        stepKey: runningStep.stepKey,
        status: 'paused',
        error: message,
      });
    }
  }
  return activeRuns.length;
};
