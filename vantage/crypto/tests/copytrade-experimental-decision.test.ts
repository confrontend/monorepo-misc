import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/platform/db/client.js';
import type { CopyTradeRow } from '../src/copytrade/scrutiny/evaluate.js';
import {
  computeCopyabilityScore,
  computeFastTradingPenalty,
  computeHistoricalHyperactivityPenalty,
  delayedCopyPerformancePassesCandidacyGate,
  readExperimentalDecisionPromotedRules,
  robustnessScore,
  type ExperimentalDecisionPromotedRules,
} from '../src/copytrade/experimentalDecision.js';
import {
  patternDiscoveryCacheKey,
  readPatternDiscoveryDataFingerprint,
  writePatternDiscoveryCache,
} from '../src/copytrade/discovery/patternDiscovery.js';

const makeRow = (overrides: Record<string, unknown> = {}): CopyTradeRow =>
  ({
    walletAddress: 'WALLET',
    name: null,
    trades: 600,
    winRatePercent: 50,
    medianReturnPercent: 2,
    averageReturnPercent: 2,
    endingCapitalUsd: 102,
    verdict: 'screen_pass',
    riskFlags: [],
    failedRules: [],
    excludedNoCostBasis: 0,
    endingCapitalUsdCompounded: 102,
    truncated: false,
    coveredDays: 30,
    lastTradeAt: 1_700_000_000,
    daysSinceLastTrade: 1,
    needsDuneBackfill: false,
    unreliableReason: null,
    riskEvidence: {
      fastRoundTripPercent: 10,
      under15SecondsPercent: 40.2,
      medianHoldSeconds: 120,
      noCostBasisPercent: 0,
      fundedByAddress: null,
      walletAgeDays: 100,
    },
    riskNotes: [],
    comparable: true,
    profitConcentration: {
      bestToken: null,
      bestThreeTokens: [],
      bestTokenSharePositiveProfitPercent: 80,
      bestThreeSharePositiveProfitPercent: 90,
      bestTradeProfitUsd: 100,
      excludingBestTrade: {
        trades: 599,
        medianReturnPercent: 4,
        endingCapitalUsd: 104,
      },
      excludingBestToken: {
        trades: 590,
        medianReturnPercent: 4,
        endingCapitalUsd: 104,
      },
    },
    weeklyPerformance: [],
    monthlyPerformance: [],
    rankHistory: { currentRank: 1, points: [] },
    gmgnAggregate: {
      period: '30d',
      fetchedAt: '2026-08-24T00:00:00.000Z',
      realizedProfit: 10,
      realizedProfitPnlPercent: 2,
      nativeBalance: 1,
      buyCount: 300,
      sellCount: 300,
      boughtCost: 50_000,
      soldIncome: 50_000,
      boughtFee: 0,
      soldFee: 0,
      totalCost: 50_000,
      lastTimestamp: 1_700_000_000,
      tokenCount: 50,
      winRatePercent: 50,
      averageHoldingPeriodSeconds: 120,
    },
    ...overrides,
  }) as unknown as CopyTradeRow;

const rules: ExperimentalDecisionPromotedRules = {
  hyperactivityThresholds: [{ feature: 'prior_wallet_trade_count', threshold: 580, effect: -8.45 }],
  hyperactivityCorrelations: [],
  fastTradingCorrelations: [{ feature: 'prior_wallet_under_15_seconds_percent', effect: -0.124 }],
};

test('robustness treats concentration as neutral while retaining post-best-token performance', () => {
  const concentrated = makeRow({
    profitConcentration: {
      ...makeRow().profitConcentration,
      bestTokenSharePositiveProfitPercent: 90,
    },
  });
  const diversified = makeRow({
    profitConcentration: {
      ...makeRow().profitConcentration,
      bestTokenSharePositiveProfitPercent: 20,
    },
  });
  assert.equal(robustnessScore(concentrated), robustnessScore(diversified));
  assert.equal(robustnessScore(concentrated), 55);
});

test('negative or missing delayed-copy median cannot pass final candidacy', () => {
  assert.equal(
    delayedCopyPerformancePassesCandidacyGate({ simulatedMedianReturnPercent: -37.6 }),
    false,
  );
  assert.equal(
    delayedCopyPerformancePassesCandidacyGate({ simulatedMedianReturnPercent: 0 }),
    false,
  );
  assert.equal(
    delayedCopyPerformancePassesCandidacyGate({ simulatedMedianReturnPercent: null }),
    false,
  );
  assert.equal(
    delayedCopyPerformancePassesCandidacyGate({ simulatedMedianReturnPercent: 0.1 }),
    true,
  );
});

test('historical hyperactivity applies the promoted threshold effect without inventing a cutoff', () => {
  const row = makeRow();
  assert.equal(computeHistoricalHyperactivityPenalty(row, [row], rules), 8.45);
  const belowThreshold = makeRow({
    gmgnAggregate: { ...row.gmgnAggregate, buyCount: 200, sellCount: 200 },
  });
  assert.equal(computeHistoricalHyperactivityPenalty(belowThreshold, [belowThreshold], rules), 0);
});

test('promoted fast-trading correlation materially lowers Copyability', () => {
  const row = makeRow();
  const penalty = computeFastTradingPenalty(row, rules);
  assert.ok(penalty > 4.9 && penalty < 5.1);
  const oldScore = computeCopyabilityScore(90, 120);
  const newScore = computeCopyabilityScore(90, 120, penalty);
  assert.ok(oldScore !== null && newScore !== null);
  assert.ok(newScore < oldScore);
});

test('only cross-coverage promoted survivors activate scoring rules', () => {
  const database = openDatabase(':memory:');
  try {
    const fingerprint = readPatternDiscoveryDataFingerprint(database);
    writePatternDiscoveryCache(
      database,
      patternDiscoveryCacheKey('sensitivity', 30, 50, 10, 500),
      fingerprint,
      {
        crossCoveragePromotedPatterns: [
          {
            pattern: {
              feature: 'prior_wallet_trade_count',
              effect: -8.4,
              conditions: [{ feature: 'prior_wallet_trade_count', operator: '>=', value: 580 }],
            },
            supportingCoveragePercent: [90, 95],
          },
          {
            pattern: {
              feature: 'prior_wallet_under_15_seconds_percent',
              effect: -0.12,
              conditions: [
                {
                  feature: 'prior_wallet_under_15_seconds_percent',
                  operator: 'correlation',
                  value: 'negative',
                },
              ],
            },
            supportingCoveragePercent: [90, 95],
          },
        ],
      },
    );
    const promoted = readExperimentalDecisionPromotedRules(database);
    assert.deepEqual(promoted.hyperactivityThresholds, [
      { feature: 'prior_wallet_trade_count', threshold: 580, effect: -8.4 },
    ]);
    assert.deepEqual(promoted.fastTradingCorrelations, [
      { feature: 'prior_wallet_under_15_seconds_percent', effect: -0.12 },
    ]);
  } finally {
    database.close();
  }
});

test('Pattern Discovery revision follows match/input changes, not Dune run status metadata', () => {
  const database = openDatabase(':memory:');
  try {
    const triggerNames = new Set(
      database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'trigger' AND name LIKE 'pattern_discovery_%'`,
        )
        .all()
        .map((row) => (row as { name: string }).name),
    );
    assert.ok(triggerNames.has('pattern_discovery_matches_insert'));
    assert.ok(triggerNames.has('pattern_discovery_signals_update'));
    assert.ok(triggerNames.has('pattern_discovery_tokens_insert'));
    assert.equal(triggerNames.has('pattern_discovery_dune_update'), false);
  } finally {
    database.close();
  }
});
