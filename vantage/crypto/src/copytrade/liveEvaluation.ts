import type { DatabaseSync } from 'node:sqlite';
import {
  summarizeTrades,
  performanceByPeriod,
  computeProfitConcentration,
  holdSecondsPerSell,
  buildRiskNotes,
  parseAmount,
  round,
  readGmgnAggregate,
  computeCopyTradeReport,
  type CopyTradeRow,
  type RiskEvidence,
} from './scrutiny/evaluate.js';
import {
  clamp,
  positiveReturnScore,
  computeCopyabilityScore,
  computeHistoricalHyperactivityPenalty,
  computeFastTradingPenalty,
  readExperimentalDecisionWeighting,
  HYPERACTIVITY_FEATURES,
  FAST_TRADING_FEATURE,
  type ExperimentalDecisionPromotedRules,
  type CopyabilityDiagnostics,
  type CopyabilityScoreInput,
} from './experimentalDecision.js';
import {
  readPatternDiscoveryDataFingerprint,
  readPatternDiscoveryCache,
  readLatestPatternDiscoveryCache,
  patternDiscoveryCacheKey,
  MAX_PATTERN_DISCOVERY_WALLETS,
} from './discovery/patternDiscovery.js';
import {
  currentWalletFeatureValueMap,
  type CurrentWalletFeatures,
} from './features/walletFeatureEngine.js';
import {
  WALLET_FEATURE_ENGINE_VERSION,
  walletFeaturesForApplication,
} from './features/walletFeatureDefinitions.js';
import { readWalletFeatureSnapshotsBatch } from './features/walletFeatureReader.js';
import { readGmgnRiskResults } from './scrutiny/gmgnRisk.js';
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
  type WinnerPolicyResult,
  type WinnerPolicyStatus,
} from './winnerPolicy.js';
import {
  buildWalletEvidenceSnapshot,
  type WalletEvidenceSnapshot,
} from './evidence/walletEvidenceSnapshot.js';
import type {
  PatternDiscoverySensitivity,
  PatternDiscoveryCrossCoveragePattern,
} from './discovery/patternDiscoveryRunner.js';
import { weightCategoryForFeature, type DecisionLabCategory } from './decisionCategories.js';
import { SOL_ADDRESS_PATTERN } from './screening/roster.js';

export const LIVE_EVALUATION_DISCLAIMER =
  'Live Evaluation uses persisted GMGN and delayed-copy evidence; it never fetches Dune or uses a fallback verdict.';

/** Every component score Live Evaluation can produce, named distinctly from Decision Lab's own
 *  category names ("edge" never appears here) so the two are never confused in output or UI. */
type LiveEvaluationCategory =
  'historicalProfitability' | 'consistency' | 'robustness' | 'copyability';

const CATEGORY_FROM_DECISION_LAB: Record<DecisionLabCategory, LiveEvaluationCategory> = {
  edge: 'historicalProfitability',
  consistency: 'consistency',
  robustness: 'robustness',
  copyability: 'copyability',
};

export type LiveEvaluationRuleApplied = {
  feature: string;
  kind: 'threshold' | 'correlation';
  category: LiveEvaluationCategory;
  effect: number;
  pointsApplied: number;
  detail: string;
};

export type LiveEvaluationRuleUnavailable = {
  feature: string;
  reason: 'no-gmgn-mapping' | 'condition-shape-not-modeled' | 'insufficient-wallet-data';
  detail: string;
};

export type LiveEvaluationProfileLoadStatus =
  | { status: 'loaded'; dataFingerprint: string; supportingCoveragePercent: number[] }
  | { status: 'stale'; dataFingerprint: string; cachedFingerprint: string }
  | { status: 'unavailable'; reason: string };

export type LiveEvaluationGmgnStatsUsed = {
  period: '30d';
  fetchedAt: string | null;
  trades: number;
  buyCount: number | null;
  sellCount: number | null;
  medianReturnPercent: number | null;
  winRatePercent: number | null;
  medianHoldSeconds: number | null;
  fastRoundTripPercent: number | null;
  noCostBasisPercent: number | null;
  under15SecondsPercent: number | null;
  bestTokenProfitSharePercent: number | null;
  realizedProfitUsd: number | null;
  gmgnTags: string[] | null;
};

export type EvaluationTrend =
  | { available: false }
  | {
      available: true;
      scoreDelta: number | null;
      direction: 'better' | 'worse' | 'unchanged' | 'unknown';
      verdictChanged: boolean;
      previousSource: 'live' | 'decision_lab';
      previousGeneratedAt: string;
    };

export type LiveEvaluationResult = {
  walletAddress: string;
  generatedAt: string;
  featureEngineVersion: string;
  periodDays: 30;
  /** Explicit point-in-time and calculation provenance. Legacy fields remain for compatibility. */
  evidenceContext: HistoricalEvidenceContext;
  calculationVersions: typeof CALCULATION_VERSIONS;
  calculationManifestVersion: typeof CALCULATION_VERSION_MANIFEST.manifestVersion;
  evidenceSnapshot: WalletEvidenceSnapshot<
    LiveActivityEvidence,
    OfficialGmgnEvidence,
    WinnerPolicyResult['evidence']
  >;
  readOnly: true;
  noDuneFetch: true;
  disclaimer: string;
  profileLoadStatus: LiveEvaluationProfileLoadStatus;
  evidenceLevel: 'complete' | 'partial' | 'insufficient' | 'missing';
  confidence: 'high' | 'medium' | 'low' | 'none';
  verdict: 'pass' | 'reject' | 'insufficient_evidence';
  winnerPolicy: WinnerPolicyResult;
  winnerPolicyStatus: WinnerPolicyStatus;
  gmgnProfitabilityLanguage: string;
  estimatedOverallScore: number | null;
  componentScores: Record<LiveEvaluationCategory, number | null>;
  weighting:
    | {
        mode: 'validated-patterns';
        weights: Partial<Record<LiveEvaluationCategory, number>>;
        detail: string;
      }
    | { mode: 'unavailable'; detail: string };
  positiveReasons: string[];
  riskReasons: string[];
  rulesApplied: LiveEvaluationRuleApplied[];
  rulesUnavailable: LiveEvaluationRuleUnavailable[];
  gmgnStatsUsed: LiveEvaluationGmgnStatsUsed;
  copyabilityDiagnostics: CopyabilityDiagnostics;
  trend?: EvaluationTrend;
};

