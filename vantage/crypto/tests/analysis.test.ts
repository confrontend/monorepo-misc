import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/platform/db/client.js';
import { readSnapshotAnalysis } from '../src/signals/analysis.js';
import { storeGmgnSignal } from '../src/gmgn/capture/ingest.js';

test('snapshot analysis is descriptive and excludes raw payloads', () => {
  const database = openDatabase(':memory:');
  try {
    database.prepare(`INSERT INTO tokens (token_address, source, imported_at, raw_payload, validation_errors) VALUES (?, ?, ?, ?, ?)`).run('TokenA', 'dune', '2026-03-01T00:00:00Z', '{}', '[]');
    storeGmgnSignal(database, { id: 'a', token_address: 'TokenA', signal_type: 13, observed_at: '2026-03-01T00:01:00Z', market_cap: 100 }, { source: 'gmgn-browser-extension', chain: 'sol', capturedAt: new Date('2026-03-01T00:01:01Z') });
    storeGmgnSignal(database, { id: 'b', token_address: 'TokenA', signal_type: 14, observed_at: '2026-03-01T00:02:00Z', market_cap: 300 }, { source: 'gmgn-browser-extension', chain: 'sol', capturedAt: new Date('2026-03-01T00:02:01Z') });
    storeGmgnSignal(database, { id: 'c', token_address: 'TokenB', signal_type: 13, observed_at: '2026-03-01T00:03:00Z' }, { source: 'gmgn-cli', chain: 'sol', capturedAt: new Date('2026-03-01T00:03:01Z') });
    const report = readSnapshotAnalysis(database, new Date('2026-03-01T01:00:00Z'));
    assert.equal(report.scope, 'descriptive-snapshot-only');
    assert.equal(report.signals.total, 3);
    assert.equal(report.signals.uniqueTokens, 2);
    assert.equal(report.signals.multiSignalTokens, 1);
    assert.equal(report.signals.maxSignalsPerToken, 2);
    assert.equal(report.cohortOverlap.matchedSignals, 2);
    assert.equal(report.cohortOverlap.unmatchedSignals, 1);
    assert.equal(report.marketCap.median, 200);
    assert.deepEqual(report.sources, [{ source: 'gmgn-browser-extension', count: 2 }, { source: 'gmgn-cli', count: 1 }]);
    assert.equal(JSON.stringify(report).includes('raw_payload'), false);
    assert.equal(report.limitations.some((item) => /returns|scoring/i.test(item)), true);
  } finally { database.close(); }
});

test('empty snapshot analysis is stable', () => {
  const database = openDatabase(':memory:');
  try {
    const report = readSnapshotAnalysis(database, new Date('2026-03-01T01:00:00Z'));
    assert.equal(report.signals.total, 0);
    assert.equal(report.signals.averagePerToken, 0);
    assert.equal(report.marketCap.median, null);
    assert.deepEqual(report.signalTypes, []);
  } finally { database.close(); }
});
