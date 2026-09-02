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
import { DataStatusSummary } from './components/data/DataStatusSummary.js';
import { UI_STRINGS } from './strings.js';
import { ArchivesRoute } from './routes/ArchivesRoute.js';
import { DiagnosticsRoute } from './routes/DiagnosticsRoute.js';
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
  SignalPatternGroup,
  SignalPatternReport,
  SignalPatternSnapshot,
  SubgroupProperty,
  SignalPatternSubgroupReport,
  GmgnStatus,
  CopyTradeSubTab,
} from './types.js';

const PATTERN_DISCOVERY_COVERAGE_GRID = [50, 60, 70, 80, 90, 95, 100] as const;
const PATTERN_DISCOVERY_PERIODS = [30, 60, 90] as const;
type ThemeMode = 'dark' | 'light';
const readThemeMode = (): ThemeMode => {
  try {
    return window.localStorage.getItem('vantage-theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
};

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
const SIGNAL_TYPE_LABELS: Record<string, string> = {
  '1': 'General price spike',
  '2': 'Dex ad placement',
  '3': 'Dex social-link update',
  '4': 'Dex trending bar',
  '5': 'Dex Boost',
  '6': 'Price up',
  '7': 'Price ATH',
  '8': 'Market-cap key level',
  '9': 'Live stream',
  '10': 'Bundler sell',
  '11': 'Community takeover',
  '12': 'Smart-money buy',
  '13': 'Platform call',
  '14': 'Large-amount buy',
  '15': 'Multiple buys',
  '16': 'Multiple large buys',
  '17': 'Bags Claim',
  '18': 'Pump Claim',
  '19': 'Platform call V2',
  '20': 'KOL buy',
  '21': 'Banker Claim',
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
const formatSignalType = (value: string | null): string =>
  value ? `${value} · ${SIGNAL_TYPE_LABELS[value] ?? 'Unmapped GMGN type'}` : 'unknown signal type';

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

const formatPercentChange = (base: number | null, value: number | null): string =>
  base === null || value === null || base === 0
    ? '—'
    : `${(((value - base) / base) * 100).toFixed(2)}%`;
const formatPct = (value: number | null): string => (value === null ? '—' : `${value.toFixed(1)}%`);
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
    const reliable = horizon.groups.filter(
      (group) => group.reliable && group.medianReturnPct !== null,
    );
    if (!reliable.length) return [];
    return [
      {
        horizon: horizon.horizon,
        bestMedian: Math.max(...reliable.map((group) => group.medianReturnPct as number)),
        reliableCount: reliable.length,
        nFresh: reliable.reduce((total, group) => total + group.nFresh, 0),
      },
    ];
  });
  return (
    [...candidates].sort((left, right) => {
      const medianDelta = right.bestMedian - left.bestMedian;
      if (medianDelta !== 0) return medianDelta;
      const countDelta = right.reliableCount - left.reliableCount;
      if (countDelta !== 0) return countDelta;
      return right.nFresh - left.nFresh;
    })[0]?.horizon ?? null
  );
};
const bestGroupHorizon = (
  report: SignalPatternReport,
  key: string,
): { horizon: string; group: SignalPatternGroup } | null => {
  const entries = report.horizons.flatMap((horizon) => {
    const group = horizon.groups.find((candidate) => candidate.key === key);
    return group ? [{ horizon: horizon.horizon, group }] : [];
  });
  const candidates = entries.filter(
    (entry) => entry.group.reliable && entry.group.medianReturnPct !== null,
  );
  return (
    [...candidates].sort((left, right) => {
      const medianDelta =
        (right.group.medianReturnPct ?? -Infinity) - (left.group.medianReturnPct ?? -Infinity);
      if (medianDelta !== 0) return medianDelta;
      const coverageDelta =
        (right.group.coveragePct ?? -Infinity) - (left.group.coveragePct ?? -Infinity);
      if (coverageDelta !== 0) return coverageDelta;
      return right.group.nFresh - left.group.nFresh;
    })[0] ?? null
  );
};
const percentChangeValue = (base: number | null, value: number | null): number | null =>
  base === null || value === null || base === 0 ? null : ((value - base) / base) * 100;
const shortAddress = (address: string): string => `${address.slice(0, 3)}...`;
const shortWalletAddress = (address: string): string => `${address.slice(0, 6)}...`;
const normalizeRoute = (route: string): string => (route === 'copy-trades' ? 'copytrade' : route);
const parseCopyTradeRoute = (route: string): { menu: string; subTab: CopyTradeSubTab } => {
  const [rawMenu, rawSubTab] = route.split('/');
  const subTab: CopyTradeSubTab =
    rawSubTab === 'data' ||
    rawSubTab === 'pattern-discovery' ||
    rawSubTab === 'api-reference' ||
    rawSubTab === 'experimental-decision' ||
    rawSubTab === 'live-evaluation'
      ? rawSubTab
      : 'experimental-decision';
  if (rawSubTab === 'wallet-stats')
    return { menu: normalizeRoute(rawMenu || 'dune-capture'), subTab: 'experimental-decision' };
  return { menu: normalizeRoute(rawMenu || 'dune-capture'), subTab };
};
const copyAddress = async (address: string) => {
  try {
    await navigator.clipboard.writeText(address);
  } catch {
    /* clipboard access is optional */
  }
};
const CopyAddressButton = ({
  address,
  label = 'wallet address',
}: {
  address: string;
  label?: string;
}) => (
  <button
    type="button"
    className="icon-copy"
    title={`Copy ${label}`}
    aria-label={`Copy ${label}`}
    onClick={(event) => {
      event.stopPropagation();
      void copyAddress(address);
    }}
  >
    ⧉
  </button>
);
const saveJson = (value: unknown, filename: string) => {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};
const SaveRowButton = ({ row, filename }: { row: unknown; filename: string }) => (
  <button
    type="button"
    className="icon-copy row-save-button"
    title="Save this row as JSON"
    aria-label="Save this row as JSON"
    onClick={(event) => {
      event.stopPropagation();
      saveJson(row, filename);
    }}
  >
    ⇩
  </button>
);
const tokenDisplay = (symbol: string | null, address: string): string =>
  symbol?.trim() || shortAddress(address);