type LiveActivityEvidence = {
  tradeCount: number;
  medianReturnPercent: number | null;
  medianHoldSeconds: number | null;
  fastRoundTripPercent: number | null;
  under15SecondsPercent: number | null;
};
type OfficialGmgnEvidence = Omit<LiveEvaluationGmgnStatsUsed, 'gmgnTags'>;

/** Build the shared evidence contract used by this read-only evaluator. Values remain in their
 * source namespace: official 30-day GMGN aggregates are never presented as local activity or
 * delayed-copy outcomes. */
const buildLiveEvidenceSnapshot = (input: {
  walletAddress: string;
  chain: string;
  now: Date;
  row: CopyTradeRow | null;
  gmgnStatsUsed: LiveEvaluationGmgnStatsUsed;
  evidenceLevel: LiveEvaluationResult['evidenceLevel'];
  winnerPolicyEvidence: WinnerPolicyResult['evidence'];
}): WalletEvidenceSnapshot<
  LiveActivityEvidence,
  OfficialGmgnEvidence,
  WinnerPolicyResult['evidence']
> => {
  const context = createHistoricalEvidenceContext({
    chain: input.chain,
    asOf: input.now,
    periodDays: 30,
    completeness: { status: input.evidenceLevel === 'complete' ? 'complete' : 'partial' },
  });
  const { gmgnTags: _informationalTags, ...officialGmgnStats } = input.gmgnStatsUsed;
  return buildWalletEvidenceSnapshot<
    LiveActivityEvidence,
    OfficialGmgnEvidence,
    WinnerPolicyResult['evidence']
  >({
    walletAddress: input.walletAddress,
    context,
    activity: {
      status: input.row ? 'available' : 'missing',
      value: input.row
        ? {
            tradeCount: input.row.trades,
            medianReturnPercent: input.row.medianReturnPercent,
            medianHoldSeconds: input.row.riskEvidence.medianHoldSeconds,
            fastRoundTripPercent: input.row.riskEvidence.fastRoundTripPercent,
            under15SecondsPercent: input.row.riskEvidence.under15SecondsPercent ?? null,
          }
        : null,
    },
    officialGmgn: {
      status: input.row?.gmgnAggregate ? 'available' : 'missing',
      value: input.row?.gmgnAggregate ? officialGmgnStats : null,
    },
    delayedCopy: {
      status: input.winnerPolicyEvidence.endingCapitalUsd === null ? 'missing' : 'available',
      value:
        input.winnerPolicyEvidence.endingCapitalUsd === null ? null : input.winnerPolicyEvidence,
    },
    provenance: {
      activity: {
        source: 'copytrade_trades',
        exact: true,
        calculationVersion: CALCULATION_VERSIONS.walletFeatures,
      },
      officialGmgn: {
        source: 'copytrade_wallet_stats',
        exact: true,
        calculationVersion: null,
      },
      delayedCopy: {
        source: input.winnerPolicyEvidence.provenance.delayedCopy,
        exact: true,
        calculationVersion: CALCULATION_VERSIONS.delayedCopyOutcomes,
      },
    },
  });
};

// ---------------------------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------------------------

export const isSolWalletAddress = (value: string): boolean => SOL_ADDRESS_PATTERN.test(value);

export const parseLiveEvaluationRequest = (
  payload: unknown,
): { ok: true; walletAddress: string } | { ok: false; error: string } => {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'Request body must be a JSON object with a walletAddress field.' };
  }
  const walletAddress = (payload as { walletAddress?: unknown }).walletAddress;
  if (typeof walletAddress !== 'string' || walletAddress.trim() === '') {
    return { ok: false, error: 'walletAddress is required.' };
  }
  const trimmed = walletAddress.trim();
  if (!isSolWalletAddress(trimmed)) {
    return {
      ok: false,
      error:
        'walletAddress is not a valid Solana wallet address (expected 32-44 base58 characters).',
    };
  }
  return { ok: true, walletAddress: trimmed };
};

// ---------------------------------------------------------------------------------------------
// GMGN-only wallet row (mirrors computeCopyTradeReport's per-wallet assembly in evaluate.ts,
// but for exactly one address with no roster dependency -- computeCopyTradeReport silently
// skips any wallet not present in the current roster snapshot, which makes it unusable for an
// arbitrary ad-hoc address).
// ---------------------------------------------------------------------------------------------

type LiveTradeRow = {
  id: number;
  walletAddress: string;
  observedTimestamp: number;
  eventType: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  costUsd: string | null;
  buyCostUsd: string | null;
};

