import type { EtfBasketAnalysis, EtfCheckResult, HistoryWindow, MethodologyConfig, PortfolioBacktestResult, PortfolioConfig, PortfolioHoldoutValidationResult, PortfolioSearchResult, Rating, SignalDiscoveryResult, SignalPolicy } from './data';

export type AnalysisMeta = {
  fingerprint: string;
  // The persisted analysis_runs.id this fingerprint's results were (or are being) written under,
  // if the local SQLite persistence layer is available; null only if that write failed.
  runId: number | null;
  windows: HistoryWindow[];
  tiers: Rating[];
  accuracyHorizons: number[];
  methodology: MethodologyConfig;
};

type AnalysisResponse<T> = {
  data: T;
  fingerprint: string;
};

const request = async <T>(params: URLSearchParams): Promise<T> => {
  const response = await fetch(`/api/analysis?${params.toString()}`, { cache: 'no-store' });
  const payload = await response.json() as unknown;
  const errorMessage = typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string' ? payload.error : null;
  if (!response.ok) throw new Error(errorMessage ?? `Analysis request failed (${response.status})`);
  return payload as T;
};

// ---------------------------------------------------------------------------
// Research report (/api/research) — the Python pipeline's output in research/.
// Typed here rather than in data.ts because none of it is produced by data.ts:
// it comes off flat files written by run_analysis.py, and the two analyses are
// deliberately independent of each other.
// ---------------------------------------------------------------------------
export type ResearchRow = {
  lookback: string;
  hold: string;
  floor: string;
  dipTolerance: string;
  testable: boolean;
  discoveredRule: boolean;
  mean: number | null;
  t: number | null;
  p: number | null;
  holmP: number | null;
  bhP: number | null;
  n: number;
  tickers: number;
  // Plain-outcome fields, so a dollar figure never has to be reconstructed in
  // the UI from an excess return. All are fractions (0.2134 = +21.34%).
  meanReturn: number | null;
  medianReturn: number | null;
  meanSpyReturn: number | null;
  winRateVsSpy: number | null;
  winRateAbsolute: number | null;
  returnCiLow: number | null;
  returnCiHigh: number | null;
  excessCiLow: number | null;
  excessCiHigh: number | null;
};

export type ResearchConcentrationRow = {
  topK: number;
  percentOfTotal: number | null;
  meanExcluding: number | null;
};

export type ResearchPlacebo = {
  observed_mean?: number | null;
  random_median?: number | null;
  random_p5?: number | null;
  random_p95?: number | null;
  empirical_p?: number | null;
};

export type BearishResearchRow = {
  family: 'transition' | 'persistence';
  lookback: string | null;
  hold: string;
  signal: 'sell_or_strong_sell' | 'strong_sell_only';
  outcome: 'raw_short' | 'spy_hedged_short';
  candidateSignals: number;
  incompleteTrades: number;
  overlapSkipped: number;
  dropReasons: Record<string, number>;
  testable: boolean;
  discoveredRule: boolean;
  mean: number | null;
  median: number | null;
  positiveRate: number | null;
  stockFellRate: number | null;
  underperformedSpyRate: number | null;
  t: number | null;
  p: number | null;
  holmP: number | null;
  bhP: number | null;
  n: number;
  tickers: number;
  ciLow: number | null;
  ciHigh: number | null;
};

export type BearishConcentrationRow = {
  topK: number;
  percentOfTotal: number | null;
  meanExcluding: number | null;
};

export type BearishFamilyMeta = {
  correction_scope: number;
  lookbacks?: string[];
  holds: string[];
  signals: string[];
  outcomes: string[];
  summary: { tests_total: number; tests_testable: number; tests_clearing_bar: number };
  top_candidate: (BearishResearchRow & { placebo?: ResearchPlacebo | null }) | null;
};

