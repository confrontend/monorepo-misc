import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { zipStored } from '../src/dune/ingest/archive.js';
import { listGmgnArchives } from '../src/gmgn/archives.js';

const buildCaptureArchive = (options: {
  capturedAt?: string;
  eventCount?: number;
  stored?: number;
  repeated?: number;
  validationErrors?: number;
  events?: unknown[];
  omitManifest?: boolean;
  omitResponse?: boolean;
}): Buffer => {
  const events = options.events ?? [{ id: 'evt-1' }, { id: 'evt-2' }];
  const manifest = {
    capturedAt: options.capturedAt ?? '2026-08-11T04:12:21.462Z',
    eventCount: options.eventCount ?? events.length,
    stored: options.stored ?? events.length,
    repeated: options.repeated ?? 0,
    validationErrors: options.validationErrors ?? 0,
  };
  const entries = [];
  if (!options.omitResponse) entries.push({ name: 'gmgn-signal-response.json', data: Buffer.from(JSON.stringify(events), 'utf8') });
  if (!options.omitManifest) entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') });
  return zipStored(entries);
};

const writeArchive = (directory: string, buffer: Buffer, hashOverride?: string): string => {
  const hash = hashOverride ?? createHash('sha256').update(buffer).digest('hex');
  const fileName = `gmgn-capture-2026-08-11T04-12-21-462Z-${hash.slice(0, 16)}.zip`;
  writeFileSync(path.join(directory, fileName), buffer);
  return fileName;
};

test('a well-formed archive is reported fully verified with a safe, parsed manifest', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'crypto-gmgn-archives-'));
  try {
    const buffer = buildCaptureArchive({});
    const fileName = writeArchive(directory, buffer);

    const [summary] = listGmgnArchives(directory);
    assert.equal(summary!.fileName, fileName);
    assert.equal(summary!.hashVerified, true);
    assert.equal(summary!.structureVerified, true);
    assert.equal(summary!.eventCountVerified, true);
    assert.equal(summary!.verified, true);
    assert.equal(summary!.verificationError, null);
    assert.deepEqual(summary!.entryNames.sort(), ['gmgn-signal-response.json', 'manifest.json']);
    assert.equal(summary!.manifest!.eventCount, 2);
    assert.equal(summary!.manifest!.capturedAt, '2026-08-11T04:12:21.462Z');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a tampered archive fails hash verification even though it still parses', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'crypto-gmgn-archives-'));
  try {
    const buffer = buildCaptureArchive({});
    const fileName = writeArchive(directory, buffer);
    // Tamper the file after naming it from its original hash, simulating on-disk corruption or edits.
    writeFileSync(path.join(directory, fileName), Buffer.concat([buffer, Buffer.from('tampered')]));

    const [summary] = listGmgnArchives(directory);
    assert.equal(summary!.hashVerified, false);
    assert.equal(summary!.verified, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a structurally invalid file is flagged with a descriptive error and no manifest', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'crypto-gmgn-archives-'));
  try {
    const garbage = Buffer.from('this is not a zip file');
    writeArchive(directory, garbage);

    const [summary] = listGmgnArchives(directory);
    assert.equal(summary!.structureVerified, false);
    assert.equal(summary!.verified, false);
    assert.equal(summary!.manifest, null);
    assert.match(summary!.verificationError ?? '', /valid stored ZIP archive/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an archive missing manifest.json is flagged rather than silently treated as empty', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'crypto-gmgn-archives-'));
  try {
    const buffer = buildCaptureArchive({ omitManifest: true });
    writeArchive(directory, buffer);

    const [summary] = listGmgnArchives(directory);
    assert.equal(summary!.structureVerified, false);
    assert.equal(summary!.verified, false);
    assert.match(summary!.verificationError ?? '', /manifest\.json/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a manifest event count that disagrees with the archived response is flagged, not trusted', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'crypto-gmgn-archives-'));
  try {
    const buffer = buildCaptureArchive({ events: [{ id: 'evt-1' }, { id: 'evt-2' }, { id: 'evt-3' }], eventCount: 2 });
    writeArchive(directory, buffer);

    const [summary] = listGmgnArchives(directory);
    assert.equal(summary!.structureVerified, true);
    assert.equal(summary!.eventCountVerified, false);
    assert.equal(summary!.verified, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('listGmgnArchives never returns the raw captured event payload, only manifest-derived fields', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'crypto-gmgn-archives-'));
  try {
    const secretLookingEvent = { id: 'evt-1', triggering_wallet: 'SECRET_WALLET_ADDRESS_SHOULD_NOT_LEAK' };
    const buffer = buildCaptureArchive({ events: [secretLookingEvent], eventCount: 1 });
    writeArchive(directory, buffer);

    const serialized = JSON.stringify(listGmgnArchives(directory));
    assert.doesNotMatch(serialized, /SECRET_WALLET_ADDRESS_SHOULD_NOT_LEAK/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a missing archive directory returns an empty list rather than throwing', () => {
  const directory = path.join(tmpdir(), 'crypto-gmgn-archives-does-not-exist');
  assert.deepEqual(listGmgnArchives(directory), []);
});
