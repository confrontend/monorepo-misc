import type { DatabaseSync } from 'node:sqlite';

/**
 * PostgreSQL operation persistence used by the production worker.  The
 * synchronous SQLite helpers below remain available for the current legacy
 * server, while these helpers keep operation/progress state durable when the
 * worker is moved to PostgreSQL.  They deliberately use the same column names
 * and status values as the SQLite schema so either backend produces identical
 * diagnostics.
 */
export type OperationStatus = 'processing' | 'completed' | 'failed';
export type PostgresJobStatus = 'queued' | 'running' | 'retrying' | 'completed' | 'failed' | 'cancelled';

export type PostgresQueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
export type PostgresQueryRunner = { query: (...args: unknown[]) => Promise<PostgresQueryResult> };

const jsonObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
};

export const startPostgresOperation = async (pool: PostgresQueryRunner, operation: string, startedAt = new Date().toISOString(), payload: Record<string, unknown> = {}): Promise<number> => {
  const result = await pool.query(
    `INSERT INTO uw_job_runs (kind, status, payload, progress, created_at, started_at, updated_at)
     VALUES ($1, 'running', $3::jsonb, '{}'::jsonb, $2, $2, $2) RETURNING id`,
    [operation, startedAt, JSON.stringify(payload)],
  );
  return Number(result.rows[0]?.id);
};

export const readPostgresOperation = async (pool: PostgresQueryRunner, id: number) => {
  const result = await pool.query(
    `SELECT id, kind, status, payload, progress, error, attempt, created_at AS "createdAt",
            started_at AS "startedAt", completed_at AS "completedAt", updated_at AS "updatedAt"
       FROM uw_job_runs WHERE id=$1`, [id],
  );
  return result.rows[0] ?? null;
};

/** Atomically claims a queued/retrying job. A cancelled job is never resurrected. */
export const claimPostgresOperation = async (pool: PostgresQueryRunner, id: number, startedAt = new Date().toISOString()) => {
  const result = await pool.query(
    `UPDATE uw_job_runs SET status='running', attempt=attempt+1, started_at=COALESCE(started_at,$1), updated_at=$1
       WHERE id=$2 AND status IN ('queued','retrying') RETURNING id, attempt`, [startedAt, id],
  );
  return result.rows[0] ?? null;
};

export const retryPostgresOperation = async (pool: PostgresQueryRunner, id: number, error: string, retryAt = new Date().toISOString()) => {
  await pool.query(`UPDATE uw_job_runs SET status='retrying', error=$1, updated_at=$2 WHERE id=$3 AND status IN ('running','retrying')`, [error, retryAt, id]);
};

export const cancelPostgresOperation = async (pool: PostgresQueryRunner, id: number, reason = 'Cancelled by request', completedAt = new Date().toISOString()) => {
  const result = await pool.query(
    `UPDATE uw_job_runs SET status='cancelled', error=COALESCE(error,$1), completed_at=$2, updated_at=$2
       WHERE id=$3 AND status IN ('queued','running','retrying') RETURNING id`, [reason, completedAt, id],
  );
  return (result.rowCount ?? 0) > 0;
};

export const finishPostgresOperation = async (pool: PostgresQueryRunner, id: number, status: Exclude<OperationStatus, 'processing'>, details: Record<string, unknown> = {}, error: string | null = null, completedAt = new Date().toISOString()) => {
  await pool.query(
    `UPDATE uw_job_runs SET completed_at=$1, status=$2, error=$3, progress=$4::jsonb, updated_at=$1 WHERE id=$5`,
    [completedAt, status, error, JSON.stringify(details), id],
  );
};

export const updatePostgresOperation = async (pool: PostgresQueryRunner, id: number, details: Record<string, unknown>) => {
  const result = await pool.query(
    `SELECT progress FROM uw_job_runs WHERE id=$1 AND status IN ('running','retrying')`, [id],
  );
  const current = jsonObject(result.rows[0]?.progress);
  await pool.query(
    `UPDATE uw_job_runs SET progress=$1::jsonb, updated_at=now() WHERE id=$2 AND status IN ('running','retrying')`,
    [JSON.stringify({ ...current, ...details }), id],
  );
};

