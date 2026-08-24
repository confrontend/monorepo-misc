import type { DatabaseSync } from 'node:sqlite';
import {
  asOptionalString,
  insertByHash,
  snapshotPayload,
  type RawSnapshotResult,
} from './rawSnapshot.js';

export const storeRadarSnapshot = (
  database: DatabaseSync,
  input: {
    chain?: unknown;
    period?: unknown;
    category?: unknown;
    capturedAt: string;
    rawPayload: unknown;
  },
): RawSnapshotResult => {
  const { raw, sha256 } = snapshotPayload(input.rawPayload);
  return insertByHash(
    database,
    `INSERT OR IGNORE INTO gmgn_radar_snapshots (chain, period, category, captured_at, raw_payload, source_sha256) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      asOptionalString(input.chain),
      asOptionalString(input.period),
      asOptionalString(input.category),
      input.capturedAt,
      raw,
      sha256,
    ],
    sha256,
  );
};
