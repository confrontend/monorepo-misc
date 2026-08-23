import type { DatabaseSync } from 'node:sqlite';
import { redactDiagnosticValue, redactSensitiveText } from '../security/redaction.js';

export type DiagnosticLevel = 'info' | 'warn' | 'error';

export interface DiagnosticLogEntry {
  level: DiagnosticLevel;
  event: string;
  method?: string | null;
  path?: string | null;
  status?: number | null;
  durationMs?: number | null;
  requestBytes?: number | null;
  message?: string | null;
  detail?: unknown;
}

export interface StoredDiagnosticLog {
  id: number;
  createdAt: string;
  level: DiagnosticLevel;
  event: string;
  method: string | null;
  path: string | null;
  status: number | null;
  durationMs: number | null;
  requestBytes: number | null;
  message: string | null;
  detail: string | null;
}

/**
 * Never throws: a broken diagnostic write must not take down the request it is describing.
 */
export const logDiagnostic = (database: DatabaseSync, entry: DiagnosticLogEntry): void => {
  try {
    database.prepare(`
      INSERT INTO diagnostic_logs
        (created_at, level, event, method, path, status, duration_ms, request_bytes, message, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      new Date().toISOString(),
      entry.level,
      entry.event,
      entry.method ?? null,
      entry.path ?? null,
      entry.status ?? null,
      entry.durationMs ?? null,
      entry.requestBytes ?? null,
      entry.message === undefined || entry.message === null ? null : redactSensitiveText(entry.message),
      entry.detail === undefined ? null : redactDiagnosticValue(entry.detail),
    );
  } catch (error) {
    console.error('[diagnostics] failed to write log entry:', error instanceof Error ? error.message : error);
  }
};

export const readRecentDiagnostics = (database: DatabaseSync, limit = 100): StoredDiagnosticLog[] =>
  database.prepare(`
    SELECT id, created_at AS createdAt, level, event, method, path, status,
           duration_ms AS durationMs, request_bytes AS requestBytes, message, detail
    FROM diagnostic_logs
    ORDER BY id DESC
    LIMIT ?
  `).all(limit) as unknown as StoredDiagnosticLog[];
