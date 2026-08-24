import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { zipStored } from '../src/dune/ingest/archive.js';
import { openDatabase } from '../src/platform/db/client.js';
import { readIntegrityReport } from '../src/signals/integrity.js';
import { storeGmgnSignal } from '../src/gmgn/capture/ingest.js';
import { startGmgnPoll, completeGmgnPoll, failGmgnPoll } from '../src/gmgn/capture/polls.js';

const emptyArchiveDirectory = path.join(tmpdir(), 'crypto-integrity-no-archives');

test('integrity report never fabricates fields for an empty database', () => {
  const database = openDatabase(':memory:');
  try {
    const report = readIntegrityReport(database, { archiveDirectory: emptyArchiveDirectory, now: () => new Date('2026-08-10T00:00:00.000Z') });
    assert.equal(report.generatedAt, '2026-08-10T00:00:00.000Z');
    assert.equal(report.signals.total, 0);
    assert.deepEqual(report.tokensBySource, []);
    assert.deepEqual(report.signals.bySource, []);
    assert.deepEqual(report.signals.byType, []);
    assert.deepEqual(report.signals.timestampCoverage, {
      earliestObservedAt: null, latestObservedAt: null, earliestTriggerAt: null, latestTriggerAt: null,
    });
    assert.deepEqual(report.duplicates, { pollRepeatedSignals: 0, duneImportSkippedRows: 0, browserImportSkippedSignals: 0 });
    assert.deepEqual(report.polls, {
      totalPolls: 0, completedPolls: 0, failedPolls: 0, incompletePolls: 0, emptyPolls: 0, pollsWithGaps: 0, gaps: [],
    });
    assert.deepEqual(report.browserCoverage, {
      totalWindows: 0, openWindows: 0, gapClosedWindows: 0, totalCoveredSeconds: 0, windows: [],
    });
    assert.equal(report.provenance.gmgnCaptureArchives.total, 0);
  } finally {
    database.close();
  }
});

test('signals are broken down by source and signal type without judging good or bad', () => {
  const database = openDatabase(':memory:');
  try {
    storeGmgnSignal(database, { observed_at: '2026-08-09T01:00:00Z', token_address: 'A', signal_type: 'buy' },
      { capturedAt: new Date('2026-08-09T01:00:01Z'), logger: { warn() {} }, source: 'gmgn-cli', chain: 'sol' });
    storeGmgnSignal(database, { observed_at: '2026-08-09T02:00:00Z', token_address: 'B', signal_type: 'buy' },
      { capturedAt: new Date('2026-08-09T02:00:01Z'), logger: { warn() {} }, source: 'gmgn-cli', chain: 'sol' });
    storeGmgnSignal(database, { observed_at: '2026-08-09T03:00:00Z', token_address: 'C', signal_type: 'watch' },
      { capturedAt: new Date('2026-08-09T03:00:01Z'), logger: { warn() {} }, source: 'gmgn-browser-extension', chain: 'sol' });

    const report = readIntegrityReport(database, { archiveDirectory: emptyArchiveDirectory });
    assert.deepEqual(report.signals.bySource, [
      { source: 'gmgn-cli', count: 2 },
      { source: 'gmgn-browser-extension', count: 1 },
    ]);
    assert.deepEqual(report.signals.byType, [
      { signalType: 'buy', count: 2 },
      { signalType: 'watch', count: 1 },
    ]);
    assert.equal(report.signals.timestampCoverage.earliestObservedAt, '2026-08-09T01:00:00.000Z');
    assert.equal(report.signals.timestampCoverage.latestObservedAt, '2026-08-09T03:00:00.000Z');
  } finally {
    database.close();
  }
});

test('tokens are broken down by source so a Dune cohort import and a later targeted enrichment stay distinguishable', () => {
  const database = openDatabase(':memory:');
  try {
    database.prepare(`
      INSERT INTO tokens (token_address, source, imported_at, raw_payload) VALUES
        ('CohortToken1', 'dune', '2026-08-09T00:00:00Z', '{}'),
        ('CohortToken2', 'dune', '2026-08-09T00:00:00Z', '{}'),
        ('EnrichedToken1', 'dune-targeted-enrichment', '2026-08-10T00:00:00Z', '{}')
    `).run();

    const report = readIntegrityReport(database, { archiveDirectory: emptyArchiveDirectory });
    assert.deepEqual(report.tokensBySource, [
      { source: 'dune', count: 2 },
      { source: 'dune-targeted-enrichment', count: 1 },
    ]);
  } finally {
    database.close();
  }
});

