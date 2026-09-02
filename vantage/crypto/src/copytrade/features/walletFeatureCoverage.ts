import type { DatabaseSync } from 'node:sqlite';
import { listRosterWallets } from '../screening/roster.js';

const MAX_PERIOD_DAYS = 365;
const WALLET_QUERY_CHUNK_SIZE = 250;
const SECONDS_PER_DAY = 86_400;

export type WalletFeatureCoverageAssessment =
  'complete_requested_window' | 'incomplete' | 'unknown';

export type WalletFeatureCoverage = {
  walletAddress: string;
  chain: string;
  requestedPeriodDays: number;
  rawActivityCount: number;
  buyCount: number;
  sellCount: number;
  oldestActivityAt: string | null;
  newestActivityAt: string | null;
  availableSpanDays: number | null;
  assessment: WalletFeatureCoverageAssessment;
  coverageComplete: boolean | null;
  coverageRequestedPeriodDays: number | null;
  truncated: boolean | null;
  stopReason: string | null;
  requestsUsed: number | null;
  coverageUpdatedAt: string | null;
  officialStatsPeriod: string | null;
  officialStatsFetchedAt: string | null;
};

export type WalletFeatureCoverageInventory = {
  chain: string;
  requestedPeriodDays: number;
  availabilitySemantics: {
    oldestRowMeaning: 'availability_only';
    oldestRowProvesContinuousCoverage: false;
    description: string;
  };
  rows: WalletFeatureCoverage[];
};

export type ReadWalletFeatureCoverageOptions = {
  walletAddresses: string[];
  chain: string;
  periodDays: number;
};

type ActivityAggregateRow = {
  walletAddress: string;
  rawActivityCount: number;
  buyCount: number;
  sellCount: number;
  oldestActivityTimestamp: number | null;
  newestActivityTimestamp: number | null;
};

type CoverageRow = {
  walletAddress: string;
  coverageComplete: number;
  requestedPeriodDays: number | null;
  truncated: number;
  stopReason: string | null;
  requestsUsed: number;
  updatedAt: string;
};

type OfficialStatsRow = {
  walletAddress: string;
  period: string;
  fetchedAt: string;
};

const validatePeriodDays = (periodDays: number): number => {
  if (!Number.isInteger(periodDays) || periodDays < 1 || periodDays > MAX_PERIOD_DAYS) {
    throw new RangeError(`periodDays must be an integer between 1 and ${MAX_PERIOD_DAYS}.`);
  }
  return periodDays;
};

const normalizeChain = (chain: string): string => {
  const normalized = chain.trim().toLowerCase();
  if (!normalized) throw new Error('chain must not be empty.');
  return normalized;
};

const normalizeWalletAddresses = (walletAddresses: string[]): string[] => [
  ...new Set(walletAddresses.map((wallet) => wallet.trim()).filter(Boolean)),
];

