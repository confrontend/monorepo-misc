import type { DatabaseSync } from 'node:sqlite';

export type StoredGmgnRiskResult = {
  walletAddress: string;
  period: '30d';
  available: boolean;
  metrics?: unknown;
  error?: string;
  fetchedAt: string;
};

export const saveGmgnRiskResult = (
  database: DatabaseSync,
  result: Omit<StoredGmgnRiskResult, 'fetchedAt'>,
): StoredGmgnRiskResult => {
  const saved: StoredGmgnRiskResult = { ...result, fetchedAt: new Date().toISOString() };
  database
    .prepare(
      `
    INSERT INTO copytrade_gmgn_risk_stats (wallet_address, period, fetched_at, available, metrics_json, error)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(wallet_address, period) DO UPDATE SET fetched_at = excluded.fetched_at,
      available = excluded.available, metrics_json = excluded.metrics_json, error = excluded.error
  `,
    )
    .run(
      saved.walletAddress,
      saved.period,
      saved.fetchedAt,
      saved.available ? 1 : 0,
      saved.metrics === undefined ? null : JSON.stringify(saved.metrics),
      saved.error ?? null,
    );
  return saved;
};

export const readGmgnRiskResults = (
  database: DatabaseSync,
  walletAddresses: string[],
): StoredGmgnRiskResult[] => {
  if (!walletAddresses.length) return [];
  const rows = database
    .prepare(
      `SELECT wallet_address AS walletAddress, period, fetched_at AS fetchedAt, available, metrics_json AS metricsJson, error
    FROM copytrade_gmgn_risk_stats WHERE period = '30d' AND wallet_address IN (${walletAddresses.map(() => '?').join(',')})`,
    )
    .all(...walletAddresses) as unknown as Array<{
    walletAddress: string;
    period: '30d';
    fetchedAt: string;
    available: number;
    metricsJson: string | null;
    error: string | null;
  }>;
  return rows.map((row) => ({
    walletAddress: row.walletAddress,
    period: '30d',
    fetchedAt: row.fetchedAt,
    available: row.available === 1,
    metrics: row.metricsJson ? JSON.parse(row.metricsJson) : undefined,
    error: row.error ?? undefined,
  }));
};