export const buildLiveGmgnWalletRow = (
  database: DatabaseSync,
  walletAddress: string,
  options: { chain?: string; periodDays?: number | null; now?: Date } = {},
): CopyTradeRow | null => {
  const chain = options.chain ?? 'sol';
  const periodDays = options.periodDays === undefined ? 30 : options.periodDays;
  const now = options.now ?? new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const cutoffSeconds = periodDays === null ? null : nowSeconds - periodDays * 86_400;

  const rows = database
    .prepare(
      `SELECT id, wallet_address AS walletAddress, observed_timestamp AS observedTimestamp,
            event_type AS eventType, token_address AS tokenAddress, token_symbol AS tokenSymbol,
            cost_usd AS costUsd, buy_cost_usd AS buyCostUsd
     FROM copytrade_trades
     WHERE chain = ? AND wallet_address = ? AND event_type IN ('buy', 'sell')
       AND (? IS NULL OR observed_timestamp >= ?)
     ORDER BY observed_timestamp ASC, id ASC`,
    )
    .all(chain, walletAddress, cutoffSeconds, cutoffSeconds) as unknown as LiveTradeRow[];
  if (rows.length === 0) return null;

  const completed: Array<{
    sourceId: number;
    timestamp: number;
    returnRatio: number;
    profitUsd: number;
    tokenAddress: string;
    tokenSymbol: string | null;
  }> = [];
  let excluded = 0;
  let sells = 0;
  for (const row of rows) {
    if (row.eventType !== 'sell') continue;
    sells += 1;
    const proceeds = parseAmount(row.costUsd);
    const costBasis = parseAmount(row.buyCostUsd);
    if (proceeds === null || costBasis === null || costBasis <= 0) {
      excluded += 1;
      continue;
    }
    completed.push({
      sourceId: row.id,
      timestamp: row.observedTimestamp,
      returnRatio: (proceeds - costBasis) / costBasis,
      profitUsd: proceeds - costBasis,
      tokenAddress: row.tokenAddress,
      tokenSymbol: row.tokenSymbol,
    });
  }

  const summary = summarizeTrades(completed);
  const holds = holdSecondsPerSell(rows);
  const under15SecondsCount = holds.filter((seconds) => seconds <= 15).length;
  const fastRoundTripCount = holds.filter((seconds) => seconds <= 60).length;
  const medianHold =
    holds.length === 0
      ? null
      : holds.slice().sort((a, b) => a - b)[Math.floor((holds.length - 1) / 2)];

  const statsRow = database
    .prepare(
      `SELECT wallet_address AS walletAddress, period, fetched_at AS fetchedAt,
            fund_from_address AS fundFromAddress, created_at_ts AS createdAtTs, raw_payload AS rawPayload
     FROM copytrade_wallet_stats WHERE chain = ? AND wallet_address = ? AND period = '30d'`,
    )
    .get(chain, walletAddress) as
    | {
        walletAddress: string;
        period: string;
        fetchedAt: string;
        fundFromAddress: string | null;
        createdAtTs: number | null;
        rawPayload: string;
      }
    | undefined;
  const gmgnAggregate = statsRow ? (readGmgnAggregate(statsRow) ?? undefined) : undefined;

  const riskEvidence: RiskEvidence = {
    fastRoundTripPercent:
      holds.length === 0 ? null : round((fastRoundTripCount / holds.length) * 100, 1),
    under15SecondsPercent:
      holds.length === 0 ? null : round((under15SecondsCount / holds.length) * 100, 1),
    under15SecondsCount,
    pairedTradeCount: holds.length,
    noCostBasisPercent: sells === 0 ? null : round((excluded / sells) * 100, 1),
    medianHoldSeconds: medianHold === null ? null : Math.round(medianHold),
    fundedByAddress: statsRow?.fundFromAddress ?? null,
    walletAgeDays: statsRow?.createdAtTs
      ? round((now.getTime() / 1000 - statsRow.createdAtTs) / 86_400, 1)
      : null,
  };

  const tagsRow = database
    .prepare(
      `SELECT gmgn_tags AS gmgnTags FROM copytrade_wallets
       WHERE chain = ? AND wallet_address = ? ORDER BY added_at DESC LIMIT 1`,
    )
    .get(chain, walletAddress) as { gmgnTags: string } | undefined;
  const gmgnTags = parseGmgnTags(tagsRow?.gmgnTags);

  const lastTradeAt =
    completed.length === 0 ? null : Math.max(...completed.map((c) => c.timestamp));
  const spanDays =
    completed.length === 0
      ? 0
      : (Math.max(...completed.map((c) => c.timestamp)) -
          Math.min(...completed.map((c) => c.timestamp))) /
        86_400;

  return {
    walletAddress,
    name: null,
    iconUrl: null,
    ...summary,
    verdict: 'descriptive_only',
    riskFlags: [],
    gmgnTags: gmgnTags ?? undefined,
    failedRules: [],
    excludedNoCostBasis: excluded,
    endingCapitalUsdCompounded: null,
    truncated: false,
    historyFailed: false,
    coveredDays: completed.length === 0 ? null : round(spanDays, 4),
    lastTradeAt,
    daysSinceLastTrade: lastTradeAt === null ? null : round((nowSeconds - lastTradeAt) / 86_400, 1),
    needsDuneBackfill: false,
    unreliableReason: null,
    riskEvidence,
    riskNotes: buildRiskNotes(riskEvidence, []),
    comparable: true,
    profitConcentration: computeProfitConcentration(completed),
    weeklyPerformance: performanceByPeriod(completed, 'week'),
    monthlyPerformance: performanceByPeriod(completed, 'month'),
    rankHistory: {
      walletAddress,
      leaderboardCaptures: 0,
      appearances: 0,
      topFiveAppearances: 0,
      topFiveMembershipPercent: null,
      currentRank: null,
      bestRank: null,
      worstRank: null,
      firstObservedAt: null,
      lastObservedAt: null,
    },
    ...(gmgnAggregate ? { gmgnAggregate } : {}),
  };
};

