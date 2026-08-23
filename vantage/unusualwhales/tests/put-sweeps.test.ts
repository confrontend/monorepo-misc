import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase } from '../src/db/client.js';
import { syncRecentPutSweeps } from '../src/providers/put-sweeps.js';

const fixture = {
  data: [{
    id: 'put-trade-1',
    executed_at: '2026-08-18T17:00:00.123Z',
    underlying_symbol: 'AAPL',
    option_chain_id: 'AAPL260918P00200000',
    option_type: 'put',
    expiry: '2026-09-18',
    strike: '200',
    premium: '350000',
    price: '2.50',
    size: 1400,
    underlying_price: '199.25',
    open_interest: 900,
    volume: 1500,
    report_flags: ['intermarket_sweep'],
    tags: ['bid_side'],
    canceled: false,
  }],
};

test('syncs put sweeps with provider filters and preserves normalization', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uw-put-sweep-'));
  const keyFile = path.join(directory, 'key.txt');
  await writeFile(keyFile, 'put-test-key', 'utf8');
  const database = createDatabase(path.join(directory, 'test.sqlite'));
  let requestUrl: URL | null = null;
  let requestAuth: string | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    requestUrl = new URL(String(input));
    requestAuth = (init?.headers as Record<string, string>).Authorization;
    return new Response(JSON.stringify(fixture), { status: 200 });
  };

  try {
    const summary = await syncRecentPutSweeps(database, {
      apiKeyFile: keyFile,
      fetchImpl,
      limit: 17,
      apiBaseUrl: 'https://fixture.invalid',
      now: () => new Date('2026-08-18T18:00:00Z'),
    });
    assert.equal(summary.inserted, 1);
    assert.equal(summary.duplicates, 0);
    assert.ok(requestUrl);
    const capturedUrl = requestUrl as URL;
    assert.equal(capturedUrl.pathname, '/api/option-trades');
    assert.equal(capturedUrl.searchParams.get('type'), 'put');
    assert.equal(capturedUrl.searchParams.get('report_flag[]'), 'intermarket_sweep');
    assert.equal(capturedUrl.searchParams.get('canceled'), 'false');
    assert.equal(capturedUrl.searchParams.get('force_15_min_delay'), 'true');
    assert.equal(capturedUrl.searchParams.get('limit'), '17');
    assert.equal(requestAuth, 'Bearer put-test-key');

    const stored = database.prepare(`
      SELECT source_trade_id, signal_type, option_type, underlying_symbol, raw_payload, validation_errors
      FROM uw_option_trades
    `).get() as Record<string, string>;
    assert.equal(stored.source_trade_id, 'put-trade-1');
    assert.equal(stored.signal_type, 'put_sweep');
    assert.equal(stored.option_type, 'put');
    assert.equal(stored.underlying_symbol, 'AAPL');
    assert.equal(JSON.parse(stored.raw_payload).premium, '350000');
    assert.deepEqual(JSON.parse(stored.validation_errors), []);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('put sweep sync is idempotent by provider source ID', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uw-put-sweep-'));
  const keyFile = path.join(directory, 'key.txt');
  await writeFile(keyFile, 'put-test-key', 'utf8');
  const database = createDatabase(path.join(directory, 'test.sqlite'));
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify(fixture), { status: 200 });
  try {
    const first = await syncRecentPutSweeps(database, { apiKeyFile: keyFile, fetchImpl });
    const second = await syncRecentPutSweeps(database, { apiKeyFile: keyFile, fetchImpl });
    assert.deepEqual({ inserted: first.inserted, duplicates: first.duplicates }, { inserted: 1, duplicates: 0 });
    assert.deepEqual({ inserted: second.inserted, duplicates: second.duplicates }, { inserted: 0, duplicates: 1 });
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM uw_option_trades WHERE signal_type = 'put_sweep'").get() as { count: number }).count, 1);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('canceled put records are retained and marked, while canceled events are requested out', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uw-put-sweep-'));
  const keyFile = path.join(directory, 'key.txt');
  await writeFile(keyFile, 'put-test-key', 'utf8');
  const database = createDatabase(path.join(directory, 'test.sqlite'));
  const canceled = { data: [{ ...fixture.data[0], id: 'put-canceled', canceled: true }] };
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify(canceled), { status: 200 });
  try {
    await syncRecentPutSweeps(database, { apiKeyFile: keyFile, fetchImpl });
    const stored = database.prepare("SELECT canceled FROM uw_option_trades WHERE source_trade_id = 'put-canceled'").get() as { canceled: number };
    assert.equal(stored.canceled, 1);
    const batch = database.prepare('SELECT query_json FROM uw_import_batches ORDER BY id DESC LIMIT 1').get() as { query_json: string };
    assert.equal(JSON.parse(batch.query_json).canceled, false);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing API key fails without exposing its contents', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uw-put-sweep-'));
  const keyFile = path.join(directory, 'key.txt');
  await writeFile(keyFile, '', 'utf8');
  const database = createDatabase(path.join(directory, 'test.sqlite'));
  try {
    await assert.rejects(
      syncRecentPutSweeps(database, { apiKeyFile: keyFile }),
      (error: Error) => !error.message.includes('put-test-key') && error.message.includes('API key'),
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
