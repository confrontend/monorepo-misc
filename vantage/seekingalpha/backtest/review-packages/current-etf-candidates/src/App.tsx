import { Fragment, useEffect, useMemo, useState } from 'react';
import { fetchAnalysis, fetchAnalysisMeta, fetchDataConsolidationJob, fetchDataStatus, fetchEtfResearchExport, fetchEtfSignalDiscovery, fetchResearchJob, fetchResearchReport, fetchSignalDiscovery, runDataImport, startDataConsolidation, startResearchRun, type AnalysisMeta, type DataConsolidationJob, type DataStatus, type ImportSummary, type ResearchJob, type ResearchReport } from './api';
import { DataView } from './domains/data/components/DataView';
import { PortfolioBacktestView } from './domains/portfolio/components/PortfolioBacktestView';
import type { AggregateResult, CohortResult, HistoryWindow, PredictiveAccuracySummary, Rating, RatingCallSummary, ScoreCorrelation, SignalDiscoveryResult, SignalPolicy, StrongBuyOutlierAnalysis, StrongBuyTrade, StrongBuyTrustResult, TickerAccuracy, TickerCohortResult, TickerResult, TierStats, TierWinRate } from './data';
import { OverallResultsTable } from './domains/overall-results/components/OverallResultsTable';
import { StrongBuyTrustView, type StrongBuySummary } from './domains/strong-buy-trust/components/StrongBuyTrustView';
import { ScoreCorrelationChart, TierWinRateSummary, RatingTierTable, TickerCohortTable } from './domains/rating-tiers/components/RatingTiersView';
import { TickerAccuracyView } from './domains/rating-accuracy/components/RatingAccuracyView';
import { ResearchView } from './domains/research/components/ResearchView';
import { SignalDiscoveryView } from './domains/signal-discovery/components/SignalDiscoveryView';
import { EtfHubView } from './domains/etf/components/EtfHubView';
import { buildHistoryOptions, fallbackHistoryOptions, matrixKey, policyExitRules, policyLabels, policyOptions, ratingClass, signedPercent, type HistoryOption } from './shared/analysisUi';
import { LoadingState } from './shared/components/LoadingState';
import { LegendPanel } from './shared/components/LegendPanel';

type SortKey = 'ticker' | 'signals' | 'hitRate' | 'averageReturn';
type ActiveView = 'data' | 'tickers' | 'overall' | 'strong-buy' | 'tiers' | 'accuracy' | 'discovery' | 'etfs' | 'etf-discovery' | 'etf-candidates' | 'etf-research' | 'research' | 'portfolio';
type PrimaryArea = 'stocks' | 'etfs' | 'data';

const ACTIVE_VIEWS: ActiveView[] = ['data', 'tickers', 'overall', 'strong-buy', 'tiers', 'accuracy', 'discovery', 'etfs', 'etf-discovery', 'etf-candidates', 'etf-research', 'research', 'portfolio'];

const ROUTES: Record<ActiveView, string> = {
  data: '/data',
  tickers: '/stocks',
  overall: '/stocks/overview',
  'strong-buy': '/stocks/strong-buy-trust',
  tiers: '/stocks/rating-groups',
  accuracy: '/stocks/prediction-accuracy',
  discovery: '/stocks/signal-discovery',
  etfs: '/etfs/discovery',
  'etf-discovery': '/etfs/discovery',
  'etf-candidates': '/etfs/candidates',
  'etf-research': '/etfs/research',
  research: '/stocks/research',
  portfolio: '/stocks/portfolio',
};
const routeForView = (view: ActiveView) => ROUTES[view];

const ROUTE_VIEWS: Record<string, ActiveView> = {
  '/': 'etf-discovery',
  '/data': 'data',
  '/stocks': 'tickers',
  '/stocks/overview': 'overall',
  '/stocks/strong-buy-trust': 'strong-buy',
  '/stocks/rating-groups': 'tiers',
  '/stocks/prediction-accuracy': 'accuracy',
  '/stocks/signal-discovery': 'discovery',
  '/etfs': 'etf-discovery',
  '/etfs/discovery': 'etf-discovery',
  '/etfs/candidates': 'etf-candidates',
  '/etfs/research': 'etf-research',
  '/etfs/check': 'etf-candidates',
  '/stocks/research': 'research',
  '/stocks/portfolio': 'portfolio',
  // Legacy routes remain readable and are replaced with their canonical /stocks/... URL on load.
  '/overview': 'overall',
  '/signals/strong-buy': 'strong-buy',
  '/signals/rating-groups': 'tiers',
  '/signals/prediction-accuracy': 'accuracy',
  '/signal-discovery': 'discovery',
  '/research': 'research',
  '/portfolio': 'portfolio',
};
const viewForRoute = (pathname: string): ActiveView | null => ROUTE_VIEWS[pathname] ?? null;

const areaForView = (view: ActiveView): PrimaryArea => {
  if (view === 'data') return 'data';
  if (view === 'etfs' || view.startsWith('etf-')) return 'etfs';
  return 'stocks';
};
const isEtfView = (view: ActiveView) => view === 'etfs' || view === 'etf-discovery' || view === 'etf-candidates' || view === 'etf-research';

