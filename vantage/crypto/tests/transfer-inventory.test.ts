import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalizeActivityType,
  TransferAwareInventory,
} from '../src/copytrade/accounting/transferInventory.js';
import { storeActivityPage } from '../src/copytrade/screening/fetch.js';
import { openDatabase } from '../src/platform/db/client.js';
import { applyMigrations } from '../src/platform/db/schema.js';

const row = (eventType: string, tokenAmount: string | null = '100') => ({
  eventType,
  tokenAddress: 'TOKEN',
  observedTimestamp: 1,
  tokenAmount,
  costUsd: eventType === 'sell' ? '120' : null,
  buyCostUsd: eventType === 'sell' ? '100' : null,
});

test('normal buy then sell has proven cost-basis inventory', () => {
  const inventory = new TransferAwareInventory();
  inventory.apply(row('buy'));
  const result = inventory.apply(row('sell'));
  assert.equal(result?.eligible, true);
  assert.equal(result?.reason, 'known_cost_basis');
});

test('TX In then sell is excluded as unknown-cost inventory', () => {
  const inventory = new TransferAwareInventory();
  inventory.apply(row('TX In'));
  const result = inventory.apply(row('sell'));
  assert.equal(result?.eligible, false);
  assert.equal(result?.reason, 'unknown_transfer_inventory');
});

test('buy plus TX In keeps the affected sell unproven', () => {
  const inventory = new TransferAwareInventory();
  inventory.apply(row('buy', '100'));
  inventory.apply(row('transfer_in', '100'));
  const result = inventory.apply(row('sell', '50'));
  assert.equal(result?.eligible, false);
  assert.equal(result?.reason, 'unknown_transfer_inventory');
});

test('partial transfer-in and partial sells remain conservative until transfer inventory clears', () => {
  const inventory = new TransferAwareInventory();
  inventory.apply(row('buy', '100'));
  inventory.apply(row('transfer_in', '50'));
  const first = inventory.apply(row('sell', '25'));
  const second = inventory.apply(row('sell', '25'));
  const third = inventory.apply(row('sell', '25'));
  assert.equal(first?.eligible, false);
  assert.equal(second?.eligible, false);
  assert.equal(third?.eligible, true);
});

test('TX In without a sell contributes no realized trade', () => {
  const inventory = new TransferAwareInventory();
  const result = inventory.apply(row('TX In'));
  assert.equal(result, null);
  assert.equal(canonicalizeActivityType('TX In'), 'transfer_in');
});

test('GMGN TX In is stored canonically while its provider spelling stays in raw payload', () => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  try {
    const result = storeActivityPage(
      database,
      [
        {
          wallet: 'WALLET',
          tx_hash: 'TX_IN_1',
          event_type: 'transferIn',
          token: { address: 'TOKEN', symbol: 'TKN' },
          timestamp: 1,
          token_amount: '10',
        },
      ],
      { chain: 'sol', fetchedAt: '2026-09-06T00:00:00.000Z' },
    );
    assert.equal(result.inserted, 1);
    const saved = database
      .prepare('SELECT event_type AS eventType, raw_payload AS rawPayload FROM copytrade_trades')
      .get() as { eventType: string; rawPayload: string };
    assert.equal(saved.eventType, 'transfer_in');
    assert.equal(JSON.parse(saved.rawPayload).event_type, 'transferIn');
  } finally {
    database.close();
  }
});
