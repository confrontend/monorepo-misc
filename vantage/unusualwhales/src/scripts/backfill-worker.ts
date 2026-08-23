import { parentPort, workerData } from 'node:worker_threads';
import { createDatabase } from '../db/client.js';
import { finishOperation, updateOperation } from '../diagnostics.js';
import { backfillHistoricalSignals, type HistoricalSignalType } from '../providers/historical-backfill.js';
import { refreshMarketPrices } from '../providers/market-data.js';
import { refreshOutcomes } from '../research/outcomes.js';
import { refreshComparisonCache } from '../research/comparison.js';

type WorkerInput = { databasePath: string; from: string; to: string; signalTypes: HistoricalSignalType[]; operationId: number };
const input = workerData as WorkerInput;
const database = createDatabase(input.databasePath);

// A single refreshOutcomes() pass over millions of trades can run far longer than any one
// dashboard session. Without this, the comparison cache would only update once the *entire*
// pass finishes (or not at all, if the process gets interrupted and resumed first) -- so the
// dashboard could sit on a snapshot that's arbitrarily many hours stale. Recomputing here runs
// on this same worker connection, so it costs CPU time on the worker only; it never contends
// with the main thread's reader the way a live-computed HTTP response would.
const COMPARISON_CACHE_REFRESH_INTERVAL_MS = 3 * 60_000;
let lastComparisonCacheRefreshAt = 0;
const maybeRefreshComparisonCache = () => {
  const now = Date.now();
  if (now - lastComparisonCacheRefreshAt < COMPARISON_CACHE_REFRESH_INTERVAL_MS) return;
  lastComparisonCacheRefreshAt = now;
  refreshComparisonCache(database);
};

try {
  updateOperation(database, input.operationId, { worker: true, stage: 'historical_fetch', updatedAt: new Date().toISOString(), from: input.from, to: input.to, signalTypes: input.signalTypes });
  const result = await backfillHistoricalSignals(database, { from: input.from, to: input.to, signalTypes: input.signalTypes });
  const marketStageStartedAt = new Date().toISOString();
  updateOperation(database, input.operationId, { worker: true, stage: 'refreshing_market_prices', stageStartedAt: marketStageStartedAt, updatedAt: marketStageStartedAt, historical: result });
  const marketRefresh = await refreshMarketPrices(database, { onProgress: (progress) => updateOperation(database, input.operationId, { worker: true, stage: 'refreshing_market_prices', stageStartedAt: marketStageStartedAt, updatedAt: new Date().toISOString(), progress, historical: result }) });
  const outcomeStageStartedAt = new Date().toISOString();
  updateOperation(database, input.operationId, { worker: true, stage: 'refreshing_outcomes', stageStartedAt: outcomeStageStartedAt, updatedAt: outcomeStageStartedAt, progress: { completed: 0, total: 0 }, historical: result, marketRefresh });
  const outcomeRows = refreshOutcomes(database, new Date(), (progress) => {
    if (progress.completed === progress.total || progress.completed % 500 === 0) updateOperation(database, input.operationId, { worker: true, stage: 'refreshing_outcomes', stageStartedAt: outcomeStageStartedAt, updatedAt: new Date().toISOString(), progress, historical: result, marketRefresh });
    maybeRefreshComparisonCache();
  });
  refreshComparisonCache(database);
  const responseBody = { ...result, skipped: result.skippedDays + result.excludedOutsideRange, marketRefresh, outcomeRows };
  finishOperation(database, input.operationId, result.status === 'failed' ? 'failed' : 'completed', responseBody, result.errors.length ? result.errors.join('; ') : null);
  parentPort?.postMessage({ status: 'completed', responseBody });
} catch (error) {
  const message = error instanceof Error ? error.message : 'Historical backfill worker failed';
  finishOperation(database, input.operationId, 'failed', { worker: true }, message);
  parentPort?.postMessage({ status: 'failed', error: message });
  process.exitCode = 1;
} finally {
  database.close();
}
