import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/platform/db/client.js';
import { applyMigrations } from '../src/platform/db/schema.js';
import { activeDuneExecutionCount, activeExecutionCount, allowedApplicationExecutions, canSubmitExecution, latestReportedLimit, waitForDuneCapacity, withDuneSubmissionLock } from '../src/copytrade/simulation/duneScheduler.js';
import { alreadyCoveredTradeIds } from '../src/copytrade/simulation/copySimulationDune.js';

const setup = (): DatabaseSync => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  return database;
};

test('reported account limit is reduced by the configurable safety margin', () => {
  assert.equal(allowedApplicationExecutions(3, 1), 2);
  assert.equal(allowedApplicationExecutions(3, 0), 3);
  assert.equal(allowedApplicationExecutions(null, 1), 2);
  assert.equal(canSubmitExecution(1, 3, 1), true);
  assert.equal(canSubmitExecution(2, 3, 1), false);
  assert.equal(activeExecutionCount(['running', 'submitted', 'completed', 'failed']), 2);
});

test('capacity wait drains queued work only after an active execution ends', async () => {
  const database = setup();
  database.prepare(`INSERT INTO copytrade_copy_simulation_runs (trade_refs, query_sql, status, requested_at, dune_max_inflight_interactive_executions)
    VALUES ('[1]', 'SELECT 1', 'running', 'now', 3), ('[2]', 'SELECT 2', 'running', 'now', 3)`).run();
  let reconciled = 0;
  const seen: number[] = [];
  const wait = waitForDuneCapacity(database, { pollMs: 1, onCapacity: ({ active }) => seen.push(active), reconcile: async () => {
    reconciled += 1;
    const active = database.prepare(`SELECT id FROM copytrade_copy_simulation_runs WHERE status = 'running' LIMIT 1`).get() as { id: number };
    database.prepare(`UPDATE copytrade_copy_simulation_runs SET status = 'completed' WHERE id = ?`).run(active.id);
  } });
  await wait;
  assert.ok(reconciled >= 1);
  assert.equal(activeDuneExecutionCount(database), 1);
  assert.ok(seen.includes(2));
});

test('restart recovery treats submitted/running executions as covered and never resubmits their trades', () => {
  const database = setup();
  database.prepare(`INSERT INTO copytrade_copy_simulation_runs (trade_refs, query_sql, status, requested_at, execution_id)
    VALUES ('[10,11]', 'SELECT 1', 'submitted', 'now', 'exec-1'), ('[12]', 'SELECT 2', 'running', 'now', 'exec-2')`).run();
  assert.deepEqual([...alreadyCoveredTradeIds(database)].sort((a, b) => a - b), [10, 11, 12]);
});

test('latest reported limit is persisted for restart-time scheduling', () => {
  const database = setup();
  database.prepare(`INSERT INTO copytrade_copy_simulation_runs (trade_refs, query_sql, status, requested_at, dune_max_inflight_interactive_executions)
    VALUES ('[]', 'SELECT 1', 'running', 'now', 5)`).run();
  assert.equal(latestReportedLimit(database), 5);
});

test('submission lock serializes concurrent capacity-check/submission critical sections', async () => {
  const order: string[] = [];
  const first = withDuneSubmissionLock(async () => {
    order.push('first-start');
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push('first-end');
  });
  const second = withDuneSubmissionLock(async () => { order.push('second'); });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
});
