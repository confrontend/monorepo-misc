import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { readHistoryDepthCoverage } from '../src/copytrade/features/walletFeatureCoverage.js';
import { openDatabase } from '../src/platform/db/client.js';
import { applyMigrations } from '../src/platform/db/schema.js';

const setup = (): DatabaseSync => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  return database;
};

const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);
const NOW_ISO = new Date(now * 1_000).toISOString();

const insertTrade = (
  database: DatabaseSync,
  walletAddress: string,
  eventType: string,
  observedTimestamp: number,
  suffix: string,
): void => {
  database
    .prepare(
      `INSERT INTO copytrade_trades
       (wallet_address, chain, tx_hash, event_type, token_address, observed_timestamp,
        raw_payload, fetched_at, dedup_key)
       VALUES (?, 'sol', ?, ?, 'TOKEN', ?, '{}', ?, ?)`,
    )
    .run(
      walletAddress,
      `TX-${suffix}`,
      eventType,
      observedTimestamp,
      NOW_ISO,
      `${walletAddress}:${suffix}`,
    );
};

const insertFetchRun = (database: DatabaseSync): number => {
  database
    .prepare(`INSERT INTO copytrade_fetch_runs (started_at, status) VALUES (?, 'completed')`)
    .run(NOW_ISO);
  return Number((database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
};

/** `oldestDaysAgo`/`newestDaysAgo` build oldest_held_ts/newest_held_ts relative to `now`, and
 *  `observedAt` defaults to "now" -- matching how production actually records a coverage event
 *  (recordCoverage always stamps observed_at at the moment the walk just finished). Depth is
 *  measured FROM observed_at BACK TO oldest_held_ts, so keeping these two anchored to the same
 *  "now" is what makes a fixture's intended depth (oldestDaysAgo) equal the value under test. */
const insertCoverageEvent = (
  database: DatabaseSync,
  walletAddress: string,
  values: {
    runId: number;
    requestedPeriodDays: number;
    truncated: number;
    stopReason: string;
    oldestDaysAgo: number | null;
    newestDaysAgo: number | null;
    observedAt?: string;
    error?: string | null;
  },
): void => {
  database
    .prepare(
      `INSERT INTO copytrade_wallet_coverage_events
       (run_id, wallet_address, chain, requested_period_days, requests_used, truncated,
        stop_reason, oldest_held_ts, newest_held_ts, observed_at, error)
       VALUES (?, ?, 'sol', ?, 4, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      values.runId,
      walletAddress,
      values.requestedPeriodDays,
      values.truncated,
      values.stopReason,
      values.oldestDaysAgo === null ? null : now - values.oldestDaysAgo * DAY,
      values.newestDaysAgo === null ? null : now - values.newestDaysAgo * DAY,
      values.observedAt ?? NOW_ISO,
      values.error ?? null,
    );
};

const insertLatestCoverage = (
  database: DatabaseSync,
  walletAddress: string,
  values: { runId: number; periodDays: number; pagesFetched: number },
): void => {
  database
    .prepare(
      `INSERT INTO copytrade_wallet_coverage
       (wallet_address, chain, last_run_id, requests_used, truncated, coverage_complete,
        requested_period_days, stop_reason, updated_at, pages_fetched)
       VALUES (?, 'sol', ?, 4, 0, 1, ?, 'window_covered', ?, ?)`,
    )
    .run(walletAddress, values.runId, values.periodDays, NOW_ISO, values.pagesFetched);
};

test('a wallet that genuinely reached the target depth is classified reached_target with correct milestones', () => {
  const database = setup();
  try {
    const runId = insertFetchRun(database);
    insertTrade(database, 'DEEP', 'buy', now - 95 * DAY, '1');
    insertTrade(database, 'DEEP', 'sell', now, '2');
    insertCoverageEvent(database, 'DEEP', {
      runId,
      requestedPeriodDays: 90,
      truncated: 0,
      stopReason: 'window_covered',
      oldestDaysAgo: 95,
      newestDaysAgo: 0,
    });
    insertLatestCoverage(database, 'DEEP', { runId, periodDays: 90, pagesFetched: 12 });

    const inventory = readHistoryDepthCoverage(database, {
      walletAddresses: ['DEEP'],
      chain: 'sol',
      targetDays: 90,
    });

    const [row] = inventory.rows;
    assert.equal(row.status, 'reached_target');
    assert.deepEqual(row.milestones, { 30: true, 60: true, 90: true });
    assert.ok(row.deepestCompletedDays !== null && Math.abs(row.deepestCompletedDays - 95) < 0.01);
    assert.equal(row.pagesFetched, 12);
    assert.equal(inventory.summary.byMilestone[90], 1);
    assert.equal(inventory.summary.byStatus.reached_target, 1);
  } finally {
    database.close();
  }
});

test('a young wallet whose pagination genuinely ends before the target is pagination_exhausted, not an error', () => {
  const database = setup();
  try {
    const runId = insertFetchRun(database);
    insertTrade(database, 'YOUNG', 'buy', now - 20 * DAY, '1');
    insertTrade(database, 'YOUNG', 'sell', now, '2');
    // Requested 90d, but GMGN had nothing older -- pagination ended on its own.
    insertCoverageEvent(database, 'YOUNG', {
      runId,
      requestedPeriodDays: 90,
      truncated: 0,
      stopReason: 'no_more_data',
      oldestDaysAgo: 20,
      newestDaysAgo: 0,
    });

    const inventory = readHistoryDepthCoverage(database, {
      walletAddresses: ['YOUNG'],
      chain: 'sol',
      targetDays: 90,
    });

    const [row] = inventory.rows;
    assert.equal(row.status, 'pagination_exhausted');
    assert.deepEqual(row.milestones, { 30: false, 60: false, 90: false });
    assert.ok(row.deepestCompletedDays !== null && Math.abs(row.deepestCompletedDays - 20) < 0.01);
  } finally {
    database.close();
  }
});

test('a page-budget/cursor-stall stop is reported as partial, and never counted as a reached milestone', () => {
  const database = setup();
  try {
    const runId = insertFetchRun(database);
    insertTrade(database, 'PARTIAL', 'buy', now - 40 * DAY, '1');
    insertTrade(database, 'PARTIAL', 'sell', now, '2');
    insertCoverageEvent(database, 'PARTIAL', {
      runId,
      requestedPeriodDays: 90,
      truncated: 1,
      stopReason: 'request_cap',
      oldestDaysAgo: 40,
      newestDaysAgo: 0,
    });

    const inventory = readHistoryDepthCoverage(database, {
      walletAddresses: ['PARTIAL'],
      chain: 'sol',
      targetDays: 90,
    });

    const [row] = inventory.rows;
    assert.equal(row.status, 'partial');
    assert.deepEqual(row.milestones, { 30: false, 60: false, 90: false });
  } finally {
    database.close();
  }
});

test('a wallet with no coverage events at all is not_fetched', () => {
  const database = setup();
  try {
    const inventory = readHistoryDepthCoverage(database, {
      walletAddresses: ['NEVER-FETCHED'],
      chain: 'sol',
      targetDays: 30,
    });
    const [row] = inventory.rows;
    assert.equal(row.status, 'not_fetched');
    assert.deepEqual(row.milestones, { 30: false, 60: false, 90: false });
    assert.equal(inventory.summary.byStatus.not_fetched, 1);
  } finally {
    database.close();
  }
});

test('a genuine failure with no prior completion is reported as error', () => {
  const database = setup();
  try {
    const runId = insertFetchRun(database);
    insertCoverageEvent(database, 'BROKEN', {
      runId,
      requestedPeriodDays: 90,
      truncated: 1,
      stopReason: 'failed',
      oldestDaysAgo: null,
      newestDaysAgo: null,
      error: 'GMGN CLI exited with code 1',
    });

    const inventory = readHistoryDepthCoverage(database, {
      walletAddresses: ['BROKEN'],
      chain: 'sol',
      targetDays: 90,
    });
    const [row] = inventory.rows;
    assert.equal(row.status, 'error');
    assert.equal(row.lastError, 'GMGN CLI exited with code 1');
  } finally {
    database.close();
  }
});

test('a later failure takes precedence over an older shallow completion', () => {
  const database = setup();
  try {
    const completedRunId = insertFetchRun(database);
    insertTrade(database, 'RETRY-FAILED', 'buy', now - 35 * DAY, '1');
    insertTrade(database, 'RETRY-FAILED', 'sell', now, '2');
    insertCoverageEvent(database, 'RETRY-FAILED', {
      runId: completedRunId,
      requestedPeriodDays: 30,
      truncated: 0,
      stopReason: 'no_more_data',
      oldestDaysAgo: 35,
      newestDaysAgo: 0,
    });

    const failedRunId = insertFetchRun(database);
    insertCoverageEvent(database, 'RETRY-FAILED', {
      runId: failedRunId,
      requestedPeriodDays: 90,
      truncated: 1,
      stopReason: 'failed',
      oldestDaysAgo: 35,
      newestDaysAgo: 0,
      error: 'GMGN request failed',
    });

    const inventory = readHistoryDepthCoverage(database, {
      walletAddresses: ['RETRY-FAILED'],
      chain: 'sol',
      targetDays: 90,
    });
    const [row] = inventory.rows;
    assert.equal(row.status, 'error');
    assert.equal(row.stopReason, 'failed');
    assert.equal(row.lastError, 'GMGN request failed');
    assert.equal(row.milestones[30], true);
    assert.equal(inventory.summary.byStatus.error, 1);
  } finally {
    database.close();
  }
});

test('supersession hazard: a shallower re-fetch does not erase a previously-completed deeper milestone', () => {
  const database = setup();
  try {
    const deepRunId = insertFetchRun(database);
    insertTrade(database, 'DEEPENED-THEN-RESHALLOWED', 'buy', now - 95 * DAY, '1');
    insertTrade(database, 'DEEPENED-THEN-RESHALLOWED', 'sell', now, '2');
    // First, a genuine 90-day completion, recorded an hour ago.
    const anHourAgoIso = new Date((now - 3_600) * 1_000).toISOString();
    insertCoverageEvent(database, 'DEEPENED-THEN-RESHALLOWED', {
      runId: deepRunId,
      requestedPeriodDays: 90,
      truncated: 0,
      stopReason: 'window_covered',
      oldestDaysAgo: 95,
      newestDaysAgo: 0,
      observedAt: anHourAgoIso,
    });
    // Then a later, shallower 30-day run overwrites the LATEST copytrade_wallet_coverage row
    // (which only ever holds one row per wallet+chain) with a smaller requested_period_days.
    const shallowRunId = insertFetchRun(database);
    insertCoverageEvent(database, 'DEEPENED-THEN-RESHALLOWED', {
      runId: shallowRunId,
      requestedPeriodDays: 30,
      truncated: 0,
      stopReason: 'up_to_date',
      oldestDaysAgo: 30,
      newestDaysAgo: 0,
    });
    insertLatestCoverage(database, 'DEEPENED-THEN-RESHALLOWED', {
      runId: shallowRunId,
      periodDays: 30,
      pagesFetched: 2,
    });

    // The milestone must still reflect the deepest genuine completion ever observed (95 days),
    // not just the latest coverage row's requested_period_days=30.
    const inventory = readHistoryDepthCoverage(database, {
      walletAddresses: ['DEEPENED-THEN-RESHALLOWED'],
      chain: 'sol',
      targetDays: 90,
    });
    const [row] = inventory.rows;
    assert.equal(row.status, 'reached_target');
    assert.deepEqual(row.milestones, { 30: true, 60: true, 90: true });
    // The deep event's observed_at was deliberately set an hour before "now" (to simulate it
    // having been recorded earlier than the later shallow event), so the exact depth is ~95 days
    // minus that hour -- assert it's close to 95, not exactly 95 to the millisecond.
    assert.ok(row.deepestCompletedDays !== null && Math.abs(row.deepestCompletedDays - 95) < 1);
  } finally {
    database.close();
  }
});

test('aggregate summary counts match individual wallet classifications', () => {
  const database = setup();
  try {
    const runId = insertFetchRun(database);
    insertTrade(database, 'A', 'buy', now - 95 * DAY, '1');
    insertTrade(database, 'A', 'sell', now, '2');
    insertCoverageEvent(database, 'A', {
      runId,
      requestedPeriodDays: 90,
      truncated: 0,
      stopReason: 'window_covered',
      oldestDaysAgo: 95,
      newestDaysAgo: 0,
    });
    insertTrade(database, 'B', 'buy', now - 40 * DAY, '1');
    insertTrade(database, 'B', 'sell', now, '2');
    insertCoverageEvent(database, 'B', {
      runId,
      requestedPeriodDays: 90,
      truncated: 0,
      stopReason: 'no_more_data',
      oldestDaysAgo: 40,
      newestDaysAgo: 0,
    });

    const inventory = readHistoryDepthCoverage(database, {
      walletAddresses: ['A', 'B', 'C-NEVER-FETCHED'],
      chain: 'sol',
      targetDays: 90,
    });

    assert.equal(inventory.summary.total, 3);
    assert.equal(inventory.summary.byMilestone[30], 2);
    assert.equal(inventory.summary.byMilestone[90], 1);
    assert.equal(inventory.summary.byStatus.reached_target, 1);
    assert.equal(inventory.summary.byStatus.pagination_exhausted, 1);
    assert.equal(inventory.summary.byStatus.not_fetched, 1);
  } finally {
    database.close();
  }
});
