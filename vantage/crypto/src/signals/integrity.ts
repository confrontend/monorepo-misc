import type { DatabaseSync } from 'node:sqlite';
import { readDataQuality, type DataQuality } from './quality.js';
import { listGmgnArchives, gmgnArchiveDirectory } from '../gmgn/archives.js';

export interface SignalSourceBreakdown {
  source: string;
  count: number;
}

export interface SignalTypeBreakdown {
  signalType: string;
  count: number;
}

export interface TimestampCoverage {
  earliestObservedAt: string | null;
  latestObservedAt: string | null;
  earliestTriggerAt: string | null;
  latestTriggerAt: string | null;
}

export interface PollGap {
  pollId: number;
  gapStartAt: string;
  gapEndAt: string;
}

export interface PollIntegrity {
  totalPolls: number;
  completedPolls: number;
  failedPolls: number;
  incompletePolls: number;
  emptyPolls: number;
  pollsWithGaps: number;
  gaps: PollGap[];
}

export interface ProvenanceIntegrity {
  duneImportBatches: { total: number; completed: number; failed: number; archived: number };
  gmgnBrowserImportBatches: { total: number; completed: number; failed: number; archived: number };
  gmgnCaptureArchives: { total: number; verified: number; unverified: number };
}

export interface DuplicateIntegrity {
  pollRepeatedSignals: number;
  duneImportSkippedRows: number;
  browserImportSkippedSignals: number;
}

export interface BrowserCoverageWindow {
  id: number;
  batchId: number;
  startedAt: string;
  endedAt: string | null;
  lastHeartbeatAt: string;
  closedReason: string | null;
}

export interface BrowserCoverageIntegrity {
  totalWindows: number;
  openWindows: number;
  gapClosedWindows: number;
  totalCoveredSeconds: number;
  windows: BrowserCoverageWindow[];
}

export interface TokenSourceBreakdown {
  source: string;
  count: number;
}

export interface IntegrityReport {
  generatedAt: string;
  dataQuality: DataQuality;
  tokensBySource: TokenSourceBreakdown[];
  signals: {
    total: number;
    bySource: SignalSourceBreakdown[];
    byType: SignalTypeBreakdown[];
    timestampCoverage: TimestampCoverage;
  };
  duplicates: DuplicateIntegrity;
  polls: PollIntegrity;
  browserCoverage: BrowserCoverageIntegrity;
  provenance: ProvenanceIntegrity;
}

// Distinguishes the original Dune cohort export from later targeted enrichment lookups —
// both land in the same `tokens` table (so cohort matching keeps working unmodified), but
// provenance must stay visible rather than being silently blended.
const readTokensBySource = (database: DatabaseSync): TokenSourceBreakdown[] =>
  (
    database
      .prepare(
        `
    SELECT COALESCE(source, 'unknown') AS source, COUNT(*) AS count
    FROM tokens GROUP BY source ORDER BY count DESC
  `,
      )
      .all() as unknown as TokenSourceBreakdown[]
  ).map((row) => ({ ...row }));

const readSignalsBySource = (database: DatabaseSync): SignalSourceBreakdown[] =>
  (
    database
      .prepare(
        `
    SELECT COALESCE(source, 'unknown') AS source, COUNT(*) AS count
    FROM gmgn_signals GROUP BY source ORDER BY count DESC
  `,
      )
      .all() as unknown as SignalSourceBreakdown[]
  ).map((row) => ({ ...row }));

const readSignalsByType = (database: DatabaseSync): SignalTypeBreakdown[] =>
  (
    database
      .prepare(
        `
    SELECT COALESCE(signal_type, 'unknown') AS signalType, COUNT(*) AS count
    FROM gmgn_signals GROUP BY signal_type ORDER BY count DESC
  `,
      )
      .all() as unknown as SignalTypeBreakdown[]
  ).map((row) => ({ ...row }));

const readTimestampCoverage = (database: DatabaseSync): TimestampCoverage => {
  const row = database
    .prepare(
      `
    SELECT
      MIN(observed_at) AS earliestObservedAt,
      MAX(observed_at) AS latestObservedAt,
      MIN(trigger_at) AS earliestTriggerAt,
      MAX(trigger_at) AS latestTriggerAt
    FROM gmgn_signals
  `,
    )
    .get() as unknown as TimestampCoverage;
  return { ...row };
};

const readDuplicates = (database: DatabaseSync): DuplicateIntegrity => {
  const row = database
    .prepare(
      `
    SELECT
      (SELECT COALESCE(SUM(repeated_count), 0) FROM gmgn_polls) AS pollRepeatedSignals,
      (SELECT COALESCE(SUM(skipped_count), 0) FROM dune_import_batches) AS duneImportSkippedRows,
      (SELECT COALESCE(SUM(skipped_count), 0) FROM gmgn_browser_import_batches) AS browserImportSkippedSignals
  `,
    )
    .get() as unknown as DuplicateIntegrity;
  return { ...row };
};

