import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { createDatabase } from '../src/db/client.js';
import { backfillHistoricalSignals, parseDateRange } from '../src/providers/historical-backfill.js';

/**
 * Builds a real full-tape response body: a single-entry ZIP with a DEFLATE-compressed CSV,
 * matching the shape confirmed live against GET /api/option-trades/full-tape/{date}
 * (2026-08-18: content-type application/zip, not JSON). Earlier fixtures here mocked a
 * `{data: [...]}` JSON envelope, which let the tests pass while the real endpoint -- which
 * returns a ~1-1.5 GB ZIP per day -- made backfillHistoricalSignals fail every time it ran
 * against the live API (`response.json()` on a ZIP body, then a 120s timeout on a
 * multi-hundred-MB download). These fixtures exercise the real ZIP+CSV decode path instead.
 */
const buildFullTapeZip = (csvText: string, fileName = '2026-01-02-option_trades.csv'): Buffer => {
  const nameBuf = Buffer.from(fileName, 'utf8');
  const compressed = zlib.deflateRawSync(Buffer.from(csvText, 'utf8'));
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(csvText.length, 22);
  header.writeUInt16LE(nameBuf.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBuf, compressed]);
};

const FULL_TAPE_COLUMNS = ['id', 'executed_at', 'underlying_symbol', 'option_type', 'report_flags'];
const csv = (rows: string[][]) => [FULL_TAPE_COLUMNS.join(','), ...rows.map((row) => row.join(','))].join('\n') + '\n';
const zipResponse = (csvText: string) => {
  const body = buildFullTapeZip(csvText);
  return new Response(body, { status: 200, headers: { 'content-type': 'application/zip', 'content-length': String(body.length) } });
};
const sweepRow = (id: string, executedAt: string, type = 'call') => [id, executedAt, 'AAPL', type, '{intermarket_sweep}'];

test('historical backfill validates date bounds and request size', () => {
  assert.throws(() => parseDateRange('2026-02-01', '2026-01-01'), /earlier/);
  assert.throws(() => parseDateRange('not-a-date', '2026-01-01'), /valid ISO/);
  assert.throws(() => parseDateRange('2024-01-01', '2026-01-01'), /limited/);
});

test('historical backfill requests one documented full-tape file per day and deduplicates', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uw-backfill-'));
  const keyFile = path.join(directory, 'key.txt'); await writeFile(keyFile, 'fixture-key', 'utf8');
  const database = createDatabase(path.join(directory, 'test.sqlite'));
  const urls: URL[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    const isDay2 = url.pathname.endsWith('2026-01-02');
    return zipResponse(csv(isDay2
      ? [sweepRow('a', '2026-01-02 10:00:00+00'), sweepRow('outside', '2025-12-31 10:00:00+00')]
      : [sweepRow('a', '2026-01-02 10:00:00+00'), sweepRow('b', '2026-01-01 10:00:00+00')]));
  };
  try {
    const result = await backfillHistoricalSignals(database, { from: '2026-01-01', to: '2026-01-03', signalTypes: ['call_sweep'], apiKeyFile: keyFile, apiBaseUrl: 'https://fixture.invalid', fetchImpl, now: () => new Date('2026-01-10T00:00:00Z') });
    assert.equal(result.pages, 2); assert.equal(result.received, 4); assert.equal(result.inserted, 2); assert.ok(result.duplicates >= 1); assert.ok(result.excludedOutsideRange >= 1);
    assert.match(urls[0].pathname, /full-tape\/2026-01-02$/);
    assert.equal(urls[0].search, '');
    assert.match(urls[1].pathname, /full-tape\/2026-01-01$/);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM uw_option_trades').get() as { count: number }).count, 2);
  } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
});

test('historical backfill only inserts rows matching the requested option type and the intermarket_sweep flag', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uw-backfill-'));
  const keyFile = path.join(directory, 'key.txt'); await writeFile(keyFile, 'fixture-key', 'utf8');
  const database = createDatabase(path.join(directory, 'test.sqlite'));
  const fetchImpl: typeof fetch = async () => zipResponse(csv([
    sweepRow('call-sweep', '2026-01-01 10:00:00+00', 'call'),
    ['put-sweep', '2026-01-01 10:00:01+00', 'AAPL', 'put', '{intermarket_sweep}'],
    ['call-not-sweep', '2026-01-01 10:00:02+00', 'AAPL', 'call', '{ask_side,bullish}'],
  ]));
  try {
    const result = await backfillHistoricalSignals(database, { from: '2026-01-01', to: '2026-01-02', signalTypes: ['call_sweep'], apiKeyFile: keyFile, fetchImpl, now: () => new Date('2026-01-10T00:00:00Z') });
    assert.equal(result.inserted, 1);
    const row = database.prepare('SELECT source_trade_id FROM uw_option_trades').get() as { source_trade_id: string };
    assert.equal(row.source_trade_id, 'call-sweep');
  } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
});

