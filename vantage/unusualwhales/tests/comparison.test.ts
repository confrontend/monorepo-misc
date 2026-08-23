import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../src/db/client.js';
import { readSignalComparison, readCachedComparison, refreshComparisonCache } from '../src/research/comparison.js';
import { readPostgresComparison } from '../src/research/postgres-comparison.js';
import { comparisonWarnings, selectComparisonLeader } from '../src/research/comparison-rules.js';

type PostgresRow = Record<string, unknown>;

class FakeComparisonPool {
  constructor(private readonly stats: PostgresRow[]) {}

  async query(sql: string) {
    if (sql.includes('WITH stats')) return { rows: this.stats, rowCount: this.stats.length };
    return { rows: [{ signal_type: 'call_sweep', raw: '30', tickers: '3', earliest: '2026-01-01T00:00:00.000Z', latest: '2026-01-03T00:00:00.000Z' }], rowCount: 1 };
  }
}

test('comparison response contains every catalog signal and no fabricated non-call metrics', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'uw-comparison-'));
  const database = createDatabase(path.join(directory, 'comparison.sqlite'));
  const response = readSignalComparison(database);
  assert.ok(response.signals.length >= 10);
  const call = response.signals.find((signal) => signal.signalId === 'call_sweep');
  assert.ok(call);
  assert.equal(call.coverage.rawEvents, 0);
  assert.equal(call.outcomes[0].averageReturnPct, null);
  const put = response.signals.find((signal) => signal.signalId === 'put_sweep');
  assert.ok(put);
  assert.equal(put.coverage.rawEvents, 0);
  assert.equal(put.outcomes[3].status, 'unavailable');
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