const parseGmgnTags = (raw: string | undefined): string[] | null => {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === 'string')
      : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------------------------
// Pattern Discovery promoted profile loading
// ---------------------------------------------------------------------------------------------

type CachedSensitivity = Pick<PatternDiscoverySensitivity, 'crossCoveragePromotedPatterns'>;

const SENSITIVITY_CACHE_KEY = patternDiscoveryCacheKey(
  'sensitivity',
  30,
  50,
  10,
  MAX_PATTERN_DISCOVERY_WALLETS,
);

type PromotedProfile = {
  status: LiveEvaluationProfileLoadStatus;
  patterns: PatternDiscoveryCrossCoveragePattern[];
};

const readPromotedProfile = (database: DatabaseSync): PromotedProfile => {
  const currentFingerprint = readPatternDiscoveryDataFingerprint(database);
  const current = readPatternDiscoveryCache<CachedSensitivity>(
    database,
    SENSITIVITY_CACHE_KEY,
    currentFingerprint,
  );
  if (current) {
    return {
      status: {
        status: 'loaded',
        dataFingerprint: currentFingerprint,
        supportingCoveragePercent: [
          ...new Set(
            (current.crossCoveragePromotedPatterns ?? []).flatMap(
              (entry) => entry.supportingCoveragePercent,
            ),
          ),
        ].sort((a, b) => a - b),
      },
      patterns: current.crossCoveragePromotedPatterns ?? [],
    };
  }
  const latest = readLatestPatternDiscoveryCache<CachedSensitivity>(
    database,
    SENSITIVITY_CACHE_KEY,
  );
  if (latest) {
    return {
      status: {
        status: 'stale',
        dataFingerprint: currentFingerprint,
        cachedFingerprint: latest.metadata.dataFingerprint,
      },
      patterns: latest.value.crossCoveragePromotedPatterns ?? [],
    };
  }
  return {
    status: {
      status: 'unavailable',
      reason:
        'No Pattern Discovery result has been computed for the current or any prior evidence.',
    },
    patterns: [],
  };
};

// ---------------------------------------------------------------------------------------------
// GMGN-only component scores
// ---------------------------------------------------------------------------------------------

export const estimateHistoricalProfitabilityScore = (
  medianReturnPercent: number | null,
): number | null => positiveReturnScore(medianReturnPercent);

export const estimateGmgnCopyabilityScore = (input: CopyabilityScoreInput): number | null =>
  computeCopyabilityScore(input).score;

// ---------------------------------------------------------------------------------------------
// Generic promoted-rule evaluator, for every cross-coverage-promoted pattern not already
// covered by the reused hyperactivity/fast-trading penalty functions above.
// ---------------------------------------------------------------------------------------------

type ThresholdCondition = { feature: string; operator: '>=' | '>' | '<=' | '<'; value: number };
type CorrelationCondition = {
  feature: string;
  operator: 'correlation';
  value: 'positive' | 'negative';
};

const parseThresholdCondition = (conditions: unknown): ThresholdCondition | null => {
  if (!Array.isArray(conditions) || conditions.length !== 1) return null;
  const raw = conditions[0] as { feature?: unknown; operator?: unknown; value?: unknown };
  if (
    typeof raw?.feature === 'string' &&
    (raw.operator === '>=' ||
      raw.operator === '>' ||
      raw.operator === '<=' ||
      raw.operator === '<') &&
    typeof raw.value === 'number' &&
    Number.isFinite(raw.value)
  ) {
    return { feature: raw.feature, operator: raw.operator, value: raw.value };
  }
  return null;
};

const parseCorrelationCondition = (conditions: unknown): CorrelationCondition | null => {
  if (!Array.isArray(conditions) || conditions.length !== 1) return null;
  const raw = conditions[0] as { feature?: unknown; operator?: unknown; value?: unknown };
  if (
    typeof raw?.feature === 'string' &&
    raw.operator === 'correlation' &&
    (raw.value === 'positive' || raw.value === 'negative')
  ) {
    return { feature: raw.feature, operator: 'correlation', value: raw.value };
  }
  return null;
};

const satisfiesThreshold = (value: number, condition: ThresholdCondition): boolean => {
  switch (condition.operator) {
    case '>=':
      return value >= condition.value;
    case '>':
      return value > condition.value;
    case '<=':
      return value <= condition.value;
    case '<':
      return value < condition.value;
  }
};

const percentileRank = (value: number, values: number[]): number | null => {
  if (values.length < 2) return null;
  const belowOrEqual = values.filter((candidate) => candidate <= value).length;
  return (belowOrEqual - 1) / (values.length - 1);
};

/** `prior_wallet_*` feature name -> the wallet's current value, from the same standing-wallet
 *  snapshot Pattern Discovery's own PIT accumulation produces (readCurrentWalletFeatures). */
/** The complete set of feature names Live Evaluation can resolve to a live value -- anything
 *  not in this set (every `prior_token_*`/`token_*`/`entry_*` name) has no standing-wallet
 *  equivalent and must be reported as unavailable, never silently skipped. Note some of these
 *  names share a substring with `weightCategoryForFeature`'s buckets (e.g. `prior_token_buy_count`
 *  also contains "buy_count"), so membership here -- not the category mapping -- is what decides
 *  whether a feature is GMGN-live-resolvable. */
const SUPPORTED_LIVE_FEATURES = new Set<string>(
  walletFeaturesForApplication('live_evaluation').map(({ identifier }) => identifier),
);

