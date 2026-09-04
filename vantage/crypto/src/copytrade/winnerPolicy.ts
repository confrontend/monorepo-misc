/**
 * The single authoritative winner policy shared by Decision Lab and Live Evaluation.
 *
 * This module is deliberately pure. Provider clients, GMGN aggregates, Pattern Discovery, and
 * UI-specific score models must adapt their saved evidence into WinnerPolicyEvidence before this
 * function is called. That keeps “winner” proof stable and reviewable across both consumers.
 *
 * v5 philosophy: the chronological Dune portfolio proves profitability while net-dollar profit
 * factor and tail robustness describe asymmetric edge (70% total). GMGN execution/risk data only
 * discounts that already-proven profitability (30%) and never grants winner status on its own.
 */

import type {
  CopySimulationTradeResult,
  CopySimulationWalletReport,
} from './simulation/copySimulation.js';
import { median } from './scrutiny/evaluate.js';
import { WINNER_POLICY_V2_CONFIG } from './winnerPolicyV2Config.js';
import { UNCOPYABLE_TRADE_MAX_HOLD_SECONDS } from './simulation/constants.js';

export const WINNER_POLICY_VERSION = WINNER_POLICY_V2_CONFIG.policyVersion;
export const WINNER_POLICY_STARTING_CAPITAL_USD = 100;
export const WINNER_POLICY_MIN_COMPLETED_COPIED_BUYS =
  WINNER_POLICY_V2_CONFIG.minimumCompletedCopiedTrades;
export const WINNER_POLICY_RECENCY_HALF_LIFE_DAYS = WINNER_POLICY_V2_CONFIG.recencyHalfLifeDays;
/** Kept for the evidence builder, which still computes 3 chronological holdout windows for
 *  "Historical stability" display context -- v2 no longer gates WINNER status on them. */
export const WINNER_POLICY_HOLDOUT_WINDOWS = 3;

export type WinnerPolicyStatus = 'WINNER' | 'REJECTED' | 'UNPROVEN';
export type WinnerPolicyGateStatus = 'pass' | 'fail' | 'unproven' | 'warning';

export type WinnerPolicyHoldout = {
  index: number;
  startAt: string | null;
  endAt: string | null;
  completedCopiedBuyOutcomes: number;
  medianReturnPercent: number | null;
  startingCapitalUsd: number;
  endingCapitalUsd: number | null;
  profitable: boolean | null;
};

/** Wallet-native execution-speed/activity signals -- not on CopySimulationWalletReport, so each
 *  call site (Decision Lab, Live Evaluation) supplies these from whatever it already reads. */
export type WinnerPolicyActivitySignals = {
  fastRoundTripPercent: number | null;
  under15SecondsPercent: number | null;
  medianHoldSeconds: number | null;
  tradesPerActiveDay: number | null;
  walletAgeDays: number | null;
};

/** Adapted from the optional, current-only Chrome-extension GMGN risk-bundle import
 *  (copytrade_gmgn_risk_stats). Never populated for a historical Decision Lab evaluation -- an
 *  upsert-only current snapshot cannot be retroactively valid for a past evaluation window. */
export type GmgnRiskBundleEvidence = {
  fetchedAt: string;
  periodLabel: '30d';
  noBuyHoldRatio: number | null;
  sellPassBuyRatio: number | null;
  fastTxRatio: number | null;
  /** Never parsed from any known GMGN response by this codebase -- always null. Kept as an
   *  explicit field (rather than omitted) so "missing" is a visible fact, not an absence. */
  honeypotRatio: null;
  honeypotRatioMissing: true;
};

export type WinnerPolicyTradeQualitySignals = {
  largeLossRatePercent: number | null;
  profitableTokenPercent: number | null;
  simulatedTradeCount: number;
  distinctTokenCount: number;
};

export type WinnerPolicyExecutionFrictionSignals = {
  gasRatioPercent: number | null;
  tradesWithGasData: number;
};

export type WinnerPolicyEvidence = {
  source: 'persisted_copy_simulation';
  periodDays: number | null;
  recency?: {
    halfLifeDays: number;
    evaluationTimestamp: string;
    oldestEvidenceTimestamp: string | null;
    newestEvidenceTimestamp: string | null;
  };
  completedCopiedBuyOutcomes: number;
  medianReturnPercent: number | null;
  recencyWeightedMedianReturnPercent?: number | null;
  startingCapitalUsd: number;
  endingCapitalUsd: number | null;
  capitalPath?: { day: string; capitalUsd: number }[];
  copiedOutcomeEconomics?: Array<{
    buyTradeId: number;
    timestamp: number;
    netPnlUsd: number;
    returnPercent: number;
  }>;
  portfolioWithoutBestTradeEndingCapitalUsd?: number | null;
  portfolioWithoutUncopyableTradesEndingCapitalUsd?: number | null;
  uncopyableTradeCount?: number;
  uncopyableProfitDependencyPercent?: number | null;
  holdouts: WinnerPolicyHoldout[];
  coverageStatus: CopySimulationWalletReport['coverageStatus'] | null;
  feasibility:
    | { status: 'pass' | 'warning' | 'fail'; detail: string }
    | { status: 'unavailable'; detail: string };
  activitySignals: WinnerPolicyActivitySignals | null;
  riskBundle: GmgnRiskBundleEvidence | null;
  tradeQualitySignals: WinnerPolicyTradeQualitySignals;
  executionFrictionSignals: WinnerPolicyExecutionFrictionSignals;
  coverageQuality?: CoverageQuality;
  provenance: {
    delayedCopy: string;
    portfolio: string;
    featureSource: string;
    patternDiscoveryUsed: false;
    officialGmgnAggregatesUsed: false;
  };
};

export type CoverageQualityStatus =
  | 'GOOD_COVERAGE_NO_OBVIOUS_BIAS'
  | 'PARTIAL_COVERAGE_MISSING_SET_SIMILAR'
  | 'POSSIBLE_OPTIMISTIC_BIAS'
  | 'POSSIBLE_CONSERVATIVE_BIAS'
  | 'INCOMPLETE_COVERAGE_REQUIRES_REVIEW'
  | 'INSUFFICIENT_DATA_TO_ASSESS'
  | 'PENDING_DUNE';
export type OperationalDuneEvidenceStatus = 'PENDING' | 'GOOD' | 'REVIEW' | 'UNPROVEN';

export type CoveragePerformance = {
  count: number;
  effectiveSampleSize: number;
  medianReturn: number | null;
  weightedMedianReturn: number | null;
  winRate: number | null;
  lossRate: number | null;
  largeLossRate: number | null;
  bigWinnerRate: number | null;
  medianHoldSeconds: number | null;
  fastRoundTripRate: number | null;
};