const readPollIntegrity = (database: DatabaseSync): PollIntegrity => {
  const totals = database
    .prepare(
      `
    SELECT
      COUNT(*) AS totalPolls,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedPolls,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedPolls,
      SUM(CASE WHEN status = 'started' THEN 1 ELSE 0 END) AS incompletePolls,
      SUM(CASE WHEN status = 'completed' AND received_count = 0 THEN 1 ELSE 0 END) AS emptyPolls,
      SUM(CASE WHEN gap_start_at IS NOT NULL THEN 1 ELSE 0 END) AS pollsWithGaps
    FROM gmgn_polls
  `,
    )
    .get() as Omit<PollIntegrity, 'gaps'>;

  const gaps = (
    database
      .prepare(
        `
    SELECT id AS pollId, gap_start_at AS gapStartAt, gap_end_at AS gapEndAt
    FROM gmgn_polls WHERE gap_start_at IS NOT NULL ORDER BY id DESC
  `,
      )
      .all() as unknown as PollGap[]
  ).map((row) => ({ ...row }));

  return {
    totalPolls: totals.totalPolls ?? 0,
    completedPolls: totals.completedPolls ?? 0,
    failedPolls: totals.failedPolls ?? 0,
    incompletePolls: totals.incompletePolls ?? 0,
    emptyPolls: totals.emptyPolls ?? 0,
    pollsWithGaps: totals.pollsWithGaps ?? 0,
    gaps,
  };
};

// A window only proves continuous coverage between its heartbeats; the effective covered span
// is (endedAt or, for a window still open, its last known heartbeat) minus startedAt, never
// projected forward to "now" — an open window with a stale heartbeat is not assumed to still
// be covering the present moment.
const readBrowserCoverage = (database: DatabaseSync): BrowserCoverageIntegrity => {
  const totals = database
    .prepare(
      `
    SELECT
      COUNT(*) AS totalWindows,
      SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END) AS openWindows,
      SUM(CASE WHEN closed_reason IS NOT NULL THEN 1 ELSE 0 END) AS gapClosedWindows,
      COALESCE(SUM((julianday(COALESCE(ended_at, last_heartbeat_at)) - julianday(started_at)) * 86400), 0) AS totalCoveredSeconds
    FROM gmgn_browser_coverage_windows
  `,
    )
    .get() as Omit<BrowserCoverageIntegrity, 'windows'>;

  const windows = (
    database
      .prepare(
        `
    SELECT id, batch_id AS batchId, started_at AS startedAt, ended_at AS endedAt,
      last_heartbeat_at AS lastHeartbeatAt, closed_reason AS closedReason
    FROM gmgn_browser_coverage_windows ORDER BY id DESC LIMIT 500
  `,
      )
      .all() as unknown as BrowserCoverageWindow[]
  ).map((row) => ({ ...row }));

  return {
    totalWindows: totals.totalWindows ?? 0,
    openWindows: totals.openWindows ?? 0,
    gapClosedWindows: totals.gapClosedWindows ?? 0,
    totalCoveredSeconds: Math.round((totals.totalCoveredSeconds ?? 0) * 100) / 100,
    windows,
  };
};

const readImportBatchProvenance = (
  database: DatabaseSync,
  table: 'dune_import_batches' | 'gmgn_browser_import_batches',
): { total: number; completed: number; failed: number; archived: number } => {
  const row = database
    .prepare(
      `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN archive_path IS NOT NULL THEN 1 ELSE 0 END) AS archived
    FROM ${table}
  `,
    )
    .get() as { total: number; completed: number; failed: number; archived: number };
  return { ...row };
};

/**
 * Reports whether captured data is complete, consistent, and auditable. Never scores or
 * labels a signal as financially good or bad — that judgment belongs to the research contract.
 */
export const readIntegrityReport = (
  database: DatabaseSync,
  options: { archiveDirectory?: string; now?: () => Date } = {},
): IntegrityReport => {
  const now = options.now ?? (() => new Date());
  const dataQuality = readDataQuality(database);
  const gmgnArchives = listGmgnArchives(options.archiveDirectory ?? gmgnArchiveDirectory);

  return {
    generatedAt: now().toISOString(),
    dataQuality,
    tokensBySource: readTokensBySource(database),
    signals: {
      total: dataQuality.signalCount,
      bySource: readSignalsBySource(database),
      byType: readSignalsByType(database),
      timestampCoverage: readTimestampCoverage(database),
    },
    duplicates: readDuplicates(database),
    polls: readPollIntegrity(database),
    browserCoverage: readBrowserCoverage(database),
    provenance: {
      duneImportBatches: readImportBatchProvenance(database, 'dune_import_batches'),
      gmgnBrowserImportBatches: readImportBatchProvenance(database, 'gmgn_browser_import_batches'),
      gmgnCaptureArchives: {
        total: gmgnArchives.length,
        verified: gmgnArchives.filter((archive) => archive.verified).length,
        unverified: gmgnArchives.filter((archive) => !archive.verified).length,
      },
    },
  };
};