const chunked = <T>(values: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

const isoTimestamp = (seconds: number | null): string | null =>
  seconds === null ? null : new Date(seconds * 1_000).toISOString();

const readActivityAggregates = (
  database: DatabaseSync,
  chain: string,
  walletAddresses: string[],
): Map<string, ActivityAggregateRow> => {
  const rows: ActivityAggregateRow[] = [];
  for (const wallets of chunked(walletAddresses, WALLET_QUERY_CHUNK_SIZE)) {
    const placeholders = wallets.map(() => '?').join(',');
    rows.push(
      ...(database
        .prepare(
          `SELECT wallet_address AS walletAddress,
                  COUNT(*) AS rawActivityCount,
                  SUM(CASE WHEN LOWER(event_type) = 'buy' THEN 1 ELSE 0 END) AS buyCount,
                  SUM(CASE WHEN LOWER(event_type) = 'sell' THEN 1 ELSE 0 END) AS sellCount,
                  MIN(observed_timestamp) AS oldestActivityTimestamp,
                  MAX(observed_timestamp) AS newestActivityTimestamp
           FROM copytrade_trades
           WHERE chain = ? AND wallet_address IN (${placeholders})
           GROUP BY wallet_address`,
        )
        .all(chain, ...wallets) as unknown as ActivityAggregateRow[]),
    );
  }
  return new Map(rows.map((row) => [row.walletAddress, row]));
};

const readCoverageRows = (
  database: DatabaseSync,
  chain: string,
  walletAddresses: string[],
): Map<string, CoverageRow> => {
  const rows: CoverageRow[] = [];
  for (const wallets of chunked(walletAddresses, WALLET_QUERY_CHUNK_SIZE)) {
    const placeholders = wallets.map(() => '?').join(',');
    rows.push(
      ...(database
        .prepare(
          `SELECT wallet_address AS walletAddress,
                  coverage_complete AS coverageComplete,
                  requested_period_days AS requestedPeriodDays,
                  truncated,
                  stop_reason AS stopReason,
                  requests_used AS requestsUsed,
                  updated_at AS updatedAt
           FROM copytrade_wallet_coverage
           WHERE chain = ? AND wallet_address IN (${placeholders})`,
        )
        .all(chain, ...wallets) as unknown as CoverageRow[]),
    );
  }
  return new Map(rows.map((row) => [row.walletAddress, row]));
};

const readLatestOfficialStats = (
  database: DatabaseSync,
  chain: string,
  walletAddresses: string[],
): Map<string, OfficialStatsRow> => {
  const rows: OfficialStatsRow[] = [];
  for (const wallets of chunked(walletAddresses, WALLET_QUERY_CHUNK_SIZE)) {
    const placeholders = wallets.map(() => '?').join(',');
    rows.push(
      ...(database
        .prepare(
          `SELECT walletAddress, period, fetchedAt
           FROM (
             SELECT wallet_address AS walletAddress,
                    period,
                    fetched_at AS fetchedAt,
                    ROW_NUMBER() OVER (
                      PARTITION BY wallet_address
                      ORDER BY fetched_at DESC, period DESC
                    ) AS recency
             FROM copytrade_wallet_stats
             WHERE chain = ? AND wallet_address IN (${placeholders})
           )
           WHERE recency = 1`,
        )
        .all(chain, ...wallets) as unknown as OfficialStatsRow[]),
    );
  }
  return new Map(rows.map((row) => [row.walletAddress, row]));
};

const coverageAssessment = (
  coverage: CoverageRow | undefined,
  requestedPeriodDays: number,
): WalletFeatureCoverageAssessment => {
  if (!coverage) return 'unknown';
  if (
    coverage.coverageComplete === 1 &&
    coverage.truncated === 0 &&
    coverage.requestedPeriodDays !== null &&
    coverage.requestedPeriodDays >= requestedPeriodDays
  ) {
    return 'complete_requested_window';
  }
  return 'incomplete';
};

/**
 * Reads normalized local GMGN activity availability and the persisted fetch markers in batches.
 * The oldest stored row describes available data only; it cannot prove that no pages or records
 * are missing between the oldest and newest timestamps.
 */
export const readWalletFeatureCoverageInventory = (
  database: DatabaseSync,
  options: ReadWalletFeatureCoverageOptions,
): WalletFeatureCoverageInventory => {
  const requestedPeriodDays = validatePeriodDays(options.periodDays);
  const chain = normalizeChain(options.chain);
  const walletAddresses = normalizeWalletAddresses(options.walletAddresses);

  const activities = readActivityAggregates(database, chain, walletAddresses);
  const coverageRows = readCoverageRows(database, chain, walletAddresses);
  const officialStats = readLatestOfficialStats(database, chain, walletAddresses);

  return {
    chain,
    requestedPeriodDays,
    availabilitySemantics: {
      oldestRowMeaning: 'availability_only',
      oldestRowProvesContinuousCoverage: false,
      description:
        'Oldest and newest activity timestamps show which normalized rows are locally available. Only an explicit, non-truncated coverage marker can establish completion of the requested fetch window; row span alone does not prove continuous coverage.',
    },
    rows: walletAddresses.map((walletAddress) => {
      const activity = activities.get(walletAddress);
      const coverage = coverageRows.get(walletAddress);
      const stats = officialStats.get(walletAddress);
      const oldest = activity?.oldestActivityTimestamp ?? null;
      const newest = activity?.newestActivityTimestamp ?? null;
      return {
        walletAddress,
        chain,
        requestedPeriodDays,
        rawActivityCount: Number(activity?.rawActivityCount ?? 0),
        buyCount: Number(activity?.buyCount ?? 0),
        sellCount: Number(activity?.sellCount ?? 0),
        oldestActivityAt: isoTimestamp(oldest),
        newestActivityAt: isoTimestamp(newest),
        availableSpanDays:
          oldest === null || newest === null
            ? null
            : Math.max(0, newest - oldest) / SECONDS_PER_DAY,
        assessment: coverageAssessment(coverage, requestedPeriodDays),
        coverageComplete: coverage ? coverage.coverageComplete === 1 : null,
        coverageRequestedPeriodDays: coverage?.requestedPeriodDays ?? null,
        truncated: coverage ? coverage.truncated === 1 : null,
        stopReason: coverage?.stopReason ?? null,
        requestsUsed: coverage ? Number(coverage.requestsUsed) : null,
        coverageUpdatedAt: coverage?.updatedAt ?? null,
        officialStatsPeriod: stats?.period ?? null,
        officialStatsFetchedAt: stats?.fetchedAt ?? null,
      };
    }),
  };
};

// ---------------------------------------------------------------------------------------------
// Deep-history coverage for the centralized Data workflow. A separate function (not a widened
// WalletFeatureCoverage) so the existing feature-coverage panel/tests above stay untouched.
// ---------------------------------------------------------------------------------------------

/** Stop reasons that mean the walk genuinely finished (not truncated by a page/rate budget and
 *  not aborted mid-walk) -- the only reasons whose achieved span can be trusted for a milestone
 *  flag. 'no_more_data' is a genuine completion too: it means the provider had nothing older,
 *  which is the correct, expected outcome for a wallet younger than the requested depth. */
export const GENUINE_COMPLETION_STOP_REASONS = new Set([
  'window_covered',
  'no_more_data',
  'up_to_date',
]);

export type HistoryDepthStatus =
  'reached_target' | 'pagination_exhausted' | 'partial' | 'not_fetched' | 'error';

export type WalletHistoryDepthCoverage = {
  walletAddress: string;
  name: string | null;
  rankPosition: number | null;
  oldestTradeAt: string | null;
  newestTradeAt: string | null;
  daysAvailable: number | null;
  tradeCount: number;
  pagesFetched: number | null;
  deepestCompletedDays: number | null;
  milestones: Record<number, boolean>;
  status: HistoryDepthStatus;
  stopReason: string | null;
  truncated: boolean | null;
  lastError: string | null;
  lastRunId: number | null;
  updatedAt: string | null;
};

export type HistoryDepthCoverageInventory = {
  chain: string;
  targetDays: number;
  depthMilestones: number[];
  generatedAt: string;
  rows: WalletHistoryDepthCoverage[];
  summary: {
    total: number;
    byMilestone: Record<number, number>;
    byStatus: Record<HistoryDepthStatus, number>;
  };
};

export type ReadHistoryDepthCoverageOptions = {
  walletAddresses: string[];
  chain: string;
  targetDays: number;
  depthMilestones?: number[];
};

type CoverageEventDepthRow = {
  walletAddress: string;
  requestedPeriodDays: number | null;
  truncated: number;
  stopReason: string | null;
  oldestHeldTs: number | null;
  newestHeldTs: number | null;
  pagesFetched: number | null;
  error: string | null;
  observedAt: string;
};

type LatestCoverageRow = {
  walletAddress: string;
  pagesFetched: number | null;
  lastRunId: number | null;
  updatedAt: string;
  lastError: string | null;
};

const readCoverageEventDepthRows = (
  database: DatabaseSync,
  chain: string,
  walletAddresses: string[],
): Map<string, CoverageEventDepthRow[]> => {
  const byWallet = new Map<string, CoverageEventDepthRow[]>();
  for (const wallets of chunked(walletAddresses, WALLET_QUERY_CHUNK_SIZE)) {
    const placeholders = wallets.map(() => '?').join(',');
    const rows = database
      .prepare(
        `SELECT wallet_address AS walletAddress,
                requested_period_days AS requestedPeriodDays,
                truncated,
                stop_reason AS stopReason,
                oldest_held_ts AS oldestHeldTs,
                newest_held_ts AS newestHeldTs,
                pages_fetched AS pagesFetched,
                error,
                observed_at AS observedAt
         FROM copytrade_wallet_coverage_events
         WHERE chain = ? AND wallet_address IN (${placeholders})
         ORDER BY observed_at ASC, id ASC`,
      )
      .all(chain, ...wallets) as unknown as CoverageEventDepthRow[];
    for (const row of rows) {
      const existing = byWallet.get(row.walletAddress);
      if (existing) existing.push(row);
      else byWallet.set(row.walletAddress, [row]);
    }
  }
  return byWallet;
};

const readLatestCoverageForDepth = (
  database: DatabaseSync,
  chain: string,
  walletAddresses: string[],
): Map<string, LatestCoverageRow> => {
  const rows: LatestCoverageRow[] = [];
  for (const wallets of chunked(walletAddresses, WALLET_QUERY_CHUNK_SIZE)) {
    const placeholders = wallets.map(() => '?').join(',');
    rows.push(
      ...(database
        .prepare(
          `SELECT wallet_address AS walletAddress,
                  pages_fetched AS pagesFetched,
                  last_run_id AS lastRunId,
                  updated_at AS updatedAt,
                  last_error AS lastError
           FROM copytrade_wallet_coverage
           WHERE chain = ? AND wallet_address IN (${placeholders})`,
        )
        .all(chain, ...wallets) as unknown as LatestCoverageRow[]),
    );
  }
  return new Map(rows.map((row) => [row.walletAddress, row]));
};

const readRosterMeta = (
  database: DatabaseSync,
  chain: string,
): Map<string, { name: string | null; rankPosition: number | null }> => {
  // Reuses the roster's own "current" definition (latest snapshot) instead of querying
  // copytrade_wallets directly -- that table is UNIQUE(wallet_address, chain, source_snapshot_id),
  // so a raw address-scoped query can return one row per past snapshot for the same wallet.
  const wallets = listRosterWallets(database, { chain });
  return new Map(
    wallets.map((wallet) => [
      wallet.walletAddress,
      { name: wallet.name, rankPosition: wallet.rankPosition },
    ]),
  );
};

// Depth is measured from the event's own observed_at back to oldest_held_ts -- NOT the span
// between oldest_held_ts and newest_held_ts. A wallet with a single trade from 95 days ago has a
// genuinely-confirmed 95-day-deep walk even though oldest and newest are the same row (span 0);
// conversely two trades close together near "now" have a tiny span despite telling us nothing
// about how far back the walk actually reached.
const achievedSpanDays = (event: CoverageEventDepthRow): number | null => {
  if (event.oldestHeldTs === null) return null;
  const observedAtSeconds = Date.parse(event.observedAt) / 1_000;
  if (!Number.isFinite(observedAtSeconds)) return null;
  return Math.max(0, observedAtSeconds - event.oldestHeldTs) / SECONDS_PER_DAY;
};

/**
 * Deep-history coverage for the Data workflow's step-4 verification table. Milestone flags are
 * derived from the DEEPEST genuinely-completed event per wallet across all of
 * copytrade_wallet_coverage_events, never from the latest copytrade_wallet_coverage row alone --
 * that table is keyed (wallet_address, chain) and holds only the most recent request, so a 30-day
 * re-fetch after a completed 90-day walk would otherwise make 90-day coverage look lost even
 * though the trades are still stored.
 */
export const readHistoryDepthCoverage = (
  database: DatabaseSync,
  options: ReadHistoryDepthCoverageOptions,
): HistoryDepthCoverageInventory => {
  const targetDays = validatePeriodDays(options.targetDays);
  const chain = normalizeChain(options.chain);
  const walletAddresses = normalizeWalletAddresses(options.walletAddresses);
  const depthMilestones = [...new Set(options.depthMilestones ?? [30, 60, 90])].sort(
    (a, b) => a - b,
  );

  const activities = readActivityAggregates(database, chain, walletAddresses);
  const events = readCoverageEventDepthRows(database, chain, walletAddresses);
  const latestCoverage = readLatestCoverageForDepth(database, chain, walletAddresses);
  const rosterMeta = readRosterMeta(database, chain);

  const byMilestone: Record<number, number> = Object.fromEntries(
    depthMilestones.map((milestone) => [milestone, 0]),
  );
  const byStatus: Record<HistoryDepthStatus, number> = {
    reached_target: 0,
    pagination_exhausted: 0,
    partial: 0,
    not_fetched: 0,
    error: 0,
  };

  const rows = walletAddresses.map((walletAddress): WalletHistoryDepthCoverage => {
    const activity = activities.get(walletAddress);
    const walletEvents = events.get(walletAddress) ?? [];
    const coverage = latestCoverage.get(walletAddress);
    const meta = rosterMeta.get(walletAddress);

    const genuineEvents = walletEvents.filter(
      (event) =>
        event.truncated === 0 && GENUINE_COMPLETION_STOP_REASONS.has(event.stopReason ?? ''),
    );
    let deepestCompletedDays: number | null = null;
    let deepestEvent: CoverageEventDepthRow | null = null;
    for (const event of genuineEvents) {
      const span = achievedSpanDays(event);
      if (span !== null && (deepestCompletedDays === null || span > deepestCompletedDays)) {
        deepestCompletedDays = span;
        deepestEvent = event;
      }
    }

    const milestones = Object.fromEntries(
      depthMilestones.map((milestone) => [
        milestone,
        deepestCompletedDays !== null && deepestCompletedDays >= milestone,
      ]),
    );
    for (const milestone of depthMilestones) {
      if (milestones[milestone]) byMilestone[milestone] += 1;
    }

    const latestEvent = walletEvents.at(-1) ?? null;
    let status: HistoryDepthStatus;
    if (walletEvents.length === 0) {
      status = 'not_fetched';
    } else if (deepestCompletedDays !== null && deepestCompletedDays >= targetDays) {
      status = 'reached_target';
    } else if (latestEvent?.stopReason === 'failed') {
      // A failed retry is the wallet's current state, even when an older genuine completion
      // still preserves shallower milestones. Do not let that older event make a failed fetch
      // look like pagination exhaustion or a successful partial walk.
      status = 'error';
    } else if (deepestEvent?.stopReason === 'no_more_data') {
      status = 'pagination_exhausted';
    } else if (walletEvents.some((event) => event.truncated === 1) || deepestEvent) {
      status = 'partial';
    } else {
      status = 'error';
    }
    byStatus[status] += 1;

    const oldest = activity?.oldestActivityTimestamp ?? null;
    const newest = activity?.newestActivityTimestamp ?? null;

    return {
      walletAddress,
      name: meta?.name ?? null,
      rankPosition: meta?.rankPosition ?? null,
      oldestTradeAt: isoTimestamp(oldest),
      newestTradeAt: isoTimestamp(newest),
      daysAvailable:
        oldest === null || newest === null ? null : Math.max(0, newest - oldest) / SECONDS_PER_DAY,
      tradeCount: Number(activity?.rawActivityCount ?? 0),
      pagesFetched: coverage?.pagesFetched ?? null,
      deepestCompletedDays,
      milestones,
      status,
      stopReason: latestEvent?.stopReason ?? null,
      truncated: latestEvent ? latestEvent.truncated === 1 : null,
      lastError: coverage?.lastError ?? latestEvent?.error ?? null,
      lastRunId: coverage?.lastRunId ?? null,
      updatedAt: coverage?.updatedAt ?? null,
    };
  });

  return {
    chain,
    targetDays,
    depthMilestones,
    generatedAt: new Date().toISOString(),
    rows,
    summary: { total: rows.length, byMilestone, byStatus },
  };
};
