CREATE TABLE IF NOT EXISTS uw_import_batches (
  id BIGINT PRIMARY KEY,
  endpoint TEXT NOT NULL, query_json JSONB NOT NULL, requested_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ, status TEXT NOT NULL, http_status INTEGER,
  received_count BIGINT NOT NULL DEFAULT 0, inserted_count BIGINT NOT NULL DEFAULT 0,
  duplicate_count BIGINT NOT NULL DEFAULT 0, response_sha256 TEXT, raw_response TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS uw_option_trades (
  id BIGINT PRIMARY KEY, source_trade_id TEXT UNIQUE NOT NULL, source_batch_id BIGINT,
  executed_at TIMESTAMPTZ, captured_at TIMESTAMPTZ NOT NULL, signal_type TEXT NOT NULL,
  underlying_symbol TEXT, option_chain_id TEXT, option_type TEXT, expiry TEXT, strike TEXT,
  premium TEXT, price TEXT, size BIGINT, underlying_price TEXT, open_interest BIGINT,
  volume BIGINT, nbbo_bid TEXT, nbbo_ask TEXT, report_flags JSONB NOT NULL DEFAULT '[]',
  tags JSONB NOT NULL DEFAULT '[]', canceled BOOLEAN NOT NULL DEFAULT FALSE,
  raw_payload JSONB NOT NULL, validation_errors JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS uw_option_signal_idx ON uw_option_trades(signal_type, canceled, id);
CREATE TABLE IF NOT EXISTS uw_dark_pool_trades (
  id BIGINT PRIMARY KEY, source_trade_id TEXT UNIQUE NOT NULL, executed_at TIMESTAMPTZ,
  captured_at TIMESTAMPTZ NOT NULL, ticker TEXT, price TEXT, size DOUBLE PRECISION,
  premium TEXT, canceled BOOLEAN NOT NULL DEFAULT FALSE, raw_payload JSONB NOT NULL,
  validation_errors JSONB NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS uw_historical_coverage (
  id BIGINT PRIMARY KEY, signal_type TEXT NOT NULL, trading_date DATE NOT NULL,
  endpoint TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ,
  status TEXT NOT NULL, received_count BIGINT NOT NULL DEFAULT 0,
  inserted_count BIGINT NOT NULL DEFAULT 0, duplicate_count BIGINT NOT NULL DEFAULT 0,
  error TEXT, bytes_received BIGINT, bytes_expected BIGINT, progress_updated_at TIMESTAMPTZ,
  UNIQUE(signal_type, trading_date)
);
CREATE TABLE IF NOT EXISTS uw_market_bars (
  id BIGINT PRIMARY KEY, symbol TEXT NOT NULL, timeframe TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL, open DOUBLE PRECISION, high DOUBLE PRECISION,
  low DOUBLE PRECISION, close DOUBLE PRECISION NOT NULL, volume DOUBLE PRECISION,
  source TEXT NOT NULL, retrieved_at TIMESTAMPTZ NOT NULL,
  UNIQUE(symbol, timeframe, observed_at)
);
CREATE TABLE IF NOT EXISTS uw_signal_outcomes (
  id BIGINT PRIMARY KEY, trade_id BIGINT NOT NULL, horizon TEXT NOT NULL,
  entry_at TIMESTAMPTZ, entry_price DOUBLE PRECISION, outcome_at TIMESTAMPTZ,
  outcome_price DOUBLE PRECISION, spy_entry_price DOUBLE PRECISION,
  spy_outcome_price DOUBLE PRECISION, return_pct DOUBLE PRECISION,
  spy_return_pct DOUBLE PRECISION, excess_return_pct DOUBLE PRECISION,
  exclusion_reason TEXT, calculated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(trade_id, horizon)
);
CREATE INDEX IF NOT EXISTS uw_outcome_horizon_idx ON uw_signal_outcomes(horizon, trade_id);
