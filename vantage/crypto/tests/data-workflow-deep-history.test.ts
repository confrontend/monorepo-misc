import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/platform/db/client.js';
import { applyMigrations } from '../src/platform/db/schema.js';
import {
  createCopyTradeFetchRun,
  runCopyTradeFetch,
  readWalletCoverageRows,
  type ActivityPage,
} from '../src/copytrade/screening/fetch.js';

// Stubs the per-wallet supporting-stats call so tests never pay the real 5s GMGN rate gate for
// a request whose result these tests don't examine (fetch.ts already treats its failure as
// non-fatal to the trade walk, so a no-op stub changes nothing observable).
const fetchStats = async (): Promise<void> => {};

const setup = (): DatabaseSync => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  return database;
};

const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);

/** Builds a fake `fetchPage` from an ordered list of pages. The first page is served for
 *  `cursor: null`; each subsequent page is served for the previous page's `next` cursor. Records
 *  every cursor it was actually called with, so a test can assert exactly how many requests
 *  happened and with which cursor (e.g. proving a resume genuinely started from a saved cursor
 *  rather than page 1). */
const fakeFetchPage = (
  pages: ActivityPage[],
): { fetchPage: (options: { cursor: string | null }) => Promise<ActivityPage>; calls: Array<string | null> } => {
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

const activity = (
  timestamp: number,
  suffix: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  wallet: 'WALLET',
  tx_hash: `TX-${suffix}`,
  event_type: 'sell',
  token: { address: `TOKEN-${suffix}` },
  timestamp,
  token_amount: '1',
  cost_usd: '10',
  buy_cost_usd: '5',
  ...over,
});

test('a wallet whose oldest page reaches the cutoff stops with window_covered', async () => {
  const database = setup();
  try {
    const runId = createCopyTradeFetchRun(database, { limit: 1, periodDays: 30, scope: 'single' });
    const { fetchPage, calls } = fakeFetchPage([
      { activities: [activity(now - 5 * DAY, '1')], next: 'c1' },
      { activities: [activity(now - 40 * DAY, '2')], next: 'c2' },
    ]);
    await runCopyTradeFetch(database, runId, {
      limit: 1,
      periodDays: 30,
      walletAddresses: ['WALLET'],
      fetchPage,
      fetchStats,
    });

    assert.equal(calls.length, 2, 'stopped as soon as the cutoff was reached, not before');
    const coverage = readWalletCoverageRows(database, 'sol', ['WALLET']).get('WALLET');
    assert.equal(coverage?.stopReason, 'window_covered');
    assert.equal(coverage?.truncated, 0);
    assert.equal(coverage?.resumeCursor, null, 'a fully covered window has nothing to resume');
  } finally {
    database.close();
  }
});

test('a wallet younger than the requested window stops with no_more_data, not an error', async () => {
  const database = setup();
  try {
    const runId = createCopyTradeFetchRun(database, { limit: 1, periodDays: 90, scope: 'single' });
    const { fetchPage } = fakeFetchPage([{ activities: [activity(now - 10 * DAY, '1')], next: null }]);
    await runCopyTradeFetch(database, runId, {
      limit: 1,
      periodDays: 90,
      walletAddresses: ['WALLET'],
      fetchPage,
      fetchStats,
    });

    const coverage = readWalletCoverageRows(database, 'sol', ['WALLET']).get('WALLET');
    assert.equal(coverage?.stopReason, 'no_more_data');
    assert.equal(coverage?.truncated, 0);
    assert.equal(coverage?.coverageComplete, 1, 'genuinely exhausting pagination is a real completion');
  } finally {
    database.close();
  }
});

test('a per-wallet page budget stops the walk, marks it truncated, and saves a resume cursor pointing at the NEXT page', async () => {
  const database = setup();
  try {
    const runId = createCopyTradeFetchRun(database, { limit: 1, periodDays: 90, scope: 'single' });
    // None of these pages reach the 90-day cutoff or run out of data on their own -- only the
    // page budget should stop this walk.
    const { fetchPage, calls } = fakeFetchPage([
      { activities: [activity(now - 1 * DAY, '1')], next: 'c1' },
      { activities: [activity(now - 2 * DAY, '2')], next: 'c2' },
      { activities: [activity(now - 3 * DAY, '3')], next: 'c3' },
    ]);
    await runCopyTradeFetch(database, runId, {
      limit: 1,
      periodDays: 90,
      walletAddresses: ['WALLET'],
      pageBudgetPerWallet: 2,
      fetchPage,
      fetchStats,
    });

    assert.deepEqual(calls, [null, 'c1'], 'stopped after exactly the budgeted number of pages');
    const coverage = readWalletCoverageRows(database, 'sol', ['WALLET']).get('WALLET');
    assert.equal(coverage?.stopReason, 'request_cap');
    assert.equal(coverage?.truncated, 1);
    assert.equal(
      coverage?.resumeCursor,
      'c2',
      'resumes from the next unfetched page, not the page that was just stored',
    );
  } finally {
    database.close();
  }
});

