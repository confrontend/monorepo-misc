import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import test from 'node:test';
import { parsePostgresArrayLiteral, splitCsvLine, streamFullTapeCsvRows } from '../src/providers/full-tape-csv.js';

/**
 * Builds a minimal ZIP local-file-header + entry, matching the shape confirmed live against
 * GET /api/option-trades/full-tape/{date} (2026-08-18): one entry, DEFLATE or STORED
 * compression, file name length in the header. Deliberately omits the central directory --
 * streamFullTapeCsvRows never reads it, so a fixture without one still exercises the real
 * parsing path end to end.
 */
const buildZipEntry = (csvText: string, options: { fileName?: string; stored?: boolean } = {}): Buffer => {
  const fileName = options.fileName ?? '2026-01-02-option_trades.csv';
  const nameBuf = Buffer.from(fileName, 'utf8');
  const contentBuf = Buffer.from(csvText, 'utf8');
  const body = options.stored ? contentBuf : zlib.deflateRawSync(contentBuf);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(options.stored ? 0 : 8, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(body.length, 18);
  header.writeUInt32LE(contentBuf.length, 22);
  header.writeUInt16LE(nameBuf.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBuf, body]);
};

const bodyStreamOf = (buffer: Buffer): ReadableStream<Uint8Array> => new Response(buffer).body!;

const collectRows = async (stream: ReadableStream<Uint8Array>) => {
  const rows = [];
  for await (const row of streamFullTapeCsvRows(stream)) rows.push(row);
  return rows;
};

test('splitCsvLine handles quoted fields with embedded commas and doubled quotes', () => {
  assert.deepEqual(splitCsvLine('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(splitCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
  assert.deepEqual(splitCsvLine('a,"say ""hi""",c'), ['a', 'say "hi"', 'c']);
  assert.deepEqual(splitCsvLine(''), ['']);
});

test('parsePostgresArrayLiteral parses the report_flags/tags column format', () => {
  assert.deepEqual(parsePostgresArrayLiteral('{}'), []);
  assert.deepEqual(parsePostgresArrayLiteral('{intermarket_sweep}'), ['intermarket_sweep']);
  assert.deepEqual(parsePostgresArrayLiteral('{ask_side,bullish}'), ['ask_side', 'bullish']);
  assert.deepEqual(parsePostgresArrayLiteral(''), []);
});

test('streamFullTapeCsvRows decodes a real DEFLATE-compressed CSV entry into row objects', async () => {
  const csv = 'id,underlying_symbol,executed_at,option_type,report_flags\n'
    + 'a,AAPL,2026-01-02 10:00:00.123456+00,call,{intermarket_sweep}\n'
    + 'b,MSFT,2026-01-02 10:00:01+00,put,"{ask_side,bullish}"\n';
  const rows = await collectRows(bodyStreamOf(buildZipEntry(csv)));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'a');
  assert.equal(rows[0].underlying_symbol, 'AAPL');
  assert.equal(rows[0].report_flags, '{intermarket_sweep}');
  assert.equal(rows[1].tags, undefined);
  assert.equal(rows[1].report_flags, '{ask_side,bullish}');
});

test('streamFullTapeCsvRows decodes a STORED (uncompressed) entry the same way', async () => {
  const csv = 'id,option_type\na,call\nb,put\n';
  const rows = await collectRows(bodyStreamOf(buildZipEntry(csv, { stored: true })));
  assert.deepEqual(rows.map((row) => row.id), ['a', 'b']);
});

test('streamFullTapeCsvRows tolerates a large decompressed payload without buffering it whole', async () => {
  const rowCount = 20_000;
  const lines = ['id,value'];
  for (let i = 0; i < rowCount; i++) lines.push(`row-${i},${i}`);
  const csv = lines.join('\n') + '\n';
  const rows = await collectRows(bodyStreamOf(buildZipEntry(csv)));
  assert.equal(rows.length, rowCount);
  assert.equal(rows[0].id, 'row-0');
  assert.equal(rows.at(-1)?.id, `row-${rowCount - 1}`);
});

test('streamFullTapeCsvRows rejects a non-ZIP response instead of silently returning nothing', async () => {
  // Long enough to clear the 30-byte local-file-header read before the signature is checked.
  const notAZip = Buffer.from(JSON.stringify({ error: 'not found', data: [], padding: 'x'.repeat(32) }), 'utf8');
  await assert.rejects(collectRows(bodyStreamOf(notAZip)), /not a ZIP file/);
});

test('streamFullTapeCsvRows reports a clear error for a body shorter than a ZIP header', async () => {
  const tooShort = Buffer.from('short', 'utf8');
  await assert.rejects(collectRows(bodyStreamOf(tooShort)), /ended before a ZIP header/);
});

test('streamFullTapeCsvRows enforces the decompressed-byte safety cap', async () => {
  const csv = 'id\n' + Array.from({ length: 1000 }, (_, i) => `row-${i}`).join('\n') + '\n';
  const stream = bodyStreamOf(buildZipEntry(csv));
  const rows = streamFullTapeCsvRows(stream, { maxDecompressedBytes: 16 });
  await assert.rejects(async () => { for await (const _ of rows) { /* drain */ } }, /safety limit/);
});
