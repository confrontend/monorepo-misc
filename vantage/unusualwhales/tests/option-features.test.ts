import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase } from '../src/db/client.js';
import { refreshOptionFeatures } from '../src/research/option-features.js';

test('derives option microstructure features without losing the raw trade', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'unusual-whales-features-'));
  const database = createDatabase(path.join(directory, 'test.sqlite'));
  try {
    const batch = database.prepare(`INSERT INTO uw_import_batches(endpoint,query_json,requested_at,status) VALUES('test','{}','2026-08-21T00:00:00Z','completed')`).run();
    database.prepare(`INSERT INTO uw_option_trades(source_trade_id,source_batch_id,executed_at,captured_at,signal_type,underlying_symbol,expiry,strike,underlying_price,open_interest,price,nbbo_bid,nbbo_ask,size,raw_payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('t1', Number(batch.lastInsertRowid), '2026-08-21T15:00:00Z', '2026-08-21T15:00:00Z', 'call_sweep', 'ABC', '2026-09-20', '105', '100', 100, '3', '2', '4', 20, '{"delta":"0.5","gamma":"0.02","vega":"0.1","implied_volatility":"0.4","all_opening_trades":true}');
    assert.equal(refreshOptionFeatures(database), 1);
    const row = database.prepare('SELECT volume_oi_ratio,spread_pct,moneyness_pct,delta,gamma,vega,is_opening_trade FROM uw_option_features').get() as Record<string, number>;
    assert.equal(row.volume_oi_ratio, 0.2);
    assert.equal(Number(row.spread_pct.toFixed(2)), 66.67);
    assert.equal(Number(row.moneyness_pct.toFixed(2)), 5);
    assert.equal(row.delta, 0.5);
    assert.equal(row.is_opening_trade, 1);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