const liveMetricForFeature = (features: CurrentWalletFeatures, feature: string): number | null => {
  const map = currentWalletFeatureValueMap(features);
  return feature in map ? map[feature] : null;
};

export const applyPromotedGmgnRules = (
  patterns: PatternDiscoveryCrossCoveragePattern[],
  walletFeatures: CurrentWalletFeatures,
  referenceFeatures: CurrentWalletFeatures[],
): {
  rulesApplied: LiveEvaluationRuleApplied[];
  rulesUnavailable: LiveEvaluationRuleUnavailable[];
} => {
  const rulesApplied: LiveEvaluationRuleApplied[] = [];
  const rulesUnavailable: LiveEvaluationRuleUnavailable[] = [];

  for (const entry of patterns) {
    const { pattern } = entry;
    const feature = pattern.feature;
    const effect = pattern.effect;
    if (!feature || typeof effect !== 'number' || !Number.isFinite(effect)) continue;
    // Already scored via the reused, established hyperactivity/fast-trading penalty functions --
    // do not double-apply the same promoted pattern through this generic path too.
    if (HYPERACTIVITY_FEATURES.has(feature) || feature === FAST_TRADING_FEATURE) continue;

    if (!SUPPORTED_LIVE_FEATURES.has(feature)) {
      rulesUnavailable.push({
        feature,
        reason: 'no-gmgn-mapping',
        detail: `"${feature}" has no standing-wallet equivalent (per-token-entry or outcome-only feature).`,
      });
      continue;
    }
    const category = weightCategoryForFeature(feature);
    if (!category) {
      rulesUnavailable.push({
        feature,
        reason: 'no-gmgn-mapping',
        detail: `"${feature}" has no Decision Lab score category mapping.`,
      });
      continue;
    }
    const liveCategory = CATEGORY_FROM_DECISION_LAB[category];

    const threshold = parseThresholdCondition(pattern.conditions);
    if (threshold && threshold.feature === feature) {
      const value = liveMetricForFeature(walletFeatures, feature);
      if (value === null) {
        rulesUnavailable.push({
          feature,
          reason: 'insufficient-wallet-data',
          detail: `"${feature}" could not be computed from this wallet's current trade history.`,
        });
        continue;
      }
      if (!satisfiesThreshold(value, threshold)) continue;
      const points = clamp50(effect < 0 ? -effect : effect) * Math.sign(effect || 1);
      rulesApplied.push({
        feature,
        kind: 'threshold',
        category: liveCategory,
        effect,
        pointsApplied: points,
        detail: `${feature} ${threshold.operator} ${threshold.value} (current: ${value}) — promoted pattern, effect ${effect.toFixed(2)}.`,
      });
      continue;
    }

    const correlation = parseCorrelationCondition(pattern.conditions);
    if (correlation && correlation.feature === feature) {
      const value = liveMetricForFeature(walletFeatures, feature);
      const referenceValues = referenceFeatures
        .map((candidate) => liveMetricForFeature(candidate, feature))
        .filter(
          (candidate): candidate is number => candidate !== null && Number.isFinite(candidate),
        );
      if (value === null) {
        rulesUnavailable.push({
          feature,
          reason: 'insufficient-wallet-data',
          detail: `"${feature}" could not be computed from this wallet's current trade history.`,
        });
        continue;
      }
      const rank = percentileRank(value, referenceValues);
      if (rank === null) {
        rulesUnavailable.push({
          feature,
          reason: 'insufficient-wallet-data',
          detail: `"${feature}" has too small a reference population to rank this wallet against.`,
        });
        continue;
      }
      const points = round100(effect * rank);
      rulesApplied.push({
        feature,
        kind: 'correlation',
        category: liveCategory,
        effect,
        pointsApplied: points,
        detail: `${feature} is ${correlation.value}ly correlated with outcomes (effect ${effect.toFixed(2)}); this wallet ranks at the ${Math.round(rank * 100)}th percentile of the reference population.`,
      });
      continue;
    }

    rulesUnavailable.push({
      feature,
      reason: 'condition-shape-not-modeled',
      detail: `"${feature}"'s promoted condition shape (bucket range or mutual-information) has no established scoring convention in this codebase.`,
    });
  }

  return { rulesApplied, rulesUnavailable };
};

const clamp50 = (magnitude: number): number => Math.max(0, magnitude);
const round100 = (value: number): number => Math.round(value * 100) / 100;

// ---------------------------------------------------------------------------------------------
// Weighting, verdict, profitability language
// ---------------------------------------------------------------------------------------------

export const renormalizeWeights = (
  baseWeights: Partial<Record<LiveEvaluationCategory, number>>,
  availableCategories: Set<LiveEvaluationCategory>,
): Partial<Record<LiveEvaluationCategory, number>> | null => {
  const entries = [...availableCategories]
    .map((category) => [category, baseWeights[category]] as const)
    .filter((entry): entry is [LiveEvaluationCategory, number] => typeof entry[1] === 'number');
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (entries.length === 0 || total <= 0) return null;
  return Object.fromEntries(entries.map(([category, weight]) => [category, weight / total]));
};

export const deriveLiveEvaluationVerdict = (
  evidenceLevel: LiveEvaluationResult['evidenceLevel'],
  estimatedOverallScore: number | null,
): LiveEvaluationResult['verdict'] => {
  if (evidenceLevel !== 'complete' || estimatedOverallScore === null)
    return 'insufficient_evidence';
  return estimatedOverallScore >= 50 ? 'pass' : 'reject';
};

