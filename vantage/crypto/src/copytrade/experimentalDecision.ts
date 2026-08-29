import type { DatabaseSync } from 'node:sqlite';
import { computeCopyTradeReport, RULES, type CopyTradeRow } from './scrutiny/evaluate.js';
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
  facts: {
    gmgnPeriod?: string | null;
    gmgnFetchedAt?: string | null;
    gmgnTrades?: number | null;
    gmgnBuyCount?: number | null;
    gmgnSellCount?: number | null;
    gmgnMedianPercent: number | null;
    gmgnWinRatePercent?: number | null;
    gmgnUnder15SecondsPercent?: number | null;
    gmgnBestTokenSharePercent?: number | null;
    gmgnRealizedProfitUsd?: number | null;
    gmgnFastRoundTripPercent?: number | null;
    gmgnNoCostBasisPercent?: number | null;
    copyMedianPercent: number | null;
    copyCapitalUsd: number | null;
    duneCoveragePercent: number | null;
    matchedRoundTrips: number;
    roundTripsConsidered: number;
    medianHoldSeconds: number | null;
    under15SecondsPercent: number | null;
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
  periodDays: 30;
  readOnly: true;
  noProviderFetch: true;
  source: 'saved SQLite evidence';
  methodology: string[];
  weighting: ExperimentalDecisionWeighting;
  wallets: ExperimentalDecisionWallet[];
};

export const clamp = (value: number): number =>
  Math.max(0, Math.min(100, Math.round(value * 10) / 10));
const COPY_DELAY_REFERENCE_SECONDS = 15;
export const positiveReturnScore = (value: number | null): number | null =>
  value === null ? null : clamp(50 + value * 1.25);
/** Final candidacy requires the delayed-copy median itself to be positive. A high score from
 * other dimensions must not rescue a wallet whose typical copied trade lost money. */
export const holdScore = (seconds: number | null): number | null =>
  seconds === null
    ? null
    : clamp(
        (seconds / COPY_DELAY_REFERENCE_SECONDS) * 25 +
          (seconds >= COPY_DELAY_REFERENCE_SECONDS ? 50 : 0),
      );

// Kept as compatibility helpers for diagnostics and existing callers; Decision Lab no longer
// invokes any Dune-based gate.
export const delayedCopyPerformancePassesCandidacyGate = (
  simulation: { simulatedMedianReturnPercent?: number | null } | null | undefined,
): boolean => (simulation?.simulatedMedianReturnPercent ?? -Infinity) > 0;
export const copyPortfolioProfitabilityPassesCandidacyGate = (
  simulation:
    { portfolio?: { startingCapitalUsd?: number; endingCapitalUsd?: number } } | null | undefined,
): boolean => {
  const portfolio = simulation?.portfolio;
  return (
    portfolio !== undefined &&
    Number.isFinite(portfolio.startingCapitalUsd) &&
    Number.isFinite(portfolio.endingCapitalUsd) &&
    (portfolio.startingCapitalUsd ?? 0) > 0 &&
    (portfolio.endingCapitalUsd ?? 0) > (portfolio.startingCapitalUsd ?? 0)
  );
};
export const outOfSampleStabilityPassesCandidacyGate = (
  check: ({ verdict?: string } & Record<string, unknown>) | null | undefined,
): boolean => check?.verdict === 'pass';

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

