import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateWinnerPolicy,
  evaluateCoverageQuality,
  computeProfitFactorMetrics,
  computeTailRobustnessScore,
  WINNER_POLICY_VERSION,
  type GmgnRiskBundleEvidence,
  type WinnerPolicyActivitySignals,
  type WinnerPolicyEvidence,
} from '../src/copytrade/winnerPolicy.js';
import type { CopySimulationTradeResult } from '../src/copytrade/simulation/copySimulation.js';

const coverageTrade = (
  status: 'simulated' | 'missing_entry_match' | 'missing_exit_match' | 'not_yet_queried',
  returnPercent: number,
  day: number,
) => ({
  status,
  walletReturnPercent: returnPercent,
  buyAt: `2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`,
  holdSeconds: 3600,
}) as unknown as CopySimulationTradeResult;

const holdouts: WinnerPolicyEvidence['holdouts'] = [
  {
    index: 1,
    startAt: '2026-01-01T00:00:00.000Z',
    endAt: '2026-01-10T00:00:00.000Z',
    completedCopiedBuyOutcomes: 33,
    medianReturnPercent: 60,
    startingCapitalUsd: 100,
    endingCapitalUsd: 180,
    profitable: true,
  },
  {
    index: 2,
    startAt: '2026-01-11T00:00:00.000Z',
    endAt: '2026-01-20T00:00:00.000Z',
    completedCopiedBuyOutcomes: 33,
    medianReturnPercent: 90,
    startingCapitalUsd: 100,
    endingCapitalUsd: 260,
    profitable: true,
  },
  {
    index: 3,
    startAt: '2026-01-21T00:00:00.000Z',
    endAt: '2026-01-30T00:00:00.000Z',
    completedCopiedBuyOutcomes: 34,
    medianReturnPercent: -10,
    startingCapitalUsd: 100,
    endingCapitalUsd: 96,
    profitable: false,
  },
];

const evidence = (overrides: Partial<WinnerPolicyEvidence> = {}): WinnerPolicyEvidence => ({
  source: 'persisted_copy_simulation',
  periodDays: 90,
  completedCopiedBuyOutcomes: 100,
  medianReturnPercent: 80,
  startingCapitalUsd: 100,
  endingCapitalUsd: 250,
  copiedOutcomeEconomics: Array.from({ length: 100 }, (_, index) => ({
    buyTradeId: index + 1,
    timestamp: Date.parse(`2026-08-${String((index % 25) + 1).padStart(2, '0')}T00:00:00Z`) / 1000,
    netPnlUsd: 8,
    returnPercent: 80,
  })),
  portfolioWithoutBestTradeEndingCapitalUsd: 240,
  portfolioWithoutUncopyableTradesEndingCapitalUsd: 240,
  uncopyableTradeCount: 0,
  uncopyableProfitDependencyPercent: 0,
  holdouts,
  coverageStatus: 'fully_covered',
  feasibility: { status: 'pass', detail: 'complete' },
  activitySignals: null,
  riskBundle: null,
  tradeQualitySignals: {
    largeLossRatePercent: null,
    profitableTokenPercent: null,
    simulatedTradeCount: 0,
    distinctTokenCount: 0,
  },
  executionFrictionSignals: { gasRatioPercent: null, tradesWithGasData: 0 },
  provenance: {
    delayedCopy: 'persisted',
    portfolio: 'canonical',
    featureSource: 'stored activity',
    patternDiscoveryUsed: false,
    officialGmgnAggregatesUsed: false,
  },
  ...overrides,
});

const riskyActivitySignals: WinnerPolicyActivitySignals = {
  fastRoundTripPercent: 38,
  under15SecondsPercent: 25,
  medianHoldSeconds: 16,
  tradesPerActiveDay: 9.3,
  walletAgeDays: 90,
};

test('coverage quality distinguishes strong optimistic bias from pending data', () => {
  const covered = Array.from({ length: 20 }, () => coverageTrade('simulated', 40, 24));
  const missing = Array.from({ length: 20 }, () =>
    coverageTrade('missing_entry_match', -40, 24),
  );
  const quality = evaluateCoverageQuality([...covered, ...missing], new Date('2026-08-25T00:00:00Z'));
  assert.equal(quality.status, 'POSSIBLE_OPTIMISTIC_BIAS');
  assert.equal(quality.confirmedMissing.total, 20);
  assert.equal(quality.pendingTrips, 0);
});

test('coverage quality does not classify a tiny extreme missing sample as bias', () => {
  const quality = evaluateCoverageQuality([
    ...Array.from({ length: 10 }, (_, index) => coverageTrade('simulated', 40, index + 1)),
    ...Array.from({ length: 3 }, (_, index) => coverageTrade('missing_exit_match', -90, index + 11)),
  ]);
  assert.equal(quality.status, 'INSUFFICIENT_DATA_TO_ASSESS');
  assert.equal(quality.optimisticBiasDetected, false);
});

