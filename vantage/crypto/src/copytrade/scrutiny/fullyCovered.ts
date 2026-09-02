import type { DatabaseSync } from 'node:sqlite';

export const DEFAULT_FULLY_COVERED_PERIOD_DAYS = 30;
export const MAX_FULLY_COVERED_PERIOD_DAYS = 365;

export type FullyCoveredWallet = {
  walletAddress: string;
  chain: 'sol';
  periodDays: number;
  stopReason: string | null;
  updatedAt: string;
  storedTradeCount: number;
  coverageComplete: true;
  truncated: false;
};

export type FullyCoveredResponse = {
  requestedPeriodDays: number;
  coverageSemantics: {
    kind: 'verified_local_history';
    label: '100% verified local history coverage';
    description: string;
    excludesDuneOutcomeCoverage: true;
  };
  rows: FullyCoveredWallet[];
};

export const validateFullyCoveredPeriodDays = (periodDays: number): number => {
  if (
    !Number.isInteger(periodDays) ||
    periodDays <= 0 ||
    periodDays > MAX_FULLY_COVERED_PERIOD_DAYS
  ) {
    throw new RangeError(
      `periodDays must be an integer between 1 and ${MAX_FULLY_COVERED_PERIOD_DAYS}.`,
    );
  }
  return periodDays;
};

const GENUINE_COMPLETION_REASONS = ['window_covered', 'no_more_data', 'up_to_date'] as const;

/** Read verified coverage, preserving evidence from deeper walks after later runs overwrite the
 * latest convenience row. */
const readVerifiedCoverage = (
  database: DatabaseSync,
  chain: string,
  periodDays: number,
): Array<{ walletAddress: string; stopReason: string | null; updatedAt: string }> => {
  const reasons = GENUINE_COMPLETION_REASONS.map(() => '?').join(',');
  return database
    .prepare(
      `WITH candidates AS (
         SELECT wallet_address AS walletAddress,
                stop_reason AS stopReason,
                updated_at AS updatedAt
         FROM copytrade_wallet_coverage
         WHERE chain = ? AND coverage_complete = 1 AND truncated = 0
           AND requested_period_days = ?
         UNION ALL
         SELECT wallet_address AS walletAddress,
                stop_reason AS stopReason,
                observed_at AS updatedAt
         FROM copytrade_wallet_coverage_events
         WHERE chain = ? AND truncated = 0 AND stop_reason IN (${reasons})
           AND oldest_held_ts IS NOT NULL
           AND unixepoch(observed_at) - oldest_held_ts >= ? * 86400
       ), ranked AS (
         SELECT walletAddress, stopReason, updatedAt,
                ROW_NUMBER() OVER (PARTITION BY walletAddress ORDER BY updatedAt DESC) AS recency
         FROM candidates
       )
       SELECT walletAddress, stopReason, updatedAt
       FROM ranked WHERE recency = 1
       ORDER BY updatedAt DESC, walletAddress ASC`,
    )
    .all(chain, periodDays, chain, ...GENUINE_COMPLETION_REASONS, periodDays) as Array<{
    walletAddress: string;
    stopReason: string | null;
    updatedAt: string;
  }>;
};

/**
 * Shared predicate for verified local history at a requested depth. An exact completed marker or
 * a deeper completed append-only walk can satisfy the requested period; later runs must never
 * erase shallower historical coverage.
 */
export const readWalletAddressesWithCompleteCoverage = (
  database: DatabaseSync,
  chain: string,
  periodDays: number,
  limit?: number,
): string[] => {
  const rows = readVerifiedCoverage(database, chain, periodDays);
  return (limit === undefined ? rows : rows.slice(0, limit)).map((row) => row.walletAddress);
};

/** Read-only view of wallets whose latest local GMGN history pass explicitly completed. */
export const readFullyCoveredWallets = (
  database: DatabaseSync,
  requestedPeriodDays = DEFAULT_FULLY_COVERED_PERIOD_DAYS,
): FullyCoveredResponse => {
  const periodDays = validateFullyCoveredPeriodDays(requestedPeriodDays);
  const rows = readVerifiedCoverage(database, 'sol', periodDays).map((row) => ({
    ...row,
    storedTradeCount: database
      .prepare(
        `SELECT COUNT(*) AS count FROM copytrade_trades
         WHERE wallet_address = ? AND chain = 'sol'`,
      )
      .get(row.walletAddress) as { count: number },
  }));

  return {
    requestedPeriodDays: periodDays,
    coverageSemantics: {
      kind: 'verified_local_history',
      label: '100% verified local history coverage',
      description:
        'The latest local GMGN history walk completed the requested period without truncation; storedTradeCount is the number of normalized local trade rows currently stored for that wallet and chain.',
      excludesDuneOutcomeCoverage: true,
    },
    rows: rows.map((row) => ({
      walletAddress: String(row.walletAddress),
      chain: 'sol',
      periodDays,
      stopReason: row.stopReason,
      updatedAt: row.updatedAt,
      storedTradeCount: Number(row.storedTradeCount.count ?? 0),
      coverageComplete: true,
      truncated: false,
    })),
  };
};
