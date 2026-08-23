import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import type { HealthStatus } from '../models/health.js';
import { createDatabase } from '../db/client.js';
import { probeOptionTrades } from '../providers/unusualwhales.js';
import { readSignalDataSummary, syncRecentCallSweeps } from '../providers/unusualwhales-ingest.js';
import { readOutcomeSummary, refreshOutcomes } from '../research/outcomes.js';
import { refreshPostgresOutcomes } from '../research/postgres-outcomes.js';
import { peekCachedComparison, type CachedSignalComparison } from '../research/comparison.js';
import { refreshMarketPrices, refreshMarketPricesPostgres } from '../providers/market-data.js';
import { cancelPostgresOperation, finishOperation, finishPostgresOperation, markPostgresProcessingOperationsFailed, readDiagnostics, startOperation, startPostgresOperation, updateOperation } from '../diagnostics.js';
import { syncRecentPutSweeps } from '../providers/put-sweeps.js';
import { fetchRecentDarkPool } from '../providers/dark-pool.js';
import { backfillHistoricalSignals, type HistoricalSignalType } from '../providers/historical-backfill.js';
import { checkPostgresReadiness, configuredDatabaseBackend, databaseBackendStatus, postgresResearchPool } from '../db/backend.js';
import { readPostgresComparison } from '../research/postgres-comparison.js';
import { syncRecentSweepsToPostgres } from '../providers/postgres-sweeps.js';

const database = createDatabase();
const port = Number.parseInt(process.env.API_PORT ?? '4273', 10);
const staticRoot = path.resolve(process.cwd(), 'dist-ui');
let activeBackfillController: AbortController | null = null;
let activeBackfillOperationId: number | null = null;
let activeBackfillWorker: Worker | null = null;
let activePostgresBackfillWorker: Worker | null = null;
let activePostgresJobId: number | null = null;
let activeOptionFeatureWorker: Worker | null = null;
const MAX_BACKFILL_RETRIES = 3;
const backfillRetryTimers = new Set<ReturnType<typeof setTimeout>>();

// The API runs in two supported modes: tsx against src/ during development and
// plain Node against dist/ in production. Resolve workers for both layouts so a
// development server does not look for a JavaScript file that only exists after
// compilation. Worker threads inherit the tsx loader through execArgv.
const workerUrl = (name: string) => {
  const javascriptUrl = new URL(`./${name}.js`, import.meta.url);
  if (existsSync(javascriptUrl)) return javascriptUrl;
  const typescriptUrl = new URL(`./${name}.ts`, import.meta.url);
  if (existsSync(typescriptUrl)) return typescriptUrl;
  throw new Error(`Worker script not found: ${name}.js or ${name}.ts`);
};

// A process restart interrupts network work. Do not leave the UI showing a job as
// permanently active after that restart; all rows already inserted remain valid.
const interruptedAt = new Date().toISOString();
const interruptedBackfill = configuredDatabaseBackend() === 'sqlite'
  ? database.prepare(`SELECT id, details_json AS detailsJson FROM uw_operation_logs WHERE operation='signals.historical_backfill' AND status='processing' ORDER BY id DESC LIMIT 1`).get() as { id?: number; detailsJson?: string } | undefined
  : undefined;
if (configuredDatabaseBackend() === 'sqlite') {
  database.prepare(`UPDATE uw_operation_logs SET completed_at=?, status='failed', error=COALESCE(error, 'Interrupted by server restart') WHERE status='processing'`).run(interruptedAt);
  database.prepare(`UPDATE uw_import_batches SET completed_at=?, status='failed', error=COALESCE(error, 'Interrupted by server restart') WHERE status='processing'`).run(interruptedAt);
  database.prepare(`UPDATE uw_historical_coverage SET completed_at=?, status='failed', error=COALESCE(error, 'Interrupted by server restart') WHERE status='processing'`).run(interruptedAt);
}

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const readJsonBody = async (request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Request body must be a JSON object');
  return parsed as Record<string, unknown>;
};

