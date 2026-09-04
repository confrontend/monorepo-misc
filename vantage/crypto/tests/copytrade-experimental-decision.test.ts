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
  readExperimentalDecisionPromotedRules,
  readExperimentalDecisionWeighting,
  robustnessScore,
  type ExperimentalDecisionPromotedRules,
  type ExperimentalDecisionWallet,
} from '../src/copytrade/experimentalDecision.js';
import { evaluateWinnerPolicy } from '../src/copytrade/winnerPolicy.js';
import { emptyWinnerPolicyEvidence } from '../src/copytrade/winnerPolicyEvidence.js';
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
      under15SecondsCount: 8,
      pairedTradeCount: 20,
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

test('GMGN-only candidacy requires complete evidence, a passing score, and positive GMGN median', () => {
  const base = { evidenceLevel: 'complete' as const, overall: 82, medianReturnPercent: 4.2 };
  assert.equal(gmgnCandidatePasses(base), true);
  assert.equal(gmgnCandidatePasses({ ...base, medianReturnPercent: 0 }), false);
  assert.equal(gmgnCandidatePasses({ ...base, medianReturnPercent: -3 }), false);
  assert.equal(gmgnCandidatePasses({ ...base, evidenceLevel: 'partial' }), false);
  assert.equal(gmgnCandidatePasses({ ...base, overall: null }), false);
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
  const withoutRule = computeCopyabilityScore({
    medianHoldSeconds: 120,
    fastRoundTripPercent: 10,
    under15SecondPercent: 40.2,
    pairedTradeCount: 20,
  });
  const withRule = computeCopyabilityScore({
    medianHoldSeconds: 120,
    fastRoundTripPercent: 10,
    under15SecondPercent: 40.2,
    pairedTradeCount: 20,
    patternAdjustment: -penalty,
  });
  assert.ok(withoutRule.score !== null && withRule.score !== null);
  assert.ok(withRule.score < withoutRule.score);
});

test('canonical Copyability avoids hold-time saturation and directly penalizes fast activity', () => {
  const brokenCase = computeCopyabilityScore({
    medianHoldSeconds: 521,
    fastRoundTripPercent: 37.5,
    under15SecondPercent: 25.8,
    pairedTradeCount: 80,
  });
  assert.notEqual(brokenCase.score, 100);
  assert.equal(brokenCase.diagnostics.fastRoundTripPenalty, 13.1);
  assert.equal(brokenCase.diagnostics.under15SecondPenalty, 12.9);
  assert.equal(brokenCase.diagnostics.confidence, 'high');
  assert.ok(brokenCase.diagnostics.holdContribution !== null);
});

test('Copyability ordering is monotonic for hold time and fast activity', () => {
  const scoreFor = (holdSeconds: number, fastRoundTripPercent: number) =>
    computeCopyabilityScore({
      medianHoldSeconds: holdSeconds,
      fastRoundTripPercent,
      under15SecondPercent: 0,
      pairedTradeCount: 50,
    }).score!;
  assert.ok(scoreFor(7_200, 0) > scoreFor(600, 0));
  assert.ok(scoreFor(600, 0) > scoreFor(60, 0));
  assert.ok(scoreFor(60, 0) > scoreFor(20, 0));
  assert.ok(scoreFor(600, 5) > scoreFor(600, 30));
  assert.ok(scoreFor(600, 30) > scoreFor(600, 60));
});

test('direct fast-trading penalties remain active without Pattern Discovery rules', () => {
  const result = computeCopyabilityScore({
    medianHoldSeconds: 600,
    fastRoundTripPercent: 60,
    under15SecondPercent: 30,
    pairedTradeCount: 50,
    patternAdjustment: 0,
  });
  assert.ok(result.score !== null);
  assert.ok(result.diagnostics.fastRoundTripPenalty > 0);
  assert.ok(result.diagnostics.under15SecondPenalty > 0);
});

