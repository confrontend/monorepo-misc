import { Pool } from 'pg';
import { runPostgresHistoricalWorker } from '../providers/postgres-historical-backfill.js';
import { refreshMarketPricesPostgres } from '../providers/market-data.js';
import { refreshPostgresOutcomes } from '../research/postgres-outcomes.js';
import { finishPostgresOperation, updatePostgresOperation } from '../diagnostics.js';

const workerData = (await import('node:worker_threads')).workerData as { jobId?: number };
const jobId = Number(workerData?.jobId ?? process.env.UW_HISTORICAL_JOB_ID);
if (!Number.isInteger(jobId) || jobId <= 0) throw new Error('UW_HISTORICAL_JOB_ID must be a positive integer');

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL ?? 'postgres://unusualwhales:unusualwhales-local-only@127.0.0.1:54329/unusualwhales',
  max: Number(process.env.POSTGRES_POOL_SIZE ?? 8),
  idleTimeoutMillis: 30_000,
});

try {
  const result = await runPostgresHistoricalWorker(pool, jobId);
  if (result.status === 'completed' || result.status === 'partial') {
    await updatePostgresOperation(pool, jobId, { stage: 'refreshing_market_prices', updatedAt: new Date().toISOString() });
    const marketRefresh = await refreshMarketPricesPostgres(pool);
    await updatePostgresOperation(pool, jobId, { stage: 'refreshing_outcomes', marketRefresh, updatedAt: new Date().toISOString() });
    const outcomeRows = await refreshPostgresOutcomes(pool, { jobId, onProgress: (progress) => { void updatePostgresOperation(pool, jobId, { stage: 'refreshing_outcomes', progress, updatedAt: new Date().toISOString() }); } });
    await finishPostgresOperation(pool, jobId, result.status === 'partial' ? 'completed' : 'completed', { ...result, marketRefresh, outcomeRows });
    process.stdout.write(`${JSON.stringify({ ...result, marketRefresh, outcomeRows })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
  if (result.status === 'failed') process.exitCode = 1;
} finally {
  await pool.end();
}