const canonicalSignalTypes = (requestedTypes: unknown): HistoricalSignalType[] => {
  const values = Array.isArray(requestedTypes) ? requestedTypes : ['call_sweep', 'put_sweep'];
  return [...new Set(values.map((value) => value === 'call_sweeps' ? 'call_sweep' : value === 'put_sweeps' ? 'put_sweep' : value === 'dark_pool_blocks' ? 'dark_pool_block' : value)
    .filter((value): value is HistoricalSignalType => ['call_sweep', 'put_sweep', 'dark_pool_block', 'repeated_sweeps', 'flow_imbalance', 'open_interest_spike', 'gex_gamma', 'market_etf_flow', 'insider_activity', 'congress_activity'].includes(value as string)))];
};

const latestResumableRange = () => {
  const rows = database.prepare(`SELECT endpoint, query_json AS queryJson FROM uw_import_batches WHERE endpoint='/api/option-trades/full-tape' ORDER BY id DESC LIMIT 12`).all() as unknown as Array<{ endpoint: string; queryJson: string }>;
  for (const row of rows) {
    try {
      const query = JSON.parse(row.queryJson) as Record<string, unknown>;
      if (typeof query.from === 'string' && typeof query.to === 'string' && (query.type === 'call' || query.type === 'put')) return { from: query.from, to: query.to };
    } catch { /* ignore malformed historical metadata */ }
  }
  return null;
};

const runHistoricalBackfill = async (from: string, to: string, signalTypes: HistoricalSignalType[], controller: AbortController, operationId: number) => {
  const result = await backfillHistoricalSignals(database, { from, to, signalTypes, abortSignal: controller.signal });
  const marketRefresh = await refreshMarketPrices(database);
  const outcomeRows = refreshOutcomes(database);
  warmComparisonCache();
  const responseBody = { ...result, skipped: result.skippedDays + result.excludedOutsideRange, marketRefresh, outcomeRows };
  finishOperation(database, operationId, result.status === 'failed' ? 'failed' : 'completed', responseBody, result.errors.length ? result.errors.join('; ') : null);
  return responseBody;
};

const launchHistoricalBackfillWorker = (from: string, to: string, signalTypes: HistoricalSignalType[], operationId: number, retryAttempt = 0) => {
  const databasePath = process.env.UNUSUAL_WHALES_DB_PATH ?? path.resolve(process.cwd(), '.data', 'unusual-whales.sqlite');
  const worker = new Worker(workerUrl('backfill-worker'), { execArgv: process.execArgv, workerData: { databasePath, from, to, signalTypes, operationId } });
  activeBackfillWorker = worker;
  updateOperation(database, operationId, { worker: true, retryAttempt, maxRetries: MAX_BACKFILL_RETRIES, stage: 'starting_worker', updatedAt: new Date().toISOString(), from, to, signalTypes });
  const retry = (reason: string) => {
    if (activeBackfillWorker !== worker) return;
    if (retryAttempt >= MAX_BACKFILL_RETRIES) {
      finishOperation(database, operationId, 'failed', { worker: true, retryAttempt, maxRetries: MAX_BACKFILL_RETRIES }, reason);
      activeBackfillWorker = null; activeBackfillController = null; activeBackfillOperationId = null;
      return;
    }
    const nextAttempt = retryAttempt + 1;
    const delayMs = Math.min(60_000, 5_000 * 2 ** retryAttempt);
    updateOperation(database, operationId, { worker: true, retryAttempt, maxRetries: MAX_BACKFILL_RETRIES, retryScheduled: true, retryInMs: delayMs, retryReason: reason, updatedAt: new Date().toISOString(), from, to, signalTypes });
    finishOperation(database, operationId, 'failed', { worker: true, retryAttempt, maxRetries: MAX_BACKFILL_RETRIES, retryScheduled: true, retryInMs: delayMs }, reason);
    activeBackfillWorker = null; activeBackfillController = null; activeBackfillOperationId = null;
    const timer = setTimeout(() => {
      backfillRetryTimers.delete(timer);
      if (activeBackfillWorker) return;
      const nextOperationId = startOperation(database, 'signals.historical_backfill');
      launchHistoricalBackfillWorker(from, to, signalTypes, nextOperationId, nextAttempt);
    }, delayMs);
    backfillRetryTimers.add(timer);
  };
  worker.on('message', (message: { status?: string; responseBody?: { status?: string; errors?: string[] }; error?: string }) => {
    if (message.status === 'failed') retry(message.error ?? 'Historical backfill worker failed');
    else if (message.responseBody?.status === 'failed') retry(message.responseBody.errors?.join('; ') || 'Historical backfill failed');
    if (activeBackfillWorker === worker) { activeBackfillWorker = null; activeBackfillController = null; activeBackfillOperationId = null; }
  });
  worker.on('error', (error) => {
    retry(error.message);
  });
  worker.on('exit', (code) => {
    if (code !== 0 && activeBackfillWorker === worker) {
      retry(`Backfill worker exited with code ${code}`);
    }
  });
};

