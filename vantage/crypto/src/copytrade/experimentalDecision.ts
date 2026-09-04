import type { DatabaseSync } from 'node:sqlite';
import { computeCopyTradeReport, type CopyTradeRow } from './scrutiny/evaluate.js';
import { readGmgnRiskResults } from './scrutiny/gmgnRisk.js';
import {
  MAX_PATTERN_DISCOVERY_WALLETS,
  patternDiscoveryCacheKey,
  readPatternDiscoveryCache,
  readPatternDiscoveryDataFingerprint,
} from './discovery/patternDiscovery.js';
import { PATTERN_DISCOVERY_COVERAGE_THRESHOLDS } from './discovery/patternDiscoveryRunner.js';
import { weightCategoryForFeature } from './decisionCategories.js';
import { CACHE_VERSIONS } from '../platform/cache/cacheVersions.js';
import {
  WALLET_FEATURE_ENGINE_VERSION,
  walletFeaturesForApplication,
} from './features/walletFeatureDefinitions.js';
import { readWalletFeatureSnapshotsBatch } from './features/walletFeatureReader.js';
import { CALCULATION_VERSION_MANIFEST, CALCULATION_VERSIONS } from './calculationVersions.js';
import {
  createHistoricalEvidenceContext,
  type HistoricalEvidenceContext,
} from './evidence/historicalEvidenceContext.js';
import { computeCopySimulationReport } from './simulation/copySimulation.js';
import {
  buildGmgnRiskBundleEvidence,
  buildWinnerPolicyEvidence,
  emptyWinnerPolicyEvidence,
} from './winnerPolicyEvidence.js';
import {
  evaluateWinnerPolicy,
  WINNER_POLICY_VERSION,
  type WinnerPolicyResult,
} from './winnerPolicy.js';

const NEUTRAL_DECISION_WEIGHTS = {
  edge: 0.25,
  consistency: 0.25,
  robustness: 0.25,
  copyability: 0.25,
} as const;
/** @deprecated Use CACHE_VERSIONS.decisionLab for new cache consumers. */
export const DECISION_LAB_SCORING_VERSION = CACHE_VERSIONS.decisionLab.replace(
  'experimental-decision:',
  '',
);
const PROMOTION_THRESHOLDS = PATTERN_DISCOVERY_COVERAGE_THRESHOLDS;
const MIN_PROMOTION_WALLETS = 10;

export type ExperimentalDecisionWeights = {
  edge: number;
  consistency: number;
  robustness: number;
  copyability: number;
};
export type ExperimentalDecisionWeighting = {
  mode: 'neutral-fallback' | 'validated-patterns';
  weights: ExperimentalDecisionWeights;
  detail: string;
  supportingThresholds: number[];
  supportingWallets: number;
};

/**
 * A deliberately separate, read-only scoring experiment.
 *
 * This is not used by the production verdict engine. It is a transparent way to compare
 * several saved-evidence dimensions before we decide whether a new decision model is useful.
 * In particular, it must never fetch a provider or silently turn missing evidence into a zero.
 */
export type ExperimentalDecisionWallet = {
  walletAddress: string;
  name: string | null;
  rank: number | null;
  tags: string[];
  evidence: { level: 'complete' | 'partial' | 'insufficient' | 'missing'; detail: string };
  candidateStatus: 'eligible' | 'rejected' | 'insufficient_evidence' | 'missing_evidence';
  /** Authoritative winner classification; candidateStatus remains a legacy analytical label. */
  winnerPolicy: WinnerPolicyResult;
  scores: {
    edge: number | null;
    consistency: number | null;
    robustness: number | null;
    copyability: number | null;
    overall: number | null;
  };
  scoreDetails: Record<
    'edge' | 'consistency' | 'robustness' | 'copyability' | 'overall',
    { label: string; detail: string }
  >;
  copyabilityDiagnostics: CopyabilityDiagnostics;
  facts: {
    activityPeriodDays: 30 | 60 | 90;
    activityTradeCount: number;
    activityMedianReturnPercent: number | null;
    activityUnder15SecondsPercent?: number | null;
    activityBestTokenSharePercent?: number | null;
    activityFastRoundTripPercent?: number | null;
    activityNoCostBasisPercent?: number | null;
    activityMedianHoldSeconds: number | null;
    officialGmgnPeriod?: string | null;
    officialGmgnFetchedAt?: string | null;
    officialGmgnBuyCount?: number | null;
    officialGmgnSellCount?: number | null;
    officialGmgnWinRatePercent?: number | null;
    officialGmgnRealizedProfitUsd?: number | null;
    copyMedianPercent: number | null;
    copyCapitalUsd: number | null;
    duneCoveragePercent: number | null;
    matchedRoundTrips: number;
    roundTripsConsidered: number;
  };
  scrutiny: {
    pass: number;
    fail: number;
    insufficient: number;
    checks: Array<{ label: string; verdict: string; detail: string }>;
  } | null;
  riskDetails: { available: boolean; metrics: Record<string, unknown> | null };
  liquidity: { low: number | null; medium: number | null; high: number | null } | null;
  liquidityBands: Array<{
    band: 'low' | 'medium' | 'high';
    minEntryTradeAmountUsd: number;
    maxEntryTradeAmountUsd: number;
    tradeCount: number;
    simulatedCount: number;
    missedCount: number;
    missedTradeRatePercent: number | null;
    winRatePercent: number | null;
    medianSimulatedReturnPercent: number | null;
    medianWalletReturnPercent: number | null;
    medianDelayCostPercentagePoints: number | null;
    reliable: boolean;
  }> | null;
  risks: string[];
};

