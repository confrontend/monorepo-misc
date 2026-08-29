import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/platform/db/client.js';
import type { CopyTradeRow } from '../src/copytrade/scrutiny/evaluate.js';
import { storeActivityPage } from '../src/copytrade/screening/fetch.js';
import { syncCopyTradeRoster } from '../src/copytrade/screening/roster.js';
import {
  computeCopyabilityScore,
  computeExperimentalDecisionReport,
  computeFastTradingPenalty,
  computeHistoricalHyperactivityPenalty,
  gmgnCandidatePasses,
  copyPortfolioProfitabilityPassesCandidacyGate,
  delayedCopyPerformancePassesCandidacyGate,
  outOfSampleStabilityPassesCandidacyGate,
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

test('GMGN-only candidacy requires complete evidence, a passing score, and positive GMGN median', () => {
  const base = { evidenceLevel: 'complete' as const, overall: 82, medianReturnPercent: 4.2 };
  assert.equal(gmgnCandidatePasses(base), true);
  assert.equal(gmgnCandidatePasses({ ...base, medianReturnPercent: 0 }), false);
  assert.equal(gmgnCandidatePasses({ ...base, medianReturnPercent: -3 }), false);
  assert.equal(gmgnCandidatePasses({ ...base, evidenceLevel: 'partial' }), false);
  assert.equal(gmgnCandidatePasses({ ...base, overall: null }), false);
});

test('a $100 delayed-copy portfolio must end above $100 for final candidacy', () => {
  const portfolio = (endingCapitalUsd: number) => ({
    startingCapitalUsd: 100,
    endingCapitalUsd,
  });
  assert.equal(copyPortfolioProfitabilityPassesCandidacyGate({ portfolio: portfolio(64) }), false);
  assert.equal(copyPortfolioProfitabilityPassesCandidacyGate({ portfolio: portfolio(100) }), false);
  assert.equal(
    copyPortfolioProfitabilityPassesCandidacyGate({ portfolio: portfolio(100.01) }),
    true,
  );
  assert.equal(copyPortfolioProfitabilityPassesCandidacyGate(undefined), false);
});

test('final candidacy consumes the existing Out-of-sample stability verdict', () => {
  assert.equal(
    outOfSampleStabilityPassesCandidacyGate({
      key: 'outOfSampleStability',
      label: 'Out-of-sample stability',
      n: 150,
      verdict: 'fail',
      detail: 'Early half median 56.82% vs late half median -23.72%.',
      metrics: {
        splitDate: '2026-08-15T00:00:00.000Z',
        earlyMedianReturnPercent: 56.82,
        earlyN: 124,
        lateMedianReturnPercent: -23.72,
        lateN: 26,
      },
    }),
    false,
  );
  assert.equal(
    outOfSampleStabilityPassesCandidacyGate({
      key: 'outOfSampleStability',
      label: 'Out-of-sample stability',
      n: 241,
      verdict: 'pass',
      detail: 'Early half median 30.48% vs late half median 53.75%.',
      metrics: {
        splitDate: '2026-08-11T00:00:00.000Z',
        earlyMedianReturnPercent: 30.48,
        earlyN: 184,
        lateMedianReturnPercent: 53.75,
        lateN: 57,
      },
    }),
    true,
  );
  assert.equal(outOfSampleStabilityPassesCandidacyGate(undefined), false);
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

test('REGRESSION: a wallet under the minimum-trade evidence gate never gets an overall score', () => {
  // A real production export showed 2-trade wallets scoring 100 overall -- tied for the top of
  // the leaderboard alongside wallets with a real (100+ trade) track record -- because the four
  // component scores can all compute from a tiny sample even though evidence.level correctly
  // reports 'insufficient'. Overall must be withheld the same way candidateStatus already is.
  const database = openDatabase(':memory:');
  try {
    database
      .prepare(
        `INSERT INTO gmgn_wallet_rank_snapshots (window, orderby, captured_at, raw_payload, source_sha256)
         VALUES ('7d', 'pnl_30d', '2026-08-15T00:00:00.000Z', ?, 'sha-thin-sample')`,
      )
      .run(JSON.stringify({ code: 0, data: { rank: [{ wallet_address: 'THIN', tags: [] }] } }));
    syncCopyTradeRoster(database);

    const now = new Date('2026-08-15T00:00:00.000Z');
    const base = Math.floor(now.getTime() / 1000) - 3 * 86_400;
    const trade = (over: Record<string, unknown>) =>
      storeActivityPage(
        database,
        [
          {
            wallet: 'THIN',
            chain: 'sol',
            token_amount: '100',
            price_usd: '0.1',
            gas_usd: '0.01',
            dex_usd: '0.02',
            launchpad_platform: 'Pump.fun',
            ...over,
          },
        ],
        { chain: 'sol', fetchedAt: '2026-08-15T00:00:00.000Z' },
      );
    // Two round trips on two different tokens: robustness ("performance after excluding the best
    // token") needs a second token to still have something left once the best one is excluded.
    trade({
      tx_hash: 'BUY1',
      event_type: 'buy',
      token: { address: 'TOKEN_A', symbol: 'AAA' },
      timestamp: base,
      cost_usd: '100',
    });
    trade({
      tx_hash: 'SELL1',
      event_type: 'sell',
      token: { address: 'TOKEN_A', symbol: 'AAA' },
      timestamp: base + 3_600,
      cost_usd: '150',
      buy_cost_usd: '100',
    });
    trade({
      tx_hash: 'BUY2',
      event_type: 'buy',
      token: { address: 'TOKEN_B', symbol: 'BBB' },
      timestamp: base + 7_200,
      cost_usd: '100',
    });
    trade({
      tx_hash: 'SELL2',
      event_type: 'sell',
      token: { address: 'TOKEN_B', symbol: 'BBB' },
      timestamp: base + 10_800,
      cost_usd: '120',
      buy_cost_usd: '100',
    });

    const report = computeExperimentalDecisionReport(database);
    const wallet = report.wallets.find((entry) => entry.walletAddress === 'THIN');
    assert.ok(wallet, 'the thin-sample wallet is still reported');
    assert.notEqual(wallet!.evidence.level, 'complete', 'only 2 trades cannot be complete evidence');
    assert.ok(
      wallet!.scores.edge !== null &&
        wallet!.scores.consistency !== null &&
        wallet!.scores.robustness !== null &&
        wallet!.scores.copyability !== null,
      'this is exactly the case where all four components still compute despite the thin sample',
    );
    assert.equal(wallet!.scores.overall, null, 'overall must not bypass the evidence-level gate');
    assert.notEqual(wallet!.candidateStatus, 'eligible');
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
