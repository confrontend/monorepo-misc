import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateWinnerPolicy,
  WINNER_POLICY_VERSION,
  type GmgnRiskBundleEvidence,
  type WinnerPolicyActivitySignals,
  type WinnerPolicyEvidence,
} from '../src/copytrade/winnerPolicy.js';

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

const cleanActivitySignals: WinnerPolicyActivitySignals = {
  fastRoundTripPercent: 2,
  under15SecondsPercent: 0,
  medianHoldSeconds: 300,
  tradesPerActiveDay: 3,
  walletAgeDays: 365,
};

test('Winner Policy v2.1 reproduces the spec worked example (strong-but-risky wallet)', () => {
  const result = evaluateWinnerPolicy(evidence({ activitySignals: riskyActivitySignals }));
  assert.equal(result.policyVersion, WINNER_POLICY_VERSION);
  assert.equal(WINNER_POLICY_VERSION, 'winner-policy-v3');
  assert.equal(result.status, 'WINNER');
  assert.ok(result.profitabilityScore);
  assert.ok(result.gmgnRiskScore);
  assert.equal(result.profitabilityScore!.score, 63);
  assert.equal(result.gmgnRiskScore!.score, 20);
  assert.equal(result.finalScore, 83);
});

test('Winner Policy v2.1 rewards clean execution over risky execution at identical profitability', () => {
  const risky = evaluateWinnerPolicy(evidence({ activitySignals: riskyActivitySignals }));
  const clean = evaluateWinnerPolicy(evidence({ activitySignals: cleanActivitySignals }));
  assert.ok(clean.finalScore! > risky.finalScore!);
  assert.equal(clean.profitabilityScore!.score, risky.profitabilityScore!.score);
});

test('Winner Policy v2.1 rejects on a non-positive median despite excellent GMGN data', () => {
  const result = evaluateWinnerPolicy(
    evidence({ medianReturnPercent: -5, activitySignals: cleanActivitySignals }),
  );
  assert.equal(result.status, 'REJECTED');
  assert.ok(result.rejectionReasons.some((reason) => reason.includes('median')));
  assert.ok(result.profitabilityScore, 'scores remain visible on REJECTED so users can see how close a wallet was');
  assert.ok(result.gmgnRiskScore);
  assert.ok(typeof result.finalScore === 'number');
});

test('Winner Policy v2.1 rejects when the canonical portfolio does not end above $100', () => {
  const result = evaluateWinnerPolicy(evidence({ endingCapitalUsd: 100 }));
  assert.equal(result.status, 'REJECTED');
  assert.ok(result.rejectionReasons.some((reason) => reason.includes('$100')));
});

test('Winner Policy v2.1 is UNPROVEN below minimum evidence and reports no score', () => {
  const result = evaluateWinnerPolicy(evidence({ completedCopiedBuyOutcomes: 15 }));
  assert.equal(result.status, 'UNPROVEN');
  assert.equal(result.finalScore, null);
  assert.equal(result.profitabilityScore, null);
  assert.equal(result.gmgnRiskScore, null);
  assert.equal(result.proofGates.completedCopiedTrades.status, 'unproven');
});

test('Winner Policy v2.1 never treats a missing GMGN risk bundle as zero risk', () => {
  const result = evaluateWinnerPolicy(evidence({ riskBundle: null }));
  assert.equal(result.gmgnRiskScore!.deductions.tokenRisk, 0);
  assert.ok(result.warnings.some((warning) => warning.toLowerCase().includes('risk bundle')));
  assert.ok(!result.warnings.some((warning) => warning.toLowerCase().includes('safe')));
});

test('Winner Policy v2.1 always flags a missing honeypot ratio when a risk bundle is present', () => {
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

test('Winner Policy v2.1 caps the combined execution-speed penalty at its budget (worst-of, not summed)', () => {
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

test('Winner Policy v3 applies horizon-independent wallet-age maturity bands', () => {
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

test('Winner Policy v2.1 is identical between Decision Lab and Live Evaluation for identical evidence', () => {
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
