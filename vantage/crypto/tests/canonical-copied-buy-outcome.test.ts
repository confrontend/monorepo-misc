import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateCanonicalCopiedBuyOutcomes,
  type CanonicalCopiedBuy,
  type CanonicalCopiedExitFragment,
} from '../src/copytrade/simulation/canonicalCopiedBuyOutcome.js';

const buy = (tradeId: number): CanonicalCopiedBuy => ({ tradeId });

const fragment = (
  over: Partial<CanonicalCopiedExitFragment> & Pick<CanonicalCopiedExitFragment, 'sellTradeId'>,
): CanonicalCopiedExitFragment => ({
  buyTradeId: 1,
  copyFraction: 1,
  entryMatched: true,
  exitMatched: true,
  simulatedReturnRatio: 0,
  buyCostUsd: 100,
  ...over,
});

test('aggregates multiple exits by copy fraction and returns one outcome per original buy', () => {
  const result = aggregateCanonicalCopiedBuyOutcomes(
    [buy(1)],
    [
      fragment({ sellTradeId: 12, copyFraction: 0.25, simulatedReturnRatio: 0.2 }),
      fragment({ sellTradeId: 11, copyFraction: 0.75, simulatedReturnRatio: -0.1 }),
    ],
  );

  assert.deepEqual(result.outcomes[0], {
    buyTradeId: 1,
    exitFragmentCount: 2,
    matchedExitFragmentCount: 2,
    copiedFraction: 1,
    simulatedReturnRatio: result.outcomes[0]?.simulatedReturnRatio,
    partiallyMatched: false,
  });
  assert.ok(Math.abs((result.outcomes[0]?.simulatedReturnRatio ?? 0) - -0.025) < 1e-12);
  assert.equal(result.diagnostics.matchedRoundTrips, 2);
  assert.equal(result.diagnostics.sameBuyMultipleExits, 1);
  assert.equal(result.diagnostics.additionalExitsForMultiExitBuys, 1);
});

test('reports missing buy cost without discarding a valid delayed-copy outcome', () => {
  const result = aggregateCanonicalCopiedBuyOutcomes(
    [buy(1)],
    [fragment({ sellTradeId: 11, buyCostUsd: null, simulatedReturnRatio: 0.15 })],
  );

  assert.equal(result.outcomes[0]?.simulatedReturnRatio, 0.15);
  assert.equal(result.diagnostics.sellsWithMissingBuyCost, 1);
  assert.equal(result.diagnostics.excludedRecords, 0);
});

test('reports unmatched buys, unmatched sells, and open positions explicitly', () => {
  const result = aggregateCanonicalCopiedBuyOutcomes(
    [buy(1), buy(2), buy(3)],
    [
      fragment({ sellTradeId: 21, buyTradeId: null }),
      fragment({ sellTradeId: 22, buyTradeId: 999 }),
    ],
    [{ buyTradeId: 2, remainingFraction: 0.4 }],
  );

  assert.equal(result.diagnostics.unmatchedBuys, 2);
  assert.equal(result.diagnostics.unmatchedSells, 2);
  assert.equal(result.diagnostics.openPositions, 1);
  assert.equal(result.diagnostics.excludedRecords, 2);
  assert.equal(result.diagnostics.excludedByReason.unmatched_sell, 1);
  assert.equal(result.diagnostics.excludedByReason.unknown_buy, 1);
  assert.equal(result.outcomes[1]?.simulatedReturnRatio, null);
});

test('excludes unusable legs, invalid fractions, and missing returns with reason counts', () => {
  const result = aggregateCanonicalCopiedBuyOutcomes(
    [buy(1)],
    [
      fragment({ sellTradeId: 11, entryMatched: false }),
      fragment({ sellTradeId: 12, exitMatched: false }),
      fragment({ sellTradeId: 13, copyFraction: 0 }),
      fragment({ sellTradeId: 14, simulatedReturnRatio: null }),
      fragment({ sellTradeId: 15, simulatedReturnRatio: 0.25 }),
    ],
  );

  assert.equal(result.outcomes[0]?.matchedExitFragmentCount, 1);
  assert.equal(result.outcomes[0]?.simulatedReturnRatio, 0.25);
  assert.equal(result.outcomes[0]?.partiallyMatched, true);
  assert.equal(result.diagnostics.matchedRoundTrips, 1);
  assert.equal(result.diagnostics.excludedRecords, 4);
  assert.deepEqual(result.diagnostics.excludedByReason, {
    unmatched_sell: 0,
    unknown_buy: 0,
    unmatched_buy_leg: 1,
    unmatched_sell_leg: 1,
    invalid_copy_fraction: 1,
    missing_simulated_return: 1,
  });
});

test('sorts input deterministically by buy and sell ids', () => {
  const result = aggregateCanonicalCopiedBuyOutcomes(
    [buy(2), buy(1)],
    [
      fragment({ sellTradeId: 22, buyTradeId: 2, simulatedReturnRatio: 0.2 }),
      fragment({ sellTradeId: 11, buyTradeId: 1, simulatedReturnRatio: 0.1 }),
    ],
  );

  assert.deepEqual(
    result.outcomes.map((outcome) => outcome.buyTradeId),
    [1, 2],
  );
});
