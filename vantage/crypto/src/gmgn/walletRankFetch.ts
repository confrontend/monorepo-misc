import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storeWalletRankSnapshot } from './walletRank.js';
import { waitForGmgnRequest } from './rateLimit.js';

export type WalletRankRefreshResult = {
  snapshotId: number;
  capturedAt: string;
  walletCount: number;
  inserted: boolean;
  responseStatus: number;
  live: boolean;
  fallbackReason?: string;
  joinedWallets: string[];
  leftWallets: string[];
  requestQuery: { orderby: string; min_winrate_30d?: string; limit: string };
};

export const RESEARCH_RANK_ORDERBY = 'pnl_30d';
export const RESEARCH_RANK_MIN_WINRATE_30D = 0.5;

const DEFAULT_RANK_PATH = '/api/v1/rank/sol/wallets/7d';
const readRankApiKey = (): string => {
  const env = process.env.GMGN_API_KEY?.trim();
  if (env) return env;
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, 'package.json'))) {
      const file = path.join(current, '.secrets', 'gmgn', 'gmgn-api-key.txt');
      try { return readFileSync(file, 'utf8').trim(); } catch { return ''; }
    }
    current = path.dirname(current);
  }
  return '';
};

const rankItems = (payload: unknown): unknown[] => {
  const root = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown> : {};
  const data = root.data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const nested = (data as Record<string, unknown>).rank ?? (data as Record<string, unknown>).list;
    if (Array.isArray(nested)) return nested;
  }
  const rank = root.rank ?? root.list;
  return Array.isArray(rank) ? rank : [];
};

const walletAddresses = (payload: unknown, limit: number): string[] => rankItems(payload)
  .slice(0, limit)
  .map((item) => item && typeof item === 'object'
    ? (typeof (item as Record<string, unknown>).wallet_address === 'string'
      ? (item as Record<string, unknown>).wallet_address as string
      : typeof (item as Record<string, unknown>).address === 'string'
        ? (item as Record<string, unknown>).address as string
        : null)
    : null)
  .filter((wallet): wallet is string => Boolean(wallet));

const latestRosterAddresses = (database: DatabaseSync, limit: number): string[] => {
  const row = database.prepare(
    `SELECT raw_payload AS rawPayload FROM gmgn_wallet_rank_snapshots ORDER BY captured_at DESC, id DESC LIMIT 1`,
  ).get() as { rawPayload: string } | undefined;
  if (!row) return [];
  try { return walletAddresses(JSON.parse(row.rawPayload), limit); } catch { return []; }
};

const readSavedRankSnapshot = (database: DatabaseSync, orderby: string, limit: number, reason: string): WalletRankRefreshResult | null => {
  const fallback = database.prepare(
    `SELECT id, captured_at AS capturedAt, raw_payload AS rawPayload
     FROM gmgn_wallet_rank_snapshots ORDER BY captured_at DESC, id DESC LIMIT 1`,
  ).get() as { id: number; capturedAt: string; rawPayload: string } | undefined;
  if (!fallback) return null;
  let payload: unknown;
  try { payload = JSON.parse(fallback.rawPayload); } catch { return null; }
  const walletCount = rankItems(payload).filter((item) => item && typeof item === 'object').length;
  if (walletCount === 0) return null;
  return {
    snapshotId: fallback.id, capturedAt: fallback.capturedAt, walletCount: Math.min(walletCount, limit),
    inserted: false, responseStatus: 0, live: false, fallbackReason: reason,
    joinedWallets: [], leftWallets: [],
    requestQuery: { orderby, limit: String(limit) },
  };
};

/**
 * Fetches the current GMGN wallet leaderboard through the isolated rank endpoint.
 * The response is stored verbatim as an append-only snapshot; no old snapshot or stats row
 * is overwritten. This endpoint is intentionally separate from the official CLI stats calls.
 */
export const refreshCurrentWalletRank = async (
  database: DatabaseSync,
  options: { limit?: number; chain?: string; orderby?: string; minWinrate30d?: number; useSavedSnapshot?: boolean } = {},
): Promise<WalletRankRefreshResult> => {
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 100)));
  const chain = options.chain ?? 'sol';
  const orderby = options.orderby ?? RESEARCH_RANK_ORDERBY;
  const path = process.env.GMGN_RANK_PATH ?? DEFAULT_RANK_PATH.replace('/sol/', `/${chain}/`);
  const url = new URL(`https://gmgn.ai${path}`);
  url.searchParams.set('orderby', orderby);
  url.searchParams.set('limit', String(limit));
  if (options.minWinrate30d !== undefined) url.searchParams.set('min_winrate_30d', String(options.minWinrate30d));
  const apiKey = readRankApiKey();
  if (!apiKey) throw new Error('GMGN API key not found. Add it to .secrets/gmgn/gmgn-api-key.txt.');

  const previousWallets = latestRosterAddresses(database, limit);

  await waitForGmgnRequest();
  const capturedAt = new Date().toISOString();
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'x-api-key': apiKey,
        authorization: `Bearer ${apiKey}`,
        'user-agent': 'vantage-crypto-research/1.0',
      },
    });
  } catch (error) {
    const reason = `Live GMGN rank request failed (${error instanceof Error ? error.message : String(error)}); user approved the saved snapshot.`;
    const fallback = options.useSavedSnapshot ? readSavedRankSnapshot(database, orderby, limit, reason) : null;
    if (fallback) return fallback;
    throw error;
  }
  const text = await response.text();
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { payload = { raw_text: text }; }
  if (!response.ok) {
    // The rank page is a GMGN web endpoint and may reject API-key authentication with 403.
    // Never substitute a saved snapshot silently; the UI must obtain explicit approval first.
    if (response.status === 403 && options.useSavedSnapshot) {
      const fallback = readSavedRankSnapshot(database, orderby, limit, `Live GMGN rank request returned HTTP 403; user approved the saved snapshot.`);
      if (fallback) return { ...fallback, responseStatus: response.status };
    }
    throw new Error(`GMGN leaderboard request failed (HTTP ${response.status}).`);
  }
  const count = rankItems(payload).filter((item) => item && typeof item === 'object').length;
  if (count === 0) throw new Error('GMGN leaderboard response contained no wallet rows; no snapshot was stored.');

  const result = storeWalletRankSnapshot(database, {
    window: orderby.match(/_(\d+[a-z]+)$/i)?.[1] ?? '30d',
    orderby,
    capturedAt,
    rawPayload: payload,
    requestPath: path,
    requestQuery: Object.fromEntries(url.searchParams.entries()),
  });
  const row = database.prepare('SELECT id FROM gmgn_wallet_rank_snapshots WHERE source_sha256 = ?').get(result.sourceSha256) as { id: number };
  const currentWallets = walletAddresses(payload, limit);
  const previousSet = new Set(previousWallets);
  const currentSet = new Set(currentWallets);
  return {
    snapshotId: row.id, capturedAt, walletCount: count, inserted: result.inserted > 0,
    responseStatus: response.status, live: true,
    joinedWallets: currentWallets.filter((wallet) => !previousSet.has(wallet)),
    leftWallets: previousWallets.filter((wallet) => !currentSet.has(wallet)),
    requestQuery: Object.fromEntries(url.searchParams.entries()) as WalletRankRefreshResult['requestQuery'],
  };
};