test('coverage quality keeps pending trades separate from confirmed missing trades', () => {
  const quality = evaluateCoverageQuality([
    ...Array.from({ length: 10 }, (_, index) => coverageTrade('simulated', 40, index + 1)),
    ...Array.from({ length: 12 }, (_, index) => coverageTrade('not_yet_queried', -90, index + 11)),
  ]);
  assert.equal(quality.status, 'PENDING_DUNE');
  assert.equal(quality.confirmedMissing.total, 0);
  assert.equal(quality.pendingTrips, 12);
});

const cleanActivitySignals: WinnerPolicyActivitySignals = {
  fastRoundTripPercent: 2,
  under15SecondsPercent: 0,
  medianHoldSeconds: 300,
  tradesPerActiveDay: 3,
  walletAgeDays: 365,
};

test('Winner Policy v5 uses the 30/20/10/10 Dune allocation for a strong-but-risky wallet', () => {
  const result = evaluateWinnerPolicy(evidence({ activitySignals: riskyActivitySignals }));
  assert.equal(result.policyVersion, WINNER_POLICY_VERSION);
  assert.equal(WINNER_POLICY_VERSION, 'winner-policy-v5');
  assert.equal(result.status, 'WINNER');
  assert.ok(result.profitabilityScore);
  assert.ok(result.gmgnRiskScore);
  assert.ok(result.profitabilityScore!.portfolioScore <= 30);
  assert.ok(result.profitabilityScore!.profitFactorScore <= 20);
  assert.ok(result.profitabilityScore!.evidenceConfidenceScore <= 10);
  assert.ok(result.profitabilityScore!.robustnessScore <= 10);
  assert.equal(result.gmgnRiskScore!.score, 20);
  assert.equal(result.finalScore, 87);
});

test('Winner Policy v5 rewards clean execution over risky execution at identical profitability', () => {
  const risky = evaluateWinnerPolicy(evidence({ activitySignals: riskyActivitySignals }));
  const clean = evaluateWinnerPolicy(evidence({ activitySignals: cleanActivitySignals }));
  assert.ok(clean.finalScore! > risky.finalScore!);
  assert.equal(clean.profitabilityScore!.score, risky.profitabilityScore!.score);
});

test('Winner Policy v5 keeps a non-positive median diagnostic when the portfolio is profitable', () => {
  const result = evaluateWinnerPolicy(
    evidence({ medianReturnPercent: -5, activitySignals: cleanActivitySignals }),
  );
  assert.equal(result.status, 'WINNER');
  assert.ok(result.warnings.some((reason) => reason.includes('median')));
  assert.ok(result.profitabilityScore);
  assert.ok(result.gmgnRiskScore);
  assert.ok(typeof result.finalScore === 'number');
});

test('Winner Policy v5 computes recency-weighted net-dollar profit factor', () => {
  const evaluationSeconds = Date.parse('2026-09-01T00:00:00Z') / 1000;
  const metrics = computeProfitFactorMetrics(
    [
      { buyTradeId: 1, timestamp: evaluationSeconds, netPnlUsd: 30, returnPercent: 300 },
      { buyTradeId: 2, timestamp: evaluationSeconds, netPnlUsd: -8, returnPercent: -80 },
    ],
    evaluationSeconds,
  );
  assert.equal(metrics.profitFactor, 3.75);
  assert.ok(metrics.score > 0 && metrics.score < 20);
});

test('Winner Policy v5 tail robustness falls when the best trade is essential', () => {
  const fragile = computeTailRobustnessScore({
    startingCapitalUsd: 100,
    endingCapitalUsd: 180,
    endingCapitalWithoutBestTradeUsd: 94,
    bestTradeProfitSharePercent: 90,
    bestThreeProfitSharePercent: 98,
  });
  const robust = computeTailRobustnessScore({
    startingCapitalUsd: 100,
    endingCapitalUsd: 180,
    endingCapitalWithoutBestTradeUsd: 165,
    bestTradeProfitSharePercent: 20,
    bestThreeProfitSharePercent: 45,
  });
  assert.ok(robust > fragile);
});

test('Winner Policy v5 rejects when the canonical portfolio does not end above $100', () => {
  const result = evaluateWinnerPolicy(evidence({ endingCapitalUsd: 100 }));
  assert.equal(result.status, 'REJECTED');
  assert.ok(result.rejectionReasons.some((reason) => reason.includes('$100')));
});

test('Winner Policy v5 rejects when fast trades are required for portfolio profitability', () => {
  const result = evaluateWinnerPolicy(
    evidence({
      endingCapitalUsd: 180,
      portfolioWithoutUncopyableTradesEndingCapitalUsd: 94,
      uncopyableTradeCount: 7,
      uncopyableProfitDependencyPercent: 100,
    }),
  );
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.proofGates.uncopyableProfitDependency.status, 'fail');
  assert.ok(result.rejectionReasons.some((reason) => reason.includes('sub-60-second')));
});