export type CoverageQuality = {
  status: CoverageQualityStatus;
  operationalStatus: OperationalDuneEvidenceStatus;
  eligibleTrips: number;
  simulatedTrips: number;
  confirmedMissing: { total: number; missingEntry: number; missingExit: number };
  pendingTrips: number;
  coveragePercent: number | null;
  coveredNativePerformance: CoveragePerformance;
  missingNativePerformance: CoveragePerformance;
  differences: {
    medianReturnGap: number | null;
    weightedMedianReturnGap: number | null;
    winRateGap: number | null;
    lossRateGap: number | null;
    largeLossRateGap: number | null;
  };
  sufficientSampleForBiasTest: boolean;
  optimisticBiasDetected: boolean;
  reason: string;
  missingTradeMateriality: {
    applicable: boolean;
    missingCount: number;
    severity: 'LOW' | 'MODERATE' | 'HIGH';
    concerningTrades: number;
    worstNativeReturn: number | null;
    aggregateInterpretation: string;
  };
};

export type WinnerPolicyGate = {
  key: 'evidence' | 'delayed_copy_median' | 'canonical_portfolio' | 'feasibility';
  label: string;
  status: WinnerPolicyGateStatus;
  detail: string;
};

export type WinnerPolicyProofGateStatus = 'pass' | 'fail' | 'unproven';
export type WinnerPolicyProofGate = { status: WinnerPolicyProofGateStatus; detail: string };
export type WinnerPolicyProofGates = {
  completedCopiedTrades: WinnerPolicyProofGate;
  simulatedPortfolioPositive: WinnerPolicyProofGate;
  duneEvidenceActionable: WinnerPolicyProofGate;
  uncopyableProfitDependency: WinnerPolicyProofGate;
};

export type WinnerPolicyProfitabilityScore = {
  score: number;
  max: number;
  portfolioScore: number;
  profitFactorScore: number;
  evidenceConfidenceScore: number;
  robustnessScore: number;
  weightedProfitFactor: number | null;
  bestTradeProfitSharePercent: number | null;
  bestThreeProfitSharePercent: number | null;
  portfolioWithoutBestTradeEndingCapitalUsd: number | null;
};

export type WinnerPolicyGmgnRiskScore = {
  score: number;
  max: number;
  walletAgeDays: number | null;
  deductions: {
    executionSpeed: number;
    hyperactivity: number;
    tradeQuality: number;
    tokenRisk: number;
    costs: number;
    walletAge: number;
  };
  deductionDetails: {
    executionSpeed: string;
    hyperactivity: string;
    tradeQuality: string;
    tokenRisk: string;
    costs: string;
    walletAge: string;
  };
};

export type WinnerPolicyResult = {
  policyVersion: typeof WINNER_POLICY_VERSION;
  status: WinnerPolicyStatus;
  /** Operational Dune evidence state; kept separate from the profitability proof status. */
  duneEvidenceStatus: OperationalDuneEvidenceStatus;
  /** Review evidence keeps the proof visible but prevents automatic selection. */
  actionability: 'ACTIONABLE' | 'REVIEW' | 'NOT_ACTIONABLE';
  finalScore: number | null;
  proofGates: WinnerPolicyProofGates;
  profitabilityScore: WinnerPolicyProfitabilityScore | null;
  gmgnRiskScore: WinnerPolicyGmgnRiskScore | null;
  gates: WinnerPolicyGate[];
  positiveReasons: string[];
  rejectionReasons: string[];
  unprovenReasons: string[];
  warnings: string[];
  evidence: WinnerPolicyEvidence;
};

const gate = (
  key: WinnerPolicyGate['key'],
  label: string,
  status: WinnerPolicyGateStatus,
  detail: string,
): WinnerPolicyGate => ({ key, label, status, detail });

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));
const clamp01 = (value: number): number => clamp(value, 0, 1);
const round2 = (value: number): number => Math.round(value * 100) / 100;
/** Whole-point rounding for the 3 top-level totals (profitabilityScore.score, gmgnRiskScore.score,
 *  finalScore) -- these are the "63/70", "18/30", "81/100" numbers shown to users, so they round
 *  to whole points; sub-component breakdowns keep round2 precision for detail display. */
const roundScore = (value: number): number => Math.round(value);

const roundMetric = (value: number): number => Math.round(value * 100) / 100;

const signalText = (label: string, value: number | null, suffix = ''): string =>
  value === null ? `${label}: unavailable` : `${label}: ${value.toFixed(1)}${suffix}`;

const buildGmgnDeductionDetails = (args: {
  activitySignals: WinnerPolicyActivitySignals | null;
  riskBundle: GmgnRiskBundleEvidence | null;
  tradeQuality: WinnerPolicyTradeQualitySignals;
  gasRatioPercent: number | null;
  deductions: WinnerPolicyGmgnRiskScore['deductions'];
}): WinnerPolicyGmgnRiskScore['deductionDetails'] => {
  const { activitySignals, riskBundle, tradeQuality, gasRatioPercent, deductions } = args;
  const speedSignals = activitySignals
    ? [
        signalText('fast round trips', activitySignals.fastRoundTripPercent, '%'),
        signalText('under-15s trades', activitySignals.under15SecondsPercent, '%'),
        signalText('median hold', activitySignals.medianHoldSeconds, 's'),
        signalText(
          'GMGN fast transactions',
          riskBundle?.fastTxRatio === null || !riskBundle ? null : riskBundle.fastTxRatio * 100,
          '%',
        ),
      ]
    : ['execution-speed signals: unavailable'];
  return {
    executionSpeed:
      deductions.executionSpeed > 0
        ? `${speedSignals.join(' · ')}; highest applicable speed signal produced −${deductions.executionSpeed} of 12.`
        : `${speedSignals.join(' · ')}; no speed deduction applied.`,
    hyperactivity:
      activitySignals?.tradesPerActiveDay === null || !activitySignals
        ? 'Trades per active day: unavailable; no hyperactivity deduction applied.'
        : `${activitySignals.tradesPerActiveDay.toFixed(1)} trades per active day; −${deductions.hyperactivity} of 3.`,
    tradeQuality:
      tradeQuality.largeLossRatePercent === null && tradeQuality.profitableTokenPercent === null
        ? 'Large-loss and profitable-token rates: unavailable; no trade-quality deduction applied.'
        : `${signalText('large-loss rate', tradeQuality.largeLossRatePercent, '%')} · ${signalText('profitable-token rate', tradeQuality.profitableTokenPercent, '%')} · −${deductions.tradeQuality} of 4.`,
    tokenRisk: !riskBundle
      ? 'GMGN risk bundle unavailable; no token-risk deduction applied.'
      : `${signalText('no-buy/hold', riskBundle.noBuyHoldRatio === null ? null : riskBundle.noBuyHoldRatio * 100, '%')} · ${signalText('sell>buy', riskBundle.sellPassBuyRatio === null ? null : riskBundle.sellPassBuyRatio * 100, '%')} · −${deductions.tokenRisk} of 4.`,
    costs:
      gasRatioPercent === null
        ? 'Gas/fee ratio: unavailable; no cost deduction applied.'
        : `Gas/fee ratio: ${gasRatioPercent.toFixed(1)}%; −${deductions.costs} of 2.`,
    walletAge:
      activitySignals?.walletAgeDays === null || !activitySignals
        ? 'Wallet age: unavailable; no maturity deduction applied.'
        : `Wallet age: ${activitySignals.walletAgeDays.toFixed(1)} days; −${deductions.walletAge} of 5.`,
  };
};
const parseTradeTimestamp = (value: string): number | null => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 1000 : null;
};