const hasActivePostgresHistoricalJob = async () => {
  const result = await postgresResearchPool().query(`SELECT id FROM uw_job_runs WHERE kind='signals.historical_backfill' AND status IN ('queued','running','retrying') ORDER BY id DESC LIMIT 1`);
  return result.rows[0] ?? null;
};

let comparisonWarmupInFlight = false;
/** Fire-and-forget: recomputes the comparison cache off the main thread. Safe to call whenever
 *  the cache might be stale or missing -- concurrent callers just see the in-flight guard and
 *  skip, since the eventual single write covers all of them. */
const warmComparisonCache = () => {
  if (comparisonWarmupInFlight) return;
  comparisonWarmupInFlight = true;
  const databasePath = process.env.UNUSUAL_WHALES_DB_PATH ?? path.resolve(process.cwd(), '.data', 'unusual-whales.sqlite');
  const worker = new Worker(workerUrl('comparison-cache-worker'), { execArgv: process.execArgv, workerData: { databasePath } });
  const done = () => { comparisonWarmupInFlight = false; };
  worker.on('message', done);
  worker.on('error', done);
  worker.on('exit', done);
};

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? '/', 'http://localhost');

  if (requestUrl.pathname === '/api/health') {
    database.prepare('SELECT value FROM app_metadata WHERE key = ?').get('schema_version');
    const health: HealthStatus = {
      project: 'unusual-whales-research',
      status: 'ready',
      database: 'connected',
      timestamp: new Date().toISOString(),
    };
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ...health, databaseBackend: { ...databaseBackendStatus(), postgres: await checkPostgresReadiness() } }));
    return;
  }

  if (requestUrl.pathname === '/api/diagnostics' && request.method === 'GET') {
    if (configuredDatabaseBackend() === 'postgres') {
      try {
        const pool = postgresResearchPool();
        const [imports, trades, outcomes, bars, coverage, operations] = await Promise.all([
          pool.query(`SELECT id, endpoint, requested_at AS "requestedAt", completed_at AS "completedAt", status, http_status AS "httpStatus", received_count AS received, inserted_count AS inserted, duplicate_count AS duplicates, error FROM uw_import_batches ORDER BY id DESC LIMIT 1`),
          pool.query(`SELECT COUNT(*)::bigint AS count FROM uw_option_trades`), pool.query(`SELECT COUNT(*)::bigint AS count FROM uw_signal_outcomes`),
          pool.query(`SELECT COUNT(*)::bigint AS count FROM uw_market_bars`), pool.query(`SELECT signal_type AS "signalType", status, COUNT(*)::bigint AS days, SUM(received_count)::bigint AS received, SUM(inserted_count)::bigint AS inserted, MAX(error) AS error FROM uw_historical_coverage GROUP BY signal_type,status ORDER BY signal_type,status`),
          pool.query(`SELECT id, kind AS operation, status, payload, progress, error, attempt, created_at AS "createdAt", started_at AS "startedAt", completed_at AS "completedAt", updated_at AS "updatedAt" FROM uw_job_runs ORDER BY id DESC LIMIT 20`),
        ]);
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ generatedAt: new Date().toISOString(), database: { connected: true, backend: 'postgres', optionTrades: Number(trades.rows[0]?.count ?? 0), outcomeRows: Number(outcomes.rows[0]?.count ?? 0), marketBars: Number(bars.rows[0]?.count ?? 0) }, latestImport: imports.rows[0] ?? null, historicalCoverage: coverage.rows, recentOperations: operations.rows, note: 'PostgreSQL diagnostics are active.' }));
      } catch (error) { response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'PostgreSQL diagnostics failed' })); }
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(readDiagnostics(database)));
    return;
  }

  if (requestUrl.pathname === '/api/research/stream/status' && request.method === 'GET') {
    const summary = database.prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT topic) AS topics, MIN(captured_at) AS firstCapturedAt, MAX(captured_at) AS lastCapturedAt FROM uw_stream_events`).get() as { total: number; topics: number; firstCapturedAt: string | null; lastCapturedAt: string | null };
    const byTopic = database.prepare(`SELECT topic, COUNT(*) AS count, MAX(captured_at) AS lastCapturedAt FROM uw_stream_events GROUP BY topic ORDER BY topic`).all();
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ configured: Boolean(process.env.UNUSUAL_WHALES_STREAM_URL), ...summary, byTopic }));
    return;
  }

  if (requestUrl.pathname === '/api/research/option-features/refresh' && request.method === 'POST') {
    if (configuredDatabaseBackend() !== 'sqlite') {
      response.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'unavailable', error: 'Option feature refresh is currently implemented for SQLite only.' }));
      return;
    }
    if (activeOptionFeatureWorker) {
      response.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'rejected', error: 'An option feature refresh is already running.' }));
      return;
    }
    const operationId = startOperation(database, 'research.option_features');
    const databasePath = process.env.UNUSUAL_WHALES_DB_PATH ?? path.resolve(process.cwd(), '.data', 'unusual-whales.sqlite');
    const worker = new Worker(workerUrl('option-features-worker'), { execArgv: process.execArgv, workerData: { databasePath, operationId } });
    activeOptionFeatureWorker = worker;
    const clear = () => { if (activeOptionFeatureWorker === worker) activeOptionFeatureWorker = null; };
    worker.on('exit', clear);
    worker.on('error', clear);
    response.writeHead(202, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ status: 'processing', operationId, worker: true }));
    return;
  }

  if (requestUrl.pathname === '/api/provider/unusual-whales/probe' && request.method === 'GET') {
    const operationId = startOperation(database, 'provider.unusual-whales.probe');
    try {
      const result = await probeOptionTrades({ ticker: requestUrl.searchParams.get('ticker') ?? undefined });
      finishOperation(database, operationId, result.ok ? 'completed' : 'failed', {
        ticker: requestUrl.searchParams.get('ticker') ?? null,
        ok: result.ok,
        status: result.status,
        fields: result.fields ?? [],
      }, result.ok ? null : result.error ?? 'Provider probe failed');
      response.writeHead(result.ok ? 200 : 503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Provider probe failed';
      finishOperation(database, operationId, 'failed', {}, message);
      response.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ok: false, error: message }));
    }
    return;
  }

  if (requestUrl.pathname === '/api/signals/summary' && request.method === 'GET') {
    const signalSummary = readSignalDataSummary(database);
    const outcomes = readOutcomeSummary(database);
    const primaryOutcome = outcomes['+1d'] ?? outcomes['+5m'];
    const coverage = {
      rawEvents: signalSummary.callSweepEvents,
      independentEvents: primaryOutcome?.nIndependent ?? null,
      matureEvents: primaryOutcome?.nMature ?? null,
      tickers: signalSummary.distinctTickers,
      oldestEvent: signalSummary.earliestExecutedAt,
      newestEvent: signalSummary.latestExecutedAt,
      lastSync: signalSummary.latestImport?.completedAt ?? null,
    };
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({
      ...signalSummary,
      scope: {
        signal: 'Large call sweeps',
        provider: 'Unusual Whales',
        filters: { premium: 'all', dte: 'all', overlap: 'non-overlapping' },
      },
      coverage,
      outcomes,
    }));
    return;
  }

  if (requestUrl.pathname === '/api/signals/comparison' && request.method === 'GET') {
    if (configuredDatabaseBackend() === 'postgres') {
      try {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify(await readPostgresComparison(postgresResearchPool())));
      } catch (error) {
        response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'PostgreSQL comparison read failed' }));
      }
      return;
    }
    // Serves the cached snapshot (see refreshComparisonCache) rather than recomputing the
    // cross-signal aggregation live, so this request never has to wait behind a large
    // in-progress outcome recalculation. generatedAt in the payload tells the UI how old it is.
    const cached = peekCachedComparison(database);
    if (cached) {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(cached));
      return;
    }
    // No cache yet (fresh database, or the cache table was just added by a migration on an
    // existing large one). Computing it inline here measured 70+ seconds against the current
    // production data -- long enough to look identical to the original stuck-dashboard
    // symptom. Kick off the background warm-up worker and report the true state instead of
    // blocking this request on it.
    warmComparisonCache();
    const warming: CachedSignalComparison = {
      generatedAt: null,
      leader: { status: 'none', horizon: '+1d', signalId: null, label: null, afterCostsPct: null, message: 'Comparison summary is being computed for the first time since the last restart. This can take a while on a large database; retry shortly.' },
      signals: [],
    };
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(warming));
    return;
  }

  if (requestUrl.pathname === '/api/signals/sync' && request.method === 'POST') {
    if (configuredDatabaseBackend() === 'postgres') {
      const pool = postgresResearchPool();
      try {
        const jobId = await startPostgresOperation(pool, 'signals.sync', new Date().toISOString(), { source: 'recent_sync' });
        const callSweeps = await syncRecentSweepsToPostgres(pool, 'call');
        const putSweeps = await syncRecentSweepsToPostgres(pool, 'put');
        const marketRefresh = await refreshMarketPricesPostgres(pool);
        const outcomeRows = await refreshPostgresOutcomes(pool, { jobId });
        await finishPostgresOperation(pool, jobId, 'completed', { callSweeps, putSweeps, marketRefresh, outcomeRows });
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ callSweeps, putSweeps, marketRefresh, outcomeRows, backend: 'postgres' }));
      } catch (error) { response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'PostgreSQL signal sync failed', backend: 'postgres' })); }
      return;
    }
    const operationId = startOperation(database, 'signals.sync');
    try {
      const result = await syncRecentCallSweeps(database);
      const putSweeps = await syncRecentPutSweeps(database);
      let darkPool: { received: number; inserted: number; error?: string };
      try {
        const fetched = await fetchRecentDarkPool();
        const insert = database.prepare(`INSERT OR IGNORE INTO uw_dark_pool_trades
          (source_trade_id, executed_at, captured_at, ticker, price, size, premium, canceled, raw_payload, validation_errors)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        let inserted = 0;
        for (const record of fetched.records) {
          inserted += Number(insert.run(record.sourceId, record.executedAt, fetched.requestedAt, record.ticker, record.price,
            record.size, record.premium, record.canceled ? 1 : 0, record.rawPayload, JSON.stringify(record.validationErrors)).changes);
        }
        darkPool = { received: fetched.received, inserted };
      } catch (error) {
        darkPool = { received: 0, inserted: 0, error: error instanceof Error ? error.message : 'Dark Pool sync failed' };
      }
      const marketRefresh = await refreshMarketPrices(database);
      refreshOutcomes(database);
      warmComparisonCache();
      finishOperation(database, operationId, 'completed', { ...result, putSweeps, darkPool, marketRefresh });
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ...result, putSweeps, darkPool, marketRefresh }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Signal sync failed';
      finishOperation(database, operationId, 'failed', {}, message);
      response.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (requestUrl.pathname === '/api/signals/backfill' && request.method === 'POST') {
    if (configuredDatabaseBackend() === 'postgres') {
      if (activePostgresBackfillWorker) { response.writeHead(409, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ status: 'rejected', backend: 'postgres', error: 'A PostgreSQL historical backfill is already running.' })); return; }
      try {
        const existingJob = await hasActivePostgresHistoricalJob();
        if (existingJob) { response.writeHead(409, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ status: 'rejected', backend: 'postgres', operationId: Number(existingJob.id), error: 'A PostgreSQL historical backfill is already active.' })); return; }
        const body = await readJsonBody(request);
        const from = typeof body.from === 'string' ? body.from : '';
        const to = typeof body.to === 'string' ? body.to : '';
        const signalTypes = canonicalSignalTypes(Array.isArray(body.signalTypes) ? body.signalTypes : Array.isArray(body.signals) ? body.signals : ['call_sweep', 'put_sweep']);
        if (!from || !to || !signalTypes.length) throw new Error('from, to, and at least one supported signalType are required');
        const pool = postgresResearchPool();
        const jobId = await startPostgresOperation(pool, 'signals.historical_backfill', new Date().toISOString(), { from, to, signalTypes });
      const worker = new Worker(workerUrl('postgres-backfill-worker'), { execArgv: process.execArgv, workerData: { jobId } });
        activePostgresBackfillWorker = worker; activePostgresJobId = jobId;
        const clear = () => { if (activePostgresBackfillWorker === worker) { activePostgresBackfillWorker = null; activePostgresJobId = null; } };
        worker.on('error', async (error) => { await finishPostgresOperation(pool, jobId, 'failed', {}, error.message).catch(() => undefined); clear(); });
        worker.on('exit', (code) => { if (code !== 0) void finishPostgresOperation(pool, jobId, 'failed', {}, `PostgreSQL worker exited with code ${code}`); clear(); });
        response.writeHead(202, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ status: 'processing', backend: 'postgres', operationId: jobId, from, to, signalTypes, worker: true }));
      } catch (error) { response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ status: 'failed', backend: 'postgres', error: error instanceof Error ? error.message : 'PostgreSQL historical backfill failed' })); }
      return;
    }
    if (activeBackfillController || activeBackfillWorker) {
      response.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'rejected', error: 'A historical backfill is already running.' }));
      return;
    }
    try {
      const body = await readJsonBody(request);
      const from = typeof body.from === 'string' ? body.from : '';
      const to = typeof body.to === 'string' ? body.to : '';
      const requestedTypes = Array.isArray(body.signalTypes) ? body.signalTypes : Array.isArray(body.signals) ? body.signals : ['call_sweep', 'put_sweep'];
      const signalTypes = canonicalSignalTypes(requestedTypes);
      if (!signalTypes.length) throw new Error('signalTypes must include at least one known signal catalog id');
      const operationId = startOperation(database, 'signals.historical_backfill');
      activeBackfillOperationId = operationId;
      launchHistoricalBackfillWorker(from, to, signalTypes, operationId);
      response.writeHead(202, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ status: 'processing', operationId, from, to, signalTypes, worker: true }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Historical backfill failed';
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ status: 'failed', error: message }));
    }
    return;
  }

  if (requestUrl.pathname === '/api/signals/backfill/resume' && request.method === 'POST') {
    if (configuredDatabaseBackend() === 'postgres') {
      if (activePostgresBackfillWorker) { response.writeHead(409, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ status: 'rejected', backend: 'postgres', error: 'A PostgreSQL historical backfill is already running.' })); return; }
      try {
        const existingJob = await hasActivePostgresHistoricalJob();
        if (existingJob) { response.writeHead(409, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ status: 'rejected', backend: 'postgres', operationId: Number(existingJob.id), error: 'A PostgreSQL historical backfill is already active.' })); return; }
        const pool = postgresResearchPool();
        const prior = await pool.query(`SELECT payload FROM uw_job_runs WHERE kind='signals.historical_backfill' AND status IN ('failed','retrying','cancelled') ORDER BY id DESC LIMIT 1`);
        const payload = prior.rows[0]?.payload && typeof prior.rows[0].payload === 'object' ? prior.rows[0].payload as Record<string, unknown> : null;
        if (!payload?.from || !payload?.to) throw new Error('No saved PostgreSQL historical request range is available to resume.');
        const jobId = await startPostgresOperation(pool, 'signals.historical_backfill', new Date().toISOString(), payload);
        const worker = new Worker(workerUrl('postgres-backfill-worker'), { execArgv: process.execArgv, workerData: { jobId } });
        activePostgresBackfillWorker = worker; activePostgresJobId = jobId;
        const clear = () => { if (activePostgresBackfillWorker === worker) { activePostgresBackfillWorker = null; activePostgresJobId = null; } };
        worker.on('error', async (error) => { await finishPostgresOperation(pool, jobId, 'failed', {}, error.message).catch(() => undefined); clear(); });
        worker.on('exit', (code) => { if (code !== 0) void finishPostgresOperation(pool, jobId, 'failed', {}, `PostgreSQL worker exited with code ${code}`); clear(); });
        response.writeHead(202, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ status: 'processing', backend: 'postgres', operationId: jobId, resumed: true, worker: true, ...payload }));
      } catch (error) { response.writeHead(409, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ status: 'unavailable', backend: 'postgres', error: error instanceof Error ? error.message : 'PostgreSQL historical resume failed' })); }
      return;
    }
    if (activeBackfillController || activeBackfillWorker) {
      response.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'rejected', error: 'A historical backfill is already running.' }));
      return;
    }
    const range = latestResumableRange();
    if (!range) {
      response.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'unavailable', error: 'No saved historical request range is available to resume.' }));
      return;
    }
    try {
      const operationId = startOperation(database, 'signals.historical_backfill');
      activeBackfillOperationId = operationId;
      launchHistoricalBackfillWorker(range.from, range.to, ['call_sweep', 'put_sweep'], operationId);
      response.writeHead(202, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ status: 'processing', operationId, from: range.from, to: range.to, signalTypes: ['call_sweep', 'put_sweep'], resumed: true, worker: true }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Historical backfill resume failed';
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ status: 'failed', resumed: true, error: message }));
    }
    return;
  }

  if (requestUrl.pathname === '/api/signals/backfill/cancel' && request.method === 'POST') {
    if (configuredDatabaseBackend() === 'postgres') {
      if (activePostgresJobId === null) { response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ status: 'idle', backend: 'postgres', cancelled: false })); return; }
      const pool = postgresResearchPool();
      const cancelled = await cancelPostgresOperation(pool, activePostgresJobId);
      await activePostgresBackfillWorker?.terminate();
      const operationId = activePostgresJobId; activePostgresBackfillWorker = null; activePostgresJobId = null;
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ status: cancelled ? 'cancelled' : 'idle', backend: 'postgres', cancelled, operationId }));
      return;
    }
    if (activeBackfillWorker || activeBackfillController) {
      activeBackfillController?.abort();
      void activeBackfillWorker?.terminate();
      if (activeBackfillOperationId !== null) finishOperation(database, activeBackfillOperationId, 'failed', { cancelled: true, worker: true }, 'Historical backfill cancelled');
      database.prepare(`UPDATE uw_import_batches SET completed_at=?, status='failed', error=COALESCE(error, 'Historical backfill cancelled') WHERE status='processing'`).run(new Date().toISOString());
      database.prepare(`UPDATE uw_historical_coverage SET completed_at=?, status='failed', error=COALESCE(error, 'Historical backfill cancelled') WHERE status='processing'`).run(new Date().toISOString());
      const cancelledOperationId = activeBackfillOperationId;
      activeBackfillWorker = null; activeBackfillController = null; activeBackfillOperationId = null;
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'cancelled', cancelled: true, operationId: cancelledOperationId }));
    } else {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'idle', cancelled: false }));
    }
    return;
  }

  const relativePath = requestUrl.pathname === '/' ? 'index.html' : requestUrl.pathname.slice(1);
  let filePath = path.resolve(staticRoot, relativePath);
  if (!filePath.startsWith(`${staticRoot}${path.sep}`) || !existsSync(filePath)) {
    filePath = path.join(staticRoot, 'index.html');
  }

  if (!existsSync(filePath)) {
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'UI build not found. Run npm run build:ui.' }));
    return;
  }

  response.writeHead(200, { 'content-type': contentTypes[path.extname(filePath)] ?? 'application/octet-stream' });
  createReadStream(filePath).pipe(response);
});

