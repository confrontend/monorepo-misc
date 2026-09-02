import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/platform/db/client.js';
import { applyMigrations } from '../src/platform/db/schema.js';
import {
  createCopyTradeFetchRun,
  runCopyTradeFetch,
  readWalletCoverageRows,
  requestCopyTradeFetchStop,
  reconcileStaleFetchRuns,
  hasActiveFetchRun,
  type ActivityPage,
} from '../src/copytrade/screening/fetch.js';
import {
  createDataWorkflowRun,
  readDataWorkflowRun,
  updateDataWorkflowStep,
  reconcileStaleDataWorkflowRuns,
} from '../src/copytrade/data/dataWorkflowRunStore.js';
import {
  pauseDataWorkflow,
  resumeDataWorkflow,
  runDataWorkflowDune,
  retryDataWorkflowWallet,
} from '../src/copytrade/data/dataWorkflowOrchestrator.js';

const fetchStats = async (): Promise<void> => {};

const setup = (): DatabaseSync => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  return database;
};

const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);

const fakeFetchPage = (
  pages: ActivityPage[],
): {
  fetchPage: (options: { cursor: string | null }) => Promise<ActivityPage>;
  calls: Array<string | null>;
} => {
  const byCursor = new Map<string | null, ActivityPage>();
  let cursor: string | null = null;
  for (const page of pages) {
    byCursor.set(cursor, page);
    cursor = page.next;
  }
  const calls: Array<string | null> = [];
  return {
    calls,
    fetchPage: async ({ cursor: requested }) => {
      calls.push(requested);
      const page = byCursor.get(requested);
      if (!page) throw new Error(`unexpected cursor requested: ${String(requested)}`);
      return page;
    },
  };
};

const activity = (timestamp: number, suffix: string): Record<string, unknown> => ({
  wallet: 'WALLET',
  tx_hash: `TX-${suffix}`,
  event_type: 'sell',
  token: { address: `TOKEN-${suffix}` },
  timestamp,
  token_amount: '1',
});

test('a mid-wallet stop request saves the resume cursor at the NEXT unfetched page, not the one just stored', async () => {
  const database = setup();
  try {
    const runId = createCopyTradeFetchRun(database, { limit: 1, periodDays: 90, scope: 'single' });
    const pages: ActivityPage[] = [
      { activities: [activity(now - 1 * DAY, '1')], next: 'c1' },
      { activities: [activity(now - 2 * DAY, '2')], next: 'c2' },
      { activities: [activity(now - 3 * DAY, '3')], next: null },
    ];
    const byCursor = new Map<string | null, ActivityPage>();
    let cursor: string | null = null;
    for (const page of pages) {
      byCursor.set(cursor, page);
      cursor = page.next;
    }
    let calls = 0;
    const fetchPage = async ({
      cursor: requested,
    }: {
      cursor: string | null;
    }): Promise<ActivityPage> => {
      calls += 1;
      // Simulate a pause request arriving mid-fetch, exactly the way the Data workflow's Pause
      // action calls requestCopyTradeFetchStop while a page is in flight.
      if (calls === 1) requestCopyTradeFetchStop(database);
      const page = byCursor.get(requested);
      if (!page) throw new Error(`unexpected cursor requested: ${String(requested)}`);
      return page;
    };

    await runCopyTradeFetch(database, runId, {
      limit: 1,
      periodDays: 90,
      walletAddresses: ['WALLET'],
      terminalStatusOnCancel: 'paused',
      fetchPage,
      fetchStats,
    });

    assert.equal(calls, 1, 'stopped after exactly one page, before the second request was made');
    const coverage = readWalletCoverageRows(database, 'sol', ['WALLET']).get('WALLET');
    assert.equal(coverage?.stopReason, 'cancelled');
    // A user pause is cleanly resumable via its saved cursor, unlike a page-budget/cursor-stall
    // stop -- so it is deliberately not flagged 'truncated' the way those data-quality stops are.
    assert.equal(coverage?.truncated, 0);
    assert.equal(
      coverage?.resumeCursor,
      'c1',
      'resumes from the page after the one already stored',
    );

    const runRow = database
      .prepare(`SELECT status FROM copytrade_fetch_runs WHERE id = ?`)
      .get(runId) as {
      status: string;
    };
    assert.equal(
      runRow.status,
      'paused',
      'terminalStatusOnCancel is honored for a Data-workflow pause',
    );
  } finally {
    database.close();
  }
});