/** Shared v3 decay primitive used by profitability and coverage-quality comparisons. */
export const computeRecencyWeightedMedian = (
  values: readonly { value: number; timestamp: number }[],
  evaluationSeconds: number,
): number | null => {
  if (!values.length) return null;
  const ordered = values
    .map((item) => ({
      value: item.value,
      weight: Math.pow(
        0.5,
        Math.max(0, evaluationSeconds - item.timestamp) /
          86_400 /
          WINNER_POLICY_RECENCY_HALF_LIFE_DAYS,
      ),
    }))
    .sort((a, b) => a.value - b.value);
  const total = ordered.reduce((sum, item) => sum + item.weight, 0);
  let cumulative = 0;
  for (const item of ordered) {
    cumulative += item.weight;
    if (cumulative >= total / 2) return item.value;
  }
  return ordered[ordered.length - 1]?.value ?? null;
};

const coveragePerformance = (
  trades: readonly CopySimulationTradeResult[],
  evaluationSeconds: number,
): CoveragePerformance => {
  const observed = trades.flatMap((trade) => {
    const value = trade.walletReturnPercent;
    const timestamp = trade.buyAt ? parseTradeTimestamp(trade.buyAt) : null;
    return value !== null && timestamp !== null && trade.holdSeconds !== undefined
      ? [{ trade, value, timestamp }]
      : [];
  });
  const rate = (predicate: (item: (typeof observed)[number]) => boolean): number | null =>
    observed.length
      ? roundMetric((observed.filter(predicate).length / observed.length) * 100)
      : null;
  const holds = observed.map((item) => item.trade.holdSeconds as number).sort((a, b) => a - b);
  const weights = observed.map((item) =>
    Math.pow(
      0.5,
      Math.max(0, evaluationSeconds - item.timestamp) /
        86_400 /
        WINNER_POLICY_RECENCY_HALF_LIFE_DAYS,
    ),
  );
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const effectiveSampleSize =
    weightTotal > 0
      ? roundMetric(
          (weightTotal * weightTotal) / weights.reduce((sum, weight) => sum + weight * weight, 0),
        )
      : 0;
  const middle = holds.length ? Math.floor(holds.length / 2) : 0;
  return {
    count: observed.length,
    effectiveSampleSize,
    medianReturn: observed.length ? roundMetric(median(observed.map((item) => item.value))!) : null,
    weightedMedianReturn: computeRecencyWeightedMedian(
      observed.map((item) => ({ value: item.value, timestamp: item.timestamp })),
      evaluationSeconds,
    ),
    winRate: rate((item) => item.value > 0),
    lossRate: rate((item) => item.value < 0),
    largeLossRate: rate(
      (item) => item.value <= WINNER_POLICY_V2_CONFIG.largeLossReturnThresholdPercent,
    ),
    bigWinnerRate: rate((item) => item.value > 50),
    medianHoldSeconds: holds.length
      ? holds.length % 2
        ? (holds[middle] ?? null)
        : roundMetric(((holds[middle - 1] ?? 0) + (holds[middle] ?? 0)) / 2)
      : null,
    fastRoundTripRate: rate(
      (item) => (item.trade.holdSeconds ?? Infinity) <= UNCOPYABLE_TRADE_MAX_HOLD_SECONDS,
    ),
  };
};

