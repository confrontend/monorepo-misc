import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { probeOptionTrades, readUnusualWhalesApiKey } from '../src/providers/unusualwhales.js';

test('reads and trims the server-side API key without exposing it in probe output', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uw-provider-'));
  const keyFile = path.join(dir, 'key.txt');
  await writeFile(keyFile, ' test-key\n', 'utf8');
  assert.equal(await readUnusualWhalesApiKey(keyFile), 'test-key');
  const result = await probeOptionTrades({ apiKeyFile: keyFile, apiBaseUrl: 'https://example.test', fetchImpl: async (_input, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-key');
    return new Response(JSON.stringify({ data: [{ id: 'redacted' }] }), { status: 200 });
  }});
  assert.deepEqual(result.ok, true);
  assert.equal(result.recordCount, 1);
  assert.equal(JSON.stringify(result).includes('test-key'), false);
});

test('returns a sanitized HTTP error', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uw-provider-'));
  const keyFile = path.join(dir, 'key.txt');
  await writeFile(keyFile, 'test-key', 'utf8');
  const result = await probeOptionTrades({ apiKeyFile: keyFile, fetchImpl: async () => new Response('nope', { status: 401 }) });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.error, 'Unusual Whales API returned HTTP 401');
});

test('returns a sanitized configuration error when the key is empty', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uw-provider-'));
  const keyFile = path.join(dir, 'key.txt');
  await writeFile(keyFile, '', 'utf8');
  const result = await probeOptionTrades({ apiKeyFile: keyFile });
  assert.deepEqual(result, { ok: false, status: null, durationMs: 0, recordCount: null, error: 'Unusual Whales API key is not configured' });
});