test('poll integrity counts gaps, empty polls, crashed polls, and failures separately', () => {
  const database = openDatabase(':memory:');
  try {
    // Completed poll with data, no gap.
    const pollA = startGmgnPoll(database, { startedAt: '2026-08-09T01:00:00Z', source: 'gmgn-cli', chain: 'sol', cliVersion: '1.0.0' });
    completeGmgnPoll(database, pollA, {
      completedAt: '2026-08-09T01:00:05Z', received: 3, stored: 3, repeated: 0, errors: 0,
      bounds: { oldestTriggerAt: '2026-08-09T00:59:00Z', newestTriggerAt: '2026-08-09T01:00:00Z' },
      previousNewest: null, archivePath: '/archive/a.zip', archiveSha256: 'sha-a',
    });

    // Completed poll with a detected gap versus the previous poll's newest trigger.
    const pollB = startGmgnPoll(database, { startedAt: '2026-08-09T02:00:00Z', source: 'gmgn-cli', chain: 'sol', cliVersion: '1.0.0' });
    completeGmgnPoll(database, pollB, {
      completedAt: '2026-08-09T02:00:05Z', received: 2, stored: 1, repeated: 1, errors: 0,
      bounds: { oldestTriggerAt: '2026-08-09T01:30:00Z', newestTriggerAt: '2026-08-09T02:00:00Z' },
      previousNewest: '2026-08-09T01:00:00Z', archivePath: '/archive/b.zip', archiveSha256: 'sha-b',
    });

    // Completed poll that received nothing.
    const pollC = startGmgnPoll(database, { startedAt: '2026-08-09T03:00:00Z', source: 'gmgn-cli', chain: 'sol', cliVersion: '1.0.0' });
    completeGmgnPoll(database, pollC, {
      completedAt: '2026-08-09T03:00:05Z', received: 0, stored: 0, repeated: 0, errors: 0,
      bounds: { oldestTriggerAt: null, newestTriggerAt: null },
      previousNewest: '2026-08-09T02:00:00Z', archivePath: '/archive/c.zip', archiveSha256: 'sha-c',
    });

    // Failed poll.
    const pollD = startGmgnPoll(database, { startedAt: '2026-08-09T04:00:00Z', source: 'gmgn-cli', chain: 'sol', cliVersion: '1.0.0' });
    failGmgnPoll(database, pollD, '2026-08-09T04:00:02Z', new Error('rate limited'));

    // Poll that never completed (process crashed mid-poll).
    startGmgnPoll(database, { startedAt: '2026-08-09T05:00:00Z', source: 'gmgn-cli', chain: 'sol', cliVersion: '1.0.0' });

    const report = readIntegrityReport(database, { archiveDirectory: emptyArchiveDirectory });
    assert.equal(report.polls.totalPolls, 5);
    assert.equal(report.polls.completedPolls, 3);
    assert.equal(report.polls.failedPolls, 1);
    assert.equal(report.polls.incompletePolls, 1);
    assert.equal(report.polls.emptyPolls, 1);
    assert.equal(report.polls.pollsWithGaps, 1);
    assert.equal(report.polls.gaps.length, 1);
    assert.equal(report.polls.gaps[0].pollId, pollB);
    assert.equal(report.duplicates.pollRepeatedSignals, 1);
  } finally {
    database.close();
  }
});

