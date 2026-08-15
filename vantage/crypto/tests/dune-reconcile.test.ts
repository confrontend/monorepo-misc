import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/db/client.js';
import { reconcileDuneRun, reconcileStuckDuneRuns, readAllDuneOutcomes } from '../src/dune/outcomes.js';
import { storeGmgnSignal } from '../src/gmgn/ingest.js';

const seedSignal = (database: ReturnType<typeof openDatabase>, id: string, signalType: number, token: string): number =>
  storeGmgnSignal(database, { id, token_address: token, signal_type: signalType, observed_at: '2026-03-01T00:00:00Z', market_cap: 1000 }, { source: 'gmgn-cli', chain: 'sol', capturedAt: new Date('2026-03-01T00:00:01Z') }).id;

const insertStuckRun = (
  database: ReturnType<typeof openDatabase>,
  options: { signalIds: number[]; status: 'submitted' | 'running' | 'timed_out'; executionId?: string | null; requestedAt?: string },
): number => Number(database.prepare(`
  INSERT INTO dune_outcome_runs (signal_ids, query_sql, execution_id, status, requested_at) VALUES (?, 'select 1', ?, ?, ?)
`).run(JSON.stringify(options.signalIds), options.executionId ?? null, options.status, options.requestedAt ?? new Date().toISOString()).lastInsertRowid);

// A minimal fetch stand-in: dispatches on whether the URL is a status or results poll, so a
// single mock can drive reconcileDuneRun's two-request sequence without hitting the real network.
const fetchMock = (state: string, rows: Array<Record<string, unknown>> = []) => async (url: string) => {
  if (url.includes('/status')) return { ok: true, json: async () => ({ state }) } as Response;
  if (url.includes('/results')) return { ok: true, text: async () => JSON.stringify({ result: { rows } }) } as Response;
  throw new Error(`unexpected fetch url in test: ${url}`);
};

test('reconcileDuneRun returns not_found for an unknown run id', async () => {
  const database = openDatabase(':memory:');
  try {
    assert.equal(await reconcileDuneRun(database, 9999), 'not_found');
  } finally { database.close(); }
});

test('reconcileDuneRun reports completed without any network call for an already-completed run', async (t) => {
  const database = openDatabase(':memory:');
  try {
    const signalId = seedSignal(database, 'done', 7, 'TokenDone');
    const runId = Number(database.prepare(`INSERT INTO dune_outcome_runs (signal_ids, query_sql, status, requested_at, completed_at) VALUES (?, 'select 1', 'completed', ?, ?)`)
      .run(JSON.stringify([signalId]), new Date().toISOString(), new Date().toISOString()).lastInsertRowid);
    let fetchCalled = false;
    t.mock.method(globalThis, 'fetch', async () => { fetchCalled = true; throw new Error('should not be called'); });
    assert.equal(await reconcileDuneRun(database, runId), 'completed');
    assert.equal(fetchCalled, false);
  } finally { database.close(); }
});

test('reconcileDuneRun gives a run with no execution id a grace period before writing it off', async () => {
  const database = openDatabase(':memory:');
  try {
    const signalId = seedSignal(database, 'fresh-no-exec', 7, 'TokenFreshNoExec');
    const runId = insertStuckRun(database, { signalIds: [signalId], status: 'submitted', executionId: null, requestedAt: new Date().toISOString() });
    assert.equal(await reconcileDuneRun(database, runId), 'still_running', 'a run submitted moments ago may still be genuinely in flight over the network');
    const row = database.prepare('SELECT status FROM dune_outcome_runs WHERE id = ?').get(runId) as { status: string };
    assert.equal(row.status, 'submitted', 'must not be touched during the grace period');
  } finally { database.close(); }
});

test('reconcileDuneRun writes off a stale run that never received an execution id', async () => {
  const database = openDatabase(':memory:');
  try {
    const signalId = seedSignal(database, 'stale-no-exec', 7, 'TokenStaleNoExec');
    const runId = insertStuckRun(database, { signalIds: [signalId], status: 'submitted', executionId: null, requestedAt: '2020-01-01T00:00:00.000Z' });
    assert.equal(await reconcileDuneRun(database, runId), 'failed');
    const row = database.prepare('SELECT status, completed_at AS completedAt FROM dune_outcome_runs WHERE id = ?').get(runId) as { status: string; completedAt: string | null };
    assert.equal(row.status, 'failed');
    assert.ok(row.completedAt, 'completed_at must be recorded so this run stops being treated as stuck');
  } finally { database.close(); }
});

