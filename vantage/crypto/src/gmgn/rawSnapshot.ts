import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type RawSnapshotResult = { inserted: number; skipped: number; sourceSha256: string };

export const snapshotPayload = (rawPayload: unknown): { raw: string; sha256: string } => {
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    throw new Error('GMGN endpoint response must be a JSON object.');
  }
  const raw = JSON.stringify(rawPayload);
  if (!raw) throw new Error('GMGN endpoint response was empty.');
  return { raw, sha256: createHash('sha256').update(raw, 'utf8').digest('hex') };
};

export const insertByHash = (
  database: DatabaseSync,
  sql: string,
  values: (string | number | null)[],
  sha256: string,
): RawSnapshotResult => {
  const result = database.prepare(sql).run(...values);
  return { inserted: result.changes > 0 ? 1 : 0, skipped: result.changes > 0 ? 0 : 1, sourceSha256: sha256 };
};

export const asOptionalString = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;
