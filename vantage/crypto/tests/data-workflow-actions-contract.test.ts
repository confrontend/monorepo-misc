import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/platform/db/client.js';
import { applyMigrations } from '../src/platform/db/schema.js';
import {
  createDataWorkflowRun,
  updateDataWorkflowRunStatus,
  updateDataWorkflowStep,
} from '../src/copytrade/data/dataWorkflowRunStore.js';
import {
  cancelDataWorkflow,
  finishDataWorkflow,
  readDataWorkflowStatus,
} from '../src/copytrade/data/dataWorkflowOrchestrator.js';
import { reconcileStaleCopySimulationRuns } from '../src/copytrade/simulation/copySimulationDune.js';

// Verifies the server-authored actions/jobs/shouldPoll contract that replaced the UI's own
// client-side invariant checker. The two bugs this fixes both trace to job ownership: a
// workflow's own in-flight GMGN fetch or Dune batch must never be reported as an *external*
// production-job lock, but an unrelated job must still block correctly. Every assertion here
// reads the typed contract directly -- never a parsed English string.

const NOW_ISO = new Date('2026-08-30T12:00:00.000Z').toISOString();

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
      JSON.stringify({
        data: wallets.map((wallet, index) => ({ wallet_address: wallet, rank: index + 1 })),
      }),
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
  wallets.forEach((wallet, index) =>
    insertWallet.run(wallet, wallet, snapshotId, index + 1, NOW_ISO),
  );
  return snapshotId;
};

const addWorkflow = (database: DatabaseSync, wallets: string[], targetDays = 90): number => {
  const runId = createDataWorkflowRun(database, {
    chain: 'sol',
    targetDays,
    traderLimit: wallets.length,
    rosterSnapshotId: wallets.length > 0 ? addRoster(database, wallets) : null,
    rosterWallets: wallets,
  });
  updateDataWorkflowStep(database, {
    runId,
    stepKey: 'roster',
    status: 'completed',
    markSuccess: true,
    markCompletedAt: true,
  });
  return runId;
};

