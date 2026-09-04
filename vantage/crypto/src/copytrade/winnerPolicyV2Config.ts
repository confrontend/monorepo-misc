/**
 * Every threshold, weight, and curve parameter for Winner Policy v2, centralized so nothing is a
 * scattered magic number and the whole scoring model can be recalibrated from one place. These
 * are starting design constraints, not statistically optimal weights -- see progress.md for the
 * v2 implementation write-up and its stated limitations.
 */
export const WINNER_POLICY_V2_CONFIG = Object.freeze({
  policyVersion: 'winner-policy-v5' as const,
  recencyHalfLifeDays: 45,

  minimumCompletedCopiedTrades: 20,
  profitabilityWeight: 70,
  gmgnRiskWeight: 30,

  portfolioReturnMaxPoints: 30,
  profitFactorMaxPoints: 20,
  confidenceMaxPoints: 10,
  robustnessMaxPoints: 10,
  profitFactorCurveK: 0.8,
  profitFactorCalculationCap: 5,
  robustnessBestTradePoints: 3,
  robustnessTopThreePoints: 2,
  robustnessLeaveOneOutPoints: 5,
  robustnessBestTradeFullAtShare: 0.3,
  robustnessBestTradeZeroAtShare: 0.8,
  robustnessTopThreeFullAtShare: 0.6,
  robustnessTopThreeZeroAtShare: 0.95,

  maxExecutionSpeedPenalty: 12,
  maxHyperactivityPenalty: 3,
  maxTradeQualityPenalty: 4,
  maxTokenRiskPenalty: 4,
  maxCostPenalty: 2,
  maxWalletAgePenalty: 5,

  // Coverage-quality protection: pending work is distinct from confirmed Dune no-matches.
  coverageBiasMinimumConfirmedMissing: 10,
  coverageBiasConfirmationGapPercent: 10,
  coverageBiasConservativeGapPercent: 30,
  coverageBiasGapTiers: [
    { effectiveMissingN: 10, requiredMedianGap: 30 },
    { effectiveMissingN: 100, requiredMedianGap: 20 },
    { effectiveMissingN: 1000, requiredMedianGap: 10 },
  ],
  coveragePendingMaterialMinimum: 10,
  coveragePendingMaterialShare: 0.2,

  // Profitability curves: score = maxPoints * (1 - e^(-k * max(0, x))) -- gradual, capped, and
  // resistant to one extreme value dominating (median return is already outlier-resistant by
  // construction; the curve itself also saturates rather than growing unbounded).
  portfolioReturnCurveK: 0.022, // same shape, applied to (ending-starting)/starting as a percent
  confidenceVolumeCurveK: 0.0347, // n=20 -> 5pts, n=21 -> 5.17pts, n=200 -> ~10pts
  confidenceQualityMultiplier: {
    fully_covered: 1.0,
    partially_covered: 0.75,
    small_sample: 0.6,
    missing_local_history: 0.5,
    no_dune_match: 0.4,
    unavailable: 0.5,
  } as Record<string, number>,

  // Execution-speed combined penalty: worst-of the overlapping speed signals, mapped once to the
  // shared budget, so fast-round-trip%, under-15s%, short median hold, and the risk bundle's
  // fast_tx_ratio (all describing the same "how fast is this wallet's execution" behavior) never
  // stack into independent penalties for the same thing.
  executionSpeedHoldSecondsZeroRiskAt: 60, // matches evaluate.ts's own FAST_ROUND_TRIP_SECONDS

  hyperactivityBaselineTradesPerActiveDay: 5,
  hyperactivityCurveK: 0.0667,

  // Trade quality: newly derived signals (never fetched -- computed from already-stored trades).
  largeLossReturnThresholdPercent: -50,
  largeLossRateFullPenaltyAt: 0.35, // fraction of simulated round trips at/below the threshold
  largeLossMaxSubPenalty: 3,
  profitableTokenFullPenaltyBelow: 0.4, // fraction of distinct tokens net-profitable
  profitableTokenMaxSubPenalty: 2,
  minSimulatedTradesForTradeQuality: 5,
  minDistinctTokensForTradeQuality: 3,

  // Token/risk flags: from the optional, current-only Chrome-extension risk bundle. fast_tx_ratio
  // is deliberately excluded here (folded into execution speed instead) to avoid double-counting.
  noBuyHoldFullPenaltyAt: 0.5,
  sellPassBuyFullPenaltyAt: 0.5,
  noBuyHoldMaxSubPenalty: 2,
  sellPassBuyMaxSubPenalty: 2,

  // Costs / execution friction.
  gasRatioFullPenaltyAtPercent: 5,
} as const);