server.listen(port, () => {
  console.log(`Unusual Whales research app listening on http://localhost:${port}`);
  if (configuredDatabaseBackend() === 'postgres') {
    void markPostgresProcessingOperationsFailed(postgresResearchPool(), 'Interrupted by server restart').catch((error) => {
      console.error(`PostgreSQL restart recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  // Refresh the comparison cache once per boot, off the main thread. The persisted row from
  // before this restart is still valid and still served for any request that lands before
  // this finishes (or immediately if the cache was already empty) -- this just makes sure a
  // fresh snapshot lands soon after startup rather than waiting for the next write to trigger
  // one, or for a request to hit an empty cache cold.
  warmComparisonCache();
  if (interruptedBackfill?.detailsJson) {
    try {
      const details = JSON.parse(interruptedBackfill.detailsJson) as Record<string, unknown>;
      const from = typeof details.from === 'string' ? details.from : null;
      const to = typeof details.to === 'string' ? details.to : null;
      const signalTypes = canonicalSignalTypes(details.signalTypes);
      const retryAttempt = typeof details.retryAttempt === 'number' ? details.retryAttempt : 0;
      if (from && to && signalTypes.length && retryAttempt < MAX_BACKFILL_RETRIES) {
        setTimeout(() => {
          if (activeBackfillWorker) return;
          const operationId = startOperation(database, 'signals.historical_backfill');
          launchHistoricalBackfillWorker(from, to, signalTypes, operationId, retryAttempt + 1);
        }, 1_000);
      }
    } catch { /* malformed prior details are left for manual resume */ }
  }
});

const shutDown = () => {
  server.close(() => {
    database.close();
    process.exit(0);
  });
};

process.on('SIGINT', shutDown);
process.on('SIGTERM', shutDown);