const gmgnProfitabilityLanguage = (
  evidenceLevel: LiveEvaluationResult['evidenceLevel'],
  historicalProfitabilityScore: number | null,
): string => {
  if (evidenceLevel === 'missing' || historicalProfitabilityScore === null) {
    return 'Not enough GMGN 30-day history to assess historical profitability.';
  }
  return historicalProfitabilityScore >= 50
    ? 'Likely profitable based on GMGN historical features.'
    : 'Does not match historically profitable wallet patterns.';
};

// ---------------------------------------------------------------------------------------------
// Main pure compute
// ---------------------------------------------------------------------------------------------

export const computeLiveEvaluation = (
  database: DatabaseSync,
  walletAddress: string,
  options: { chain?: string; now?: Date } = {},
): LiveEvaluationResult => {
  const chain = options.chain ?? 'sol';
  const now = options.now ?? new Date();

  const row = buildLiveGmgnWalletRow(database, walletAddress, { chain, periodDays: null, now });
  // Live Evaluation is read-only: this report consumes only already-persisted Dune matches.
  // The 90-day scope is explicit in the proof while the legacy GMGN reference fields remain 30d.
  const delayedCopyWallet = computeCopySimulationReport(database, {
    walletAddresses: [walletAddress],
    chain,
    periodDays: undefined,
    now,
  }).wallets[0];
  // Live Evaluation is current-context (not a historical replay), so a fresh GMGN risk-bundle
  // snapshot is legitimately usable here -- unlike Decision Lab, which never populates it.
  const liveActivitySnapshot = readWalletFeatureSnapshotsBatch(database, {
    walletAddresses: [walletAddress],
    asOfTimestamp: now.toISOString(),
    lookbackDays: 3650,
    includePreWindowContext: false,
    trigger: 'current',
    chain,
  }).get(walletAddress);
  const activitySignals = {
    fastRoundTripPercent: row?.riskEvidence.fastRoundTripPercent ?? null,
    under15SecondsPercent: row?.riskEvidence.under15SecondsPercent ?? null,
    medianHoldSeconds: row?.riskEvidence.medianHoldSeconds ?? null,
    tradesPerActiveDay: liveActivitySnapshot?.features.priorWalletTradesPerActiveDay ?? null,
    walletAgeDays: row?.riskEvidence.walletAgeDays ?? null,
  };
  const riskBundle = buildGmgnRiskBundleEvidence(readGmgnRiskResults(database, [walletAddress])[0]);
  const winnerPolicyEvidence = delayedCopyWallet
    ? buildWinnerPolicyEvidence(delayedCopyWallet, null, { activitySignals, riskBundle })
    : emptyWinnerPolicyEvidence(null);
  const winnerPolicy = evaluateWinnerPolicy(winnerPolicyEvidence);

  const profile = readPromotedProfile(database);

  const gmgnStatsUsed: LiveEvaluationGmgnStatsUsed = {
    period: '30d',
    fetchedAt: row?.gmgnAggregate?.fetchedAt ?? null,
    trades: row?.trades ?? 0,
    buyCount: row?.gmgnAggregate?.buyCount ?? null,
    sellCount: row?.gmgnAggregate?.sellCount ?? null,
    medianReturnPercent: row?.medianReturnPercent ?? null,
    winRatePercent: row?.winRatePercent ?? null,
    medianHoldSeconds: row?.riskEvidence.medianHoldSeconds ?? null,
    fastRoundTripPercent: row?.riskEvidence.fastRoundTripPercent ?? null,
    noCostBasisPercent: row?.riskEvidence.noCostBasisPercent ?? null,
    under15SecondsPercent: row?.riskEvidence.under15SecondsPercent ?? null,
    bestTokenProfitSharePercent:
      row?.profitConcentration.bestTokenSharePositiveProfitPercent ?? null,
    realizedProfitUsd: row?.gmgnAggregate?.realizedProfit ?? null,
    gmgnTags: row?.gmgnTags ?? null,
  };

  if (!row) {
    const evidenceLevel: LiveEvaluationResult['evidenceLevel'] = 'missing';
    const copyabilityDiagnostics = computeCopyabilityScore({
      medianHoldSeconds: null,
      fastRoundTripPercent: null,
      under15SecondPercent: null,
      pairedTradeCount: 0,
      under15SecondCount: null,
    }).diagnostics;
    return {
      walletAddress,
      generatedAt: now.toISOString(),
      featureEngineVersion: WALLET_FEATURE_ENGINE_VERSION,
      periodDays: 30,
      evidenceContext: createHistoricalEvidenceContext({
        chain,
        asOf: now,
        periodDays: 30,
        completeness: { status: 'partial' },
      }),
      calculationVersions: CALCULATION_VERSIONS,
      calculationManifestVersion: CALCULATION_VERSION_MANIFEST.manifestVersion,
      evidenceSnapshot: buildLiveEvidenceSnapshot({
        walletAddress,
        chain,
        now,
        row,
        gmgnStatsUsed,
        evidenceLevel,
        winnerPolicyEvidence,
      }),
      readOnly: true,
      noDuneFetch: true,
      disclaimer: LIVE_EVALUATION_DISCLAIMER,
      profileLoadStatus: profile.status,
      evidenceLevel,
      confidence: 'none',
      verdict: 'insufficient_evidence',
      winnerPolicy,
      winnerPolicyStatus: winnerPolicy.status,
      gmgnProfitabilityLanguage: gmgnProfitabilityLanguage(evidenceLevel, null),
      estimatedOverallScore: null,
      componentScores: {
        historicalProfitability: null,
        consistency: null,
        robustness: null,
        copyability: null,
      },
      weighting: {
        mode: 'unavailable',
        detail: 'Not enough GMGN trade history to score this wallet.',
      },
      positiveReasons: [],
      riskReasons: ['No stored GMGN trade history for this wallet in the last 30 days.'],
      rulesApplied: [],
      rulesUnavailable: [],
      gmgnStatsUsed,
      copyabilityDiagnostics,
    };
  }

  const promotedRules: ExperimentalDecisionPromotedRules =
    readExperimentalDecisionPromotedRulesFromPatterns(profile.patterns);
  const referenceRows = computeCopyTradeReport(database, {
    periodDays: 30,
    traderLimit: 100,
    chain,
    now,
  }).rows;
  const featureSnapshots = readWalletFeatureSnapshotsBatch(database, {
    walletAddresses: [walletAddress, ...referenceRows.map((candidate) => candidate.walletAddress)],
    asOfTimestamp: now.toISOString(),
    lookbackDays: 30,
    includePreWindowContext: false,
    trigger: 'current',
    chain,
  });
  const walletSnapshot = featureSnapshots.get(walletAddress) ?? null;
  const walletFeatures = walletSnapshot?.features ?? null;
  const hyperactivityPenalty = computeHistoricalHyperactivityPenalty(
    row,
    referenceRows,
    promotedRules,
  );
  const fastTradingPenalty = computeFastTradingPenalty(row, promotedRules);

  const canonical = walletSnapshot?.decisionMetrics;
  if (walletSnapshot && canonical) {
    gmgnStatsUsed.trades = canonical.completedTrades;
    gmgnStatsUsed.buyCount = walletSnapshot.features.priorWalletBuyCount;
    gmgnStatsUsed.sellCount = canonical.sellCount;
    gmgnStatsUsed.medianReturnPercent = canonical.medianReturnPercent;
    gmgnStatsUsed.winRatePercent = canonical.winRatePercent;
    gmgnStatsUsed.medianHoldSeconds = canonical.medianHoldSeconds;
    gmgnStatsUsed.fastRoundTripPercent = canonical.under60SecondsPercent;
    gmgnStatsUsed.noCostBasisPercent = canonical.noCostBasisPercent;
    gmgnStatsUsed.under15SecondsPercent = canonical.under15SecondsPercent;
    gmgnStatsUsed.bestTokenProfitSharePercent = canonical.bestTokenProfitSharePercent;
    gmgnStatsUsed.realizedProfitUsd = walletSnapshot.features.priorWalletRealizedProfitUsd;
  }
  const medianReturnPercent = canonical?.medianReturnPercent ?? row.medianReturnPercent;
  const excludingBestTokenMedianReturnPercent =
    canonical?.excludingBestTokenMedianReturnPercent ??
    row.profitConcentration.excludingBestToken.medianReturnPercent;
  const holdSeconds = canonical?.medianHoldSeconds ?? row.riskEvidence.medianHoldSeconds;
  const copyabilityResult = computeCopyabilityScore({
    medianHoldSeconds: holdSeconds,
    fastRoundTripPercent: canonical?.under60SecondsPercent ?? row.riskEvidence.fastRoundTripPercent,
    under15SecondPercent:
      canonical?.under15SecondsPercent ?? row.riskEvidence.under15SecondsPercent,
    pairedTradeCount: row.riskEvidence.pairedTradeCount,
    under15SecondCount: row.riskEvidence.under15SecondsCount,
    patternAdjustment: -(fastTradingPenalty + hyperactivityPenalty),
  });
  const baseScores: Record<LiveEvaluationCategory, number | null> = {
    historicalProfitability: estimateHistoricalProfitabilityScore(medianReturnPercent),
    consistency: canonical
      ? canonical.periodCount === 0
        ? null
        : clamp((canonical.positivePeriodCount / canonical.periodCount) * 100)
      : null,
    robustness:
      excludingBestTokenMedianReturnPercent === null
        ? null
        : clamp(50 + excludingBestTokenMedianReturnPercent * 1.25),
    copyability: copyabilityResult.score,
  };

  let rulesApplied: LiveEvaluationRuleApplied[] = [];
  let rulesUnavailable: LiveEvaluationRuleUnavailable[] = [];
  const componentScores = { ...baseScores };
  if (walletFeatures) {
    const referenceFeatures = referenceRows
      .map((candidate) => featureSnapshots.get(candidate.walletAddress)?.features ?? null)
      .filter((candidate): candidate is CurrentWalletFeatures => candidate !== null);
    const generic = applyPromotedGmgnRules(profile.patterns, walletFeatures, referenceFeatures);
    rulesApplied = generic.rulesApplied;
    rulesUnavailable = generic.rulesUnavailable;
    for (const rule of rulesApplied) {
      const current = componentScores[rule.category];
      if (current === null) continue;
      componentScores[rule.category] = clamp(current + rule.pointsApplied);
    }
  }
  if (hyperactivityPenalty > 0) {
    rulesApplied.push({
      feature: '[hyperactivity]',
      kind: 'threshold',
      category: 'copyability',
      effect: -hyperactivityPenalty,
      pointsApplied: -hyperactivityPenalty,
      detail: `Promoted hyperactivity rule(s) reduced the copyability estimate by ${hyperactivityPenalty.toFixed(1)} points.`,
    });
  }
  if (fastTradingPenalty > 0) {
    rulesApplied.push({
      feature: FAST_TRADING_FEATURE,
      kind: 'correlation',
      category: 'copyability',
      effect: -fastTradingPenalty,
      pointsApplied: -fastTradingPenalty,
      detail: `Promoted fast-trading rule reduced the copyability estimate by ${fastTradingPenalty.toFixed(1)} points.`,
    });
  }

  const weighting = readExperimentalDecisionWeighting(database);
  const availableCategories = new Set(
    (Object.keys(componentScores) as LiveEvaluationCategory[]).filter(
      (category) => componentScores[category] !== null,
    ),
  );
  const renamedWeights: Partial<Record<LiveEvaluationCategory, number>> = {
    historicalProfitability: weighting.weights.edge,
    consistency: weighting.weights.consistency,
    robustness: weighting.weights.robustness,
    copyability: weighting.weights.copyability,
  };

  let estimatedOverallScore: number | null = null;
  let weightingResult: LiveEvaluationResult['weighting'];
  if (weighting.mode === 'neutral-fallback') {
    weightingResult = {
      mode: 'unavailable',
      detail:
        'No Pattern Discovery category has survived promotion, so no validated weighting exists. A neutral/equal-weight estimate is not produced.',
    };
  } else {
    const renormalized = renormalizeWeights(renamedWeights, availableCategories);
    if (renormalized === null) {
      weightingResult = {
        mode: 'unavailable',
        detail: 'No component score is available for this wallet under the validated weighting.',
      };
    } else {
      weightingResult = {
        mode: 'validated-patterns',
        weights: renormalized,
        detail: weighting.detail,
      };
      estimatedOverallScore = clamp(
        (Object.entries(renormalized) as Array<[LiveEvaluationCategory, number]>).reduce(
          (sum, [category, weight]) => sum + (componentScores[category] ?? 0) * weight,
          0,
        ),
      );
    }
  }

  const evidenceLevel: LiveEvaluationResult['evidenceLevel'] =
    profile.status.status === 'unavailable'
      ? 'insufficient'
      : availableCategories.size === 4
        ? 'complete'
        : availableCategories.size > 0
          ? 'partial'
          : 'insufficient';
  const confidence: LiveEvaluationResult['confidence'] =
    evidenceLevel === 'complete' && profile.status.status === 'loaded'
      ? 'high'
      : evidenceLevel === 'complete' || evidenceLevel === 'partial'
        ? profile.status.status === 'loaded'
          ? 'medium'
          : 'low'
        : 'none';

  const verdict = deriveLiveEvaluationVerdict(evidenceLevel, estimatedOverallScore);
  const profitabilityLanguage = gmgnProfitabilityLanguage(
    evidenceLevel,
    componentScores.historicalProfitability,
  );

  const positiveReasons = rulesApplied
    .filter((rule) => rule.pointsApplied > 0)
    .map((rule) => rule.detail);
  const riskReasons = [
    ...rulesApplied.filter((rule) => rule.pointsApplied < 0).map((rule) => rule.detail),
    ...row.riskNotes,
  ];

  return {
    walletAddress,
    generatedAt: now.toISOString(),
    featureEngineVersion: WALLET_FEATURE_ENGINE_VERSION,
    periodDays: 30,
    evidenceContext: createHistoricalEvidenceContext({
      chain,
      asOf: now,
      periodDays: 30,
      completeness: { status: evidenceLevel === 'complete' ? 'complete' : 'partial' },
    }),
    calculationVersions: CALCULATION_VERSIONS,
    calculationManifestVersion: CALCULATION_VERSION_MANIFEST.manifestVersion,
    evidenceSnapshot: buildLiveEvidenceSnapshot({
      walletAddress,
      chain,
      now,
      row,
      gmgnStatsUsed,
      evidenceLevel,
      winnerPolicyEvidence,
    }),
    readOnly: true,
    noDuneFetch: true,
    disclaimer: LIVE_EVALUATION_DISCLAIMER,
    profileLoadStatus: profile.status,
    evidenceLevel,
    confidence,
    verdict,
    winnerPolicy,
    winnerPolicyStatus: winnerPolicy.status,
    gmgnProfitabilityLanguage: profitabilityLanguage,
    estimatedOverallScore,
    componentScores,
    weighting: weightingResult,
    positiveReasons,
    riskReasons,
    rulesApplied,
    rulesUnavailable,
    gmgnStatsUsed,
    copyabilityDiagnostics: copyabilityResult.diagnostics,
  };
};

