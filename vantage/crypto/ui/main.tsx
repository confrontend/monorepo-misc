import { Fragment, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

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
type CopyTradeFetchStatus = { running: boolean; runId: number | null; walletDone: number | null; walletTotal: number | null; tradesFetched: number | null; tradesDuplicate: number | null; tradesDailyCapped: number | null; rateLimitedUntil: string | null; status: 'idle' | 'running' | 'completed' | 'failed' | 'rate_limited' | 'cancelled'; message: string; estimatedRemainingSeconds: number | null; scope: 'roster' | 'winners' | 'single' | null };
type CopyTradeFetchEstimateBasis = { source: 'measured' | 'default'; runsCounted: number; updatedAt: string | null };
type CopyTradeFetchEstimate = { walletCount: number; freshWallets: number; coveredWallets: number; periodDays: number; estimatedRequests: number; estimatedSeconds: number; basis: CopyTradeFetchEstimateBasis; confidence: 'seeded' | 'low' | 'medium' | 'high' };
type BrowserActivityImportResult = { imported: number; duplicates: number; malformed: number; activityEndpoints: number; samples: number; archivePath: string | null; archiveSha256: string | null };
type CopyTradePeriod = { period: string; trades: number; winRatePercent: number | null; medianReturnPercent: number | null; averageReturnPercent: number | null; endingCapitalUsd: number | null };
type CopyTradeTokenProfit = { tokenAddress: string; tokenSymbol: string | null; trades: number; profitUsd: number };
type CopyTradeConcentration = { bestToken: CopyTradeTokenProfit | null; bestThreeTokens: CopyTradeTokenProfit[]; bestTokenSharePositiveProfitPercent: number | null; bestThreeSharePositiveProfitPercent: number | null; bestTradeProfitUsd: number | null; excludingBestTrade: { trades: number; medianReturnPercent: number | null; endingCapitalUsd: number | null }; excludingBestToken: { trades: number; medianReturnPercent: number | null; endingCapitalUsd: number | null } };
type CopyTradeRankHistory = { leaderboardCaptures: number; appearances: number; topFiveAppearances: number; topFiveMembershipPercent: number | null; currentRank: number | null; bestRank: number | null; worstRank: number | null; firstObservedAt: string | null; lastObservedAt: string | null };
type CopyTradeRow = { walletAddress: string; name: string | null; trades: number | null; winRatePercent: number | null; medianReturnPercent: number | null; averageReturnPercent: number | null; endingCapitalUsd: number | null; verdict: 'screen_pass' | 'no' | 'thin' | 'flagged' | 'descriptive_only'; comparable: boolean; riskFlags: string[]; failedRules: string[]; profitConcentration: CopyTradeConcentration; weeklyPerformance: CopyTradePeriod[]; monthlyPerformance: CopyTradePeriod[]; rankHistory: CopyTradeRankHistory };
type CopyTradeResults = { computedAt: string; startingCapitalUsd: 100; periodDays: number | null; rows: CopyTradeRow[]; overall: CopyTradeOverallRow; overallByWallet: CopyTradeOverallRow; rules: { minTrades: number | null; minDays: number | null; requiresPositiveMedian: boolean }; scope?: { rosterSnapshotId: number | null; rosterProvenance: { capturedAt: string; window: string | null; orderby: string | null; requestPath: string | null; requestQuery: Record<string, unknown> } | null }; walletPerformance?: { status: 'available'; description: string }; copySimulation?: { status: 'not_available'; description: string; requiredInputs: string[] } };
type CopyTradeOverallRow = { trades: number | null; winRatePercent: number | null; medianReturnPercent: number | null; averageReturnPercent: number | null; endingCapitalUsd: number | null; weighting: 'trade-weighted' | 'wallet-weighted'; wallets: number | null };
type CopyTradeSortKey = 'name' | 'trades' | 'winRatePercent' | 'medianReturnPercent' | 'averageReturnPercent' | 'endingCapitalUsd' | 'verdict';

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
type TopCallerLeaderboardRow = { callerKey: string; rankPosition: number; callCount: number | null; reportedAvgMultiplier: string | null; reportedBestMultiplier: string | null; reportedHitRate2xPct: string | null; tracked: boolean };
type TopCallerLeaderboard = { snapshot: { capturedAt: string; period: string | null } | null; rows: TopCallerLeaderboardRow[] };
type TopCallerCollectionKind = 'leaderboard' | 'callouts' | 'checkpoints';
type TopCallerCollectionStatus = { running: boolean; runId: number | null; status: 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'rate_limited' | 'cancelled'; requestsMade: number; walletTotal: number | null; walletDone: number | null; rateLimitedUntil: string | null; retryCount: number; nextRetryAt: string | null; message: string };
type TopCallerEvaluationRow = { callerKey: string; callCount: number; measuredCallCount: number; waitingCallCount: number; unavailableCallCount: number; coverageRatePercent: number | null; coverageSufficient: boolean; winRatePercent: number | null; medianReturnPercent: number | null; reliable: boolean };
type TopCallerEvaluation = { checkpoint: string; rows: TopCallerEvaluationRow[] };
type TopCallerAllEvaluation = Record<TopCallerEvaluationCheckpoint, TopCallerEvaluation>;
const TOP_CALLER_CHECKPOINTS: TopCallerEvaluationCheckpoint[] = ['5m', '10m', '15m', '30m', '45m', '1h', '6h', '24h'];
type TopCallerEvaluationCheckpoint = '5m' | '10m' | '15m' | '30m' | '45m' | '1h' | '6h' | '24h';
type TopCallerTableSortKey = 'callerKey' | 'checkpoint' | 'medianReturnPercent' | 'winRatePercent' | 'measuredCallCount' | 'coverageRatePercent' | 'reliable';
type TopCallerOutcome = { checkpoint: string; status: string; measuredReturnPct: number | null; gapSeconds: number | null };
type TopCallerCallout = { id: number; tokenAddress: string; tokenSymbol: string | null; callTimestamp: string; callPriceUsd: string | null; message: string | null; reportedMultiplier: string | null; outcomes: TopCallerOutcome[] };
type TopCallerDetail = { callerKey: string; callouts: TopCallerCallout[] };
type TopCallerReliabilityReason = 'awaiting_dune_fetch' | 'insufficient_coverage' | 'awaiting_more_capture_dates' | 'no_callouts';
type TopCallerCheckpointBreakdownRow = { checkpoint: string; callCount: number; measuredCallCount: number; waitingCallCount: number; unavailableCallCount: number; coverageRatePercent: number | null; coverageSufficient: boolean; winRatePercent: number | null; medianReturnPercent: number | null; reliable: boolean; reasons: TopCallerReliabilityReason[] };
type TopCallerCheckpointBreakdown = { callerKey: string; rows: TopCallerCheckpointBreakdownRow[] };
type ExperimentSummary = {
  experimentId: number; selectedAtUtc: string; filterHash: string; filterMatchesLatestCapture: boolean;
  primaryTopN: number; rosterTopN: number; walletCount: number;
  windowsDays: number[]; maturedWindowsDays: number[]; pendingWindowsDays: number[];
};
type ExperimentWindowState = 'pending' | 'matured' | 'insufficient_coverage';
type ExperimentWindowResult = {
  windowDays: number; state: ExperimentWindowState; windowEndUtc: string; trades: number;
  medianReturnPercent: number | null; winRatePercent: number | null; averageReturnPercent: number | null; endingCapitalUsd: number | null;
};
type ExperimentWalletResult = { walletAddress: string; rankAtSelection: number; selectedGroup: 'primary' | 'comparison'; windows: ExperimentWindowResult[] };
type ExperimentReport = {
  experimentId: number; selectedAtUtc: string; filterHash: string; methodologyVersion: string;
  primaryTopN: number; rosterTopN: number; wallets: ExperimentWalletResult[];
  evaluatedScope?: { kind: 'first_stage_winners'; winnerCount: number; frozenRosterCount: number };
};

type CopyCandidate = {
  walletAddress: string; name: string | null; rankPosition: number | null;
  medianReturnPercent: number | null; winRatePercent: number | null; trades: number;
  medianHoldSeconds: number | null; fastRoundTripPercent: number | null; concentrationPercent: number | null;
  bestTokenSymbol: string | null; historicalConsistencyVerdict: HistoricalConsistencyVerdict | null;
  gmgnProfileUrl: string;
  copySurvivalStatus: 'survives' | 'fails_copy_survival' | 'not_yet_simulated';
  simulatedMedianReturnPercent: number | null;
  copySimulationCoverageRatePercent: number | null;
};
type CopyCandidatesReport = {
  computedAt: string;
  thresholds: { minMedianHoldSeconds: number; maxFastRoundTripPercent: number; maxConcentrationPercent: number; requiredHistoricalConsistencyVerdict: string };
  screenedCount: number; candidates: CopyCandidate[]; excludedCount: number;
  pendingCopySimulationCount: number; failedCopySurvivalCount: number;
};
type CopySimulationTradeResult = { tokenAddress: string; tokenSymbol: string | null; walletReturnPercent: number | null; simulatedReturnPercent: number | null; status: 'simulated' | 'missing_entry_match' | 'missing_exit_match' | 'not_yet_queried'; entryGapSeconds: number | null; exitGapSeconds: number | null; gasFeeSol: number | null; entryTradeAmountUsd: number | null; exitTradeAmountUsd: number | null };
type CopySimulationWalletReport = { walletAddress: string; roundTripsConsidered: number; copiedTrades: number; missedTrades: number; coverageRatePercent: number | null; walletMedianReturnPercent: number | null; simulatedMedianReturnPercent: number | null; delayCostPercentagePoints: number | null; worstSimulatedReturnPercent: number | null; totalGasFeeSol: number | null; trades: CopySimulationTradeResult[] };
type CopySimulationReport = { computedAt: string; assumptions: { copierDelaySeconds: number; feeBps: number; slippageBps: number; gasPriorityFeeSolPerTx: number; maxMatchGapSeconds: number; maxRoundTripsPerWallet: number }; wallets: CopySimulationWalletReport[] };
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

type GmgnWatchLastPoll = {
  at: string;
  ok: boolean;
  captured?: number;
  stored?: number;
  repeated?: number;
  errors?: number;
  gapDetected?: boolean;
  message?: string;
  rateLimited?: boolean;
};

type GmgnWatchStatus = {
  running: boolean;
  intervalSeconds: number;
  nextPollAt: string | null;
  lastPoll: GmgnWatchLastPoll | null;
  totalPolls: number;
  totalStored: number;
  totalRepeated: number;
  consecutiveFailures: number;
  stoppedReason: string | null;
  rateLimitedUntil: string | null;
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


// Disabled for now (kept in place, not removed): continuous polling needs more runway on the
// manual one-off capture path first. Server also rejects POST /api/gmgn/watch/start while this
// is off, so this flag just keeps the UI honest about it. Flip both back to re-enable.
const GMGN_WATCH_MODE_ENABLED = false;

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
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

const formatTime = (value: string | null): string => value ? new Date(value).toLocaleString() : '—';
const formatPercentChange = (base: number | null, value: number | null): string => base === null || value === null || base === 0 ? '—' : `${((value - base) / base * 100).toFixed(2)}%`;
const formatPct = (value: number | null): string => value === null ? '—' : `${value.toFixed(1)}%`;
const formatUsd = (value: number | null): string => value === null ? '—' : `$${value.toFixed(2)}`;
const formatCount = (value: number | null): string => value === null ? '—' : value.toLocaleString();
const formatDuration = (seconds: number | null): string => {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
};
const formatForwardWindow = (days: number): string => {
  const minutes = days * 24 * 60;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`;
  if (days < 365) return `${Number.isInteger(days) ? days : days.toFixed(1)}d`;
  return `${days}d`;
};
const renderForwardTimeline = (windows: ExperimentWindowResult[]) => {
  const usable = windows.filter((window) => window.state === 'matured' && window.medianReturnPercent !== null && window.winRatePercent !== null);
  const pending = windows.filter((window) => window.state === 'pending').length;
  const insufficient = windows.filter((window) => window.state === 'insufficient_coverage').length;
  if (usable.length === 0) return <div className="forward-timeline-empty">Waiting for enough completed trades{pending > 0 ? ` · ${pending} checkpoint${pending === 1 ? '' : 's'} pending` : ''}{insufficient > 0 ? ` · ${insufficient} below coverage floor` : ''}</div>;
  const width = 500;
  const height = 150;
  const left = 34;
  const right = 14;
  const top = 12;
  const bottom = 30;
  const maxMinutes = Math.max(...usable.map((window) => window.windowDays * 24 * 60), 1);
  const x = (window: ExperimentWindowResult) => left + ((window.windowDays * 24 * 60) / maxMinutes) * (width - left - right);
  const yMedian = (value: number) => top + (1 - (Math.max(-100, Math.min(100, value)) + 100) / 200) * (height - top - bottom);
  const yWin = (value: number) => top + (1 - value / 100) * (height - top - bottom);
  const medianPoints = usable.map((window) => `${x(window)},${yMedian(window.medianReturnPercent ?? 0)}`).join(' ');
  const winPoints = usable.map((window) => `${x(window)},${yWin(window.winRatePercent ?? 0)}`).join(' ');
  return <div className="forward-timeline">
    <svg className="forward-timeline-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Median return and win rate across matured forward-validation checkpoints">
      <line x1={left} x2={width - right} y1={yMedian(0)} y2={yMedian(0)} className="forward-timeline-zero" />
      <line x1={left} x2={left} y1={top} y2={height - bottom} className="forward-timeline-axis" />
      <polyline points={medianPoints} className="forward-timeline-median" fill="none" />
      <polyline points={winPoints} className="forward-timeline-win" fill="none" />
      {usable.map((window) => <Fragment key={window.windowDays}>
        <circle cx={x(window)} cy={yMedian(window.medianReturnPercent ?? 0)} r="4" className="forward-timeline-median-point"><title>{formatForwardWindow(window.windowDays)}: {formatPct(window.medianReturnPercent)} median</title></circle>
        <circle cx={x(window)} cy={yWin(window.winRatePercent ?? 0)} r="4" className="forward-timeline-win-point"><title>{formatForwardWindow(window.windowDays)}: {formatPct(window.winRatePercent)} win</title></circle>
        <text x={x(window)} y={height - 10} textAnchor="middle" className="forward-timeline-label">{formatForwardWindow(window.windowDays)}</text>
      </Fragment>)}
    </svg>
    <div className="forward-timeline-legend"><span><i className="forward-timeline-key median" /> median return</span><span><i className="forward-timeline-key win" /> win rate</span></div>
    <div className="forward-timeline-values">{usable.map((window) => <span key={`value-${window.windowDays}`}><b>{formatForwardWindow(window.windowDays)}</b> {formatPct(window.medianReturnPercent)} median · {formatPct(window.winRatePercent)} win · {formatCount(window.trades)} trades</span>)}</div>
    {(pending > 0 || insufficient > 0) && <small className="muted">Not plotted: {pending > 0 ? `${pending} pending` : ''}{pending > 0 && insufficient > 0 ? ' · ' : ''}{insufficient > 0 ? `${insufficient} below the coverage floor` : ''}.</small>}
  </div>;
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
const normalizeRoute = (route: string): string => route === 'birdeye-batch' ? 'dune-capture' : route === 'copy-trades' ? 'copytrade' : route;
type CopyTradeSubTab = 'research' | 'winners' | 'historical-consistency' | 'forward-validation' | 'top-callers';
const parseCopyTradeRoute = (route: string): { menu: string; subTab: CopyTradeSubTab } => {
  const [rawMenu, rawSubTab] = route.split('/');
  const subTab: CopyTradeSubTab = rawSubTab === 'winners' || rawSubTab === 'historical-consistency' || rawSubTab === 'forward-validation' || rawSubTab === 'top-callers' ? rawSubTab : 'research';
  return { menu: normalizeRoute(rawMenu || 'dune-capture'), subTab };
};
const copyAddress = async (address: string) => { try { await navigator.clipboard.writeText(address); } catch { /* clipboard access is optional */ } };
const tokenDisplay = (symbol: string | null, address: string): string => symbol?.trim() || shortAddress(address);
const InfoTip = ({ label = 'More information', text }: { label?: string; text: string }) => (
  <details className="info-tip">
    <summary aria-label={label} title={label}><span aria-hidden="true">i</span></summary>
    <span>{text}</span>
  </details>
);

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
  const initialRoute = parseCopyTradeRoute(window.location.hash.slice(1) || 'dune-capture');
  const [activeMenu, setActiveMenu] = useState(initialRoute.menu);
  const [focusedView, setFocusedView] = useState(true);
  const [stats, setStats] = useState<Stats>(emptyStats);
  const [quality, setQuality] = useState<DataQuality>(emptyQuality);
  const [analysis, setAnalysis] = useState<SnapshotAnalysis | null>(null);
  const [scoring, setScoring] = useState<SignalScoringReport | null>(null);
  const [probeAddress, setProbeAddress] = useState('');
  const [probeTime, setProbeTime] = useState(new Date().toISOString().slice(0, 16));
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeResult, setProbeResult] = useState<{ status: string; priceHttpStatus: number | null; liquidityHttpStatus: number | null; priceUsd: number | null; currentLiquidityHttpStatus: number | null; currentLiquidityUsd: number | null; liquidityMessage: string | null; archivePath: string | null; error: string | null } | null>(null);
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
  const [copyTradeLimit, setCopyTradeLimit] = useState(25);
  const [copyTradePeriodDays, setCopyTradePeriodDays] = useState(90);
  const [copyTradeBusy, setCopyTradeBusy] = useState(false);
  const [winnersFetchBusy, setWinnersFetchBusy] = useState(false);
  const [singleTraderQuery, setSingleTraderQuery] = useState('');
  const [singleTraderBusy, setSingleTraderBusy] = useState(false);
  const [singleTraderError, setSingleTraderError] = useState<string | null>(null);
  const [copyTradeStopBusy, setCopyTradeStopBusy] = useState(false);
  const [copyTradeLoading, setCopyTradeLoading] = useState(false);
  const [copyTradeError, setCopyTradeError] = useState<string | null>(null);
  const [copyTradeEstimate, setCopyTradeEstimate] = useState<CopyTradeFetchEstimate | null>(null);
  const [copyTradeEstimateLoading, setCopyTradeEstimateLoading] = useState(false);
  const [copyTradeSubTab, setCopyTradeSubTab] = useState<CopyTradeSubTab>(initialRoute.subTab);
  const [historicalConsistency, setHistoricalConsistency] = useState<HistoricalConsistencyReport | null>(null);
  const [historicalConsistencyLoading, setHistoricalConsistencyLoading] = useState(false);
  const [captureHealth, setCaptureHealth] = useState<CaptureHealth | null>(null);
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);
  const [experimentsLoading, setExperimentsLoading] = useState(false);
  const [selectedExperimentId, setSelectedExperimentId] = useState<number | null>(null);
  const [selectedExperiment, setSelectedExperiment] = useState<ExperimentReport | null>(null);
  const [freezeBusy, setFreezeBusy] = useState(false);
  const [copyWinners, setCopyWinners] = useState<CopyCandidatesReport | null>(null);
  const [copyWinnersLoading, setCopyWinnersLoading] = useState(false);
  const [copySimulation, setCopySimulation] = useState<CopySimulationReport | null>(null);
  const [copySimulationLoading, setCopySimulationLoading] = useState(false);
  const [copySimulationRunBusy, setCopySimulationRunBusy] = useState(false);
  const [liquidityImpact, setLiquidityImpact] = useState<LiquidityImpactReport | null>(null);
  const [liquidityImpactLoading, setLiquidityImpactLoading] = useState(false);
  const [browserActivityImportBusy, setBrowserActivityImportBusy] = useState(false);
  const [copyTradeSort, setCopyTradeSort] = useState<{ key: CopyTradeSortKey; direction: 'asc' | 'desc' }>({ key: 'endingCapitalUsd', direction: 'desc' });
  const [topCallerLeaderboard, setTopCallerLeaderboard] = useState<TopCallerLeaderboard | null>(null);
  const [topCallerEvaluation, setTopCallerEvaluation] = useState<TopCallerEvaluation | null>(null);
  const [topCallerAllEvaluation, setTopCallerAllEvaluation] = useState<TopCallerAllEvaluation | null>(null);
  const [topCallerEvaluationCheckpoint, setTopCallerEvaluationCheckpoint] = useState<TopCallerEvaluationCheckpoint>('24h');
  const [showUnreliableTopCallers, setShowUnreliableTopCallers] = useState(false);
  const [topCallerAllPage, setTopCallerAllPage] = useState(0);
  const [topCallerTableSort, setTopCallerTableSort] = useState<{ key: TopCallerTableSortKey | 'default'; direction: 'asc' | 'desc' }>({ key: 'default', direction: 'desc' });
  const [topCallerDetail, setTopCallerDetail] = useState<TopCallerDetail | null>(null);
  const [topCallerCheckpointBreakdown, setTopCallerCheckpointBreakdown] = useState<TopCallerCheckpointBreakdown | null>(null);
  const [topCallerSelectedKey, setTopCallerSelectedKey] = useState<string | null>(null);
  const [topCallerLoading, setTopCallerLoading] = useState(false);
  const [topCallerWorkflowBusy, setTopCallerWorkflowBusy] = useState(false);
  const [topCallerStopBusy, setTopCallerStopBusy] = useState(false);
  const [topCallerResumeBusy, setTopCallerResumeBusy] = useState(false);
  const [topCallerWorkflowStage, setTopCallerWorkflowStage] = useState<string | null>(null);
  const [topCallerError, setTopCallerError] = useState<string | null>(null);
  const [topCallerRunStatus, setTopCallerRunStatus] = useState<Record<TopCallerCollectionKind, TopCallerCollectionStatus | null>>({ leaderboard: null, callouts: null, checkpoints: null });
  const [topCallerClockMs, setTopCallerClockMs] = useState(() => Date.now());
  const topCallerStopRequestedRef = useRef(false);
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [gmgnStatus, setGmgnStatus] = useState<GmgnStatus | null>(null);
  const [capturingGmgn, setCapturingGmgn] = useState(false);
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
  const [watchStatus, setWatchStatus] = useState<GmgnWatchStatus | null>(null);
  const [watchBusy, setWatchBusy] = useState(false);
  const [watchIntervalMinutes, setWatchIntervalMinutes] = useState(5);
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
      const [nextStats, nextImports, nextQuality, nextGmgn, nextWatch, nextAnalysis, nextScoring, nextCandidates, nextMeasurementPlan, latestOutcomes, nextPatternReport, nextPatternSnapshots] = await Promise.all([
      api<Stats>('/api/stats'),
      api<ImportSummary[]>('/api/imports'),
      api<DataQuality>('/api/quality'),
      api<GmgnStatus>('/api/gmgn/status'),
      api<GmgnWatchStatus>('/api/gmgn/watch/status'),
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
    setWatchStatus(nextWatch);
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

  const loadTopCallerData = async (checkpoint = topCallerEvaluationCheckpoint) => {
    setTopCallerLoading(true);
    setTopCallerError(null);
    try {
      const [leaderboard, ...evaluations] = await Promise.all([
        api<TopCallerLeaderboard>('/api/top-callers/leaderboard'),
        ...TOP_CALLER_CHECKPOINTS.map((item) => api<TopCallerEvaluation>(`/api/top-callers/callers?checkpoint=${item}`)),
      ]);
      const allEvaluation = Object.fromEntries(evaluations.map((item) => [item.checkpoint, item])) as TopCallerAllEvaluation;
      const evaluation = allEvaluation[checkpoint] ?? evaluations[0] ?? null;
      setTopCallerLeaderboard(leaderboard);
      setTopCallerAllEvaluation(allEvaluation);
      setTopCallerEvaluation(evaluation);
      setTopCallerAllPage(0);
      const selected = topCallerSelectedKey ?? leaderboard.rows.find((row) => row.tracked)?.callerKey ?? leaderboard.rows[0]?.callerKey ?? null;
      setTopCallerSelectedKey(selected);
      if (selected) {
        setTopCallerDetail(await api<TopCallerDetail>(`/api/top-callers/callers/${encodeURIComponent(selected)}`));
        setTopCallerCheckpointBreakdown(await api<TopCallerCheckpointBreakdown>(`/api/top-callers/callers/${encodeURIComponent(selected)}/checkpoints`));
      } else { setTopCallerDetail(null); setTopCallerCheckpointBreakdown(null); }
    } catch (error: unknown) {
      setTopCallerError(error instanceof Error ? error.message : String(error));
    } finally { setTopCallerLoading(false); }
  };

  const loadTopCallerStatus = async (kind: TopCallerCollectionKind) => {
    try {
      const status = await api<TopCallerCollectionStatus>(`/api/top-callers/collect/status?kind=${kind}`);
      setTopCallerRunStatus((current) => ({ ...current, [kind]: status }));
      return status;
    } catch (error: unknown) {
      setTopCallerError(error instanceof Error ? error.message : String(error));
      return null;
    }
  };

  const collectTopCaller = async (kind: TopCallerCollectionKind) => {
    setTopCallerError(null);
    try {
      const response = await fetch('/api/top-callers/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }) });
      const body = await response.json() as { error?: string; runId?: number; status?: TopCallerCollectionStatus['status'] };
      if (response.status === 409) {
        const existing = await loadTopCallerStatus(kind);
        if (!existing?.running) throw new Error(body.error ?? 'A collection was already in progress, but its status is no longer running.');
      } else if (!response.ok) throw new Error(body.error ?? `Collection failed (${response.status}).`);
      await loadTopCallerStatus(kind);
      setMessage(`${kind === 'leaderboard' ? 'Leaderboard' : kind === 'callouts' ? 'Callout' : 'Checkpoint'} collection started.`);
      await loadTopCallerData();
    } catch (error: unknown) { setTopCallerError(error instanceof Error ? error.message : String(error)); }
  };

  const toggleTopCallerTracking = async (row: TopCallerLeaderboardRow) => {
    const nextTracked = !row.tracked;
    setTopCallerLeaderboard((current) => current ? { ...current, rows: current.rows.map((item) => item.callerKey === row.callerKey ? { ...item, tracked: nextTracked } : item) } : current);
    try {
      const endpoint = nextTracked ? '/api/top-callers/track' : '/api/top-callers/untrack';
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callerKey: row.callerKey }) });
      const body = await response.json() as { tracked?: boolean; error?: string };
      if (!response.ok || body.tracked !== nextTracked) throw new Error(body.error ?? 'The server did not confirm the tracking change.');
      await loadTopCallerData();
    } catch (error: unknown) {
      setTopCallerLeaderboard((current) => current ? { ...current, rows: current.rows.map((item) => item.callerKey === row.callerKey ? { ...item, tracked: row.tracked } : item) } : current);
      setTopCallerError(error instanceof Error ? error.message : String(error));
    }
  };

  const runTopCallerWorkflow = async () => {
    if (topCallerWorkflowBusy) return;
    topCallerStopRequestedRef.current = false;
    setTopCallerWorkflowBusy(true);
    setTopCallerError(null);
    try {
      const runCollectionAndWait = async (kind: TopCallerCollectionKind, label: string) => {
        if (topCallerStopRequestedRef.current) throw new Error('Workflow stopped by user. Data already fetched is retained.');
        setTopCallerWorkflowStage(label);
        // Start the collection exactly once. The backend now owns rate-limit resilience itself
        // (one bounded automatic retry, then a permanent 'paused' state) — this loop must never
        // re-POST /collect on its own during a pause, or it would race the backend's own retry
        // and start a second, unrelated run. The only thing worth retrying client-side is the
        // short, self-inflicted leaderboard debounce cooldown (429 on the initial POST itself).
        {
          const response = await fetch('/api/top-callers/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }) });
          if (response.status === 429) {
            const body = await response.json() as { error?: string; retryAfterSeconds?: number };
            const waitSeconds = typeof body.retryAfterSeconds === 'number' ? body.retryAfterSeconds : 10;
            setTopCallerWorkflowStage(`${label} — waiting ${waitSeconds}s for the capture cooldown…`);
            await new Promise((resolve) => window.setTimeout(resolve, (waitSeconds + 1) * 1000));
            if (topCallerStopRequestedRef.current) throw new Error('Workflow stopped by user. Data already fetched is retained.');
            const retry = await fetch('/api/top-callers/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }) });
            if (retry.status !== 409 && !retry.ok) {
              const retryBody = await retry.json() as { error?: string };
              throw new Error(retryBody.error ?? `${label} failed (${retry.status}).`);
            }
          } else if (response.status !== 409 && !response.ok) {
            const body = await response.json() as { error?: string };
            throw new Error(body.error ?? `${label} failed (${response.status}).`);
          }
        }
        for (;;) {
          const status = await api<TopCallerCollectionStatus>(`/api/top-callers/collect/status?kind=${kind}`);
          setTopCallerRunStatus((current) => ({ ...current, [kind]: status }));
          if (kind === 'callouts' && status.running && status.walletTotal) {
            setTopCallerWorkflowStage(`${label} (${status.walletDone ?? 0} of ${status.walletTotal} callers — each one is saved as soon as it's fetched)`);
          }
          if (status.status === 'completed') break;
          if (status.status === 'paused') {
            if (status.retryCount >= 1) {
              throw new Error(`${label} is paused after one automatic retry by GMGN's rate limit. Use "Resume collection" below to continue — it will not retry again on its own.`);
            }
            const nextRetryMs = status.nextRetryAt ? Date.parse(status.nextRetryAt) : NaN;
            const seconds = Number.isFinite(nextRetryMs) ? Math.max(0, Math.ceil((nextRetryMs - Date.now()) / 1000)) : null;
            setTopCallerWorkflowStage(`${label} paused by GMGN — ${status.walletDone ?? 0} of ${status.walletTotal ?? '?'} wallets complete. One automatic retry ${seconds !== null ? `in ${seconds}s` : 'is scheduled'}.`);
            if (topCallerStopRequestedRef.current) throw new Error('Workflow stopped by user. Data already fetched is retained.');
            await new Promise((resolve) => window.setTimeout(resolve, 2000));
            continue;
          }
          if (!status.running) throw new Error(status.message || `${label} did not complete.`);
          if (topCallerStopRequestedRef.current) throw new Error('Workflow stopped by user. Data already fetched is retained.');
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
        }
      };
      await runCollectionAndWait('leaderboard', '1/4 Capturing the GMGN leaderboard…');
      const latestLeaderboard = await api<TopCallerLeaderboard>('/api/top-callers/leaderboard');
      setTopCallerLeaderboard(latestLeaderboard);
      const topRows = latestLeaderboard.rows.slice(0, 25);
      setTopCallerWorkflowStage(`2/4 Tracking the top ${topRows.length} callers…`);
      for (const row of topRows) {
        if (topCallerStopRequestedRef.current) throw new Error('Workflow stopped by user. Data already fetched is retained.');
        if (row.tracked) continue;
        const response = await fetch('/api/top-callers/track', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callerKey: row.callerKey }) });
        if (!response.ok) throw new Error(`Could not track ${shortAddress(row.callerKey)}.`);
      }
      await loadTopCallerData();
      await runCollectionAndWait('callouts', '3/4 Fetching caller history from GMGN…');
      await runCollectionAndWait('checkpoints', '4/4 Measuring matured outcomes with Dune…');
      await loadTopCallerData();
      setTopCallerWorkflowStage('Workflow complete. Best measured caller is shown above.');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (topCallerStopRequestedRef.current) {
        setTopCallerError(null);
        setTopCallerWorkflowStage('Workflow stopped by user. Data already fetched is retained.');
      } else {
        setTopCallerError(message);
        setTopCallerWorkflowStage('Workflow stopped. Open advanced controls for the failed step.');
      }
    } finally {
      setTopCallerWorkflowBusy(false);
    }
  };

  const stopTopCallerWork = async () => {
    if (topCallerStopBusy) return;
    topCallerStopRequestedRef.current = true;
    setTopCallerStopBusy(true);
    setTopCallerWorkflowStage('Stopping Top Caller work…');
    try {
      await fetch('/api/top-callers/collect/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      await Promise.all((['leaderboard', 'callouts', 'checkpoints'] as TopCallerCollectionKind[]).map((kind) => loadTopCallerStatus(kind)));
      setMessage('Top Caller work stopped. Data already fetched is retained.');
    } catch (error: unknown) {
      setTopCallerError(error instanceof Error ? error.message : String(error));
    } finally { setTopCallerStopBusy(false); }
  };

  /** The backend already made its one bounded automatic retry and gave up — this is the only
   *  way collection starts again from here. Never called automatically; always a deliberate
   *  click, matching the "pause, don't retry forever" behavior this state machine exists for. */
  const resumeTopCallerCollection = async (kind: TopCallerCollectionKind) => {
    if (topCallerResumeBusy) return;
    setTopCallerResumeBusy(true);
    setTopCallerError(null);
    try {
      const response = await fetch('/api/top-callers/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: topCallerRunStatus[kind]?.runId ?? undefined }) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Resume failed (${response.status}).`);
      await loadTopCallerStatus(kind);
    } catch (error: unknown) {
      setTopCallerError(error instanceof Error ? error.message : String(error));
    } finally { setTopCallerResumeBusy(false); }
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

  const loadExperiments = async () => {
    setExperimentsLoading(true);
    try {
      const list = await api<ExperimentSummary[]>('/api/copytrade/experiments');
      setExperiments(list);
      // Restore the selected experiment on a full page refresh.  The list and
      // the detail are separate requests; relying only on the selected-id
      // effect meant the list could render while the detail remained blank
      // when the initial state was null.
      const nextId = selectedExperimentId ?? list[0]?.experimentId ?? null;
      setSelectedExperimentId(nextId);
      if (nextId === null) {
        setSelectedExperiment(null);
      } else if (selectedExperiment?.experimentId !== nextId) {
        await loadExperimentDetail(nextId);
      }
    } catch (error: unknown) { setCopyTradeError(error instanceof Error ? error.message : String(error)); }
    finally { setExperimentsLoading(false); }
  };

  const loadExperimentDetail = async (experimentId: number) => {
    try { setSelectedExperiment(await api<ExperimentReport>(`/api/copytrade/experiments/${experimentId}`)); }
    catch (error: unknown) { setCopyTradeError(error instanceof Error ? error.message : String(error)); }
  };

  const freezeCurrentRoster = async () => {
    const snapshotId = captureHealth?.latestProvenancedSnapshotId;
    if (!snapshotId) return;
    setFreezeBusy(true);
    try {
      const result = await api<{ experimentId: number; created: boolean }>('/api/copytrade/experiments/freeze', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshotId }),
      });
      setMessage(result.created
        ? `Froze a new walk-forward experiment (#${result.experimentId}).`
        : `The current leaderboard snapshot was already frozen as experiment #${result.experimentId}.`);
      await loadExperiments();
      setSelectedExperimentId(result.experimentId);
    } catch (error: unknown) { setCopyTradeError(error instanceof Error ? error.message : String(error)); }
    finally { setFreezeBusy(false); }
  };

  const loadCopyWinners = async (limit: number, rosterSnapshotId = selectedRosterSnapshotId) => {
    setCopyWinnersLoading(true);
    try { setCopyWinners(await api<CopyCandidatesReport>(`/api/copytrade/winners?limit=${limit}${rosterSnapshotId ? `&snapshotId=${rosterSnapshotId}` : ''}`)); }
    catch (error: unknown) { setCopyTradeError(error instanceof Error ? error.message : String(error)); }
    finally { setCopyWinnersLoading(false); }
  };

  const loadCopySimulation = async (rosterSnapshotId = selectedRosterSnapshotId) => {
    setCopySimulationLoading(true);
    try { setCopySimulation(await api<CopySimulationReport>(`/api/copytrade/copy-simulation${rosterSnapshotId ? `?snapshotId=${rosterSnapshotId}` : ''}`)); }
    catch (error: unknown) { setCopyTradeError(error instanceof Error ? error.message : String(error)); }
    finally { setCopySimulationLoading(false); }
  };

  const loadLiquidityImpact = async (rosterSnapshotId = selectedRosterSnapshotId) => {
    setLiquidityImpactLoading(true);
    try { setLiquidityImpact(await api<LiquidityImpactReport>(`/api/copytrade/liquidity-impact${rosterSnapshotId ? `?snapshotId=${rosterSnapshotId}` : ''}`)); }
    catch (error: unknown) { setCopyTradeError(error instanceof Error ? error.message : String(error)); }
    finally { setLiquidityImpactLoading(false); }
  };

  const runCopySimulationBatch = async () => {
    setCopySimulationRunBusy(true);
    try {
      const result = await api<{ runIds: number[]; targetsSubmitted: number; batchesRun: number; exhausted: boolean }>(`/api/copytrade/copy-simulation/run${selectedRosterSnapshotId ? `?snapshotId=${selectedRosterSnapshotId}` : ''}`, { method: 'POST' });
      setMessage(result.targetsSubmitted > 0
        ? `Queried Dune for ${result.targetsSubmitted} entry/exit price${result.targetsSubmitted === 1 ? '' : 's'} across ${result.batchesRun} batch${result.batchesRun === 1 ? '' : 'es'}.${result.exhausted ? ' More remain — run again to continue.' : ''}`
        : 'Every eligible trade for the current top traders has already been queried.');
      await loadCopySimulation(selectedRosterSnapshotId ?? undefined);
      await loadLiquidityImpact(selectedRosterSnapshotId ?? undefined);
    } catch (error: unknown) { setCopyTradeError(error instanceof Error ? error.message : String(error)); }
    finally { setCopySimulationRunBusy(false); }
  };

  const loadCopyTradePage = async () => {
    setCopyTradeLoading(true);
    setCopyTradeError(null);
    try {
      const rosterCatalog = await api<CopyTradeRosterCatalog>('/api/copytrade/rosters');
      setCopyTradeRosters(rosterCatalog);
      const rosterSnapshotId = selectedRosterSnapshotId ?? rosterCatalog.selectedByDefault;
      if (selectedRosterSnapshotId === null && rosterSnapshotId !== null) setSelectedRosterSnapshotId(rosterSnapshotId);
      const snapshotQuery = rosterSnapshotId ? `&snapshotId=${rosterSnapshotId}` : '';
      const [summary, results, status] = await Promise.all([
        api<CopyTradeSummary>('/api/copytrade/summary'),
        // The selected period and trader count must scope the report too, not just the next
        // fetch — otherwise the table answers a different question than the controls describe.
        api<CopyTradeResults>(`/api/copytrade/results?periodDays=${copyTradePeriodDays}&limit=${copyTradeLimit}${snapshotQuery}`),
        api<CopyTradeFetchStatus>('/api/copytrade/fetch/status'),
      ]);
      setCopyTradeSummary(summary);
      setCopyTradeResults(results);
      setCopyTradeStatus(status);
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
      await loadExperiments();
      if (selectedExperimentId !== null) await loadExperimentDetail(selectedExperimentId);
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

  const ensureGmgnReady = async (): Promise<void> => {
    const status = await api<GmgnStatus>('/api/gmgn/status');
    setGmgnStatus(status);
    if (!status.configured) throw new Error(status.message);
  };

  const captureGmgnSignals = async () => {
    setCapturingGmgn(true);
    try {
      await ensureGmgnReady();
      const result = await api<{ captured: number; stored: number; repeated: number; errors: number; gapDetected: boolean; archivePath: string }>('/api/gmgn/capture', { method: 'POST' });
      await refresh();
      setMessage(`GMGN poll received ${result.captured}; stored ${result.stored}; repeated ${result.repeated}; issues ${result.errors}; gap ${result.gapDetected ? 'flagged' : 'not detected'}. ZIP archived.`);
    } catch (error: unknown) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setCapturingGmgn(false); }
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

  const loadWatchStatus = async () => {
    try {
      setWatchStatus(await api<GmgnWatchStatus>('/api/gmgn/watch/status'));
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const startWatch = async () => {
    setWatchBusy(true);
    try {
      await ensureGmgnReady();
      const status = await api<GmgnWatchStatus>('/api/gmgn/watch/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intervalSeconds: watchIntervalMinutes * 60 }),
      });
      setWatchStatus(status);
      setMessage(`Watch mode started — polling every ${watchIntervalMinutes} min.`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setWatchBusy(false);
    }
  };

  const stopWatch = async () => {
    setWatchBusy(true);
    try {
      setWatchStatus(await api<GmgnWatchStatus>('/api/gmgn/watch/stop', { method: 'POST' }));
      setMessage('Watch mode stopped.');
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setWatchBusy(false);
    }
  };

  useEffect(() => {
    if (!watchStatus?.running) return;
    const timer = window.setInterval(() => { void loadWatchStatus(); }, 4000);
    return () => window.clearInterval(timer);
  }, [watchStatus?.running]);

  useEffect(() => {
    void loadCopyTradeStatus();
  }, []);

  useEffect(() => {
    if (activeMenu !== 'copytrade') return;
    void loadCopyTradePage();
  }, [activeMenu]);
  useEffect(() => {
    if (activeMenu !== 'copytrade' || selectedRosterSnapshotId === null) return;
    void loadCopyTradePage();
  }, [selectedRosterSnapshotId]);

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

  useEffect(() => { void loadCopyTradeEstimate(copyTradeLimit, copyTradePeriodDays); }, [copyTradeLimit, copyTradePeriodDays]);
  // Lazy per sub-tab, mirroring the subgroup-report pattern elsewhere: only fetched once the
  // reader actually opens that tab, not on every CopyTrade page load.
  useEffect(() => {
    if (copyTradeSubTab === 'historical-consistency') void loadHistoricalConsistency(copyTradeLimit, selectedRosterSnapshotId ?? undefined);
    else if (copyTradeSubTab === 'forward-validation') { void loadCaptureHealth(); void loadExperiments(); }
    else if (copyTradeSubTab === 'top-callers') {
      void loadTopCallerData();
      (['leaderboard', 'callouts', 'checkpoints'] as TopCallerCollectionKind[]).forEach((kind) => { void loadTopCallerStatus(kind); });
    }
  }, [copyTradeSubTab, copyTradeLimit, selectedRosterSnapshotId]);
  useEffect(() => { if (selectedExperimentId !== null) void loadExperimentDetail(selectedExperimentId); }, [selectedExperimentId]);
  useEffect(() => {
    if (copyTradeSubTab !== 'top-callers' || !topCallerSelectedKey) return;
    void api<TopCallerDetail>(`/api/top-callers/callers/${encodeURIComponent(topCallerSelectedKey)}`).then(setTopCallerDetail).catch((error: unknown) => setTopCallerError(error instanceof Error ? error.message : String(error)));
    void api<TopCallerCheckpointBreakdown>(`/api/top-callers/callers/${encodeURIComponent(topCallerSelectedKey)}/checkpoints`).then(setTopCallerCheckpointBreakdown).catch((error: unknown) => setTopCallerError(error instanceof Error ? error.message : String(error)));
  }, [copyTradeSubTab, topCallerSelectedKey]);
  useEffect(() => {
    if (copyTradeSubTab !== 'top-callers') return;
    const kinds = (['leaderboard', 'callouts', 'checkpoints'] as TopCallerCollectionKind[]).filter((kind) => topCallerRunStatus[kind]?.running);
    if (kinds.length === 0) return;
    const timer = window.setInterval(async () => {
      let terminal = false;
      for (const kind of kinds) {
        const status = await loadTopCallerStatus(kind);
        if (status && !status.running) terminal = true;
      }
      if (terminal) await loadTopCallerData();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [copyTradeSubTab, topCallerRunStatus.leaderboard?.running, topCallerRunStatus.callouts?.running, topCallerRunStatus.checkpoints?.running]);
  useEffect(() => {
    if (copyTradeSubTab !== 'top-callers') return;
    const timer = window.setInterval(() => setTopCallerClockMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [copyTradeSubTab]);
  // Winners is the default-visible content now (everything else is behind the research
  // toggle), so unlike the sub-tab data above it loads unconditionally, not lazily.
  useEffect(() => { void loadCopyWinners(copyTradeLimit, selectedRosterSnapshotId ?? undefined); }, [copyTradeLimit, selectedRosterSnapshotId]);
  useEffect(() => { void loadCopySimulation(selectedRosterSnapshotId ?? undefined); void loadLiquidityImpact(selectedRosterSnapshotId ?? undefined); }, [selectedRosterSnapshotId]);

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

  useEffect(() => { void refresh().catch((error: unknown) => setMessage(String(error))); }, []);
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

  const runBirdeyeProbe = async () => {
    setProbeBusy(true);
    try {
      const result = await api<{ status: string; priceHttpStatus: number | null; liquidityHttpStatus: number | null; priceUsd: number | null; currentLiquidityHttpStatus: number | null; currentLiquidityUsd: number | null; liquidityMessage: string | null; archivePath: string | null; error: string | null }>('/api/birdeye/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokenAddress: probeAddress.trim(), targetTimestamp: new Date(probeTime).toISOString() }) });
      setProbeResult(result);
      setMessage(`Birdeye probe ${result.status}. Raw price/liquidity responses archived.`);
    } catch (error: unknown) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setProbeBusy(false); }
  };

  const navigateTo = (section: string) => {
    setActiveMenu(section);
    if (section === 'copytrade') setCopyTradeSubTab('research');
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
    if (window.location.hash.slice(1) === 'birdeye-batch') window.history.replaceState({}, '', '#dune-capture');
    const onLocationChange = () => {
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
  const sortedCopyTradeRows = [...copyTradeRows].sort((left, right) => {
    const value = (row: CopyTradeRow): string | number | null => copyTradeSort.key === 'name' ? (row.name ?? row.walletAddress) : copyTradeSort.key === 'verdict' ? row.verdict : row[copyTradeSort.key];
    const leftValue = value(left);
    const rightValue = value(right);
    const comparison = leftValue === null && rightValue === null ? 0 : leftValue === null ? 1 : rightValue === null ? -1 : typeof leftValue === 'number' && typeof rightValue === 'number' ? leftValue - rightValue : String(leftValue).localeCompare(String(rightValue));
    return (copyTradeSort.direction === 'asc' ? 1 : -1) * comparison;
  });
  const toggleCopyTradeSort = (key: CopyTradeSortKey) => setCopyTradeSort((current) => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' }));
  const copyTradeSortIndicator = (key: CopyTradeSortKey) => copyTradeSort.key === key ? (copyTradeSort.direction === 'asc' ? ' ↑' : ' ↓') : '';
  const toggleTopCallerTableSort = (key: TopCallerTableSortKey) => {
    setTopCallerTableSort((current) => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' }));
    setTopCallerAllPage(0);
  };
  const topCallerTableSortIndicator = (key: TopCallerTableSortKey) => topCallerTableSort.key === key ? (topCallerTableSort.direction === 'asc' ? ' ↑' : ' ↓') : '';
  const medianAverageConflicts = copyTradeRows.filter((row) => row.medianReturnPercent !== null && row.averageReturnPercent !== null && Math.sign(row.medianReturnPercent) !== Math.sign(row.averageReturnPercent));
  const winnerSimulationWallets = copySimulation && copyWinners
    ? copySimulation.wallets.filter((wallet) => copyWinners.candidates.some((candidate) => candidate.walletAddress === wallet.walletAddress))
    : [];
  const copyTradeProgressPercent = copyTradeStatus && (copyTradeStatus.walletTotal ?? 0) > 0 ? Math.min(100, (copyTradeStatus.walletDone ?? 0) / (copyTradeStatus.walletTotal ?? 1) * 100) : null;
  const signalRoutes = new Set(['imports', 'capture', 'dune-capture', 'patterns']);
  const signalMenuActive = signalRoutes.has(activeMenu);
  const navigateSignal = () => navigateTo('dune-capture');
  return <main className={`shell routed-view page-${activeMenu} ${focusedView ? 'focused-view' : ''}`}>
    <header className="hero">
      <div>
        <p className="eyebrow">GMGN / DUNE · BACKTEST</p>
        <h1>GMGN/Dune Backtest</h1>
        <p className="lede">A local collection desk for Solana cohort exports and GMGN observations. Every upload is persisted to SQLite, logged, and archived as a ZIP.</p>
      </div>
      <div className="status-pill"><span className="dot" /> SQLite connected</div>
    </header>

    <nav className="section-nav" aria-label="Research desk sections">
      <button className={`nav-button advanced-toggle ${focusedView ? 'active' : ''}`} onClick={() => setFocusedView((current) => !current)}>{focusedView ? 'Main workflow' : 'Show all sections'}</button>
      <button className={`nav-button advanced-section ${activeMenu === 'overview' ? 'active' : ''}`} onClick={() => navigateTo('overview')}>Overview</button>
      <button className={`nav-button ${signalMenuActive ? 'active' : ''}`} onClick={navigateSignal}>Signal</button>
      <button className={`nav-button ${activeMenu === 'copytrade' ? 'active' : ''}`} onClick={() => navigateTo('copytrade')}>CopyTrade</button>
      <button className={`nav-button advanced-section ${activeMenu === 'analysis' ? 'active' : ''}`} onClick={() => navigateTo('analysis')}>Snapshot Analysis</button>
      <button className={`nav-button advanced-section ${activeMenu === 'scoring' ? 'active' : ''}`} onClick={() => navigateTo('scoring')}>Scoring</button>
      <button className={`nav-button advanced-section ${activeMenu === 'evidence' ? 'active' : ''}`} onClick={() => navigateTo('evidence')}>Evidence</button>
      <button className={`nav-button advanced-section ${activeMenu === 'diagnostics' ? 'active' : ''}`} onClick={() => navigateTo('diagnostics')}>Diagnostics</button>
    </nav>
    {signalMenuActive && <nav className="subsection-nav" aria-label="Signal workspace">
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
      <details className="signal-legend raw-endpoint-details" open={rawEndpointOpen} onToggle={(event) => { if (event.currentTarget.open !== rawEndpointOpen) void openRawEndpointSection(); }}>
        <summary>Raw endpoint captures (radar / wallet rank / smart money / Twitter)</summary>
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
            {rawEndpointType === 'smart-money' && 'walletAddress' in row && <><td><span className="address-compact" title={row.walletAddress}>{row.walletAddress}</span></td><td>{row.chain ?? '—'}</td></>}
            {rawEndpointType === 'twitter' && 'twType' in row && <><td>{row.twType ?? '—'}</td><td>{row.hasToken === null ? '—' : row.hasToken ? 'yes' : 'no'}</td></>}
            <td>{formatTime(row.capturedAt)}</td>
            <td><button className="secondary" onClick={() => setRawEndpointExpandedId(rawEndpointExpandedId === row.id ? null : row.id)}>{rawEndpointExpandedId === row.id ? 'Hide raw' : 'Show raw'}</button></td>
          </tr>
          {rawEndpointExpandedId === row.id && <tr className="raw-endpoint-json-row"><td colSpan={4}><pre>{JSON.stringify(row.rawPayload, null, 2)}</pre></td></tr>}
        </Fragment>)}</tbody></table></div>}
      </details>
    </section>

    <section className="menu-section panel watch-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">GMGN WATCH MODE</p><h2>Continuous local polling</h2></div>
        <span className={`tag ${watchStatus?.running ? 'tag-good' : ''}`}>{watchStatus?.running ? 'RUNNING' : 'STOPPED'}</span>
      </div>
      <p>Repeats the same one-off capture on a timer while this app stays open. No cloud service, no background task — polling stops the moment the local server stops, and stops itself after repeated failures.</p>
      {/* GMGN_WATCH_MODE_ENABLED is false for now — continuous polling is disabled (code kept intact; server also rejects /watch/start). Use "Fetch once" in the meantime. */}
      {!GMGN_WATCH_MODE_ENABLED && <p className="probe-result">Continuous polling is temporarily disabled. "Fetch once" still works below.</p>}
      <div className="watch-controls">
        <label>Interval
          <select value={watchIntervalMinutes} disabled={!GMGN_WATCH_MODE_ENABLED || watchStatus?.running} onChange={(event) => setWatchIntervalMinutes(Number(event.target.value))}>
            <option value={1}>1 minute</option>
            <option value={5}>5 minutes</option>
            <option value={15}>15 minutes</option>
            <option value={30}>30 minutes</option>
            <option value={60}>60 minutes</option>
          </select>
        </label>
        <button className="secondary" disabled={capturingGmgn} onClick={() => void captureGmgnSignals()}>{capturingGmgn ? 'Fetching…' : 'Fetch once'}</button>
        {watchStatus?.running
          ? <button className="primary" disabled={watchBusy} onClick={() => void stopWatch()}>{watchBusy ? 'Stopping…' : 'Stop watching'}</button>
          : <button className="primary" disabled={!GMGN_WATCH_MODE_ENABLED || watchBusy} onClick={() => void startWatch()}>{GMGN_WATCH_MODE_ENABLED ? (watchBusy ? 'Starting…' : 'Start watching') : 'Disabled for now'}</button>}
      </div>
      <div className="credential-status">
        <span className={`status-dot ${watchStatus?.running ? 'good' : ''}`} />
        <div>
          <strong>{watchStatus?.running ? `Running — next poll ${formatTime(watchStatus.nextPollAt)}` : watchStatus?.stoppedReason ? `Stopped: ${watchStatus.stoppedReason}` : 'Not running'}</strong>
          <small>{watchStatus?.lastPoll
            ? `Last poll ${formatTime(watchStatus.lastPoll.at)}: ${watchStatus.lastPoll.ok
              ? `+${watchStatus.lastPoll.stored ?? 0} new · ${watchStatus.lastPoll.repeated ?? 0} repeats · ${watchStatus.lastPoll.errors ?? 0} issues${watchStatus.lastPoll.gapDetected ? ' · gap flagged' : ''}`
              : `failed — ${watchStatus.lastPoll.message ?? 'unknown error'}`}`
            : 'No polls yet this session.'}</small>
        </div>
      </div>
      {watchStatus && watchStatus.totalPolls > 0 && <p className="watch-totals">{watchStatus.totalPolls} polls this session · {watchStatus.totalStored} new signals · {watchStatus.totalRepeated} repeats · {watchStatus.consecutiveFailures} consecutive failures</p>}
      {watchStatus?.rateLimitedUntil && <p className="probe-result">Rate-limited by GMGN — resuming at {formatTime(watchStatus.rateLimitedUntil)}</p>}
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
      <details className="signal-legend"><summary>Signal-type legend</summary><div className="signal-legend-grid">{Object.keys(SIGNAL_TYPE_LABELS).map((code) => <div key={code}><b>{code} · {SIGNAL_TYPE_LABELS[code]}</b><small>{SIGNAL_TYPE_DESCRIPTIONS[code]}</small></div>)}</div><small>Names and high-level meanings are from GMGNAI’s official gmgn-skills CLI documentation. GMGN does not publish every wallet-classification, amount, count, or time-window threshold here, so these labels are observations—not quality or profitability verdicts.</small></details>
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
      {measurementPlan && prescreenCounts && <details className="measurement-explanation">
        <summary>How this Dune pass works <small>{prescreenTotal} stored signals reviewed; nothing was deleted</small></summary>
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
      </details>}
      {measurementPlan && selectedMeasurementProgress && <>
        <p className="measurement-summary">
          <span className="status-good">{selectedMeasurementProgress.measured}</span> complete outcomes · <span className={selectedMeasurementProgress.retryEligibleSelected > 0 ? 'status-warn' : ''}>{selectedMeasurementProgress.retryEligibleSelected}</span> ready to re-fetch · <span className={selectedMeasurementProgress.unmeasured > 0 ? 'status-warn' : ''}>{selectedMeasurementProgress.unmeasured}</span> not complete
          {selectedMeasurementProgress.inFlight > 0 && <> · <span className="status-warn">{selectedMeasurementProgress.inFlight} stuck (use Reconcile above)</span></>}
          {selectedUpToDate && ' — up to date'}
        </p>
        <details className="signal-legend">
          <summary>Measurement details</summary>
          <div className="measurement-status-grid">
            <div><b>GMGN parsing</b><span className="status-good">COMPLETE</span><small>{selectedMeasurementProgress.captured} normalized signals stored</small><small>latest capture {formatTime(measurementPlan.latestCapturedAt)}</small></div>
            <div><b>Dune outcomes</b><span className={selectedUpToDate ? 'status-good' : 'status-warn'}>{selectedUpToDate ? 'COMPLETE' : 'PARTIAL'}</span><small>{selectedMeasurementProgress.measured} complete outcomes · {selectedMeasurementProgress.retryEligibleSelected} ready to re-fetch · {selectedWaitingCount} waiting</small><small>last completed run {formatTime(measurementPlan.latestDuneCompletedAt)}</small></div>
            <div><b>Next Dune work</b><span className={selectedUpToDate ? 'status-good' : selectedMeasurementProgress.inFlight > 0 && selectedMeasurementProgress.eligible === 0 ? 'status-warn' : 'status-warn'}>{selectedUpToDate ? 'UP TO DATE' : selectedMeasurementProgress.inFlight > 0 && selectedMeasurementProgress.eligible === 0 ? 'IN FLIGHT' : selectedWaitingCount > 0 && selectedMeasurementProgress.eligible === 0 ? 'WAITING' : 'PENDING'}</span><small>{selectedMeasurementProgress.newEligible} new · {selectedMeasurementProgress.retryEligibleSelected} retries · {selectedMeasurementProgress.eligible} total selected</small><small>{selectedMeasurementProgress.pending} waiting for target time · {selectedMeasurementProgress.complete} complete · {selectedMeasurementProgress.inFlight} in flight</small><small>Pre-screen: {measurementPlan.prescreen.byDisposition.eligible_core ?? 0} core · {measurementPlan.prescreen.byDisposition.eligible_audit ?? 0} audit · {(measurementPlan.prescreen.byDisposition.deferred_repeat ?? 0) + (measurementPlan.prescreen.byDisposition.deferred_budget ?? 0)} deferred · {measurementPlan.prescreen.byDisposition.too_fresh ?? 0} waiting for buffer</small></div>
          </div>
        </details>
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
      {patternSnapshots.length > 0 && <details className="pattern-history"><summary>Saved snapshots ({patternSnapshots.length})</summary>
        <div className="pattern-history-list">{patternSnapshots.map((snapshot) => <div key={snapshot.id} className="pattern-history-row"><span>#{snapshot.id} · {formatTime(snapshot.computedAt)} · {snapshot.sourceRunIds.length} source run{snapshot.sourceRunIds.length === 1 ? '' : 's'}</span><button className="secondary" onClick={() => setViewingSnapshotId(snapshot.id)}>View</button></div>)}</div>
      </details>}
      <details className="pattern-subgroups" open={subgroupOpened} onToggle={(event) => { const open = event.currentTarget.open; setSubgroupOpened(open); if (open && !subgroupReport && !subgroupBusy) void loadSubgroupReport(subgroupProperty); }}>
        <summary>Subgroup breakdown: signal type × property (exploratory)</summary>
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
      </details>
    </section>

    <details className="outcome-results-details" open={false}><summary>Measured results ({outcomeTimelines.length})</summary><div className="outcome-results-controls"><label>Rows per page<select value={outcomePageSize} onChange={(event) => { const value = event.target.value; setOutcomePageSize(value === 'all' ? 'all' : Number(value)); setOutcomePage(0); }}><option value="25">25</option><option value="100">100</option><option value="1000">1,000</option><option value="all">All</option></select></label><button type="button" className="secondary" disabled={outcomePage === 0 || outcomePageSize === 'all'} onClick={() => setOutcomePage((page) => Math.max(0, page - 1))}>Previous</button><span>Page {Math.min(outcomePage + 1, outcomePageCount)} of {outcomePageCount}</span><button type="button" className="secondary" disabled={outcomePageSize === 'all' || outcomePage + 1 >= outcomePageCount} onClick={() => setOutcomePage((page) => Math.min(outcomePageCount - 1, page + 1))}>Next</button></div><div className="table-wrap outcome-table outcome-table-visible"><table><thead><tr>{outcomeColumns.map((column) => <th key={column.key} onClick={() => toggleOutcomeSort(column.key)} className="sortable-header" title="Click to sort">{column.label}{sortIndicator(column.key)}</th>)}</tr></thead><tbody>{visibleOutcomeTimelines.map((timeline) => { const base = timeline.checkpoints.find((checkpoint) => checkpoint.label === 'signal')?.result.priceUsd ?? null; return <tr key={timeline.signal.id}><td>#{timeline.signal.id}</td><td>{formatSignalType(timeline.signal.signalType)}</td>{CHECKPOINT_COLUMNS.map((label) => renderCheckpointCell(timeline, base, label))}<td><span className="token-cell" title={timeline.signal.tokenAddress}>{tokenDisplay(timeline.signal.symbol, timeline.signal.tokenAddress)} <button type="button" className="copy-address" aria-label={`Copy address ${timeline.signal.tokenAddress}`} onClick={() => void copyAddress(timeline.signal.tokenAddress)}>⧉</button></span></td></tr>; })}</tbody></table></div></details>

    <section id="copytrade" className="menu-section panel copytrade-panel">
      <div className="panel-heading"><div><p className="eyebrow">COPYTRADE · RESEARCH</p><h2>Top-trader copy research</h2></div><span className="tag">$100 START</span></div>
      <p className="compact-info-line"><span>Historical wallet research</span><InfoTip label="About CopyTrade research" text="Fetches GMGN trade history, preserves it in SQLite, and estimates what a $100 copy would have become. Results are descriptive research, not trading instructions." /></p>
      <nav className="subsection-nav copytrade-subnav" aria-label="CopyTrade sections">
        <span className="subsection-label">CopyTrade</span>
        <button className={`nav-button ${copyTradeSubTab === 'research' ? 'active' : ''}`} onClick={() => navigateCopyTradeSubTab('research')}>Top-trader copy research</button>
        <button className={`nav-button ${copyTradeSubTab === 'winners' ? 'active' : ''}`} onClick={() => navigateCopyTradeSubTab('winners')}>Winners</button>
        <button className={`nav-button ${copyTradeSubTab === 'historical-consistency' ? 'active' : ''}`} onClick={() => navigateCopyTradeSubTab('historical-consistency')}>Historical consistency</button>
        <button className={`nav-button ${copyTradeSubTab === 'forward-validation' ? 'active' : ''}`} onClick={() => navigateCopyTradeSubTab('forward-validation')}>Forward validation</button>
        <button className={`nav-button ${copyTradeSubTab === 'top-callers' ? 'active' : ''}`} onClick={() => navigateCopyTradeSubTab('top-callers')}>Top callers</button>
      </nav>

      {copyTradeSubTab === 'research' && <div className="copytrade-research-route">
      <div className="copytrade-fetch-box">
        <div className="copytrade-fields">
          <label>Top traders<select value={copyTradeLimit} onChange={(event) => setCopyTradeLimit(Number(event.target.value))}><option value="25">25</option><option value="50">50</option><option value="100">100</option><option value="250">250</option></select></label>
          <label>Period<select value={copyTradePeriodDays} onChange={(event) => setCopyTradePeriodDays(Number(event.target.value))}><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></select></label>
          <label>Roster source<select value={selectedRosterSnapshotId ?? ''} onChange={(event) => setSelectedRosterSnapshotId(event.target.value ? Number(event.target.value) : null)} disabled={!copyTradeRosters?.snapshots.length}>
            {copyTradeRosters?.snapshots.length ? copyTradeRosters.snapshots.map((snapshot) => <option key={snapshot.snapshotId} value={snapshot.snapshotId}>#{snapshot.snapshotId} · {snapshot.window ?? 'legacy'} / {snapshot.orderby ?? 'unknown'} · {formatTime(snapshot.capturedAt)}</option>) : <option value="">No snapshots</option>}
          </select></label>
          {copyTradeStatus?.running
            ? <button className="secondary copytrade-stop-button" disabled={copyTradeStopBusy} onClick={() => void stopCopyTradeFetch()}>{copyTradeStopBusy ? 'Stopping…' : 'Stop fetch'}</button>
            : <button className="primary" disabled={copyTradeBusy} onClick={() => void fetchCopyTrades()}>{copyTradeBusy ? 'Starting…' : 'Fetch trades'}</button>}
        </div>
        {!copyTradeStatus?.running && copyTradeEstimate && (
          <p className="copytrade-estimate" title={copyTradeEstimateConfidenceLabel[copyTradeEstimate.confidence]}>
            Approximate timeline: <strong>{formatDuration(copyTradeEstimate.estimatedSeconds)}</strong>
            {' '}for {formatCount(copyTradeEstimate.walletCount)} wallets
            {' '}({formatCount(copyTradeEstimate.freshWallets)} need new history, {formatCount(copyTradeEstimate.coveredWallets)} already covered)
            {copyTradeEstimateLoading && ' · updating…'}
            <InfoTip label="Estimate basis" text={copyTradeEstimate.basis.source === 'measured'
              ? `Based on ${copyTradeEstimate.basis.runsCounted} completed fetch${copyTradeEstimate.basis.runsCounted === 1 ? '' : 'es'}${copyTradeEstimate.basis.updatedAt ? `; last updated ${formatTime(copyTradeEstimate.basis.updatedAt)}` : ''}.`
              : 'No completed fetch yet; this is a seeded estimate that will sharpen after the first run.'} />
          </p>
        )}
        {copyTradeStatus?.running && copyTradeStatus.scope === 'roster' && <div className="copytrade-progress"><div className="copytrade-progress-heading"><strong>Fetching trades</strong><span>{formatCount(copyTradeStatus.walletDone)}/{formatCount(copyTradeStatus.walletTotal)} wallets · {formatCount(copyTradeStatus.tradesFetched)} trades{copyTradeStatus.estimatedRemainingSeconds !== null && <> · ~{formatDuration(copyTradeStatus.estimatedRemainingSeconds)} remaining</>}</span></div><div className="copytrade-progress-track"><i style={{ width: `${copyTradeProgressPercent ?? 12}%` }} /></div><small>{copyTradeStatus.message || 'Saving each wallet and trade to SQLite.'}</small></div>}
        {copyTradeStatus && !copyTradeStatus.running && copyTradeStatus.scope === 'roster' && copyTradeStatus.status === 'completed' && <small className="copytrade-fetch-summary">{copyTradeStatus.message}</small>}
        {copyTradeStatus && !copyTradeStatus.running && copyTradeStatus.scope === 'roster' && copyTradeStatus.status === 'rate_limited' && <p className="copytrade-status-warning">Rate limited until {copyTradeStatus.rateLimitedUntil ? formatTime(copyTradeStatus.rateLimitedUntil) : '—'}. Retrying early can extend the wait.</p>}
        {copyTradeStatus && !copyTradeStatus.running && copyTradeStatus.scope === 'roster' && copyTradeStatus.status === 'failed' && <p className="copytrade-status-warning">Fetch failed: {copyTradeStatus.message || 'See diagnostics for details.'}</p>}
        {copyTradeError && <p className="copytrade-status-warning">{copyTradeError}</p>}
          <p className="compact-info-line"><span>GMGN API → SQLite</span><InfoTip label="Fetch storage rules" text="Existing data is retained. Repeated fetches append only new observations and do not overwrite historical rows." /></p>
      </div>

      <div className="copytrade-fetch-box single-trader-box">
        <div className="copytrade-fields single-trader-fields">
          <label className="single-trader-input">Wallet address or trader name<input type="text" value={singleTraderQuery} placeholder="e.g. DxM1hf… or a trader's name" onChange={(event) => setSingleTraderQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void fetchSingleTrader(); }} /></label>
          <button className="primary" disabled={singleTraderBusy || !singleTraderQuery.trim() || copyTradeStatus?.running} onClick={() => void fetchSingleTrader()}>{singleTraderBusy ? 'Looking up…' : 'Fetch this trader'}</button>
        </div>
        <p className="compact-info-line"><span>Address/name lookup</span><InfoTip label="Lookup rules" text="Wallet-shaped input is used directly. Other text is matched only against names already captured from a real leaderboard snapshot; unknown names are never guessed." /></p>
        {copyTradeStatus?.running && copyTradeStatus.scope === 'single' && <div className="copytrade-progress"><div className="copytrade-progress-heading"><strong>Fetching trades</strong><span>{formatCount(copyTradeStatus.walletDone)}/{formatCount(copyTradeStatus.walletTotal)} wallets · {formatCount(copyTradeStatus.tradesFetched)} trades</span></div><div className="copytrade-progress-track"><i style={{ width: `${copyTradeProgressPercent ?? 12}%` }} /></div><small>{copyTradeStatus.message || 'Saving trades to SQLite.'}</small></div>}
        {copyTradeStatus && !copyTradeStatus.running && copyTradeStatus.scope === 'single' && copyTradeStatus.status === 'completed' && <small className="copytrade-fetch-summary">{copyTradeStatus.message}</small>}
        {copyTradeStatus && !copyTradeStatus.running && copyTradeStatus.scope === 'single' && copyTradeStatus.status === 'rate_limited' && <p className="copytrade-status-warning">Rate limited until {copyTradeStatus.rateLimitedUntil ? formatTime(copyTradeStatus.rateLimitedUntil) : '—'}. Retrying early can extend the wait.</p>}
        {copyTradeStatus && !copyTradeStatus.running && copyTradeStatus.scope === 'single' && copyTradeStatus.status === 'failed' && <p className="copytrade-status-warning">Fetch failed: {copyTradeStatus.message || 'See diagnostics for details.'}</p>}
        {singleTraderError && <p className="copytrade-status-warning">{singleTraderError}</p>}
      </div>

      <p className="eyebrow copytrade-step-label">STORED</p>
      <div className="quality-grid copytrade-summary-grid">
        <div className="quality-metric"><strong>{formatCount(copyTradeSummary?.traders ?? null)}</strong><span>traders</span></div>
        <div className="quality-metric"><strong>{formatCount(copyTradeSummary?.trades ?? null)}</strong><span>trades</span></div>
        <div className="quality-metric"><strong>{formatCount(copyTradeSummary?.historyDays ?? null)}</strong><span>history days</span></div>
        <div className="quality-metric"><strong>{formatPct(copyTradeSummary?.verifiedPercent ?? null)}</strong><span>verified</span><small className="compact-info-line"><span>Last run</span><InfoTip label="Last fetch time" text={formatTime(copyTradeSummary?.lastRunAt ?? null)} /></small></div>
      </div>
      {copyTradeLoading && <p className="muted">Loading saved CopyTrade results…</p>}
      </div>}

      {copyTradeSubTab === 'winners' && <div className="winners-route">
      <div className="copytrade-fetch-box">
        <div className="copytrade-fields">
          {copyTradeStatus?.running
            ? <button className="secondary copytrade-stop-button" disabled={copyTradeStopBusy} onClick={() => void stopCopyTradeFetch()}>{copyTradeStopBusy ? 'Stopping…' : 'Stop fetch'}</button>
            : <button className="primary" disabled={winnersFetchBusy} onClick={() => void fetchWinnersTrades()}>{winnersFetchBusy ? 'Starting…' : "Fetch winners' trades"}</button>}
        </div>
        <p className="compact-info-line"><span>Current winners only</span><InfoTip label="Winner fetch scope" text="Fetches only wallets that currently qualify as Winners and only what is missing since each wallet's last fetch. It does not start a new top-N discovery run." /></p>
        {copyTradeStatus?.running && copyTradeStatus.scope === 'winners' && <div className="copytrade-progress"><div className="copytrade-progress-heading"><strong>Fetching trades</strong><span>{formatCount(copyTradeStatus.walletDone)}/{formatCount(copyTradeStatus.walletTotal)} wallets · {formatCount(copyTradeStatus.tradesFetched)} trades{copyTradeStatus.estimatedRemainingSeconds !== null && <> · ~{formatDuration(copyTradeStatus.estimatedRemainingSeconds)} remaining</>}</span></div><div className="copytrade-progress-track"><i style={{ width: `${copyTradeProgressPercent ?? 12}%` }} /></div><small>{copyTradeStatus.message || 'Saving each wallet and trade to SQLite.'}</small></div>}
        {copyTradeStatus && !copyTradeStatus.running && copyTradeStatus.scope === 'winners' && copyTradeStatus.status === 'completed' && <small className="copytrade-fetch-summary">{copyTradeStatus.message}</small>}
        {copyTradeStatus && !copyTradeStatus.running && copyTradeStatus.scope === 'winners' && copyTradeStatus.status === 'rate_limited' && <p className="copytrade-status-warning">Rate limited until {copyTradeStatus.rateLimitedUntil ? formatTime(copyTradeStatus.rateLimitedUntil) : '—'}. Retrying early can extend the wait.</p>}
        {copyTradeStatus && !copyTradeStatus.running && copyTradeStatus.scope === 'winners' && copyTradeStatus.status === 'failed' && <p className="copytrade-status-warning">Fetch failed: {copyTradeStatus.message || 'See diagnostics for details.'}</p>}
        {copyTradeError && <p className="copytrade-status-warning">{copyTradeError}</p>}
      </div>

      <div className="copytrade-winners">
        <p className="eyebrow copytrade-step-label">WINNERS</p>
        <p className="compact-info-line"><span>Current Screen Pass winners</span><InfoTip label="Winner rules" text="Winners must pass historical consistency and copyability gates: sufficient earlier and recent history, no split-second flip pattern, and no single-token concentration. Return ranks only wallets that clear every gate." /></p>
        {copyWinnersLoading && <p className="muted">Loading…</p>}
        {copyWinners && copyWinners.candidates.length === 0 && <p className="muted">
          No wallets currently pass every gate ({copyWinners.excludedCount} of {copyWinners.screenedCount} screened traders were close but fell short).
          {copyWinners.pendingCopySimulationCount > 0 && <> {copyWinners.pendingCopySimulationCount} trader{copyWinners.pendingCopySimulationCount === 1 ? '' : 's'} passed every other gate but still need{copyWinners.pendingCopySimulationCount === 1 ? 's' : ''} copy-survival verification — click Run simulation below to check {copyWinners.pendingCopySimulationCount === 1 ? 'it' : 'them'}.</>}
        </p>}
        {copyWinners && copyWinners.candidates.length > 0 && <div className="winner-list">
          {copyWinners.candidates.map((candidate) => (
            <div className="winner-card" key={candidate.walletAddress}>
              <div className="winner-headline">
                <strong>{candidate.name?.trim() || shortAddress(candidate.walletAddress)}</strong>
                <span className={`winner-median ${(candidate.medianReturnPercent ?? 0) >= 0 ? 'copytrade-positive' : 'copytrade-negative'}`}>{formatPct(candidate.medianReturnPercent)} median</span>
              </div>
              <a className="primary winner-copy-link" href={candidate.gmgnProfileUrl} target="_blank" rel="noreferrer">Copy on GMGN ↗</a>
            </div>
          ))}
        </div>}
      </div>

      <div className="copy-simulation">
        <p className="eyebrow copytrade-step-label">COPY SIMULATION</p>
        <p className="compact-info-line"><span>Winner-only delayed-copy estimate</span><InfoTip label="Copy simulation method" text="Estimates a copier entering and exiting a few seconds later, using nearby market prices instead of the trader's own fills. It is historical estimation, not live execution." /></p>
        {copySimulationLoading && <p className="muted">Loading…</p>}
        {copySimulation && copyWinners && winnerSimulationWallets.length === 0 && <p className="muted">No winner has a completed copy simulation yet.</p>}
        {winnerSimulationWallets.length > 0 && <div className="copy-sim-winner-grid">
          {winnerSimulationWallets.map((wallet) => {
            const winner = copyWinners?.candidates.find((candidate) => candidate.walletAddress === wallet.walletAddress);
            const own = wallet.walletMedianReturnPercent;
            const copier = wallet.simulatedMedianReturnPercent;
            const scale = Math.max(10, Math.abs(own ?? 0), Math.abs(copier ?? 0));
            const coverage = wallet.coverageRatePercent ?? 0;
            const delay = wallet.delayCostPercentagePoints;
            return <article className="copy-sim-winner-card" key={wallet.walletAddress}>
              <header className="copy-sim-winner-header">
                <div><strong>{winner?.name?.trim() || shortAddress(wallet.walletAddress)}</strong><small title={wallet.walletAddress}>{shortAddress(wallet.walletAddress)}</small></div>
                <span className="copy-sim-winner-badge">SCREEN PASS</span>
              </header>
              <div className="copy-sim-comparison" aria-label="Wallet and simulated copier median return comparison">
                <div className="copy-sim-comparison-row"><span>Wallet median</span><div className="copy-sim-bar-track"><i className={(own ?? 0) >= 0 ? 'positive' : 'negative'} style={{ width: `${Math.min(100, Math.abs(own ?? 0) / scale * 100)}%` }} /></div><b className={(own ?? 0) >= 0 ? 'copytrade-positive' : 'copytrade-negative'}>{formatPct(own)}</b></div>
                <div className="copy-sim-comparison-row"><span>Copier median</span><div className="copy-sim-bar-track"><i className={(copier ?? 0) >= 0 ? 'positive' : 'negative'} style={{ width: `${Math.min(100, Math.abs(copier ?? 0) / scale * 100)}%` }} /></div><b className={(copier ?? 0) >= 0 ? 'copytrade-positive' : 'copytrade-negative'}>{formatPct(copier)}</b></div>
              </div>
              <div className="copy-sim-winner-summary"><strong className={delay !== null && delay >= 0 ? 'copytrade-positive' : 'copytrade-negative'}>{delay === null ? '—' : `${delay >= 0 ? '+' : ''}${delay.toFixed(2)}pp`}</strong><span>impact from delayed entry/exit</span></div>
              <dl className="copy-sim-detail-grid">
                <div><dt>Coverage</dt><dd>{wallet.copiedTrades} / {wallet.roundTripsConsidered} <small>({coverage}%)</small></dd></div>
                <div><dt>Missed trades</dt><dd>{wallet.missedTrades}</dd></div>
                <div><dt>Worst copied trade</dt><dd className="copytrade-negative">{formatPct(wallet.worstSimulatedReturnPercent)}</dd></div>
                <div><dt>Gas</dt><dd>{wallet.totalGasFeeSol !== null ? `${wallet.totalGasFeeSol} SOL` : '—'}</dd></div>
              </dl>
              {(() => {
                const concentration = liquidityImpact?.byWallet.find((w) => w.walletAddress === wallet.walletAddress);
                const totalBanded = concentration ? concentration.bands.reduce((sum, b) => sum + b.tradeCount, 0) : 0;
                if (!concentration || totalBanded === 0) return null;
                const small = concentration.bands.find((b) => b.band === 'low')!;
                const medium = concentration.bands.find((b) => b.band === 'medium')!;
                const large = concentration.bands.find((b) => b.band === 'high')!;
                const pct = (n: number) => totalBanded > 0 ? Math.round((n / totalBanded) * 100) : 0;
                const verdict = small.simulatedCount === 0
                  ? { text: 'No data yet', tone: '' }
                  : (small.medianSimulatedReturnPercent ?? 0) > 0
                    ? { text: `Still good${small.reliable ? '' : ' (small sample)'}`, tone: 'copytrade-positive' }
                    : { text: `Loses money${small.reliable ? '' : ' (small sample)'}`, tone: 'copytrade-negative' };
                return <div className="trade-size-block">
                  <p className="compact-info-line"><span>Trade sizes</span><InfoTip label="Trade sizes" text="Their own round trips split into small/medium/large by entry trade size, using the same size ranges as every other winner, so results are comparable across wallets." /></p>
                  <div className="trade-size-bar" title={`Small ${pct(small.tradeCount)}% · Medium ${pct(medium.tradeCount)}% · Large ${pct(large.tradeCount)}%`}>
                    <i className="trade-size-small" style={{ width: `${pct(small.tradeCount)}%` }} />
                    <i className="trade-size-medium" style={{ width: `${pct(medium.tradeCount)}%` }} />
                    <i className="trade-size-large" style={{ width: `${pct(large.tradeCount)}%` }} />
                  </div>
                  <div className="trade-size-legend"><span>Small {pct(small.tradeCount)}%</span><span>Medium {pct(medium.tradeCount)}%</span><span>Large {pct(large.tradeCount)}%</span></div>
                  <div className="trade-size-verdict"><span>Return on their small trades</span><b className={verdict.tone}>{verdict.text}</b></div>
                </div>;
              })()}
            </article>;
          })}
        </div>}
        {copySimulation && <p className="compact-info-line copy-sim-assumptions"><span>Simulation assumptions</span><InfoTip label="Simulation assumptions" text={`${copySimulation.assumptions.copierDelaySeconds}s copier delay; ${(copySimulation.assumptions.feeBps / 100).toFixed(2)}% GMGN fee; ${(copySimulation.assumptions.slippageBps / 100).toFixed(2)}% assumed slippage; ${copySimulation.assumptions.gasPriorityFeeSolPerTx} SOL priority gas per transaction; matches older than ${copySimulation.assumptions.maxMatchGapSeconds}s are rejected.`} /></p>}
        <button className="secondary" onClick={() => void runCopySimulationBatch()} disabled={copySimulationRunBusy}>{copySimulationRunBusy ? 'Querying Dune…' : 'Run simulation'}</button>
        <p className="compact-info-line copy-sim-limitations"><span>Historical estimate · limitations</span><InfoTip label="Copy simulation limitations" text={`In-sample estimate using each wallet's latest ${copySimulation?.assumptions.maxRoundTripsPerWallet ?? 150} round trips. It does not model position sizing, partial fills, overlapping positions, liquidity-dependent slippage, or guaranteed execution; nearby Dune trades are price proxies.`} /></p>
      </div>

      <div className="liquidity-impact">
        <p className="eyebrow copytrade-step-label">LIQUIDITY IMPACT (EXPLORATORY)</p>
        <p className="compact-info-line"><span>Trade-size liquidity proxy</span><InfoTip label="Liquidity impact method" text="Compares delayed-copy results across three groups split by the USD size of the matched Dune entry trade. This is a proxy for local trading activity, not directly measured pool liquidity, and is not a winner gate." /></p>
        {liquidityImpactLoading && <p className="muted">Loading…</p>}
        {liquidityImpact && liquidityImpact.bands.length === 0 && <p className="muted">Not enough bandable trades yet (need at least 3 round trips with a matched entry) to split into groups.</p>}
        {liquidityImpact && liquidityImpact.bands.length > 0 && <div className="liquidity-band-table-wrap">
          <table className="liquidity-band-table">
            <thead>
              <tr><th>Band</th><th>Entry size range</th><th>Trades</th><th>Win rate</th><th>Median copier return</th><th>Median delay cost</th><th>Missed rate</th></tr>
            </thead>
            <tbody>
              {liquidityImpact.bands.map((band) => (
                <tr key={band.band} className={band.reliable ? '' : 'liquidity-band-unreliable'}>
                  <td className="liquidity-band-name">{band.band}{!band.reliable && <small title={`Fewer than ${liquidityImpact.minReliableSample} simulated trades in this band — shown, not a verdict.`}> (low sample)</small>}</td>
                  <td>${band.minEntryTradeAmountUsd.toLocaleString()} – ${band.maxEntryTradeAmountUsd.toLocaleString()}</td>
                  <td>{band.simulatedCount} / {band.tradeCount}</td>
                  <td>{band.winRatePercent === null ? '—' : `${band.winRatePercent}%`}</td>
                  <td className={band.medianSimulatedReturnPercent !== null && band.medianSimulatedReturnPercent >= 0 ? 'copytrade-positive' : 'copytrade-negative'}>{formatPct(band.medianSimulatedReturnPercent)}</td>
                  <td className={band.medianDelayCostPercentagePoints !== null && band.medianDelayCostPercentagePoints >= 0 ? 'copytrade-positive' : 'copytrade-negative'}>{band.medianDelayCostPercentagePoints === null ? '—' : `${band.medianDelayCostPercentagePoints >= 0 ? '+' : ''}${band.medianDelayCostPercentagePoints.toFixed(2)}pp`}</td>
                  <td>{band.missedTradeRatePercent === null ? '—' : `${band.missedTradeRatePercent}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>}
        {liquidityImpact && <p className="compact-info-line copy-sim-assumptions"><span>Liquidity data quality</span><InfoTip label="Liquidity proxy data quality" text={`Source: matched Dune entry-trade USD size. ${liquidityImpact.unbandableCount} round trip${liquidityImpact.unbandableCount === 1 ? '' : 's'} without a matched entry are excluded, never treated as zero liquidity. Each band needs at least ${liquidityImpact.minReliableSample} simulated trades before its numbers are reliable.`} /></p>}
      </div>


      {copyWinners && copyWinners.candidates.length > 0 && <div className="winners-why-panel">
        <p className="eyebrow copytrade-step-label">WHY THESE TRADERS WON</p>
        <p className="compact-info-line"><span>Gate comparison</span><InfoTip label="Winner gate comparison" text="Each meter shows a winner's measured value against the threshold it had to clear. This explains selection; it is not an additional score." /></p>
        <div className="winner-gate-grid">
          {copyWinners.candidates.map((candidate) => {
            const holdThreshold = copyWinners.thresholds.minMedianHoldSeconds;
            const holdCap = Math.max(holdThreshold * 4, (candidate.medianHoldSeconds ?? 0) * 1.15);
            const holdFillPct = candidate.medianHoldSeconds !== null ? Math.min(100, (candidate.medianHoldSeconds / holdCap) * 100) : 0;
            const holdMarkerPct = Math.min(100, (holdThreshold / holdCap) * 100);
            const fastFillPct = candidate.fastRoundTripPercent !== null ? Math.min(100, Math.max(0, candidate.fastRoundTripPercent)) : 0;
            const fastMarkerPct = Math.min(100, copyWinners.thresholds.maxFastRoundTripPercent);
            const concFillPct = candidate.concentrationPercent !== null ? Math.min(100, Math.max(0, candidate.concentrationPercent)) : 0;
            const concMarkerPct = Math.min(100, copyWinners.thresholds.maxConcentrationPercent);
            return (
              <div className="winner-gate-card" key={candidate.walletAddress}>
                <div className="winner-gate-header">
                  <strong>{candidate.name?.trim() || shortAddress(candidate.walletAddress)}</strong>
                  <span className={`hc-verdict hc-${candidate.historicalConsistencyVerdict ?? 'insufficient'}`}>{(candidate.historicalConsistencyVerdict ?? '').replace('_', ' ')}</span>
                </div>
                <small className="address-compact" title={candidate.walletAddress}>{candidate.walletAddress}</small>

                <div className="winner-gate-row">
                  <span className="winner-gate-label">Median hold</span>
                  <div className="winner-gate-bar" title={`${candidate.medianHoldSeconds !== null ? formatDuration(candidate.medianHoldSeconds) : '—'} held, vs a ${formatDuration(holdThreshold)} minimum`}>
                    <i className="winner-gate-fill" style={{ width: `${holdFillPct}%` }} />
                    <i className="winner-gate-marker" style={{ left: `${holdMarkerPct}%` }} />
                  </div>
                  <span className="winner-gate-value">{candidate.medianHoldSeconds !== null ? formatDuration(candidate.medianHoldSeconds) : '—'}</span>
                </div>

                <div className="winner-gate-row">
                  <span className="winner-gate-label">Fast round-trip</span>
                  <div className="winner-gate-bar" title={`${formatPct(candidate.fastRoundTripPercent)}, vs a ${copyWinners.thresholds.maxFastRoundTripPercent}% maximum allowed`}>
                    <i className="winner-gate-fill" style={{ width: `${fastFillPct}%` }} />
                    <i className="winner-gate-marker" style={{ left: `${fastMarkerPct}%` }} />
                  </div>
                  <span className="winner-gate-value">{formatPct(candidate.fastRoundTripPercent)}</span>
                </div>

                <div className="winner-gate-row">
                  <span className="winner-gate-label">Concentration</span>
                  <div className="winner-gate-bar" title={`${formatPct(candidate.concentrationPercent)} of profit from ${candidate.bestTokenSymbol ?? 'its best token'}, vs a ${copyWinners.thresholds.maxConcentrationPercent}% maximum allowed`}>
                    <i className="winner-gate-fill" style={{ width: `${concFillPct}%` }} />
                    <i className="winner-gate-marker" style={{ left: `${concMarkerPct}%` }} />
                  </div>
                  <span className="winner-gate-value">{formatPct(candidate.concentrationPercent)}</span>
                </div>

                {(() => {
                  const simValue = candidate.simulatedMedianReturnPercent ?? 0;
                  const simCap = Math.max(20, simValue * 1.15);
                  const simFillPct = Math.min(100, Math.max(0, (simValue / simCap) * 100));
                  return (
                    <div className="winner-gate-row">
                      <span className="winner-gate-label">Copy-simulated return</span>
                      <div className="winner-gate-bar" title={`${formatPct(candidate.simulatedMedianReturnPercent)} simulated median after delay, fees, slippage and gas — vs > 0% required to survive copying · ${candidate.copySimulationCoverageRatePercent ?? '—'}% of round trips had usable Dune price data`}>
                        <i className="winner-gate-fill" style={{ width: `${simFillPct}%` }} />
                        <i className="winner-gate-marker" style={{ left: '0%' }} />
                      </div>
                      <span className="winner-gate-value">{formatPct(candidate.simulatedMedianReturnPercent)}</span>
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
        <p className="muted winner-gate-legend"><span className="winner-gate-legend-swatch" aria-hidden="true" /> measured value <span className="winner-gate-legend-marker" aria-hidden="true" /> gate threshold</p>
        <p className="muted">
          {copyWinners.excludedCount} other screen-pass trader{copyWinners.excludedCount === 1 ? '' : 's'} failed at least one of these gates and are folded into the tables below, not shown as winners.
          {copyWinners.pendingCopySimulationCount > 0 && <> {copyWinners.pendingCopySimulationCount} still need{copyWinners.pendingCopySimulationCount === 1 ? 's' : ''} copy-survival verification.</>}
          {copyWinners.failedCopySurvivalCount > 0 && <> {copyWinners.failedCopySurvivalCount} passed every other gate but did not survive the copy simulation.</>}
        </p>
      </div>}
      </div>}

      {copyTradeSubTab === 'historical-consistency' && <div className="historical-consistency-panel">
        <p className="eyebrow copytrade-step-label">HISTORICAL CONSISTENCY</p>
        <p className="compact-info-line"><span>Earlier vs recent performance</span><InfoTip label="Historical consistency method" text="Compares today's traders with their earlier and recent history. This is backward-looking only; it does not test future performance." /></p>
        {historicalConsistencyLoading && <p className="muted">Loading…</p>}
        {historicalConsistency && <>
          <p className="compact-info-line"><span>History split</span><InfoTip label="History split rules" text={historicalConsistency.rules.description} /></p>
          <div className="quality-grid copytrade-summary-grid">
            <div className="quality-metric"><strong>{formatCount(historicalConsistency.totalWallets)}</strong><span>traders analyzed</span></div>
            <div className="quality-metric hc-consistent"><strong>{formatCount(historicalConsistency.counts.consistent)}</strong><span>consistent</span></div>
            <div className="quality-metric hc-declining"><strong>{formatCount(historicalConsistency.counts.declining)}</strong><span>declining</span></div>
            <div className="quality-metric hc-recent-only"><strong>{formatCount(historicalConsistency.counts.recent_only)}</strong><span>recent-only</span></div>
            <div className="quality-metric hc-consistently-negative"><strong>{formatCount(historicalConsistency.counts.consistently_negative)}</strong><span>consistently negative</span></div>
            <div className="quality-metric hc-insufficient"><strong>{formatCount(historicalConsistency.counts.insufficient)}</strong><span>insufficient</span></div>
          </div>
          <div className="table-wrap copytrade-table-wrap"><table className="copytrade-table"><thead><tr>
            <th>Trader</th><th>Depth &amp; split</th><th>Early period</th><th>Recent period</th><th>Verdict</th>
          </tr></thead><tbody>
            {historicalConsistency.rows.length === 0
              ? <tr><td colSpan={5} className="muted">No trader results yet. Fetch trade data first.</td></tr>
              : historicalConsistency.rows.map((row) => {
                const traderName = row.name?.trim() || shortAddress(row.walletAddress);
                const depthLabel = row.split === 'insufficient_depth' ? `${row.availableDays?.toFixed(0) ?? 0}d available (under 30d floor)`
                  : row.split === 'relative_half' ? `${row.availableDays?.toFixed(0)}d available (half-split)`
                  : 'Full 90d (fixed 60/30 split)';
                return <tr key={row.walletAddress}>
                  <td><strong>{traderName}</strong>{row.riskFlags.length > 0 && <span className="copytrade-risk-flags">{row.riskFlags.map((flag) => <span className="copytrade-risk-chip" key={flag}>{flag}</span>)}</span>}<small className="address-compact" title={row.walletAddress}>{shortAddress(row.walletAddress)}</small></td>
                  <td>{depthLabel}</td>
                  <td>{row.early.trades === 0 ? '—' : <>{formatPct(row.early.summary.medianReturnPercent)} median · {formatPct(row.early.summary.winRatePercent)} win<small> ({formatCount(row.early.trades)} trades)</small></>}</td>
                  <td>{row.recent.trades === 0 ? '—' : <>{formatPct(row.recent.summary.medianReturnPercent)} median · {formatPct(row.recent.summary.winRatePercent)} win<small> ({formatCount(row.recent.trades)} trades)</small></>}</td>
                  <td><span className={`hc-verdict hc-${row.verdict}`}>{row.verdict.replace('_', ' ')}</span></td>
                </tr>;
              })}
          </tbody></table></div>
        </>}
      </div>}

      {copyTradeSubTab === 'top-callers' && <div className="top-callers-panel">
        <p className="eyebrow copytrade-step-label">TOP CALLERS · DECISION VIEW</p>
        <div className="top-callers-heading"><div><h2>Which caller performed best?</h2><p className="muted">Run one guided workflow to collect GMGN history, measure matured Dune checkpoints, and rank the best caller.</p></div><button className="quiet top-caller-refresh" disabled={topCallerLoading || topCallerWorkflowBusy} onClick={() => void loadTopCallerData()}>{topCallerLoading ? 'Refreshing…' : 'Refresh saved results'}</button></div>
        <div className="top-caller-horizon"><span>All available Dune checkpoints</span><small>Reliable wallet + checkpoint combinations are shown first. Use the toggle to inspect measured but insufficient rows.</small></div>
        {topCallerLoading && <div className="top-caller-loading" role="status"><span className="loading-spinner" aria-hidden="true" /> <strong>Loading caller results…</strong><span>Reading saved GMGN and Dune data.</span></div>}
        {(() => {
          const hasLeaderboard = Boolean(topCallerLeaderboard?.snapshot && topCallerLeaderboard.rows.length > 0);
          const trackedRows = topCallerLeaderboard?.rows.filter((row) => row.tracked) ?? [];
          const trackedCount = trackedRows.length;
          const hasCallouts = topCallerEvaluation?.rows.some((row) => row.callCount > 0) ?? false;
          const leaderboardRunning = topCallerRunStatus.leaderboard?.running ?? false;
          const calloutsRunning = topCallerRunStatus.callouts?.running ?? false;
          const checkpointsRunning = topCallerRunStatus.checkpoints?.running ?? false;
          const gmgnCooldownUntil = [topCallerRunStatus.leaderboard?.rateLimitedUntil, topCallerRunStatus.callouts?.rateLimitedUntil]
            .filter((value): value is string => Boolean(value)).map((value) => Date.parse(value))
            .filter((value) => Number.isFinite(value) && value > topCallerClockMs).sort((a, b) => b - a)[0] ?? null;
          const gmgnCooldownSeconds = gmgnCooldownUntil === null ? null : Math.max(0, Math.ceil((gmgnCooldownUntil - topCallerClockMs) / 1000));
          const gmgnCoolingDown = gmgnCooldownSeconds !== null && gmgnCooldownSeconds > 0;
          const runningKind = (['leaderboard', 'callouts', 'checkpoints'] as TopCallerCollectionKind[]).find((kind) => topCallerRunStatus[kind]?.running);
          const pausedKind = (['leaderboard', 'callouts', 'checkpoints'] as TopCallerCollectionKind[]).find((kind) => topCallerRunStatus[kind]?.status === 'paused');
          const pausedStatus = pausedKind ? topCallerRunStatus[pausedKind] : null;
          const pausedNextRetryMs = pausedStatus?.nextRetryAt ? Date.parse(pausedStatus.nextRetryAt) : NaN;
          const pausedSecondsRemaining = Number.isFinite(pausedNextRetryMs) ? Math.max(0, Math.ceil((pausedNextRetryMs - topCallerClockMs) / 1000)) : null;
          const pausedRetryExhausted = (pausedStatus?.retryCount ?? 0) >= 1;
          const capturedCount = topCallerLeaderboard?.rows.length ?? null;
          const includedCount = topCallerLeaderboard ? trackedCount : null;
          const notIncludedCount = capturedCount === null ? null : Math.max(0, capturedCount - trackedCount);
          const duneMeasuredCount = topCallerEvaluation ? topCallerEvaluation.rows.filter((row) => row.measuredCallCount > 0).length : null;
          const workflowRunning = topCallerWorkflowBusy || runningKind !== undefined;
          const selectedEvaluation = topCallerEvaluation?.rows.find((row) => row.callerKey === topCallerSelectedKey) ?? null;
          const selectedCalls = selectedEvaluation?.callCount ?? topCallerDetail?.callouts.length ?? 0;
          const selectedMeasured = selectedEvaluation?.measuredCallCount ?? 0;
          const selectedMedian = selectedEvaluation?.medianReturnPercent ?? null;
          const selectedWinRate = selectedEvaluation?.winRatePercent ?? null;
          const selectedWaiting = selectedEvaluation?.waitingCallCount ?? 0;
          const selectedUnavailable = selectedEvaluation?.unavailableCallCount ?? 0;
          const selectedCoverageSufficient = selectedEvaluation?.coverageSufficient ?? false;
          const estimatedValue = selectedMedian === null ? null : 100 * (1 + selectedMedian / 100);
          const coverage = selectedCalls > 0 ? (selectedMeasured / selectedCalls) * 100 : null;
          const rankedEvaluations = [...(topCallerEvaluation?.rows ?? [])]
            .filter((row) => row.measuredCallCount > 0 && row.medianReturnPercent !== null)
            .sort((a, b) => {
              if (Boolean(a.reliable) !== Boolean(b.reliable)) return a.reliable ? -1 : 1;
              if ((b.medianReturnPercent ?? -Infinity) !== (a.medianReturnPercent ?? -Infinity)) return (b.medianReturnPercent ?? -Infinity) - (a.medianReturnPercent ?? -Infinity);
              if ((b.winRatePercent ?? -Infinity) !== (a.winRatePercent ?? -Infinity)) return (b.winRatePercent ?? -Infinity) - (a.winRatePercent ?? -Infinity);
              return b.measuredCallCount - a.measuredCallCount;
            });
          const allCheckpointRows = TOP_CALLER_CHECKPOINTS.flatMap((checkpoint) => (topCallerAllEvaluation?.[checkpoint]?.rows ?? []).map((row) => ({ ...row, checkpoint })));
          const visibleCheckpointRows = allCheckpointRows
            .filter((row) => row.measuredCallCount > 0 && row.medianReturnPercent !== null && (showUnreliableTopCallers || row.reliable))
            .sort((a, b) => {
              if (topCallerTableSort.key === 'default') {
                if (Boolean(a.reliable) !== Boolean(b.reliable)) return a.reliable ? -1 : 1;
                if ((b.medianReturnPercent ?? -Infinity) !== (a.medianReturnPercent ?? -Infinity)) return (b.medianReturnPercent ?? -Infinity) - (a.medianReturnPercent ?? -Infinity);
                if (b.measuredCallCount !== a.measuredCallCount) return b.measuredCallCount - a.measuredCallCount;
                return TOP_CALLER_CHECKPOINTS.indexOf(a.checkpoint) - TOP_CALLER_CHECKPOINTS.indexOf(b.checkpoint);
              }
              const key = topCallerTableSort.key;
              const left: string | number | boolean | null = key === 'callerKey' ? a.callerKey : key === 'checkpoint' ? a.checkpoint : key === 'reliable' ? a.reliable : a[key];
              const right: string | number | boolean | null = key === 'callerKey' ? b.callerKey : key === 'checkpoint' ? b.checkpoint : key === 'reliable' ? b.reliable : b[key];
              let comparison = left === null && right === null ? 0 : left === null ? 1 : right === null ? -1 : typeof left === 'number' && typeof right === 'number' ? left - right : typeof left === 'boolean' && typeof right === 'boolean' ? Number(left) - Number(right) : String(left).localeCompare(String(right));
              if (comparison === 0) comparison = a.callerKey.localeCompare(b.callerKey) || TOP_CALLER_CHECKPOINTS.indexOf(a.checkpoint) - TOP_CALLER_CHECKPOINTS.indexOf(b.checkpoint);
              return (topCallerTableSort.direction === 'asc' ? 1 : -1) * comparison;
            });
          const checkpointPageSize = 100;
          const checkpointPageCount = Math.max(1, Math.ceil(visibleCheckpointRows.length / checkpointPageSize));
          const checkpointPage = Math.min(topCallerAllPage, checkpointPageCount - 1);
          const checkpointPageRows = visibleCheckpointRows.slice(checkpointPage * checkpointPageSize, (checkpointPage + 1) * checkpointPageSize);
          const bestEvaluation = rankedEvaluations[0] ?? null;
          const bestEstimatedValue = bestEvaluation?.medianReturnPercent === null || bestEvaluation?.medianReturnPercent === undefined ? null : 100 * (1 + bestEvaluation.medianReturnPercent / 100);
          const bestName = bestEvaluation ? shortAddress(bestEvaluation.callerKey) : 'No measured caller yet';
          const outcomesByCheckpoint = new Map<string, number[]>();
          for (const callout of topCallerDetail?.callouts ?? []) for (const outcome of callout.outcomes) {
            if (outcome.status !== 'measured' || outcome.measuredReturnPct === null) continue;
            const values = outcomesByCheckpoint.get(outcome.checkpoint) ?? []; values.push(outcome.measuredReturnPct); outcomesByCheckpoint.set(outcome.checkpoint, values);
          }
          const medianOf = (values: number[]): number | null => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2; };
          const checkpointRows = Array.from(outcomesByCheckpoint.entries()).sort((a, b) => ['5m', '10m', '15m', '30m', '45m', '1h', '6h', '24h', '3d', '7d'].indexOf(a[0]) - ['5m', '10m', '15m', '30m', '45m', '1h', '6h', '24h', '3d', '7d'].indexOf(b[0])).map(([checkpoint, values]) => ({ checkpoint, values, median: medianOf(values), winRate: values.length ? values.filter((value) => value > 0).length / values.length * 100 : null }));
          const representative = (topCallerDetail?.callouts ?? []).map((callout) => ({ callout, outcome: callout.outcomes.find((item) => item.checkpoint === (topCallerEvaluation?.checkpoint ?? '24h') && item.status === 'measured' && item.measuredReturnPct !== null) })).filter((item): item is { callout: TopCallerCallout; outcome: TopCallerOutcome & { measuredReturnPct: number } } => item.outcome !== undefined).sort((a, b) => b.outcome.measuredReturnPct - a.outcome.measuredReturnPct).slice(0, 3);
          const selectedName = topCallerSelectedKey ? shortAddress(topCallerSelectedKey) : 'No caller selected';
          const verdict = !selectedEvaluation || !selectedCoverageSufficient ? 'Insufficient coverage' : selectedEvaluation.reliable && selectedMedian !== null && selectedMedian > 0 ? 'Promising caller' : selectedEvaluation.reliable ? 'Measured, but not profitable' : 'More data needed';
          const verdictClass = verdict === 'Promising caller' ? 'positive' : verdict === 'Measured, but not profitable' ? 'negative' : 'pending';
          return <>
            {workflowRunning && <div className="top-caller-status-bar running" role="status"><span className="loading-spinner" aria-hidden="true" /><div><strong>{topCallerWorkflowStage ?? (runningKind === 'leaderboard' ? 'Capturing the GMGN leaderboard…' : runningKind === 'callouts' ? 'Fetching caller history…' : 'Measuring Dune checkpoints…')}</strong><span>{runningKind === 'callouts' && topCallerRunStatus.callouts?.walletTotal
              ? <>Fetched {topCallerRunStatus.callouts.walletDone ?? 0} of {topCallerRunStatus.callouts.walletTotal} tracked callers. Each caller's history is saved as soon as it's fetched. Results will update automatically.</>
              : runningKind === 'checkpoints' && topCallerRunStatus.checkpoints?.walletTotal
                ? <>Processed {topCallerRunStatus.checkpoints.walletDone ?? 0} of {topCallerRunStatus.checkpoints.walletTotal} matured checkpoints ({topCallerRunStatus.checkpoints.requestsMade ?? 0} Dune batch{(topCallerRunStatus.checkpoints.requestsMade ?? 0) === 1 ? '' : 'es'} so far). This keeps going until the backlog is empty — results update automatically as each batch lands.</>
                : runningKind === 'checkpoints'
                  ? <>Counting matured checkpoints…</>
                  : <>Waiting for GMGN to respond. Results will update automatically.</>}</span>{runningKind === 'callouts' && topCallerRunStatus.callouts?.walletTotal ? <div className="top-caller-operation-progress-track"><i style={{ width: `${Math.round(((topCallerRunStatus.callouts.walletDone ?? 0) / topCallerRunStatus.callouts.walletTotal) * 100)}%` }} /></div> : runningKind === 'checkpoints' && topCallerRunStatus.checkpoints?.walletTotal ? <div className="top-caller-operation-progress-track"><i style={{ width: `${Math.round(((topCallerRunStatus.checkpoints.walletDone ?? 0) / topCallerRunStatus.checkpoints.walletTotal) * 100)}%` }} /></div> : null}</div></div>}
            {!workflowRunning && pausedKind && pausedStatus && <div className="top-caller-status-bar paused" role="status"><div><strong>Paused by GMGN — {pausedStatus.walletDone ?? 0} / {pausedStatus.walletTotal ?? '?'} wallets complete.</strong><span>{pausedRetryExhausted
              ? 'Automatic retry used. Paused until you resume it.'
              : pausedSecondsRemaining !== null ? <>Will retry automatically in <b>{formatDuration(pausedSecondsRemaining)}</b>.</> : 'One automatic retry is scheduled.'}</span></div>{pausedRetryExhausted && <button className="secondary" disabled={topCallerResumeBusy} onClick={() => void resumeTopCallerCollection(pausedKind)}>{topCallerResumeBusy ? 'Resuming…' : 'Resume collection'}</button>}</div>}
            {!workflowRunning && !pausedKind && gmgnCoolingDown && <div className="top-caller-status-bar warning" role="status"><strong>GMGN is cooling down.</strong><span>Requests are paused for <b>{formatDuration(gmgnCooldownSeconds)}</b>. Do not retry until the cooldown ends. Dune measurement remains available.</span></div>}
            {!workflowRunning && !pausedKind && topCallerError && <div className="top-caller-status-bar warning" role="status"><strong>Workflow stopped.</strong><span>{topCallerWorkflowStage ?? topCallerError} Data already collected is retained.</span></div>}
            {!workflowRunning && !pausedKind && !gmgnCoolingDown && !topCallerError && <div className="top-caller-status-bar" role="status"><strong>{hasLeaderboard ? 'COMPLETE' : 'READY'}</strong><span>{hasLeaderboard ? `${capturedCount ?? '—'} callers captured · ${duneMeasuredCount ?? '—'} with measured Dune outcomes` : 'No GMGN caller snapshot yet. Run the workflow to begin.'}</span></div>}
            <div className="top-caller-orchestrator"><div className="top-caller-orchestrator-actions"><button className="primary" disabled={topCallerWorkflowBusy} onClick={() => void runTopCallerWorkflow()}>{topCallerWorkflowBusy ? 'Research workflow running…' : 'Run complete caller research'}</button>{(workflowRunning || topCallerWorkflowBusy) && <button className="secondary top-caller-stop" disabled={topCallerStopBusy} onClick={() => void stopTopCallerWork()}>{topCallerStopBusy ? 'Stopping…' : 'Stop all Top Caller work'}</button>}</div><p>{topCallerWorkflowStage ?? 'Captures GMGN → tracks top 25 → fetches history → measures with Dune → shows the best performer.'}</p></div>
            <div className="top-caller-scope"><span>Captured <b>{capturedCount ?? '—'}</b></span><span>Included <b>{includedCount ?? '—'}</b></span><span>Not included <b>{notIncludedCount ?? '—'}</b></span><span>Dune measured <b>{duneMeasuredCount ?? '—'}</b></span></div>
            <section className="top-caller-top10"><div className="top-callers-section-heading"><div><p className="eyebrow">ALL CHECKPOINT RESULTS</p><h3>Best measured wallet × checkpoint</h3></div><label className="top-caller-table-toggle"><input type="checkbox" checked={showUnreliableTopCallers} onChange={(event) => { setShowUnreliableTopCallers(event.target.checked); setTopCallerAllPage(0); }} /> Show insufficient rows</label></div><p className="muted top-caller-table-explainer">Each row is one wallet at one time horizon. Reliable rows are shown by default; the toggle reveals measured rows that do not yet meet the sample or coverage requirements. Click a column heading to sort.</p>{visibleCheckpointRows.length === 0 ? <p className="muted">No reliable checkpoint results yet. Measure matured Dune checkpoints, or enable “Show insufficient rows.”</p> : <><div className="table-wrap copytrade-table-wrap"><table className="copytrade-table top-caller-top10-table"><thead><tr><th>#</th><th onClick={() => toggleTopCallerTableSort('callerKey')} className="sortable-header" title="Sort by wallet">Wallet{topCallerTableSortIndicator('callerKey')}</th><th onClick={() => toggleTopCallerTableSort('checkpoint')} className="sortable-header" title="Sort by checkpoint">Checkpoint{topCallerTableSortIndicator('checkpoint')}</th><th onClick={() => toggleTopCallerTableSort('medianReturnPercent')} className="sortable-header" title="Sort by median return">Median{topCallerTableSortIndicator('medianReturnPercent')}</th><th onClick={() => toggleTopCallerTableSort('winRatePercent')} className="sortable-header" title="Sort by win rate">Win{topCallerTableSortIndicator('winRatePercent')}</th><th onClick={() => toggleTopCallerTableSort('measuredCallCount')} className="sortable-header" title="Sort by measured calls">Measured{topCallerTableSortIndicator('measuredCallCount')}</th><th onClick={() => toggleTopCallerTableSort('coverageRatePercent')} className="sortable-header" title="Sort by coverage">Coverage{topCallerTableSortIndicator('coverageRatePercent')}</th><th>$100</th><th onClick={() => toggleTopCallerTableSort('reliable')} className="sortable-header" title="Sort by status">Status{topCallerTableSortIndicator('reliable')}</th></tr></thead><tbody>{checkpointPageRows.map((row, index) => { const rowCoverage = row.callCount > 0 ? row.measuredCallCount / row.callCount * 100 : null; const rowValue = row.medianReturnPercent === null ? null : 100 * (1 + row.medianReturnPercent / 100); const absoluteIndex = checkpointPage * checkpointPageSize + index; return <tr key={`${row.callerKey}-${row.checkpoint}`} className={absoluteIndex === 0 ? 'top-caller-top10-best' : undefined} onClick={() => { setTopCallerSelectedKey(row.callerKey); setTopCallerEvaluationCheckpoint(row.checkpoint); }}><td><strong>{absoluteIndex + 1}</strong></td><td><strong>{shortAddress(row.callerKey)}</strong></td><td><strong>+{row.checkpoint}</strong></td><td className={row.medianReturnPercent !== null && row.medianReturnPercent >= 0 ? 'positive' : 'negative'}>{formatPct(row.medianReturnPercent)}</td><td>{formatPct(row.winRatePercent)}</td><td>{row.measuredCallCount} / {row.callCount}</td><td>{rowCoverage === null ? '—' : `${rowCoverage.toFixed(0)}%`}</td><td>{formatUsd(rowValue)}</td><td><span className={`top-caller-table-status ${row.reliable ? 'reliable' : 'pending'}`}>{row.reliable ? 'Reliable' : 'Insufficient data'}</span></td></tr>; })}</tbody></table></div><div className="top-caller-table-pagination"><span>Showing {checkpointPageRows.length} of {visibleCheckpointRows.length} rows · {checkpointPageSize} per page</span><button className="secondary" disabled={checkpointPage === 0} onClick={() => setTopCallerAllPage((page) => Math.max(0, page - 1))}>Previous</button><span>Page {checkpointPage + 1} of {checkpointPageCount}</span><button className="secondary" disabled={checkpointPage >= checkpointPageCount - 1} onClick={() => setTopCallerAllPage((page) => Math.min(checkpointPageCount - 1, page + 1))}>Next</button></div></>}</section>
            <div className="top-caller-overview-toolbar"><label htmlFor="top-caller-selected">Inspect a caller</label><select id="top-caller-selected" value={topCallerSelectedKey ?? ''} onChange={(event) => setTopCallerSelectedKey(event.target.value || null)}><option value="">Choose a tracked caller</option>{trackedRows.map((row) => <option key={row.callerKey} value={row.callerKey}>{shortAddress(row.callerKey)} · {row.callCount ?? 0} calls</option>)}</select><span className="muted">Viewing only — does not change the research run.</span></div>
            <section className="top-caller-verdict"><div><span className="top-caller-verdict-label">{selectedEvaluation?.reliable ? 'RELIABLE SAMPLE' : 'DATA STATUS'}</span><h3>{selectedName}: <span className={`top-caller-verdict-text ${verdictClass}`}>{verdict}</span></h3><p className="muted">{selectedMeasured > 0 ? `Based on ${selectedMeasured} measured calls at the ${topCallerEvaluation?.checkpoint ?? '24h'} checkpoint.` : 'Fetch caller history first, then measure matured calls with Dune.'}</p></div><div className="top-caller-value-result"><strong>{estimatedValue === null ? '—' : formatUsd(estimatedValue)}</strong><span>estimated value from a $100 equal-size copy</span></div></section>
            <div className="top-caller-overview-metrics"><div><strong>{selectedWinRate === null ? '—' : formatPct(selectedWinRate)}</strong><span>winning calls</span></div><div><strong className={selectedMedian !== null && selectedMedian >= 0 ? 'positive' : selectedMedian !== null ? 'negative' : ''}>{formatPct(selectedMedian)}</strong><span>median return per call</span></div><div><strong>{selectedMeasured ? `${selectedMeasured} / ${selectedCalls}` : '—'}</strong><span>measured by Dune</span></div><div><strong>{coverage === null ? '—' : `${coverage.toFixed(1)}%`}</strong><span>usable coverage</span></div></div>
            <div className="top-caller-coverage-note"><strong>Measurement coverage</strong><span>{selectedMeasured} measured · {selectedWaiting} waiting for a mature checkpoint · {selectedUnavailable} unavailable because Dune found no qualifying trade.</span>{!selectedCoverageSufficient && <small>A verdict is blocked until at least 30 calls are measured and coverage reaches 70%.</small>}</div>
            <div className="top-caller-overview-grid"><section className="top-caller-overview-panel"><div className="top-callers-section-heading"><div><p className="eyebrow">OUTCOME OVER TIME</p><h3>How the result changes by checkpoint</h3></div><span className="source-badge source-dune">DUNE</span></div>{checkpointRows.length === 0 ? <p className="muted">No measured checkpoints yet.</p> : <div className="top-caller-timeline">{checkpointRows.map((row) => <div className="top-caller-timeline-row" key={row.checkpoint}><label>+{row.checkpoint}</label><div className="top-caller-timeline-bar"><i className={row.median !== null && row.median >= 0 ? 'positive' : 'negative'} style={{ width: `${Math.min(100, Math.max(4, Math.abs(row.median ?? 0)))}%` }} /></div><b className={row.median !== null && row.median >= 0 ? 'positive' : 'negative'}>{formatPct(row.median)} <small>· {formatPct(row.winRate)} win</small></b></div>)}</div>}<p className="top-caller-footnote">Missing checkpoints are excluded, never treated as zero.</p></section><section className="top-caller-overview-panel"><div className="top-callers-section-heading"><div><p className="eyebrow">EVIDENCE SAMPLE</p><h3>Representative calls</h3></div><span className="muted">{representative.length} shown</span></div>{representative.length === 0 ? <p className="muted">No measured calls to show yet.</p> : <div className="top-caller-evidence-list">{representative.map(({ callout, outcome }) => <div className="top-caller-evidence-row" key={callout.id}><span><strong>{callout.tokenSymbol?.trim() || shortAddress(callout.tokenAddress)}</strong><small>{formatTime(callout.callTimestamp)} · GMGN call</small></span><b className={outcome.measuredReturnPct >= 0 ? 'positive' : 'negative'}>{formatPct(outcome.measuredReturnPct)}</b></div>)}</div>}<p className="top-caller-footnote">Open raw evidence for the complete call list.</p></section></div>
            <details className="top-caller-evidence-details"><summary>Advanced evidence and manual controls</summary><div className="top-callers-actions"><div className="top-caller-action"><button className="primary" disabled={leaderboardRunning || gmgnCoolingDown || topCallerWorkflowBusy} onClick={() => void collectTopCaller('leaderboard')}>{leaderboardRunning ? 'Capturing…' : 'Capture GMGN snapshot'} <span className="source-badge source-gmgn">GMGN</span></button><small>Manual override for source collection.</small></div><div className="top-caller-action"><button className="secondary" disabled={!hasLeaderboard || trackedCount === 0 || calloutsRunning || gmgnCoolingDown || topCallerWorkflowBusy} onClick={() => void collectTopCaller('callouts')}>{calloutsRunning ? 'Fetching history…' : 'Fetch caller history'} <span className="source-badge source-gmgn">GMGN</span></button><small>Manual override for tracked caller history.</small></div><div className="top-caller-action"><button className="secondary" disabled={!hasCallouts || checkpointsRunning || topCallerWorkflowBusy} onClick={() => void collectTopCaller('checkpoints')}>{checkpointsRunning ? 'Measuring…' : `Measure Dune checkpoints (${trackedCount})`} <span className="source-badge source-dune">DUNE</span></button><small>Measures all matured pending checkpoints for included callers.</small></div></div><div className="top-callers-run-status">{(['leaderboard', 'callouts', 'checkpoints'] as TopCallerCollectionKind[]).map((kind) => { const status = topCallerRunStatus[kind]; const label = kind === 'leaderboard' ? 'Leaderboard' : kind === 'callouts' ? 'History' : 'Dune'; const runningLabel = status?.running
                ? (kind === 'callouts' && status.walletTotal ? `running · ${status.walletDone ?? 0} of ${status.walletTotal} callers`
                  : kind === 'checkpoints' && status.walletTotal ? `running · ${status.walletDone ?? 0} of ${status.walletTotal} checkpoints`
                  : 'running')
                : status?.status === 'paused'
                  ? `paused · ${status.walletDone ?? 0} of ${status.walletTotal ?? '?'} wallets${(status.retryCount ?? 0) >= 1 ? ' · needs Resume' : ' · retrying automatically'}`
                  : (status?.status ?? 'idle');
              const retrySuffix = status && status.retryCount > 0 ? ` · ${status.retryCount} retry used` : '';
              return <span key={kind} className={status?.running ? 'top-callers-running' : status?.status === 'paused' ? 'top-callers-paused' : ''}><b>{label}</b> · {runningLabel}{retrySuffix}{status?.message ? ` · ${status.message}` : ''}</span>; })}</div><div className="table-wrap copytrade-table-wrap"><table className="copytrade-table top-callers-table"><thead><tr><th>Rank</th><th>Caller</th><th>Calls</th><th>Track</th></tr></thead><tbody>{!topCallerLeaderboard || topCallerLeaderboard.rows.length === 0 ? <tr><td colSpan={4} className="muted">No leaderboard snapshot captured yet.</td></tr> : topCallerLeaderboard.rows.map((row) => <tr key={row.callerKey} className={topCallerSelectedKey === row.callerKey ? 'top-callers-selected' : ''} onClick={() => setTopCallerSelectedKey(row.callerKey)}><td>#{row.rankPosition}</td><td><strong>{shortAddress(row.callerKey)}</strong><small className="address-compact">{row.callerKey}</small></td><td>{row.callCount ?? '—'}</td><td><button className={row.tracked ? 'secondary top-caller-track active' : 'secondary top-caller-track'} onClick={(event) => { event.stopPropagation(); void toggleTopCallerTracking(row); }}>{row.tracked ? 'Tracking' : 'Track'}</button></td></tr>)}</tbody></table></div><div className="table-wrap copytrade-table-wrap"><table className="copytrade-table top-caller-detail-table"><thead><tr><th>Token</th><th>Called</th><th>GMGN price</th><th>Dune +1h</th><th>Dune +24h</th></tr></thead><tbody>{!topCallerDetail || topCallerDetail.callouts.length === 0 ? <tr><td colSpan={5} className="muted">Select a tracked caller with captured callouts.</td></tr> : topCallerDetail.callouts.map((callout) => <tr key={callout.id}><td><strong>{callout.tokenSymbol?.trim() || shortAddress(callout.tokenAddress)}</strong><button className="icon-copy" title="Copy token address" onClick={() => void copyAddress(callout.tokenAddress)}>⧉</button></td><td>{formatTime(callout.callTimestamp)}</td><td>{callout.callPriceUsd ?? '—'}</td><td>{formatPct(callout.outcomes.find((item) => item.checkpoint === '1h')?.measuredReturnPct ?? null)}</td><td>{formatPct(callout.outcomes.find((item) => item.checkpoint === '24h')?.measuredReturnPct ?? null)}</td></tr>)}</tbody></table></div><div className="table-wrap copytrade-table-wrap"><table className="copytrade-table top-caller-checkpoint-breakdown-table"><thead><tr><th>Checkpoint</th><th>Measured</th><th>Waiting</th><th>No trade</th><th>Dates</th><th>Coverage</th><th>Result</th></tr></thead><tbody>{!topCallerCheckpointBreakdown || topCallerCheckpointBreakdown.rows.length === 0 ? <tr><td colSpan={7} className="muted">Select a tracked caller with captured callouts.</td></tr> : topCallerCheckpointBreakdown.rows.map((row) => {
                const reasonLabels: Record<TopCallerReliabilityReason, string> = { awaiting_dune_fetch: 'Awaiting Dune fetch', insufficient_coverage: 'No qualifying trade', awaiting_more_capture_dates: 'Awaiting more capture dates', no_callouts: 'No callouts yet' };
                const resultText = row.reliable ? 'Reliable measurement' : (row.reasons[0] ? reasonLabels[row.reasons[0]] : 'Insufficient data');
                const resultClass = row.reliable ? 'reliable' : row.reasons.includes('insufficient_coverage') ? 'unavailable' : 'pending';
                return <tr key={row.checkpoint}><td>+{row.checkpoint}</td><td>{row.measuredCallCount} / {row.callCount}</td><td>{row.waitingCallCount}</td><td>{row.unavailableCallCount}</td><td>{row.callCount === 0 ? '—' : row.reasons.includes('awaiting_more_capture_dates') ? <span className="top-caller-table-status pending">too few</span> : 'ok'}</td><td>{row.coverageRatePercent === null ? '—' : `${row.coverageRatePercent}%`}</td><td><span className={`top-caller-table-status ${resultClass}`} title={row.reasons.map((r) => reasonLabels[r]).join(', ')}>{resultText}</span></td></tr>;
              })}</tbody></table></div></details>
          </>;
        })()}
      </div>}

      {copyTradeSubTab === 'forward-validation' && <div className="forward-validation-panel">
        <p className="eyebrow copytrade-step-label">FORWARD VALIDATION</p>
        <p className="compact-info-line"><span>Future performance after selection</span><InfoTip label="Forward validation method" text="Tests traders selected from a dated, provenanced GMGN leaderboard against trades observed strictly after selection. This is separate from the historical screen." /></p>
        <label className={`copytrade-browser-import ${browserActivityImportBusy ? 'disabled' : ''}`}>
          <input type="file" accept=".json,application/json" disabled={browserActivityImportBusy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importBrowserActivity(file); event.currentTarget.value = ''; }} />
          <span>{browserActivityImportBusy ? 'Importing wallet activity…' : 'Import GMGN wallet activity for validation'}</span>
          <small className="compact-info-line"><span>Wallet activity JSON</span><InfoTip label="Wallet activity import" text="Upload an investigation export from the selected winner's wallet page. Only /vas/api/v1/wallet_activity/sol responses are normalized; the complete file is archived." /></small>
        </label>
        {captureHealth && <p className="muted">
          {captureHealth.provenancedSnapshotCount} provenanced capture{captureHealth.provenancedSnapshotCount === 1 ? '' : 's'} · {captureHealth.legacySnapshotCount} legacy (filter unknown, cannot be frozen)
          {captureHealth.latestSnapshotAt && <> · last capture {formatTime(captureHealth.latestSnapshotAt)} ({captureHealth.hoursSinceLastCapture?.toFixed(1)}h ago)</>}
        </p>}
        <button className="primary" disabled={freezeBusy || !captureHealth?.latestProvenancedSnapshotId} onClick={() => void freezeCurrentRoster()}>
          {freezeBusy ? 'Freezing…' : captureHealth?.latestProvenancedSnapshotId ? 'Freeze current roster as new experiment' : 'Capture a provenanced GMGN leaderboard to begin'}
        </button>

        {experimentsLoading && <p className="muted">Loading experiments…</p>}
        {!experimentsLoading && experiments.length === 0 && <p className="muted">No eligible frozen cohorts yet. Capture a fully provenanced GMGN leaderboard, then freeze it above.</p>}
        {experiments.length > 0 && <>
          <div className="table-wrap forward-experiment-list"><table className="copytrade-table"><thead><tr>
            <th>Frozen at</th><th>Filter</th><th>Wallets</th><th>Windows</th>
          </tr></thead><tbody>
            {experiments.map((experiment) => <tr key={experiment.experimentId} className={`forward-experiment-row ${experiment.experimentId === selectedExperimentId ? 'active' : ''}`} onClick={() => setSelectedExperimentId(experiment.experimentId)}>
              <td>{experiment.experimentId === selectedExperimentId ? '● ' : ''}{formatTime(experiment.selectedAtUtc)}</td>
              <td>{experiment.filterMatchesLatestCapture ? 'matches current' : <span className="copytrade-status-warning">⚠ different filter than latest capture</span>}</td>
              <td>{experiment.walletCount} ({experiment.primaryTopN} primary)</td>
              <td>{experiment.maturedWindowsDays.length > 0 ? `${experiment.maturedWindowsDays.map(formatForwardWindow).join(', ')} matured` : 'all pending'}{experiment.pendingWindowsDays.length > 0 && experiment.maturedWindowsDays.length > 0 ? `, ${experiment.pendingWindowsDays.map(formatForwardWindow).join(', ')} pending` : ''}</td>
            </tr>)}
          </tbody></table></div>

          {selectedExperiment && <>
            <p className="muted">Selected: {formatTime(selectedExperiment.selectedAtUtc)} · methodology {selectedExperiment.methodologyVersion} · {selectedExperiment.evaluatedScope ? `${selectedExperiment.evaluatedScope.winnerCount} first-stage winner${selectedExperiment.evaluatedScope.winnerCount === 1 ? '' : 's'} evaluated from ${selectedExperiment.evaluatedScope.frozenRosterCount} frozen wallets` : `${selectedExperiment.wallets.length} wallets`}</p>
            <div className="table-wrap copytrade-table-wrap"><table className="copytrade-table forward-validation-table"><thead><tr>
              <th>Trader</th><th>Rank</th><th>Group</th><th>Forward timeline</th>
            </tr></thead><tbody>
              {selectedExperiment.wallets.map((wallet) => <tr key={wallet.walletAddress}>
                <td><small className="address-compact" title={wallet.walletAddress}>{shortAddress(wallet.walletAddress)}</small></td>
                <td>#{wallet.rankAtSelection}</td>
                <td>{wallet.selectedGroup}</td>
                <td>{renderForwardTimeline(wallet.windows)}</td>
              </tr>)}
            </tbody></table></div>
          </>}
        </>}
      </div>}

      {copyTradeSubTab === 'research' && <div className="historical-wallet-performance-panel">
      <p className="eyebrow copytrade-step-label">HISTORICAL WALLET PERFORMANCE · NOT COPY PERFORMANCE</p>
      {copyTradeResults && <>
        <div className="copytrade-results-meta"><span>{formatCount(copyTradeResults.periodDays)} days · computed {formatTime(copyTradeResults.computedAt)}</span><button className="secondary" onClick={() => void saveCopyTradeSnapshot()}>Save snapshot</button></div>
        <p className="compact-info-line"><span>Roster source</span><InfoTip label="Selected roster" text={`Snapshot #${copyTradeResults.scope?.rosterSnapshotId ?? selectedRosterSnapshotId ?? '—'} · ${copyTradeResults.scope?.rosterProvenance?.window ?? 'legacy'} / ${copyTradeResults.scope?.rosterProvenance?.orderby ?? 'filter not recorded'} · captured ${formatTime(copyTradeResults.scope?.rosterProvenance?.capturedAt ?? null)}. All CopyTrade reports use this wallet list.`} /></p>
        {copyTradeResults.scope?.rosterProvenance && <details className="copytrade-rules"><summary>Exact GMGN leaderboard source</summary><p>Captured {formatTime(copyTradeResults.scope.rosterProvenance.capturedAt)} · window {copyTradeResults.scope.rosterProvenance.window ?? 'not recorded'} · ordered by {copyTradeResults.scope.rosterProvenance.orderby ?? 'not recorded'}.</p><pre>{JSON.stringify(copyTradeResults.scope.rosterProvenance.requestQuery, null, 2)}</pre></details>}
        <div className="copytrade-method-card"><strong>Wallet performance is available</strong><span>{copyTradeResults.walletPerformance?.description ?? 'This table describes the target wallets’ own realized trades.'}</span></div>
        <div className="table-wrap copytrade-table-wrap"><table className="copytrade-table"><thead><tr>
          {([['name', 'Trader'], ['trades', 'Trades'], ['winRatePercent', 'Win%'], ['medianReturnPercent', 'Median'], ['averageReturnPercent', 'Average'], ['endingCapitalUsd', '$100 →']] as Array<[CopyTradeSortKey, string]>).map(([key, label]) => <th key={key} onClick={() => toggleCopyTradeSort(key)} className="sortable-header">{label}{copyTradeSortIndicator(key)}</th>)}
          <th>Across time</th><th>Profit concentration</th><th>Rank history</th><th onClick={() => toggleCopyTradeSort('verdict')} className="sortable-header">Assessment{copyTradeSortIndicator('verdict')}</th>
        </tr></thead><tbody>
          {sortedCopyTradeRows.length === 0 ? <tr><td colSpan={10} className="muted">No trader results yet. Fetch trade data first.</td></tr> : sortedCopyTradeRows.map((row) => {
            const traderName = row.name?.trim() || shortAddress(row.walletAddress);
            const failedRules = row.failedRules.length ? row.failedRules.map(formatRule).join('; ') : 'All historical screen rules passed';
            const capitalClass = row.endingCapitalUsd === null ? '' : row.endingCapitalUsd > 100 ? 'copytrade-positive' : row.endingCapitalUsd < 100 ? 'copytrade-negative' : 'copytrade-neutral';
            const positiveWeeks = row.weeklyPerformance.filter((period) => (period.medianReturnPercent ?? 0) > 0).length;
            const positiveMonths = row.monthlyPerformance.filter((period) => (period.medianReturnPercent ?? 0) > 0).length;
            const concentration = row.profitConcentration;
            const bestToken = concentration.bestToken?.tokenSymbol || (concentration.bestToken ? shortAddress(concentration.bestToken.tokenAddress) : '—');
            const weeklyDots = row.weeklyPerformance.map((period) => <span key={`w-dot-${period.period}`} className={`copytrade-spark-segment ${period.medianReturnPercent === null ? 'neutral' : period.medianReturnPercent >= 0 ? 'positive' : 'negative'}`} title={`Week ${period.period}: ${formatPct(period.medianReturnPercent)} median`} />);
            const rankDots = Array.from({ length: Math.min(8, row.rankHistory.leaderboardCaptures) }, (_, index) => <span key={`rank-dot-${index}`} className={`copytrade-rank-dot ${index < row.rankHistory.topFiveAppearances ? 'active' : ''}`} />);
            const topThreeShare = concentration.bestThreeSharePositiveProfitPercent ?? 0;
            return <tr key={row.walletAddress}><td><strong>{traderName}</strong>{row.riskFlags.length > 0 && <span className="copytrade-risk-flags">{row.riskFlags.map((flag) => <span className="copytrade-risk-chip" key={flag}>{flag}</span>)}</span>}<small className="address-compact" title={row.walletAddress}>{shortAddress(row.walletAddress)}</small></td><td>{formatCount(row.trades)}</td><td>{formatPct(row.winRatePercent)}</td><td>{formatPct(row.medianReturnPercent)}</td><td>{formatPct(row.averageReturnPercent)}</td><td className={`copytrade-capital ${capitalClass}`}>{formatUsd(row.endingCapitalUsd)}</td>
              <td className="copytrade-evidence-cell"><strong>{positiveWeeks}/{row.weeklyPerformance.length} positive weeks</strong><div className="copytrade-sparkline" aria-label={`${positiveWeeks} of ${row.weeklyPerformance.length} positive weeks`}>{weeklyDots}</div><small>{positiveMonths}/{row.monthlyPerformance.length} positive months</small><details><summary>Breakdown</summary>{row.weeklyPerformance.map((period) => <small key={`w-${period.period}`}>Week {period.period}: {formatPct(period.medianReturnPercent)} median ({period.trades})</small>)}{row.monthlyPerformance.map((period) => <small key={`m-${period.period}`}>Month {period.period}: {formatPct(period.medianReturnPercent)} median ({period.trades})</small>)}</details></td>
              <td className="copytrade-evidence-cell"><strong>{bestToken} · {formatPct(concentration.bestTokenSharePositiveProfitPercent)}</strong><div className="copytrade-concentration-bar" title={`Top three tokens account for ${formatPct(concentration.bestThreeSharePositiveProfitPercent)} of positive profit`}><i style={{ width: `${Math.min(100, Math.max(0, topThreeShare))}%` }} /></div><small>top 3: {formatPct(concentration.bestThreeSharePositiveProfitPercent)} of positive profit</small><details><summary>Exclusions</summary><small>without best trade: {formatUsd(concentration.excludingBestTrade.endingCapitalUsd)}</small><small>without best token: {formatUsd(concentration.excludingBestToken.endingCapitalUsd)}</small></details></td>
              <td className="copytrade-evidence-cell"><strong>Top 5: {row.rankHistory.topFiveAppearances}/{row.rankHistory.leaderboardCaptures}</strong><div className="copytrade-rank-dots" aria-label={`${row.rankHistory.topFiveAppearances} top-five appearances across ${row.rankHistory.leaderboardCaptures} captures`}>{rankDots}</div><small>{formatPct(row.rankHistory.topFiveMembershipPercent)} of captures</small><small>current #{row.rankHistory.currentRank ?? '—'} · best #{row.rankHistory.bestRank ?? '—'} · worst #{row.rankHistory.worstRank ?? '—'}</small></td>
              <td title={failedRules}><span className={`copytrade-verdict copytrade-verdict-${row.verdict}`}><b>{copyTradeVerdictIcon[row.verdict]}</b> {copyTradeVerdictLabel[row.verdict]}</span></td></tr>;
          })}
          {/* Both aggregations are shown because they answer different questions and routinely
              disagree: pooling every trade lets the busiest wallet define the headline, while
              one-vote-per-wallet describes a typical trader on the list. */}
          {copyTradeResults && ([copyTradeResults.overall, copyTradeResults.overallByWallet] as CopyTradeOverallRow[]).map((row) => (
            <tr key={row.weighting} className="copytrade-overall-row">
              <td><strong>{row.weighting === 'trade-weighted' ? `ALL ${copyTradeRows.length} · by trade` : `ALL ${copyTradeRows.length} · by wallet`}</strong><small>{row.weighting === 'trade-weighted' ? 'every trade pooled' : 'each wallet counts once'}</small></td>
              <td>{formatCount(row.trades)}</td>
              <td>{formatPct(row.winRatePercent)}</td>
              <td>{formatPct(row.medianReturnPercent)}</td>
              <td>{formatPct(row.averageReturnPercent)}</td>
              <td className={`copytrade-capital ${row.endingCapitalUsd === null ? '' : row.endingCapitalUsd > 100 ? 'copytrade-positive' : row.endingCapitalUsd < 100 ? 'copytrade-negative' : 'copytrade-neutral'}`}>{formatUsd(row.endingCapitalUsd)}</td>
              <td colSpan={4}>—</td>
            </tr>
          ))}
        </tbody></table></div>
        {medianAverageConflicts.length > 0 && <p className="copytrade-warning"><strong>Median and average disagree:</strong> {medianAverageConflicts.map((row) => `${row.name?.trim() || shortAddress(row.walletAddress)}: average ${formatPct(row.averageReturnPercent)} but median ${formatPct(row.medianReturnPercent)}.`).join(' ')} Median is the more honest typical outcome.</p>}
        <details className="copytrade-rules"><summary>Screen-pass rules · all must pass</summary><p>{formatCount(copyTradeResults.rules.minTrades)}+ trades · {formatCount(copyTradeResults.rules.minDays)}+ days · {copyTradeResults.rules.requiresPositiveMedian ? 'positive median' : 'median sign not required'} · no risk flag · complete comparable history.</p></details>
        <div className="copytrade-method-card"><strong>Copy simulation is separate and not available</strong><span>{copyTradeResults.copySimulation?.description ?? 'No execution simulation is mixed into these wallet results.'} Required before simulation: {copyTradeResults.copySimulation?.requiredInputs.join(', ') ?? 'delay, slippage, fees, liquidity, and failed-order assumptions'}.</span></div>
      </>}
      </div>}
    </section>

    <section id="birdeye" className="menu-section panel signal-outcome-panel">
      <div className="panel-heading"><div><p className="eyebrow">SIGNAL OUTCOME TIMELINE</p><h2>Measure a captured GMGN signal</h2></div><span className="tag">PRICE HISTORY</span></div>
      <p>Choose a signal already captured by GMGN. The app freezes its buy/sell label and observed time, then requests historical prices at the signal, +1h, +6h, +24h, and +7d. Each response is archived separately.</p>
      <p className="muted">This legacy single-token diagnostic is available only in the full view. Use the batch signal timeline above.</p>
    </section>

    <section id="legacy-probe" className="menu-section panel probe-panel">
      <div className="panel-heading"><div><p className="eyebrow">CURRENT WORK · ONE COIN</p><h2>Check one token outcome</h2></div><span className="tag">RAW EVIDENCE</span></div>
      <p>Fetches one historical price response and one liquidity response for a token and timestamp. The app stores both untouched responses and archives them; it does not calculate an outcome yet.</p>
      <div className="probe-form"><label>Token address<input value={probeAddress} onChange={(event) => setProbeAddress(event.target.value)} placeholder="Solana token address" /></label><label>Target UTC time<input type="datetime-local" value={probeTime} onChange={(event) => setProbeTime(event.target.value)} /></label><button className="primary" disabled={probeBusy || !probeAddress.trim()} onClick={() => void runBirdeyeProbe()}>{probeBusy ? 'Probing…' : 'Run one probe'}</button></div>
      {probeResult && <div className="probe-result"><strong>{probeResult.status === 'completed' ? 'Historical outcome received' : 'Partial result received'}</strong><div className="probe-result-grid"><span>Price HTTP <b>{probeResult.priceHttpStatus ?? '—'}</b></span><span>Price at target <b>{probeResult.priceUsd === null ? 'not returned' : `$${probeResult.priceUsd}`}</b></span><span>Historical liquidity HTTP <b>{probeResult.liquidityHttpStatus ?? '—'}</b></span><span>Current liquidity fallback <b>{probeResult.currentLiquidityUsd === null ? `not returned (${probeResult.currentLiquidityHttpStatus ?? '—'})` : `$${probeResult.currentLiquidityUsd}`}</b></span></div><small>{probeResult.error ? `${probeResult.error} · ` : ''}{probeResult.liquidityMessage ? `${probeResult.liquidityMessage} · ` : ''}Complete raw response archived{probeResult.archivePath ? ` · ${probeResult.archivePath}` : ''}</small></div>}
    </section>

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
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
