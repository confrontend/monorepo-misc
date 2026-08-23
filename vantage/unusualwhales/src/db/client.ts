import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const defaultDatabasePath = path.resolve(process.cwd(), '.data', 'unusual-whales.sqlite');

export const createDatabase = (databasePath = process.env.UNUSUAL_WHALES_DB_PATH ?? defaultDatabasePath) => {
  const resolvedPath = path.resolve(databasePath);
  mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const database = new DatabaseSync(resolvedPath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    -- Without this, a connection that hits even brief WAL lock contention from another
    -- connection's in-flight write (e.g. the historical-backfill worker's outcome writer)
    -- throws SQLITE_BUSY immediately instead of waiting a moment and retrying. That is what
    -- made /api/signals/comparison intermittently fail/hang behind a long-running write.
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO app_metadata (key, value)
    VALUES ('schema_version', '1');

    CREATE TABLE IF NOT EXISTS uw_import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL,
      query_json TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed')),
      http_status INTEGER,
      received_count INTEGER NOT NULL DEFAULT 0,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      response_sha256 TEXT,
      raw_response TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_uw_import_batches_requested_at
      ON uw_import_batches(requested_at);

    CREATE TABLE IF NOT EXISTS uw_option_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_trade_id TEXT NOT NULL UNIQUE,
      source_batch_id INTEGER NOT NULL REFERENCES uw_import_batches(id),
      executed_at TEXT,
      captured_at TEXT NOT NULL,
      signal_type TEXT NOT NULL,
      underlying_symbol TEXT,
      option_chain_id TEXT,
      option_type TEXT,
      expiry TEXT,
      strike TEXT,
      premium TEXT,
      price TEXT,
      size INTEGER,
      underlying_price TEXT,
      open_interest INTEGER,
      volume INTEGER,
      nbbo_bid TEXT,
      nbbo_ask TEXT,
      report_flags TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]',
      canceled INTEGER NOT NULL DEFAULT 0,
      raw_payload TEXT NOT NULL,
      validation_errors TEXT NOT NULL DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_uw_option_trades_executed_at
      ON uw_option_trades(executed_at);
    CREATE INDEX IF NOT EXISTS idx_uw_option_trades_symbol
      ON uw_option_trades(underlying_symbol);
    CREATE INDEX IF NOT EXISTS idx_uw_option_trades_signal_type
      ON uw_option_trades(signal_type);

    CREATE TABLE IF NOT EXISTS uw_dark_pool_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_trade_id TEXT NOT NULL UNIQUE,
      executed_at TEXT,
      captured_at TEXT NOT NULL,
      ticker TEXT,
      price TEXT,
      size REAL,
      premium TEXT,
      canceled INTEGER NOT NULL DEFAULT 0,
      raw_payload TEXT NOT NULL,
      validation_errors TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_uw_dark_pool_trades_executed_at ON uw_dark_pool_trades(executed_at);
    CREATE INDEX IF NOT EXISTS idx_uw_dark_pool_trades_ticker ON uw_dark_pool_trades(ticker);

    CREATE TABLE IF NOT EXISTS uw_historical_coverage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_type TEXT NOT NULL,
      trading_date TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed')),
      received_count INTEGER NOT NULL DEFAULT 0,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      bytes_received INTEGER,
      bytes_expected INTEGER,
      progress_updated_at TEXT,
      UNIQUE(signal_type, trading_date)
    );
    CREATE INDEX IF NOT EXISTS idx_uw_historical_coverage_lookup ON uw_historical_coverage(signal_type, trading_date, status);

    CREATE TABLE IF NOT EXISTS uw_market_bars (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL CHECK(timeframe IN ('1m', '5m', '1d')),
      observed_at TEXT NOT NULL,
      open REAL,
      high REAL,
      low REAL,
      close REAL NOT NULL,
      volume REAL,
      source TEXT NOT NULL,
      retrieved_at TEXT NOT NULL,
      UNIQUE(symbol, timeframe, observed_at)
    );
    CREATE INDEX IF NOT EXISTS idx_uw_market_bars_lookup
      ON uw_market_bars(symbol, timeframe, observed_at);

    CREATE TABLE IF NOT EXISTS uw_signal_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id INTEGER NOT NULL REFERENCES uw_option_trades(id),
      horizon TEXT NOT NULL,
      entry_at TEXT,
      entry_price REAL,
      outcome_at TEXT,
      outcome_price REAL,
      spy_entry_price REAL,
      spy_outcome_price REAL,
      return_pct REAL,
      spy_return_pct REAL,
      excess_return_pct REAL,
      exclusion_reason TEXT,
      calculated_at TEXT NOT NULL,
      UNIQUE(trade_id, horizon)
    );
    CREATE INDEX IF NOT EXISTS idx_uw_signal_outcomes_horizon
      ON uw_signal_outcomes(horizon);
    CREATE INDEX IF NOT EXISTS idx_uw_signal_outcomes_horizon_trade
      ON uw_signal_outcomes(horizon, trade_id);
    CREATE INDEX IF NOT EXISTS idx_uw_signal_outcomes_horizon_return
      ON uw_signal_outcomes(horizon, return_pct);
    CREATE INDEX IF NOT EXISTS idx_uw_signal_outcomes_horizon_excess
      ON uw_signal_outcomes(horizon, excess_return_pct);
    CREATE INDEX IF NOT EXISTS idx_uw_option_trades_signal_active
      ON uw_option_trades(signal_type, canceled, id);

    CREATE TABLE IF NOT EXISTS uw_option_features (
      trade_id INTEGER PRIMARY KEY REFERENCES uw_option_trades(id),
      volume_oi_ratio REAL,
      spread_pct REAL,
      moneyness_pct REAL,
      dte_days REAL,
      side_score REAL,
      implied_volatility REAL,
      delta REAL,
      gamma REAL,
      vega REAL,
      is_opening_trade INTEGER,
      calculated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_uw_option_features_side ON uw_option_features(side_score);
    CREATE INDEX IF NOT EXISTS idx_uw_option_features_dte ON uw_option_features(dte_days);

    -- Non-trade signals (market flow, OI, GEX, and filings) are stored separately from
    -- option trades so they retain their own publication/observability timestamps and
    -- cannot accidentally enter trade-specific outcome calculations.
    CREATE TABLE IF NOT EXISTS uw_signal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_event_id TEXT NOT NULL UNIQUE,
      source_batch_id INTEGER NOT NULL REFERENCES uw_import_batches(id),
      signal_type TEXT NOT NULL,
      event_at TEXT,
      published_at TEXT,
      observable_at TEXT,
      captured_at TEXT NOT NULL,
      symbol TEXT,
      outcome_symbol TEXT,
      prediction_mode TEXT NOT NULL CHECK(prediction_mode IN ('directional', 'volatility', 'regime')),
      score REAL,
      raw_payload TEXT NOT NULL,
      validation_errors TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_uw_signal_events_lookup
      ON uw_signal_events(signal_type, event_at);
    CREATE INDEX IF NOT EXISTS idx_uw_signal_events_symbol
      ON uw_signal_events(symbol, event_at);

    CREATE TABLE IF NOT EXISTS uw_signal_event_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES uw_signal_events(id),
      horizon TEXT NOT NULL,
      entry_at TEXT,
      entry_price REAL,
      outcome_at TEXT,
      outcome_price REAL,
      spy_entry_price REAL,
      spy_outcome_price REAL,
      return_pct REAL,
      spy_return_pct REAL,
      excess_return_pct REAL,
      exclusion_reason TEXT,
      calculated_at TEXT NOT NULL,
      UNIQUE(event_id, horizon)
    );
    CREATE INDEX IF NOT EXISTS idx_uw_signal_event_outcomes_lookup
      ON uw_signal_event_outcomes(horizon, event_id);

    -- Forward-only provider stream messages. These are deliberately separate from
    -- historical events: stream retention is short and capture time is part of the
    -- evidence needed for a point-in-time forward test.
    CREATE TABLE IF NOT EXISTS uw_stream_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_event_id TEXT NOT NULL UNIQUE,
      topic TEXT NOT NULL,
      message_type TEXT,
      event_at TEXT,
      published_at TEXT,
      captured_at TEXT NOT NULL,
      symbol TEXT,
      raw_payload TEXT NOT NULL,
      validation_errors TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_uw_stream_events_topic_time
      ON uw_stream_events(topic, event_at);
    CREATE INDEX IF NOT EXISTS idx_uw_stream_events_symbol_time
      ON uw_stream_events(symbol, event_at);

    CREATE TABLE IF NOT EXISTS uw_operation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed')),
      error TEXT,
      details_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_uw_operation_logs_started_at
      ON uw_operation_logs(started_at);
    CREATE TABLE IF NOT EXISTS uw_outcome_checkpoints (
      scope TEXT PRIMARY KEY,
      last_symbol TEXT,
      last_executed_at TEXT,
      last_trade_id INTEGER,
      completed INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    -- Single-row cache of the last computed /api/signals/comparison payload. This table
    -- exists so the dashboard's hot read path never has to re-run the full cross-signal
    -- aggregation (which scans uw_signal_outcomes -- millions of rows during a large
    -- backfill) on every poll; it reads this one row instead. generated_at is the
    -- authoritative "as of" timestamp shown to the user, since it can lag behind the true
    -- live state while an outcome recalculation is in progress.
    CREATE TABLE IF NOT EXISTS uw_comparison_cache (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload_json TEXT NOT NULL,
      generated_at TEXT NOT NULL
    );
  `);

  // uw_historical_coverage predates per-request byte/row progress tracking. ALTER TABLE ADD
  // COLUMN is not idempotent (it errors if the column already exists), so a databases created
  // before this change need the columns added explicitly; a fresh database already has them
  // from the CREATE TABLE above and this is a no-op.
  const historicalCoverageColumns = new Set(
    (database.prepare('PRAGMA table_info(uw_historical_coverage)').all() as Array<{ name: string }>).map((row) => row.name),
  );
  for (const [column, definition] of [
    ['bytes_received', 'INTEGER'],
    ['bytes_expected', 'INTEGER'],
    ['progress_updated_at', 'TEXT'],
  ] as const) {
    if (!historicalCoverageColumns.has(column)) {
      database.exec(`ALTER TABLE uw_historical_coverage ADD COLUMN ${column} ${definition}`);
    }
  }

  database.exec(`
    INSERT INTO app_metadata (key, value)
    VALUES ('schema_version', '8')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `);

  return database;
};
