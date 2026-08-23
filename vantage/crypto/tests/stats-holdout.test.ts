import assert from 'node:assert/strict';
import test from 'node:test';
import { splitByDate, suggestSplitDate } from '../src/platform/stats-utils/holdout.js';

test('splitByDate: partitions strictly by the cutoff, boundary date goes to test not discovery', () => {
  const observations = [
    { observedAt: '2026-08-10T05:00:00.000Z' },
    { observedAt: '2026-08-11T05:00:00.000Z' },
    { observedAt: '2026-08-12T05:00:00.000Z' },
    { observedAt: '2026-08-13T05:00:00.000Z' },
  ];
  const result = splitByDate(observations, '2026-08-12T00:00:00.000Z');
  assert.equal(result.discovery.length, 2);
  assert.equal(result.test.length, 2);
  assert.equal(result.discoveryDates, 2);
  assert.equal(result.testDates, 2);
});

test('suggestSplitDate: returns null when fewer than 2 distinct dates exist (cannot split meaningfully)', () => {
  const observations = [
    { observedAt: '2026-08-10T05:00:00.000Z' },
    { observedAt: '2026-08-10T09:00:00.000Z' },
  ];
  assert.equal(suggestSplitDate(observations), null);
});

test('suggestSplitDate: with several distinct dates, produces a date that actually splits the data', () => {
  const observations = Array.from({ length: 7 }, (_, day) => ({ observedAt: `2026-08-${String(10 + day).padStart(2, '0')}T05:00:00.000Z` }));
  const split = suggestSplitDate(observations, 0.3);
  assert.ok(split);
  const result = splitByDate(observations, split!);
  assert.ok(result.discovery.length > 0, 'discovery side must not be empty');
  assert.ok(result.test.length > 0, 'test side must not be empty');
});

test('suggestSplitDate: clamps an extreme testFraction rather than producing a degenerate split', () => {
  const observations = Array.from({ length: 5 }, (_, day) => ({ observedAt: `2026-08-${String(10 + day).padStart(2, '0')}T05:00:00.000Z` }));
  const split = suggestSplitDate(observations, 0.99);
  assert.ok(split);
  const result = splitByDate(observations, split!);
  assert.ok(result.discovery.length > 0, 'an extreme fraction request must still leave something to discover on');
});
