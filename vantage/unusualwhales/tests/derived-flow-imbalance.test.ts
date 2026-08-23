import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase } from '../src/db/client.js';
import { deriveSweepFlowImbalance } from '../src/providers/derived-flow-imbalance.js';

test('derives deterministic mixed call/put sweep flow imbalance windows', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'uw-flow-imbalance-'));
  const database = createDatabase(path.join(dir, 'test.sqlite'));
  try {
    const batch = database.prepare(`INSERT INTO uw_import_batches (endpoint,query_json,requested_at,status) VALUES ('fixture','{}','2026-01-01T00:00:00Z','completed')`).run();
    const insert = database.prepare(`INSERT INTO uw_option_trades (source_trade_id,source_batch_id,executed_at,captured_at,signal_type,underlying_symbol,option_type,premium,raw_payload) VALUES (?,?,?,?,?,?,?,?,?)`);
    insert.run('call-1', batch.lastInsertRowid, '2026-01-02T10:01:00Z', '2026-01-02T10:01:00Z', 'call_sweep', 'ABC', 'call', '300', '{}');
    insert.run('put-1', batch.lastInsertRowid, '2026-01-02T10:12:00Z', '2026-01-02T10:12:00Z', 'put_sweep', 'ABC', 'put', '100', '{}');
    insert.run('call-only', batch.lastInsertRowid, '2026-01-02T11:01:00Z', '2026-01-02T11:01:00Z', 'call_sweep', 'ABC', 'call', '50', '{}');
    const result = deriveSweepFlowImbalance(database, '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z');
    assert.equal(result.received, 1);
    assert.equal(result.inserted, 1);
    const row = database.prepare(`SELECT signal_type,underlying_symbol,executed_at,premium,raw_payload FROM uw_option_trades WHERE signal_type='flow_imbalance'`).get() as { signal_type: string; underlying_symbol: string; executed_at: string; premium: string; raw_payload: string };
    assert.equal(row.signal_type, 'flow_imbalance');
    assert.equal(row.underlying_symbol, 'ABC');
    assert.equal(Number(row.premium), 0.5);
    assert.equal(JSON.parse(row.raw_payload).tradeCount, 2);
    assert.equal(database.prepare(`SELECT status FROM uw_historical_coverage WHERE signal_type='flow_imbalance' AND trading_date='2026-01-02'`).get()?.status, 'completed');
  } finally {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