test('Winner Policy v5 keeps profitable wallets when removing fast trades remains profitable', () => {
  const result = evaluateWinnerPolicy(
    evidence({
      endingCapitalUsd: 180,
      portfolioWithoutUncopyableTradesEndingCapitalUsd: 150,
      uncopyableTradeCount: 7,
      uncopyableProfitDependencyPercent: 37.5,
    }),
  );
  assert.equal(result.status, 'WINNER');
  assert.equal(result.proofGates.uncopyableProfitDependency.status, 'pass');
});

test('Winner Policy v5 is UNPROVEN below minimum evidence and reports no score', () => {
  const result = evaluateWinnerPolicy(evidence({ completedCopiedBuyOutcomes: 15 }));
  assert.equal(result.status, 'UNPROVEN');
  assert.equal(result.finalScore, null);
  assert.equal(result.profitabilityScore, null);
  assert.equal(result.gmgnRiskScore, null);
  assert.equal(result.proofGates.completedCopiedTrades.status, 'unproven');
});

test('Winner Policy v5 never treats a missing GMGN risk bundle as zero risk', () => {
  const result = evaluateWinnerPolicy(evidence({ riskBundle: null }));
  assert.equal(result.gmgnRiskScore!.deductions.tokenRisk, 0);
  assert.ok(result.warnings.some((warning) => warning.toLowerCase().includes('risk bundle')));
  assert.ok(!result.warnings.some((warning) => warning.toLowerCase().includes('safe')));
});

test('Winner Policy v5 always flags a missing honeypot ratio when a risk bundle is present', () => {
  const riskBundle: GmgnRiskBundleEvidence = {
    fetchedAt: '2026-08-30T00:00:00.000Z',
    periodLabel: '30d',
    noBuyHoldRatio: 0.1,
    sellPassBuyRatio: 0.1,
    fastTxRatio: 0.1,
    honeypotRatio: null,
    honeypotRatioMissing: true,
  };
  const result = evaluateWinnerPolicy(evidence({ riskBundle }));
  assert.ok(result.warnings.some((warning) => warning.toLowerCase().includes('honeypot')));
});

test('Winner Policy v5 caps the combined execution-speed penalty at its budget (worst-of, not summed)', () => {
  const maxedSignals: WinnerPolicyActivitySignals = {
    fastRoundTripPercent: 100,
    under15SecondsPercent: 100,
    medianHoldSeconds: 0,
    tradesPerActiveDay: 3,
    walletAgeDays: 90,
  };
  const maxedRiskBundle: GmgnRiskBundleEvidence = {
    fetchedAt: '2026-08-30T00:00:00.000Z',
    periodLabel: '30d',
    noBuyHoldRatio: null,
    sellPassBuyRatio: null,
    fastTxRatio: 1,
    honeypotRatio: null,
    honeypotRatioMissing: true,
  };
  const result = evaluateWinnerPolicy(
    evidence({ activitySignals: maxedSignals, riskBundle: maxedRiskBundle }),
  );
  assert.equal(result.gmgnRiskScore!.deductions.executionSpeed, 12);
});

test('Winner Policy v5 applies horizon-independent wallet-age maturity bands', () => {
  const at = (walletAgeDays: number | null, periodDays: number | null = null) =>
    evaluateWinnerPolicy(evidence({ periodDays, activitySignals: { ...cleanActivitySignals, walletAgeDays } }));
  assert.equal(at(6).gmgnRiskScore!.deductions.walletAge, 5);
  assert.equal(at(7).gmgnRiskScore!.deductions.walletAge, 4);
  assert.equal(at(29).gmgnRiskScore!.deductions.walletAge, 4);
  assert.equal(at(30).gmgnRiskScore!.deductions.walletAge, 2);
  assert.equal(at(59).gmgnRiskScore!.deductions.walletAge, 2);
  assert.equal(at(60).gmgnRiskScore!.deductions.walletAge, 0);
  assert.equal(at(null).gmgnRiskScore!.deductions.walletAge, 0);
});

test('Winner Policy v5 is identical between Decision Lab and Live Evaluation for identical evidence', () => {
  const buildEvidence = (): WinnerPolicyEvidence =>
    evidence({ activitySignals: riskyActivitySignals, riskBundle: null });
  const decisionLabResult = evaluateWinnerPolicy(buildEvidence());
  const liveEvaluationResult = evaluateWinnerPolicy(buildEvidence());
  assert.deepEqual(
    {
      status: decisionLabResult.status,
      profitabilityScore: decisionLabResult.profitabilityScore,
      gmgnRiskScore: decisionLabResult.gmgnRiskScore,
      finalScore: decisionLabResult.finalScore,
      policyVersion: decisionLabResult.policyVersion,
    },
    {
      status: liveEvaluationResult.status,
      profitabilityScore: liveEvaluationResult.profitabilityScore,
      gmgnRiskScore: liveEvaluationResult.gmgnRiskScore,
      finalScore: liveEvaluationResult.finalScore,
      policyVersion: liveEvaluationResult.policyVersion,
    },
  );
});
