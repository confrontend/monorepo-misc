import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import {
  computeExperimentalDecisionReport,
  type ExperimentalDecisionReport,
} from '../../copytrade/experimentalDecision.js';
import {
  recordEvaluationHistory,
  decisionLabHistoryEntry,
} from '../../copytrade/liveEvaluationHistory.js';
import { WINNER_POLICY_VERSION } from '../../copytrade/winnerPolicy.js';
import { WALLET_FEATURE_ENGINE_VERSION } from '../../copytrade/features/walletFeatureDefinitions.js';
import { CACHE_VERSIONS, versionedCacheKey } from '../../platform/cache/cacheVersions.js';

export interface DecisionLabRouteRequest {
  method: string | undefined;
  url: URL;
  request: IncomingMessage;
  readJsonBody: () => Promise<unknown>;
}

export interface DecisionLabRouteContext {
  database: DatabaseSync;
  respond: (status: number, value: unknown) => void;
  readExperimentalDecisionCacheVersion: (
    database: DatabaseSync,
    periodDays?: 30 | 60 | 90,
  ) => string;
  readLatestPersistedResearch: <T>(keyPrefix: string) => T | null;
  readCachedResearch: <T>(key: string, compute: () => T) => T;
}

export type DecisionLabRoute = (
  request: DecisionLabRouteRequest,
  context: DecisionLabRouteContext,
) => Promise<boolean>;

const latestKeyPrefix = (limit: number, periodDays: 30 | 60 | 90 | null): string =>
  `${CACHE_VERSIONS.decisionLab}:${limit}:${periodDays}:latest:`;

/** Authoritative Decision Lab report route. The report is persisted and fingerprint-cached;
 * this adapter only handles HTTP parsing and cache selection. */
export const createDecisionLabRoutes = (): DecisionLabRoute[] => [
  async (
    { method, url },
    {
      database,
      respond,
      readExperimentalDecisionCacheVersion,
      readLatestPersistedResearch,
      readCachedResearch,
    },
  ) => {
    if (method !== 'GET' || url.pathname !== '/api/copytrade/experimental-decision') return false;
    const periodDays = null;
    const cachePeriodDays = 90 as const;
    const limitRaw = Number(url.searchParams.get('limit') ?? '100');
    const snapshotRaw = Number(url.searchParams.get('snapshotId') ?? '');
    const limit = Number.isFinite(limitRaw)
      ? Math.min(100, Math.max(1, Math.floor(limitRaw)))
      : 100;
    const rosterSnapshotId =
      Number.isInteger(snapshotRaw) && snapshotRaw > 0 ? snapshotRaw : undefined;
    const weightingVersion = `${readExperimentalDecisionCacheVersion(database, cachePeriodDays)}:${WINNER_POLICY_VERSION}:coverage-quality-v2:deduction-details-v1`;
    const refresh = url.searchParams.get('refresh') === '1';
    const candidate =
      !refresh && rosterSnapshotId === undefined
        ? readLatestPersistedResearch<ExperimentalDecisionReport>(
            latestKeyPrefix(limit, cachePeriodDays),
          )
        : null;
    const savedReport =
      candidate?.featureEngineVersion === WALLET_FEATURE_ENGINE_VERSION &&
      candidate.winnerPolicyVersion === WINNER_POLICY_VERSION &&
      candidate.wallets.every(
        (wallet) =>
          wallet.winnerPolicy?.evidence?.coverageQuality !== undefined &&
          wallet.winnerPolicy.gmgnRiskScore?.deductionDetails !== undefined,
      )
        ? candidate
        : null;
    const report =
      savedReport ??
      readCachedResearch(
        versionedCacheKey(
          'decisionLab',
          'all',
          limit,
          rosterSnapshotId ?? 'latest',
          weightingVersion,
        ),
        () => {
          const computed = computeExperimentalDecisionReport(database, {
            limit,
            rosterSnapshotId,
            periodDays,
          });
          for (const wallet of computed.wallets)
            recordEvaluationHistory(
              database,
              decisionLabHistoryEntry(wallet, computed.generatedAt),
            );
          return computed;
        },
      );
    respond(200, report);
    return true;
  },
];
