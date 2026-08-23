import { parentPort, workerData } from 'node:worker_threads';
import { createDatabase } from '../db/client.js';
import { refreshComparisonCache } from '../research/comparison.js';

// Computing the comparison payload against a large uw_signal_outcomes table is a genuinely
// expensive synchronous SQLite scan (verified: 70+ seconds against ~17.5M outcome rows). Doing
// that on the main HTTP thread -- even just once, to warm an empty cache after a restart --
// would block every other request for its whole duration, including /api/health. This worker
// exists solely to run that one computation off the main thread, the same way
// backfill-worker.ts already isolates the much longer-running outcome recalculation.
type WorkerInput = { databasePath: string };
const input = workerData as WorkerInput;
const database = createDatabase(input.databasePath);

try {
  refreshComparisonCache(database);
  parentPort?.postMessage({ status: 'completed' });
} catch (error) {
  parentPort?.postMessage({ status: 'failed', error: error instanceof Error ? error.message : 'Comparison cache warm-up failed' });
} finally {
  database.close();
}
