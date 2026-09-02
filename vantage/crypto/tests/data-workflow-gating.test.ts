import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/platform/db/client.js';
import { applyMigrations } from '../src/platform/db/schema.js';
import { createDataWorkflowRun } from '../src/copytrade/data/dataWorkflowRunStore.js';
import { readDataWorkflowStatus } from '../src/copytrade/data/dataWorkflowOrchestrator.js';
import { readDataWorkflowState } from '../src/copytrade/data/dataWorkflowState.js';

// Verifies the exact enabled/disabled wiring the Data tab UI depends on: each later step must be
// disabled with a specific, readable reason until its real prerequisite is satisfied -- never a
// bare disabled control, and never gated on a stale stored flag (that invariant is covered
// separately in data-workflow-state.test.ts).

const DAY = 86_400;
const NOW = new Date('2026-08-29T12:00:00.000Z');
const NOW_ISO = NOW.toISOString();

const setup = (): DatabaseSync => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  return database;
};

const addRoster = (database: DatabaseSync, wallets: string[]): number => {
  database
    .prepare(
      `INSERT INTO gmgn_wallet_rank_snapshots (captured_at, raw_payload, source_sha256)
       VALUES (?, ?, ?)`,
    )
    .run(
      NOW_ISO,
      JSON.stringify({ data: wallets.map((wallet, index) => ({ wallet_address: wallet, rank: index + 1 })) }),
      `snapshot-${wallets.join('-')}`,
    );
  const snapshotId = Number(
    (database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id,
  );
  const insertWallet = database.prepare(
    `INSERT INTO copytrade_wallets
     (wallet_address, chain, name, source_snapshot_id, rank_position, risk_flags, added_at)
     VALUES (?, 'sol', ?, ?, ?, '[]', ?)`,
  );
  wallets.forEach((wallet, index) => insertWallet.run(wallet, wallet, snapshotId, index + 1, NOW_ISO));
  return snapshotId;
};

const addWorkflow = (database: DatabaseSync, wallets: string[], targetDays = 90): number =>
  createDataWorkflowRun(database, {
    chain: 'sol',
    targetDays,
    traderLimit: wallets.length,
    rosterSnapshotId: wallets.length > 0 ? addRoster(database, wallets) : null,
    rosterWallets: wallets,
  });

const addFetchRun = (database: DatabaseSync): number => {
  database
    .prepare(`INSERT INTO copytrade_fetch_runs (started_at, status, requested_period_days) VALUES (?, 'completed', 90)`)
    .run(NOW_ISO);
  return Number((database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
};

const addGenuineCoverage = (database: DatabaseSync, wallet: string, oldestDaysAgo: number): void => {
  const fetchRunId = addFetchRun(database);
  database
    .prepare(
      `INSERT INTO copytrade_wallet_coverage_events
       (run_id, wallet_address, chain, requested_period_days, requests_used, truncated,
        stop_reason, oldest_held_ts, newest_held_ts, observed_at, error)
       VALUES (?, ?, 'sol', 90, 3, 0, 'window_covered', ?, ?, ?, NULL)`,
    )
    .run(
      fetchRunId,
      wallet,
      Math.floor(NOW.getTime() / 1000) - oldestDaysAgo * DAY,
      Math.floor(NOW.getTime() / 1000),
      NOW_ISO,
    );
  database
    .prepare(
      `INSERT INTO copytrade_wallet_coverage
       (wallet_address, chain, last_run_id, requests_used, truncated, coverage_complete,
        requested_period_days, stop_reason, updated_at, pages_fetched)
       VALUES (?, 'sol', ?, 3, 0, 1, 90, 'window_covered', ?, 2)
       ON CONFLICT(wallet_address, chain) DO UPDATE SET last_run_id = excluded.last_run_id,
         truncated = excluded.truncated, coverage_complete = excluded.coverage_complete,
         requested_period_days = excluded.requested_period_days, stop_reason = excluded.stop_reason,
         updated_at = excluded.updated_at`,
    )
    .run(wallet, fetchRunId, NOW_ISO);
};

test('an empty roster disables every downstream step with a roster-first reason', () => {
  const database = setup();
  try {
    const runId = addWorkflow(database, []);
    const state = readDataWorkflowState(database, { runId, now: NOW });
    const metadataStep = state.steps.find((step) => step.stepKey === 'wallet_metadata');
    const activityStep = state.steps.find((step) => step.stepKey === 'activity_history');
    assert.match(metadataStep?.disabledReason ?? '', /roster/i);
    assert.match(activityStep?.disabledReason ?? '', /roster/i);
  } finally {
    database.close();
  }
});

test('Dune outcomes stay disabled with a specific coverage-shortfall reason until the depth threshold is met', () => {
  const database = setup();
  try {
    const runId = addWorkflow(database, ['A', 'B'], 90);
    // Only one of two wallets reaches 90 days; the default 90% threshold needs both.
    addGenuineCoverage(database, 'A', 95);
    const state = readDataWorkflowState(database, { runId, now: NOW });
    const duneStep = state.steps.find((step) => step.stepKey === 'dune_outcomes');
    assert.ok(duneStep?.disabledReason, 'Dune must be disabled while coverage is short of the threshold');
    assert.match(duneStep!.disabledReason!, /Complete GMGN wallet-history fetch/);
    assert.match(duneStep!.disabledReason!, /1\/2/);
  } finally {
    database.close();
  }
});

test('Dune outcomes become enabled once every required wallet reaches the requested depth', () => {
  const database = setup();
  try {
    const runId = addWorkflow(database, ['A', 'B'], 90);
    addGenuineCoverage(database, 'A', 95);
    addGenuineCoverage(database, 'B', 91);
    const state = readDataWorkflowState(database, { runId, now: NOW }, );
    const duneStep = state.steps.find((step) => step.stepKey === 'dune_outcomes');
    assert.equal(duneStep?.disabledReason, null);
    assert.equal(state.counts.coverage.ready, true);
  } finally {
    database.close();
  }
});

test('a lower completeness threshold enables Dune sooner, without changing the underlying coverage data', () => {
  const database = setup();
  try {
    const runId = createDataWorkflowRun(database, {
      chain: 'sol',
      targetDays: 90,
      traderLimit: 2,
      rosterSnapshotId: addRoster(database, ['A', 'B']),
      rosterWallets: ['A', 'B'],
      completenessThresholdPercent: 50,
    });
    addGenuineCoverage(database, 'A', 95);
    const state = readDataWorkflowState(database, { runId, now: NOW });
    assert.equal(state.counts.coverage.requiredWallets, 1);
    assert.equal(state.counts.coverage.ready, true);
    const duneStep = state.steps.find((step) => step.stepKey === 'dune_outcomes');
    assert.equal(duneStep?.disabledReason, null);
  } finally {
    database.close();
  }
});

test('readDataWorkflowState works with no workflow run at all, keyed only by chain and targetDays', () => {
  const database = setup();
  try {
    addRoster(database, ['A', 'B']);
    addGenuineCoverage(database, 'A', 95);
    addGenuineCoverage(database, 'B', 95);
    const state = readDataWorkflowState(database, { chain: 'sol', targetDays: 90, now: NOW });
    assert.equal(state.run, null);
    assert.equal(state.rosterWallets.length, 2);
    assert.equal(state.counts.coverage.ready, true);
  } finally {
    database.close();
  }
});

test('status defaults to the current workflow run and its frozen wallet selection', () => {
  const database = setup();
  try {
    const runId = addWorkflow(database, ['A', 'B'], 90);
    const status = readDataWorkflowStatus(database, { chain: 'sol', targetDays: 30 });
    assert.equal(status.run?.id, runId);
    assert.equal(status.run?.targetDays, 90);
    assert.deepEqual(status.run?.rosterWallets, ['A', 'B']);
    assert.equal(status.phase, 'ready_for_step');
    assert.equal(status.actions.pause.allowed, false);
    assert.equal(
      status.jobs.some((job) => job.kind === 'gmgn_fetch'),
      false,
      'unrelated legacy fetch progress must not be shown',
    );
  } finally {
    database.close();
  }
});
