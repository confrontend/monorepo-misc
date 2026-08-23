import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/platform/db/client.js';
import { readSignalScoringReport } from '../src/signals/scoring.js';
import { storeGmgnSignal } from '../src/gmgn/capture/ingest.js';

test('scoring transparently credits Dune provenance and supporting fields', () => {
  const database = openDatabase(':memory:');
  try {
    database.prepare(`INSERT INTO tokens (token_address, first_trade_time, first_dex, first_tx, source, imported_at, raw_payload, validation_errors) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('TokenA', '2026-03-01T00:00:00Z', 'raydium', 'tx-a', 'dune', '2026-03-01T00:00:00Z', '{}', '[]');
    storeGmgnSignal(database, { id: 'a', token_address: 'TokenA', signal_type: 13, observed_at: '2026-03-01T00:01:00Z', market_cap: 100 }, { source: 'gmgn-browser-extension', chain: 'sol', capturedAt: new Date('2026-03-01T00:01:01Z') });
    storeGmgnSignal(database, { id: 'b', token_address: 'TokenB', signal_type: 14 }, { source: 'gmgn-cli', chain: 'sol', capturedAt: new Date('2026-03-01T00:01:01Z') });
    const report = readSignalScoringReport(database, new Date('2026-03-01T01:00:00Z'));
    assert.equal(report.method, 'exploratory-data-readiness-v1');
    assert.equal(report.totalSignals, 2);
    const matched = report.rows.find((row) => row.tokenAddress === 'TokenA')!;
    const unmatched = report.rows.find((row) => row.tokenAddress === 'TokenB')!;
    assert.equal(matched.score, 8);
    assert.equal(matched.matchedDuneToken, true);
    assert.equal(unmatched.score, 0);
    assert.equal(unmatched.matchedDuneToken, false);
    assert.match(report.limitations[0], /not a profitability/);
  } finally { database.close(); }
});
