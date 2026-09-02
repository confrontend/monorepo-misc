import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import {
  createCopyTradeFetchRun,
  readFetchRunState,
  readWalletCoverageRows,
  requestCopyTradeFetchStop,
  runCopyTradeFetch,
  startCopyTradeFetch,
  type ActivityPage,
} from '../src/copytrade/screening/fetch.js';
import { createDataWorkflowRun } from '../src/copytrade/data/dataWorkflowRunStore.js';
import { openDatabase } from '../src/platform/db/client.js';
import { applyMigrations } from '../src/platform/db/schema.js';

const DAY = 86_400;

const setup = (): DatabaseSync => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  return database;
};

const activity = (wallet: string, timestamp: number, suffix: string): Record<string, unknown> => ({
  wallet,
  tx_hash: `TX-${wallet}-${suffix}`,
  event_type: 'sell',
  token: { address: `TOKEN-${wallet}-${suffix}` },
  timestamp,
  token_amount: '1',
  cost_usd: '10',
  buy_cost_usd: '5',
});

const fetchPages = (
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
      if (!page) throw new Error(`unexpected cursor ${String(requested)}`);
      return page;
    },
  };
};

const noStats = async (): Promise<void> => {};

const runWithPages = async (
  database: DatabaseSync,
  wallet: string,
  periodDays: number,
  pages: ActivityPage[],
  options: {
    pageBudgetPerWallet?: number;
    skipCompletedWallets?: boolean;
    refreshWallets?: string[];
  } = {},
): Promise<{ runId: number; calls: Array<string | null> }> => {
  const runId = createCopyTradeFetchRun(database, {
    limit: 1,
    periodDays,
    scope: 'roster',
  });
  const fake = fetchPages(pages);
  await runCopyTradeFetch(database, runId, {
    limit: 1,
    periodDays,
    walletAddresses: [wallet],
    fetchPage: fake.fetchPage,
    fetchStats: noStats,
    ...options,
  });
  return { runId, calls: fake.calls };
};

test('workflowRunId is optional and injected page/stats functions are used', async () => {
  const database = setup();
  try {
    const workflowRunId = createDataWorkflowRun(database, {
      chain: 'sol',
      targetDays: 30,
      traderLimit: 1,
      rosterSnapshotId: null,
      rosterWallets: ['INJECTED'],
    });
    const linkedRunId = createCopyTradeFetchRun(database, {
      limit: 1,
      periodDays: 30,
      workflowRunId,
    });
    const ordinaryRunId = createCopyTradeFetchRun(database, {
      limit: 1,
      periodDays: 30,
    });
    const linked = database
      .prepare(
        'SELECT workflow_run_id AS workflowRunId, fetch_scope AS fetchScope FROM copytrade_fetch_runs WHERE id = ?',
      )
      .get(linkedRunId) as { workflowRunId: number | null; fetchScope: string };
    const ordinary = database
      .prepare(
        'SELECT workflow_run_id AS workflowRunId, fetch_scope AS fetchScope FROM copytrade_fetch_runs WHERE id = ?',
      )
      .get(ordinaryRunId) as { workflowRunId: number | null; fetchScope: string };
    assert.equal(linked.workflowRunId, workflowRunId);
    assert.equal(linked.fetchScope, 'roster');
    assert.equal(ordinary.workflowRunId, null);

    const statsWallets: string[] = [];
    const page = fetchPages([
      { activities: [activity('INJECTED', Math.floor(Date.now() / 1000) - DAY, '1')], next: null },
    ]);
    await runCopyTradeFetch(database, linkedRunId, {
      limit: 1,
      periodDays: 30,
      walletAddresses: ['INJECTED'],
      fetchPage: page.fetchPage,
      fetchStats: async (_database, options) => {
        statsWallets.push(options.wallet);
      },
    });
    assert.deepEqual(page.calls, [null]);
    assert.deepEqual(statsWallets, ['INJECTED']);
  } finally {
    database.close();
  }
});

test('omitting the Data-only page budget preserves the ordinary unbounded walk', async () => {
  const database = setup();
  try {
    const now = Math.floor(Date.now() / 1000);
    const { calls, runId } = await runWithPages(database, 'ORDINARY', 90, [
      { activities: [activity('ORDINARY', now - DAY, '1')], next: 'c1' },
      { activities: [activity('ORDINARY', now - 2 * DAY, '2')], next: 'c2' },
      { activities: [activity('ORDINARY', now - 3 * DAY, '3')], next: null },
    ]);
    assert.deepEqual(calls, [null, 'c1', 'c2']);
    assert.equal(
      (
        database.prepare('SELECT status FROM copytrade_fetch_runs WHERE id = ?').get(runId) as {
          status: string;
        }
      ).status,
      'completed',
    );
    assert.equal(
      readWalletCoverageRows(database, 'sol', ['ORDINARY']).get('ORDINARY')?.stopReason,
      'no_more_data',
    );
  } finally {
    database.close();
  }
});

