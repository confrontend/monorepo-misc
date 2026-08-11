import type { DatabaseSync } from 'node:sqlite';

export interface DataQuality {
  cohortTokenCount: number;
  signalCount: number;
  matchedSignalCount: number;
  unmatchedSignalCount: number;
  tokensWithSignals: number;
  tokensWithoutSignals: number;
  coveragePercent: number;
  missingTokenAddressSignals: number;
  missingSignalTypeSignals: number;
  missingObservedAtSignals: number;
  signalsWithValidationIssues: number;
}

interface QualityRow {
  cohortTokenCount: number;
  signalCount: number;
  matchedSignalCount: number;
  unmatchedSignalCount: number;
  tokensWithSignals: number;
  tokensWithoutSignals: number;
  missingTokenAddressSignals: number;
  missingSignalTypeSignals: number;
  missingObservedAtSignals: number;
  signalsWithValidationIssues: number;
}

export const readDataQuality = (database: DatabaseSync): DataQuality => {
  const row = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM tokens) AS cohortTokenCount,
      (SELECT COUNT(*) FROM gmgn_signals) AS signalCount,
      (SELECT COUNT(*) FROM gmgn_signals s
        WHERE s.token_address IS NOT NULL
          AND EXISTS (SELECT 1 FROM tokens t WHERE t.token_address = s.token_address))
        AS matchedSignalCount,
      (SELECT COUNT(*) FROM gmgn_signals s
        WHERE s.token_address IS NULL
           OR NOT EXISTS (SELECT 1 FROM tokens t WHERE t.token_address = s.token_address))
        AS unmatchedSignalCount,
      (SELECT COUNT(*) FROM tokens t
        WHERE EXISTS (SELECT 1 FROM gmgn_signals s WHERE s.token_address = t.token_address))
        AS tokensWithSignals,
      (SELECT COUNT(*) FROM tokens t
        WHERE NOT EXISTS (SELECT 1 FROM gmgn_signals s WHERE s.token_address = t.token_address))
        AS tokensWithoutSignals,
      (SELECT COUNT(*) FROM gmgn_signals WHERE token_address IS NULL) AS missingTokenAddressSignals,
      (SELECT COUNT(*) FROM gmgn_signals WHERE signal_type IS NULL) AS missingSignalTypeSignals,
      (SELECT COUNT(*) FROM gmgn_signals WHERE observed_at IS NULL) AS missingObservedAtSignals,
      (SELECT COUNT(*) FROM gmgn_signals WHERE validation_errors <> '[]') AS signalsWithValidationIssues
  `).get() as unknown as QualityRow;

  return {
    ...row,
    coveragePercent: row.signalCount === 0
      ? 0
      : Math.round((row.matchedSignalCount / row.signalCount) * 1000) / 10,
  };
};

