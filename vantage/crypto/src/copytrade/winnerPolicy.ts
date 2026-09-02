/**
 * The single authoritative winner policy shared by Decision Lab and Live Evaluation.
 *
 * This module is deliberately pure. Provider clients, GMGN aggregates, Pattern Discovery, and
 * UI-specific score models must adapt their saved evidence into WinnerPolicyEvidence before this
 * function is called. That keeps “winner” proof stable and reviewable across both consumers.
 *
 * v2 philosophy: Dune delayed-copy evidence proves whether copying a wallet is profitable (hard
 * gates + 70% of the score). GMGN execution/risk data only discounts that already-proven
 * profitability (30% of the score) -- it is never a positive bonus, because only Dune evidence
 * has been validated as predictive of future returns. See progress.md's v2 write-up for the full
 * before/after comparison against v1.
 */

import type { CopySimulationWalletReport } from './simulation/copySimulation.js';
import { WINNER_POLICY_V2_CONFIG } from './winnerPolicyV2Config.js';

export const WINNER_POLICY_VERSION = WINNER_POLICY_V2_CONFIG.policyVersion;
export const WINNER_POLICY_STARTING_CAPITAL_USD = 100;
export const WINNER_POLICY_MIN_COMPLETED_COPIED_BUYS =
  WINNER_POLICY_V2_CONFIG.minimumCompletedCopiedTrades;
/** Kept for the evidence builder, which still computes 3 chronological holdout windows for
 *  "Historical stability" display context -- v2 no longer gates WINNER status on them. */
export const WINNER_POLICY_HOLDOUT_WINDOWS = 3;

export type WinnerPolicyStatus = 'WINNER' | 'REJECTED' | 'UNPROVEN';
export type WinnerPolicyMode = 'authoritative' | 'discovered_rules';
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
  completedCopiedBuyOutcomes: number;
  medianReturnPercent: number | null;
  startingCapitalUsd: number;
  endingCapitalUsd: number | null;
  holdouts: WinnerPolicyHoldout[];
  coverageStatus: CopySimulationWalletReport['coverageStatus'] | null;
  feasibility:
    | { status: 'pass' | 'warning' | 'fail'; detail: string }
    | { status: 'unavailable'; detail: string };
  activitySignals: WinnerPolicyActivitySignals | null;
  riskBundle: GmgnRiskBundleEvidence | null;
  tradeQualitySignals: WinnerPolicyTradeQualitySignals;
  executionFrictionSignals: WinnerPolicyExecutionFrictionSignals;
  provenance: {
    delayedCopy: string;
    portfolio: string;
    featureSource: string;
    patternDiscoveryUsed: false;
    officialGmgnAggregatesUsed: false;
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
  medianDelayedCopyPositive: WinnerPolicyProofGate;
  simulatedPortfolioPositive: WinnerPolicyProofGate;
};

export type WinnerPolicyProfitabilityScore = {
  score: number;
  max: number;
  medianReturnScore: number;
  portfolioScore: number;
  evidenceConfidenceScore: number;
};

export type WinnerPolicyGmgnRiskScore = {
  score: number;
  max: number;
  deductions: {
    executionSpeed: number;
    hyperactivity: number;
    tradeQuality: number;
    tokenRisk: number;
    costs: number;
  };
};

