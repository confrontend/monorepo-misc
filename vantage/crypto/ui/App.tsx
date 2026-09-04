import { Fragment, useEffect, useRef, useState } from 'react';
import { api, formatTime } from './httpClient.js';
import { DataTable } from './components/DataTable.js';
import { Collapsible } from './components/Collapsible.js';
import { PanelHeading } from './components/PanelHeading.js';
import { AppHeader } from './components/AppHeader.js';
import { AppNavigation } from './components/AppNavigation.js';
import { OverviewSection } from './components/OverviewSection.js';
import { useSortState } from './components/useSortState.js';
import { CopyTradeSubTabContent } from './components/CopyTradeSubTabContent.js';
import {
  PatternDiscoveryRuleDialog,
  type PatternDiscoveryRule,
} from './components/PatternDiscoveryRuleDialog.js';
import { PatternDiscoveryPromotedPatterns } from './components/PatternDiscoveryPromotedPatterns.js';
import { PatternDiscoveryProgressPanel } from './components/PatternDiscoveryProgressPanel.js';
import { PatternDiscoveryRunSummary } from './components/PatternDiscoveryRunSummary.js';
import { PatternDiscoverySection } from './components/PatternDiscoverySection.js';
import { DataStatusSummary } from './components/data/DataStatusSummary.js';
import { UI_STRINGS } from './strings.js';
import { ArchivesRoute } from './routes/ArchivesRoute.js';
import { DiagnosticsRoute } from './routes/DiagnosticsRoute.js';
import { useAppRoute } from './app/useAppRoute.js';
import { useThemeMode } from './app/useThemeMode.js';
import {
  bestGroupHorizon,
  bestPatternHorizon,
  formatPercentChange,
  formatSignalType,
  percentChangeValue,
  shortWalletAddress,
  tokenDisplay,
} from './app/appFormatters.js';
import { CopyAddressButton, copyAddress, SaveRowButton, saveJson } from './app/appExports.js';
import type {
  Stats,
  ImportSummary,
  DataQuality,
  LastDuneImport,
  GmgnTokenAddressSummary,
  BrowserImportResult,
  RawEndpointSummary,
  RawEndpointType,
  RawEndpointRow,
  SnapshotAnalysis,
  SignalScoringReport,
  OutcomeCandidate,
  MeasurementPlan,
  DuneReconcileSummary,
  PatternDiscoveryExport,
  PatternDiscoveryReport,
  PatternDiscoveryExecution,
  PatternDiscoverySensitivity,
  PatternDiscoveryRunResponse,
  PatternDiscoveryStartResponse,
  PatternDiscoveryProgress,
  OutcomeTimeline,
  SignalPatternReport,
  SignalPatternSnapshot,
  SubgroupProperty,
  SignalPatternSubgroupReport,
  GmgnStatus,
  CopyTradeSubTab,
} from './types.js';

const PATTERN_DISCOVERY_COVERAGE_GRID = [50, 60, 70, 80, 90, 95, 100] as const;
const PATTERN_DISCOVERY_PERIODS = [30, 60, 90] as const;
// Must match src/dune/outcomes.ts's CHECKPOINT_OFFSETS. Kept as its own literal here rather than
// imported, matching this file's existing convention of duplicating small server-side constants
// rather than sharing a module between the server and browser bundles.
const CHECKPOINT_COLUMNS = ['+5m', '+15m', '+30m', '+1h', '+3h'] as const;
type OutcomeSortKey = 'signal' | 'type' | 'token' | (typeof CHECKPOINT_COLUMNS)[number];
const SUBGROUP_PROPERTY_LABELS: Record<SubgroupProperty, string> = {
  launchPlatform: 'Launch platform',
  tokenAge: 'Token age at signal',
  combined: 'All combined',
};
const SUBGROUP_PROPERTY_DESCRIPTIONS: Record<SubgroupProperty, string> = {
  launchPlatform: 'launch platform',
  tokenAge: 'token age',
  combined: 'launch platform × token age',
};

// Independent from the top-level report's own best-horizon pick (see bestPatternHorizon) —
// a subgroup breakdown can have a different "most interesting" horizon than the aggregate
// picture, since it's about surfacing a standout cell, not the overall median. Picks the
// horizon whose single best *reliable* cell has the highest median, tie-broken by how many
// cells are reliable at all (more statistical footing, not just one lucky cell).
const bestSubgroupHorizon = (report: SignalPatternSubgroupReport): string | null => {
  const scored = report.horizons.map((horizon) => {
    const reliable = horizon.groups.filter((group) => group.reliable);
    const bestMedian = reliable.length
      ? Math.max(...reliable.map((group) => group.medianReturnPct ?? -Infinity))
      : null;
    return { horizon: horizon.horizon, bestMedian, reliableCount: reliable.length };
  });
  const withReliable = scored.filter((entry) => entry.bestMedian !== null);
  return (
    [...withReliable].sort((left, right) => {
      const medianDelta = (right.bestMedian ?? -Infinity) - (left.bestMedian ?? -Infinity);
      if (medianDelta !== 0) return medianDelta;
      return right.reliableCount - left.reliableCount;
    })[0]?.horizon ?? null
  );
};
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
  '21': 'Banker Claim platform event.',
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
  cohortTokenCount: 0,
  signalCount: 0,
  matchedSignalCount: 0,
  unmatchedSignalCount: 0,
  tokensWithSignals: 0,
  tokensWithoutSignals: 0,
  coveragePercent: 0,
  missingTokenAddressSignals: 0,
  missingSignalTypeSignals: 0,
  missingObservedAtSignals: 0,
  signalsWithValidationIssues: 0,
};

// Selects on horizons that contain at least one reliable SIGNAL TYPE, not on the "overall"
// aggregate. The gates themselves are unchanged — a group still has to pass every one of them
// (nFresh, distinct tokens, coverage, capture dates). The aggregate was the wrong gate for a
// display picker: it pools all ~15 signal types together, so types with almost no usable data
// drag its coverage below the threshold even when an individual type is comfortably above it.
// Observed live: overall coverage sat at 24.69% against a 25% gate — 32 comparisons short —
// which blanked the entire Patterns view while signal type 13 was passing at 68% coverage
// (n=118) at all five horizons. Reliable evidence must not be hidden behind an aggregate that
// is strictly harder to satisfy than any group it contains.
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