export const markPostgresProcessingOperationsFailed = async (pool: PostgresQueryRunner, reason: string, completedAt = new Date().toISOString()) => {
  const result = await pool.query(
    `UPDATE uw_job_runs SET completed_at=$1, status='failed', error=COALESCE(error, $2), updated_at=$1 WHERE status IN ('running','retrying') RETURNING id`,
    [completedAt, reason],
  );
  return result.rowCount ?? 0;
};

export const upsertPostgresHistoricalCoverage = async (pool: PostgresQueryRunner, input: {
  signalType: string; tradingDate: string; endpoint: string; startedAt?: string;
}) => {
  const startedAt = input.startedAt ?? new Date().toISOString();
  await pool.query(`
    INSERT INTO uw_historical_coverage (signal_type, trading_date, endpoint, started_at, status)
    VALUES ($1, $2, $3, $4, 'processing')
    ON CONFLICT (signal_type, trading_date) DO UPDATE SET endpoint=EXCLUDED.endpoint,
      started_at=EXCLUDED.started_at, completed_at=NULL, status='processing', error=NULL,
      bytes_received=NULL, bytes_expected=NULL, progress_updated_at=NULL`,
    [input.signalType, input.tradingDate, input.endpoint, startedAt],
  );
};

export const updatePostgresHistoricalProgress = async (pool: PostgresQueryRunner, input: {
  signalType: string; tradingDate: string; bytesReceived?: number | null; bytesExpected?: number | null;
  receivedCount?: number; insertedCount?: number; duplicateCount?: number; updatedAt?: string;
}) => {
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  await pool.query(`
    UPDATE uw_historical_coverage SET
      bytes_received=COALESCE($1, bytes_received), bytes_expected=COALESCE($2, bytes_expected),
      received_count=COALESCE($3, received_count), inserted_count=COALESCE($4, inserted_count),
      duplicate_count=COALESCE($5, duplicate_count), progress_updated_at=$6
    WHERE signal_type=$7 AND trading_date=$8`,
    [input.bytesReceived ?? null, input.bytesExpected ?? null, input.receivedCount ?? null,
      input.insertedCount ?? null, input.duplicateCount ?? null, updatedAt, input.signalType, input.tradingDate],
  );
};

export const finishPostgresHistoricalCoverage = async (pool: PostgresQueryRunner, input: {
  signalType: string; tradingDate: string; status: Exclude<OperationStatus, 'processing'>;
  receivedCount?: number; insertedCount?: number; duplicateCount?: number; error?: string | null; completedAt?: string;
}) => {
  await pool.query(`
    UPDATE uw_historical_coverage SET completed_at=$1, status=$2,
      received_count=COALESCE($3, received_count), inserted_count=COALESCE($4, inserted_count),
      duplicate_count=COALESCE($5, duplicate_count), error=$6, progress_updated_at=$1
    WHERE signal_type=$7 AND trading_date=$8`,
    [input.completedAt ?? new Date().toISOString(), input.status, input.receivedCount ?? null,
      input.insertedCount ?? null, input.duplicateCount ?? null, input.error ?? null, input.signalType, input.tradingDate],
  );
};

export const updatePostgresOutcomeCheckpoint = async (pool: PostgresQueryRunner, input: {
  jobId: number; lastSymbol?: string | null; lastExecutedAt?: string | null; lastTradeId?: number | null;
  completed: number; total: number; updatedAt?: string;
}) => {
  await pool.query(`
    INSERT INTO uw_outcome_checkpoints (job_id, last_symbol, last_executed_at, last_trade_id, completed, total, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (job_id) DO UPDATE SET last_symbol=EXCLUDED.last_symbol,
      last_executed_at=EXCLUDED.last_executed_at, last_trade_id=EXCLUDED.last_trade_id,
      completed=EXCLUDED.completed, total=EXCLUDED.total, updated_at=EXCLUDED.updated_at`,
    [input.jobId, input.lastSymbol ?? null, input.lastExecutedAt ?? null, input.lastTradeId ?? null,
      input.completed, input.total, input.updatedAt ?? new Date().toISOString()],
  );
};

export const readPostgresOutcomeCheckpoint = async (pool: PostgresQueryRunner, jobId: number) => {
  const result = await pool.query(`SELECT job_id AS "jobId", last_symbol AS "lastSymbol", last_executed_at AS "lastExecutedAt", last_trade_id AS "lastTradeId", completed, total, updated_at AS "updatedAt" FROM uw_outcome_checkpoints WHERE job_id=$1`, [jobId]);
  return result.rows[0] ?? null;
};

