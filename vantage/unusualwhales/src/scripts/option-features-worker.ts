import { parentPort, workerData } from 'node:worker_threads';
import { createDatabase } from '../db/client.js';
import { finishOperation, updateOperation } from '../diagnostics.js';
import { refreshOptionFeatures } from '../research/option-features.js';

const input = workerData as { databasePath: string; operationId: number };
const database = createDatabase(input.databasePath);
try {
  updateOperation(database, input.operationId, { worker: true, stage: 'refreshing_option_features', updatedAt: new Date().toISOString() });
  const written = refreshOptionFeatures(database);
  finishOperation(database, input.operationId, 'completed', { worker: true, written });
  parentPort?.postMessage({ status: 'completed', written });
} catch (error) {
  const message = error instanceof Error ? error.message : 'Option feature refresh failed';
  finishOperation(database, input.operationId, 'failed', { worker: true }, message);
  parentPort?.postMessage({ status: 'failed', error: message });
  process.exitCode = 1;
} finally { database.close(); }
