import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/db/client.js';
import { importGmgnBrowserCapture } from '../src/gmgn/browserImport.js';

const exportJson = (events: unknown[], coverageWindows: unknown[] = []) => JSON.stringify({
  formatVersion: 1,
  exportedAt: '2026-03-01T12:00:00.000Z',
  extensionVersion: '0.1.0',
  source: 'gmgn-browser-extension',
  coverageWindows,
  captures: [{ capturedAt: '2026-03-01T12:00:00.250Z', requestPath: '/v1/market/token_signal', status: 200, responseBody: { data: events } }],
});

const event = (id: string, token = 'TokenBrowser') => ({ id, data: { chain: 'sol' }, token_address: token, signal_type: 14, trigger_at: 1_772_359_200, market_cap: 1234, triggering_wallet: 'WalletBrowser', raw_wallet_labels: ['smart-money'], source_url: 'https://gmgn.example/signal' });

test('browser import stores source-tagged events, preserves raw source, and archives the upload', () => {
  const database = openDatabase(':memory:');
  try {
    const raw = exportJson([event('browser-1')], [
      { startedAt: '2026-03-01T11:00:00.000Z', endedAt: '2026-03-01T11:30:00.000Z', lastHeartbeatAt: '2026-03-01T11:30:00.000Z', closedReason: null },
    ]);
    const result = importGmgnBrowserCapture(database, 'signals.json', raw, new Date('2026-03-01T12:01:00Z'));
    assert.equal(result.imported, 1);
    assert.equal(result.skipped, 0);
    assert.equal(result.errors, 0);
    assert.equal(result.coverageWindowsImported, 1);
    assert.equal(result.duplicateFile, false);
    assert.ok(result.archivePath);
    const window = database.prepare('SELECT started_at AS startedAt, ended_at AS endedAt, closed_reason AS closedReason FROM gmgn_browser_coverage_windows').get() as Record<string, string | null>;
    assert.equal(window.startedAt, '2026-03-01T11:00:00.000Z');
    assert.equal(window.endedAt, '2026-03-01T11:30:00.000Z');
    assert.equal(window.closedReason, null);
    const row = database.prepare('SELECT source, chain, source_event_id, raw_payload, captured_at FROM gmgn_signals').get() as Record<string, string>;
    assert.equal(row.source, 'gmgn-browser-extension');
    assert.equal(row.chain, 'sol');
    assert.equal(row.source_event_id, 'browser-1');
    assert.deepEqual(JSON.parse(row.raw_payload), event('browser-1'));
    assert.equal(row.captured_at, '2026-03-01T12:00:00.250Z');
    const batch = database.prepare('SELECT status, raw_source, archive_path FROM gmgn_browser_import_batches').get() as Record<string, string>;
    assert.equal(batch.status, 'completed');
    assert.equal(batch.raw_source, raw);
    assert.equal(batch.archive_path, result.archivePath);
  } finally { database.close(); }
});

test('browser import is idempotent by file hash and event identity', () => {
  const database = openDatabase(':memory:');
  try {
    const raw = exportJson([event('browser-2')]);
    const first = importGmgnBrowserCapture(database, 'signals.json', raw);
    const sameFile = importGmgnBrowserCapture(database, 'renamed.json', raw);
    assert.equal(sameFile.duplicateFile, true);
    assert.equal(sameFile.batchId, first.batchId);
    assert.equal(sameFile.coverageWindowsImported, first.coverageWindowsImported);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM gmgn_signals').get() as { count: number }).count, 1);
    const overlap = importGmgnBrowserCapture(database, 'signals-2.json', exportJson([event('browser-2'), event('browser-3')]));
    assert.equal(overlap.imported, 1);
    assert.equal(overlap.skipped, 1);
  } finally { database.close(); }
});

test('browser import drops malformed coverage window entries instead of failing the whole upload', () => {
  const database = openDatabase(':memory:');
  try {
    const raw = exportJson([event('browser-4')], [
      { startedAt: '2026-03-01T11:00:00.000Z', lastHeartbeatAt: '2026-03-01T11:05:00.000Z' },
      { endedAt: '2026-03-01T11:10:00.000Z' },
      'not-an-object',
    ]);
    const result = importGmgnBrowserCapture(database, 'signals.json', raw);
    assert.equal(result.imported, 1);
    assert.equal(result.coverageWindowsImported, 1);
  } finally { database.close(); }
});

test('browser import rejects malformed exports and records a failed batch', () => {
  const database = openDatabase(':memory:');
  try {
    assert.throws(() => importGmgnBrowserCapture(database, 'bad.json', JSON.stringify({ formatVersion: 1, source: 'wrong', captures: [] })), /source gmgn-browser-extension/);
    const batch = database.prepare('SELECT status, error_count, error FROM gmgn_browser_import_batches').get() as { status: string; error_count: number; error: string };
    assert.equal(batch.status, 'failed');
    assert.equal(batch.error_count, 1);
    assert.match(batch.error, /source gmgn-browser-extension/);
  } finally { database.close(); }
});
