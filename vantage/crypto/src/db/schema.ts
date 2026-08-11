import type { DatabaseSync } from 'node:sqlite';

interface Migration {
  description: string;
  up: (database: DatabaseSync) => void;
}

const migrations: Migration[] = [
  {
    description: 'V1 token cohort, GMGN signals, and Dune ingestion audit',
    up: (database) => {
      database.exec(`
        CREATE TABLE tokens (
          token_address TEXT PRIMARY KEY,
          symbol TEXT,
          first_trade_time TEXT,
          first_dex TEXT,
          first_tx TEXT,
          source TEXT NOT NULL,
          imported_at TEXT NOT NULL,
          raw_payload TEXT NOT NULL,
          validation_errors TEXT NOT NULL DEFAULT '[]'
        );

        CREATE INDEX idx_tokens_first_trade_time ON tokens(first_trade_time);

        CREATE TABLE gmgn_signals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          observed_at TEXT,
          token_address TEXT,
          signal_type TEXT,
          market_cap REAL,
          triggering_wallet TEXT,
          raw_wallet_labels TEXT,
          source_url TEXT,
          ingestion_latency_ms INTEGER,
          raw_payload TEXT NOT NULL,
          captured_at TEXT NOT NULL,
          validation_errors TEXT NOT NULL DEFAULT '[]'
        );

        CREATE INDEX idx_gmgn_signals_token_address
          ON gmgn_signals(token_address);
        CREATE INDEX idx_gmgn_signals_observed_at
          ON gmgn_signals(observed_at);
        CREATE INDEX idx_gmgn_signals_signal_type
          ON gmgn_signals(signal_type);

        CREATE TABLE dune_import_batches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_path TEXT NOT NULL,
          source_sha256 TEXT NOT NULL UNIQUE,
          source_format TEXT NOT NULL CHECK(source_format IN ('csv', 'json', 'unknown')),
          raw_source TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed')),
          imported_count INTEGER NOT NULL DEFAULT 0,
          skipped_count INTEGER NOT NULL DEFAULT 0,
          error_count INTEGER NOT NULL DEFAULT 0,
          imported_at TEXT NOT NULL,
          completed_at TEXT,
          error TEXT
        );

        CREATE TABLE dune_import_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          batch_id INTEGER NOT NULL REFERENCES dune_import_batches(id),
          row_number INTEGER NOT NULL,
          token_address TEXT,
          status TEXT NOT NULL CHECK(status IN ('imported', 'skipped', 'error')),
          errors TEXT NOT NULL DEFAULT '[]',
          raw_payload TEXT NOT NULL,
          captured_at TEXT NOT NULL,
          UNIQUE(batch_id, row_number)
        );

        CREATE INDEX idx_dune_import_records_batch
          ON dune_import_records(batch_id, row_number);
      `);
    },
  },
  {
    description: 'immutable processed-source archive provenance',
    up: (database) => {
      database.exec(`
        ALTER TABLE dune_import_batches ADD COLUMN archive_path TEXT;
        ALTER TABLE dune_import_batches ADD COLUMN archive_sha256 TEXT;
        ALTER TABLE dune_import_batches ADD COLUMN archived_at TEXT;
      `);
    },
  },
  {
    description: 'append-only diagnostic log for request-level troubleshooting',
    up: (database) => {
      database.exec(`
        CREATE TABLE diagnostic_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          level TEXT NOT NULL CHECK(level IN ('info', 'warn', 'error')),
          event TEXT NOT NULL,
          method TEXT,
          path TEXT,
          status INTEGER,
          duration_ms INTEGER,
          request_bytes INTEGER,
          message TEXT,
          detail TEXT
        );

        CREATE INDEX idx_diagnostic_logs_created_at ON diagnostic_logs(created_at);
        CREATE INDEX idx_diagnostic_logs_level ON diagnostic_logs(level);
      `);
    },
  },
  {
    description: 'GMGN source-native event identity and trigger fields',
    up: (database) => {
      database.exec(`
        ALTER TABLE gmgn_signals ADD COLUMN source TEXT;
        ALTER TABLE gmgn_signals ADD COLUMN chain TEXT;
        ALTER TABLE gmgn_signals ADD COLUMN source_event_id TEXT;
        ALTER TABLE gmgn_signals ADD COLUMN trigger_at TEXT;
        ALTER TABLE gmgn_signals ADD COLUMN trigger_mc REAL;
        ALTER TABLE gmgn_signals ADD COLUMN first_trigger_mc REAL;
        ALTER TABLE gmgn_signals ADD COLUMN signal_times INTEGER;
        ALTER TABLE gmgn_signals ADD COLUMN signal_times_by_type TEXT;
        ALTER TABLE gmgn_signals ADD COLUMN query_market_cap REAL;
        ALTER TABLE gmgn_signals ADD COLUMN query_ath REAL;
        ALTER TABLE gmgn_signals ADD COLUMN query_cur_data TEXT;

        CREATE UNIQUE INDEX idx_gmgn_signals_source_identity
          ON gmgn_signals(source, chain, source_event_id)
          WHERE source IS NOT NULL AND chain IS NOT NULL AND source_event_id IS NOT NULL;
      `);
    },
  },
  {
    description: 'GMGN poll audit and coverage boundaries',
    up: (database) => {
      database.exec(`
        CREATE TABLE gmgn_polls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          poll_started_at TEXT NOT NULL,
          poll_completed_at TEXT,
          source TEXT NOT NULL,
          chain TEXT NOT NULL,
          cli_version TEXT,
          status TEXT NOT NULL CHECK(status IN ('started', 'completed', 'failed')),
          received_count INTEGER NOT NULL DEFAULT 0,
          stored_count INTEGER NOT NULL DEFAULT 0,
          repeated_count INTEGER NOT NULL DEFAULT 0,
          error_count INTEGER NOT NULL DEFAULT 0,
          oldest_trigger_at TEXT,
          newest_trigger_at TEXT,
          previous_newest_trigger_at TEXT,
          gap_start_at TEXT,
          gap_end_at TEXT,
          archive_path TEXT,
          archive_sha256 TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_gmgn_polls_started_at ON gmgn_polls(poll_started_at);
        CREATE INDEX idx_gmgn_polls_status ON gmgn_polls(status);
      `);
    },
  },
  {
    description: 'GMGN browser-extension capture import audit',
    up: (database) => {
      database.exec(`
        CREATE TABLE gmgn_browser_import_batches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_path TEXT NOT NULL,
          source_sha256 TEXT NOT NULL UNIQUE,
          raw_source TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed')),
          imported_count INTEGER NOT NULL DEFAULT 0,
          skipped_count INTEGER NOT NULL DEFAULT 0,
          error_count INTEGER NOT NULL DEFAULT 0,
          imported_at TEXT NOT NULL,
          completed_at TEXT,
          archive_path TEXT,
          archive_sha256 TEXT,
          archived_at TEXT,
          error TEXT
        );
        CREATE INDEX idx_gmgn_browser_import_batches_imported_at
          ON gmgn_browser_import_batches(imported_at);
      `);
    },
  },
  {
    description: 'GMGN browser-extension coverage windows (verified capture-active periods)',
    up: (database) => {
      database.exec(`
        CREATE TABLE gmgn_browser_coverage_windows (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          batch_id INTEGER NOT NULL REFERENCES gmgn_browser_import_batches(id),
          started_at TEXT NOT NULL,
          ended_at TEXT,
          last_heartbeat_at TEXT NOT NULL,
          closed_reason TEXT,
          imported_at TEXT NOT NULL
        );
        CREATE INDEX idx_gmgn_browser_coverage_windows_batch
          ON gmgn_browser_coverage_windows(batch_id);
        CREATE INDEX idx_gmgn_browser_coverage_windows_started_at
          ON gmgn_browser_coverage_windows(started_at);
      `);
    },
  },
  {
    description: 'Birdeye historical outcome probe evidence',
    up: (database) => {
      database.exec(`
        CREATE TABLE birdeye_probe_batches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token_address TEXT NOT NULL,
          target_timestamp TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('completed', 'partial', 'failed')),
          price_http_status INTEGER,
          liquidity_http_status INTEGER,
          price_raw_payload TEXT,
          liquidity_raw_payload TEXT,
          price_error TEXT,
          liquidity_error TEXT,
          archive_path TEXT,
          archive_sha256 TEXT,
          archived_at TEXT
        );
        CREATE INDEX idx_birdeye_probe_batches_token_time ON birdeye_probe_batches(token_address, target_timestamp);
      `);
    },
  },
  {
    description: 'Dune signal outcome executions',
    up: (database) => {
      database.exec(`
        CREATE TABLE dune_outcome_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          signal_ids TEXT NOT NULL,
          query_sql TEXT NOT NULL,
          execution_id TEXT,
          status TEXT NOT NULL,
          raw_result TEXT,
          archive_path TEXT,
          archive_sha256 TEXT,
          requested_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE INDEX idx_dune_outcome_runs_requested_at ON dune_outcome_runs(requested_at);
      `);
    },
  },
];

export const latestSchemaVersion = migrations.length;

export const applyMigrations = (database: DatabaseSync): void => {
  database.exec('PRAGMA foreign_keys = ON;');
  const row = database.prepare('PRAGMA user_version').get() as { user_version: number };
  let currentVersion = row.user_version;

  if (currentVersion > latestSchemaVersion) {
    throw new Error(
      `Database schema version ${currentVersion} is newer than supported version ${latestSchemaVersion}.`,
    );
  }

  for (let index = currentVersion; index < migrations.length; index += 1) {
    const migration = migrations[index];
    database.exec('BEGIN IMMEDIATE;');
    try {
      migration.up(database);
      database.exec(`PRAGMA user_version = ${index + 1};`);
      database.exec('COMMIT;');
      currentVersion = index + 1;
    } catch (error) {
      database.exec('ROLLBACK;');
      throw new Error(`Migration ${index + 1} failed (${migration.description}).`, { cause: error });
    }
  }
};
