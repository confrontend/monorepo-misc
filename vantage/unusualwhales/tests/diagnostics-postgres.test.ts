import assert from 'node:assert/strict';
import test from 'node:test';
import {
  finishPostgresHistoricalCoverage,
  finishPostgresOperation,
  readPostgresOutcomeCheckpoint,
  startPostgresOperation,
  updatePostgresHistoricalProgress,
  updatePostgresOperation,
  updatePostgresOutcomeCheckpoint,
  upsertPostgresHistoricalCoverage,
} from '../src/diagnostics.js';
import type { PostgresQueryRunner } from '../src/diagnostics.js';

test('PostgreSQL operation helpers persist durable job status and merged progress', async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const pool = { query: async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    if (text.includes('RETURNING id')) return { rows: [{ id: 42 }], rowCount: 1 };
    if (text.includes('SELECT progress')) return { rows: [{ progress: { stage: 'download' } }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } };
  const runner = pool as unknown as PostgresQueryRunner;
  assert.equal(await startPostgresOperation(runner, 'signals.historical_backfill', '2026-01-01T00:00:00.000Z'), 42);
  await updatePostgresOperation(runner, 42, { completed: 5, total: 10 });
  await finishPostgresOperation(runner, 42, 'completed', { completed: 10, total: 10 });
  assert.match(calls[0].text, /uw_job_runs/);
  assert.match(calls[1].text, /progress/);
  assert.deepEqual(calls[2].values?.[0], JSON.stringify({ stage: 'download', completed: 5, total: 10 }));
  assert.match(calls[3].text, /status=\$2/);
});

test('PostgreSQL historical progress and outcome checkpoint helpers preserve resumable state', async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const pool = { query: async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    return { rows: text.includes('SELECT job_id') ? [{ jobId: 7, completed: 3, total: 9 }] : [], rowCount: 1 };
  } };
  const runner = pool as unknown as PostgresQueryRunner;
  await upsertPostgresHistoricalCoverage(runner, { signalType: 'call_sweep', tradingDate: '2026-01-02', endpoint: '/full-tape' });
  await updatePostgresHistoricalProgress(runner, { signalType: 'call_sweep', tradingDate: '2026-01-02', bytesReceived: 100, bytesExpected: 200, receivedCount: 4 });
  await finishPostgresHistoricalCoverage(runner, { signalType: 'call_sweep', tradingDate: '2026-01-02', status: 'completed', insertedCount: 3 });
  await updatePostgresOutcomeCheckpoint(runner, { jobId: 7, completed: 3, total: 9, lastTradeId: 123 });
  const checkpoint = await readPostgresOutcomeCheckpoint(runner, 7);
  assert.equal(checkpoint.completed, 3);
  assert.ok(calls.some((call) => call.text.includes('uw_historical_coverage')));
  assert.ok(calls.some((call) => call.text.includes('uw_outcome_checkpoints')));
});