type CountRow = { count: number };

const count = (database: DatabaseSync, query: string) =>
  Number((database.prepare(query).get() as unknown as CountRow | undefined)?.count ?? 0);

export const startOperation = (database: DatabaseSync, operation: string, startedAt = new Date().toISOString()) => {
  const result = database.prepare(`INSERT INTO uw_operation_logs (operation, started_at, status) VALUES (?, ?, 'processing')`).run(operation, startedAt);
  return Number(result.lastInsertRowid);
};

export const finishOperation = (database: DatabaseSync, id: number, status: 'completed' | 'failed', details: Record<string, unknown> = {}, error: string | null = null, completedAt = new Date().toISOString()) => {
  database.prepare(`UPDATE uw_operation_logs SET completed_at=?, status=?, error=?, details_json=? WHERE id=?`)
    .run(completedAt, status, error, JSON.stringify(details), id);
};

export const updateOperation = (database: DatabaseSync, id: number, details: Record<string, unknown>) => {
  const current = database.prepare(`SELECT details_json AS detailsJson FROM uw_operation_logs WHERE id=? AND status='processing'`).get(id) as { detailsJson?: string } | undefined;
  let previous: Record<string, unknown> = {};
  try { const parsed = JSON.parse(String(current?.detailsJson ?? '{}')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) previous = parsed as Record<string, unknown>; } catch { /* replace malformed details */ }
  database.prepare(`UPDATE uw_operation_logs SET details_json=? WHERE id=? AND status='processing'`)
    .run(JSON.stringify({ ...previous, ...details }), id);
};

