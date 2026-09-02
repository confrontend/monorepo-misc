import type { DatabaseSync } from 'node:sqlite';
import { listRosterWallets } from './roster.js';

export type GmgnPeriodMetrics = {
  tradeCount: number;
  realizedProfitUsd: number | null;
  realizedPnlPercent: number | null;
};

const finiteNumber = (value: string | null): number | null => {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Reads period metrics from persisted GMGN activity without fetching or changing SQLite. */
export const readGmgnPeriodMetrics = (
  database: DatabaseSync,
  options: { periodDays: number; limit: number; snapshotId?: number; chain?: string },
): Record<string, GmgnPeriodMetrics> => {
  const chain = options.chain ?? 'sol';
  const roster = listRosterWallets(database, {
    chain,
    limit: options.limit,
    snapshotId: options.snapshotId,
  });
  const metrics: Record<string, GmgnPeriodMetrics> = {};
  for (const wallet of roster) {
    metrics[wallet.walletAddress] = {
      tradeCount: 0,
      realizedProfitUsd: null,
      realizedPnlPercent: null,
    };
  }
  if (roster.length === 0) return metrics;

  const cutoffSeconds = Math.floor(Date.now() / 1000) - options.periodDays * 86_400;
  const addresses = roster.map((wallet) => wallet.walletAddress);
  const rows = database
    .prepare(
      `SELECT wallet_address AS walletAddress, event_type AS eventType,
              cost_usd AS costUsd, buy_cost_usd AS buyCostUsd
       FROM copytrade_trades
       WHERE chain = ? AND observed_timestamp >= ?
         AND event_type IN ('buy', 'sell')
         AND wallet_address IN (${addresses.map(() => '?').join(',')})`,
    )
    .all(chain, cutoffSeconds, ...addresses) as unknown as Array<{
    walletAddress: string;
    eventType: string;
    costUsd: string | null;
    buyCostUsd: string | null;
  }>;
  const profitByWallet = new Map<string, { profit: number; costBasis: number }>();
  for (const row of rows) {
    const metric = metrics[row.walletAddress];
    if (!metric) continue;
    metric.tradeCount += 1;
    if (row.eventType !== 'sell') continue;
    const proceeds = finiteNumber(row.costUsd);
    const costBasis = finiteNumber(row.buyCostUsd);
    if (proceeds === null || costBasis === null || costBasis <= 0) continue;
    const current = profitByWallet.get(row.walletAddress) ?? { profit: 0, costBasis: 0 };
    current.profit += proceeds - costBasis;
    current.costBasis += costBasis;
    profitByWallet.set(row.walletAddress, current);
  }
  for (const [walletAddress, value] of profitByWallet) {
    const metric = metrics[walletAddress];
    if (!metric || value.costBasis <= 0) continue;
    metric.realizedProfitUsd = Math.round(value.profit * 100) / 100;
    metric.realizedPnlPercent = Math.round((value.profit / value.costBasis) * 100_000) / 1_000;
  }
  return metrics;
};

/**
 * Counts the GMGN trade events already persisted for the selected roster window.
 * This is deliberately read-only: it does not call GMGN or alter any saved data.
 */
export const readGmgnTradeCounts = (
  database: DatabaseSync,
  options: { periodDays: number; limit: number; snapshotId?: number; chain?: string },
): Record<string, number> => {
  const chain = options.chain ?? 'sol';
  const roster = listRosterWallets(database, {
    chain,
    limit: options.limit,
    snapshotId: options.snapshotId,
  });
  if (roster.length === 0) return {};

  const addresses = roster.map((wallet) => wallet.walletAddress);
  const cutoffSeconds = Math.floor(Date.now() / 1000) - options.periodDays * 86_400;
  const rows = database
    .prepare(
      `SELECT wallet_address AS walletAddress, COUNT(*) AS tradeCount
       FROM copytrade_trades
       WHERE chain = ? AND observed_timestamp >= ?
         AND event_type IN ('buy', 'sell')
         AND wallet_address IN (${addresses.map(() => '?').join(',')})
       GROUP BY wallet_address`,
    )
    .all(chain, cutoffSeconds, ...addresses) as unknown as Array<{
    walletAddress: string;
    tradeCount: number;
  }>;

  const counts: Record<string, number> = {};
  for (const address of addresses) counts[address] = 0;
  for (const row of rows) counts[row.walletAddress] = Number(row.tradeCount) || 0;
  return counts;
};
