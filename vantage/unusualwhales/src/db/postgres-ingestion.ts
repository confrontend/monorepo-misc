import type pg from 'pg';

export type PostgresOptionTradeInput = {
  sourceTradeId: string;
  sourceBatchId: number;
  executedAt: string | null;
  capturedAt: string;
  signalType: 'call_sweep' | 'put_sweep';
  underlyingSymbol: string | null;
  optionChainId: string | null;
  optionType: string | null;
  expiry: string | null;
  strike: string | null;
  premium: string | null;
  price: string | null;
  size: number | null;
  underlyingPrice: string | null;
  openInterest: number | null;
  volume: number | null;
  nbboBid: string | null;
  nbboAsk: string | null;
  reportFlags: unknown;
  tags: unknown;
  canceled: boolean;
  rawPayload: unknown;
  validationErrors: unknown;
};

export type PostgresImportBatch = { id: number };

/**
 * PostgreSQL writes used by provider ingestion.  The methods are deliberately
 * small and transaction-friendly: callers can import a complete API response
 * atomically while the unique source ids preserve retry idempotency.
 */
export class PostgresIngestionRepository {
  constructor(private readonly pool: pg.Pool) {}

  async ensureSchema(): Promise<void> {
    // The original migration preserved ids but had no defaults for new rows.
    // Sequences make fresh ingestion safe after migration and are harmless when
    // the database is already initialized.
    await this.pool.query(`
      CREATE SEQUENCE IF NOT EXISTS uw_import_batches_id_seq;
      CREATE SEQUENCE IF NOT EXISTS uw_option_trades_id_seq;
      CREATE SEQUENCE IF NOT EXISTS uw_dark_pool_trades_id_seq;
      CREATE SEQUENCE IF NOT EXISTS uw_historical_coverage_id_seq;
      SELECT setval('uw_import_batches_id_seq', GREATEST(COALESCE((SELECT MAX(id) FROM uw_import_batches), 1), 1), true);
      SELECT setval('uw_option_trades_id_seq', GREATEST(COALESCE((SELECT MAX(id) FROM uw_option_trades), 1), 1), true);
      SELECT setval('uw_dark_pool_trades_id_seq', GREATEST(COALESCE((SELECT MAX(id) FROM uw_dark_pool_trades), 1), 1), true);
      SELECT setval('uw_historical_coverage_id_seq', GREATEST(COALESCE((SELECT MAX(id) FROM uw_historical_coverage), 1), 1), true);
      ALTER TABLE uw_import_batches ALTER COLUMN id SET DEFAULT nextval('uw_import_batches_id_seq');
      ALTER TABLE uw_option_trades ALTER COLUMN id SET DEFAULT nextval('uw_option_trades_id_seq');
      ALTER TABLE uw_dark_pool_trades ALTER COLUMN id SET DEFAULT nextval('uw_dark_pool_trades_id_seq');
      ALTER TABLE uw_historical_coverage ALTER COLUMN id SET DEFAULT nextval('uw_historical_coverage_id_seq');
    `);
  }

  async beginBatch(endpoint: string, query: unknown, requestedAt: string): Promise<PostgresImportBatch> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO uw_import_batches (endpoint, query_json, requested_at, status)
       VALUES ($1, $2::jsonb, $3, 'processing') RETURNING id`,
      [endpoint, JSON.stringify(query), requestedAt],
    );
    return { id: Number(result.rows[0].id) };
  }

  async importOptionTrades(batchId: number, rows: PostgresOptionTradeInput[]): Promise<{ inserted: number; duplicates: number }> {
    const client = await this.pool.connect();
    let inserted = 0;
    try {
      await client.query('BEGIN');
      for (const row of rows) {
        const result = await client.query(
          `INSERT INTO uw_option_trades
            (source_batch_id, source_trade_id, executed_at, captured_at, signal_type,
             underlying_symbol, option_chain_id, option_type, expiry, strike, premium,
             price, size, underlying_price, open_interest, volume, nbbo_bid, nbbo_ask,
             report_flags, tags, canceled, raw_payload, validation_errors)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20::jsonb,$21,$22::jsonb,$23::jsonb)
           ON CONFLICT (source_trade_id) DO NOTHING`,
          [row.sourceBatchId, row.sourceTradeId, row.executedAt, row.capturedAt, row.signalType,
            row.underlyingSymbol, row.optionChainId, row.optionType, row.expiry, row.strike,
            row.premium, row.price, row.size, row.underlyingPrice, row.openInterest, row.volume,
            row.nbboBid, row.nbboAsk, JSON.stringify(row.reportFlags ?? []), JSON.stringify(row.tags ?? []),
            row.canceled, JSON.stringify(row.rawPayload ?? {}), JSON.stringify(row.validationErrors ?? [])],
        );
        inserted += result.rowCount ?? 0;
      }
      await client.query('COMMIT');
      return { inserted, duplicates: rows.length - inserted };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async finishBatch(batchId: number, values: { completedAt: string; httpStatus?: number; received: number; inserted: number; duplicates: number; responseSha256?: string; rawResponse?: unknown }): Promise<void> {
    await this.pool.query(
      `UPDATE uw_import_batches SET completed_at=$1,status='completed',http_status=$2,
       received_count=$3,inserted_count=$4,duplicate_count=$5,response_sha256=$6,raw_response=$7
       WHERE id=$8`,
      [values.completedAt, values.httpStatus ?? null, values.received, values.inserted, values.duplicates,
        values.responseSha256 ?? null, values.rawResponse == null ? null : JSON.stringify(values.rawResponse), batchId],
    );
  }

  async failBatch(batchId: number, completedAt: string, error: string): Promise<void> {
    await this.pool.query(`UPDATE uw_import_batches SET completed_at=$1,status='failed',error=$2 WHERE id=$3`, [completedAt, error, batchId]);
  }
}