export type ExperimentalDecisionReport = {
  generatedAt: string;
  featureEngineVersion: string;
  periodDays: 30 | 60 | 90;
  /** Explicit calculation metadata so consumers can distinguish local activity from official
   * GMGN aggregates and can reproduce the exact point-in-time boundary used by this report. */
  evidenceContext: HistoricalEvidenceContext;
  calculationVersions: typeof CALCULATION_VERSIONS;
  calculationManifestVersion: typeof CALCULATION_VERSION_MANIFEST.manifestVersion;
  readOnly: true;
  noProviderFetch: true;
  source: 'saved SQLite evidence';
  winnerPolicyVersion: typeof WINNER_POLICY_VERSION;
  methodology: string[];
  weighting: ExperimentalDecisionWeighting;
  wallets: ExperimentalDecisionWallet[];
};

export const clamp = (value: number): number =>
  Math.max(0, Math.min(100, Math.round(value * 10) / 10));

/**
 * Transparent execution-feasibility parameters. These are deliberately a baseline, not an
 * economically calibrated model. Keep them in one place so a later point-in-time Dune study
 * can replace the parameters without reimplementing scoring in each consumer.
 */
export const COPYABILITY_CONFIG = {
  holdReferenceSeconds: 15,
  holdCapSeconds: 4 * 60 * 60,
  fastRoundTripPenaltyPerPercent: 0.35,
  under15SecondPenaltyPerPercent: 0.5,
  minimumObservations: 3,
  lowConfidenceObservations: 10,
  moderateConfidenceObservations: 30,
  lowConfidenceAdjustment: -10,
  moderateConfidenceAdjustment: -4,
} as const;

export type CopyabilityConfidence = 'insufficient' | 'low' | 'moderate' | 'high';
export type CopyabilityDiagnostics = {
  medianHoldSeconds: number | null;
  holdContribution: number | null;
  fastRoundTripPercent: number | null;
  fastRoundTripPenalty: number;
  under15SecondPercent: number | null;
  under15SecondPenalty: number;
  patternAdjustment: number;
  confidenceAdjustment: number;
  sampleSize: {
    pairedTrades: number;
    holdingObservations: number;
    fastRoundTripDenominator: number;
    under15SecondDenominator: number;
    under15SecondObservations: number | null;
  };
  confidence: CopyabilityConfidence;
  gate: 'pass' | 'insufficient_sample' | 'missing_hold';
  finalScore: number | null;
};

export type CopyabilityScoreInput = {
  medianHoldSeconds: number | null;
  fastRoundTripPercent?: number | null;
  under15SecondPercent?: number | null;
  pairedTradeCount?: number | null;
  under15SecondCount?: number | null;
  /** Signed supplementary adjustment from promoted Pattern Discovery rules. */
  patternAdjustment?: number;
};

export type CopyabilityScoreResult = {
  score: number | null;
  diagnostics: CopyabilityDiagnostics;
};

export const positiveReturnScore = (value: number | null): number | null =>
  value === null ? null : clamp(50 + value * 1.25);
/** Final candidacy requires the delayed-copy median itself to be positive. A high score from
 * other dimensions must not rescue a wallet whose typical copied trade lost money. */
export const holdScore = (seconds: number | null): number | null => {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  const cappedSeconds = Math.min(seconds, COPYABILITY_CONFIG.holdCapSeconds);
  // Log interpolation keeps 15s, 30s, 1m, 5m, 10m, 30m, 1h and multi-hour holds distinct,
  // while making the intentionally explicit four-hour cap the only point of saturation.
  return clamp(
    (Math.log1p(cappedSeconds / COPYABILITY_CONFIG.holdReferenceSeconds) /
      Math.log1p(COPYABILITY_CONFIG.holdCapSeconds / COPYABILITY_CONFIG.holdReferenceSeconds)) *
      100,
  );
};

const historicalMetricForFeature = (row: CopyTradeRow, feature: string): number | null => {
  const aggregate = row.gmgnAggregate;
  const buyCount = aggregate?.buyCount ?? null;
  const sellCount = aggregate?.sellCount ?? null;
  switch (feature) {
    case 'prior_wallet_trade_count':
      return buyCount !== null && sellCount !== null ? buyCount + sellCount : null;
    case 'prior_wallet_buy_count':
      return aggregate?.buyCount ?? null;
    case 'prior_wallet_sell_count':
      return aggregate?.sellCount ?? null;
    case 'prior_wallet_buy_volume_usd':
      return aggregate?.boughtCost ?? null;
    case 'prior_wallet_sell_volume_usd':
      return aggregate?.soldIncome ?? null;
    case FAST_TRADING_FEATURE:
      return row.riskEvidence.under15SecondsPercent ?? null;
    default:
      return null;
  }
};

const percentileRank = (value: number, values: number[]): number | null => {
  if (values.length < 2) return null;
  const belowOrEqual = values.filter((candidate) => candidate <= value).length;
  return (belowOrEqual - 1) / (values.length - 1);
};

