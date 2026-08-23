import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/platform/db/client.js';
import { applyMigrations } from '../src/platform/db/schema.js';
import { importBrowserWalletActivity } from '../src/copytrade/browserActivityImport.js';

const setup = (): DatabaseSync => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  return database;
};

const exportFile = (wallet = 'WALLET_A'): string => JSON.stringify({
  formatVersion: 1,
  source: 'gmgn-browser-extension-investigation',
  endpoints: [{
    url: `https://gmgn.ai/vas/api/v1/wallet_activity/sol?wallet=${wallet}&limit=50`,
    samples: [{
      observedAt: '2026-08-17T02:44:36.897Z',
      pageUrl: `https://gmgn.ai/sol/address/${wallet}`,
      status: 200,
      responsePayload: JSON.stringify({ code: 0, data: { activities: [{
        wallet, chain: 'sol', tx_hash: 'TX-1', event_type: 'sell',
        token: { address: 'TOKEN-1', symbol: 'AAA' }, timestamp: 1786719207,
        token_amount: '10', cost_usd: '12', buy_cost_usd: '10', price_usd: '1.2',
      }] } }),
    }],
  }],
});

test('browser wallet activity importer normalizes trades and preserves provenance in raw payload', () => {
  const database = setup();
  const result = importBrowserWalletActivity(database, 'investigation.json', exportFile());
  assert.equal(result.imported, 1);
  assert.equal(result.duplicates, 0);
  assert.equal(result.activityEndpoints, 1);
  const row = database.prepare('SELECT wallet_address, observed_timestamp, fetched_at, raw_payload FROM copytrade_trades').get() as Record<string, unknown>;
  assert.equal(row.wallet_address, 'WALLET_A');
  assert.equal(row.fetched_at, '2026-08-17T02:44:36.897Z');
  const raw = JSON.parse(String(row.raw_payload)) as Record<string, unknown>;
  assert.equal((raw.__gmgn_browser_provenance as Record<string, unknown>).sourceName, 'investigation.json');
  assert.match(String((raw.__gmgn_browser_provenance as Record<string, unknown>).sourceUrl), /wallet_activity\/sol/);
});

test('browser wallet activity importer is row-idempotent and ignores unrelated endpoints', () => {
  const database = setup();
  const content = JSON.stringify({ ...JSON.parse(exportFile()), endpoints: [
    { url: 'https://gmgn.ai/api/v1/gas_price_list', samples: [] },
    ...(JSON.parse(exportFile()).endpoints),
  ] });
  const first = importBrowserWalletActivity(database, 'investigation.json', content);
  const second = importBrowserWalletActivity(database, 'investigation.json', content);
  assert.equal(first.imported, 1);
  assert.equal(second.imported, 0);
  assert.equal(second.duplicates, 1);
  assert.equal((database.prepare('SELECT COUNT(*) AS count FROM copytrade_trades').get() as { count: number }).count, 1);
});
