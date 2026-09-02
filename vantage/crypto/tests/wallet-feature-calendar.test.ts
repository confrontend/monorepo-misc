import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import {
  generateWalletFeatureCalendarSnapshots,
  readWalletFeatureSourceRevisionsAtCutoff,
} from '../src/copytrade/features/walletFeatureCalendar.js';
import { WALLET_FEATURE_ENGINE_VERSION } from '../src/copytrade/features/walletFeatureDefinitions.js';
import { openDatabase } from '../src/platform/db/client.js';

const insertTrade = (
  database: DatabaseSync,
  input: {
    id: number;
    walletAddress: string;
    observedTimestamp: number;
    eventType: 'buy' | 'sell';
    tokenAddress?: string;
    costUsd?: number;
    buyCostUsd?: number;
  },
): void => {
  database
    .prepare(
      `INSERT INTO copytrade_trades
       (id, wallet_address, chain, tx_hash, event_type, token_address,
        observed_timestamp, cost_usd, buy_cost_usd, raw_payload, fetched_at, dedup_key)
       VALUES (?, ?, 'sol', ?, ?, ?, ?, ?, ?, '{}', '2026-08-01T00:00:00.000Z', ?)`,
    )
    .run(
      input.id,
      input.walletAddress,
      `tx-${input.id}`,
      input.eventType,
      input.tokenAddress ?? 'token-a',
      input.observedTimestamp,
      input.costUsd === undefined ? null : String(input.costUsd),
      input.buyCostUsd === undefined ? null : String(input.buyCostUsd),
      `calendar-${input.id}`,
    );
};

test('calendar generation excludes post-cutoff rows from features and source revision', () => {
  const database = openDatabase(':memory:');
  try {
    const cutoffSeconds = Math.floor(Date.parse('2026-08-01T00:00:00.000Z') / 1_000);
    insertTrade(database, {
      id: 10,
      walletAddress: 'wallet-a',
      observedTimestamp: cutoffSeconds - 60,
      eventType: 'buy',
      costUsd: 100,
    });
    insertTrade(database, {
      id: 11,
      walletAddress: 'wallet-a',
      observedTimestamp: cutoffSeconds - 30,
      eventType: 'sell',
      costUsd: 130,
      buyCostUsd: 100,
    });
    insertTrade(database, {
      id: 999,
      walletAddress: 'wallet-a',
      observedTimestamp: cutoffSeconds,
      eventType: 'sell',
      costUsd: 999,
      buyCostUsd: 1,
    });

    const revision = readWalletFeatureSourceRevisionsAtCutoff(
      database,
      ['wallet-a'],
      'sol',
      cutoffSeconds,
    );
    assert.equal(revision.get('wallet-a'), 11);

    const [result] = generateWalletFeatureCalendarSnapshots(database, {
      walletAddresses: ['wallet-a'],
      asOfTimestamp: '2026-08-01T00:00:00.999Z',
      lookbackDays: 30,
      chain: 'sol',
      triggerKind: 'calendar',
      createdAt: '2026-08-01T00:01:00.000Z',
    });
    assert.equal(result.inserted, true);
    assert.equal(result.snapshot.asOfTimestamp, '2026-08-01T00:00:00.000Z');
    assert.equal(result.snapshot.sourceDataRevision, 11);
    assert.equal(result.snapshot.featureEngineVersion, WALLET_FEATURE_ENGINE_VERSION);
    assert.equal(result.snapshot.features.prior_wallet_trade_count, 2);
    assert.equal(result.snapshot.features.prior_wallet_realized_profit_usd, 30);
    assert.equal(result.snapshot.quality.rowsExamined, 2);
    assert.equal(result.snapshot.quality.newestObservedAt, '2026-07-31T23:59:30.000Z');
  } finally {
    database.close();
  }
});

test('calendar generation is idempotent and creates a new revision only for a pre-cutoff backfill', () => {
  const database = openDatabase(':memory:');
  try {
    const cutoff = '2026-08-01T00:00:00.000Z';
    const cutoffSeconds = Math.floor(Date.parse(cutoff) / 1_000);
    insertTrade(database, {
      id: 1,
      walletAddress: 'wallet-a',
      observedTimestamp: cutoffSeconds - 10,
      eventType: 'buy',
      costUsd: 10,
    });
    const request = {
      walletAddresses: ['wallet-a'],
      asOfTimestamp: cutoff,
      lookbackDays: null,
      chain: 'sol',
      triggerKind: 'current' as const,
      createdAt: '2026-08-01T00:01:00.000Z',
    };

    const [first] = generateWalletFeatureCalendarSnapshots(database, request);
    const [retry] = generateWalletFeatureCalendarSnapshots(database, request);
    assert.equal(first.inserted, true);
    assert.equal(retry.inserted, false);
    assert.equal(retry.snapshot.id, first.snapshot.id);

    insertTrade(database, {
      id: 2,
      walletAddress: 'wallet-a',
      observedTimestamp: cutoffSeconds - 5,
      eventType: 'sell',
      costUsd: 15,
      buyCostUsd: 10,
    });
    const [backfilled] = generateWalletFeatureCalendarSnapshots(database, request);
    assert.equal(backfilled.inserted, true);
    assert.notEqual(backfilled.snapshot.id, first.snapshot.id);
    assert.equal(backfilled.snapshot.sourceDataRevision, 2);
    assert.equal(backfilled.snapshot.features.prior_wallet_trade_count, 2);

    const count = database
      .prepare(`SELECT COUNT(*) AS count FROM copytrade_wallet_feature_snapshots`)
      .get() as { count: number };
    assert.equal(count.count, 2);
  } finally {
    database.close();
  }
});

test('batch generation persists explicit wallets with no eligible evidence', () => {
  const database = openDatabase(':memory:');
  try {
    const results = generateWalletFeatureCalendarSnapshots(database, {
      walletAddresses: ['wallet-empty-b', 'wallet-empty-a', 'wallet-empty-b', '  '],
      asOfTimestamp: '2026-08-01T00:00:00.000Z',
      lookbackDays: 30,
      chain: 'sol',
      triggerKind: 'calendar',
    });
    assert.equal(results.length, 2);
    assert.deepEqual(
      results.map((result) => result.snapshot.walletAddress),
      ['wallet-empty-b', 'wallet-empty-a'],
    );
    assert.equal(results[0].snapshot.sourceDataRevision, 0);
    assert.equal(results[0].snapshot.features.prior_wallet_trade_count, 0);
    assert.deepEqual(results[0].snapshot.quality, {
      rowsExamined: 0,
      contextRowsExamined: 0,
      sellRowsExamined: 0,
      returnRowsIncluded: 0,
      rowsExcludedNoCostBasis: 0,
      holdsPaired: 0,
      sellsWithoutPriorBuyContext: 0,
      oldestObservedAt: null,
      newestObservedAt: null,
      requestedWindowStart: '2026-07-02T00:00:00.000Z',
      requestedWindowEnd: '2026-08-01T00:00:00.000Z',
    });
  } finally {
    database.close();
  }
});
