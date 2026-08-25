import type { DatabaseSync } from 'node:sqlite';
import type { PatternDiscoveryProgress } from './patternDiscoveryRunner.js';

export type StoredPatternDiscoveryRun = {
  id: number;
  periodDays: number;
  minN: number;
  workerPid: number | null;
  progress: PatternDiscoveryProgress;
  error: string | null;
};

type StoredRunRow = {
  id: number;
  periodDays: number;
  minN: number;
  workerPid: number | null;
  progressJson: string;
  error: string | null;
};

const parseProgress = (raw: string): PatternDiscoveryProgress =>
  JSON.parse(raw) as PatternDiscoveryProgress;

export const startPatternDiscoveryRun = (
  database: DatabaseSync,
  periodDays: number,
  minN: number,
  progress: PatternDiscoveryProgress,
): number => {
  const result = database
    .prepare(
      `INSERT INTO copytrade_pattern_discovery_runs
       (period_days, minimum_n, status, progress_json, started_at, heartbeat_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      periodDays,
      minN,
      progress.status,
      JSON.stringify(progress),
      progress.startedAt,
      progress.heartbeatAt ?? progress.startedAt,
    );
  return Number(result.lastInsertRowid);
};

export const updatePatternDiscoveryRun = (
  database: DatabaseSync,
  runId: number,
  progress: PatternDiscoveryProgress,
  options: { workerPid?: number | null; error?: string | null } = {},
): void => {
  database
    .prepare(
      `UPDATE copytrade_pattern_discovery_runs
       SET status = ?, progress_json = ?, worker_pid = COALESCE(?, worker_pid),
           heartbeat_at = ?, completed_at = ?, error = ?
       WHERE id = ?`,
    )
    .run(
      progress.status,
      JSON.stringify(progress),
      options.workerPid ?? null,
      progress.heartbeatAt ?? new Date().toISOString(),
      progress.completedAt,
      options.error ?? null,
      runId,
    );
};

export const readLatestPatternDiscoveryRun = (
  database: DatabaseSync,
): StoredPatternDiscoveryRun | null => {
  const row = database
    .prepare(
      `SELECT id, period_days AS periodDays, minimum_n AS minN,
              worker_pid AS workerPid, progress_json AS progressJson, error
       FROM copytrade_pattern_discovery_runs
       ORDER BY id DESC LIMIT 1`,
    )
    .get() as StoredRunRow | undefined;
  return row ? { ...row, progress: parseProgress(row.progressJson) } : null;
};

export const markInterruptedPatternDiscoveryRuns = (database: DatabaseSync): number => {
  const rows = database
    .prepare(
      `SELECT id, progress_json AS progressJson
       FROM copytrade_pattern_discovery_runs
       WHERE status IN ('preparing', 'running')`,
    )
    .all() as unknown as Array<{ id: number; progressJson: string }>;
  const now = new Date().toISOString();
  for (const row of rows) {
    const previous = parseProgress(row.progressJson);
    const progress: PatternDiscoveryProgress = {
      ...previous,
      status: 'stopped',
      stage: 'stopped',
      message:
        'The server restarted during discovery. Completed coverage levels remain cached; Run resumes missing levels.',
      heartbeatAt: now,
      completedAt: now,
      activeThresholds: [],
      cpuWorkersActive: 0,
    };
    updatePatternDiscoveryRun(database, row.id, progress, {
      error: 'Interrupted by server restart.',
    });
  }
  return rows.length;
};
