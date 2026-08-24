import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/platform/db/client.js';
import { applyMigrations } from '../src/platform/db/schema.js';
import { readPatternDiscoveryExport, readPreEventFeatures } from '../src/copytrade/discovery/patternDiscovery.js';

const setup = (): DatabaseSync => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  return database;
};

test('pattern discovery export selects by coverage before outcome rows and rejects non-exact wallets', () => {
  const database = setup();
  try {
    database.prepare(
      `INSERT INTO copytrade_wallet_coverage
         (wallet_address, chain, requests_used, truncated, coverage_complete, requested_period_days, stop_reason, updated_at)
       VALUES ('COVERED', 'sol', 2, 0, 1, 30, 'no_more_data', '2026-08-21T00:00:00.000Z'),
              ('TRUNCATED', 'sol', 2, 1, 1, 30, 'request_cap', '2026-08-21T00:01:00.000Z'),
              ('WRONG_PERIOD', 'sol', 2, 0, 1, 7, 'no_more_data', '2026-08-21T00:02:00.000Z')`,
    ).run();
    const result = readPatternDiscoveryExport(database, 30);
    assert.equal(result.metadata.coverage_scope, 'outcome_exact_100_percent');
    assert.equal(result.metadata.shared_engine_database_opened, false);
    assert.equal(result.metadata.selected_wallet_count, 0);
    assert.equal(result.metadata.excluded_wallets_not_exactly_100_percent, 1);
    assert.deepEqual(result.rows, []);
  } finally { database.close(); }
});

test('pattern discovery export validates the requested period and wallet bound', () => {
  const database = setup();
  try {
    assert.throws(() => readPatternDiscoveryExport(database, 0), /periodDays must be an integer/);
    assert.throws(() => readPatternDiscoveryExport(database, 91), /periodDays must be an integer/);
    assert.throws(() => readPatternDiscoveryExport(database, 30, 501), /limit must be an integer/);
  } finally { database.close(); }
});

test('pattern discovery pre-event features exclude the current and later same-second trades', () => {
  const database = setup();
  try {
    const insert = database.prepare(
      `INSERT INTO copytrade_trades
         (id, wallet_address, chain, tx_hash, event_type, token_address, token_symbol, observed_timestamp,
          token_amount, cost_usd, buy_cost_usd, price_usd, gas_usd, dex_usd, launchpad_platform, raw_payload, fetched_at, dedup_key)
       VALUES (?, ?, 'sol', ?, ?, ?, NULL, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, '{}', ?, ?)`
    );
    insert.run(1, 'W1', 'TX1', 'buy', 'TOKEN_A', 1_700_000_000, '25', '2026-08-21T00:00:00.000Z', 'D1');
    insert.run(2, 'W1', 'TX2', 'sell', 'TOKEN_A', 1_700_000_010, '40', '2026-08-21T00:00:00.000Z', 'D2');
    insert.run(3, 'W1', 'TX3', 'buy', 'TOKEN_B', 1_700_000_100, '100', '2026-08-21T00:00:00.000Z', 'D3');
    insert.run(4, 'W1', 'TX4', 'buy', 'TOKEN_A', 1_700_000_200, '999', '2026-08-21T00:00:00.000Z', 'D4');
    database.prepare(`UPDATE copytrade_trades SET buy_cost_usd = '25' WHERE id = 2`).run();

    const features = readPreEventFeatures(database, 'W1', 'TOKEN_A', new Date(1_700_000_200 * 1000).toISOString(), 4);
    assert.equal(features.priorWalletTradeCount, 3);
    assert.equal(features.priorTokenTradeCount, 2);
    assert.equal(features.priorWalletBuyVolumeUsd, 125);
    assert.equal(features.priorWalletBuyCount, 2);
    assert.equal(features.priorWalletSellCount, 1);
    assert.equal(features.priorWalletSellVolumeUsd, 40);
    assert.equal(features.priorWalletRealizedProfitUsd, 15);
    assert.equal(features.priorWalletMedianReturnPercent, 60);
    assert.equal(features.priorWalletWinRatePercent, 100);
    assert.equal(features.priorWalletPositiveDayPercent, 100);
    assert.equal(features.priorWalletBestTokenProfitSharePercent, 100);
    assert.equal(features.priorWalletMedianHoldSeconds, 10);
    assert.equal(features.priorWalletUnder15SecondsPercent, 100);
    assert.equal(features.priorWalletPairedTradeCount, 1);
  } finally { database.close(); }
});
