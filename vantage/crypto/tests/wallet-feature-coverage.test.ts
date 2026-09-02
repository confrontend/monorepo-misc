import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { readWalletFeatureCoverageInventory } from '../src/copytrade/features/walletFeatureCoverage.js';
import { openDatabase } from '../src/platform/db/client.js';
import { applyMigrations } from '../src/platform/db/schema.js';

const setup = (): DatabaseSync => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  return database;
};

const insertTrade = (
  database: DatabaseSync,
  walletAddress: string,
  eventType: string,
  observedTimestamp: number,
  suffix: string,
  chain = 'sol',
): void => {
  database
    .prepare(
      `INSERT INTO copytrade_trades
       (wallet_address, chain, tx_hash, event_type, token_address, observed_timestamp,
        raw_payload, fetched_at, dedup_key)
       VALUES (?, ?, ?, ?, 'TOKEN', ?, '{}', '2026-08-29T12:00:00.000Z', ?)`,
    )
    .run(
      walletAddress,
      chain,
      `TX-${suffix}`,
      eventType,
      observedTimestamp,
      `${walletAddress}:${suffix}`,
    );
};

const insertCoverage = (
  database: DatabaseSync,
  walletAddress: string,
  values: {
    periodDays: number;
    complete: number;
    truncated: number;
    stopReason: string;
    requestsUsed?: number;
  },
): void => {
  database
    .prepare(
      `INSERT INTO copytrade_wallet_coverage
       (wallet_address, chain, requests_used, truncated, coverage_complete,
        requested_period_days, stop_reason, updated_at)
       VALUES (?, 'sol', ?, ?, ?, ?, ?, '2026-08-29T11:00:00.000Z')`,
    )
    .run(
      walletAddress,
      values.requestsUsed ?? 4,
      values.truncated,
      values.complete,
      values.periodDays,
      values.stopReason,
    );
};

test('reports a complete requested window from an explicit non-truncated coverage marker', () => {
  const database = setup();
  try {
    insertTrade(database, 'COMPLETE', 'buy', 1_000, '1');
    insertTrade(database, 'COMPLETE', 'BUY', 2_000, '2');
    insertTrade(database, 'COMPLETE', 'sell', 87_400, '3');
    insertTrade(database, 'COMPLETE', 'transfer', 90_000, '4');
    insertTrade(database, 'COMPLETE', 'sell', 95_000, 'other-chain', 'eth');
    insertCoverage(database, 'COMPLETE', {
      periodDays: 90,
      complete: 1,
      truncated: 0,
      stopReason: 'window_covered',
      requestsUsed: 7,
    });
    database
      .prepare(
        `INSERT INTO copytrade_wallet_stats
         (wallet_address, chain, period, fetched_at, raw_payload)
         VALUES ('COMPLETE', 'sol', '7d', '2026-08-28T00:00:00.000Z', '{}'),
                ('COMPLETE', 'sol', '30d', '2026-08-29T00:00:00.000Z', '{}')`,
      )
      .run();

    const inventory = readWalletFeatureCoverageInventory(database, {
      walletAddresses: [' COMPLETE ', 'COMPLETE'],
      chain: 'SOL',
      periodDays: 30,
    });

    assert.equal(inventory.rows.length, 1);
    assert.equal(inventory.availabilitySemantics.oldestRowProvesContinuousCoverage, false);
    assert.deepEqual(inventory.rows[0], {
      walletAddress: 'COMPLETE',
      chain: 'sol',
      requestedPeriodDays: 30,
      rawActivityCount: 4,
      buyCount: 2,
      sellCount: 1,
      oldestActivityAt: '1970-01-01T00:16:40.000Z',
      newestActivityAt: '1970-01-02T01:00:00.000Z',
      availableSpanDays: 89_000 / 86_400,
      assessment: 'complete_requested_window',
      coverageComplete: true,
      coverageRequestedPeriodDays: 90,
      truncated: false,
      stopReason: 'window_covered',
      requestsUsed: 7,
      coverageUpdatedAt: '2026-08-29T11:00:00.000Z',
      officialStatsPeriod: '30d',
      officialStatsFetchedAt: '2026-08-29T00:00:00.000Z',
    });
  } finally {
    database.close();
  }
});

