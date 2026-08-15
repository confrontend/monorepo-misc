import type { DatabaseSync } from 'node:sqlite';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const clampLimit = (limit?: number): number => {
  if (!Number.isFinite(limit) || !limit || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
};

export type RadarSnapshotRow = { id: number; chain: string | null; period: string | null; category: string | null; capturedAt: string; rawPayload: unknown };
export type WalletRankSnapshotRow = { id: number; window: string | null; orderby: string | null; capturedAt: string; rawPayload: unknown };
export type SmartMoneyWalletStatRow = { id: number; walletAddress: string; chain: string | null; capturedAt: string; rawPayload: unknown };
export type TwitterMessageRow = { id: number; tweetId: string | null; twType: string | null; hasToken: boolean | null; capturedAt: string; rawPayload: unknown };

const parseRawPayload = (raw: string): unknown => { try { return JSON.parse(raw); } catch { return null; } };

export const listRadarSnapshots = (database: DatabaseSync, limit?: number): RadarSnapshotRow[] => {
  const rows = database.prepare(`SELECT id, chain, period, category, captured_at AS capturedAt, raw_payload AS rawPayload FROM gmgn_radar_snapshots ORDER BY id DESC LIMIT ?`).all(clampLimit(limit)) as unknown as Array<{ id: number; chain: string | null; period: string | null; category: string | null; capturedAt: string; rawPayload: string }>;
  return rows.map((row) => ({ ...row, rawPayload: parseRawPayload(row.rawPayload) }));
};

export const listWalletRankSnapshots = (database: DatabaseSync, limit?: number): WalletRankSnapshotRow[] => {
  const rows = database.prepare(`SELECT id, window, orderby, captured_at AS capturedAt, raw_payload AS rawPayload FROM gmgn_wallet_rank_snapshots ORDER BY id DESC LIMIT ?`).all(clampLimit(limit)) as unknown as Array<{ id: number; window: string | null; orderby: string | null; capturedAt: string; rawPayload: string }>;
  return rows.map((row) => ({ ...row, rawPayload: parseRawPayload(row.rawPayload) }));
};

// Optionally filterable by wallet — this is the one raw-endpoint table where the same entity is
// captured repeatedly over time (append-only, no dedup), so "show me this wallet's history" is
// a meaningful query, unlike the other three tables where only the latest snapshots matter.
export const listSmartMoneyWalletStats = (database: DatabaseSync, walletAddress?: string, limit?: number): SmartMoneyWalletStatRow[] => {
  const rows = walletAddress
    ? database.prepare(`SELECT id, wallet_address AS walletAddress, chain, captured_at AS capturedAt, raw_payload AS rawPayload FROM gmgn_smartmoney_wallet_stats WHERE wallet_address = ? ORDER BY id DESC LIMIT ?`).all(walletAddress, clampLimit(limit))
    : database.prepare(`SELECT id, wallet_address AS walletAddress, chain, captured_at AS capturedAt, raw_payload AS rawPayload FROM gmgn_smartmoney_wallet_stats ORDER BY id DESC LIMIT ?`).all(clampLimit(limit));
  return (rows as unknown as Array<{ id: number; walletAddress: string; chain: string | null; capturedAt: string; rawPayload: string }>).map((row) => ({ ...row, rawPayload: parseRawPayload(row.rawPayload) }));
};

export const listTwitterMessages = (database: DatabaseSync, limit?: number): TwitterMessageRow[] => {
  const rows = database.prepare(`SELECT id, tweet_id AS tweetId, tw_type AS twType, has_token AS hasTokenRaw, captured_at AS capturedAt, raw_payload AS rawPayload FROM gmgn_twitter_messages ORDER BY id DESC LIMIT ?`).all(clampLimit(limit)) as unknown as Array<{ id: number; tweetId: string | null; twType: string | null; hasTokenRaw: number | null; capturedAt: string; rawPayload: string }>;
  return rows.map((row) => ({ id: row.id, tweetId: row.tweetId, twType: row.twType, hasToken: row.hasTokenRaw === null ? null : row.hasTokenRaw === 1, capturedAt: row.capturedAt, rawPayload: parseRawPayload(row.rawPayload) }));
};

export type RawEndpointSummary = {
  radar: { count: number; latestCapturedAt: string | null };
  walletRank: { count: number; latestCapturedAt: string | null };
  smartMoney: { count: number; latestCapturedAt: string | null };
  twitter: { count: number; latestCapturedAt: string | null };
};

const summarizeTable = (database: DatabaseSync, table: string): { count: number; latestCapturedAt: string | null } => {
  const row = database.prepare(`SELECT COUNT(*) AS count, MAX(captured_at) AS latestCapturedAt FROM ${table}`).get() as { count: number; latestCapturedAt: string | null };
  return { count: row.count, latestCapturedAt: row.latestCapturedAt };
};

export const readRawEndpointSummary = (database: DatabaseSync): RawEndpointSummary => ({
  radar: summarizeTable(database, 'gmgn_radar_snapshots'),
  walletRank: summarizeTable(database, 'gmgn_wallet_rank_snapshots'),
  smartMoney: summarizeTable(database, 'gmgn_smartmoney_wallet_stats'),
  twitter: summarizeTable(database, 'gmgn_twitter_messages'),
});
