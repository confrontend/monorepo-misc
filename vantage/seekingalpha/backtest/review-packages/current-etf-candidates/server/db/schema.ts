import type { DatabaseSync } from 'node:sqlite';

// One immutable row per calculation pass. Never updated except to flip status
// running -> completed/failed once the snapshot below is fully written.
const CREATE_ANALYSIS_RUNS = `
CREATE TABLE IF NOT EXISTS analysis_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL,
  methodology_version TEXT NOT NULL,
  application_version TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT,
  input_summary_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_analysis_runs_lookup
  ON analysis_runs (fingerprint, methodology_version, status);
`;

// Roughly one result table per buildX() function in src/data.ts. Headline fields that are
// genuinely worth filtering/sorting/trending on are real columns; everything else (including
// nested per-event/per-point detail) lives in a *_json column so no information is lost without
// having to predict every future query shape up front.

const CREATE_TICKER_STRATEGY_RESULTS = `
CREATE TABLE IF NOT EXISTS ticker_strategy_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES analysis_runs(id),
  ticker TEXT NOT NULL,
  company TEXT,
  window TEXT NOT NULL,
  policy TEXT NOT NULL,
  signals INTEGER,
  latest_rating TEXT,
  hit_rate REAL,
  average_return REAL,
  median_return REAL,
  rating_changes INTEGER,
  ending_value REAL,
  total_return REAL,
  benchmark_available INTEGER,
  benchmark_total_return REAL,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_ticker_strategy_run ON ticker_strategy_results (run_id, ticker, window, policy);
`;

const CREATE_OVERALL_RESULTS = `
CREATE TABLE IF NOT EXISTS overall_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES analysis_runs(id),
  window TEXT NOT NULL,
  policy TEXT NOT NULL,
  tickers_tested INTEGER,
  total_tickers INTEGER,
  beat_benchmark_count INTEGER,
  beat_benchmark_rate REAL,
  average_extra_return REAL,
  median_extra_return REAL,
  average_strategy_return REAL,
  average_benchmark_return REAL,
  confidence TEXT,
  verdict TEXT
);
CREATE INDEX IF NOT EXISTS idx_overall_run ON overall_results (run_id, window, policy);
`;

const CREATE_STRONG_BUY_RESULTS = `
CREATE TABLE IF NOT EXISTS strong_buy_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES analysis_runs(id),
  ticker TEXT NOT NULL,
  company TEXT,
  completed_trades INTEGER,
  wins INTEGER,
  losses INTEGER,
  win_rate REAL,
  average_trade_return REAL,
  median_trade_return REAL,
  ending_value REAL,
  total_return REAL,
  open_trade_return REAL,
  date_range TEXT,
  trades_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_strong_buy_run ON strong_buy_results (run_id, ticker);
`;

const CREATE_RATING_TIER_RESULTS = `
CREATE TABLE IF NOT EXISTS rating_tier_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES analysis_runs(id),
  tier TEXT NOT NULL,
  window TEXT NOT NULL,
  ticker_count INTEGER,
  total_in_tier INTEGER,
  average_return REAL,
  median_return REAL
);
CREATE INDEX IF NOT EXISTS idx_rating_tier_run ON rating_tier_results (run_id, tier, window);
`;

const CREATE_RATING_TIER_TICKER_RESULTS = `
CREATE TABLE IF NOT EXISTS rating_tier_ticker_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES analysis_runs(id),
  ticker TEXT NOT NULL,
  company TEXT,
  tier TEXT NOT NULL,
  window TEXT NOT NULL,
  available INTEGER,
  total_return REAL
);
CREATE INDEX IF NOT EXISTS idx_rating_tier_ticker_run ON rating_tier_ticker_results (run_id, ticker, window);
`;

const CREATE_RATING_TIER_WIN_RATES = `
CREATE TABLE IF NOT EXISTS rating_tier_win_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES analysis_runs(id),
  tier TEXT NOT NULL,
  wins INTEGER,
  total INTEGER,
  win_rate REAL
);
CREATE INDEX IF NOT EXISTS idx_rating_tier_win_rates_run ON rating_tier_win_rates (run_id, tier);
`;

const CREATE_RATING_SCORE_CORRELATION = `
CREATE TABLE IF NOT EXISTS rating_score_correlation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES analysis_runs(id),
  correlation REAL,
  slope REAL,
  intercept REAL,
  points_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_rating_score_correlation_run ON rating_score_correlation (run_id);
`;

const CREATE_RATING_ACCURACY_RESULTS = `
CREATE TABLE IF NOT EXISTS rating_accuracy_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES analysis_runs(id),
  horizon_days INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  company TEXT,
  point_count INTEGER,
  correlation REAL,
  slope REAL,
  intercept REAL,
  points_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_rating_accuracy_run ON rating_accuracy_results (run_id, horizon_days, ticker);
`;

