import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase } from '../src/db/client.js';
import { runOutOfSampleValidation, validateOutOfSample, type OosEvent, type OosValidationConfig } from '../src/research/oos-validation.js';

const config = (overrides: Partial<OosValidationConfig> = {}): OosValidationConfig => ({
  methodologyVersion: 'oos-test-v1',
  inSample: { start: '2026-01-01T00:00:00Z', end: '2026-01-03T00:00:00Z' },
  outOfSample: { start: '2026-01-03T00:00:00Z', end: '2026-01-04T00:00:00Z' },
  asOf: '2026-01-05T00:00:00Z',
  selections: [{ signalId: 'call_sweep', direction: 'bullish' }],
  horizons: ['+5m'],
  costsBpsPerSide: [25],
  minimumUsableOutcomes: 1,
  ...overrides,
});

const event = (eventId: string, signalId: string, executedAt: string, returnPct: number | null, extra: Partial<OosEvent> = {}): OosEvent => ({
  eventId, signalId, symbol: 'ABC', executedAt, outcomes: [{ horizon: '+5m', outcomeAt: new Date(Date.parse(executedAt) + 5 * 60_000).toISOString(), returnPct, excessReturnPct: returnPct === null ? null : returnPct / 2 }], ...extra,
});

test('freezes selections and reports deterministic in-sample versus untouched out-of-sample metrics', () => {
  const report = validateOutOfSample([
    event('is-1', 'call_sweep', '2026-01-02T10:00:00Z', 2),
    event('is-overlap', 'call_sweep', '2026-01-02T10:03:00Z', 9),
    event('oos-1', 'call_sweep', '2026-01-03T10:00:00Z', -1),
    event('not-selected', 'put_sweep', '2026-01-03T11:00:00Z', -2),
  ], config());
  const result = report.results[0].horizons[0];
  assert.deepEqual(result.inSample, {
    rawEventN: 2, independentEventN: 1, matureEventN: 1, usableOutcomeN: 1, distinctTickers: 1, captureDates: 1,
    freshOutcomeCoveragePct: 100, winRatePct: 100, medianReturnPct: 2, averageReturnPct: 2, medianExcessPct: 1, averageExcessPct: 1,
    returnStdDevPct: 0, maxDrawdownPct: 0, profitFactor: null,
    netByCostBpsPerSide: { '25': 1.5 }, exclusions: { overlapping_event: 1 }, status: 'descriptive',
  });
  assert.equal(result.outOfSample.averageReturnPct, -1);
  assert.equal(result.outOfSample.netByCostBpsPerSide['25'], -1.5);
  assert.equal(result.outOfSample.winRatePct, 0);
  assert.equal(report.frozen.selections[0].signalId, 'call_sweep');
  assert.match(report.frozen.selectionFingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(report, validateOutOfSample([
    event('not-selected', 'put_sweep', '2026-01-03T11:00:00Z', -2),
    event('oos-1', 'call_sweep', '2026-01-03T10:00:00Z', -1),
    event('is-overlap', 'call_sweep', '2026-01-02T10:03:00Z', 9),
    event('is-1', 'call_sweep', '2026-01-02T10:00:00Z', 2),
  ], config()));
});

test('replays overlap across the split, applies maturity, and accepts only exact groups', () => {
  const report = validateOutOfSample([
    event('prior', 'call_sweep', '2026-01-02T23:58:00Z', 1),
    event('oos-overlap', 'call_sweep', '2026-01-03T00:01:00Z', 3),
    event('wrong-group', 'call_sweep', '2026-01-03T01:00:00Z', 4, { groupId: 'other' }),
    event('right-group', 'call_sweep', '2026-01-03T01:10:00Z', 5, { groupId: 'approved' }),
    { ...event('immature', 'call_sweep', '2026-01-03T23:59:00Z', 6), outcomes: [{ horizon: '+5m', maturityAt: '2026-01-04T00:04:00Z', outcomeAt: null, returnPct: null, exclusionReason: null }] },
  ], config({ asOf: '2026-01-03T23:59:00Z', selections: [{ signalId: 'call_sweep', groupId: 'approved', direction: 'bullish' }, { signalId: 'call_sweep', direction: 'bullish' }] }));
  const broad = report.results.find((result) => result.selection.groupId === undefined)?.horizons[0].outOfSample as NonNullable<typeof report.results[number]['horizons'][number]>['outOfSample'];
  assert.equal(broad.rawEventN, 4);
  assert.equal(broad.independentEventN, 3);
  assert.equal(broad.usableOutcomeN, 2);
  assert.equal(broad.exclusions.overlapping_event, 1);
  assert.equal(broad.exclusions.outcome_not_mature, 1);
  const group = report.results.find((result) => result.selection.groupId === 'approved')?.horizons[0].outOfSample;
  assert.equal(group?.rawEventN, 1);
  assert.equal(group?.averageReturnPct, 5);
});

test('database runner is read-only and uses only preselected normalized signal IDs', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'uw-oos-'));
  const database = createDatabase(path.join(directory, 'oos.sqlite'));
  try {
    const batch = database.prepare(`INSERT INTO uw_import_batches(endpoint,query_json,requested_at,status) VALUES('test','{}','2026-01-01T00:00:00Z','completed')`).run();
    const addTrade = database.prepare(`INSERT INTO uw_option_trades(source_trade_id,source_batch_id,executed_at,captured_at,signal_type,underlying_symbol,option_type,raw_payload) VALUES(?,?,?,?,?,?,?,?)`);
    addTrade.run('call-1', batch.lastInsertRowid, '2026-01-03T10:00:00Z', '2026-01-03T10:00:00Z', 'call_sweep', 'ABC', 'call', '{}');
    addTrade.run('put-1', batch.lastInsertRowid, '2026-01-03T10:00:00Z', '2026-01-03T10:00:00Z', 'put_sweep', 'ABC', 'put', '{}');
    const callId = (database.prepare(`SELECT id FROM uw_option_trades WHERE source_trade_id='call-1'`).get() as { id: number }).id;
    database.prepare(`INSERT INTO uw_signal_outcomes(trade_id,horizon,entry_at,entry_price,outcome_at,outcome_price,return_pct,excess_return_pct,exclusion_reason,calculated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(callId, '+5m', '2026-01-03T10:00:00Z', 100, '2026-01-03T10:05:00Z', 102, 2, 1, null, '2026-01-05T00:00:00Z');
    const before = (database.prepare('SELECT COUNT(*) AS count FROM uw_signal_outcomes').get() as { count: number }).count;
    const report = runOutOfSampleValidation(database, config());
    const after = (database.prepare('SELECT COUNT(*) AS count FROM uw_signal_outcomes').get() as { count: number }).count;
    assert.equal(before, after);
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].selection.signalId, 'call_sweep');
    assert.equal(report.results[0].horizons[0].outOfSample.usableOutcomeN, 1);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