test('SQLite comparison applies the same +1d gate and shorter-horizon fallback', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'uw-comparison-'));
  const database = createDatabase(path.join(directory, 'comparison.sqlite'));
  try {
    const batch = database.prepare(`INSERT INTO uw_import_batches(endpoint,query_json,requested_at,status) VALUES('test','{}','2026-01-01T00:00:00Z','completed')`).run();
    const addTrade = database.prepare(`INSERT INTO uw_option_trades(source_trade_id,source_batch_id,executed_at,captured_at,signal_type,underlying_symbol,option_type,raw_payload) VALUES(?,?,?,?,?,?,?,?)`);
    const addOutcome = database.prepare(`INSERT INTO uw_signal_outcomes(trade_id,horizon,return_pct,excess_return_pct,calculated_at) VALUES(?,?,?,?,?)`);
    for (let index = 0; index < 30; index++) {
      const trade = addTrade.run(`comparison-${index}`, Number(batch.lastInsertRowid), '2026-01-02T15:00:00Z', '2026-01-02T15:00:00Z', 'call_sweep', `SYM${index}`, 'call', '{}');
      addOutcome.run(Number(trade.lastInsertRowid), '+5m', 1, 0.8, '2026-01-10T00:00:00Z');
      addOutcome.run(Number(trade.lastInsertRowid), '+1d', 0.4, 0.2, '2026-01-10T00:00:00Z');
    }
    const response = readSignalComparison(database);
    assert.equal(response.leader.status, 'early');
    assert.equal(response.leader.horizon, '+5m');
    assert.equal(response.leader.signalId, 'call_sweep');
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('readCachedComparison serves the last cached snapshot, not a live recompute, until refreshed', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'uw-comparison-'));
  const database = createDatabase(path.join(directory, 'comparison.sqlite'));
  try {
    // Cold start: nothing cached yet, so this must fall back to a live compute and populate
    // the cache from it -- not throw, not return an empty/undefined shape.
    const first = readCachedComparison(database);
    assert.ok(first.signals.find((signal) => signal.signalId === 'call_sweep'));
    const cachedRow = database.prepare('SELECT payload_json AS payloadJson FROM uw_comparison_cache WHERE id = 1').get() as { payloadJson: string } | undefined;
    assert.ok(cachedRow, 'the cold-start fallback must populate the cache, not just return a value');

    // Mutate the underlying data directly (bypassing refreshOutcomes/refreshComparisonCache)
    // to prove the next read comes from the stale cache, not from re-scanning live tables.
    database.prepare(`INSERT INTO uw_comparison_cache (id, payload_json, generated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, generated_at = excluded.generated_at`)
      .run(JSON.stringify({ generatedAt: '2020-01-01T00:00:00.000Z', leader: first.leader, signals: [] }), '2020-01-01T00:00:00.000Z');
    const stale = readCachedComparison(database);
    assert.equal(stale.signals.length, 0, 'a cached payload with zero signals must be served as-is, not silently recomputed');
    assert.equal(stale.generatedAt, '2020-01-01T00:00:00.000Z');

    // refreshComparisonCache() must overwrite that stale row with a fresh live computation.
    const refreshed = refreshComparisonCache(database);
    assert.ok(refreshed.signals.find((signal) => signal.signalId === 'call_sweep'));
    const afterRefresh = readCachedComparison(database);
    assert.deepEqual(afterRefresh, refreshed);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('comparison leader requires non-negative +1d results after the 25 bps/side cost gate', async () => {
  const stats = [{
    signal_type: 'call_sweep', horizon: '+1d', raw: '30', independent: '30', mature: '30', usable: '30', wins: '18',
    average: 0.4, excess: 0.2, median: 0.4,
  }];
  const comparison = await readPostgresComparison(new FakeComparisonPool(stats) as never);
  assert.equal(comparison.leader.status, 'none');
  assert.equal(comparison.leader.signalId, null);
});

test('comparison leader selects a non-negative +1d result as the candidate', async () => {
  const stats = [{
    signal_type: 'call_sweep', horizon: '+1d', raw: '30', independent: '30', mature: '30', usable: '30', wins: '18',
    average: 0.8, excess: 0.6, median: 0.8,
  }];
  const comparison = await readPostgresComparison(new FakeComparisonPool(stats) as never);
  assert.equal(comparison.leader.status, 'candidate');
  assert.equal(comparison.leader.horizon, '+1d');
  assert.ok(Math.abs((comparison.leader.afterCostsPct ?? 0) - 0.3) < 1e-9);
});

test('comparison leader may use a shorter positive descriptive horizon only as an early fallback', async () => {
  const stats = [
    {
      signal_type: 'call_sweep', horizon: '+5m', raw: '30', independent: '30', mature: '30', usable: '30', wins: '18',
      average: 1, excess: 0.8, median: 1,
    },
    {
      signal_type: 'call_sweep', horizon: '+1d', raw: '30', independent: '30', mature: '30', usable: '30', wins: '14',
      average: 0.4, excess: 0.2, median: 0.4,
    },
  ];
  const comparison = await readPostgresComparison(new FakeComparisonPool(stats) as never);
  assert.equal(comparison.leader.status, 'early');
  assert.equal(comparison.leader.horizon, '+5m');
  assert.equal(comparison.leader.signalId, 'call_sweep');
});

test('winner rules keep 29 usable outcomes insufficient and expose evidence warnings', () => {
  const leader = selectComparisonLeader([{
    signalId: 'call_sweep', label: 'Call sweeps', outcomes: [{
      horizon: '+1d', sampleSize: 29, averageExcessPct: 1,
      afterCostsPct: { '10': 0.8, '25': 0.5, '50': 0 }, status: 'insufficient',
    }],
  }]);
  assert.equal(leader.status, 'none');
  assert.deepEqual(comparisonWarnings({
    coverageStatus: 'candidate', rawEvents: 29, tickers: 2,
    primaryOutcome: { sampleSize: 29, status: 'insufficient', afterCostsPct: { '10': 0.8, '25': 0.5, '50': 0 } },
  }), [
    'Source coverage is candidate; this signal is not fully validated.',
    'Fewer than 30 raw events are available.',
    'Fewer than 10 distinct tickers are represented.',
    'Fewer than 30 usable +1d outcomes are available.',
    'Any leader remains a candidate only; out-of-sample validation is required.',
  ]);
});

test('PostgreSQL coverage reports +1d evidence instead of the strongest other horizon', async () => {
  const stats = [
    { signal_type: 'call_sweep', horizon: '+5m', raw: '50', independent: '50', mature: '50', usable: '50', wins: '30', average: 2, excess: 1.5, median: 2 },
    { signal_type: 'call_sweep', horizon: '+1d', raw: '50', independent: '1', mature: '1', usable: '1', wins: '1', average: 2, excess: 1.5, median: 2 },
  ];
  const comparison = await readPostgresComparison(new FakeComparisonPool(stats) as never);
  const call = comparison.signals.find((signal) => signal.signalId === 'call_sweep');
  assert.ok(call);
  assert.equal(call.coverage.independentEvents, 1);
  assert.equal(call.coverage.matureEvents, 1);
  assert.equal(call.coverage.usableOutcomes, 1);
});