test('a repeated cursor is classified cursor_stalled and does NOT save a resume cursor', async () => {
  const database = setup();
  try {
    const runId = createCopyTradeFetchRun(database, { limit: 1, periodDays: 90, scope: 'single' });
    // Page 2's `next` points back to a cursor already seen ('c1' was the cursor used to fetch
    // page 2 itself is not the issue -- the provider returning a `next` that repeats is).
    const { fetchPage } = fakeFetchPage([
      { activities: [activity(now - 1 * DAY, '1')], next: 'c1' },
      { activities: [activity(now - 2 * DAY, '2')], next: 'c1' },
    ]);
    await runCopyTradeFetch(database, runId, {
      limit: 1,
      periodDays: 90,
      walletAddresses: ['WALLET'],
      fetchPage,
      fetchStats,
    });

    const coverage = readWalletCoverageRows(database, 'sol', ['WALLET']).get('WALLET');
    assert.equal(coverage?.stopReason, 'cursor_stalled');
    assert.equal(coverage?.truncated, 1);
    assert.equal(coverage?.resumeCursor, null, 'a known-bad cursor must never be resumed from');
  } finally {
    database.close();
  }
});

test('three consecutive barren pages outside known coverage are cursor_stalled, not silently accepted', async () => {
  const database = setup();
  try {
    const runId = createCopyTradeFetchRun(database, { limit: 1, periodDays: 90, scope: 'single' });
    const emptyPage = (suffix: string, next: string | null): ActivityPage => ({
      // Real activities that all fail to insert (malformed) look "barren" the same way an empty
      // page does -- simplest reproduction here is truly empty pages, which are barren by
      // definition and unambiguous to reason about.
      activities: [{ wallet: 'WALLET', event_type: 'sell' }],
      next,
    });
    const { fetchPage } = fakeFetchPage([
      emptyPage('1', 'c1'),
      emptyPage('2', 'c2'),
      emptyPage('3', 'c3'),
      emptyPage('4', 'c4'),
    ]);
    await runCopyTradeFetch(database, runId, {
      limit: 1,
      periodDays: 90,
      walletAddresses: ['WALLET'],
      fetchPage,
      fetchStats,
    });

    const coverage = readWalletCoverageRows(database, 'sol', ['WALLET']).get('WALLET');
    assert.equal(coverage?.stopReason, 'cursor_stalled');
    assert.equal(coverage?.resumeCursor, null);
  } finally {
    database.close();
  }
});

test('re-running the exact same pages is idempotent: zero new inserts, everything counted as duplicate', async () => {
  const database = setup();
  try {
    const pages: ActivityPage[] = [
      { activities: [activity(now - 5 * DAY, '1')], next: 'c1' },
      { activities: [activity(now - 40 * DAY, '2')], next: null },
    ];

    const runOnce = async () => {
      const runId = createCopyTradeFetchRun(database, { limit: 1, periodDays: 30, scope: 'single' });
      const { fetchPage } = fakeFetchPage(pages);
      await runCopyTradeFetch(database, runId, {
        limit: 1,
        periodDays: 30,
        walletAddresses: ['WALLET'],
        fetchPage,
        fetchStats,
      });
    };

    await runOnce();
    const countAfterFirst = (
      database.prepare(`SELECT COUNT(*) AS count FROM copytrade_trades`).get() as { count: number }
    ).count;
    assert.equal(countAfterFirst, 2);

    await runOnce();
    const countAfterSecond = (
      database.prepare(`SELECT COUNT(*) AS count FROM copytrade_trades`).get() as { count: number }
    ).count;
    assert.equal(countAfterSecond, 2, 'no duplicate rows were inserted on the identical re-run');
  } finally {
    database.close();
  }
});