test('page budget persists the next cursor, while cursor_stalled persists none', async () => {
  const database = setup();
  try {
    const now = Math.floor(Date.now() / 1000);
    const first = await runWithPages(
      database,
      'CURSOR',
      90,
      [
        { activities: [activity('CURSOR', now - DAY, '1')], next: 'resume-here' },
        { activities: [activity('CURSOR', now - 2 * DAY, '2')], next: 'later' },
      ],
      { pageBudgetPerWallet: 1 },
    );
    assert.deepEqual(first.calls, [null]);
    assert.equal(
      readWalletCoverageRows(database, 'sol', ['CURSOR']).get('CURSOR')?.stopReason,
      'request_cap',
    );
    assert.equal(
      readWalletCoverageRows(database, 'sol', ['CURSOR']).get('CURSOR')?.resumeCursor,
      'resume-here',
    );

    const resumedRunId = createCopyTradeFetchRun(database, {
      limit: 1,
      periodDays: 90,
      scope: 'roster',
    });
    const resumedCalls: Array<string | null> = [];
    await runCopyTradeFetch(database, resumedRunId, {
      limit: 1,
      periodDays: 90,
      walletAddresses: ['CURSOR'],
      fetchPage: async ({ cursor }) => {
        resumedCalls.push(cursor);
        return { activities: [activity('CURSOR', now - 2 * DAY, '2')], next: null };
      },
      fetchStats: noStats,
    });
    assert.deepEqual(resumedCalls, ['resume-here']);
    assert.equal(
      readWalletCoverageRows(database, 'sol', ['CURSOR']).get('CURSOR')?.resumeCursor,
      null,
    );

    const stalled = await runWithPages(database, 'STALLED', 90, [
      { activities: [activity('STALLED', now - DAY, '1')], next: 'same' },
      { activities: [activity('STALLED', now - 2 * DAY, '2')], next: 'same' },
    ]);
    assert.deepEqual(stalled.calls, [null, 'same']);
    const stalledCoverage = readWalletCoverageRows(database, 'sol', ['STALLED']).get('STALLED');
    assert.equal(stalledCoverage?.stopReason, 'cursor_stalled');
    assert.equal(stalledCoverage?.resumeCursor, null);
  } finally {
    database.close();
  }
});

test('30d, 60d, and 90d requests deepen exactly instead of treating shallower coverage as complete', async () => {
  const database = setup();
  try {
    const now = Math.floor(Date.now() / 1000);
    const shallow = await runWithPages(database, 'DEPTH', 30, [
      { activities: [activity('DEPTH', now - 5 * DAY, '5')], next: '30' },
      { activities: [activity('DEPTH', now - 35 * DAY, '35')], next: null },
    ]);
    const medium = await runWithPages(database, 'DEPTH', 60, [
      { activities: [activity('DEPTH', now - 5 * DAY, '5')], next: '60-a' },
      { activities: [activity('DEPTH', now - 35 * DAY, '35')], next: '60-b' },
      { activities: [activity('DEPTH', now - 65 * DAY, '65')], next: null },
    ]);
    const deep = await runWithPages(database, 'DEPTH', 90, [
      { activities: [activity('DEPTH', now - 5 * DAY, '5')], next: '90-a' },
      { activities: [activity('DEPTH', now - 35 * DAY, '35')], next: '90-b' },
      { activities: [activity('DEPTH', now - 65 * DAY, '65')], next: '90-c' },
      { activities: [activity('DEPTH', now - 95 * DAY, '95')], next: null },
    ]);
    assert.equal(shallow.calls.length, 2);
    assert.equal(medium.calls.length, 3);
    assert.equal(deep.calls.length, 4);
    assert.equal(
      readWalletCoverageRows(database, 'sol', ['DEPTH']).get('DEPTH')?.requestedPeriodDays,
      90,
    );
    assert.equal(
      readWalletCoverageRows(database, 'sol', ['DEPTH']).get('DEPTH')?.coverageComplete,
      1,
    );

    const skipped = await runWithPages(
      database,
      'DEPTH',
      60,
      [{ activities: [activity('DEPTH', now - DAY, 'should-not-fetch')], next: null }],
      { skipCompletedWallets: true },
    );
    assert.deepEqual(skipped.calls, [], 'deeper complete coverage satisfies a shallower target');
  } finally {
    database.close();
  }
});

