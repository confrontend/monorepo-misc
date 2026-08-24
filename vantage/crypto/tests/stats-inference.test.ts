import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bootstrapMedianCI,
  signTest,
  holmCorrection,
} from '../src/platform/stats-utils/inference.js';

test('bootstrapMedianCI: a constant array always resamples to the same median, CI collapses to a point', () => {
  const values = Array(20).fill(5);
  const result = bootstrapMedianCI(values, { iterations: 500, seed: 1 });
  assert.ok(result);
  assert.equal(result.median, 5);
  assert.equal(result.lower, 5);
  assert.equal(result.upper, 5);
  assert.equal(result.n, 20);
});

test('bootstrapMedianCI: is reproducible given the same seed', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, -3, -8, 12, 4, -1];
  const a = bootstrapMedianCI(values, { iterations: 1000, seed: 42 });
  const b = bootstrapMedianCI(values, { iterations: 1000, seed: 42 });
  assert.deepEqual(a, b);
});

test('bootstrapMedianCI: a spread-out distribution produces a wider interval than a tight one', () => {
  const tight = [10, 10.1, 9.9, 10.05, 9.95, 10.02, 9.98, 10.01, 9.99, 10];
  const wide = [-50, -20, 5, 10, 15, 30, 40, 60, 80, 100];
  const tightResult = bootstrapMedianCI(tight, { iterations: 1000, seed: 7 })!;
  const wideResult = bootstrapMedianCI(wide, { iterations: 1000, seed: 7 })!;
  assert.ok(wideResult.upper - wideResult.lower > tightResult.upper - tightResult.lower);
});

test('bootstrapMedianCI: empty input returns null rather than throwing', () => {
  assert.equal(bootstrapMedianCI([]), null);
});

test('signTest: all-positive sample matches the exact hand-computed binomial p-value', () => {
  // n=10, k=0 (min of 10 positive / 0 negative): p = 2 * C(10,0) * 0.5^10 = 2/1024
  const result = signTest([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(result.nPositive, 10);
  assert.equal(result.nNegative, 0);
  assert.ok(Math.abs(result.pValue - 2 / 1024) < 1e-9);
});

test('signTest: a perfectly balanced 5/5 split is indistinguishable from chance (p = 1)', () => {
  const result = signTest([1, 2, 3, 4, 5, -1, -2, -3, -4, -5]);
  assert.equal(result.nPositive, 5);
  assert.equal(result.nNegative, 5);
  assert.equal(result.pValue, 1);
});

test('signTest: exact zeros are excluded from the tally, not counted as either sign', () => {
  const result = signTest([1, 2, 3, 0, 0, 0]);
  assert.equal(result.nTicked, 3);
  assert.equal(result.nTotal, 6);
});

test('signTest: no ticked observations at all returns p=1, not NaN or a throw', () => {
  const result = signTest([0, 0, 0]);
  assert.equal(result.pValue, 1);
});

test('holmCorrection: matches a hand-computed example exactly', () => {
  // p = [0.01, 0.02, 0.03, 0.04, 0.05], alpha = 0.05, m = 5, already ascending.
  // Step-down thresholds: 0.05/5=0.01, 0.05/4=0.0125, 0.05/3, 0.05/2, 0.05/1.
  // Only the first p-value (0.01) clears its threshold; the chain breaks after that.
  const result = holmCorrection([0.01, 0.02, 0.03, 0.04, 0.05], 0.05);
  assert.deepEqual(result.rejected, [true, false, false, false, false]);
  assert.ok(Math.abs(result.adjustedPValues[0] - 0.05) < 1e-9);
  assert.ok(Math.abs(result.adjustedPValues[1] - 0.08) < 1e-9);
  assert.ok(Math.abs(result.adjustedPValues[2] - 0.09) < 1e-9);
  // Adjusted p-values must be monotone non-decreasing once sorted by original p-value.
  assert.ok(result.adjustedPValues[3] >= result.adjustedPValues[2]);
  assert.ok(result.adjustedPValues[4] >= result.adjustedPValues[3]);
});

test('holmCorrection: preserves input order in its output, not sorted order', () => {
  // Same p-values as above but shuffled — output must realign to the original index order.
  const result = holmCorrection([0.05, 0.01, 0.04, 0.02, 0.03], 0.05);
  assert.equal(result.rejected[1], true); // the 0.01 entry, now at index 1
  assert.equal(result.rejected[0], false); // the 0.05 entry, now at index 0
});

test('holmCorrection: a single test is unaffected by correction (m=1 behaves like uncorrected)', () => {
  const result = holmCorrection([0.03], 0.05);
  assert.equal(result.adjustedPValues[0], 0.03);
  assert.equal(result.rejected[0], true);
});

test('holmCorrection: scanning many cells makes it much harder for any one to survive correction', () => {
  // A single p=0.04 result survives uncorrected (alpha=0.05), but not once bundled with 50 other
  // untested (p=1) cells — this is the exact scenario the Patterns subgroup view is in today.
  const manyCells = [0.04, ...Array(50).fill(1)];
  const result = holmCorrection(manyCells, 0.05);
  assert.equal(
    result.rejected[0],
    false,
    'a borderline result must not survive correction across many scanned cells',
  );
});