const VIEW_COPY: Record<ActiveView, { title: string; subtitle: string }> = {
  data: { title: 'Data', subtitle: 'One folder in, one database out — every analysis reads what you import here' },
  tickers: { title: 'Stock results', subtitle: 'One summary row per ticker · compare every strategy or open full details from the Actions column' },
  overall: { title: 'Overview', subtitle: 'Which strategies consistently beat simply holding each stock' },
  'strong-buy': { title: 'Strong Buy trust', subtitle: 'Were historical entries into Strong Buy profitable before the rating changed?' },
  tiers: { title: 'Rating groups', subtitle: 'Do stocks rated better today actually have stronger real track records?' },
  accuracy: { title: 'Prediction accuracy', subtitle: "Does a stock's own rating predict what its own price does next, per ticker" },
  discovery: { title: 'Signal discovery', subtitle: 'Discover stock rating-persistence rules, then test them on an unseen final year' },
  etfs: { title: 'ETF workspace', subtitle: 'Discover rules, validate the evidence, and find ETFs that currently match them' },
  'etf-discovery': { title: 'Discover ETF rules', subtitle: 'Find patterns in the data and test them on the unseen period' },
  'etf-candidates': { title: 'Current ETF candidates', subtitle: 'See which imported ETFs currently match a validated rule' },
  'etf-research': { title: 'ETF evidence', subtitle: 'Inspect SPY comparisons, placebo tests, bootstrap results, and methodology' },
  research: { title: 'Stock research', subtitle: 'Corrected bullish and bearish studies using the imported single-stock universe' },
  portfolio: { title: 'Portfolio backtest', subtitle: 'Test how groups of historically selected stocks performed together' },
};

const DEFAULT_HISTORY_WINDOW: HistoryWindow = '7d';
const DEFAULT_POLICY: SignalPolicy = 'long-exit-hold';
const DEFAULT_SORT_KEY: SortKey = 'hitRate';
const DEFAULT_ACTIVE_VIEW: ActiveView = 'etf-discovery';
const DEFAULT_ACCURACY_HORIZON = 90;
const UI_STATE_STORAGE_KEY = 'seeking-alpha-backtest-ui-state';

type PersistedUiState = {
  activeView: ActiveView;
  historyWindow: HistoryWindow;
  policy: SignalPolicy;
  sortKey: SortKey;
  accuracyHorizon: number;
};

const defaultUiState: PersistedUiState = {
  activeView: DEFAULT_ACTIVE_VIEW,
  historyWindow: DEFAULT_HISTORY_WINDOW,
  policy: DEFAULT_POLICY,
  sortKey: DEFAULT_SORT_KEY,
  accuracyHorizon: DEFAULT_ACCURACY_HORIZON,
};

const readPersistedUiState = (): PersistedUiState => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(UI_STATE_STORAGE_KEY) ?? '{}') as Partial<PersistedUiState>;
    // Stock views are still reachable by their direct URLs, but are archived from
    // the normal UI. Migrate an old saved stock tab to the ETF workspace so a
    // stale local-storage value cannot defeat the new default landing page.
    const archivedStockViews: ActiveView[] = ['tickers', 'overall', 'strong-buy', 'tiers', 'accuracy', 'discovery', 'research', 'portfolio', 'etfs'];
    const savedView = parsed.activeView && ACTIVE_VIEWS.includes(parsed.activeView) ? parsed.activeView : null;
    const activeView = savedView && !archivedStockViews.includes(savedView) ? savedView : DEFAULT_ACTIVE_VIEW;
    const historyWindow = parsed.historyWindow === '7d' || parsed.historyWindow === 'all' || (typeof parsed.historyWindow === 'string' && /^\d+m$/.test(parsed.historyWindow)) ? parsed.historyWindow as HistoryWindow : DEFAULT_HISTORY_WINDOW;
    const policy = policyOptions.some((option) => option.value === parsed.policy) ? parsed.policy as SignalPolicy : DEFAULT_POLICY;
    const sortKey = parsed.sortKey === 'ticker' || parsed.sortKey === 'signals' || parsed.sortKey === 'hitRate' || parsed.sortKey === 'averageReturn' ? parsed.sortKey : DEFAULT_SORT_KEY;
    const accuracyHorizon = typeof parsed.accuracyHorizon === 'number' && Number.isFinite(parsed.accuracyHorizon) && parsed.accuracyHorizon > 0 ? parsed.accuracyHorizon : DEFAULT_ACCURACY_HORIZON;
    return { activeView, historyWindow, policy, sortKey, accuracyHorizon };
  } catch {
    return defaultUiState;
  }
};

// Rating tiers view uses a shorter column set than the rest of the app: 7 days through 24
// months, plus All — per user request, the 30m-54m windows in between weren't useful here.
const fallbackTierHistoryOptions = fallbackHistoryOptions.filter((option) => {
  if (option.value === '7d' || option.value === 'all') return true;
  return Number.parseInt(option.value, 10) <= 24;
});


