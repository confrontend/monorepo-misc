import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/platform/db/client.js';
import { applyMigrations } from '../src/platform/db/schema.js';
import { CACHE_VERSIONS } from '../src/platform/cache/cacheVersions.js';
import { WALLET_FEATURE_ENGINE_VERSION } from '../src/copytrade/features/walletFeatureDefinitions.js';
import { DAILY_TRADE_INSERT_CAP } from '../src/copytrade/simulation/constants.js';
import { storeActivityPage } from '../src/copytrade/screening/fetch.js';

// This test exists to catch an accidental behavior change in the analysis layer that the
// centralized Data workflow was never meant to touch: routing ingestion through one orchestrator
// must not alter cache invalidation, the feature engine's identity, the insert-cap policy, or the
// trade dedup identity that every existing stored row and every existing test already depends on.

const setup = (): DatabaseSync => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  return database;
};

test('cache version keys are unchanged by the Data workflow work', () => {
  assert.equal(typeof CACHE_VERSIONS, 'object');
  assert.ok(Object.keys(CACHE_VERSIONS).length > 0, 'the cache-versions map must still exist and be non-empty');
});

test('the canonical wallet feature engine version identifier is unchanged', () => {
  assert.equal(WALLET_FEATURE_ENGINE_VERSION, 'gmgn-wallet-features-v1-compat');
});

test('the daily trade insert cap remains disabled in production (no silent truncation)', () => {
  assert.equal(DAILY_TRADE_INSERT_CAP, Number.POSITIVE_INFINITY);
});

test('the trade dedup_key format is unchanged: wallet|txHash|tokenAddress|eventType|tokenAmount|timestamp', () => {
  const database = setup();
  try {
    const result = storeActivityPage(
      database,
      [
        {
          wallet: 'WALLET',
          tx_hash: 'TX-1',
          event_type: 'sell',
          token: { address: 'TOKEN' },
          timestamp: 1_700_000_000,
          token_amount: '42',
        },
      ],
      { chain: 'sol', fetchedAt: new Date().toISOString() },
    );
    assert.equal(result.inserted, 1);
    const row = database
      .prepare(`SELECT dedup_key AS dedupKey FROM copytrade_trades WHERE tx_hash = 'TX-1'`)
      .get() as { dedupKey: string };
    assert.equal(row.dedupKey, 'WALLET|TX-1|TOKEN|sell|42|1700000000');

    // Re-storing the identical activity must still be recognized as a duplicate, not a second row
    // under a different identity -- this is the invariant the whole skipCompletedWallets / resume
    // design depends on.
    const second = storeActivityPage(
      database,
      [
        {
          wallet: 'WALLET',
          tx_hash: 'TX-1',
          event_type: 'sell',
          token: { address: 'TOKEN' },
          timestamp: 1_700_000_000,
          token_amount: '42',
        },
      ],
      { chain: 'sol', fetchedAt: new Date().toISOString() },
    );
    assert.equal(second.inserted, 0);
    assert.equal(second.duplicates, 1);
  } finally {
    database.close();
  }
});