export const readDiagnostics = (database: DatabaseSync) => {
  const schemaVersion = database.prepare(`SELECT value FROM app_metadata WHERE key='schema_version'`).get() as { value?: string } | undefined;
  const latestImport = database.prepare(`SELECT id, endpoint, requested_at AS requestedAt, completed_at AS completedAt, status, http_status AS httpStatus, received_count AS received, inserted_count AS inserted, duplicate_count AS duplicates, error FROM uw_import_batches ORDER BY id DESC LIMIT 1`).get() ?? null;
  const recentOperations = database.prepare(`SELECT id, operation, started_at AS startedAt, completed_at AS completedAt, status, error, details_json AS detailsJson FROM uw_operation_logs ORDER BY id DESC LIMIT 20`).all() as unknown as Array<Record<string, unknown>>;
  const operations = recentOperations.map((operation) => {
    let details: unknown = {};
    try { details = JSON.parse(String(operation.detailsJson ?? '{}')); } catch { details = { parseError: true }; }
    return { ...operation, detailsJson: undefined, details };
  });
  const exclusionReasons = database.prepare(`SELECT COALESCE(exclusion_reason, 'usable') AS reason, COUNT(*) AS count FROM uw_signal_outcomes GROUP BY COALESCE(exclusion_reason, 'usable') ORDER BY count DESC`).all();
  const validationErrors = database.prepare(`SELECT validation_errors AS errors FROM uw_option_trades WHERE validation_errors <> '[]'`).all() as unknown as Array<{ errors: string }>;
  const validationErrorCounts: Record<string, number> = {};
  for (const row of validationErrors) {
    try {
      for (const error of JSON.parse(row.errors) as string[]) validationErrorCounts[error] = (validationErrorCounts[error] ?? 0) + 1;
    } catch { validationErrorCounts.invalid_validation_errors = (validationErrorCounts.invalid_validation_errors ?? 0) + 1; }
  }
  const historicalCoverage = database.prepare(`SELECT signal_type AS signalType, status, COUNT(*) AS days, SUM(received_count) AS received, SUM(inserted_count) AS inserted, MAX(error) AS error FROM uw_historical_coverage GROUP BY signal_type, status ORDER BY signal_type, status`).all();
  // The single currently-running day, if any, with its live byte/row counters -- this is what
  // makes a determinate in-progress bar possible; the grouped query above only has day counts.
  const activeHistoricalDay = database.prepare(`
    SELECT signal_type AS signalType, trading_date AS tradingDate, started_at AS startedAt,
           bytes_received AS bytesReceived, bytes_expected AS bytesExpected,
           received_count AS receivedCount, inserted_count AS insertedCount,
           progress_updated_at AS progressUpdatedAt
    FROM uw_historical_coverage WHERE status = 'processing' ORDER BY started_at DESC LIMIT 1
  `).get() ?? null;
  const processingImport = database.prepare(`
    SELECT id, endpoint, requested_at AS requestedAt, query_json AS queryJson,
           received_count AS received, inserted_count AS inserted
    FROM uw_import_batches
    WHERE status='processing' AND endpoint IN ('/api/option-trades/full-tape', '/api/darkpool/recent')
    ORDER BY id DESC LIMIT 1
  `).get() as { id?: number; endpoint?: string; requestedAt?: string; queryJson?: string; received?: number; inserted?: number } | undefined;
  const processingCoverage = database.prepare(`
    SELECT signal_type AS signalType, trading_date AS tradingDate, endpoint, started_at AS startedAt,
           bytes_received AS bytesReceived, bytes_expected AS bytesExpected, progress_updated_at AS progressUpdatedAt
    FROM uw_historical_coverage WHERE status='processing' ORDER BY started_at DESC LIMIT 1
  `).get() as { signalType?: string; tradingDate?: string; endpoint?: string; startedAt?: string; bytesReceived?: number; bytesExpected?: number; progressUpdatedAt?: string } | undefined;
  let processingQuery: Record<string, unknown> = {};
  try { const parsed = JSON.parse(String(processingImport?.queryJson ?? '{}')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) processingQuery = parsed as Record<string, unknown>; } catch { /* keep empty */ }
  const historicalActivity = processingImport ? {
    status: activeHistoricalDay ? 'downloading' : 'requesting_provider_file',
    importId: processingImport.id ?? null,
    signalType: processingQuery.type === 'call' ? 'call_sweep' : processingQuery.type === 'put' ? 'put_sweep' : processingImport.endpoint === '/api/darkpool/recent' ? 'dark_pool_block' : null,
    tradingDate: processingCoverage?.tradingDate ?? null,
    requestUrl: processingCoverage?.endpoint ?? processingImport.endpoint ?? null,
    requestStartedAt: processingCoverage?.startedAt ?? processingImport.requestedAt ?? null,
    progressUpdatedAt: processingCoverage?.progressUpdatedAt ?? null,
    requestedAt: processingImport.requestedAt ?? null,
    received: processingImport.received ?? 0,
    inserted: processingImport.inserted ?? 0,
    bytesReceived: activeHistoricalDay?.bytesReceived ?? processingCoverage?.bytesReceived ?? 0,
    bytesExpected: activeHistoricalDay?.bytesExpected ?? processingCoverage?.bytesExpected ?? null,
  } : null;
  const historicalRequestRows = database.prepare(`
    SELECT id, endpoint, query_json AS queryJson, requested_at AS requestedAt, status
    FROM uw_import_batches
    WHERE endpoint IN ('/api/option-trades/full-tape', '/api/darkpool/recent')
    ORDER BY id DESC LIMIT 20
  `).all() as unknown as Array<Record<string, unknown>>;
  const historicalRequests = historicalRequestRows.map((row) => {
    let query: Record<string, unknown> = {};
    try { const parsed = JSON.parse(String(row.queryJson ?? '{}')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) query = parsed as Record<string, unknown>; } catch { /* keep empty */ }
    return { id: row.id, endpoint: row.endpoint, requestedAt: row.requestedAt, status: row.status, from: query.from ?? null, to: query.to ?? null, type: query.type ?? null };
  });
  return {
    generatedAt: new Date().toISOString(),
    database: {
      connected: true,
      schemaVersion: schemaVersion?.value ?? null,
      optionTrades: count(database, 'SELECT COUNT(*) AS count FROM uw_option_trades'),
      darkPoolTrades: count(database, 'SELECT COUNT(*) AS count FROM uw_dark_pool_trades'),
      marketBars: count(database, 'SELECT COUNT(*) AS count FROM uw_market_bars'),
      outcomeRows: count(database, 'SELECT COUNT(*) AS count FROM uw_signal_outcomes'),
    },
    latestImport,
    outcomeExclusionReasons: exclusionReasons,
    validationErrorCounts,
    historicalCoverage,
    activeHistoricalDay,
    historicalActivity,
    historicalRequests,
    recentOperations: operations,
  };
};