test('historical backfill records the downloaded byte count against the day, from the response Content-Length', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uw-backfill-'));
  const keyFile = path.join(directory, 'key.txt'); await writeFile(keyFile, 'fixture-key', 'utf8');
  const database = createDatabase(path.join(directory, 'test.sqlite'));
  const fetchImpl: typeof fetch = async () => zipResponse(csv([sweepRow('a', '2026-01-01 10:00:00+00')]));
  try {
    await backfillHistoricalSignals(database, { from: '2026-01-01', to: '2026-01-02', signalTypes: ['call_sweep'], apiKeyFile: keyFile, fetchImpl, now: () => new Date('2026-01-10T00:00:00Z') });
    const row = database.prepare(`SELECT bytes_received AS bytesReceived, bytes_expected AS bytesExpected, progress_updated_at AS progressUpdatedAt, status
      FROM uw_historical_coverage WHERE signal_type='call_sweep' AND trading_date='2026-01-01'`).get() as
      { bytesReceived: number | null; bytesExpected: number | null; progressUpdatedAt: string | null; status: string };
    assert.equal(row.status, 'completed');
    assert.ok(row.bytesExpected !== null && row.bytesExpected > 0, 'bytes_expected should be set from Content-Length');
    assert.equal(row.bytesReceived, row.bytesExpected, 'a completed day should show its full byte count, not a stale throttled value');
    assert.ok(row.progressUpdatedAt);
  } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
});

test('historical backfill still records partial byte progress when a day fails mid-download', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uw-backfill-'));
  const keyFile = path.join(directory, 'key.txt'); await writeFile(keyFile, 'fixture-key', 'utf8');
  const database = createDatabase(path.join(directory, 'test.sqlite'));
  // A large-enough row set that streamFullTapeCsvRows will have emitted several progress
  // callbacks before the configured decompressed-byte safety cap aborts the day.
  const rows = Array.from({ length: 2000 }, (_, i) => sweepRow(`row-${i}`, '2026-01-01 10:00:00+00'));
  const fetchImpl: typeof fetch = async () => zipResponse(csv(rows));
  try {
    const result = await backfillHistoricalSignals(database, {
      from: '2026-01-01', to: '2026-01-02', signalTypes: ['call_sweep'], apiKeyFile: keyFile, fetchImpl,
      now: () => new Date('2026-01-10T00:00:00Z'), maxDecompressedBytesPerDay: 2048,
    });
    // The safety cap trips before any row is matched, so nothing was inserted -- 'failed' is
    // correct here, same as any other zero-progress error. The point of this test is that the
    // partial byte count still gets persisted below, not the overall status.
    assert.equal(result.signalResults[0].status, 'failed');
    const row = database.prepare(`SELECT bytes_received AS bytesReceived, status FROM uw_historical_coverage WHERE signal_type='call_sweep' AND trading_date='2026-01-01'`).get() as
      { bytesReceived: number | null; status: string };
    assert.equal(row.status, 'failed');
    assert.ok(row.bytesReceived !== null && row.bytesReceived > 0, 'a failed day should still show how many bytes it got through, not stay null');
  } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
});

test('historical backfill supports both signal types and records import batches', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uw-backfill-'));
  const keyFile = path.join(directory, 'key.txt'); await writeFile(keyFile, 'fixture-key', 'utf8');
  const database = createDatabase(path.join(directory, 'test.sqlite'));
  let requestNumber = 0;
  const fetchImpl: typeof fetch = async () => {
    requestNumber++;
    const optionType = requestNumber === 1 ? 'call' : 'put';
    return zipResponse(csv([sweepRow(`${optionType}-fixture`, '2026-01-01 10:00:00+00', optionType)]));
  };
  try {
    const result = await backfillHistoricalSignals(database, { from: '2026-01-01', to: '2026-01-02', signalTypes: ['call_sweep', 'put_sweep'], apiKeyFile: keyFile, fetchImpl, now: () => new Date('2026-01-10T00:00:00Z') });
    assert.equal(result.status, 'completed'); assert.equal(result.inserted, 2);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM uw_import_batches WHERE status = \'completed\'').get() as { count: number }).count, 2);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM uw_option_trades WHERE signal_type='put_sweep'").get() as { count: number }).count, 1);
  } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
});