/** Classifies Dune coverage without treating pending queries as confirmed misses. */
export const evaluateCoverageQuality = (
  trades: readonly CopySimulationTradeResult[],
  evaluationTimestamp: Date = new Date(),
): CoverageQuality => {
  const covered = trades.filter((trade) => trade.status === 'simulated');
  const confirmedMissing = trades.filter(
    (trade) => trade.status === 'missing_entry_match' || trade.status === 'missing_exit_match',
  );
  const pendingTrips = trades.filter((trade) => trade.status === 'not_yet_queried').length;
  const evaluationSeconds = Math.floor(evaluationTimestamp.getTime() / 1000);
  const coveredNativePerformance = coveragePerformance(covered, evaluationSeconds);
  const missingNativePerformance = coveragePerformance(confirmedMissing, evaluationSeconds);
  const diff = (a: number | null, b: number | null): number | null =>
    a !== null && b !== null ? roundMetric(b - a) : null;
  const differences = {
    medianReturnGap: diff(
      coveredNativePerformance.medianReturn,
      missingNativePerformance.medianReturn,
    ),
    weightedMedianReturnGap: diff(
      coveredNativePerformance.weightedMedianReturn,
      missingNativePerformance.weightedMedianReturn,
    ),
    winRateGap: diff(coveredNativePerformance.winRate, missingNativePerformance.winRate),
    lossRateGap: diff(coveredNativePerformance.lossRate, missingNativePerformance.lossRate),
    largeLossRateGap: diff(
      coveredNativePerformance.largeLossRate,
      missingNativePerformance.largeLossRate,
    ),
  };
  const sufficientSampleForBiasTest =
    missingNativePerformance.effectiveSampleSize >=
      WINNER_POLICY_V2_CONFIG.coverageBiasMinimumConfirmedMissing &&
    coveredNativePerformance.effectiveSampleSize >=
      WINNER_POLICY_V2_CONFIG.coverageBiasMinimumConfirmedMissing;
  const positiveSignals = [
    differences.weightedMedianReturnGap,
    differences.lossRateGap,
    differences.largeLossRateGap,
  ];
  const requiredMedianGap =
    [...WINNER_POLICY_V2_CONFIG.coverageBiasGapTiers]
      .reverse()
      .find((tier) => missingNativePerformance.effectiveSampleSize >= tier.effectiveMissingN)
      ?.requiredMedianGap ?? 30;
  const medianGapTriggers =
    differences.weightedMedianReturnGap !== null &&
    differences.weightedMedianReturnGap <= -requiredMedianGap;
  const confirmingDeterioration = [differences.lossRateGap, differences.largeLossRateGap].some(
    (gap) => gap !== null && gap >= WINNER_POLICY_V2_CONFIG.coverageBiasConfirmationGapPercent,
  );
  const optimisticBiasDetected =
    sufficientSampleForBiasTest && medianGapTriggers && confirmingDeterioration;
  const conservativeBiasDetected =
    sufficientSampleForBiasTest &&
    positiveSignals.every(
      (gap) => gap === null || gap >= WINNER_POLICY_V2_CONFIG.coverageBiasConservativeGapPercent,
    );
  const pendingMaterial =
    pendingTrips >= WINNER_POLICY_V2_CONFIG.coveragePendingMaterialMinimum &&
    pendingTrips / Math.max(1, trades.length) >=
      WINNER_POLICY_V2_CONFIG.coveragePendingMaterialShare;
  const missingReturns = confirmedMissing
    .map((trade) => trade.walletReturnPercent)
    .filter((value): value is number => value !== null);
  const concerningTrades = missingReturns.filter((value) => value <= -50).length;
  const worstNativeReturn = missingReturns.length ? Math.min(...missingReturns) : null;
  const materialitySeverity: 'LOW' | 'MODERATE' | 'HIGH' =
    concerningTrades >= 2 || (concerningTrades >= 1 && coveredNativePerformance.count < 50)
      ? 'HIGH'
      : worstNativeReturn !== null && worstNativeReturn <= -30
        ? 'MODERATE'
        : 'LOW';
  const missingTradeMateriality = {
    applicable: !sufficientSampleForBiasTest && confirmedMissing.length > 0,
    missingCount: confirmedMissing.length,
    severity: materialitySeverity,
    concerningTrades,
    worstNativeReturn,
    aggregateInterpretation:
      materialitySeverity === 'HIGH'
        ? 'Specific missing trades may materially overturn the observed Dune conclusion.'
        : materialitySeverity === 'MODERATE'
          ? 'Specific missing trades are concerning, but their impact is not conclusive.'
          : 'Available GMGN-native outcomes for the missing trades do not appear materially harmful.',
  };
  let status: CoverageQualityStatus;
  let reason: string;
  let operationalStatus: OperationalDuneEvidenceStatus;
  if (pendingMaterial) {
    status = 'PENDING_DUNE';
    operationalStatus = 'PENDING';
    reason = `${pendingTrips} eligible trips still have no Dune query result.`;
  } else if (optimisticBiasDetected) {
    status = 'POSSIBLE_OPTIMISTIC_BIAS';
    operationalStatus = 'UNPROVEN';
    reason =
      'Confirmed Dune-missing trades are materially worse on native GMGN outcomes than covered trades.';
  } else if (conservativeBiasDetected) {
    status = 'POSSIBLE_CONSERVATIVE_BIAS';
    operationalStatus = 'GOOD';
    reason =
      'Confirmed Dune-missing trades look materially better than covered trades; no bonus is applied.';
  } else if (confirmedMissing.length === 0) {
    status = 'GOOD_COVERAGE_NO_OBVIOUS_BIAS';
    operationalStatus = 'GOOD';
    reason = 'No confirmed Dune-missing trades are present.';
  } else if (!sufficientSampleForBiasTest) {
    status = 'INSUFFICIENT_DATA_TO_ASSESS';
    operationalStatus =
      materialitySeverity === 'HIGH'
        ? 'UNPROVEN'
        : materialitySeverity === 'MODERATE'
          ? 'REVIEW'
          : 'GOOD';
    reason = `Only ${missingNativePerformance.effectiveSampleSize} effective confirmed-missing observations are available; ${missingTradeMateriality.aggregateInterpretation}`;
  } else if (medianGapTriggers) {
    status = 'INCOMPLETE_COVERAGE_REQUIRES_REVIEW';
    operationalStatus = 'REVIEW';
    reason = `The missing population is large enough to review: weighted native median gap is ${differences.weightedMedianReturnGap} points, but no confirming deterioration metric met the ${WINNER_POLICY_V2_CONFIG.coverageBiasConfirmationGapPercent}-point threshold.`;
  } else {
    status = 'PARTIAL_COVERAGE_MISSING_SET_SIMILAR';
    operationalStatus = 'GOOD';
    reason = 'Covered and confirmed-missing trades do not show a material directional difference.';
  }
  return {
    status,
    operationalStatus,
    eligibleTrips: trades.length,
    simulatedTrips: covered.length,
    confirmedMissing: {
      total: confirmedMissing.length,
      missingEntry: confirmedMissing.filter((trade) => trade.status === 'missing_entry_match')
        .length,
      missingExit: confirmedMissing.filter((trade) => trade.status === 'missing_exit_match').length,
    },
    pendingTrips,
    coveragePercent: trades.length ? roundMetric((covered.length / trades.length) * 100) : null,
    coveredNativePerformance,
    missingNativePerformance,
    differences,
    sufficientSampleForBiasTest,
    optimisticBiasDetected,
    reason,
    missingTradeMateriality,
  };
};

/** Gradual, capped growth curve: 0 at x<=0, approaches but never reaches maxPoints. Used for every
 *  profitability sub-score so one extreme value can never dominate or blow past its budget. */
const saturating = (x: number, maxPoints: number, k: number): number =>
  maxPoints * (1 - Math.exp(-k * Math.max(0, x)));

export const computePortfolioReturnScore = (
  startingCapitalUsd: number,
  endingCapitalUsd: number | null,
): number => {
  if (endingCapitalUsd === null || startingCapitalUsd <= 0) return 0;
  const returnPercent = ((endingCapitalUsd - startingCapitalUsd) / startingCapitalUsd) * 100;
  return round2(
    clamp(
      saturating(
        returnPercent,
        WINNER_POLICY_V2_CONFIG.portfolioReturnMaxPoints,
        WINNER_POLICY_V2_CONFIG.portfolioReturnCurveK,
      ),
      0,
      WINNER_POLICY_V2_CONFIG.portfolioReturnMaxPoints,
    ),
  );
};

