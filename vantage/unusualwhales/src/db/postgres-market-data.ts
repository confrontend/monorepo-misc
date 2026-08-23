import type pg from 'pg';
import type { MarketBar } from '../research/outcomes.js';

export type PostgresMarketDataRepository = {
  ensureSchema(): Promise<void>;
  upsertBars(bars: MarketBar[]): Promise<number>;
};

const validBar = (bar: MarketBar) => Boolean(
  bar.symbol && Number.isFinite(bar.close) && !Number.isNaN(Date.parse(bar.observedAt)),
);

/** PostgreSQL-only market-bar persistence. SQLite remains owned by outcomes.upsertMarketBars. */
export class PostgresMarketDataWriter implements PostgresMarketDataRepository {
  constructor(private readonly pool: pg.Pool) {}

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE SEQUENCE IF NOT EXISTS uw_market_bars_id_seq;
      SELECT setval('uw_market_bars_id_seq', GREATEST(COALESCE((SELECT MAX(id) FROM uw_market_bars), 1), 1), true);
      ALTER TABLE uw_market_bars ALTER COLUMN id SET DEFAULT nextval('uw_market_bars_id_seq');
    `);
  }

  async upsertBars(bars: MarketBar[]): Promise<number> {
    const rows = bars.filter(validBar);
    if (!rows.length) return 0;
    const client = await this.pool.connect();
    let written = 0;
    try {
      await client.query('BEGIN');
      for (const bar of rows) {
        const result = await client.query(
          `INSERT INTO uw_market_bars
             (symbol,timeframe,observed_at,open,high,low,close,volume,source,retrieved_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (symbol,timeframe,observed_at) DO UPDATE SET
             open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
             close=EXCLUDED.close, volume=EXCLUDED.volume, source=EXCLUDED.source,
             retrieved_at=EXCLUDED.retrieved_at`,
          [bar.symbol.toUpperCase(), bar.timeframe, new Date(bar.observedAt).toISOString(),
            bar.open ?? null, bar.high ?? null, bar.low ?? null, bar.close, bar.volume ?? null,
            bar.source, bar.retrievedAt ?? new Date().toISOString()],
        );
        written += result.rowCount ?? 0;
      }
      await client.query('COMMIT');
      return written;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
