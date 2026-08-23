import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/client.js';
import { applyMigrations } from '../src/db/schema.js';
import { readFullyCoveredWallets, validateFullyCoveredPeriodDays } from '../src/copytrade/fullyCovered.js';

const setup = (): DatabaseSync => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  return database;
};

const insertCoverage = (database: DatabaseSync, wallet: string, values: { chain?: string; complete?: number; truncated?: number; period?: number; updatedAt?: string }): void => {
  database.prepare(
    `INSERT INTO copytrade_wallet_coverage
       (wallet_address, chain, requests_used, truncated, coverage_complete, requested_period_days, stop_reason, updated_at)
     VALUES (?, ?, 2, ?, ?, ?, 'no_more_data', ?)`,
  ).run(wallet, values.chain ?? 'sol', values.truncated ?? 0, values.complete ?? 1, values.period ?? 30, values.updatedAt ?? '2026-08-21T00:00:00.000Z');
};

const insertTrade = (database: DatabaseSync, wallet: string, id: string): void => {
  database.prepare(
    `INSERT INTO copytrade_trades
       (wallet_address, chain, tx_hash, event_type, token_address, observed_timestamp, raw_payload, fetched_at, dedup_key)
     VALUES (?, 'sol', ?, 'sell', 'TOKEN', 1787260000, '{}', '2026-08-21T00:00:00.000Z', ?)`,
  ).run(wallet, id, `${wallet}:${id}`);
};

test('fully covered reader applies chain, marker, truncation, and requested-period filters', () => {
  const database = setup();
  try {
    insertCoverage(database, 'KEEP', { updatedAt: '2026-08-21T02:00:00.000Z' });
    insertTrade(database, 'KEEP', 'TX-1');
    insertTrade(database, 'KEEP', 'TX-2');
    insertCoverage(database, 'TRUNCATED', { truncated: 1 });
    insertCoverage(database, 'INCOMPLETE', { complete: 0 });
    insertCoverage(database, 'WRONG_PERIOD', { period: 7 });
    insertCoverage(database, 'OTHER_CHAIN', { chain: 'eth' });

    const result = readFullyCoveredWallets(database);
    assert.equal(result.requestedPeriodDays, 30);
    assert.deepEqual(result.rows, [{
      walletAddress: 'KEEP', chain: 'sol', periodDays: 30, stopReason: 'no_more_data',
      updatedAt: '2026-08-21T02:00:00.000Z', storedTradeCount: 2, coverageComplete: true, truncated: false,
    }]);
    assert.equal(result.coverageSemantics.label, '100% verified local history coverage');
    assert.equal(result.coverageSemantics.excludesDuneOutcomeCoverage, true);
  } finally { database.close(); }
});

test('fully covered period validation is loud and bounded', () => {
  assert.equal(validateFullyCoveredPeriodDays(30), 30);
  assert.throws(() => validateFullyCoveredPeriodDays(0), /between 1 and 365/);
  assert.throws(() => validateFullyCoveredPeriodDays(366), /between 1 and 365/);
  assert.throws(() => validateFullyCoveredPeriodDays(30.5), /between 1 and 365/);
});