export const computeProfitFactorMetrics = (
  outcomes: NonNullable<WinnerPolicyEvidence['copiedOutcomeEconomics']>,
  evaluationSeconds: number,
): {
  profitFactor: number | null;
  score: number;
  bestTradeProfitSharePercent: number | null;
  bestThreeProfitSharePercent: number | null;
} => {
  const weighted = outcomes.map((outcome) => ({
    pnl: outcome.netPnlUsd,
    weightedPnl:
      outcome.netPnlUsd *
      Math.pow(
        0.5,
        Math.max(0, evaluationSeconds - outcome.timestamp) /
          86_400 /
          WINNER_POLICY_RECENCY_HALF_LIFE_DAYS,
      ),
  }));
  const weightedProfit = weighted.reduce((sum, item) => sum + Math.max(0, item.weightedPnl), 0);
  const weightedLoss = weighted.reduce((sum, item) => sum + Math.max(0, -item.weightedPnl), 0);
  const profitFactor =
    weightedProfit <= 0
      ? 0
      : weightedLoss <= 1e-9
        ? WINNER_POLICY_V2_CONFIG.profitFactorCalculationCap
        : weightedProfit / weightedLoss;
  const cappedProfitFactor = Math.min(
    WINNER_POLICY_V2_CONFIG.profitFactorCalculationCap,
    profitFactor,
  );
  const score =
    cappedProfitFactor <= 1
      ? 0
      : WINNER_POLICY_V2_CONFIG.profitFactorMaxPoints *
        (1 - Math.exp(-WINNER_POLICY_V2_CONFIG.profitFactorCurveK * (cappedProfitFactor - 1)));
  const profits = weighted
    .map((item) => Math.max(0, item.weightedPnl))
    .filter((value) => value > 0)
    .sort((left, right) => right - left);
  const totalProfit = profits.reduce((sum, value) => sum + value, 0);
  return {
    profitFactor: Number.isFinite(profitFactor) ? round2(profitFactor) : null,
    score: round2(clamp(score, 0, WINNER_POLICY_V2_CONFIG.profitFactorMaxPoints)),
    bestTradeProfitSharePercent: totalProfit
      ? round2(((profits[0] ?? 0) / totalProfit) * 100)
      : null,
    bestThreeProfitSharePercent: totalProfit
      ? round2((profits.slice(0, 3).reduce((sum, value) => sum + value, 0) / totalProfit) * 100)
      : null,
  };
};

const descendingShareScore = (
  sharePercent: number | null,
  fullAtShare: number,
  zeroAtShare: number,
  maxPoints: number,
): number => {
  if (sharePercent === null) return 0;
  const share = sharePercent / 100;
  return maxPoints * clamp01((zeroAtShare - share) / (zeroAtShare - fullAtShare));
};

export const computeTailRobustnessScore = (options: {
  startingCapitalUsd: number;
  endingCapitalUsd: number | null;
  endingCapitalWithoutBestTradeUsd: number | null;
  bestTradeProfitSharePercent: number | null;
  bestThreeProfitSharePercent: number | null;
}): number => {
  const bestTrade = descendingShareScore(
    options.bestTradeProfitSharePercent,
    WINNER_POLICY_V2_CONFIG.robustnessBestTradeFullAtShare,
    WINNER_POLICY_V2_CONFIG.robustnessBestTradeZeroAtShare,
    WINNER_POLICY_V2_CONFIG.robustnessBestTradePoints,
  );
  const bestThree = descendingShareScore(
    options.bestThreeProfitSharePercent,
    WINNER_POLICY_V2_CONFIG.robustnessTopThreeFullAtShare,
    WINNER_POLICY_V2_CONFIG.robustnessTopThreeZeroAtShare,
    WINNER_POLICY_V2_CONFIG.robustnessTopThreePoints,
  );
  const originalProfit =
    options.endingCapitalUsd === null
      ? 0
      : Math.max(0, options.endingCapitalUsd - options.startingCapitalUsd);
  const withoutBestProfit =
    options.endingCapitalWithoutBestTradeUsd === null
      ? 0
      : Math.max(0, options.endingCapitalWithoutBestTradeUsd - options.startingCapitalUsd);
  const leaveOneOut =
    originalProfit > 0
      ? WINNER_POLICY_V2_CONFIG.robustnessLeaveOneOutPoints *
        clamp01(withoutBestProfit / originalProfit)
      : 0;
  return round2(
    clamp(bestTrade + bestThree + leaveOneOut, 0, WINNER_POLICY_V2_CONFIG.robustnessMaxPoints),
  );
};

/** Evidence RELIABILITY, not a reward for trading volume: a saturating curve over sample size
 *  (20 trades barely clears it, 200 is meaningfully more confident, beyond that adds little) times
 *  a data-quality multiplier from the delayed-copy coverage status. */
export const computeEvidenceConfidenceScore = (
  completedCopiedBuyOutcomes: number,
  feasibilityStatus: WinnerPolicyEvidence['feasibility']['status'],
  coverageStatus: CopySimulationWalletReport['coverageStatus'] | null,
): number => {
  const volume = saturating(
    completedCopiedBuyOutcomes,
    WINNER_POLICY_V2_CONFIG.confidenceMaxPoints,
    WINNER_POLICY_V2_CONFIG.confidenceVolumeCurveK,
  );
  const qualityKey =
    coverageStatus ?? (feasibilityStatus === 'pass' ? 'fully_covered' : 'unavailable');
  const multiplier =
    WINNER_POLICY_V2_CONFIG.confidenceQualityMultiplier[qualityKey] ??
    WINNER_POLICY_V2_CONFIG.confidenceQualityMultiplier.unavailable;
  return round2(clamp(volume * multiplier, 0, WINNER_POLICY_V2_CONFIG.confidenceMaxPoints));
};

/** Worst-of the overlapping execution-speed signals (never summed) -- fast-round-trip%,
 *  under-15s%, short median hold, and the risk bundle's fast_tx_ratio all describe the same
 *  underlying behavior from different angles, so only the single worst-implied risk counts. */
export const computeExecutionSpeedRiskFraction = (signals: {
  fastRoundTripPercent: number | null;
  under15SecondsPercent: number | null;
  medianHoldSeconds: number | null;
  fastTxRatio: number | null;
}): number => {
  const fractions: number[] = [];
  if (signals.fastRoundTripPercent !== null)
    fractions.push(clamp01(signals.fastRoundTripPercent / 100));
  if (signals.under15SecondsPercent !== null)
    fractions.push(clamp01(signals.under15SecondsPercent / 100));
  if (signals.medianHoldSeconds !== null) {
    fractions.push(
      clamp01(
        1 - signals.medianHoldSeconds / WINNER_POLICY_V2_CONFIG.executionSpeedHoldSecondsZeroRiskAt,
      ),
    );
  }
  if (signals.fastTxRatio !== null) fractions.push(clamp01(signals.fastTxRatio));
  return fractions.length ? Math.max(...fractions) : 0;
};