test('reconcileDuneRun leaves a genuinely still-executing run untouched', async (t) => {
  const database = openDatabase(':memory:');
  try {
    const signalId = seedSignal(database, 'executing', 7, 'TokenExecuting');
    const runId = insertStuckRun(database, { signalIds: [signalId], status: 'running', executionId: 'exec-executing' });
    t.mock.method(globalThis, 'fetch', fetchMock('QUERY_STATE_EXECUTING'));
    assert.equal(await reconcileDuneRun(database, runId), 'still_running');
    const row = database.prepare('SELECT status FROM dune_outcome_runs WHERE id = ?').get(runId) as { status: string };
    assert.equal(row.status, 'running', 'status must be unchanged while genuinely still executing');
  } finally { database.close(); }
});

test('reconcileDuneRun marks a Dune-side failure as failed, freeing the signal', async (t) => {
  const database = openDatabase(':memory:');
  try {
    const signalId = seedSignal(database, 'dune-failed', 7, 'TokenDuneFailed');
    const runId = insertStuckRun(database, { signalIds: [signalId], status: 'running', executionId: 'exec-failed' });
    t.mock.method(globalThis, 'fetch', fetchMock('QUERY_STATE_FAILED'));
    assert.equal(await reconcileDuneRun(database, runId), 'failed');
    const row = database.prepare('SELECT status FROM dune_outcome_runs WHERE id = ?').get(runId) as { status: string };
    assert.equal(row.status, 'failed');
  } finally { database.close(); }
});

test('reconcileDuneRun finalizes a run that actually completed on Dune, and the result becomes visible through readAllDuneOutcomes', async (t) => {
  const database = openDatabase(':memory:');
  try {
    const signalId = seedSignal(database, 'finished', 7, 'TokenFinished');
    const runId = insertStuckRun(database, { signalIds: [signalId], status: 'timed_out', executionId: 'exec-finished' });
    t.mock.method(globalThis, 'fetch', fetchMock('QUERY_STATE_COMPLETED', [
      { signal_id: signalId, checkpoint: 'signal', target_at: '2026-03-01 00:00:00.000 UTC', price_usd: 1, matched_trade_at: '2026-03-01 00:00:00.000 UTC' },
    ]));
    assert.equal(await reconcileDuneRun(database, runId), 'completed');
    const row = database.prepare('SELECT status, raw_result AS rawResult, archive_path AS archivePath FROM dune_outcome_runs WHERE id = ?').get(runId) as { status: string; rawResult: string | null; archivePath: string | null };
    assert.equal(row.status, 'completed');
    assert.ok(row.rawResult);
    assert.ok(row.archivePath, 'a reconciled run must be archived exactly like a freshly measured one');
    const [outcome] = readAllDuneOutcomes(database);
    const checkpoint = outcome.checkpoints.find((c) => c.label === 'signal')!;
    assert.equal(checkpoint.result.priceUsd, 1, 'reconciled data must flow through the same read path as directly measured data');
  } finally { database.close(); }
});

test('reconcileStuckDuneRuns sweeps every stuck run and tallies outcomes independently per run', async (t) => {
  const database = openDatabase(':memory:');
  try {
    const completing = seedSignal(database, 'sweep-complete', 7, 'TokenSweepComplete');
    const failing = seedSignal(database, 'sweep-fail', 7, 'TokenSweepFail');
    const executing = seedSignal(database, 'sweep-executing', 7, 'TokenSweepExecuting');
    const completeRunId = insertStuckRun(database, { signalIds: [completing], status: 'running', executionId: 'exec-a' });
    const failRunId = insertStuckRun(database, { signalIds: [failing], status: 'running', executionId: 'exec-b' });
    const executingRunId = insertStuckRun(database, { signalIds: [executing], status: 'timed_out', executionId: 'exec-c' });
    t.mock.method(globalThis, 'fetch', async (url: string) => {
      if (url.includes('exec-a')) return fetchMock('QUERY_STATE_COMPLETED', [{ signal_id: completing, checkpoint: 'signal', target_at: '2026-03-01 00:00:00.000 UTC', price_usd: 1 }])(url);
      if (url.includes('exec-b')) return fetchMock('QUERY_STATE_FAILED')(url);
      if (url.includes('exec-c')) return fetchMock('QUERY_STATE_EXECUTING')(url);
      throw new Error(`unexpected execution id in url: ${url}`);
    });
    const summary = await reconcileStuckDuneRuns(database);
    assert.equal(summary.checked, 3);
    assert.equal(summary.completed, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.stillRunning, 1);
    assert.deepEqual(summary.runIds.completed, [completeRunId]);
    assert.deepEqual(summary.runIds.failed, [failRunId]);
    assert.deepEqual(summary.runIds.stillRunning, [executingRunId]);
  } finally { database.close(); }
});
