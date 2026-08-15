import type { DatabaseSync } from 'node:sqlite';
import { asOptionalString, insertByHash, snapshotPayload, type RawSnapshotResult } from './rawSnapshot.js';

export type TwitterStoreResult = { inserted: number; skipped: number; issues: string[] };

export const storeTwitterMessages = (database: DatabaseSync, input: { hasToken?: unknown; capturedAt: string; rawPayload: unknown }): TwitterStoreResult => {
  if (input.rawPayload === null || typeof input.rawPayload !== 'object' || Array.isArray(input.rawPayload)) throw new Error('GMGN Twitter response must be a JSON object.');
  const response = input.rawPayload as Record<string, unknown>;
  const messages = response.data;
  if (!Array.isArray(messages)) throw new Error('GMGN Twitter response data must be an array.');
  let inserted = 0;
  let skipped = 0;
  const issues: string[] = [];
  for (const message of messages) {
    const payload = message && typeof message === 'object' && !Array.isArray(message) ? message : null;
    if (!payload) { issues.push('twitter message is not a JSON object'); continue; }
    const tweetId = asOptionalString(payload.tweet_id ?? payload.tweetId ?? payload.id);
    const twType = asOptionalString(payload.tw_type ?? payload.twType);
    const sourceEventId = tweetId && asOptionalString(payload.id) ? `${tweetId}:${String(payload.id)}` : tweetId;
    const result = snapshotPayload(payload);
    const stored = insertByHash(database, `INSERT OR IGNORE INTO gmgn_twitter_messages (tweet_id, tw_type, has_token, captured_at, raw_payload, source_event_id, source_sha256) VALUES (?, ?, ?, ?, ?, ?, ?)`, [tweetId, twType, input.hasToken === true || input.hasToken === 'true' ? 1 : input.hasToken === false || input.hasToken === 'false' ? 0 : null, input.capturedAt, result.raw, sourceEventId, result.sha256], result.sha256);
    inserted += stored.inserted;
    skipped += stored.skipped;
  }
  return { inserted, skipped, issues };
};
