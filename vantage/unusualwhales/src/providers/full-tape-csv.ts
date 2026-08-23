import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const LOCAL_FILE_HEADER_FIXED_LENGTH = 30;

export type FullTapeCsvRow = Record<string, string>;

/**
 * Minimal RFC4180 line splitter: handles quoted fields with embedded commas and doubled
 * double-quotes (`""` -> `"`). Sufficient for the full-tape CSV export; not a general parser.
 */
export const splitCsvLine = (line: string): string[] => {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; } else { inQuotes = false; }
      } else current += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { fields.push(current); current = ''; }
    else current += ch;
  }
  fields.push(current);
  return fields;
};

/**
 * Parses a Postgres array literal (`{}`, `{intermarket_sweep}`, `{ask_side,bullish}`) into a
 * plain string array. Handles backslash-escaped quotes within a quoted element, matching
 * Postgres's own array-output escaping. Not a full Postgres array grammar implementation --
 * scoped to the simple bareword tag values this feed actually produces.
 */
export const parsePostgresArrayLiteral = (raw: string): string[] => {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '{}') return [];
  const body = trimmed.startsWith('{') && trimmed.endsWith('}') ? trimmed.slice(1, -1) : trimmed;
  if (!body) return [];
  const elements: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inQuotes) {
      if (ch === '\\' && i + 1 < body.length) { current += body[i + 1]; i++; }
      else if (ch === '"') inQuotes = false;
      else current += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { elements.push(current); current = ''; }
    else current += ch;
  }
  elements.push(current);
  return elements.map((value) => value.trim()).filter((value) => value.length > 0);
};

export type FullTapeStreamOptions = {
  /** Safety cap on decompressed bytes read, so a corrupted or unexpectedly large entry
   *  cannot grow memory unbounded. Rows are still yielded one at a time before this is hit. */
  maxDecompressedBytes?: number;
  /** Called with each raw (pre-decompression) chunk's length as it arrives off the network.
   *  This reflects real download progress most directly, since it tracks wire bytes against
   *  the response's Content-Length rather than an estimate of the (larger) decompressed size. */
  onBytes?: (byteLength: number) => void;
};

/**
 * Streams the single-entry ZIP that GET /api/option-trades/full-tape/{date} returns (verified
 * live 2026-08-18: HTTP 200, `content-type: application/zip`, one deflate-compressed entry
 * named `{date}-option_trades.csv`) and yields one plain object per CSV row, keyed by the
 * header column names.
 *
 * This is intentionally NOT a general-purpose ZIP reader: it reads only the local file header
 * of the first entry (signature, compression method, name/extra length) to find where the
 * compressed data starts, then decodes forward. It never reads the central directory. End of
 * data is detected from the DEFLATE bitstream's own final-block marker (verified: Node's
 * zlib.createInflateRaw() ends its readable side cleanly and ignores any trailing bytes fed to
 * it afterward, so the ZIP central directory that follows the entry is simply never parsed
 * rather than needing to be explicitly skipped). Memory use is bounded because rows are parsed
 * and yielded incrementally from a small rolling text buffer, never by materializing the full
 * decompressed CSV (which can be several GB for one trading day).
 */
export async function* streamFullTapeCsvRows(
  body: ReadableStream<Uint8Array>,
  options: FullTapeStreamOptions = {},
): AsyncGenerator<FullTapeCsvRow> {
  const maxBytes = options.maxDecompressedBytes ?? Number.POSITIVE_INFINITY;
  const source = Readable.fromWeb(body as never);
  const iterator = source[Symbol.asyncIterator]();
  const nextChunk = async () => {
    const result = await iterator.next();
    if (!result.done) options.onBytes?.((result.value as Uint8Array).length);
    return result;
  };

  let headerBuffer = Buffer.alloc(0);
  while (headerBuffer.length < LOCAL_FILE_HEADER_FIXED_LENGTH) {
    const { value, done } = await nextChunk();
    if (done) throw new Error('Unusual Whales full-tape response ended before a ZIP header could be read');
    headerBuffer = Buffer.concat([headerBuffer, Buffer.from(value as Uint8Array)]);
  }
  const signature = headerBuffer.readUInt32LE(0);
  if (signature !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(`Unusual Whales full-tape response is not a ZIP file (signature 0x${signature.toString(16)})`);
  }
  const compressionMethod = headerBuffer.readUInt16LE(8);
  const nameLength = headerBuffer.readUInt16LE(26);
  const extraLength = headerBuffer.readUInt16LE(28);
  const headerTotalLength = LOCAL_FILE_HEADER_FIXED_LENGTH + nameLength + extraLength;
  while (headerBuffer.length < headerTotalLength) {
    const { value, done } = await nextChunk();
    if (done) throw new Error('Unusual Whales full-tape response ended before the ZIP entry name/extra field could be read');
    headerBuffer = Buffer.concat([headerBuffer, Buffer.from(value as Uint8Array)]);
  }
  if (compressionMethod !== 0 && compressionMethod !== 8) {
    throw new Error(`Unusual Whales full-tape entry uses unsupported ZIP compression method ${compressionMethod}`);
  }
  const leftover = headerBuffer.length > headerTotalLength ? headerBuffer.subarray(headerTotalLength) : null;

  async function* remainingEntryBytes(): AsyncGenerator<Buffer> {
    if (leftover && leftover.length > 0) yield leftover;
    while (true) {
      const { value, done } = await nextChunk();
      if (done) return;
      yield Buffer.from(value as Uint8Array);
    }
  }

  async function* decodedBytes(): AsyncGenerator<Buffer> {
    if (compressionMethod === 0) {
      yield* remainingEntryBytes();
      return;
    }
    const inflate = zlib.createInflateRaw();
    const rawReadable = Readable.from(remainingEntryBytes());
    const pumpDone = pipeline(rawReadable, inflate).catch((error) => {
      // A pipeline failure here means the write side broke, not that decompression is done;
      // surface it through the readable side so the outer consumer sees a real error.
      if (!inflate.destroyed) inflate.destroy(error instanceof Error ? error : new Error(String(error)));
    });
    try {
      for await (const chunk of inflate) yield Buffer.from(chunk as Uint8Array);
    } finally {
      await pumpDone;
    }
  }

  const decoder = new TextDecoder('utf-8');
  let carry = '';
  let headerColumns: string[] | null = null;
  let decompressedBytes = 0;

  const emitLine = (line: string): FullTapeCsvRow | null => {
    if (!headerColumns) {
      headerColumns = splitCsvLine(line);
      return null;
    }
    if (line.length === 0) return null;
    const fields = splitCsvLine(line);
    const row: FullTapeCsvRow = {};
    for (let i = 0; i < headerColumns.length; i++) row[headerColumns[i]] = fields[i] ?? '';
    return row;
  };

  for await (const chunk of decodedBytes()) {
    decompressedBytes += chunk.length;
    if (decompressedBytes > maxBytes) {
      throw new Error(`Unusual Whales full-tape entry exceeded the configured ${maxBytes}-byte safety limit`);
    }
    carry += decoder.decode(chunk, { stream: true });
    let newlineIndex: number;
    while ((newlineIndex = carry.indexOf('\n')) !== -1) {
      const line = carry.slice(0, newlineIndex).replace(/\r$/, '');
      carry = carry.slice(newlineIndex + 1);
      const row = emitLine(line);
      if (row) yield row;
    }
  }
  carry += decoder.decode();
  const finalLine = carry.replace(/\r$/, '');
  if (finalLine.length > 0) {
    const row = emitLine(finalLine);
    if (row) yield row;
  }
}