test('resuming after a mid-wallet stop genuinely continues from the saved cursor, not from page one', async () => {
  const database = setup();
  try {
    // First pass: stop after page 1 (same mechanism as the previous test).
    const firstRunId = createCopyTradeFetchRun(database, {
      limit: 1,
      periodDays: 90,
      scope: 'single',
    });
    const pages: ActivityPage[] = [
      { activities: [activity(now - 1 * DAY, '1')], next: 'c1' },
      { activities: [activity(now - 2 * DAY, '2')], next: 'c2' },
      { activities: [activity(now - 3 * DAY, '3')], next: null },
    ];
    const byCursor = new Map<string | null, ActivityPage>();
    let cursor: string | null = null;
    for (const page of pages) {
      byCursor.set(cursor, page);
      cursor = page.next;
    }
    let firstCalls = 0;
    await runCopyTradeFetch(database, firstRunId, {
      limit: 1,
      periodDays: 90,
      walletAddresses: ['WALLET'],
      terminalStatusOnCancel: 'paused',
      fetchPage: async ({ cursor: requested }) => {
        firstCalls += 1;
        if (firstCalls === 1) requestCopyTradeFetchStop(database);
        const page = byCursor.get(requested);
        if (!page) throw new Error(`unexpected cursor requested: ${String(requested)}`);
        return page;
      },
      fetchStats,
    });
    assert.equal(
      readWalletCoverageRows(database, 'sol', ['WALLET']).get('WALLET')?.resumeCursor,
      'c1',
    );

    // Resume: a fresh run against the same wallet must pick up exactly at 'c1', never re-request
    // page one (null cursor).
    const secondRunId = createCopyTradeFetchRun(database, {
      limit: 1,
      periodDays: 90,
      scope: 'single',
    });
    const resumeFetch = fakeFetchPage(pages);
    await runCopyTradeFetch(database, secondRunId, {
      limit: 1,
      periodDays: 90,
      walletAddresses: ['WALLET'],
      fetchPage: resumeFetch.fetchPage,
      fetchStats,
    });

    assert.deepEqual(
      resumeFetch.calls,
      ['c1', 'c2'],
      'resumed from the saved cursor, not page one',
    );
    const coverage = readWalletCoverageRows(database, 'sol', ['WALLET']).get('WALLET');
    assert.equal(coverage?.stopReason, 'no_more_data');
    assert.equal(coverage?.truncated, 0);
  } finally {
    database.close();
  }
});

test('a simulated server restart marks an active workflow (and its running step) paused independently of the underlying fetch run reconciler', () => {
  const database = setup();
  try {
    const runId = createDataWorkflowRun(database, {
      chain: 'sol',
      targetDays: 90,
      traderLimit: 1,
      rosterSnapshotId: null,
      rosterWallets: ['WALLET'],
    });
    updateDataWorkflowStep(database, {
      runId,
      stepKey: 'activity_history',
      status: 'running',
      underlyingRunKind: 'copytrade_fetch_runs',
    });
    database
      .prepare(
        `INSERT INTO copytrade_fetch_runs (started_at, status, requested_period_days) VALUES (?, 'running', 90)`,
      )
      .run(new Date().toISOString());

    // Server-restart order, as wired in server.ts: the workflow-level reconciler runs first so the
    // workflow is captured as resumable before the generic fetch-run reconciler unconditionally
    // fails every running fetch row.
    const reconciledWorkflows = reconcileStaleDataWorkflowRuns(database);
    const reconciledFetchRuns = reconcileStaleFetchRuns(database);

    assert.equal(reconciledWorkflows, 1);
    assert.equal(reconciledFetchRuns, 1);
    const run = readDataWorkflowRun(database, runId)!;
    assert.equal(run.status, 'paused');
    assert.match(run.error ?? '', /server restart/i);
    assert.equal(run.steps.find((step) => step.stepKey === 'activity_history')!.status, 'paused');
    assert.equal(
      hasActiveFetchRun(database),
      false,
      'the stale fetch run itself no longer looks active',
    );
  } finally {
    database.close();
  }
});

