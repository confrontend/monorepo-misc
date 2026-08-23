CREATE TABLE IF NOT EXISTS uw_job_runs (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','retrying','completed','failed','cancelled')),
  payload JSONB NOT NULL,
  progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS uw_job_runs_status_idx ON uw_job_runs(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS uw_outcome_checkpoints (
  job_id BIGINT PRIMARY KEY REFERENCES uw_job_runs(id) ON DELETE CASCADE,
  last_symbol TEXT,
  last_executed_at TIMESTAMPTZ,
  last_trade_id BIGINT,
  completed BIGINT NOT NULL DEFAULT 0,
  total BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS uw_comparison_snapshots (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT REFERENCES uw_job_runs(id),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS uw_comparison_snapshots_created_idx ON uw_comparison_snapshots(created_at DESC);