const CREATE_RATING_CALL_RESULTS = `
CREATE TABLE IF NOT EXISTS rating_call_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES analysis_runs(id),
  horizon_days INTEGER NOT NULL,
  scored_calls INTEGER,
  correct_calls INTEGER,
  incorrect_calls INTEGER,
  hit_rate REAL,
  hit_rate_low REAL,
  hit_rate_high REAL,
  average_return REAL,
  median_return REAL,
  open_calls INTEGER,
  neutral_calls INTEGER,
  calls_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_rating_call_results_run ON rating_call_results (run_id, horizon_days);
`;

const CREATE_PREDICTIVE_ACCURACY_RESULTS = `
CREATE TABLE IF NOT EXISTS predictive_accuracy_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES analysis_runs(id),
  horizon_days INTEGER NOT NULL,
  scored_calls INTEGER,
  correct_calls INTEGER,
  incorrect_calls INTEGER,
  hit_rate REAL,
  hit_rate_low REAL,
  hit_rate_high REAL,
  hit_rate_bootstrap_low REAL,
  hit_rate_bootstrap_high REAL,
  ticker_weighted_hit_rate REAL,
  average_return REAL,
  median_return REAL,
  censored_calls INTEGER,
  neutral_calls INTEGER,
  by_tier_json TEXT,
  outcomes_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_predictive_accuracy_run ON predictive_accuracy_results (run_id, horizon_days);
`;

const CREATE_STRONG_BUY_OUTLIER_RESULTS = `
CREATE TABLE IF NOT EXISTS strong_buy_outlier_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES analysis_runs(id),
  completed_trades INTEGER,
  tickers INTEGER,
  raw_mean_return REAL,
  median_return REAL,
  trimmed_mean_return REAL,
  winsorized_mean_return REAL,
  geometric_mean_return REAL,
  largest_winner_return REAL,
  largest_loser_return REAL,
  top1_percent_contribution_percent REAL,
  top5_percent_contribution_percent REAL,
  top10_percent_contribution_percent REAL,
  leave_one_out_min_mean_return REAL,
  leave_one_out_max_mean_return REAL,
  outlier_sensitive INTEGER,
  outlier_sensitive_reasons_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_strong_buy_outlier_run ON strong_buy_outlier_results (run_id);
`;

// Ordered, append-only list of schema migrations, tracked via SQLite's built-in `PRAGMA
// user_version` integer (no extra table needed to store "which version am I"). Each entry upgrades
// the database from its own array index to index + 1. Once a migration has shipped and could exist
// on a real on-disk database, never edit or reorder it -- only ever append a new one, the same
// append-only discipline already used for progress.md and for analysis_runs itself. This is what
// lets an existing database be upgraded in place instead of requiring a full wipe whenever a table
// or column changes.
// --- Ingestion layer -------------------------------------------------------------------------
// The tables above store *outputs* (one snapshot per calculation pass). Everything below stores
// *inputs*: the parsed contents of whatever JSON files are sitting in input/. That split is the
// point of the design -- raw tables are only ever written by the importer, never derived from
// anything, so every result in the database can be thrown away and rebuilt from them.
//
// No raw JSON is retained per row. The source file itself stays on disk and each row records
// which file it came from, which is what keeps this database small enough to open reliably.
const CREATE_SOURCE_FILES = `
CREATE TABLE IF NOT EXISTS source_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rel_path TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('imported', 'failed')),
  error TEXT,
  price_rows INTEGER NOT NULL DEFAULT 0,
  rating_rows INTEGER NOT NULL DEFAULT 0,
  quant_rows INTEGER NOT NULL DEFAULT 0,
  benchmark_rows INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL
);
`;

const CREATE_TICKERS = `
CREATE TABLE IF NOT EXISTS tickers (
  slug TEXT PRIMARY KEY,
  name TEXT,
  company_name TEXT,
  exchange TEXT,
  currency TEXT,
  sector TEXT,
  first_seen TEXT,
  last_seen TEXT
);
`;

// adj_close is stored, not computed at read time, so that every consumer -- data.ts, the Python
// pipeline, any future query -- uses one definition of "adjusted close" instead of each deciding
// how to combine close and div_adj_factor.
const CREATE_PRICES = `
CREATE TABLE IF NOT EXISTS prices (
  ticker_slug TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  open REAL, high REAL, low REAL, close REAL, volume REAL,
  div_adj_factor REAL,
  adj_close REAL,
  api_id TEXT,
  source_file_id INTEGER NOT NULL REFERENCES source_files(id),
  PRIMARY KEY (ticker_slug, as_of_date)
);
CREATE INDEX IF NOT EXISTS idx_prices_source ON prices (source_file_id);
CREATE INDEX IF NOT EXISTS idx_prices_date ON prices (as_of_date);
`;