// GMGN returns large monetary fields and pnl ratios as decimal strings in many responses, while
// some responses use JSON numbers. Treat both representations identically; rejecting strings
// made the stored 30d realized-PnL column appear empty even though SQLite had it. Shared by
// every GMGN payload reader in this file instead of each one re-declaring its own closure.
const formatDailyProfit7d = (
  value: unknown,
): { label: string; total: number | null; points: number[] } => {
  if (!Array.isArray(value)) return { label: '—', total: null, points: [] };
  const items: unknown[] = value;
  const points = items
    .map((item) => {
      const raw: unknown =
        item && typeof item === 'object' ? (item as Record<string, unknown>).profit : item;
      const number = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      return Number.isFinite(number) ? number : null;
    })
    .filter((number): number is number => number !== null);
  if (points.length === 0) return { label: '—', total: null, points: [] };
  const total = points.reduce((sum, number) => sum + number, 0);
  const compact = new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(total);
  return { label: `${total >= 0 ? '+' : ''}$${compact}`, total, points };
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

export function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(readThemeMode);
  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    try {
      window.localStorage.setItem('vantage-theme', themeMode);
    } catch {
      // Theme still applies for this session when storage is unavailable.
    }
  }, [themeMode]);
  const initialRoute = (() => {
    const parsed = parseCopyTradeRoute(
      window.location.hash.slice(1) || 'copytrade/experimental-decision',
    );
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
  const [copyTradeSubTab, setCopyTradeSubTab] = useState<CopyTradeSubTab>(initialRoute.subTab);
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

  const navigateTo = (section: string) => {
    setActiveMenu(section);
    if (section === 'copytrade') setCopyTradeSubTab('experimental-decision');
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
    const onLocationChange = () => {
      const next = parseCopyTradeRoute(window.location.hash.slice(1) || 'dune-capture');
      setActiveMenu(next.menu);
      setCopyTradeSubTab(next.subTab);
    };
    window.addEventListener('popstate', onLocationChange);
    window.addEventListener('hashchange', onLocationChange);
    return () => {
      window.removeEventListener('popstate', onLocationChange);
      window.removeEventListener('hashchange', onLocationChange);
    };
  }, []);

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
        onToggleTheme={() => setThemeMode((mode) => (mode === 'dark' ? 'light' : 'dark'))}
      />

      <AppNavigation
        copyTradeSubTab={copyTradeSubTab}
        activeMenu={activeMenu}
        signalMenuActive={signalMenuActive}
        onCopyTradeTabChange={navigateCopyTradeSubTab}
        onMenuChange={navigateTo}
      />

      <OverviewSection stats={stats} gmgnStatus={gmgnStatus} />

      <section id="imports" className="menu-section work-grid">
        <article className="panel upload-panel">
          <PanelHeading
            eyebrow="01 · DUNE COHORT"
            title="Import historical tokens"
            tag="CSV / JSON"
          />
          <p>
            Choose an export from your computer. Duplicate files and token addresses are safely
            skipped; malformed rows remain in the audit log.
          </p>
          <div className="credential-status">
            <span
              className={`status-dot ${duneBusyFile ? '' : stats.tokenCount > 0 ? 'good' : ''}`}
            />
            <div>
              <strong>
                {duneBusyFile
                  ? `Saving ${duneBusyFile}…`
                  : `${stats.tokenCount.toLocaleString()} token${stats.tokenCount === 1 ? '' : 's'} stored in SQLite`}
              </strong>
              <small>
                {lastDuneImport
                  ? `Last import "${lastDuneImport.fileName}": +${lastDuneImport.result.imported} imported · ${lastDuneImport.result.skipped} skipped · ${lastDuneImport.result.errors} errors · ${lastDuneImport.result.duplicateFile ? 'duplicate file, already archived' : lastDuneImport.result.archivePath ? 'archived to ZIP' : 'archive pending'} · ${formatTime(lastDuneImport.at)}`
                  : 'Persists in SQLite across refreshes and restarts — import each export only once.'}
              </small>
            </div>
          </div>
          {measurementPlan && prescreenCounts && (
            <small className="import-detail-line prescreen-audit-line">
              Current GMGN pre-screen:{' '}
              {prescreenCounts.eligible_core + prescreenCounts.eligible_audit} of {prescreenTotal}{' '}
              signal rows selected for the next Dune pass (
              {prescreenPercent(prescreenCounts.eligible_core + prescreenCounts.eligible_audit)}).
              This cohort import changes the reference data only; it does not send a Dune request.
            </small>
          )}
          <label className={`dropzone ${busy ? 'disabled' : ''}`}>
            <input
              type="file"
              accept=".csv,.json,application/json,text/csv"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importDune(file);
                event.currentTarget.value = '';
              }}
            />
            <span className="upload-icon">↑</span>
            <strong>Choose a Dune export</strong>
            <small>Nothing leaves this machine</small>
          </label>
        </article>

        <article className="panel signal-panel">
          <PanelHeading eyebrow="MANUAL OVERRIDE" title="Paste a raw observation" tag="JSON" />
          <p>
            Optional: paste one captured event by hand instead of using automated capture below. The
            normalized fields are only a convenience; the complete payload is always retained.
          </p>
          <textarea
            value={gmgnPayload}
            onChange={(event) => setGmgnPayload(event.target.value)}
            spellCheck={false}
          />
          <button className="primary" disabled={busy} onClick={() => void captureGmgn()}>
            Save GMGN observation
          </button>
        </article>

        <article className="panel upload-panel">
          <PanelHeading
            eyebrow="TARGETED ENRICHMENT"
            title="Look up GMGN tokens in Dune"
            tag="CSV / JSON"
          />
          <p>
            Most GMGN signals land on tokens the Dune cohort export never covered. Export the
            addresses GMGN has actually observed, look them up in Dune yourself, then upload the
            result here — it's stored separately from the original cohort and never overwrites an
            address already on file.
          </p>
          <div className="watch-controls">
            <button
              className="secondary"
              disabled={exportingAddresses}
              onClick={() => void exportGmgnTokenAddresses()}
            >
              {exportingAddresses ? 'Exporting…' : 'Export addresses (.txt)'}
            </button>
            <button
              className="secondary"
              disabled={generatingQuery}
              onClick={() => void generateDuneQuery()}
            >
              {generatingQuery ? 'Generating…' : 'Generate Dune query'}
            </button>
          </div>
          {duneQuery && (
            <div className="dune-query-block">
              <textarea
                readOnly
                value={duneQuery}
                spellCheck={false}
                onFocus={(event) => event.currentTarget.select()}
              />
              <button className="primary" onClick={() => void copyDuneQuery()}>
                Copy query
              </button>
            </div>
          )}
          <div className="credential-status">
            <span
              className={`status-dot ${enrichmentBusy ? '' : lastEnrichmentImport ? 'good' : ''}`}
            />
            <div>
              <strong>
                {enrichmentBusy
                  ? 'Importing enrichment…'
                  : lastEnrichmentImport
                    ? `Last enrichment: ${lastEnrichmentImport.fileName}`
                    : 'No enrichment imported this session'}
              </strong>
              <small>
                {lastEnrichmentImport
                  ? `+${lastEnrichmentImport.result.imported} imported · ${lastEnrichmentImport.result.skipped} already on file · ${lastEnrichmentImport.result.errors} errors · ${formatTime(lastEnrichmentImport.at)}`
                  : 'Same audit trail and archive as a cohort import, tagged dune-targeted-enrichment.'}
              </small>
            </div>
          </div>
          {lastEnrichmentImport && (
            <small className="import-detail-line prescreen-audit-line">
              This targeted lookup enriches stored cohort metadata only; it does not automatically
              capture outcomes. Use Dune Capture to send the pre-screened queue.
            </small>
          )}
          <label className={`dropzone ${enrichmentBusy ? 'disabled' : ''}`}>
            <input
              type="file"
              accept=".csv,.json,application/json,text/csv"
              disabled={enrichmentBusy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importDuneEnrichment(file);
                event.currentTarget.value = '';
              }}
            />
            <span className="upload-icon">↑</span>
            <strong>Choose a Dune lookup result</strong>
            <small>Nothing leaves this machine</small>
          </label>
        </article>
      </section>

      <section id="capture" className="menu-section panel browser-import-panel">
        <PanelHeading
          eyebrow="GMGN BROWSER CAPTURE"
          title="Import website signal evidence"
          tag="JSON EXPORT"
        />
        <p>
          Upload an export produced by the authorized GMGN browser capture extension. Events are
          tagged <code>gmgn-browser-extension</code>, stored through the same append-only signal
          path, and the complete upload is archived with a manifest. This does not scrape or infer
          anything.
        </p>
        <div className="credential-status">
          <span
            className={`status-dot ${browserImportBusy ? '' : lastBrowserImport ? 'good' : ''}`}
          />
          <div>
            <strong>
              {browserImportBusy
                ? 'Importing browser capture…'
                : lastBrowserImport
                  ? `Last upload: ${lastBrowserImport.fileName}`
                  : 'No browser capture imported this session'}
            </strong>
            {!lastBrowserImport && (
              <small>The raw JSON remains available for later audit and replay.</small>
            )}
          </div>
        </div>
        {lastBrowserImport &&
          (lastBrowserImport.result.duplicateFile ? (
            <p className="import-duplicate-banner">
              This exact file was already imported before — nothing new was added and nothing was
              re-fetched. Safe to re-upload an old export by mistake.
            </p>
          ) : (
            <>
              <div className="quality-grid import-result-grid">
                <div className="quality-metric import-metric-new">
                  <strong>{lastBrowserImport.result.imported}</strong>
                  <span>new signals added</span>
                </div>
                <div className="quality-metric import-metric-skip">
                  <strong>{lastBrowserImport.result.skipped}</strong>
                  <span>already captured — skipped</span>
                </div>
                <div
                  className={`quality-metric ${lastBrowserImport.result.errors > 0 ? 'import-metric-issue' : ''}`}
                >
                  <strong>{lastBrowserImport.result.errors}</strong>
                  <span>issue rows</span>
                </div>
              </div>
              <small className="import-detail-line">
                {lastBrowserImport.result.otherCaptures} other endpoint capture(s) archived (not
                parsed) · {lastBrowserImport.result.coverageWindowsImported} coverage window(s) ·
                ZIP archived · {formatTime(lastBrowserImport.at)}
              </small>
              {(() => {
                const r = lastBrowserImport.result.rawEndpoints;
                const total =
                  r.radar.imported +
                  r.radar.skipped +
                  r.walletRank.imported +
                  r.walletRank.skipped +
                  r.smartMoney.imported +
                  r.smartMoney.skipped +
                  r.twitter.imported +
                  r.twitter.skipped;
                return total > 0 ? (
                  <small className="import-detail-line">
                    Raw endpoints this upload: {r.radar.imported + r.radar.skipped} radar ·{' '}
                    {r.walletRank.imported + r.walletRank.skipped} wallet-rank ·{' '}
                    {r.smartMoney.imported + r.smartMoney.skipped} smart-money ·{' '}
                    {r.twitter.imported + r.twitter.skipped} twitter
                  </small>
                ) : null;
              })()}
            </>
          ))}
        {lastBrowserImport && Object.keys(lastBrowserImport.result.issueBreakdown).length > 0 && (
          <small className="import-issue-detail">
            Issue details:{' '}
            {Object.entries(lastBrowserImport.result.issueBreakdown)
              .map(([issue, count]) => `${issue} (${count})`)
              .join(' · ')}
          </small>
        )}
        {measurementPlan && prescreenCounts && (
          <p className="import-detail-line prescreen-audit-line">
            <strong>Pre-screen after import:</strong>{' '}
            {prescreenCounts.eligible_core + prescreenCounts.eligible_audit} selected (
            {prescreenPercent(prescreenCounts.eligible_core + prescreenCounts.eligible_audit)}) for
            Dune · {prescreenCounts.deferred_repeat + prescreenCounts.deferred_budget} deferred (
            {prescreenPercent(prescreenCounts.deferred_repeat + prescreenCounts.deferred_budget)}) ·{' '}
            {prescreenCounts.too_fresh ?? 0} waiting for the{' '}
            {measurementPlan.prescreen.minSignalAgeHours}h buffer (
            {prescreenPercent(prescreenCounts.too_fresh ?? 0)}) ·{' '}
            {prescreenCounts.invalid_for_query} invalid (
            {prescreenPercent(prescreenCounts.invalid_for_query)}) ·{' '}
            {prescreenCounts.already_measured} already measured (
            {prescreenPercent(prescreenCounts.already_measured)}). Deferred repeats are later
            token/type observations; deferred budget rows are valid but outside the current{' '}
            {measurementPlan.prescreen.maxSignalIds}-signal pass budget.
          </p>
        )}
        <label className={`dropzone ${browserImportBusy ? 'disabled' : ''}`}>
          <input
            type="file"
            accept=".json,application/json"
            multiple
            disabled={browserImportBusy}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              if (files.length) void importBrowserCaptures(files);
              event.currentTarget.value = '';
            }}
          />
          <span className="upload-icon">↑</span>
          <strong>Choose browser capture exports</strong>
          <small>Select one or more JSON files; each is processed and archived separately.</small>
        </label>
      </section>

      <section id="capture-raw-endpoints" className="menu-section panel raw-endpoint-panel">
        <Collapsible
          className="signal-legend raw-endpoint-details"
          open={rawEndpointOpen}
          onToggle={(open) => {
            if (open !== rawEndpointOpen) void openRawEndpointSection();
          }}
          summary="Raw endpoint captures (radar / wallet rank / smart money / Twitter)"
        >
          <p className="muted">
            Exploratory raw data captured alongside signals — GMGN&apos;s own trending-token radar,
            its public wallet leaderboard, per-wallet smart-money stats, and KOL/Twitter activity.
            Purely descriptive: nothing here is scored, ranked, or linked to captured signals.
          </p>
          {rawEndpointSummary && (
            <div className="quality-grid raw-endpoint-summary-grid">
              <button
                type="button"
                className={`quality-metric raw-endpoint-tile ${rawEndpointType === 'radar' ? 'active' : ''}`}
                onClick={() => {
                  setRawEndpointType('radar');
                  void loadRawEndpointDetails('radar');
                }}
              >
                <strong>{rawEndpointSummary.radar.count}</strong>
                <span>radar snapshots</span>
                <small>latest {formatTime(rawEndpointSummary.radar.latestCapturedAt)}</small>
              </button>
              <button
                type="button"
                className={`quality-metric raw-endpoint-tile ${rawEndpointType === 'wallet-rank' ? 'active' : ''}`}
                onClick={() => {
                  setRawEndpointType('wallet-rank');
                  void loadRawEndpointDetails('wallet-rank');
                }}
              >
                <strong>{rawEndpointSummary.walletRank.count}</strong>
                <span>wallet rank snapshots</span>
                <small>latest {formatTime(rawEndpointSummary.walletRank.latestCapturedAt)}</small>
              </button>
              <button
                type="button"
                className={`quality-metric raw-endpoint-tile ${rawEndpointType === 'smart-money' ? 'active' : ''}`}
                onClick={() => {
                  setRawEndpointType('smart-money');
                  void loadRawEndpointDetails('smart-money');
                }}
              >
                <strong>{rawEndpointSummary.smartMoney.count}</strong>
                <span>smart-money observations</span>
                <small>latest {formatTime(rawEndpointSummary.smartMoney.latestCapturedAt)}</small>
              </button>
              <button
                type="button"
                className={`quality-metric raw-endpoint-tile ${rawEndpointType === 'twitter' ? 'active' : ''}`}
                onClick={() => {
                  setRawEndpointType('twitter');
                  void loadRawEndpointDetails('twitter');
                }}
              >
                <strong>{rawEndpointSummary.twitter.count}</strong>
                <span>Twitter messages</span>
                <small>latest {formatTime(rawEndpointSummary.twitter.latestCapturedAt)}</small>
              </button>
            </div>
          )}
          {rawEndpointBusy && <p className="muted">Loading…</p>}
          {!rawEndpointBusy && rawEndpointRows.length === 0 && (
            <p className="muted">No {rawEndpointType.replace('-', ' ')} captures stored yet.</p>
          )}
          {!rawEndpointBusy && rawEndpointRows.length > 0 && (
            <div className="table-wrap raw-endpoint-table">
              <table>
                <thead>
                  <tr>
                    {rawEndpointType === 'radar' && (
                      <>
                        <th>Chain</th>
                        <th>Period</th>
                        <th>Category</th>
                      </>
                    )}
                    {rawEndpointType === 'wallet-rank' && (
                      <>
                        <th>Window</th>
                        <th>Order by</th>
                      </>
                    )}
                    {rawEndpointType === 'smart-money' && (
                      <>
                        <th>Wallet</th>
                        <th>Chain</th>
                      </>
                    )}
                    {rawEndpointType === 'twitter' && (
                      <>
                        <th>Tweet type</th>
                        <th>Has token</th>
                      </>
                    )}
                    <th>Captured</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rawEndpointRows.map((row) => (
                    <Fragment key={row.id}>
                      <tr>
                        {rawEndpointType === 'radar' && 'category' in row && (
                          <>
                            <td>{row.chain ?? '—'}</td>
                            <td>{row.period ?? '—'}</td>
                            <td>{row.category ?? '—'}</td>
                          </>
                        )}
                        {rawEndpointType === 'wallet-rank' && 'window' in row && (
                          <>
                            <td>{row.window ?? '—'}</td>
                            <td>{row.orderby ?? '—'}</td>
                          </>
                        )}
                        {rawEndpointType === 'smart-money' && 'walletAddress' in row && (
                          <>
                            <td>
                              <span className="address-compact" title={row.walletAddress}>
                                {row.walletAddress}
                              </span>
                              <CopyAddressButton address={row.walletAddress} />
                              <SaveRowButton row={row} filename={`smart-money-${row.id}.json`} />
                            </td>
                            <td>{row.chain ?? '—'}</td>
                          </>
                        )}
                        {rawEndpointType === 'twitter' && 'twType' in row && (
                          <>
                            <td>{row.twType ?? '—'}</td>
                            <td>{row.hasToken === null ? '—' : row.hasToken ? 'yes' : 'no'}</td>
                          </>
                        )}
                        <td>{formatTime(row.capturedAt)}</td>
                        <td>
                          <button
                            className="secondary"
                            onClick={() =>
                              setRawEndpointExpandedId(
                                rawEndpointExpandedId === row.id ? null : row.id,
                              )
                            }
                          >
                            {rawEndpointExpandedId === row.id ? 'Hide raw' : 'Show raw'}
                          </button>
                        </td>
                      </tr>
                      {rawEndpointExpandedId === row.id && (
                        <tr className="raw-endpoint-json-row">
                          <td colSpan={4}>
                            <pre>{JSON.stringify(row.rawPayload, null, 2)}</pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Collapsible>
      </section>

      <section id="analysis" className="menu-section panel snapshot-analysis-panel">
        <PanelHeading
          eyebrow="DESCRIPTIVE ANALYSIS"
          title="Captured-signal snapshot"
          tag="NO SCORING"
        />
        <p>
          This summarizes what is currently in the database. It describes the snapshot only; it does
          not decide whether any signal is good or bad.
        </p>
        {analysis && (
          <>
            <div className="quality-grid">
              <div className="quality-metric">
                <strong>{analysis.signals.total}</strong>
                <span>signals captured</span>
                <small>{analysis.signals.uniqueTokens} unique tokens</small>
              </div>
              <div className="quality-metric">
                <strong>{analysis.cohortOverlap.matchedSignals}</strong>
                <span>signals matched to Dune</span>
                <small>{analysis.cohortOverlap.unmatchedSignals} unmatched</small>
              </div>
              <div className="quality-metric">
                <strong>
                  {analysis.marketCap.median === null
                    ? '—'
                    : `$${Math.round(analysis.marketCap.median).toLocaleString()}`}
                </strong>
                <span>median signal market cap</span>
                <small>{analysis.marketCap.count} records with market cap</small>
              </div>
              <div className="quality-metric">
                <strong>{analysis.signals.multiSignalTokens}</strong>
                <span>tokens with multiple signals</span>
                <small>max {analysis.signals.maxSignalsPerToken} per token</small>
              </div>
            </div>
            <div className="analysis-columns">
              <div>
                <h3>Signal types</h3>
                {analysis.signalTypes.map((item) => (
                  <div className="analysis-row" key={item.signalType}>
                    <span>Type {item.signalType}</span>
                    <b>{item.count}</b>
                  </div>
                ))}
              </div>
              <div>
                <h3>Sources</h3>
                {analysis.sources.map((item) => (
                  <div className="analysis-row" key={item.source}>
                    <span>{item.source}</span>
                    <b>{item.count}</b>
                  </div>
                ))}
                <h3>Timing</h3>
                <p className="analysis-note">
                  Observed: {formatTime(analysis.timing.earliestObservedAt)} →{' '}
                  {formatTime(analysis.timing.latestObservedAt)}
                  <br />
                  Captured: {formatTime(analysis.timing.earliestCapturedAt)} →{' '}
                  {formatTime(analysis.timing.latestCapturedAt)}
                </p>
              </div>
            </div>
            <p className="analysis-limitations">
              <strong>Interpretation limits:</strong> {analysis.limitations.join(' ')}
            </p>
          </>
        )}
      </section>

      <section id="scoring" className="menu-section panel scoring-panel">
        <PanelHeading
          eyebrow="EXPLORATORY SCORING"
          title="Signal data-readiness score"
          tag="PROVISIONAL"
        />
        <p>
          This is the first transparent scoring experiment. It scores how much supporting data we
          have for each signal—not whether the signal made money.
        </p>
        {scoring && (
          <>
            <div className="quality-grid">
              <div className="quality-metric">
                <strong>{scoring.averageScore}/8</strong>
                <span>average readiness</span>
                <small>{scoring.totalSignals} signals scored</small>
              </div>
              <div className="quality-metric">
                <strong>
                  {scoring.scoreDistribution.find((item) => item.score === 8)?.count ?? 0}
                </strong>
                <span>fully documented</span>
                <small>all eight checks passed</small>
              </div>
            </div>
            <div className="score-legend">
              <span>
                Points: Dune match (2) · first-trade time · DEX · transaction · signal time · time
                order · market cap
              </span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Signal</th>
                    <th>Type</th>
                    <th>Score</th>
                    <th>Dune</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {scoring.rows.slice(0, 25).map((row) => (
                    <tr key={row.signalId}>
                      <td>
                        <strong>#{row.signalId}</strong>
                        <small>{row.tokenAddress ?? 'missing address'}</small>
                      </td>
                      <td>{row.signalType ?? '—'}</td>
                      <td>
                        <span className="count-good">
                          {row.score}/{row.maxScore}
                        </span>
                      </td>
                      <td>{row.matchedDuneToken ? 'Matched' : 'Unmatched'}</td>
                      <td>
                        <small>
                          {[
                            row.firstTradeKnown && 'trade time',
                            row.firstDexKnown && 'DEX',
                            row.firstTxKnown && 'tx',
                            row.temporalOrderValid && 'time order',
                            row.marketCapKnown && 'market cap',
                          ]
                            .filter(Boolean)
                            .join(' · ') || 'No supporting fields'}
                        </small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="analysis-limitations">
              <strong>Important:</strong> {scoring.limitations.join(' ')}
            </p>
          </>
        )}
      </section>

      <section id="dune-capture" className="menu-section panel signal-outcome-batch-panel">
        <section className="outcome-inner">
          <PanelHeading
            eyebrow="DUNE SIGNAL OUTCOME TIMELINE"
            title="Measure captured GMGN signals"
            tag="DUNE PRICE HISTORY"
          />
          <div
            className={`dune-activity ${duneActivity ? 'is-active' : 'is-idle'}`}
            role="status"
            aria-live="polite"
          >
            <span className="activity-spinner" aria-hidden="true"></span>
            <span>{duneActivityLabel}</span>
            {outcomeBatchProgress && outcomeBatchBusy && (
              <small>
                {outcomeBatchProgress.completed}/{outcomeBatchProgress.total} signals · batch{' '}
                {Math.min(outcomeBatchProgress.current + 1, outcomeBatchProgress.batches)}/
                {outcomeBatchProgress.batches}
              </small>
            )}
          </div>
          <Collapsible className="signal-legend" summary="Signal-type legend">
            <div className="signal-legend-grid">
              {Object.keys(SIGNAL_TYPE_LABELS).map((code) => (
                <div key={code}>
                  <b>
                    {code} · {SIGNAL_TYPE_LABELS[code]}
                  </b>
                  <small>{SIGNAL_TYPE_DESCRIPTIONS[code]}</small>
                </div>
              ))}
            </div>
            <small>
              Names and high-level meanings are from GMGNAI’s official gmgn-skills CLI
              documentation. GMGN does not publish every wallet-classification, amount, count, or
              time-window threshold here, so these labels are observations—not quality or
              profitability verdicts.
            </small>
          </Collapsible>
          <label className="select-all-row">
            <span>Signal type</span>
            <select
              value={outcomeTypeFilter}
              onChange={(event) => setOutcomeTypeFilter(event.target.value)}
            >
              <option value="all">All types</option>
              {outcomeTypeOptions.map((type) => (
                <option key={type} value={type}>
                  {type} · {formatSignalType(type)}
                </option>
              ))}
            </select>
            <small>
              {filteredOutcomeCandidates.length} captured signal
              {filteredOutcomeCandidates.length === 1 ? '' : 's'} in this filter
            </small>
          </label>
          <p>
            Choose a signal type, then measure all matching signals. The app submits Dune-safe
            batches, skips complete outcomes, and retries only signals that are eligible for another
            measurement.
          </p>
          <div className="outcome-actions">
            {outcomeBatchBusy && (
              <button
                className="secondary stop-measurement"
                onClick={stopOutcomeBatch}
                title="Finish the current batch, then stop submitting new Dune batches."
              >
                Stop after current batch
              </button>
            )}
            <div className="measurement-queues">
              <div className="measurement-queue-grid">
                <div className="measurement-queue queue-new">
                  <strong>{selectedMeasurementProgress?.newReady ?? 0}</strong>
                  <span>new signals ready</span>
                  <small>
                    Never measured. Selected for the next safe Dune pass:{' '}
                    {selectedMeasurementProgress?.newEligible ?? 0}.
                  </small>
                  <button
                    className="secondary"
                    disabled={
                      outcomeBusy ||
                      outcomeBatchBusy ||
                      (selectedMeasurementProgress?.newEligible ?? 0) === 0
                    }
                    onClick={() => void measureAllOutcomes('new')}
                  >
                    {outcomeBatchBusy
                      ? 'Measuring…'
                      : `Measure new (${selectedMeasurementProgress?.newEligible ?? 0})`}
                  </button>
                </div>
                <div className="measurement-queue queue-retry">
                  <strong>{selectedMeasurementProgress?.retryReady ?? 0}</strong>
                  <span>ready to re-fetch</span>
                  <small>
                    Earlier data was incomplete or unavailable, and its retry delay has elapsed (
                    {selectedMeasurementProgress?.neverMaturelyAttempted ?? 0} of these get their
                    first fair post-buffer check). Screened retry queue:{' '}
                    {selectedMeasurementProgress?.retryEligibleSelected ?? 0}. Requests are sent in
                    small batches.
                  </small>
                  <button
                    className="secondary"
                    disabled={
                      outcomeBusy ||
                      outcomeBatchBusy ||
                      (selectedMeasurementProgress?.retryEligibleSelected ?? 0) === 0
                    }
                    onClick={() => void measureAllOutcomes('retry')}
                  >
                    {outcomeBatchBusy
                      ? 'Re-fetching…'
                      : `Re-fetch matured (${selectedMeasurementProgress?.retryEligibleSelected ?? 0})`}
                  </button>
                </div>
                <div className="measurement-queue queue-wait">
                  <strong>
                    {(selectedMeasurementProgress?.pending ?? 0) +
                      (selectedMeasurementProgress?.tooFresh ?? 0) +
                      (selectedMeasurementProgress?.waitingOnRetryBuffer ?? 0)}
                  </strong>
                  <span>waiting — nothing to do yet</span>
                  <small>
                    {selectedMeasurementProgress?.pending ?? 0} waiting on a checkpoint time ·{' '}
                    {selectedMeasurementProgress?.tooFresh ?? 0} never measured, still inside the{' '}
                    {measurementPlan?.prescreen.minSignalAgeHours ?? 24}h buffer ·{' '}
                    {selectedMeasurementProgress?.waitingOnRetryBuffer ?? 0} already measured,
                    waiting to turn {measurementPlan?.prescreen.minSignalAgeHours ?? 24}h old or for
                    its retry delay before another attempt. All move into the queues above
                    automatically; nothing runs on its own.
                  </small>
                </div>
              </div>
            </div>
            {selectedMeasurementProgress && selectedMeasurementProgress.inFlight > 0 && (
              <button
                className="secondary"
                disabled={reconcileBusy || outcomeBatchBusy}
                onClick={() => void reconcileStuckRuns()}
                title="Checks stuck Dune runs against Dune's real current state and finalizes any that have actually finished, without re-submitting them."
              >
                {reconcileBusy
                  ? 'Reconciling…'
                  : `Reconcile ${selectedMeasurementProgress.inFlight} in-flight signal${selectedMeasurementProgress.inFlight === 1 ? '' : 's'}`}
              </button>
            )}
          </div>
          {measurementPlan && prescreenCounts && (
            <Collapsible
              className="measurement-explanation"
              summary={
                <>
                  How this Dune pass works{' '}
                  <small>{prescreenTotal} stored signals reviewed; nothing was deleted</small>
                </>
              }
            >
              <p className="muted">
                The app sends only the next safe batch to Dune. Everything else stays in SQLite and
                can be reconsidered later.
              </p>
              <p className="measurement-plan-note">
                <strong>Why these signals are in or out of this Dune pass</strong> ·{' '}
                {prescreenTotal} stored candidates evaluated; nothing was deleted.
              </p>
              <div className="prescreen-breakdown-grid">
                <div>
                  <b>
                    {prescreenCounts.eligible_core + prescreenCounts.eligible_audit} selected (
                    {prescreenPercent(
                      prescreenCounts.eligible_core + prescreenCounts.eligible_audit,
                    )}
                    )
                  </b>
                  <small>
                    Core = first token/type observation; audit = deterministic sample of deferred
                    rows.
                  </small>
                </div>
                <div>
                  <b>
                    {prescreenCounts.deferred_repeat} deferred repeats (
                    {prescreenPercent(prescreenCounts.deferred_repeat)})
                  </b>
                  <small>
                    Later observation of a token/type whose lifetime-first row is already the
                    research unit.
                  </small>
                </div>
                <div>
                  <b>
                    {prescreenCounts.deferred_budget} deferred by budget (
                    {prescreenPercent(prescreenCounts.deferred_budget)})
                  </b>
                  <small>
                    Valid lifetime-first rows waiting because this pass allows{' '}
                    {measurementPlan.prescreen.maxSignalIds} total requests.
                  </small>
                </div>
                <div>
                  <b>
                    {prescreenCounts.too_fresh ?? 0} waiting for{' '}
                    {measurementPlan.prescreen.minSignalAgeHours}h buffer (
                    {prescreenPercent(prescreenCounts.too_fresh ?? 0)})
                  </b>
                  <small>
                    Never measured; younger than the required observation buffer before its first
                    Dune request. Not a rejection — it will become eligible automatically once old
                    enough.
                  </small>
                </div>
                <div>
                  <b>
                    {prescreenCounts.already_measured} already measured (
                    {prescreenPercent(prescreenCounts.already_measured)})
                  </b>
                  <small>
                    Has a completed/pending/in-flight/retry-protected Dune outcome; it is not
                    submitted again now.
                  </small>
                </div>
                <div>
                  <b>
                    {prescreenCounts.invalid_for_query} invalid (
                    {prescreenPercent(prescreenCounts.invalid_for_query)})
                  </b>
                  <small>
                    Missing required token address, signal type, UTC observation time, or capture
                    date.
                  </small>
                </div>
              </div>
            </Collapsible>
          )}
          {measurementPlan && selectedMeasurementProgress && (
            <>
              <p className="measurement-summary">
                <span className="status-good">{selectedMeasurementProgress.measured}</span> complete
                outcomes ·{' '}
                <span
                  className={
                    selectedMeasurementProgress.retryEligibleSelected > 0 ? 'status-warn' : ''
                  }
                >
                  {selectedMeasurementProgress.retryEligibleSelected}
                </span>{' '}
                ready to re-fetch ·{' '}
                <span className={selectedMeasurementProgress.unmeasured > 0 ? 'status-warn' : ''}>
                  {selectedMeasurementProgress.unmeasured}
                </span>{' '}
                not complete
                {selectedMeasurementProgress.inFlight > 0 && (
                  <>
                    {' '}
                    ·{' '}
                    <span className="status-warn">
                      {selectedMeasurementProgress.inFlight} stuck (use Reconcile above)
                    </span>
                  </>
                )}
                {selectedUpToDate && ' — up to date'}
              </p>
              <Collapsible className="signal-legend" summary="Measurement details">
                <div className="measurement-status-grid">
                  <div>
                    <b>GMGN parsing</b>
                    <span className="status-good">COMPLETE</span>
                    <small>{selectedMeasurementProgress.captured} normalized signals stored</small>
                    <small>latest capture {formatTime(measurementPlan.latestCapturedAt)}</small>
                  </div>
                  <div>
                    <b>Dune outcomes</b>
                    <span className={selectedUpToDate ? 'status-good' : 'status-warn'}>
                      {selectedUpToDate ? 'COMPLETE' : 'PARTIAL'}
                    </span>
                    <small>
                      {selectedMeasurementProgress.measured} complete outcomes ·{' '}
                      {selectedMeasurementProgress.retryEligibleSelected} ready to re-fetch ·{' '}
                      {selectedWaitingCount} waiting
                    </small>
                    <small>
                      last completed run {formatTime(measurementPlan.latestDuneCompletedAt)}
                    </small>
                  </div>
                  <div>
                    <b>Next Dune work</b>
                    <span
                      className={
                        selectedUpToDate
                          ? 'status-good'
                          : selectedMeasurementProgress.inFlight > 0 &&
                              selectedMeasurementProgress.eligible === 0
                            ? 'status-warn'
                            : 'status-warn'
                      }
                    >
                      {selectedUpToDate
                        ? 'UP TO DATE'
                        : selectedMeasurementProgress.inFlight > 0 &&
                            selectedMeasurementProgress.eligible === 0
                          ? 'IN FLIGHT'
                          : selectedWaitingCount > 0 && selectedMeasurementProgress.eligible === 0
                            ? 'WAITING'
                            : 'PENDING'}
                    </span>
                    <small>
                      {selectedMeasurementProgress.newEligible} new ·{' '}
                      {selectedMeasurementProgress.retryEligibleSelected} retries ·{' '}
                      {selectedMeasurementProgress.eligible} total selected
                    </small>
                    <small>
                      {selectedMeasurementProgress.pending} waiting for target time ·{' '}
                      {selectedMeasurementProgress.complete} complete ·{' '}
                      {selectedMeasurementProgress.inFlight} in flight
                    </small>
                    <small>
                      Pre-screen: {measurementPlan.prescreen.byDisposition.eligible_core ?? 0} core
                      · {measurementPlan.prescreen.byDisposition.eligible_audit ?? 0} audit ·{' '}
                      {(measurementPlan.prescreen.byDisposition.deferred_repeat ?? 0) +
                        (measurementPlan.prescreen.byDisposition.deferred_budget ?? 0)}{' '}
                      deferred · {measurementPlan.prescreen.byDisposition.too_fresh ?? 0} waiting
                      for buffer
                    </small>
                  </div>
                </div>
              </Collapsible>
            </>
          )}
          {outcomeBatchProgress && (
            <p className="batch-progress">
              {outcomeBatchBusy ? 'Batch run in progress' : 'Batch run complete'} ·{' '}
              {outcomeBatchProgress.completed}/{outcomeBatchProgress.total} signals · batch{' '}
              {Math.min(outcomeBatchProgress.current, outcomeBatchProgress.batches)}/
              {outcomeBatchProgress.batches}. Each batch is saved independently.
            </p>
          )}
          {outcomeTimelines.map((timeline) => (
            <div className="timeline-result" key={timeline.signal.id}>
              <strong>
                Signal #{timeline.signal.id} · {timeline.signal.signalType ?? 'unknown'} ·{' '}
                <span className="address-compact" title={timeline.signal.tokenAddress}>
                  {timeline.signal.tokenAddress}
                </span>
              </strong>
              <div className="timeline-grid">
                {timeline.checkpoints.map((checkpoint) => (
                  <div key={checkpoint.label}>
                    <span>{checkpoint.label}</span>
                    <b>
                      {checkpoint.result.priceUsd === null
                        ? 'not available'
                        : `$${checkpoint.result.priceUsd}`}
                    </b>
                    <small>
                      {checkpoint.result.status} · HTTP {checkpoint.result.priceHttpStatus ?? '—'}
                    </small>
                  </div>
                ))}
              </div>
              <small>Missing checkpoints remain missing, never treated as zero.</small>
            </div>
          ))}
        </section>
      </section>

      <section id="patterns" className="menu-section panel patterns-panel">
        <PanelHeading
          eyebrow="SIGNAL PATTERN BREAKDOWN"
          title="Which signal types moved after the signal?"
          tag="DESCRIPTIVE"
        />
        <p className="analysis-limitations">
          <strong>
            {displayedPatternReport?.disclaimer ??
              'Descriptive research only. This does not prove any signal type is profitable or predictive going forward.'}
          </strong>
        </p>
        {displayedPatternReport && measurementPlan && (
          <p className="measurement-plan-note">
            Patterns status:{' '}
            <span
              className={
                measurementPlan.latestDuneCompletedAt &&
                displayedPatternReport.computedAt >= measurementPlan.latestDuneCompletedAt
                  ? 'status-good'
                  : 'status-warn'
              }
            >
              {measurementPlan.latestDuneCompletedAt &&
              displayedPatternReport.computedAt >= measurementPlan.latestDuneCompletedAt
                ? 'UP TO DATE'
                : 'REFRESH NEEDED'}
            </span>{' '}
            · computed {formatTime(displayedPatternReport.computedAt)} · latest Dune run{' '}
            {formatTime(measurementPlan.latestDuneCompletedAt)} · this report issues no new Dune
            request.
          </p>
        )}
        {displayedPatternReport && (
          <p className="muted">
            V3 coverage gate: {displayedPatternReport.minCoveragePct}% fresh coverage across{' '}
            {displayedPatternReport.minCaptureDates} fresh capture dates; analysis unit is{' '}
            {displayedPatternReport.analysisUnit}. Trade-age cutoffs are enforced before a
            comparison can count as fresh.
          </p>
        )}
        {displayedPatternReport && (
          <p className="muted">
            {displayedPatternReport.staleNote} Ranked by median, not average — one outlier trade can
            swing an average heavily without reflecting a typical outcome.
          </p>
        )}
        {viewingSnapshotId !== null && (
          <p className="muted">
            Viewing saved snapshot #{viewingSnapshotId} from{' '}
            {formatTime(
              patternSnapshots.find((snapshot) => snapshot.id === viewingSnapshotId)?.computedAt ??
                null,
            )}
            .{' '}
            <button className="secondary" onClick={() => setViewingSnapshotId(null)}>
              Back to live report
            </button>
          </p>
        )}
        {!displayedPatternReport && (
          <p className="muted">No measured outcomes yet — measure some signals above first.</p>
        )}
        {displayedPatternReport && (
          <>
            <div className="outcome-actions">
              <span className="pattern-auto-horizon">
                Showing best reliable horizon:{' '}
                <strong>{displayedPatternHorizon?.horizon ?? '—'}</strong>
                <small>highest median among signal types that pass every reliability gate</small>
              </span>
              <button
                className="secondary"
                disabled={savingSnapshot || viewingSnapshotId !== null}
                onClick={() => void saveCurrentPatternSnapshot()}
              >
                {savingSnapshot ? 'Saving…' : 'Save snapshot'}
              </button>
            </div>
            {displayedPatternHorizon && (
              <div className="quality-grid">
                <div className="quality-metric">
                  <strong>
                    {displayedPatternHorizon.overall.n
                      ? `${((100 * displayedPatternHorizon.overall.nFresh) / displayedPatternHorizon.overall.n).toFixed(0)}%`
                      : '—'}
                  </strong>
                  <span>signals with a genuine outcome</span>
                  <small>
                    {displayedPatternHorizon.overall.nFresh} of {displayedPatternHorizon.overall.n}{' '}
                    — the rest are missing or stale
                  </small>
                </div>
                <div className="quality-metric">
                  <strong>{formatPct(displayedPatternHorizon.overall.upPct)}</strong>
                  <span>up overall at {displayedPatternHorizon.horizon}</span>
                  <small>across all signal types combined</small>
                </div>
                <div className="quality-metric">
                  <strong>{formatPct(displayedPatternHorizon.overall.medianReturnPct)}</strong>
                  <span>overall median return</span>
                  <small>the honest "typical outcome" number, not the average</small>
                </div>
              </div>
            )}
            {patternVerdict && <p className="analysis-note">{patternVerdict}</p>}
            {displayedPatternHorizon && (
              <label className="pattern-insufficient-toggle">
                <input
                  type="checkbox"
                  checked={showInsufficientPatterns}
                  onChange={(event) => setShowInsufficientPatterns(event.target.checked)}
                />{' '}
                Show rows with insufficient data{' '}
                <small>
                  {displayedPatternHorizon.groups.filter((group) => !group.reliable).length} hidden
                  by default
                </small>
              </label>
            )}
            {displayedPatternHorizon && (
              <div
                className={`table-wrap pattern-table-focused ${showInsufficientPatterns ? 'show-insufficient' : 'hide-insufficient'}`}
              >
                <table>
                  <thead>
                    <tr>
                      <th>Signal type</th>
                      <th>best horizon</th>
                      <th>n</th>
                      <th>fresh</th>
                      <th>tokens</th>
                      <th>missing</th>
                      <th>up %</th>
                      <th>median</th>
                      <th>p25 downside</th>
                      <th>worst</th>
                      <th>average</th>
                      <th>verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="pattern-overall-row">
                      <td>
                        <b>Overall</b>
                      </td>
                      <td>{displayedPatternHorizon.horizon}</td>
                      <td>{displayedPatternHorizon.overall.n}</td>
                      <td>{displayedPatternHorizon.overall.nFresh}</td>
                      <td>{displayedPatternHorizon.overall.nDistinctTokens}</td>
                      <td>{displayedPatternHorizon.overall.nMissing}</td>
                      <td>{formatPct(displayedPatternHorizon.overall.upPct)}</td>
                      <td>{formatPct(displayedPatternHorizon.overall.medianReturnPct)}</td>
                      <td>{formatPct(displayedPatternHorizon.overall.p25ReturnPct)}</td>
                      <td>{formatPct(displayedPatternHorizon.overall.worstReturnPct)}</td>
                      <td>{formatPct(displayedPatternHorizon.overall.avgReturnPct)}</td>
                      <td>{displayedPatternHorizon.overall.verdict}</td>
                    </tr>
                    {displayedPatternHorizon.groups.map((group) => {
                      const best = bestGroupHorizon(displayedPatternReport, group.key);
                      const row = best?.group ?? group;
                      return (
                        <tr
                          key={`focused-${group.key}`}
                          className={row.reliable ? '' : 'pattern-unreliable-row'}
                        >
                          <td>{formatSignalType(row.key)}</td>
                          <td>{best?.horizon ?? '—'}</td>
                          <td>{row.n}</td>
                          <td>{row.nFresh}</td>
                          <td>{row.nDistinctTokens}</td>
                          <td>{row.nMissing}</td>
                          <td>{formatPct(row.upPct)}</td>
                          <td
                            className={
                              row.medianReturnPct === null
                                ? ''
                                : row.medianReturnPct >= 0
                                  ? 'change-positive'
                                  : 'change-negative'
                            }
                          >
                            {formatPct(row.medianReturnPct)}
                          </td>
                          <td>{formatPct(row.p25ReturnPct)}</td>
                          <td className="change-negative">{formatPct(row.worstReturnPct)}</td>
                          <td>{formatPct(row.avgReturnPct)}</td>
                          <td>
                            <span
                              className={`pattern-verdict pattern-verdict-${row.verdict.replaceAll(' ', '-')}`}
                            >
                              {row.verdict}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {displayedPatternHorizon && (
              <div
                className={`table-wrap pattern-table ${showInsufficientPatterns ? 'show-insufficient' : 'hide-insufficient'}`}
              >
                <table>
                  <thead>
                    <tr>
                      <th>Signal type</th>
                      <th>best horizon</th>
                      <th>n</th>
                      <th>with data</th>
                      <th>missing</th>
                      <th title="No new trade before this checkpoint — excluded from up %/avg/median">
                        stale
                      </th>
                      <th>fresh</th>
                      <th title="Distinct tokens behind the fresh comparisons — a lower number than n/fresh means the same token repeated">
                        tokens
                      </th>
                      <th>up %</th>
                      <th>avg return</th>
                      <th>median return</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="pattern-overall-row">
                      <td>
                        <b>Overall</b>
                      </td>
                      <td>{displayedPatternHorizon.horizon}</td>
                      <td>{displayedPatternHorizon.overall.n}</td>
                      <td>{displayedPatternHorizon.overall.nWithData}</td>
                      <td>{displayedPatternHorizon.overall.nMissing}</td>
                      <td>{displayedPatternHorizon.overall.nStale}</td>
                      <td>{displayedPatternHorizon.overall.nFresh}</td>
                      <td>{displayedPatternHorizon.overall.nDistinctTokens}</td>
                      <td>{formatPct(displayedPatternHorizon.overall.upPct)}</td>
                      <td>{formatPct(displayedPatternHorizon.overall.avgReturnPct)}</td>
                      <td>{formatPct(displayedPatternHorizon.overall.medianReturnPct)}</td>
                      <td />
                    </tr>
                    {displayedPatternHorizon.groups.map((group) => {
                      const best = bestGroupHorizon(displayedPatternReport, group.key);
                      const row = best?.group ?? group;
                      return (
                        <tr
                          key={group.key}
                          className={row.reliable ? '' : 'pattern-unreliable-row'}
                        >
                          <td>{formatSignalType(row.key)}</td>
                          <td>{best?.horizon ?? '—'}</td>
                          <td>{row.n}</td>
                          <td>{row.nWithData}</td>
                          <td>{row.nMissing}</td>
                          <td>{row.nStale}</td>
                          <td>{row.nFresh}</td>
                          <td
                            className={
                              row.nFresh > 0 && row.nDistinctTokens < row.nFresh
                                ? 'pattern-repeat-tokens'
                                : ''
                            }
                            title={
                              row.nFresh > 0 && row.nDistinctTokens < row.nFresh
                                ? 'Some tokens repeated this signal type more than once — these comparisons are not fully independent.'
                                : undefined
                            }
                          >
                            {row.nDistinctTokens}
                          </td>
                          <td>{formatPct(row.upPct)}</td>
                          <td
                            className={
                              row.avgReturnPct === null
                                ? ''
                                : row.avgReturnPct >= 0
                                  ? 'change-positive'
                                  : 'change-negative'
                            }
                          >
                            {formatPct(row.avgReturnPct)}
                          </td>
                          <td
                            className={
                              row.medianReturnPct === null
                                ? ''
                                : row.medianReturnPct >= 0
                                  ? 'change-positive'
                                  : 'change-negative'
                            }
                          >
                            {formatPct(row.medianReturnPct)}
                          </td>
                          <td>
                            {!row.reliable && (
                              <span
                                className="pattern-warning"
                                title={`Fewer than ${displayedPatternReport.minReliableSample} genuine (non-stale) comparisons — too small to trust as a pattern.`}
                              >
                                small sample
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted">
              Computed {formatTime(displayedPatternReport.computedAt)} from{' '}
              {displayedPatternReport.sourceRunIds.length} archived Dune run
              {displayedPatternReport.sourceRunIds.length === 1 ? '' : 's'} already stored locally —
              no new Dune query is issued to build this report.
            </p>
          </>
        )}
        {patternSnapshots.length > 0 && (
          <Collapsible
            className="pattern-history"
            summary={`Saved snapshots (${patternSnapshots.length})`}
          >
            <div className="pattern-history-list">
              {patternSnapshots.map((snapshot) => (
                <div key={snapshot.id} className="pattern-history-row">
                  <span>
                    #{snapshot.id} · {formatTime(snapshot.computedAt)} ·{' '}
                    {snapshot.sourceRunIds.length} source run
                    {snapshot.sourceRunIds.length === 1 ? '' : 's'}
                  </span>
                  <button className="secondary" onClick={() => setViewingSnapshotId(snapshot.id)}>
                    View
                  </button>
                </div>
              ))}
            </div>
          </Collapsible>
        )}
        <Collapsible
          className="pattern-subgroups"
          open={subgroupOpened}
          onToggle={(open) => {
            setSubgroupOpened(open);
            if (open && !subgroupReport && !subgroupBusy) void loadSubgroupReport(subgroupProperty);
          }}
          summary="Subgroup breakdown: signal type × property (exploratory)"
        >
          <p className="analysis-limitations">
            <strong>
              {subgroupReport?.disclaimer ??
                'Descriptive research only. This does not prove any signal type + property combination is profitable or predictive going forward.'}
            </strong>
          </p>
          <p className="muted">
            Limited to properties fixed at signal time (launch platform, token age) — fast-moving
            fields like live liquidity or volume are query-time snapshots, not verified trigger-time
            facts, so they're deliberately excluded from this breakdown for now. No statistical
            correction is applied for testing multiple cells at once — the cell count below is shown
            so a good-looking cell can be weighed against how many were tested. This view picks its
            own best horizon independently of the main table above — a standout combination can peak
            at a different horizon than the aggregate picture.
          </p>
          <div className="outcome-actions">
            {(Object.keys(SUBGROUP_PROPERTY_LABELS) as SubgroupProperty[]).map((property) => (
              <button
                key={property}
                className={subgroupProperty === property ? 'primary' : 'secondary'}
                onClick={() => {
                  setSubgroupProperty(property);
                  setSubgroupReport(null);
                  void loadSubgroupReport(property);
                }}
              >
                {SUBGROUP_PROPERTY_LABELS[property]}
              </button>
            ))}
          </div>
          {subgroupBusy && <p className="muted">Computing…</p>}
          {!subgroupBusy && displayedSubgroupHorizon && (
            <>
              <p className="muted">
                Auto-selected: <strong>{displayedSubgroupHorizon.horizon}</strong> (best reliable
                cell for this breakdown) · {displayedSubgroupHorizon.cellCount} cell
                {displayedSubgroupHorizon.cellCount === 1 ? '' : 's'} tested (signal type ×{' '}
                {SUBGROUP_PROPERTY_DESCRIPTIONS[subgroupProperty]}) ·{' '}
                {displayedSubgroupHorizon.nUnextractable} signal
                {displayedSubgroupHorizon.nUnextractable === 1 ? '' : 's'} excluded (property not
                extractable, not guessed).
              </p>
              <div className="table-wrap pattern-table-subgroup">
                <table>
                  <thead>
                    <tr>
                      <th>Cell (type × {SUBGROUP_PROPERTY_DESCRIPTIONS[subgroupProperty]})</th>
                      <th>n</th>
                      <th>fresh</th>
                      <th>tokens</th>
                      <th>up %</th>
                      <th>median</th>
                      <th>average</th>
                      <th>verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedSubgroupHorizon.groups.map((group) => (
                      <tr
                        key={group.key}
                        className={group.reliable ? '' : 'pattern-unreliable-row'}
                      >
                        <td>{group.key}</td>
                        <td>{group.n}</td>
                        <td>{group.nFresh}</td>
                        <td>{group.nDistinctTokens}</td>
                        <td>{formatPct(group.upPct)}</td>
                        <td
                          className={
                            group.medianReturnPct === null
                              ? ''
                              : group.medianReturnPct >= 0
                                ? 'change-positive'
                                : 'change-negative'
                          }
                        >
                          {formatPct(group.medianReturnPct)}
                        </td>
                        <td>{formatPct(group.avgReturnPct)}</td>
                        <td>
                          <span
                            className={`pattern-verdict pattern-verdict-${group.verdict.replaceAll(' ', '-')}`}
                          >
                            {group.verdict}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {!subgroupBusy && subgroupReport && !displayedSubgroupHorizon && (
            <p className="muted">
              No subgroup horizon currently passes all reliability gates (fresh sample, coverage,
              distinct tokens, and capture-date spread). The data remains stored for review.
            </p>
          )}
        </Collapsible>
      </section>

      <Collapsible
        className="outcome-results-details"
        open={false}
        summary={`Measured results (${outcomeTimelines.length})`}
      >
        <div className="outcome-results-controls">
          <label>
            Rows per page
            <select
              value={outcomePageSize}
              onChange={(event) => {
                const value = event.target.value;
                setOutcomePageSize(value === 'all' ? 'all' : Number(value));
                setOutcomePage(0);
              }}
            >
              <option value="25">25</option>
              <option value="100">100</option>
              <option value="1000">1,000</option>
              <option value="all">All</option>
            </select>
          </label>
          <button
            type="button"
            className="secondary"
            disabled={outcomePage === 0 || outcomePageSize === 'all'}
            onClick={() => setOutcomePage((page) => Math.max(0, page - 1))}
          >
            Previous
          </button>
          <span>
            Page {Math.min(outcomePage + 1, outcomePageCount)} of {outcomePageCount}
          </span>
          <button
            type="button"
            className="secondary"
            disabled={outcomePageSize === 'all' || outcomePage + 1 >= outcomePageCount}
            onClick={() => setOutcomePage((page) => Math.min(outcomePageCount - 1, page + 1))}
          >
            Next
          </button>
        </div>
        <div className="table-wrap outcome-table outcome-table-visible">
          <table>
            <thead>
              <tr>
                {outcomeColumns.map((column) => (
                  <th
                    key={column.key}
                    onClick={() => toggleOutcomeSort(column.key)}
                    className="sortable-header"
                    title="Click to sort"
                  >
                    {column.label}
                    {sortIndicator(column.key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleOutcomeTimelines.map((timeline) => {
                const base =
                  timeline.checkpoints.find((checkpoint) => checkpoint.label === 'signal')?.result
                    .priceUsd ?? null;
                return (
                  <tr key={timeline.signal.id}>
                    <td>#{timeline.signal.id}</td>
                    <td>{formatSignalType(timeline.signal.signalType)}</td>
                    {CHECKPOINT_COLUMNS.map((label) => renderCheckpointCell(timeline, base, label))}
                    <td>
                      <span className="token-cell" title={timeline.signal.tokenAddress}>
                        {tokenDisplay(timeline.signal.symbol, timeline.signal.tokenAddress)}{' '}
                        <button
                          type="button"
                          className="copy-address"
                          aria-label={`Copy address ${timeline.signal.tokenAddress}`}
                          onClick={() => void copyAddress(timeline.signal.tokenAddress)}
                        >
                          ⧉
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Collapsible>

      <section id="copytrade" className="menu-section panel copytrade-panel">
        <CopyTradeSubTabContent
          activeTab={copyTradeSubTab}
          api={api}
          periodDays={copyTradePeriodDays as 30 | 60 | 90}
          onPeriodDaysChange={(periodDays) => setCopyTradePeriodDays(periodDays)}
        />
      </section>
      {copyTradeSubTab === 'pattern-discovery' && (
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