test('provenance reports archive coverage for dune imports, browser imports, and gmgn capture archives', () => {
  const database = openDatabase(':memory:');
  try {
    database.prepare(`
      INSERT INTO dune_import_batches (source_path, source_sha256, source_format, raw_source, status, imported_count, skipped_count, error_count, imported_at, completed_at, archive_path, archive_sha256, archived_at)
      VALUES ('a', 'sha-a', 'json', '{}', 'completed', 10, 2, 0, '2026-08-09T00:00:00Z', '2026-08-09T00:00:01Z', '/archive/dune-a.zip', 'sha-dune-a', '2026-08-09T00:00:01Z')
    `).run();
    database.prepare(`
      INSERT INTO dune_import_batches (source_path, source_sha256, source_format, raw_source, status, imported_count, skipped_count, error_count, imported_at)
      VALUES ('b', 'sha-b', 'json', '{}', 'processing', 0, 0, 0, '2026-08-09T01:00:00Z')
    `).run();

    database.prepare(`
      INSERT INTO gmgn_browser_import_batches (source_path, source_sha256, raw_source, status, imported_count, skipped_count, error_count, imported_at, completed_at, archive_path, archive_sha256, archived_at)
      VALUES ('c', 'sha-c', '{}', 'completed', 5, 1, 0, '2026-08-09T02:00:00Z', '2026-08-09T02:00:01Z', '/archive/browser-c.zip', 'sha-browser-c', '2026-08-09T02:00:01Z')
    `).run();

    const directory = mkdtempSync(path.join(tmpdir(), 'crypto-integrity-archives-'));
    try {
      const events = [{ id: 'evt-1' }];
      const manifest = { capturedAt: '2026-08-09T03:00:00.000Z', eventCount: 1, stored: 1, repeated: 0, validationErrors: 0 };
      const buffer = zipStored([
        { name: 'gmgn-signal-response.json', data: Buffer.from(JSON.stringify(events), 'utf8') },
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') },
      ]);
      const hash = createHash('sha256').update(buffer).digest('hex');
      writeFileSync(path.join(directory, `gmgn-capture-2026-08-09T03-00-00-000Z-${hash.slice(0, 16)}.zip`), buffer);

      const report = readIntegrityReport(database, { archiveDirectory: directory });
      assert.deepEqual(report.provenance.duneImportBatches, { total: 2, completed: 1, failed: 0, archived: 1 });
      assert.deepEqual(report.provenance.gmgnBrowserImportBatches, { total: 1, completed: 1, failed: 0, archived: 1 });
      assert.deepEqual(report.provenance.gmgnCaptureArchives, { total: 1, verified: 1, unverified: 0 });
      assert.equal(report.duplicates.duneImportSkippedRows, 2);
      assert.equal(report.duplicates.browserImportSkippedSignals, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  } finally {
    database.close();
  }
});

test('browser coverage windows report covered duration and distinguish gap-closed from clean closes', () => {
  const database = openDatabase(':memory:');
  try {
    const batch = database.prepare(`
      INSERT INTO gmgn_browser_import_batches (source_path, source_sha256, raw_source, status, imported_count, skipped_count, error_count, imported_at)
      VALUES ('cov', 'sha-cov', '{}', 'completed', 0, 0, 0, '2026-08-09T00:00:00Z')
    `).run();
    const batchId = Number(batch.lastInsertRowid);

    database.prepare(`
      INSERT INTO gmgn_browser_coverage_windows (batch_id, started_at, ended_at, last_heartbeat_at, closed_reason, imported_at)
      VALUES (?, '2026-08-09T00:00:00.000Z', '2026-08-09T00:30:00.000Z', '2026-08-09T00:30:00.000Z', NULL, '2026-08-09T00:30:00.000Z')
    `).run(batchId);
    database.prepare(`
      INSERT INTO gmgn_browser_coverage_windows (batch_id, started_at, ended_at, last_heartbeat_at, closed_reason, imported_at)
      VALUES (?, '2026-08-09T01:00:00.000Z', '2026-08-09T01:10:00.000Z', '2026-08-09T01:05:00.000Z', 'heartbeat-gap-detected-on-wake', '2026-08-09T01:10:00.000Z')
    `).run(batchId);
    database.prepare(`
      INSERT INTO gmgn_browser_coverage_windows (batch_id, started_at, ended_at, last_heartbeat_at, closed_reason, imported_at)
      VALUES (?, '2026-08-09T02:00:00.000Z', NULL, '2026-08-09T02:15:00.000Z', NULL, '2026-08-09T02:15:00.000Z')
    `).run(batchId);

    const report = readIntegrityReport(database, { archiveDirectory: emptyArchiveDirectory });
    assert.equal(report.browserCoverage.totalWindows, 3);
    assert.equal(report.browserCoverage.openWindows, 1);
    assert.equal(report.browserCoverage.gapClosedWindows, 1);
    // 30 min (closed) + 10 min (gap-closed) + 15 min (still open, counted up to its last heartbeat) = 3300s
    assert.equal(report.browserCoverage.totalCoveredSeconds, 3300);
    assert.equal(report.browserCoverage.windows.length, 3);
  } finally {
    database.close();
  }
});

test('integrity report does not include any financial good/bad judgment fields', () => {
  const database = openDatabase(':memory:');
  try {
    const report = readIntegrityReport(database, { archiveDirectory: emptyArchiveDirectory });
    const serialized = JSON.stringify(report).toLowerCase();
    for (const forbidden of ['score', 'rank', 'profit', 'return', 'strategy', 'good', 'bad']) {
      assert.doesNotMatch(serialized, new RegExp(forbidden), `integrity report must not mention "${forbidden}"`);
    }
  } finally {
    database.close();
  }
});
