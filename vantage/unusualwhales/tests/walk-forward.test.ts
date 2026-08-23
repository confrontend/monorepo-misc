import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWalkForward, type WalkForwardConfig } from '../src/research/walk-forward.js';
import type { OosEvent } from '../src/research/oos-validation.js';

const event = (id: string, at: string, value: number): OosEvent => ({ eventId: id, signalId: 'call_sweep', symbol: id, executedAt: at, outcomes: [{ horizon: '+5m', outcomeAt: new Date(Date.parse(at) + 300_000).toISOString(), returnPct: value, excessReturnPct: value }] });

test('walk-forward validation keeps selections fixed across sequential windows', () => {
  const config: WalkForwardConfig = {
    methodologyVersion: 'walk-forward-test-v1', selections: [{ signalId: 'call_sweep', direction: 'bullish' }], horizons: ['+5m'], costsBpsPerSide: [25], minimumUsableOutcomes: 1,
    windows: [
      { id: 'w2', inSample: { start: '2026-01-03T00:00:00Z', end: '2026-01-04T00:00:00Z' }, outOfSample: { start: '2026-01-04T00:00:00Z', end: '2026-01-05T00:00:00Z' }, asOf: '2026-01-06T00:00:00Z' },
      { id: 'w1', inSample: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' }, outOfSample: { start: '2026-01-02T00:00:00Z', end: '2026-01-03T00:00:00Z' }, asOf: '2026-01-04T00:00:00Z' },
    ],
  };
  const report = validateWalkForward([event('a', '2026-01-01T10:00:00Z', 1), event('b', '2026-01-02T10:00:00Z', 2), event('c', '2026-01-03T10:00:00Z', -1), event('d', '2026-01-04T10:00:00Z', 3)], config);
  assert.deepEqual(report.windows.map(window => window.id), ['w1', 'w2']);
  assert.equal(report.windows[0].report.results[0].horizons[0].outOfSample.averageReturnPct, 2);
  assert.equal(report.windows[1].report.results[0].horizons[0].outOfSample.averageReturnPct, 3);
});
