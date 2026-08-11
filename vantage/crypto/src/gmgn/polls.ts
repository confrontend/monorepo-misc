import type { DatabaseSync } from 'node:sqlite';
import { redactSensitiveText } from '../security/redaction.js';

export type PollBounds = { oldestTriggerAt: string | null; newestTriggerAt: string | null };

export const triggerBounds = (events: unknown[]): PollBounds => {
  const timestamps = events.flatMap((event) => {
    if (!event || typeof event !== 'object') return [];
    const value = (event as Record<string, unknown>).trigger_at;
    if (typeof value !== 'number' && typeof value !== 'string') return [];
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return [];
    const date = new Date(Math.abs(numeric) < 100_000_000_000 ? numeric * 1000 : numeric);
    return Number.isNaN(date.getTime()) ? [] : [date.toISOString()];
  }).sort();
  return { oldestTriggerAt: timestamps[0] ?? null, newestTriggerAt: timestamps.at(-1) ?? null };
};

export const previousNewestTriggerAt = (database: DatabaseSync): string | null => {
  const row = database.prepare(`
    SELECT newest_trigger_at AS newestTriggerAt
    FROM gmgn_polls WHERE status = 'completed' AND newest_trigger_at IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get() as { newestTriggerAt: string | null } | undefined;
  return row?.newestTriggerAt ?? null;
};

export const startGmgnPoll = (database: DatabaseSync, input: { startedAt: string; source: string; chain: string; cliVersion: string }): number => {
  const result = database.prepare(`
    INSERT INTO gmgn_polls (poll_started_at, source, chain, cli_version, status, created_at)
    VALUES (?, ?, ?, ?, 'started', ?)
  `).run(input.startedAt, input.source, input.chain, input.cliVersion, input.startedAt);
  return Number(result.lastInsertRowid);
};

export const completeGmgnPoll = (database: DatabaseSync, pollId: number, input: {
  completedAt: string; received: number; stored: number; repeated: number; errors: number;
  bounds: PollBounds; previousNewest: string | null; archivePath: string; archiveSha256: string;
}): void => {
  const gap = input.previousNewest && input.bounds.oldestTriggerAt && input.bounds.oldestTriggerAt > input.previousNewest;
  database.prepare(`
    UPDATE gmgn_polls SET poll_completed_at = ?, status = 'completed', received_count = ?,
      stored_count = ?, repeated_count = ?, error_count = ?, oldest_trigger_at = ?,
      newest_trigger_at = ?, previous_newest_trigger_at = ?, gap_start_at = ?, gap_end_at = ?,
      archive_path = ?, archive_sha256 = ? WHERE id = ?
  `).run(input.completedAt, input.received, input.stored, input.repeated, input.errors,
    input.bounds.oldestTriggerAt, input.bounds.newestTriggerAt, input.previousNewest,
    gap ? input.previousNewest : null, gap ? input.bounds.oldestTriggerAt : null,
    input.archivePath, input.archiveSha256, pollId);
};

export const failGmgnPoll = (database: DatabaseSync, pollId: number, completedAt: string, error: unknown): void => {
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
  database.prepare(`
    UPDATE gmgn_polls SET poll_completed_at = ?, status = 'failed', error_message = ? WHERE id = ?
  `).run(completedAt, message, pollId);
};