function App() {
  const [initialUiState] = useState(readPersistedUiState);
  const [activeView, setActiveView] = useState<ActiveView>(() => viewForRoute(window.location.pathname) ?? initialUiState.activeView);
  const [historyWindow, setHistoryWindow] = useState<HistoryWindow>(initialUiState.historyWindow);
  const [policy, setPolicy] = useState<SignalPolicy>(initialUiState.policy);
  const [sortKey, setSortKey] = useState<SortKey>(initialUiState.sortKey);
  const [exportLabel, setExportLabel] = useState('Export table');
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [expandedTickers, setExpandedTickers] = useState<Set<string>>(() => new Set());
  const [historyOptions, setHistoryOptions] = useState<HistoryOption[]>(fallbackHistoryOptions);
  const [fingerprint, setFingerprint] = useState('');
  const [tickerRows, setTickerRows] = useState<TickerResult[]>([]);
  const [aggregateRows, setAggregateRows] = useState<AggregateResult[]>([]);
  const [strongBuyRows, setStrongBuyRows] = useState<StrongBuySummary[]>([]);
  const [strongBuyOutliers, setStrongBuyOutliers] = useState<StrongBuyOutlierAnalysis | null>(null);
  const [cohortRows, setCohortRows] = useState<CohortResult[]>([]);
  const [cohortTiers, setCohortTiers] = useState<Array<CohortResult['tier']>>([]);
  const [tickerCohortRows, setTickerCohortRows] = useState<TickerCohortResult[]>([]);
  const [tierWinRates, setTierWinRates] = useState<TierWinRate[]>([]);
  const [scoreCorrelation, setScoreCorrelation] = useState<ScoreCorrelation>({ points: [], correlation: null, slope: null, intercept: null });
  const [tierHistoryOptions, setTierHistoryOptions] = useState<HistoryOption[]>(fallbackTierHistoryOptions);
  const [accuracyRows, setAccuracyRows] = useState<TickerAccuracy[]>([]);
  const [accuracyHorizon, setAccuracyHorizon] = useState(initialUiState.accuracyHorizon);
  const [accuracyHorizonOptions, setAccuracyHorizonOptions] = useState<number[]>([30, 90, 180, 365]);
  const [selectedAccuracyTicker, setSelectedAccuracyTicker] = useState<string | null>(null);
  const [ratingCallSummary, setRatingCallSummary] = useState<RatingCallSummary | null>(null);
  const [predictiveAccuracySummary, setPredictiveAccuracySummary] = useState<PredictiveAccuracySummary | null>(null);
  const [methodology, setMethodology] = useState<AnalysisMeta['methodology'] | null>(null);
  const [researchReport, setResearchReport] = useState<ResearchReport | null>(null);
  const [researchJob, setResearchJob] = useState<ResearchJob | null>(null);
  const [signalDiscovery, setSignalDiscovery] = useState<SignalDiscoveryResult | null>(null);
  const [etfSignalDiscovery, setEtfSignalDiscovery] = useState<SignalDiscoveryResult | null>(null);
  const [dataStatus, setDataStatus] = useState<DataStatus | null>(null);
  const [dataConsolidationJob, setDataConsolidationJob] = useState<DataConsolidationJob | null>(null);
  const [importing, setImporting] = useState(false);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [matrixResults, setMatrixResults] = useState<Map<string, Map<string, TickerResult>>>(() => new Map());
  const [selectedResult, setSelectedResult] = useState<TickerResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const windowLabel = historyOptions.find((option) => option.value === historyWindow)?.label ?? historyWindow;
  const activeArea = areaForView(activeView);
  const rows = useMemo(() => [...tickerRows].sort((left, right) => {
    if (sortKey === 'ticker') return left.ticker.localeCompare(right.ticker);
    if (sortKey === 'signals') return right.signals - left.signals;
    if (sortKey === 'averageReturn') return right.averageReturn - left.averageReturn;
    return right.hitRate - left.hitRate;
  }), [tickerRows, sortKey]);
  const hasAnyBenchmark = rows.some((row) => row.detail.benchmark.available);

  useEffect(() => {
    const currentRoute = viewForRoute(window.location.pathname);
    if (!currentRoute || window.location.pathname !== routeForView(currentRoute)) {
      const canonicalView = currentRoute ?? activeView;
      window.history.replaceState({ view: canonicalView }, '', routeForView(canonicalView));
    }
    const handleHistory = () => {
      const view = viewForRoute(window.location.pathname);
      if (!view) return;
      setActiveView(view);
      setSelectedTicker(null);
      setSelectedResult(null);
    };
    window.addEventListener('popstate', handleHistory);
    return () => window.removeEventListener('popstate', handleHistory);
  }, [activeView]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setSelectedTicker(null); setSelectedResult(null); }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);

  useEffect(() => {
    try {
      const state: PersistedUiState = { activeView, historyWindow, policy, sortKey, accuracyHorizon };
      window.localStorage.setItem(UI_STATE_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage may be unavailable in private or restricted browser contexts.
    }
  }, [activeView, historyWindow, policy, sortKey, accuracyHorizon]);

  useEffect(() => {
    let cancelled = false;
    const refreshMeta = async () => {
      try {
        const meta = await fetchAnalysisMeta();
        if (cancelled) return;
        const nextOptions = buildHistoryOptions(meta.windows);
        setHistoryOptions(nextOptions);
        setTierHistoryOptions(nextOptions.filter((option) => option.value === '7d' || option.value === 'all' || Number.parseInt(option.value, 10) <= 24));
        if (!meta.windows.includes(historyWindow)) setHistoryWindow(DEFAULT_HISTORY_WINDOW);
        if (meta.accuracyHorizons?.length) {
          setAccuracyHorizonOptions(meta.accuracyHorizons);
          setAccuracyHorizon((current) => (meta.accuracyHorizons.includes(current) ? current : meta.accuracyHorizons[Math.floor(meta.accuracyHorizons.length / 2)]));
        }
        if (meta.methodology) setMethodology(meta.methodology);
        setFingerprint((current) => {
          if (current && current !== meta.fingerprint) {
            setMatrixResults(new Map());
            setSelectedTicker(null);
            setSelectedResult(null);
          }
          return meta.fingerprint;
        });
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      }
    };
    // Research, data, and portfolio views have their own job/report polling and do not
    // consume the analysis metadata. Avoid issuing a background metadata request every
    // two seconds while those long-running views are open.
    const metaPollingViews = new Set<ActiveView>([
      'research', 'etfs', 'etf-discovery', 'etf-candidates', 'etf-research', 'data', 'portfolio',
    ]);
    if (metaPollingViews.has(activeView)) return () => { cancelled = true; };
    void refreshMeta();
    const timer = window.setInterval(refreshMeta, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [activeView, historyWindow]);

  useEffect(() => {
    // The research view reads flat files written by the Python pipeline, so it
    // has no dependency on the analysis fingerprint (or on the analysis SQLite
    // database being healthy) and must not wait for one.
    if (!fingerprint && activeView !== 'research' && !isEtfView(activeView) && activeView !== 'data' && activeView !== 'portfolio') return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    const loadActiveView = async () => {
      try {
        if (activeView === 'tickers') {
          const response = await fetchAnalysis<TickerResult[]>('tickerRows', { window: historyWindow, policy });
          if (!cancelled) setTickerRows(response.data);
        } else if (activeView === 'overall') {
          const response = await fetchAnalysis<AggregateResult[]>('aggregate');
          if (!cancelled) setAggregateRows(response.data);
        } else if (activeView === 'strong-buy') {
          const response = await fetchAnalysis<{ tickers: StrongBuySummary[]; outliers: StrongBuyOutlierAnalysis }>('strongBuy');
          if (!cancelled) {
            setStrongBuyRows(response.data.tickers);
            setStrongBuyOutliers(response.data.outliers);
          }
        } else if (activeView === 'data') {
          const [response, consolidation] = await Promise.all([fetchDataStatus(), fetchDataConsolidationJob()]);
          if (!cancelled) {
            setDataStatus(response);
            setDataConsolidationJob(consolidation.job);
          }
        } else if (activeView === 'research') {
          // Independent of the analysis fingerprint: this reads the Python
          // pipeline's report directory, which changes when run_analysis.py is
          // re-run, not when input JSON files change.
          const response = await fetchResearchReport();
          if (!cancelled) {
            setResearchReport(response);
            setResearchJob(response.job ?? null);
          }
        } else if (activeView === 'discovery') {
          const response = await fetchSignalDiscovery();
          if (!cancelled) setSignalDiscovery(response.data);
        } else if (isEtfView(activeView)) {
          if (activeView === 'etf-discovery') {
            const discoveryResponse = await fetchEtfSignalDiscovery();
            if (!cancelled) setEtfSignalDiscovery(discoveryResponse.data);
          } else {
            const researchResponse = await fetchResearchReport();
            if (!cancelled) {
              setResearchReport(researchResponse);
              setResearchJob(researchResponse.job ?? null);
            }
          }
        } else if (activeView === 'portfolio') {
          if (!cancelled) setLoading(false);
          return;
        } else if (activeView === 'accuracy') {
          const response = await fetchAnalysis<{ tickerAccuracy: TickerAccuracy[]; ratingCalls: RatingCallSummary; predictiveAccuracy: PredictiveAccuracySummary }>('accuracy', { horizon: accuracyHorizon });
          if (!cancelled) {
            setAccuracyRows(response.data.tickerAccuracy);
            setRatingCallSummary(response.data.ratingCalls);
            setPredictiveAccuracySummary(response.data.predictiveAccuracy);
            setSelectedAccuracyTicker((current) => (current && response.data.tickerAccuracy.some((row) => row.ticker === current) ? current : (response.data.tickerAccuracy[0]?.ticker ?? null)));
          }
        } else {
          const response = await fetchAnalysis<{
            cohortRows: CohortResult[];
            cohortTiers: Array<CohortResult['tier']>;
            tickerRows: TickerCohortResult[];
            winRates: TierWinRate[];
            correlation: ScoreCorrelation;
            windows: HistoryWindow[];
          }>('tiers');
          if (!cancelled) {
            setCohortRows(response.data.cohortRows);
            setCohortTiers(response.data.cohortTiers);
            setTickerCohortRows(response.data.tickerRows);
            setTierWinRates(response.data.winRates);
            setScoreCorrelation(response.data.correlation);
            setTierHistoryOptions(buildHistoryOptions(response.data.windows));
          }
        }
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void loadActiveView();
    return () => { cancelled = true; };
  }, [activeView, historyWindow, policy, fingerprint, accuracyHorizon]);

  useEffect(() => {
    if (activeView !== 'data' || dataConsolidationJob?.status !== 'running') return;
    let cancelled = false;
    const poll = window.setInterval(async () => {
      try {
        const { job } = await fetchDataConsolidationJob();
        if (cancelled || !job) return;
        setDataConsolidationJob(job);
        if (job.status !== 'running') {
          window.clearInterval(poll);
          if (job.dataStatus) setDataStatus(job.dataStatus);
          if (job.importSummary) setImportSummary(job.importSummary);
          if (job.status === 'failed') setImportError(job.error ?? job.message);
        }
      } catch (error) {
        if (!cancelled) setImportError(error instanceof Error ? error.message : String(error));
        window.clearInterval(poll);
      }
    }, 750);
    return () => { cancelled = true; window.clearInterval(poll); };
  }, [activeView, dataConsolidationJob?.id, dataConsolidationJob?.status]);

  const toggleMatrix = async (ticker: string) => {
    if (expandedTickers.has(ticker)) {
      setExpandedTickers((current) => { const next = new Set(current); next.delete(ticker); return next; });
      return;
    }
    setExpandedTickers((current) => new Set(current).add(ticker));
    if (!matrixResults.has(ticker)) {
      try {
        const response = await fetchAnalysis<Array<{ window: HistoryWindow; policy: SignalPolicy; result: TickerResult }>>('tickerMatrix', { ticker });
        const tickerResults = new Map(response.data.map((entry) => [matrixKey(entry.window, entry.policy), entry.result]));
        setMatrixResults((current) => new Map(current).set(ticker, tickerResults));
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error));
      }
    }
  };
  const openTickerDetails = async (ticker: string) => {
    setSelectedTicker(ticker);
    setSelectedResult(null);
    try {
      const response = await fetchAnalysis<TickerResult | null>('tickerDetail', { window: historyWindow, policy, ticker });
      setSelectedResult(response.data);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  };

  // The analysis runs as a server-side job, so the page polls until it lands and then reloads the
  // report. Polling stops as soon as the job leaves 'running' — no timer is left behind.
  const handleResearchRun = async () => {
    try {
      const started = await startResearchRun();
      setResearchJob(started.job);
      const poll = window.setInterval(async () => {
        try {
          const { job } = await fetchResearchJob();
          setResearchJob(job);
          if (job && job.status !== 'running') {
            window.clearInterval(poll);
            if (job.status === 'completed') setResearchReport(await fetchResearchReport());
          }
        } catch {
          window.clearInterval(poll);
        }
      }, 2000);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleImport = async () => {
    setImporting(true);
    setImportError(null);
    try {
      const response = await runDataImport();
      setImportSummary(response.summary);
      setDataStatus(response.status);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  };

  const handleConsolidate = async () => {
    setImportError(null);
    try { setDataConsolidationJob((await startDataConsolidation()).job); }
    catch (error) { setImportError(error instanceof Error ? error.message : String(error)); }
  };

  const resetFilters = () => {
    setHistoryWindow(DEFAULT_HISTORY_WINDOW);
    setPolicy(DEFAULT_POLICY);
    setSortKey(DEFAULT_SORT_KEY);
  };

  const selectView = (view: ActiveView) => {
    setActiveView(view);
    if (window.location.pathname !== routeForView(view)) window.history.pushState({ view }, '', routeForView(view));
    setSelectedTicker(null);
    setSelectedResult(null);
  };

  const runSignalDiscovery = async () => {
    setLoading(true);
    setLoadError(null);
    try { setSignalDiscovery((await fetchSignalDiscovery()).data); }
    catch (error) { setLoadError(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };

  const runEtfSignalDiscovery = async () => {
    setLoading(true);
    setLoadError(null);
    try { setEtfSignalDiscovery((await fetchEtfSignalDiscovery()).data); }
    catch (error) { setLoadError(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };

  const handleExport = () => {
    const exportRows = activeView === 'tickers' ? rows
      : activeView === 'overall' ? aggregateRows
        : activeView === 'strong-buy' ? strongBuyRows
          : activeView === 'accuracy' ? accuracyRows
            : activeView === 'research' ? (researchReport ? {
                available: researchReport.available,
                reason: researchReport.reason,
                meta: researchReport.meta,
                rows: researchReport.rows,
                concentration: researchReport.concentration,
                placebo: researchReport.placebo,
                bearish: researchReport.bearish,
              } : [])
            : isEtfView(activeView) ? (researchReport?.etf ?? [])
              : cohortRows;
    const blob = new Blob([JSON.stringify(exportRows, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = activeView === 'tickers' ? 'ticker-results.json'
      : activeView === 'overall' ? 'overall-results.json'
        : activeView === 'strong-buy' ? 'strong-buy-trust.json'
          : activeView === 'accuracy' ? 'rating-accuracy.json'
            : activeView === 'research' ? 'stock-research.json'
              : isEtfView(activeView) ? 'etf-research.json'
              : 'rating-tier-results.json';
    anchor.click();
    URL.revokeObjectURL(url);
    setExportLabel('Exported');
    window.setTimeout(() => setExportLabel('Export table'), 1400);
  };

  const handleEtfResearchExport = async () => {
    try {
      const reportPackage = await fetchEtfResearchExport();
      const blob = new Blob([JSON.stringify(reportPackage, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'etf-research-report-package.json';
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="app-shell">
      <header className="page-header">
        <div>
          <div className="eyebrow">Seeking Alpha research</div>
          <h1>{VIEW_COPY[activeView].title}</h1>
          <p>{VIEW_COPY[activeView].subtitle}</p>
        </div>
        {activeView !== 'portfolio' && activeView !== 'discovery' && activeView !== 'etfs' && <button className="primary-button" type="button" onClick={handleExport}>{exportLabel}</button>}
      </header>

      <nav className="section-nav" aria-label="Main areas">
        <button className={activeArea === 'etfs' ? 'nav-button active' : 'nav-button'} type="button" onClick={() => selectView('etf-discovery')}>ETFs</button>
        <button className={activeArea === 'data' ? 'nav-button active' : 'nav-button'} type="button" onClick={() => selectView('data')}>Data{dataStatus && dataStatus.pending > 0 ? <span className="nav-pill">{dataStatus.pending}</span> : null}</button>
      </nav>

      {activeArea === 'stocks' && <div className="archived-route-note">Single-stock analysis is archived from the visible workflow because its historical results were not reliable enough for the current ETF decision process.</div>}

      {activeArea === 'etfs' && <nav className="subsection-nav" aria-label="ETF workspace">
        <span className="subsection-label">ETFs</span>
        <button className={activeView === 'etf-discovery' ? 'subsection-button active' : 'subsection-button'} type="button" onClick={() => selectView('etf-discovery')}>Discover rules</button>
        <button className={activeView === 'etf-candidates' ? 'subsection-button active' : 'subsection-button'} type="button" onClick={() => selectView('etf-candidates')}>Current candidates</button>
        <button className={activeView === 'etf-research' ? 'subsection-button active' : 'subsection-button'} type="button" onClick={() => selectView('etf-research')}>Evidence &amp; diagnostics</button>
      </nav>}



      {loadError && <div className="data-status data-error">Could not load fresh analysis: {loadError}</div>}
      {loading && activeView !== 'data' && (
        <LoadingState
          label={activeView === 'research' || isEtfView(activeView) ? 'Loading research results' : 'Loading analysis table'}
          detail="Reading the local database and calculating the selected view."
        />
      )}

      {activeView === 'portfolio' ? (
        <PortfolioBacktestView />
      ) : isEtfView(activeView) ? (
        <EtfHubView section={activeView === 'etf-candidates' ? 'candidates' : activeView === 'etf-research' ? 'research' : activeView === 'etf-discovery' ? 'discovery' : 'all'} discovery={etfSignalDiscovery} researchReport={researchReport} researchJob={researchJob} onRunDiscovery={() => void runEtfSignalDiscovery()} onRunResearch={() => void handleResearchRun()} onExportResearch={() => void handleEtfResearchExport()} />
      ) : activeView === 'discovery' ? (
        <SignalDiscoveryView result={signalDiscovery} onRun={() => void runSignalDiscovery()} universe="stocks" />
      ) : activeView === 'data' ? (
        <DataView status={dataStatus} importing={importing} consolidationJob={dataConsolidationJob} lastSummary={importSummary ?? dataStatus?.lastImport ?? null} onImport={() => void handleImport()} onConsolidate={() => void handleConsolidate()} error={importError} />
      ) : activeView === 'tickers' ? (
        <>
      <LegendPanel
        title="How to read stock results"
        items={[
          { term: 'Long', meaning: 'A normal buy position: you profit if the stock goes up.' },
          { term: 'Short', meaning: 'A sell-first position: you profit if the stock goes down.' },
          { term: 'Exit on Hold', meaning: 'Sell when the rating falls to Hold or any Sell rating.' },
          { term: 'Hold through Hold', meaning: 'Keep the position while the rating is Hold; exit only on Sell.' },
          { term: 'Buy & hold', meaning: 'A simple benchmark: buy once and do nothing else.' },
        ]}
      />
      <section className="toolbar" aria-label="Table controls">
        <div className="field">
          <label htmlFor="horizon">Signal history</label>
          <select id="horizon" value={historyWindow} onChange={(event) => setHistoryWindow(event.target.value as HistoryWindow)}>
            {historyOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="policy">Signal policy</label>
          <select id="policy" value={policy} onChange={(event) => setPolicy(event.target.value as SignalPolicy)}>
            {policyOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sort">Sort rows by</label>
          <select id="sort" value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}>
            <option value="hitRate">Hit rate</option>
            <option value="averageReturn">Average return</option>
            <option value="signals">Signals</option>
            <option value="ticker">Ticker</option>
          </select>
        </div>
        <button className="reset-button" type="button" onClick={resetFilters} disabled={historyWindow === DEFAULT_HISTORY_WINDOW && policy === DEFAULT_POLICY && sortKey === DEFAULT_SORT_KEY}>Reset filters</button>
        <div className="toolbar-count">{rows.length} {rows.length === 1 ? 'ticker' : 'tickers'} · {rows.reduce((total, row) => total + row.signals, 0).toLocaleString()} eligible signals</div>
      </section>

      {!hasAnyBenchmark && (
        <div className="benchmark-hint">
          No buy-and-hold benchmark data cached yet. Run <code>npm run fetch:benchmark</code> in <code>backtest/</code> once to pull real daily prices (Yahoo Finance, cached locally — no repeated network calls).
        </div>
      )}

      <section className="table-panel" aria-labelledby="results-title">
        <div className="table-heading">
          <div><h2 id="results-title">Backtest by ticker</h2><p>{windowLabel} · {policyLabels[policy]}</p></div>
          <span className="data-badge">{rows.length} {rows.length === 1 ? 'row' : 'rows'} loaded</span>
        </div>
        <div className="table-scroll">
          <table className="results-table">
            <thead><tr><th title="The stock symbol, for example ATI.">Ticker</th><th className="number" title="How many rating signals were tested for this stock.">Signals</th><th title="The most recent rating in the captured data.">Latest rating</th><th className="number" title="The percentage of tested signals that were correct. Example: 60% means 6 out of 10.">Hit rate</th><th className="number" title="The average return from one completed signal.">Avg return</th><th className="number" title="The middle return when all signal returns are sorted.">Median return</th><th className="number" title="What $100 would become if the strategy were followed.">Growth of $100</th><th className="number" title="What $100 would become by simply holding the stock.">Buy &amp; hold</th><th className="number" title="How many times the stock's rating changed.">Rating changes</th><th title="The first and last dates included in the test.">Date range</th><th className="actions-heading" title="Open the strategy comparison or full stock details.">Actions</th></tr></thead>
            <tbody>
              {rows.map((row) => {
                const matrixOpen = expandedTickers.has(row.ticker);
                const tickerMatrix = matrixResults.get(row.ticker);
                const matrixEndingValues = tickerMatrix
                  ? [...tickerMatrix.values()].map((result) => Number(result.detail.endingValue.toFixed(2)))
                  : [];
                const bestEndingValue = matrixEndingValues.length ? Math.max(...matrixEndingValues) : null;
                const worstEndingValue = matrixEndingValues.length ? Math.min(...matrixEndingValues) : null;
                return (
                  <Fragment key={row.ticker}>
                    <tr className={matrixOpen ? 'ticker-row matrix-open' : 'ticker-row'}>
                      <td><span className="ticker">{row.ticker}</span><span className="company">{row.company}</span></td>
                      <td className="number">{row.signals.toLocaleString()}</td>
                      <td><span className={ratingClass(row.latestRating)}>{row.latestRating}</span></td>
                      <td className={`number ${row.hitRate >= 50 ? 'positive' : 'negative'}`}>{row.hitRate.toFixed(1)}%</td>
                      <td className={`number ${row.averageReturn >= 0 ? 'positive' : 'negative'}`}>{signedPercent(row.averageReturn)}</td>
                      <td className={`number ${row.medianReturn >= 0 ? 'positive' : 'negative'}`}>{signedPercent(row.medianReturn)}</td>
                      <td className={`number ${row.detail.totalReturn >= 0 ? 'positive' : 'negative'}`}>${row.detail.endingValue.toFixed(2)}</td>
                      <td className={`number ${row.detail.benchmark.available ? (row.detail.benchmark.totalReturn >= 0 ? 'positive' : 'negative') : 'muted'}`}>
                        {row.detail.benchmark.available ? `$${row.detail.benchmark.endingValue.toFixed(2)}` : 'Not fetched'}
                      </td>
                      <td className="number">{row.ratingChanges.toLocaleString()}</td>
                      <td className="muted">{row.dateRange}</td>
                      <td>
                        <div className="row-actions">
                          <button className={matrixOpen ? 'icon-button active' : 'icon-button'} type="button" aria-label={`${matrixOpen ? 'Collapse' : 'Expand'} ${row.ticker} strategy matrix`} aria-expanded={matrixOpen} onClick={() => toggleMatrix(row.ticker)}>
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM4 10h16M9 5v14M14 5v14" /></svg>
                            <svg className={matrixOpen ? 'chevron rotated' : 'chevron'} viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4" /></svg>
                          </button>
                          <button className="icon-button" type="button" aria-label={`Open ${row.ticker} full details`} onClick={() => void openTickerDetails(row.ticker)}>
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4zM14 4v16M7 8h4M7 12h4M7 16h4" /></svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                    {matrixOpen && (
                      <tr className="strategy-matrix-row">
                        <td colSpan={12}>
                          <div className="strategy-matrix-wrap">
                            <div className="strategy-matrix-heading"><strong>{row.ticker} · all strategy combinations</strong><span><i className="matrix-legend-best" />Best result <i className="matrix-legend-worst" />Worst result</span></div>
                            <div className="strategy-matrix-scroll">
                              <table className="strategy-matrix" style={{ minWidth: `${155 + (historyOptions.length * 130)}px` }} aria-label={`${row.ticker} signal history and policy comparison`}>
                                <thead><tr><th title="The rule used to enter, hold, or exit a position.">Signal policy</th>{historyOptions.map((option) => <th key={option.value} title="The selected history length, for example 7 days or 12 months.">{option.shortLabel}</th>)}</tr></thead>
                                <tbody>
                                  <tr className="matrix-benchmark-row">
                                    <th title="The passive benchmark: buy once and hold, without using ratings.">Buy &amp; hold<small>Real closing price, no rating</small></th>
                                    {historyOptions.map((historyOption) => {
                                      const referenceResult = tickerMatrix?.get(matrixKey(historyOption.value, 'long-exit-hold'));
                                      const benchmark = referenceResult?.detail.benchmark;
                                      return (
                                        <td key={historyOption.value} className="matrix-benchmark-cell">
                                          {benchmark?.available ? (
                                            <>
                                              <strong className={benchmark.totalReturn >= 0 ? 'positive' : 'negative'}>${benchmark.endingValue.toFixed(2)}</strong>
                                              <span>{signedPercent(benchmark.totalReturn)}</span>
                                            </>
                                          ) : <span className="muted">Not fetched</span>}
                                        </td>
                                      );
                                    })}
                                  </tr>
                                  {policyOptions.map((policyOption) => (
                                    <tr key={policyOption.value}>
                                      <th title="The specific buy, hold, and exit rule being compared.">{policyOption.shortLabel}<small>{policyOption.label}</small></th>
                                      {historyOptions.map((historyOption) => {
                                        const result = tickerMatrix?.get(matrixKey(historyOption.value, policyOption.value));
                                        if (!result) return <td key={historyOption.value} className="matrix-empty">No data</td>;
                                        const displayedEndingValue = Number(result.detail.endingValue.toFixed(2));
                                        const isBest = displayedEndingValue === bestEndingValue;
                                        const isWorst = displayedEndingValue === worstEndingValue;
                                        return (
                                          <td key={historyOption.value} className={`${isBest ? 'matrix-best' : ''} ${isWorst ? 'matrix-worst' : ''}`.trim() || undefined}>
                                            {(isBest || isWorst) && <div className="matrix-statuses">{isBest && <em className="matrix-status best">Best</em>}{isWorst && <em className="matrix-status worst">Worst</em>}</div>}
                                            <strong className={result.detail.totalReturn >= 0 ? 'positive' : 'negative'}>${result.detail.endingValue.toFixed(2)}</strong>
                                            <span>{signedPercent(result.detail.totalReturn)} · {result.hitRate.toFixed(1)}% hit</span>
                                            <small>{result.signals.toLocaleString()} signals</small>
                                          </td>
                                        );
                                      })}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <footer className="table-footer"><span>Use the matrix icon to compare all {historyOptions.length * policyOptions.length} combinations · use the panel icon for full details</span><span>Input folder: ./input · Buy &amp; hold benchmark: ./benchmark (Yahoo Finance, cached — run npm run fetch:benchmark to refresh)</span></footer>
      </section>
        </>
      ) : activeView === 'overall' ? (
        <OverallResultsTable rows={aggregateRows} historyOptions={historyOptions} />
      ) : activeView === 'strong-buy' ? (
        <StrongBuyTrustView key={fingerprint} rows={strongBuyRows} outliers={strongBuyOutliers} />
      ) : activeView === 'research' ? (
        <ResearchView report={researchReport} job={researchJob} onRun={() => void handleResearchRun()} scope="stocks" />
      ) : activeView === 'tiers' ? (
        <>
          <ScoreCorrelationChart correlation={scoreCorrelation} />
          <TierWinRateSummary rows={tierWinRates} />
          <RatingTierTable rows={cohortRows} tiers={cohortTiers} historyOptions={tierHistoryOptions} />
          <TickerCohortTable results={tickerCohortRows} historyOptions={tierHistoryOptions} />
        </>
      ) : (
        <TickerAccuracyView
          rows={accuracyRows}
          horizonDays={accuracyHorizon}
          horizonOptions={accuracyHorizonOptions}
          selectedTicker={selectedAccuracyTicker}
          onSelectTicker={setSelectedAccuracyTicker}
          onHorizonChange={setAccuracyHorizon}
          ratingCallSummary={ratingCallSummary}
          predictiveAccuracySummary={predictiveAccuracySummary}
          methodology={methodology}
        />
      )}

      {selectedResult && activeView === 'tickers' && (
        <aside className="detail-panel" aria-label={`${selectedResult.ticker} strategy replay details`}>
          <header className="detail-header">
            <div><div className="eyebrow">Strategy replay</div><h2>{selectedResult.ticker} · {selectedResult.company}</h2><p>{selectedResult.dateRange} · {policyLabels[policy]}</p></div>
            <button className="close-button" type="button" aria-label="Close details" onClick={() => { setSelectedTicker(null); setSelectedResult(null); }}>×</button>
          </header>

          <section className="detail-summary">
            <div><span>Starting value</span><strong>${selectedResult.detail.startingValue.toFixed(2)}</strong></div>
            <div><span>Ending value</span><strong className={selectedResult.detail.totalReturn >= 0 ? 'positive' : 'negative'}>${selectedResult.detail.endingValue.toFixed(2)}</strong></div>
            <div><span>Total return</span><strong className={selectedResult.detail.totalReturn >= 0 ? 'positive' : 'negative'}>{signedPercent(selectedResult.detail.totalReturn)}</strong></div>
            <div><span>Position</span><strong>{selectedResult.detail.positionStatus}</strong>{selectedResult.detail.openTradeReturn !== null && <small className={selectedResult.detail.openTradeReturn >= 0 ? 'positive' : 'negative'}>{signedPercent(selectedResult.detail.openTradeReturn)} unrealized</small>}</div>
            <div>
              <span>Buy &amp; hold</span>
              {selectedResult.detail.benchmark.available ? (
                <>
                  <strong className={selectedResult.detail.benchmark.totalReturn >= 0 ? 'positive' : 'negative'}>${selectedResult.detail.benchmark.endingValue.toFixed(2)}</strong>
                  <small>{signedPercent(selectedResult.detail.benchmark.totalReturn)} · real price, same window</small>
                </>
              ) : <strong className="muted">Not fetched</strong>}
            </div>
          </section>

          <section className="detail-section">
            <div className="section-title"><h3>Replay rule</h3><span>{selectedResult.detail.entries} entries · {selectedResult.detail.exits} exits</span></div>
            <div className="rule-box"><span>Enter</span><strong>{policy === 'long-short' ? 'Buy bullish ratings; short bearish ratings' : 'Buy once on Buy / Strong Buy'}</strong><span>Exit</span><strong>{policyExitRules[policy]}</strong></div>
          </section>

          <section className="detail-section">
            <div className="section-title"><h3>Rating distribution</h3><span>{selectedResult.detail.capturedDays} captured days</span></div>
            <div className="distribution-list">{selectedResult.detail.ratingDistribution.map((item) => <div className="distribution-row" key={item.rating}><span>{item.rating}</span><div><i style={{ width: `${(item.days / selectedResult.detail.capturedDays) * 100}%` }} /></div><strong>{item.days}</strong></div>)}</div>
          </section>

          <section className="detail-section">
            <div className="section-title"><h3>All decisions</h3><span>{selectedResult.detail.events.length} decisions</span></div>
            <div className="event-list">
              <div className="event-list-header"><span>Change</span><span>Decision</span><span>Price</span><span>Exit return</span></div>
              {selectedResult.detail.events.map((event, index) => <article className="event-row" key={`${event.date}-${event.decision}-${index}`}><div><time>{event.date}</time><strong>{event.change}</strong></div><span className={`event-action ${event.decision === 'Exit' || event.decision === 'Cover' ? 'exit' : event.decision === 'Buy once' || event.decision === 'Short once' ? 'buy' : 'none'}`}>{event.decision}</span><b>${event.price.toFixed(2)}</b><b className={event.tradeReturn === null ? 'muted' : event.tradeReturn >= 0 ? 'positive' : 'negative'}>{event.tradeReturn === null ? '—' : signedPercent(event.tradeReturn)}</b></article>)}
            </div>
          </section>

          <footer className="detail-footer"><span>Current price ${selectedResult.detail.currentPrice.toFixed(2)} · Quant score {selectedResult.detail.quantScore.toFixed(2)}</span><span>{selectedResult.detail.sourceFile}</span><span>Captured {selectedResult.detail.capturedAt}</span></footer>
        </aside>
      )}
    </div>
  );
}

export default App;