const CREATE_RATING_CHANGES = `
CREATE TABLE IF NOT EXISTS rating_changes (
  api_id TEXT PRIMARY KEY,
  ticker_slug TEXT NOT NULL,
  created_at TEXT NOT NULL,
  new_rating TEXT,
  previous_rating TEXT,
  rating_new REAL,
  rating_previous REAL,
  market_cap REAL,
  div_yield REAL,
  analysts INTEGER,
  sector_display TEXT,
  source_file_id INTEGER NOT NULL REFERENCES source_files(id)
);
CREATE INDEX IF NOT EXISTS idx_rating_changes_ticker ON rating_changes (ticker_slug, created_at);
CREATE INDEX IF NOT EXISTS idx_rating_changes_source ON rating_changes (source_file_id);
`;

// The hand-curated captures are a different observation entirely: one row per day with the rating
// as it stood that day, plus the factor grades. Kept in its own table rather than forced into
// rating_changes, because a daily snapshot is not a change event and merging them would invent
// transitions that never happened.
const CREATE_QUANT_HISTORY = `
CREATE TABLE IF NOT EXISTS quant_history (
  ticker_slug TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  price REAL,
  quant_rating TEXT,
  quant_score REAL,
  valuation TEXT, growth TEXT, profitability TEXT, momentum TEXT, eps_revisions TEXT,
  source_file_id INTEGER NOT NULL REFERENCES source_files(id),
  PRIMARY KEY (ticker_slug, as_of_date)
);
CREATE INDEX IF NOT EXISTS idx_quant_history_source ON quant_history (source_file_id);
`;

const CREATE_BENCHMARK_PRICES = `
CREATE TABLE IF NOT EXISTS benchmark_prices (
  symbol TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  close REAL,
  adj_close REAL,
  source TEXT,
  source_file_id INTEGER NOT NULL REFERENCES source_files(id),
  PRIMARY KEY (symbol, as_of_date)
);
CREATE INDEX IF NOT EXISTS idx_benchmark_source ON benchmark_prices (source_file_id);
`;

// Single row. Replaces vite.config.ts's buildFingerprint(): "has the data changed" becomes a
// number the importer bumps, rather than a hash of directory mtimes recomputed on every request.
const CREATE_DATA_VERSION = `
CREATE TABLE IF NOT EXISTS data_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  price_rows INTEGER NOT NULL DEFAULT 0,
  rating_rows INTEGER NOT NULL DEFAULT 0,
  last_import_json TEXT
);
INSERT OR IGNORE INTO data_version (id, version, updated_at) VALUES (1, 0, '1970-01-01T00:00:00.000Z');
`;

// Compatibility views, so research/pipeline.py's existing sqlite loader -- which looks for tables
// named historical_prices and ticker_changes with these exact column names -- runs against this
// database unmodified. Validated statistical code should not have to be edited just because its
// input moved.
const CREATE_PIPELINE_VIEWS = `
CREATE VIEW IF NOT EXISTS historical_prices AS
  SELECT ticker_slug, as_of_date, close, div_adj_factor FROM prices;
CREATE VIEW IF NOT EXISTS ticker_changes AS
  SELECT ticker_slug, created_at, new_rating, sector_display FROM rating_changes;
`;

type Migration = { description: string; up: (db: DatabaseSync) => void };