/**
 * Convert promoted threshold effects directly into score points and use promoted correlations
 * only as a rank-based fallback when discovery did not produce a stable threshold. This avoids
 * inventing cutoffs while still making the repeated negative activity findings actionable.
 */
export const computeHistoricalHyperactivityPenalty = (
  row: CopyTradeRow,
  rows: CopyTradeRow[],
  rules: ExperimentalDecisionPromotedRules,
): number => {
  const thresholdPenalties = rules.hyperactivityThresholds
    .filter(
      (rule) => (historicalMetricForFeature(row, rule.feature) ?? -Infinity) >= rule.threshold,
    )
    .map((rule) => Math.max(0, -rule.effect));
  const correlationPenalties = rules.hyperactivityCorrelations.map((rule) => {
    const metric = historicalMetricForFeature(row, rule.feature);
    const values = rows
      .map((candidate) => historicalMetricForFeature(candidate, rule.feature))
      .filter((value): value is number => value !== null && Number.isFinite(value));
    if (metric === null) return 0;
    const rank = percentileRank(metric, values);
    return rank === null ? 0 : 100 * Math.abs(rule.effect) * rank;
  });
  return Math.max(0, ...thresholdPenalties, ...correlationPenalties);
};

/** A promoted negative correlation maps the observed fast-trade percentage to score points. */
export const computeFastTradingPenalty = (
  row: CopyTradeRow,
  rules: ExperimentalDecisionPromotedRules,
): number => {
  const fastPercent = row.riskEvidence.under15SecondsPercent ?? null;
  if (fastPercent === null || rules.fastTradingCorrelations.length === 0) return 0;
  const strength = Math.max(...rules.fastTradingCorrelations.map((rule) => Math.abs(rule.effect)));
  return Math.max(0, fastPercent * strength);
};

/**
 * Canonical Copyability calculation shared by Decision Lab, Live Evaluation, exports and tests.
 * It measures execution feasibility only: holding time, directly observed fast activity, and
 * data confidence. Profitability, consistency, robustness and token concentration belong to
 * their own components and must not be smuggled into this score through a coverage weight.
 */
export const computeCopyabilityScore = (input: CopyabilityScoreInput): CopyabilityScoreResult => {
  const pairedTrades =
    typeof input.pairedTradeCount === 'number' && Number.isFinite(input.pairedTradeCount)
      ? Math.max(0, Math.floor(input.pairedTradeCount))
      : 0;
  const holdingObservations = pairedTrades;
  const fastRoundTripPercent =
    typeof input.fastRoundTripPercent === 'number' && Number.isFinite(input.fastRoundTripPercent)
      ? clamp(Math.max(0, input.fastRoundTripPercent))
      : null;
  const under15SecondPercent =
    typeof input.under15SecondPercent === 'number' && Number.isFinite(input.under15SecondPercent)
      ? clamp(Math.max(0, input.under15SecondPercent))
      : null;
  const holdContribution = holdScore(input.medianHoldSeconds);
  const fastRoundTripPenalty =
    fastRoundTripPercent === null
      ? 0
      : clamp(fastRoundTripPercent * COPYABILITY_CONFIG.fastRoundTripPenaltyPerPercent);
  const under15SecondPenalty =
    under15SecondPercent === null
      ? 0
      : clamp(under15SecondPercent * COPYABILITY_CONFIG.under15SecondPenaltyPerPercent);
  const patternAdjustment = Number.isFinite(input.patternAdjustment ?? 0)
    ? (input.patternAdjustment ?? 0)
    : 0;
  const confidence: CopyabilityConfidence =
    pairedTrades < COPYABILITY_CONFIG.minimumObservations
      ? 'insufficient'
      : pairedTrades < COPYABILITY_CONFIG.lowConfidenceObservations
        ? 'low'
        : pairedTrades < COPYABILITY_CONFIG.moderateConfidenceObservations
          ? 'moderate'
          : 'high';
  const confidenceAdjustment =
    confidence === 'low'
      ? COPYABILITY_CONFIG.lowConfidenceAdjustment
      : confidence === 'moderate'
        ? COPYABILITY_CONFIG.moderateConfidenceAdjustment
        : 0;
  const gate: CopyabilityDiagnostics['gate'] =
    holdContribution === null
      ? 'missing_hold'
      : confidence === 'insufficient'
        ? 'insufficient_sample'
        : 'pass';
  const score =
    gate === 'pass'
      ? clamp(
          (holdContribution ?? 0) -
            fastRoundTripPenalty -
            under15SecondPenalty +
            patternAdjustment +
            confidenceAdjustment,
        )
      : null;
  return {
    score,
    diagnostics: {
      medianHoldSeconds: input.medianHoldSeconds,
      holdContribution,
      fastRoundTripPercent,
      fastRoundTripPenalty,
      under15SecondPercent,
      under15SecondPenalty,
      patternAdjustment,
      confidenceAdjustment,
      sampleSize: {
        pairedTrades,
        holdingObservations,
        fastRoundTripDenominator: pairedTrades,
        under15SecondDenominator: pairedTrades,
        under15SecondObservations:
          typeof input.under15SecondCount === 'number' && Number.isFinite(input.under15SecondCount)
            ? Math.min(pairedTrades, Math.max(0, Math.floor(input.under15SecondCount)))
            : null,
      },
      confidence,
      gate,
      finalScore: score,
    },
  };
};