export type BearishResearchMeta = {
  generated_at: string;
  spec: string;
  prior_exploratory_evidence_known: boolean;
  dataset: ResearchMeta['dataset'];
  universe_audit: {
    global_end: string;
    stale_days: number;
    tickers_total: number;
    early_end_count: number;
    early_end_tickers: Array<{ ticker: string; last_date: string }>;
    likely_fixture_tickers: string[];
    real_early_end_count: number;
  };
  thresholds: ResearchMeta['thresholds'];
  execution: Record<string, string>;
  families: { transition: BearishFamilyMeta; persistence: BearishFamilyMeta };
};

export type BearishResearchReport = {
  available: boolean;
  meta: BearishResearchMeta | null;
  transitionRows: BearishResearchRow[];
  persistenceRows: BearishResearchRow[];
  transitionConcentration: BearishConcentrationRow[];
  persistenceConcentration: BearishConcentrationRow[];
  transitionPlacebo: ResearchPlacebo | null;
  persistencePlacebo: ResearchPlacebo | null;
};

export type EtfResearchRow = {
  family: 'rating_trust' | 'persistence';
  filter: 'strong_buy' | 'bullish_plus';
  persistence: string | null;
  hold: string;
  candidateSignals: number;
  incompleteTrades: number;
  dropReasons: Record<string, number>;
  outcome: 'bhar' | 'excess_pool';
  testable: boolean;
  discoveredRule: boolean;
  meanReturn: number | null;
  medianReturn: number | null;
  meanSpyReturn: number | null;
  meanExcessSpy: number | null;
  beatSpyRate: number | null;
  meanPoolReturn: number | null;
  meanExcessPool: number | null;
  beatPoolRate: number | null;
  /** Fraction of trades where the ETF's own return was negative, independent of SPY/pool. */
  absoluteLossRate: number | null;
  mean: number | null;
  t: number | null;
  p: number | null;
  holmP: number | null;
  bhP: number | null;
  n: number;
  tickers: number;
  ciLow: number | null;
  ciHigh: number | null;
};

export type EtfResearchDiagnostic = {
  filter: EtfResearchRow['filter'];
  persistence: string | null;
  hold: string;
  topK: number;
  percentOfTotal: number | null;
  meanExcluding: number | null;
};

export type EtfResearchPlacebo = ResearchPlacebo & {
  filter: EtfResearchRow['filter'];
  persistence: string | null;
  hold: string;
  simulations: number;
};

export type EtfResearchFamilyMeta = {
  question: string;
  benchmark: string;
  correction_scope: number;
  filters: string[];
  persistence?: string[];
  holds: string[];
  summary: {
    tests_total: number;
    tests_testable: number;
    tests_clearing_bar: number;
    positive_tests_clearing_bar: number;
    negative_tests_clearing_bar: number;
  };
  top_candidate: (EtfResearchRow & { placebo: ResearchPlacebo | null; examples: EtfTradeExample[] }) | null;
};

export type EtfTradeExample = {
  ticker: string;
  signal_date: string;
  buy_date: string;
  sell_date: string;
  days_held: number;
  buy_price: number;
  sell_price: number;
  etf_return: number;
  spy_return: number;
  excess_spy: number;
  dollar_start: number;
  dollar_end: number;
};

export type EtfResearchMeta = {
  generated_at: string;
  spec: string;
  prior_exploratory_evidence_known: boolean;
  dataset: {
    etfs: number; price_rows: number; rating_events: number;
    price_start: string; price_end: string; validation_start: string; validation_end: string;
  };
  thresholds: ResearchMeta['thresholds'];
  execution: Record<string, string>;
  families: { rating_trust: EtfResearchFamilyMeta; persistence: EtfResearchFamilyMeta };
};

export type EtfResearchReport = {
  available: boolean;
  meta: EtfResearchMeta | null;
  ratingRows: EtfResearchRow[];
  persistenceRows: EtfResearchRow[];
  ratingConcentration: EtfResearchDiagnostic[];
  persistenceConcentration: EtfResearchDiagnostic[];
  ratingPlacebos: EtfResearchPlacebo[];
  persistencePlacebos: EtfResearchPlacebo[];
};

