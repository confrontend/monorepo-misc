import type { DatabaseSync } from 'node:sqlite';
import { asOptionalString, insertByHash, snapshotPayload, type RawSnapshotResult } from './rawSnapshot.js';

export const storeWalletRankSnapshot = (database: DatabaseSync, input: { window?: unknown; orderby?: unknown; capturedAt: string; rawPayload: unknown }): RawSnapshotResult => {
  const { raw, sha256 } = snapshotPayload(input.rawPayload);
  return insertByHash(database, `INSERT OR IGNORE INTO gmgn_wallet_rank_snapshots (window, orderby, captured_at, raw_payload, source_sha256) VALUES (?, ?, ?, ?, ?)`, [asOptionalString(input.window), asOptionalString(input.orderby), input.capturedAt, raw, sha256], sha256);
};
