import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { asOptionalString, insertByHash, snapshotPayload, type RawSnapshotResult } from './rawSnapshot.js';

export const storeWalletRankSnapshot = (database: DatabaseSync, input: { window?: unknown; orderby?: unknown; capturedAt: string; rawPayload: unknown; requestPath?: unknown; requestQuery?: unknown }): RawSnapshotResult => {
  const { raw, sha256 } = snapshotPayload(input.rawPayload);
  const window = asOptionalString(input.window);
  const orderby = asOptionalString(input.orderby);
  const result = insertByHash(database, `INSERT OR IGNORE INTO gmgn_wallet_rank_snapshots (window, orderby, captured_at, raw_payload, source_sha256) VALUES (?, ?, ?, ?, ?)`, [window, orderby, input.capturedAt, raw, sha256], sha256);

  // The response body can be byte-identical under two different GMGN filters. The normalized
  // snapshot table deduplicates that body by source_sha256, so request provenance is a separate
  // append-only observation keyed by capture time + exact request context + response hash.
  const snapshot = database.prepare(
    `SELECT id FROM gmgn_wallet_rank_snapshots WHERE source_sha256 = ?`,
  ).get(sha256) as { id: number };
  const requestPath = asOptionalString(input.requestPath);
  const query = input.requestQuery && typeof input.requestQuery === 'object' && !Array.isArray(input.requestQuery)
    ? input.requestQuery as Record<string, unknown>
    : {};
  const requestQueryJson = JSON.stringify(query);
  const captureSha256 = createHash('sha256').update(JSON.stringify({
    snapshotId: snapshot.id, capturedAt: input.capturedAt, requestPath, requestQueryJson,
  }), 'utf8').digest('hex');
  database.prepare(
    `INSERT OR IGNORE INTO gmgn_wallet_rank_capture_provenance
       (snapshot_id, captured_at, request_path, request_query_json, window, orderby, capture_sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(snapshot.id, input.capturedAt, requestPath, requestQueryJson, window, orderby, captureSha256);
  return result;
};