// Thresholds and grid come from the run itself (run_meta.json, written by
// run_analysis.py from pipeline.py's constants) so the page can never display
// a bar that differs from the one the displayed results were judged against.
export type ResearchMeta = {
  generated_at: string;
  input_path: string;
  spy_path: string;
  dataset: {
    tickers: number; price_rows: number; rating_events: number;
    price_start: string; price_end: string;
    spy_start: string; spy_end: string; spy_days: number;
  };
  thresholds: { min_clusters: number; discovery_t: number; alpha: number; bootstrap_reps: number };
  grid: { lookbacks: string[]; holds: string[]; floors: string[]; dip_tolerances: string[] };
  summary: { cuts_total: number; cuts_testable: number; discovered_rules: number };
  top_candidate: (ResearchRow & { placebo?: ResearchPlacebo; placebo_sims?: number }) | null;
};

export type ResearchJob = {
  id: number;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  log: string;
};

export type ResearchStatus = {
  currentDataVersion: number;
  reportDataVersion: number | null;
  current: boolean;
};

export type ResearchReport = {
  available: boolean;
  reason?: string;
  job?: ResearchJob | null;
  meta: ResearchMeta | null;
  rows: ResearchRow[];
  concentration: ResearchConcentrationRow[];
  placebo: ResearchPlacebo | null;
  bearish: BearishResearchReport;
  etf: EtfResearchReport;
  researchStatus?: ResearchStatus;
};

export const startResearchRun = () =>
  dataRequest<{ job: ResearchJob }>('/api/research/run', { method: 'POST' });
export const fetchResearchJob = () => dataRequest<{ job: ResearchJob | null }>('/api/research/job');
export const fetchEtfResearchExport = () => dataRequest<Record<string, unknown>>('/api/research/export');

