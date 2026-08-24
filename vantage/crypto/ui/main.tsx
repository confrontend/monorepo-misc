import { Fragment, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { Modal } from './components/Modal.js';
import { DataTable } from './components/DataTable.js';
import { Collapsible } from './components/Collapsible.js';
import { normalizeGmgnProfitStat } from '../src/gmgn/normalize.js';
import { assessWalletRiskGuardrails } from '../src/copytrade/scrutiny/walletRiskGuardrails.js';
import { decideThirtyDayVerdict, explainThirtyDayDecision, thirtyDayDecisionPriority } from '../src/copytrade/scrutiny/decisionEngine.js';

type Stats = {
  tokenCount: number;
  gmgnSignalCount: number;
  tokenFirstTrade: { earliest: string | null; latest: string | null };
  gmgnObserved: { earliest: string | null; latest: string | null };
  gmgnCaptured: { earliest: string | null; latest: string | null };
  signalsByType: Array<{ signalType: string; count: number }>;
};

type ImportSummary = {
  id?: number;
  batchId?: number;
  sourcePath: string;
  status?: string;
  imported: number;
  skipped: number;
  errors: number;
  duplicateFile?: boolean;
  archivePath?: string | null;
};

type DataQuality = {
  cohortTokenCount: number;
  signalCount: number;
  matchedSignalCount: number;
  unmatchedSignalCount: number;
  tokensWithSignals: number;
  tokensWithoutSignals: number;
  coveragePercent: number;
  missingTokenAddressSignals: number;
  missingSignalTypeSignals: number;
  missingObservedAtSignals: number;
  signalsWithValidationIssues: number;
};

type LastDuneImport = { fileName: string; at: string; result: ImportSummary };
type GmgnTokenAddressSummary = { addresses: string[]; total: number; matchedToCohort: number; unmatchedToCohort: number };
type RawEndpointCounts = { imported: number; skipped: number };
type RawEndpointBreakdown = { radar: RawEndpointCounts; walletRank: RawEndpointCounts; smartMoney: RawEndpointCounts; twitter: RawEndpointCounts };
type BrowserImportResult = { batchId: number; imported: number; skipped: number; errors: number; issueBreakdown: Record<string, number>; otherCaptures: number; coverageWindowsImported: number; duplicateFile: boolean; archivePath: string | null; archiveSha256: string | null; rawEndpoints: RawEndpointBreakdown };
type RawEndpointSummary = { radar: { count: number; latestCapturedAt: string | null }; walletRank: { count: number; latestCapturedAt: string | null }; smartMoney: { count: number; latestCapturedAt: string | null }; twitter: { count: number; latestCapturedAt: string | null } };
type RawEndpointType = 'radar' | 'wallet-rank' | 'smart-money' | 'twitter';
type RawRadarSnapshot = { id: number; chain: string | null; period: string | null; category: string | null; capturedAt: string; rawPayload: unknown };
type RawWalletRankSnapshot = { id: number; window: string | null; orderby: string | null; capturedAt: string; requestPath?: string | null; requestQuery?: Record<string, unknown>; rawPayload: unknown };
type RawSmartMoneyWalletStat = { id: number; walletAddress: string; chain: string | null; capturedAt: string; rawPayload: unknown };
type RawTwitterMessage = { id: number; tweetId: string | null; twType: string | null; hasToken: boolean | null; capturedAt: string; rawPayload: unknown };
type RawEndpointRow = RawRadarSnapshot | RawWalletRankSnapshot | RawSmartMoneyWalletStat | RawTwitterMessage;
type SnapshotAnalysis = { generatedAt: string; scope: 'descriptive-snapshot-only'; signals: { total: number; uniqueTokens: number; averagePerToken: number; singleSignalTokens: number; multiSignalTokens: number; maxSignalsPerToken: number }; signalTypes: Array<{ signalType: string; count: number }>; sources: Array<{ source: string; count: number }>; cohortOverlap: { matchedSignals: number; unmatchedSignals: number; matchedTokens: number }; timing: { earliestObservedAt: string | null; latestObservedAt: string | null; earliestCapturedAt: string | null; latestCapturedAt: string | null }; marketCap: { count: number; minimum: number | null; median: number | null; average: number | null; maximum: number | null }; validation: { signalsWithIssues: number; missingTokenAddress: number; missingSignalType: number; missingObservedAt: number }; limitations: string[] };
type SignalScoreRow = { signalId: number; tokenAddress: string | null; signalType: string | null; observedAt: string | null; score: number; maxScore: 8; matchedDuneToken: boolean; firstTradeKnown: boolean; firstDexKnown: boolean; firstTxKnown: boolean; signalTimeKnown: boolean; temporalOrderValid: boolean; marketCapKnown: boolean };
type SignalScoringReport = { generatedAt: string; method: 'exploratory-data-readiness-v1'; totalSignals: number; averageScore: number; scoreDistribution: Array<{ score: number; count: number }>; rows: SignalScoreRow[]; limitations: string[] };
type OutcomeCandidate = { id: number; tokenAddress: string; symbol: string | null; signalType: string | null; observedAt: string; marketCap: number | null };
type PrescreenSummary = { ruleVersion: string; auditSeed: string; maxSignalIds: number; auditFraction: number; minSignalAgeHours: number; selectedIds: number[]; selectedNewCount: number; selectedRetryCount: number; byDisposition: Record<string, number>; bySignalType: Array<{ signalType: string; captured: number; selected: number; core: number; audit: number; deferred: number; newSelected: number; retrySelected: number; tooFresh: number }> };
type MeasurementPlan = { version: string; generatedAt: string; retryDelaysMinutes: number[]; maxAttempts: number; capturedCount: number; parsedCount: number; latestCapturedAt: string | null; latestObservedAt: string | null; latestDuneCompletedAt: string | null; measuredCount: number; unmeasuredCount: number; tooFreshCount: number; inFlightCount: number; neverMaturelyAttemptedCount: number; eligibleSignalIds: number[]; eligibleNewSignalIds: number[]; eligibleRetrySignalIds: number[]; retryQueueSignalIds: number[]; byState: Record<string, number>; bySignalType: Array<{ signalType: string; captured: number; measured: number; unmeasured: number; eligible: number; pending: number; complete: number; retryEligible: number; inFlight: number; tooFresh: number; neverMaturelyAttempted: number; waitingOnRetryBuffer: number }>; prescreen: PrescreenSummary };
type DuneReconcileSummary = { checked: number; completed: number; failed: number; stillRunning: number; noApiKey: number; runIds: { completed: number[]; failed: number[]; stillRunning: number[] } };
type CopyTradeSummary = { traders: number | null; trades: number | null; historyDays: number | null; verifiedPercent: number | null; lastRunAt: string | null };
type CopyTradeFetchStatus = { running: boolean; runId: number | null; walletDone: number | null; walletTotal: number | null; tradesFetched: number | null; tradesDuplicate: number | null; tradesDailyCapped: number | null; failedWallets: number | null; requestsMade: number | null; rateLimitedUntil: string | null; status: 'idle' | 'running' | 'completed' | 'failed' | 'rate_limited' | 'cancelled'; message: string; estimatedRemainingSeconds: number | null; expectedTradesTotal?: number | null; storedTradesTotal?: number | null; remainingTradesTotal?: number | null; totalTradeProgressPercent?: number | null; currentWalletAddress?: string | null; currentWalletExpectedTrades?: number | null; currentWalletStoredTrades?: number | null; currentWalletRemainingTrades?: number | null; currentWalletProgressPercent?: number | null; currentWalletEstimatedRemainingSeconds?: number | null; totalEstimatedRemainingSeconds?: number | null; scope: 'roster' | 'winners' | 'single' | null; resumeAvailable?: boolean; estimateExceeded?: boolean; walletsWithNewData?: number; walletsAlreadyCurrent?: number };
type CopyTradeFetchEstimateBasis = { source: 'measured' | 'default'; runsCounted: number; updatedAt: string | null };
type CopyTradeFetchEstimate = { walletCount: number; freshWallets: number; coveredWallets: number; periodDays: number; estimatedRequests: number; estimatedSeconds: number; basis: CopyTradeFetchEstimateBasis; confidence: 'seeded' | 'low' | 'medium' | 'high' };
type BrowserActivityImportResult = { imported: number; duplicates: number; malformed: number; activityEndpoints: number; samples: number; archivePath: string | null; archiveSha256: string | null };
type CopyTradePeriod = { period: string; trades: number; winRatePercent: number | null; medianReturnPercent: number | null; averageReturnPercent: number | null; endingCapitalUsd: number | null };
type CopyTradeTokenProfit = { tokenAddress: string; tokenSymbol: string | null; trades: number; profitUsd: number };
type CopyTradeConcentration = { bestToken: CopyTradeTokenProfit | null; bestThreeTokens: CopyTradeTokenProfit[]; bestTokenSharePositiveProfitPercent: number | null; bestThreeSharePositiveProfitPercent: number | null; bestTradeProfitUsd: number | null; excludingBestTrade: { trades: number; medianReturnPercent: number | null; endingCapitalUsd: number | null }; excludingBestToken: { trades: number; medianReturnPercent: number | null; endingCapitalUsd: number | null } };
type CopyTradeRankHistory = { leaderboardCaptures: number; appearances: number; topFiveAppearances: number; topFiveMembershipPercent: number | null; currentRank: number | null; bestRank: number | null; worstRank: number | null; firstObservedAt: string | null; lastObservedAt: string | null };
/** GMGN's own outcome-distribution buckets. These are the closest thing the aggregate endpoint
 *  gives to a return histogram, and they answer the tail question directly: how many positions
 *  were total losses versus multi-baggers. Counts, never percentages, so a small sample cannot
 *  hide behind a ratio. */
type GmgnPnlBuckets = { lossOver50: number | null; loss50to0: number | null; gain0to2x: number | null; gain2to5x: number | null; gainOver5x: number | null };
type GmgnAggregateStats = { period: string; fetchedAt: string; realizedProfit: number | null; realizedProfitPnlPercent: number | null; nativeBalance: number | null; buyCount: number | null; sellCount: number | null; boughtCost: number | null; soldIncome: number | null; boughtFee: number | null; soldFee: number | null; totalCost: number | null; lastTimestamp: number | null; tokenCount: number | null; winRatePercent: number | null; averageHoldingPeriodSeconds: number | null; buckets: GmgnPnlBuckets; tags: string[]; walletCreatedAt: number | null; twitterName: string | null; createdTokenCount: number | null };
type GmgnStatsFetchStatus = { running: boolean; status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'; walletDone: number; walletTotal: number; periods: string[]; requestsMade: number; skippedFresh: number; error: string | null; startedAt: string | null; completedAt: string | null };
type GmgnStatsRecord = { walletAddress: string; period: string; fetchedAt: string; rawPayload: string };
type CopyTradeHistoryRow = { id: number; walletAddress: string; chain: string; txHash: string; eventType: string; tokenAddress: string; tokenSymbol: string | null; observedTimestamp: number; tokenAmount: string | null; costUsd: string | null; buyCostUsd: string | null; priceUsd: string | null; gasUsd: string | null; dexUsd: string | null; launchpadPlatform: string | null; fetchedAt: string };
type CopyTradeHistoryResponse = { walletAddress: string; chain: string; total: number; rows: CopyTradeHistoryRow[]; coverage: { requestsUsed: number; periodDays: number | null; truncated: number; stopReason: string | null; updatedAt: string; resumeCursor: string | null } | null };
type PatternDiscoveryExport = { metadata: { project: 'crypto'; outcome: 'net_return_after_costs'; outcome_horizon: string; period_days: number; coverage_scope: 'outcome_exact_100_percent'; coverage_semantics: string; selection_rule: string; selected_wallet_count: number; exported_rows: number; excluded_wallets_not_exactly_100_percent: number; export_generated_at: string }; rows: Array<{ event_id: string; event_time: string; entity_id: string; signal_type: string; wallet_address: string; token_address: string; net_return_after_costs: number; coverage_rate_percent: 100 }> };
type PatternDiscoveryReport = { project: 'crypto'; patterns: Array<{ source?: string; kind?: string; feature?: string; conditions?: unknown; effect?: number | null; discovery_sample_size?: number; validationStatus?: string; validation?: { sample_size?: number; effect_vs_all?: number | null; reason?: string }; reason?: string }>; status_counts: Record<string, number>; input_contract?: { feature_allowlist_version?: string; rejected_fields?: string[] }; split: { method?: string; discovery_rows?: number; validation_rows?: number; untouched_holdout_rows?: number; holdout_policy?: string; holdout_used_for_discovery?: boolean; holdout_used_for_validation?: boolean; [key: string]: unknown }; language?: string };
type PatternDiscoveryExecution = { pythonExecutable: string; inputPath: string; outputPath: string; sharedRoot: string };
type PatternDiscoveryRunResponse = { report: PatternDiscoveryReport; execution?: PatternDiscoveryExecution };

const patternFeatureLabel = (feature: string | undefined): string => ({
  prior_wallet_trade_count: 'Previous wallet trades',
  prior_token_trade_count: 'Previous trades for this token',
  prior_wallet_buy_volume_usd: 'Previous wallet buy volume',
}[feature ?? ''] ?? feature?.replaceAll('_', ' ') ?? 'Unknown feature');

const formatPatternNumber = (value: number): string => {
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}k`;
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2);
};

const patternConditionText = (feature: string | undefined, conditions: unknown): string => {
  if (!Array.isArray(conditions) || conditions.length === 0) return 'No simple rule was reported.';
  const parts = conditions.map((condition) => {
    if (!condition || typeof condition !== 'object') return null;
    const item = condition as { lower?: number; upper?: number; operator?: string; value?: number | string };
    if (typeof item.lower === 'number' && typeof item.upper === 'number') return `${formatPatternNumber(item.lower)} – ${formatPatternNumber(item.upper)}`;
    if (item.operator === '>=') return `${formatPatternNumber(Number(item.value))}+`;
    if (item.operator === '<=') return `≤ ${formatPatternNumber(Number(item.value))}`;
    if (item.operator === 'correlation' && item.value === 'negative') return 'Higher values → lower outcomes';
    if (item.operator === 'correlation' && item.value === 'positive') return 'Higher values → higher outcomes';
    if (item.operator && item.value !== undefined) return `${item.operator} ${item.value}`;
    return null;
  }).filter((part): part is string => Boolean(part));
  return parts.join(' and ') || 'No simple rule was reported.';
};
type ResearchUpdateSummary = {
  completedAt: string; rosterSnapshotId: number | null; rosterWalletCount: number; rosterAdded: number; rosterAlreadyPresent: number;
  statsStatus: string; statsWalletDone: number; statsWalletTotal: number; statsRequests: number; statsReused: number;
  duneSubmitted: number; duneBatches: number; duneExhausted: boolean;
  beforeRows: number; beforeStatsRows: number; beforeMatched: number; beforeVerdicts: Record<string, number>; beforeVerdictByWallet: Record<string, string>;
  leaderboardOrderby: string; leaderboardMinWinrate30d: number;
};
type RosterChange = { joinedWallets: string[]; leftWallets: string[]; live: boolean; capturedAt: string | null };
type RosterWalletComparison = { walletAddress: string; chain: string; name: string | null; iconUrl?: string | null; rankPosition: number | null; reportedPnl30d: string | null; reportedWinrate30d: string | null; riskFlags: string[] };
type RosterComparison = { currentSnapshotId: number | null; currentCapturedAt: string | null; previousSnapshotId: number | null; previousCapturedAt: string | null; baselineAvailable: boolean; current: RosterWalletComparison[]; joined: RosterWalletComparison[]; left: RosterWalletComparison[] };
type WalletScreenSummary = {
  completedAt: string; snapshotId: number | null; walletCount: number; statsWalletCount: number;
  fastWallets: number; notFastWallets: number; missingStatsWallets: number;
  totalTrades: number; maxTrades: number; maxTradesWallet: string | null;
  activityLeaders: Array<{ wallet: string; name: string | null; trades: number; rank: number | null; netProfit: number | null; averageHoldSeconds: number | null }>;
  periodDays: number; averageHoldThresholdSeconds: number; lastFetchedAt: string | null;
};
type GmgnLeaderboardMetric = { pnl1d: unknown; pnl7d: unknown; pnl30d: unknown; dailyProfit7d: unknown };
type CopyTradeRow = { walletAddress: string; name: string | null; iconUrl?: string | null; trades: number | null; winRatePercent: number | null; medianReturnPercent: number | null; averageReturnPercent: number | null; endingCapitalUsd: number | null; endingCapitalUsdCompounded: number | null; coveredDays: number | null; capitalPath?: Array<{ day: string; capitalUsd: number }>; verdict: 'screen_pass' | 'no' | 'thin' | 'flagged' | 'descriptive_only'; comparable: boolean; riskFlags: string[]; gmgnTags?: string[]; failedRules: string[]; truncated?: boolean; historyFailed?: boolean; riskEvidence?: { medianHoldSeconds: number | null; walletAgeDays: number | null; under15SecondsPercent?: number | null; under15SecondsCount?: number; pairedTradeCount?: number }; profitConcentration: CopyTradeConcentration; weeklyPerformance: CopyTradePeriod[]; monthlyPerformance: CopyTradePeriod[]; rankHistory: CopyTradeRankHistory; representativeSampled?: boolean; representativePopulationTrades?: number; representativeSampleTrades?: number; gmgnAggregate?: GmgnAggregateStats };
type CopyTradeResults = { computedAt: string; startingCapitalUsd: 100; periodDays: number | null; rows: CopyTradeRow[]; overall: CopyTradeOverallRow; overallByWallet: CopyTradeOverallRow; rules: { minTrades: number | null; minDays: number | null; requiresPositiveMedian: boolean }; representativeSampling?: { method: string; maxSellsPerWallet: number | null; sampledWallets: number; populationTrades: number; selectedTrades: number }; scope?: { rosterSnapshotId: number | null; rosterProvenance: { capturedAt: string; window: string | null; orderby: string | null; requestPath: string | null; requestQuery: Record<string, unknown> } | null }; walletPerformance?: { status: 'available'; description: string }; copySimulation?: { status: 'not_available'; description: string; requiredInputs: string[] } };

type CopyTradeOverallRow = { trades: number | null; winRatePercent: number | null; medianReturnPercent: number | null; averageReturnPercent: number | null; endingCapitalUsd: number | null; weighting: 'trade-weighted' | 'wallet-weighted'; wallets: number | null };
type CopyTradeSortKey = 'name' | 'trades' | 'winRatePercent' | 'medianReturnPercent' | 'averageReturnPercent' | 'endingCapitalUsd' | 'verdict';
type DecisionSortKey = 'default' | 'rank' | 'name' | 'verdict' | 'gmgnPnl' | 'copyResult' | 'copyCapital' | 'coverage' | 'activity';
type GmgnStatsSortKey = 'name' | 'pnl1d' | 'pnl7d' | 'pnl30d' | 'dailyProfit7d' | 'win7d' | 'win30d' | 'activity' | 'equivalent' | 'updated';
type CopyDelaySortKey = 'trader' | 'totalTrades7d' | 'totalTrades30d' | 'medianHold' | 'delayShare' | 'edge' | 'reading';
type CopySimulationBatchOutcome = { batch: number; targets: number; status: 'running' | 'stored' | 'failed'; seconds: number | null; error: string | null };
type CopySimulationRunStatus = { mode?: 'precise' | 'wide_retry'; running: boolean; cancelRequested: boolean; targetsTotal: number; targetsProcessed: number; batchesRun: number; currentBatch: number; batchesTotal: number; message: string; batches: CopySimulationBatchOutcome[]; startedAt: string | null; finishedAt: string | null; storedTargets: number; failedTargets: number; remainingTargets: number; retryableTargetsBefore?: number | null; retryableTargetsRemaining?: number | null; coverageBeforePercent?: number | null; coverageAfterPercent?: number | null; outcome: 'idle' | 'running' | 'complete' | 'partial' | 'stopped' | 'error'; duneExecutionId: string | null; duneState: string | null; dunePollCount: number; duneElapsedSeconds: number; duneIsExecutionFinished: boolean; duneExecutionCostCredits: number | null; duneLastStatusAt: string | null; duneRequestPhase?: 'status_requesting' | 'status_received' | 'results_requesting' | 'results_received' | 'idle'; duneLastHttpStatus?: number | null; duneLastRequestMs?: number | null; duneLastPayload?: string | null; persistedRun?: { id: number; status: string; requestedAt: string; completedAt: string | null; storedTargets: number; searchWindowMinutes: number; matchSource: string } | null; audit?: { id: number; requestedAt: string; completedAt: string | null; mode: string; walletCount: number; plannedTargets: number; submittedTargets: number; storedTargets: number; failedTargets: number; remainingTargets: number; status: string; message: string | null } | null };
type CopySimulationDuneResponse = { id: number; executionId: string | null; status: string; requestedAt: string; completedAt: string | null; tradeCount: number; archivePath: string | null; archiveSha256: string | null; rawResult: string | null };

type HistoricalConsistencyVerdict = 'consistent' | 'declining' | 'recent_only' | 'consistently_negative' | 'insufficient';
type HistoricalConsistencySplit = 'fixed_60_30' | 'relative_half' | 'insufficient_depth';
type HistoricalPeriodReport = {
  label: 'early' | 'recent'; startAt: string | null; endAt: string | null; trades: number;
  summary: { trades: number; winRatePercent: number | null; medianReturnPercent: number | null; averageReturnPercent: number | null; endingCapitalUsd: number | null; endingCapitalUsdCompounded: number | null };
  weeklyConsistency: { positivePeriods: number; periodsWithData: number; positivePercent: number | null };
  profitConcentration: { bestToken: { tokenAddress: string; tokenSymbol: string | null } | null; bestTokenSharePositiveProfitPercent: number | null; bestThreeSharePositiveProfitPercent: number | null };
};
type HistoricalConsistencyRow = {
  walletAddress: string; availableDays: number | null; split: HistoricalConsistencySplit; splitPointAt: string | null;
  early: HistoricalPeriodReport; recent: HistoricalPeriodReport; verdict: HistoricalConsistencyVerdict;
  name: string | null; rankPosition: number | null; riskFlags: string[];
};
type HistoricalConsistencyReport = {
  computedAt: string;
  rules: { minimumHistoryDays: number; fixedHistoryDays: number; recentDays: number; description: string };
  totalWallets: number;
  counts: Record<HistoricalConsistencyVerdict, number>;
  rows: HistoricalConsistencyRow[];
  scope?: { chain: string; traderLimit: number; rosterSize: number };
};

type CaptureHealth = {
  latestSnapshotAt: string | null; latestSnapshotId: number | null;
  latestProvenanceStatus: 'provenanced' | 'legacy_unprovenanced' | null; latestFilterHash: string | null;
  latestProvenancedSnapshotId: number | null; hoursSinceLastCapture: number | null;
  distinctCaptureDatesForLatestFilter: number; legacySnapshotCount: number; provenancedSnapshotCount: number;
};
type CopyTradeRosterSnapshot = { snapshotId: number; capturedAt: string; provenanceStatus: 'provenanced' | 'legacy_unprovenanced'; window: string | null; orderby: string | null; filterHash: string | null; };
type CopyTradeRosterCatalog = { selectedByDefault: number | null; snapshots: CopyTradeRosterSnapshot[] };
type CopyCandidate = {
  walletAddress: string; name: string | null; rankPosition: number | null;
  medianReturnPercent: number | null; winRatePercent: number | null; trades: number;
  endingCapitalUsd: number | null; endingCapitalUsdCompounded: number | null; coveredDays: number | null; analysisPeriodDays: number;
  medianHoldSeconds: number | null; fastRoundTripPercent: number | null; concentrationPercent: number | null;
  bestTokenSymbol: string | null; historicalConsistencyVerdict: HistoricalConsistencyVerdict | null;
  gmgnProfileUrl: string;
  daysSinceLastTrade: number | null;
  dormant: boolean;
  copySurvivalStatus: 'survives' | 'fails_copy_survival' | 'not_yet_simulated';
  simulatedMedianReturnPercent: number | null;
  simulatedMeanReturnPercent: number | null;
  tradesAbove100Percent: number;
  tailShareOfMeanPercent: number | null;
  copySimulationCoverageRatePercent: number | null;
};
type CopyCandidatesReport = {
  computedAt: string;
  thresholds: { minMedianHoldSeconds: number; maxFastRoundTripPercent: number; maxConcentrationPercent: number; requiredHistoricalConsistencyVerdict: string };
  screenedCount: number; candidates: CopyCandidate[]; excludedCount: number;
  pendingCopySimulationCount: number; failedCopySurvivalCount: number;
  highUpsideCandidates: CopyCandidate[]; highUpsidePendingSimulationCount: number;
};
type ScrutinyVerdict = 'pass' | 'fail' | 'insufficient';
type ScrutinyCheck<M> = { key: string; label: string; verdict: ScrutinyVerdict; n: number; detail: string; metrics: M };
type CandidateScrutinyReport = {
  walletAddress: string; name: string | null; computedAt: string;
  selectionContext: { candidateCount: number; screenedCount: number; note: string };
  checks: {
    dormancy: ScrutinyCheck<{ daysSinceLastTrade: number | null; dormantAfterDays: number }>;
    coverage: ScrutinyCheck<{ inWindowMatched: number; inWindowTotal: number; inWindowPercent: number | null; fullHistoryMatched: number; fullHistoryTotal: number; fullHistoryPercent: number | null }>;
    coverageBias: ScrutinyCheck<{ matchedBigWinPercent: number | null; matchedN: number; unmatchedBigWinPercent: number | null; unmatchedN: number; gapPercentagePoints: number | null; direction: 'conservative' | 'optimistic' | 'unclear' | 'no_gap' }>;
    concentration: ScrutinyCheck<{ bestTokenSymbol: string | null; bestTokenSharePercent: number | null; medianWithToken: number | null; medianWithoutToken: number | null; tradesWithoutToken: number }>;
    repeatEntry: ScrutinyCheck<{ repeatEntryMedianReturnPercent: number | null; repeatEntryN: number; singleEntryMedianReturnPercent: number | null; singleEntryN: number }>;
    buySellComposition: ScrutinyCheck<{ buyCount: number; sellCount: number; buySharePercent: number | null }>;
    medianMeanDivergence: ScrutinyCheck<{ medianReturnPercent: number | null; averageReturnPercent: number | null; diverges: boolean }>;
    tailFragility: ScrutinyCheck<{ top3SharePercent: number | null; tradesAboveThreshold: number; thresholdPercent: number; simulatedTrades: number }>;
    copyability: ScrutinyCheck<{ medianHoldSeconds: number | null; copierDelaySeconds: number; delayMultiple: number | null; minRequiredMultiple: number }>;
    outOfSampleStability: ScrutinyCheck<{ splitDate: string | null; earlyMedianReturnPercent: number | null; earlyN: number; lateMedianReturnPercent: number | null; lateN: number }>;
  };
};
type ScrutinyResponse = { reports: CandidateScrutinyReport[]; cappedAt: number; requested: number; missingWallets: string[] };
type GmgnRiskMetrics = {
  realizedProfit: number | null; realizedPnlPercent: number | null; winRate: number | null; buys: number | null; sells: number | null;
  fees: number | null; averageHoldingSeconds: number | null; nativeBalance: number | null; tokenCount: number | null;
  risk: { noBuyHold: number | null; noBuyHoldRatio: number | null; sellPassBuy: number | null; sellPassBuyRatio: number | null; fastTx: number | null; fastTxRatio: number | null };
  pnlDistribution: Record<string, number | string>;
};
type GmgnRiskResult = { walletAddress: string; period: '30d'; available: boolean; metrics?: GmgnRiskMetrics; error?: string };
type GmgnRiskResponse = { results: GmgnRiskResult[]; requestedWallets: number; requestedPeriods: string[] };

const normalizeImportedGmgnRisk = (payload: unknown): GmgnRiskMetrics | null => normalizeGmgnProfitStat(payload);

type EliminationReason = 'strongly_negative_30d_pnl' | 'negative_delayed_copy_result' | 'hold_time_shorter_than_copy_delay';
type CoverageGapDirection = 'conservative' | 'optimistic' | 'unclear' | 'no_gap';
type HiddenLossRisk = 'high' | 'moderate' | 'negligible' | 'unknown';
type CoverageGapAssessment = {
  matchedBigWinPercent: number | null; matchedN: number;
  unmatchedBigWinPercent: number | null; unmatchedN: number;
  gapPercentagePoints: number | null; upsideBiasWeightedPercentagePoints: number | null; direction: CoverageGapDirection;
  shownLossRatePercent: number | null; trueLossRatePercent: number | null;
  lossRateUnderstatedPercentagePoints: number | null; hiddenLossRisk: HiddenLossRisk; hiddenUpsideBias: HiddenLossRisk;
};
type WalletEliminationEntry = {
  walletAddress: string; name: string | null; trades: number; truncated: boolean;
  duneCoveragePercent: number | null; duneMissedTrades: number | null; gmgnPnl30dPercent: number | null;
  simulatedMedianReturnPercent: number | null; medianHoldSeconds: number | null;
  coverageGap: CoverageGapAssessment | null;
  trustworthy: boolean; eliminated: boolean; reasons: EliminationReason[];
};
/** Plain-language reading of whether a wallet's missing Dune data actually changes the picture.
 *  "Hides big wins" is the cohort-wide pattern (unmatched trades ~2x more likely to be big
 *  winners) showing up in this specific wallet — its real edge is probably understated. */
/** Answers the only question that matters for "don't lose money": is this wallet's real losing-
 *  trade rate worse than the measured sample shows? Coverage-weighted, so a wallet with 99%
 *  coverage is never flagged for a difference that moves its true rate by a fraction of a point. */
const HIDDEN_LOSS_LABELS: Record<HiddenLossRisk, { label: string; tone: string }> = {
  high: { label: 'Hides real losses', tone: 'negative' },
  moderate: { label: 'Hides some losses', tone: 'copytrade-warning-text' },
  negligible: { label: 'Safe to trust', tone: 'positive' },
  unknown: { label: 'Cannot tell', tone: '' },
};
/**
 * The four states the canonical decision table reduces to. The underlying verdict logic keeps
 * its six finer-grained values (they carry the *reason*, shown on hover); this is purely the
 * reader-facing collapse, so there is one vocabulary on screen instead of six.
 *
 * Wording is deliberately descriptive rather than instructional. Every threshold behind these
 * states — 50 trades, 90% coverage, the 10pp hidden-loss bar, the assumed 15s copy delay — is
 * reasoned but none has been calibrated against a realised trading outcome, and this project
 * produces descriptive research only. "Passed all tests" is a claim this codebase can actually
 * support; "copy now" is not.
 */
type DecisionState = 'passed' | 'watch' | 'rejected' | 'needs_data';
const DECISION_STATES: Record<DecisionState, { label: string; tone: string; blurb: string }> = {
  passed: { label: 'Consistently profitable (30d)', tone: 'pass', blurb: 'Positive typical copied trade, positive in every measured week, and no decline between its earlier and recent history — over 30 days of measured evidence' },
  watch: { label: 'Watch', tone: 'watch', blurb: 'Historically positive overall, but not consistently: it fails the copy test, or its profit is not spread across the period' },
  rejected: { label: 'Rejected', tone: 'fail', blurb: 'Failed a check on evidence good enough to trust' },
  needs_data: { label: 'Needs more evidence', tone: 'pending', blurb: 'The decision evidence is incomplete; this may or may not be fixable with another fetch' },
};
const DECISION_ORDER: DecisionState[] = ['passed', 'watch', 'rejected', 'needs_data'];
const decisionStateFor = (verdict: string): DecisionState =>
  verdict === 'Tested candidate' ? 'passed'
    : verdict === 'Watch' ? 'watch'
    : verdict === 'Needs data' || verdict === 'Historical / stale' ? 'needs_data'
    : 'rejected';

/** Age of the newest GMGN stats response behind a row, as a short human string. Surfaced as its
 *  own column because a verdict computed from a week-old snapshot is a different claim from the
 *  same verdict computed an hour ago, and nothing else on the row reveals that. */
const freshnessLabel = (fetchedAt: string | null | undefined): { text: string; stale: boolean } => {
  if (!fetchedAt) return { text: 'never', stale: true };
  const ms = Date.now() - Date.parse(fetchedAt);
  if (!Number.isFinite(ms)) return { text: 'unknown', stale: true };
  const hours = ms / 3_600_000;
  if (hours < 1) return { text: `${Math.max(1, Math.round(ms / 60_000))}m ago`, stale: false };
  if (hours < 24) return { text: `${Math.round(hours)}h ago`, stale: false };
  return { text: `${Math.round(hours / 24)}d ago`, stale: true };
};

const COPY_EVIDENCE_MIN_COVERAGE_PERCENT = 90;
const COPY_EVIDENCE_MIN_ROUND_TRIPS = 30;
/** Weeks of the wallet's own history that must be measured, and all positive, before the verdict
 *  will call it consistent. 3 rather than 4 because a 30-day window yields 4 calendar weeks only
 *  when it aligns, and a wallet should not fail purely on where the month boundary fell. Like
 *  every other threshold in this tab, a reasoned choice, not one calibrated against a realised
 *  trading outcome. */
const MIN_CONSISTENT_WEEKS = 3;

type DuneRefetchEstimate = { targetsNeeded: number; secondsPerTarget: number; estimatedSeconds: number; basis: 'measured' | 'seeded'; runsCounted: number };
type EliminationReport = {
  generatedAt: string; totalWallets: number; eliminated: WalletEliminationEntry[]; surviving: WalletEliminationEntry[];
  survivorsNeedingDune: WalletEliminationEntry[]; survivorsNeverSimulatedCount: number; measuredDuneTargetsRemaining: number;
  duneEstimate: DuneRefetchEstimate; periodDays?: number;
};
const ELIMINATION_REASON_LABELS: Record<EliminationReason, string> = {
  strongly_negative_30d_pnl: 'Strongly negative 30d P&L',
  negative_delayed_copy_result: 'Negative delayed-copy result',
  hold_time_shorter_than_copy_delay: 'Hold time shorter than copy delay',
};
const formatSeconds = (seconds: number): string => {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
};
// Must match MAX_SCRUTINY_WALLETS in src/copytrade/candidateScrutiny.ts — duplicated here per
// this file's existing convention (see CHECKPOINT_COLUMNS above) rather than sharing a module
// between the server and browser bundles.
const MAX_SCRUTINY_WALLETS_UI = 100;
const SCRUTINY_VERDICT_LABELS: Record<ScrutinyVerdict, string> = { pass: 'Pass', fail: 'Fail', insufficient: 'Insufficient data' };
/** Shape + color together, not color alone, so the compact table cells stay readable for a
 *  colorblind reader without needing the text label spelled out in every row. */
const SCRUTINY_VERDICT_ICONS: Record<ScrutinyVerdict, string> = { pass: '✓', fail: '✕', insufficient: '–' };
type CopySimulationTradeResult = { tokenAddress: string; tokenSymbol: string | null; buyAt?: string; sellAt?: string; holdSeconds?: number; walletReturnPercent: number | null; simulatedReturnPercent: number | null; edgeKeptPercent?: number | null; status: 'simulated' | 'missing_entry_match' | 'missing_exit_match' | 'not_yet_queried'; entryMatchedAt?: string | null; exitMatchedAt?: string | null; entryGapSeconds: number | null; exitGapSeconds: number | null; gasFeeSol: number | null; gasFeeUsd?: number | null; entryTradeAmountUsd: number | null; exitTradeAmountUsd: number | null };
type FixedStakePortfolioReport = { startingCapitalUsd: number; stakePerTradeUsd: number; maxOpenPositions: number; endingCapitalUsd: number; realizedPnlUsd: number; markToMarketPnlUsd?: number; openPositionsMarked?: number; openPositionsUnpriced?: number; eligibleTrades: number; copiedTrades: number; skippedInsufficientCash: number; skippedMaxOpenPositions: number; maxConcurrentPositions: number; gasFeeSol: number; gasFeeUsd?: number; gasCostComplete?: boolean; capitalPath: Array<{ day: string; capitalUsd: number }>; tradeCapitalPath?: Array<{ trade: number; tradeId?: number; day: string; capitalUsd: number }> };
type CopySimulationWalletReport = { walletAddress: string; roundTripsConsidered: number; copiedTrades: number; missedTrades: number; coverageRatePercent: number | null; coverageStatus: 'fully_covered' | 'partially_covered' | 'missing_local_history' | 'no_dune_match' | 'small_sample'; coverageStatusReason: string; localHistoryTruncated: boolean; localHistoryStopReason: string | null; walletMedianReturnPercent: number | null; simulatedMedianReturnPercent: number | null; walletMeanReturnPercent: number | null; simulatedMeanReturnPercent: number | null; tradesAbove100Percent: number; tradesAbove300Percent: number; bestSimulatedReturnPercent: number | null; tailShareOfMeanPercent: number | null; delayCostPercentagePoints: number | null; worstSimulatedReturnPercent: number | null; totalGasFeeSol: number | null; totalGasFeeUsd?: number | null; gasCostComplete?: boolean; portfolio?: FixedStakePortfolioReport; trades: CopySimulationTradeResult[]; pendingDuneTargets?: number; duneNoMatchTargets?: number; duneMatchedTargets?: number };
type CopySimulationReport = { computedAt: string; pendingDuneTargets?: number; duneNoMatchTargets?: number; duneMatchedTargets?: number; assumptions: { copierDelaySeconds: number; feeBps: number; slippageBps: number; gasPriorityFeeSolPerTx: number; maxMatchGapSeconds: number; maxRoundTripsPerWallet: number | null; startingCapitalUsd: number; stakePerTradeUsd: number; maxOpenPositions: number }; wallets: CopySimulationWalletReport[] };
type LiquidityBandStats = { band: 'low' | 'medium' | 'high'; minEntryTradeAmountUsd: number; maxEntryTradeAmountUsd: number; tradeCount: number; simulatedCount: number; missedCount: number; winRatePercent: number | null; medianSimulatedReturnPercent: number | null; medianWalletReturnPercent: number | null; medianDelayCostPercentagePoints: number | null; missedTradeRatePercent: number | null; reliable: boolean };
type WalletLiquidityConcentration = { walletAddress: string; bands: LiquidityBandStats[] };
type LiquidityImpactReport = { computedAt: string; dataSource: 'dune_matched_trade_amount_usd'; measuredVsProxied: 'proxied'; bandedOnField: 'entryTradeAmountUsd'; minReliableSample: number; totalTradesConsidered: number; unbandableCount: number; bands: LiquidityBandStats[]; byWallet: WalletLiquidityConcentration[] };
type OutcomeTimeline = { signal: OutcomeCandidate; checkpoints: Array<{ label: string; targetTimestamp: string; result: { priceUsd: number | null; status: string; priceHttpStatus: number | null; archivePath: string | null } }> };
// Must match src/dune/outcomes.ts's CHECKPOINT_OFFSETS. Kept as its own literal here rather than
// imported, matching this file's existing convention of duplicating small server-side constants
// rather than sharing a module between the server and browser bundles.
const CHECKPOINT_COLUMNS = ['+5m', '+15m', '+30m', '+1h', '+3h'] as const;
const OUTCOME_CHECKPOINT_LABELS = ['signal', ...CHECKPOINT_COLUMNS];
type OutcomeSortKey = 'signal' | 'type' | 'token' | typeof CHECKPOINT_COLUMNS[number];
type SignalPatternGroup = { key: string; n: number; nWithData: number; nMissing: number; nStale: number; nFresh: number; nDistinctTokens: number; nCaptured: number; nMatured: number; coveragePct: number | null; captureDates: number; nRepeatedExcluded: number; maxBaselineTradeAgeSeconds: number | null; maxTargetTradeAgeSeconds: number | null; upCount: number; upPct: number | null; avgReturnPct: number | null; medianReturnPct: number | null; p25ReturnPct: number | null; worstReturnPct: number | null; bestReturnPct: number | null; verdict: 'insufficient data' | 'promising but fragile' | 'mixed' | 'weak'; reliable: boolean };
type SignalPatternHorizonReport = { horizon: string; overall: SignalPatternGroup; groups: SignalPatternGroup[] };
type SignalPatternReport = { computedAt: string; method: string; groupBy: string; upThreshold: number; minReliableSample: number; minCoveragePct: number; minCaptureDates: number; analysisUnit: string; tradeAgePolicy: string; disclaimer: string; staleNote: string; horizons: SignalPatternHorizonReport[]; sourceRunIds: number[] };
type SignalPatternSnapshot = { id: number; computedAt: string; params: { groupBy: string; upThreshold: number; minReliableSample: number; minCoveragePct: number; minCaptureDates: number; analysisUnit: string }; sourceRunIds: number[]; report: SignalPatternReport };
type SubgroupProperty = 'launchPlatform' | 'tokenAge' | 'combined';
type SignalPatternSubgroupHorizonReport = { horizon: string; cellCount: number; nUnextractable: number; groups: SignalPatternGroup[] };
type SignalPatternSubgroupReport = { computedAt: string; method: string; property: SubgroupProperty; minReliableSample: number; minCoveragePct: number; minCaptureDates: number; disclaimer: string; horizons: SignalPatternSubgroupHorizonReport[] };
const SUBGROUP_PROPERTY_LABELS: Record<SubgroupProperty, string> = { launchPlatform: 'Launch platform', tokenAge: 'Token age at signal', combined: 'All combined' };
const SUBGROUP_PROPERTY_DESCRIPTIONS: Record<SubgroupProperty, string> = { launchPlatform: 'launch platform', tokenAge: 'token age', combined: 'launch platform × token age' };

// Independent from the top-level report's own best-horizon pick (see bestPatternHorizon) —
// a subgroup breakdown can have a different "most interesting" horizon than the aggregate
// picture, since it's about surfacing a standout cell, not the overall median. Picks the
// horizon whose single best *reliable* cell has the highest median, tie-broken by how many
// cells are reliable at all (more statistical footing, not just one lucky cell).
const bestSubgroupHorizon = (report: SignalPatternSubgroupReport): string | null => {
  const scored = report.horizons.map((horizon) => {
    const reliable = horizon.groups.filter((group) => group.reliable);
    const bestMedian = reliable.length ? Math.max(...reliable.map((group) => group.medianReturnPct ?? -Infinity)) : null;
    return { horizon: horizon.horizon, bestMedian, reliableCount: reliable.length };
  });
  const withReliable = scored.filter((entry) => entry.bestMedian !== null);
  return [...withReliable].sort((left, right) => {
    const medianDelta = (right.bestMedian ?? -Infinity) - (left.bestMedian ?? -Infinity);
    if (medianDelta !== 0) return medianDelta;
    return right.reliableCount - left.reliableCount;
  })[0]?.horizon ?? null;
};
const SIGNAL_TYPE_LABELS: Record<string, string> = { '1': 'General price spike', '2': 'Dex ad placement', '3': 'Dex social-link update', '4': 'Dex trending bar', '5': 'Dex Boost', '6': 'Price up', '7': 'Price ATH', '8': 'Market-cap key level', '9': 'Live stream', '10': 'Bundler sell', '11': 'Community takeover', '12': 'Smart-money buy', '13': 'Platform call', '14': 'Large-amount buy', '15': 'Multiple buys', '16': 'Multiple large buys', '17': 'Bags Claim', '18': 'Pump Claim', '19': 'Platform call V2', '20': 'KOL buy', '21': 'Banker Claim' };
const SIGNAL_TYPE_DESCRIPTIONS: Record<string, string> = {
  '1': 'Rapid K-line price movement. This records what happened, not a buy recommendation.',
  '2': 'DEX ad placement or paid visibility event. It is promotion, not proof of demand.',
  '3': 'DEX social-link metadata was updated. No trading direction is implied.',
  '4': 'Token appeared in a DEX trending bar or ranking surface.',
  '5': 'DEX Boost or boosted visibility event. The exact payment/threshold rule is not published here.',
  '6': 'Price-up threshold trigger. It confirms upward movement at the trigger time, not future performance.',
  '7': 'Token reached an all-time-high price trigger at the observed time.',
  '8': 'A recognized market-cap key level was crossed; the exact threshold is not published in the CLI docs.',
  '9': 'Live-stream or live-community event associated with the token.',
  '10': 'Sell activity attributed to bundler-linked wallets; it does not mean every holder is selling.',
  '11': 'Community takeover (CTO) event, indicating a project/community ownership change.',
  '12': 'Buy attributed by GMGN to a smart-money wallet classification. The wallet scoring rule is not published.',
  '13': 'GMGN platform call or promotion event; the exact trigger rule is not published.',
  '14': 'Buy classified as large amount. The amount threshold is not published in the CLI docs.',
  '15': 'Several buy events grouped into one signal. The exact count and time window are not published.',
  '16': 'Several large buys grouped into one signal. Count, amount, and time-window thresholds are not published.',
  '17': 'Bags Claim platform event.',
  '18': 'Pump Claim platform event.',
  '19': 'Platform call V2 event; the public docs do not specify how it differs from type 13.',
  '20': 'Buy attributed by GMGN to a KOL-labelled wallet. The KOL list and threshold are not published.',
  '21': 'Banker Claim platform event.'
};
const formatSignalType = (value: string | null): string => value ? `${value} · ${SIGNAL_TYPE_LABELS[value] ?? 'Unmapped GMGN type'}` : 'unknown signal type';

type GmgnStatus = {
  configured: boolean;
  keyPath: string;
  publicKeyConfigured: boolean;
  keyBytes: number;
  message: string;
};

type GmgnArchiveManifest = {
  capturedAt: string | null;
  eventCount: number | null;
  stored: number | null;
  repeated: number | null;
  validationErrors: number | null;
};

type GmgnArchiveSummary = {
  fileName: string;
  archiveBytes: number;
  modifiedAt: string;
  archiveSha256: string;
  expectedShaPrefix: string | null;
  hashVerified: boolean;
  structureVerified: boolean;
  eventCountVerified: boolean | null;
  verified: boolean;
  verificationError: string | null;
  entryNames: string[];
  manifest: GmgnArchiveManifest | null;
};

type DiagnosticLog = {
  id: number;
  createdAt: string;
  level: 'info' | 'warn' | 'error';
  event: string;
  method: string | null;
  path: string | null;
  status: number | null;
  durationMs: number | null;
  requestBytes: number | null;
  message: string | null;
  detail: string | null;
};


const emptyStats: Stats = {
  tokenCount: 0,
  gmgnSignalCount: 0,
  tokenFirstTrade: { earliest: null, latest: null },
  gmgnObserved: { earliest: null, latest: null },
  gmgnCaptured: { earliest: null, latest: null },
  signalsByType: [],
};

const emptyQuality: DataQuality = {
  cohortTokenCount: 0, signalCount: 0, matchedSignalCount: 0, unmatchedSignalCount: 0,
  tokensWithSignals: 0, tokensWithoutSignals: 0, coveragePercent: 0,
  missingTokenAddressSignals: 0, missingSignalTypeSignals: 0, missingObservedAtSignals: 0,
  signalsWithValidationIssues: 0,
};


async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: (T & { error?: string }) | null = null;
  try { body = JSON.parse(text) as T & { error?: string }; } catch { /* proxy/network errors may return plain text */ }
  if (!response.ok) throw new Error(body?.error ?? (text.slice(0, 240) || `Request failed (${response.status})`));
  if (!body) throw new Error('The server returned an empty or invalid response.');
  return body;
}

const formatTime = (value: string | null): string => {
  if (!value) return '—';
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
  }).formatToParts(new Date(value));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('day')} ${get('month').toUpperCase()} ${get('year')}, ${get('hour')}:${get('minute')} ${get('dayPeriod')}`;
};
const formatFetchTime = (value: string | null): string => {
  if (!value) return '—';
  const date = new Date(value);
  const now = new Date();
  const startOfDay = (input: Date) => new Date(input.getFullYear(), input.getMonth(), input.getDate()).getTime();
  const daysAgo = Math.floor((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (daysAgo === 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';
  if (daysAgo >= 2 && daysAgo <= 4) return `${daysAgo} days ago`;
  return formatTime(value);
};
const formatPercentChange = (base: number | null, value: number | null): string => base === null || value === null || base === 0 ? '—' : `${((value - base) / base * 100).toFixed(2)}%`;
const formatPct = (value: number | null): string => value === null ? '—' : `${value.toFixed(1)}%`;
const meterWidth = (value: number | null): string => `${Math.min(100, Math.max(0, Math.abs(value ?? 0)))}%`;
const formatSignedPct = (value: number | null): string => value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
const tradeReturnPercent = (eventType: string, costUsd: string | null, buyCostUsd: string | null): number | null => {
  if (!eventType.toLowerCase().startsWith('sell')) return null;
  const proceeds = costUsd === null ? NaN : Number(costUsd);
  const costBasis = buyCostUsd === null ? NaN : Number(buyCostUsd);
  if (!Number.isFinite(proceeds) || !Number.isFinite(costBasis) || costBasis <= 0) return null;
  return (proceeds - costBasis) / costBasis * 100;
};
const formatCompactNumber = (value: string | null): string => {
  const parsed = value === null ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—';
};
const holdingSecondsBySellId = (rows: CopyTradeHistoryRow[]): Map<number, number | null> => {
  const openBuys = new Map<string, number[]>();
  const holds = new Map<number, number | null>();
  [...rows].sort((a, b) => a.observedTimestamp - b.observedTimestamp || a.id - b.id).forEach((trade) => {
    const side = trade.eventType.toLowerCase();
    if (side.startsWith('buy')) {
      const queue = openBuys.get(trade.tokenAddress) ?? [];
      queue.push(trade.observedTimestamp);
      openBuys.set(trade.tokenAddress, queue);
    } else if (side.startsWith('sell')) {
      const queue = openBuys.get(trade.tokenAddress);
      const openedAt = queue?.shift();
      holds.set(trade.id, openedAt === undefined ? null : Math.max(0, trade.observedTimestamp - openedAt));
      if (queue && queue.length === 0) openBuys.delete(trade.tokenAddress);
    }
  });
  return holds;
};
const formatHugeUsd = (value: number): string => {
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  const mantissa = value / (10 ** exponent);
  return `$${mantissa.toFixed(2)} × 10^${exponent}`;
};

/** Shared K/M/B compaction for the three USD formatters below. Each caller still handles its
 *  own sign, huge-number (>=1e21), and sub-1000 formatting, since those genuinely differ by
 *  context (a table cell wants comma-grouped cents, a compact headline wants whole numbers, a
 *  chart tick wants lowercase with no grouping) — this only unifies the M/K/B tier cascade that
 *  was previously copy-pasted three times with slightly different thresholds/rounding, so a
 *  fix to that cascade can't silently apply to only one or two of the three formatters. */
const compactMagnitudeUsd = (absolute: number, opts: { billions: boolean; upperCase: boolean; round: boolean; decimals: number }): string | null => {
  const [B, M, K] = opts.upperCase ? ['B', 'M', 'K'] : ['b', 'm', 'k'];
  const fmt = (n: number) => opts.round ? Math.round(n).toString() : n.toFixed(opts.decimals);
  if (opts.billions && absolute >= 1_000_000_000) return `$${fmt(absolute / 1_000_000_000)}${B}`;
  if (absolute >= 1_000_000) return `$${fmt(absolute / 1_000_000)}${M}`;
  if (absolute >= 1_000) return `$${fmt(absolute / 1_000)}${K}`;
  return null;
};

const formatUsd = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  if (absolute >= 1e21) return formatHugeUsd(value);
  const magnitude = compactMagnitudeUsd(absolute, { billions: true, upperCase: true, round: false, decimals: 2 });
  if (magnitude) return `${sign}${magnitude}`;
  return `${sign}$${absolute.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const formatCopyCapital = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  if (absolute < 1) return `${sign}$${absolute.toFixed(2)}`;
  if (absolute >= 1e21) return `${sign}$${Math.round(absolute / 10 ** Math.floor(Math.log10(absolute)))} × 10^${Math.floor(Math.log10(absolute))}`;
  const magnitude = compactMagnitudeUsd(absolute, { billions: true, upperCase: true, round: true, decimals: 0 });
  if (magnitude) return `${sign}${magnitude}`;
  return `${sign}$${Math.round(absolute).toLocaleString('en-US')}`;
};

const formatChartUsd = (value: number): string => {
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  if (absolute >= 1e21) return `${sign}${formatHugeUsd(absolute)}`;
  const magnitude = compactMagnitudeUsd(absolute, { billions: false, upperCase: false, round: false, decimals: 2 });
  if (magnitude) return `${sign}${magnitude}`;
  return `${sign}$${absolute.toFixed(2)}`;
};

const formatChartDate = (value: string): string => {
  const day = value.replace(' start', '');
  if (day === 'start') return 'Starting balance';
  if (/^\d{4}-\d{2}-\d{2}T/.test(day)) {
    const parsed = new Date(day);
    return Number.isNaN(parsed.getTime()) ? day : parsed.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
  }
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : `2000-${day}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? day : parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: /^\d{4}-/.test(day) ? 'numeric' : undefined, timeZone: 'UTC' });
};

const CapitalPathChart = ({ points, activeTradeId, onTradeHover, zoomable = false }: { points: Array<{ day: string; capitalUsd: number; label?: string; tradeId?: number }>; activeTradeId?: number | null; onTradeHover?: (tradeId: number | null) => void; zoomable?: boolean }) => {
  const [hovered, setHovered] = useState<{ point: { day: string; capitalUsd: number; label?: string }; x: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const chartRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const element = chartRef.current;
    if (!zoomable || !element) return undefined;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setZoom((current) => Math.max(1, Math.min(4, current + (event.deltaY < 0 ? 0.25 : -0.25))));
    };
    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => element.removeEventListener('wheel', handleWheel);
  }, [zoomable]);
  if (points.length === 0) return <span className="capital-path-unavailable" title="No complete multi-day capital path is available for this trader">No path</span>;
  const width = 460 * (zoomable ? zoom : 1);
  const height = 170;
  const left = 42;
  const right = 8;
  const top = 8;
  const bottom = 24;
  const values = points.map((point) => point.capitalUsd);
  const dataMin = Math.min(...values, 0);
  const dataMax = Math.max(...values, 100);
  const padding = Math.max(1, (dataMax - dataMin) * 0.1, Math.abs(dataMax) * 0.02);
  const min = dataMin < 0 ? dataMin - padding : 0;
  const max = dataMax + padding;
  const range = Math.max(1, max - min);
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const zeroY = height - bottom - ((0 - min) / range) * plotHeight;
  const barGap = points.length > 40 ? 1 : 3;
  const barWidth = Math.max(2, Math.min(14, plotWidth / points.length - barGap));
  const barData = points.map((point, index) => {
    const x = left + (index / Math.max(1, points.length)) * plotWidth + (plotWidth / points.length - barWidth) / 2;
    const y = height - bottom - ((point.capitalUsd - min) / range) * plotHeight;
    return { point, x, y, height: Math.abs(zeroY - y) };
  });
  const finalPoint = points[points.length - 1];
  const firstLabel = points[0].label ?? points[0].day.replace(' start', '').slice(5);
  const lastLabel = finalPoint.label ?? finalPoint.day.slice(5);
  const hoveredLeft = hovered ? `${Math.max(8, Math.min(92, hovered.x / width * 100))}%` : '50%';
  return <span ref={chartRef} className="capital-path-chart" style={zoomable ? { width: `${zoom * 100}%` } : undefined} title={`$100 path: ${points[0].day} → ${finalPoint.day}; final ${formatUsd(finalPoint.capitalUsd)}`}>
    {zoomable && <button type="button" className="capital-path-reset" onClick={() => setZoom(1)} disabled={zoom === 1}>Reset 100%</button>}
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`$100 path ending at ${formatUsd(finalPoint.capitalUsd)}`} preserveAspectRatio="none" onMouseLeave={() => setHovered(null)}>
      <line x1={left} x2={left} y1={top} y2={height - bottom} className="capital-path-axis" />
      <line x1={left} x2={width - right} y1={height - bottom} y2={height - bottom} className="capital-path-axis" />
      <line x1={left} x2={width - right} y1={zeroY} y2={zeroY} className="capital-path-baseline" />
      <defs><linearGradient id="capital-path-gradient" x1="0" x2="1" y1="0" y2="0"><stop offset="0%" stopColor="#72d8af" /><stop offset="50%" stopColor="#f0c875" /><stop offset="100%" stopColor="#72a7ff" /></linearGradient></defs>
      <text x={left - 5} y={top + 4} textAnchor="end" className="capital-path-label">{formatChartUsd(max)}</text>
      <text x={left - 5} y={height - bottom + 4} textAnchor="end" className="capital-path-label">{formatChartUsd(min)}</text>
      <text x={left} y={height - 6} textAnchor="start" className="capital-path-label">{firstLabel}</text>
      <text x={width - right} y={height - 6} textAnchor="end" className="capital-path-label">{lastLabel}</text>
      {barData.map(({ point, x, y, height: barHeight }, index) => <rect key={`${point.day}-${index}`} x={x} y={Math.min(zeroY, y)} width={barWidth} height={Math.max(1, barHeight)} className={`${point.capitalUsd >= 100 ? 'capital-path-bar positive' : 'capital-path-bar negative'}${point.tradeId !== undefined && point.tradeId === activeTradeId ? ' active' : ''}`} onMouseEnter={() => { setHovered({ point, x: x + barWidth / 2 }); onTradeHover?.(point.tradeId ?? null); }} />)}
    </svg>
    {hovered && <span className="capital-path-tooltip" style={{ left: hoveredLeft }} role="status"><small>{hovered.point.label ?? 'Portfolio point'}</small><strong>{formatUsd(hovered.point.capitalUsd)}</strong><span>{formatChartDate(hovered.point.day)}</span></span>}
  </span>;
};
const formatCount = (value: number | null | undefined): string => value === null || value === undefined ? '—' : value.toLocaleString();
const formatGmgnRiskRatio = (value: number | null): string => value === null ? '—' : `${(Math.abs(value) <= 1 ? value * 100 : value).toFixed(1)}%`;
const formatGmgnRiskValue = (value: number | null): string => value === null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
type DuneCoverageSummary = { matched: number; eligible: number; percent: number | null } | null;
const duneCoverageClass = (coverage: DuneCoverageSummary): string => {
  if (!coverage || coverage.percent === null) return 'unknown';
  if (coverage.percent >= 99.999) return 'full';
  if (coverage.percent >= 90) return 'partial';
  return 'low';
};
const duneCoverageLabel = (coverage: DuneCoverageSummary | undefined, period: string): string => {
  if (!coverage || typeof coverage !== 'object') return `Dune ${period} coverage has not been measured yet.`;
  const percent = typeof coverage.percent === 'number' && Number.isFinite(coverage.percent) ? `${coverage.percent.toFixed(1)}%` : '—';
  const matched = typeof coverage.matched === 'number' && Number.isFinite(coverage.matched) ? coverage.matched.toLocaleString() : '—';
  const eligible = typeof coverage.eligible === 'number' && Number.isFinite(coverage.eligible) ? coverage.eligible.toLocaleString() : '—';
  return `Dune ${period}: ${matched} of ${eligible} locally eligible round trips have usable prices (${percent}). GMGN's activity count includes events, so it is not the denominator.`;
};
const formatDuration = (seconds: number | null | undefined): string => {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
};
const copyTradeEstimateConfidenceLabel: Record<CopyTradeFetchEstimate['confidence'], string> = {
  seeded: 'a seeded guess — no completed fetch yet',
  low: 'a rough guess — only 1-2 completed fetches so far',
  medium: 'a reasonable guess — a handful of completed fetches so far',
  high: 'based on several completed fetches',
};
const formatRule = (rule: string): string => ({
  min_trades: 'not enough trades',
  min_days: 'not enough history',
  positive_median: 'median return is not positive',
  risk_flag: 'risk flag present',
}[rule] ?? rule.replaceAll('_', ' ').replace(/^[a-z]/, (letter) => letter.toUpperCase()));
const copyTradeVerdictLabel: Record<CopyTradeRow['verdict'], string> = { screen_pass: 'Screen pass', no: 'Screen fail', thin: 'Thin data', flagged: 'Flagged', descriptive_only: 'Descriptive only — not comparable' };
const copyTradeVerdictIcon: Record<CopyTradeRow['verdict'], string> = { screen_pass: '✓', no: '✕', thin: '—', flagged: '⚠', descriptive_only: '◌' };
// Selects on horizons that contain at least one reliable SIGNAL TYPE, not on the "overall"
// aggregate. The gates themselves are unchanged — a group still has to pass every one of them
// (nFresh, distinct tokens, coverage, capture dates). The aggregate was the wrong gate for a
// display picker: it pools all ~15 signal types together, so types with almost no usable data
// drag its coverage below the threshold even when an individual type is comfortably above it.
// Observed live: overall coverage sat at 24.69% against a 25% gate — 32 comparisons short —
// which blanked the entire Patterns view while signal type 13 was passing at 68% coverage
// (n=118) at all five horizons. Reliable evidence must not be hidden behind an aggregate that
// is strictly harder to satisfy than any group it contains.
const bestPatternHorizon = (report: SignalPatternReport): string | null => {
  const candidates = report.horizons.flatMap((horizon) => {
    const reliable = horizon.groups.filter((group) => group.reliable && group.medianReturnPct !== null);
    if (!reliable.length) return [];
    return [{
      horizon: horizon.horizon,
      bestMedian: Math.max(...reliable.map((group) => group.medianReturnPct as number)),
      reliableCount: reliable.length,
      nFresh: reliable.reduce((total, group) => total + group.nFresh, 0),
    }];
  });
  return [...candidates].sort((left, right) => {
    const medianDelta = right.bestMedian - left.bestMedian;
    if (medianDelta !== 0) return medianDelta;
    const countDelta = right.reliableCount - left.reliableCount;
    if (countDelta !== 0) return countDelta;
    return right.nFresh - left.nFresh;
  })[0]?.horizon ?? null;
};
const bestGroupHorizon = (report: SignalPatternReport, key: string): { horizon: string; group: SignalPatternGroup } | null => {
  const entries = report.horizons.flatMap((horizon) => {
    const group = horizon.groups.find((candidate) => candidate.key === key);
    return group ? [{ horizon: horizon.horizon, group }] : [];
  });
  const candidates = entries.filter((entry) => entry.group.reliable && entry.group.medianReturnPct !== null);
  return [...candidates].sort((left, right) => {
    const medianDelta = (right.group.medianReturnPct ?? -Infinity) - (left.group.medianReturnPct ?? -Infinity);
    if (medianDelta !== 0) return medianDelta;
    const coverageDelta = (right.group.coveragePct ?? -Infinity) - (left.group.coveragePct ?? -Infinity);
    if (coverageDelta !== 0) return coverageDelta;
    return right.group.nFresh - left.group.nFresh;
  })[0] ?? null;
};
const percentChangeValue = (base: number | null, value: number | null): number | null => base === null || value === null || base === 0 ? null : (value - base) / base * 100;
const shortAddress = (address: string): string => `${address.slice(0, 3)}...`;
const shortWalletAddress = (address: string): string => `${address.slice(0, 6)}...`;
const formatDuneResponse = (raw: string | null): string => {
  if (!raw) return 'No response body stored yet.';
  try { return JSON.stringify(JSON.parse(raw), null, 2); }
  catch { return raw; }
};
const normalizeRoute = (route: string): string => route === 'copy-trades' ? 'copytrade' : route;
type CopyTradeSubTab = 'wallet-stats' | 'pattern-discovery' | 'scrutiny';
type DecisionColumnKey = 'rank' | 'gmgn' | 'trader' | 'decision' | 'freshness' | 'gmgnPnl' | 'gmgnTrades' | 'copyMedian' | 'copyCapital' | 'evidence' | 'hold' | 'under15s' | 'gmgnTags';
const DECISION_COLUMNS: Array<{ key: DecisionColumnKey; label: string }> = [
  { key: 'rank', label: 'Rank' }, { key: 'gmgn', label: 'GMGN' }, { key: 'trader', label: 'Trader' },
  { key: 'decision', label: 'Decision' }, { key: 'freshness', label: 'Data freshness' }, { key: 'gmgnPnl', label: '30d GMGN PnL' }, { key: 'gmgnTrades', label: '30d GMGN trades' },
  { key: 'copyMedian', label: '30d copy median' }, { key: 'copyCapital', label: '$100 after copy' }, { key: 'evidence', label: 'Evidence' },
  { key: 'hold', label: 'Typical hold' }, { key: 'under15s', label: 'GMGN ≤15s trades' }, { key: 'gmgnTags', label: 'GMGN tags' },
];
const GMGN_TAG_EXPLANATIONS: Record<string, { tone: 'positive' | 'negative' | 'neutral'; text: string }> = {
  smart_degen: { tone: 'positive', text: 'GMGN sees historically strong trading. Confirm with 30-day PnL, copy results, and risk checks.' },
  pump_smart: { tone: 'positive', text: 'Strong around early or new-token trading. Early entries may still be difficult to copy after delay.' },
  renowned: { tone: 'neutral', text: 'Known or notable wallet, such as an influencer, fund, or public figure. Reputation is not proof of profit.' },
  kol: { tone: 'neutral', text: 'KOL or influencer wallet. Public influence does not necessarily mean good copy-trading results.' },
  fresh_wallet: { tone: 'neutral', text: 'New wallet with little history. There is not enough track record to judge consistency safely.' },
  wash_trader: { tone: 'negative', text: 'Suspected fake or self-repeating trading used to create volume. Treat reported performance cautiously.' },
  fomo: { tone: 'negative', text: 'Often buys after a price move. A copy trader may enter even later and get worse execution.' },
  sniper: { tone: 'neutral', text: 'Buys extremely early at launch, often with automation. The strategy may be profitable but hard to copy.' },
  rat_trader: { tone: 'negative', text: 'Suspected insider or connected trader with unusually early information. Copiers may receive the trade too late.' },
  bundler: { tone: 'negative', text: 'Involved in bundled launch transactions or bot buying. Launch-time execution may not be reproducible by a copier.' },
  whale: { tone: 'neutral', text: 'Holds or trades a large amount. Size can affect liquidity and does not guarantee skill.' },
  top_holder: { tone: 'neutral', text: 'One of a token’s largest holders. Concentration and exit risk should be checked separately.' },
  transfer_in: { tone: 'neutral', text: 'Tokens entered by transfer, not necessarily a purchase. This can distort buy-based PnL and trade counts.' },
  dev_team: { tone: 'negative', text: 'Associated with a token development team. Own-token activity can create conflicts for copy-traders.' },
  creator: { tone: 'negative', text: 'Token creator or deployer. Selling into followers or launch liquidity can make copying unsafe.' },
  dev: { tone: 'negative', text: 'Developer or creator classification. Treat own-token activity as a possible conflict of interest.' },
  dex_bot: { tone: 'neutral', text: 'Automated trading bot linked to platforms such as Axiom, Photon, BullX, Trojan, or GMGN. Copyability depends on latency and execution.' },
  axiom: { tone: 'neutral', text: 'Axiom is a Solana trading terminal and execution platform.' },
  padre: { tone: 'neutral', text: 'Padre is a Solana trading terminal and token-trading platform.' },
  photon: { tone: 'neutral', text: 'Photon is a Solana trading terminal commonly used for fast token execution.' },
  gmgn: { tone: 'neutral', text: 'GMGN is the wallet analytics and trading platform that supplied this label.' },
  bullx: { tone: 'neutral', text: 'BullX is a multi-chain trading terminal and execution platform.' },
  trojan: { tone: 'neutral', text: 'Trojan is a Solana trading bot and execution platform.' },
  bluechip_owner: { tone: 'neutral', text: 'Also holds established or higher-quality tokens. This is background context, not proof of trading skill.' },
  arbitrager: { tone: 'positive', text: 'GMGN identifies arbitrage activity. Returns may depend on speed and may be difficult to reproduce.' },
  top_followed: { tone: 'positive', text: 'Among GMGN’s most-followed wallets. Popularity does not replace the delayed-copy test.' },
  top_renamed: { tone: 'positive', text: 'Among GMGN’s most-renamed or recognized wallets. Recognition is not proof of future performance.' },
  launchpad_smart: { tone: 'positive', text: 'Active around launchpads. Check holding time and delay impact before copying.' },
};
const gmgnTagInfo = (tag: string): { tone: 'positive' | 'negative' | 'neutral'; text: string } =>
  GMGN_TAG_EXPLANATIONS[tag] ?? { tone: 'neutral', text: `GMGN label: ${tag.replaceAll('_', ' ')}.` };
const GmgnTag = ({ tag }: { tag: string }) => {
  const info = gmgnTagInfo(tag);
  return <span className={`copytrade-tag ${info.tone}`} title={info.text}>{tag.replaceAll('_', ' ')}</span>;
};
const decisionColumnsStorageKey = 'vantage.crypto.decision-columns.v1';
// Lightweight deployment mode: keep the other workflows and routes in source, but expose only
// the aggregate GMGN wallet-stats reader until the broader research workspace is needed again.
const WALLET_STATS_ONLY = true;
// Lightweight mode still exposes Scrutiny alongside the wallet-stats reader — it's a read-only
// interrogation view a reader may want without opening the full (heavier) research workspace.
const parseCopyTradeRoute = (route: string): { menu: string; subTab: CopyTradeSubTab } => {
  const [rawMenu, rawSubTab] = route.split('/');
  const subTab: CopyTradeSubTab = rawSubTab === 'pattern-discovery' || rawSubTab === 'scrutiny' ? rawSubTab : 'wallet-stats';
  return { menu: normalizeRoute(rawMenu || 'dune-capture'), subTab };
};
const copyAddress = async (address: string) => { try { await navigator.clipboard.writeText(address); } catch { /* clipboard access is optional */ } };
const CopyAddressButton = ({ address, label = 'wallet address' }: { address: string; label?: string }) => (
  <button type="button" className="icon-copy" title={`Copy ${label}`} aria-label={`Copy ${label}`} onClick={(event) => { event.stopPropagation(); void copyAddress(address); }}>⧉</button>
);
const WalletIcon = ({ url, name }: { url?: string | null; name: string }) => url ? <img className="copytrade-wallet-icon" src={url} alt="" title={`${name} icon`} onError={(event) => { event.currentTarget.style.display = 'none'; }} /> : null;
const saveJson = (value: unknown, filename: string) => {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};
const saveCompressedJson = async (value: unknown, filename: string) => {
  const json = JSON.stringify(value);
  if (typeof CompressionStream !== 'function') {
    saveJson(value, filename.replace(/\.gz$/, ''));
    return;
  }
  const compressed = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  const url = URL.createObjectURL(compressed);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};
const csvCell = (value: unknown): string => {
  const text = value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value);
  return `"${text.replaceAll('"', '""')}"`;
};
const saveCsv = (rows: Array<Record<string, unknown>>, filename: string) => {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  // Keep each CSV row as a separate Blob part. Full exports contain raw GMGN payloads
  // and complete trade histories; joining every row into one JavaScript string can exceed
  // the browser's maximum string length before Blob gets a chance to handle the data.
  const parts: BlobPart[] = [`\uFEFF${headers.map(csvCell).join(',')}\r\n`];
  for (const row of rows) parts.push(`${headers.map((header) => csvCell(row[header] ?? '')).join(',')}\r\n`);
  const blob = new Blob(parts, { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};
const SaveRowButton = ({ row, filename }: { row: unknown; filename: string }) => (
  <button type="button" className="icon-copy row-save-button" title="Save this row as JSON" aria-label="Save this row as JSON" onClick={(event) => { event.stopPropagation(); saveJson(row, filename); }}>⇩</button>
);
const tokenDisplay = (symbol: string | null, address: string): string => symbol?.trim() || shortAddress(address);
const InfoTip = ({ label = 'More information', text }: { label?: string; text: string }) => (
  <span className="info-tip" role="note" aria-label={label} title={text}><span aria-hidden="true">i</span></span>
);
// GMGN returns large monetary fields and pnl ratios as decimal strings in many responses, while
// some responses use JSON numbers. Treat both representations identically; rejecting strings
// made the stored 30d realized-PnL column appear empty even though SQLite had it. Shared by
// every GMGN payload reader in this file instead of each one re-declaring its own closure.
const numberValue = (source: Record<string, unknown>, key: string): number | null => {
  const value = source[key];
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

const parseAggregateRecord = (record: GmgnStatsRecord): GmgnAggregateStats | null => {
  try {
    const root = JSON.parse(record.rawPayload) as Record<string, unknown>;
    const unwrapped = root.data ?? root;
    const data = (Array.isArray(unwrapped) ? unwrapped[0] : unwrapped) as Record<string, unknown>;
    if (!data || typeof data !== 'object') return null;
    const pnl = (data.pnl_stat ?? {}) as Record<string, unknown>;
    const pnlPercent = numberValue(data, 'realized_profit_pnl');
    const winRate = numberValue(pnl, 'winrate');
    const common = (data.common ?? {}) as Record<string, unknown>;
    return { period: record.period, fetchedAt: record.fetchedAt, realizedProfit: numberValue(data, 'realized_profit'), realizedProfitPnlPercent: pnlPercent === null ? null : pnlPercent * 100, nativeBalance: numberValue(data, 'native_balance'), buyCount: numberValue(data, 'buy'), sellCount: numberValue(data, 'sell'), boughtCost: numberValue(data, 'bought_cost'), soldIncome: numberValue(data, 'sold_income'), boughtFee: numberValue(data, 'bought_fee'), soldFee: numberValue(data, 'sold_fee'), totalCost: numberValue(data, 'total_cost'), lastTimestamp: numberValue(data, 'last_timestamp'), tokenCount: numberValue(pnl, 'token_num'), winRatePercent: winRate === null ? null : winRate * 100, averageHoldingPeriodSeconds: numberValue(pnl, 'avg_holding_period'),
      buckets: { lossOver50: numberValue(pnl, 'pnl_lt_nd5_num'), loss50to0: numberValue(pnl, 'pnl_nd5_0x_num'), gain0to2x: numberValue(pnl, 'pnl_0x_2x_num'), gain2to5x: numberValue(pnl, 'pnl_2x_5x_num'), gainOver5x: numberValue(pnl, 'pnl_gt_5x_num') },
      tags: Array.isArray(common.tags) ? (common.tags as unknown[]).filter((tag): tag is string => typeof tag === 'string') : [],
      walletCreatedAt: numberValue(common, 'created_at'),
      twitterName: typeof common.twitter_name === 'string' && common.twitter_name.trim() !== '' ? common.twitter_name : null,
      createdTokenCount: numberValue(common, 'created_token_count') };
  } catch { return null; }
};
const formatLeaderboardMetric = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '—';
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (Number.isFinite(numeric)) return `${(numeric * 100).toFixed(1)}%`;
  return '—';
};
const leaderboardMetricTone = (value: unknown): string => {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(numeric) ? (numeric >= 0 ? 'positive' : 'negative') : '';
};
const formatDailyProfit7d = (value: unknown): { label: string; total: number | null; points: number[] } => {
  if (!Array.isArray(value)) return { label: '—', total: null, points: [] };
  const points = value.map((item) => {
    const raw = item && typeof item === 'object' ? (item as Record<string, unknown>).profit : item;
    const number = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    return Number.isFinite(number) ? number : null;
  }).filter((number): number is number => number !== null);
  if (points.length === 0) return { label: '—', total: null, points: [] };
  const total = points.reduce((sum, number) => sum + number, 0);
  const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(total);
  return { label: `${total >= 0 ? '+' : ''}$${compact}`, total, points };
};
const formatHoldingTime = (seconds: number | null | undefined): string => {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3_600) return `${(seconds / 60).toFixed(1)}m`;
  return `${(seconds / 3_600).toFixed(1)}h`;
};

// Column names in the SELECT (token_address, symbol, first_trade_time, first_dex, first_tx) are
// deliberate — they match the aliases src/dune/importer.ts already recognizes, so a CSV/JSON
// export of this query's result can be uploaded back through "Choose a Dune lookup result"
// without any extra mapping step.
const buildDuneEnrichmentQuery = (addresses: string[]): string => {
  const values = addresses.map((address) => `    ('${address.replace(/'/g, "''")}')`).join(',\n');
  return `-- Targeted Dune lookup for ${addresses.length} GMGN-observed token address(es) not yet in the cohort.
-- Generated ${new Date().toISOString()} by the crypto research app.
-- Table/column names below (dex_solana.trades) are a common Solana first-trade source on
-- Dune — adjust them if your workspace uses a different one. Keep the final SELECT's output
-- column names exactly as token_address, symbol, first_trade_time, first_dex, first_tx so
-- this app recognizes them on re-upload.
with target_tokens (token_address) as (
  values
${values}
),
first_trades as (
  select
    t.token_bought_mint_address as token_address,
    t.token_bought_symbol as symbol,
    t.block_time as first_trade_time,
    t.project as first_dex,
    t.tx_id as first_tx,
    row_number() over (partition by t.token_bought_mint_address order by t.block_time asc) as rn
  from dex_solana.trades t
  inner join target_tokens tt on tt.token_address = t.token_bought_mint_address
)
select token_address, symbol, first_trade_time, first_dex, first_tx
from first_trades
where rn = 1
order by first_trade_time;
`;
};

const buildSimpleDuneEnrichmentQuery = (addresses: string[]): string => {
  const list = addresses.map((address) => `'${address.replace(/'/g, "''")}'`).join(',\n  ');
  return `-- Fast targeted lookup for ${addresses.length} GMGN-observed token addresses.
-- The 90-day filter avoids scanning all historical trades. Change or remove it if older
-- first-trade history is required. Adjust dex_solana.trades/column names if your workspace differs.
SELECT
  token_bought_mint_address AS token_address,
  MIN_BY(token_bought_symbol, block_time) AS symbol,
  MIN(block_time) AS first_trade_time,
  MIN_BY(project, block_time) AS first_dex,
  MIN_BY(tx_id, block_time) AS first_tx
FROM dex_solana.trades
WHERE block_time >= CURRENT_TIMESTAMP - INTERVAL '90' DAY
  AND token_bought_mint_address IN (
  ${list}
  )
GROUP BY token_bought_mint_address
ORDER BY first_trade_time;
`;
};

function App() {
  const initialRoute = (() => {
    const parsed = parseCopyTradeRoute(window.location.hash.slice(1) || 'copytrade/wallet-stats');
    return { menu: 'copytrade', subTab: parsed.subTab };
  })();
  const [activeMenu, setActiveMenu] = useState(initialRoute.menu);
  const [stats, setStats] = useState<Stats>(emptyStats);
  const [quality, setQuality] = useState<DataQuality>(emptyQuality);
  const [analysis, setAnalysis] = useState<SnapshotAnalysis | null>(null);
  const [scoring, setScoring] = useState<SignalScoringReport | null>(null);
  const [outcomeCandidates, setOutcomeCandidates] = useState<OutcomeCandidate[]>([]);
  const [measurementPlan, setMeasurementPlan] = useState<MeasurementPlan | null>(null);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [measurementPlanRefreshing, setMeasurementPlanRefreshing] = useState(false);
  const [outcomeTypeFilter, setOutcomeTypeFilter] = useState('all');
  const [outcomeBusy, setOutcomeBusy] = useState(false);
  const [outcomeBatchBusy, setOutcomeBatchBusy] = useState(false);
  const [outcomeBatchProgress, setOutcomeBatchProgress] = useState<{ completed: number; total: number; current: number; batches: number } | null>(null);
  const stopOutcomeBatchRef = useRef(false);
  const [reconcileBusy, setReconcileBusy] = useState(false);
  const [outcomeTimelines, setOutcomeTimelines] = useState<OutcomeTimeline[]>([]);
  const [outcomePageSize, setOutcomePageSize] = useState<number | 'all'>(25);
  const [outcomePage, setOutcomePage] = useState(0);
  const [outcomeSort, setOutcomeSort] = useState<{ key: OutcomeSortKey; direction: 'asc' | 'desc' }>({ key: 'signal', direction: 'asc' });
  const [patternReport, setPatternReport] = useState<SignalPatternReport | null>(null);
  const [patternSnapshots, setPatternSnapshots] = useState<SignalPatternSnapshot[]>([]);
  const [patternHorizon, setPatternHorizon] = useState<string | null>(null);
  const [showInsufficientPatterns, setShowInsufficientPatterns] = useState(false);
  const [subgroupProperty, setSubgroupProperty] = useState<SubgroupProperty>('launchPlatform');
  const [subgroupReport, setSubgroupReport] = useState<SignalPatternSubgroupReport | null>(null);
  const [subgroupHorizon, setSubgroupHorizon] = useState<string | null>(null);
  const [subgroupBusy, setSubgroupBusy] = useState(false);
  const [subgroupOpened, setSubgroupOpened] = useState(false);
  const [viewingSnapshotId, setViewingSnapshotId] = useState<number | null>(null);
  const [savingSnapshot, setSavingSnapshot] = useState(false);
  const [copyTradeSummary, setCopyTradeSummary] = useState<CopyTradeSummary | null>(null);
  const [copyTradeStatus, setCopyTradeStatus] = useState<CopyTradeFetchStatus | null>(null);
  const [copyTradeResults, setCopyTradeResults] = useState<CopyTradeResults | null>(null);
  const [copyTradeRosters, setCopyTradeRosters] = useState<CopyTradeRosterCatalog | null>(null);
  const [selectedRosterSnapshotId, setSelectedRosterSnapshotId] = useState<number | null>(null);
  const [copyTradeLimit, setCopyTradeLimit] = useState(100);
  const [copyTradePeriodDays, setCopyTradePeriodDays] = useState(30);
  const [copyTradeBusy, setCopyTradeBusy] = useState(false);
  const [winnersFetchBusy, setWinnersFetchBusy] = useState(false);
  const [singleTraderQuery, setSingleTraderQuery] = useState('');
  const [singleTraderBusy, setSingleTraderBusy] = useState(false);
  const [singleTraderError, setSingleTraderError] = useState<string | null>(null);
  const [copyTradeStopBusy, setCopyTradeStopBusy] = useState(false);
  const [copyTradeResumeBusy, setCopyTradeResumeBusy] = useState(false);
  const [copyTradeResetBusy, setCopyTradeResetBusy] = useState(false);
  const [copyTradeLoading, setCopyTradeLoading] = useState(false);
  const [gmgnStatsStatus, setGmgnStatsStatus] = useState<GmgnStatsFetchStatus | null>(null);
  const [gmgnStatsRecords, setGmgnStatsRecords] = useState<GmgnStatsRecord[]>([]);
  const [gmgnLeaderboardMetrics, setGmgnLeaderboardMetrics] = useState<Record<string, GmgnLeaderboardMetric>>({});
  const [gmgnStatsBusy, setGmgnStatsBusy] = useState(false);
  const [gmgnStatsLoading, setGmgnStatsLoading] = useState(false);
  const [walletStatsReady, setWalletStatsReady] = useState(false);
  const [rosterSyncBusy, setRosterSyncBusy] = useState(false);
  const [rosterRefreshMessage, setRosterRefreshMessage] = useState<string | null>(null);
  const [rosterRefreshError, setRosterRefreshError] = useState<string | null>(null);
  const [rosterChange, setRosterChange] = useState<RosterChange | null>(null);
  const [rosterComparison, setRosterComparison] = useState<RosterComparison | null>(null);
  const [rosterComparisonLoading, setRosterComparisonLoading] = useState(false);
  const [rosterComparisonOpen, setRosterComparisonOpen] = useState(false);
  const [copyTradeError, setCopyTradeError] = useState<string | null>(null);
  const [patternDiscoveryExport, setPatternDiscoveryExport] = useState<PatternDiscoveryExport | null>(null);
  const [patternDiscoveryLoading, setPatternDiscoveryLoading] = useState(false);
  const [patternDiscoveryError, setPatternDiscoveryError] = useState<string | null>(null);
  const [patternDiscoveryReport, setPatternDiscoveryReport] = useState<PatternDiscoveryReport | null>(null);
  const [patternDiscoveryExecution, setPatternDiscoveryExecution] = useState<PatternDiscoveryExecution | null>(null);
  const [patternDiscoveryRunLoading, setPatternDiscoveryRunLoading] = useState(false);
  const [patternDiscoveryRunError, setPatternDiscoveryRunError] = useState<string | null>(null);
  const [patternDiscoverySourceOpen, setPatternDiscoverySourceOpen] = useState(false);
  const [copyTradeEstimate, setCopyTradeEstimate] = useState<CopyTradeFetchEstimate | null>(null);
  const [copyTradeEstimateLoading, setCopyTradeEstimateLoading] = useState(false);
  const [researchUpdateBusy, setResearchUpdateBusy] = useState(false);
  const [researchUpdateStage, setResearchUpdateStage] = useState<string | null>(null);
  const [researchUpdateFailedStage, setResearchUpdateFailedStage] = useState<number | null>(null);
  const [researchUpdateSummary, setResearchUpdateSummary] = useState<ResearchUpdateSummary | null>(null);
  const [walletScreenSummary, setWalletScreenSummary] = useState<WalletScreenSummary | null>(null);
  const [excludedScreeningWallets, setExcludedScreeningWallets] = useState<string[]>(() => {
    try {
      const stored = window.localStorage.getItem('vantage.crypto.excluded-screening-wallets');
      const parsed = stored ? JSON.parse(stored) : [];
      return Array.isArray(parsed) ? parsed.filter((wallet): wallet is string => typeof wallet === 'string') : [];
    } catch { return []; }
  });
  const [includedScreeningWallets, setIncludedScreeningWallets] = useState<string[]>(() => {
    try {
      const stored = window.localStorage.getItem('vantage.crypto.included-screening-wallets');
      const parsed = stored ? JSON.parse(stored) : [];
      return Array.isArray(parsed) ? parsed.filter((wallet): wallet is string => typeof wallet === 'string') : [];
    } catch { return []; }
  });
  // Advanced diagnostics is read-only research tooling (elimination triage, Scrutiny, Pattern
  // Discovery) — it must never gain an actionable control. Fetch controls (GMGN/Dune buttons,
  // the pre-fetch scope filters, live progress) live in their own always-visible section above
  // it instead, so this no longer needs to auto-open for fetch activity at all.
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  // Defaults OFF and is never persisted, unlike the manual exclusion lists above: triage
  // thresholds (50 trades, 90% coverage, the hidden-loss bars) are reasoned judgment calls, not
  // outcome-calibrated, so skipping a wallet's Dune fetch on their say-so should be a decision
  // made fresh each session, not something that silently keeps happening after the tab reopens.
  // A current triage result is an exclusion by default. The user can explicitly uncheck it or
  // re-check an individual wallet; without a current triage report this has no effect.
  const [skipEliminatedInDune, setSkipEliminatedInDune] = useState(true);
  // Single toggle covering two different kinds of pre-Dune scope reduction, merged into one
  // control per user request (was two separate checkboxes): (1) hold time < copier delay — not a
  // judgment call, a wallet this fast can never pass the copy-viability verdict regardless of
  // what Dune returns, so spending credits on it is provably wasted; measured live: 7 of 98
  // wallets, ~48,757 of the outstanding Dune targets, about a third of the backlog. (2) the seven
  // GMGN-flagged high-risk checks (wash_trader tag, strongly negative 30d PnL, extreme/thin
  // volume, mass token creation, weak win rate, one-sided buy/sell) — these ARE judgment calls, a
  // legitimate trader could still trip one. Defaults ON; the per-wallet checkbox in the activity
  // table below always overrides this for any individual wallet regardless of which check it hit.
  const [skipScopeFiltersInDune, setSkipScopeFiltersInDune] = useState(true);
  const legacyHighActivityMigrationDone = useRef(false);
  const scrutinyAutoPinnedRef = useRef(false);
  const [copyTradeSubTab, setCopyTradeSubTab] = useState<CopyTradeSubTab>(initialRoute.subTab);
  const [historicalConsistency, setHistoricalConsistency] = useState<HistoricalConsistencyReport | null>(null);
  const [historicalConsistencyLoading, setHistoricalConsistencyLoading] = useState(false);
  const [captureHealth, setCaptureHealth] = useState<CaptureHealth | null>(null);
  const [copyWinners, setCopyWinners] = useState<CopyCandidatesReport | null>(null);
  const [copyWinnersLoading, setCopyWinnersLoading] = useState(false);
  const [copySimulation, setCopySimulation] = useState<CopySimulationReport | null>(null);
  const [copySimulation30d, setCopySimulation30d] = useState<CopySimulationReport | null>(null);
  const [copySimulationLoading, setCopySimulationLoading] = useState(false);
  const [copySimulationRunBusy, setCopySimulationRunBusy] = useState(false);
  const [copySimulationStopBusy, setCopySimulationStopBusy] = useState(false);
  const [copySimulationRunStatus, setCopySimulationRunStatus] = useState<CopySimulationRunStatus | null>(null);
  const [copySimulationRunReportOpen, setCopySimulationRunReportOpen] = useState(false);
  const copySimulationStatusPollInFlight = useRef(false);
  const [liquidityImpact, setLiquidityImpact] = useState<LiquidityImpactReport | null>(null);
  const [liquidityImpactLoading, setLiquidityImpactLoading] = useState(false);
  const [scrutinyPinned, setScrutinyPinned] = useState<string[]>(() => {
    try {
      const stored = window.localStorage.getItem('vantage.crypto.scrutiny-pinned-wallets');
      const parsed = stored ? JSON.parse(stored) : [];
      return Array.isArray(parsed) ? parsed.filter((wallet): wallet is string => typeof wallet === 'string') : [];
    } catch { return []; }
  });
  const [eliminationReport, setEliminationReport] = useState<EliminationReport | null>(null);
  const [eliminationLoading, setEliminationLoading] = useState(false);
  const [eliminationError, setEliminationError] = useState<string | null>(null);
  const [scrutinyResponse, setScrutinyResponse] = useState<ScrutinyResponse | null>(null);
  const [scrutinyLoading, setScrutinyLoading] = useState(false);
  const [scrutinyError, setScrutinyError] = useState<string | null>(null);
  const [scrutinyRefreshBusy, setScrutinyRefreshBusy] = useState(false);
  const [scrutinyFillBusy, setScrutinyFillBusy] = useState(false);
  const [scrutinyOutcome, setScrutinyOutcome] = useState<string | null>(null);
  const [scrutinyAddInput, setScrutinyAddInput] = useState('');
  const [selectedScrutinyWallet, setSelectedScrutinyWallet] = useState<string | null>(null);
  const [gmgnRiskResults, setGmgnRiskResults] = useState<Record<string, GmgnRiskResult>>({});
  const [gmgnRiskBusy, setGmgnRiskBusy] = useState(false);
  const scrutinyLoadAbortRef = useRef<AbortController | null>(null);
  const [browserActivityImportBusy, setBrowserActivityImportBusy] = useState(false);
  const [copyTradeSort, setCopyTradeSort] = useState<{ key: CopyTradeSortKey; direction: 'asc' | 'desc' }>({ key: 'endingCapitalUsd', direction: 'desc' });
  const [decisionSort, setDecisionSort] = useState<{ key: DecisionSortKey; direction: 'asc' | 'desc' }>({ key: 'default', direction: 'asc' });
  const [gmgnStatsSort, setGmgnStatsSort] = useState<{ key: GmgnStatsSortKey; direction: 'asc' | 'desc' }>({ key: 'pnl30d', direction: 'desc' });
  const [copyDelaySort, setCopyDelaySort] = useState<{ key: CopyDelaySortKey; direction: 'asc' | 'desc' }>({ key: 'edge', direction: 'desc' });
  const [showDelaySurvivorsOnly, setShowDelaySurvivorsOnly] = useState(true);
  const [decisionColumns, setDecisionColumns] = useState<Record<DecisionColumnKey, boolean>>(() => {
    const defaults = Object.fromEntries(DECISION_COLUMNS.map(({ key }) => [key, true])) as Record<DecisionColumnKey, boolean>;
    try {
      const saved = JSON.parse(localStorage.getItem(decisionColumnsStorageKey) ?? 'null') as Partial<Record<DecisionColumnKey, unknown>> | null;
      if (saved) for (const { key } of DECISION_COLUMNS) if (typeof saved[key] === 'boolean') defaults[key] = saved[key] as boolean;
    } catch { /* use all columns when browser storage is unavailable */ }
    return defaults;
  });
  const [decisionColumnsOpen, setDecisionColumnsOpen] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [selectedCopyDelayWallet, setSelectedCopyDelayWallet] = useState<string | null>(null);
  const [statsDetailWallet, setStatsDetailWallet] = useState<string | null>(null);
  const [statsDetailTradeId, setStatsDetailTradeId] = useState<number | null>(null);
  const [statsDetailTrades, setStatsDetailTrades] = useState<CopyTradeHistoryResponse | null>(null);
  const [statsDetailTradesLoading, setStatsDetailTradesLoading] = useState(false);
  const [showOnlyCurrentHistory, setShowOnlyCurrentHistory] = useState(true);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [gmgnStatus, setGmgnStatus] = useState<GmgnStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [duneBusyFile, setDuneBusyFile] = useState<string | null>(null);
  const [lastDuneImport, setLastDuneImport] = useState<LastDuneImport | null>(null);
  const [exportingAddresses, setExportingAddresses] = useState(false);
  const [enrichmentBusy, setEnrichmentBusy] = useState(false);
  const [lastEnrichmentImport, setLastEnrichmentImport] = useState<LastDuneImport | null>(null);
  const [duneQuery, setDuneQuery] = useState('');
  const [generatingQuery, setGeneratingQuery] = useState(false);
  const [browserImportBusy, setBrowserImportBusy] = useState(false);
  const [lastBrowserImport, setLastBrowserImport] = useState<{ fileName: string; at: string; result: BrowserImportResult } | null>(null);
  const [rawEndpointSummary, setRawEndpointSummary] = useState<RawEndpointSummary | null>(null);
  const [rawEndpointType, setRawEndpointType] = useState<RawEndpointType>('radar');
  const [rawEndpointRows, setRawEndpointRows] = useState<RawEndpointRow[]>([]);
  const [rawEndpointBusy, setRawEndpointBusy] = useState(false);
  const [rawEndpointOpen, setRawEndpointOpen] = useState(false);
  const [rawEndpointExpandedId, setRawEndpointExpandedId] = useState<number | null>(null);
  const [logs, setLogs] = useState<DiagnosticLog[] | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [archives, setArchives] = useState<GmgnArchiveSummary[] | null>(null);
  const [loadingArchives, setLoadingArchives] = useState(false);
  const [expandedArchive, setExpandedArchive] = useState<string | null>(null);
  const [message, setMessage] = useState('Ready. Data is saved locally in SQLite.');
  const [gmgnPayload, setGmgnPayload] = useState(`{
  "observed_at": "2026-08-09T12:00:00Z",
  "token_address": "",
  "signal_type": "",
  "market_cap": null,
  "triggering_wallet": "",
  "raw_wallet_labels": []
}`);

  const refresh = async () => {
    setRefreshBusy(true);
    try {
      const [nextStats, nextImports, nextQuality, nextGmgn, nextAnalysis, nextScoring, nextCandidates, nextMeasurementPlan, latestOutcomes, nextPatternReport, nextPatternSnapshots] = await Promise.all([
      api<Stats>('/api/stats'),
      api<ImportSummary[]>('/api/imports'),
      api<DataQuality>('/api/quality'),
      api<GmgnStatus>('/api/gmgn/status'),
      api<SnapshotAnalysis>('/api/analysis/snapshot'),
      api<SignalScoringReport>('/api/analysis/scores'),
      api<OutcomeCandidate[]>('/api/dune/candidates'),
      api<MeasurementPlan>('/api/dune/measurement-plan'),
      api<OutcomeTimeline[]>('/api/dune/outcomes/all'),
      api<SignalPatternReport>('/api/analysis/patterns'),
      api<SignalPatternSnapshot[]>('/api/analysis/patterns/snapshots'),
      ]);
      setStats(nextStats);
    setImports(nextImports);
    setQuality(nextQuality);
    setGmgnStatus(nextGmgn);
    setAnalysis(nextAnalysis);
    setScoring(nextScoring);
    setOutcomeCandidates(nextCandidates);
    setMeasurementPlan(nextMeasurementPlan);
    setOutcomeTimelines(latestOutcomes);
    setPatternReport(nextPatternReport);
    setPatternSnapshots(nextPatternSnapshots);
      setPatternHorizon(bestPatternHorizon(nextPatternReport));
    } finally { setRefreshBusy(false); }
  };

  const refreshPatternReport = async () => {
    const nextPatternReport = await api<SignalPatternReport>('/api/analysis/patterns');
    setPatternReport(nextPatternReport);
    setPatternHorizon(bestPatternHorizon(nextPatternReport));
  };

  const loadCopyTradeStatus = async () => {
    try {
      const next = await api<CopyTradeFetchStatus>('/api/copytrade/fetch/status');
      setCopyTradeStatus(next);
      return next;
    } catch (error: unknown) {
      setCopyTradeError(error instanceof Error ? error.message : String(error));
      return null;
    }
  };

  const loadPatternDiscoveryExport = async (periodDays = copyTradePeriodDays) => {
    setPatternDiscoveryLoading(true);
    setPatternDiscoveryError(null);
    setPatternDiscoveryRunError(null);
    setPatternDiscoveryExecution(null);
    setPatternDiscoveryReport(null);
    try {
      setPatternDiscoveryExport(await api<PatternDiscoveryExport>(`/api/copytrade/pattern-discovery/export?periodDays=${periodDays}`));
    } catch (error: unknown) {
      setPatternDiscoveryError(error instanceof Error ? error.message : String(error));
    } finally { setPatternDiscoveryLoading(false); }
  };

  const runPatternDiscovery = async () => {
    if (patternDiscoveryRunLoading || patternDiscoveryLoading || !patternDiscoveryExport?.metadata.exported_rows) return;
    setPatternDiscoveryRunLoading(true);
    setPatternDiscoveryRunError(null);
    try {
      const result = await api<PatternDiscoveryRunResponse>(
        '/api/copytrade/pattern-discovery/run/report',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ periodDays: copyTradePeriodDays, minN: 10 }) },
      );
      setPatternDiscoveryReport(result.report);
      setPatternDiscoveryExecution(result.execution ?? null);
    } catch (error: unknown) {
      setPatternDiscoveryRunError(error instanceof Error ? error.message : String(error));
    } finally { setPatternDiscoveryRunLoading(false); }
  };


  const loadCopyTradeEstimate = async (limit: number, periodDays: number) => {
    setCopyTradeEstimateLoading(true);
    try {
      setCopyTradeEstimate(await api<CopyTradeFetchEstimate>(`/api/copytrade/fetch/estimate?limit=${limit}&periodDays=${periodDays}`));
    } catch { /* advisory only — a failed estimate must never block the fetch controls */ }
    finally { setCopyTradeEstimateLoading(false); }
  };

  const loadHistoricalConsistency = async (limit: number, rosterSnapshotId = selectedRosterSnapshotId) => {
    setHistoricalConsistencyLoading(true);
    try {
      const snapshotQuery = rosterSnapshotId ? `&snapshotId=${rosterSnapshotId}` : '';
      setHistoricalConsistency(await api<HistoricalConsistencyReport>(`/api/copytrade/historical-consistency?limit=${limit}${snapshotQuery}`));
    } catch (error: unknown) { setCopyTradeError(error instanceof Error ? error.message : String(error)); }
    finally { setHistoricalConsistencyLoading(false); }
  };

  const loadCaptureHealth = async () => {
    try { setCaptureHealth(await api<CaptureHealth>('/api/copytrade/capture-health')); }
    catch { /* advisory only — a failed capture-health read must never block the Forward Validation tab */ }
  };

  const loadElimination = async (rosterSnapshotId = selectedRosterSnapshotId): Promise<EliminationReport | null> => {
    setEliminationLoading(true);
    setEliminationError(null);
    setEliminationReport(null);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (rosterSnapshotId) params.set('snapshotId', String(rosterSnapshotId));
      const report = await api<EliminationReport>(`/api/copytrade/elimination?${params.toString()}`);
      setEliminationReport(report);
      return report;
    } catch (error: unknown) { setEliminationError(error instanceof Error ? error.message : String(error)); return null; }
    finally { setEliminationLoading(false); }
  };

  const loadCopyWinners = async (limit: number, rosterSnapshotId = selectedRosterSnapshotId) => {
    setCopyWinnersLoading(true);
    try { setCopyWinners(await api<CopyCandidatesReport>(`/api/copytrade/winners?limit=${limit}${rosterSnapshotId ? `&snapshotId=${rosterSnapshotId}` : ''}`)); }
    catch (error: unknown) { setCopyTradeError(error instanceof Error ? error.message : String(error)); }
    finally { setCopyWinnersLoading(false); }
  };

  const loadScrutiny = async (wallets = scrutinyPinned, rosterSnapshotId = selectedRosterSnapshotId) => {
    if (!wallets.length) { setScrutinyResponse(null); return; }
    scrutinyLoadAbortRef.current?.abort();
    const controller = new AbortController();
    scrutinyLoadAbortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 45_000);
    setScrutinyLoading(true);
    setScrutinyError(null);
    try {
      const params = new URLSearchParams({ wallets: wallets.join(',') });
      if (rosterSnapshotId) params.set('snapshotId', String(rosterSnapshotId));
      const response = await api<ScrutinyResponse>(`/api/copytrade/scrutiny?${params.toString()}`, { signal: controller.signal });
      const savedRisk = await api<GmgnRiskResponse>(`/api/copytrade/scrutiny/gmgn-risk?wallets=${encodeURIComponent(wallets.join(','))}`, { signal: controller.signal });
      setScrutinyResponse(response);
      setGmgnRiskResults(Object.fromEntries(savedRisk.results.map((result) => [`${result.walletAddress}|${result.period}`, result])));
    } catch (error: unknown) {
      if (scrutinyLoadAbortRef.current === controller) {
        setScrutinyError(error instanceof DOMException && error.name === 'AbortError' ? 'Reading saved Scrutiny evidence timed out. No provider request was made.' : error instanceof Error ? error.message : String(error));
      }
    } finally {
      window.clearTimeout(timeout);
      if (scrutinyLoadAbortRef.current === controller) { scrutinyLoadAbortRef.current = null; setScrutinyLoading(false); }
    }
  };

  const fetchGmgnRiskDetails = async (walletAddresses = scrutinyPinned) => {
    if (gmgnRiskBusy || !walletAddresses.length) return;
    setGmgnRiskBusy(true); setScrutinyError(null); setScrutinyOutcome(null);
    try {
      const response = await api<GmgnRiskResponse>('/api/copytrade/scrutiny/gmgn-risk', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ walletAddresses, periods: ['30d'] }),
      });
      setGmgnRiskResults((current) => Object.fromEntries([...Object.entries(current), ...response.results.map((result) => [`${result.walletAddress}|${result.period}`, result])]));
      const unavailable = response.results.filter((result) => !result.available).length;
      setScrutinyOutcome(unavailable ? `GMGN risk details loaded with ${unavailable} unavailable period${unavailable === 1 ? '' : 's'}.` : 'GMGN risk details loaded for the selected wallets.');
    } catch (error: unknown) { setScrutinyError(error instanceof Error ? error.message : String(error)); }
    finally { setGmgnRiskBusy(false); }
  };

  const importGmgnRiskFile = async (file: File, walletAddress: string) => {
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
      const captures = root && Array.isArray(root.captures)
        ? (parsed as { captures: unknown[] }).captures : Array.isArray(parsed) ? parsed : [];
      const capture = captures.find((value) => {
        if (!value || typeof value !== 'object') return false;
        const item = value as { walletAddress?: unknown; period?: unknown };
        return item.walletAddress === walletAddress && item.period === '30d';
      }) as { walletAddress?: string; period?: string; status?: number; responseBody?: unknown } | undefined;
      let status = capture?.status;
      let responseBody = capture?.responseBody;
      // The investigation export produced by the extension uses `endpoints[].samples[]`,
      // rather than the newer `captures[]` format. Accept both formats so dropping the
      // downloaded investigation file into this wallet works as promised.
      if (!capture && root && Array.isArray(root.endpoints)) {
        for (const endpoint of root.endpoints) {
          if (!endpoint || typeof endpoint !== 'object') continue;
          const item = endpoint as { url?: unknown; samples?: unknown };
          if (typeof item.url !== 'string' || !/\/wallet\/sol\/[^/]+\/profit_stat\/30d(?:\?|$)/.test(item.url) || !Array.isArray(item.samples)) continue;
          const walletInUrl = item.url.match(/\/wallet\/sol\/([^/]+)\/profit_stat\/30d(?:\?|$)/)?.[1];
          if (walletInUrl !== walletAddress) continue;
          const sample = item.samples.find((value) => value && typeof value === 'object' && typeof (value as { responsePayload?: unknown }).responsePayload === 'string') as { status?: number; responsePayload?: string } | undefined;
          if (!sample?.responsePayload) continue;
          status = sample.status;
          responseBody = JSON.parse(sample.responsePayload);
          break;
        }
      }
      const metrics = responseBody === undefined ? null : normalizeImportedGmgnRisk(responseBody);
      if (!metrics) throw new Error(`This file has no usable 30d risk response for ${shortAddress(walletAddress)}.`);
      const imported: GmgnRiskResult = { walletAddress, period: '30d', available: status === undefined || status === 200, metrics, error: status && status !== 200 ? `GMGN returned HTTP ${status}` : undefined };
      if (!imported.available) throw new Error(imported.error ?? 'The imported GMGN response was unavailable.');
      await api('/api/copytrade/scrutiny/gmgn-risk/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ results: [imported] }) });
      setGmgnRiskResults((current) => ({ ...current, [`${walletAddress}|30d`]: imported }));
      setScrutinyOutcome('Imported GMGN 30-day risk details.');
    } catch (error: unknown) { setScrutinyError(error instanceof Error ? error.message : 'Could not read the GMGN risk JSON.'); }
  };

  const toggleScrutinyPin = (walletAddress: string) => {
    setScrutinyPinned((current) => {
      if (current.includes(walletAddress)) return current.filter((wallet) => wallet !== walletAddress);
      if (current.length >= MAX_SCRUTINY_WALLETS_UI) {
        setMessage(`At most ${MAX_SCRUTINY_WALLETS_UI} wallets can be pinned for scrutiny at once — unpin one first.`);
        return current;
      }
      return [...current, walletAddress];
    });
  };

  /** Scoped re-fetch for the pinned wallets only, reusing the same fire-and-forget fetch-run
   *  machinery (and single-run guard) as every other CopyTrade fetch. Polls locally to completion
   *  so the outcome message can report a per-wallet trade-count delta rather than just "started". */
  const refreshScrutinyTrades = async () => {
    if (scrutinyRefreshBusy || copyTradeStatus?.running || !scrutinyPinned.length) return;
    setScrutinyRefreshBusy(true);
    setScrutinyError(null);
    setScrutinyOutcome(null);
    const before = new Map((scrutinyResponse?.reports ?? []).map((r) => [r.walletAddress, r.checks.buySellComposition.metrics.buyCount + r.checks.buySellComposition.metrics.sellCount]));
    try {
      const response = await fetch('/api/copytrade/scrutiny/refresh-trades', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ walletAddresses: scrutinyPinned }),
      });
      const body = await response.json() as { runId?: number; status?: 'running'; error?: string };
      if (response.status === 409) { setMessage('A CopyTrade fetch is already running. Waiting for it to finish.'); }
      else if (!response.ok) { throw new Error(body.error ?? `Request failed (${response.status})`); }
      // Poll to completion (bounded) rather than firing and leaving the reader to guess when the
      // pinned wallets' figures are current again.
      let status = await loadCopyTradeStatus();
      for (let iterations = 0; status?.running && iterations < 150; iterations += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        status = await loadCopyTradeStatus();
      }
      await loadScrutiny();
      setScrutinyResponse((current) => {
        if (!current) return current;
        const outcomes = current.reports.map((report) => {
          const beforeCount = before.get(report.walletAddress) ?? 0;
          const afterCount = report.checks.buySellComposition.metrics.buyCount + report.checks.buySellComposition.metrics.sellCount;
          const delta = afterCount - beforeCount;
          const label = report.name?.trim() || `${report.walletAddress.slice(0, 6)}…`;
          return delta > 0 ? `${label}: +${delta} new trade${delta === 1 ? '' : 's'}` : `${label}: no new trades (already up to date)`;
        });
        setScrutinyOutcome(outcomes.length ? outcomes.join(' · ') : 'No pinned wallet returned a scrutiny report.');
        return current;
      });
    } catch (error: unknown) { setScrutinyError(error instanceof Error ? error.message : String(error)); }
    finally { setScrutinyRefreshBusy(false); }
  };

  /** Reuses POST /api/copytrade/copy-simulation/run as-is (its walletAddresses body override was
   *  already built for exactly this) — no new Dune wiring. That route runs to completion before
   *  responding, so no polling is needed here, unlike the fire-and-forget fetch above. */
  const fillScrutinyCoverage = async () => {
    if (scrutinyFillBusy || !scrutinyPinned.length) return;
    setScrutinyFillBusy(true);
    setScrutinyError(null);
    setScrutinyOutcome(null);
    const before = new Map((scrutinyResponse?.reports ?? []).map((r) => [r.walletAddress, r.checks.coverage.metrics.fullHistoryMatched]));
    try {
      const response = await fetch('/api/copytrade/copy-simulation/run', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ walletAddresses: scrutinyPinned }),
      });
      const body = await response.json() as { targetsSubmitted?: number; targetsTotal?: number; error?: string };
      if (response.status === 409) { setMessage('A copy simulation is already running.'); }
      else if (!response.ok) { throw new Error(body.error ?? `Request failed (${response.status})`); }
      else { setMessage(`Dune coverage run finished for ${scrutinyPinned.length} pinned wallet(s) (${body.targetsSubmitted ?? 0}/${body.targetsTotal ?? 0} targets submitted).`); }
      await loadScrutiny();
      setScrutinyResponse((current) => {
        if (!current) return current;
        const outcomes = current.reports.map((report) => {
          const beforeCount = before.get(report.walletAddress) ?? 0;
          const afterCount = report.checks.coverage.metrics.fullHistoryMatched;
          const delta = afterCount - beforeCount;
          const label = report.name?.trim() || `${report.walletAddress.slice(0, 6)}…`;
          return delta > 0 ? `${label}: +${delta} newly Dune-matched` : `${label}: no new matches (already up to date, or Dune returned nothing)`;
        });
        setScrutinyOutcome(outcomes.length ? outcomes.join(' · ') : 'No pinned wallet returned a scrutiny report.');
        return current;
      });
    } catch (error: unknown) { setScrutinyError(error instanceof Error ? error.message : String(error)); }
    finally { setScrutinyFillBusy(false); }
  };

  const loadCopySimulation = async (rosterSnapshotId = selectedRosterSnapshotId, walletAddresses?: string[], periodDays?: number) => {
    setCopySimulationLoading(true);
    const params = new URLSearchParams();
    if (rosterSnapshotId) params.set('snapshotId', String(rosterSnapshotId));
    if (walletAddresses?.length) params.set('walletAddresses', walletAddresses.join(','));
    if (periodDays) params.set('periodDays', String(periodDays));
    try {
      const report = await api<CopySimulationReport>(`/api/copytrade/copy-simulation${params.toString() ? `?${params.toString()}` : ''}`);
      setCopySimulation(report);
      return report;
    }
    catch (error: unknown) { setCopyTradeError(error instanceof Error ? error.message : String(error)); }
    finally { setCopySimulationLoading(false); }
  };

  const loadLiquidityImpact = async (rosterSnapshotId = selectedRosterSnapshotId) => {
    setLiquidityImpactLoading(true);
    try { setLiquidityImpact(await api<LiquidityImpactReport>(`/api/copytrade/liquidity-impact?periodDays=30${rosterSnapshotId ? `&snapshotId=${rosterSnapshotId}` : ''}`)); }
    catch (error: unknown) { setCopyTradeError(error instanceof Error ? error.message : String(error)); }
    finally { setLiquidityImpactLoading(false); }
  };

  const runCopySimulationBatch = async (walletAddresses?: string[], periodDays?: number, wideRetry = false, rosterSnapshotId = selectedRosterSnapshotId): Promise<{ targetsSubmitted: number; batchesRun: number; exhausted: boolean } | null> => {
    setCopySimulationRunBusy(true);
    setCopySimulationRunStatus({
      running: true,
      cancelRequested: false,
      targetsTotal: 0,
      targetsProcessed: 0,
      batchesRun: 0,
      currentBatch: 0,
      batchesTotal: 0,
      message: 'Planning…',
      batches: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      storedTargets: 0,
      failedTargets: 0,
      remainingTargets: 0,
      outcome: 'running',
      duneExecutionId: null,
      duneState: 'SUBMITTING',
      dunePollCount: 0,
      duneElapsedSeconds: 0,
      duneIsExecutionFinished: false,
      duneExecutionCostCredits: null,
      duneLastStatusAt: new Date().toISOString(),
      duneRequestPhase: 'idle',
      duneLastHttpStatus: null,
      duneLastRequestMs: null,
      duneLastPayload: null,
    });
    try {
      const result = await api<{ runIds: number[]; targetsSubmitted: number; batchesRun: number; exhausted: boolean; cancelled: boolean; targetsTotal: number }>(`/api/copytrade/copy-simulation/${wideRetry ? 'wide-retry' : 'run'}${rosterSnapshotId ? `?snapshotId=${rosterSnapshotId}` : ''}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(walletAddresses?.length ? { walletAddresses, periodDays } : { periodDays }) });
      setMessage(result.targetsSubmitted > 0
        ? `Queried Dune for ${result.targetsSubmitted} entry/exit price${result.targetsSubmitted === 1 ? '' : 's'} across ${result.batchesRun} batch${result.batchesRun === 1 ? '' : 'es'}.${result.exhausted ? ' More remain — run again to continue.' : ''}`
        : 'Every eligible trade for the current top traders has already been queried.');
      await loadCopySimulation(selectedRosterSnapshotId ?? undefined, walletAddresses, periodDays);
      await loadLiquidityImpact(selectedRosterSnapshotId ?? undefined);
      return result;
    } catch (error: unknown) { setCopyTradeError(error instanceof Error ? error.message : String(error)); return null; }
    finally { setCopySimulationRunBusy(false); void api<CopySimulationRunStatus>('/api/copytrade/copy-simulation/status').then(setCopySimulationRunStatus).catch(() => undefined); }
  };

  const stopCopySimulation = async () => {
    setCopySimulationStopBusy(true);
    try { setCopySimulationRunStatus(await api<CopySimulationRunStatus>('/api/copytrade/copy-simulation/stop', { method: 'POST' })); }
    catch (error: unknown) { setCopyTradeError(error instanceof Error ? error.message : String(error)); }
    finally { setCopySimulationStopBusy(false); }
  };

  const loadCopyTradePage = async (loadWalletEvidence = true) => {
    setCopyTradeLoading(true);
    setCopyTradeError(null);
    try {
      const rosterCatalog = await api<CopyTradeRosterCatalog>('/api/copytrade/rosters');
      setCopyTradeRosters(rosterCatalog);
      const rosterSnapshotId = selectedRosterSnapshotId ?? rosterCatalog.selectedByDefault;
      if (selectedRosterSnapshotId === null && rosterSnapshotId !== null) setSelectedRosterSnapshotId(rosterSnapshotId);
      const snapshotQuery = rosterSnapshotId ? `&snapshotId=${rosterSnapshotId}` : '';
      const [summary, results, status, duneStatus] = await Promise.all([
        api<CopyTradeSummary>('/api/copytrade/summary'),
        // The selected period and trader count must scope the report too, not just the next
        // fetch — otherwise the table answers a different question than the controls describe.
        api<CopyTradeResults>(`/api/copytrade/results?periodDays=${copyTradePeriodDays}&limit=${copyTradeLimit}${snapshotQuery}`),
        api<CopyTradeFetchStatus>('/api/copytrade/fetch/status'),
        api<CopySimulationRunStatus>('/api/copytrade/copy-simulation/status'),
      ]);
      setCopyTradeSummary(summary);
      setCopyTradeResults(results);
      setCopyTradeStatus(status);
      setCopySimulationRunStatus(duneStatus);
      // Wallet-stats uses the full selected table scope, not only the default screen-pass
      // candidates used by the broader research view. Read the same persisted simulation
      // report for these exact rows so their status cannot temporarily appear as “Never queried”.
      if (loadWalletEvidence && copyTradeSubTab === 'wallet-stats') {
        const walletAddresses = results.rows.map((row) => row.walletAddress);
        const simulation = await loadCopySimulation(rosterSnapshotId ?? undefined, walletAddresses, 30);
        if (simulation) setCopySimulation30d(simulation);
      }
      return results;
    } catch (error: unknown) {
      setCopyTradeError(error instanceof Error ? error.message : String(error));
    } finally {
      setCopyTradeLoading(false);
    }
  };

  const fetchCopyTrades = async () => {
    if (copyTradeBusy || copyTradeStatus?.running) return;
    setCopyTradeBusy(true);
    setCopyTradeError(null);
    try {
      const response = await fetch('/api/copytrade/fetch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limit: copyTradeLimit, periodDays: copyTradePeriodDays }) });
      const body = await response.json() as { runId?: number; status?: 'running'; error?: string };
      if (response.status === 409) {
        setMessage('A CopyTrade fetch is already running. Resuming its progress.');
        await loadCopyTradeStatus();
      } else if (!response.ok) {
        throw new Error(body.error ?? `Request failed (${response.status})`);
      } else {
        setMessage(`CopyTrade fetch started (run ${body.runId ?? '—'}).`);
        await loadCopyTradeStatus();
      }
    } catch (error: unknown) {
      setCopyTradeError(error instanceof Error ? error.message : String(error));
    } finally {
      setCopyTradeBusy(false);
    }
  };

  const fetchSingleTrader = async () => {
    const query = singleTraderQuery.trim();
    if (!query || singleTraderBusy || copyTradeStatus?.running) return;
    setSingleTraderBusy(true);
    setSingleTraderError(null);
    try {
      const response = await fetch('/api/copytrade/fetch/single', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, periodDays: copyTradePeriodDays }) });
      const body = await response.json() as { runId?: number; status?: 'running'; error?: string; resolved?: { kind: string; walletAddress?: string; matchedName?: string } };
      if (response.status === 409) {
        setMessage('A CopyTrade fetch is already running. Resuming its progress.');
        await loadCopyTradeStatus();
      } else if (!response.ok) {
        throw new Error(body.error ?? `Request failed (${response.status})`);
      } else {
        const label = body.resolved?.kind === 'name_match' ? `${body.resolved.matchedName} (${shortAddress(body.resolved.walletAddress ?? '')})` : body.resolved?.walletAddress ?? query;
        setMessage(`Fetching trades for ${label} (run ${body.runId ?? '—'}).`);
        await loadCopyTradeStatus();
      }
    } catch (error: unknown) {
      setSingleTraderError(error instanceof Error ? error.message : String(error));
    } finally {
      setSingleTraderBusy(false);
    }
  };

  const fetchWinnersTrades = async () => {
    if (winnersFetchBusy || copyTradeStatus?.running) return;
    setWinnersFetchBusy(true);
    setCopyTradeError(null);
    try {
      const response = await fetch(`/api/copytrade/winners/fetch${selectedRosterSnapshotId ? `?snapshotId=${selectedRosterSnapshotId}` : ''}`, { method: 'POST' });
      const body = await response.json() as { runId?: number; status?: 'running'; error?: string };
      if (response.status === 409) {
        setMessage('A CopyTrade fetch is already running. Resuming its progress.');
        await loadCopyTradeStatus();
      } else if (!response.ok) {
        throw new Error(body.error ?? `Request failed (${response.status})`);
      } else {
        setMessage(`Fetching trades for the current Winners (run ${body.runId ?? '—'}).`);
        await loadCopyTradeStatus();
      }
    } catch (error: unknown) {
      setCopyTradeError(error instanceof Error ? error.message : String(error));
    } finally {
      setWinnersFetchBusy(false);
    }
  };

  const stopCopyTradeFetch = async () => {
    if (!copyTradeStatus?.running || copyTradeStopBusy) return;
    setCopyTradeStopBusy(true);
    setCopyTradeError(null);
    try {
      const response = await fetch('/api/copytrade/fetch/stop', { method: 'POST' });
      const body = await response.json() as { stopped?: boolean; runId?: number | null; error?: string };
      if (!response.ok) throw new Error(body.error ?? `Stop request failed (${response.status})`);
      setMessage(body.stopped
        ? `Stop requested for CopyTrade fetch${body.runId ? ` (run ${body.runId})` : ''}. The current request will finish, then the run will stop.`
        : 'No CopyTrade fetch was running.');
      await loadCopyTradeStatus();
    } catch (error: unknown) {
      setCopyTradeError(error instanceof Error ? error.message : String(error));
    } finally {
      setCopyTradeStopBusy(false);
    }
  };

  const resumeCopyTradeFetch = async () => {
    if (copyTradeResumeBusy || copyTradeStatus?.running) return;
    setCopyTradeResumeBusy(true);
    setCopyTradeError(null);
    try {
      const response = await fetch('/api/copytrade/fetch/resume', { method: 'POST' });
      const body = await response.json() as { runId?: number; error?: string };
      if (!response.ok) throw new Error(body.error ?? `Resume request failed (${response.status})`);
      setMessage(`Resumed GMGN top-100 fetch (run ${body.runId ?? '—'}).`);
      await loadCopyTradeStatus();
    } catch (error: unknown) { setCopyTradeError(error instanceof Error ? error.message : String(error)); }
    finally { setCopyTradeResumeBusy(false); }
  };

  const resetCopyTradeFetch = async () => {
    if (copyTradeResetBusy || copyTradeStatus?.running) return;
    setCopyTradeResetBusy(true);
    setCopyTradeError(null);
    try {
      const response = await fetch('/api/copytrade/fetch/reset', { method: 'POST' });
      const body = await response.json() as { reset?: boolean; error?: string };
      if (!response.ok) throw new Error(body.error ?? `Reset request failed (${response.status})`);
      setMessage(body.reset ? 'GMGN resume snapshot reset. Saved trades were kept.' : 'No GMGN snapshot to reset.');
      await loadCopyTradeStatus();
    } catch (error: unknown) { setCopyTradeError(error instanceof Error ? error.message : String(error)); }
    finally { setCopyTradeResetBusy(false); }
  };

  const importBrowserActivity = async (file: File) => {
    setBrowserActivityImportBusy(true);
    setCopyTradeError(null);
    try {
      const result = await api<BrowserActivityImportResult>('/api/copytrade/import-browser-activity', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: file.name, content: await file.text() }),
      });
      setMessage(`Imported ${result.imported} wallet trades from ${file.name}; ${result.duplicates} duplicates retained as history. ${result.malformed} malformed rows were kept in the raw archive.`);
      await loadCopyTradePage();
      await loadCaptureHealth();
    } catch (error: unknown) {
      setCopyTradeError(error instanceof Error ? error.message : String(error));
    } finally { setBrowserActivityImportBusy(false); }
  };

  const saveCopyTradeSnapshot = async () => {
    try {
      const result = await api<{ snapshotId: number; computedAt: string }>('/api/copytrade/results/snapshot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Freeze what is on screen, not the server defaults.
      body: JSON.stringify({ periodDays: copyTradePeriodDays, limit: copyTradeLimit, snapshotId: selectedRosterSnapshotId }),
      });
      setMessage(`CopyTrade snapshot #${result.snapshotId} saved.`);
    } catch (error: unknown) {
      setCopyTradeError(error instanceof Error ? error.message : String(error));
    }
  };

  // Lazy-fetched — the subgroup section is collapsed by default, so this only runs once a
  // user actually opens it or switches property, not on every page load/refresh cycle.
  const loadSubgroupReport = async (property: SubgroupProperty) => {
    setSubgroupBusy(true);
    try {
      const next = await api<SignalPatternSubgroupReport>(`/api/analysis/patterns/subgroups?property=${property}`);
      setSubgroupReport(next);
      // Recomputed on every fetch, independent of the top-level report's own horizon pick —
      // different properties (or "combined") can each have their own best horizon.
      setSubgroupHorizon(bestSubgroupHorizon(next));
    }
    catch (error: unknown) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setSubgroupBusy(false); }
  };

  const refreshMeasurementPlan = async () => {
    setMeasurementPlanRefreshing(true);
    try {
      const nextPlan = await api<MeasurementPlan>('/api/dune/measurement-plan');
      setMeasurementPlan(nextPlan);
      return nextPlan;
    } finally { setMeasurementPlanRefreshing(false); }
  };

  const saveCurrentPatternSnapshot = async () => {
    setSavingSnapshot(true);
    try {
      await api<SignalPatternSnapshot>('/api/analysis/patterns/snapshot', { method: 'POST' });
      setPatternSnapshots(await api<SignalPatternSnapshot[]>('/api/analysis/patterns/snapshots'));
      setMessage('Pattern snapshot saved.');
    } catch (error: unknown) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setSavingSnapshot(false); }
  };

  const displayedPatternReport = viewingSnapshotId === null ? patternReport : patternSnapshots.find((snapshot) => snapshot.id === viewingSnapshotId)?.report ?? null;
  const displayedPatternHorizon = displayedPatternReport?.horizons.find((horizon) => horizon.horizon === patternHorizon) ?? null;
  const displayedSubgroupHorizon = subgroupReport?.horizons.find((horizon) => horizon.horizon === subgroupHorizon) ?? null;
  const prescreenCounts = measurementPlan?.prescreen.byDisposition;
  const prescreenTotal = prescreenCounts ? Object.values(prescreenCounts).reduce((sum, value) => sum + value, 0) : 0;
  const prescreenPercent = (value: number): string => prescreenTotal === 0 ? '0%' : `${(100 * value / prescreenTotal).toFixed(1)}%`;
  const patternVerdict = (() => {
    if (!displayedPatternHorizon) return null;
    const reliableGroups = displayedPatternHorizon.groups.filter((group) => group.reliable);
    const positive = reliableGroups.filter((group) => (group.medianReturnPct ?? 0) > 0).sort((a, b) => (b.medianReturnPct ?? 0) - (a.medianReturnPct ?? 0));
    const negative = reliableGroups.filter((group) => (group.medianReturnPct ?? 0) <= 0);
    if (!reliableGroups.length) return `At ${displayedPatternHorizon.horizon}, no signal type yet has enough genuine (non-stale) comparisons to call a pattern either way.`;
    if (!positive.length) return `At ${displayedPatternHorizon.horizon}, every signal type with enough data has a negative or flat median return — none stands out as positive.`;
    return `At ${displayedPatternHorizon.horizon}: ${positive.map((group) => formatSignalType(group.key)).join(', ')} ${positive.length === 1 ? 'is the only type' : 'are the only types'} with a positive median return; ${negative.length} other type${negative.length === 1 ? '' : 's'} with enough data ${negative.length === 1 ? 'is' : 'are'} net-negative.`;
  })();

  // Checks every stuck submitted/running/timed_out run against Dune's real current state and
  // finalizes whichever ones have actually finished, freeing their signals for re-measurement.
  // Never re-submits a query, so it can never create a duplicate Dune execution.
  const reconcileStuckRuns = async (): Promise<DuneReconcileSummary | null> => {
    if (reconcileBusy) return null;
    setReconcileBusy(true);
    try {
      const summary = await api<DuneReconcileSummary>('/api/dune/reconcile', { method: 'POST' });
      await refreshMeasurementPlan();
      if (summary.checked === 0) setMessage('No stuck Dune runs to reconcile.');
      else setMessage(`Reconciled ${summary.checked} stuck run${summary.checked === 1 ? '' : 's'}: ${summary.completed} completed, ${summary.failed} failed, ${summary.stillRunning} still running${summary.noApiKey ? ' (stopped early: no Dune API key configured)' : ''}.`);
      return summary;
    } catch (error: unknown) { setMessage(error instanceof Error ? error.message : String(error)); return null; }
    finally { setReconcileBusy(false); }
  };

  const measureAllOutcomes = async (reason: 'new' | 'retry' | 'all' = 'all') => {
    if (outcomeBatchBusy) return;
    const filteredCandidates = outcomeTypeFilter === 'all' ? outcomeCandidates : outcomeCandidates.filter((candidate) => candidate.signalType === outcomeTypeFilter);
    // Reconcile first so signals from previously stuck runs that have since actually finished
    // on Dune's side are eligible again before we decide what to measure this run.
    await reconcileStuckRuns();
    const currentPlan = await refreshMeasurementPlan();
    const eligibleIds = new Set(reason === 'new' ? currentPlan.eligibleNewSignalIds : reason === 'retry' ? currentPlan.retryQueueSignalIds : currentPlan.eligibleSignalIds);
    const ids = filteredCandidates.map((candidate) => candidate.id).filter((id) => eligibleIds.has(id));
    if (!ids.length) {
      setMessage(reason === 'retry'
        ? 'No matured outcomes are ready for re-fetch in this pass. Fresh checkpoints remain protected until their target time and retry delay have elapsed.'
        : reason === 'new'
          ? 'No never-measured signals are ready in this pass. New signals may still be waiting for a safe pre-screen slot.'
          : 'No signals are currently eligible for measurement. Pending, unavailable, and already usable checkpoints are protected from unnecessary Dune requests.');
      return;
    }
    const batchSize = 25;
    const batches = Array.from({ length: Math.ceil(ids.length / batchSize) }, (_, index) => ids.slice(index * batchSize, (index + 1) * batchSize));
    setOutcomeBatchBusy(true);
    stopOutcomeBatchRef.current = false;
    setOutcomeBatchProgress({ completed: 0, total: ids.length, current: 0, batches: batches.length });
    const merged = new Map<number, OutcomeTimeline>();
    const failedBatches: string[] = [];
    try {
      for (let index = 0; index < batches.length; index += 1) {
        if (stopOutcomeBatchRef.current) break;
        // Caught per-batch (not around the whole loop): one batch timing out or erroring must
        // not abort every batch after it — it's recorded and the run moves on to the next one.
        try {
          const result = await api<OutcomeTimeline[]>('/api/dune/outcomes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signalIds: batches[index] }) });
          for (const timeline of result) merged.set(timeline.signal.id, timeline);
          setOutcomeTimelines((current) => {
            const next = new Map(current.map((timeline) => [timeline.signal.id, timeline]));
            for (const timeline of result) next.set(timeline.signal.id, timeline);
            return [...next.values()];
          });
          setMessage(`Measured batch ${index + 1} of ${batches.length} (${batches[index].length} signals archived).`);
        } catch (error: unknown) {
          const reason = error instanceof Error ? error.message : String(error);
          failedBatches.push(`batch ${index + 1} (${reason})`);
          setMessage(`Batch ${index + 1} of ${batches.length} failed: ${reason} — continuing with the remaining batches.`);
        }
        const completed = Math.min((index + 1) * batchSize, ids.length);
        setOutcomeBatchProgress({ completed, total: ids.length, current: index + 1, batches: batches.length });
        await Promise.all([refreshPatternReport().catch(() => {}), refreshMeasurementPlan().catch(() => {})]);
        if (index + 1 < batches.length) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      setOutcomeTimelines([...merged.values()]);
      if (failedBatches.length) setMessage(`Measured ${merged.size} of ${ids.length} signals across ${batches.length} batches; ${failedBatches.length} batch${failedBatches.length === 1 ? '' : 'es'} failed and ${failedBatches.length === 1 ? 'was' : 'were'} skipped: ${failedBatches.join('; ')}. Completed batches remain saved — a stuck batch will be picked up automatically by reconciliation on the next run.`);
      else setMessage(`${reason === 'retry' ? 'Re-fetched' : reason === 'new' ? 'Measured new' : 'Measured'} ${ids.length} signals in ${batches.length} archived Dune batches. Existing complete measurements were skipped.`);
      if (stopOutcomeBatchRef.current) setMessage(`Stopped after ${merged.size} of ${ids.length} signals. Completed batches remain saved; the remaining ${Math.max(0, ids.length - merged.size)} signals can be run later.`);
    } finally { stopOutcomeBatchRef.current = false; setOutcomeBatchBusy(false); }
  };

  const stopOutcomeBatch = () => {
    if (!outcomeBatchBusy) return;
    stopOutcomeBatchRef.current = true;
    setMessage('Stop requested. The current Dune batch will finish, then no further batches will be submitted.');
  };

  const loadArchives = async () => {
    setLoadingArchives(true);
    try {
      setArchives(await api<GmgnArchiveSummary[]>('/api/gmgn/archives'));
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingArchives(false);
    }
  };

  useEffect(() => {
    const updateScrollTopVisibility = () => setShowScrollTop(window.scrollY > 500);
    updateScrollTopVisibility();
    window.addEventListener('scroll', updateScrollTopVisibility, { passive: true });
    return () => window.removeEventListener('scroll', updateScrollTopVisibility);
  }, []);
  useEffect(() => {
    if (!copySimulationRunStatus || copySimulationRunStatus.outcome === 'idle') return;
    setCopySimulationRunReportOpen(copySimulationRunStatus.running);
  }, [copySimulationRunStatus?.running, copySimulationRunStatus?.outcome]);
  useEffect(() => {
    if (WALLET_STATS_ONLY) return;
    void loadCopyTradeStatus();
  }, []);

  useEffect(() => {
    if (WALLET_STATS_ONLY) return;
    if (activeMenu !== 'copytrade') return;
    if (copyTradeSubTab === 'wallet-stats') return;
    void loadCopyTradePage();
    const snapshotForStats = selectedRosterSnapshotId ?? copyTradeRosters?.selectedByDefault ?? null;
    if (snapshotForStats !== null) {
      void loadGmgnStats(100, snapshotForStats).then((result) => {
        if (result?.stats) setWalletScreenSummary(buildWalletScreenSummary(result.stats, Math.max(copyTradeRows.length, 100)));
      });
    }
  }, [activeMenu, copyTradeSubTab, selectedRosterSnapshotId, copyTradeRosters?.selectedByDefault]);
  useEffect(() => {
    if (WALLET_STATS_ONLY) return;
    if (activeMenu !== 'copytrade' || selectedRosterSnapshotId === null || copyTradeSubTab === 'wallet-stats') return;
    void loadCopyTradePage();
  }, [selectedRosterSnapshotId, copyTradeSubTab]);

  useEffect(() => {
    if (!copyTradeStatus?.running) return;
    const timer = window.setInterval(async () => {
      const next = await loadCopyTradeStatus();
      if (next && !next.running && (next.status === 'completed' || next.status === 'failed' || next.status === 'rate_limited' || next.status === 'cancelled')) {
        await loadCopyTradePage();
        // A completed run just folded a fresh data point into the server-side estimate
        // (recordFetchRunEstimate) — refresh so the next projection reflects it immediately,
        // rather than waiting for the user to touch a dropdown.
        if (next.status === 'completed') await loadCopyTradeEstimate(copyTradeLimit, copyTradePeriodDays);
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [copyTradeStatus?.running]);

  useEffect(() => {
    // The estimate is advisory and can never improve the first render. On the wallet-stats
    // tab, let the database-backed results table render first; otherwise a slow estimate request can
    // compete with the initial report read and make the page look stuck.
    if (WALLET_STATS_ONLY && copyTradeSubTab === 'wallet-stats' && !walletStatsReady) return;
    const timer = window.setTimeout(() => { void loadCopyTradeEstimate(copyTradeLimit, copyTradePeriodDays); }, WALLET_STATS_ONLY ? 1200 : 0);
    return () => window.clearTimeout(timer);
  }, [copyTradeLimit, copyTradePeriodDays, copyTradeSubTab, walletStatsReady]);
  // Load only data used by the three active CopyTrade tabs.
  useEffect(() => {
    if (copyTradeSubTab === 'wallet-stats') {
      setWalletStatsReady(false);
      void (async () => {
        try {
          // Render the database-backed roster/report as soon as the base reads finish. GMGN stats and
          // Dune evidence refresh in the background instead of blocking the table spinner.
          const pageResults = await loadCopyTradePage(false);
          const walletAddresses = pageResults?.rows.map((row) => row.walletAddress);
          // The roster/results response is enough to render the table shell immediately. The
          // larger GMGN-stats and Dune reports enrich it in the background; they must not keep
          // the whole decision view in a loading state.
          setWalletStatsReady(true);
          // The decision view is 30-day now. Load that large report once and reuse it for both
          // legacy state holders; requesting the same 8MB report twice made first load feel hung.
          // Historical consistency is now a hard gate on the "Passed all tests" verdict, so this
          // tab must load it too — it was previously fetched only on the `research` tab, which
          // would have left every wallet here permanently 'insufficient' and unable to pass.
          const [, simulation] = await Promise.all([
            loadGmgnStats(),
            loadCopySimulation(selectedRosterSnapshotId ?? undefined, walletAddresses, 30),
            loadHistoricalConsistency(copyTradeLimit, selectedRosterSnapshotId ?? undefined),
          ]);
          if (simulation) setCopySimulation30d(simulation);
        } catch { setWalletStatsReady(true); }
      })();
    } else if (copyTradeSubTab === 'scrutiny') {
      if (!WALLET_STATS_ONLY) {
        void loadCopyWinners(copyTradeLimit, selectedRosterSnapshotId ?? undefined);
      } else if (!walletStatsReady) {
        // Auto-pin (below) reads the wallet-stats decision table's own candidates — load that
        // data even when Scrutiny is opened directly, without visiting GMGN wallet stats first.
        void (async () => {
          try {
            const pageResults = await loadCopyTradePage(false);
            const walletAddresses = pageResults?.rows.map((row) => row.walletAddress);
            const [, simulation] = await Promise.all([
              loadGmgnStats(),
              loadCopySimulation(selectedRosterSnapshotId ?? undefined, walletAddresses, 30),
            ]);
            if (simulation) setCopySimulation30d(simulation);
          } finally { setWalletStatsReady(true); }
        })();
      }
      void loadScrutiny();
    }
  }, [copyTradeSubTab, copyTradeLimit, selectedRosterSnapshotId, copyTradeRosters?.selectedByDefault]);
  useEffect(() => {
    if (WALLET_STATS_ONLY || activeMenu !== 'copytrade' || copyTradeSubTab !== 'wallet-stats') return;
    void loadElimination(selectedRosterSnapshotId ?? undefined);
  }, [activeMenu, copyTradeSubTab, selectedRosterSnapshotId]);
  useEffect(() => {
    if (copyTradeSubTab !== 'pattern-discovery') return;
    void loadPatternDiscoveryExport(copyTradePeriodDays);
  }, [copyTradeSubTab, copyTradePeriodDays]);
  useEffect(() => {
    if (copyTradeSubTab !== 'wallet-stats' || !gmgnStatsStatus?.running) return;
    const timer = window.setInterval(async () => {
      const status = await api<GmgnStatsFetchStatus>('/api/copytrade/stats/status');
      setGmgnStatsStatus(status);
      await loadGmgnStats();
      if (!status.running) await loadCopyTradePage();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [copyTradeSubTab, gmgnStatsStatus?.running]);
  useEffect(() => {
    if (!copySimulationRunStatus?.running) return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      if (disposed || copySimulationStatusPollInFlight.current) return;
      copySimulationStatusPollInFlight.current = true;
      let next: CopySimulationRunStatus | null = null;
      try {
        next = await api<CopySimulationRunStatus>('/api/copytrade/copy-simulation/status');
        if (!disposed) setCopySimulationRunStatus(next);
      } catch { /* retry on the next poll while the run remains active */ }
      finally {
        copySimulationStatusPollInFlight.current = false;
        // Schedule only after the prior request finishes. A slow backend can no longer
        // accumulate a backlog of status requests in the browser.
          if (!disposed && (next?.running ?? copySimulationRunStatus?.running === true)) timer = window.setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    return () => { disposed = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [copySimulationRunStatus?.running === true]);
  useEffect(() => {
    if (!statsDetailWallet) {
      setStatsDetailTrades(null);
      setStatsDetailTradesLoading(false);
      setStatsDetailTradeId(null);
      return;
    }
    let disposed = false;
    setStatsDetailTradesLoading(true);
    void api<CopyTradeHistoryResponse>(`/api/copytrade/trades/${encodeURIComponent(statsDetailWallet)}`)
      .then((result) => { if (!disposed) setStatsDetailTrades(result); })
      .catch((error: unknown) => { if (!disposed) setMessage(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (!disposed) setStatsDetailTradesLoading(false); });
    return () => { disposed = true; };
  }, [statsDetailWallet]);
  const openStatsDetail = (walletAddress: string) => {
    setMessage(`Opening saved details for ${shortWalletAddress(walletAddress)}`);
    setMaintenanceOpen(true);
    setStatsDetailWallet(walletAddress);
    window.setTimeout(() => document.querySelector('.copytrade-modal')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  };
  const highlightStatsTrade = (tradeId: number | null, scrollToRow = false) => {
    setStatsDetailTradeId(tradeId);
    if (scrollToRow && tradeId !== null) window.requestAnimationFrame(() => document.querySelector(`[data-detail-trade-id="${tradeId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  };
  useEffect(() => {
    try { window.localStorage.setItem('vantage.crypto.excluded-screening-wallets', JSON.stringify(excludedScreeningWallets)); }
    catch { /* Persistence is best effort. */ }
  }, [excludedScreeningWallets]);
  useEffect(() => {
    try { window.localStorage.setItem('vantage.crypto.included-screening-wallets', JSON.stringify(includedScreeningWallets)); }
    catch { /* Persistence is best effort. */ }
  }, [includedScreeningWallets]);
  useEffect(() => {
    try { window.localStorage.setItem('vantage.crypto.scrutiny-pinned-wallets', JSON.stringify(scrutinyPinned)); }
    catch { /* Persistence is best effort. */ }
    if (copyTradeSubTab === 'scrutiny') void loadScrutiny();
  }, [scrutinyPinned]);
  useEffect(() => { if (!WALLET_STATS_ONLY && copyTradeSubTab !== 'wallet-stats') { void loadCopySimulation(selectedRosterSnapshotId ?? undefined); void loadLiquidityImpact(selectedRosterSnapshotId ?? undefined); } }, [selectedRosterSnapshotId, copyTradeSubTab]);

  const loadLogs = async () => {
    setLoadingLogs(true);
    try {
      setLogs(await api<DiagnosticLog[]>('/api/logs?limit=50'));
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingLogs(false);
    }
  };

  useEffect(() => {
    if (WALLET_STATS_ONLY) return;
    void refresh().catch((error: unknown) => setMessage(String(error)));
  }, []);
  useEffect(() => {
    const intro = document.querySelector<HTMLElement>('.signal-outcome-batch-panel .outcome-inner > p');
    if (intro) intro.textContent = 'Select one or more captured signals. The Dune SQL query uses supported time arithmetic for the signal time and its configured historical checkpoints. A checkpoint whose window has not yet elapsed shows as pending; a token with no matching trade remains unavailable.';
    const candidateById = new Map(outcomeCandidates.map((candidate) => [candidate.id, candidate]));
    document.querySelectorAll<HTMLElement>('.signal-outcome-batch-panel .candidate-row').forEach((row) => {
      const id = Number(row.querySelector('b')?.textContent?.match(/#(\d+)/)?.[1]);
      const candidate = candidateById.get(id);
      const address = row.querySelector<HTMLElement>('small[title]');
      if (candidate && address) { address.textContent = ''; address.append(document.createTextNode(tokenDisplay(candidate.symbol, candidate.tokenAddress))); const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'copy-address'; copy.ariaLabel = `Copy address ${candidate.tokenAddress}`; copy.textContent = '⧉'; copy.onclick = (event) => { event.preventDefault(); event.stopPropagation(); void copyAddress(candidate.tokenAddress); }; address.append(copy); }
    });
  }, [outcomeCandidates]);

  const importDune = async (file: File) => {
    setBusy(true);
    setDuneBusyFile(file.name);
    setMessage(`Saving ${file.name} to SQLite and creating an archive…`);
    try {
      const result = await api<ImportSummary>('/api/import-dune', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: file.name, content: await file.text() }),
      });
      await refresh();
      setLastDuneImport({ fileName: file.name, at: new Date().toISOString(), result });
      setMessage(`Imported ${result.imported}; skipped ${result.skipped}; errors ${result.errors}. Archive: ${result.archivePath ?? 'already archived'}`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      setDuneBusyFile(null);
    }
  };

  const exportGmgnTokenAddresses = async () => {
    setExportingAddresses(true);
    try {
      const summary = await api<GmgnTokenAddressSummary>('/api/gmgn/token-addresses');
      if (summary.addresses.length === 0) {
        setMessage('No GMGN-observed token addresses are missing from the cohort right now — nothing to export.');
        return;
      }
      const blob = new Blob([summary.addresses.join('\n')], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `gmgn-token-addresses-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage(`Exported ${summary.addresses.length} address(es) not yet in the Dune cohort (of ${summary.total} GMGN-observed addresses total, ${summary.matchedToCohort} already matched). Look these up in Dune, then upload the result below.`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setExportingAddresses(false);
    }
  };

  const generateDuneQuery = async () => {
    setGeneratingQuery(true);
    try {
      const summary = await api<GmgnTokenAddressSummary>('/api/gmgn/token-addresses');
      if (summary.addresses.length === 0) {
        setMessage('No GMGN-observed token addresses are missing from the cohort right now — nothing to query.');
        setDuneQuery('');
        return;
      }
      setDuneQuery(buildSimpleDuneEnrichmentQuery(summary.addresses));
      setMessage(`Generated a Dune query for ${summary.addresses.length} address(es). Copy it below, run it in Dune, then upload the result.`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setGeneratingQuery(false);
    }
  };

  const copyDuneQuery = async () => {
    try {
      await navigator.clipboard.writeText(duneQuery);
      setMessage('Dune query copied to clipboard.');
    } catch {
      setMessage('Could not copy automatically — select the query text below and copy it manually.');
    }
  };

  const importDuneEnrichment = async (file: File) => {
    setEnrichmentBusy(true);
    setMessage(`Saving ${file.name} as targeted Dune enrichment…`);
    try {
      const result = await api<ImportSummary>('/api/import-dune-enrichment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: file.name, content: await file.text() }),
      });
      await refresh();
      setLastEnrichmentImport({ fileName: file.name, at: new Date().toISOString(), result });
      setMessage(`Enrichment imported ${result.imported}; skipped ${result.skipped}; errors ${result.errors}. Addresses already in the cohort were left untouched.`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setEnrichmentBusy(false);
    }
  };

  const captureGmgn = async () => {
    setBusy(true);
    try {
      const stored = await api<{ id: number }>('/api/gmgn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: gmgnPayload,
      });
      await refresh();
      setMessage(`GMGN observation #${stored.id} saved. Raw payload preserved.`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const importBrowserCapture = async (file: File) => {
    setBrowserImportBusy(true);
    setMessage(`Importing ${file.name} and preserving the raw browser response…`);
    try {
      const result = await api<BrowserImportResult>('/api/gmgn/import-browser-capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: file.name, content: await file.text() }),
      });
      await refresh();
      setLastBrowserImport({ fileName: file.name, at: new Date().toISOString(), result });
      setMessage(`${result.duplicateFile ? 'Browser capture already imported' : 'Browser capture imported'}: +${result.imported} signals · ${result.skipped} repeats · ${result.errors} issues. Raw upload archived.`);
      if (rawEndpointOpen) await loadRawEndpointSummary();
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBrowserImportBusy(false);
    }
  };

  const importBrowserCaptures = async (files: File[]) => {
    if (files.length <= 1) { if (files[0]) await importBrowserCapture(files[0]); return; }
    setMessage(`Importing ${files.length} browser captures one by one; each raw upload will be archived separately.`);
    for (const file of files) await importBrowserCapture(file);
    setMessage(`Finished importing ${files.length} browser capture files. Each file was processed and archived independently.`);
  };

  const loadRawEndpointSummary = async () => {
    try { setRawEndpointSummary(await api<RawEndpointSummary>('/api/gmgn/raw-endpoints/summary')); }
    catch (error: unknown) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  // Lazy-fetched — this section is collapsed by default, same reasoning as the Patterns
  // subgroup breakdown: costs nothing when unused, only queried once a user actually opens it.
  const loadRawEndpointDetails = async (type: RawEndpointType) => {
    setRawEndpointBusy(true);
    setRawEndpointExpandedId(null);
    try { setRawEndpointRows(await api<RawEndpointRow[]>(`/api/gmgn/raw-endpoints/${type}?limit=50`)); }
    catch (error: unknown) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setRawEndpointBusy(false); }
  };

  const openRawEndpointSection = async () => {
    const opening = !rawEndpointOpen;
    setRawEndpointOpen(opening);
    if (opening && !rawEndpointSummary) await loadRawEndpointSummary();
    if (opening && rawEndpointRows.length === 0) await loadRawEndpointDetails(rawEndpointType);
  };


  const navigateTo = (section: string) => {
    setActiveMenu(section);
    if (section === 'copytrade') setCopyTradeSubTab('wallet-stats');
    window.history.pushState({}, '', `#${section}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const navigateCopyTradeSubTab = (subTab: CopyTradeSubTab) => {
    setActiveMenu('copytrade');
    setCopyTradeSubTab(subTab);
    window.history.pushState({}, '', `#copytrade/${subTab}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  useEffect(() => {
    if (WALLET_STATS_ONLY) {
      const parsed = parseCopyTradeRoute(window.location.hash.slice(1) || 'copytrade/wallet-stats');
    const allowedSubTab = parsed.subTab;
      const canonicalHash = `#copytrade/${allowedSubTab}`;
      if (window.location.hash !== canonicalHash) window.history.replaceState({}, '', canonicalHash);
    }
    const onLocationChange = () => {
      if (WALLET_STATS_ONLY) {
        const parsed = parseCopyTradeRoute(window.location.hash.slice(1) || 'copytrade/wallet-stats');
        const allowedSubTab = parsed.subTab;
        setActiveMenu('copytrade');
        setCopyTradeSubTab(allowedSubTab);
        const canonicalHash = `#copytrade/${allowedSubTab}`;
        if (window.location.hash !== canonicalHash) window.history.replaceState({}, '', canonicalHash);
        return;
      }
      const next = parseCopyTradeRoute(window.location.hash.slice(1) || 'dune-capture');
      setActiveMenu(next.menu);
      setCopyTradeSubTab(next.subTab);
    };
    window.addEventListener('popstate', onLocationChange);
    window.addEventListener('hashchange', onLocationChange);
    return () => { window.removeEventListener('popstate', onLocationChange); window.removeEventListener('hashchange', onLocationChange); };
  }, []);

  const toggleOutcomeSort = (key: OutcomeSortKey) => setOutcomeSort((current) => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' }));
  const sortIndicator = (key: typeof outcomeSort.key) => outcomeSort.key === key ? (outcomeSort.direction === 'asc' ? ' ↑' : ' ↓') : '';
  const outcomeColumns: Array<{ key: OutcomeSortKey; label: string }> = [
    { key: 'signal', label: 'Signal' },
    { key: 'type', label: 'Type' },
    ...CHECKPOINT_COLUMNS.map((label) => ({ key: label, label: `${label} change` })),
    { key: 'token', label: 'Token' },
  ];
  const filteredOutcomeCandidates = outcomeTypeFilter === 'all' ? outcomeCandidates : outcomeCandidates.filter((candidate) => candidate.signalType === outcomeTypeFilter);
  const outcomeTypeOptions = [...new Set(outcomeCandidates.map((candidate) => candidate.signalType).filter((value): value is string => Boolean(value)))].sort((a, b) => Number(a) - Number(b));
  const selectedTypePrescreen = outcomeTypeFilter === 'all' ? null : measurementPlan?.prescreen.bySignalType.find((item) => item.signalType === outcomeTypeFilter);
  const selectedNewCount = selectedTypePrescreen?.newSelected ?? measurementPlan?.prescreen.selectedNewCount ?? 0;
  const selectedRetryCount = outcomeTypeFilter === 'all'
    ? measurementPlan?.retryQueueSignalIds.length ?? 0
    : measurementPlan?.retryQueueSignalIds.filter((id) => outcomeCandidates.some((candidate) => candidate.id === id && candidate.signalType === outcomeTypeFilter)).length ?? 0;
  const selectedMeasurementProgress = measurementPlan
    ? outcomeTypeFilter === 'all'
      ? {
        captured: measurementPlan.capturedCount,
        measured: measurementPlan.measuredCount,
        unmeasured: measurementPlan.unmeasuredCount,
        eligible: measurementPlan.eligibleSignalIds.length,
        newEligible: selectedNewCount,
        retryEligibleSelected: selectedRetryCount,
        newReady: measurementPlan.byState.not_measured ?? 0,
        // Show the same screened lifetime-first queue that the action button submits.
        // The broader planner retry_eligible count includes retained repeats that are
        // intentionally not part of this Dune pass.
        retryReady: selectedRetryCount,
        pending: measurementPlan.byState.pending_target_time ?? 0,
        complete: measurementPlan.byState.complete ?? 0,
        retryEligible: measurementPlan.byState.retry_eligible ?? 0,
        inFlight: measurementPlan.inFlightCount,
        tooFresh: measurementPlan.tooFreshCount,
        neverMaturelyAttempted: measurementPlan.neverMaturelyAttemptedCount,
        waitingOnRetryBuffer: measurementPlan.byState.elapsed_but_unavailable ?? 0,
      }
      : (() => {
        const item = measurementPlan.bySignalType.find((entry) => entry.signalType === outcomeTypeFilter);
        // newReady must exclude too-fresh rows explicitly here: item.unmeasured bundles
        // not_measured and too_fresh together (see planner.ts's stateFor/typeStates), unlike
        // the all-types branch above which reads byState.not_measured directly (already
        // too_fresh-free). Without this subtraction, selecting a specific signal type would
        // wrongly count signals still inside the 24h observation buffer as "ready".
        return item ? { ...item, newEligible: selectedNewCount, retryEligibleSelected: selectedRetryCount, newReady: item.unmeasured - item.tooFresh, retryReady: selectedRetryCount } : {
          captured: 0, measured: 0, unmeasured: 0, eligible: 0, newEligible: 0, retryEligibleSelected: 0,
          newReady: 0, retryReady: 0, pending: 0, complete: 0, retryEligible: 0, inFlight: 0, tooFresh: 0, neverMaturelyAttempted: 0, waitingOnRetryBuffer: 0,
        };
      })()
    : null;
  const selectedWaitingCount = selectedMeasurementProgress ? selectedMeasurementProgress.pending + selectedMeasurementProgress.tooFresh + selectedMeasurementProgress.waitingOnRetryBuffer : 0;
  const selectedUpToDate = Boolean(selectedMeasurementProgress) && selectedMeasurementProgress!.newEligible === 0 && selectedMeasurementProgress!.retryEligibleSelected === 0 && selectedWaitingCount === 0 && selectedMeasurementProgress!.inFlight === 0;
  // A checkpoint whose window had not elapsed when it was measured renders as "pending",
  // distinct from a normal missing value — it is not automatically backfilled; re-measuring
  // the signal later is what will produce a real number.
  const renderCheckpointCell = (timeline: OutcomeTimeline, base: number | null, label: string) => {
    const checkpoint = timeline.checkpoints.find((c) => c.label === label);
    if (checkpoint?.result.status === 'checkpoint not yet reached') {
      return <td key={label} className="change-pending" title="Not yet elapsed when measured — re-measure this signal later for a real value.">pending</td>;
    }
    const value = checkpoint?.result.priceUsd ?? null;
    return <td key={label} className={value === null || base === null ? '' : value >= base ? 'change-positive' : 'change-negative'}><strong>{formatPercentChange(base, value)}</strong></td>;
  };
  const visibleOutcomeTimelines = outcomePageSize === 'all' ? outcomeTimelines : outcomeTimelines.slice(outcomePage * outcomePageSize, (outcomePage + 1) * outcomePageSize);
  const outcomePageCount = outcomePageSize === 'all' ? 1 : Math.max(1, Math.ceil(outcomeTimelines.length / outcomePageSize));
  // Sort keys/headers are matched declaratively via each <th>'s own onClick below — not by
  // DOM position — so inserting or reordering checkpoint columns can never attach a click
  // handler to the wrong header (the DOM-position-matching version of this was fragile in
  // exactly that way).
  useEffect(() => {
    if (outcomeTimelines.length === 0) return;
    setOutcomeTimelines((current) => [...current].sort((left, right) => {
      const checkpointValue = (timeline: OutcomeTimeline, label: string) => timeline.checkpoints.find((checkpoint) => checkpoint.label === label)?.result.priceUsd ?? null;
      const leftBase = checkpointValue(left, 'signal');
      const rightBase = checkpointValue(right, 'signal');
      const metric = (timeline: OutcomeTimeline, base: number | null): string | number | null => outcomeSort.key === 'signal' ? timeline.signal.id : outcomeSort.key === 'type' ? (timeline.signal.signalType ?? '') : outcomeSort.key === 'token' ? (timeline.signal.symbol ?? timeline.signal.tokenAddress) : percentChangeValue(base, checkpointValue(timeline, outcomeSort.key));
      const leftValue = metric(left, leftBase);
      const rightValue = metric(right, rightBase);
      const comparison = leftValue === null && rightValue === null ? 0 : leftValue === null ? 1 : rightValue === null ? -1 : typeof leftValue === 'number' && typeof rightValue === 'number' ? leftValue - rightValue : String(leftValue).localeCompare(String(rightValue));
      return (outcomeSort.direction === 'asc' ? 1 : -1) * comparison;
    }));
  }, [outcomeSort]);

  const duneActivity = refreshBusy || measurementPlanRefreshing || outcomeBatchBusy || reconcileBusy || outcomeBusy;
  const duneActivityLabel = outcomeBatchBusy ? 'Dune measurement batches are running' : reconcileBusy ? 'Checking Dune runs for completion' : measurementPlanRefreshing ? 'Refreshing the Dune measurement plan' : refreshBusy ? 'Loading saved Dune evidence' : 'Dune Capture is idle';
  const copyTradeRows = copyTradeResults?.rows ?? [];
  const historicalConsistencyByWallet = new Map((historicalConsistency?.rows ?? []).map((row) => [row.walletAddress, row]));
  const sortedCopyTradeRows = [...copyTradeRows].sort((left, right) => {
    const value = (row: CopyTradeRow): string | number | null => copyTradeSort.key === 'name' ? (row.name ?? row.walletAddress) : copyTradeSort.key === 'verdict' ? row.verdict : row[copyTradeSort.key];
    const leftValue = value(left);
    const rightValue = value(right);
    const comparison = leftValue === null && rightValue === null ? 0 : leftValue === null ? 1 : rightValue === null ? -1 : typeof leftValue === 'number' && typeof rightValue === 'number' ? leftValue - rightValue : String(leftValue).localeCompare(String(rightValue));
    return (copyTradeSort.direction === 'asc' ? 1 : -1) * comparison;
  });
  const sortedGmgnAggregateRows = [...copyTradeRows].sort((left, right) => {
    const leftValue = left.gmgnAggregate?.realizedProfitPnlPercent ?? null;
    const rightValue = right.gmgnAggregate?.realizedProfitPnlPercent ?? null;
    if (leftValue === null && rightValue === null) return left.walletAddress.localeCompare(right.walletAddress);
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    return rightValue - leftValue;
  });
  const gmgnStatsByWallet = new Map<string, Map<string, GmgnAggregateStats>>();
  for (const record of gmgnStatsRecords) {
    const parsed = parseAggregateRecord(record);
    if (!parsed) continue;
    const periods = gmgnStatsByWallet.get(record.walletAddress) ?? new Map<string, GmgnAggregateStats>();
    periods.set(record.period, parsed);
    gmgnStatsByWallet.set(record.walletAddress, periods);
  }
  const visibleWalletScreenSummary = walletScreenSummary ?? (gmgnStatsRecords.length > 0 ? buildWalletScreenSummary(gmgnStatsRecords, Math.max(copyTradeRows.length, 100)) : null);
  const includedScreeningWalletSet = new Set(includedScreeningWallets);
  // Triage-eliminated wallets fold into the same exclusion set the manual checkboxes use, so a
  // wallet the triage rejected is skipped on the next Dune fetch exactly like a manually
  // unchecked one — same override path too: ticking its checkbox adds it to
  // includedScreeningWallets, which wins over both sources of exclusion identically. Opt-in via
  // skipEliminatedInDune and re-derived fresh each render, not written back into
  // excludedScreeningWallets itself, so it never persists past a re-run of triage or a session.
  const latestGmgnFetchAt = visibleWalletScreenSummary?.lastFetchedAt ?? null;
  // What skipping a fetch actually costs, stated in plain terms, from data already on hand — no
  // new request needed to show this. Derived from each wallet's own historical trade rate
  // (buy+sell over its stored 30-day window), which is a real measured average, not a guess
  // conjured for this banner — but it stays an ESTIMATE, never a promise: a quiet wallet could
  // still trade in the next minute, and a historically busy one could stay silent for a week.
  // The one thing this can say for certain is the size of the blind window itself (how long
  // since data was last confirmed current), because that number has no uncertainty in it.
  const staleDataAgeHours = latestGmgnFetchAt ? (Date.now() - Date.parse(latestGmgnFetchAt)) / 3_600_000 : null;
  const estimatedTradesSinceLastFetch = staleDataAgeHours !== null
    ? [...gmgnStatsByWallet.values()].reduce((sum, periods) => {
      const stats30d = periods.get('30d');
      const totalTrades30d = stats30d ? (stats30d.buyCount ?? 0) + (stats30d.sellCount ?? 0) : 0;
      return sum + (totalTrades30d / (30 * 24)) * staleDataAgeHours;
    }, 0)
    : null;
  const latestDuneFetchAt = copySimulationRunStatus?.finishedAt ?? copySimulationRunStatus?.persistedRun?.completedAt ?? null;
  const triageHasCurrentInputs = Boolean(eliminationReport && latestGmgnFetchAt && latestDuneFetchAt
    && Date.parse(latestGmgnFetchAt) <= Date.parse(eliminationReport.generatedAt)
    && Date.parse(latestDuneFetchAt) <= Date.parse(eliminationReport.generatedAt));
  const triageEliminatedWalletSet = new Set(skipEliminatedInDune && triageHasCurrentInputs && eliminationReport ? eliminationReport.eliminated.map((entry) => entry.walletAddress) : []);
  // Uses whichever copier-delay assumption the loaded Dune simulation actually used (falling
  // back to the same 15s default rendered elsewhere in this file), so this never disagrees with
  // the verdict's own `impossible` check computed from the same trades.
  const copierDelaySecondsForScope = copySimulation30d?.assumptions.copierDelaySeconds ?? copySimulation?.assumptions.copierDelaySeconds ?? 15;
  const uncopyableWalletSet = new Set(skipScopeFiltersInDune ? copyTradeRows
    .filter((row) => row.riskEvidence?.medianHoldSeconds !== null && row.riskEvidence?.medianHoldSeconds !== undefined && row.riskEvidence.medianHoldSeconds < copierDelaySecondsForScope)
    .map((row) => row.walletAddress) : []);
  // Seven guardrails built entirely from data the official GMGN API already returns on every
  // regular fetch (no new request, no blocked web-cookie endpoint). Shared with the backend via
  // assessWalletRiskGuardrails (src/copytrade/scrutiny/walletRiskGuardrails.ts) — see that
  // module's own comment for what each check is and why — so this UI toggle is no longer the
  // only place that knows these rules.
  const highRiskWalletReasons = new Map<string, string[]>();
  for (const row of copyTradeRows) {
    const stats30d = gmgnStatsByWallet.get(row.walletAddress)?.get('30d');
    if (!stats30d) continue;
    const reasons = assessWalletRiskGuardrails(stats30d);
    if (reasons.length > 0) highRiskWalletReasons.set(row.walletAddress, reasons);
  }
  const highRiskWalletSet = new Set(skipScopeFiltersInDune ? highRiskWalletReasons.keys() : []);
  const scopeFilteredWalletSet = new Set([...uncopyableWalletSet, ...highRiskWalletSet]);
  const excludedScreeningWalletSet = new Set(
    [...excludedScreeningWallets, ...triageEliminatedWalletSet, ...uncopyableWalletSet, ...highRiskWalletSet].filter((wallet) => !includedScreeningWalletSet.has(wallet)),
  );
  const skippedScreeningCount = visibleWalletScreenSummary?.activityLeaders.filter((entry) => excludedScreeningWalletSet.has(entry.wallet)).length ?? 0;
  const triageExcludedFromDuneCount = visibleWalletScreenSummary?.activityLeaders.filter((entry) => excludedScreeningWalletSet.has(entry.wallet) && triageEliminatedWalletSet.has(entry.wallet)).length ?? 0;
  const uncopyableExcludedFromDuneCount = visibleWalletScreenSummary?.activityLeaders.filter((entry) => excludedScreeningWalletSet.has(entry.wallet) && uncopyableWalletSet.has(entry.wallet)).length ?? uncopyableWalletSet.size;
  const researchWalletAddresses = (copyTradeRows.length > 0 ? copyTradeRows.filter((row) => !row.historyFailed).map((row) => row.walletAddress) : visibleWalletScreenSummary?.activityLeaders.map((entry) => entry.wallet) ?? []).filter((wallet) => !excludedScreeningWalletSet.has(wallet));
  const duneHistoryFailedCount = copyTradeRows.filter((row) => row.historyFailed).length;
  const duneManuallyExcludedCount = (copyTradeRows.length > 0 ? copyTradeRows.map((row) => row.walletAddress) : visibleWalletScreenSummary?.activityLeaders.map((entry) => entry.wallet) ?? []).filter((wallet) => excludedScreeningWalletSet.has(wallet)).length;
  const duneSelectionNote = [duneHistoryFailedCount > 0 ? `${duneHistoryFailedCount} history incomplete` : null, duneManuallyExcludedCount > 0 ? `${duneManuallyExcludedCount} excluded` : null].filter(Boolean).join(' · ');
  const activityWalletAddresses = visibleWalletScreenSummary?.activityLeaders.map((entry) => entry.wallet) ?? [];
  const toggleScreeningWallet = (wallet: string) => {
    if (excludedScreeningWalletSet.has(wallet)) {
      setExcludedScreeningWallets((current) => current.filter((entry) => entry !== wallet));
      setIncludedScreeningWallets((current) => current.includes(wallet) ? current : [...current, wallet]);
    } else {
      setIncludedScreeningWallets((current) => current.filter((entry) => entry !== wallet));
      setExcludedScreeningWallets((current) => current.includes(wallet) ? current : [...current, wallet]);
    }
  };
  const selectAllScreeningWallets = () => {
    setIncludedScreeningWallets(activityWalletAddresses);
    setExcludedScreeningWallets([]);
  };
  const deselectAllScreeningWallets = () => {
    setIncludedScreeningWallets([]);
    setExcludedScreeningWallets(activityWalletAddresses);
  };

  const fetchTop100GmgnHistoryAndWait = async (periodDays: number): Promise<CopyTradeFetchStatus> => {
    const response = await fetch('/api/copytrade/fetch', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 100, periodDays }),
    });
    const body = await response.json() as { error?: string };
    if (!response.ok && response.status !== 409) throw new Error(body.error ?? `GMGN history fetch failed (${response.status}).`);
    let status = await loadCopyTradeStatus();
    while (status?.running) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      status = await loadCopyTradeStatus();
    }
    if (!status) throw new Error('Could not read GMGN history fetch status.');
    if (status.status !== 'completed') throw new Error(status.message || `GMGN history fetch ${status.status}.`);
    return status;
  };
  useEffect(() => {
    // Older builds stored automatic >2,000-trade exclusions as permanent exclusions.
    // Migrate those once; from now on, automatic exclusions are derived defaults and a
    // user's explicit re-enable is stored separately and wins over the default.
    if (!visibleWalletScreenSummary || legacyHighActivityMigrationDone.current) return;
    legacyHighActivityMigrationDone.current = true;
    const highActivityWallets = new Set(visibleWalletScreenSummary.activityLeaders.filter((entry) => entry.trades > 2_000).map((entry) => entry.wallet));
    if (highActivityWallets.size > 0) setExcludedScreeningWallets((current) => current.filter((wallet) => !highActivityWallets.has(wallet)));
  }, [visibleWalletScreenSummary?.snapshotId]);
  const gmgnStatsValue = (row: CopyTradeRow): string | number | null => {
    const leaderboard = gmgnLeaderboardMetrics[row.walletAddress];
    const periods = gmgnStatsByWallet.get(row.walletAddress);
    const short = periods?.get('7d');
    const long = periods?.get('30d');
    if (gmgnStatsSort.key === 'name') return row.name?.trim() || row.walletAddress;
    const numeric = (value: unknown): number | null => { const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN; return Number.isFinite(parsed) ? parsed : null; };
    if (gmgnStatsSort.key === 'pnl1d') return numeric(leaderboard?.pnl1d);
    if (gmgnStatsSort.key === 'pnl7d') return numeric(leaderboard?.pnl7d);
    if (gmgnStatsSort.key === 'pnl30d') return numeric(leaderboard?.pnl30d);
    if (gmgnStatsSort.key === 'dailyProfit7d') return formatDailyProfit7d(leaderboard?.dailyProfit7d).total;
    if (gmgnStatsSort.key === 'win7d') return short?.winRatePercent ?? null;
    if (gmgnStatsSort.key === 'win30d') return long?.winRatePercent ?? null;
    if (gmgnStatsSort.key === 'activity') { const activity = long ?? short; return activity ? (activity.buyCount ?? 0) + (activity.sellCount ?? 0) : null; }
    if (gmgnStatsSort.key === 'equivalent') {
      const pnl30d = long?.realizedProfitPnlPercent ?? (numeric(leaderboard?.pnl30d) === null ? null : numeric(leaderboard?.pnl30d)! * 100);
      return pnl30d == null ? null : 100 * (1 + pnl30d / 100);
    }
    return long?.fetchedAt ? Date.parse(long.fetchedAt) : short?.fetchedAt ? Date.parse(short.fetchedAt) : null;
  };
  const sortedGmgnStatsRows = [...copyTradeRows].sort((left, right) => {
    const leftValue = gmgnStatsValue(left); const rightValue = gmgnStatsValue(right);
    const comparison = leftValue === null && rightValue === null ? left.walletAddress.localeCompare(right.walletAddress) : leftValue === null ? 1 : rightValue === null ? -1 : typeof leftValue === 'number' && typeof rightValue === 'number' ? leftValue - rightValue : String(leftValue).localeCompare(String(rightValue));
    return (gmgnStatsSort.direction === 'asc' ? 1 : -1) * comparison;
  });
    const copySimulationByWallet = new Map((copySimulation?.wallets ?? []).map((wallet) => [wallet.walletAddress, wallet]));
  const copySimulation30dByWallet = new Map((copySimulation30d?.wallets ?? []).map((wallet) => [wallet.walletAddress, wallet]));
  const copyDelayRows = sortedGmgnStatsRows.map((row) => {
    const tradeRow = copyTradeResults?.rows.find((candidate) => candidate.walletAddress === row.walletAddress);
    const statsPeriods = gmgnStatsByWallet.get(row.walletAddress);
    const stats7d = statsPeriods?.get('7d');
    const stats30d = statsPeriods?.get('30d');
    const totalTrades7d = stats7d ? (stats7d.buyCount ?? 0) + (stats7d.sellCount ?? 0) : null;
    const totalTrades30d = stats30d ? (stats30d.buyCount ?? 0) + (stats30d.sellCount ?? 0) : null;
    const hold = tradeRow?.riskEvidence?.medianHoldSeconds ?? null;
    const delay = copySimulation30d?.assumptions.copierDelaySeconds ?? copySimulation?.assumptions.copierDelaySeconds ?? 15;
    const delayShare = hold !== null && Number.isFinite(hold) && hold > 0 ? delay / hold * 100 : null;
    const sim7 = copySimulationByWallet.get(row.walletAddress);
    const sim30 = copySimulation30dByWallet.get(row.walletAddress);
    // Fail closed for the 30-day decision. A broader legacy simulation must never be paired
    // with 30-day GMGN statistics.
    const sim = sim30;
    // Keep the visible fraction and percentage tied to the same denominator. A stale or
    // differently scoped cached percentage must not disagree with the counts shown in Evidence.
    const evidenceCoverage = sim && sim.roundTripsConsidered > 0
      ? Math.round(sim.copiedTrades / sim.roundTripsConsidered * 1000) / 10 : null;
    const walletMedian = sim?.walletMedianReturnPercent;
    const simulatedMedian = sim?.simulatedMedianReturnPercent;
    const portfolioPnl = sim?.portfolio?.realizedPnlUsd ?? null;
    const edge = walletMedian != null && simulatedMedian != null && Number.isFinite(walletMedian) && Number.isFinite(simulatedMedian) && walletMedian > 0 ? simulatedMedian / walletMedian * 100 : null;
    const impossible = delayShare !== null && delayShare >= 100;
    const fragile = delayShare !== null && delayShare >= 25 && !impossible;
    const survivedDelay = portfolioPnl != null && Number.isFinite(portfolioPnl) && portfolioPnl > 0
      && sim?.gasCostComplete === true
      && (evidenceCoverage ?? 0) >= COPY_EVIDENCE_MIN_COVERAGE_PERCENT
      && (sim?.roundTripsConsidered ?? 0) >= COPY_EVIDENCE_MIN_ROUND_TRIPS;
    const hasQueriedNoMatch = sim?.trades.some((trade) => trade.status === 'missing_entry_match' || trade.status === 'missing_exit_match') ?? false;
    const hasNeverQueried = sim?.trades.some((trade) => trade.status === 'not_yet_queried') ?? false;
    const reading = hold === null ? 'No median hold data' : !sim ? 'Never queried' : sim.coverageStatus === 'missing_local_history' ? 'Missing local history' : sim.coverageStatus === 'no_dune_match' || (hasQueriedNoMatch && sim.copiedTrades === 0) ? 'Queried · no match' : hasNeverQueried ? 'Not queried yet' : sim.coverageStatus === 'small_sample' ? 'Small sample' : !sim.gasCostComplete ? 'Gas cost incomplete' : impossible ? 'Delay exceeds median hold' : fragile ? 'Delay is material' : survivedDelay ? 'Portfolio survived delay and costs' : 'Portfolio result is non-positive';
    return { row, name: row.name?.trim() || shortAddress(row.walletAddress), totalTrades7d, totalTrades30d, hold, delayShare, coverage: evidenceCoverage, coverage7d: sim7 ? { matched: sim7.copiedTrades, eligible: sim7.roundTripsConsidered, percent: sim7.roundTripsConsidered > 0 ? Math.round(sim7.copiedTrades / sim7.roundTripsConsidered * 1000) / 10 : null } : null, coverage30d: sim30 ? { matched: sim30.copiedTrades, eligible: sim30.roundTripsConsidered, percent: sim30.roundTripsConsidered > 0 ? Math.round(sim30.copiedTrades / sim30.roundTripsConsidered * 1000) / 10 : null } : null, edge, reading, survivedPnl: portfolioPnl, impossible, fragile, survivedDelay, sim, walletMedian };
  });
  const unifiedTraderRows = sortedGmgnStatsRows.map((row) => {
    const periods = gmgnStatsByWallet.get(row.walletAddress);
    const short = periods?.get('7d');
    const long = periods?.get('30d');
    const leaderboard = gmgnLeaderboardMetrics[row.walletAddress];
    const leaderboardPnl7d = typeof leaderboard?.pnl7d === 'number' ? leaderboard.pnl7d : typeof leaderboard?.pnl7d === 'string' && leaderboard.pnl7d.trim() !== '' ? Number(leaderboard.pnl7d) : NaN;
    const leaderboardPnl30d = typeof leaderboard?.pnl30d === 'number' ? leaderboard.pnl30d : typeof leaderboard?.pnl30d === 'string' && leaderboard.pnl30d.trim() !== '' ? Number(leaderboard.pnl30d) : NaN;
    const historical7d = short?.realizedProfitPnlPercent ?? (Number.isFinite(leaderboardPnl7d) ? leaderboardPnl7d * 100 : null);
    const historical30d = long?.realizedProfitPnlPercent ?? (Number.isFinite(leaderboardPnl30d) ? leaderboardPnl30d * 100 : null);
    const delay = copyDelayRows.find((entry) => entry.row.walletAddress === row.walletAddress) ?? null;
    const hasStats = Boolean(long);
    const coverage = delay?.coverage ?? null;
    const sample = delay?.sim?.roundTripsConsidered ?? 0;
    const enoughEvidence = coverage !== null && coverage >= COPY_EVIDENCE_MIN_COVERAGE_PERCENT
      && sample >= COPY_EVIDENCE_MIN_ROUND_TRIPS && delay?.sim?.gasCostComplete === true;
    const freshStats = Boolean(long?.fetchedAt && Date.now() - Date.parse(long.fetchedAt) >= 0 && Date.now() - Date.parse(long.fetchedAt) <= 24 * 60 * 60 * 1000);
    const duneEvidenceAt = copySimulationRunStatus?.finishedAt
      ?? copySimulationRunStatus?.persistedRun?.completedAt
      ?? copySimulation30d?.computedAt
      ?? null;
    const duneFresh = Boolean(duneEvidenceAt && Date.now() - Date.parse(duneEvidenceAt) >= 0 && Date.now() - Date.parse(duneEvidenceAt) <= 24 * 60 * 60 * 1000);
    const historyIncomplete = row.truncated === true || row.historyFailed === true || row.failedRules.includes('requested history window incomplete');
    // The 30-day decision may only use the exact 30-day GMGN statistic. Leaderboard PnL is
    // useful context, but it has a different provenance and must not make an old/missing 30d
    // statistic look current or positive.
    const historicalPositive = long?.realizedProfitPnlPercent !== null
      && long?.realizedProfitPnlPercent !== undefined
      && long.realizedProfitPnlPercent > 0;

    // Three gates added so "Passed all tests" can actually support the sentence a reader takes
    // from it — "this wallet consistently made money over the last 30 days". Before these, the
    // verdict only required the SUM to be positive, which an audit against live data showed was
    // materially weaker than it reads: of 28 passing wallets, 9 had a negative delayed-copy
    // median (their typical copied trade lost money and only a few large winners carried the
    // total), and 13 had at least one losing week.
    //
    // 1. Typical trade must profit, not just the total. Guards the median-vs-total divergence
    //    this project already has a standing rule about.
    const copyMedianPositive = delay?.sim?.simulatedMedianReturnPercent != null
      && delay.sim.simulatedMedianReturnPercent > 0;
    // 2. The wallet's earlier and recent halves must BOTH hold up — this is exactly what
    //    historicalConsistency already computes; it simply was never wired into this verdict.
    //    'insufficient' deliberately does not pass: unknown is not the same as consistent.
    //
    // historicalConsistency loads in the background (see the wallet-stats effect above) and,
    // measured live, a cold cache on this endpoint can take several minutes on a server that is
    // concurrently mid-fetch. Until the report has actually arrived, `historicalConsistencyByWallet`
    // is empty for every wallet — silently reading that as "not consistent" would make a
    // genuinely consistent wallet flash "Watch" for however long the load takes. `Needs data` is
    // the honest state for "not measured yet", exactly as `hasStats`/`enoughEvidence` already
    // treat their own not-yet-loaded evidence.
    const consistencyDataMissing = historicalConsistency === null;
    const consistencyVerdict = historicalConsistencyByWallet.get(row.walletAddress)?.verdict ?? null;
    const historicallyConsistent = consistencyVerdict === 'consistent';
    // 3. No losing week inside the window. Uses the wallet's own weekly medians, and requires at
    //    least MIN_CONSISTENT_WEEKS measured weeks so a wallet with one good week cannot pass by
    //    having no negative week to show.
    const measuredWeeks = (row.weeklyPerformance ?? []).filter((week) => week.trades > 0);
    const noLosingWeek = measuredWeeks.length >= MIN_CONSISTENT_WEEKS
      && measuredWeeks.every((week) => (week.medianReturnPercent ?? 0) > 0);
    const consistentlyProfitable = copyMedianPositive && historicallyConsistent && noLosingWeek;
    const decisionEvidence = {
      historyIncomplete,
      impossibleToCopy: delay?.impossible ?? false,
      hasGmgn30dStats: hasStats,
      enoughDuneEvidence: enoughEvidence,
      gmgnStatsFresh: freshStats,
      duneEvidenceFresh: duneFresh,
      gmgn30dPositive: historicalPositive,
      delayedCopySurvived: delay?.survivedDelay ?? false,
      delayedCopyMedianPositive: copyMedianPositive,
      consistentlyProfitable,
      consistencyDataMissing,
      historicalConsistency: consistencyVerdict,
      noLosingWeek: measuredWeeks.length >= MIN_CONSISTENT_WEEKS ? noLosingWeek : false,
      measuredWeeks: measuredWeeks.length,
      minimumMeasuredWeeks: MIN_CONSISTENT_WEEKS,
    } as const;
    const verdict = decideThirtyDayVerdict(decisionEvidence);
    const priority = thirtyDayDecisionPriority(verdict);
    const decisionReasons = explainThirtyDayDecision(decisionEvidence);
    return { row, name: row.name?.trim() || shortAddress(row.walletAddress), short, long, historical7d, historical30d, delay, coverage, sample, freshStats, duneFresh, duneEvidenceAt, historyIncomplete, verdict, priority, decisionReasons };
  });
  // Scrutiny mirrors the complete 30-day Wallet Stats population.
  useEffect(() => {
    if (copyTradeSubTab !== 'scrutiny' || !walletStatsReady || unifiedTraderRows.length === 0) return;
    const source = unifiedTraderRows.map((entry) => entry.row.walletAddress).slice(0, MAX_SCRUTINY_WALLETS_UI);
    setScrutinyPinned((current) => current.length === source.length && current.every((wallet, index) => wallet === source[index]) ? current : source);
  }, [copyTradeSubTab, walletStatsReady, unifiedTraderRows]);
  const decisionSortValue = (entry: typeof unifiedTraderRows[number]): string | number | null => {
    if (decisionSort.key === 'default') return entry.priority;
    if (decisionSort.key === 'rank') return entry.row.rankHistory.currentRank;
    if (decisionSort.key === 'name') return entry.name;
    if (decisionSort.key === 'verdict') return entry.verdict;
    if (decisionSort.key === 'gmgnPnl') return entry.long?.realizedProfit ?? entry.historical30d;
    // The table displays the delayed simulated median return in this column. Sort by that
    // same value; portfolio net P&L is a separate winner/ranking metric and must not make the
    // visible percentages appear out of order.
    if (decisionSort.key === 'copyResult') return entry.delay?.sim?.simulatedMedianReturnPercent ?? null;
    if (decisionSort.key === 'copyCapital') return entry.delay?.sim?.portfolio?.endingCapitalUsd ?? null;
    if (decisionSort.key === 'coverage') return entry.coverage;
    return entry.delay?.hold ?? null;
  };
  const sortedUnifiedTraderRows = [...unifiedTraderRows].sort((left, right) => {
    const leftValue = decisionSortValue(left); const rightValue = decisionSortValue(right);
    const comparison = leftValue === null && rightValue === null ? left.name.localeCompare(right.name) : leftValue === null ? 1 : rightValue === null ? -1 : typeof leftValue === 'number' && typeof rightValue === 'number' ? leftValue - rightValue : String(leftValue).localeCompare(String(rightValue));
    return (decisionSort.direction === 'asc' ? 1 : -1) * comparison || left.name.localeCompare(right.name);
  });
  const winnerRankedRows = [...unifiedTraderRows].sort((left, right) => {
    const priority = left.priority - right.priority;
    if (priority !== 0) return priority;
    const returnGap = (right.delay?.survivedPnl ?? Number.NEGATIVE_INFINITY) - (left.delay?.survivedPnl ?? Number.NEGATIVE_INFINITY);
    if (returnGap !== 0) return returnGap;
    const copyGap = (right.delay?.sim?.simulatedMeanReturnPercent ?? Number.NEGATIVE_INFINITY) - (left.delay?.sim?.simulatedMeanReturnPercent ?? Number.NEGATIVE_INFINITY);
    if (copyGap !== 0) return copyGap;
    const coverageGap = (right.coverage ?? Number.NEGATIVE_INFINITY) - (left.coverage ?? Number.NEGATIVE_INFINITY);
    if (coverageGap !== 0) return coverageGap;
    return (left.row.rankHistory.currentRank ?? Number.POSITIVE_INFINITY) - (right.row.rankHistory.currentRank ?? Number.POSITIVE_INFINITY) || left.name.localeCompare(right.name);
  });
  const unifiedVerdictCounts = unifiedTraderRows.reduce<Record<string, number>>((counts, entry) => { counts[entry.verdict] = (counts[entry.verdict] ?? 0) + 1; return counts; }, {});
  const researchVerdictChanges = researchUpdateSummary
    ? unifiedTraderRows.filter((entry) => researchUpdateSummary.beforeVerdictByWallet[entry.row.walletAddress] && researchUpdateSummary.beforeVerdictByWallet[entry.row.walletAddress] !== entry.verdict)
      .map((entry) => ({ name: entry.name, from: researchUpdateSummary.beforeVerdictByWallet[entry.row.walletAddress], to: entry.verdict }))
    : [];
  const walletStatsTableLoading = !walletStatsReady || (copyTradeLoading && !copyTradeResults) || researchUpdateBusy;
  const researchVerdictLabels = (counts: Record<string, number>) => Object.entries(counts).filter(([, count]) => count > 0).map(([label, count]) => `${count} ${label}`).join(' · ') || 'none';
  const primary30dWinner = winnerRankedRows.find((entry) => entry.verdict === 'Tested candidate') ?? null;
  const selectedCopyDelayEntry = selectedCopyDelayWallet
    ? copyDelayRows.find((entry) => entry.row.walletAddress === selectedCopyDelayWallet) ?? null
    : null;
  const copyDelaySortValue = (entry: typeof copyDelayRows[number]): string | number | null => {
    if (copyDelaySort.key === 'trader') return entry.name;
    if (copyDelaySort.key === 'totalTrades7d') return entry.totalTrades7d;
    if (copyDelaySort.key === 'totalTrades30d') return entry.totalTrades30d;
    if (copyDelaySort.key === 'medianHold') return entry.hold;
    if (copyDelaySort.key === 'delayShare') return entry.delayShare;
    if (copyDelaySort.key === 'edge') return entry.edge;
    return entry.reading;
  };
  const sortedCopyDelayRows = [...copyDelayRows].sort((left, right) => {
    const leftValue = copyDelaySortValue(left);
    const rightValue = copyDelaySortValue(right);
    let comparison = 0;
    if (leftValue === null && rightValue === null) comparison = left.row.walletAddress.localeCompare(right.row.walletAddress);
    else if (leftValue === null) comparison = 1;
    else if (rightValue === null) comparison = -1;
    else if (typeof leftValue === 'number' && typeof rightValue === 'number') comparison = leftValue - rightValue;
    else comparison = String(leftValue).localeCompare(String(rightValue));
    return (copyDelaySort.direction === 'asc' ? 1 : -1) * comparison;
  });
  const hasPositiveCopyGain = (entry: { delay?: { sim?: { portfolio?: { realizedPnlUsd?: number | null } | null } | null } | null }): boolean => {
    const pnl = entry.delay?.sim?.portfolio?.realizedPnlUsd;
    return pnl !== null && pnl !== undefined && Number.isFinite(pnl) && pnl > 0;
  };
  const hasPositiveCopyDelayGain = (entry: typeof copyDelayRows[number]): boolean => {
    const pnl = entry.sim?.portfolio?.realizedPnlUsd;
    return pnl !== null && pnl !== undefined && Number.isFinite(pnl) && pnl > 0;
  };
  const visibleDecisionRows = showDelaySurvivorsOnly
    ? sortedUnifiedTraderRows.filter(hasPositiveCopyGain)
    : sortedUnifiedTraderRows;
  const duneScopeWalletSet = new Set(researchWalletAddresses);
  const duneNeedsDataCount = unifiedTraderRows.filter((entry) => duneScopeWalletSet.has(entry.row.walletAddress) && decisionStateFor(entry.verdict) === 'needs_data').length;
  const duneNeedsDataWalletAddresses = unifiedTraderRows.filter((entry) => duneScopeWalletSet.has(entry.row.walletAddress) && decisionStateFor(entry.verdict) === 'needs_data').map((entry) => entry.row.walletAddress);
  const duneResultWalletSet = new Set((copySimulation?.wallets ?? []).map((wallet) => wallet.walletAddress));
  const duneResultCount = researchWalletAddresses.filter((wallet) => duneResultWalletSet.has(wallet)).length;
  const copyDelaySurvivorWallets = new Set(copyDelayRows.filter(hasPositiveCopyDelayGain).map((entry) => entry.row.walletAddress));
  const visibleGmgnStatsRows = showDelaySurvivorsOnly
    ? sortedGmgnStatsRows.filter((row) => copyDelaySurvivorWallets.has(row.walletAddress))
    : sortedGmgnStatsRows;
  const visibleCopyDelayRows = showDelaySurvivorsOnly
    ? sortedCopyDelayRows.filter(hasPositiveCopyDelayGain)
    : sortedCopyDelayRows;
  const copyDelayByWallet = new Map(copyDelayRows.map((entry) => [entry.row.walletAddress, entry]));
  const visibleCombinedStatsRows = visibleGmgnStatsRows.map((row) => ({ row, delay: copyDelayByWallet.get(row.walletAddress) ?? null }));
  // Drain every eligible wallet. Sort by the saved GMGN 7-day activity count so small
  // wallets finish first; unknown counts are retained at the end rather than silently dropped.
  const copyDelayDuneEligibleWallets = [...copyDelayRows]
    .sort((left, right) => (left.totalTrades7d ?? Number.POSITIVE_INFINITY) - (right.totalTrades7d ?? Number.POSITIVE_INFINITY))
    .map((entry) => entry.row.walletAddress);
  const wideRetryExhausted = copySimulationRunStatus?.mode === 'wide_retry'
    && !copySimulationRunStatus.running
    && copySimulationRunStatus.retryableTargetsRemaining === 0;
  const wideRetryRemaining = copySimulationRunStatus?.mode === 'wide_retry'
    ? copySimulationRunStatus.retryableTargetsRemaining
    : null;
  const toggleCopyDelaySort = (key: CopyDelaySortKey) => setCopyDelaySort((current) => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' }));
  const copyDelaySortIndicator = (key: CopyDelaySortKey) => copyDelaySort.key === key ? (copyDelaySort.direction === 'asc' ? ' ↑' : ' ↓') : '';
  const exportCopyDelayCsv = () => {
    if (visibleCopyDelayRows.length === 0) return;
    saveCsv(visibleCopyDelayRows.map((entry) => ({
      trader: entry.name,
      wallet_address: entry.row.walletAddress,
      gmgn_total_trades_7d: entry.totalTrades7d,
      gmgn_total_trades_30d: entry.totalTrades30d,
      median_hold_seconds: entry.hold,
      delay_share_percent: entry.delayShare,
      copy_coverage_percent: entry.coverage,
      edge_kept_percent: entry.edge,
      reading: entry.reading,
    })), `copy-delay-feasibility-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
  };
  const exportUnifiedTraderCsv = async () => {
    if (sortedUnifiedTraderRows.length === 0) return;
    setExportError(null);
    setExportBusy(true);
    try {
      const historyResults = await Promise.all(sortedUnifiedTraderRows.map(async (entry) => {
        try {
          return { entry, history: await api<CopyTradeHistoryResponse>(`/api/copytrade/trades/${encodeURIComponent(entry.row.walletAddress)}`), error: null };
        } catch (error: unknown) {
          return { entry, history: null, error: error instanceof Error ? error.message : String(error) };
        }
      }));
      const failedHistory = historyResults.filter((result) => result.error !== null);
      if (failedHistory.length > 0) {
        const sample = failedHistory.slice(0, 3).map(({ entry, error }) => `${entry.row.walletAddress.slice(0, 6)}…: ${error}`).join(' · ');
        throw new Error(`Export stopped: stored trade history failed for ${failedHistory.length} wallet${failedHistory.length === 1 ? '' : 's'}; no partial CSV was created. ${sample}`);
      }
      const exportedRows = historyResults.map(({ entry, history }) => {
        const sells = history?.rows.filter((trade) => trade.eventType.toLowerCase().startsWith('sell')) ?? [];
        const holds = history ? holdingSecondsBySellId(history.rows) : new Map<number, number>();
        const tags = entry.row.gmgnTags ?? entry.row.riskFlags;
        const evidenceLabel = entry.delay?.sim ? `${entry.delay.sim.copiedTrades.toLocaleString()} / ${entry.delay.sim.roundTripsConsidered.toLocaleString()}` : 'Not measured';
        const gmgnRawPayloads = Object.fromEntries(gmgnStatsRecords.filter((record) => record.walletAddress === entry.row.walletAddress).map((record) => [record.period, { fetched_at: record.fetchedAt, raw_payload: record.rawPayload }]));
        const tooltipContext = {
          decision: entry.decisionReasons.join(' '),
          data_freshness: `GMGN 30d stats: ${entry.long?.fetchedAt ? formatFetchTime(entry.long.fetchedAt) : 'not available'}. Dune 30d simulation: ${entry.duneEvidenceAt ? formatFetchTime(entry.duneEvidenceAt) : 'not available'}. Both must be current for a candidate verdict.`,
          gmgn_pnl: 'GMGN-reported 30-day realized profit before delay, fees, slippage, or Dune matching.',
          copy_median: 'Median simulated return per copied trade after the configured copy delay, fees, and slippage. The portfolio P&L compounds the full trade path and can be much larger.',
          copy_capital: 'Cash-constrained simulated ending value from a $100 starting portfolio after delay, fees, slippage, and gas.',
          evidence: `Dune price matches: ${evidenceLabel} copied trades divided by eligible round trips. ${entry.coverage === null || entry.coverage === undefined ? 'Coverage percentage is not available.' : `${entry.coverage.toFixed(0)}% usable prices.`}`,
          typical_hold: `Median time this trader holds a position. Evidence is ${entry.freshStats ? 'fresh' : 'older than 24 hours'}.`,
          gmgn_under_15_seconds: 'GMGN-derived percentage of completed buy/sell pairs held for 15 seconds or less. Only pairs with both timestamps are counted; incomplete or truncated history is not included.',
          gmgn_tags: Object.fromEntries(tags.map((tag) => [tag, gmgnTagInfo(tag).text])),
          dialog: {
            after_copy_path: 'Simulated cash balance after each completed copied trade using the configured delay, fees, slippage, gas, stake, and position limit.',
            trade_reconciliation: 'The chart contains the simulated trade path; the stored history table contains locally saved sell rows. Missing rows indicate that the two views cannot be fully reconciled.',
            stored_sell_history: 'Only stored sell rows are shown because they close positions and provide the realized result. Buy rows are used for matching but are not displayed in this table.',
            outcome_distribution: 'GMGN-reported counts of positions by result, showing whether gains come from many small wins or a few large ones.',
            flow_and_costs: 'Gross amounts and fees reported by GMGN for the selected period. These describe the trader, not the delayed-copy result.',
          },
        };
        const sellHistory = sells.map((trade) => ({
          id: trade.id, observed_timestamp: trade.observedTimestamp, token_address: trade.tokenAddress,
          token_symbol: trade.tokenSymbol, hold_seconds: holds.get(trade.id) ?? null,
          realized_return_percent: tradeReturnPercent(trade.eventType, trade.costUsd, trade.buyCostUsd),
          transaction: trade.txHash,
        }));
        return {
          trader: entry.name,
          wallet_address: entry.row.walletAddress,
          icon_url: entry.row.iconUrl ?? null,
          wallet_row_json: JSON.stringify(entry.row),
          verdict: entry.verdict,
          decision_snapshot_json: JSON.stringify({ verdict: entry.verdict, reasons: entry.decisionReasons, delay: entry.delay ?? null, dune_evidence_at: entry.duneEvidenceAt ?? null }),
          gmgn_7d_return_percent: entry.historical7d,
          gmgn_30d_context_percent: entry.historical30d,
          gmgn_7d_json: entry.short ? JSON.stringify(entry.short) : null,
          gmgn_30d_json: entry.long ? JSON.stringify(entry.long) : null,
          gmgn_raw_payloads_json: JSON.stringify(gmgnRawPayloads),
          risk_evidence_json: entry.row.riskEvidence ? JSON.stringify(entry.row.riskEvidence) : null,
          gmgn_tags: (entry.row.gmgnTags ?? entry.row.riskFlags).join(', '),
          copy_evidence_json: entry.delay?.sim ? JSON.stringify(entry.delay.sim) : null,
          dune_matched_round_trips: entry.delay?.sim?.copiedTrades ?? null,
          dune_round_trips_considered: entry.delay?.sim?.roundTripsConsidered ?? null,
          dune_coverage_percent: entry.coverage,
          median_hold_seconds: entry.delay?.hold,
          gmgn_under_15_seconds_percent: entry.row.riskEvidence?.under15SecondsPercent ?? null,
          gmgn_under_15_seconds_pairs: entry.row.riskEvidence ? `${entry.row.riskEvidence.under15SecondsCount}/${entry.row.riskEvidence.pairedTradeCount}` : null,
          evidence_fresh_within_24h: entry.freshStats,
          tooltip_context_json: JSON.stringify(tooltipContext),
          decision_reasons: entry.decisionReasons.join(' | '),
          dialog_data_json: JSON.stringify({
            rank_history: entry.row.rankHistory,
            decision_reasons: entry.decisionReasons,
            gmgn_7d: entry.short,
            gmgn_30d: entry.long,
            gmgn_tags: tags,
            risk_evidence: entry.row.riskEvidence,
            copy_simulation: entry.delay?.sim ?? null,
            portfolio: entry.delay?.sim?.portfolio ?? null,
            trade_path: entry.delay?.sim?.portfolio?.tradeCapitalPath ?? entry.delay?.sim?.portfolio?.capitalPath ?? null,
            history_coverage: history?.coverage ?? null,
          }),
          stored_trade_history_count: history?.rows.length ?? 0,
          stored_history_chain: history?.chain ?? null,
          stored_history_total: history?.total ?? null,
          stored_trade_history_json: history ? JSON.stringify(history.rows) : null,
          stored_sell_history_json: JSON.stringify(sellHistory),
          stored_history_coverage_json: history?.coverage ? JSON.stringify(history.coverage) : null,
        };
      });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const compactRows = exportedRows.map(({ wallet_row_json, decision_snapshot_json, gmgn_7d_json, gmgn_30d_json, gmgn_raw_payloads_json, risk_evidence_json, copy_evidence_json, dialog_data_json, stored_trade_history_json, stored_sell_history_json, stored_history_coverage_json, ...row }) => row);
      const parseExportJson = (value: unknown): unknown => {
        if (typeof value !== 'string' || value === '') return null;
        try { return JSON.parse(value); } catch { return value; }
      };
      const fullDetails = exportedRows.map((row) => ({
        wallet: parseExportJson(row.wallet_row_json),
        table: compactRows.find((compactRow) => compactRow.wallet_address === row.wallet_address) ?? null,
        gmgn_raw_payloads: parseExportJson(row.gmgn_raw_payloads_json),
        copy_simulation: parseExportJson(row.copy_evidence_json),
        dialog_context: parseExportJson(row.dialog_data_json),
        tooltip_context: parseExportJson(row.tooltip_context_json),
        stored_history: parseExportJson(row.stored_trade_history_json),
        stored_history_coverage: parseExportJson(row.stored_history_coverage_json),
      }));
      await saveCompressedJson({ format: 'vantage-crypto-full-export-v2', generated_at: new Date().toISOString(), wallets: fullDetails }, `copytrade-full-details-${timestamp}.json.gz`);
      saveCsv(compactRows, `copytrade-table-${timestamp}.csv`);
    } catch (error: unknown) {
      setExportError(error instanceof Error ? error.message : String(error));
    } finally { setExportBusy(false); }
  };
  const delayExample = sortedGmgnStatsRows.map((row) => {
    const holdSeconds = row.riskEvidence?.medianHoldSeconds ?? null;
    const delaySeconds = copySimulation?.assumptions.copierDelaySeconds ?? 15;
    return {
      row,
      holdSeconds,
      delaySeconds,
      delayShare: holdSeconds !== null && Number.isFinite(holdSeconds) && holdSeconds > 0 ? (delaySeconds / holdSeconds) * 100 : null,
      walletAgeDays: row.riskEvidence?.walletAgeDays ?? null,
    };
  }).find((example) => example.holdSeconds !== null) ?? null;
  const toggleGmgnStatsSort = (key: GmgnStatsSortKey) => setGmgnStatsSort((current) => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' }));
  const gmgnStatsSortIndicator = (key: GmgnStatsSortKey) => gmgnStatsSort.key === key ? (gmgnStatsSort.direction === 'asc' ? ' ↑' : ' ↓') : '';
  const gmgnStatsRowsWithData = copyTradeRows.filter((row) => gmgnLeaderboardMetrics[row.walletAddress] || gmgnStatsByWallet.has(row.walletAddress)).length;
  const gmgnStatsFreshRows = copyTradeRows.filter((row) => {
    const periods = gmgnStatsByWallet.get(row.walletAddress);
    const fetched = periods?.get('30d')?.fetchedAt ?? periods?.get('7d')?.fetchedAt;
    return fetched ? Date.now() - Date.parse(fetched) < 24 * 60 * 60 * 1000 : false;
  }).length;
  const exportGmgnAggregateCsv = () => {
    if (!copyTradeResults || sortedCopyTradeRows.length === 0) return;
    const rows: Array<Record<string, unknown>> = sortedGmgnAggregateRows.map((row) => {
      const stats = row.gmgnAggregate;
      const traderName = row.name?.trim() || shortAddress(row.walletAddress);
      return {
        model: 'gmgn_reported_aggregate',
        starting_capital_usd: 100,
        gmgn_period: stats?.period ?? null,
        fetched_at: stats?.fetchedAt ?? null,
        trader_name: traderName,
        wallet_address: row.walletAddress,
        realized_profit: stats?.realizedProfit ?? null,
        realized_profit_pnl_percent: stats?.realizedProfitPnlPercent ?? null,
        hundred_dollar_equivalent: stats?.realizedProfitPnlPercent === null || stats?.realizedProfitPnlPercent === undefined ? null : 100 * (1 + stats.realizedProfitPnlPercent / 100),
        win_rate_percent: stats?.winRatePercent ?? null,
        buy_count: stats?.buyCount ?? null,
        sell_count: stats?.sellCount ?? null,
        token_count: stats?.tokenCount ?? null,
        native_balance: stats?.nativeBalance ?? null,
        bought_cost: stats?.boughtCost ?? null,
        sold_income: stats?.soldIncome ?? null,
        bought_fee: stats?.boughtFee ?? null,
        sold_fee: stats?.soldFee ?? null,
        average_holding_period_seconds: stats?.averageHoldingPeriodSeconds ?? null,
      };
    });
    saveCsv(rows, `copytrade-gmgn-aggregate-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
  };

  const loadGmgnStats = async (limitOverride = copyTradeLimit, snapshotOverride = selectedRosterSnapshotId) => {
    setGmgnStatsLoading(true);
    try {
      const query = `?limit=${limitOverride}${snapshotOverride ? `&snapshotId=${snapshotOverride}` : ''}`;
      const result = await api<{ stats: GmgnStatsRecord[]; leaderboard: Record<string, GmgnLeaderboardMetric> }>(`/api/copytrade/stats${query}`);
      setGmgnStatsRecords(result.stats);
      setGmgnLeaderboardMetrics(result.leaderboard ?? {});
      setGmgnStatsStatus(await api<GmgnStatsFetchStatus>('/api/copytrade/stats/status'));
      return result;
    } catch (error: unknown) { setCopyTradeError(error instanceof Error ? error.message : String(error)); }
    finally { setGmgnStatsLoading(false); }
    return null;
  };

  function buildWalletScreenSummary(records: GmgnStatsRecord[], walletCount: number): WalletScreenSummary {
    const periodRows = records.filter((record) => record.period === '30d');
    const aggregateRows = periodRows.map(parseAggregateRecord).filter((row): row is GmgnAggregateStats => row !== null);
    const fastWallets = aggregateRows.filter((row) => row.averageHoldingPeriodSeconds !== null && row.averageHoldingPeriodSeconds < 60).length;
    const activityLeaders = periodRows.map((record) => ({ record, aggregate: parseAggregateRecord(record) })).filter((row): row is { record: GmgnStatsRecord; aggregate: GmgnAggregateStats } => row.aggregate !== null).map(({ record, aggregate }) => { const trader = copyTradeRows.find((row) => row.walletAddress === record.walletAddress); return { wallet: record.walletAddress, name: trader?.name ?? null, trades: (aggregate.buyCount ?? 0) + (aggregate.sellCount ?? 0), rank: trader?.rankHistory.currentRank ?? null, netProfit: aggregate.realizedProfit, averageHoldSeconds: aggregate.averageHoldingPeriodSeconds }; }).sort((left, right) => right.trades - left.trades);
    const lastFetchedAt = periodRows.map((row) => row.fetchedAt).sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
    return { completedAt: new Date().toISOString(), snapshotId: selectedRosterSnapshotId, walletCount, statsWalletCount: aggregateRows.length, fastWallets, notFastWallets: Math.max(0, aggregateRows.length - fastWallets), missingStatsWallets: Math.max(0, walletCount - aggregateRows.length), totalTrades: activityLeaders.reduce((sum, row) => sum + row.trades, 0), maxTrades: activityLeaders[0]?.trades ?? 0, maxTradesWallet: activityLeaders[0]?.wallet ?? null, activityLeaders, periodDays: 30, averageHoldThresholdSeconds: 60, lastFetchedAt };
  }

  const startGmgnStatsFetch = async (limitOverride = copyTradeLimit, snapshotOverride = selectedRosterSnapshotId): Promise<boolean> => {
    setGmgnStatsBusy(true);
    try {
      const body = await api<GmgnStatsFetchStatus>('/api/copytrade/stats/fetch', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ limit: limitOverride, snapshotId: snapshotOverride ?? undefined, periods: ['7d', '30d'], maxAgeHours: 24 }),
      });
      setGmgnStatsStatus(body);
      return true;
    } catch (error: unknown) { setCopyTradeError(error instanceof Error ? error.message : String(error)); return false; }
    finally { setGmgnStatsBusy(false); }
  };

  const waitForGmgnStats = async () => {
    let status = await api<GmgnStatsFetchStatus>('/api/copytrade/stats/status');
    while (status.running) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      status = await api<GmgnStatsFetchStatus>('/api/copytrade/stats/status');
      setGmgnStatsStatus(status);
      await loadGmgnStats();
    }
    setGmgnStatsStatus(status);
    return status;
  };

  const stopGmgnStatsFetch = async () => {
    try { setGmgnStatsStatus(await api<GmgnStatsFetchStatus>('/api/copytrade/stats/stop', { method: 'POST' })); }
    catch (error: unknown) { setCopyTradeError(error instanceof Error ? error.message : String(error)); }
  };

  const syncLatestWalletRoster = async (useSavedSnapshot = false): Promise<{ snapshotId: number | null; walletCount: number; added: number; alreadyPresent: number } | null> => {
    setRosterSyncBusy(true);
    setRosterRefreshMessage('Contacting GMGN for the current top 100…');
    setRosterRefreshError(null);
    setCopyTradeError(null);
    try {
      const result = await api<{ snapshotId: number | null; added?: number; alreadyPresent?: number; total?: number; walletCount?: number; inserted?: boolean; live?: boolean; fallbackReason?: string; capturedAt?: string; joinedWallets?: string[]; leftWallets?: string[]; roster?: { snapshotId: number | null; added: number; alreadyPresent: number; total: number }; researchFilter?: { orderby: string; minWinrate30d: number } }>('/api/copytrade/roster/refresh', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limit: 100, useSavedSnapshot }),
      });
      setCopyTradeLimit(100);
      // The response contains two different IDs: snapshotId is the raw GMGN leaderboard
      // capture, while roster.snapshotId is the copytrade_wallets snapshot used by stats and
      // Dune selection. Mixing them makes the saved stats appear empty and disables step 2.
      const rosterSnapshotId = result.roster?.snapshotId ?? null;
      if (rosterSnapshotId !== null) setSelectedRosterSnapshotId(rosterSnapshotId);
      setRosterChange({ joinedWallets: result.live ? (result.joinedWallets ?? []) : [], leftWallets: result.live ? (result.leftWallets ?? []) : [], live: result.live === true, capturedAt: result.capturedAt ?? null });
      const refreshMessage = result.snapshotId === null
        ? 'GMGN returned no usable wallet leaderboard; no roster was changed.'
        : result.live === false
          ? `Used approved saved snapshot ${result.snapshotId} from ${result.capturedAt ? formatTime(result.capturedAt) : 'the latest capture'}: ${result.walletCount ?? result.roster?.total ?? result.total ?? 0} wallets. No old data was overwritten.`
          : `Success: GMGN top ${result.walletCount ?? result.roster?.total ?? result.total ?? 0} saved as snapshot ${result.snapshotId}. ${result.roster?.added ?? result.added ?? 0} new wallet${(result.roster?.added ?? result.added ?? 0) === 1 ? '' : 's'} · ${result.roster?.alreadyPresent ?? result.alreadyPresent ?? 0} already known. Older snapshots were kept.`;
      setRosterRefreshMessage(refreshMessage);
      setMessage(refreshMessage);
      await loadCopyTradePage();
      await loadGmgnStats();
      return {
        snapshotId: rosterSnapshotId,
        walletCount: result.walletCount ?? result.roster?.total ?? result.total ?? 0,
        added: result.roster?.added ?? result.added ?? 0,
        alreadyPresent: result.roster?.alreadyPresent ?? result.alreadyPresent ?? 0,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!useSavedSnapshot && window.confirm(`Live GMGN top-100 fetch failed. Read the latest saved local snapshot instead?\n\nThis will not fetch new wallets.`)) {
        return syncLatestWalletRoster(true);
      }
      setRosterRefreshError(`Refresh failed: ${errorMessage}. The previous roster was left unchanged.`);
      setRosterRefreshMessage(null);
      setCopyTradeError(errorMessage);
      return null;
    }
    finally { setRosterSyncBusy(false); }
  };

  const openRosterComparison = async () => {
    setRosterComparisonLoading(true);
    try {
      setRosterComparison(await api<RosterComparison>('/api/copytrade/roster/compare'));
      setRosterComparisonOpen(true);
    } catch (error: unknown) { setCopyTradeError(error instanceof Error ? error.message : String(error)); }
    finally { setRosterComparisonLoading(false); }
  };

  const screenTopWallets = async () => {
    if (researchUpdateBusy) return;
    setResearchUpdateBusy(true);
    setCopyTradeError(null);
    try {
      setResearchUpdateStage('Refreshing the top 100 GMGN roster…');
      setWalletScreenSummary(null);
      const rosterResult = await syncLatestWalletRoster();
      if (!rosterResult) throw new Error('GMGN roster refresh failed.');
      setResearchUpdateStage('Fetching complete GMGN trade history for all 100 wallets…');
      const historyStatus = await fetchTop100GmgnHistoryAndWait(30);
      if (historyStatus.status !== 'completed') {
        setResearchUpdateStage(`GMGN history ${historyStatus.status}. Saved progress is retained; resume it when ready.`);
        return;
      }
      if ((historyStatus.failedWallets ?? 0) > 0) setMessage(`${historyStatus.failedWallets} GMGN wallet fetches failed and were skipped; they are marked as failed.`);
      setResearchUpdateStage('Fetching 7-day and 30-day GMGN summaries…');
      const statsStatus = await api<GmgnStatsFetchStatus>('/api/copytrade/stats/status');
      if (!statsStatus.running && !(await startGmgnStatsFetch(100, rosterResult.snapshotId))) throw new Error('GMGN summary fetch could not be started.');
      const completedStats = await waitForGmgnStats();
      if (completedStats.status === 'failed') throw new Error(completedStats.error ?? `GMGN summary fetch ${completedStats.status}.`);
      const statsResult = await loadGmgnStats(100, rosterResult.snapshotId);
      const periodRows = (statsResult?.stats ?? []).filter((record) => record.period === '30d');
      const aggregateRows = periodRows.map(parseAggregateRecord).filter((row): row is GmgnAggregateStats => row !== null);
      const fastWallets = aggregateRows.filter((row) => row.averageHoldingPeriodSeconds !== null && row.averageHoldingPeriodSeconds < 60).length;
      const missingStatsWallets = Math.max(0, rosterResult.walletCount - aggregateRows.length);
      const totalTrades = aggregateRows.reduce((sum, row) => sum + (row.buyCount ?? 0) + (row.sellCount ?? 0), 0);
      const activityRows = periodRows.map((record) => ({ record, aggregate: parseAggregateRecord(record) })).filter((row): row is { record: GmgnStatsRecord; aggregate: GmgnAggregateStats } => row.aggregate !== null).map(({ record, aggregate }) => { const trader = copyTradeRows.find((row) => row.walletAddress === record.walletAddress); return { wallet: record.walletAddress, name: trader?.name ?? null, trades: (aggregate.buyCount ?? 0) + (aggregate.sellCount ?? 0), rank: trader?.rankHistory.currentRank ?? null, netProfit: aggregate.realizedProfit, averageHoldSeconds: aggregate.averageHoldingPeriodSeconds }; }).sort((left, right) => right.trades - left.trades);
      const summary: WalletScreenSummary = { ...buildWalletScreenSummary(statsResult?.stats ?? [], rosterResult.walletCount), completedAt: new Date().toISOString(), snapshotId: rosterResult.snapshotId, totalTrades, maxTrades: activityRows[0]?.trades ?? 0, maxTradesWallet: activityRows[0]?.wallet ?? null, activityLeaders: activityRows, missingStatsWallets };
      setWalletScreenSummary(summary);
      setResearchUpdateStage('Screening complete. Review the counts, then approve Dune research.');
      setMessage(`Screened ${summary.statsWalletCount} wallets: ${summary.notFastWallets} not fast, ${summary.fastWallets} fast, ${summary.totalTrades.toLocaleString()} 30-day trades. Highest activity: ${summary.maxTrades.toLocaleString()}.`);
      await loadCopyTradePage();
      await loadGmgnStats(100, rosterResult.snapshotId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setCopyTradeError(message);
      setResearchUpdateStage(`Screening stopped: ${message}`);
    } finally { setResearchUpdateBusy(false); }
  };

  const approveAndResearch = async () => {
    if (researchUpdateBusy || !visibleWalletScreenSummary) return;
    if (researchUpdateBusy) return;
    const screeningSummary = visibleWalletScreenSummary;
    let approvedWalletAddresses = duneNeedsDataWalletAddresses;
    // A triage result is only a hint. Before spending Dune budget, refresh it from
    // the backend when its GMGN/Dune inputs are no longer current (including changes made in
    // another browser session), then derive the actual fetch list from that fresh report.
    if (skipEliminatedInDune && eliminationReport?.eliminated.length && !triageHasCurrentInputs) {
      const freshTriage = await loadElimination(screeningSummary.snapshotId ?? selectedRosterSnapshotId);
      if (!freshTriage) return;
      const freshEliminated = new Set(freshTriage.eliminated.map((entry) => entry.walletAddress));
      const manuallyExcluded = new Set(excludedScreeningWallets);
      const manuallyIncluded = new Set(includedScreeningWallets);
      const allWallets = duneNeedsDataWalletAddresses;
      approvedWalletAddresses = allWallets.filter((wallet) => !manuallyExcluded.has(wallet)
        && (!freshEliminated.has(wallet) || manuallyIncluded.has(wallet)));
    }
    if (approvedWalletAddresses.length === 0) {
      setCopyTradeError('All screened wallets are excluded. Re-enable at least one candidate before researching.');
      return;
    }
    setResearchUpdateBusy(true);
    setResearchUpdateFailedStage(null);
    setCopyTradeError(null);
    let currentResearchStage = -1;
    try {
      currentResearchStage = 0;
      setResearchUpdateStage('Fetching missing Dune prices…');
      const beforeVerdictByWallet = Object.fromEntries(unifiedTraderRows.map((entry) => [entry.row.walletAddress, entry.verdict]));
      const beforeVerdicts = { ...unifiedVerdictCounts };
      const beforeRows = copyTradeRows.length;
      const beforeStatsRows = gmgnStatsRowsWithData;
      const beforeMatched = duneMatchedTargets;
      setResearchUpdateSummary(null);
      const duneResult = await runCopySimulationBatch(approvedWalletAddresses, 30, false, screeningSummary.snapshotId ?? selectedRosterSnapshotId);
      currentResearchStage = 1;
      setResearchUpdateStage('Refreshing the decision table…');
      await loadCopyTradePage();
      await loadGmgnStats();
      // Refresh the exact approved wallet scope so the decision table immediately reflects
      // the Dune results just stored; omitting walletAddresses would fall back to the server's
      // narrower default candidate scope and leave many rows showing “Not measured”.
      await loadCopySimulation(screeningSummary.snapshotId ?? selectedRosterSnapshotId, approvedWalletAddresses, 30);
      setResearchUpdateSummary({
        completedAt: new Date().toISOString(), rosterSnapshotId: screeningSummary.snapshotId,
        rosterWalletCount: screeningSummary.walletCount, rosterAdded: 0,
        rosterAlreadyPresent: screeningSummary.walletCount, statsStatus: 'completed',
        statsWalletDone: screeningSummary.statsWalletCount, statsWalletTotal: screeningSummary.walletCount,
        statsRequests: 0, statsReused: screeningSummary.statsWalletCount,
        duneSubmitted: duneResult?.targetsSubmitted ?? 0, duneBatches: duneResult?.batchesRun ?? 0,
        duneExhausted: duneResult?.exhausted ?? false, beforeRows, beforeStatsRows, beforeMatched,
        beforeVerdicts, beforeVerdictByWallet, leaderboardOrderby: 'pnl_30d', leaderboardMinWinrate30d: 0.5,
      });
      setMessage('Research update complete. Saved evidence was reused; only missing or stale work was requested.');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setCopyTradeError(message);
      setResearchUpdateFailedStage(currentResearchStage >= 0 ? currentResearchStage : null);
      setResearchUpdateStage(`Update stopped: ${message}`);
    } finally {
      setResearchUpdateBusy(false);
    }
  };

  const toggleCopyTradeSort = (key: CopyTradeSortKey) => setCopyTradeSort((current) => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' }));
  const copyTradeSortIndicator = (key: CopyTradeSortKey) => copyTradeSort.key === key ? (copyTradeSort.direction === 'asc' ? ' ↑' : ' ↓') : '';
  const toggleDecisionSort = (key: Exclude<DecisionSortKey, 'default'>) => setDecisionSort((current) => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' }));
  const decisionSortIndicator = (key: Exclude<DecisionSortKey, 'default'>) => decisionSort.key === key ? (decisionSort.direction === 'asc' ? ' ↑' : ' ↓') : '';
  const toggleDecisionColumn = (key: DecisionColumnKey) => setDecisionColumns((current) => {
    const next = { ...current, [key]: !current[key] };
    try { localStorage.setItem(decisionColumnsStorageKey, JSON.stringify(next)); } catch { /* preference is optional */ }
    return next;
  });
  const medianAverageConflicts = copyTradeRows.filter((row) => row.medianReturnPercent !== null && row.averageReturnPercent !== null && Math.sign(row.medianReturnPercent) !== Math.sign(row.averageReturnPercent));
  const winnerSimulationWallets = copySimulation && copyWinners
    ? copySimulation.wallets.filter((wallet) => copyWinners.candidates.some((candidate) => candidate.walletAddress === wallet.walletAddress))
    : [];
  const currentDuneBatch = copySimulationRunStatus?.batches.find((batch) => batch.status === 'running')
    ?? copySimulationRunStatus?.batches.at(-1)
    ?? null;
  // All Dune evidence counters come from the backend's canonical leg-level snapshot (never
  // reconstructed from round-trip rows, since one round trip contains two legs — see each
  // wallet's own pendingDuneTargets/duneNoMatchTargets/duneMatchedTargets comment). But the
  // report-level totals (copySimulation.pendingDuneTargets etc.) are summed over whatever wallet
  // set the report was originally requested for — typically the full roster, not the currently
  // in-scope "needs more evidence" set the Fetch button actually targets. Re-summing the
  // per-wallet fields over exactly duneNeedsDataWalletAddresses keeps this number equal to what
  // the button will actually submit, the same way duneNeedsDataCount already scopes the wallet
  // count.
  const duneNeedsDataWalletSet = new Set(duneNeedsDataWalletAddresses);
  const unifiedTraderRowByWallet = new Map(unifiedTraderRows.map((entry) => [entry.row.walletAddress, entry]));
  const scopedCopySimulationWallets = (copySimulation?.wallets ?? []).filter((wallet) => duneNeedsDataWalletSet.has(wallet.walletAddress));
  const sumWalletTargetField = (key: 'pendingDuneTargets' | 'duneNoMatchTargets' | 'duneMatchedTargets'): number =>
    scopedCopySimulationWallets.reduce((total, wallet) => total + (wallet[key] ?? 0), 0);
  const duneMatchedTargets = sumWalletTargetField('duneMatchedTargets');
  const preciseTargetsRemaining = copySimulation ? sumWalletTargetField('pendingDuneTargets') : null;
  const widerRetryCandidates = copySimulation ? sumWalletTargetField('duneNoMatchTargets') : null;
  const duneHasNewTargets = preciseTargetsRemaining === null || preciseTargetsRemaining > 0;
  const duneRunActive = researchUpdateBusy || copySimulationRunStatus?.running === true;
  const copyTradeProgressPercent = copyTradeStatus?.totalTradeProgressPercent ?? (copyTradeStatus && (copyTradeStatus.walletTotal ?? 0) > 0 ? Math.min(100, (copyTradeStatus.walletDone ?? 0) / (copyTradeStatus.walletTotal ?? 1) * 100) : null);
  const rosterFetchStatus = copyTradeStatus?.scope === 'roster' ? copyTradeStatus : null;
  const rosterProgressPercent = rosterFetchStatus?.totalTradeProgressPercent ?? (rosterFetchStatus?.walletTotal ? Math.min(100, (rosterFetchStatus.walletDone ?? 0) / rosterFetchStatus.walletTotal * 100) : null);
  const copyTradeProcessedRows = copyTradeStatus
    ? (copyTradeStatus.tradesFetched ?? 0) + (copyTradeStatus.tradesDuplicate ?? 0) + (copyTradeStatus.tradesDailyCapped ?? 0)
    : 0;
  const signalRoutes = new Set(['imports', 'capture', 'dune-capture', 'patterns']);
  const signalMenuActive = signalRoutes.has(activeMenu);
  const navigateSignal = () => navigateTo('dune-capture');
  const researchStageIndex = researchUpdateStage?.startsWith('Refreshing the top 100') ? 0
    : researchUpdateStage?.startsWith('Fetching complete GMGN trade history') ? 1
      : researchUpdateStage?.startsWith('Fetching 7-day') ? 2
        : researchUpdateStage?.startsWith('Fetching missing Dune') ? 3
          : researchUpdateStage?.startsWith('Refreshing the decision') ? 4 : -1;
  const researchStepState = (index: number): 'done' | 'active' | 'waiting' | 'failed' => {
    if (researchUpdateFailedStage !== null) return index < researchUpdateFailedStage ? 'done' : index === researchUpdateFailedStage ? 'failed' : 'waiting';
    if (!researchUpdateBusy && !researchUpdateStage?.startsWith('Update stopped:')) return 'done';
    return index < researchStageIndex ? 'done' : index === researchStageIndex ? 'active' : 'waiting';
  };
  const researchStepDetail = (index: number, state: ReturnType<typeof researchStepState>): string => {
    if (state === 'failed') return 'Failed; saved work was retained.';
    if (index === 0) return state === 'done' ? 'Roster saved.' : state === 'active' ? 'Refreshing the top 100 roster…' : 'Waiting to select the roster.';
    if (index === 1) {
      if (copyTradeStatus?.running) return `${copyTradeStatus.walletDone ?? 0} / ${copyTradeStatus.walletTotal ?? 100} wallets · ${copyTradeStatus.tradesFetched ?? 0} new trades · ${copyTradeStatus.requestsMade ?? 0} requests`;
      if (state === 'done') return `${copyTradeStatus?.walletDone ?? copyTradeStatus?.walletTotal ?? 0} wallets complete · saved in SQLite.`;
      return state === 'active' ? 'Starting the GMGN history fetch…' : 'Waiting for the roster step.';
    }
    if (index === 2) {
      if (gmgnStatsStatus?.running) return `${gmgnStatsStatus.walletDone} / ${gmgnStatsStatus.walletTotal} wallets · ${gmgnStatsStatus.requestsMade} requests`;
      if (state === 'done') return `Complete · ${gmgnStatsStatus?.skippedFresh ?? 0} saved summaries reused.`;
      return state === 'active' ? 'Starting the GMGN summary fetch…' : 'Waiting for GMGN history.';
    }
    if (index === 3) {
      if (copySimulationRunStatus?.running) return `${copySimulationRunStatus.targetsProcessed} / ${copySimulationRunStatus.targetsTotal} Dune targets · ${copySimulationRunStatus.remainingTargets} remaining`;
      if (state === 'done') return `Complete · ${copySimulationRunStatus?.storedTargets ?? 0} targets stored.`;
      return state === 'active' ? 'Starting the Dune fetch…' : 'Waiting for approval and GMGN summaries.';
    }
    return state === 'done' ? 'Decision table refreshed.' : state === 'active' ? 'Recomputing decisions from saved evidence…' : 'Waiting for Dune results.';
  };
  return <main className={`shell routed-view page-${activeMenu} ${WALLET_STATS_ONLY ? 'wallet-stats-only' : ''} ${WALLET_STATS_ONLY && copyTradeSubTab === 'scrutiny' ? 'lightweight-scrutiny' : ''} ${WALLET_STATS_ONLY && copyTradeSubTab === 'pattern-discovery' ? 'lightweight-pattern-discovery' : ''}`}>
    <header className="hero">
      <div>
        <p className="eyebrow">GMGN / DUNE · BACKTEST</p>
        <h1>GMGN/Dune Backtest</h1>
        <p className="lede">Find promising Solana wallets by comparing GMGN performance with realistic delayed-copy backtests.</p>
      </div>
      <div className="status-pill"><span className="dot" /> SQLite connected</div>
    </header>

    <nav className="section-nav" aria-label="CopyTrade sections">
      <button className={`nav-button ${copyTradeSubTab === 'wallet-stats' ? 'active' : ''}`} onClick={() => navigateCopyTradeSubTab('wallet-stats')}>CopyTrade · GMGN wallet stats</button>
      <button className={`nav-button ${copyTradeSubTab === 'pattern-discovery' ? 'active' : ''}`} onClick={() => navigateCopyTradeSubTab('pattern-discovery')}>CopyTrade · Pattern Discovery</button>
      <button className={`nav-button ${copyTradeSubTab === 'scrutiny' ? 'active' : ''}`} onClick={() => navigateCopyTradeSubTab('scrutiny')}>CopyTrade · Scrutiny</button>
    </nav>
    {!WALLET_STATS_ONLY && signalMenuActive && <nav className="subsection-nav" aria-label="Signal workspace">
      <span className="subsection-label">Signal</span>
      <button className={`nav-button ${activeMenu === 'imports' ? 'active' : ''}`} onClick={() => navigateTo('imports')}>Imports</button>
      <button className={`nav-button ${activeMenu === 'capture' ? 'active' : ''}`} onClick={() => navigateTo('capture')}>GMGN Capture</button>
      <button className={`nav-button ${activeMenu === 'dune-capture' ? 'active' : ''}`} onClick={() => navigateTo('dune-capture')}>Dune Capture</button>
      <button className={`nav-button ${activeMenu === 'patterns' ? 'active' : ''}`} onClick={() => navigateTo('patterns')}>Patterns</button>
    </nav>}

    <section id="overview" className="menu-section">
    <ol className="workflow-strip">
      <li className={stats.tokenCount > 0 ? 'done' : 'active'}><span>1</span><div><strong>Import a Dune cohort</strong><small>{stats.tokenCount > 0 ? `${stats.tokenCount.toLocaleString()} tokens stored` : 'Not started'}</small></div></li>
      <li className={gmgnStatus?.configured ? (stats.gmgnSignalCount > 0 ? 'done' : 'active') : ''}><span>2</span><div><strong>Capture GMGN signals</strong><small>{stats.gmgnSignalCount > 0 ? `${stats.gmgnSignalCount.toLocaleString()} signals captured` : 'Import a browser export, fetch once, or start watching'}</small></div></li>
      <li><span>3</span><div><strong>Review evidence &amp; diagnostics</strong><small>Archives, coverage, activity, and logs below</small></div></li>
    </ol>

    <section className="stats-grid">
      <article className="stat-card"><span>Tokens</span><strong>{stats.tokenCount.toLocaleString()}</strong><small>unique addresses</small></article>
      <article className="stat-card"><span>GMGN signals</span><strong>{stats.gmgnSignalCount.toLocaleString()}</strong><small>raw observations</small></article>
      <article className="stat-card"><span>First trade range</span><strong>{formatTime(stats.tokenFirstTrade.earliest)}</strong><small>to {formatTime(stats.tokenFirstTrade.latest)}</small></article>
      <article className="stat-card"><span>Observed range</span><strong>{formatTime(stats.gmgnObserved.earliest)}</strong><small>to {formatTime(stats.gmgnObserved.latest)}</small></article>
    </section>
    </section>

    <section id="imports" className="menu-section work-grid">
      <article className="panel upload-panel">
        <div className="panel-heading"><div><p className="eyebrow">01 · DUNE COHORT</p><h2>Import historical tokens</h2></div><span className="tag">CSV / JSON</span></div>
        <p>Choose an export from your computer. Duplicate files and token addresses are safely skipped; malformed rows remain in the audit log.</p>
        <div className="credential-status">
          <span className={`status-dot ${duneBusyFile ? '' : stats.tokenCount > 0 ? 'good' : ''}`} />
          <div>
            <strong>{duneBusyFile ? `Saving ${duneBusyFile}…` : `${stats.tokenCount.toLocaleString()} token${stats.tokenCount === 1 ? '' : 's'} stored in SQLite`}</strong>
            <small>{lastDuneImport
              ? `Last import "${lastDuneImport.fileName}": +${lastDuneImport.result.imported} imported · ${lastDuneImport.result.skipped} skipped · ${lastDuneImport.result.errors} errors · ${lastDuneImport.result.duplicateFile ? 'duplicate file, already archived' : lastDuneImport.result.archivePath ? 'archived to ZIP' : 'archive pending'} · ${formatTime(lastDuneImport.at)}`
              : 'Persists in SQLite across refreshes and restarts — import each export only once.'}</small>
          </div>
        </div>
        {measurementPlan && prescreenCounts && <small className="import-detail-line prescreen-audit-line">Current GMGN pre-screen: {prescreenCounts.eligible_core + prescreenCounts.eligible_audit} of {prescreenTotal} signal rows selected for the next Dune pass ({prescreenPercent(prescreenCounts.eligible_core + prescreenCounts.eligible_audit)}). This cohort import changes the reference data only; it does not send a Dune request.</small>}
        <label className={`dropzone ${busy ? 'disabled' : ''}`}>
          <input type="file" accept=".csv,.json,application/json,text/csv" disabled={busy} onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importDune(file);
            event.currentTarget.value = '';
          }} />
          <span className="upload-icon">↑</span><strong>Choose a Dune export</strong><small>Nothing leaves this machine</small>
        </label>
      </article>

      <article className="panel signal-panel">
        <div className="panel-heading"><div><p className="eyebrow">MANUAL OVERRIDE</p><h2>Paste a raw observation</h2></div><span className="tag">JSON</span></div>
        <p>Optional: paste one captured event by hand instead of using automated capture below. The normalized fields are only a convenience; the complete payload is always retained.</p>
        <textarea value={gmgnPayload} onChange={(event) => setGmgnPayload(event.target.value)} spellCheck={false} />
        <button className="primary" disabled={busy} onClick={() => void captureGmgn()}>Save GMGN observation</button>
      </article>

      <article className="panel upload-panel">
        <div className="panel-heading"><div><p className="eyebrow">TARGETED ENRICHMENT</p><h2>Look up GMGN tokens in Dune</h2></div><span className="tag">CSV / JSON</span></div>
        <p>Most GMGN signals land on tokens the Dune cohort export never covered. Export the addresses GMGN has actually observed, look them up in Dune yourself, then upload the result here — it's stored separately from the original cohort and never overwrites an address already on file.</p>
        <div className="watch-controls">
          <button className="secondary" disabled={exportingAddresses} onClick={() => void exportGmgnTokenAddresses()}>{exportingAddresses ? 'Exporting…' : 'Export addresses (.txt)'}</button>
          <button className="secondary" disabled={generatingQuery} onClick={() => void generateDuneQuery()}>{generatingQuery ? 'Generating…' : 'Generate Dune query'}</button>
        </div>
        {duneQuery && (
          <div className="dune-query-block">
            <textarea readOnly value={duneQuery} spellCheck={false} onFocus={(event) => event.currentTarget.select()} />
            <button className="primary" onClick={() => void copyDuneQuery()}>Copy query</button>
          </div>
        )}
        <div className="credential-status">
          <span className={`status-dot ${enrichmentBusy ? '' : lastEnrichmentImport ? 'good' : ''}`} />
          <div>
            <strong>{enrichmentBusy ? 'Importing enrichment…' : lastEnrichmentImport ? `Last enrichment: ${lastEnrichmentImport.fileName}` : 'No enrichment imported this session'}</strong>
            <small>{lastEnrichmentImport
              ? `+${lastEnrichmentImport.result.imported} imported · ${lastEnrichmentImport.result.skipped} already on file · ${lastEnrichmentImport.result.errors} errors · ${formatTime(lastEnrichmentImport.at)}`
              : 'Same audit trail and archive as a cohort import, tagged dune-targeted-enrichment.'}</small>
          </div>
        </div>
        {lastEnrichmentImport && <small className="import-detail-line prescreen-audit-line">This targeted lookup enriches stored cohort metadata only; it does not automatically capture outcomes. Use Dune Capture to send the pre-screened queue.</small>}
        <label className={`dropzone ${enrichmentBusy ? 'disabled' : ''}`}>
          <input type="file" accept=".csv,.json,application/json,text/csv" disabled={enrichmentBusy} onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importDuneEnrichment(file);
            event.currentTarget.value = '';
          }} />
          <span className="upload-icon">↑</span><strong>Choose a Dune lookup result</strong><small>Nothing leaves this machine</small>
        </label>
      </article>
    </section>

    <section id="capture" className="menu-section panel browser-import-panel">
      <div className="panel-heading"><div><p className="eyebrow">GMGN BROWSER CAPTURE</p><h2>Import website signal evidence</h2></div><span className="tag">JSON EXPORT</span></div>
      <p>Upload an export produced by the authorized GMGN browser capture extension. Events are tagged <code>gmgn-browser-extension</code>, stored through the same append-only signal path, and the complete upload is archived with a manifest. This does not scrape or infer anything.</p>
      <div className="credential-status">
        <span className={`status-dot ${browserImportBusy ? '' : lastBrowserImport ? 'good' : ''}`} />
        <div><strong>{browserImportBusy ? 'Importing browser capture…' : lastBrowserImport ? `Last upload: ${lastBrowserImport.fileName}` : 'No browser capture imported this session'}</strong>
          {!lastBrowserImport && <small>The raw JSON remains available for later audit and replay.</small>}</div>
      </div>
      {lastBrowserImport && (lastBrowserImport.result.duplicateFile
        ? <p className="import-duplicate-banner">This exact file was already imported before — nothing new was added and nothing was re-fetched. Safe to re-upload an old export by mistake.</p>
        : <>
            <div className="quality-grid import-result-grid">
              <div className="quality-metric import-metric-new"><strong>{lastBrowserImport.result.imported}</strong><span>new signals added</span></div>
              <div className="quality-metric import-metric-skip"><strong>{lastBrowserImport.result.skipped}</strong><span>already captured — skipped</span></div>
              <div className={`quality-metric ${lastBrowserImport.result.errors > 0 ? 'import-metric-issue' : ''}`}><strong>{lastBrowserImport.result.errors}</strong><span>issue rows</span></div>
            </div>
            <small className="import-detail-line">{lastBrowserImport.result.otherCaptures} other endpoint capture(s) archived (not parsed) · {lastBrowserImport.result.coverageWindowsImported} coverage window(s) · ZIP archived · {formatTime(lastBrowserImport.at)}</small>
            {(() => { const r = lastBrowserImport.result.rawEndpoints; const total = r.radar.imported + r.radar.skipped + r.walletRank.imported + r.walletRank.skipped + r.smartMoney.imported + r.smartMoney.skipped + r.twitter.imported + r.twitter.skipped;
              return total > 0 ? <small className="import-detail-line">Raw endpoints this upload: {r.radar.imported + r.radar.skipped} radar · {r.walletRank.imported + r.walletRank.skipped} wallet-rank · {r.smartMoney.imported + r.smartMoney.skipped} smart-money · {r.twitter.imported + r.twitter.skipped} twitter</small> : null; })()}
          </>)}
      {lastBrowserImport && Object.keys(lastBrowserImport.result.issueBreakdown).length > 0 && <small className="import-issue-detail">Issue details: {Object.entries(lastBrowserImport.result.issueBreakdown).map(([issue, count]) => `${issue} (${count})`).join(' · ')}</small>}
      {measurementPlan && prescreenCounts && <p className="import-detail-line prescreen-audit-line"><strong>Pre-screen after import:</strong> {prescreenCounts.eligible_core + prescreenCounts.eligible_audit} selected ({prescreenPercent(prescreenCounts.eligible_core + prescreenCounts.eligible_audit)}) for Dune · {prescreenCounts.deferred_repeat + prescreenCounts.deferred_budget} deferred ({prescreenPercent(prescreenCounts.deferred_repeat + prescreenCounts.deferred_budget)}) · {prescreenCounts.too_fresh ?? 0} waiting for the {measurementPlan.prescreen.minSignalAgeHours}h buffer ({prescreenPercent(prescreenCounts.too_fresh ?? 0)}) · {prescreenCounts.invalid_for_query} invalid ({prescreenPercent(prescreenCounts.invalid_for_query)}) · {prescreenCounts.already_measured} already measured ({prescreenPercent(prescreenCounts.already_measured)}). Deferred repeats are later token/type observations; deferred budget rows are valid but outside the current {measurementPlan.prescreen.maxSignalIds}-signal pass budget.</p>}
      <label className={`dropzone ${browserImportBusy ? 'disabled' : ''}`}><input type="file" accept=".json,application/json" multiple disabled={browserImportBusy} onChange={(event) => { const files = Array.from(event.target.files ?? []); if (files.length) void importBrowserCaptures(files); event.currentTarget.value = ''; }} /><span className="upload-icon">↑</span><strong>Choose browser capture exports</strong><small>Select one or more JSON files; each is processed and archived separately.</small></label>
    </section>

    <section id="capture-raw-endpoints" className="menu-section panel raw-endpoint-panel">
      <Collapsible className="signal-legend raw-endpoint-details" open={rawEndpointOpen} onToggle={(open) => { if (open !== rawEndpointOpen) void openRawEndpointSection(); }} summary="Raw endpoint captures (radar / wallet rank / smart money / Twitter)">
        <p className="muted">Exploratory raw data captured alongside signals — GMGN&apos;s own trending-token radar, its public wallet leaderboard, per-wallet smart-money stats, and KOL/Twitter activity. Purely descriptive: nothing here is scored, ranked, or linked to captured signals.</p>
        {rawEndpointSummary && <div className="quality-grid raw-endpoint-summary-grid">
          <button type="button" className={`quality-metric raw-endpoint-tile ${rawEndpointType === 'radar' ? 'active' : ''}`} onClick={() => { setRawEndpointType('radar'); void loadRawEndpointDetails('radar'); }}><strong>{rawEndpointSummary.radar.count}</strong><span>radar snapshots</span><small>latest {formatTime(rawEndpointSummary.radar.latestCapturedAt)}</small></button>
          <button type="button" className={`quality-metric raw-endpoint-tile ${rawEndpointType === 'wallet-rank' ? 'active' : ''}`} onClick={() => { setRawEndpointType('wallet-rank'); void loadRawEndpointDetails('wallet-rank'); }}><strong>{rawEndpointSummary.walletRank.count}</strong><span>wallet rank snapshots</span><small>latest {formatTime(rawEndpointSummary.walletRank.latestCapturedAt)}</small></button>
          <button type="button" className={`quality-metric raw-endpoint-tile ${rawEndpointType === 'smart-money' ? 'active' : ''}`} onClick={() => { setRawEndpointType('smart-money'); void loadRawEndpointDetails('smart-money'); }}><strong>{rawEndpointSummary.smartMoney.count}</strong><span>smart-money observations</span><small>latest {formatTime(rawEndpointSummary.smartMoney.latestCapturedAt)}</small></button>
          <button type="button" className={`quality-metric raw-endpoint-tile ${rawEndpointType === 'twitter' ? 'active' : ''}`} onClick={() => { setRawEndpointType('twitter'); void loadRawEndpointDetails('twitter'); }}><strong>{rawEndpointSummary.twitter.count}</strong><span>Twitter messages</span><small>latest {formatTime(rawEndpointSummary.twitter.latestCapturedAt)}</small></button>
        </div>}
        {rawEndpointBusy && <p className="muted">Loading…</p>}
        {!rawEndpointBusy && rawEndpointRows.length === 0 && <p className="muted">No {rawEndpointType.replace('-', ' ')} captures stored yet.</p>}
        {!rawEndpointBusy && rawEndpointRows.length > 0 && <div className="table-wrap raw-endpoint-table"><table><thead><tr>
          {rawEndpointType === 'radar' && <><th>Chain</th><th>Period</th><th>Category</th></>}
          {rawEndpointType === 'wallet-rank' && <><th>Window</th><th>Order by</th></>}
          {rawEndpointType === 'smart-money' && <><th>Wallet</th><th>Chain</th></>}
          {rawEndpointType === 'twitter' && <><th>Tweet type</th><th>Has token</th></>}
          <th>Captured</th><th></th>
        </tr></thead><tbody>{rawEndpointRows.map((row) => <Fragment key={row.id}>
          <tr>
            {rawEndpointType === 'radar' && 'category' in row && <><td>{row.chain ?? '—'}</td><td>{row.period ?? '—'}</td><td>{row.category ?? '—'}</td></>}
            {rawEndpointType === 'wallet-rank' && 'window' in row && <><td>{row.window ?? '—'}</td><td>{row.orderby ?? '—'}</td></>}
            {rawEndpointType === 'smart-money' && 'walletAddress' in row && <><td><span className="address-compact" title={row.walletAddress}>{row.walletAddress}</span><CopyAddressButton address={row.walletAddress} /><SaveRowButton row={row} filename={`smart-money-${row.id}.json`} /></td><td>{row.chain ?? '—'}</td></>}
            {rawEndpointType === 'twitter' && 'twType' in row && <><td>{row.twType ?? '—'}</td><td>{row.hasToken === null ? '—' : row.hasToken ? 'yes' : 'no'}</td></>}
            <td>{formatTime(row.capturedAt)}</td>
            <td><button className="secondary" onClick={() => setRawEndpointExpandedId(rawEndpointExpandedId === row.id ? null : row.id)}>{rawEndpointExpandedId === row.id ? 'Hide raw' : 'Show raw'}</button></td>
          </tr>
          {rawEndpointExpandedId === row.id && <tr className="raw-endpoint-json-row"><td colSpan={4}><pre>{JSON.stringify(row.rawPayload, null, 2)}</pre></td></tr>}
        </Fragment>)}</tbody></table></div>}
      </Collapsible>
    </section>

    <section id="analysis" className="menu-section panel snapshot-analysis-panel">
      <div className="panel-heading"><div><p className="eyebrow">DESCRIPTIVE ANALYSIS</p><h2>Captured-signal snapshot</h2></div><span className="tag">NO SCORING</span></div>
      <p>This summarizes what is currently in the database. It describes the snapshot only; it does not decide whether any signal is good or bad.</p>
      {analysis && <>
        <div className="quality-grid">
          <div className="quality-metric"><strong>{analysis.signals.total}</strong><span>signals captured</span><small>{analysis.signals.uniqueTokens} unique tokens</small></div>
          <div className="quality-metric"><strong>{analysis.cohortOverlap.matchedSignals}</strong><span>signals matched to Dune</span><small>{analysis.cohortOverlap.unmatchedSignals} unmatched</small></div>
          <div className="quality-metric"><strong>{analysis.marketCap.median === null ? '—' : `$${Math.round(analysis.marketCap.median).toLocaleString()}`}</strong><span>median signal market cap</span><small>{analysis.marketCap.count} records with market cap</small></div>
          <div className="quality-metric"><strong>{analysis.signals.multiSignalTokens}</strong><span>tokens with multiple signals</span><small>max {analysis.signals.maxSignalsPerToken} per token</small></div>
        </div>
        <div className="analysis-columns">
          <div><h3>Signal types</h3>{analysis.signalTypes.map((item) => <div className="analysis-row" key={item.signalType}><span>Type {item.signalType}</span><b>{item.count}</b></div>)}</div>
          <div><h3>Sources</h3>{analysis.sources.map((item) => <div className="analysis-row" key={item.source}><span>{item.source}</span><b>{item.count}</b></div>)}<h3>Timing</h3><p className="analysis-note">Observed: {formatTime(analysis.timing.earliestObservedAt)} → {formatTime(analysis.timing.latestObservedAt)}<br />Captured: {formatTime(analysis.timing.earliestCapturedAt)} → {formatTime(analysis.timing.latestCapturedAt)}</p></div>
        </div>
        <p className="analysis-limitations"><strong>Interpretation limits:</strong> {analysis.limitations.join(' ')}</p>
      </>}
    </section>

    <section id="scoring" className="menu-section panel scoring-panel">
      <div className="panel-heading"><div><p className="eyebrow">EXPLORATORY SCORING</p><h2>Signal data-readiness score</h2></div><span className="tag">PROVISIONAL</span></div>
      <p>This is the first transparent scoring experiment. It scores how much supporting data we have for each signal—not whether the signal made money.</p>
      {scoring && <>
        <div className="quality-grid"><div className="quality-metric"><strong>{scoring.averageScore}/8</strong><span>average readiness</span><small>{scoring.totalSignals} signals scored</small></div><div className="quality-metric"><strong>{scoring.scoreDistribution.find((item) => item.score === 8)?.count ?? 0}</strong><span>fully documented</span><small>all eight checks passed</small></div></div>
        <div className="score-legend"><span>Points: Dune match (2) · first-trade time · DEX · transaction · signal time · time order · market cap</span></div>
        <div className="table-wrap"><table><thead><tr><th>Signal</th><th>Type</th><th>Score</th><th>Dune</th><th>Evidence</th></tr></thead><tbody>{scoring.rows.slice(0, 25).map((row) => <tr key={row.signalId}><td><strong>#{row.signalId}</strong><small>{row.tokenAddress ?? 'missing address'}</small></td><td>{row.signalType ?? '—'}</td><td><span className="count-good">{row.score}/{row.maxScore}</span></td><td>{row.matchedDuneToken ? 'Matched' : 'Unmatched'}</td><td><small>{[row.firstTradeKnown && 'trade time', row.firstDexKnown && 'DEX', row.firstTxKnown && 'tx', row.temporalOrderValid && 'time order', row.marketCapKnown && 'market cap'].filter(Boolean).join(' · ') || 'No supporting fields'}</small></td></tr>)}</tbody></table></div>
        <p className="analysis-limitations"><strong>Important:</strong> {scoring.limitations.join(' ')}</p>
      </>}
    </section>

    <section id="dune-capture" className="menu-section panel signal-outcome-batch-panel">
      <section className="outcome-inner">
      <div className="panel-heading"><div><p className="eyebrow">DUNE SIGNAL OUTCOME TIMELINE</p><h2>Measure captured GMGN signals</h2></div><span className="tag">DUNE PRICE HISTORY</span></div>
      <div className={`dune-activity ${duneActivity ? 'is-active' : 'is-idle'}`} role="status" aria-live="polite"><span className="activity-spinner" aria-hidden="true"></span><span>{duneActivityLabel}</span>{outcomeBatchProgress && outcomeBatchBusy && <small>{outcomeBatchProgress.completed}/{outcomeBatchProgress.total} signals · batch {Math.min(outcomeBatchProgress.current + 1, outcomeBatchProgress.batches)}/{outcomeBatchProgress.batches}</small>}</div>
      <Collapsible className="signal-legend" summary="Signal-type legend"><div className="signal-legend-grid">{Object.keys(SIGNAL_TYPE_LABELS).map((code) => <div key={code}><b>{code} · {SIGNAL_TYPE_LABELS[code]}</b><small>{SIGNAL_TYPE_DESCRIPTIONS[code]}</small></div>)}</div><small>Names and high-level meanings are from GMGNAI’s official gmgn-skills CLI documentation. GMGN does not publish every wallet-classification, amount, count, or time-window threshold here, so these labels are observations—not quality or profitability verdicts.</small></Collapsible>
       <label className="select-all-row"><span>Signal type</span><select value={outcomeTypeFilter} onChange={(event) => setOutcomeTypeFilter(event.target.value)}><option value="all">All types</option>{outcomeTypeOptions.map((type) => <option key={type} value={type}>{type} · {formatSignalType(type)}</option>)}</select><small>{filteredOutcomeCandidates.length} captured signal{filteredOutcomeCandidates.length === 1 ? '' : 's'} in this filter</small></label>
       <p>Choose a signal type, then measure all matching signals. The app submits Dune-safe batches, skips complete outcomes, and retries only signals that are eligible for another measurement.</p>
      <div className="outcome-actions">
         {outcomeBatchBusy && <button className="secondary stop-measurement" onClick={stopOutcomeBatch} title="Finish the current batch, then stop submitting new Dune batches.">Stop after current batch</button>}
         <div className="measurement-queues">
          <div className="measurement-queue-grid">
           <div className="measurement-queue queue-new"><strong>{selectedMeasurementProgress?.newReady ?? 0}</strong><span>new signals ready</span><small>Never measured. Selected for the next safe Dune pass: {selectedMeasurementProgress?.newEligible ?? 0}.</small><button className="secondary" disabled={outcomeBusy || outcomeBatchBusy || (selectedMeasurementProgress?.newEligible ?? 0) === 0} onClick={() => void measureAllOutcomes('new')}>{outcomeBatchBusy ? 'Measuring…' : `Measure new (${selectedMeasurementProgress?.newEligible ?? 0})`}</button></div>
           <div className="measurement-queue queue-retry"><strong>{selectedMeasurementProgress?.retryReady ?? 0}</strong><span>ready to re-fetch</span><small>Earlier data was incomplete or unavailable, and its retry delay has elapsed ({selectedMeasurementProgress?.neverMaturelyAttempted ?? 0} of these get their first fair post-buffer check). Screened retry queue: {selectedMeasurementProgress?.retryEligibleSelected ?? 0}. Requests are sent in small batches.</small><button className="secondary" disabled={outcomeBusy || outcomeBatchBusy || (selectedMeasurementProgress?.retryEligibleSelected ?? 0) === 0} onClick={() => void measureAllOutcomes('retry')}>{outcomeBatchBusy ? 'Re-fetching…' : `Re-fetch matured (${selectedMeasurementProgress?.retryEligibleSelected ?? 0})`}</button></div>
           <div className="measurement-queue queue-wait"><strong>{(selectedMeasurementProgress?.pending ?? 0) + (selectedMeasurementProgress?.tooFresh ?? 0) + (selectedMeasurementProgress?.waitingOnRetryBuffer ?? 0)}</strong><span>waiting — nothing to do yet</span><small>{selectedMeasurementProgress?.pending ?? 0} waiting on a checkpoint time · {selectedMeasurementProgress?.tooFresh ?? 0} never measured, still inside the {measurementPlan?.prescreen.minSignalAgeHours ?? 24}h buffer · {selectedMeasurementProgress?.waitingOnRetryBuffer ?? 0} already measured, waiting to turn {measurementPlan?.prescreen.minSignalAgeHours ?? 24}h old or for its retry delay before another attempt. All move into the queues above automatically; nothing runs on its own.</small></div>
          </div>
         </div>
         {selectedMeasurementProgress && selectedMeasurementProgress.inFlight > 0 && <button className="secondary" disabled={reconcileBusy || outcomeBatchBusy} onClick={() => void reconcileStuckRuns()} title="Checks stuck Dune runs against Dune's real current state and finalizes any that have actually finished, without re-submitting them.">{reconcileBusy ? 'Reconciling…' : `Reconcile ${selectedMeasurementProgress.inFlight} in-flight signal${selectedMeasurementProgress.inFlight === 1 ? '' : 's'}`}</button>}
       </div>
      {measurementPlan && prescreenCounts && <Collapsible className="measurement-explanation" summary={<>How this Dune pass works <small>{prescreenTotal} stored signals reviewed; nothing was deleted</small></>}>
        <p className="muted">The app sends only the next safe batch to Dune. Everything else stays in SQLite and can be reconsidered later.</p>
        <p className="measurement-plan-note"><strong>Why these signals are in or out of this Dune pass</strong> · {prescreenTotal} stored candidates evaluated; nothing was deleted.</p>
        <div className="prescreen-breakdown-grid">
          <div><b>{prescreenCounts.eligible_core + prescreenCounts.eligible_audit} selected ({prescreenPercent(prescreenCounts.eligible_core + prescreenCounts.eligible_audit)})</b><small>Core = first token/type observation; audit = deterministic sample of deferred rows.</small></div>
          <div><b>{prescreenCounts.deferred_repeat} deferred repeats ({prescreenPercent(prescreenCounts.deferred_repeat)})</b><small>Later observation of a token/type whose lifetime-first row is already the research unit.</small></div>
          <div><b>{prescreenCounts.deferred_budget} deferred by budget ({prescreenPercent(prescreenCounts.deferred_budget)})</b><small>Valid lifetime-first rows waiting because this pass allows {measurementPlan.prescreen.maxSignalIds} total requests.</small></div>
          <div><b>{prescreenCounts.too_fresh ?? 0} waiting for {measurementPlan.prescreen.minSignalAgeHours}h buffer ({prescreenPercent(prescreenCounts.too_fresh ?? 0)})</b><small>Never measured; younger than the required observation buffer before its first Dune request. Not a rejection — it will become eligible automatically once old enough.</small></div>
          <div><b>{prescreenCounts.already_measured} already measured ({prescreenPercent(prescreenCounts.already_measured)})</b><small>Has a completed/pending/in-flight/retry-protected Dune outcome; it is not submitted again now.</small></div>
          <div><b>{prescreenCounts.invalid_for_query} invalid ({prescreenPercent(prescreenCounts.invalid_for_query)})</b><small>Missing required token address, signal type, UTC observation time, or capture date.</small></div>
        </div>
      </Collapsible>}
      {measurementPlan && selectedMeasurementProgress && <>
        <p className="measurement-summary">
          <span className="status-good">{selectedMeasurementProgress.measured}</span> complete outcomes · <span className={selectedMeasurementProgress.retryEligibleSelected > 0 ? 'status-warn' : ''}>{selectedMeasurementProgress.retryEligibleSelected}</span> ready to re-fetch · <span className={selectedMeasurementProgress.unmeasured > 0 ? 'status-warn' : ''}>{selectedMeasurementProgress.unmeasured}</span> not complete
          {selectedMeasurementProgress.inFlight > 0 && <> · <span className="status-warn">{selectedMeasurementProgress.inFlight} stuck (use Reconcile above)</span></>}
          {selectedUpToDate && ' — up to date'}
        </p>
        <Collapsible className="signal-legend" summary="Measurement details">
          <div className="measurement-status-grid">
            <div><b>GMGN parsing</b><span className="status-good">COMPLETE</span><small>{selectedMeasurementProgress.captured} normalized signals stored</small><small>latest capture {formatTime(measurementPlan.latestCapturedAt)}</small></div>
            <div><b>Dune outcomes</b><span className={selectedUpToDate ? 'status-good' : 'status-warn'}>{selectedUpToDate ? 'COMPLETE' : 'PARTIAL'}</span><small>{selectedMeasurementProgress.measured} complete outcomes · {selectedMeasurementProgress.retryEligibleSelected} ready to re-fetch · {selectedWaitingCount} waiting</small><small>last completed run {formatTime(measurementPlan.latestDuneCompletedAt)}</small></div>
            <div><b>Next Dune work</b><span className={selectedUpToDate ? 'status-good' : selectedMeasurementProgress.inFlight > 0 && selectedMeasurementProgress.eligible === 0 ? 'status-warn' : 'status-warn'}>{selectedUpToDate ? 'UP TO DATE' : selectedMeasurementProgress.inFlight > 0 && selectedMeasurementProgress.eligible === 0 ? 'IN FLIGHT' : selectedWaitingCount > 0 && selectedMeasurementProgress.eligible === 0 ? 'WAITING' : 'PENDING'}</span><small>{selectedMeasurementProgress.newEligible} new · {selectedMeasurementProgress.retryEligibleSelected} retries · {selectedMeasurementProgress.eligible} total selected</small><small>{selectedMeasurementProgress.pending} waiting for target time · {selectedMeasurementProgress.complete} complete · {selectedMeasurementProgress.inFlight} in flight</small><small>Pre-screen: {measurementPlan.prescreen.byDisposition.eligible_core ?? 0} core · {measurementPlan.prescreen.byDisposition.eligible_audit ?? 0} audit · {(measurementPlan.prescreen.byDisposition.deferred_repeat ?? 0) + (measurementPlan.prescreen.byDisposition.deferred_budget ?? 0)} deferred · {measurementPlan.prescreen.byDisposition.too_fresh ?? 0} waiting for buffer</small></div>
          </div>
        </Collapsible>
      </>}
      {outcomeBatchProgress && <p className="batch-progress">{outcomeBatchBusy ? 'Batch run in progress' : 'Batch run complete'} · {outcomeBatchProgress.completed}/{outcomeBatchProgress.total} signals · batch {Math.min(outcomeBatchProgress.current, outcomeBatchProgress.batches)}/{outcomeBatchProgress.batches}. Each batch is saved independently.</p>}
      {outcomeTimelines.map((timeline) => <div className="timeline-result" key={timeline.signal.id}><strong>Signal #{timeline.signal.id} · {timeline.signal.signalType ?? 'unknown'} · <span className="address-compact" title={timeline.signal.tokenAddress}>{timeline.signal.tokenAddress}</span></strong><div className="timeline-grid">{timeline.checkpoints.map((checkpoint) => <div key={checkpoint.label}><span>{checkpoint.label}</span><b>{checkpoint.result.priceUsd === null ? 'not available' : `$${checkpoint.result.priceUsd}`}</b><small>{checkpoint.result.status} · HTTP {checkpoint.result.priceHttpStatus ?? '—'}</small></div>)}</div><small>Missing checkpoints remain missing, never treated as zero.</small></div>)}
    </section>

    </section>

    <section id="patterns" className="menu-section panel patterns-panel">
      <div className="panel-heading"><div><p className="eyebrow">SIGNAL PATTERN BREAKDOWN</p><h2>Which signal types moved after the signal?</h2></div><span className="tag">DESCRIPTIVE</span></div>
      <p className="analysis-limitations"><strong>{displayedPatternReport?.disclaimer ?? 'Descriptive research only. This does not prove any signal type is profitable or predictive going forward.'}</strong></p>
      {displayedPatternReport && measurementPlan && <p className="measurement-plan-note">Patterns status: <span className={measurementPlan.latestDuneCompletedAt && displayedPatternReport.computedAt >= measurementPlan.latestDuneCompletedAt ? 'status-good' : 'status-warn'}>{measurementPlan.latestDuneCompletedAt && displayedPatternReport.computedAt >= measurementPlan.latestDuneCompletedAt ? 'UP TO DATE' : 'REFRESH NEEDED'}</span> · computed {formatTime(displayedPatternReport.computedAt)} · latest Dune run {formatTime(measurementPlan.latestDuneCompletedAt)} · this report issues no new Dune request.</p>}
      {displayedPatternReport && <p className="muted">V3 coverage gate: {displayedPatternReport.minCoveragePct}% fresh coverage across {displayedPatternReport.minCaptureDates} fresh capture dates; analysis unit is {displayedPatternReport.analysisUnit}. Trade-age cutoffs are enforced before a comparison can count as fresh.</p>}
      {displayedPatternReport && <p className="muted">{displayedPatternReport.staleNote} Ranked by median, not average — one outlier trade can swing an average heavily without reflecting a typical outcome.</p>}
      {viewingSnapshotId !== null && <p className="muted">Viewing saved snapshot #{viewingSnapshotId} from {formatTime(patternSnapshots.find((snapshot) => snapshot.id === viewingSnapshotId)?.computedAt ?? null)}. <button className="secondary" onClick={() => setViewingSnapshotId(null)}>Back to live report</button></p>}
      {!displayedPatternReport && <p className="muted">No measured outcomes yet — measure some signals above first.</p>}
      {displayedPatternReport && <>
        <div className="outcome-actions">
          <span className="pattern-auto-horizon">Showing best reliable horizon: <strong>{displayedPatternHorizon?.horizon ?? '—'}</strong><small>highest median among signal types that pass every reliability gate</small></span>
          <button className="secondary" disabled={savingSnapshot || viewingSnapshotId !== null} onClick={() => void saveCurrentPatternSnapshot()}>{savingSnapshot ? 'Saving…' : 'Save snapshot'}</button>
        </div>
        {displayedPatternHorizon && <div className="quality-grid">
          <div className="quality-metric"><strong>{displayedPatternHorizon.overall.n ? `${(100 * displayedPatternHorizon.overall.nFresh / displayedPatternHorizon.overall.n).toFixed(0)}%` : '—'}</strong><span>signals with a genuine outcome</span><small>{displayedPatternHorizon.overall.nFresh} of {displayedPatternHorizon.overall.n} — the rest are missing or stale</small></div>
          <div className="quality-metric"><strong>{formatPct(displayedPatternHorizon.overall.upPct)}</strong><span>up overall at {displayedPatternHorizon.horizon}</span><small>across all signal types combined</small></div>
          <div className="quality-metric"><strong>{formatPct(displayedPatternHorizon.overall.medianReturnPct)}</strong><span>overall median return</span><small>the honest "typical outcome" number, not the average</small></div>
        </div>}
        {patternVerdict && <p className="analysis-note">{patternVerdict}</p>}
        {displayedPatternHorizon && <label className="pattern-insufficient-toggle"><input type="checkbox" checked={showInsufficientPatterns} onChange={(event) => setShowInsufficientPatterns(event.target.checked)} /> Show rows with insufficient data <small>{displayedPatternHorizon.groups.filter((group) => !group.reliable).length} hidden by default</small></label>}
        {displayedPatternHorizon && <div className={`table-wrap pattern-table-focused ${showInsufficientPatterns ? 'show-insufficient' : 'hide-insufficient'}`}><table><thead><tr><th>Signal type</th><th>best horizon</th><th>n</th><th>fresh</th><th>tokens</th><th>missing</th><th>up %</th><th>median</th><th>p25 downside</th><th>worst</th><th>average</th><th>verdict</th></tr></thead><tbody>
          <tr className="pattern-overall-row"><td><b>Overall</b></td><td>{displayedPatternHorizon.horizon}</td><td>{displayedPatternHorizon.overall.n}</td><td>{displayedPatternHorizon.overall.nFresh}</td><td>{displayedPatternHorizon.overall.nDistinctTokens}</td><td>{displayedPatternHorizon.overall.nMissing}</td><td>{formatPct(displayedPatternHorizon.overall.upPct)}</td><td>{formatPct(displayedPatternHorizon.overall.medianReturnPct)}</td><td>{formatPct(displayedPatternHorizon.overall.p25ReturnPct)}</td><td>{formatPct(displayedPatternHorizon.overall.worstReturnPct)}</td><td>{formatPct(displayedPatternHorizon.overall.avgReturnPct)}</td><td>{displayedPatternHorizon.overall.verdict}</td></tr>
          {displayedPatternHorizon.groups.map((group) => { const best = bestGroupHorizon(displayedPatternReport, group.key); const row = best?.group ?? group; return <tr key={`focused-${group.key}`} className={row.reliable ? '' : 'pattern-unreliable-row'}><td>{formatSignalType(row.key)}</td><td>{best?.horizon ?? '—'}</td><td>{row.n}</td><td>{row.nFresh}</td><td>{row.nDistinctTokens}</td><td>{row.nMissing}</td><td>{formatPct(row.upPct)}</td><td className={row.medianReturnPct === null ? '' : row.medianReturnPct >= 0 ? 'change-positive' : 'change-negative'}>{formatPct(row.medianReturnPct)}</td><td>{formatPct(row.p25ReturnPct)}</td><td className="change-negative">{formatPct(row.worstReturnPct)}</td><td>{formatPct(row.avgReturnPct)}</td><td><span className={`pattern-verdict pattern-verdict-${row.verdict.replaceAll(' ', '-')}`}>{row.verdict}</span></td></tr>; })}
        </tbody></table></div>}
        {displayedPatternHorizon && <div className={`table-wrap pattern-table ${showInsufficientPatterns ? 'show-insufficient' : 'hide-insufficient'}`}><table>
          <thead><tr><th>Signal type</th><th>best horizon</th><th>n</th><th>with data</th><th>missing</th><th title="No new trade before this checkpoint — excluded from up %/avg/median">stale</th><th>fresh</th><th title="Distinct tokens behind the fresh comparisons — a lower number than n/fresh means the same token repeated">tokens</th><th>up %</th><th>avg return</th><th>median return</th><th /></tr></thead>
          <tbody>
            <tr className="pattern-overall-row"><td><b>Overall</b></td><td>{displayedPatternHorizon.horizon}</td><td>{displayedPatternHorizon.overall.n}</td><td>{displayedPatternHorizon.overall.nWithData}</td><td>{displayedPatternHorizon.overall.nMissing}</td><td>{displayedPatternHorizon.overall.nStale}</td><td>{displayedPatternHorizon.overall.nFresh}</td><td>{displayedPatternHorizon.overall.nDistinctTokens}</td><td>{formatPct(displayedPatternHorizon.overall.upPct)}</td><td>{formatPct(displayedPatternHorizon.overall.avgReturnPct)}</td><td>{formatPct(displayedPatternHorizon.overall.medianReturnPct)}</td><td /></tr>
            {displayedPatternHorizon.groups.map((group) => { const best = bestGroupHorizon(displayedPatternReport, group.key); const row = best?.group ?? group; return <tr key={group.key} className={row.reliable ? '' : 'pattern-unreliable-row'}>
              <td>{formatSignalType(row.key)}</td>
              <td>{best?.horizon ?? '—'}</td>
              <td>{row.n}</td>
              <td>{row.nWithData}</td>
              <td>{row.nMissing}</td>
              <td>{row.nStale}</td>
              <td>{row.nFresh}</td>
              <td className={row.nFresh > 0 && row.nDistinctTokens < row.nFresh ? 'pattern-repeat-tokens' : ''} title={row.nFresh > 0 && row.nDistinctTokens < row.nFresh ? 'Some tokens repeated this signal type more than once — these comparisons are not fully independent.' : undefined}>{row.nDistinctTokens}</td>
              <td>{formatPct(row.upPct)}</td>
              <td className={row.avgReturnPct === null ? '' : row.avgReturnPct >= 0 ? 'change-positive' : 'change-negative'}>{formatPct(row.avgReturnPct)}</td>
              <td className={row.medianReturnPct === null ? '' : row.medianReturnPct >= 0 ? 'change-positive' : 'change-negative'}>{formatPct(row.medianReturnPct)}</td>
              <td>{!row.reliable && <span className="pattern-warning" title={`Fewer than ${displayedPatternReport.minReliableSample} genuine (non-stale) comparisons — too small to trust as a pattern.`}>small sample</span>}</td>
            </tr>; })}
          </tbody>
        </table></div>}
        <p className="muted">Computed {formatTime(displayedPatternReport.computedAt)} from {displayedPatternReport.sourceRunIds.length} archived Dune run{displayedPatternReport.sourceRunIds.length === 1 ? '' : 's'} already stored locally — no new Dune query is issued to build this report.</p>
      </>}
      {patternSnapshots.length > 0 && <Collapsible className="pattern-history" summary={`Saved snapshots (${patternSnapshots.length})`}>
        <div className="pattern-history-list">{patternSnapshots.map((snapshot) => <div key={snapshot.id} className="pattern-history-row"><span>#{snapshot.id} · {formatTime(snapshot.computedAt)} · {snapshot.sourceRunIds.length} source run{snapshot.sourceRunIds.length === 1 ? '' : 's'}</span><button className="secondary" onClick={() => setViewingSnapshotId(snapshot.id)}>View</button></div>)}</div>
      </Collapsible>}
      <Collapsible className="pattern-subgroups" open={subgroupOpened} onToggle={(open) => { setSubgroupOpened(open); if (open && !subgroupReport && !subgroupBusy) void loadSubgroupReport(subgroupProperty); }} summary="Subgroup breakdown: signal type × property (exploratory)">
        <p className="analysis-limitations"><strong>{subgroupReport?.disclaimer ?? 'Descriptive research only. This does not prove any signal type + property combination is profitable or predictive going forward.'}</strong></p>
        <p className="muted">Limited to properties fixed at signal time (launch platform, token age) — fast-moving fields like live liquidity or volume are query-time snapshots, not verified trigger-time facts, so they're deliberately excluded from this breakdown for now. No statistical correction is applied for testing multiple cells at once — the cell count below is shown so a good-looking cell can be weighed against how many were tested. This view picks its own best horizon independently of the main table above — a standout combination can peak at a different horizon than the aggregate picture.</p>
        <div className="outcome-actions">
          {(Object.keys(SUBGROUP_PROPERTY_LABELS) as SubgroupProperty[]).map((property) => <button key={property} className={subgroupProperty === property ? 'primary' : 'secondary'} onClick={() => { setSubgroupProperty(property); setSubgroupReport(null); void loadSubgroupReport(property); }}>{SUBGROUP_PROPERTY_LABELS[property]}</button>)}
        </div>
        {subgroupBusy && <p className="muted">Computing…</p>}
        {!subgroupBusy && displayedSubgroupHorizon && <>
          <p className="muted">Auto-selected: <strong>{displayedSubgroupHorizon.horizon}</strong> (best reliable cell for this breakdown) · {displayedSubgroupHorizon.cellCount} cell{displayedSubgroupHorizon.cellCount === 1 ? '' : 's'} tested (signal type × {SUBGROUP_PROPERTY_DESCRIPTIONS[subgroupProperty]}) · {displayedSubgroupHorizon.nUnextractable} signal{displayedSubgroupHorizon.nUnextractable === 1 ? '' : 's'} excluded (property not extractable, not guessed).</p>
          <div className="table-wrap pattern-table-subgroup"><table>
            <thead><tr><th>Cell (type × {SUBGROUP_PROPERTY_DESCRIPTIONS[subgroupProperty]})</th><th>n</th><th>fresh</th><th>tokens</th><th>up %</th><th>median</th><th>average</th><th>verdict</th></tr></thead>
            <tbody>{displayedSubgroupHorizon.groups.map((group) => <tr key={group.key} className={group.reliable ? '' : 'pattern-unreliable-row'}>
              <td>{group.key}</td>
              <td>{group.n}</td>
              <td>{group.nFresh}</td>
              <td>{group.nDistinctTokens}</td>
              <td>{formatPct(group.upPct)}</td>
              <td className={group.medianReturnPct === null ? '' : group.medianReturnPct >= 0 ? 'change-positive' : 'change-negative'}>{formatPct(group.medianReturnPct)}</td>
              <td>{formatPct(group.avgReturnPct)}</td>
              <td><span className={`pattern-verdict pattern-verdict-${group.verdict.replaceAll(' ', '-')}`}>{group.verdict}</span></td>
            </tr>)}</tbody>
          </table></div>
        </>}
        {!subgroupBusy && subgroupReport && !displayedSubgroupHorizon && <p className="muted">No subgroup horizon currently passes all reliability gates (fresh sample, coverage, distinct tokens, and capture-date spread). The data remains stored for review.</p>}
      </Collapsible>
    </section>

    <Collapsible className="outcome-results-details" open={false} summary={`Measured results (${outcomeTimelines.length})`}><div className="outcome-results-controls"><label>Rows per page<select value={outcomePageSize} onChange={(event) => { const value = event.target.value; setOutcomePageSize(value === 'all' ? 'all' : Number(value)); setOutcomePage(0); }}><option value="25">25</option><option value="100">100</option><option value="1000">1,000</option><option value="all">All</option></select></label><button type="button" className="secondary" disabled={outcomePage === 0 || outcomePageSize === 'all'} onClick={() => setOutcomePage((page) => Math.max(0, page - 1))}>Previous</button><span>Page {Math.min(outcomePage + 1, outcomePageCount)} of {outcomePageCount}</span><button type="button" className="secondary" disabled={outcomePageSize === 'all' || outcomePage + 1 >= outcomePageCount} onClick={() => setOutcomePage((page) => Math.min(outcomePageCount - 1, page + 1))}>Next</button></div><div className="table-wrap outcome-table outcome-table-visible"><table><thead><tr>{outcomeColumns.map((column) => <th key={column.key} onClick={() => toggleOutcomeSort(column.key)} className="sortable-header" title="Click to sort">{column.label}{sortIndicator(column.key)}</th>)}</tr></thead><tbody>{visibleOutcomeTimelines.map((timeline) => { const base = timeline.checkpoints.find((checkpoint) => checkpoint.label === 'signal')?.result.priceUsd ?? null; return <tr key={timeline.signal.id}><td>#{timeline.signal.id}</td><td>{formatSignalType(timeline.signal.signalType)}</td>{CHECKPOINT_COLUMNS.map((label) => renderCheckpointCell(timeline, base, label))}<td><span className="token-cell" title={timeline.signal.tokenAddress}>{tokenDisplay(timeline.signal.symbol, timeline.signal.tokenAddress)} <button type="button" className="copy-address" aria-label={`Copy address ${timeline.signal.tokenAddress}`} onClick={() => void copyAddress(timeline.signal.tokenAddress)}>⧉</button></span></td></tr>; })}</tbody></table></div></Collapsible>

    <section id="copytrade" className="menu-section panel copytrade-panel">





      {copyTradeSubTab === 'scrutiny' && <div className="scrutiny-panel">
        <p className="eyebrow copytrade-step-label">SCRUTINY · INDIVIDUAL CANDIDATE INTERROGATION</p>
        <div className="scrutiny-heading">
          <div><h2>Does each wallet hold up?</h2><p className="muted">Mirrors the saved 30-day GMGN Wallet Stats table. Reads <code>GET /api/copytrade/scrutiny</code> (per-wallet checks, from already-stored GMGN/Dune evidence); the risk-detail drop zone below uses <code>GET</code>/<code>POST /api/copytrade/scrutiny/gmgn-risk</code> to save an imported file locally — none of these call GMGN or Dune directly.</p></div>
        </div>

        <p className="compact-info-line scrutiny-selection-note">Automatically reviewing {scrutinyPinned.length || 'all'} wallets from the 30-day GMGN Wallet Stats table. Click a row for the detailed view.</p>

        {scrutinyOutcome && <p className="muted scrutiny-outcome">{scrutinyOutcome}</p>}
        {scrutinyError && <p className="copytrade-status-warning">{scrutinyError}</p>}
        {scrutinyResponse && scrutinyResponse.missingWallets.length > 0 && <p className="copytrade-status-warning">No scored data yet for: {scrutinyResponse.missingWallets.map((wallet) => shortAddress(wallet)).join(', ')}. Fetch their trades first.</p>}

        {scrutinyLoading && <p className="muted scrutiny-loading-note"><span className="loading-spinner" aria-hidden="true" /> Reading saved GMGN and Dune evidence from SQLite — no provider fetch is running.</p>}
        {!scrutinyLoading && scrutinyPinned.length > 0 && (!scrutinyResponse || scrutinyResponse.reports.length === 0) && <p className="muted">No scrutiny data yet for the pinned wallets.</p>}

        {scrutinyResponse?.reports.length ? <>
          <div className="scrutiny-legend" role="note" aria-label="Verdict legend">
            {(['pass', 'fail', 'insufficient'] as const).map((verdict) => <span key={verdict} className={`scrutiny-legend-item scrutiny-verdict-${verdict}`}><span className="scrutiny-legend-icon" aria-hidden="true">{SCRUTINY_VERDICT_ICONS[verdict]}</span>{SCRUTINY_VERDICT_LABELS[verdict]}</span>)}
          </div>
          <DataTable
            wrapClassName="scrutiny-table-wrap"
            tableClassName="scrutiny-table"
            rows={scrutinyResponse.reports}
            getRowKey={(report) => report.walletAddress}
            rowProps={(report) => ({ className: 'scrutiny-table-row', tabIndex: 0, role: 'button', onClick: () => setSelectedScrutinyWallet(report.walletAddress), onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') setSelectedScrutinyWallet(report.walletAddress); } })}
            columns={[
              {
                key: 'rank',
                header: 'Rank',
                cellProps: () => ({ title: 'Current rank in the selected GMGN top-100 roster' }),
                render: (report) => {
                  const rank = copyTradeRows.find((row) => row.walletAddress === report.walletAddress)?.rankHistory.currentRank ?? null;
                  return rank === null ? '—' : `#${rank}`;
                },
              },
              { key: 'wallet', header: 'Wallet', render: (report) => <><strong>{report.name?.trim() || shortAddress(report.walletAddress)}</strong><small title={report.walletAddress}>{shortAddress(report.walletAddress)}</small></> },
              ...Object.values(scrutinyResponse.reports[0].checks).map((firstCheck) => ({
                key: firstCheck.key,
                header: <span>{firstCheck.label}</span>,
                cellProps: (report: typeof scrutinyResponse.reports[0]) => {
                  const check = (report.checks as Record<string, typeof firstCheck>)[firstCheck.key];
                  return { className: `scrutiny-cell-${check.verdict}`, title: `${check.label}: ${SCRUTINY_VERDICT_LABELS[check.verdict]} — ${check.detail}` };
                },
                render: (report: typeof scrutinyResponse.reports[0]) => {
                  const check = (report.checks as Record<string, typeof firstCheck>)[firstCheck.key];
                  return <><span aria-hidden="true">{SCRUTINY_VERDICT_ICONS[check.verdict]}</span><span className="visually-hidden">{SCRUTINY_VERDICT_LABELS[check.verdict]}</span></>;
                },
              })),
            ]}
          />
        </> : null}
        {scrutinyResponse?.reports.filter((report) => report.walletAddress === selectedScrutinyWallet).map((report) => <Modal key={report.walletAddress} onClose={() => setSelectedScrutinyWallet(null)} ariaLabel={`Scrutiny details for ${report.name?.trim() || shortAddress(report.walletAddress)}`} backdropClassName="scrutiny-detail-backdrop" dialogClassName="scrutiny-card scrutiny-detail-card" dialogAs="article">
          <header className="scrutiny-card-header">
            <div><strong>{report.name?.trim() || shortAddress(report.walletAddress)}</strong><small title={report.walletAddress}>{shortAddress(report.walletAddress)}</small></div>
            <button type="button" className="quiet" onClick={() => setSelectedScrutinyWallet(null)}>Close details</button>
            <a className="quiet" href={`https://gmgn.ai/sol/address/${report.walletAddress}`} target="_blank" rel="noreferrer">View on GMGN ↗</a>
          </header>
          <p className="compact-info-line scrutiny-selection-note"><span>{report.selectionContext.note}</span></p>
          <section className="scrutiny-gmgn-risk" aria-label="GMGN risk details">
            <div className="scrutiny-gmgn-risk-heading"><div><strong>GMGN 30-day risk details</strong><small>Click <b>View on GMGN ↗</b> above, then export the 30d risk JSON from the extension.</small></div></div>
            <label className="scrutiny-risk-dropzone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void importGmgnRiskFile(file, report.walletAddress); }}>
              <span>Drop the exported JSON here</span><small>or choose a file from your computer</small><input type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importGmgnRiskFile(file, report.walletAddress); event.currentTarget.value = ''; }} />
            </label>
            <div className="scrutiny-gmgn-period-grid">{(['30d'] as const).map((period) => {
              const result = gmgnRiskResults[`${report.walletAddress}|${period}`];
              const metrics = result?.metrics;
              return <div className="scrutiny-gmgn-period" key={period}><h4>30d</h4>
                {!result && <small className="muted">Open GMGN and import the exported JSON above.</small>}
                {result && !result.available && <small className="copytrade-status-warning">Unavailable{result.error ? ` — ${result.error}` : ''}</small>}
                {metrics && <div className="scrutiny-gmgn-metrics">
                  <span><b>P&amp;L</b>{formatGmgnRiskValue(metrics.realizedProfit)}</span><span><b>Win rate</b>{formatGmgnRiskRatio(metrics.winRate)}</span>
                  <span><b>Fees</b>{formatGmgnRiskValue(metrics.fees)}</span><span><b>Avg hold</b>{metrics.averageHoldingSeconds === null ? '—' : `${(metrics.averageHoldingSeconds / 3600).toFixed(1)}h`}</span>
                  <span><b>Fast tx</b>{formatGmgnRiskRatio(metrics.risk.fastTxRatio ?? metrics.risk.fastTx)}</span><span><b>Sell&gt;buy</b>{formatGmgnRiskRatio(metrics.risk.sellPassBuyRatio ?? metrics.risk.sellPassBuy)}</span>
                  <span><b>No buy/hold</b>{formatGmgnRiskRatio(metrics.risk.noBuyHoldRatio ?? metrics.risk.noBuyHold)}</span><span><b>Native balance</b>{formatGmgnRiskValue(metrics.nativeBalance)}</span>
                </div>}
              </div>;
            })}</div>
          </section>
          <div className="scrutiny-check-grid">
            {Object.values(report.checks).map((check) => <div className={`scrutiny-check scrutiny-check-${check.verdict}`} key={check.key}>
              <div className="scrutiny-check-header"><strong>{check.label}</strong><span className={`scrutiny-verdict-badge scrutiny-verdict-${check.verdict}`}>{SCRUTINY_VERDICT_LABELS[check.verdict]}</span></div>
              <p className="scrutiny-check-detail">{check.detail}</p>
              <small className="scrutiny-check-n">n = {formatCount(check.n)}</small>
            </div>)}
          </div>
        </Modal>)}
      </div>}
    </section>

    {copyTradeSubTab === 'wallet-stats' && <section id="copytrade-wallet-stats" className="menu-section panel copytrade-research-route">
      <div className="panel-heading"><div><p className="eyebrow">30-DAY COHORT · 30-DAY DECISION</p><h2>Who is worth following?</h2></div><span className="tag">30D DECISION VIEW</span></div>
      {walletStatsTableLoading && <div className="copytrade-analysis-status running" role="status" aria-live="polite"><span className="loading-spinner" aria-hidden="true" /><div><strong>Loading saved trader evidence…</strong><small>Reading the roster, GMGN summaries, and Dune results from SQLite. Temporary verdicts are hidden until loading finishes.</small></div></div>}
      <div className="copytrade-final-decision-panel">
        <div className="copytrade-decision-state-counts">
          {DECISION_ORDER.map((state) => {
            const count = walletStatsTableLoading ? null : unifiedTraderRows.reduce((total, entry) => total + (decisionStateFor(entry.verdict) === state ? 1 : 0), 0);
            return <div key={state} className={`copytrade-decision-state-tile tone-${DECISION_STATES[state].tone}`} title={DECISION_STATES[state].blurb}>
              <strong>{count ?? '—'}</strong><span>{DECISION_STATES[state].label}</span>
            </div>;
          })}
        </div>
        <div className="copytrade-decision-panel-foot">
          <span>
            {showDelaySurvivorsOnly ? 'Showing positive-copy rows · ' : ''}GMGN summaries: {gmgnStatsFreshRows}/{copyTradeRows.length} fresh
            {visibleWalletScreenSummary?.lastFetchedAt ? ` (${formatFetchTime(visibleWalletScreenSummary.lastFetchedAt)})` : ' (not completed)'}
            {' · '}
            Dune: {copySimulationRunStatus?.outcome === 'complete' ? 'complete' : duneMatchedTargets > 0 ? 'partial' : 'not completed'}
            {' · 30-day period'}
          </span>
        </div>
      </div>
      <div className="copytrade-top-fetch-controls">
        <div className="copytrade-top-fetch-heading"><strong>Fetch controls</strong><span>Update saved GMGN history first, then run the Dune copy test.</span></div>
        <div className="copytrade-workflow-row copytrade-prefetch-scope-row">
          <div className="copytrade-workflow-label">
            <span className="copytrade-workflow-step" title="Runs before step 1 — this only narrows which wallets steps 1 and 2 will touch, it fetches nothing itself.">0</span>
            <div>
              <strong>Narrow the Dune scope first</strong>
              <small>
                Skips wallets Dune fetching can never help or shouldn't be spent on — see the checkbox tooltip for the full list of checks.
                {scopeFilteredWalletSet.size > 0 && ` Currently ${scopeFilteredWalletSet.size} wallet${scopeFilteredWalletSet.size === 1 ? '' : 's'}.`}
              </small>
            </div>
          </div>
          <label className="copytrade-filter-toggle" title={`Two kinds of check, both from data already on hand — no new Dune or GMGN request:\n\n• Can't be copied: median hold time < the ${copierDelaySecondsForScope}s copy delay. Not a judgment call — the verdict already forces "Not copyable" for this regardless of what Dune returns, so spending credits on it is provably wasted (${uncopyableWalletSet.size} wallet${uncopyableWalletSet.size === 1 ? '' : 's'}).\n\n• GMGN-flagged high-risk: wash_trader tag, 30d PnL ≤ -20%, >5,000 trades in 30d, >100 tokens created, <10 trades in 30d, <20% win rate, or >90% one-sided buy/sell activity. These ARE judgment calls, not provable waste — a legitimate trader could still trip one (${highRiskWalletReasons.size} wallet${highRiskWalletReasons.size === 1 ? '' : 's'}).\n\nOverride any individual wallet in the activity table below regardless of which check it hit.`}>
            <input type="checkbox" checked={skipScopeFiltersInDune} onChange={(event) => setSkipScopeFiltersInDune(event.target.checked)} />
            Skip low-value wallets (uncopyable or GMGN-flagged high-risk){scopeFilteredWalletSet.size > 0 ? ` (${scopeFilteredWalletSet.size})` : ''}
          </label>
        </div>
        {/* Server-derived `rosterFetchStatus.running` only, matching how the button row below
            decides Pause vs Resume vs Fetch — NOT the client-only `researchUpdateBusy` flag. That
            flag is set at the start of screenTopWallets and only cleared in its own finally block;
            when a fetch is interrupted by something outside that flow (e.g. the dev server
            restarting mid-run, confirmed live: "Interrupted: the server restarted while this fetch
            was running"), it can stay stuck true while the server has already moved on, hiding
            this banner indefinitely even though the button correctly shows "Resume". */}
        {!rosterFetchStatus?.running && staleDataAgeHours !== null && (
          <p className="copytrade-status-warning" title="Estimate only, from each wallet's own historical average trade rate over its stored 30-day window — not a live check. A quiet wallet can still trade any minute; a busy one can go silent for days. The one certain number here is how long ago the data was last confirmed current.">
            Your GMGN data is <strong>{formatDuration(Math.round(staleDataAgeHours * 3600))} old</strong> (last fetched {formatFetchTime(latestGmgnFetchAt)}).
            {' '}Based on this cohort's historical trading pace, an estimated <strong>~{Math.round(estimatedTradesSinceLastFetch ?? 0).toLocaleString()} trades</strong> may
            {' '}have happened since then that this view does not yet reflect. Skip fetching only if that's a risk you're fine carrying.
          </p>
        )}
        {researchUpdateBusy && <div className="copytrade-live-fetch-status" role="status" aria-live="polite"><div><strong>{researchUpdateStage ?? 'Preparing research…'}</strong><small>Existing GMGN and Dune responses are retained; only missing work is requested.</small></div>{gmgnStatsStatus?.running && <div><b>GMGN summaries</b><span>{gmgnStatsStatus.walletDone} / {gmgnStatsStatus.walletTotal} wallets · {gmgnStatsStatus.requestsMade} requests</span><small>Fetching and parsing wallet statistics</small></div>}{copySimulationRunStatus?.running && <div><b>Dune copy prices</b><span>Query {copySimulationRunStatus.currentBatch || '—'} / {copySimulationRunStatus.batchesTotal || '—'} · {copySimulationRunStatus.targetsProcessed.toLocaleString()} / {copySimulationRunStatus.targetsTotal.toLocaleString()} targets</span><small>{copySimulationRunStatus.storedTargets.toLocaleString()} stored · {copySimulationRunStatus.failedTargets.toLocaleString()} failed · {copySimulationRunStatus.remainingTargets.toLocaleString()} remaining · Dune {copySimulationRunStatus.duneState?.replace('QUERY_STATE_', '').toLowerCase() ?? 'submitting'}</small><small>{copySimulationRunStatus.message}</small></div>}</div>}
        <div className="copytrade-workflow-actions">
          <div className="copytrade-workflow-row">
            <div className="copytrade-workflow-label"><span className="copytrade-workflow-step">1</span><div><strong>GMGN screening</strong><small>{visibleWalletScreenSummary ? `${visibleWalletScreenSummary.statsWalletCount}/${visibleWalletScreenSummary.walletCount} wallets · fetched ${formatFetchTime(visibleWalletScreenSummary.lastFetchedAt)}` : 'No saved screening yet'}</small></div><button type="button" className="copytrade-icon-button" onClick={() => void openRosterComparison()} disabled={rosterComparisonLoading} title="Compare the current GMGN top 100 with the previous saved list" aria-label="Open GMGN top 100 comparison">{rosterComparisonLoading ? '…' : '☷'}</button></div>
            <div className="copytrade-workflow-status"><strong>{rosterFetchStatus?.running ? 'Fetching…' : visibleWalletScreenSummary ? 'Saved screening available' : 'Not fetched'}</strong><small>Complete wallet history and 30-day summaries</small></div>
            {rosterFetchStatus?.running && <div className="copytrade-top-fetch-detail" role="status" aria-live="polite">
              <div className="copytrade-top-fetch-detail-head"><strong>{rosterFetchStatus.walletDone ?? 0}/{rosterFetchStatus.walletTotal ?? 0} wallets</strong><span>{rosterProgressPercent === null ? 'Progress calculating' : `${rosterProgressPercent.toFixed(1)}%`}</span></div>
              <progress max={100} value={rosterProgressPercent ?? 0} />
              <small>{rosterFetchStatus.currentWalletAddress ? `Current: ${shortAddress(rosterFetchStatus.currentWalletAddress)}` : 'Preparing wallet'} · {(rosterFetchStatus.storedTradesTotal ?? 0).toLocaleString()} stored · {(rosterFetchStatus.tradesFetched ?? 0).toLocaleString()} new · {(rosterFetchStatus.tradesDuplicate ?? 0).toLocaleString()} duplicates · {(rosterFetchStatus.requestsMade ?? 0).toLocaleString()} requests</small>
              <small>{(rosterFetchStatus.failedWallets ?? 0).toLocaleString()} failed wallets · {rosterFetchStatus.currentWalletEstimatedRemainingSeconds == null ? 'Wallet ETA calculating' : `${formatSeconds(rosterFetchStatus.currentWalletEstimatedRemainingSeconds)} current wallet remaining`} · {rosterFetchStatus.totalEstimatedRemainingSeconds == null ? 'Total ETA calculating' : `${formatSeconds(rosterFetchStatus.totalEstimatedRemainingSeconds)} total remaining`}</small>
            </div>}
            {rosterFetchStatus?.running
              ? <button className="primary copytrade-stop-button" disabled={copyTradeStopBusy} onClick={() => void stopCopyTradeFetch()}>{copyTradeStopBusy ? 'Pausing…' : 'Pause GMGN fetch'}</button>
              : rosterFetchStatus?.resumeAvailable
                ? <button className="primary" disabled={copyTradeResumeBusy || researchUpdateBusy || gmgnStatsBusy || gmgnStatsStatus?.running || rosterSyncBusy || copySimulationRunStatus?.running} onClick={() => void resumeCopyTradeFetch()}>{copyTradeResumeBusy ? 'Resuming…' : 'Resume GMGN fetch'}</button>
                : <button className="primary" onClick={() => void screenTopWallets()} disabled={researchUpdateBusy || gmgnStatsBusy || gmgnStatsStatus?.running || rosterSyncBusy || copySimulationRunStatus?.running}>{researchUpdateBusy && !visibleWalletScreenSummary ? 'Fetching…' : 'Fetch top 100'}</button>}
            {!rosterFetchStatus?.running && rosterFetchStatus?.runId !== null && rosterFetchStatus?.runId !== undefined && <button className="quiet" disabled={copyTradeResetBusy} onClick={() => void resetCopyTradeFetch()} title="Forget only the resumable cursor. Saved GMGN trades remain in SQLite.">{copyTradeResetBusy ? 'Resetting…' : 'Reset resume snapshot'}</button>}
            {/* Was computed but never rendered — a live-vs-fallback roster refresh looked
                identical to the user, with the distinction only visible in a transient toast
                that the next fetch stage immediately overwrote. */}
            {rosterRefreshError && <p className="copytrade-status-warning" role="alert">{rosterRefreshError}</p>}
            {!rosterRefreshError && rosterRefreshMessage && <p className={rosterRefreshMessage.startsWith('Live refresh blocked') ? 'copytrade-status-warning' : 'muted'} role="status">{rosterRefreshMessage}</p>}
            {!rosterFetchStatus?.running && rosterFetchStatus?.message && <p className={rosterFetchStatus.status === 'failed' ? 'copytrade-status-warning' : 'muted'}>{rosterFetchStatus.message}</p>}
            {visibleWalletScreenSummary && <div className="copytrade-screening-summary">
              <div className="copytrade-screening-summary-facts"><span><strong>{visibleWalletScreenSummary.statsWalletCount}/{visibleWalletScreenSummary.walletCount}</strong> wallets</span><span><strong>{visibleWalletScreenSummary.notFastWallets}</strong> not fast · <strong>{visibleWalletScreenSummary.fastWallets}</strong> fast</span><span><strong>{visibleWalletScreenSummary.totalTrades.toLocaleString()}</strong> trades · {visibleWalletScreenSummary.periodDays}d</span><span>Most active: <strong>{visibleWalletScreenSummary.maxTrades.toLocaleString()}</strong>{visibleWalletScreenSummary.maxTradesWallet ? ` · ${shortAddress(visibleWalletScreenSummary.maxTradesWallet)}` : ''}</span><span><strong>{researchWalletAddresses.length}</strong> selected for Dune</span>{skippedScreeningCount > 0 && <span><strong>{skippedScreeningCount}</strong> excluded{triageExcludedFromDuneCount > 0 && ` (${triageExcludedFromDuneCount} by triage)`}</span>}</div>
              <label className="copytrade-filter-toggle" title={triageHasCurrentInputs ? `Skips the ${eliminationReport?.eliminated.length ?? 0} wallets rejected by the current triage run. Uncheck to include them, or re-check an individual row below.` : 'Run triage after the latest GMGN and Dune fetches before using its exclusions.'}>
                <input type="checkbox" checked={skipEliminatedInDune} disabled={!triageHasCurrentInputs || eliminationReport?.eliminated.length === 0} onChange={(event) => setSkipEliminatedInDune(event.target.checked)} />
                Skip wallets triage rejected{eliminationReport ? ` (${eliminationReport.eliminated.length})` : ''}{eliminationReport && !triageHasCurrentInputs ? ' · triage out of date' : ''}
              </label>
              <Collapsible summary={`Show activity table (${visibleWalletScreenSummary.activityLeaders.length})`}><div className="copytrade-activity-table-toolbar"><span><strong>{researchWalletAddresses.length}</strong> selected for Dune · yellow rows have Dune data to fetch</span><div><button type="button" className="quiet" onClick={selectAllScreeningWallets} disabled={activityWalletAddresses.length === 0}>Select all</button><button type="button" className="quiet" onClick={deselectAllScreeningWallets} disabled={activityWalletAddresses.length === 0}>Deselect all</button></div></div><div className="table-wrap copytrade-screening-activity-table"><table><thead><tr><th>Fetch?</th><th>Activity #</th><th>Rank</th><th>Trader</th><th>Trades</th><th>Net profit (30d)</th><th>Delay fit</th></tr></thead><tbody>{visibleWalletScreenSummary.activityLeaders.map((entry, index) => { const excluded = excludedScreeningWalletSet.has(entry.wallet); const decisionEntry = unifiedTraderRowByWallet.get(entry.wallet); const needsEvidence = decisionEntry ? decisionStateFor(decisionEntry.verdict) === 'needs_data' && (!decisionEntry.delay?.sim || (decisionEntry.delay?.sim?.pendingDuneTargets ?? 0) > 0) : false; const rejectedByTriage = triageEliminatedWalletSet.has(entry.wallet); const highRiskReasons = highRiskWalletReasons.get(entry.wallet); const delayFit = entry.averageHoldSeconds === null ? 'Unknown' : entry.averageHoldSeconds < 60 ? 'Poor fit — fast trader' : 'Better fit — fetch'; const duneSim = decisionEntry?.delay?.sim; const duneLegsTotal = duneSim ? (duneSim.pendingDuneTargets ?? 0) + (duneSim.duneNoMatchTargets ?? 0) + (duneSim.duneMatchedTargets ?? 0) : 0; const duneQueriedPercent = duneLegsTotal > 0 && duneSim ? Math.round(((duneSim.duneNoMatchTargets ?? 0) + (duneSim.duneMatchedTargets ?? 0)) / duneLegsTotal * 100) : null; const usableCoverage = decisionEntry?.coverage; const coverageText = usableCoverage === null || usableCoverage === undefined ? 'Dune usable coverage is not available.' : `Dune usable coverage is ${usableCoverage.toFixed(0)}% (${duneSim?.copiedTrades ?? 0} matched of ${duneSim?.roundTripsConsidered ?? 0} eligible round trips).`; const queryText = duneQueriedPercent === null ? 'Dune query coverage is not available.' : `Dune query coverage is ${duneQueriedPercent}%; ${duneQueriedPercent >= 100 ? 'all current trade legs were already queried, so another normal fetch cannot add unqueried Dune data.' : 'unqueried Dune legs may still be fetchable.'}`; const evidenceReason = decisionEntry && decisionStateFor(decisionEntry.verdict) === 'needs_data' ? `${decisionEntry?.decisionReasons.join(' ') ?? 'Required decision evidence is incomplete.'} ${coverageText} ${queryText}` : 'This wallet does not currently need more decision evidence.'; return <tr key={entry.wallet} className={[excluded ? 'copytrade-screening-excluded' : '', needsEvidence ? 'copytrade-screening-needs-data' : ''].filter(Boolean).join(' ') || undefined}><td><input type="checkbox" checked={!excluded} onChange={() => toggleScreeningWallet(entry.wallet)} aria-label={`${excluded ? 'Include' : 'Exclude'} ${entry.name?.trim() || shortAddress(entry.wallet)} in Dune research`} /></td><td>{index + 1}</td><td>{entry.rank === null ? '—' : `#${entry.rank}`}</td><td title={evidenceReason}>{entry.name?.trim() || shortAddress(entry.wallet)}{needsEvidence && <small className="copytrade-needs-data-label">Needs more evidence</small>}{rejectedByTriage && <small className="copytrade-warning-text" title="The last triage run rejected this wallet. Check the box to fetch it anyway."> · rejected by triage</small>}{highRiskReasons && highRiskReasons.length > 0 && <small className="copytrade-warning-text" title="Check the box to fetch it anyway."> · {highRiskReasons.join(', ')}</small>}</td><td>{entry.trades.toLocaleString()}</td><td className={entry.netProfit !== null && entry.netProfit >= 0 ? 'positive' : entry.netProfit !== null ? 'negative' : undefined}>{formatUsd(entry.netProfit)}</td><td title={`GMGN provides average holding time here; this is the best available delay-risk proxy. ${evidenceReason}`}>{delayFit}<small>{entry.averageHoldSeconds === null ? 'No hold-time data' : `${formatHoldingTime(entry.averageHoldSeconds)} average hold`}</small></td></tr>; })}</tbody></table></div></Collapsible>{visibleWalletScreenSummary.missingStatsWallets > 0 && <small>{visibleWalletScreenSummary.missingStatsWallets} summaries missing</small>}
            </div>}
          </div>
          <div className="copytrade-workflow-row">
            <div className="copytrade-workflow-label"><span className="copytrade-workflow-step">2</span><div><strong>Dune copy test</strong><small>{copySimulationRunStatus?.persistedRun?.completedAt ? `Last fetched ${formatFetchTime(copySimulationRunStatus.persistedRun.completedAt)}` : 'No saved Dune run yet'}</small></div></div>
            <div className="copytrade-workflow-status"><strong>{duneRunActive ? 'Processing Dune targets…' : preciseTargetsRemaining === 0 ? 'Dune complete · no new targets' : copySimulationRunStatus?.outcome === 'complete' ? 'Dune run complete' : copySimulationRunStatus?.persistedRun ? 'Saved Dune evidence available' : 'Not fetched'}</strong><small>{duneRunActive && copySimulationRunStatus ? `${copySimulationRunStatus.targetsProcessed.toLocaleString()} / ${copySimulationRunStatus.targetsTotal.toLocaleString()} targets processed · ${copySimulationRunStatus.remainingTargets.toLocaleString()} remaining` : `${duneNeedsDataCount} wallets need more evidence; ${preciseTargetsRemaining === null ? 'Dune target count is loading' : `${preciseTargetsRemaining.toLocaleString()} price targets remain`}`}</small></div>
            {copySimulationRunStatus?.running
              ? <button className="primary copytrade-stop-button" onClick={() => void stopCopySimulation()} disabled={copySimulationStopBusy}>{copySimulationStopBusy ? 'Stopping…' : 'Stop Dune fetch'}</button>
              : <button className="primary" onClick={() => void approveAndResearch()} disabled={researchUpdateBusy || !visibleWalletScreenSummary || !duneNeedsDataWalletAddresses.length || !duneHasNewTargets || gmgnStatsStatus?.running}>{researchUpdateBusy && visibleWalletScreenSummary ? 'Fetching…' : preciseTargetsRemaining === 0 ? 'No new Dune data to fetch' : copySimulationRunStatus?.outcome === 'partial' || copySimulationRunStatus?.outcome === 'stopped' ? `Resume Dune (${preciseTargetsRemaining?.toLocaleString() ?? '…'} targets · ${duneNeedsDataCount} wallets)` : `Fetch ${preciseTargetsRemaining?.toLocaleString() ?? '…'} Dune targets (${duneNeedsDataCount} wallets)`}</button>}
          </div>
          <div className="copytrade-dune-scope" role="status" aria-live="polite">
            <div className="copytrade-dune-scope-head"><strong>Dune research scope</strong><span>{duneNeedsDataCount} wallets still need more data</span></div>
            <div className="copytrade-dune-scope-grid"><span><b>{researchWalletAddresses.length}</b> selected wallets</span><span><b>{duneNeedsDataCount}</b> need more evidence</span><span><b>{duneResultCount}</b> have a saved Dune result</span><span><b>{preciseTargetsRemaining == null ? '—' : preciseTargetsRemaining.toLocaleString()}</b> price targets unqueried</span><span><b>{widerRetryCandidates == null ? '—' : widerRetryCandidates.toLocaleString()}</b> queried with no usable match</span></div>
            {copySimulationRunStatus?.running && <><progress max={100} value={copySimulationRunStatus.targetsTotal > 0 ? Math.min(100, copySimulationRunStatus.targetsProcessed / copySimulationRunStatus.targetsTotal * 100) : 0} /><small>{copySimulationRunStatus.targetsProcessed.toLocaleString()} / {copySimulationRunStatus.targetsTotal.toLocaleString()} targets · {copySimulationRunStatus.remainingTargets.toLocaleString()} remaining · {copySimulationRunStatus.failedTargets.toLocaleString()} failed</small></>}
            {copySimulationRunStatus?.audit && !copySimulationRunStatus.running && <small>Last audited run: planned {copySimulationRunStatus.audit.plannedTargets.toLocaleString()} · submitted {copySimulationRunStatus.audit.submittedTargets.toLocaleString()} · stored {copySimulationRunStatus.audit.storedTargets.toLocaleString()} · failed {copySimulationRunStatus.audit.failedTargets.toLocaleString()} · remaining {copySimulationRunStatus.audit.remainingTargets.toLocaleString()}</small>}
            <small>{duneNeedsDataCount > 0 && preciseTargetsRemaining === 0 ? `These ${duneNeedsDataCount} wallets still fail a decision-evidence rule, but Dune has no unqueried prices left. The missing evidence may be insufficient sample/coverage or a price Dune could not match; another normal fetch cannot create it.` : duneNeedsDataCount > 0 ? `The button above targets only these ${duneNeedsDataCount} wallets. It fetches their missing eligible price targets and keeps completed results; it does not fetch the other ${Math.max(0, researchWalletAddresses.length - duneNeedsDataCount)} wallets.` : 'No selected wallet currently needs more evidence; the Dune button is disabled.'}</small>
            {(() => {
              // The real reason a batch failed (Dune's own error text — e.g. an exhausted
              // billing quota) was captured by the backend all along but never rendered here;
              // only a generic failed-count ever reached the UI. Deduplicated because the same
              // failure (like an account-level quota) repeats identically across every batch.
              const failureMessages = [...new Set((copySimulationRunStatus?.batches ?? [])
                .filter((batch) => batch.status === 'failed' && batch.error)
                .map((batch) => batch.error as string))];
              return failureMessages.length > 0 ? (
                <p className="copytrade-status-warning" role="alert">
                  {failureMessages.length === 1 ? 'Dune reported: ' : `Dune reported ${failureMessages.length} distinct errors: `}
                  {failureMessages.join(' · ')}
                </p>
              ) : null;
            })()}
          </div>
        </div>
      </div>
      {rosterComparisonOpen && rosterComparison && <Modal onClose={() => setRosterComparisonOpen(false)} ariaLabel="GMGN top 100 comparison" dialogClassName="copytrade-roster-modal">
        <div className="copytrade-modal-head"><div><p className="eyebrow">GMGN ROSTER</p><h3>Top 100 wallet comparison</h3><small>{rosterComparison.currentCapturedAt ? `Current: ${formatFetchTime(rosterComparison.currentCapturedAt)}` : 'No saved snapshot'}</small></div><button className="secondary" onClick={() => setRosterComparisonOpen(false)}>Close</button></div>
        {!rosterComparison.baselineAvailable ? <p className="muted">No earlier GMGN list is saved, so there is no baseline for identifying new or departed wallets.</p> : <><p className="copytrade-roster-modal-summary"><strong>{rosterComparison.joined.length} new today</strong><span>·</span><strong>{rosterComparison.left.length} left the previous list</strong></p><div className="copytrade-roster-modal-left"><h4>Left the list</h4>{rosterComparison.left.length === 0 ? <p className="muted">None.</p> : <div>{rosterComparison.left.map((wallet) => <a key={wallet.walletAddress} href={`https://gmgn.ai/sol/address/${wallet.walletAddress}`} target="_blank" rel="noreferrer"><span>{wallet.rankPosition ? `#${wallet.rankPosition}` : '—'}</span>{wallet.name?.trim() || shortWalletAddress(wallet.walletAddress)} ↗</a>)}</div>}</div></>}
        <h4>Current ranked list</h4><div className="table-wrap copytrade-roster-modal-table"><table><thead><tr><th>Rank</th><th>Wallet</th><th>GMGN 30d PnL</th><th>Status</th></tr></thead><tbody>{rosterComparison.current.map((wallet) => { const isJoined = rosterComparison.joined.some((entry) => entry.walletAddress === wallet.walletAddress); return <tr key={wallet.walletAddress} className={isJoined ? 'copytrade-roster-new-row' : undefined}><td>#{wallet.rankPosition ?? '—'}</td><td><WalletIcon url={wallet.iconUrl} name={wallet.name || wallet.walletAddress} /><a href={`https://gmgn.ai/sol/address/${wallet.walletAddress}`} target="_blank" rel="noreferrer">{wallet.name?.trim() || shortWalletAddress(wallet.walletAddress)} ↗</a><small title={wallet.walletAddress}>{shortWalletAddress(wallet.walletAddress)}</small></td><td>{wallet.reportedPnl30d ?? '—'}</td><td>{isJoined ? <span className="copytrade-roster-new-badge">NEW TODAY</span> : 'Previously listed'}</td></tr>; })}</tbody></table></div>
      </Modal>}
      <div className="copytrade-top-export-row">
        <button className="secondary" onClick={() => void exportUnifiedTraderCsv()} disabled={exportBusy || sortedUnifiedTraderRows.length === 0}>{exportBusy ? 'Exporting CSV + details…' : 'Export table + details'}</button>
        {exportError && <p className="copytrade-refresh-error" role="alert">{exportError}</p>}
        <span>{researchWalletAddresses.length} wallets selected for Dune</span>
      </div>
      {rosterChange && <div className="copytrade-roster-change" role="status">
        <strong>{rosterChange.live ? 'GMGN roster source: live request' : 'GMGN roster source: saved snapshot'}</strong>
        {rosterChange.live
          ? <span>{rosterChange.joinedWallets.length} joined · {rosterChange.leftWallets.length} left · unchanged wallets remain in the saved history.</span>
          : <span>No new leaderboard was received, so no membership change was measured.</span>}
        {(rosterChange.joinedWallets.length > 0 || rosterChange.leftWallets.length > 0) && <Collapsible summary="Show wallet changes"><div className="copytrade-roster-change-lists">
          {rosterChange.joinedWallets.length > 0 && <div><b>Joined</b>{rosterChange.joinedWallets.map((wallet) => <a key={`joined-${wallet}`} href={`https://gmgn.ai/sol/address/${wallet}`} target="_blank" rel="noreferrer" title={wallet}>{shortWalletAddress(wallet)} ↗</a>)}</div>}
          {rosterChange.leftWallets.length > 0 && <div><b>Left</b>{rosterChange.leftWallets.map((wallet) => <a key={`left-${wallet}`} href={`https://gmgn.ai/sol/address/${wallet}`} target="_blank" rel="noreferrer" title={wallet}>{shortWalletAddress(wallet)} ↗</a>)}</div>}
        </div></Collapsible>}
      </div>}
      <div className="copytrade-table-overview">
        <span>{gmgnStatsFreshRows} / {copyTradeRows.length} summaries fresh · {duneMatchedTargets.toLocaleString()} usable Dune target legs</span>
      </div>
      <div className="copytrade-decision-filters">
        <label className="copytrade-filter-toggle"><input type="checkbox" checked={showDelaySurvivorsOnly} onChange={(event) => setShowDelaySurvivorsOnly(event.target.checked)} /> Show positive copy gains only</label>
        <span>{walletStatsTableLoading ? 'Loading…' : `${visibleDecisionRows.length} shown`}</span>
      </div>
      <Collapsible className="copytrade-column-picker" open={decisionColumnsOpen} onToggle={setDecisionColumnsOpen} summary="Columns">
        <div className="copytrade-column-picker-options">
          {DECISION_COLUMNS.map(({ key, label }) => <label key={key}><input type="checkbox" checked={decisionColumns[key]} onChange={() => toggleDecisionColumn(key)} /> {label}</label>)}
        </div>
      </Collapsible>
      <div className="table-wrap copytrade-table-wrap copytrade-decision-table-wrap" onClickCapture={(event) => { const target = event.target as HTMLElement; if (target.closest('a,button')) return; const row = target.closest('tr.copytrade-decision-row') as HTMLElement | null; const walletAddress = row?.dataset.walletAddress; if (walletAddress) openStatsDetail(walletAddress); }}><table className="copytrade-table copytrade-decision-table"><thead><tr>
        {decisionColumns.rank && <th onClick={() => toggleDecisionSort('rank')} className="sortable-header" title="Sort by current GMGN rank">Rank{decisionSortIndicator('rank')}</th>}
        {decisionColumns.gmgn && <th title="Open this wallet on GMGN">GMGN</th>}
        {decisionColumns.trader && <th onClick={() => toggleDecisionSort('name')} className="sortable-header" title="Sort by trader">Trader{decisionSortIndicator('name')}</th>}
        {decisionColumns.decision && <th onClick={() => toggleDecisionSort('verdict')} className="sortable-header" title="Sort by verdict">Decision{decisionSortIndicator('verdict')}</th>}
        {decisionColumns.freshness && <th title="Age of the GMGN stats response this row's verdict was computed from">Data freshness</th>}
        {decisionColumns.gmgnPnl && <th onClick={() => toggleDecisionSort('gmgnPnl')} className="sortable-header" title="GMGN-reported 30-day realized profit before delay, fees, slippage, or Dune matching">30d GMGN PnL{decisionSortIndicator('gmgnPnl')}</th>}
        {decisionColumns.gmgnTrades && <th title="Total GMGN-reported buy and sell transactions in the 30-day period">30d GMGN trades</th>}
        {decisionColumns.copyMedian && <th onClick={() => toggleDecisionSort('copyResult')} className="sortable-header" title="Median simulated return per copied trade after delay, fees, and slippage">30d copy median{decisionSortIndicator('copyResult')}</th>}
        {decisionColumns.copyCapital && <th onClick={() => toggleDecisionSort('copyCapital')} className="sortable-header" title="Sort by cash-constrained simulated ending value from $100">$100 after copy{decisionSortIndicator('copyCapital')}</th>}
        {decisionColumns.evidence && <th onClick={() => toggleDecisionSort('coverage')} className="sortable-header" title="Sort by Dune coverage">Evidence{decisionSortIndicator('coverage')}</th>}
        {decisionColumns.hold && <th onClick={() => toggleDecisionSort('activity')} className="sortable-header" title="Sort by typical holding time">Typical hold{decisionSortIndicator('activity')}</th>}
        {decisionColumns.under15s && <th title="Percentage of completed GMGN buy/sell pairs held for 15 seconds or less">GMGN ≤15s trades</th>}
        {decisionColumns.gmgnTags && <th title="Labels returned by GMGN for this wallet">GMGN tags</th>}
        <th aria-label="Details" />
      </tr></thead><tbody>
        {(walletStatsTableLoading ? [] : visibleDecisionRows).map((entry) =>{
          const delay = entry.delay;
          // Distinguishes, right on the "Needs more evidence" badge, whether more Dune fetching
          // could still help this wallet or whether it's a dead end — the same leg-level fields
          // that back the Dune copy test panel's own "no new targets" state (see
          // CopySimulationWalletReport's own comment), re-used here instead of a second
          // computation of the same concept.
          const duneLegsTotal = delay?.sim
            ? (delay.sim.pendingDuneTargets ?? 0) + (delay.sim.duneNoMatchTargets ?? 0) + (delay.sim.duneMatchedTargets ?? 0)
            : 0;
          const duneQueriedPercent = delay?.sim && duneLegsTotal > 0
            ? Math.round(((delay.sim.duneNoMatchTargets ?? 0) + (delay.sim.duneMatchedTargets ?? 0)) / duneLegsTotal * 100)
            : null;
          const simulatedMedian = delay?.sim?.simulatedMedianReturnPercent ?? null;
          const copyLabel = simulatedMedian === null ? delay?.reading ?? 'Not measured' : formatPct(simulatedMedian);
          const copyCapital = delay?.sim?.portfolio?.endingCapitalUsd ?? null;
          const evidenceLabel = delay?.sim ? `${delay.sim.copiedTrades.toLocaleString()} / ${delay.sim.roundTripsConsidered.toLocaleString()}` : 'Not measured';
          const coverageClass = delay?.coverage === null || delay?.coverage === undefined ? 'unknown' : delay.coverage >= 90 ? 'full' : delay.coverage >= 70 ? 'partial' : 'low';
          const verdictTooltip = entry.verdict === 'Tested candidate'
            ? 'Over the last 30 days: the typical copied trade was profitable (positive median, not just a positive total), every measured week was positive, and the wallet did not decline between its earlier and recent history — all on Dune coverage and sample size good enough to trust. Descriptive of the past only; not a prediction.'
            : entry.verdict === 'Watch'
              ? `Watch — ${entry.decisionReasons.join(' ')}`
              : entry.verdict === 'Needs data'
                ? 'Not a rejection: GMGN history or stats, Dune evidence, coverage, sample size, or cost data is incomplete. Fetch the top 100 again for GMGN data, then fetch Dune details for missing copy evidence.'
                : entry.verdict === 'Not copyable'
                  ? 'Typical holding time is shorter than the configured copy delay, so copying may arrive too late.'
                  : entry.verdict === 'Historical / stale'
                    ? 'GMGN history is older than 24 hours. Click the Fetch top 100 button to refresh the GMGN roster, history, and 30-day summaries; the verdict will recalculate automatically.'
                    : entry.verdict === 'Historical screen failed'
                      ? 'The current 30-day GMGN result is not positive. Fetch newer GMGN data if you want to recheck this period.'
                      : entry.verdict;
          const walletNameCandidate = entry.name?.trim() ?? '';
          const normalizedWalletName = walletNameCandidate.replace(/[.…]+$/g, '').toLowerCase();
          const walletName = walletNameCandidate && normalizedWalletName !== entry.row.walletAddress.toLowerCase() && !entry.row.walletAddress.toLowerCase().startsWith(normalizedWalletName) ? walletNameCandidate : null;
          const isWinner = primary30dWinner?.row.walletAddress === entry.row.walletAddress;
          return <tr key={`decision-${entry.row.walletAddress}`} data-wallet-address={entry.row.walletAddress} className={`copytrade-decision-row verdict-${entry.verdict.toLowerCase().replaceAll(' ', '-').replaceAll('/', '-')}${isWinner ? ' copytrade-decision-winner-row' : ''}`} onClick={() => openStatsDetail(entry.row.walletAddress)} onPointerUp={(event) => { if (!(event.target as HTMLElement).closest('a,button')) openStatsDetail(entry.row.walletAddress); }} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openStatsDetail(entry.row.walletAddress); } }}>
            {decisionColumns.rank && <td title="Current rank in the selected GMGN roster">{entry.row.rankHistory.currentRank === null ? '—' : `#${entry.row.rankHistory.currentRank}`}</td>}
            {decisionColumns.gmgn && <td><a className="copytrade-gmgn-link" href={`https://gmgn.ai/sol/address/${entry.row.walletAddress}`} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} title="Open this wallet on GMGN">View ↗</a></td>}
            {decisionColumns.trader && <td title="Trader name and wallet address."><WalletIcon url={entry.row.iconUrl} name={walletName || entry.row.walletAddress} /><span>{walletName ? <><strong>{walletName}</strong><small className="address-compact" title={entry.row.walletAddress}>{shortWalletAddress(entry.row.walletAddress)}</small></> : <strong className="address-compact" title={entry.row.walletAddress}>{shortWalletAddress(entry.row.walletAddress)}</strong>}<CopyAddressButton address={entry.row.walletAddress} /></span></td>}
            {decisionColumns.decision && <td><span title={decisionStateFor(entry.verdict) === 'needs_data' && duneQueriedPercent !== null ? `${verdictTooltip} Dune has been queried for ${duneQueriedPercent}% of this wallet's trade legs${duneQueriedPercent >= 100 ? ' (fully queried — another fetch cannot add new evidence)' : ' — fetching more Dune data could still help'}.` : verdictTooltip} aria-label={verdictTooltip} className={`copytrade-verdict-badge ${DECISION_STATES[decisionStateFor(entry.verdict)].tone}`}>{DECISION_STATES[decisionStateFor(entry.verdict)].label}{decisionStateFor(entry.verdict) === 'needs_data' && duneQueriedPercent !== null && <small className="copytrade-verdict-dune-percent"> · Dune {duneQueriedPercent}%</small>}</span></td>}
            {decisionColumns.freshness && <td title={`GMGN 30d stats: ${entry.long?.fetchedAt ? formatFetchTime(entry.long.fetchedAt) : 'not available'}. Dune 30d simulation: ${entry.duneEvidenceAt ? formatFetchTime(entry.duneEvidenceAt) : 'not available'}. Both must be current for a candidate verdict.`}><span className={!entry.freshStats || !entry.duneFresh ? 'copytrade-warning-text' : ''}>{entry.long?.fetchedAt ? `GMGN ${freshnessLabel(entry.long.fetchedAt).text}` : 'GMGN 30d missing'} · {entry.duneEvidenceAt ? `Dune ${freshnessLabel(entry.duneEvidenceAt).text}` : 'Dune 30d missing'}</span></td>}
            {decisionColumns.gmgnPnl && <td title="GMGN-reported 30-day realized profit before delay, fees, slippage, or Dune matching."><strong className={entry.historical30d === null ? '' : entry.historical30d >= 0 ? 'positive' : 'negative'}>{entry.long?.realizedProfit === null || entry.long?.realizedProfit === undefined ? formatPct(entry.historical30d) : formatUsd(entry.long.realizedProfit)}</strong>{entry.long?.realizedProfit !== null && entry.long?.realizedProfit !== undefined && <small>{formatPct(entry.historical30d)} GMGN return</small>}</td>}
            {decisionColumns.gmgnTrades && <td title="Total GMGN-reported buy and sell transactions in the 30-day period."><strong>{entry.long?.buyCount === null || entry.long?.buyCount === undefined || entry.long?.sellCount === null || entry.long?.sellCount === undefined ? '—' : formatCount(entry.long.buyCount + entry.long.sellCount)}</strong><small>{entry.long?.buyCount === null || entry.long?.buyCount === undefined || entry.long?.sellCount === null || entry.long?.sellCount === undefined ? 'GMGN count unavailable' : `${formatCount(entry.long.buyCount)} buys · ${formatCount(entry.long.sellCount)} sells`}</small></td>}
            {decisionColumns.copyMedian && <td title="Median simulated return per copied trade after the configured copy delay, fees, and slippage. The winner panel's portfolio P&L compounds the full trade path, so it can be much larger."><strong className={entry.verdict === 'Tested candidate' && simulatedMedian !== null ? (simulatedMedian >= 0 ? 'positive' : 'negative') : ''}>{copyLabel}</strong><small>{delay?.edge === null || delay?.edge === undefined ? 'After delay and costs' : `${delay.edge.toFixed(0)}% edge kept`}</small></td>}
            {decisionColumns.copyCapital && <td title="Cash-constrained simulated ending value from a $100 starting portfolio after delay, fees, slippage, and gas."><strong className={copyCapital !== null ? (copyCapital >= 100 ? 'positive' : 'negative') : ''}>{formatCopyCapital(copyCapital)}</strong></td>}
            {decisionColumns.evidence && <td title={`Dune price matches: copied trades divided by eligible round trips. ${delay?.coverage === null || delay?.coverage === undefined ? 'Coverage percentage is not available.' : `${delay.coverage.toFixed(0)}% usable prices.`}`}><strong><i className={`dune-coverage-dot ${coverageClass}`} /> {evidenceLabel}</strong></td>}
            {decisionColumns.hold && <td title={`Median time this trader holds a position. Evidence is ${entry.freshStats ? 'fresh' : 'older than 24 hours'}.`}><strong>{formatHoldingTime(delay?.hold ?? null)}</strong></td>}
            {decisionColumns.under15s && (() => {
              const fast = entry.row.riskEvidence?.under15SecondsPercent ?? null;
              const fastCount = entry.row.riskEvidence?.under15SecondsCount ?? 0;
              const paired = entry.row.riskEvidence?.pairedTradeCount ?? 0;
              return <td title="GMGN-derived percentage of completed buy/sell pairs held for 15 seconds or less. Only pairs with both timestamps are counted; incomplete or truncated history is not included."><strong>{fast === null ? '—' : `${fast}%`}</strong><small>{fast === null ? 'No paired trades' : `${fastCount.toLocaleString()} / ${paired.toLocaleString()} pairs`}</small></td>;
            })()}
            {decisionColumns.gmgnTags && <td title="These are GMGN-provided wallet labels, not labels inferred by this application. Hover a tag for a short explanation."><span className="copytrade-tag-list">{(entry.row.gmgnTags ?? entry.row.riskFlags).length > 0 ? (entry.row.gmgnTags ?? entry.row.riskFlags).map((tag) => <GmgnTag key={tag} tag={tag} />) : '—'}</span></td>}
            <td className="copytrade-decision-chevron"><button type="button" className="copytrade-detail-button" onPointerUp={(event) => { event.stopPropagation(); openStatsDetail(entry.row.walletAddress); }} onClick={(event) => { event.stopPropagation(); openStatsDetail(entry.row.walletAddress); }} title="Open full trader details." aria-label="Open trader details">›</button></td>
          </tr>;
        })}
        {sortedUnifiedTraderRows.length === 0 && <tr><td colSpan={DECISION_COLUMNS.filter(({ key }) => decisionColumns[key]).length + 1} className="muted">{walletStatsTableLoading ? <span className="copytrade-loading-inline"><span className="loading-spinner" aria-hidden="true" /> Loading roster and GMGN summaries…</span> : 'Load a roster and fetch GMGN summaries to build the candidate list.'}</td></tr>}
      </tbody></table></div>
      <Collapsible className="copytrade-maintenance" open={maintenanceOpen || statsDetailWallet !== null} onToggle={setMaintenanceOpen} summary="Trader evidence">
      {statsDetailWallet && (() => {
        const periods = gmgnStatsByWallet.get(statsDetailWallet);
        const detail7d = periods?.get('7d') ?? null;
        const detail30d = periods?.get('30d') ?? null;
        const detail = periods?.get('30d') ?? periods?.get('7d') ?? null;
        const row = copyTradeRows.find((entry) => entry.walletAddress === statsDetailWallet);
        const title = row?.name?.trim() || shortAddress(statsDetailWallet);
        const money = (value: number | null) => value === null ? '—' : formatUsd(value);
        // Bucket counts are GMGN's own outcome distribution. Rendered as a proportional bar so
        // the shape is readable at a glance — a wallet whose wins are all 0-2x is a different
        // animal from one carried by a handful of >5x, even at identical win rates.
        const b = detail?.buckets;
        const bucketRows = b ? ([
          { label: 'Lost over 50%', value: b.lossOver50, tone: 'negative' },
          { label: 'Lost 0-50%', value: b.loss50to0, tone: 'negative' },
          { label: 'Gained 0-2x', value: b.gain0to2x, tone: 'positive' },
          { label: 'Gained 2-5x', value: b.gain2to5x, tone: 'positive' },
          { label: 'Gained over 5x', value: b.gainOver5x, tone: 'positive' },
        ]) : [];
        const bucketTotal = bucketRows.reduce((sum, entry) => sum + (entry.value ?? 0), 0);
        const historyCutoffSeconds = Math.floor(Date.now() / 1000) - copyTradePeriodDays * 24 * 60 * 60;
        const allSellHistoryRows = statsDetailTrades?.rows.filter((trade) => trade.eventType.toLowerCase().startsWith('sell')) ?? [];
        const visibleSellHistoryRows = (showOnlyCurrentHistory ? allSellHistoryRows.filter((trade) => trade.observedTimestamp >= historyCutoffSeconds) : allSellHistoryRows)
          .sort((left, right) => left.observedTimestamp - right.observedTimestamp || left.id - right.id);
        const detailDecision = unifiedTraderRows.find((entry) => entry.row.walletAddress === statsDetailWallet);
        const detailPortfolio = detailDecision?.delay?.sim?.portfolio;
        const detailTradePath = detailPortfolio?.tradeCapitalPath?.map((point) => ({ day: point.day, label: `Trade ${point.trade}`, tradeId: point.tradeId, capitalUsd: point.capitalUsd })) ?? [];
        const chartTradeIds = new Set(detailTradePath.map((point) => point.tradeId).filter((tradeId): tradeId is number => tradeId !== undefined));
        const tableTradeIds = new Set(visibleSellHistoryRows.map((trade) => trade.id));
        const canReconcileTrades = detailTradePath.length > 0 && detailTradePath.every((point) => point.tradeId !== undefined);
        const missingFromChart = canReconcileTrades ? visibleSellHistoryRows.filter((trade) => !chartTradeIds.has(trade.id)) : [];
        const missingFromTable = canReconcileTrades ? detailTradePath.filter((point) => point.tradeId !== undefined && !tableTradeIds.has(point.tradeId)) : [];
        return <Modal onClose={() => setStatsDetailWallet(null)} ariaLabel={`GMGN saved statistics for ${title}`} dialogClassName="copytrade-stats-modal">
            <div className="copytrade-modal-head">
              <div>
                <p className="eyebrow">GMGN SAVED RESPONSE</p>
                <h3>{title}</h3>
                <small className="address-compact">{statsDetailWallet}<CopyAddressButton address={statsDetailWallet} /></small>
              </div>
              <button className="secondary" onClick={() => setStatsDetailWallet(null)}>Close</button>
            </div>
            {(() => {
              const decision = unifiedTraderRows.find((entry) => entry.row.walletAddress === statsDetailWallet);
              const decisionSimulation = decision?.delay?.sim;
              return decision ? <div className="copytrade-evidence-summary">
                <div><span>Decision</span><strong className={`copytrade-verdict-badge ${decision.verdict === 'Tested candidate' ? 'pass' : decision.verdict === 'Not copyable' || decision.verdict === 'Historical screen failed' ? 'fail' : 'pending'}`}>{decision.verdict}</strong></div>
                <div><span>7-day history</span><strong>{formatPct(decision.historical7d)}</strong></div>
                <div><span>Delayed copy result</span><strong>{formatPct(decisionSimulation?.simulatedMedianReturnPercent ?? null)}</strong></div>
                <div><span>Dune evidence</span><strong>{decision.coverage === null ? 'Not measured' : `${decision.coverage.toFixed(0)}% usable`}</strong></div>
                <p>{decision.verdict === 'Tested candidate' ? 'This row passed the current historical, coverage, freshness, and delayed-copy gates.' : decision.verdict === 'Needs data' ? 'This trader is not rejected; the evidence is incomplete or stale.' : decision.verdict === 'Not copyable' ? 'The typical holding time is shorter than the configured copy delay.' : 'This is a historical or data-quality result, not a final follow recommendation.'}</p>
              </div> : null;
            })()}
            {(() => {
              if (!detailPortfolio) return null;
              const path = detailTradePath.length > 0 ? [{ day: 'start', label: 'Start', capitalUsd: detailPortfolio.startingCapitalUsd }, ...detailTradePath] : detailPortfolio.capitalPath;
              const reconciliationWarning = !canReconcileTrades || missingFromChart.length > 0 || missingFromTable.length > 0;
              return <div className="copytrade-modal-block copytrade-capital-chart-block">
                <div className="copytrade-modal-block-head"><p className="compact-info-line"><span>$100 after-copy path</span><InfoTip label="$100 after-copy path" text="The simulated cash balance after each completed copied trade, using the configured delay, fees, slippage, gas, fixed $10 stake, and position limit. Older saved runs may show one point per day until they are recomputed." /></p><strong>{detailTradePath.length > 0 ? `${detailTradePath.length} completed trades` : 'Saved daily path'}</strong><small className="copytrade-chart-zoom-hint">Scroll over chart to zoom</small></div>
                <div className={`copytrade-trade-reconciliation${reconciliationWarning ? ' warning' : ''}`}><strong>Trade reconciliation</strong><span>Chart: {detailTradePath.length} · Table: {visibleSellHistoryRows.length} sells</span><small>{!canReconcileTrades ? 'This saved chart predates trade IDs, so its points cannot be matched row-by-row.' : missingFromChart.length === 0 && missingFromTable.length === 0 ? 'Every visible sell row has a matching chart point.' : `${missingFromChart.length} table row${missingFromChart.length === 1 ? '' : 's'} missing from chart · ${missingFromTable.length} chart point${missingFromTable.length === 1 ? '' : 's'} missing from table.`} Partial sells split the fixed stake proportionally; open positions remain valued at cost until sold.</small></div>
                <div className="copytrade-capital-chart-scroll"><CapitalPathChart points={path} activeTradeId={statsDetailTradeId} onTradeHover={(tradeId) => highlightStatsTrade(tradeId, tradeId !== null)} zoomable /></div>
              </div>;
            })()}
            <div className="copytrade-modal-block">
              <p className="eyebrow">GMGN PERIOD RESULTS</p>
              <div className="copytrade-modal-period-grid">
                {[['7-day', detail7d], ['30-day', detail30d]].map(([label, period]) => {
                  const stats = period as GmgnAggregateStats | null;
                  return <div className="copytrade-modal-period" key={label as string}><strong>{label as string}</strong>{stats ? <><span>Realized PnL <b>{formatPct(stats.realizedProfitPnlPercent)}</b></span><span>Profit <b>{money(stats.realizedProfit)}</b></span><span>Win rate <b>{formatPct(stats.winRatePercent)}</b></span><span>Buys / sells <b>{formatCount(stats.buyCount)} / {formatCount(stats.sellCount)}</b></span><span>Tokens <b>{formatCount(stats.tokenCount)}</b></span><span>Average hold <b>{formatHoldingTime(stats.averageHoldingPeriodSeconds)}</b></span><small>Fetched {formatTime(stats.fetchedAt)}</small></> : <span className="muted">Not fetched</span>}</div>;
                })}
              </div>
            </div>
            {!detail ? <p className="muted">No GMGN statistics response has been saved for this trader yet. Run “Fetch missing stats”.</p> : <>
              <div className="copytrade-modal-meta">
                <span>Period <b>{detail.period}</b></span>
                <span>Fetched <b>{formatTime(detail.fetchedAt)}</b></span>
                {detail.twitterName && <span>Twitter <b>@{detail.twitterName}</b></span>}
                {detail.walletCreatedAt !== null && <span>Wallet created <b>{formatTime(new Date(detail.walletCreatedAt * 1000).toISOString())}</b></span>}
              </div>
              {detail.tags.length > 0 && <div className="copytrade-modal-tags">{detail.tags.map((tag) => <GmgnTag key={tag} tag={tag} />)}</div>}

              <div className="copytrade-modal-metrics">
                <div><strong className={(detail.realizedProfit ?? 0) >= 0 ? 'positive' : 'negative'}>{money(detail.realizedProfit)}</strong><span>Realized profit</span></div>
                <div><strong className={(detail.realizedProfitPnlPercent ?? 0) >= 0 ? 'positive' : 'negative'}>{formatPct(detail.realizedProfitPnlPercent)}</strong><span>Return on cost</span></div>
                <div><strong>{formatPct(detail.winRatePercent)}</strong><span>Win rate</span></div>
                <div><strong>{formatHoldingTime(detail.averageHoldingPeriodSeconds)}</strong><span>Avg hold (GMGN)</span></div>
              </div>

              <div className="copytrade-modal-block copytrade-full-history-block">
                <div className="copytrade-modal-block-head"><p className="compact-info-line"><span>Stored sell history</span><InfoTip label="Stored sell history" text="Only sell rows are shown here. They are the rows that close positions and provide realized results; the underlying buy rows remain saved in SQLite for matching and audit." /></p><strong>{statsDetailTradesLoading ? 'Loading…' : `${visibleSellHistoryRows.length.toLocaleString()} sells`}</strong></div>
                <label className="copytrade-filter-toggle"><input type="checkbox" checked={showOnlyCurrentHistory} onChange={(event) => setShowOnlyCurrentHistory(event.target.checked)} /> Only show sells from the current {copyTradePeriodDays}-day window</label>
                {statsDetailTradesLoading ? <p className="copytrade-history-loading"><span className="loading-dot" /> Loading saved trades…</p> : statsDetailTrades && statsDetailTrades.rows.length > 0 ? (() => {
                  const holds = holdingSecondsBySellId(statsDetailTrades.rows);
                  const sellRows = visibleSellHistoryRows;
                  return sellRows.length > 0 ? <DataTable
                    wrapClassName="table-wrap copytrade-history-table-wrap"
                    tableClassName="copytrade-table copytrade-history-table"
                    rows={sellRows}
                    getRowKey={(trade) => trade.id}
                    rowProps={(trade) => ({ 'data-detail-trade-id': trade.id, className: statsDetailTradeId === trade.id ? 'copytrade-trade-row-active' : '', onMouseEnter: () => highlightStatsTrade(trade.id), onMouseLeave: () => highlightStatsTrade(null) })}
                    columns={[
                      { key: 'index', header: '#', render: (_trade, index) => index + 1 },
                      { key: 'sellTime', header: 'Sell time', render: (trade) => formatTime(new Date(trade.observedTimestamp * 1000).toISOString()) },
                      { key: 'token', header: 'Token', render: (trade) => <><strong>{trade.tokenSymbol?.trim() || shortAddress(trade.tokenAddress)}</strong><small className="address-compact">{shortAddress(trade.tokenAddress)}</small></> },
                      { key: 'held', header: 'Held', render: (trade) => formatHoldingTime(holds.get(trade.id) ?? null) },
                      { key: 'pnl', header: 'P/L', cellProps: (trade) => { const pnl = tradeReturnPercent(trade.eventType, trade.costUsd, trade.buyCostUsd); return { className: pnl === null ? '' : pnl >= 0 ? 'positive' : 'negative', title: 'Realized return using the stored sell proceeds and buy cost basis' }; }, render: (trade) => formatSignedPct(tradeReturnPercent(trade.eventType, trade.costUsd, trade.buyCostUsd)) },
                      { key: 'transaction', header: 'Transaction', render: (trade) => <><span className="address-compact" title={trade.txHash}>{shortAddress(trade.txHash)}</span><CopyAddressButton address={trade.txHash} /></> },
                    ]}
                  /> : <p className="muted">No stored sell rows for this wallet.</p>;
                })() : <p className="muted">No stored trade rows for this wallet.</p>}
              </div>

              <div className="copytrade-modal-block copytrade-history-notes">
                <p className="muted">This shows the sell rows available locally. The coverage note below explains if the original provider response was capped or interrupted.</p>
                <p className="muted">Only stored sell rows are shown because they close a position and provide the realized result. Hold is matched to the earlier stored buy for the same token; “—” means that buy row was not saved.</p>
                {statsDetailTrades?.coverage && <small className="muted">Fetch record: {statsDetailTrades.coverage.requestsUsed} provider requests · {statsDetailTrades.coverage.truncated ? 'history was truncated' : 'fetch was not marked truncated'}{statsDetailTrades.coverage.stopReason ? ` · ${statsDetailTrades.coverage.stopReason}` : ''} · saved {formatTime(statsDetailTrades.coverage.updatedAt)}</small>}
              </div>

              {bucketTotal > 0 && <div className="copytrade-modal-block">
                <p className="compact-info-line"><span>Outcome distribution</span><InfoTip label="Outcome distribution" text="GMGN's own count of positions by result. This is the closest thing the aggregate endpoint gives to a return histogram — it shows whether gains come from many small wins or a few large ones." /></p>
                {bucketRows.map((entry) => <div className="copytrade-bucket-row" key={entry.label}>
                  <label>{entry.label}</label>
                  <div className="copytrade-bucket-track"><i className={entry.tone} style={{ width: `${((entry.value ?? 0) / bucketTotal) * 100}%` }} /></div>
                  <b>{entry.value === null ? '—' : formatCount(entry.value)}</b>
                </div>)}
                <small className="muted">{formatCount(bucketTotal)} positions counted{detail.tokenCount !== null ? ` · ${formatCount(detail.tokenCount)} distinct tokens traded` : ''}</small>
              </div>}

              <div className="copytrade-modal-block">
                <p className="compact-info-line"><span>Flow and costs</span><InfoTip label="Flow and costs" text="Gross amounts GMGN reports for this window. Fees are already reflected in realized profit; they are shown separately so their size is visible." /></p>
                <dl className="copytrade-modal-grid">
                  <div><dt>Buys</dt><dd>{detail.buyCount === null ? '—' : formatCount(detail.buyCount)}</dd></div>
                  <div><dt>Sells</dt><dd>{detail.sellCount === null ? '—' : formatCount(detail.sellCount)}</dd></div>
                  <div><dt>Bought cost</dt><dd>{money(detail.boughtCost)}</dd></div>
                  <div><dt>Sold income</dt><dd>{money(detail.soldIncome)}</dd></div>
                  <div><dt>Buy fees</dt><dd>{money(detail.boughtFee)}</dd></div>
                  <div><dt>Sell fees</dt><dd>{money(detail.soldFee)}</dd></div>
                  <div><dt>SOL balance</dt><dd>{detail.nativeBalance === null ? '—' : `${detail.nativeBalance.toFixed(2)} SOL`}</dd></div>
                  <div><dt>Last activity</dt><dd>{detail.lastTimestamp === null ? '—' : formatTime(new Date(detail.lastTimestamp * 1000).toISOString())}</dd></div>
                </dl>
              </div>
              <small className="muted">Every value here is GMGN's own reported figure for this wallet, saved as-is. It describes what the trader did — not what copying them would have returned.</small>
            </>}
        </Modal>;
      })()}
      <div className="copytrade-delay-details">
        {(() => {
          const combinedStatsRows = visibleCombinedStatsRows.map(({ row, delay: entry }) => {
            const periods = gmgnStatsByWallet.get(row.walletAddress);
            const short = periods?.get('7d');
            const long = periods?.get('30d');
            const leaderboard = gmgnLeaderboardMetrics[row.walletAddress];
            const name = row.name?.trim() || shortAddress(row.walletAddress);
            const simulatedMedian = entry?.sim?.simulatedMedianReturnPercent ?? null;
            const copyResult = simulatedMedian === null ? entry?.reading ?? 'Not measured' : formatPct(simulatedMedian);
            const evidencePercent = entry?.sim && entry.sim.roundTripsConsidered > 0 ? entry.sim.copiedTrades / entry.sim.roundTripsConsidered * 100 : entry?.coverage ?? null;
            const evidenceCoverage: DuneCoverageSummary | undefined = entry?.sim && entry.sim.roundTripsConsidered > 0 ? { matched: entry.sim.copiedTrades, eligible: entry.sim.roundTripsConsidered, percent: evidencePercent } : undefined;
            return { row, entry, short, long, leaderboard, name, copyResult, evidencePercent, evidenceCoverage };
          });
          return <DataTable
            wrapClassName="table-wrap copytrade-table-wrap"
            tableClassName="copytrade-table copytrade-delay-table copytrade-combined-stats-table"
            rows={combinedStatsRows}
            getRowKey={(r) => `combined-${r.row.walletAddress}`}
            emptyMessage={showDelaySurvivorsOnly ? 'No wallets currently meet the delay-survivor rule.' : 'Load stats first.'}
            rowProps={(r) => ({
              className: `${r.entry?.survivedDelay ? 'copytrade-delay-survivor ' : ''}copytrade-row-clickable`,
              role: 'button',
              tabIndex: 0,
              onClick: (event) => { if ((event.target as HTMLElement).closest('button')) return; setStatsDetailWallet(r.row.walletAddress); },
              onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') setStatsDetailWallet(r.row.walletAddress); },
              title: 'Open saved wallet and trade details',
            })}
            columns={[
              { key: 'trader', header: 'Trader', render: (r) => <><strong>{r.name}</strong>{r.entry?.survivedDelay && <span className="copytrade-delay-badge">✓ survived</span>}<small className="address-compact" title={r.row.walletAddress}>{shortAddress(r.row.walletAddress)}</small><CopyAddressButton address={r.row.walletAddress} /></> },
              { key: 'pnl1d', header: '1d PnL', cellProps: (r) => ({ className: leaderboardMetricTone(r.leaderboard?.pnl1d) }), render: (r) => formatLeaderboardMetric(r.leaderboard?.pnl1d) },
              { key: 'pnl7d', header: '7d PnL', cellProps: (r) => ({ className: leaderboardMetricTone(r.leaderboard?.pnl7d) }), render: (r) => formatLeaderboardMetric(r.leaderboard?.pnl7d) },
              { key: 'pnl30d', header: '30d PnL', cellProps: (r) => ({ className: leaderboardMetricTone(r.leaderboard?.pnl30d) }), render: (r) => formatLeaderboardMetric(r.leaderboard?.pnl30d) },
              { key: 'win7d', header: '7d win', render: (r) => formatPct(r.short?.winRatePercent ?? null) },
              { key: 'win30d', header: '30d win', render: (r) => formatPct(r.long?.winRatePercent ?? null) },
              { key: 'trades7d', header: 'Trades 7d', render: (r) => <>{r.entry?.totalTrades7d == null ? '—' : formatCount(r.entry.totalTrades7d)}<span className={`dune-coverage-dot ${duneCoverageClass(r.entry?.coverage7d ?? null)}`} /></> },
              { key: 'trades30d', header: 'Trades 30d', render: (r) => <>{r.entry?.totalTrades30d == null ? '—' : formatCount(r.entry.totalTrades30d)}<span className={`dune-coverage-dot ${duneCoverageClass(r.entry?.coverage30d ?? null)}`} /></> },
              { key: 'medianHold', header: 'Median hold', render: (r) => formatHoldingTime(r.entry?.hold ?? null) },
              { key: 'delayHold', header: `${copySimulation?.assumptions.copierDelaySeconds ?? 15}s delay / hold`, cellProps: (r) => ({ className: r.entry?.impossible ? 'negative' : r.entry?.fragile ? 'copytrade-warning-text' : '' }), render: (r) => r.entry?.delayShare == null ? '—' : `${r.entry.delayShare.toFixed(0)}%` },
              { key: 'copyTest', header: '30d copy test', cellProps: (r) => ({ className: r.entry?.survivedDelay ? 'positive' : r.entry?.impossible ? 'negative' : '' }), render: (r) => r.copyResult },
              { key: 'duneCoverage', header: 'Dune coverage', cellProps: (r) => ({ title: r.entry ? duneCoverageLabel(r.evidenceCoverage, 'copy simulation') : 'No Dune result' }), render: (r) => r.evidencePercent == null ? '—' : `${r.evidencePercent.toFixed(0)}%` },
              { key: 'reading', header: 'Reading', cellProps: (r) => ({ title: r.entry?.sim?.coverageStatusReason, className: r.entry?.impossible ? 'negative' : r.entry?.fragile ? 'copytrade-warning-text' : r.entry?.survivedDelay ? 'positive' : '' }), render: (r) => r.entry?.reading ?? 'No delay evidence' },
            ]}
          />;
        })()}
        {selectedCopyDelayEntry && <Modal onClose={() => setSelectedCopyDelayWallet(null)} ariaLabel={`Trade details for ${selectedCopyDelayEntry.name}`} dialogClassName="copytrade-trade-detail-modal">
            <div className="copytrade-modal-head"><div><p className="eyebrow">ROUND-TRIP AUDIT</p><h3>{selectedCopyDelayEntry.name}</h3><small className="address-compact">{selectedCopyDelayEntry.row.walletAddress}<CopyAddressButton address={selectedCopyDelayEntry.row.walletAddress} /></small></div><button className="secondary" onClick={() => setSelectedCopyDelayWallet(null)}>Close</button></div>
            <p className="muted">Each row is one stored buy→sell round trip. Copy result uses the configured {copySimulation?.assumptions.copierDelaySeconds ?? 15}s delay, Dune-matched prices, fees, and slippage. Opening this dialog reads SQLite only.</p>
            {!selectedCopyDelayEntry.sim ? <p className="muted">No simulation report is stored for this wallet yet. Fetch missing Dune prices first.</p> : <>
              <div className="copytrade-modal-metrics"><div><strong>{selectedCopyDelayEntry.sim.trades.length.toLocaleString()}</strong><span>round trips stored</span></div><div><strong>{selectedCopyDelayEntry.sim.copiedTrades.toLocaleString()}</strong><span>copy simulations</span></div><div><strong>{selectedCopyDelayEntry.sim.missedTrades.toLocaleString()}</strong><span>missing Dune matches</span></div><div><strong>{formatPct(selectedCopyDelayEntry.sim.coverageRatePercent)}</strong><span>coverage</span></div></div>
              <DataTable
                wrapClassName="table-wrap copytrade-trade-detail-wrap"
                tableClassName="copytrade-table copytrade-trade-detail-table"
                rows={selectedCopyDelayEntry.sim.trades}
                getRowKey={(trade, index) => `${trade.tokenAddress}-${trade.buyAt}-${index}`}
                columns={[
                  { key: 'token', header: 'Token', render: (trade) => <><strong>{trade.tokenSymbol?.trim() || shortAddress(trade.tokenAddress)}</strong><small className="address-compact">{shortAddress(trade.tokenAddress)}</small></> },
                  { key: 'held', header: 'Held', cellProps: (trade) => ({ title: `${trade.buyAt} → ${trade.sellAt}` }), render: (trade) => formatHoldingTime(trade.holdSeconds) },
                  { key: 'wallet', header: 'Wallet', cellProps: (trade) => ({ className: trade.walletReturnPercent !== null && trade.walletReturnPercent >= 0 ? 'positive' : 'negative' }), render: (trade) => formatPct(trade.walletReturnPercent) },
                  { key: 'copied', header: 'Copied', cellProps: (trade) => ({ className: trade.simulatedReturnPercent !== null && trade.simulatedReturnPercent >= 0 ? 'positive' : trade.simulatedReturnPercent !== null ? 'negative' : '' }), render: (trade) => formatPct(trade.simulatedReturnPercent) },
                  { key: 'edge', header: 'Edge kept', render: (trade) => trade.edgeKeptPercent == null ? '—' : `${trade.edgeKeptPercent.toFixed(1)}%` },
                  { key: 'lag', header: 'Entry / exit lag', render: (trade) => trade.entryGapSeconds === null && trade.exitGapSeconds === null ? '—' : `${trade.entryGapSeconds?.toFixed(1) ?? '—'}s / ${trade.exitGapSeconds?.toFixed(1) ?? '—'}s` },
                  { key: 'status', header: 'Status', cellProps: (trade) => ({ title: `${trade.entryMatchedAt ?? 'no entry match'} · ${trade.exitMatchedAt ?? 'no exit match'}` }), render: (trade) => trade.status.replaceAll('_', ' ') },
                ]}
              />
            </>}
        </Modal>}
      </div>
      </Collapsible>
    </section>}
    {copyTradeSubTab === 'wallet-stats' && <Collapsible className="copytrade-advanced-diagnostics" open={diagnosticsOpen} onToggle={setDiagnosticsOpen} summary="Advanced diagnostics">
      <p className="muted">Research-maintenance tooling, not a recommendation view. Use the canonical table above to decide who to follow; use this to investigate why a wallet reads the way it does.</p>
      <div id="copytrade-elimination" className="copytrade-temp-panel">
      <div className="panel-heading"><div><p className="eyebrow">TEMPORARY · PRE-SIMULATION TRIAGE</p><h2>Which wallets can we stop chasing?</h2></div><span className="tag">EXPERIMENTAL</span></div>
      <p className="muted">
        Judged over 30 days of history, matching the GMGN 30-day P&amp;L this eliminates on. Eliminates
        a wallet only when its data is trustworthy — GMGN history complete and not failed, at least
        50 trades, at least 90% Dune coverage over a real round-trip sample, <em>and</em> a
        negligible hidden-loss reading — <em>and</em> the visible result is bad. Coverage does not
        have to be perfect, but what is missing has to be shown not to flatter the wallet: the
        "does the gap matter?" column checks that per wallet using the wallet's own GMGN outcomes,
        which exist for every trade whether Dune matched it or not. A wallet whose gap could still
        be hiding the trades that change the verdict is never eliminated. Silent GMGN
        omissions (rows GMGN never returned at all) are not modeled here — see <code>progress.md</code>.
      </p>
      <button className="secondary" disabled={eliminationLoading} onClick={() => void loadElimination()}>{eliminationLoading ? 'Checking…' : 'Run triage'}</button>
      {eliminationError && <p className="error">{eliminationError}</p>}
      {eliminationReport && <>
        {(() => {
          // A saved verdict computed before the latest fetch is describing data that no longer
          // exists. Comparing against the real fetch timestamps makes that visible instead of
          // relying on the reader to remember whether they re-ran it.
          const generatedMs = Date.parse(eliminationReport.generatedAt);
          const newerData = [visibleWalletScreenSummary?.lastFetchedAt, copySimulationRunStatus?.finishedAt]
            .filter((value): value is string => typeof value === 'string' && value.length > 0)
            .some((value) => Date.parse(value) > generatedMs);
          return newerData
            ? <p className="copytrade-status-warning">Out of date — GMGN or Dune data has been fetched since this triage ran ({formatFetchTime(eliminationReport.generatedAt)}). Run triage again before trusting these verdicts.</p>
            : <p className="muted">Current result from {formatFetchTime(eliminationReport.generatedAt)} over {eliminationReport.periodDays ?? 30} days of history — computed from SQLite.</p>;
        })()}
        <div className="copytrade-screening-summary-facts">
          <span><strong>{eliminationReport.totalWallets}</strong> wallets checked</span>
          <span><strong>{eliminationReport.eliminated.length}</strong> eliminated</span>
          <span><strong>{eliminationReport.surviving.length}</strong> surviving</span>
          <span><strong>{eliminationReport.survivorsNeedingDune.length}</strong> survivors still need Dune coverage</span>
        </div>
        <div className="copytrade-primary-winner">
          <div><p className="eyebrow">ESTIMATED REFETCH TIME FOR SURVIVORS</p>
            <strong>{formatSeconds(eliminationReport.duneEstimate.estimatedSeconds)}</strong>
            <small> for {eliminationReport.duneEstimate.targetsNeeded.toLocaleString()} known Dune targets ({eliminationReport.duneEstimate.basis === 'measured' ? `measured from ${eliminationReport.duneEstimate.runsCounted} recent runs` : 'seeded estimate, no completed runs yet'} · {eliminationReport.duneEstimate.secondsPerTarget}s/target)</small>
            {eliminationReport.survivorsNeverSimulatedCount > 0 && <small className="warning"> Lower bound only — {eliminationReport.survivorsNeverSimulatedCount} survivor(s) have never been simulated at all, so their Dune workload isn't counted above.</small>}
          </div>
        </div>
        <Collapsible open summary={`Surviving wallets (${eliminationReport.surviving.length})`}>
          <div className="table-wrap">
            <table><thead><tr><th>Trader</th><th>Trades</th><th>Dune coverage</th><th>Does the gap matter?</th><th>30d P&amp;L</th><th>Delayed-copy median</th><th>Trustworthy?</th></tr></thead>
              <tbody>{eliminationReport.surviving.map((entry) => { const gap = entry.coverageGap; const riskLabel = HIDDEN_LOSS_LABELS[gap?.hiddenLossRisk ?? 'unknown']; return <tr key={entry.walletAddress}>
                <td>{entry.name?.trim() || shortAddress(entry.walletAddress)}</td>
                <td>{entry.trades.toLocaleString()}</td>
                <td>{entry.duneCoveragePercent === null ? 'Not yet simulated' : `${entry.duneCoveragePercent.toFixed(0)}%`}</td>
                <td className={riskLabel.tone} title={gap === null || gap.hiddenLossRisk === 'unknown'
                  ? 'Not enough measured and unmeasured trades to compare.'
                  : `Measured trades lose ${gap.shownLossRatePercent ?? '—'}% of the time; including the unmeasured ones the real rate is ${gap.trueLossRatePercent ?? '—'}%. Based on the wallet's own GMGN outcomes, which exist for every trade. Big-win direction (separate signal): ${gap.gapPercentagePoints === null ? 'n/a' : `${gap.gapPercentagePoints > 0 ? '+' : ''}${gap.gapPercentagePoints}pp`}.`}>
                  {riskLabel.label}
                  {gap && gap.hiddenLossRisk !== 'unknown' && gap.shownLossRatePercent !== null && gap.trueLossRatePercent !== null
                    && <small> loses {gap.shownLossRatePercent}% shown → {gap.trueLossRatePercent}% real</small>}
                </td>
                <td className={entry.gmgnPnl30dPercent !== null && entry.gmgnPnl30dPercent >= 0 ? 'positive' : entry.gmgnPnl30dPercent !== null ? 'negative' : undefined}>{formatPct(entry.gmgnPnl30dPercent)}</td>
                <td className={entry.simulatedMedianReturnPercent !== null && entry.simulatedMedianReturnPercent >= 0 ? 'positive' : entry.simulatedMedianReturnPercent !== null ? 'negative' : undefined}>{formatPct(entry.simulatedMedianReturnPercent)}</td>
                <td>{entry.trustworthy ? 'Yes' : 'Not yet'}</td>
              </tr>; })}</tbody>
            </table>
          </div>
        </Collapsible>
        <Collapsible summary={`Eliminated wallets (${eliminationReport.eliminated.length})`}>
          <div className="table-wrap">
            <table><thead><tr><th>Trader</th><th>Trades</th><th>Dune coverage</th><th>30d P&amp;L</th><th>Delayed-copy median</th><th>Reason(s)</th></tr></thead>
              <tbody>{eliminationReport.eliminated.map((entry) => <tr key={entry.walletAddress}>
                <td>{entry.name?.trim() || shortAddress(entry.walletAddress)}</td>
                <td>{entry.trades.toLocaleString()}</td>
                <td>{entry.duneCoveragePercent === null ? '—' : `${entry.duneCoveragePercent.toFixed(0)}%`}</td>
                <td className={entry.gmgnPnl30dPercent !== null && entry.gmgnPnl30dPercent >= 0 ? 'positive' : entry.gmgnPnl30dPercent !== null ? 'negative' : undefined}>{formatPct(entry.gmgnPnl30dPercent)}</td>
                <td className={entry.simulatedMedianReturnPercent !== null && entry.simulatedMedianReturnPercent >= 0 ? 'positive' : entry.simulatedMedianReturnPercent !== null ? 'negative' : undefined}>{formatPct(entry.simulatedMedianReturnPercent)}</td>
                <td>{entry.reasons.map((reason) => ELIMINATION_REASON_LABELS[reason]).join(', ')}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </Collapsible>
      </>}
      </div>
    </Collapsible>}

    {copyTradeSubTab === 'pattern-discovery' && <section id="copytrade-pattern-discovery" className="menu-section panel copytrade-research-route pattern-discovery-panel">
      <div className="panel-heading"><div><p className="eyebrow">GMGN COPYTRADE · SHARED ENGINE EXPORT</p><h2>Pattern Discovery</h2></div><span className="tag">100% OUTCOME COVERAGE</span></div>
      <p className="compact-info-line"><span>Read-only normalized export for wallets with exactly 100% Dune copy-simulation outcome coverage in the selected period.</span></p>
      <p className="copytrade-outcome-coverage-warning"><strong>Complete outcome set:</strong> every paired round trip for these wallets has a usable delayed-copy result for the selected period.</p>
      <p className="muted"><strong>Strict feature gate:</strong> the shared run uses only the explicit event-time <code>features</code> object. Return, hold-duration, delay, fee, outcome, and post-event matching fields are rejected as leakage and are never valid discovery features. The current GMGN export may therefore produce insufficient data rather than a valid pattern.</p>
      <div className="copytrade-coverage-controls"><label>Selected period (days)<input type="number" min={1} max={90} step={1} value={copyTradePeriodDays} onChange={(event) => setCopyTradePeriodDays(Math.min(90, Math.max(1, Number(event.target.value) || 1)))} /></label><button type="button" className="secondary" disabled={patternDiscoveryLoading} onClick={() => void loadPatternDiscoveryExport(copyTradePeriodDays)}>{patternDiscoveryLoading ? 'Reading…' : 'Refresh outcome export'}</button>{patternDiscoveryExport && <button type="button" className="secondary" onClick={() => saveJson(patternDiscoveryExport, `crypto-pattern-discovery-${patternDiscoveryExport.metadata.period_days}d.json`)}>Download normalized export</button>}<button type="button" className="primary" disabled={patternDiscoveryRunLoading || patternDiscoveryLoading || !patternDiscoveryExport?.metadata.exported_rows} onClick={() => void runPatternDiscovery()}>{patternDiscoveryRunLoading ? 'Running shared discovery…' : 'Run shared discovery'}</button></div>
      {patternDiscoveryError && <p className="error-text">{patternDiscoveryError}</p>}
      {patternDiscoveryLoading && <div className="copytrade-analysis-status running" role="status"><span className="loading-spinner" aria-hidden="true" /><div><strong>Reading saved copy-simulation outcomes…</strong><small>No GMGN or Dune request is made.</small></div></div>}
      {patternDiscoveryExport && !patternDiscoveryLoading && <><div className="copytrade-table-overview"><span><strong>{patternDiscoveryExport.metadata.selected_wallet_count}</strong> wallets</span><span><strong>{patternDiscoveryExport.metadata.exported_rows}</strong> normalized events</span><span><strong>{patternDiscoveryExport.metadata.excluded_wallets_not_exactly_100_percent}</strong> excluded below exact coverage</span></div><Collapsible className="copytrade-info-panel pattern-discovery-source-data" open={patternDiscoverySourceOpen} onToggle={setPatternDiscoverySourceOpen} summary={`Source data · ${patternDiscoveryExport.metadata.exported_rows} events`}><DataTable
                wrapClassName="table-wrap copytrade-table-wrap"
                tableClassName="copytrade-table fully-covered-table"
                rows={patternDiscoveryExport.rows.slice(0, 100)}
                getRowKey={(row) => row.event_id}
                emptyMessage="No wallets currently meet exact 100% outcome coverage for this period."
                columns={[
                  { key: 'wallet', header: 'Wallet', render: (row) => <><a className="copytrade-gmgn-link" href={`https://gmgn.ai/sol/address/${row.wallet_address}`} target="_blank" rel="noreferrer">{shortWalletAddress(row.wallet_address)} ↗</a><CopyAddressButton address={row.wallet_address} /></> },
                  { key: 'eventTime', header: 'Event time', render: (row) => formatTime(row.event_time) },
                  { key: 'token', header: 'Token', cellProps: (row) => ({ title: row.token_address }), render: (row) => row.entity_id },
                  { key: 'copyOutcome', header: 'Copy outcome', cellProps: (row) => ({ className: row.net_return_after_costs >= 0 ? 'positive' : 'negative' }), render: (row) => `${row.net_return_after_costs.toFixed(2)}%` },
                  { key: 'coverage', header: 'Coverage', render: () => '100%' },
                ]}
              /><p className="muted">{patternDiscoveryExport.metadata.coverage_semantics}</p></Collapsible><Collapsible className="copytrade-info-panel" summary="Configured shared-engine fallback"><p>The browser view only exports JSON. From the Vantage workspace, run the JSON-only adapter and then the isolated Python report command:</p><pre className="pattern-discovery-command">python -m shared_pattern_discovery.exporters.gmgn --project crypto --input &lt;downloaded-export.json&gt; --output runs/crypto/gmgn-pattern-discovery.json{`\n`}python -m shared_pattern_discovery.cli --project crypto --input runs/crypto/gmgn-pattern-discovery.json --output runs/crypto/pattern-discovery-report.json --min-n 10</pre><p className="muted">The shared engine reads this normalized JSON only; it never opens the crypto SQLite database.</p></Collapsible></>}
      {!patternDiscoveryLoading && patternDiscoveryExport?.metadata.exported_rows === 0 && <p className="muted">No exact-100% outcome-coverage rows exist for this period, so shared discovery is unavailable until an eligible export exists.</p>}
      {!patternDiscoveryLoading && patternDiscoveryExport && !patternDiscoveryReport && !patternDiscoveryRunLoading && !patternDiscoveryRunError && <p className="muted">Normalized export loaded. The shared Python engine has not run yet; click “Run shared discovery” to generate the report.</p>}
      {patternDiscoveryRunError && <p className="error-text">{patternDiscoveryRunError}</p>}
      {patternDiscoveryRunLoading && <div className="copytrade-analysis-status running" role="status"><span className="loading-spinner" aria-hidden="true" /><div><strong>Running the shared Python discovery engine…</strong><small>The engine receives normalized JSON only; no database or network access is used.</small></div></div>}
      {patternDiscoveryReport && !patternDiscoveryRunLoading && <div className="copytrade-info-panel pattern-discovery-readable">
        <div className="pattern-discovery-headline"><div><span className="eyebrow">PLAIN-ENGLISH RESULT</span><h3>What did the finder learn?</h3></div><span className="pattern-discovery-status">{(patternDiscoveryReport.status_counts['validation survivor'] ?? 0) > 0 ? 'Evidence repeated on later trades' : 'No reliable rule yet'}</span></div>
        <div className="pattern-discovery-cards"><div><strong>{patternDiscoveryReport.status_counts['validation survivor'] ?? 0}</strong><span>rules that survived a second test</span></div><div><strong>{patternDiscoveryReport.split.discovery_rows ?? 0}</strong><span>older trades used to discover rules</span></div><div><strong>{patternDiscoveryReport.split.validation_rows ?? 0}</strong><span>newer trades used to check them</span></div><div><strong>{patternDiscoveryReport.split.untouched_holdout_rows ?? 0}</strong><span>trades kept untouched</span></div></div>
        <div className="pattern-discovery-flow"><div><b>1</b><span>Look at older trades</span></div><i>→</i><div><b>2</b><span>Find a simple relationship</span></div><i>→</i><div><b>3</b><span>Check it on newer trades</span></div></div>
        <p className="pattern-discovery-explainer"><strong>Read this as:</strong> a behavior that appeared often enough in the selected data to test again.</p>
        {patternDiscoveryReport.patterns.filter((pattern) => pattern.validationStatus === 'insufficient data').map((pattern, index) => <p className="copytrade-outcome-coverage-warning" key={`insufficient-${index}`}><strong>Why a rule was not shown:</strong> {pattern.reason ?? 'There was not enough usable data.'}</p>)}
        <div className="pattern-discovery-results"><div className="pattern-discovery-results-heading"><h4>Rules found</h4><span>{patternDiscoveryReport.status_counts['validation survivor'] ?? 0} repeated</span></div>{patternDiscoveryReport.patterns.filter((pattern) => pattern.validationStatus === 'discovered candidate' || pattern.validationStatus === 'validation survivor').map((pattern, index) => { const effect = pattern.effect ?? null; const status = pattern.validationStatus === 'validation survivor' ? 'repeated' : 'candidate'; const isCorrelation = pattern.kind === 'correlation'; return <article className={`pattern-discovery-rule ${effect !== null && effect >= 0 ? 'positive-rule' : 'negative-rule'}`} key={`${pattern.feature ?? 'pattern'}-${index}`}><div className="pattern-discovery-rule-title"><strong>{patternFeatureLabel(pattern.feature)}</strong><span className={status}>{status === 'repeated' ? 'REPEATS' : 'CANDIDATE'}</span></div><div className="pattern-discovery-rule-main"><div><small>RULE</small><p>{patternConditionText(pattern.feature, pattern.conditions)}</p></div><div className={`pattern-discovery-effect ${effect !== null && effect >= 0 ? 'positive' : 'negative'}`}><small>{isCorrelation ? 'CORRELATION' : 'OUTCOME DIFFERENCE'}</small><b>{effect === null ? '—' : `${effect >= 0 ? '+' : ''}${formatPatternNumber(effect)}${isCorrelation ? '' : ' pts'}`}</b></div></div><div className="pattern-discovery-rule-meta"><span>Older data <b>{pattern.discovery_sample_size ?? 0}</b></span><span>Newer data <b>{pattern.validation?.sample_size ?? 0}</b></span></div></article>; })}{patternDiscoveryReport.patterns.filter((pattern) => pattern.validationStatus === 'discovered candidate' || pattern.validationStatus === 'validation survivor').length === 0 && <p className="muted">No rules found yet.</p>}</div>
        <Collapsible className="pattern-discovery-details" summary="Technical details"><p>Features come from wallet and token history available before each event. The final holdout is reserved for a later check.</p>{patternDiscoveryExecution && <p className="muted">Report file: {patternDiscoveryExecution.outputPath}</p>}</Collapsible>
      </div>}
    </section>}


    <div className="reference-divider"><span>3 · Reference &amp; diagnostics</span><small>Everything below is read-only — nothing here requires action</small></div>

    <section id="evidence" className="menu-section panel archives-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">GMGN ARCHIVE EVIDENCE</p><h2>Capture archives on disk</h2></div>
        <button className="secondary" disabled={loadingArchives} onClick={() => void loadArchives()}>{loadingArchives ? 'Loading…' : 'Load archives'}</button>
      </div>
      <p>Every one-off capture is archived locally as a ZIP. This re-verifies each file's SHA-256 and structure from disk and shows only the safe manifest — never the API key or raw captured events.</p>
      {archives === null
        ? <p className="muted">Not loaded yet.</p>
        : archives.length === 0
          ? <p className="muted">No GMGN capture archives found.</p>
          : <div className="table-wrap"><table><thead><tr><th>Captured</th><th>Events</th><th>Size</th><th>SHA-256</th><th>Status</th></tr></thead><tbody>
              {archives.map((archive) => <Fragment key={archive.fileName}>
                <tr className="archive-row" onClick={() => setExpandedArchive((current) => (current === archive.fileName ? null : archive.fileName))}>
                  <td><strong>{formatTime(archive.manifest?.capturedAt ?? null)}</strong><small>{archive.fileName}</small></td>
                  <td>{archive.manifest?.eventCount ?? '—'}<small>{archive.manifest ? `${archive.manifest.stored ?? 0} stored · ${archive.manifest.repeated ?? 0} repeated · ${archive.manifest.validationErrors ?? 0} issues` : ''}</small></td>
                  <td>{(archive.archiveBytes / 1024).toFixed(1)} KB</td>
                  <td><small>{archive.archiveSha256.slice(0, 16)}…</small></td>
                  <td>{archive.verified ? <span className="archived">Verified</span> : <span className="log-error">Failed</span>}</td>
                </tr>
                {expandedArchive === archive.fileName && <tr className="archive-detail-row"><td colSpan={5}>
                  <div className="archive-detail">
                    <div><span>Full SHA-256</span><strong>{archive.archiveSha256}</strong></div>
                    <div><span>Filename hash matches content</span><strong className={archive.hashVerified ? 'log-info' : 'log-error'}>{archive.hashVerified ? 'Yes' : 'No'}</strong></div>
                    <div><span>ZIP structure valid</span><strong className={archive.structureVerified ? 'log-info' : 'log-error'}>{archive.structureVerified ? 'Yes' : 'No'}</strong></div>
                    <div><span>Manifest event count matches archived response</span><strong className={archive.eventCountVerified === false ? 'log-error' : 'log-info'}>{archive.eventCountVerified === null ? 'Not checked' : archive.eventCountVerified ? 'Yes' : 'No'}</strong></div>
                    <div><span>Entries</span><strong>{archive.entryNames.join(', ') || '—'}</strong></div>
                    <div><span>Modified</span><strong>{formatTime(archive.modifiedAt)}</strong></div>
                    {archive.verificationError && <div><span>Verification error</span><strong className="log-error">{archive.verificationError}</strong></div>}
                  </div>
                </td></tr>}
              </Fragment>)}
            </tbody></table></div>}
    </section>

    <section className="menu-section quality-panel panel">
      <div className="panel-heading"><div><p className="eyebrow">DATA QUALITY · V1.1 LINKAGE</p><h2>Cohort ↔ GMGN coverage</h2></div><span className="tag">ADDRESS JOIN</span></div>
      <p>Signals are matched to the imported cohort by exact <code>token_address</code>. Unmatched observations stay preserved for later review.</p>
      <div className="quality-grid">
        <div className="quality-metric"><strong>{quality.coveragePercent}%</strong><span>signals matched to cohort</span><small>{quality.matchedSignalCount} of {quality.signalCount}</small></div>
        <div className="quality-metric"><strong>{quality.tokensWithSignals}</strong><span>cohort tokens with signals</span><small>{quality.tokensWithoutSignals} without signals</small></div>
        <div className="quality-metric"><strong>{quality.unmatchedSignalCount}</strong><span>signals outside cohort</span><small>kept, not discarded</small></div>
        <div className="quality-metric"><strong>{quality.signalsWithValidationIssues}</strong><span>signals with issues</span><small>{quality.missingTokenAddressSignals} missing address · {quality.missingObservedAtSignals} missing time</small></div>
      </div>
    </section>

    <section className="menu-section lower-grid">
      <article className="panel"><div className="panel-heading"><div><p className="eyebrow">ACTIVITY</p><h2>Recent imports</h2></div></div>
        {imports.length === 0 ? <p className="muted">No Dune exports processed yet.</p> : <div className="table-wrap"><table><thead><tr><th>Source</th><th>Rows</th><th>Archive</th></tr></thead><tbody>{imports.map((item) => <tr key={item.id ?? item.batchId}><td><strong>{item.sourcePath.split(/[\\/]/).pop()}</strong><small>{item.status ?? 'completed'}</small></td><td><span className="count-good">+{item.imported}</span> / {item.skipped} skipped / {item.errors} errors</td><td>{item.archivePath ? <span className="archived">ZIP archived</span> : '—'}</td></tr>)}</tbody></table></div>}
      </article>
      <article className="panel"><div className="panel-heading"><div><p className="eyebrow">SIGNAL MIX</p><h2>By signal type</h2></div></div>
        {stats.signalsByType.length === 0 ? <p className="muted">No signal types captured yet.</p> : <div className="bars">{stats.signalsByType.map((item) => <div className="bar-row" key={item.signalType}><span>{item.signalType}</span><b style={{ width: `${Math.max(8, item.count / Math.max(...stats.signalsByType.map((entry) => entry.count)) * 100)}%` }}>{item.count}</b></div>)}</div>}
      </article>
    </section>

    <section id="diagnostics" className="menu-section panel diagnostics-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">DIAGNOSTICS</p><h2>Recent request activity</h2></div>
        <button className="secondary" disabled={loadingLogs} onClick={() => void loadLogs()}>{loadingLogs ? 'Loading…' : 'Load recent activity'}</button>
      </div>
      <p>Every non-GET request, every error, and any connection dropped before a response was sent is recorded here for troubleshooting.</p>
      {logs === null
        ? <p className="muted">Not loaded yet.</p>
        : logs.length === 0
          ? <p className="muted">No diagnostic events recorded yet.</p>
          : <div className="table-wrap"><table><thead><tr><th>Time</th><th>Event</th><th>Request</th><th>Result</th></tr></thead><tbody>
              {logs.map((log) => <tr key={log.id}>
                <td><small>{formatTime(log.createdAt)}</small></td>
                <td><strong className={`log-${log.level}`}>{log.event}</strong>{log.message ? <small>{log.message}</small> : null}</td>
                <td><small>{log.method ?? '—'} {log.path ?? ''}</small></td>
                <td><small>{log.status ?? '—'}{log.durationMs !== null ? ` · ${log.durationMs}ms` : ''}{log.requestBytes ? ` · ${(log.requestBytes / 1024).toFixed(1)}KB` : ''}</small></td>
              </tr>)}
            </tbody></table></div>}
    </section>

    <footer><span>{message}</span><button className="quiet" onClick={() => void refresh()}>Refresh</button><span>V1 capture only · no scoring or returns</span></footer>
    {showScrollTop && <button type="button" className="scroll-top-button" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} aria-label="Scroll to top" title="Scroll to top">↑ <span>Top</span></button>}
  </main>;
}

// Every Vite HMR update to this module re-runs this file's top level. Calling createRoot() again
// each time mounted a second React tree onto the same #root element without disposing the first
// — React's own console warning ("createRoot() on a container that has already been passed to
// createRoot() before") was firing on every single edit all session. Whichever root won the race
// could keep rendering stale content indefinitely after that, even though the served source and
// the API data were both already current — a real bug, not a caching illusion. Stashing the root
// on `window` and reusing it across hot reloads is the fix React's own docs recommend for this
// exact warning.
declare global { interface Window { __copytradeReactRoot?: ReturnType<typeof createRoot> } }
const rootContainer = document.getElementById('root')!;
if (!window.__copytradeReactRoot) window.__copytradeReactRoot = createRoot(rootContainer);
window.__copytradeReactRoot.render(<App />);