type CachedDiscoveryReport = {
  patterns?: Array<{
    feature?: string;
    effect?: number | null;
    validationStatus?: string;
    historical_stability?: { status?: string };
  }>;
  dataset_summary?: { wallets?: number };
};

type CachedPromotedPattern = {
  feature?: string;
  effect?: number | null;
  conditions?: unknown;
};

type CachedDiscoverySensitivity = {
  crossCoveragePromotedPatterns?: Array<{
    pattern?: CachedPromotedPattern;
    supportingCoveragePercent?: number[];
  }>;
};

type PromotedThresholdRule = {
  feature: string;
  threshold: number;
  effect: number;
};

type PromotedCorrelationRule = {
  feature: string;
  effect: number;
};

export type ExperimentalDecisionPromotedRules = {
  hyperactivityThresholds: PromotedThresholdRule[];
  hyperactivityCorrelations: PromotedCorrelationRule[];
  fastTradingCorrelations: PromotedCorrelationRule[];
};

export const HYPERACTIVITY_FEATURES: ReadonlySet<string> = new Set<string>(
  walletFeaturesForApplication('decision_hyperactivity_penalty').map(
    ({ identifier }) => identifier,
  ),
);
export const FAST_TRADING_FEATURE: string =
  walletFeaturesForApplication('decision_fast_trading_penalty')[0]?.identifier ??
  'prior_wallet_under_15_seconds_percent';

const numericCondition = (conditions: unknown): { operator: string; value: number } | null => {
  if (!Array.isArray(conditions) || conditions.length !== 1) return null;
  const condition: unknown = conditions[0];
  if (!condition || typeof condition !== 'object') return null;
  const candidate = condition as { operator?: unknown; value?: unknown };
  if (typeof candidate.operator !== 'string' || typeof candidate.value !== 'number') return null;
  return Number.isFinite(candidate.value)
    ? { operator: candidate.operator, value: candidate.value }
    : null;
};

/**
 * Read only cross-coverage survivors. Rules are intentionally inert when the cached discovery
 * result does not contain a genuinely promoted/stable pattern. This keeps a missing discovery
 * run from silently changing the scoring model.
 */
export const readExperimentalDecisionPromotedRules = (
  database: DatabaseSync,
  dataFingerprint = readPatternDiscoveryDataFingerprint(database),
  periodDays: 30 | 60 | 90 = 30,
): ExperimentalDecisionPromotedRules => {
  const sensitivity = readPatternDiscoveryCache<CachedDiscoverySensitivity>(
    database,
    patternDiscoveryCacheKey('sensitivity', periodDays, 50, 10, MAX_PATTERN_DISCOVERY_WALLETS),
    dataFingerprint,
  );
  const hyperactivityThresholds: PromotedThresholdRule[] = [];
  const hyperactivityCorrelations = new Map<string, PromotedCorrelationRule>();
  const fastTradingCorrelations = new Map<string, PromotedCorrelationRule>();
  for (const entry of sensitivity?.crossCoveragePromotedPatterns ?? []) {
    const pattern = entry.pattern;
    const feature = pattern?.feature;
    const effect = pattern?.effect;
    if (!feature || typeof effect !== 'number' || !Number.isFinite(effect)) continue;
    const condition = numericCondition(pattern.conditions);
    if (HYPERACTIVITY_FEATURES.has(feature) && condition?.operator === '>=' && effect < 0) {
      hyperactivityThresholds.push({ feature, threshold: condition.value, effect });
      continue;
    }
    const raw: unknown = Array.isArray(pattern.conditions) ? pattern.conditions[0] : null;
    const isNegativeCorrelation =
      raw &&
      typeof raw === 'object' &&
      (raw as { operator?: unknown }).operator === 'correlation' &&
      (raw as { value?: unknown }).value === 'negative' &&
      effect < 0;
    if (!isNegativeCorrelation) continue;
    if (feature === FAST_TRADING_FEATURE) {
      const current = fastTradingCorrelations.get(feature);
      if (!current || Math.abs(effect) > Math.abs(current.effect))
        fastTradingCorrelations.set(feature, { feature, effect });
    } else if (HYPERACTIVITY_FEATURES.has(feature)) {
      const current = hyperactivityCorrelations.get(feature);
      if (!current || Math.abs(effect) > Math.abs(current.effect))
        hyperactivityCorrelations.set(feature, { feature, effect });
    }
  }
  return {
    hyperactivityThresholds,
    hyperactivityCorrelations: [...hyperactivityCorrelations.values()],
    fastTradingCorrelations: [...fastTradingCorrelations.values()],
  };
};

/**
 * Promote discovery into scoring only when it is repeated across coverage levels.
 * A single run never rewrites the Decision Lab weights.
 */