test('very small paired-trade samples are explicitly insufficient', () => {
  const result = computeCopyabilityScore({
    medianHoldSeconds: 7_200,
    fastRoundTripPercent: 0,
    under15SecondPercent: 0,
    pairedTradeCount: 2,
  });
  assert.equal(result.score, null);
  assert.equal(result.diagnostics.gate, 'insufficient_sample');
  assert.equal(result.diagnostics.confidence, 'insufficient');
  assert.equal(result.diagnostics.sampleSize.pairedTrades, 2);
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

test('Decision Lab keeps the selected horizon in the report and reads matching pattern rules', () => {
  const database = openDatabase(':memory:');
  try {
    const fingerprint = readPatternDiscoveryDataFingerprint(database);
    writePatternDiscoveryCache(
      database,
      patternDiscoveryCacheKey('sensitivity', 60, 50, 10, 500),
      fingerprint,
      {
        crossCoveragePromotedPatterns: [
          {
            pattern: {
              feature: 'prior_wallet_trade_count',
              effect: -4,
              conditions: [{ feature: 'prior_wallet_trade_count', operator: '>=', value: 100 }],
            },
            supportingCoveragePercent: [90, 95],
          },
        ],
      },
    );
    assert.deepEqual(readExperimentalDecisionPromotedRules(database, fingerprint, 60), {
      hyperactivityThresholds: [
        { feature: 'prior_wallet_trade_count', threshold: 100, effect: -4 },
      ],
      hyperactivityCorrelations: [],
      fastTradingCorrelations: [],
    });
    const report = computeExperimentalDecisionReport(database, { periodDays: 60 });
    assert.equal(report.periodDays, 60);
    assert.match(
      report.methodology[0] ?? '',
      /^All available saved GMGN history is evaluated through the shared point-in-time wallet feature engine;/,
    );
  } finally {
    database.close();
  }
});

test('REGRESSION: a wallet with incomplete component evidence never gets an overall score', () => {
  // A real production export showed 2-trade wallets scoring 100 overall -- tied for the top of
  // the leaderboard alongside wallets with a real track record. Overall remains unavailable when
  // a component input is missing; the legacy candidateStatus no longer adds a 100-trade gate.
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
    assert.notEqual(wallet.evidence.level, 'complete', 'only 2 trades cannot be complete evidence');
    assert.ok(wallet.scores.edge !== null && wallet.scores.consistency !== null);
    assert.equal(wallet.scores.copyability, null, 'Copyability requires a minimum paired sample');
    assert.equal(wallet.scores.overall, null, 'overall must not bypass the evidence-level gate');
    assert.notEqual(wallet.candidateStatus, 'eligible');
  } finally {
    database.close();
  }
});

test('Decision Lab never populates a Winner Policy risk bundle (Decision Lab is historical, not current-context)', () => {
  const database = openDatabase(':memory:');
  try {
    database
      .prepare(
        `INSERT INTO gmgn_wallet_rank_snapshots (window, orderby, captured_at, raw_payload, source_sha256)
         VALUES ('7d', 'pnl_30d', '2026-08-15T00:00:00.000Z', ?, 'sha-pit-check')`,
      )
      .run(JSON.stringify({ code: 0, data: { rank: [{ wallet_address: 'PIT', tags: [] }] } }));
    syncCopyTradeRoster(database);

    const now = new Date('2026-08-15T00:00:00.000Z');
    const base = Math.floor(now.getTime() / 1000) - 3 * 86_400;
    const trade = (over: Record<string, unknown>) =>
      storeActivityPage(
        database,
        [
          {
            wallet: 'PIT',
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

    const report = computeExperimentalDecisionReport(database);
    const wallet = report.wallets.find((entry) => entry.walletAddress === 'PIT');
    assert.ok(wallet);
    assert.equal(wallet.winnerPolicy.evidence.riskBundle, null);
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

test('readExperimentalDecisionWeighting still reads the period-30 cache key by default', () => {
  // Regression guard: adding an optional third `periodDays` parameter (for the Data-workflow
  // readiness caller, which passes a real period) must not change the default behavior of this
  // function's existing callers -- the production Decision Lab scoring path and Live Evaluation
  // both call it with no third argument and must keep reading period-30 evidence exactly as
  // before. Neither seeded report has a qualifying promoted pattern, so mode stays
  // neutral-fallback either way; supportingWallets is what actually proves which period was read.
  const database = openDatabase(':memory:');
  try {
    const fingerprint = readPatternDiscoveryDataFingerprint(database);
    writePatternDiscoveryCache(
      database,
      patternDiscoveryCacheKey('report', 30, 50, 10, 500),
      fingerprint,
      { dataset_summary: { wallets: 15 }, patterns: [] },
    );
    writePatternDiscoveryCache(
      database,
      patternDiscoveryCacheKey('report', 60, 50, 10, 500),
      fingerprint,
      { dataset_summary: { wallets: 99 }, patterns: [] },
    );
    const weighting = readExperimentalDecisionWeighting(database, fingerprint);
    assert.equal(weighting.mode, 'neutral-fallback');
    assert.equal(weighting.supportingWallets, 15, 'read the period-30 report, not period-60');
  } finally {
    database.close();
  }
});

test('readExperimentalDecisionWeighting reads the requested period when one is passed explicitly', () => {
  const database = openDatabase(':memory:');
  try {
    const fingerprint = readPatternDiscoveryDataFingerprint(database);
    writePatternDiscoveryCache(
      database,
      patternDiscoveryCacheKey('report', 30, 50, 10, 500),
      fingerprint,
      { dataset_summary: { wallets: 15 }, patterns: [] },
    );
    writePatternDiscoveryCache(
      database,
      patternDiscoveryCacheKey('report', 60, 50, 10, 500),
      fingerprint,
      { dataset_summary: { wallets: 99 }, patterns: [] },
    );
    const weighting = readExperimentalDecisionWeighting(database, fingerprint, 60);
    assert.equal(weighting.supportingWallets, 99, 'read the requested period-60 report, not 30');
  } finally {
    database.close();
  }
});