export const fetchResearchReport = async (): Promise<ResearchReport> => {
  const response = await fetch('/api/research', { cache: 'no-store' });
  const payload = await response.json() as ResearchReport & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Research request failed (${response.status})`);
  return payload;
};

// ---------------------------------------------------------------------------
// Ingestion (/api/data) — the input folder versus the database.
// ---------------------------------------------------------------------------
export type DataFileReport = {
  relPath: string;
  status: 'new' | 'changed' | 'imported' | 'failed';
  kind: 'capture' | 'api_prices' | 'api_changes' | 'bundle' | 'benchmark' | 'unknown';
  bytes: number;
  priceRows: number;
  ratingRows: number;
  quantRows: number;
  benchmarkRows: number;
  importedAt: string | null;
  error: string | null;
};

export type ImportSummary = {
  startedAt: string; finishedAt: string; elapsedMs: number;
  filesScanned: number; filesImported: number; filesFailed: number; filesUnchanged: number;
  filesMissing: string[];
  priceRows: number; ratingRows: number; quantRows: number; benchmarkRows: number;
  dataVersion: number;
};

export type DataStatus = {
  files: DataFileReport[];
  missing: string[];
  recentProcessedSymbols: Array<{
    slug: string;
    symbol: string;
    fundType: string | null;
    processedAt: string;
    kinds: string[];
  }>;
  counts: {
    tickers: number; priceRows: number; ratingRows: number; quantRows: number;
    benchmarkRows: number; priceStart: string | null; priceEnd: string | null;
  };
  dataVersion: number;
  updatedAt: string;
  lastImport: ImportSummary | null;
  pending: number;
};

export type DataConsolidationSummary = {
  generatedAt: string;
  uniqueTickers: number;
  etfTickers: number;
  mergedDataRows: number;
  rawFilesArchived: string[];
  archiveFile: string | null;
  removedSourceFiles: string[];
  outputBytes: number;
  verified: boolean;
  payloadsWithNoUsableUpstreamData: string[];
};

export type DataConsolidationJob = {
  id: number;
  status: 'running' | 'completed' | 'failed';
  stage: string;
  message: string;
  progress: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  summary: DataConsolidationSummary | null;
  importSummary: ImportSummary | null;
  dataStatus: DataStatus | null;
};

const dataRequest = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, { cache: 'no-store', ...init });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
};

export const fetchDataStatus = () => dataRequest<DataStatus>('/api/data/status');
export const runDataImport = () =>
  dataRequest<{ summary: ImportSummary; status: DataStatus }>('/api/data/import', { method: 'POST' });
// Same permanent writer as the Data page's Import button (server/db/ingest.ts writeParsed) --
// files picked here become part of the shared database, not a separate/ephemeral check.
export const uploadEtfFiles = (files: Array<{ name: string; content: string }>) =>
  dataRequest<{ summary: ImportSummary; status: DataStatus }>('/api/data/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  });
export const startDataConsolidation = () =>
  dataRequest<{ job: DataConsolidationJob }>('/api/data/consolidate', { method: 'POST' });
export const fetchDataConsolidationJob = () =>
  dataRequest<{ job: DataConsolidationJob | null }>('/api/data/consolidate/job');

export const fetchAnalysisMeta = () => request<AnalysisMeta>(new URLSearchParams({ action: 'meta' }));
export const fetchSignalDiscovery = () => request<AnalysisResponse<SignalDiscoveryResult>>(new URLSearchParams({ action: 'signalDiscovery' }));
export const fetchEtfSignalDiscovery = () => request<AnalysisResponse<SignalDiscoveryResult>>(new URLSearchParams({ action: 'etfSignalDiscovery' }));
// Empty tickers = every ETF in the database. A comma-separated list checks only those tickers,
// used right after an upload so the page doesn't have to wait on/filter the full universe.
export const fetchEtfCheck = (tickers: string[] = []) =>
  request<AnalysisResponse<EtfCheckResult[]>>(new URLSearchParams(tickers.length ? { action: 'etfCheck', tickers: tickers.join(',') } : { action: 'etfCheck' }));
export const fetchEtfBasketAnalysis = (tickers: string[], horizonDays: number, basketSize: number) =>
  request<AnalysisResponse<EtfBasketAnalysis>>(new URLSearchParams({
    action: 'etfBasket', tickers: tickers.join(','), horizon: String(horizonDays), basketSize: String(basketSize),
  }));

export const fetchAnalysis = <T>(action: string, options: { window?: HistoryWindow; policy?: SignalPolicy; ticker?: string; horizon?: number } = {}) => {
  const params = new URLSearchParams({ action });
  if (options.window) params.set('window', options.window);
  if (options.policy) params.set('policy', options.policy);
  if (options.ticker) params.set('ticker', options.ticker);
  if (options.horizon) params.set('horizon', String(options.horizon));
  return request<AnalysisResponse<T>>(params);
};

export const fetchPortfolioBacktest = (config: PortfolioConfig) => {
  const params = new URLSearchParams({ action: 'portfolio', config: JSON.stringify(config) });
  return request<AnalysisResponse<PortfolioBacktestResult>>(params);
};

// The sell rule and maximum hold are part of the searched grid now, so the caller supplies only
// the date range — passing them in would have silently fixed two of the dimensions being searched.
export const fetchBestPortfolioBacktests = (
  config: Omit<PortfolioConfig, 'portfolioSize' | 'ratingFilter' | 'rebalance' | 'weighting' | 'exitOnRatingDrop' | 'maxHoldDays'>,
) => {
  const params = new URLSearchParams({ action: 'portfolioBest', config: JSON.stringify(config) });
  return request<AnalysisResponse<PortfolioSearchResult>>(params);
};

export const fetchPortfolioHoldoutValidation = (
  config: Omit<PortfolioConfig, 'portfolioSize' | 'ratingFilter' | 'rebalance' | 'weighting' | 'exitOnRatingDrop' | 'maxHoldDays'>,
  options: { repetitions?: number; holdoutFraction?: number; seed?: number } = {},
) => {
  const params = new URLSearchParams({ action: 'portfolioValidate', config: JSON.stringify({ ...config, ...options }) });
  return request<AnalysisResponse<PortfolioHoldoutValidationResult>>(params);
};