export type WinnerPolicyResult = {
  policyVersion: typeof WINNER_POLICY_VERSION;
  mode: WinnerPolicyMode;
  status: WinnerPolicyStatus;
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

/** Gradual, capped growth curve: 0 at x<=0, approaches but never reaches maxPoints. Used for every
 *  profitability sub-score so one extreme value can never dominate or blow past its budget. */
const saturating = (x: number, maxPoints: number, k: number): number =>
  maxPoints * (1 - Math.exp(-k * Math.max(0, x)));

export const computeMedianReturnScore = (medianReturnPercent: number | null): number => {
  if (medianReturnPercent === null) return 0;
  return round2(
    clamp(
      saturating(
        medianReturnPercent,
        WINNER_POLICY_V2_CONFIG.medianReturnMaxPoints,
        WINNER_POLICY_V2_CONFIG.medianReturnCurveK,
      ),
      0,
      WINNER_POLICY_V2_CONFIG.medianReturnMaxPoints,
    ),
  );
};

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

/**
 * Evaluate the fixed v2 policy. Only 3 hard gates (minimum evidence, positive median, profitable
 * $100 portfolio) decide WINNER/REJECTED/UNPROVEN; holdout stability and execution feasibility are
 * shown as context/warnings only. Wallets that clear the gates receive a 0-100 score: up to 70
 * points from Dune delayed-copy profitability, plus up to 30 points that START at 30 and are
 * discounted by transparent, capped GMGN execution/risk penalties -- GMGN data can only lower an
 * already-proven wallet's score, never grant winner status on its own.
 */
export const evaluateWinnerPolicy = (
  evidence: WinnerPolicyEvidence,
  options: { mode?: WinnerPolicyMode } = {},
): WinnerPolicyResult => {
  const mode = options.mode ?? 'authoritative';
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

  // Gate B -- positive delayed-copy median.
  const medianValue = evidence.medianReturnPercent;
  const medianAvailable = medianValue !== null;
  const medianPositive = medianAvailable && medianValue! > 0;
  gates.push(
    gate(
      'delayed_copy_median',
      'Positive delayed-copy median',
      !medianAvailable ? 'unproven' : medianPositive ? 'pass' : 'fail',
      !medianAvailable
        ? 'No canonical delayed-copy median is available.'
        : `Canonical delayed-copy median is ${medianValue!.toFixed(2)}%${medianPositive ? '' : ', not positive'}.`,
    ),
  );
  if (!medianAvailable) unprovenReasons.push('The canonical delayed-copy median is missing.');
  else if (!medianPositive) rejectionReasons.push('Canonical delayed-copy median is not positive.');
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

  const proofGates: WinnerPolicyProofGates = {
    completedCopiedTrades: { status: evidenceOk ? 'pass' : 'unproven', detail: evidenceDetail },
    medianDelayedCopyPositive: {
      status: !medianAvailable ? 'unproven' : medianPositive ? 'pass' : 'fail',
      detail: gates[1].detail,
    },
    simulatedPortfolioPositive: {
      status: !portfolioAvailable ? 'unproven' : portfolioPositive ? 'pass' : 'fail',
      detail: gates[2].detail,
    },
  };

  const dataMissing = !evidenceOk || !medianAvailable || !portfolioAvailable;
  const hardFailed =
    (medianAvailable && !medianPositive) || (portfolioAvailable && !portfolioPositive);
  const status: WinnerPolicyStatus = dataMissing ? 'UNPROVEN' : hardFailed ? 'REJECTED' : 'WINNER';

  let profitabilityScore: WinnerPolicyProfitabilityScore | null = null;
  let gmgnRiskScore: WinnerPolicyGmgnRiskScore | null = null;
  let finalScore: number | null = null;

  if (!dataMissing) {
    const medianReturnScore = computeMedianReturnScore(evidence.medianReturnPercent);
    const portfolioScore = computePortfolioReturnScore(
      evidence.startingCapitalUsd,
      evidence.endingCapitalUsd,
    );
    const evidenceConfidenceScore = computeEvidenceConfidenceScore(
      evidence.completedCopiedBuyOutcomes,
      evidence.feasibility.status,
      evidence.coverageStatus,
    );
    const profitTotal = roundScore(
      clamp(
        medianReturnScore + portfolioScore + evidenceConfidenceScore,
        0,
        WINNER_POLICY_V2_CONFIG.profitabilityWeight,
      ),
    );
    profitabilityScore = {
      score: profitTotal,
      max: WINNER_POLICY_V2_CONFIG.profitabilityWeight,
      medianReturnScore,
      portfolioScore,
      evidenceConfidenceScore,
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
    const gmgnTotal = roundScore(
      clamp(
        WINNER_POLICY_V2_CONFIG.gmgnRiskWeight -
          (executionSpeed + hyperactivity + tradeQuality + tokenRisk + costs),
        0,
        WINNER_POLICY_V2_CONFIG.gmgnRiskWeight,
      ),
    );
    gmgnRiskScore = {
      score: gmgnTotal,
      max: WINNER_POLICY_V2_CONFIG.gmgnRiskWeight,
      deductions: { executionSpeed, hyperactivity, tradeQuality, tokenRisk, costs },
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

  if (mode === 'discovered_rules') {
    warnings.push(
      'Discovered Rules mode is experimental context only; Pattern Discovery cannot override the fixed Winner Policy gates or scores.',
    );
  }

  return {
    policyVersion: WINNER_POLICY_VERSION,
    mode,
    status,
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