/** Same classification `readExperimentalDecisionPromotedRules` performs, applied to a
 *  caller-supplied pattern list instead of re-reading the cache -- Live Evaluation already
 *  read the sensitivity cache once (readPromotedProfile) and must not read it a second time
 *  under a possibly-different fingerprint. */
const readExperimentalDecisionPromotedRulesFromPatterns = (
  patterns: PatternDiscoveryCrossCoveragePattern[],
): ExperimentalDecisionPromotedRules => {
  const hyperactivityThresholds: ExperimentalDecisionPromotedRules['hyperactivityThresholds'] = [];
  const hyperactivityCorrelations = new Map<string, { feature: string; effect: number }>();
  const fastTradingCorrelations = new Map<string, { feature: string; effect: number }>();
  for (const entry of patterns) {
    const { pattern } = entry;
    const feature = pattern.feature;
    const effect = pattern.effect;
    if (!feature || typeof effect !== 'number' || !Number.isFinite(effect)) continue;
    const threshold = parseThresholdCondition(pattern.conditions);
    if (HYPERACTIVITY_FEATURES.has(feature) && threshold?.operator === '>=' && effect < 0) {
      hyperactivityThresholds.push({ feature, threshold: threshold.value, effect });
      continue;
    }
    const correlation = parseCorrelationCondition(pattern.conditions);
    if (!correlation || correlation.value !== 'negative' || effect >= 0) continue;
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