const addRunningFetchRun = (database: DatabaseSync, workflowRunId: number | null): number => {
  database
    .prepare(
      `INSERT INTO copytrade_fetch_runs (started_at, status, requested_period_days, workflow_run_id)
       VALUES (?, 'running', 90, ?)`,
    )
    .run(NOW_ISO, workflowRunId);
  return Number((database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
};

const addDuneRun = (
  database: DatabaseSync,
  status: 'submitted' | 'running' | 'timed_out',
  workflowRunId: number | null,
): number => {
  database
    .prepare(
      `INSERT INTO copytrade_copy_simulation_runs (trade_refs, query_sql, status, requested_at, workflow_run_id)
       VALUES ('[]', 'SELECT 1', ?, ?, ?)`,
    )
    .run(status, NOW_ISO, workflowRunId);
  return Number((database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
};

const addRunningPatternDiscovery = (database: DatabaseSync): number => {
  database
    .prepare(
      `INSERT INTO copytrade_pattern_discovery_runs
       (period_days, minimum_n, status, progress_json, started_at, heartbeat_at)
       VALUES (30, 10, 'running', '{}', ?, ?)`,
    )
    .run(NOW_ISO, NOW_ISO);
  return Number((database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
};

test('no run, no jobs: start is allowed and nothing polls', () => {
  const database = setup();
  try {
    const status = readDataWorkflowStatus(database, { chain: 'sol', targetDays: 30 });
    assert.deepEqual(status.actions.start, { allowed: true, reasonCode: 'ok', message: null });
    assert.deepEqual(status.jobs, []);
    assert.equal(status.shouldPoll, false);
  } finally {
    database.close();
  }
});

test('manual workflow exposes only the next incomplete step as runnable', () => {
  const database = setup();
  try {
    const runId = addWorkflow(database, ['A', 'B']);
    let status = readDataWorkflowStatus(database, { runId });
    const initial = new Map(status.steps.map((step) => [step.stepKey, step]));
    assert.equal(initial.get('wallet_metadata')?.status, 'not_started');
    assert.equal(initial.get('activity_history')?.status, 'not_started');
    assert.equal(initial.get('wallet_metadata')?.action.allowed, true);
    assert.equal(initial.get('activity_history')?.action.allowed, false);
    assert.equal(initial.get('coverage_verification')?.action.allowed, false);

    updateDataWorkflowStep(database, {
      runId,
      stepKey: 'wallet_metadata',
      status: 'completed',
      markSuccess: true,
      markCompletedAt: true,
    });
    status = readDataWorkflowStatus(database, { runId });
    const afterMetadata = new Map(status.steps.map((step) => [step.stepKey, step]));
    // The manual workflow is sequential: once the prior step is explicitly completed, the next
    // step is runnable. Its own provider call determines whether it can produce complete evidence.
    assert.equal(afterMetadata.get('activity_history')?.action.allowed, true);
    assert.equal(afterMetadata.get('coverage_verification')?.action.allowed, false);
  } finally {
    database.close();
  }
});

test('a legacy run completed after Dune remains continuable for readiness', () => {
  const database = setup();
  try {
    const runId = addWorkflow(database, ['A', 'B']);
    for (const stepKey of [
      'wallet_metadata',
      'activity_history',
      'coverage_verification',
      'dune_outcomes',
    ] as const) {
      updateDataWorkflowStep(database, {
        runId,
        stepKey,
        status: 'completed',
        markSuccess: true,
        markCompletedAt: true,
      });
    }
    // This is the state produced by the old Dune completion handler.
    updateDataWorkflowRunStatus(database, { runId, status: 'completed', completed: true });

    const status = readDataWorkflowStatus(database, { runId });
    assert.equal(status.phase, 'ready_for_step');
    assert.equal(status.steps.find((step) => step.stepKey === 'readiness')?.action.allowed, true);
    assert.equal(status.steps.find((step) => step.stepKey === 'readiness')?.action.message, null);
    assert.equal(status.actions.pause.allowed, false);
  } finally {
    database.close();
  }
});

test('no run, external gmgn_fetch running: start is locked with the right reason and job entry', () => {
  const database = setup();
  try {
    addRunningFetchRun(database, null);
    const status = readDataWorkflowStatus(database, { chain: 'sol', targetDays: 30 });
    assert.equal(status.actions.start.allowed, false);
    assert.equal(status.actions.start.reasonCode, 'production_job_locked');
    assert.equal(status.jobs.length, 1);
    assert.equal(status.jobs[0].kind, 'gmgn_fetch');
    assert.equal(status.jobs[0].relationship, 'external');
  } finally {
    database.close();
  }
});

test('no run, external dune_simulation running: still correctly blocks (ownership fix did not make locking toothless)', () => {
  const database = setup();
  try {
    addDuneRun(database, 'running', null);
    const status = readDataWorkflowStatus(database, { chain: 'sol', targetDays: 30 });
    assert.equal(status.actions.start.allowed, false);
    assert.equal(status.actions.start.reasonCode, 'production_job_locked');
    assert.equal(status.jobs.length, 1);
    assert.equal(status.jobs[0].kind, 'dune_simulation');
    assert.equal(status.jobs[0].relationship, 'external');
  } finally {
    database.close();
  }
});

test('no run, external pattern_research running: still correctly blocks', () => {
  const database = setup();
  try {
    addRunningPatternDiscovery(database);
    const status = readDataWorkflowStatus(database, { chain: 'sol', targetDays: 30 });
    assert.equal(status.actions.start.allowed, false);
    assert.equal(status.actions.start.reasonCode, 'production_job_locked');
    assert.equal(status.jobs.length, 1);
    assert.equal(status.jobs[0].kind, 'pattern_research');
    assert.equal(status.jobs[0].relationship, 'external');
  } finally {
    database.close();
  }
});

test('run active with its own gmgn_fetch running: reported as owned, not an external lock', () => {
  const database = setup();
  try {
    const runId = addWorkflow(database, ['A', 'B']);
    addRunningFetchRun(database, runId);
    const status = readDataWorkflowStatus(database, { runId });
    assert.equal(status.actions.start.reasonCode, 'workflow_active');
    assert.equal(status.jobs.length, 1);
    assert.equal(status.jobs[0].kind, 'gmgn_fetch');
    assert.equal(status.jobs[0].relationship, 'owned');
    assert.equal(
      status.jobs.some((job) => job.relationship === 'external'),
      false,
    );
    assert.equal(status.shouldPoll, true);
  } finally {
    database.close();
  }
});

test('run active with its own Dune batch running: the exact false-positive regression this task fixes', () => {
  const database = setup();
  try {
    const runId = addWorkflow(database, ['A', 'B']);
    addDuneRun(database, 'running', runId);
    const status = readDataWorkflowStatus(database, { runId });

    assert.equal(status.jobs.length, 1);
    assert.equal(status.jobs[0].kind, 'dune_simulation');
    assert.equal(status.jobs[0].relationship, 'owned');
    assert.equal(
      status.jobs.some((job) => job.relationship === 'external'),
      false,
      "the workflow's own Dune batch must never appear as an external blocker",
    );
    assert.equal(status.actions.start.reasonCode, 'workflow_active');
    assert.notEqual(status.actions.start.reasonCode, 'production_job_locked');
    assert.equal(status.actions.pause.allowed, true);
    assert.equal(status.shouldPoll, true);
  } finally {
    database.close();
  }
});

test('run ready for the next step does not poll or offer pause', () => {
  const database = setup();
  try {
    const runId = addWorkflow(database, ['A', 'B']);
    const status = readDataWorkflowStatus(database, { runId });
    assert.deepEqual(status.jobs, []);
    assert.equal(status.phase, 'ready_for_step');
    assert.equal(status.actions.start.reasonCode, 'workflow_ready');
    assert.equal(status.actions.pause.allowed, false);
    assert.equal(status.shouldPoll, false);
  } finally {
    database.close();
  }
});

test('idle incomplete workflow exposes safe finish and cancel actions', () => {
  const database = setup();
  try {
    const runId = addWorkflow(database, ['A', 'B']);
    const status = readDataWorkflowStatus(database, { runId });
    assert.deepEqual(status.actions.finish, { allowed: true, reasonCode: 'ok', message: null });
    assert.deepEqual(status.actions.cancel, { allowed: true, reasonCode: 'ok', message: null });
  } finally {
    database.close();
  }
});

test('finish closes an idle incomplete workflow with explicit warnings and unblocks creation', () => {
  const database = setup();
  try {
    const runId = addWorkflow(database, ['A', 'B']);
    const result = finishDataWorkflow(database, runId);
    assert.deepEqual(result, { runId, status: 'completed_with_warnings' });

    const run = readDataWorkflowStatus(database, { runId });
    assert.equal(run.run?.status, 'completed_with_warnings');
    assert.equal(run.actions.start.allowed, true);
    assert.equal(
      run.steps.find((step) => step.stepKey === 'wallet_metadata')?.status,
      'completed_with_warnings',
    );
    assert.match(
      run.steps.find((step) => step.stepKey === 'wallet_metadata')?.warnings[0] ?? '',
      /not run/i,
    );
    assert.equal(
      run.run?.steps.find((step) => step.stepKey === 'wallet_metadata')?.lastSuccessAt,
      null,
      'an unrun step must not receive a last-success timestamp',
    );
    assert.equal(finishDataWorkflow(database, runId).status, 'completed_with_warnings');
  } finally {
    database.close();
  }
});

test('cancel closes an idle incomplete workflow without deleting saved roster evidence', () => {
  const database = setup();
  try {
    const runId = addWorkflow(database, ['A', 'B']);
    const result = cancelDataWorkflow(database, runId);
    assert.deepEqual(result, { runId, status: 'abandoned' });
    const run = readDataWorkflowStatus(database, { runId });
    assert.equal(run.run?.status, 'abandoned');
    assert.equal(run.actions.start.allowed, true);
    assert.equal(run.steps.find((step) => step.stepKey === 'roster')?.status, 'completed');
    assert.equal(cancelDataWorkflow(database, runId).status, 'abandoned');
  } finally {
    database.close();
  }
});

test('finish and cancel are blocked while an owned provider step is running', () => {
  const database = setup();
  try {
    const runId = addWorkflow(database, ['A', 'B']);
    updateDataWorkflowStep(database, {
      runId,
      stepKey: 'activity_history',
      status: 'running',
      underlyingRunId: addRunningFetchRun(database, runId),
      underlyingRunKind: 'gmgn_activity_fetch',
    });
    const status = readDataWorkflowStatus(database, { runId });
    assert.equal(status.actions.finish.allowed, false);
    assert.equal(status.actions.finish.reasonCode, 'workflow_close_unsafe');
    assert.equal(status.actions.cancel.allowed, false);
    assert.throws(() => finishDataWorkflow(database, runId), /current workflow step/i);
    assert.throws(() => cancelDataWorkflow(database, runId), /current workflow step/i);
  } finally {
    database.close();
  }
});

test('run paused with resume allowed: stops polling', () => {
  const database = setup();
  try {
    const runId = addWorkflow(database, ['A', 'B']);
    updateDataWorkflowRunStatus(database, { runId, status: 'paused', error: null });
    const status = readDataWorkflowStatus(database, { runId });
    assert.deepEqual(status.actions.start, {
      allowed: false,
      reasonCode: 'workflow_paused',
      message: 'Resume or finish the paused workflow before creating another run.',
    });
    assert.deepEqual(status.actions.resume, { allowed: true, reasonCode: 'ok', message: null });
    const metadata = status.steps.find((step) => step.stepKey === 'wallet_metadata');
    assert.equal(metadata?.action.allowed, false);
    assert.equal(metadata?.action.reasonCode, 'workflow_paused');
    assert.equal(metadata?.action.message, 'Resume the workflow first.');
    assert.equal(status.shouldPoll, false);
  } finally {
    database.close();
  }
});

test('run paused with an external lock present: resume is blocked and polling continues to notice it clear', () => {
  const database = setup();
  try {
    const runId = addWorkflow(database, ['A', 'B']);
    updateDataWorkflowRunStatus(database, { runId, status: 'paused', error: null });
    addRunningFetchRun(database, null); // a different, unrelated fetch
    const status = readDataWorkflowStatus(database, { runId });
    assert.equal(status.actions.resume.allowed, false);
    assert.equal(status.actions.resume.reasonCode, 'production_job_locked');
    assert.equal(status.shouldPoll, true);
  } finally {
    database.close();
  }
});

test("cross-run isolation: workflow A's owned Dune batch is external to workflow B, and still blocks B from starting", () => {
  const database = setup();
  try {
    const runA = addWorkflow(database, ['A']);
    addDuneRun(database, 'running', runA);

    const statusForB = readDataWorkflowStatus(database, { chain: 'sol', targetDays: 30 });
    // No runId selects the "no active run" view; runA is active so it is the selected run, and
    // its own Dune batch correctly still reads as owned from its own perspective...
    assert.equal(statusForB.run?.id, runA);
    assert.equal(statusForB.jobs[0]?.relationship, 'owned');

    // ...but a query scoped to a workflow that does NOT own the batch sees it as external.
    const runB = createDataWorkflowRun(database, {
      chain: 'sol',
      targetDays: 30,
      traderLimit: 1,
      rosterSnapshotId: null,
      rosterWallets: ['B'],
    });
    updateDataWorkflowRunStatus(database, { runId: runB, status: 'paused', error: null });
    const statusForRunB = readDataWorkflowStatus(database, { runId: runB });
    assert.equal(
      statusForRunB.jobs.some(
        (job) => job.kind === 'dune_simulation' && job.relationship === 'external',
      ),
      true,
    );
    assert.equal(statusForRunB.actions.resume.reasonCode, 'production_job_locked');
  } finally {
    database.close();
  }
});

test('a Dune batch orphaned by a server restart is cleared at startup, not left blocking forever', () => {
  const database = setup();
  try {
    // Simulates exactly what happened live: an old, now-unrelated workflow owned a Dune batch
    // that was mid-flight when the process restarted, leaving its row stuck at 'running' with no
    // process left to ever finish polling it.
    addDuneRun(database, 'running', null);
    const before = readDataWorkflowStatus(database, { chain: 'sol', targetDays: 30 });
    assert.equal(before.actions.start.allowed, false);
    assert.equal(before.actions.start.reasonCode, 'production_job_locked');

    const reconciled = reconcileStaleCopySimulationRuns(database);
    assert.equal(reconciled, 1);
    assert.equal(reconcileStaleCopySimulationRuns(database), 0, 'reconciling again is a no-op');

    const after = readDataWorkflowStatus(database, { chain: 'sol', targetDays: 30 });
    assert.equal(after.actions.start.allowed, true);
    assert.deepEqual(after.jobs, []);
  } finally {
    database.close();
  }
});

test('startup reconciliation preserves a Dune row with an execution id for recovery', () => {
  const database = setup();
  try {
    const runId = addDuneRun(database, 'running', null);
    database
      .prepare(`UPDATE copytrade_copy_simulation_runs SET execution_id = 'exec-123' WHERE id = ?`)
      .run(runId);

    assert.equal(reconcileStaleCopySimulationRuns(database), 0);
    const row = database
      .prepare(`SELECT status FROM copytrade_copy_simulation_runs WHERE id = ?`)
      .get(runId) as { status: string };
    assert.equal(row.status, 'running');
  } finally {
    database.close();
  }
});