export const computeCopyabilityScore = (
  coveragePercent: number | null,
  holdSeconds: number | null,
  fastTradingPenalty = 0,
  hyperactivityPenalty = 0,
): number | null => {
  if (coveragePercent === null || holdSeconds === null) return null;
  return clamp(
    coveragePercent * 0.6 +
      (holdScore(holdSeconds) ?? 0) * 0.4 -
      fastTradingPenalty -
      hyperactivityPenalty,
  );
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

export const HYPERACTIVITY_FEATURES = new Set([
  'prior_wallet_trade_count',
  'prior_wallet_buy_count',
  'prior_wallet_sell_count',
  'prior_wallet_buy_volume_usd',
  'prior_wallet_sell_volume_usd',
]);
export const FAST_TRADING_FEATURE = 'prior_wallet_under_15_seconds_percent';

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
): ExperimentalDecisionPromotedRules => {
  const sensitivity = readPatternDiscoveryCache<CachedDiscoverySensitivity>(
    database,
    patternDiscoveryCacheKey('sensitivity', 30, 50, 10, MAX_PATTERN_DISCOVERY_WALLETS),
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
): ExperimentalDecisionWeighting => {
  const evidence = new Map<keyof ExperimentalDecisionWeights, Set<number>>();
  let supportingWallets = 0;
  for (const threshold of PROMOTION_THRESHOLDS) {
    const report = readPatternDiscoveryCache<CachedDiscoveryReport>(
      database,
      patternDiscoveryCacheKey('report', 30, threshold, 10, MAX_PATTERN_DISCOVERY_WALLETS),
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

export const readExperimentalDecisionCacheVersion = (database: DatabaseSync): string => {
  const fingerprint = readPatternDiscoveryDataFingerprint(database);
  const row = database
    .prepare(
      `SELECT MAX(updated_at) AS updatedAt FROM copytrade_report_cache
     WHERE cache_key LIKE ? AND data_fingerprint = ?`,
    )
    .get(`${CACHE_VERSIONS.patternDiscovery}:report:%`, fingerprint) as
    { updatedAt?: string | null } | undefined;
  return `${fingerprint}:${row?.updatedAt ?? 'no-promoted-patterns'}`;
};

export const consistencyScore = (row: CopyTradeRow): number | null => {
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
  if (row.trades < RULES.minTrades)
    return {
      level: 'insufficient',
      detail: `Unrankable: only ${row.trades} GMGN trades; at least ${RULES.minTrades} are required for comparison.`,
    };
  if (Object.values(scores).some((score) => score === null))
    return {
      level: 'partial',
      detail: 'Some GMGN scoring inputs are unavailable for this wallet.',
    };
  if (row.truncated || row.historyFailed)
    return { level: 'partial', detail: 'GMGN history is incomplete for this wallet.' };
  return {
    level: 'complete',
    detail: `${row.trades} GMGN trades in the last 30 days; all four GMGN scores are available.`,
  };
};

/** The Decision Lab candidacy contract is intentionally small and GMGN-only. Keeping it as a
 * pure helper makes the hard gate testable without constructing a Dune database fixture. */
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
  options: { limit?: number; rosterSnapshotId?: number } = {},
): ExperimentalDecisionReport => {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 100)));
  const screen = computeCopyTradeReport(database, {
    periodDays: 30,
    traderLimit: limit,
    rosterSnapshotId: options.rosterSnapshotId,
  });
  // Capture one evidence revision for both adaptive weights and rule penalties. Reading the
  // fingerprint separately can observe two different revisions while live ingestion is running,
  // causing one side to load a completed result while the other silently falls back to neutral.
  const patternDiscoveryFingerprint = readPatternDiscoveryDataFingerprint(database);
  const weighting = readExperimentalDecisionWeighting(database, patternDiscoveryFingerprint);
  const promotedRules = readExperimentalDecisionPromotedRules(
    database,
    patternDiscoveryFingerprint,
  );
  const riskByWallet = new Map(
    readGmgnRiskResults(
      database,
      screen.rows.map((row) => row.walletAddress),
    ).map((result) => [result.walletAddress, result]),
  );
  const wallets = screen.rows.map((row) => {
    const edge = positiveReturnScore(row.medianReturnPercent);
    const consistency = consistencyScore(row);
    const robustness = robustnessScore(row);
    const fastTradingPenalty = computeFastTradingPenalty(row, promotedRules);
    const hyperactivityPenalty = computeHistoricalHyperactivityPenalty(
      row,
      screen.rows,
      promotedRules,
    );
    const copyability =
      row.riskEvidence.medianHoldSeconds === null
        ? null
        : clamp(
            (holdScore(row.riskEvidence.medianHoldSeconds) ?? 0) -
              fastTradingPenalty -
              hyperactivityPenalty,
          );
    const evidence = evidenceFor(row, { edge, consistency, robustness, copyability });
    // A wallet under the minimum-trade threshold can still produce four non-null component
    // scores (e.g. two lucky trades), but combining them into one overall number would let a
    // near-zero sample rank alongside wallets with real evidence. candidateStatus below already
    // withholds "eligible" status for exactly this reason; overall must be withheld the same way
    // rather than bypassing that gate.
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
                medianReturnPercent: row.medianReturnPercent,
              })
            ? 'eligible'
            : 'rejected';
    const positivePeriods = [...row.weeklyPerformance, ...row.monthlyPerformance].filter(
      (period) => period.medianReturnPercent !== null,
    );
    const positivePeriodCount = positivePeriods.filter(
      (period) => (period.medianReturnPercent ?? 0) > 0,
    ).length;
    const holdSeconds = row.riskEvidence.medianHoldSeconds;
    const scoreDetails: ExperimentalDecisionWallet['scoreDetails'] = {
      edge: {
        label: 'GMGN profitability',
        detail:
          row.medianReturnPercent === null
            ? 'Missing GMGN realized median return.'
            : `Starts at 50 and adjusts with the GMGN realized median return (${row.medianReturnPercent.toFixed(1)}%).`,
      },
      consistency: {
        label: 'Consistency',
        detail:
          positivePeriods.length === 0
            ? 'No saved weekly or monthly periods.'
            : `${positivePeriodCount} of ${positivePeriods.length} saved weekly/monthly periods were positive.`,
      },
      robustness: {
        label: 'Robustness',
        detail:
          row.profitConcentration.excludingBestToken.medianReturnPercent === null
            ? 'Missing the median return after removing the best token.'
            : `Uses the median return after removing the best token (${row.profitConcentration.excludingBestToken.medianReturnPercent.toFixed(1)}%); profit concentration is currently neutral pending stronger evidence.`,
      },
      copyability: {
        label: 'Copyability',
        detail:
          holdSeconds === null
            ? 'Missing GMGN holding-time input.'
            : `Uses GMGN median holding time (${(holdSeconds / 3600).toFixed(1)}h), then subtracts ${fastTradingPenalty.toFixed(1)} fast-trading points and ${hyperactivityPenalty.toFixed(1)} historical-activity points from promoted Pattern Discovery rules.`,
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
      scores: { edge, consistency, robustness, copyability, overall: rawOverall },
      scoreDetails,
      facts: {
        gmgnPeriod: row.gmgnAggregate?.period ?? null,
        gmgnFetchedAt: row.gmgnAggregate?.fetchedAt ?? null,
        gmgnTrades: row.trades,
        gmgnBuyCount: row.gmgnAggregate?.buyCount ?? null,
        gmgnSellCount: row.gmgnAggregate?.sellCount ?? null,
        gmgnMedianPercent: row.medianReturnPercent,
        gmgnWinRatePercent: row.gmgnAggregate?.winRatePercent ?? row.winRatePercent,
        gmgnUnder15SecondsPercent: row.riskEvidence.under15SecondsPercent ?? null,
        gmgnBestTokenSharePercent:
          row.profitConcentration.bestTokenSharePositiveProfitPercent ?? null,
        gmgnRealizedProfitUsd: row.gmgnAggregate?.realizedProfit ?? null,
        gmgnFastRoundTripPercent: row.riskEvidence.fastRoundTripPercent,
        gmgnNoCostBasisPercent: row.riskEvidence.noCostBasisPercent,
        copyMedianPercent: null,
        copyCapitalUsd: null,
        duneCoveragePercent: null,
        matchedRoundTrips: 0,
        roundTripsConsidered: 0,
        medianHoldSeconds: row.riskEvidence.medianHoldSeconds,
        under15SecondsPercent: row.riskEvidence.under15SecondsPercent ?? null,
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
    generatedAt: new Date().toISOString(),
    periodDays: 30,
    readOnly: true,
    noProviderFetch: true,
    source: 'saved SQLite evidence',
    methodology: [
      '30-day saved GMGN report; Dune delayed-copy simulation is not used in this tab.',
      `Raw overall scores require all four GMGN components; thinner samples remain unavailable. Candidate status requires at least ${RULES.minTrades} GMGN trades and complete GMGN inputs.`,
      'Scores are exploratory, capped at 0–100, and missing inputs stay null.',
      'Profitability is a hard gate for final candidacy: the GMGN realized median return must be positive, even when the raw weighted score is high.',
      weighting.detail,
      promotedRules.hyperactivityThresholds.length > 0 ||
      promotedRules.hyperactivityCorrelations.length > 0 ||
      promotedRules.fastTradingCorrelations.length > 0
        ? 'Promoted/stable Pattern Discovery rules subtract evidence-calibrated penalties for extreme historical activity and under-15-second trading; missing promoted-rule evidence does not activate new penalties.'
        : 'No cross-coverage promoted pattern matched the hyperactivity/fast-trading feature list specifically, so no new penalties were activated (other promoted patterns may still affect category weighting above).',
      'Profit concentration is neutral in Robustness; the score uses performance after removing the best token until stronger evidence supports a reward or penalty.',
      'This tab does not replace or modify the production decision engine.',
    ],
    weighting,
    wallets,
  };
};
