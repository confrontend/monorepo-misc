import test from 'node:test';
import assert from 'node:assert/strict';
import { SIGNAL_CATALOG, getSignalDefinition } from '../src/research/signal-catalog.js';

test('catalog covers the breadth-first signal families without implying profitability', () => {
  const ids = new Set(SIGNAL_CATALOG.map((signal) => signal.id));
  for (const id of ['call_sweep', 'put_sweep', 'repeated_sweeps', 'dark_pool_block', 'flow_imbalance', 'open_interest_spike', 'gex_gamma', 'market_etf_flow', 'insider_activity', 'congress_activity']) {
    assert.ok(ids.has(id), `missing catalog entry: ${id}`);
  }
  assert.equal(SIGNAL_CATALOG.find((signal) => signal.id === 'call_sweep')?.feasibility, 'ready');
  assert.ok(SIGNAL_CATALOG.every((signal) => signal.timingLimitations.length > 0));
});

test('catalog lookup is deterministic', () => {
  assert.equal(getSignalDefinition('put_sweep')?.direction, 'bearish');
  assert.equal(getSignalDefinition('does_not_exist'), null);
});

