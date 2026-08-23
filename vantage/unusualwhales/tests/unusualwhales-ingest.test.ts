import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase } from '../src/db/client.js';
import { readSignalDataSummary, syncRecentCallSweeps } from '../src/providers/unusualwhales-ingest.js';

test('syncs call sweeps idempotently and preserves the raw source record', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uw-ingest-'));
  const keyFile = path.join(directory, 'key.txt');
  await writeFile(keyFile, 'test-key', 'utf8');
  const database = createDatabase(path.join(directory, 'test.sqlite'));
  const providerPayload = {
    data: [{
      id: 'trade-1',
      executed_at: '2026-08-18T17:00:00.123Z',
      underlying_symbol: 'AAPL',
      option_chain_id: 'AAPL260918C00200000',
      option_type: 'call',
      expiry: '2026-09-18',
      strike: '200',
      premium: '350000',
      price: '2.50',
      size: 1400,
      underlying_price: '199.25',
      open_interest: 900,
      volume: 1500,
      report_flags: ['intermarket_sweep'],
      tags: ['ask_side'],
      canceled: false,
    }],
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('type'), 'call');
    assert.equal(url.searchParams.get('report_flag[]'), 'intermarket_sweep');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-key');
    return new Response(JSON.stringify(providerPayload), { status: 200 });
  };

  try {
    const first = await syncRecentCallSweeps(database, { apiKeyFile: keyFile, fetchImpl, now: () => new Date('2026-08-18T18:00:00Z') });
    const second = await syncRecentCallSweeps(database, { apiKeyFile: keyFile, fetchImpl, now: () => new Date('2026-08-18T18:01:00Z') });
    assert.deepEqual({ inserted: first.inserted, duplicates: first.duplicates }, { inserted: 1, duplicates: 0 });
    assert.deepEqual({ inserted: second.inserted, duplicates: second.duplicates }, { inserted: 0, duplicates: 1 });

    const summary = readSignalDataSummary(database);
    assert.equal(summary.callSweepEvents, 1);
    assert.equal(summary.distinctTickers, 1);
    const stored = database.prepare('SELECT source_trade_id, raw_payload, validation_errors FROM uw_option_trades').get() as { source_trade_id: string; raw_payload: string; validation_errors: string };
    assert.equal(stored.source_trade_id, 'trade-1');
    assert.equal(JSON.parse(stored.raw_payload).premium, '350000');
    assert.deepEqual(JSON.parse(stored.validation_errors), []);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