export const computeExecutionSpeedPenalty = (riskFraction: number): number =>
  round2(
    clamp(
      WINNER_POLICY_V2_CONFIG.maxExecutionSpeedPenalty * riskFraction,
      0,
      WINNER_POLICY_V2_CONFIG.maxExecutionSpeedPenalty,
    ),
  );

export const computeHyperactivityPenalty = (tradesPerActiveDay: number | null): number => {
  if (tradesPerActiveDay === null) return 0;
  const excess = Math.max(
    0,
    tradesPerActiveDay - WINNER_POLICY_V2_CONFIG.hyperactivityBaselineTradesPerActiveDay,
  );
  const fraction = 1 - Math.exp(-WINNER_POLICY_V2_CONFIG.hyperactivityCurveK * excess);
  return round2(
    clamp(
      WINNER_POLICY_V2_CONFIG.maxHyperactivityPenalty * fraction,
      0,
      WINNER_POLICY_V2_CONFIG.maxHyperactivityPenalty,
    ),
  );
};

export const computeTradeQualityPenalty = (signals: WinnerPolicyTradeQualitySignals): number => {
  if (
    signals.simulatedTradeCount < WINNER_POLICY_V2_CONFIG.minSimulatedTradesForTradeQuality ||
    signals.distinctTokenCount < WINNER_POLICY_V2_CONFIG.minDistinctTokensForTradeQuality ||
    signals.largeLossRatePercent === null ||
    signals.profitableTokenPercent === null
  ) {
    return 0;
  }
  const largeLoss = clamp(
    WINNER_POLICY_V2_CONFIG.largeLossMaxSubPenalty *
      (signals.largeLossRatePercent / 100 / WINNER_POLICY_V2_CONFIG.largeLossRateFullPenaltyAt),
    0,
    WINNER_POLICY_V2_CONFIG.largeLossMaxSubPenalty,
  );
  const profitableToken = clamp(
    WINNER_POLICY_V2_CONFIG.profitableTokenMaxSubPenalty *
      ((WINNER_POLICY_V2_CONFIG.profitableTokenFullPenaltyBelow -
        signals.profitableTokenPercent / 100) /
        WINNER_POLICY_V2_CONFIG.profitableTokenFullPenaltyBelow),
    0,
    WINNER_POLICY_V2_CONFIG.profitableTokenMaxSubPenalty,
  );
  return round2(
    clamp(largeLoss + profitableToken, 0, WINNER_POLICY_V2_CONFIG.maxTradeQualityPenalty),
  );
};

/** fast_tx_ratio is deliberately excluded here -- folded into computeExecutionSpeedRiskFraction
 *  instead, so it never counts twice against two different penalty buckets. */
export const computeTokenRiskPenalty = (riskBundle: GmgnRiskBundleEvidence | null): number => {
  if (!riskBundle) return 0;
  const noBuyHold =
    riskBundle.noBuyHoldRatio === null
      ? 0
      : clamp(
          WINNER_POLICY_V2_CONFIG.noBuyHoldMaxSubPenalty *
            (riskBundle.noBuyHoldRatio / WINNER_POLICY_V2_CONFIG.noBuyHoldFullPenaltyAt),
          0,
          WINNER_POLICY_V2_CONFIG.noBuyHoldMaxSubPenalty,
        );
  const sellPassBuy =
    riskBundle.sellPassBuyRatio === null
      ? 0
      : clamp(
          WINNER_POLICY_V2_CONFIG.sellPassBuyMaxSubPenalty *
            (riskBundle.sellPassBuyRatio / WINNER_POLICY_V2_CONFIG.sellPassBuyFullPenaltyAt),
          0,
          WINNER_POLICY_V2_CONFIG.sellPassBuyMaxSubPenalty,
        );
  return round2(clamp(noBuyHold + sellPassBuy, 0, WINNER_POLICY_V2_CONFIG.maxTokenRiskPenalty));
};

export const computeCostPenalty = (gasRatioPercent: number | null): number =>
  gasRatioPercent === null
    ? 0
    : round2(
        clamp(
          WINNER_POLICY_V2_CONFIG.maxCostPenalty *
            (gasRatioPercent / WINNER_POLICY_V2_CONFIG.gasRatioFullPenaltyAtPercent),
          0,
          WINNER_POLICY_V2_CONFIG.maxCostPenalty,
        ),
      );

export const computeWalletAgePenalty = (
  ageDays: number | null,
  periodDays: number | null,
): number => {
  if (ageDays === null || ageDays < 0) return 0;
  if (periodDays === null || periodDays <= 0) {
    if (ageDays < 7) return 5;
    if (ageDays < 30) return 4;
    if (ageDays < 60) return 2;
    return 0;
  }
  if (ageDays < 7) return WINNER_POLICY_V2_CONFIG.maxWalletAgePenalty;
  if (ageDays < periodDays * 0.5) return 4;
  if (ageDays < periodDays) return 2;
  return 0;
};

/**
 * Evaluate the authoritative policy. The hard gates are minimum copied evidence, a profitable
 * chronological $100 portfolio, actionable Dune evidence, and independence from uncopyable
 * sub-60-second trades. Median return remains diagnostic.
 * shown as context/warnings only. Wallets that clear the gates receive a 0-100 score: up to 70
 * points from Dune delayed-copy profitability, plus up to 30 points that START at 30 and are
 * discounted by transparent, capped GMGN execution/risk penalties -- GMGN data can only lower an
 * already-proven wallet's score, never grant winner status on its own.
 */