test('pauseDataWorkflow only succeeds on an active run and resumeDataWorkflow only succeeds on a paused one', () => {
  const database = setup();
  try {
    const runId = createDataWorkflowRun(database, {
      chain: 'sol',
      targetDays: 30,
      traderLimit: 1,
      rosterSnapshotId: null,
      rosterWallets: ['WALLET'],
    });
    updateDataWorkflowStep(database, {
      runId,
      stepKey: 'wallet_metadata',
      status: 'running',
      underlyingRunKind: 'gmgn_stats_fetch',
    });

    assert.throws(() => resumeDataWorkflow(database, runId), /not paused/);

    const paused = pauseDataWorkflow(database, runId);
    assert.equal(paused.status, 'paused');
    assert.equal(readDataWorkflowRun(database, runId)!.status, 'paused');

    assert.throws(() => pauseDataWorkflow(database, runId), /not active/);
  } finally {
    database.close();
  }
});

test('pausing a workflow does not stop an unrelated GMGN fetch', () => {
  const database = setup();
  try {
    const runId = createDataWorkflowRun(database, {
      chain: 'sol',
      targetDays: 30,
      traderLimit: 1,
      rosterSnapshotId: null,
      rosterWallets: ['WALLET'],
    });
    updateDataWorkflowStep(database, {
      runId,
      stepKey: 'activity_history',
      status: 'running',
      underlyingRunKind: 'gmgn_activity_fetch',
    });
    const fetchRunId = Number(
      database
        .prepare(
          `INSERT INTO copytrade_fetch_runs (started_at, status, workflow_run_id)
           VALUES (?, 'running', NULL)`,
        )
        .run(new Date().toISOString()).lastInsertRowid,
    );

    pauseDataWorkflow(database, runId);

    const row = database
      .prepare(`SELECT status FROM copytrade_fetch_runs WHERE id = ?`)
      .get(fetchRunId) as { status: string };
    assert.equal(row.status, 'running');
  } finally {
    database.close();
  }
});

test('runDataWorkflowDune reports the exact coverage shortfall instead of silently doing nothing', () => {
  const database = setup();
  try {
    const runId = createDataWorkflowRun(database, {
      chain: 'sol',
      targetDays: 90,
      traderLimit: 1,
      rosterSnapshotId: null,
      rosterWallets: ['WALLET'],
    });
    assert.throws(
      () => runDataWorkflowDune(database, { runId }),
      /Dune outcomes are blocked until 1 wallets complete 90-day history\./,
    );
  } finally {
    database.close();
  }
});

test('retryDataWorkflowWallet refuses to start while another GMGN activity fetch is already running', () => {
  const database = setup();
  try {
    const runId = createDataWorkflowRun(database, {
      chain: 'sol',
      targetDays: 30,
      traderLimit: 1,
      rosterSnapshotId: null,
      rosterWallets: ['WALLET'],
    });
    database
      .prepare(
        `INSERT INTO copytrade_fetch_runs (started_at, status, requested_period_days) VALUES (?, 'running', 30)`,
      )
      .run(new Date().toISOString());

    assert.throws(
      () => retryDataWorkflowWallet(database, { runId, walletAddress: 'WALLET' }),
      /already running/,
    );
  } finally {
    database.close();
  }
});
