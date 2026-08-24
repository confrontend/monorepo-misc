import type { DatabaseSync } from 'node:sqlite';

export interface SignalScoreRow {
  signalId: number;
  tokenAddress: string | null;
  signalType: string | null;
  observedAt: string | null;
  score: number;
  maxScore: 8;
  matchedDuneToken: boolean;
  firstTradeKnown: boolean;
  firstDexKnown: boolean;
  firstTxKnown: boolean;
  signalTimeKnown: boolean;
  temporalOrderValid: boolean;
  marketCapKnown: boolean;
}

export interface SignalScoringReport {
  generatedAt: string;
  method: 'exploratory-data-readiness-v1';
  totalSignals: number;
  averageScore: number;
  scoreDistribution: Array<{ score: number; count: number }>;
  rows: SignalScoreRow[];
  limitations: string[];
}

export const readSignalScoringReport = (
  database: DatabaseSync,
  now = new Date(),
): SignalScoringReport => {
  const rows = database
    .prepare(
      `
    SELECT s.id AS signalId, s.token_address AS tokenAddress, s.signal_type AS signalType,
      s.observed_at AS observedAt, s.market_cap AS marketCap,
      t.token_address AS duneTokenAddress, t.first_trade_time AS firstTradeTime, t.first_dex AS firstDex, t.first_tx AS firstTx
    FROM gmgn_signals s LEFT JOIN tokens t ON t.token_address = s.token_address
    ORDER BY s.id DESC
  `,
    )
    .all() as unknown as Array<Record<string, string | number | null>>;
  const scored: SignalScoreRow[] = rows.map((row) => {
    const matchedDuneToken =
      typeof row.duneTokenAddress === 'string' && row.duneTokenAddress.length > 0;
    const firstTradeKnown = typeof row.firstTradeTime === 'string' && row.firstTradeTime.length > 0;
    const firstDexKnown = typeof row.firstDex === 'string' && row.firstDex.length > 0;
    const firstTxKnown = typeof row.firstTx === 'string' && row.firstTx.length > 0;
    const signalTimeKnown = typeof row.observedAt === 'string' && row.observedAt.length > 0;
    const temporalOrderValid =
      firstTradeKnown &&
      signalTimeKnown &&
      Date.parse(row.firstTradeTime as string) <= Date.parse(row.observedAt as string);
    const marketCapKnown = typeof row.marketCap === 'number' && Number.isFinite(row.marketCap);
    const score =
      [
        matchedDuneToken,
        firstTradeKnown,
        firstDexKnown,
        firstTxKnown,
        signalTimeKnown,
        temporalOrderValid,
        marketCapKnown,
      ].filter(Boolean).length + (matchedDuneToken ? 1 : 0);
    return {
      signalId: Number(row.signalId),
      tokenAddress: typeof row.tokenAddress === 'string' ? row.tokenAddress : null,
      signalType:
        typeof row.signalType === 'string'
          ? row.signalType
          : row.signalType === null
            ? null
            : String(row.signalType),
      observedAt: typeof row.observedAt === 'string' ? row.observedAt : null,
      score,
      maxScore: 8,
      matchedDuneToken,
      firstTradeKnown,
      firstDexKnown,
      firstTxKnown,
      signalTimeKnown,
      temporalOrderValid,
      marketCapKnown,
    };
  });
  const distribution = new Map<number, number>();
  for (const row of scored) distribution.set(row.score, (distribution.get(row.score) ?? 0) + 1);
  return {
    generatedAt: now.toISOString(),
    method: 'exploratory-data-readiness-v1',
    totalSignals: scored.length,
    averageScore: scored.length
      ? Number((scored.reduce((sum, row) => sum + row.score, 0) / scored.length).toFixed(2))
      : 0,
    scoreDistribution: [...distribution.entries()]
      .sort(([a], [b]) => b - a)
      .map(([score, count]) => ({ score, count })),
    rows: scored,
    limitations: [
      'This is a data-readiness score, not a profitability or signal-effectiveness score.',
      'Dune enrichment contributes provenance and timing fields; it does not prove an outcome.',
      'Weights are provisional and must be preregistered before outcome analysis.',
    ],
  };
};
