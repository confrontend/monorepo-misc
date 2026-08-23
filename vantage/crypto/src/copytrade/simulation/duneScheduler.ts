import type { DatabaseSync } from 'node:sqlite';

export const DEFAULT_DUNE_ACCOUNT_LIMIT = 3;
export const DEFAULT_DUNE_SAFETY_MARGIN = 1;
export const DUNE_CAPACITY_POLL_MS = 5_000;

// Capacity checks and execution submission must be one critical section. Without this,
// two simultaneous Measure requests can both observe a free slot and submit together.
let submissionTail: Promise<void> = Promise.resolve();

export const withDuneSubmissionLock = async <T>(work: () => Promise<T>): Promise<T> => {
  const previous = submissionTail;
  let release!: () => void;
  submissionTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await work(); }
  finally { release(); }
};

export const configuredSafetyMargin = (): number => {
  const value = Number(process.env.DUNE_CONCURRENCY_SAFETY_MARGIN ?? DEFAULT_DUNE_SAFETY_MARGIN);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_DUNE_SAFETY_MARGIN;
};

export const allowedApplicationExecutions = (reportedLimit: number | null, margin = configuredSafetyMargin()): number => {
  const limit = reportedLimit && Number.isFinite(reportedLimit) && reportedLimit > 0 ? Math.floor(reportedLimit) : DEFAULT_DUNE_ACCOUNT_LIMIT;
  return Math.max(1, limit - Math.max(0, Math.floor(margin)));
};

export const activeExecutionCount = (states: readonly string[]): number => states.filter((state) => state === 'submitted' || state === 'running' || state === 'timed_out').length;

export const canSubmitExecution = (active: number, reportedLimit: number | null, margin = configuredSafetyMargin()): boolean => active < allowedApplicationExecutions(reportedLimit, margin);

export const latestReportedLimit = (database: DatabaseSync): number | null => {
  const row = database.prepare(`SELECT value FROM (
      SELECT dune_max_inflight_interactive_executions AS value, id FROM copytrade_copy_simulation_runs
      WHERE dune_max_inflight_interactive_executions IS NOT NULL
      UNION ALL
      SELECT dune_max_inflight_interactive_executions AS value, id FROM dune_outcome_runs
      WHERE dune_max_inflight_interactive_executions IS NOT NULL
    ) ORDER BY id DESC LIMIT 1`).get() as { value: number | null } | undefined;
  return row?.value ?? null;
};

export const activeDuneExecutionCount = (database: DatabaseSync): number => {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT id FROM copytrade_copy_simulation_runs WHERE status IN ('submitted', 'running', 'timed_out')
      UNION ALL
      SELECT id FROM dune_outcome_runs WHERE status IN ('submitted', 'running', 'timed_out')
    )`).get() as { count: number };
  return Number(row.count ?? 0);
};

export const waitForDuneCapacity = async (
  database: DatabaseSync,
  options: { shouldStop?: () => boolean; reconcile?: () => Promise<void>; onCapacity?: (info: { active: number; limit: number; margin: number }) => void; pollMs?: number } = {},
): Promise<void> => {
  const margin = configuredSafetyMargin();
  for (;;) {
    if (options.shouldStop?.()) throw new Error('Stopped while waiting for Dune capacity.');
    const limit = allowedApplicationExecutions(latestReportedLimit(database), margin);
    const active = activeDuneExecutionCount(database);
    options.onCapacity?.({ active, limit, margin });
    if (active < limit) return;
    await options.reconcile?.();
    if (activeDuneExecutionCount(database) < limit) return;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? DUNE_CAPACITY_POLL_MS));
  }
};
