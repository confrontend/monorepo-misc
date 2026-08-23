import type { DatabaseSync } from 'node:sqlite';

const WINDOW_SECONDS = 30 * 60;

export type DerivedFlowImbalanceResult = {
  status: 'completed';
  received: number;
  inserted: number;
  duplicates: number;
  days: number;
};

/**
 * Derives a point-in-time flow signal from the already imported Call/Put Sweep
 * trades. This is deliberately named and documented as sweep flow imbalance;
 * it is not a substitute for the provider's full market-tide feed.
 */
export const deriveSweepFlowImbalance = (database: DatabaseSync, from: string, to: string, capturedAt = new Date().toISOString()): DerivedFlowImbalanceResult => {
  const rows = database.prepare(`
    SELECT underlying_symbol AS symbol,
           CAST((unixepoch(executed_at) / ?) AS INTEGER) AS bucket,
           MAX(executed_at) AS executedAt,
           SUM(CASE WHEN option_type='call' THEN CAST(COALESCE(premium, '0') AS REAL) ELSE 0 END) AS callPremium,
           SUM(CASE WHEN option_type='put' THEN CAST(COALESCE(premium, '0') AS REAL) ELSE 0 END) AS putPremium,
           COUNT(*) AS tradeCount
    FROM uw_option_trades
    WHERE signal_type IN ('call_sweep','put_sweep')
      AND canceled=0
      AND underlying_symbol IS NOT NULL
      AND executed_at IS NOT NULL
      AND executed_at >= ? AND executed_at < ?
    GROUP BY underlying_symbol, bucket
    HAVING callPremium > 0 AND putPremium > 0
  `).all(WINDOW_SECONDS, from, to) as unknown as Array<{ symbol: string; bucket: number; executedAt: string; callPremium: number; putPremium: number; tradeCount: number }>;

  const batch = database.prepare(`INSERT INTO uw_import_batches (endpoint, query_json, requested_at, status) VALUES (?, ?, ?, 'processing')`).run(
    'derived://sweep-flow-imbalance', JSON.stringify({ from, to, windowSeconds: WINDOW_SECONDS, sourceSignals: ['call_sweep', 'put_sweep'] }), capturedAt,
  );
  const batchId = Number(batch.lastInsertRowid);
  const insert = database.prepare(`INSERT OR IGNORE INTO uw_option_trades
    (source_trade_id, source_batch_id, executed_at, captured_at, signal_type, underlying_symbol, option_type, premium, raw_payload, validation_errors)
    VALUES (?, ?, ?, ?, 'flow_imbalance', ?, 'flow_imbalance', ?, ?, '[]')`);
  let inserted = 0;
  let duplicates = 0;
  const days = new Set<string>();
  for (const row of rows) {
    const callPremium = Number(row.callPremium ?? 0);
    const putPremium = Number(row.putPremium ?? 0);
    const totalPremium = callPremium + putPremium;
    if (!row.symbol || !Number.isFinite(totalPremium) || totalPremium <= 0) continue;
    const imbalance = (callPremium - putPremium) / totalPremium;
    const executedAt = new Date(row.executedAt).toISOString();
    const sourceId = `sweep-flow-imbalance:${row.symbol}:${row.bucket}`;
    const payload = JSON.stringify({ source: 'call_put_sweeps', windowSeconds: WINDOW_SECONDS, symbol: row.symbol, callPremium, putPremium, totalPremium, imbalance, tradeCount: row.tradeCount });
    const result = insert.run(sourceId, batchId, executedAt, capturedAt, row.symbol, String(imbalance), payload);
    if (Number(result.changes)) inserted++; else duplicates++;
    days.add(executedAt.slice(0, 10));
  }
  database.prepare(`UPDATE uw_import_batches SET completed_at=?, status='completed', received_count=?, inserted_count=?, duplicate_count=? WHERE id=?`).run(capturedAt, rows.length, inserted, duplicates, batchId);
  for (const day of days) {
    const dayStart = `${day}T00:00:00.000Z`;
    const dayEnd = new Date(new Date(dayStart).getTime() + 86400000).toISOString();
    const dayRows = database.prepare(`SELECT COUNT(*) AS count, SUM(CASE WHEN source_batch_id=? THEN 1 ELSE 0 END) AS inserted FROM uw_option_trades WHERE signal_type='flow_imbalance' AND executed_at >= ? AND executed_at < ?`).get(batchId, dayStart, dayEnd) as { count: number; inserted: number };
    database.prepare(`INSERT INTO uw_historical_coverage (signal_type,trading_date,endpoint,started_at,completed_at,status,received_count,inserted_count,duplicate_count)
      VALUES (?,?,?,?,?,'completed',?,?,?)
      ON CONFLICT(signal_type,trading_date) DO UPDATE SET completed_at=excluded.completed_at,status='completed',received_count=excluded.received_count,inserted_count=excluded.inserted_count,duplicate_count=excluded.duplicate_count,error=NULL`)
      .run('flow_imbalance', day, 'derived://sweep-flow-imbalance', capturedAt, capturedAt, Number(dayRows.count ?? 0), Number(dayRows.inserted ?? 0), 0);
  }
  return { status: 'completed', received: rows.length, inserted, duplicates, days: days.size };
};
