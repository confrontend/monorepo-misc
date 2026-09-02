import type { PatternDiscoveryProgressView } from './components/PatternDiscoveryProgressPanel.js';

export type ScrutinyCheck<M> = {
  key: string;
  label: string;
  n: number;
  verdict: 'pass' | 'fail' | 'insufficient';
  detail: string;
  metrics: M;
};

export type Stats = {
  tokenCount: number;
  gmgnSignalCount: number;
  tokenFirstTrade: { earliest: string | null; latest: string | null };
  gmgnObserved: { earliest: string | null; latest: string | null };
  gmgnCaptured: { earliest: string | null; latest: string | null };
  signalsByType: Array<{ signalType: string; count: number }>;
};

export type ImportSummary = {
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

export type DataQuality = {
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

export type LastDuneImport = { fileName: string; at: string; result: ImportSummary };

export type GmgnTokenAddressSummary = {
  addresses: string[];
  total: number;
  matchedToCohort: number;
  unmatchedToCohort: number;
};

export type RawEndpointCounts = { imported: number; skipped: number };

export type RawEndpointBreakdown = {
  radar: RawEndpointCounts;
  walletRank: RawEndpointCounts;
  smartMoney: RawEndpointCounts;
  twitter: RawEndpointCounts;
};

export type BrowserImportResult = {
  batchId: number;
  imported: number;
  skipped: number;
  errors: number;
  issueBreakdown: Record<string, number>;
  otherCaptures: number;
  coverageWindowsImported: number;
  duplicateFile: boolean;
  archivePath: string | null;
  archiveSha256: string | null;
  rawEndpoints: RawEndpointBreakdown;
};

export type RawEndpointSummary = {
  radar: { count: number; latestCapturedAt: string | null };
  walletRank: { count: number; latestCapturedAt: string | null };
  smartMoney: { count: number; latestCapturedAt: string | null };
  twitter: { count: number; latestCapturedAt: string | null };
};

export type RawEndpointType = 'radar' | 'wallet-rank' | 'smart-money' | 'twitter';

export type RawRadarSnapshot = {
  id: number;
  chain: string | null;
  period: string | null;
  category: string | null;
  capturedAt: string;
  rawPayload: unknown;
};

export type RawWalletRankSnapshot = {
  id: number;
  window: string | null;
  orderby: string | null;
  capturedAt: string;
  requestPath?: string | null;
  requestQuery?: Record<string, unknown>;
  rawPayload: unknown;
};

export type RawSmartMoneyWalletStat = {
  id: number;
  walletAddress: string;
  chain: string | null;
  capturedAt: string;
  rawPayload: unknown;
};

export type RawTwitterMessage = {
  id: number;
  tweetId: string | null;
  twType: string | null;
  hasToken: boolean | null;
  capturedAt: string;
  rawPayload: unknown;
};

export type RawEndpointRow =
  RawRadarSnapshot | RawWalletRankSnapshot | RawSmartMoneyWalletStat | RawTwitterMessage;

export type SnapshotAnalysis = {
  generatedAt: string;
  scope: 'descriptive-snapshot-only';
  signals: {
    total: number;
    uniqueTokens: number;
    averagePerToken: number;
    singleSignalTokens: number;
    multiSignalTokens: number;
    maxSignalsPerToken: number;
  };
  signalTypes: Array<{ signalType: string; count: number }>;
  sources: Array<{ source: string; count: number }>;
  cohortOverlap: { matchedSignals: number; unmatchedSignals: number; matchedTokens: number };
  timing: {
    earliestObservedAt: string | null;
    latestObservedAt: string | null;
    earliestCapturedAt: string | null;
    latestCapturedAt: string | null;
  };
  marketCap: {
    count: number;
    minimum: number | null;
    median: number | null;
    average: number | null;
    maximum: number | null;
  };
  validation: {
    signalsWithIssues: number;
    missingTokenAddress: number;
    missingSignalType: number;
    missingObservedAt: number;
  };
  limitations: string[];
};

export type SignalScoreRow = {
  signalId: number;
  tokenAddress: string | null;
  signalType: string | null;
  observedAt: string | null;
  score: number;
  maxScore: 8;
  matchedDuneToken: boolean;
  firstTradeKnown: boolean;
  firstDexKnown: boolean;
  firstTxKnown: boolean;
  signalTimeKnown: boolean;
  temporalOrderValid: boolean;
  marketCapKnown: boolean;
};

export type SignalScoringReport = {
  generatedAt: string;
  method: 'exploratory-data-readiness-v1';
  totalSignals: number;
  averageScore: number;
  scoreDistribution: Array<{ score: number; count: number }>;
  rows: SignalScoreRow[];
  limitations: string[];
};

export type OutcomeCandidate = {
  id: number;
  tokenAddress: string;
  symbol: string | null;
  signalType: string | null;
  observedAt: string;
  marketCap: number | null;
};

export type PrescreenSummary = {
  ruleVersion: string;
  auditSeed: string;
  maxSignalIds: number;
  auditFraction: number;
  minSignalAgeHours: number;
  selectedIds: number[];
  selectedNewCount: number;
  selectedRetryCount: number;
  byDisposition: Record<string, number>;
  bySignalType: Array<{
    signalType: string;
    captured: number;
    selected: number;
    core: number;
    audit: number;
    deferred: number;
    newSelected: number;
    retrySelected: number;
    tooFresh: number;
  }>;
};

export type MeasurementPlan = {
  version: string;
  generatedAt: string;
  retryDelaysMinutes: number[];
  maxAttempts: number;
  capturedCount: number;
  parsedCount: number;
  latestCapturedAt: string | null;
  latestObservedAt: string | null;
  latestDuneCompletedAt: string | null;
  measuredCount: number;
  unmeasuredCount: number;
  tooFreshCount: number;
  inFlightCount: number;
  neverMaturelyAttemptedCount: number;
  eligibleSignalIds: number[];
  eligibleNewSignalIds: number[];
  eligibleRetrySignalIds: number[];
  retryQueueSignalIds: number[];
  byState: Record<string, number>;
  bySignalType: Array<{
    signalType: string;
    captured: number;
    measured: number;
    unmeasured: number;
    eligible: number;
    pending: number;
    complete: number;
    retryEligible: number;
    inFlight: number;
    tooFresh: number;
    neverMaturelyAttempted: number;
    waitingOnRetryBuffer: number;
  }>;
  prescreen: PrescreenSummary;
};

export type DuneReconcileSummary = {
  checked: number;
  completed: number;
  failed: number;
  stillRunning: number;
  noApiKey: number;
  runIds: { completed: number[]; failed: number[]; stillRunning: number[] };
};

export type CopyTradeSummary = {
  traders: number | null;
  trades: number | null;
  historyDays: number | null;
  verifiedPercent: number | null;
  lastRunAt: string | null;
};

export type CopyTradeFetchStatus = {
  running: boolean;
  runId: number | null;
  walletDone: number | null;
  walletTotal: number | null;
  tradesFetched: number | null;
  tradesDuplicate: number | null;
  tradesDailyCapped: number | null;
  failedWallets: number | null;
  requestsMade: number | null;
  rateLimitedUntil: string | null;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'rate_limited' | 'cancelled';
  message: string;
  estimatedRemainingSeconds: number | null;
  expectedTradesTotal?: number | null;
  storedTradesTotal?: number | null;
  remainingTradesTotal?: number | null;
  totalTradeProgressPercent?: number | null;
  currentWalletAddress?: string | null;
  currentWalletExpectedTrades?: number | null;
  currentWalletStoredTrades?: number | null;
  currentWalletRemainingTrades?: number | null;
  currentWalletProgressPercent?: number | null;
  currentWalletEstimatedRemainingSeconds?: number | null;
  totalEstimatedRemainingSeconds?: number | null;
  scope: 'roster' | 'winners' | 'single' | null;
  resumeAvailable?: boolean;
  estimateExceeded?: boolean;
  walletsWithNewData?: number;
  walletsAlreadyCurrent?: number;
};

export type CopyTradeFetchEstimateBasis = {
  source: 'measured' | 'default';
  runsCounted: number;
  updatedAt: string | null;
};

export type CopyTradeFetchEstimate = {
  walletCount: number;
  freshWallets: number;
  coveredWallets: number;
  periodDays: number;
  estimatedRequests: number;
  estimatedSeconds: number;
  basis: CopyTradeFetchEstimateBasis;
  confidence: 'seeded' | 'low' | 'medium' | 'high';
};

export type BrowserActivityImportResult = {
  imported: number;
  duplicates: number;
  malformed: number;
  activityEndpoints: number;
  samples: number;
  archivePath: string | null;
  archiveSha256: string | null;
};

export type CopyTradePeriod = {
  period: string;
  trades: number;
  winRatePercent: number | null;
  medianReturnPercent: number | null;
  averageReturnPercent: number | null;
  endingCapitalUsd: number | null;
};

export type CopyTradeTokenProfit = {
  tokenAddress: string;
  tokenSymbol: string | null;
  trades: number;
  profitUsd: number;
};

export type CopyTradeConcentration = {
  bestToken: CopyTradeTokenProfit | null;
  bestThreeTokens: CopyTradeTokenProfit[];
  bestTokenSharePositiveProfitPercent: number | null;
  bestThreeSharePositiveProfitPercent: number | null;
  bestTradeProfitUsd: number | null;
  excludingBestTrade: {
    trades: number;
    medianReturnPercent: number | null;
    endingCapitalUsd: number | null;
  };
  excludingBestToken: {
    trades: number;
    medianReturnPercent: number | null;
    endingCapitalUsd: number | null;
  };
};

export type CopyTradeRankHistory = {
  leaderboardCaptures: number;
  appearances: number;
  topFiveAppearances: number;
  topFiveMembershipPercent: number | null;
  currentRank: number | null;
  bestRank: number | null;
  worstRank: number | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
};

/** GMGN's own outcome-distribution buckets. These are the closest thing the aggregate endpoint
 *  gives to a return histogram, and they answer the tail question directly: how many positions
 *  were total losses versus multi-baggers. Counts, never percentages, so a small sample cannot
 *  hide behind a ratio. */
export type GmgnPnlBuckets = {
  lossOver50: number | null;
  loss50to0: number | null;
  gain0to2x: number | null;
  gain2to5x: number | null;
  gainOver5x: number | null;
};

export type GmgnAggregateStats = {
  period: string;
  fetchedAt: string;
  realizedProfit: number | null;
  realizedProfitPnlPercent: number | null;
  nativeBalance: number | null;
  buyCount: number | null;
  sellCount: number | null;
  boughtCost: number | null;
  soldIncome: number | null;
  boughtFee: number | null;
  soldFee: number | null;
  totalCost: number | null;
  lastTimestamp: number | null;
  tokenCount: number | null;
  winRatePercent: number | null;
  averageHoldingPeriodSeconds: number | null;
  buckets: GmgnPnlBuckets;
  tags: string[];
  walletCreatedAt: number | null;
  twitterName: string | null;
  createdTokenCount: number | null;
};

export type GmgnStatsFetchStatus = {
  workflowRunId: number | null;
  running: boolean;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  walletDone: number;
  walletTotal: number;
  periods: string[];
  requestsMade: number;
  skippedFresh: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type GmgnStatsRecord = {
  walletAddress: string;
  period: string;
  fetchedAt: string;
  rawPayload: string;
};

export type CopyTradeHistoryRow = {
  id: number;
  walletAddress: string;
  chain: string;
  txHash: string;
  eventType: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  observedTimestamp: number;
  tokenAmount: string | null;
  costUsd: string | null;
  buyCostUsd: string | null;
  priceUsd: string | null;
  gasUsd: string | null;
  dexUsd: string | null;
  launchpadPlatform: string | null;
  fetchedAt: string;
};

export type CopyTradeHistoryResponse = {
  walletAddress: string;
  chain: string;
  total: number;
  rows: CopyTradeHistoryRow[];
  coverage: {
    requestsUsed: number;
    periodDays: number | null;
    truncated: number;
    stopReason: string | null;
    updatedAt: string;
    resumeCursor: string | null;
  } | null;
};

export type CopyTradeHistoryBulkResponse = { histories: CopyTradeHistoryResponse[] };

export type PatternDiscoveryExport = {
  metadata: {
    project: 'crypto';
    outcome: 'net_return_after_costs';
    outcome_horizon: string;
    period_days: number;
    coverage_scope: 'outcome_minimum_percent';
    minimum_coverage_percent: number;
    coverage_semantics: string;
    selection_rule: string;
    selected_wallet_count: number;
    exported_rows: number;
    eligible_wallets_before_threshold: number;
    excluded_wallets_below_threshold: number;
    coverage_distribution_percent: number[];
    export_generated_at: string;
  };
  rows: Array<{
    event_id: string;
    event_time: string;
    entity_id: string;
    signal_type: string;
    wallet_address: string;
    token_address: string;
    net_return_after_costs: number;
    coverage_rate_percent: number;
    coverage_status: 'fully_covered' | 'partially_covered';
  }>;
};

export type PatternDiscoveryReport = {
  project: 'crypto';
  patterns: Array<{
    source?: string;
    kind?: string;
    feature?: string;
    conditions?: unknown;
    effect?: number | null;
    p_value?: number | null;
    q_value?: number | null;
    discovery_sample_size?: number;
    discovery_independence_groups?: number;
    discovery_wallets?: number;
    weighting?: string;
    promoted?: boolean;
    validationStatus?: string;
    validation?: {
      sample_size?: number;
      effect_vs_all?: number | null;
      coefficient?: number | null;
      independence_groups?: number;
      wallets?: number;
      weighting?: string;
      reason?: string;
    };
    historical_stability?: {
      status?: string;
      blocks?: number;
      surviving_blocks?: number;
      reason?: string;
    };
    reason?: string;
  }>;
  status_counts: Record<string, number>;
  dataset_summary?: {
    rows?: number;
    independence_groups?: number;
    wallets?: number;
    [key: string]: unknown;
  };
  input_contract?: { feature_allowlist_version?: string; rejected_fields?: string[] };
  split: {
    method?: string;
    discovery_rows?: number;
    validation_rows?: number;
    untouched_holdout_rows?: number;
    holdout_policy?: string;
    holdout_used_for_discovery?: boolean;
    holdout_used_for_validation?: boolean;
    [key: string]: unknown;
  };
  language?: string;
};

export type PatternDiscoveryExecution = {
  pythonExecutable: string;
  inputPath: string;
  outputPath: string;
  sharedRoot: string;
};

export type PatternDiscoverySensitivityPoint = {
  minimumCoveragePercent: number;
  wallets: number;
  rows: number;
  independentEntries: number;
  validationSurvivors: number;
  discoveredCandidates: number;
  promotedPatterns: number;
  historicalStablePatterns: number;
  rejected: number;
  insufficientData: number;
  reportAvailable: boolean;
  error?: string;
};

export type PatternDiscoverySensitivity = {
  thresholds: PatternDiscoverySensitivityPoint[];
  weighting: 'equal wallet total weight';
  note: string;
  reportsByCoverage?: Record<string, PatternDiscoveryReport>;
  crossCoveragePromotedPatterns?: Array<{
    pattern: PatternDiscoveryReport['patterns'][number];
    supportingCoveragePercent: number[];
  }>;
};

export type PatternDiscoveryRunResponse = {
  report?: PatternDiscoveryReport;
  execution?: PatternDiscoveryExecution;
  sensitivity?: PatternDiscoverySensitivity;
  freshness?: {
    state: 'current' | 'stale';
    currentFingerprint: string;
    cachedFingerprint?: string;
    cachedAt?: string;
  };
};

export type PatternDiscoveryStartResponse = {
  started: true;
  runId: number;
  progress: PatternDiscoveryProgress;
};

export type PatternDiscoveryProgress = PatternDiscoveryProgressView;

export type ResearchUpdateSummary = {
  completedAt: string;
  rosterSnapshotId: number | null;
  rosterWalletCount: number;
  rosterAdded: number;
  rosterAlreadyPresent: number;
  statsStatus: string;
  statsWalletDone: number;
  statsWalletTotal: number;
  statsRequests: number;
  statsReused: number;
  duneSubmitted: number;
  duneBatches: number;
  duneExhausted: boolean;
  beforeRows: number;
  beforeStatsRows: number;
  beforeMatched: number;
  beforeVerdicts: Record<string, number>;
  beforeVerdictByWallet: Record<string, string>;
  leaderboardOrderby: string;
  leaderboardMinWinrate30d: number;
};

export type RosterChange = {
  joinedWallets: string[];
  leftWallets: string[];
  live: boolean;
  capturedAt: string | null;
};

export type RosterWalletComparison = {
  walletAddress: string;
  chain: string;
  name: string | null;
  iconUrl?: string | null;
  rankPosition: number | null;
  reportedPnl30d: string | null;
  reportedWinrate30d: string | null;
  riskFlags: string[];
};

export type RosterComparison = {
  currentSnapshotId: number | null;
  currentCapturedAt: string | null;
  previousSnapshotId: number | null;
  previousCapturedAt: string | null;
  baselineAvailable: boolean;
  current: RosterWalletComparison[];
  joined: RosterWalletComparison[];
  left: RosterWalletComparison[];
};

export type WalletScreenSummary = {
  completedAt: string;
  snapshotId: number | null;
  walletCount: number;
  statsWalletCount: number;
  fastWallets: number;
  notFastWallets: number;
  missingStatsWallets: number;
  totalTrades: number;
  maxTrades: number;
  maxTradesWallet: string | null;
  activityLeaders: Array<{
    wallet: string;
    name: string | null;
    trades: number;
    rank: number | null;
    netProfit: number | null;
    averageHoldSeconds: number | null;
  }>;
  periodDays: number;
  averageHoldThresholdSeconds: number;
  lastFetchedAt: string | null;
};

export type GmgnLeaderboardMetric = {
  pnl1d: unknown;
  pnl7d: unknown;
  pnl30d: unknown;
  dailyProfit7d: unknown;
};

export type CopyTradeRow = {
  walletAddress: string;
  name: string | null;
  iconUrl?: string | null;
  trades: number | null;
  winRatePercent: number | null;
  medianReturnPercent: number | null;
  averageReturnPercent: number | null;
  endingCapitalUsd: number | null;
  endingCapitalUsdCompounded: number | null;
  coveredDays: number | null;
  capitalPath?: Array<{ day: string; capitalUsd: number }>;
  verdict: 'screen_pass' | 'no' | 'thin' | 'flagged' | 'descriptive_only';
  comparable: boolean;
  riskFlags: string[];
  gmgnTags?: string[];
  failedRules: string[];
  truncated?: boolean;
  historyFailed?: boolean;
  riskEvidence?: {
    medianHoldSeconds: number | null;
    walletAgeDays: number | null;
    under15SecondsPercent?: number | null;
    under15SecondsCount?: number;
    pairedTradeCount?: number;
  };
  profitConcentration: CopyTradeConcentration;
  weeklyPerformance: CopyTradePeriod[];
  monthlyPerformance: CopyTradePeriod[];
  rankHistory: CopyTradeRankHistory;
  representativeSampled?: boolean;
  representativePopulationTrades?: number;
  representativeSampleTrades?: number;
  gmgnAggregate?: GmgnAggregateStats;
};

export type CopyTradeResults = {
  computedAt: string;
  startingCapitalUsd: 100;
  periodDays: number | null;
  rows: CopyTradeRow[];
  overall: CopyTradeOverallRow;
  overallByWallet: CopyTradeOverallRow;
  rules: { minTrades: number | null; minDays: number | null; requiresPositiveMedian: boolean };
  representativeSampling?: {
    method: string;
    maxSellsPerWallet: number | null;
    sampledWallets: number;
    populationTrades: number;
    selectedTrades: number;
  };
  scope?: {
    rosterSnapshotId: number | null;
    rosterProvenance: {
      capturedAt: string;
      window: string | null;
      orderby: string | null;
      requestPath: string | null;
      requestQuery: Record<string, unknown>;
    } | null;
  };
  walletPerformance?: { status: 'available'; description: string };
  copySimulation?: { status: 'not_available'; description: string; requiredInputs: string[] };
};

export type CopyTradeOverallRow = {
  trades: number | null;
  winRatePercent: number | null;
  medianReturnPercent: number | null;
  averageReturnPercent: number | null;
  endingCapitalUsd: number | null;
  weighting: 'trade-weighted' | 'wallet-weighted';
  wallets: number | null;
};

export type CopyTradeSortKey =
  | 'name'
  | 'trades'
  | 'winRatePercent'
  | 'medianReturnPercent'
  | 'averageReturnPercent'
  | 'endingCapitalUsd'
  | 'verdict';

export type DecisionSortKey =
  | 'default'
  | 'rank'
  | 'name'
  | 'verdict'
  | 'gmgnPnl'
  | 'copyResult'
  | 'copyCapital'
  | 'coverage'
  | 'activity';

export type GmgnStatsSortKey =
  | 'name'
  | 'pnl1d'
  | 'pnl7d'
  | 'pnl30d'
  | 'dailyProfit7d'
  | 'win7d'
  | 'win30d'
  | 'activity'
  | 'equivalent'
  | 'updated';

export type CopyDelaySortKey =
  'trader' | 'totalTrades7d' | 'totalTrades30d' | 'medianHold' | 'delayShare' | 'edge' | 'reading';

export type CopySimulationBatchOutcome = {
  batch: number;
  targets: number;
  status: 'running' | 'stored' | 'failed';
  seconds: number | null;
  error: string | null;
};

export type CopySimulationRunStatus = {
  mode?: 'precise' | 'wide_retry';
  running: boolean;
  cancelRequested: boolean;
  targetsTotal: number;
  targetsProcessed: number;
  batchesRun: number;
  currentBatch: number;
  batchesTotal: number;
  message: string;
  batches: CopySimulationBatchOutcome[];
  startedAt: string | null;
  finishedAt: string | null;
  storedTargets: number;
  failedTargets: number;
  remainingTargets: number;
  retryableTargetsBefore?: number | null;
  retryableTargetsRemaining?: number | null;
  coverageBeforePercent?: number | null;
  coverageAfterPercent?: number | null;
  outcome: 'idle' | 'running' | 'complete' | 'partial' | 'stopped' | 'error';
  duneExecutionId: string | null;
  duneState: string | null;
  dunePollCount: number;
  duneElapsedSeconds: number;
  duneIsExecutionFinished: boolean;
  duneExecutionCostCredits: number | null;
  duneLastStatusAt: string | null;
  duneRequestPhase?:
    'status_requesting' | 'status_received' | 'results_requesting' | 'results_received' | 'idle';
  duneLastHttpStatus?: number | null;
  duneLastRequestMs?: number | null;
  duneLastPayload?: string | null;
  persistedRun?: {
    id: number;
    status: string;
    requestedAt: string;
    completedAt: string | null;
    storedTargets: number;
    searchWindowMinutes: number;
    matchSource: string;
  } | null;
  audit?: {
    id: number;
    requestedAt: string;
    completedAt: string | null;
    mode: string;
    walletCount: number;
    plannedTargets: number;
    submittedTargets: number;
    storedTargets: number;
    failedTargets: number;
    remainingTargets: number;
    status: string;
    message: string | null;
  } | null;
};

export type CopySimulationDuneResponse = {
  id: number;
  executionId: string | null;
  status: string;
  requestedAt: string;
  completedAt: string | null;
  tradeCount: number;
  archivePath: string | null;
  archiveSha256: string | null;
  rawResult: string | null;
};

export type HistoricalConsistencyVerdict =
  'consistent' | 'declining' | 'recent_only' | 'consistently_negative' | 'insufficient';

export type HistoricalConsistencySplit = 'fixed_60_30' | 'relative_half' | 'insufficient_depth';

export type HistoricalPeriodReport = {
  label: 'early' | 'recent';
  startAt: string | null;
  endAt: string | null;
  trades: number;
  summary: {
    trades: number;
    winRatePercent: number | null;
    medianReturnPercent: number | null;
    averageReturnPercent: number | null;
    endingCapitalUsd: number | null;
    endingCapitalUsdCompounded: number | null;
  };
  weeklyConsistency: {
    positivePeriods: number;
    periodsWithData: number;
    positivePercent: number | null;
  };
  profitConcentration: {
    bestToken: { tokenAddress: string; tokenSymbol: string | null } | null;
    bestTokenSharePositiveProfitPercent: number | null;
    bestThreeSharePositiveProfitPercent: number | null;
  };
};

export type HistoricalConsistencyRow = {
  walletAddress: string;
  availableDays: number | null;
  split: HistoricalConsistencySplit;
  splitPointAt: string | null;
  early: HistoricalPeriodReport;
  recent: HistoricalPeriodReport;
  verdict: HistoricalConsistencyVerdict;
  name: string | null;
  rankPosition: number | null;
  riskFlags: string[];
};

export type HistoricalConsistencyReport = {
  computedAt: string;
  rules: {
    minimumHistoryDays: number;
    fixedHistoryDays: number;
    recentDays: number;
    description: string;
  };
  totalWallets: number;
  counts: Record<HistoricalConsistencyVerdict, number>;
  rows: HistoricalConsistencyRow[];
  scope?: { chain: string; traderLimit: number; rosterSize: number };
};

export type CaptureHealth = {
  latestSnapshotAt: string | null;
  latestSnapshotId: number | null;
  latestProvenanceStatus: 'provenanced' | 'legacy_unprovenanced' | null;
  latestFilterHash: string | null;
  latestProvenancedSnapshotId: number | null;
  hoursSinceLastCapture: number | null;
  distinctCaptureDatesForLatestFilter: number;
  legacySnapshotCount: number;
  provenancedSnapshotCount: number;
};

export type CopyTradeRosterSnapshot = {
  snapshotId: number;
  capturedAt: string;
  provenanceStatus: 'provenanced' | 'legacy_unprovenanced';
  window: string | null;
  orderby: string | null;
  filterHash: string | null;
};

export type CopyTradeRosterCatalog = {
  selectedByDefault: number | null;
  snapshots: CopyTradeRosterSnapshot[];
};

export type CopyCandidate = {
  walletAddress: string;
  name: string | null;
  rankPosition: number | null;
  medianReturnPercent: number | null;
  winRatePercent: number | null;
  trades: number;
  endingCapitalUsd: number | null;
  endingCapitalUsdCompounded: number | null;
  coveredDays: number | null;
  analysisPeriodDays: number;
  medianHoldSeconds: number | null;
  fastRoundTripPercent: number | null;
  concentrationPercent: number | null;
  bestTokenSymbol: string | null;
  historicalConsistencyVerdict: HistoricalConsistencyVerdict | null;
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

export type CopyCandidatesReport = {
  computedAt: string;
  thresholds: {
    minMedianHoldSeconds: number;
    maxFastRoundTripPercent: number;
    maxConcentrationPercent: number;
    requiredHistoricalConsistencyVerdict: string;
  };
  screenedCount: number;
  candidates: CopyCandidate[];
  excludedCount: number;
  pendingCopySimulationCount: number;
  failedCopySurvivalCount: number;
  highUpsideCandidates: CopyCandidate[];
  highUpsidePendingSimulationCount: number;
};

export type CandidateScrutinyReport = {
  walletAddress: string;
  name: string | null;
  computedAt: string;
  selectionContext: { candidateCount: number; screenedCount: number; note: string };
  checks: {
    dormancy: ScrutinyCheck<{ daysSinceLastTrade: number | null; dormantAfterDays: number }>;
    coverage: ScrutinyCheck<{
      inWindowMatched: number;
      inWindowTotal: number;
      inWindowPercent: number | null;
      fullHistoryMatched: number;
      fullHistoryTotal: number;
      fullHistoryPercent: number | null;
    }>;
    coverageBias: ScrutinyCheck<{
      matchedBigWinPercent: number | null;
      matchedN: number;
      unmatchedBigWinPercent: number | null;
      unmatchedN: number;
      gapPercentagePoints: number | null;
      direction: 'conservative' | 'optimistic' | 'unclear' | 'no_gap';
    }>;
    concentration: ScrutinyCheck<{
      bestTokenSymbol: string | null;
      bestTokenSharePercent: number | null;
      medianWithToken: number | null;
      medianWithoutToken: number | null;
      tradesWithoutToken: number;
    }>;
    repeatEntry: ScrutinyCheck<{
      repeatEntryMedianReturnPercent: number | null;
      repeatEntryN: number;
      singleEntryMedianReturnPercent: number | null;
      singleEntryN: number;
    }>;
    buySellComposition: ScrutinyCheck<{
      buyCount: number;
      sellCount: number;
      buySharePercent: number | null;
    }>;
    medianMeanDivergence: ScrutinyCheck<{
      medianReturnPercent: number | null;
      averageReturnPercent: number | null;
      diverges: boolean;
    }>;
    tailFragility: ScrutinyCheck<{
      top3SharePercent: number | null;
      tradesAboveThreshold: number;
      thresholdPercent: number;
      simulatedTrades: number;
    }>;
    copyability: ScrutinyCheck<{
      medianHoldSeconds: number | null;
      copierDelaySeconds: number;
      delayMultiple: number | null;
      minRequiredMultiple: number;
    }>;
    outOfSampleStability: ScrutinyCheck<{
      splitDate: string | null;
      earlyMedianReturnPercent: number | null;
      earlyN: number;
      lateMedianReturnPercent: number | null;
      lateN: number;
    }>;
  };
};

export type ScrutinyResponse = {
  reports: CandidateScrutinyReport[];
  cappedAt: number;
  requested: number;
  missingWallets: string[];
};

export type GmgnRiskMetrics = {
  realizedProfit: number | null;
  realizedPnlPercent: number | null;
  winRate: number | null;
  buys: number | null;
  sells: number | null;
  fees: number | null;
  averageHoldingSeconds: number | null;
  nativeBalance: number | null;
  tokenCount: number | null;
  risk: {
    noBuyHold: number | null;
    noBuyHoldRatio: number | null;
    sellPassBuy: number | null;
    sellPassBuyRatio: number | null;
    fastTx: number | null;
    fastTxRatio: number | null;
  };
  pnlDistribution: Record<string, number | string>;
};

export type GmgnRiskResult = {
  walletAddress: string;
  period: '30d';
  available: boolean;
  metrics?: GmgnRiskMetrics;
  error?: string;
};

export type GmgnRiskResponse = {
  results: GmgnRiskResult[];
  requestedWallets: number;
  requestedPeriods: string[];
};

export type EliminationReason =
  | 'strongly_negative_30d_pnl'
  | 'negative_delayed_copy_result'
  | 'hold_time_shorter_than_copy_delay';

export type CoverageGapDirection = 'conservative' | 'optimistic' | 'unclear' | 'no_gap';

export type HiddenLossRisk = 'high' | 'moderate' | 'negligible' | 'unknown';

export type CoverageGapAssessment = {
  matchedBigWinPercent: number | null;
  matchedN: number;
  unmatchedBigWinPercent: number | null;
  unmatchedN: number;
  gapPercentagePoints: number | null;
  upsideBiasWeightedPercentagePoints: number | null;
  direction: CoverageGapDirection;
  shownLossRatePercent: number | null;
  trueLossRatePercent: number | null;
  lossRateUnderstatedPercentagePoints: number | null;
  hiddenLossRisk: HiddenLossRisk;
  hiddenUpsideBias: HiddenLossRisk;
};

export type WalletEliminationEntry = {
  walletAddress: string;
  name: string | null;
  trades: number;
  truncated: boolean;
  duneCoveragePercent: number | null;
  duneMissedTrades: number | null;
  gmgnPnl30dPercent: number | null;
  simulatedMedianReturnPercent: number | null;
  medianHoldSeconds: number | null;
  coverageGap: CoverageGapAssessment | null;
  trustworthy: boolean;
  eliminated: boolean;
  reasons: EliminationReason[];
};

export type DuneRefetchEstimate = {
  targetsNeeded: number;
  secondsPerTarget: number;
  estimatedSeconds: number;
  basis: 'measured' | 'seeded';
  runsCounted: number;
};

export type EliminationReport = {
  generatedAt: string;
  totalWallets: number;
  eliminated: WalletEliminationEntry[];
  surviving: WalletEliminationEntry[];
  survivorsNeedingDune: WalletEliminationEntry[];
  survivorsNeverSimulatedCount: number;
  measuredDuneTargetsRemaining: number;
  duneEstimate: DuneRefetchEstimate;
  periodDays?: number;
};

export type CopySimulationTradeResult = {
  tokenAddress: string;
  tokenSymbol: string | null;
  buyAt?: string;
  sellAt?: string;
  holdSeconds?: number;
  walletReturnPercent: number | null;
  simulatedReturnPercent: number | null;
  edgeKeptPercent?: number | null;
  status: 'simulated' | 'missing_entry_match' | 'missing_exit_match' | 'not_yet_queried';
  entryMatchedAt?: string | null;
  exitMatchedAt?: string | null;
  entryGapSeconds: number | null;
  exitGapSeconds: number | null;
  gasFeeSol: number | null;
  gasFeeUsd?: number | null;
  entryTradeAmountUsd: number | null;
  exitTradeAmountUsd: number | null;
};

export type FixedStakePortfolioReport = {
  startingCapitalUsd: number;
  stakePerTradeUsd: number;
  maxOpenPositions: number;
  endingCapitalUsd: number;
  realizedPnlUsd: number;
  markToMarketPnlUsd?: number;
  openPositionsMarked?: number;
  openPositionsUnpriced?: number;
  eligibleTrades: number;
  copiedTrades: number;
  skippedInsufficientCash: number;
  skippedMaxOpenPositions: number;
  maxConcurrentPositions: number;
  gasFeeSol: number;
  gasFeeUsd?: number;
  gasCostComplete?: boolean;
  capitalPath: Array<{ day: string; capitalUsd: number }>;
  tradeCapitalPath?: Array<{ trade: number; tradeId?: number; day: string; capitalUsd: number }>;
};

export type CopySimulationWalletReport = {
  walletAddress: string;
  roundTripsConsidered: number;
  copiedTrades: number;
  missedTrades: number;
  coverageRatePercent: number | null;
  coverageStatus:
    | 'fully_covered'
    | 'partially_covered'
    | 'missing_local_history'
    | 'no_dune_match'
    | 'small_sample';
  coverageStatusReason: string;
  localHistoryTruncated: boolean;
  localHistoryStopReason: string | null;
  walletMedianReturnPercent: number | null;
  simulatedMedianReturnPercent: number | null;
  walletMeanReturnPercent: number | null;
  simulatedMeanReturnPercent: number | null;
  tradesAbove100Percent: number;
  tradesAbove300Percent: number;
  bestSimulatedReturnPercent: number | null;
  tailShareOfMeanPercent: number | null;
  delayCostPercentagePoints: number | null;
  worstSimulatedReturnPercent: number | null;
  totalGasFeeSol: number | null;
  totalGasFeeUsd?: number | null;
  gasCostComplete?: boolean;
  portfolio?: FixedStakePortfolioReport;
  trades: CopySimulationTradeResult[];
  pendingDuneTargets?: number;
  duneNoMatchTargets?: number;
  duneMatchedTargets?: number;
};

export type CopySimulationReport = {
  computedAt: string;
  duneTargetsTotal?: number;
  pendingDuneTargets?: number;
  duneNoMatchTargets?: number;
  duneMatchedTargets?: number;
  assumptions: {
    copierDelaySeconds: number;
    feeBps: number;
    slippageBps: number;
    gasPriorityFeeSolPerTx: number;
    maxMatchGapSeconds: number;
    maxRoundTripsPerWallet: number | null;
    startingCapitalUsd: number;
    stakePerTradeUsd: number;
    maxOpenPositions: number;
  };
  wallets: CopySimulationWalletReport[];
};

export type LiquidityBandStats = {
  band: 'low' | 'medium' | 'high';
  minEntryTradeAmountUsd: number;
  maxEntryTradeAmountUsd: number;
  tradeCount: number;
  simulatedCount: number;
  missedCount: number;
  winRatePercent: number | null;
  medianSimulatedReturnPercent: number | null;
  medianWalletReturnPercent: number | null;
  medianDelayCostPercentagePoints: number | null;
  missedTradeRatePercent: number | null;
  reliable: boolean;
};

export type WalletLiquidityConcentration = { walletAddress: string; bands: LiquidityBandStats[] };

export type LiquidityImpactReport = {
  computedAt: string;
  dataSource: 'dune_matched_trade_amount_usd';
  measuredVsProxied: 'proxied';
  bandedOnField: 'entryTradeAmountUsd';
  minReliableSample: number;
  totalTradesConsidered: number;
  unbandableCount: number;
  bands: LiquidityBandStats[];
  byWallet: WalletLiquidityConcentration[];
};

export type OutcomeTimeline = {
  signal: OutcomeCandidate;
  checkpoints: Array<{
    label: string;
    targetTimestamp: string;
    result: {
      priceUsd: number | null;
      status: string;
      priceHttpStatus: number | null;
      archivePath: string | null;
    };
  }>;
};

export type SignalPatternGroup = {
  key: string;
  n: number;
  nWithData: number;
  nMissing: number;
  nStale: number;
  nFresh: number;
  nDistinctTokens: number;
  nCaptured: number;
  nMatured: number;
  coveragePct: number | null;
  captureDates: number;
  nRepeatedExcluded: number;
  maxBaselineTradeAgeSeconds: number | null;
  maxTargetTradeAgeSeconds: number | null;
  upCount: number;
  upPct: number | null;
  avgReturnPct: number | null;
  medianReturnPct: number | null;
  p25ReturnPct: number | null;
  worstReturnPct: number | null;
  bestReturnPct: number | null;
  verdict: 'insufficient data' | 'promising but fragile' | 'mixed' | 'weak';
  reliable: boolean;
};

export type SignalPatternHorizonReport = {
  horizon: string;
  overall: SignalPatternGroup;
  groups: SignalPatternGroup[];
};

export type SignalPatternReport = {
  computedAt: string;
  method: string;
  groupBy: string;
  upThreshold: number;
  minReliableSample: number;
  minCoveragePct: number;
  minCaptureDates: number;
  analysisUnit: string;
  tradeAgePolicy: string;
  disclaimer: string;
  staleNote: string;
  horizons: SignalPatternHorizonReport[];
  sourceRunIds: number[];
};

export type SignalPatternSnapshot = {
  id: number;
  computedAt: string;
  params: {
    groupBy: string;
    upThreshold: number;
    minReliableSample: number;
    minCoveragePct: number;
    minCaptureDates: number;
    analysisUnit: string;
  };
  sourceRunIds: number[];
  report: SignalPatternReport;
};

export type SubgroupProperty = 'launchPlatform' | 'tokenAge' | 'combined';

export type SignalPatternSubgroupHorizonReport = {
  horizon: string;
  cellCount: number;
  nUnextractable: number;
  groups: SignalPatternGroup[];
};

export type SignalPatternSubgroupReport = {
  computedAt: string;
  method: string;
  property: SubgroupProperty;
  minReliableSample: number;
  minCoveragePct: number;
  minCaptureDates: number;
  disclaimer: string;
  horizons: SignalPatternSubgroupHorizonReport[];
};

export type GmgnStatus = {
  configured: boolean;
  keyPath: string;
  publicKeyConfigured: boolean;
  keyBytes: number;
  message: string;
};

export type GmgnArchiveManifest = {
  capturedAt: string | null;
  eventCount: number | null;
  stored: number | null;
  repeated: number | null;
  validationErrors: number | null;
};

export type GmgnArchiveSummary = {
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

export type DiagnosticLog = {
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

export type DuneCoverageSummary = {
  matched: number;
  eligible: number;
  percent: number | null;
} | null;

export type CopyTradeSubTab =
  'data' | 'pattern-discovery' | 'api-reference' | 'experimental-decision' | 'live-evaluation';

export type DecisionColumnKey =
  | 'rank'
  | 'gmgn'
  | 'trader'
  | 'decision'
  | 'freshness'
  | 'gmgnPnl'
  | 'gmgnTrades'
  | 'copyMedian'
  | 'copyCapital'
  | 'evidence'
  | 'duneCoverage'
  | 'hold'
  | 'under15s'
  | 'gmgnTags';
