import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/platform/db/client.js';
import { applyMigrations } from '../src/platform/db/schema.js';
import {
  createDataWorkflowRun,
  readDataWorkflowRun,
  readLatestDataWorkflowRun,
  updateDataWorkflowRunStatus,
  updateDataWorkflowStep,
  reconcileStaleDataWorkflowRuns,
  DATA_WORKFLOW_STEP_ORDER,
} from '../src/copytrade/data/dataWorkflowRunStore.js';

const setup = (): DatabaseSync => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  return database;
};

test('creating a run seeds all six steps as not_started, in order, with the roster frozen', () => {
  const database = setup();
  try {
    const runId = createDataWorkflowRun(database, {
      chain: 'sol',
      targetDays: 90,
      traderLimit: 100,
      rosterSnapshotId: null,
      rosterWallets: ['A', 'B', 'C'],
    });

    const run = readDataWorkflowRun(database, runId);
    assert.ok(run);
    assert.equal(run!.status, 'active');
    assert.equal(run!.targetDays, 90);
    assert.equal(run!.completenessThresholdPercent, 90);
    assert.deepEqual(run!.rosterWallets, ['A', 'B', 'C']);
    assert.equal(run!.steps.length, 6);
    assert.deepEqual(
      run!.steps.map((step) => step.stepKey),
      DATA_WORKFLOW_STEP_ORDER,
    );
    assert.ok(run!.steps.every((step) => step.status === 'not_started'));
  } finally {
    database.close();
  }
});

test('a custom completeness threshold is persisted, not silently defaulted', () => {
  const database = setup();
  try {
    const runId = createDataWorkflowRun(database, {
      chain: 'sol',
      targetDays: 30,
      traderLimit: 50,
      rosterSnapshotId: null,
      rosterWallets: [],
      completenessThresholdPercent: 75,
    });
    const run = readDataWorkflowRun(database, runId);
    assert.equal(run!.completenessThresholdPercent, 75);
  } finally {
    database.close();
  }
});

test('updateDataWorkflowStep only touches the named step and preserves fields not passed', () => {
  const database = setup();
  try {
    const runId = createDataWorkflowRun(database, {
      chain: 'sol',
      targetDays: 90,
      traderLimit: 10,
      rosterSnapshotId: null,
      rosterWallets: ['A'],
    });

    updateDataWorkflowStep(database, {
      runId,
      stepKey: 'activity_history',
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
      walletsTotal: 10,
      underlyingRunId: 42,
      underlyingRunKind: 'copytrade_fetch_runs',
    });
    let run = readDataWorkflowRun(database, runId)!;
    const activityStep1 = run.steps.find((step) => step.stepKey === 'activity_history')!;
    assert.equal(activityStep1.status, 'running');
    assert.equal(activityStep1.walletsTotal, 10);
    assert.equal(activityStep1.underlyingRunId, 42);
    assert.equal(run.steps.find((step) => step.stepKey === 'roster')!.status, 'not_started');

    // A second update that only touches walletsDone must not reset the fields set above.
    updateDataWorkflowStep(database, { runId, stepKey: 'activity_history', walletsDone: 4 });
    run = readDataWorkflowRun(database, runId)!;
    const activityStep2 = run.steps.find((step) => step.stepKey === 'activity_history')!;
    assert.equal(activityStep2.walletsDone, 4);
    assert.equal(activityStep2.walletsTotal, 10, 'earlier field was preserved, not reset to 0');
    assert.equal(activityStep2.status, 'running', 'status was preserved since this update omitted it');
  } finally {
    database.close();
  }
});

