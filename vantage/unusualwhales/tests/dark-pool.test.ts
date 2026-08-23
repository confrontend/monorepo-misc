import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fetchRecentDarkPool, normalizeDarkPoolRecords } from '../src/providers/dark-pool.js';

test('normalizes, preserves, and deduplicates dark-pool records', () => {
  const result = normalizeDarkPoolRecords({ data: [
    { id: 'dp-1', executed_at: '2026-08-18T17:00:00Z', ticker: 'AAPL', price: '200.25', size: '1,000', premium: '200250', canceled: false, side: 'buy' },
    { id: 'dp-1', executed_at: '2026-08-18T17:00:00Z', ticker: 'AAPL', price: '200.25', size: '1000', canceled: false },
  ] });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    sourceId: 'dp-1', executedAt: '2026-08-18T17:00:00.000Z', ticker: 'AAPL', price: '200.25', size: 1000,
    premium: '200250', canceled: false, rawPayload: JSON.stringify({ id: 'dp-1', executed_at: '2026-08-18T17:00:00Z', ticker: 'AAPL', price: '200.25', size: '1,000', premium: '200250', canceled: false, side: 'buy' }), validationErrors: [],
  });
});

test('accepts documented field aliases and records validation errors', () => {
  const result = normalizeDarkPoolRecords({ data: [
    { trade_id: 'dp-2', timestamp: '2026-08-18T18:01:02-04:00', symbol: 'MSFT', execution_price: 400, shares: 250, trade_value: 100000, cancelled: 'true' },
    { id: 'bad', date: 'not-a-date', symbol: '', price: 'nope', size: null },
  ] });
  assert.equal(result[0].executedAt, '2026-08-18T22:01:02.000Z');
  assert.equal(result[0].canceled, true);
  assert.deepEqual(result[1].validationErrors, ['invalid executed_at', 'missing ticker', 'invalid price', 'missing size']);
});

test('fails explicitly for an unsupported response shape and does not leak secrets on HTTP errors', async () => {
  assert.throws(() => normalizeDarkPoolRecords({ results: [] }), /does not contain a data array/);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uw-dark-pool-'));
  const keyFile = path.join(directory, 'key.txt');
  await writeFile(keyFile, 'secret-test-key', 'utf8');
  try {
    await assert.rejects(
      fetchRecentDarkPool({ apiKeyFile: keyFile, fetchImpl: async () => new Response('no', { status: 503 }) }),
      (error: Error) => error.message === 'Unusual Whales dark-pool API returned HTTP 503' && !error.message.includes('secret-test-key'),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