export const readExperimentalDecisionWeighting = (
  database: DatabaseSync,
  dataFingerprint = readPatternDiscoveryDataFingerprint(database),
  periodDays = 30,
): ExperimentalDecisionWeighting => {
  const evidence = new Map<keyof ExperimentalDecisionWeights, Set<number>>();
  let supportingWallets = 0;
  for (const threshold of PROMOTION_THRESHOLDS) {
    const report = readPatternDiscoveryCache<CachedDiscoveryReport>(
      database,
      patternDiscoveryCacheKey('report', periodDays, threshold, 10, MAX_PATTERN_DISCOVERY_WALLETS),
      dataFingerprint,
    );
    if (!report || (report.dataset_summary?.wallets ?? 0) < MIN_PROMOTION_WALLETS) continue;
    supportingWallets = Math.max(supportingWallets, report.dataset_summary?.wallets ?? 0);
    for (const pattern of report.patterns ?? []) {
      if (
        pattern.validationStatus !== 'validation survivor' ||
        pattern.historical_stability?.status !== 'stable' ||
        !pattern.feature
      )
        continue;
      const category = weightCategoryForFeature(pattern.feature);
      if (!category) continue;
      const thresholds = evidence.get(category) ?? new Set<number>();
      thresholds.add(threshold);
      evidence.set(category, thresholds);
    }
  }
  const supportingThresholds = [
    ...new Set([...evidence.values()].flatMap((thresholds) => [...thresholds])),
  ].sort((a, b) => a - b);
  const promotedCategories = [...evidence.values()].filter((thresholds) => thresholds.size >= 2);
  if (promotedCategories.length === 0) {
    return {
      mode: 'neutral-fallback',
      weights: { ...NEUTRAL_DECISION_WEIGHTS },
      detail:
        'Neutral 25/25/25/25 weights remain active because no pattern has survived both coverage-level and chronological historical validation with enough wallets.',
      supportingThresholds,
      supportingWallets,
    };
  }
  const signal = (category: keyof ExperimentalDecisionWeights): number =>
    1 + (evidence.get(category)?.size ?? 0);
  const raw = (
    Object.keys(NEUTRAL_DECISION_WEIGHTS) as Array<keyof ExperimentalDecisionWeights>
  ).map((category) => [category, signal(category)] as const);
  const total = raw.reduce((sum, [, value]) => sum + value, 0);
  const weights = Object.fromEntries(
    raw.map(([category, value]) => [category, value / total]),
  ) as ExperimentalDecisionWeights;
  return {
    mode: 'validated-patterns',
    weights,
    detail: `Adaptive weights use only patterns that survived all required chronological blocks and repeated across coverage levels ${supportingThresholds.join('%, ')}%; each supporting report had at least ${MIN_PROMOTION_WALLETS} wallets.`,
    supportingThresholds,
    supportingWallets,
  };
};

export const readExperimentalDecisionCacheVersion = (
  database: DatabaseSync,
  periodDays: 30 | 60 | 90 = 30,
): string => {
  const fingerprint = readPatternDiscoveryDataFingerprint(database);
  const row = database
    .prepare(
      `SELECT MAX(updated_at) AS updatedAt FROM copytrade_report_cache
     WHERE cache_key LIKE ? AND data_fingerprint = ?`,
    )
    .get(`${CACHE_VERSIONS.patternDiscovery}:report:${periodDays}:%`, fingerprint) as
    { updatedAt?: string | null } | undefined;
  return `${fingerprint}:${row?.updatedAt ?? 'no-promoted-patterns'}`;
};

const consistencyScore = (row: CopyTradeRow): number | null => {
  const periods = [...row.weeklyPerformance, ...row.monthlyPerformance].filter(
    (period) => period.medianReturnPercent !== null,
  );
  if (periods.length === 0) return null;
  const positive = periods.filter((period) => (period.medianReturnPercent ?? 0) > 0).length;
  return clamp((positive / periods.length) * 100);
};

export const robustnessScore = (row: CopyTradeRow): number | null => {
  const withoutBest = row.profitConcentration.excludingBestToken.medianReturnPercent;
  if (withoutBest === null) return null;
  // Pattern Discovery found a positive association for concentration in multiple promoted
  // datasets. Until that result is strong enough to reward concentration, hold it neutral and
  // score only the performance that remains after removing the best token.
  return clamp(50 + withoutBest * 1.25);
};

const evidenceFor = (
  row: CopyTradeRow,
  scores: Pick<
    ExperimentalDecisionWallet['scores'],
    'edge' | 'consistency' | 'robustness' | 'copyability'
  >,
): ExperimentalDecisionWallet['evidence'] => {
  if (Object.values(scores).some((score) => score === null))
    return {
      level: 'partial',
      detail: 'Some GMGN scoring inputs are unavailable for this wallet.',
    };
  if (row.truncated || row.historyFailed)
    return { level: 'partial', detail: 'GMGN history is incomplete for this wallet.' };
  return {
    level: 'complete',
    detail: `${row.trades} locally reconstructed GMGN activity trades are available for the activity context; all four activity scores are available.`,
  };
};

/** The Decision Lab candidacy contract is intentionally small and GMGN-only. Keeping it as a
 * pure helper makes the hard gate testable without constructing a full report fixture. */
export const gmgnCandidatePasses = (input: {
  evidenceLevel: ExperimentalDecisionWallet['evidence']['level'];
  overall: number | null;
  medianReturnPercent: number | null;
}): boolean =>
  input.evidenceLevel === 'complete' &&
  input.overall !== null &&
  input.overall >= 50 &&
  (input.medianReturnPercent ?? 0) > 0;

