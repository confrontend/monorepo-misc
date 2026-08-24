import type { DatabaseSync } from 'node:sqlite';

export interface SnapshotAnalysis {
  generatedAt: string;
  scope: 'descriptive-snapshot-only';
  signals: {
    total: number;
    uniqueTokens: number;
    averagePerToken: number;
    singleSignalTokens: number;
    multiSignalTokens: number;
    maxSignalsPerToken: number;
  };
  signalTypes: Array<{ signalType: string; count: number }>;
  sources: Array<{ source: string; count: number }>;
  cohortOverlap: { matchedSignals: number; unmatchedSignals: number; matchedTokens: number };
  timing: {
    earliestObservedAt: string | null;
    latestObservedAt: string | null;
    earliestCapturedAt: string | null;
    latestCapturedAt: string | null;
  };
  marketCap: {
    count: number;
    minimum: number | null;
    median: number | null;
    average: number | null;
    maximum: number | null;
  };
  validation: {
    signalsWithIssues: number;
    missingTokenAddress: number;
    missingSignalType: number;
    missingObservedAt: number;
  };
  limitations: string[];
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

export const readSnapshotAnalysis = (
  database: DatabaseSync,
  now = new Date(),
): SnapshotAnalysis => {
  const totals = database
    .prepare(
      `
    SELECT COUNT(*) AS total,
      COUNT(DISTINCT token_address) AS uniqueTokens,
      SUM(CASE WHEN token_address IS NOT NULL AND token_address IN (SELECT token_address FROM tokens) THEN 1 ELSE 0 END) AS matchedSignals,
      SUM(CASE WHEN token_address IS NULL OR token_address NOT IN (SELECT token_address FROM tokens) THEN 1 ELSE 0 END) AS unmatchedSignals,
      COUNT(DISTINCT CASE WHEN token_address IN (SELECT token_address FROM tokens) THEN token_address END) AS matchedTokens,
      MIN(observed_at) AS earliestObservedAt, MAX(observed_at) AS latestObservedAt,
      MIN(captured_at) AS earliestCapturedAt, MAX(captured_at) AS latestCapturedAt,
      SUM(CASE WHEN validation_errors IS NOT NULL AND validation_errors <> '[]' THEN 1 ELSE 0 END) AS signalsWithIssues,
      SUM(CASE WHEN token_address IS NULL THEN 1 ELSE 0 END) AS missingTokenAddress,
      SUM(CASE WHEN signal_type IS NULL THEN 1 ELSE 0 END) AS missingSignalType,
      SUM(CASE WHEN observed_at IS NULL THEN 1 ELSE 0 END) AS missingObservedAt
    FROM gmgn_signals
  `,
    )
    .get() as Record<string, number | string | null>;
  const perToken = database
    .prepare(
      `SELECT token_address, COUNT(*) AS count FROM gmgn_signals WHERE token_address IS NOT NULL GROUP BY token_address`,
    )
    .all() as Array<{ token_address: string; count: number }>;
  const marketCaps = (
    database
      .prepare(`SELECT market_cap FROM gmgn_signals WHERE market_cap IS NOT NULL`)
      .all() as Array<{ market_cap: number }>
  )
    .map((row) => Number(row.market_cap))
    .filter(Number.isFinite);
  const typeRows = (
    database
      .prepare(
        `SELECT COALESCE(signal_type, 'unknown') AS signalType, COUNT(*) AS count FROM gmgn_signals GROUP BY signal_type ORDER BY count DESC`,
      )
      .all() as unknown as Array<{ signalType: string; count: number }>
  ).map((row) => ({ ...row }));
  const sourceRows = (
    database
      .prepare(
        `SELECT COALESCE(source, 'unknown') AS source, COUNT(*) AS count FROM gmgn_signals GROUP BY source ORDER BY count DESC`,
      )
      .all() as unknown as Array<{ source: string; count: number }>
  ).map((row) => ({ ...row }));
  const counts = perToken.map((row) => row.count);
  const total = Number(totals.total ?? 0);
  return {
    generatedAt: now.toISOString(),
    scope: 'descriptive-snapshot-only',
    signals: {
      total,
      uniqueTokens: Number(totals.uniqueTokens ?? 0),
      averagePerToken: counts.length ? Number((total / counts.length).toFixed(2)) : 0,
      singleSignalTokens: counts.filter((count) => count === 1).length,
      multiSignalTokens: counts.filter((count) => count > 1).length,
      maxSignalsPerToken: counts.length ? Math.max(...counts) : 0,
    },
    signalTypes: typeRows,
    sources: sourceRows,
    cohortOverlap: {
      matchedSignals: Number(totals.matchedSignals ?? 0),
      unmatchedSignals: Number(totals.unmatchedSignals ?? 0),
      matchedTokens: Number(totals.matchedTokens ?? 0),
    },
    timing: {
      earliestObservedAt: String(totals.earliestObservedAt ?? '') || null,
      latestObservedAt: String(totals.latestObservedAt ?? '') || null,
      earliestCapturedAt: String(totals.earliestCapturedAt ?? '') || null,
      latestCapturedAt: String(totals.latestCapturedAt ?? '') || null,
    },
    marketCap: {
      count: marketCaps.length,
      minimum: marketCaps.length ? Math.min(...marketCaps) : null,
      median: median(marketCaps),
      average: marketCaps.length
        ? Number((marketCaps.reduce((sum, value) => sum + value, 0) / marketCaps.length).toFixed(2))
        : null,
      maximum: marketCaps.length ? Math.max(...marketCaps) : null,
    },
    validation: {
      signalsWithIssues: Number(totals.signalsWithIssues ?? 0),
      missingTokenAddress: Number(totals.missingTokenAddress ?? 0),
      missingSignalType: Number(totals.missingSignalType ?? 0),
      missingObservedAt: Number(totals.missingObservedAt ?? 0),
    },
    limitations: [
      'Descriptive snapshot only; no returns, scoring, ranking, or winner labels.',
      'Unmatched signals are retained and do not establish that a token had no historical signal.',
      'Coverage is limited to the captured source windows and may not represent the full GMGN feed.',
    ],
  };
};
