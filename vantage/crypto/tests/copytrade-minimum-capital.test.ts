import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateMinimumCapital,
  MINIMUM_CAPITAL_CALCULATION_VERSION,
} from '../src/copytrade/simulation/minimumCapital.js';
import {
  simulateFixedStakePortfolio,
  type FixedStakePortfolioTrade,
} from '../src/copytrade/simulation/fixedStakePortfolio.js';
import { openDatabase } from '../src/platform/db/client.js';
import {
  calculateMinimumCapitalFromStoredData,
  readCachedMinimumCapital,
  saveMinimumCapital,
} from '../src/copytrade/minimumCapital.js';

const trade = (
  id: number,
  entryAt: number,
  exitAt: number,
  returnRatio = 0.1,
): FixedStakePortfolioTrade => ({
  id,
  entryAt,
  exitAt,
  returnRatio,
  gasFeeSol: 0,
  gasFeeUsd: 0,
  entryGasFeeSol: 0,
  exitGasFeeSol: 0,
  entryGasFeeUsd: 0,
  exitGasFeeUsd: 0,
  copyFraction: 1,
});

test('minimum capital searches explicit configurations and returns the lowest passing capital', () => {
  const result = calculateMinimumCapital(
    'W1',
    [trade(1, 100, 200), trade(2, 300, 400)],
    { gmgnDataFingerprint: 'g1', duneHistoryFingerprint: 'd1' },
    { copyAmountsUsd: [1, 2], startingCapitalAmountsUsd: [1, 2] },
  );

  assert.equal(result.calculationVersion, MINIMUM_CAPITAL_CALCULATION_VERSION);
  assert.deepEqual(
    [
      result.recommendedConfiguration?.startingCapitalUsd,
      result.recommendedConfiguration?.copyAmountUsd,
    ],
    [1, 1],
  );
  assert.equal(result.recommendedConfiguration?.executedTradeRate, 100);
  assert.equal(result.recommendedConfiguration?.skippedTrades, 0);
  assert.equal(result.testedConfigurations.length, 4);
});

test('minimum capital does not apply the canonical ten-position cap', () => {
  const trades = Array.from({ length: 20 }, (_, index) =>
    trade(index + 1, 100 + index, 1_000 + index),
  );
  const result = calculateMinimumCapital(
    'W-many',
    trades,
    { gmgnDataFingerprint: 'g1', duneHistoryFingerprint: 'd1' },
    { copyAmountsUsd: [0.5], startingCapitalAmountsUsd: [10] },
  );
  const configuration = result.testedConfigurations[0];
  assert.equal(configuration.executedTrades, 20);
  assert.equal(configuration.skippedTrades, 0);
  assert.equal(configuration.maxConcurrentCapitalUsd, 10);
});

test('minimum capital exposes a fee warning without turning it into a hidden rejection', () => {
  const costly: FixedStakePortfolioTrade = {
    ...trade(1, 100, 200, 0.01),
    entryGasFeeUsd: 0.5,
    exitGasFeeUsd: 0.5,
  };
  const result = calculateMinimumCapital(
    'W-fees',
    [costly],
    { gmgnDataFingerprint: 'g1', duneHistoryFingerprint: 'd1' },
    { copyAmountsUsd: [1], startingCapitalAmountsUsd: [2] },
  );
  const configuration = result.testedConfigurations[0];
  assert.equal(configuration.status, 'pass');
  assert.equal(configuration.feeWarning, true);
  assert.equal(configuration.feesToGrossProfitPct, 10000);
});

test('the default $100/$10 configuration retains the shared simulator result exactly', () => {
  const trades = [trade(1, 100, 200, 0.25), trade(2, 300, 400, -0.1)];
  const expected = simulateFixedStakePortfolio(trades, {
    startingCapitalUsd: 100,
    stakePerTradeUsd: 10,
  });
  const result = calculateMinimumCapital(
    'W-default',
    trades,
    { gmgnDataFingerprint: 'g1', duneHistoryFingerprint: 'd1' },
    { copyAmountsUsd: [10], startingCapitalAmountsUsd: [100] },
  );
  const actual = result.testedConfigurations[0];
  assert.equal(actual.endingCapitalUsd, expected.endingCapitalUsd);
  assert.equal(actual.totalCapitalDeployedUsd, expected.totalCapitalDeployedUsd);
  assert.equal(actual.netPnlUsd, expected.endingCapitalUsd - expected.startingCapitalUsd);
});

test('$50 and $250 copy amounts are local scenario configurations', () => {
  const trades = [trade(1, 100, 200, 0.2)];
  const result = calculateMinimumCapital(
    'W-size',
    trades,
    { gmgnDataFingerprint: 'g1', duneHistoryFingerprint: 'd1' },
    { copyAmountsUsd: [50, 250], startingCapitalAmountsUsd: [500] },
  );
  assert.deepEqual(
    result.testedConfigurations.map((configuration) => configuration.copyAmountUsd),
    [50, 250],
  );
  assert.equal(result.testedConfigurations[0]?.totalCapitalDeployedUsd, 50);
  assert.equal(result.testedConfigurations[1]?.totalCapitalDeployedUsd, 250);
});

test('insufficient bankroll is visible as a cash skip and fails the execution gate', () => {
  const result = calculateMinimumCapital(
    'W-cash',
    [trade(1, 100, 200)],
    { gmgnDataFingerprint: 'g1', duneHistoryFingerprint: 'd1' },
    { copyAmountsUsd: [10], startingCapitalAmountsUsd: [2] },
  );
  const configuration = result.testedConfigurations[0];
  assert.equal(configuration.executedTrades, 0);
  assert.equal(configuration.insufficientCashSkips, 1);
  assert.equal(configuration.status, 'fail');
  assert.equal(result.recommendedConfiguration, null);
});

test('partial copy fractions scale the intended stake without changing the replay sequence', () => {
  const trades = [
    { ...trade(1, 100, 200, 0.1), copyFraction: 0.5 },
    { ...trade(2, 300, 400, 0.1), copyFraction: 0.25 },
  ];
  const result = calculateMinimumCapital(
    'W-fraction',
    trades,
    { gmgnDataFingerprint: 'g1', duneHistoryFingerprint: 'd1' },
    { copyAmountsUsd: [10], startingCapitalAmountsUsd: [20] },
  );
  const configuration = result.testedConfigurations[0];
  assert.equal(configuration.totalCapitalDeployedUsd, 7.5);
  assert.equal(configuration.executedTrades, 2);
});

test('scenario calculation is pure and performs no network work', () => {
  const result = calculateMinimumCapital(
    'W-local',
    [trade(1, 100, 200)],
    { gmgnDataFingerprint: 'g1', duneHistoryFingerprint: 'd1' },
    { copyAmountsUsd: [1], startingCapitalAmountsUsd: [2] },
  );
  assert.equal(result.testedConfigurations.length, 1);
});

test('saved minimum-capital results are reusable and idempotent for the same fingerprints', () => {
  const database = openDatabase(':memory:');
  try {
    const result = calculateMinimumCapitalFromStoredData(database, 'W-cache');
    saveMinimumCapital(database, result);
    saveMinimumCapital(database, result);
    const cached = readCachedMinimumCapital(database, 'W-cache');
    assert.equal(cached?.cached, true);
    assert.equal(cached?.walletAddress, 'W-cache');
    const row = database
      .prepare('SELECT COUNT(*) AS count FROM copytrade_minimum_capital_results')
      .get() as { count: number };
    assert.equal(row.count, 1);
  } finally {
    database.close();
  }
});