test('deepening 30d coverage to 90d actually re-walks instead of trusting the shallower prior pass', async () => {
  const database = setup();
  try {
    // First pass: a genuinely complete 30-day walk.
    const shallowRunId = createCopyTradeFetchRun(database, {
      limit: 1,
      periodDays: 30,
      scope: 'single',
    });
    const shallow = fakeFetchPage([
      { activities: [activity(now - 5 * DAY, '1')], next: 'c1' },
      { activities: [activity(now - 35 * DAY, '2')], next: null },
    ]);
    await runCopyTradeFetch(database, shallowRunId, {
      limit: 1,
      periodDays: 30,
      walletAddresses: ['WALLET'],
      fetchPage: shallow.fetchPage,
      fetchStats,
    });
    // The shallow pass's last page has next:null, so "pagination genuinely ended" correctly
    // takes precedence over "the content also happens to reach the 30-day cutoff" -- the
    // provider itself is the one saying there's nothing more, which is a real completion too.
    assert.equal(readWalletCoverageRows(database, 'sol', ['WALLET']).get('WALLET')?.stopReason, 'no_more_data');

    // Second pass at 90 days: trustedCoverage must be invalidated by the deeper request, so this
    // genuinely walks again rather than being skipped as "already covered."
    const deepRunId = createCopyTradeFetchRun(database, { limit: 1, periodDays: 90, scope: 'single' });
    const deep = fakeFetchPage([
      { activities: [activity(now - 5 * DAY, '1')], next: 'c1' },
      { activities: [activity(now - 35 * DAY, '2')], next: 'c2' },
      { activities: [activity(now - 95 * DAY, '3')], next: 'c3' },
    ]);
    await runCopyTradeFetch(database, deepRunId, {
      limit: 1,
      periodDays: 90,
      walletAddresses: ['WALLET'],
      fetchPage: deep.fetchPage,
      fetchStats,
    });

    assert.ok(deep.calls.length >= 3, 'a real walk happened, not a skip');
    const coverage = readWalletCoverageRows(database, 'sol', ['WALLET']).get('WALLET');
    assert.equal(coverage?.stopReason, 'window_covered');
    assert.equal(coverage?.requestedPeriodDays, 90);
  } finally {
    database.close();
  }
});

test('skipCompletedWallets skips a wallet entirely once it has genuine coverage at the target depth, but not a wallet in refreshWallets', async () => {
  const database = setup();
  try {
    // Establish genuine 90-day coverage for DONE, and leave PENDING with nothing.
    const setupRunId = createCopyTradeFetchRun(database, { limit: 2, periodDays: 90, scope: 'roster' });
    const setupFetch = fakeFetchPage([
      { activities: [activity(now - 95 * DAY, '1', { wallet: 'DONE' })], next: null },
    ]);
    await runCopyTradeFetch(database, setupRunId, {
      limit: 1,
      periodDays: 90,
      walletAddresses: ['DONE'],
      fetchPage: setupFetch.fetchPage,
      fetchStats,
    });
    assert.equal(readWalletCoverageRows(database, 'sol', ['DONE']).get('DONE')?.stopReason, 'no_more_data');

    const resumeRunId = createCopyTradeFetchRun(database, {
      limit: 2,
      periodDays: 90,
      scope: 'roster',
    });
    const resumeFetch = fakeFetchPage([
      { activities: [activity(now - 95 * DAY, '2', { wallet: 'PENDING' })], next: null },
    ]);
    await runCopyTradeFetch(database, resumeRunId, {
      limit: 2,
      periodDays: 90,
      walletAddresses: ['DONE', 'PENDING'],
      skipCompletedWallets: true,
      fetchPage: resumeFetch.fetchPage,
      fetchStats,
    });

    assert.equal(resumeFetch.calls.length, 1, 'DONE made zero requests; only PENDING was walked');
    assert.equal(
      readWalletCoverageRows(database, 'sol', ['PENDING']).get('PENDING')?.stopReason,
      'no_more_data',
    );
  } finally {
    database.close();
  }
});

test('refreshWallets forces a real walk for a named wallet even though it would otherwise be skipped', async () => {
  const database = setup();
  try {
    const setupRunId = createCopyTradeFetchRun(database, { limit: 1, periodDays: 90, scope: 'single' });
    const setupFetch = fakeFetchPage([
      { activities: [activity(now - 95 * DAY, '1', { wallet: 'DONE' })], next: null },
    ]);
    await runCopyTradeFetch(database, setupRunId, {
      limit: 1,
      periodDays: 90,
      walletAddresses: ['DONE'],
      fetchPage: setupFetch.fetchPage,
      fetchStats,
    });

    const retryRunId = createCopyTradeFetchRun(database, { limit: 1, periodDays: 90, scope: 'single' });
    const retryFetch = fakeFetchPage([
      { activities: [activity(now - 96 * DAY, '2', { wallet: 'DONE' })], next: null },
    ]);
    await runCopyTradeFetch(database, retryRunId, {
      limit: 1,
      periodDays: 90,
      walletAddresses: ['DONE'],
      skipCompletedWallets: true,
      refreshWallets: ['DONE'],
      fetchPage: retryFetch.fetchPage,
      fetchStats,
    });

    assert.equal(retryFetch.calls.length, 1, 'DONE was retried despite already having coverage');
  } finally {
    database.close();
  }
});
