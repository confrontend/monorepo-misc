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
  if (!Number.isInteger(periodDays) || periodDays <= 0 || periodDays > MAX_FULLY_COVERED_PERIOD_DAYS) {
    throw new RangeError(`periodDays must be an integer between 1 and ${MAX_FULLY_COVERED_PERIOD_DAYS}.`);
  }
  return periodDays;
};

/** Read-only view of wallets whose latest local GMGN history pass explicitly completed. */
export const readFullyCoveredWallets = (
  database: DatabaseSync,
  requestedPeriodDays = DEFAULT_FULLY_COVERED_PERIOD_DAYS,
): FullyCoveredResponse => {
  const periodDays = validateFullyCoveredPeriodDays(requestedPeriodDays);
  const rows = database.prepare(
    `SELECT coverage.wallet_address AS walletAddress,
            coverage.requested_period_days AS periodDays,
            coverage.stop_reason AS stopReason,
            coverage.updated_at AS updatedAt,
            coverage.coverage_complete AS coverageComplete,
            coverage.truncated AS truncated,
            (SELECT COUNT(*) FROM copytrade_trades AS trades
             WHERE trades.wallet_address = coverage.wallet_address AND trades.chain = coverage.chain) AS storedTradeCount
     FROM copytrade_wallet_coverage AS coverage
     WHERE coverage.chain = 'sol'
       AND coverage.coverage_complete = 1
       AND coverage.truncated = 0
       AND coverage.requested_period_days = ?
     ORDER BY coverage.updated_at DESC, coverage.wallet_address ASC`,
  ).all(periodDays) as Array<Record<string, unknown>>;

  return {
    requestedPeriodDays: periodDays,
    coverageSemantics: {
      kind: 'verified_local_history',
      label: '100% verified local history coverage',
      description: 'The latest local GMGN history walk completed the requested period without truncation; storedTradeCount is the number of normalized local trade rows currently stored for that wallet and chain.',
      excludesDuneOutcomeCoverage: true,
    },
    rows: rows.map((row) => ({
      walletAddress: String(row.walletAddress),
      chain: 'sol',
      periodDays: Number(row.periodDays),
      stopReason: typeof row.stopReason === 'string' ? row.stopReason : null,
      updatedAt: String(row.updatedAt),
      storedTradeCount: Number(row.storedTradeCount ?? 0),
      coverageComplete: true,
      truncated: false,
    })),
  };
};
