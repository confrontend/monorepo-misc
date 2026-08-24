import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { archiveDuneSource, readZipEntries, zipStored } from '../src/dune/ingest/archive.js';

test('processed Dune source is written as a ZIP with source and manifest entries', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'crypto-archive-'));
  try {
    const first = archiveDuneSource({
      archiveDirectory: directory,
      batchId: 7,
      sourceName: 'cohort.csv',
      sourceSha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      rawSource: 'token_address,symbol\nArchiveToken,ARC\n',
      summary: { imported: 1, skipped: 0, errors: 0 },
      archivedAt: '2026-08-09T00:00:00.000Z',
    });
    const bytes = readFileSync(first.archivePath);
    assert.equal(bytes.subarray(0, 4).toString('hex'), '504b0304');
    assert.match(bytes.toString('utf8'), /cohort\.csv/);
    assert.match(bytes.toString('utf8'), /manifest\.json/);

    const second = archiveDuneSource({
      archiveDirectory: directory,
      batchId: 7,
      sourceName: 'cohort.csv',
      sourceSha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      rawSource: 'different source must not overwrite',
      summary: { imported: 99 },
      archivedAt: '2026-08-10T00:00:00.000Z',
    });
    assert.equal(second.archivePath, first.archivePath);
    assert.equal(second.archiveSha256, first.archiveSha256);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('readZipEntries round-trips entries written by zipStored, including empty and multi-entry archives', () => {
  const archive = zipStored([
    { name: 'gmgn-signal-response.json', data: Buffer.from('[{"id":"evt-1"}]', 'utf8') },
    {
      name: 'manifest.json',
      data: Buffer.from(
        JSON.stringify({ capturedAt: '2026-08-10T00:00:00.000Z', eventCount: 1 }),
        'utf8',
      ),
    },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ]);
  const entries = readZipEntries(archive);
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['gmgn-signal-response.json', 'manifest.json', 'empty.txt'],
  );
  assert.equal(entries[0].data.toString('utf8'), '[{"id":"evt-1"}]');
  assert.deepEqual(JSON.parse(entries[1].data.toString('utf8')), {
    capturedAt: '2026-08-10T00:00:00.000Z',
    eventCount: 1,
  });
  assert.equal(entries[2].data.length, 0);
});

test('readZipEntries rejects a file that is not a valid ZIP archive', () => {
  assert.throws(() => readZipEntries(Buffer.from('not a zip file at all')), /valid ZIP archive/);
  assert.throws(() => readZipEntries(Buffer.alloc(4)), /too small/);
});