test('markSuccess stamps last_success_at only when explicitly requested', () => {
  const database = setup();
  try {
    const runId = createDataWorkflowRun(database, {
      chain: 'sol',
      targetDays: 30,
      traderLimit: 10,
      rosterSnapshotId: null,
      rosterWallets: [],
    });
    updateDataWorkflowStep(database, { runId, stepKey: 'roster', status: 'running' });
    let step = readDataWorkflowRun(database, runId)!.steps.find((s) => s.stepKey === 'roster')!;
    assert.equal(step.lastSuccessAt, null);

    updateDataWorkflowStep(database, { runId, stepKey: 'roster', status: 'completed', markSuccess: true, markCompletedAt: true });
    step = readDataWorkflowRun(database, runId)!.steps.find((s) => s.stepKey === 'roster')!;
    assert.ok(step.lastSuccessAt !== null);
    assert.ok(step.completedAt !== null);
  } finally {
    database.close();
  }
});

test('warnings round-trip as a real array, never silently dropped', () => {
  const database = setup();
  try {
    const runId = createDataWorkflowRun(database, {
      chain: 'sol',
      targetDays: 30,
      traderLimit: 10,
      rosterSnapshotId: null,
      rosterWallets: [],
    });
    updateDataWorkflowStep(database, {
      runId,
      stepKey: 'activity_history',
      warnings: ['3 wallets truncated by the page budget', '1 wallet failed'],
    });
    const step = readDataWorkflowRun(database, runId)!.steps.find((s) => s.stepKey === 'activity_history')!;
    assert.deepEqual(step.warnings, ['3 wallets truncated by the page budget', '1 wallet failed']);
  } finally {
    database.close();
  }
});

test('readLatestDataWorkflowRun returns the most recent run for a chain, scoped by chain', () => {
  const database = setup();
  try {
    createDataWorkflowRun(database, { chain: 'sol', targetDays: 30, traderLimit: 10, rosterSnapshotId: null, rosterWallets: [] });
    const secondRunId = createDataWorkflowRun(database, { chain: 'sol', targetDays: 90, traderLimit: 20, rosterSnapshotId: null, rosterWallets: [] });
    createDataWorkflowRun(database, { chain: 'eth', targetDays: 60, traderLimit: 5, rosterSnapshotId: null, rosterWallets: [] });

    const latestSol = readLatestDataWorkflowRun(database, 'sol');
    assert.equal(latestSol!.id, secondRunId);
    assert.equal(latestSol!.targetDays, 90);
  } finally {
    database.close();
  }
});

test('reconcileStaleDataWorkflowRuns pauses every active run and its running step, before fetch.ts would otherwise fail it', () => {
  const database = setup();
  try {
    const runId = createDataWorkflowRun(database, {
      chain: 'sol',
      targetDays: 90,
      traderLimit: 10,
      rosterSnapshotId: null,
      rosterWallets: ['A'],
    });
    updateDataWorkflowStep(database, {
      runId,
      stepKey: 'activity_history',
      status: 'running',
      underlyingRunId: 99,
      underlyingRunKind: 'copytrade_fetch_runs',
    });

    const reconciled = reconcileStaleDataWorkflowRuns(database);
    assert.equal(reconciled, 1);

    const run = readDataWorkflowRun(database, runId)!;
    assert.equal(run.status, 'paused');
    assert.match(run.error ?? '', /server restart/i);
    const step = run.steps.find((s) => s.stepKey === 'activity_history')!;
    assert.equal(step.status, 'paused');
  } finally {
    database.close();
  }
});

test('reconcileStaleDataWorkflowRuns is a no-op when nothing is active', () => {
  const database = setup();
  try {
    const runId = createDataWorkflowRun(database, {
      chain: 'sol',
      targetDays: 30,
      traderLimit: 10,
      rosterSnapshotId: null,
      rosterWallets: [],
    });
    updateDataWorkflowRunStatus(database, { runId, status: 'completed', completed: true });

    const reconciled = reconcileStaleDataWorkflowRuns(database);
    assert.equal(reconciled, 0);
    assert.equal(readDataWorkflowRun(database, runId)!.status, 'completed');
  } finally {
    database.close();
  }
});
