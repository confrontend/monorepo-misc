import type { DatabaseSync } from 'node:sqlite';
import { WALLET_FEATURE_ENGINE_VERSION } from './walletFeatureDefinitions.js';
import {
  currentWalletFeaturesFromSnapshot,
  currentWalletFeatureValueMap,
  WalletFeatureAccumulator,
} from './walletFeatureEngine.js';
import {
  readWalletFeatureSnapshotsBatch,
  type WalletFeatureQuality,
  type WalletFeatureSnapshot,
} from './walletFeatureReader.js';
import {
  writeWalletFeatureSnapshot,
  type WriteWalletFeatureSnapshotResult,
} from './walletFeatureSnapshots.js';

const WALLET_QUERY_CHUNK = 200;
const SECONDS_PER_DAY = 24 * 60 * 60;

export type GenerateWalletFeatureCalendarSnapshotsRequest = {
  walletAddresses: string[];
  asOfTimestamp: string;
  lookbackDays: number | null;
  chain: string;
  triggerKind: 'calendar' | 'current';
  createdAt?: string;
};

export type GeneratedWalletFeatureCalendarSnapshot = WriteWalletFeatureSnapshotResult;

const chunked = <T>(values: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

const normalizeRequest = (
  request: GenerateWalletFeatureCalendarSnapshotsRequest,
): GenerateWalletFeatureCalendarSnapshotsRequest & {
  cutoffSeconds: number;
  requestedWindowStart: string | null;
} => {
  const cutoffMilliseconds = Date.parse(request.asOfTimestamp);
  if (!Number.isFinite(cutoffMilliseconds)) {
    throw new Error(`Invalid wallet feature snapshot cutoff: ${request.asOfTimestamp}`);
  }
  if (
    request.lookbackDays !== null &&
    (!Number.isInteger(request.lookbackDays) || request.lookbackDays <= 0)
  ) {
    throw new RangeError('lookbackDays must be a positive integer or null.');
  }
  const chain = request.chain.trim();
  if (!chain) throw new Error('chain is required for wallet feature snapshot generation.');
  const cutoffSeconds = Math.floor(cutoffMilliseconds / 1_000);
  const asOfTimestamp = new Date(cutoffSeconds * 1_000).toISOString();
  return {
    ...request,
    walletAddresses: [
      ...new Set(request.walletAddresses.map((wallet) => wallet.trim()).filter(Boolean)),
    ],
    chain,
    asOfTimestamp,
    cutoffSeconds,
    requestedWindowStart:
      request.lookbackDays === null
        ? null
        : new Date((cutoffSeconds - request.lookbackDays * SECONDS_PER_DAY) * 1_000).toISOString(),
  };
};

/**
 * Return the newest saved GMGN activity-row revision eligible for each wallet snapshot.
 *
 * `observed_timestamp < cutoff` deliberately matches the feature reader's exclusive cutoff.
 * A later backfill whose activity belongs before the cutoff gets a higher row id and therefore
 * creates a new immutable snapshot revision. Rows at or after the cutoff are never inspected.
 */
export const readWalletFeatureSourceRevisionsAtCutoff = (
  database: DatabaseSync,
  walletAddresses: string[],
  chain: string,
  cutoffSeconds: number,
): Map<string, number> => {
  const revisions = new Map(walletAddresses.map((walletAddress) => [walletAddress, 0]));
  for (const walletGroup of chunked(walletAddresses, WALLET_QUERY_CHUNK)) {
    if (walletGroup.length === 0) continue;
    const placeholders = walletGroup.map(() => '?').join(', ');
    const rows = database
      .prepare(
        `SELECT wallet_address AS walletAddress, MAX(id) AS sourceDataRevision
         FROM copytrade_trades
         WHERE chain = ? AND wallet_address IN (${placeholders})
           AND event_type IN ('buy', 'sell', 'transfer_in') AND observed_timestamp < ?
         GROUP BY wallet_address`,
      )
      .all(chain, ...walletGroup, cutoffSeconds) as unknown as Array<{
      walletAddress: string;
      sourceDataRevision: number;
    }>;
    for (const row of rows) revisions.set(row.walletAddress, row.sourceDataRevision);
  }
  return revisions;
};

const emptySnapshot = (
  walletAddress: string,
  requestedWindowStart: string | null,
  requestedWindowEnd: string,
): WalletFeatureSnapshot => {
  const accumulator = new WalletFeatureAccumulator();
  return {
    walletAddress,
    features: currentWalletFeaturesFromSnapshot(accumulator.snapshot('')),
    decisionMetrics: accumulator.decisionCompatibilityMetrics(),
    quality: {
      rowsExamined: 0,
      contextRowsExamined: 0,
      sellRowsExamined: 0,
      returnRowsIncluded: 0,
      rowsExcludedNoCostBasis: 0,
      holdsPaired: 0,
      sellsWithoutPriorBuyContext: 0,
      oldestObservedAt: null,
      newestObservedAt: null,
      requestedWindowStart,
      requestedWindowEnd,
    },
  };
};

const qualityAsJson = (quality: WalletFeatureQuality): Record<string, unknown> => ({
  rowsExamined: quality.rowsExamined,
  contextRowsExamined: quality.contextRowsExamined,
  sellRowsExamined: quality.sellRowsExamined,
  returnRowsIncluded: quality.returnRowsIncluded,
  rowsExcludedNoCostBasis: quality.rowsExcludedNoCostBasis,
  holdsPaired: quality.holdsPaired,
  sellsWithoutPriorBuyContext: quality.sellsWithoutPriorBuyContext,
  oldestObservedAt: quality.oldestObservedAt,
  newestObservedAt: quality.newestObservedAt,
  requestedWindowStart: quality.requestedWindowStart,
  requestedWindowEnd: quality.requestedWindowEnd,
});

/** Generate and immutably persist point-in-time calendar/current snapshots in input order. */
export const generateWalletFeatureCalendarSnapshots = (
  database: DatabaseSync,
  request: GenerateWalletFeatureCalendarSnapshotsRequest,
): GeneratedWalletFeatureCalendarSnapshot[] => {
  const normalized = normalizeRequest(request);
  if (normalized.walletAddresses.length === 0) return [];

  database.exec('BEGIN IMMEDIATE;');
  try {
    const revisions = readWalletFeatureSourceRevisionsAtCutoff(
      database,
      normalized.walletAddresses,
      normalized.chain,
      normalized.cutoffSeconds,
    );
    const calculated = readWalletFeatureSnapshotsBatch(database, {
      walletAddresses: normalized.walletAddresses,
      asOfTimestamp: normalized.asOfTimestamp,
      lookbackDays: normalized.lookbackDays,
      includePreWindowContext: true,
      trigger: normalized.triggerKind,
      chain: normalized.chain,
    });
    const results = normalized.walletAddresses.map((walletAddress) => {
      const snapshot =
        calculated.get(walletAddress) ??
        emptySnapshot(walletAddress, normalized.requestedWindowStart, normalized.asOfTimestamp);
      return writeWalletFeatureSnapshot(database, {
        walletAddress,
        chain: normalized.chain,
        asOfTimestamp: normalized.asOfTimestamp,
        lookbackDays: normalized.lookbackDays,
        triggerKind: normalized.triggerKind,
        featureEngineVersion: WALLET_FEATURE_ENGINE_VERSION,
        sourceDataRevision: revisions.get(walletAddress) ?? 0,
        coverageStartTimestamp: snapshot.quality.oldestObservedAt,
        coverageEndTimestamp: snapshot.quality.newestObservedAt,
        quality: qualityAsJson(snapshot.quality),
        features: currentWalletFeatureValueMap(snapshot.features),
        createdAt: normalized.createdAt,
      });
    });
    database.exec('COMMIT;');
    return results;
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
};