test('skipCompletedWallets skips complete wallets, and refreshWallets overrides that skip', async () => {
  const database = setup();
  try {
    const now = Math.floor(Date.now() / 1000);
    await runWithPages(database, 'DONE', 90, [
      { activities: [activity('DONE', now - 95 * DAY, 'existing')], next: null },
    ]);

    const statsWallets: string[] = [];
    const pageCalls: string[] = [];
    const resumeRunId = createCopyTradeFetchRun(database, {
      limit: 2,
      periodDays: 90,
      scope: 'roster',
    });
    await runCopyTradeFetch(database, resumeRunId, {
      limit: 2,
      periodDays: 90,
      walletAddresses: ['DONE', 'PENDING'],
      skipCompletedWallets: true,
      fetchPage: async ({ wallet }) => {
        pageCalls.push(wallet);
        return { activities: [activity(wallet, now - 5 * DAY, 'pending')], next: null };
      },
      fetchStats: async (_database, options) => {
        statsWallets.push(options.wallet);
      },
    });
    assert.deepEqual(pageCalls, ['PENDING']);
    assert.deepEqual(statsWallets, ['PENDING']);

    const refreshRunId = createCopyTradeFetchRun(database, {
      limit: 1,
      periodDays: 90,
      scope: 'single',
    });
    let refreshed = 0;
    await runCopyTradeFetch(database, refreshRunId, {
      limit: 1,
      periodDays: 90,
      walletAddresses: ['DONE'],
      skipCompletedWallets: true,
      refreshWallets: ['DONE'],
      fetchPage: async () => {
        refreshed += 1;
        return { activities: [activity('DONE', now - DAY, 'refresh')], next: null };
      },
      fetchStats: noStats,
    });
    assert.equal(refreshed, 1);
  } finally {
    database.close();
  }
});

test('pause cancellation keeps the cursor and reports paused with current-wallet progress', async () => {
  const database = setup();
  try {
    const now = Math.floor(Date.now() / 1000);
    database
      .prepare(
        `INSERT INTO copytrade_wallet_stats
         (wallet_address, chain, period, fetched_at, raw_payload)
         VALUES ('PROGRESS', 'sol', '30d', ?, '{"buy":3,"sell":2}')`,
      )
      .run(new Date().toISOString());
    const runId = createCopyTradeFetchRun(database, { limit: 1, periodDays: 30, scope: 'roster' });
    let releaseSecondPage: ((page: ActivityPage) => void) | null = null;
    const fetchPage = async ({ cursor }: { cursor: string | null }): Promise<ActivityPage> => {
      if (cursor === null) {
        return { activities: [activity('PROGRESS', now - DAY, 'first')], next: 'pause-cursor' };
      }
      return new Promise((resolve) => {
        releaseSecondPage = resolve;
      });
    };
    const runPromise = runCopyTradeFetch(database, runId, {
      limit: 1,
      periodDays: 30,
      walletAddresses: ['PROGRESS'],
      fetchPage,
      fetchStats: noStats,
      terminalStatusOnCancel: 'paused',
    });
    for (let attempt = 0; attempt < 100 && releaseSecondPage === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const release = releaseSecondPage as ((page: ActivityPage) => void) | null;
    if (release === null) throw new Error('the second page request should be in flight');

    const inFlight = readFetchRunState(database);
    assert.equal(inFlight.currentWalletAddress, 'PROGRESS');
    assert.equal(inFlight.currentWalletExpectedTrades, 5);
    assert.equal(inFlight.currentWalletStoredTrades, 1);
    assert.equal(inFlight.currentWalletRemainingTrades, 4);
    assert.equal(inFlight.currentWalletProgressPercent, 20);
    assert.equal(inFlight.currentWalletDetail?.pagesFetched, 1);
    assert.equal(
      inFlight.currentWalletDetail?.oldestStoredAt,
      new Date((now - DAY) * 1000).toISOString(),
    );

    assert.deepEqual(requestCopyTradeFetchStop(database), { stopped: true, runId });
    release({ activities: [activity('PROGRESS', now - 2 * DAY, 'second')], next: 'not-fetched' });
    await runPromise;

    const paused = readFetchRunState(database);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.running, false);
    assert.match(paused.message, /^Paused\./);
    assert.equal(paused.resumeAvailable, true);
    assert.equal(
      readWalletCoverageRows(database, 'sol', ['PROGRESS']).get('PROGRESS')?.stopReason,
      'cancelled',
    );
    assert.equal(
      readWalletCoverageRows(database, 'sol', ['PROGRESS']).get('PROGRESS')?.resumeCursor,
      'not-fetched',
    );
    assert.equal(paused.currentWalletDetail?.pagesFetched, 2);
  } finally {
    database.close();
  }
});

test('startCopyTradeFetch forwards injected fetch behavior without changing its default run status', async () => {
  const database = setup();
  try {
    const now = Math.floor(Date.now() / 1000);
    const page = fetchPages([{ activities: [activity('START', now - DAY, '1')], next: null }]);
    const started = startCopyTradeFetch(database, {
      limit: 1,
      periodDays: 30,
      walletAddresses: ['START'],
      fetchPage: page.fetchPage,
      fetchStats: noStats,
    });
    assert.equal(started.status, 'running');
    while (
      (
        database
          .prepare('SELECT status FROM copytrade_fetch_runs WHERE id = ?')
          .get(started.runId) as { status: string }
      ).status === 'running'
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.deepEqual(page.calls, [null]);
    assert.equal(
      (
        database
          .prepare('SELECT status FROM copytrade_fetch_runs WHERE id = ?')
          .get(started.runId) as { status: string }
      ).status,
      'completed',
    );
  } finally {
    database.close();
  }
});
