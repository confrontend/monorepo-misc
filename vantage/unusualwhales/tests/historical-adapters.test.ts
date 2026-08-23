import test from 'node:test';
import assert from 'node:assert/strict';
import { HISTORICAL_ADAPTERS, getHistoricalAdapter, historicalAdapterCapabilities, planHistoricalAdapters } from '../src/providers/historical-adapters.js';

test('historical adapter registry has one truthful entry for every catalog source', () => {
  assert.equal(HISTORICAL_ADAPTERS.length, 10);
  assert.deepEqual(historicalAdapterCapabilities().map((entry) => entry.signalType), [
    'call_sweep', 'put_sweep', 'dark_pool_block', 'flow_imbalance', 'open_interest_spike', 'market_etf_flow',
    'gex_gamma', 'insider_activity', 'congress_activity', 'repeated_sweeps',
  ]);
  assert.equal(getHistoricalAdapter('call_sweep')?.status, 'available');
  assert.equal(getHistoricalAdapter('dark_pool_block')?.status, 'available');
  assert.equal(getHistoricalAdapter('gex_gamma')?.status, 'available');
});

test('option adapters normalize only provider-defined sweep rows and direction', () => {
  const adapter = getHistoricalAdapter('put_sweep')!;
  const rows = adapter.normalize([
    { id: 'put-1', executed_at: '2026-01-02T15:00:00Z', underlying_symbol: 'AAPL', option_type: 'put', report_flags: ['intermarket_sweep'] },
    { id: 'call-1', executed_at: '2026-01-02T15:01:00Z', underlying_symbol: 'AAPL', option_type: 'call', report_flags: ['intermarket_sweep'] },
    { id: 'put-2', executed_at: '2026-01-02T15:02:00Z', underlying_symbol: 'MSFT', option_type: 'put', report_flags: [] },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceId, 'put-1');
  assert.equal(rows[0].direction, 'bearish');
  assert.equal(rows[0].executedAt, '2026-01-02T15:00:00.000Z');
});

test('dark-pool adapter normalizes the provider envelope without inventing direction', () => {
  const adapter = getHistoricalAdapter('dark_pool_block')!;
  const rows = adapter.normalize({ data: [
    {
      id: 'dark-1',
      timestamp: '2026-01-02T15:05:00Z',
      symbol: 'AAPL',
      execution_price: '188.25',
      shares: 25000,
    },
  ] });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    sourceId: 'dark-1',
    signalType: 'dark_pool_block',
    executedAt: '2026-01-02T15:05:00.000Z',
    symbol: 'AAPL',
    direction: 'signed',
    rawPayload: JSON.stringify({
      id: 'dark-1',
      timestamp: '2026-01-02T15:05:00Z',
      symbol: 'AAPL',
      execution_price: '188.25',
      shares: 25000,
    }),
    validationErrors: [],
  });
});

test('unsupported adapters are explicit and their normalizers do no work', () => {
  const adapter = getHistoricalAdapter('repeated_sweeps')!;
  assert.equal(adapter.status, 'unsupported');
  assert.ok(adapter.reason);
  assert.deepEqual(adapter.normalize({ data: [{ id: 'must-not-be-used' }] }), []);
  assert.deepEqual(planHistoricalAdapters(['repeated_sweeps', 'unknown']), [
    { signalType: 'repeated_sweeps', status: 'unsupported', reason: adapter.reason },
    { signalType: 'unknown', status: 'unsupported', reason: 'Unknown signal type.' },
  ]);
});
