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

const ALL_STATEMENTS = [
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
];

export const applySchema = (db: DatabaseSync): void => {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  ALL_STATEMENTS.forEach((statement) => db.exec(statement));
};