const migrations: Migration[] = [
  {
    description: 'initial schema: analysis_runs + one result table per tab',
    up: (db) => {
      [
        CREATE_ANALYSIS_RUNS,
        CREATE_TICKER_STRATEGY_RESULTS,
        CREATE_OVERALL_RESULTS,
        CREATE_STRONG_BUY_RESULTS,
        CREATE_RATING_TIER_RESULTS,
        CREATE_RATING_TIER_TICKER_RESULTS,
        CREATE_RATING_TIER_WIN_RATES,
        CREATE_RATING_SCORE_CORRELATION,
        CREATE_RATING_ACCURACY_RESULTS,
        CREATE_RATING_CALL_RESULTS,
      ].forEach((statement) => db.exec(statement));
    },
  },
  {
    description: 'methodology config snapshot + predictive-accuracy and Strong Buy outlier tables + bootstrap/tier columns on rating_call_results',
    up: (db) => {
      db.exec('ALTER TABLE analysis_runs ADD COLUMN methodology_config_json TEXT;');
      db.exec('ALTER TABLE rating_call_results ADD COLUMN hit_rate_bootstrap_low REAL;');
      db.exec('ALTER TABLE rating_call_results ADD COLUMN hit_rate_bootstrap_high REAL;');
      db.exec('ALTER TABLE rating_call_results ADD COLUMN ticker_weighted_hit_rate REAL;');
      db.exec('ALTER TABLE rating_call_results ADD COLUMN by_tier_json TEXT;');
      db.exec('ALTER TABLE rating_call_results ADD COLUMN unenterable_calls INTEGER;');
      [CREATE_PREDICTIVE_ACCURACY_RESULTS, CREATE_STRONG_BUY_OUTLIER_RESULTS].forEach((statement) => db.exec(statement));
    },
  },
  {
    description: 'ingestion layer: source_files + raw price/rating/quant/benchmark tables, data_version, pipeline compatibility views',
    up: (db) => {
      [
        CREATE_SOURCE_FILES,
        CREATE_TICKERS,
        CREATE_PRICES,
        CREATE_RATING_CHANGES,
        CREATE_QUANT_HISTORY,
        CREATE_BENCHMARK_PRICES,
        CREATE_DATA_VERSION,
        CREATE_PIPELINE_VIEWS,
      ].forEach((statement) => db.exec(statement));
      db.exec('ALTER TABLE analysis_runs ADD COLUMN data_version INTEGER;');
    },
  },
  {
    description: 'preserve stock/fund type metadata for ETF-only analysis',
    up: (db) => {
      db.exec('ALTER TABLE tickers ADD COLUMN fund_type TEXT;');
    },
  },
  {
    description: 'track importer parser revisions so metadata improvements reprocess unchanged files',
    up: (db) => {
      db.exec('ALTER TABLE source_files ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 1;');
    },
  },
];

// WAL is the right default on a normal disk, but it cannot be used on every filesystem this
// project actually runs on. Over a Windows drive mounted into WSL (/mnt/c/...) — and over the FUSE
// mount used in the sandbox — SQLite cannot manage its journal files and every write fails with
// "disk I/O error". That is the real cause of the unreadable 640 MB analysis.sqlite: it was opened
// in WAL mode and left a 216 MB -wal file it could never check-point back in.
//
// TRUNCATE zeroes the journal in place instead of unlinking it, which is precisely the operation
// those filesystems do allow. So: ask for WAL, verify SQLite actually granted it, and fall back
// rather than assuming. DELETE is not a fallback — it unlinks, so it fails the same way.
// TRUNCATE, unconditionally — not "WAL with a fallback".
//
// Detecting WAL support at runtime does not work here, and the failure it produces is the worst
// kind. On a Windows drive mounted into WSL (/mnt/c/...) and on the sandbox's FUSE mount, SQLite
// accepts `PRAGMA journal_mode = WAL`, accepts a probe write, serves an entire session happily —
// and then the database cannot be reopened by the next process, because the header now says WAL
// and the -wal file can never be check-pointed back in. That is exactly how the old 640 MB
// analysis.sqlite became unreadable, with a 216 MB orphaned -wal beside it.
//
// So this never asks for WAL. TRUNCATE zeroes the journal in place rather than unlinking it, which
// is the operation these filesystems actually support, and there is nothing to gain from WAL in a
// single-process dev server that already runs with synchronous = OFF.
const setJournalMode = (db: DatabaseSync): string => {
  try {
    const result = db.prepare('PRAGMA journal_mode = TRUNCATE').get() as { journal_mode?: string } | undefined;
    return String(result?.journal_mode ?? 'unknown').toLowerCase();
  } catch {
    return 'unknown';
  }
};

export const applySchema = (db: DatabaseSync): void => {
  setJournalMode(db);
  db.exec('PRAGMA foreign_keys = ON;');
  // synchronous = OFF trades durability-on-power-loss for not calling fsync on every commit. On a
  // mounted Windows drive or a FUSE mount that fsync is the entire cost: the same 170,000-row
  // insert takes over three minutes with it and 1.3 seconds without, and under sustained load it
  // was also producing outright "disk I/O error" failures. The trade is acceptable here precisely
  // because nothing in this database is original — every row is derived from a JSON file in
  // input/, so the worst case is pressing Import again.
  db.exec('PRAGMA synchronous = OFF;');
  db.exec('PRAGMA temp_store = MEMORY;');
  db.exec('PRAGMA cache_size = -64000;');

  const currentVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let index = currentVersion; index < migrations.length; index += 1) {
    const migration = migrations[index];
    db.exec('BEGIN');
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${index + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration ${index + 1} ("${migration.description}") failed: ${message}`);
    }
  }
};