export const evaluateWinnerPolicy = (evidence: WinnerPolicyEvidence): WinnerPolicyResult => {
  const gates: WinnerPolicyGate[] = [];
  const positiveReasons: string[] = [];
  const rejectionReasons: string[] = [];
  const unprovenReasons: string[] = [];
  const warnings: string[] = [];

  // Gate A -- minimum evidence.
  const evidenceOk = evidence.completedCopiedBuyOutcomes >= WINNER_POLICY_MIN_COMPLETED_COPIED_BUYS;
  const evidenceDetail = evidenceOk
    ? `${evidence.completedCopiedBuyOutcomes} completed copied-buy outcomes are available.`
    : `Only ${evidence.completedCopiedBuyOutcomes} completed copied-buy outcomes are available; ${WINNER_POLICY_MIN_COMPLETED_COPIED_BUYS} are required.`;
  gates.push(
    gate(
      'evidence',
      'Minimum canonical copied-buy evidence',
      evidenceOk ? 'pass' : 'unproven',
      evidenceDetail,
    ),
  );
  if (!evidenceOk) {
    unprovenReasons.push(
      `Winner proof is unavailable until at least ${WINNER_POLICY_MIN_COMPLETED_COPIED_BUYS} completed copied-buy outcomes exist.`,
    );
  }

  // Diagnostic only -- asymmetric memecoin strategies can be profitable with a negative median.
  const medianValue = evidence.recencyWeightedMedianReturnPercent ?? evidence.medianReturnPercent;
  const medianAvailable = medianValue !== null;
  const medianPositive = medianAvailable && medianValue! > 0;
  gates.push(
    gate(
      'delayed_copy_median',
      'Delayed-copy median (diagnostic only)',
      !medianAvailable ? 'unproven' : medianPositive ? 'pass' : 'warning',
      !medianAvailable
        ? 'No canonical delayed-copy median is available.'
        : `Recency-weighted delayed-copy median is ${medianValue!.toFixed(2)}%${medianPositive ? '' : ', not positive'}.`,
    ),
  );
  if (!medianAvailable) warnings.push('The delayed-copy median diagnostic is unavailable.');
  else if (!medianPositive)
    warnings.push(
      'The delayed-copy median is non-positive; asymmetric edge must come from larger winners.',
    );
  else positiveReasons.push('Canonical delayed-copy median is positive.');

  // Gate C -- profitable canonical $100 portfolio.
  const endingCapitalUsd = evidence.endingCapitalUsd;
  const portfolioAvailable = endingCapitalUsd !== null;
  const portfolioPositive = portfolioAvailable && endingCapitalUsd! > evidence.startingCapitalUsd;
  gates.push(
    gate(
      'canonical_portfolio',
      'Canonical $100 portfolio ends above $100',
      !portfolioAvailable ? 'unproven' : portfolioPositive ? 'pass' : 'fail',
      !portfolioAvailable
        ? 'The canonical fixed-stake portfolio result is missing.'
        : `Canonical portfolio ends at $${endingCapitalUsd!.toFixed(2)}.`,
    ),
  );
  if (!portfolioAvailable) unprovenReasons.push('The canonical $100 portfolio result is missing.');
  else if (!portfolioPositive)
    rejectionReasons.push(
      `Canonical fixed-stake portfolio did not end above $${evidence.startingCapitalUsd}.`,
    );
  else
    positiveReasons.push(
      `Canonical fixed-stake portfolio grew from $${evidence.startingCapitalUsd} to $${endingCapitalUsd!.toFixed(2)}.`,
    );
  // Feasibility -- context/warning only in v2, never a hard gate.
  if (evidence.feasibility.status === 'warning' || evidence.feasibility.status === 'fail') {
    gates.push(
      gate('feasibility', 'Execution feasibility', 'warning', evidence.feasibility.detail),
    );
    warnings.push(evidence.feasibility.detail);
  } else if (evidence.feasibility.status === 'unavailable') {
    gates.push(
      gate('feasibility', 'Execution feasibility', 'unproven', evidence.feasibility.detail),
    );
    warnings.push(evidence.feasibility.detail);
  } else {
    gates.push(gate('feasibility', 'Execution feasibility', 'pass', evidence.feasibility.detail));
  }

  const coverageQuality = evidence.coverageQuality ?? evaluateCoverageQuality([]);
  const duneActionable = coverageQuality.operationalStatus === 'GOOD';
  const uncopyableCounterfactualAvailable =
    evidence.portfolioWithoutUncopyableTradesEndingCapitalUsd !== null &&
    evidence.portfolioWithoutUncopyableTradesEndingCapitalUsd !== undefined &&
    evidence.uncopyableTradeCount !== undefined &&
    evidence.uncopyableProfitDependencyPercent !== undefined &&
    evidence.uncopyableProfitDependencyPercent !== null;
  const uncopyableProfitDependencyDetected =
    portfolioPositive &&
    uncopyableCounterfactualAvailable &&
    evidence.uncopyableProfitDependencyPercent! > 50 &&
    evidence.portfolioWithoutUncopyableTradesEndingCapitalUsd! <= evidence.startingCapitalUsd;
  if (uncopyableProfitDependencyDetected) {
    rejectionReasons.push(
      `Profitability depends on sub-${UNCOPYABLE_TRADE_MAX_HOLD_SECONDS}-second trades: excluding them ends the canonical portfolio at $${evidence.portfolioWithoutUncopyableTradesEndingCapitalUsd!.toFixed(2)}.`,
    );
  }
  const proofGates: WinnerPolicyProofGates = {
    completedCopiedTrades: { status: evidenceOk ? 'pass' : 'unproven', detail: evidenceDetail },
    simulatedPortfolioPositive: {
      status: !portfolioAvailable ? 'unproven' : portfolioPositive ? 'pass' : 'fail',
      detail: gates[2].detail,
    },
    duneEvidenceActionable: {
      status: duneActionable ? 'pass' : 'unproven',
      detail: `Dune evidence is ${coverageQuality.operationalStatus.toLowerCase()}: ${coverageQuality.reason}`,
    },
    uncopyableProfitDependency: {
      status: !uncopyableCounterfactualAvailable
        ? 'unproven'
        : uncopyableProfitDependencyDetected
          ? 'fail'
          : 'pass',
      detail: !uncopyableCounterfactualAvailable
        ? 'No exact portfolio rerun excluding sub-60-second trades is available.'
        : uncopyableProfitDependencyDetected
          ? `${evidence.uncopyableTradeCount} sub-${UNCOPYABLE_TRADE_MAX_HOLD_SECONDS}-second copied trades account for ${evidence.uncopyableProfitDependencyPercent!.toFixed(1)}% of the profitable result; excluding them ends at $${evidence.portfolioWithoutUncopyableTradesEndingCapitalUsd!.toFixed(2)}.`
          : `${evidence.uncopyableTradeCount} sub-${UNCOPYABLE_TRADE_MAX_HOLD_SECONDS}-second copied trades do not erase portfolio profitability when excluded.`,
    },
  };

  const dataMissing = !evidenceOk || !portfolioAvailable || !uncopyableCounterfactualAvailable;
  const hardFailed =
    (portfolioAvailable && !portfolioPositive) || uncopyableProfitDependencyDetected;
  if (!uncopyableCounterfactualAvailable) {
    unprovenReasons.push(
      'Winner proof is unavailable until the exact sub-60-second trade counterfactual is computed.',
    );
  }
  let status: WinnerPolicyStatus = dataMissing ? 'UNPROVEN' : hardFailed ? 'REJECTED' : 'WINNER';
  if (status === 'WINNER' && coverageQuality.operationalStatus === 'UNPROVEN') {
    status = 'UNPROVEN';
    unprovenReasons.push(
      'Winner proof is withheld because confirmed Dune-missing trades are materially worse on native GMGN outcomes.',
    );
  } else if (status === 'WINNER' && coverageQuality.operationalStatus === 'PENDING') {
    status = 'UNPROVEN';
    unprovenReasons.push(
      'Winner proof is pending because a material population of eligible trades still needs Dune results.',
    );
  }
  if (coverageQuality.operationalStatus !== 'GOOD') {
    warnings.push(`Dune coverage quality: ${coverageQuality.reason}`);
  }

  let profitabilityScore: WinnerPolicyProfitabilityScore | null = null;
  let gmgnRiskScore: WinnerPolicyGmgnRiskScore | null = null;
  let finalScore: number | null = null;

  if (!dataMissing) {
    const portfolioScore = computePortfolioReturnScore(
      evidence.startingCapitalUsd,
      evidence.endingCapitalUsd,
    );
    const evaluationSeconds = Math.floor(
      Date.parse(evidence.recency?.evaluationTimestamp ?? new Date().toISOString()) / 1000,
    );
    const profitFactorMetrics = computeProfitFactorMetrics(
      evidence.copiedOutcomeEconomics ?? [],
      evaluationSeconds,
    );
    const evidenceConfidenceScore = computeEvidenceConfidenceScore(
      evidence.completedCopiedBuyOutcomes,
      evidence.feasibility.status,
      evidence.coverageStatus,
    );
    const robustnessScore = computeTailRobustnessScore({
      startingCapitalUsd: evidence.startingCapitalUsd,
      endingCapitalUsd: evidence.endingCapitalUsd,
      endingCapitalWithoutBestTradeUsd: evidence.portfolioWithoutBestTradeEndingCapitalUsd ?? null,
      bestTradeProfitSharePercent: profitFactorMetrics.bestTradeProfitSharePercent,
      bestThreeProfitSharePercent: profitFactorMetrics.bestThreeProfitSharePercent,
    });
    const profitTotal = roundScore(
      clamp(
        portfolioScore + profitFactorMetrics.score + evidenceConfidenceScore + robustnessScore,
        0,
        WINNER_POLICY_V2_CONFIG.profitabilityWeight,
      ),
    );
    profitabilityScore = {
      score: profitTotal,
      max: WINNER_POLICY_V2_CONFIG.profitabilityWeight,
      portfolioScore,
      profitFactorScore: profitFactorMetrics.score,
      evidenceConfidenceScore,
      robustnessScore,
      weightedProfitFactor: profitFactorMetrics.profitFactor,
      bestTradeProfitSharePercent: profitFactorMetrics.bestTradeProfitSharePercent,
      bestThreeProfitSharePercent: profitFactorMetrics.bestThreeProfitSharePercent,
      portfolioWithoutBestTradeEndingCapitalUsd:
        evidence.portfolioWithoutBestTradeEndingCapitalUsd ?? null,
    };

    const speedRiskFraction = computeExecutionSpeedRiskFraction({
      fastRoundTripPercent: evidence.activitySignals?.fastRoundTripPercent ?? null,
      under15SecondsPercent: evidence.activitySignals?.under15SecondsPercent ?? null,
      medianHoldSeconds: evidence.activitySignals?.medianHoldSeconds ?? null,
      fastTxRatio: evidence.riskBundle?.fastTxRatio ?? null,
    });
    const executionSpeed = computeExecutionSpeedPenalty(speedRiskFraction);
    const hyperactivity = computeHyperactivityPenalty(
      evidence.activitySignals?.tradesPerActiveDay ?? null,
    );
    const tradeQuality = computeTradeQualityPenalty(evidence.tradeQualitySignals);
    const tokenRisk = computeTokenRiskPenalty(evidence.riskBundle);
    const costs = computeCostPenalty(evidence.executionFrictionSignals.gasRatioPercent);
    const walletAge = computeWalletAgePenalty(
      evidence.activitySignals?.walletAgeDays ?? null,
      null,
    );
    const gmgnTotal = roundScore(
      clamp(
        WINNER_POLICY_V2_CONFIG.gmgnRiskWeight -
          (executionSpeed + hyperactivity + tradeQuality + tokenRisk + costs + walletAge),
        0,
        WINNER_POLICY_V2_CONFIG.gmgnRiskWeight,
      ),
    );
    gmgnRiskScore = {
      score: gmgnTotal,
      max: WINNER_POLICY_V2_CONFIG.gmgnRiskWeight,
      walletAgeDays: evidence.activitySignals?.walletAgeDays ?? null,
      deductions: { executionSpeed, hyperactivity, tradeQuality, tokenRisk, costs, walletAge },
      deductionDetails: buildGmgnDeductionDetails({
        activitySignals: evidence.activitySignals,
        riskBundle: evidence.riskBundle,
        tradeQuality: evidence.tradeQualitySignals,
        gasRatioPercent: evidence.executionFrictionSignals.gasRatioPercent,
        deductions: { executionSpeed, hyperactivity, tradeQuality, tokenRisk, costs, walletAge },
      }),
    };

    finalScore = roundScore(clamp(profitTotal + gmgnTotal, 0, 100));

    if (!evidence.activitySignals) {
      warnings.push(
        'Execution-speed and hyperactivity signals are unavailable; the GMGN score excludes them rather than assuming zero risk.',
      );
    }
    if (!evidence.riskBundle) {
      warnings.push(
        'GMGN risk bundle unavailable; the token-risk penalty was not applied (missing data is never treated as zero risk).',
      );
    } else if (evidence.riskBundle.honeypotRatioMissing) {
      warnings.push(
        'Token honeypot ratio is not available from any current source; treated as unknown, not zero-risk.',
      );
    }
  }

  return {
    policyVersion: WINNER_POLICY_VERSION,
    status,
    duneEvidenceStatus: coverageQuality.operationalStatus,
    actionability:
      status !== 'WINNER'
        ? 'NOT_ACTIONABLE'
        : coverageQuality.operationalStatus === 'REVIEW'
          ? 'REVIEW'
          : 'ACTIONABLE',
    finalScore,
    proofGates,
    profitabilityScore,
    gmgnRiskScore,
    gates,
    positiveReasons,
    rejectionReasons,
    unprovenReasons,
    warnings,
    evidence,
  };
};
