import type { DatabaseSync } from 'node:sqlite';

export interface DatabaseStats {
  tokenCount: number;
  gmgnSignalCount: number;
  tokenFirstTrade: { earliest: string | null; latest: string | null };
  gmgnObserved: { earliest: string | null; latest: string | null };
  gmgnCaptured: { earliest: string | null; latest: string | null };
  signalsByType: Array<{ signalType: string; count: number }>;
}

interface CountRow {
  count: number;
}

interface RangeRow {
  earliest: string | null;
  latest: string | null;
}

export const readDatabaseStats = (database: DatabaseSync): DatabaseStats => {
  const tokenCount = (
    database.prepare('SELECT COUNT(*) AS count FROM tokens').get() as unknown as CountRow
  ).count;
  const gmgnSignalCount = (
    database.prepare('SELECT COUNT(*) AS count FROM gmgn_signals').get() as unknown as CountRow
  ).count;
  const tokenFirstTradeRow = database.prepare(`
    SELECT MIN(first_trade_time) AS earliest, MAX(first_trade_time) AS latest
    FROM tokens
    WHERE first_trade_time IS NOT NULL
  `).get() as unknown as RangeRow;
  const gmgnObservedRow = database.prepare(`
    SELECT MIN(observed_at) AS earliest, MAX(observed_at) AS latest
    FROM gmgn_signals
    WHERE observed_at IS NOT NULL
  `).get() as unknown as RangeRow;
  const gmgnCapturedRow = database.prepare(`
    SELECT MIN(captured_at) AS earliest, MAX(captured_at) AS latest
    FROM gmgn_signals
  `).get() as unknown as RangeRow;
  const signalTypeRows = database.prepare(`
    SELECT COALESCE(signal_type, '(missing)') AS signalType, COUNT(*) AS count
    FROM gmgn_signals
    GROUP BY signal_type
    ORDER BY count DESC, signalType ASC
  `).all() as unknown as Array<{ signalType: string; count: number }>;

  return {
    tokenCount,
    gmgnSignalCount,
    tokenFirstTrade: {
      earliest: tokenFirstTradeRow.earliest,
      latest: tokenFirstTradeRow.latest,
    },
    gmgnObserved: {
      earliest: gmgnObservedRow.earliest,
      latest: gmgnObservedRow.latest,
    },
    gmgnCaptured: {
      earliest: gmgnCapturedRow.earliest,
      latest: gmgnCapturedRow.latest,
    },
    signalsByType: signalTypeRows.map((row) => ({
      signalType: row.signalType,
      count: row.count,
    })),
  };
};
