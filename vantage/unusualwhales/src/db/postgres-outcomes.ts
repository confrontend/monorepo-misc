import type { PoolClient } from 'pg';

export type PostgresOutcomeTrade = {
  id: number;
  underlyingSymbol: string;
  executedAt: string;
  signalType: string;
};

export type PostgresOutcomeBar = { observedAt: string; close: number };

export type PostgresOutcomeRow = {
  tradeId: number;
  horizon: string;
  entryAt: string | null;
  entryPrice: number | null;
  outcomeAt: string | null;
  outcomePrice: number | null;
  spyEntryPrice: number | null;
  spyOutcomePrice: number | null;
  returnPct: number | null;
  spyReturnPct: number | null;
  excessReturnPct: number | null;
  exclusionReason: string | null;
  calculatedAt: string;
};

export type PostgresOutcomeCheckpoint = {
  jobId: number;
  lastSymbol: string;
  lastExecutedAt: string;
  lastTradeId: number;
  completed: number;
  total: number;
  updatedAt: string;
};

type Queryable = Pick<PoolClient, 'query'>;

/** PostgreSQL-only persistence for outcome calculation. SQLite has its own unchanged path. */
export class PostgresOutcomeRepository {
  async ensureSchema(client: Queryable): Promise<void> {
    // The shipped PostgreSQL migration preserves imported IDs but does not add
    // defaults for newly calculated outcome rows. Keep that bootstrap local to
    // this PostgreSQL path; SQLite schema/behavior is untouched.
    await client.query(`
      CREATE SEQUENCE IF NOT EXISTS uw_signal_outcomes_id_seq;
      SELECT setval('uw_signal_outcomes_id_seq', GREATEST(COALESCE((SELECT MAX(id) FROM uw_signal_outcomes), 1), 1), true);
      ALTER TABLE uw_signal_outcomes ALTER COLUMN id SET DEFAULT nextval('uw_signal_outcomes_id_seq');
    `);
  }

  async countEligibleTrades(client: Queryable, symbols?: string[]): Promise<number> {
    const filter = symbols?.length ? 'AND underlying_symbol = ANY($1)' : '';
    const values = symbols?.length ? [symbols] : [];
    const result = await client.query<{ count: string }>(`SELECT COUNT(*)::bigint AS count
      FROM uw_option_trades
      WHERE signal_type IN ('call_sweep','put_sweep') AND canceled=FALSE
        AND underlying_symbol IS NOT NULL AND executed_at IS NOT NULL ${filter}`, values);
    return Number(result.rows[0]?.count ?? 0);
  }

  async listEligibleTrades(client: Queryable, after: { symbol: string; executedAt: string; id: number } | null, limit: number, symbols?: string[]): Promise<PostgresOutcomeTrade[]> {
    const values: unknown[] = symbols?.length ? [symbols] : [];
    const filter = symbols?.length ? `AND underlying_symbol = ANY($1)` : '';
    const offset = values.length;
    const cursor = after ? `AND (underlying_symbol, executed_at, id) > ($${offset + 1}, $${offset + 2}, $${offset + 3})` : '';
    if (after) values.push(after.symbol, after.executedAt, after.id);
    values.push(limit);
    const result = await client.query<PostgresOutcomeTrade & { underlying_symbol: string; executed_at: string; signal_type: string }>(
      `SELECT id, underlying_symbol, executed_at, signal_type FROM uw_option_trades
       WHERE signal_type IN ('call_sweep','put_sweep') AND canceled=FALSE
         AND underlying_symbol IS NOT NULL AND executed_at IS NOT NULL ${filter} ${cursor}
       ORDER BY underlying_symbol, executed_at, id LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => ({ id: Number(row.id), underlyingSymbol: row.underlying_symbol, executedAt: new Date(row.executed_at).toISOString(), signalType: row.signal_type }));
  }

  async firstBarAtOrAfter(client: Queryable, symbol: string, timeframe: string, at: string, strictlyAfter?: string): Promise<PostgresOutcomeBar | null> {
    const values = [symbol, timeframe, at];
    const strict = strictlyAfter ? 'AND observed_at > $4' : '';
    if (strictlyAfter) values.push(strictlyAfter);
    const result = await client.query<{ observed_at: string; close: number }>(
      `SELECT observed_at, close FROM uw_market_bars
       WHERE symbol=$1 AND timeframe=$2 AND observed_at >= $3 ${strict}
       ORDER BY observed_at LIMIT 1`, values);
    const row = result.rows[0];
    return row ? { observedAt: new Date(row.observed_at).toISOString(), close: Number(row.close) } : null;
  }

  async nthBarAfter(client: Queryable, symbol: string, timeframe: string, strictlyAfter: string, count: number): Promise<PostgresOutcomeBar | null> {
    const result = await client.query<{ observed_at: string; close: number }>(
      `SELECT observed_at, close FROM uw_market_bars
       WHERE symbol=$1 AND timeframe=$2 AND observed_at > $3
       ORDER BY observed_at LIMIT 1 OFFSET $4`, [symbol, timeframe, strictlyAfter, Math.max(0, count - 1)],
    );
    const row = result.rows[0];
    return row ? { observedAt: new Date(row.observed_at).toISOString(), close: Number(row.close) } : null;
  }

  async writeOutcomeBatch(client: Queryable, rows: PostgresOutcomeRow[]): Promise<void> {
    for (const row of rows) {
      await client.query(`INSERT INTO uw_signal_outcomes
        (trade_id,horizon,entry_at,entry_price,outcome_at,outcome_price,spy_entry_price,spy_outcome_price,
         return_pct,spy_return_pct,excess_return_pct,exclusion_reason,calculated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (trade_id,horizon) DO UPDATE SET entry_at=EXCLUDED.entry_at,
          entry_price=EXCLUDED.entry_price,outcome_at=EXCLUDED.outcome_at,outcome_price=EXCLUDED.outcome_price,
          spy_entry_price=EXCLUDED.spy_entry_price,spy_outcome_price=EXCLUDED.spy_outcome_price,
          return_pct=EXCLUDED.return_pct,spy_return_pct=EXCLUDED.spy_return_pct,
          excess_return_pct=EXCLUDED.excess_return_pct,exclusion_reason=EXCLUDED.exclusion_reason,
          calculated_at=EXCLUDED.calculated_at`, [row.tradeId, row.horizon, row.entryAt, row.entryPrice, row.outcomeAt,
        row.outcomePrice, row.spyEntryPrice, row.spyOutcomePrice, row.returnPct, row.spyReturnPct,
        row.excessReturnPct, row.exclusionReason, row.calculatedAt]);
    }
  }

  async saveCheckpoint(client: Queryable, checkpoint: PostgresOutcomeCheckpoint): Promise<void> {
    await client.query(`INSERT INTO uw_outcome_checkpoints
      (job_id,last_symbol,last_executed_at,last_trade_id,completed,total,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (job_id) DO UPDATE SET last_symbol=EXCLUDED.last_symbol,
        last_executed_at=EXCLUDED.last_executed_at,last_trade_id=EXCLUDED.last_trade_id,
        completed=EXCLUDED.completed,total=EXCLUDED.total,updated_at=EXCLUDED.updated_at`,
      [checkpoint.jobId, checkpoint.lastSymbol, checkpoint.lastExecutedAt, checkpoint.lastTradeId,
        checkpoint.completed, checkpoint.total, checkpoint.updatedAt]);
  }

  async clearCheckpoint(client: Queryable, jobId: number): Promise<void> {
    await client.query('DELETE FROM uw_outcome_checkpoints WHERE job_id=$1', [jobId]);
  }
}