export function App() {
  const { themeMode, toggleTheme } = useThemeMode();
  const { activeMenu, copyTradeSubTab, navigateTo, navigateCopyTradeSubTab } = useAppRoute();
  const [stats, setStats] = useState<Stats>(emptyStats);
  const [quality, setQuality] = useState<DataQuality>(emptyQuality);
  const [analysis, setAnalysis] = useState<SnapshotAnalysis | null>(null);
  const [scoring, setScoring] = useState<SignalScoringReport | null>(null);
  const [outcomeCandidates, setOutcomeCandidates] = useState<OutcomeCandidate[]>([]);
  const [measurementPlan, setMeasurementPlan] = useState<MeasurementPlan | null>(null);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [measurementPlanRefreshing, setMeasurementPlanRefreshing] = useState(false);
  const [outcomeTypeFilter, setOutcomeTypeFilter] = useState('all');
  // Nothing currently sets this to true (its former writer was removed with the Wallet Data
  // tab); kept read-only so the combined busy flag below keeps compiling if a caller returns.
  const [outcomeBusy] = useState(false);
  const [outcomeBatchBusy, setOutcomeBatchBusy] = useState(false);
  const [outcomeBatchProgress, setOutcomeBatchProgress] = useState<{
    completed: number;
    total: number;
    current: number;
    batches: number;
  } | null>(null);
  const stopOutcomeBatchRef = useRef(false);
  const [reconcileBusy, setReconcileBusy] = useState(false);
  const [outcomeTimelines, setOutcomeTimelines] = useState<OutcomeTimeline[]>([]);
  const [outcomePageSize, setOutcomePageSize] = useState<number | 'all'>(25);
  const [outcomePage, setOutcomePage] = useState(0);
  const {
    sort: outcomeSort,
    toggleSort: toggleOutcomeSort,
    sortIndicator,
  } = useSortState<OutcomeSortKey>('signal', 'asc');
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
  const [copyTradePeriodDays, setCopyTradePeriodDays] = useState(30);
  const [patternDiscoveryExport, setPatternDiscoveryExport] =
    useState<PatternDiscoveryExport | null>(null);
  const [, setPatternDiscoveryExportLoading] = useState(false);
  const [patternDiscoveryProgress, setPatternDiscoveryProgress] =
    useState<PatternDiscoveryProgress | null>(null);
  const [patternDiscoveryLoadingDetail, setPatternDiscoveryLoadingDetail] = useState(
    'Preparing the local SQLite read…',
  );
  const [patternDiscoveryReport, setPatternDiscoveryReport] =
    useState<PatternDiscoveryReport | null>(null);
  const [patternDiscoverySensitivity, setPatternDiscoverySensitivity] =
    useState<PatternDiscoverySensitivity | null>(null);
  const [patternDiscoveryFreshness, setPatternDiscoveryFreshness] =
    useState<PatternDiscoveryRunResponse['freshness']>(undefined);
  const [patternDiscoveryExecution, setPatternDiscoveryExecution] =
    useState<PatternDiscoveryExecution | null>(null);
  const [patternDiscoveryRunLoading, setPatternDiscoveryRunLoading] = useState(false);
  const [patternDiscoveryStartedAt, setPatternDiscoveryStartedAt] = useState<number | null>(null);
  const [patternDiscoveryElapsedSeconds, setPatternDiscoveryElapsedSeconds] = useState(0);
  const [patternDiscoveryRunError, setPatternDiscoveryRunError] = useState<string | null>(null);
  const [patternHistoryAvailable, setPatternHistoryAvailable] = useState(false);
  const [selectedPatternRule, setSelectedPatternRule] = useState<PatternDiscoveryRule | null>(null);
  const patternDiscoveryRunInFlight = useRef(false);
  const patternDiscoveryAbortController = useRef<AbortController | null>(null);
  const patternDiscoveryStopRequested = useRef(false);
  const lastLoadedPatternDiscoveryCompletionKey = useRef<string | null>(null);
  const [patternDiscoverySourceOpen, setPatternDiscoverySourceOpen] = useState(false);

  useEffect(() => {
    if (!patternDiscoveryStartedAt || !patternDiscoveryRunLoading) {
      setPatternDiscoveryElapsedSeconds(0);
      return;
    }
    const updateElapsed = () =>
      setPatternDiscoveryElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - patternDiscoveryStartedAt) / 1000)),
      );
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [patternDiscoveryStartedAt, patternDiscoveryRunLoading]);
  const [showScrollTop, setShowScrollTop] = useState(false);
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
  const [lastBrowserImport, setLastBrowserImport] = useState<{
    fileName: string;
    at: string;
    result: BrowserImportResult;
  } | null>(null);
  const [rawEndpointSummary, setRawEndpointSummary] = useState<RawEndpointSummary | null>(null);
  const [rawEndpointType, setRawEndpointType] = useState<RawEndpointType>('radar');
  const [rawEndpointRows, setRawEndpointRows] = useState<RawEndpointRow[]>([]);
  const [rawEndpointBusy, setRawEndpointBusy] = useState(false);
  const [rawEndpointOpen, setRawEndpointOpen] = useState(false);
  const [rawEndpointExpandedId, setRawEndpointExpandedId] = useState<number | null>(null);
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
      const [
        nextStats,
        nextImports,
        nextQuality,
        nextGmgn,
        nextAnalysis,
        nextScoring,
        nextCandidates,
        nextMeasurementPlan,
        latestOutcomes,
        nextPatternReport,
        nextPatternSnapshots,
      ] = await Promise.all([
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
    } finally {
      setRefreshBusy(false);
    }
  };

  const refreshPatternReport = async () => {
    const nextPatternReport = await api<SignalPatternReport>('/api/analysis/patterns');
    setPatternReport(nextPatternReport);
    setPatternHorizon(bestPatternHorizon(nextPatternReport));
  };

  const loadPatternDiscoveryExport = async (
    periodDays = copyTradePeriodDays,
    minimumCoveragePercent = 100,
  ): Promise<PatternDiscoveryExport | null> => {
    setPatternDiscoveryExportLoading(true);
    try {
      const nextExport = await api<PatternDiscoveryExport>(
        `/api/copytrade/pattern-discovery/export?periodDays=${periodDays}&minimumCoveragePercent=${minimumCoveragePercent}`,
      );
      setPatternDiscoveryExport(nextExport);
      return nextExport;
    } catch {
      setPatternDiscoveryExport(null);
      return null;
    } finally {
      setPatternDiscoveryExportLoading(false);
    }
  };

  const exportPatternDiscoveryPage = () => {
    if (!patternDiscoveryExport && !patternDiscoveryReport && !patternDiscoverySensitivity) return;
    saveJson(
      {
        format: 'vantage-pattern-discovery-page-export-v1',
        exportedAt: new Date().toISOString(),
        page: {
          periodDays: copyTradePeriodDays,
          coverageGrid: PATTERN_DISCOVERY_COVERAGE_GRID,
        },
        sourceData: patternDiscoveryExport,
        report: patternDiscoveryReport,
        sensitivity: patternDiscoverySensitivity,
        execution: patternDiscoveryExecution,
        progress: patternDiscoveryProgress,
      },
      `crypto-pattern-discovery-page-${copyTradePeriodDays}d-${new Date().toISOString().slice(0, 10)}.json`,
    );
  };

  const runPatternDiscovery = async () => {
    if (patternDiscoveryRunInFlight.current || patternDiscoveryRunLoading) return;
    patternDiscoveryRunInFlight.current = true;
    patternDiscoveryStopRequested.current = false;
    patternDiscoveryAbortController.current = new AbortController();
    setPatternDiscoveryStartedAt(Date.now());
    setPatternDiscoveryRunLoading(true);
    setPatternDiscoveryRunError(null);
    setPatternDiscoveryExport(null);
    try {
      if (patternDiscoveryStopRequested.current) return;
      const result = await api<PatternDiscoveryStartResponse>(
        '/api/copytrade/pattern-discovery/run/report',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            periodDays: copyTradePeriodDays,
            minN: 10,
          }),
          signal: patternDiscoveryAbortController.current.signal,
        },
      );
      setPatternDiscoveryProgress(result.progress);
      setPatternDiscoveryLoadingDetail(result.progress.message);
      if (['complete', 'stopped', 'error'].includes(result.progress.status)) {
        const completionKey = `${result.progress.status}:${result.progress.runId ?? 'legacy'}:${result.progress.completedAt ?? result.progress.heartbeatAt ?? 'unknown'}`;
        if (result.progress.status === 'complete' || result.progress.status === 'stopped') {
          await loadCompletedPatternDiscovery();
          lastLoadedPatternDiscoveryCompletionKey.current = completionKey;
        } else {
          setPatternDiscoveryRunError(result.progress.message);
        }
        patternDiscoveryRunInFlight.current = false;
        setPatternDiscoveryRunLoading(false);
        setPatternDiscoveryStartedAt(null);
        patternDiscoveryAbortController.current = null;
      }
    } catch (error: unknown) {
      if (!patternDiscoveryStopRequested.current)
        setPatternDiscoveryRunError(error instanceof Error ? error.message : String(error));
      patternDiscoveryRunInFlight.current = false;
      setPatternDiscoveryRunLoading(false);
      setPatternDiscoveryStartedAt(null);
      patternDiscoveryAbortController.current = null;
    }
  };

  const loadCompletedPatternDiscovery = async (): Promise<void> => {
    const result = await api<PatternDiscoveryRunResponse>(
      `/api/copytrade/pattern-discovery/run/result?periodDays=${copyTradePeriodDays}&minN=10`,
    );
    setPatternDiscoveryReport(result.report ?? null);
    setPatternDiscoveryExecution(result.execution ?? null);
    setPatternDiscoverySensitivity(result.sensitivity ?? null);
    setPatternDiscoveryFreshness(result.freshness);
  };

  const stopPatternDiscovery = async () => {
    const serverRunActive =
      patternDiscoveryProgress?.status === 'preparing' ||
      patternDiscoveryProgress?.status === 'running';
    if (!patternDiscoveryRunLoading && !serverRunActive) return;
    patternDiscoveryStopRequested.current = true;
    setPatternDiscoveryRunError('Stopping discovery… completed coverage levels remain saved.');
    try {
      await api('/api/copytrade/pattern-discovery/stop', { method: 'POST' });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/No Pattern Discovery run is active/i.test(message)) {
        setPatternDiscoveryRunError(message);
      }
    } finally {
      // The server owns cancellation. Abort only the browser's waiting request after the stop
      // command has been delivered, so a refresh cannot accidentally cancel the server job.
      patternDiscoveryAbortController.current?.abort();
      patternDiscoveryRunInFlight.current = false;
      setPatternDiscoveryRunLoading(false);
      setPatternDiscoveryStartedAt(null);
      patternDiscoveryAbortController.current = null;
    }
  };

  const loadSubgroupReport = async (property: SubgroupProperty) => {
    setSubgroupBusy(true);
    try {
      const next = await api<SignalPatternSubgroupReport>(
        `/api/analysis/patterns/subgroups?property=${property}`,
      );
      setSubgroupReport(next);
      // Recomputed on every fetch, independent of the top-level report's own horizon pick —
      // different properties (or "combined") can each have their own best horizon.
      setSubgroupHorizon(bestSubgroupHorizon(next));
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSubgroupBusy(false);
    }
  };

  const refreshMeasurementPlan = async () => {
    setMeasurementPlanRefreshing(true);
    try {
      const nextPlan = await api<MeasurementPlan>('/api/dune/measurement-plan');
      setMeasurementPlan(nextPlan);
      return nextPlan;
    } finally {
      setMeasurementPlanRefreshing(false);
    }
  };

  const saveCurrentPatternSnapshot = async () => {
    setSavingSnapshot(true);
    try {
      await api<SignalPatternSnapshot>('/api/analysis/patterns/snapshot', { method: 'POST' });
      setPatternSnapshots(await api<SignalPatternSnapshot[]>('/api/analysis/patterns/snapshots'));
      setMessage('Pattern snapshot saved.');
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingSnapshot(false);
    }
  };

  const displayedPatternReport =
    viewingSnapshotId === null
      ? patternReport
      : (patternSnapshots.find((snapshot) => snapshot.id === viewingSnapshotId)?.report ?? null);
  const displayedPatternHorizon =
    displayedPatternReport?.horizons.find((horizon) => horizon.horizon === patternHorizon) ?? null;
  const displayedSubgroupHorizon =
    subgroupReport?.horizons.find((horizon) => horizon.horizon === subgroupHorizon) ?? null;
  // The coordinator is the source of truth for whether discovery is running. The local loading
  // flag can briefly be false during a refresh or after the 202 Accepted response, which used to
  // hide the live progress panel while the worker was still active.
  const patternDiscoveryServerActive =
    patternDiscoveryProgress?.status === 'preparing' ||
    patternDiscoveryProgress?.status === 'running';
  const patternDiscoveryIsActive = patternDiscoveryRunLoading || patternDiscoveryServerActive;
  const prescreenCounts = measurementPlan?.prescreen.byDisposition;
  const prescreenTotal = prescreenCounts
    ? Object.values(prescreenCounts).reduce((sum, value) => sum + value, 0)
    : 0;
  const prescreenPercent = (value: number): string =>
    prescreenTotal === 0 ? '0%' : `${((100 * value) / prescreenTotal).toFixed(1)}%`;
  const patternVerdict = (() => {
    if (!displayedPatternHorizon) return null;
    const reliableGroups = displayedPatternHorizon.groups.filter((group) => group.reliable);
    const positive = reliableGroups
      .filter((group) => (group.medianReturnPct ?? 0) > 0)
      .sort((a, b) => (b.medianReturnPct ?? 0) - (a.medianReturnPct ?? 0));
    const negative = reliableGroups.filter((group) => (group.medianReturnPct ?? 0) <= 0);
    if (!reliableGroups.length)
      return `At ${displayedPatternHorizon.horizon}, no signal type yet has enough genuine (non-stale) comparisons to call a pattern either way.`;
    if (!positive.length)
      return `At ${displayedPatternHorizon.horizon}, every signal type with enough data has a negative or flat median return — none stands out as positive.`;
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
      else
        setMessage(
          `Reconciled ${summary.checked} stuck run${summary.checked === 1 ? '' : 's'}: ${summary.completed} completed, ${summary.failed} failed, ${summary.stillRunning} still running${summary.noApiKey ? ' (stopped early: no Dune API key configured)' : ''}.`,
        );
      return summary;
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setReconcileBusy(false);
    }
  };

  const measureAllOutcomes = async (reason: 'new' | 'retry' | 'all' = 'all') => {
    if (outcomeBatchBusy) return;
    const filteredCandidates =
      outcomeTypeFilter === 'all'
        ? outcomeCandidates
        : outcomeCandidates.filter((candidate) => candidate.signalType === outcomeTypeFilter);
    // Reconcile first so signals from previously stuck runs that have since actually finished
    // on Dune's side are eligible again before we decide what to measure this run.
    await reconcileStuckRuns();
    const currentPlan = await refreshMeasurementPlan();
    const eligibleIds = new Set(
      reason === 'new'
        ? currentPlan.eligibleNewSignalIds
        : reason === 'retry'
          ? currentPlan.retryQueueSignalIds
          : currentPlan.eligibleSignalIds,
    );
    const ids = filteredCandidates
      .map((candidate) => candidate.id)
      .filter((id) => eligibleIds.has(id));
    if (!ids.length) {
      setMessage(
        reason === 'retry'
          ? 'No matured outcomes are ready for re-fetch in this pass. Fresh checkpoints remain protected until their target time and retry delay have elapsed.'
          : reason === 'new'
            ? 'No never-measured signals are ready in this pass. New signals may still be waiting for a safe pre-screen slot.'
            : 'No signals are currently eligible for measurement. Pending, unavailable, and already usable checkpoints are protected from unnecessary Dune requests.',
      );
      return;
    }
    const batchSize = 25;
    const batches = Array.from({ length: Math.ceil(ids.length / batchSize) }, (_, index) =>
      ids.slice(index * batchSize, (index + 1) * batchSize),
    );
    setOutcomeBatchBusy(true);
    stopOutcomeBatchRef.current = false;
    setOutcomeBatchProgress({
      completed: 0,
      total: ids.length,
      current: 0,
      batches: batches.length,
    });
    const merged = new Map<number, OutcomeTimeline>();
    const failedBatches: string[] = [];
    try {
      for (let index = 0; index < batches.length; index += 1) {
        if (stopOutcomeBatchRef.current) break;
        // Caught per-batch (not around the whole loop): one batch timing out or erroring must
        // not abort every batch after it — it's recorded and the run moves on to the next one.
        try {
          const result = await api<OutcomeTimeline[]>('/api/dune/outcomes', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ signalIds: batches[index] }),
          });
          for (const timeline of result) merged.set(timeline.signal.id, timeline);
          setOutcomeTimelines((current) => {
            const next = new Map(current.map((timeline) => [timeline.signal.id, timeline]));
            for (const timeline of result) next.set(timeline.signal.id, timeline);
            return [...next.values()];
          });
          setMessage(
            `Measured batch ${index + 1} of ${batches.length} (${batches[index].length} signals archived).`,
          );
        } catch (error: unknown) {
          const reason = error instanceof Error ? error.message : String(error);
          failedBatches.push(`batch ${index + 1} (${reason})`);
          setMessage(
            `Batch ${index + 1} of ${batches.length} failed: ${reason} — continuing with the remaining batches.`,
          );
        }
        const completed = Math.min((index + 1) * batchSize, ids.length);
        setOutcomeBatchProgress({
          completed,
          total: ids.length,
          current: index + 1,
          batches: batches.length,
        });
        await Promise.all([
          refreshPatternReport().catch(() => {}),
          refreshMeasurementPlan().catch(() => {}),
        ]);
        if (index + 1 < batches.length) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      setOutcomeTimelines([...merged.values()]);
      if (failedBatches.length)
        setMessage(
          `Measured ${merged.size} of ${ids.length} signals across ${batches.length} batches; ${failedBatches.length} batch${failedBatches.length === 1 ? '' : 'es'} failed and ${failedBatches.length === 1 ? 'was' : 'were'} skipped: ${failedBatches.join('; ')}. Completed batches remain saved — a stuck batch will be picked up automatically by reconciliation on the next run.`,
        );
      else
        setMessage(
          `${reason === 'retry' ? 'Re-fetched' : reason === 'new' ? 'Measured new' : 'Measured'} ${ids.length} signals in ${batches.length} archived Dune batches. Existing complete measurements were skipped.`,
        );
      if (stopOutcomeBatchRef.current)
        setMessage(
          `Stopped after ${merged.size} of ${ids.length} signals. Completed batches remain saved; the remaining ${Math.max(0, ids.length - merged.size)} signals can be run later.`,
        );
    } finally {
      stopOutcomeBatchRef.current = false;
      setOutcomeBatchBusy(false);
    }
  };

  const stopOutcomeBatch = () => {
    if (!outcomeBatchBusy) return;
    stopOutcomeBatchRef.current = true;
    setMessage(
      'Stop requested. The current Dune batch will finish, then no further batches will be submitted.',
    );
  };

  useEffect(() => {
    const updateScrollTopVisibility = () => setShowScrollTop(window.scrollY > 500);
    updateScrollTopVisibility();
    window.addEventListener('scroll', updateScrollTopVisibility, { passive: true });
    return () => window.removeEventListener('scroll', updateScrollTopVisibility);
  }, []);
  useEffect(() => {
    if (copyTradeSubTab !== 'pattern-discovery') return;
    let disposed = false;
    let timer: number | undefined;
    let requestInFlight = false;

    const poll = async () => {
      if (disposed || requestInFlight) return;
      requestInFlight = true;
      try {
        const progress = await api<PatternDiscoveryProgress>(
          '/api/copytrade/pattern-discovery/status',
        );
        if (disposed) return;
        setPatternDiscoveryProgress(progress);
        setPatternDiscoveryLoadingDetail(progress.message);

        const active = progress.status === 'preparing' || progress.status === 'running';
        if (active) {
          // Reconnect the UI to a run that survived a browser refresh.
          if (!patternDiscoveryRunInFlight.current) {
            setPatternDiscoveryRunLoading(true);
            if (progress.startedAt) setPatternDiscoveryStartedAt(Date.parse(progress.startedAt));
          }
        } else {
          // A server restart can leave a run as `stopped` after saving several coverage levels.
          // Those saved results are still useful and the result endpoint can return them (with a
          // stale marker when the current evidence fingerprint differs). Load every terminal
          // result state once, not only the ideal `complete` state.
          const savedResultKey = ['idle', 'complete', 'stopped', 'cancelled'].includes(
            progress.status,
          )
            ? `${progress.status}:${progress.runId ?? 'legacy'}:${progress.completedAt ?? progress.heartbeatAt ?? 'unknown'}`
            : null;
          if (
            savedResultKey &&
            savedResultKey !== lastLoadedPatternDiscoveryCompletionKey.current
          ) {
            try {
              // The completed sensitivity result already contains the grid summaries and is
              // cheap to load from SQLite. The 100% normalized export is only needed when the
              // user explicitly downloads/opens source data, so do not reload it on every run
              // completion or page refresh.
              setPatternDiscoveryLoadingDetail(
                'Discovery finished. Loading the saved grid result…',
              );
              await loadCompletedPatternDiscovery();
              lastLoadedPatternDiscoveryCompletionKey.current = savedResultKey;
            } catch (error: unknown) {
              if (!disposed && progress.status === 'complete')
                setPatternDiscoveryRunError(error instanceof Error ? error.message : String(error));
            }
          } else if (progress.status === 'error') {
            setPatternDiscoveryRunError(progress.message);
          }
          patternDiscoveryRunInFlight.current = false;
          setPatternDiscoveryRunLoading(false);
          setPatternDiscoveryStartedAt(null);
          patternDiscoveryAbortController.current = null;
        }
        // The coordinator emits a heartbeat every two seconds. Polling faster than that only
        // creates a request queue in the browser without providing fresher information.
        if (!disposed) timer = window.setTimeout(() => void poll(), active ? 2000 : 5000);
      } catch {
        // Retry while this tab is open; the run endpoint reports actionable failures.
        if (!disposed) timer = window.setTimeout(() => void poll(), 3000);
      } finally {
        requestInFlight = false;
      }
    };

    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [api, copyTradePeriodDays, copyTradeSubTab]);
  useEffect(() => {
    if (activeMenu === 'copytrade') return;
    void refresh().catch((error: unknown) => setMessage(String(error)));
  }, [activeMenu]);
  useEffect(() => {
    const intro = document.querySelector<HTMLElement>(
      '.signal-outcome-batch-panel .outcome-inner > p',
    );
    if (intro)
      intro.textContent =
        'Select one or more captured signals. The Dune SQL query uses supported time arithmetic for the signal time and its configured historical checkpoints. A checkpoint whose window has not yet elapsed shows as pending; a token with no matching trade remains unavailable.';
    const candidateById = new Map(outcomeCandidates.map((candidate) => [candidate.id, candidate]));
    document
      .querySelectorAll<HTMLElement>('.signal-outcome-batch-panel .candidate-row')
      .forEach((row) => {
        const id = Number(row.querySelector('b')?.textContent?.match(/#(\d+)/)?.[1]);
        const candidate = candidateById.get(id);
        const address = row.querySelector<HTMLElement>('small[title]');
        if (candidate && address) {
          address.textContent = '';
          address.append(
            document.createTextNode(tokenDisplay(candidate.symbol, candidate.tokenAddress)),
          );
          const copy = document.createElement('button');
          copy.type = 'button';
          copy.className = 'copy-address';
          copy.ariaLabel = `Copy address ${candidate.tokenAddress}`;
          copy.textContent = '⧉';
          copy.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            void copyAddress(candidate.tokenAddress);
          };
          address.append(copy);
        }
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
      setMessage(
        `Imported ${result.imported}; skipped ${result.skipped}; errors ${result.errors}. Archive: ${result.archivePath ?? 'already archived'}`,
      );
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
        setMessage(
          'No GMGN-observed token addresses are missing from the cohort right now — nothing to export.',
        );
        return;
      }
      const blob = new Blob([summary.addresses.join('\n')], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `gmgn-token-addresses-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage(
        `Exported ${summary.addresses.length} address(es) not yet in the Dune cohort (of ${summary.total} GMGN-observed addresses total, ${summary.matchedToCohort} already matched). Look these up in Dune, then upload the result below.`,
      );
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
        setMessage(
          'No GMGN-observed token addresses are missing from the cohort right now — nothing to query.',
        );
        setDuneQuery('');
        return;
      }
      setDuneQuery(buildSimpleDuneEnrichmentQuery(summary.addresses));
      setMessage(
        `Generated a Dune query for ${summary.addresses.length} address(es). Copy it below, run it in Dune, then upload the result.`,
      );
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
      setMessage(
        'Could not copy automatically — select the query text below and copy it manually.',
      );
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
      setMessage(
        `Enrichment imported ${result.imported}; skipped ${result.skipped}; errors ${result.errors}. Addresses already in the cohort were left untouched.`,
      );
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
      setMessage(
        `${result.duplicateFile ? 'Browser capture already imported' : 'Browser capture imported'}: +${result.imported} signals · ${result.skipped} repeats · ${result.errors} issues. Raw upload archived.`,
      );
      if (rawEndpointOpen) await loadRawEndpointSummary();
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBrowserImportBusy(false);
    }
  };

  const importBrowserCaptures = async (files: File[]) => {
    if (files.length <= 1) {
      if (files[0]) await importBrowserCapture(files[0]);
      return;
    }
    setMessage(
      `Importing ${files.length} browser captures one by one; each raw upload will be archived separately.`,
    );
    for (const file of files) await importBrowserCapture(file);
    setMessage(
      `Finished importing ${files.length} browser capture files. Each file was processed and archived independently.`,
    );
  };

  const loadRawEndpointSummary = async () => {
    try {
      setRawEndpointSummary(await api<RawEndpointSummary>('/api/gmgn/raw-endpoints/summary'));
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  // Lazy-fetched — this section is collapsed by default, same reasoning as the Patterns
  // subgroup breakdown: costs nothing when unused, only queried once a user actually opens it.
  const loadRawEndpointDetails = async (type: RawEndpointType) => {
    setRawEndpointBusy(true);
    setRawEndpointExpandedId(null);
    try {
      setRawEndpointRows(await api<RawEndpointRow[]>(`/api/gmgn/raw-endpoints/${type}?limit=50`));
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRawEndpointBusy(false);
    }
  };

  const openRawEndpointSection = async () => {
    const opening = !rawEndpointOpen;
    setRawEndpointOpen(opening);
    if (opening && !rawEndpointSummary) await loadRawEndpointSummary();
    if (opening && rawEndpointRows.length === 0) await loadRawEndpointDetails(rawEndpointType);
  };


  const outcomeColumns: Array<{ key: OutcomeSortKey; label: string }> = [
    { key: 'signal', label: 'Signal' },
    { key: 'type', label: 'Type' },
    ...CHECKPOINT_COLUMNS.map((label) => ({ key: label, label: `${label} change` })),
    { key: 'token', label: 'Token' },
  ];
  const filteredOutcomeCandidates =
    outcomeTypeFilter === 'all'
      ? outcomeCandidates
      : outcomeCandidates.filter((candidate) => candidate.signalType === outcomeTypeFilter);
  const outcomeTypeOptions = [
    ...new Set(
      outcomeCandidates
        .map((candidate) => candidate.signalType)
        .filter((value): value is string => Boolean(value)),
    ),
  ].sort((a, b) => Number(a) - Number(b));
  const selectedTypePrescreen =
    outcomeTypeFilter === 'all'
      ? null
      : measurementPlan?.prescreen.bySignalType.find(
          (item) => item.signalType === outcomeTypeFilter,
        );
  const selectedNewCount =
    selectedTypePrescreen?.newSelected ?? measurementPlan?.prescreen.selectedNewCount ?? 0;
  const selectedRetryCount =
    outcomeTypeFilter === 'all'
      ? (measurementPlan?.retryQueueSignalIds.length ?? 0)
      : (measurementPlan?.retryQueueSignalIds.filter((id) =>
          outcomeCandidates.some(
            (candidate) => candidate.id === id && candidate.signalType === outcomeTypeFilter,
          ),
        ).length ?? 0);
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
          const item = measurementPlan.bySignalType.find(
            (entry) => entry.signalType === outcomeTypeFilter,
          );
          // newReady must exclude too-fresh rows explicitly here: item.unmeasured bundles
          // not_measured and too_fresh together (see planner.ts's stateFor/typeStates), unlike
          // the all-types branch above which reads byState.not_measured directly (already
          // too_fresh-free). Without this subtraction, selecting a specific signal type would
          // wrongly count signals still inside the 24h observation buffer as "ready".
          return item
            ? {
                ...item,
                newEligible: selectedNewCount,
                retryEligibleSelected: selectedRetryCount,
                newReady: item.unmeasured - item.tooFresh,
                retryReady: selectedRetryCount,
              }
            : {
                captured: 0,
                measured: 0,
                unmeasured: 0,
                eligible: 0,
                newEligible: 0,
                retryEligibleSelected: 0,
                newReady: 0,
                retryReady: 0,
                pending: 0,
                complete: 0,
                retryEligible: 0,
                inFlight: 0,
                tooFresh: 0,
                neverMaturelyAttempted: 0,
                waitingOnRetryBuffer: 0,
              };
        })()
    : null;
  const selectedWaitingCount = selectedMeasurementProgress
    ? selectedMeasurementProgress.pending +
      selectedMeasurementProgress.tooFresh +
      selectedMeasurementProgress.waitingOnRetryBuffer
    : 0;
  const selectedUpToDate =
    Boolean(selectedMeasurementProgress) &&
    selectedMeasurementProgress!.newEligible === 0 &&
    selectedMeasurementProgress!.retryEligibleSelected === 0 &&
    selectedWaitingCount === 0 &&
    selectedMeasurementProgress!.inFlight === 0;
  // A checkpoint whose window had not elapsed when it was measured renders as "pending",
  // distinct from a normal missing value — it is not automatically backfilled; re-measuring
  // the signal later is what will produce a real number.
  const renderCheckpointCell = (timeline: OutcomeTimeline, base: number | null, label: string) => {
    const checkpoint = timeline.checkpoints.find((c) => c.label === label);
    if (checkpoint?.result.status === 'checkpoint not yet reached') {
      return (
        <td
          key={label}
          className="change-pending"
          title="Not yet elapsed when measured — re-measure this signal later for a real value."
        >
          pending
        </td>
      );
    }
    const value = checkpoint?.result.priceUsd ?? null;
    return (
      <td
        key={label}
        className={
          value === null || base === null
            ? ''
            : value >= base
              ? 'change-positive'
              : 'change-negative'
        }
      >
        <strong>{formatPercentChange(base, value)}</strong>
      </td>
    );
  };
  const visibleOutcomeTimelines =
    outcomePageSize === 'all'
      ? outcomeTimelines
      : outcomeTimelines.slice(outcomePage * outcomePageSize, (outcomePage + 1) * outcomePageSize);
  const outcomePageCount =
    outcomePageSize === 'all'
      ? 1
      : Math.max(1, Math.ceil(outcomeTimelines.length / outcomePageSize));
  // Sort keys/headers are matched declaratively via each <th>'s own onClick below — not by
  // DOM position — so inserting or reordering checkpoint columns can never attach a click
  // handler to the wrong header (the DOM-position-matching version of this was fragile in
  // exactly that way).
  useEffect(() => {
    if (outcomeTimelines.length === 0) return;
    setOutcomeTimelines((current) =>
      [...current].sort((left, right) => {
        const checkpointValue = (timeline: OutcomeTimeline, label: string) =>
          timeline.checkpoints.find((checkpoint) => checkpoint.label === label)?.result.priceUsd ??
          null;
        const leftBase = checkpointValue(left, 'signal');
        const rightBase = checkpointValue(right, 'signal');
        const metric = (timeline: OutcomeTimeline, base: number | null): string | number | null =>
          outcomeSort.key === 'signal'
            ? timeline.signal.id
            : outcomeSort.key === 'type'
              ? (timeline.signal.signalType ?? '')
              : outcomeSort.key === 'token'
                ? (timeline.signal.symbol ?? timeline.signal.tokenAddress)
                : percentChangeValue(base, checkpointValue(timeline, outcomeSort.key));
        const leftValue = metric(left, leftBase);
        const rightValue = metric(right, rightBase);
        const comparison =
          leftValue === null && rightValue === null
            ? 0
            : leftValue === null
              ? 1
              : rightValue === null
                ? -1
                : typeof leftValue === 'number' && typeof rightValue === 'number'
                  ? leftValue - rightValue
                  : String(leftValue).localeCompare(String(rightValue));
        return (outcomeSort.direction === 'asc' ? 1 : -1) * comparison;
      }),
    );
  }, [outcomeSort]);

  const duneActivity =
    refreshBusy || measurementPlanRefreshing || outcomeBatchBusy || reconcileBusy || outcomeBusy;
  const duneActivityLabel = outcomeBatchBusy
    ? 'Dune measurement batches are running'
    : reconcileBusy
      ? 'Checking Dune runs for completion'
      : measurementPlanRefreshing
        ? 'Refreshing the Dune measurement plan'
        : refreshBusy
          ? 'Loading saved Dune evidence'
          : 'Dune Capture is idle';
  const signalRoutes = new Set(['imports', 'capture', 'dune-capture', 'patterns']);
  const signalMenuActive = signalRoutes.has(activeMenu);
  return (
    <main className={`shell routed-view page-${activeMenu}`}>
      <AppHeader
        themeMode={themeMode}
        onToggleTheme={toggleTheme}
      />

      <AppNavigation
        copyTradeSubTab={copyTradeSubTab}
        activeMenu={activeMenu}
        signalMenuActive={signalMenuActive}
        onCopyTradeTabChange={navigateCopyTradeSubTab}
        onMenuChange={navigateTo}
      />

      <section id="copytrade" className="menu-section panel copytrade-panel">
        <CopyTradeSubTabContent
          activeTab={copyTradeSubTab}
          api={api}
          periodDays={copyTradePeriodDays as 30 | 60 | 90}
          onPeriodDaysChange={(periodDays) => setCopyTradePeriodDays(periodDays)}
        />
      </section>
      {false && copyTradeSubTab === 'pattern-discovery' && (
        <section
          id="copytrade-pattern-discovery"
          className="menu-section panel copytrade-research-route pattern-discovery-panel"
        >
          <PanelHeading
            eyebrow="GMGN COPYTRADE · SHARED ENGINE EXPORT"
            title="Pattern Discovery"
            tag="POINT-IN-TIME FEATURES"
          />
          <DataStatusSummary
            api={api}
            targetDays={copyTradePeriodDays}
            onGoToData={() => navigateCopyTradeSubTab('data')}
            onAvailabilityChange={setPatternHistoryAvailable}
          />
          <div className="copytrade-coverage-controls">
            <label>
              Selected period (days)
              <select
                value={copyTradePeriodDays}
                onChange={(event) => setCopyTradePeriodDays(Number(event.target.value))}
              >
                {PATTERN_DISCOVERY_PERIODS.map((period) => (
                  <option key={period} value={period}>
                    {period} days
                  </option>
                ))}
              </select>
            </label>
            <span className="pattern-discovery-threshold-summary">
              <strong>Coverage levels</strong>
              <small>
                {PATTERN_DISCOVERY_COVERAGE_GRID.map((value) => `${value}%`).join(' · ')}
              </small>
            </span>
            <button
              type="button"
              className="secondary"
              disabled={
                patternDiscoveryIsActive ||
                (!patternDiscoveryExport && !patternDiscoveryReport && !patternDiscoverySensitivity)
              }
              onClick={exportPatternDiscoveryPage}
            >
              {UI_STRINGS.patternDiscovery.exportPageData}
            </button>
            {patternDiscoveryIsActive ? (
              <button
                type="button"
                className="secondary pattern-discovery-stop"
                onClick={() => void stopPatternDiscovery()}
              >
                Stop discovery
              </button>
            ) : (
              <button
                type="button"
                className="primary"
                onClick={() => void runPatternDiscovery()}
                disabled={!patternHistoryAvailable}
                title={
                  patternHistoryAvailable
                    ? undefined
                    : UI_STRINGS.patternDiscovery.historyUnavailable(copyTradePeriodDays)
                }
              >
                Run discovery
              </button>
            )}
          </div>
          <Collapsible className="pattern-discovery-advanced" summary="Advanced">
            <p className="muted">
              One run evaluates the full 50–100% coverage grid using the same point-in-time
              features, wallet-balanced validation, and leakage protections.
            </p>
            <p className="muted">
              Only the event-time <code>features</code> object is eligible. Return, hold duration,
              delay, fee, outcome, and post-event matching fields are rejected as leakage.
            </p>
          </Collapsible>
          {patternDiscoveryIsActive && (
            <PatternDiscoveryProgressPanel
              progress={patternDiscoveryProgress}
              elapsedSeconds={patternDiscoveryElapsedSeconds}
              fallbackMessage={patternDiscoveryLoadingDetail}
              periodDays={copyTradePeriodDays}
            />
          )}
          {patternDiscoveryExport && !patternDiscoveryIsActive && (
            <>
              <div className="copytrade-table-overview">
                <span>
                  <strong>{patternDiscoveryExport.metadata.selected_wallet_count}</strong> wallets
                  in the 100% coverage level
                </span>
                <span>
                  <strong>{patternDiscoveryExport.metadata.exported_rows}</strong> normalized events
                </span>
                <span>
                  <strong>
                    {patternDiscoveryExport.metadata.eligible_wallets_before_threshold -
                      patternDiscoveryExport.metadata.selected_wallet_count}
                  </strong>{' '}
                  below the 100% coverage level
                </span>
              </div>
              <Collapsible
                className="copytrade-info-panel pattern-discovery-source-data"
                open={patternDiscoverySourceOpen}
                onToggle={setPatternDiscoverySourceOpen}
                summary={`100% coverage-level source data · ${patternDiscoveryExport.metadata.exported_rows} events`}
              >
                <DataTable
                  enableColumnHiding
                  columnVisibilityStorageKey="vantage-pattern-discovery-source-columns"
                  wrapClassName="table-wrap copytrade-table-wrap"
                  tableClassName="copytrade-table fully-covered-table"
                  rows={patternDiscoveryExport.rows.slice(0, 100)}
                  getRowKey={(row) => row.event_id}
                  emptyMessage="No wallets currently meet the selected outcome-coverage threshold for this period."
                  columns={[
                    {
                      key: 'wallet',
                      header: 'Wallet',
                      render: (row) => (
                        <>
                          <a
                            className="copytrade-gmgn-link"
                            href={`https://gmgn.ai/sol/address/${row.wallet_address}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {shortWalletAddress(row.wallet_address)} ↗
                          </a>
                          <CopyAddressButton address={row.wallet_address} />
                        </>
                      ),
                    },
                    {
                      key: 'eventTime',
                      header: 'Event time',
                      render: (row) => formatTime(row.event_time),
                    },
                    {
                      key: 'token',
                      header: 'Token',
                      cellProps: (row) => ({ title: row.token_address }),
                      render: (row) => row.entity_id,
                    },
                    {
                      key: 'copyOutcome',
                      header: 'Copy outcome',
                      cellProps: (row) => ({
                        className: row.net_return_after_costs >= 0 ? 'positive' : 'negative',
                      }),
                      render: (row) => `${row.net_return_after_costs.toFixed(2)}%`,
                    },
                    {
                      key: 'coverage',
                      header: 'Coverage',
                      render: (row) => `${row.coverage_rate_percent}%`,
                    },
                  ]}
                />
                <p className="muted">{patternDiscoveryExport.metadata.coverage_semantics}</p>
              </Collapsible>
              <Collapsible
                className="copytrade-info-panel"
                summary="Configured shared-engine fallback"
              >
                <p>
                  The browser view only exports JSON. From the Vantage workspace, run the JSON-only
                  adapter and then the isolated Python report command:
                </p>
                <pre className="pattern-discovery-command">
                  python -m shared_pattern_discovery.exporters.gmgn --project crypto --input
                  &lt;downloaded-export.json&gt; --output runs/crypto/gmgn-pattern-discovery.json
                  {`\n`}python -m shared_pattern_discovery.cli --project crypto --input
                  runs/crypto/gmgn-pattern-discovery.json --output
                  runs/crypto/pattern-discovery-report.json --min-n 10
                </pre>
                <p className="muted">
                  The shared engine reads this normalized JSON only; it never opens the crypto
                  SQLite database.
                </p>
              </Collapsible>
            </>
          )}
          {!patternDiscoveryIsActive && patternDiscoveryExport?.metadata.exported_rows === 0 && (
            <p className="muted">No wallets meet the 100% coverage level for this period.</p>
          )}
          {patternDiscoveryExport &&
            !patternDiscoveryReport &&
            !patternDiscoveryIsActive &&
            !patternDiscoveryRunError && (
              <p className="muted">
                Normalized export loaded. The shared Python engine has not run yet; click “Run
                shared discovery” to generate the report.
              </p>
            )}
          {patternDiscoveryRunError && <p className="error-text">{patternDiscoveryRunError}</p>}
          {(patternDiscoveryReport || patternDiscoverySensitivity) && !patternDiscoveryIsActive && (
            <div className="copytrade-info-panel pattern-discovery-readable">
              {patternDiscoveryFreshness?.state === 'stale' ? (
                <div className="copytrade-outcome-coverage-warning" role="status">
                  <strong>
                    {UI_STRINGS.patternDiscovery.staleResult(
                      patternDiscoveryFreshness.cachedAt
                        ? new Date(patternDiscoveryFreshness.cachedAt).toLocaleString()
                        : 'an earlier run',
                    )}
                  </strong>{' '}
                  {UI_STRINGS.patternDiscovery.staleResultSafety}
                </div>
              ) : (
                <p className="muted">{UI_STRINGS.patternDiscovery.currentResult}</p>
              )}
              <PatternDiscoveryRunSummary
                report={patternDiscoveryReport}
                sensitivity={patternDiscoverySensitivity}
              />
              {patternDiscoveryReport && (
                <>
                  <div className="pattern-discovery-flow">
                    <div>
                      <b>1</b>
                      <span>Look at older trades</span>
                    </div>
                    <i>→</i>
                    <div>
                      <b>2</b>
                      <span>Find a simple relationship</span>
                    </div>
                    <i>→</i>
                    <div>
                      <b>3</b>
                      <span>Check it on newer trades</span>
                    </div>
                  </div>
                  <p className="pattern-discovery-explainer">
                    <strong>Read this as:</strong> a behavior that appeared often enough in the
                    selected data to test again.
                  </p>
                  {(() => {
                    const insufficientCount = patternDiscoveryReport.patterns.filter(
                      (pattern) => pattern.validationStatus === 'insufficient data',
                    ).length;
                    return insufficientCount > 0 ? (
                      <p className="copytrade-outcome-coverage-warning">
                        <strong>{insufficientCount} candidate rules were not shown:</strong> the
                        validation sample was below the configured minimum-N. The full per-rule
                        reasons remain in the exported report.
                      </p>
                    ) : null;
                  })()}
                  {patternDiscoverySensitivity && (
                    <PatternDiscoveryPromotedPatterns
                      sensitivity={patternDiscoverySensitivity}
                      onSelectPattern={setSelectedPatternRule}
                    />
                  )}
                  {selectedPatternRule && (
                    <PatternDiscoveryRuleDialog
                      rule={selectedPatternRule}
                      onClose={() => setSelectedPatternRule(null)}
                    />
                  )}
                  <Collapsible className="pattern-discovery-details" summary="Technical details">
                    <p>
                      Features come from wallet and token history available before each event. The
                      final holdout is reserved for a later check.
                    </p>
                    {patternDiscoveryExecution && (
                      <p className="muted">Report file: {patternDiscoveryExecution.outputPath}</p>
                    )}
                  </Collapsible>
                </>
              )}
            </div>
          )}
        </section>
      )}

      {copyTradeSubTab === 'pattern-discovery' && (
        <PatternDiscoverySection
          api={api}
          periodDays={copyTradePeriodDays}
          onPeriodDaysChange={setCopyTradePeriodDays}
          onGoToData={() => navigateCopyTradeSubTab('data')}
          patternHistoryAvailable={patternHistoryAvailable}
          onAvailabilityChange={setPatternHistoryAvailable}
          patternDiscoveryIsActive={patternDiscoveryIsActive}
          patternDiscoveryExport={patternDiscoveryExport}
          patternDiscoveryProgress={patternDiscoveryProgress}
          patternDiscoveryLoadingDetail={patternDiscoveryLoadingDetail}
          patternDiscoveryReport={patternDiscoveryReport}
          patternDiscoverySensitivity={patternDiscoverySensitivity}
          patternDiscoveryFreshness={patternDiscoveryFreshness}
          patternDiscoveryExecution={patternDiscoveryExecution}
          patternDiscoveryRunLoading={patternDiscoveryRunLoading}
          patternDiscoveryElapsedSeconds={patternDiscoveryElapsedSeconds}
          patternDiscoveryRunError={patternDiscoveryRunError}
          patternDiscoverySourceOpen={patternDiscoverySourceOpen}
          onSourceOpenChange={setPatternDiscoverySourceOpen}
          selectedPatternRule={selectedPatternRule}
          onSelectedPatternRuleChange={setSelectedPatternRule}
          onExport={exportPatternDiscoveryPage}
          onRun={() => void runPatternDiscovery()}
          onStop={() => void stopPatternDiscovery()}
        />
      )}

      <div className="reference-divider">
        <span>3 · Reference &amp; diagnostics</span>
        <small>Everything below is read-only — nothing here requires action</small>
      </div>

      <ArchivesRoute setMessage={setMessage} />

      <section className="menu-section quality-panel panel">
        <PanelHeading
          eyebrow="DATA QUALITY · V1.1 LINKAGE"
          title="Cohort ↔ GMGN coverage"
          tag="ADDRESS JOIN"
        />
        <p>
          Signals are matched to the imported cohort by exact <code>token_address</code>. Unmatched
          observations stay preserved for later review.
        </p>
        <div className="quality-grid">
          <div className="quality-metric">
            <strong>{quality.coveragePercent}%</strong>
            <span>signals matched to cohort</span>
            <small>
              {quality.matchedSignalCount} of {quality.signalCount}
            </small>
          </div>
          <div className="quality-metric">
            <strong>{quality.tokensWithSignals}</strong>
            <span>cohort tokens with signals</span>
            <small>{quality.tokensWithoutSignals} without signals</small>
          </div>
          <div className="quality-metric">
            <strong>{quality.unmatchedSignalCount}</strong>
            <span>signals outside cohort</span>
            <small>kept, not discarded</small>
          </div>
          <div className="quality-metric">
            <strong>{quality.signalsWithValidationIssues}</strong>
            <span>signals with issues</span>
            <small>
              {quality.missingTokenAddressSignals} missing address ·{' '}
              {quality.missingObservedAtSignals} missing time
            </small>
          </div>
        </div>
      </section>

      <section className="menu-section lower-grid">
        <article className="panel">
          <PanelHeading eyebrow="ACTIVITY" title="Recent imports" />
          {imports.length === 0 ? (
            <p className="muted">No Dune exports processed yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Rows</th>
                    <th>Archive</th>
                  </tr>
                </thead>
                <tbody>
                  {imports.map((item) => (
                    <tr key={item.id ?? item.batchId}>
                      <td>
                        <strong>{item.sourcePath.split(/[\\/]/).pop()}</strong>
                        <small>{item.status ?? 'completed'}</small>
                      </td>
                      <td>
                        <span className="count-good">+{item.imported}</span> / {item.skipped}{' '}
                        skipped / {item.errors} errors
                      </td>
                      <td>
                        {item.archivePath ? <span className="archived">ZIP archived</span> : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </article>
        <article className="panel">
          <PanelHeading eyebrow="SIGNAL MIX" title="By signal type" />
          {stats.signalsByType.length === 0 ? (
            <p className="muted">No signal types captured yet.</p>
          ) : (
            <div className="bars">
              {stats.signalsByType.map((item) => (
                <div className="bar-row" key={item.signalType}>
                  <span>{item.signalType}</span>
                  <b
                    style={{
                      width: `${Math.max(8, (item.count / Math.max(...stats.signalsByType.map((entry) => entry.count))) * 100)}%`,
                    }}
                  >
                    {item.count}
                  </b>
                </div>
              ))}
            </div>
          )}
        </article>
      </section>

      <DiagnosticsRoute setMessage={setMessage} />

      <footer>
        <span>{message}</span>
        <button className="quiet" onClick={() => void refresh()}>
          Refresh
        </button>
        <span>V1 capture only · no scoring or returns</span>
      </footer>
      {showScrollTop && (
        <button
          type="button"
          className="scroll-top-button"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          aria-label="Scroll to top"
          title="Scroll to top"
        >
          ↑ <span>Top</span>
        </button>
      )}
    </main>
  );
}
