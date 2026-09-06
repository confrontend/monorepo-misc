import assert from 'node:assert/strict';
import test from 'node:test';
import {
  simulateFixedStakePortfolio,
  replayTradesForScenario,
  type FixedStakePortfolioTrade,
} from '../src/copytrade/simulation/fixedStakePortfolio.js';

const trade = (over: Partial<FixedStakePortfolioTrade> = {}): FixedStakePortfolioTrade => ({
  id: 1,
  entryAt: 1,
  exitAt: 2,
  returnRatio: 0.5,
  gasFeeSol: 0,
  entryGasFeeSol: 0,
  exitGasFeeSol: 0,
  entryGasFeeUsd: 0,
  exitGasFeeUsd: 0,
  copyFraction: 1,
  ...over,
});

test('explicit default scenario matches the legacy defaults exactly', () => {
  const trades = [trade()];
  assert.deepEqual(
    simulateFixedStakePortfolio(trades),
    simulateFixedStakePortfolio(trades, {
      scenario: { startingBankrollUsd: 100, copyAmountUsd: 10 },
    }),
  );
});

test('$50 copy amount scales the deployed position locally', () => {
  const result = simulateFixedStakePortfolio([trade({ stakeUsd: 10 })], {
    scenario: { startingBankrollUsd: 100, copyAmountUsd: 50 },
  });
  assert.equal(result.totalCapitalDeployedUsd, 50);
  assert.equal(result.endingCapitalUsd, 125);
});

test('$250 copy amount is constrained by the starting bankroll', () => {
  const result = simulateFixedStakePortfolio([trade()], {
    scenario: { startingBankrollUsd: 100, copyAmountUsd: 250 },
  });
  assert.equal(result.copiedTrades, 0);
  assert.equal(result.skippedInsufficientCash, 1);
  assert.equal(result.endingCapitalUsd, 100);
});

test('insufficient bankroll skips a buy without changing cash', () => {
  const result = simulateFixedStakePortfolio([trade()], {
    scenario: { startingBankrollUsd: 25, copyAmountUsd: 50 },
  });
  assert.equal(result.copiedTrades, 0);
  assert.equal(result.skippedInsufficientCash, 1);
  assert.equal(result.endingCapitalUsd, 25);
});

test('multiple simultaneous positions preserve the open-position limit', () => {
  const trades = Array.from({ length: 3 }, (_, index) =>
    trade({ id: index + 1, entryAt: 1, exitAt: 10 + index }),
  );
  const result = simulateFixedStakePortfolio(trades, {
    startingCapitalUsd: 100,
    stakePerTradeUsd: 10,
    maxOpenPositions: 2,
  });
  assert.equal(result.maxConcurrentPositions, 2);
  assert.equal(result.skippedMaxOpenPositions, 1);
  assert.equal(result.maxConcurrentCapitalUsd, 20);
});

test('partial sell fractions deploy only the configured fraction', () => {
  const result = simulateFixedStakePortfolio(
    replayTradesForScenario([trade({ copyFraction: 0.25 })], 50),
    {
      startingCapitalUsd: 100,
      stakePerTradeUsd: 50,
    },
  );
  assert.equal(result.totalCapitalDeployedUsd, 12.5);
  assert.equal(result.endingCapitalUsd, 106.25);
});

test('fixed gas has a larger effect on small amounts', () => {
  const small = simulateFixedStakePortfolio([trade({ entryGasFeeUsd: 1, exitGasFeeUsd: 1 })], {
    startingCapitalUsd: 100,
    stakePerTradeUsd: 10,
  });
  const large = simulateFixedStakePortfolio([trade({ entryGasFeeUsd: 1, exitGasFeeUsd: 1 })], {
    startingCapitalUsd: 100,
    stakePerTradeUsd: 100,
  });
  assert.equal(small.gasFeeUsd, 2);
  assert.ok(small.endingCapitalUsd - 100 < large.endingCapitalUsd - 100);
});

test('changing scenario values makes no Dune or network call', () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    return Promise.reject(new Error('network should not be reached'));
  };
  try {
    simulateFixedStakePortfolio([trade()], { startingCapitalUsd: 100, stakePerTradeUsd: 25 });
    simulateFixedStakePortfolio([trade()], { startingCapitalUsd: 500, stakePerTradeUsd: 250 });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
});
