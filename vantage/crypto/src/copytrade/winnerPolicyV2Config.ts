/**
 * Every threshold, weight, and curve parameter for Winner Policy v2, centralized so nothing is a
 * scattered magic number and the whole scoring model can be recalibrated from one place. These
 * are starting design constraints, not statistically optimal weights -- see progress.md for the
 * v2 implementation write-up and its stated limitations.
 */
export const WINNER_POLICY_V2_CONFIG = Object.freeze({
  policyVersion: 'winner-policy-v2' as const,

  minimumCompletedCopiedTrades: 20,
  profitabilityWeight: 70,
  gmgnRiskWeight: 30,

  medianReturnMaxPoints: 30,
  portfolioReturnMaxPoints: 25,
  confidenceMaxPoints: 15,

  maxExecutionSpeedPenalty: 15,
  maxHyperactivityPenalty: 4,
  maxTradeQualityPenalty: 5,
  maxTokenRiskPenalty: 4,
  maxCostPenalty: 2,

  // Profitability curves: score = maxPoints * (1 - e^(-k * max(0, x))) -- gradual, capped, and
  // resistant to one extreme value dominating (median return is already outlier-resistant by
  // construction; the curve itself also saturates rather than growing unbounded).
  medianReturnCurveK: 0.022, // 45% -> 18.9pts, 80% -> 24.8pts, asymptotic -> 30pts
  portfolioReturnCurveK: 0.022, // same shape, applied to (ending-starting)/starting as a percent
  confidenceVolumeCurveK: 0.0347, // n=20 -> 7.5pts, n=21 -> 7.76pts, n=200 -> 14.99pts
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