export const computeExperimentalDecisionReport = (
  database: DatabaseSync,
  options: {
    limit?: number;
    rosterSnapshotId?: number;
    now?: Date;
    periodDays?: 30 | 60 | 90 | null;
  } = {},
): ExperimentalDecisionReport => {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 100)));
  const periodDays = options.periodDays === undefined ? null : options.periodDays;
  const selectedPeriodDays = periodDays ?? 90;
  const now = options.now ?? new Date();
  const screen = computeCopyTradeReport(database, {
    periodDays: null,
    traderLimit: limit,
    rosterSnapshotId: options.rosterSnapshotId,
    now,
  });
  const featureSnapshots = readWalletFeatureSnapshotsBatch(database, {
    walletAddresses: screen.rows.map((row) => row.walletAddress),
    asOfTimestamp: now.toISOString(),
    lookbackDays: 3650,
    includePreWindowContext: false,
    trigger: 'current',
    chain: 'sol',
  });
  // Capture one evidence revision for both adaptive weights and rule penalties. Reading the
  // fingerprint separately can observe two different revisions while live ingestion is running,
  // causing one side to load a completed result while the other silently falls back to neutral.
  const patternDiscoveryFingerprint = readPatternDiscoveryDataFingerprint(database);
  const weighting = readExperimentalDecisionWeighting(
    database,
    patternDiscoveryFingerprint,
    selectedPeriodDays,
  );
  const promotedRules = readExperimentalDecisionPromotedRules(
    database,
    patternDiscoveryFingerprint,
    selectedPeriodDays,
  );
  const riskByWallet = new Map(
    readGmgnRiskResults(
      database,
      screen.rows.map((row) => row.walletAddress),
    ).map((result) => [result.walletAddress, result]),
  );
  // This is a read-only reconstruction over persisted Dune matches. It does not invoke the
  // Dune runner; the same canonical report is the source of Winner Policy proof in both tabs.
  const delayedCopyByWallet = new Map(
    computeCopySimulationReport(database, {
      walletAddresses: screen.rows.map((row) => row.walletAddress),
      chain: 'sol',
      periodDays: periodDays ?? undefined,
      now,
    }).wallets.map((wallet) => [wallet.walletAddress, wallet]),
  );
  const wallets = screen.rows.map((row) => {
    const canonical = featureSnapshots.get(row.walletAddress)?.decisionMetrics;
    const medianReturnPercent = canonical?.medianReturnPercent ?? row.medianReturnPercent;
    const excludingBestTokenMedianReturnPercent =
      canonical?.excludingBestTokenMedianReturnPercent ??
      row.profitConcentration.excludingBestToken.medianReturnPercent;
    const holdSeconds = canonical?.medianHoldSeconds ?? row.riskEvidence.medianHoldSeconds;
    const edge = positiveReturnScore(medianReturnPercent);
    const consistency = canonical
      ? canonical.periodCount === 0
        ? null
        : clamp((canonical.positivePeriodCount / canonical.periodCount) * 100)
      : consistencyScore(row);
    const robustness =
      excludingBestTokenMedianReturnPercent === null
        ? null
        : clamp(50 + excludingBestTokenMedianReturnPercent * 1.25);
    const fastTradingPenalty = computeFastTradingPenalty(row, promotedRules);
    const hyperactivityPenalty = computeHistoricalHyperactivityPenalty(
      row,
      screen.rows,
      promotedRules,
    );
    const copyabilityResult = computeCopyabilityScore({
      medianHoldSeconds: holdSeconds,
      fastRoundTripPercent:
        canonical?.under60SecondsPercent ?? row.riskEvidence.fastRoundTripPercent,
      under15SecondPercent:
        canonical?.under15SecondsPercent ?? row.riskEvidence.under15SecondsPercent,
      pairedTradeCount: row.riskEvidence.pairedTradeCount,
      under15SecondCount: row.riskEvidence.under15SecondsCount,
      patternAdjustment: -(fastTradingPenalty + hyperactivityPenalty),
    });
    const copyability = copyabilityResult.score;
    const copyabilityDiagnostics = copyabilityResult.diagnostics;
    const delayedCopy = delayedCopyByWallet.get(row.walletAddress);
    const activitySignals = {
      fastRoundTripPercent:
        canonical?.under60SecondsPercent ?? row.riskEvidence.fastRoundTripPercent,
      under15SecondsPercent:
        canonical?.under15SecondsPercent ?? row.riskEvidence.under15SecondsPercent ?? null,
      medianHoldSeconds: holdSeconds,
      tradesPerActiveDay:
        featureSnapshots.get(row.walletAddress)?.features.priorWalletTradesPerActiveDay ?? null,
      walletAgeDays: row.riskEvidence.walletAgeDays,
    };
    const riskBundle = buildGmgnRiskBundleEvidence(riskByWallet.get(row.walletAddress));
    const winnerPolicy = delayedCopy
      ? evaluateWinnerPolicy(
          buildWinnerPolicyEvidence(delayedCopy, null, {
            activitySignals,
            riskBundle,
            evaluationTimestamp: now,
          }),
        )
      : evaluateWinnerPolicy(emptyWinnerPolicyEvidence(null));
    const evidence = evidenceFor(row, { edge, consistency, robustness, copyability });
    // The legacy analytical score is descriptive only. It remains unavailable when one of its
    // component inputs is missing, but it no longer applies an independent 100-GMGN-trade gate.
    const rawOverall =
      edge !== null &&
      consistency !== null &&
      robustness !== null &&
      copyability !== null &&
      evidence.level === 'complete'
        ? clamp(
            edge * weighting.weights.edge +
              consistency * weighting.weights.consistency +
              robustness * weighting.weights.robustness +
              copyability * weighting.weights.copyability,
          )
        : null;
    const candidateStatus: ExperimentalDecisionWallet['candidateStatus'] =
      evidence.level === 'missing'
        ? 'missing_evidence'
        : evidence.level !== 'complete'
          ? 'insufficient_evidence'
          : gmgnCandidatePasses({
                evidenceLevel: evidence.level,
                overall: rawOverall,
                medianReturnPercent,
              })
            ? 'eligible'
            : 'rejected';
    const positivePeriods = [...row.weeklyPerformance, ...row.monthlyPerformance].filter(
      (period) => period.medianReturnPercent !== null,
    );
    const positivePeriodCount =
      canonical?.positivePeriodCount ??
      positivePeriods.filter((period) => (period.medianReturnPercent ?? 0) > 0).length;
    const periodCount = canonical?.periodCount ?? positivePeriods.length;
    const scoreDetails: ExperimentalDecisionWallet['scoreDetails'] = {
      edge: {
        label: 'GMGN profitability',
        detail:
          medianReturnPercent === null
            ? 'Missing GMGN realized median return.'
            : `Starts at 50 and adjusts with the GMGN realized median return (${medianReturnPercent.toFixed(1)}%).`,
      },
      consistency: {
        label: 'Consistency',
        detail:
          periodCount === 0
            ? 'No saved weekly or monthly periods.'
            : `${positivePeriodCount} of ${periodCount} saved weekly/monthly periods were positive.`,
      },
      robustness: {
        label: 'Robustness',
        detail:
          excludingBestTokenMedianReturnPercent === null
            ? 'Missing the median return after removing the best token.'
            : `Uses the median return after removing the best token (${excludingBestTokenMedianReturnPercent.toFixed(1)}%); profit concentration is currently neutral pending stronger evidence.`,
      },
      copyability: {
        label: 'Copyability',
        detail:
          copyability === null
            ? copyabilityDiagnostics.gate === 'insufficient_sample'
              ? `Insufficient paired-trade evidence (${copyabilityDiagnostics.sampleSize.pairedTrades}; at least ${COPYABILITY_CONFIG.minimumObservations} required).`
              : 'Missing local activity holding-time input.'
            : `Local ${periodDays}-day execution score: hold ${copyabilityDiagnostics.holdContribution?.toFixed(1) ?? '—'} - fast ${copyabilityDiagnostics.fastRoundTripPenalty.toFixed(1)} - under-15s ${copyabilityDiagnostics.under15SecondPenalty.toFixed(1)} + Pattern Discovery ${copyabilityDiagnostics.patternAdjustment.toFixed(1)} + confidence ${copyabilityDiagnostics.confidenceAdjustment.toFixed(1)} = ${copyability.toFixed(1)}. Confidence: ${copyabilityDiagnostics.confidence} (${copyabilityDiagnostics.sampleSize.pairedTrades} paired trades).`,
      },
      overall: {
        label: 'Overall',
        detail:
          rawOverall === null
            ? 'Requires all four component scores and non-missing evidence.'
            : candidateStatus === 'eligible'
              ? `Raw weighted score: ${rawOverall.toFixed(1)}. This wallet passes the final candidacy gates.`
              : `Raw GMGN weighted score: ${rawOverall.toFixed(1)}; ${evidence.detail}`,
      },
    };
    // Persist the same GMGN-derived risk evidence that Live Evaluation can explain. These are
    // derived from saved rows only; no provider call is involved. Keeping them in the report
    // makes future comparisons historical rather than dependent on the current evaluator.
    const risks: string[] = [...row.riskNotes];
    if (evidence.level !== 'complete') risks.push(evidence.detail);
    if (row.truncated) risks.push('GMGN history is truncated.');
    if (row.historyFailed) risks.push('GMGN history fetch failed.');
    if ((row.riskEvidence.under15SecondsPercent ?? 0) > 20)
      risks.push(
        `${row.riskEvidence.under15SecondsPercent?.toFixed(1)}% of paired trades are under 15 seconds.`,
      );
    if (robustness !== null && robustness < 50)
      risks.push('Performance is weak after removing the best token.');
    if (fastTradingPenalty > 0)
      risks.push(
        `Promoted fast-trading evidence reduced Copyability by ${fastTradingPenalty.toFixed(1)} points.`,
      );
    if (hyperactivityPenalty > 0)
      risks.push(
        `Promoted historical-activity evidence reduced Copyability by ${hyperactivityPenalty.toFixed(1)} points.`,
      );
    const risk = riskByWallet.get(row.walletAddress);
    return {
      walletAddress: row.walletAddress,
      name: row.name,
      rank: row.rankHistory.currentRank,
      tags: row.gmgnTags ?? [],
      evidence,
      candidateStatus,
      winnerPolicy,
      scores: { edge, consistency, robustness, copyability, overall: rawOverall },
      scoreDetails,
      copyabilityDiagnostics,
      facts: {
        activityPeriodDays: selectedPeriodDays,
        activityTradeCount: row.trades,
        activityMedianReturnPercent: medianReturnPercent,
        activityUnder15SecondsPercent:
          canonical?.under15SecondsPercent ?? row.riskEvidence.under15SecondsPercent ?? null,
        activityBestTokenSharePercent:
          canonical?.bestTokenProfitSharePercent ??
          row.profitConcentration.bestTokenSharePositiveProfitPercent ??
          null,
        activityFastRoundTripPercent:
          canonical?.under60SecondsPercent ?? row.riskEvidence.fastRoundTripPercent,
        activityNoCostBasisPercent:
          canonical?.noCostBasisPercent ?? row.riskEvidence.noCostBasisPercent,
        activityMedianHoldSeconds: holdSeconds,
        officialGmgnPeriod: row.gmgnAggregate?.period ?? null,
        officialGmgnFetchedAt: row.gmgnAggregate?.fetchedAt ?? null,
        officialGmgnBuyCount: row.gmgnAggregate?.buyCount ?? null,
        officialGmgnSellCount: row.gmgnAggregate?.sellCount ?? null,
        officialGmgnWinRatePercent: row.gmgnAggregate?.winRatePercent ?? null,
        officialGmgnRealizedProfitUsd: row.gmgnAggregate?.realizedProfit ?? null,
        copyMedianPercent: winnerPolicy.evidence.medianReturnPercent,
        copyCapitalUsd: winnerPolicy.evidence.endingCapitalUsd,
        duneCoveragePercent: delayedCopy?.coverageRatePercent ?? null,
        matchedRoundTrips: delayedCopy?.copiedTrades ?? 0,
        roundTripsConsidered: delayedCopy?.roundTripsConsidered ?? 0,
      },
      scrutiny: null,
      riskDetails: {
        available: risk?.available === true,
        metrics:
          risk?.metrics && typeof risk.metrics === 'object'
            ? (risk.metrics as Record<string, unknown>)
            : null,
      },
      liquidity: null,
      liquidityBands: null,
      risks: [...new Set(risks)],
    };
  });
  return {
    generatedAt: now.toISOString(),
    featureEngineVersion: WALLET_FEATURE_ENGINE_VERSION,
    periodDays: selectedPeriodDays,
    evidenceContext: createHistoricalEvidenceContext({
      chain: 'sol',
      asOf: now,
      periodDays: selectedPeriodDays,
      completeness: { status: 'unknown' },
    }),
    calculationVersions: CALCULATION_VERSIONS,
    calculationManifestVersion: CALCULATION_VERSION_MANIFEST.manifestVersion,
    readOnly: true,
    noProviderFetch: true,
    source: 'saved SQLite evidence',
    winnerPolicyVersion: WINNER_POLICY_VERSION,
    methodology: [
      'All available saved GMGN history is evaluated through the shared point-in-time wallet feature engine; recent observations receive more weight through the 45-day decay.',
      'Raw overall scores require all four selected-period activity components; thinner samples remain unavailable. Candidate status is descriptive only; authoritative winner status uses the Winner Policy gates.',
      'Copyability is an execution-feasibility index, not a probability of success; its local activity inputs are hold duration, fast round trips, ultra-fast activity, supplementary promoted rules, and sample confidence.',
      'The hold contribution uses logarithmic interpolation from 15 seconds to an explicit four-hour cap so materially different execution speeds remain distinguishable.',
      `Direct Copyability penalties are ${COPYABILITY_CONFIG.fastRoundTripPenaltyPerPercent.toFixed(2)} points per fast-round-trip percentage point and ${COPYABILITY_CONFIG.under15SecondPenaltyPerPercent.toFixed(2)} points per under-15-second percentage point; ${COPYABILITY_CONFIG.minimumObservations} paired observations are required for a score.`,
      'Scores are exploratory, capped at 0–100, and missing inputs stay null.',
      'Profitability is a hard gate for final candidacy: the selected-period locally reconstructed median return must be positive, even when the raw weighted score is high.',
      weighting.detail,
      promotedRules.hyperactivityThresholds.length > 0 ||
      promotedRules.hyperactivityCorrelations.length > 0 ||
      promotedRules.fastTradingCorrelations.length > 0
        ? 'Promoted/stable Pattern Discovery rules provide supplementary Copyability adjustments; direct fast-round-trip and under-15-second penalties remain active even without promoted rules.'
        : 'No cross-coverage promoted pattern supplied a supplementary Copyability adjustment; direct fast-round-trip and under-15-second penalties remain active.',
      'Profit concentration is neutral in Robustness; the score uses performance after removing the best token until stronger evidence supports a reward or penalty.',
      'This tab does not replace or modify the production decision engine.',
      `Winner Policy ${WINNER_POLICY_VERSION} is authoritative for WINNER/REJECTED/UNPROVEN status. Its hard gates are at least 20 completed copied-buy outcomes, profitable fixed-$100 chronological portfolio growth, actionable Dune evidence, and profitability that survives removal of sub-60-second trades. The recency-weighted median remains diagnostic only.`,
      'Pattern Discovery and official GMGN aggregate snapshots are never used as Winner Policy proof.',
    ],
    weighting,
    wallets,
  };
};