test('reports a truncated wallet as incomplete even when rows span the requested period', () => {
  const database = setup();
  try {
    insertTrade(database, 'TRUNCATED', 'buy', 1_000, '1');
    insertTrade(database, 'TRUNCATED', 'sell', 1_000 + 40 * 86_400, '2');
    insertCoverage(database, 'TRUNCATED', {
      periodDays: 30,
      complete: 1,
      truncated: 1,
      stopReason: 'request_cap',
    });

    const [row] = readWalletFeatureCoverageInventory(database, {
      walletAddresses: ['TRUNCATED'],
      chain: 'sol',
      periodDays: 30,
    }).rows;

    assert.equal(row.availableSpanDays, 40);
    assert.equal(row.assessment, 'incomplete');
    assert.equal(row.coverageComplete, true);
    assert.equal(row.truncated, true);
    assert.equal(row.stopReason, 'request_cap');
  } finally {
    database.close();
  }
});

test('reports a missing wallet with zero activity and unknown coverage', () => {
  const database = setup();
  try {
    const [row] = readWalletFeatureCoverageInventory(database, {
      walletAddresses: ['MISSING'],
      chain: 'sol',
      periodDays: 30,
    }).rows;

    assert.equal(row.rawActivityCount, 0);
    assert.equal(row.buyCount, 0);
    assert.equal(row.sellCount, 0);
    assert.equal(row.oldestActivityAt, null);
    assert.equal(row.newestActivityAt, null);
    assert.equal(row.availableSpanDays, null);
    assert.equal(row.assessment, 'unknown');
    assert.equal(row.coverageComplete, null);
    assert.equal(row.truncated, null);
    assert.equal(row.officialStatsPeriod, null);
  } finally {
    database.close();
  }
});

test('keeps variable activity depth distinct from explicit fetch completeness', () => {
  const database = setup();
  try {
    insertTrade(database, 'DEEP-INCOMPLETE', 'buy', 1_000, 'deep-1');
    insertTrade(database, 'DEEP-INCOMPLETE', 'sell', 1_000 + 75 * 86_400, 'deep-2');
    insertCoverage(database, 'DEEP-INCOMPLETE', {
      periodDays: 7,
      complete: 1,
      truncated: 0,
      stopReason: 'window_covered',
    });

    insertTrade(database, 'SHALLOW-COMPLETE', 'buy', 2_000, 'shallow-1');
    insertTrade(database, 'SHALLOW-COMPLETE', 'sell', 2_000 + 2 * 86_400, 'shallow-2');
    insertCoverage(database, 'SHALLOW-COMPLETE', {
      periodDays: 30,
      complete: 1,
      truncated: 0,
      stopReason: 'no_more_data',
    });

    const rows = readWalletFeatureCoverageInventory(database, {
      walletAddresses: ['DEEP-INCOMPLETE', 'SHALLOW-COMPLETE'],
      chain: 'sol',
      periodDays: 30,
    }).rows;

    assert.equal(rows[0].availableSpanDays, 75);
    assert.equal(rows[0].assessment, 'incomplete');
    assert.equal(rows[1].availableSpanDays, 2);
    assert.equal(rows[1].assessment, 'complete_requested_window');
  } finally {
    database.close();
  }
});

test('validates requested period and chain before reading', () => {
  const database = setup();
  try {
    assert.throws(
      () =>
        readWalletFeatureCoverageInventory(database, {
          walletAddresses: [],
          chain: 'sol',
          periodDays: 0,
        }),
      /between 1 and 365/,
    );
    assert.throws(
      () =>
        readWalletFeatureCoverageInventory(database, {
          walletAddresses: [],
          chain: ' ',
          periodDays: 30,
        }),
      /chain must not be empty/,
    );
  } finally {
    database.close();
  }
});