test('historical backfill reports a clear error instead of silently misparsing a non-ZIP full-tape response', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uw-backfill-'));
  const keyFile = path.join(directory, 'key.txt'); await writeFile(keyFile, 'fixture-key', 'utf8');
  const database = createDatabase(path.join(directory, 'test.sqlite'));
  // Long enough to clear the 30-byte local-file-header read before the ZIP signature check runs.
  const nonZipBody = JSON.stringify({ error: 'This endpoint only returns data for the latest trading day.', padding: 'x'.repeat(32) });
  const fetchImpl: typeof fetch = async () => new Response(nonZipBody, { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const result = await backfillHistoricalSignals(database, { from: '2026-01-01', to: '2026-01-02', signalTypes: ['call_sweep'], apiKeyFile: keyFile, fetchImpl, now: () => new Date('2026-01-10T00:00:00Z') });
    assert.equal(result.signalResults[0].status, 'failed');
    assert.match(result.signalResults[0].errors[0], /not a ZIP file/);
  } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
});

test('multi-source backfill reports unsupported sources without network calls', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uw-backfill-'));
  const keyFile = path.join(directory, 'key.txt'); await writeFile(keyFile, 'fixture-key', 'utf8');
  const database = createDatabase(path.join(directory, 'test.sqlite'));
  let calls = 0;
  try {
    const result = await backfillHistoricalSignals(database, {
      from: '2026-01-01', to: '2026-01-02', signalTypes: ['repeated_sweeps'],
      apiKeyFile: keyFile, fetchImpl: async () => { calls++; throw new Error('must not fetch unsupported source'); },
    });
    assert.equal(calls, 0);
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.signalResults.map((row) => [row.signalType, row.status]), [['repeated_sweeps', 'unsupported']]);
    assert.match(result.signalResults[0].reason ?? '', /not downloaded/);
  } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
});

test('multi-source backfill imports historical dark-pool records through shared coverage guards, requesting the documented 200 limit', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uw-backfill-'));
  const keyFile = path.join(directory, 'key.txt'); await writeFile(keyFile, 'fixture-key', 'utf8');
  const database = createDatabase(path.join(directory, 'test.sqlite'));
  let calls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.pathname, '/api/darkpool/recent');
    assert.equal(url.searchParams.get('date'), '2026-01-01');
    assert.equal(url.searchParams.get('limit'), '200');
    return new Response(JSON.stringify({ data: [{ id: 'dp-historical-1', executed_at: '2026-01-01T15:00:00Z', ticker: 'AAPL', price: 200, size: 1000, premium: 200000, canceled: false }] }), { status: 200 });
  };
  try {
    const first = await backfillHistoricalSignals(database, { from: '2026-01-01', to: '2026-01-02', signalTypes: ['dark_pool_block'], apiKeyFile: keyFile, fetchImpl });
    const second = await backfillHistoricalSignals(database, { from: '2026-01-01', to: '2026-01-02', signalTypes: ['dark_pool_block'], apiKeyFile: keyFile, fetchImpl });
    assert.equal(first.signalResults[0].status, 'completed');
    assert.equal(first.inserted, 1);
    assert.equal(second.inserted, 0);
    assert.equal(second.skippedDays, 1);
    assert.equal(calls, 1);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM uw_dark_pool_trades').get() as { count: number }).count, 1);
  } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
});

test('historical dark-pool backfill flags (does not silently hide) a day that hits the request cap', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uw-backfill-'));
  const keyFile = path.join(directory, 'key.txt'); await writeFile(keyFile, 'fixture-key', 'utf8');
  const database = createDatabase(path.join(directory, 'test.sqlite'));
  const records = Array.from({ length: 200 }, (_, i) => ({
    id: `dp-${i}`, executed_at: '2026-01-01T15:00:00Z', ticker: 'AAPL', price: 200, size: 100, premium: 20000, canceled: false,
  }));
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ data: records }), { status: 200 });
  try {
    const result = await backfillHistoricalSignals(database, { from: '2026-01-01', to: '2026-01-02', signalTypes: ['dark_pool_block'], apiKeyFile: keyFile, fetchImpl });
    assert.equal(result.signalResults[0].status, 'completed');
    assert.match(result.signalResults[0].errors.join(' '), /request cap.*no pagination/);
  } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
});
