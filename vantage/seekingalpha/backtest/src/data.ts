export type Rating = 'Strong Buy' | 'Buy' | 'Hold' | 'Sell' | 'Strong Sell';
export type SignalPolicy = 'long-exit-hold' | 'long-hold-through' | 'long-short';
export type HistoryWindow = '7d' | `${number}m` | 'all';

type Position = 'cash' | 'long' | 'short';

type CaptureRecord = {
  date: string;
  price: number;
  quantRating: Rating;
  quantScore: number;
};

type Capture = {
  capturedAt: string;
  source: {
    ticker: string;
    companyName: string;
    currentPrice: number;
    quantRating: Rating;
    quantScore: number;
    fundType: string | null;
    sector: string | null;
  };
  quantRatingHistory: { records: CaptureRecord[] };
};

type CaptureDataset = {
  capture: Capture;
  sourceFile: string;
  records: CaptureRecord[];
  // How this ticker's own prices should be treated.
  //   'adjusted' — reconstructed from the API price feed, already split/dividend adjusted, so the
  //                dataset's own prices can be used directly for a buy-and-hold return.
  //   'capture'  — a scraped daily snapshot whose adjustment basis is unconfirmed (see
  //                progress.md), so returns must come from the separately cached Yahoo closes.
  // This used to be inferred from whether sourceFile started with "3-year/" — a string check that
  // silently changed meaning the moment the loader changed.
  priceBasis: 'adjusted' | 'capture';
};

export type BenchmarkQuote = { date: string; close: number; adjClose: number };

type BenchmarkFile = {
  ticker: string;
  currency: string;
  source: string;
  fetchedAt: string;
  records: BenchmarkQuote[];
};

export type BenchmarkResult = {
  available: boolean;
  startingValue: number;
  endingValue: number;
  totalReturn: number;
  startDate: string | null;
  endDate: string | null;
};

export type ReplayEvent = {
  date: string;
  change: string;
  decision: 'Buy once' | 'Exit' | 'Short once' | 'Cover' | 'Stay invested' | 'Stay short' | 'Stay in cash';
  price: number;
  portfolioValue: number;
  tradeReturn: number | null;
};

export type TickerResult = {
  ticker: string;
  company: string;
  signals: number;
  latestRating: Rating;
  hitRate: number;
  averageReturn: number;
  medianReturn: number;
  ratingChanges: number;
  coverage: 'Complete' | 'Partial';
  dateRange: string;
  detail: {
    startingValue: number;
    endingValue: number;
    totalReturn: number;
    positionStatus: 'Open long' | 'Open short' | 'Closed';
    openTradeReturn: number | null;
    entries: number;
    exits: number;
    currentPrice: number;
    quantScore: number;
    capturedAt: string;
    sourceFile: string;
    capturedDays: number;
    ratingDistribution: Array<{ rating: Rating; days: number }>;
    events: ReplayEvent[];
    benchmark: BenchmarkResult;
  };
};

export type AggregateResult = {
  window: HistoryWindow;
  policy: SignalPolicy;
  tickersTested: number;
  totalTickers: number;
  beatBenchmarkCount: number;
  beatBenchmarkRate: number;
  averageExtraReturn: number;
  medianExtraReturn: number;
  averageStrategyReturn: number;
  averageBenchmarkReturn: number;
  confidence: 'Low' | 'Medium' | 'High';
  verdict: 'Good' | 'Mixed' | 'Poor' | 'Not enough data';
};

export type StrongBuyTrade = {
  entryDate: string;
  entryPrice: number;
  exitDate: string | null;
  exitPrice: number | null;
  exitRating: Rating | null;
  returnPercent: number;
  marketReturnPercent: number | null;
  excessReturnPercent: number | null;
  marketAdjusted: boolean;
  status: 'Completed' | 'Open';
};

export type StrongBuyTrustResult = {
  ticker: string;
  company: string;
  completedTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  averageTradeReturn: number | null;
  medianTradeReturn: number | null;
  endingValue: number;
  totalReturn: number;
  openTradeReturn: number | null;
  dateRange: string;
  trades: StrongBuyTrade[];
};

export type StrongBuyOutlierAnalysis = {
  completedTrades: number;
  tickers: number;
  rawMeanReturn: number | null;
  medianReturn: number | null;
  trimmedMeanReturn: number | null;
  winsorizedMeanReturn: number | null;
  geometricMeanReturn: number | null;
  largestWinnerReturn: number | null;
  largestLoserReturn: number | null;
  top1PercentContributionPercent: number | null;
  top5PercentContributionPercent: number | null;
  top10PercentContributionPercent: number | null;
  leaveOneTickerOutMinMeanReturn: number | null;
  leaveOneTickerOutMaxMeanReturn: number | null;
  outlierSensitive: boolean;
  outlierSensitiveReasons: string[];
};

export const policyLabels: Record<SignalPolicy, string> = {
  'long-exit-hold': 'Long-only · Exit on Hold',
  'long-hold-through': 'Long-only · Hold through Hold',
  'long-short': 'Long-short · Sell ratings short',
};

export const policyExitRules: Record<SignalPolicy, string> = {
  'long-exit-hold': 'Exit when rating falls to Hold, Sell, or Strong Sell',
  'long-hold-through': 'Keep the position through Hold; exit on Sell or Strong Sell',
  'long-short': 'Exit to cash on Hold; short on Sell or Strong Sell',
};

// --- Data source -----------------------------------------------------------------------------
// Everything below used to be read from disk here, at module load, through three separate
// import.meta.glob calls. It now arrives from the database via initialiseDatasets(), called by the
// server before any build function runs (see vite.config.ts). Three consequences worth knowing:
//
//   1. There is one ticker universe, not three. Ticker results and Overall used to see only the 27
//      hand-curated captures while Rating accuracy, Strong Buy and Rating tiers saw 187 — an
//      accident of which glob each function happened to reference. Every tab now sees every ticker
//      in the database.
//   2. This module no longer uses any Vite-only macro, so "has the data changed" is a version
//      number the importer bumps rather than a hash of directory mtimes.
//   3. Adding data is an Import button, not an edit to a glob pattern.
let datasets: CaptureDataset[] = [];
let datasetUniverse = { total: 0, reconstructed: 0, snapshotOnly: 0 };
const signalDiscoveryResultCache = new Map<SignalDiscoveryUniverse, SignalDiscoveryResult>();

export const initialiseDatasets = (payload: {
  datasets: CaptureDataset[];
  benchmarks: Array<[string, BenchmarkQuote[]]>;
  universe: { total: number; reconstructed: number; snapshotOnly: number };
}): void => {
  datasets = payload.datasets;
  // Both bindings have to be reassigned, not just `datasets`. `extendedDatasets` is a separate
  // module-level binding that captured the value it was initialised with; leaving it alone left
  // every tab that reads it looking at the empty array this module starts with.
  extendedDatasets = payload.datasets;
  datasetUniverse = payload.universe;
  // The portfolio engine caches a per-day rating index over these datasets; a new import must
  // invalidate it or every backtest keeps running against the previous data version.
  portfolioIndex = null;
  poolCache.clear();
  signalDiscoveryResultCache.clear();
  benchmarkByTicker.clear();
  payload.benchmarks.forEach(([ticker, quotes]) => benchmarkByTicker.set(ticker.toUpperCase(), quotes));
};

export const getUniverseSummary = () => ({ ...datasetUniverse });

// `extendedDatasets` used to be a separate, larger universe built from input/3-year/*.json while
// `datasets` held only the 27 hand-curated captures. Both now resolve to the same set: the
// database does the reconstruction (see server/db/datasets.ts) and every tab reads it. The alias
// is kept rather than renamed at ~20 call sites, so this migration stays reviewable as a change of
// data source and nothing else.
let extendedDatasets: CaptureDataset[] = [];

// Benchmark quotes, keyed by symbol. Filled by initialiseDatasets() from benchmark_prices.
const benchmarkByTicker: Map<string, BenchmarkQuote[]> = new Map();

// Quotes are sorted ascending; walk forward and keep the last one that is not after targetDate.
// Parsed once per quotes array (cached by reference) rather than re-parsing every date string on
// every call — quoteOnOrBefore used to do a linear O(n) scan re-parsing dates as it went, which was
// fine when it was called a handful of times per window, but marketReturnBetween below calls it
// twice per rating call/episode/trade, and SPY's cached history alone can span years of daily
// closes. Left un-optimized, that turned a full snapshot's worth of market-adjusted calls into a
// multi-second-to-tens-of-seconds cost — see progress.md.
const quoteTimestampCache = new WeakMap<BenchmarkQuote[], number[]>();
const timestampsFor = (quotes: BenchmarkQuote[]): number[] => {
  const cached = quoteTimestampCache.get(quotes);
  if (cached) return cached;
  const timestamps = quotes.map((quote) => new Date(quote.date).getTime());
  quoteTimestampCache.set(quotes, timestamps);
  return timestamps;
};

// Binary search for the last quote whose date is <= targetDate. Quotes are sorted ascending (see
// benchmarkByTicker's construction below), which this relies on.
const quoteOnOrBefore = (quotes: BenchmarkQuote[], targetDate: Date): BenchmarkQuote | null => {
  if (!quotes.length) return null;
  const timestamps = timestampsFor(quotes);
  const target = targetDate.getTime();
  if (timestamps[0] > target) return null;
  let low = 0;
  let high = quotes.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (timestamps[mid] <= target) low = mid; else high = mid - 1;
  }
  return quotes[low];
};

const unavailableBenchmark: BenchmarkResult = {
  available: false,
  startingValue: 100,
  endingValue: 100,
  totalReturn: 0,
  startDate: null,
  endDate: null,
};

// Independent buy-and-hold comparison for the same signal-history window used by the strategy
// replay, priced from cached, split/dividend-adjusted closes rather than the Seeking Alpha
// capture's own price field (whose adjustment basis is unconfirmed — see progress.md).
const buildBenchmarkResult = (ticker: string, records: CaptureRecord[]): BenchmarkResult => {
  const quotes = benchmarkByTicker.get(ticker.toUpperCase());
  if (!quotes?.length || !records.length) return unavailableBenchmark;

  const windowStart = new Date(records[0].date);
  const windowEnd = new Date(records[records.length - 1].date);
  const entryQuote = quoteOnOrBefore(quotes, windowStart) ?? quotes[0];
  const exitQuote = quoteOnOrBefore(quotes, windowEnd);
  if (!entryQuote || !exitQuote || entryQuote.adjClose <= 0) return unavailableBenchmark;

  const endingValue = 100 * (exitQuote.adjClose / entryQuote.adjClose);
  return {
    available: true,
    startingValue: 100,
    endingValue,
    totalReturn: ((endingValue / 100) - 1) * 100,
    startDate: entryQuote.date,
    endDate: exitQuote.date,
  };
};

const coveredCalendarMonths = (records: CaptureRecord[]) => {
  if (records.length < 2) return 0;
  const first = new Date(records[0].date);
  const last = new Date(records[records.length - 1].date);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return 0;
  const wholeMonths = ((last.getFullYear() - first.getFullYear()) * 12) + last.getMonth() - first.getMonth();
  return Math.max(0, wholeMonths - (last.getDate() < first.getDate() ? 1 : 0));
};

export const getAvailableHistoryWindows = (): HistoryWindow[] => {
  const windows: HistoryWindow[] = ['7d', '1m', '3m', '6m', '12m'];
  const longestCoverage = datasets.reduce((longest, dataset) => Math.max(longest, coveredCalendarMonths(dataset.records)), 0);
  for (let months = 18; months <= longestCoverage; months += 6) windows.push(`${months}m`);
  windows.push('all');
  return windows;
};

const isBullish = (rating: Rating) => rating === 'Buy' || rating === 'Strong Buy';
const isBearish = (rating: Rating) => rating === 'Sell' || rating === 'Strong Sell';

const median = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

const desiredPosition = (policy: SignalPolicy, rating: Rating, current: Position): Position => {
  if (isBullish(rating)) return 'long';
  if (policy === 'long-short' && isBearish(rating)) return 'short';
  if (policy === 'long-hold-through' && rating === 'Hold' && current === 'long') return 'long';
  return 'cash';
};

const signalDirection = (policy: SignalPolicy, rating: Rating) => {
  if (isBullish(rating)) return 1;
  if (policy === 'long-short' && isBearish(rating)) return -1;
  return 0;
};

const recordsInWindow = (records: CaptureRecord[], window: HistoryWindow) => {
  if (window === 'all' || records.length === 0) return records;
  const latestDate = new Date(records[records.length - 1].date);
  const cutoff = new Date(latestDate);
  if (window === '7d') cutoff.setDate(cutoff.getDate() - 7);
  else cutoff.setMonth(cutoff.getMonth() - Number.parseInt(window, 10));
  return records.filter((record) => new Date(record.date) >= cutoff);
};

const buildReplay = (records: CaptureRecord[], policy: SignalPolicy) => {
  const startingValue = 100;
  let cash = startingValue;
  let position: Position = 'cash';
  let units = 0;
  let entryPrice: number | null = null;
  let entryCapital = 0;
  let previousRating = records[0]?.quantRating ?? 'Hold';
  let entries = 0;
  let exits = 0;
  const events: ReplayEvent[] = [];

  const positionValue = (price: number) => {
    if (position === 'long') return units * price;
    if (position === 'short' && entryPrice !== null) return entryCapital + units * (entryPrice - price);
    return cash;
  };

  records.forEach((record, index) => {
    const ratingChanged = index > 0 && record.quantRating !== previousRating;
    const target = desiredPosition(policy, record.quantRating, position);
    const change = `${previousRating} → ${record.quantRating}`;

    if (position !== target) {
      if (position !== 'cash' && entryPrice !== null) {
        const closingPosition = position;
        const tradeReturn = closingPosition === 'long'
          ? ((record.price / entryPrice) - 1) * 100
          : ((entryPrice - record.price) / entryPrice) * 100;
        cash = positionValue(record.price);
        position = 'cash';
        units = 0;
        entryPrice = null;
        entryCapital = 0;
        exits += 1;
        events.push({ date: record.date, change, decision: closingPosition === 'long' ? 'Exit' : 'Cover', price: record.price, portfolioValue: cash, tradeReturn });
      }

      if (target !== 'cash') {
        position = target;
        entryPrice = record.price;
        entryCapital = cash;
        units = cash / record.price;
        entries += 1;
        events.push({ date: record.date, change, decision: target === 'long' ? 'Buy once' : 'Short once', price: record.price, portfolioValue: cash, tradeReturn: null });
        cash = 0;
      }
    } else if (ratingChanged) {
      events.push({ date: record.date, change, decision: position === 'long' ? 'Stay invested' : position === 'short' ? 'Stay short' : 'Stay in cash', price: record.price, portfolioValue: positionValue(record.price), tradeReturn: null });
    }

    previousRating = record.quantRating;
  });

  const lastRecord = records[records.length - 1];
  const endingValue = lastRecord ? positionValue(lastRecord.price) : cash;
  const openTradeReturn = position !== 'cash' && entryPrice !== null && lastRecord
    ? position === 'long' ? ((lastRecord.price / entryPrice) - 1) * 100 : ((entryPrice - lastRecord.price) / entryPrice) * 100
    : null;
  const finalPosition = position as Position;

  return {
    startingValue,
    endingValue,
    totalReturn: ((endingValue / startingValue) - 1) * 100,
    positionStatus: finalPosition === 'long' ? 'Open long' as const : finalPosition === 'short' ? 'Open short' as const : 'Closed' as const,
    openTradeReturn,
    entries,
    exits,
    events,
  };
};

const buildPeriodReturns = (records: CaptureRecord[], policy: SignalPolicy) => {
  const returns: number[] = [];
  const finalRecord = records[records.length - 1];
  records.forEach((record, index) => {
    const futureRecord = index < records.length - 1 ? finalRecord : undefined;
    const direction = signalDirection(policy, record.quantRating);
    if (!futureRecord || direction === 0) return;
    returns.push((((futureRecord.price / record.price) - 1) * 100) * direction);
  });
  return returns;
};

const buildTickerResult = (dataset: CaptureDataset, window: HistoryWindow, policy: SignalPolicy): TickerResult => {
  const { capture, sourceFile } = dataset;
  const records = recordsInWindow(dataset.records, window);
  const replay = buildReplay(records, policy);
  const forwardReturns = buildPeriodReturns(records, policy);
  const distribution = new Map<Rating, number>();
  let categoryChanges = 0;
  records.forEach((record, index) => {
    distribution.set(record.quantRating, (distribution.get(record.quantRating) ?? 0) + 1);
    if (index > 0 && record.quantRating !== records[index - 1].quantRating) categoryChanges += 1;
  });

  return {
    ticker: capture.source.ticker,
    company: capture.source.companyName,
    signals: forwardReturns.length,
    latestRating: records[records.length - 1]?.quantRating ?? capture.source.quantRating,
    hitRate: forwardReturns.length ? (forwardReturns.filter((value) => value > 0).length / forwardReturns.length) * 100 : 0,
    averageReturn: forwardReturns.length ? forwardReturns.reduce((total, value) => total + value, 0) / forwardReturns.length : 0,
    medianReturn: median(forwardReturns),
    ratingChanges: categoryChanges,
    coverage: 'Complete',
    dateRange: records.length ? `${records[0].date} – ${records[records.length - 1]?.date}` : 'No records',
    detail: {
      ...replay,
      currentPrice: capture.source.currentPrice,
      quantScore: capture.source.quantScore,
      capturedAt: new Date(capture.capturedAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC'),
      sourceFile,
      capturedDays: records.length,
      ratingDistribution: (['Strong Buy', 'Buy', 'Hold', 'Sell', 'Strong Sell'] as Rating[])
        .filter((rating) => distribution.has(rating))
        .map((rating) => ({ rating, days: distribution.get(rating) ?? 0 })),
      benchmark: buildBenchmarkResult(capture.source.ticker, records),
    },
  };
};

const tickerResultsCache = new Map<string, TickerResult[]>();

export const buildTickerResults = (window: HistoryWindow, policy: SignalPolicy): TickerResult[] => {
  const key = `${window}|${policy}`;
  const cached = tickerResultsCache.get(key);
  if (cached) return cached;
  const results = datasets.map((dataset) => buildTickerResult(dataset, window, policy));
  tickerResultsCache.set(key, results);
  return results;
};

export const buildAggregateResults = (windows: HistoryWindow[], policies: SignalPolicy[]): AggregateResult[] =>
  windows.flatMap((window) => policies.map((policy) => {
    const allTickerResults = buildTickerResults(window, policy);
    const testedResults = allTickerResults.filter((result) => result.detail.benchmark.available);
    const extraReturns = testedResults.map((result) => result.detail.totalReturn - result.detail.benchmark.totalReturn);
    const beatBenchmarkCount = extraReturns.filter((value) => value > 0).length;
    const beatBenchmarkRate = testedResults.length ? (beatBenchmarkCount / testedResults.length) * 100 : 0;
    const averageExtraReturn = extraReturns.length ? extraReturns.reduce((total, value) => total + value, 0) / extraReturns.length : 0;
    const medianExtraReturn = median(extraReturns);
    const averageStrategyReturn = testedResults.length
      ? testedResults.reduce((total, result) => total + result.detail.totalReturn, 0) / testedResults.length
      : 0;
    const averageBenchmarkReturn = testedResults.length
      ? testedResults.reduce((total, result) => total + result.detail.benchmark.totalReturn, 0) / testedResults.length
      : 0;
    const confidence: AggregateResult['confidence'] = testedResults.length >= 30 ? 'High' : testedResults.length >= 10 ? 'Medium' : 'Low';
    const verdict: AggregateResult['verdict'] = testedResults.length < 3
      ? 'Not enough data'
      : beatBenchmarkRate >= 60 && averageExtraReturn > 0 && medianExtraReturn > 0
        ? 'Good'
        : beatBenchmarkRate <= 40 && averageExtraReturn < 0 && medianExtraReturn < 0
          ? 'Poor'
          : 'Mixed';

    return {
      window,
      policy,
      tickersTested: testedResults.length,
      totalTickers: allTickerResults.length,
      beatBenchmarkCount,
      beatBenchmarkRate,
      averageExtraReturn,
      medianExtraReturn,
      averageStrategyReturn,
      averageBenchmarkReturn,
      confidence,
      verdict,
    };
  }));

// Strong Buy "trust" replay: for each ticker, a trade opens the first time its rating becomes
// Strong Buy and closes when it stops being Strong Buy. Two accuracy fixes applied here (matching
// the same rules used for the event-based rating-call tests above): only isUsableRecord() rows are
// considered (a stray null price/score, or the "Not Covered" scraping artifact, no longer counts as
// a real Strong Buy day), and entry uses the NEXT usable record after Strong Buy is first observed,
// not that day's own price (next-trading-day rule). A win is market-adjusted (excess return over
// SPY across the same entry/exit dates) whenever benchmark data covers that range, falling back to
// absolute return only when it doesn't.
export const buildStrongBuyTrustResults = (): StrongBuyTrustResult[] => extendedDatasets.map((dataset) => {
  const { capture, records } = dataset;
  const usable = records.filter(isUsableRecord);
  const trades: StrongBuyTrade[] = [];
  let entryRecord: CaptureRecord | null = null;
  let portfolioValue = 100;

  for (let index = 1; index < usable.length; index += 1) {
    const previous = usable[index - 1];
    const current = usable[index];

    if (!entryRecord && previous.quantRating !== 'Strong Buy' && current.quantRating === 'Strong Buy') {
      const entryIndex = index + 1;
      if (entryIndex >= usable.length) continue; // no next trading day yet -- can't enter, wait for more data
      entryRecord = usable[entryIndex];
      continue;
    }

    if (entryRecord && current.quantRating !== 'Strong Buy') {
      const returnPercent = ((current.price / entryRecord.price) - 1) * 100;
      const marketReturnPercent = marketReturnBetween(entryRecord.date, current.date);
      const excessReturnPercent = marketReturnPercent !== null ? returnPercent - marketReturnPercent : null;
      portfolioValue *= current.price / entryRecord.price;
      trades.push({
        entryDate: entryRecord.date,
        entryPrice: entryRecord.price,
        exitDate: current.date,
        exitPrice: current.price,
        exitRating: current.quantRating,
        returnPercent,
        marketReturnPercent,
        excessReturnPercent,
        marketAdjusted: marketReturnPercent !== null,
        status: 'Completed',
      });
      entryRecord = null;
    }
  }

  const lastRecord = usable[usable.length - 1];
  let openTradeReturn: number | null = null;
  if (entryRecord && lastRecord && lastRecord !== entryRecord) {
    openTradeReturn = ((lastRecord.price / entryRecord.price) - 1) * 100;
    portfolioValue *= lastRecord.price / entryRecord.price;
    trades.push({
      entryDate: entryRecord.date,
      entryPrice: entryRecord.price,
      exitDate: null,
      exitPrice: null,
      exitRating: null,
      returnPercent: openTradeReturn,
      marketReturnPercent: null,
      excessReturnPercent: null,
      marketAdjusted: false,
      status: 'Open',
    });
  }

  const completed = trades.filter((trade) => trade.status === 'Completed');
  const completedEffectiveReturns = completed.map((trade) => trade.excessReturnPercent ?? trade.returnPercent);
  const wins = completedEffectiveReturns.filter((value) => value > 0).length;
  const losses = completedEffectiveReturns.filter((value) => value <= 0).length;

  return {
    ticker: capture.source.ticker,
    company: capture.source.companyName,
    completedTrades: completed.length,
    wins,
    losses,
    winRate: completedEffectiveReturns.length ? (wins / completedEffectiveReturns.length) * 100 : null,
    averageTradeReturn: completedEffectiveReturns.length
      ? completedEffectiveReturns.reduce((total, value) => total + value, 0) / completedEffectiveReturns.length
      : null,
    medianTradeReturn: completedEffectiveReturns.length ? median(completedEffectiveReturns) : null,
    endingValue: portfolioValue,
    totalReturn: ((portfolioValue / 100) - 1) * 100,
    openTradeReturn,
    dateRange: usable.length ? `${usable[0].date} – ${lastRecord.date}` : 'No records',
    trades,
  };
});

// Aggregate outlier/concentration diagnostics pooled across every ticker's completed Strong Buy
// trades (item 5/8 of the methodology review this responds to). Never removes an observation for
// being large -- the point is to show the raw mean alongside statistics that aren't dominated by
// one or two extreme winners, and to flag when a headline conclusion depends on them.
export const buildStrongBuyOutlierAnalysis = (): StrongBuyOutlierAnalysis => {
  const allTrades = buildStrongBuyTrustResults().flatMap((result) =>
    result.trades
      .filter((trade) => trade.status === 'Completed')
      .map((trade) => ({ ticker: result.ticker, value: trade.excessReturnPercent ?? trade.returnPercent })));

  if (allTrades.length === 0) {
    return {
      completedTrades: 0,
      tickers: 0,
      rawMeanReturn: null,
      medianReturn: null,
      trimmedMeanReturn: null,
      winsorizedMeanReturn: null,
      geometricMeanReturn: null,
      largestWinnerReturn: null,
      largestLoserReturn: null,
      top1PercentContributionPercent: null,
      top5PercentContributionPercent: null,
      top10PercentContributionPercent: null,
      leaveOneTickerOutMinMeanReturn: null,
      leaveOneTickerOutMaxMeanReturn: null,
      outlierSensitive: false,
      outlierSensitiveReasons: [],
    };
  }

  const values = allTrades.map((trade) => trade.value);
  const sorted = [...values].sort((left, right) => left - right);
  const n = sorted.length;
  const mean = (list: number[]) => (list.length ? list.reduce((total, value) => total + value, 0) / list.length : null);
  const rawMeanReturn = mean(values);

  const trimCount = Math.floor(n * 0.1);
  const trimmedMeanReturn = mean(trimCount > 0 && n - 2 * trimCount > 0 ? sorted.slice(trimCount, n - trimCount) : sorted);

  const winsorLow = sorted[Math.min(n - 1, trimCount)];
  const winsorHigh = sorted[Math.max(0, n - 1 - trimCount)];
  const winsorizedMeanReturn = mean(sorted.map((value) => Math.min(Math.max(value, winsorLow), winsorHigh)));

  // Geometric mean of returns needs (1 + r/100) factors; a single -100% (total loss) makes the
  // product zero/undefined, so guard rather than emit NaN or Infinity.
  const growthFactors = values.map((value) => 1 + value / 100);
  const geometricMeanReturn = growthFactors.every((factor) => factor > 0)
    ? (Math.pow(growthFactors.reduce((total, factor) => total * factor, 1), 1 / n) - 1) * 100
    : null;

  const totalPositiveProfit = values.filter((value) => value > 0).reduce((total, value) => total + value, 0);
  const contributionOfTopFraction = (fraction: number): number | null => {
    if (totalPositiveProfit <= 0) return null;
    const count = Math.max(1, Math.round(n * fraction));
    const topSum = [...sorted].reverse().slice(0, count).filter((value) => value > 0).reduce((total, value) => total + value, 0);
    return (topSum / totalPositiveProfit) * 100;
  };

  const byTicker = new Map<string, number[]>();
  allTrades.forEach((trade) => {
    const list = byTicker.get(trade.ticker) ?? [];
    list.push(trade.value);
    byTicker.set(trade.ticker, list);
  });
  const leaveOneOutMeans = [...byTicker.keys()]
    .map((excludedTicker) => mean(allTrades.filter((trade) => trade.ticker !== excludedTicker).map((trade) => trade.value)))
    .filter((value): value is number => value !== null);

  const reasons: string[] = [];
  if (rawMeanReturn !== null && trimmedMeanReturn !== null && Math.sign(rawMeanReturn) !== Math.sign(trimmedMeanReturn) && rawMeanReturn !== 0) {
    reasons.push('Sign flips between the raw mean and the 10% trimmed mean.');
  }
  const top10Contribution = contributionOfTopFraction(0.1);
  if (top10Contribution !== null && top10Contribution >= 50) {
    reasons.push('The top 10% of trades account for at least half of total profit.');
  }
  if (
    leaveOneOutMeans.length > 0
    && rawMeanReturn !== null
    && ((rawMeanReturn > 0 && Math.min(...leaveOneOutMeans) <= 0) || (rawMeanReturn < 0 && Math.max(...leaveOneOutMeans) >= 0))
  ) {
    reasons.push('Removing a single ticker flips the sign of the mean return.');
  }

  return {
    completedTrades: n,
    tickers: byTicker.size,
    rawMeanReturn,
    medianReturn: median(values),
    trimmedMeanReturn,
    winsorizedMeanReturn,
    geometricMeanReturn,
    largestWinnerReturn: sorted[n - 1],
    largestLoserReturn: sorted[0],
    top1PercentContributionPercent: contributionOfTopFraction(0.01),
    top5PercentContributionPercent: contributionOfTopFraction(0.05),
    top10PercentContributionPercent: top10Contribution,
    leaveOneTickerOutMinMeanReturn: leaveOneOutMeans.length ? Math.min(...leaveOneOutMeans) : null,
    leaveOneTickerOutMaxMeanReturn: leaveOneOutMeans.length ? Math.max(...leaveOneOutMeans) : null,
    outlierSensitive: reasons.length > 0,
    outlierSensitiveReasons: reasons,
  };
};

export type CohortResult = {
  tier: Rating | 'Market';
  window: HistoryWindow;
  tickerCount: number;
  totalInTier: number;
  averageReturn: number | null;
  medianReturn: number | null;
};

const ratingTierOrder: Rating[] = ['Strong Buy', 'Buy', 'Hold', 'Sell', 'Strong Sell'];

// Grouped by each ticker's latest Seeking Alpha rating. The extended source includes historical
// rating changes, but this view intentionally answers "do stocks rated X at the end of the dataset
// have stronger trailing buy-and-hold returns than stocks rated Y?", not "did every historical
// rating correctly predict its future return?" The latter belongs to Rating accuracy. Since
// trailing momentum is itself one of the five Quant factors, some separation may be mechanical.
export const getAvailableRatingTiers = (): Rating[] =>
  ratingTierOrder.filter((tier) => extendedDatasets.some((dataset) => dataset.capture.source.quantRating === tier));

const MARKET_TICKER = 'SPY';

// Market (SPY) return between two arbitrary dates, using the same total-return-adjusted close
// series as buildMarketReturn/buildBenchmarkResult below, but for a single call's own entry/exit
// dates rather than a whole ticker-history window. This is what makes a call's "correct" verdict
// market-adjusted instead of absolute: a rising market inflates every bullish call's apparent hit
// rate and deflates every bearish one, so excess return over SPY (not raw price direction) is the
// primary correctness test — see buildRatingCallSummary / buildPredictiveAccuracySummary below.
const marketReturnBetween = (entryDate: string, exitDate: string): number | null => {
  const quotes = benchmarkByTicker.get(MARKET_TICKER);
  if (!quotes?.length) return null;
  const entryQuote = quoteOnOrBefore(quotes, new Date(entryDate));
  const exitQuote = quoteOnOrBefore(quotes, new Date(exitDate));
  if (!entryQuote || !exitQuote || entryQuote.adjClose <= 0) return null;
  return ((exitQuote.adjClose / entryQuote.adjClose) - 1) * 100;
};

// "Market" uses fixed anchor dates (the earliest and most recent record across every loaded
// ticker) so every window's market return is comparable across tiers, rather than each ticker
// silently using its own captured date range as "today"/"the beginning".
const globalLatestDate = (): Date | null => extendedDatasets.reduce<Date | null>((latest, dataset) => {
  const last = dataset.records[dataset.records.length - 1];
  if (!last) return latest;
  const candidate = new Date(last.date);
  if (Number.isNaN(candidate.getTime())) return latest;
  return !latest || candidate > latest ? candidate : latest;
}, null);

const globalEarliestDate = (): Date | null => extendedDatasets.reduce<Date | null>((earliest, dataset) => {
  const first = dataset.records[0];
  if (!first) return earliest;
  const candidate = new Date(first.date);
  if (Number.isNaN(candidate.getTime())) return earliest;
  return !earliest || candidate < earliest ? candidate : earliest;
}, null);

const buildMarketReturn = (window: HistoryWindow): { available: boolean; totalReturn: number } => {
  const quotes = benchmarkByTicker.get(MARKET_TICKER);
  const anchor = globalLatestDate();
  if (!quotes?.length || !anchor) return { available: false, totalReturn: 0 };

  let entryQuote: BenchmarkQuote | null;
  if (window === 'all') {
    // "All" for a ticker tier means "as far back as the loaded capture history goes" (a couple
    // of years), not SPY's entire fetched price history (which goes back decades, since the
    // fetch script pulls full history for every cached ticker). Anchoring to the earliest
    // record across the loaded datasets keeps this comparable to the other rows instead of
    // silently comparing a ~2-year Strong Buy/Hold return to a 30-year SPY return.
    const earliest = globalEarliestDate();
    entryQuote = earliest ? (quoteOnOrBefore(quotes, earliest) ?? quotes[0]) : quotes[0];
  } else {
    const start = new Date(anchor);
    if (window === '7d') start.setDate(start.getDate() - 7);
    else start.setMonth(start.getMonth() - Number.parseInt(window, 10));
    entryQuote = quoteOnOrBefore(quotes, start) ?? quotes[0];
  }
  const exitQuote = quoteOnOrBefore(quotes, anchor);
  if (!entryQuote || !exitQuote || entryQuote.adjClose <= 0) return { available: false, totalReturn: 0 };

  return { available: true, totalReturn: (((exitQuote.adjClose / entryQuote.adjClose) - 1)) * 100 };
};

// Original scraped captures keep using their separately cached adjusted-price files. The 3-year
// API captures already contain daily close and dividend-adjustment data, so they can provide the
// same buy-and-hold result without requiring a separate benchmark file for every new ticker.
const buildRatingTierReturn = (dataset: CaptureDataset, records: CaptureRecord[]): BenchmarkResult => {
  if (dataset.priceBasis !== 'adjusted') {
    return buildBenchmarkResult(dataset.capture.source.ticker, records);
  }
  const first = records[0];
  const last = records[records.length - 1];
  if (!first || !last || first.price <= 0) return unavailableBenchmark;
  const endingValue = 100 * (last.price / first.price);
  return {
    available: true,
    startingValue: 100,
    endingValue,
    totalReturn: ((endingValue / 100) - 1) * 100,
    startDate: first.date,
    endDate: last.date,
  };
};

// Real (not strategy-replayed) buy-and-hold return per rating tier per window, plus a Market
// (SPY) reference row. This is the cohort comparison: "are today's Hold-rated stocks' real
// historical returns weaker than today's Buy/Strong Buy stocks', and how does either compare
// to just holding the index?" It deliberately reuses the same cached, split/dividend-adjusted
// prices as the "Buy & hold" column elsewhere, not the Seeking Alpha capture's own price field.
export const buildCohortResults = (windows: HistoryWindow[]): CohortResult[] => {
  const tiers = getAvailableRatingTiers();
  const rows: CohortResult[] = [];

  windows.forEach((window) => {
    tiers.forEach((tier) => {
      const tierDatasets = extendedDatasets.filter((dataset) => dataset.capture.source.quantRating === tier);
      const returns = tierDatasets
        .map((dataset) => buildRatingTierReturn(dataset, recordsInWindow(dataset.records, window)))
        .filter((result) => result.available)
        .map((result) => result.totalReturn);
      rows.push({
        tier,
        window,
        tickerCount: returns.length,
        totalInTier: tierDatasets.length,
        averageReturn: returns.length ? returns.reduce((total, value) => total + value, 0) / returns.length : null,
        medianReturn: returns.length ? median(returns) : null,
      });
    });

    const market = buildMarketReturn(window);
    rows.push({
      tier: 'Market',
      window,
      tickerCount: market.available ? 1 : 0,
      totalInTier: 1,
      averageReturn: market.available ? market.totalReturn : null,
      medianReturn: market.available ? market.totalReturn : null,
    });
  });

  return rows;
};

export type TickerCohortResult = {
  ticker: string;
  company: string;
  tier: Rating;
  window: HistoryWindow;
  available: boolean;
  totalReturn: number | null;
};

// The un-averaged version of buildCohortResults: one row's worth of data per ticker per window,
// so a tier's aggregate number (e.g. Strong Buy's average) can be traced back to which specific
// stocks actually drove it, instead of only ever seeing the group average.
export const buildTickerCohortResults = (windows: HistoryWindow[]): TickerCohortResult[] =>
  windows.flatMap((window) => extendedDatasets.map((dataset) => {
    const result = buildRatingTierReturn(dataset, recordsInWindow(dataset.records, window));
    return {
      ticker: dataset.capture.source.ticker,
      company: dataset.capture.source.companyName,
      tier: dataset.capture.source.quantRating,
      window,
      available: result.available,
      totalReturn: result.available ? result.totalReturn : null,
    };
  }));

export type TierWinRate = {
  tier: Rating;
  wins: number;
  total: number;
  winRate: number;
};

// One number per tier: of the stocks currently carrying that rating, what share have a real
// (full tracked history) return above the S&P 500's return over that same overall span. This
// collapses the "Rating tier − S&P 500" table down to a single win/loss headline per tier —
// deliberately basis-fixed to 'all' rather than window-selectable, so it reads as one summary
// conclusion rather than yet another window to page through.
export const buildTierWinRates = (): TierWinRate[] => {
  return getAvailableRatingTiers().map((tier) => {
    const tierDatasets = extendedDatasets.filter((dataset) => dataset.capture.source.quantRating === tier);
    let wins = 0;
    let total = 0;
    tierDatasets.forEach((dataset) => {
      const result = buildRatingTierReturn(dataset, recordsInWindow(dataset.records, 'all'));
      if (!result.available || !result.startDate || !result.endDate) return;
      const marketReturn = marketReturnBetween(result.startDate, result.endDate);
      if (marketReturn === null) return;
      total += 1;
      if (result.totalReturn > marketReturn) wins += 1;
    });
    return { tier, wins, total, winRate: total ? (wins / total) * 100 : 0 };
  });
};

export type ScoreCorrelationPoint = {
  ticker: string;
  company: string;
  tier: Rating;
  score: number;
  excessReturn: number;
};

export type ScoreCorrelation = {
  points: ScoreCorrelationPoint[];
  correlation: number | null;
  slope: number | null;
  intercept: number | null;
};

// Un-bucketed version of the tier comparisons above: plots the raw Quant Score (not which of
// the 5 rating buckets it falls into) against excess return over the S&P 500, one point per
// ticker, plus a simple linear fit (Pearson r / slope / intercept). Same 'all'-window basis as
// buildTierWinRates. Note this only reveals fine-grained (e.g. 4.1 vs 4.9) signal if the loaded
// tickers actually span a range of scores within a tier — if every Strong Buy in the data is
// clustered at 4.98-4.99, the correlation mostly just reflects tier-to-tier separation.
export const buildScoreCorrelation = (): ScoreCorrelation => {
  const points: ScoreCorrelationPoint[] = [];
  extendedDatasets.forEach((dataset) => {
    const result = buildRatingTierReturn(dataset, recordsInWindow(dataset.records, 'all'));
    if (!result.available || !result.startDate || !result.endDate) return;
    const marketReturn = marketReturnBetween(result.startDate, result.endDate);
    if (marketReturn === null) return;
    points.push({
      ticker: dataset.capture.source.ticker,
      company: dataset.capture.source.companyName,
      tier: dataset.capture.source.quantRating,
      score: dataset.capture.source.quantScore,
      excessReturn: result.totalReturn - marketReturn,
    });
  });

  if (points.length < 2) return { points, correlation: null, slope: null, intercept: null };

  const n = points.length;
  const meanScore = points.reduce((total, point) => total + point.score, 0) / n;
  const meanExcess = points.reduce((total, point) => total + point.excessReturn, 0) / n;
  let covariance = 0;
  let scoreVariance = 0;
  let excessVariance = 0;
  points.forEach((point) => {
    const scoreDiff = point.score - meanScore;
    const excessDiff = point.excessReturn - meanExcess;
    covariance += scoreDiff * excessDiff;
    scoreVariance += scoreDiff * scoreDiff;
    excessVariance += excessDiff * excessDiff;
  });

  if (scoreVariance === 0 || excessVariance === 0) return { points, correlation: null, slope: null, intercept: null };

  const correlation = covariance / Math.sqrt(scoreVariance * excessVariance);
  const slope = covariance / scoreVariance;
  const intercept = meanExcess - slope * meanScore;

  return { points, correlation, slope, intercept };
};

export type AccuracyPoint = {
  date: string;
  score: number;
  rating: Rating;
  price: number;
  forwardDate: string;
  forwardPrice: number;
  forwardReturn: number;
};

export type TickerAccuracy = {
  ticker: string;
  company: string;
  points: AccuracyPoint[];
  correlation: number | null;
  slope: number | null;
  intercept: number | null;
};

const ACCURACY_HORIZONS = [30, 90, 180, 365] as const;
export const getAvailableAccuracyHorizons = (): number[] => [...ACCURACY_HORIZONS];

// Real captures occasionally have a null price/quantScore/quantRating for a given day, and some
// have a non-null but non-canonical rating string ("Not CoveredRating: Not Covered" — an apparent
// scraping artifact for tickers Seeking Alpha temporarily stopped covering) despite the type
// declaring quantRating as always one of the five real tiers. Guard at runtime against both: a
// stray null previously reached `.toFixed()` in the chart tooltip and crashed the view, and an
// un-whitelisted rating string would otherwise silently count as a real rating in every summary
// below it.
const validRatings = new Set<Rating>(['Strong Buy', 'Buy', 'Hold', 'Sell', 'Strong Sell']);
const isUsableRecord = (candidate: CaptureRecord): boolean =>
  typeof candidate.price === 'number' && Number.isFinite(candidate.price) && candidate.price > 0
  && typeof candidate.quantScore === 'number' && Number.isFinite(candidate.quantScore)
  && validRatings.has(candidate.quantRating);

// Fixed-horizon forward match: for a record on date D, find the usable record closest to
// D + horizonDays, within a tolerance band, so every observation answers the same question ("what
// happened over the next N days") rather than every signal being compared to one shared,
// ever-shrinking end date (the pseudo-replication problem raised earlier for the terminal-anchor
// approach). The tolerance is a fixed number of days rather than a percentage of the horizon —
// captures are near-daily (see coveredCalendarMonths), so a small fixed window is enough to bridge
// normal gaps (weekends, occasional missing days) without letting a "365-day" match actually land
// anywhere from 310 to 420 days out, which a percentage-based tolerance previously allowed.
// Observations too close to the end of a ticker's captured history, or with no usable candidate in
// the tolerance band, have no forward match and are dropped.
const FORWARD_MATCH_TOLERANCE_DAYS = 7;
const findForwardRecord = (records: CaptureRecord[], fromIndex: number, horizonDays: number): CaptureRecord | null => {
  const anchorTime = new Date(records[fromIndex].date).getTime();
  if (Number.isNaN(anchorTime)) return null;
  const targetTime = anchorTime + horizonDays * 86_400_000;
  const toleranceMs = FORWARD_MATCH_TOLERANCE_DAYS * 86_400_000;
  let best: CaptureRecord | null = null;
  let bestDiff = Infinity;
  for (let index = fromIndex + 1; index < records.length; index += 1) {
    const time = new Date(records[index].date).getTime();
    if (Number.isNaN(time)) continue;
    if (time > targetTime + toleranceMs) break;
    if (!isUsableRecord(records[index])) continue;
    const diff = Math.abs(time - targetTime);
    if (diff <= toleranceMs && diff < bestDiff) {
      best = records[index];
      bestDiff = diff;
    }
  }
  return best;
};

// Versioned, frozen research rules: every DB run saves this alongside its methodology_version hash
// (see server/db/methodologyVersion.ts, which hashes this file) so a stored result can always be
// traced back to *which* rules produced it, not just *that* some rules were used. This object is
// meant to be edited deliberately and rarely — changing any field here changes data.ts's own
// source text, which is exactly what bumps the methodology hash and triggers a fresh DB run, so
// there is no way to silently change a rule without it being reflected in stored history.
export type MethodologyConfig = {
  version: number;
  horizonsDays: number[];
  allowedRatings: Rating[];
  entryRule: string;
  benchmarkTicker: string;
  forwardMatchToleranceDays: number;
  transactionCostAssumption: string;
  holdNeutralityRule: string;
  bootstrapRepetitions: number;
  bootstrapSeed: number;
  multipleTestingMethod: string;
  minimumEvidenceNotes: string;
};

const METHODOLOGY_CONFIG: MethodologyConfig = {
  version: 1,
  horizonsDays: [...ACCURACY_HORIZONS],
  allowedRatings: ['Strong Buy', 'Buy', 'Hold', 'Sell', 'Strong Sell'],
  entryRule: 'Next available trading-day record strictly after the signal date; the signal date\'s own price is never used as the entry price (avoids assuming a trade at the exact close the rating was captured).',
  benchmarkTicker: 'SPY',
  forwardMatchToleranceDays: FORWARD_MATCH_TOLERANCE_DAYS,
  transactionCostAssumption: 'None modeled in the predictive-accuracy or rating-call tests (gross returns). The portfolio replay tabs (Ticker results / Overall results) also do not deduct costs yet — treat all reported returns there as gross, not net.',
  holdNeutralityRule: 'Hold is excluded from headline directional hit rates (bullish/bearish only). Hold calls are still tracked and reported descriptively (median/mean excess return) for reference; no numeric neutrality band is applied.',
  bootstrapRepetitions: 5000,
  bootstrapSeed: 20260804,
  multipleTestingMethod: 'Not yet applied. Every horizon/tier/policy combination currently reported is exploratory until a small primary hypothesis family is pre-registered and corrected for (e.g. Holm for primary tests, Benjamini-Hochberg for secondary ones).',
  minimumEvidenceNotes: `Rating accuracy / Strong Buy / Rating tiers use an extended ${extendedDatasets.length}-ticker set (the original ${datasets.length} hand-curated tickers plus every input/3-year ticker with a usable rating-change history, deduplicated in favor of the 3-year version). Ticker results / Overall results still use only the original ${datasets.length}-ticker set. The ~40-50 ticker / 300+ non-overlapping episode floor generally recommended before a confident reliability verdict is defensible should now be assessed against whichever set actually produced a given number.`,
};

export const getMethodologyConfig = (): MethodologyConfig => METHODOLOGY_CONFIG;

// Deterministic seeded PRNG (mulberry32) — plain Math.random() can't be seeded, and reproducible
// bootstrap resampling (same seed in, same confidence interval out) matters more here than
// cryptographic quality. Returns a function that yields floats in [0, 1) on each call.
const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// Primary confidence interval for a hit rate: resample whole TICKERS with replacement (not
// individual calls), keeping every call belonging to each sampled ticker, and recompute the pooled
// hit rate each time. This is what makes the interval respect the real dependence structure —
// calls from the same ticker share that ticker's own stock-specific noise, sector, and history, so
// treating each call as an independent Bernoulli trial (as the descriptive Wilson interval does)
// understates uncertainty. The percentile interval from the resampled distribution is the primary
// interval; Wilson remains available alongside it for comparison only, per METHODOLOGY_CONFIG.
const bootstrapHitRateCI = (
  callsByTicker: Map<string, boolean[]>,
  repetitions: number,
  seed: number,
): { low: number; high: number } | null => {
  const tickers = [...callsByTicker.entries()];
  if (tickers.length === 0) return null;
  const rand = mulberry32(seed);
  const rates: number[] = [];
  for (let rep = 0; rep < repetitions; rep += 1) {
    let correct = 0;
    let total = 0;
    for (let draw = 0; draw < tickers.length; draw += 1) {
      const [, calls] = tickers[Math.floor(rand() * tickers.length)];
      calls.forEach((isCorrect) => {
        total += 1;
        if (isCorrect) correct += 1;
      });
    }
    if (total > 0) rates.push((correct / total) * 100);
  }
  if (rates.length === 0) return null;
  rates.sort((left, right) => left - right);
  const lowIndex = Math.max(0, Math.floor(rates.length * 0.025));
  const highIndex = Math.min(rates.length - 1, Math.ceil(rates.length * 0.975) - 1);
  return { low: rates[lowIndex], high: rates[highIndex] };
};

const fitLine = (points: Array<{ x: number; y: number }>): { correlation: number | null; slope: number | null; intercept: number | null } => {
  if (points.length < 2) return { correlation: null, slope: null, intercept: null };
  const n = points.length;
  const meanX = points.reduce((total, point) => total + point.x, 0) / n;
  const meanY = points.reduce((total, point) => total + point.y, 0) / n;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  points.forEach((point) => {
    const dx = point.x - meanX;
    const dy = point.y - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  });
  if (varianceX === 0 || varianceY === 0) return { correlation: null, slope: null, intercept: null };
  const slope = covariance / varianceX;
  return { correlation: covariance / Math.sqrt(varianceX * varianceY), slope, intercept: meanY - slope * meanX };
};

// Per-ticker, forward-looking EXPLORATORY chart ("option 2"): does THIS stock's own quant rating
// at time T correlate with what its own price does over the next `horizonDays`, using only that
// ticker's own captured (date, score, price) history. No S&P needed — this is about whether the
// rating is an accurate signal for that stock in absolute terms, not about market-relative skill.
// Every ticker gets its own correlation/slope/intercept so a fit can be traced to one stock, not
// hidden inside a pooled average.
//
// Caveat (do not treat this as a headline result): consecutive daily observations at a fixed
// horizon overlap almost completely — a 365-day observation on Monday and the one on Tuesday share
// 364 of their 365 days — so the point count is not a count of independent tests, and the r value
// overstates confidence. It also scores every daily rating against a future price even when the
// rating changed in between, so it does not answer "was the original call still correct when they
// changed their mind." See `buildRatingCallSummary` below for an event-based test that addresses
// both of those problems; treat this scatter as a rough visual pattern-finder, not a conclusion.
export const buildTickerAccuracy = (horizonDays: number): TickerAccuracy[] =>
  extendedDatasets
    .map((dataset) => {
      const { capture, records } = dataset;
      const points: AccuracyPoint[] = [];

      records.forEach((record, index) => {
        if (!isUsableRecord(record)) return;
        const forward = findForwardRecord(records, index, horizonDays);
        if (!forward) return;
        points.push({
          date: record.date,
          score: record.quantScore,
          rating: record.quantRating,
          price: record.price,
          forwardDate: forward.date,
          forwardPrice: forward.price,
          forwardReturn: ((forward.price / record.price) - 1) * 100,
        });
      });
      const fit = fitLine(points.map((point) => ({ x: point.score, y: point.forwardReturn })));
      return {
        ticker: capture.source.ticker,
        company: capture.source.companyName,
        points,
        ...fit,
      };
    })
    .filter((result) => result.points.length > 0);

export type RatingCallDirection = 'Bullish' | 'Bearish' | 'Neutral';

export type RatingCall = {
  ticker: string;
  company: string;
  rating: Rating;
  direction: RatingCallDirection;
  leftTruncated: boolean;
  signalDate: string;
  entryDate: string | null;
  entryPrice: number | null;
  exitDate: string | null;
  exitPrice: number | null;
  exitReason: 'Rating changed' | 'Horizon reached' | 'Still open' | 'No next trading day';
  daysHeld: number | null;
  returnPercent: number | null;
  marketReturnPercent: number | null;
  excessReturnPercent: number | null;
  marketAdjusted: boolean;
  correct: boolean | null;
};

const callDirection = (rating: Rating): RatingCallDirection => {
  if (rating === 'Strong Buy' || rating === 'Buy') return 'Bullish';
  if (rating === 'Sell' || rating === 'Strong Sell') return 'Bearish';
  return 'Neutral';
};

// 95% Wilson score interval for a binomial proportion — kept as a descriptive/secondary interval
// per METHODOLOGY_CONFIG (it assumes independent calls, which understates uncertainty once calls
// from the same ticker are correlated). The primary interval is the ticker-cluster bootstrap below.
const wilsonInterval = (successes: number, n: number): { low: number; high: number } | null => {
  if (n <= 0) return null;
  const z = 1.96;
  const phat = successes / n;
  const denominator = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((phat * (1 - phat) / n) + (z * z) / (4 * n * n))) / denominator;
  return { low: Math.max(0, (center - margin) * 100), high: Math.min(100, (center + margin) * 100) };
};

// One "episode" per ticker begins at its first usable record or at a rating change — never on an
// unchanged daily repeat — matching a canonical rating-episode definition rather than one call per
// captured day. Entry is deliberately the *next* usable record after the signal (next-trading-day
// rule): the signal date's own price is never used as an entry price, since a real order could not
// have been placed at the exact close the rating became known. `leftTruncated` flags a ticker's
// very first episode, whose true start may predate this dataset's captured history. `usable` is
// shared (not copied) so downstream horizon lookups can walk the same array without re-filtering.
type EpisodeStart = {
  ticker: string;
  company: string;
  rating: Rating;
  direction: RatingCallDirection;
  leftTruncated: boolean;
  signalDate: string;
  entryDate: string | null;
  entryPrice: number | null;
  entryIndex: number | null;
  nextChangeIndex: number | null;
  usable: CaptureRecord[];
};

const buildEpisodeStarts = (source: CaptureDataset[]): EpisodeStart[] => {
  const episodes: EpisodeStart[] = [];
  source.forEach((dataset) => {
    const { capture, records } = dataset;
    const usable = records.filter(isUsableRecord);
    let index = 0;
    while (index < usable.length) {
      const signal = usable[index];
      const rating = signal.quantRating;
      let nextChangeIndex: number | null = null;
      for (let j = index + 1; j < usable.length; j += 1) {
        if (usable[j].quantRating !== rating) { nextChangeIndex = j; break; }
      }
      const entryIndex = index + 1 < usable.length ? index + 1 : null;
      episodes.push({
        ticker: capture.source.ticker,
        company: capture.source.companyName,
        rating,
        direction: callDirection(rating),
        leftTruncated: index === 0,
        signalDate: signal.date,
        entryDate: entryIndex !== null ? usable[entryIndex].date : null,
        entryPrice: entryIndex !== null ? usable[entryIndex].price : null,
        entryIndex,
        nextChangeIndex,
        usable,
      });
      index = nextChangeIndex ?? usable.length;
    }
  });
  return episodes;
};

type ScorableCall = {
  ticker: string;
  rating: Rating;
  direction: RatingCallDirection;
  correct: boolean | null;
  returnPercent: number | null;
  excessReturnPercent: number | null;
};

export type TierStats = {
  scoredCalls: number;
  correctCalls: number;
  hitRate: number | null;
  hitRateBootstrapLow: number | null;
  hitRateBootstrapHigh: number | null;
  medianExcessReturn: number | null;
  tickers: number;
};

type CallStats = {
  scoredCalls: number;
  correctCalls: number;
  incorrectCalls: number;
  hitRate: number | null;
  hitRateLow: number | null;
  hitRateHigh: number | null;
  hitRateBootstrapLow: number | null;
  hitRateBootstrapHigh: number | null;
  tickerWeightedHitRate: number | null;
  averageReturn: number | null;
  medianReturn: number | null;
  byTier: Partial<Record<Rating, TierStats>>;
};

const RATING_ORDER: Rating[] = ['Strong Buy', 'Buy', 'Hold', 'Sell', 'Strong Sell'];

// Shared aggregation for both the strategy-style and predictive-accuracy call tests: call-weighted
// hit rate plus Wilson (descriptive) and ticker-cluster-bootstrap (primary) intervals, a
// ticker-weighted hit rate (each ticker's own hit rate averaged, so no single frequently-changing
// ticker dominates the pooled number), and a full per-tier breakdown (item 4/5 in the review this
// responds to — Buy is never silently merged into Strong Buy, nor Sell into Strong Sell).
const aggregateCallStats = (calls: ScorableCall[], bootstrapSeed: number, bootstrapRepetitions: number): CallStats => {
  const scored = calls.filter((call): call is ScorableCall & { correct: boolean } => call.correct !== null);
  const correctCalls = scored.filter((call) => call.correct).length;
  const incorrectCalls = scored.length - correctCalls;
  const wilson = wilsonInterval(correctCalls, scored.length);

  const byTicker = new Map<string, boolean[]>();
  scored.forEach((call) => {
    const list = byTicker.get(call.ticker) ?? [];
    list.push(call.correct);
    byTicker.set(call.ticker, list);
  });
  const bootstrap = bootstrapHitRateCI(byTicker, bootstrapRepetitions, bootstrapSeed);
  const tickerRates = [...byTicker.values()].map((list) => (list.filter(Boolean).length / list.length) * 100);
  const tickerWeightedHitRate = tickerRates.length
    ? tickerRates.reduce((total, value) => total + value, 0) / tickerRates.length
    : null;

  const effectiveReturns = scored
    .map((call) => call.excessReturnPercent ?? call.returnPercent)
    .filter((value): value is number => value !== null);

  const byTier: Partial<Record<Rating, TierStats>> = {};
  RATING_ORDER.forEach((tier) => {
    const tierCalls = calls.filter((call) => call.rating === tier);
    const tierScored = tierCalls.filter((call): call is ScorableCall & { correct: boolean } => call.correct !== null);
    const tierCorrect = tierScored.filter((call) => call.correct).length;
    const tierByTicker = new Map<string, boolean[]>();
    tierScored.forEach((call) => {
      const list = tierByTicker.get(call.ticker) ?? [];
      list.push(call.correct);
      tierByTicker.set(call.ticker, list);
    });
    const tierBootstrap = bootstrapHitRateCI(tierByTicker, bootstrapRepetitions, bootstrapSeed);
    const tierReturns = tierCalls
      .map((call) => call.excessReturnPercent ?? call.returnPercent)
      .filter((value): value is number => value !== null);
    byTier[tier] = {
      scoredCalls: tierScored.length,
      correctCalls: tierCorrect,
      hitRate: tierScored.length ? (tierCorrect / tierScored.length) * 100 : null,
      hitRateBootstrapLow: tierBootstrap?.low ?? null,
      hitRateBootstrapHigh: tierBootstrap?.high ?? null,
      medianExcessReturn: tierReturns.length ? median(tierReturns) : null,
      tickers: new Set(tierCalls.map((call) => call.ticker)).size,
    };
  });

  return {
    scoredCalls: scored.length,
    correctCalls,
    incorrectCalls,
    hitRate: scored.length ? (correctCalls / scored.length) * 100 : null,
    hitRateLow: wilson?.low ?? null,
    hitRateHigh: wilson?.high ?? null,
    hitRateBootstrapLow: bootstrap?.low ?? null,
    hitRateBootstrapHigh: bootstrap?.high ?? null,
    tickerWeightedHitRate,
    averageReturn: effectiveReturns.length
      ? effectiveReturns.reduce((total, value) => total + value, 0) / effectiveReturns.length
      : null,
    medianReturn: effectiveReturns.length ? median(effectiveReturns) : null,
    byTier,
  };
};

export type RatingCallSummary = CallStats & {
  horizonDays: number;
  calls: RatingCall[];
  openCalls: number;
  unenterableCalls: number;
  neutralCalls: number;
};

// Strategy-style event-based test: walks each ticker's history and opens a call at every episode
// start (see buildEpisodeStarts). A call closes at the first of (a) the rating changing again, or
// (b) `horizonDays` elapsing from ENTRY — whichever comes first — because this answers "how would
// an investor who reacted to every rating change have done," which is a genuinely different
// question from fixed-horizon predictive accuracy (see buildPredictiveAccuracySummary below; do not
// use this test's numbers as a stand-in for that one, or vice versa). Correctness is market-adjusted
// (excess return over SPY across the same entry/exit dates) whenever benchmark data is available for
// that date range, falling back to absolute price direction (marketAdjusted: false) otherwise — see
// marketReturnBetween. Hold calls are tracked but excluded from the hit rate.
export const buildRatingCallSummary = (horizonDays: number): RatingCallSummary => {
  const episodes = buildEpisodeStarts(extendedDatasets);

  const calls: RatingCall[] = episodes.map((episode) => {
    const base = {
      ticker: episode.ticker,
      company: episode.company,
      rating: episode.rating,
      direction: episode.direction,
      leftTruncated: episode.leftTruncated,
      signalDate: episode.signalDate,
    };

    if (episode.entryIndex === null || episode.entryDate === null || episode.entryPrice === null) {
      return {
        ...base,
        entryDate: null,
        entryPrice: null,
        exitDate: null,
        exitPrice: null,
        exitReason: 'No next trading day' as const,
        daysHeld: null,
        returnPercent: null,
        marketReturnPercent: null,
        excessReturnPercent: null,
        marketAdjusted: false,
        correct: null,
      };
    }

    const { usable, entryIndex, entryDate, entryPrice, nextChangeIndex } = episode;
    const cutoffTime = new Date(entryDate).getTime() + horizonDays * 86_400_000;
    let exitIndex = -1;
    for (let j = entryIndex; j < usable.length; j += 1) {
      if (nextChangeIndex !== null && j >= nextChangeIndex) { exitIndex = j; break; }
      if (new Date(usable[j].date).getTime() >= cutoffTime) { exitIndex = j; break; }
    }

    if (exitIndex === -1) {
      return {
        ...base,
        entryDate,
        entryPrice,
        exitDate: null,
        exitPrice: null,
        exitReason: 'Still open' as const,
        daysHeld: null,
        returnPercent: null,
        marketReturnPercent: null,
        excessReturnPercent: null,
        marketAdjusted: false,
        correct: null,
      };
    }

    const exit = usable[exitIndex];
    const exitReason: RatingCall['exitReason'] = exit.quantRating !== episode.rating ? 'Rating changed' : 'Horizon reached';
    const returnPercent = ((exit.price / entryPrice) - 1) * 100;
    const marketReturnPercent = marketReturnBetween(entryDate, exit.date);
    const excessReturnPercent = marketReturnPercent !== null ? returnPercent - marketReturnPercent : null;
    const effectiveReturn = excessReturnPercent ?? returnPercent;
    const correct = episode.direction === 'Neutral' ? null : episode.direction === 'Bullish' ? effectiveReturn > 0 : effectiveReturn < 0;

    return {
      ...base,
      entryDate,
      entryPrice,
      exitDate: exit.date,
      exitPrice: exit.price,
      exitReason,
      daysHeld: (new Date(exit.date).getTime() - new Date(entryDate).getTime()) / 86_400_000,
      returnPercent,
      marketReturnPercent,
      excessReturnPercent,
      marketAdjusted: marketReturnPercent !== null,
      correct,
    };
  });

  const stats = aggregateCallStats(
    calls.map((call) => ({
      ticker: call.ticker,
      rating: call.rating,
      direction: call.direction,
      correct: call.correct,
      returnPercent: call.returnPercent,
      excessReturnPercent: call.excessReturnPercent,
    })),
    METHODOLOGY_CONFIG.bootstrapSeed,
    METHODOLOGY_CONFIG.bootstrapRepetitions,
  );

  return {
    horizonDays,
    calls,
    ...stats,
    openCalls: calls.filter((call) => call.exitReason === 'Still open').length,
    unenterableCalls: calls.filter((call) => call.exitReason === 'No next trading day').length,
    neutralCalls: calls.filter((call) => call.direction === 'Neutral').length,
  };
};

export type PredictiveOutcome = {
  ticker: string;
  company: string;
  rating: Rating;
  direction: RatingCallDirection;
  leftTruncated: boolean;
  signalDate: string;
  entryDate: string | null;
  entryPrice: number | null;
  exitDate: string | null;
  exitPrice: number | null;
  returnPercent: number | null;
  marketReturnPercent: number | null;
  excessReturnPercent: number | null;
  marketAdjusted: boolean;
  censored: boolean;
  correct: boolean | null;
};

export type PredictiveAccuracySummary = CallStats & {
  horizonDays: number;
  outcomes: PredictiveOutcome[];
  censoredCalls: number;
  neutralCalls: number;
};

// Predictive-accuracy test: does the ORIGINAL rating, held fixed, correctly predict the stock's
// market-adjusted direction over a fixed forward horizon -- regardless of whether the rating later
// changed? This intentionally does NOT exit early on a rating change (unlike buildRatingCallSummary
// above): ending the observation window just because the rating changed would mix "was the original
// call right at 90 days" with portfolio-management behavior, which the methodology review this
// responds to calls out specifically. A call whose fixed-horizon outcome falls outside the captured
// history (or outside the forward-match tolerance band) is right-censored -- not scored as a win or
// a loss, counted and reported separately instead of silently dropped.
export const buildPredictiveAccuracySummary = (horizonDays: number): PredictiveAccuracySummary => {
  const episodes = buildEpisodeStarts(extendedDatasets);
  const toleranceMs = FORWARD_MATCH_TOLERANCE_DAYS * 86_400_000;

  const outcomes: PredictiveOutcome[] = episodes.map((episode) => {
    const base = {
      ticker: episode.ticker,
      company: episode.company,
      rating: episode.rating,
      direction: episode.direction,
      leftTruncated: episode.leftTruncated,
      signalDate: episode.signalDate,
    };

    if (episode.entryIndex === null || episode.entryDate === null || episode.entryPrice === null) {
      return {
        ...base,
        entryDate: null,
        entryPrice: null,
        exitDate: null,
        exitPrice: null,
        returnPercent: null,
        marketReturnPercent: null,
        excessReturnPercent: null,
        marketAdjusted: false,
        censored: true,
        correct: null,
      };
    }

    const { usable, entryIndex, entryDate, entryPrice } = episode;
    const targetTime = new Date(entryDate).getTime() + horizonDays * 86_400_000;
    let best: CaptureRecord | null = null;
    let bestDiff = Infinity;
    for (let j = entryIndex; j < usable.length; j += 1) {
      const time = new Date(usable[j].date).getTime();
      if (time > targetTime + toleranceMs) break;
      const diff = Math.abs(time - targetTime);
      if (diff <= toleranceMs && diff < bestDiff) { best = usable[j]; bestDiff = diff; }
    }

    if (!best) {
      return {
        ...base,
        entryDate,
        entryPrice,
        exitDate: null,
        exitPrice: null,
        returnPercent: null,
        marketReturnPercent: null,
        excessReturnPercent: null,
        marketAdjusted: false,
        censored: true,
        correct: null,
      };
    }

    const returnPercent = ((best.price / entryPrice) - 1) * 100;
    const marketReturnPercent = marketReturnBetween(entryDate, best.date);
    const excessReturnPercent = marketReturnPercent !== null ? returnPercent - marketReturnPercent : null;
    const effectiveReturn = excessReturnPercent ?? returnPercent;
    const correct = episode.direction === 'Neutral' ? null : episode.direction === 'Bullish' ? effectiveReturn > 0 : effectiveReturn < 0;

    return {
      ...base,
      entryDate,
      entryPrice,
      exitDate: best.date,
      exitPrice: best.price,
      returnPercent,
      marketReturnPercent,
      excessReturnPercent,
      marketAdjusted: marketReturnPercent !== null,
      censored: false,
      correct,
    };
  });

  const stats = aggregateCallStats(
    outcomes.map((outcome) => ({
      ticker: outcome.ticker,
      rating: outcome.rating,
      direction: outcome.direction,
      correct: outcome.correct,
      returnPercent: outcome.returnPercent,
      excessReturnPercent: outcome.excessReturnPercent,
    })),
    METHODOLOGY_CONFIG.bootstrapSeed,
    METHODOLOGY_CONFIG.bootstrapRepetitions,
  );

  return {
    horizonDays,
    outcomes,
    ...stats,
    censoredCalls: outcomes.filter((outcome) => outcome.censored).length,
    neutralCalls: outcomes.filter((outcome) => outcome.direction === 'Neutral').length,
  };
};

// ---------------------------------------------------------------------------
// Portfolio backtest
//
// A portfolio is formed on each rebalance date from the ratings known on that
// date, then entered on the next available recorded session. This is separate
// from the per-ticker replay and avoids treating a same-day rating as if it
// had been known before that day's close.
// ---------------------------------------------------------------------------
export type PortfolioRatingFilter = 'strong-buy' | 'bullish-plus';
export type PortfolioRebalance = 'weekly' | 'monthly' | 'quarterly';
export type PortfolioWeighting = 'equal' | 'score';

export type PortfolioConfig = {
  startDate: string;
  endDate: string;
  portfolioSize: number;
  ratingFilter: PortfolioRatingFilter;
  rebalance: PortfolioRebalance;
  weighting: PortfolioWeighting;
  // Sell as soon as a holding stops qualifying, rather than waiting for the next rebalance. This
  // is the difference between "hold winners while they remain winners" and "hold whatever was a
  // winner at the start of the quarter". It used to be declared and never read.
  exitOnRatingDrop: boolean;
  // Hard cap on how long any single position is held, in calendar days. null = no cap.
  maxHoldDays: number | null;
  // Optional fixed universe used by holdout validation. Normal portfolio runs omit this and use
  // the full imported universe; validation runs never allow the winner to see the holdout names.
  universeTickers?: string[];
};

export type PortfolioPoint = { date: string; portfolioValue: number; benchmarkValue: number; poolValue: number };
export type PortfolioHolding = {
  ticker: string; company: string; weight: number; entryDate: string; entryPrice: number;
  returnPercent: number;
  // How long this name has actually been held at the end of the test. A position opened on the
  // final rebalance has had no time to move, so its return is trivially near zero -- without this
  // the closing snapshot reads as if the strategy went nowhere.
  daysHeld: number;
};
export type PortfolioRebalanceEvent = { date: string; selected: string[]; added: string[]; removed: string[] };
export type PortfolioTrade = {
  date: string;
  ticker: string;
  action: 'buy' | 'sell';
  // What the trade did to the position, which is not the same question as its direction. A
  // rebalance trims winners and tops up laggards to bring weights back to target: those are real
  // executions, but they are not entering or leaving a name, and a timeline that calls them all
  // "BUY" buries the handful of decisions that matter under hundreds of housekeeping rows.
  kind: 'open' | 'add' | 'trim' | 'close';
  price: number;
  // Only meaningful for a close: it is why the position was exited. Opens carry 'rebalance'
  // (scheduled) or 'replacement' (bought with cash freed by another name's exit).
  reason: 'rebalance' | 'replacement' | 'rating-drop' | 'max-hold' | 'end-of-test';
  heldDays: number | null;
};
export type PortfolioExitReason = 'rebalance' | 'rating-drop' | 'max-hold' | 'end-of-test';

export type PortfolioBacktestResult = {
  config: PortfolioConfig;
  summary: {
    portfolioReturn: number;
    benchmarkReturn: number;
    excessReturn: number;
    // Owning every eligible stock over the same dates, equally weighted, with no selection at all.
    // This is the number that matters: the candidate pool only contains companies still covered at
    // export time, so it already beats SPY before any stock-picking happens. Excess over SPY mixes
    // that head start into the headline; excess over the pool is what the selection rule actually
    // contributed.
    poolReturn: number;
    excessVsPool: number;
    poolHoldings: number;
    maxDrawdown: number;
    rebalanceCount: number;
    averageHoldings: number;
    periods: number;
    tradeCount: number;
    exitReasons: Record<PortfolioExitReason, number>;
    // Counted here, in the summary, rather than derived by the caller from `rebalances` or
    // `trades`. The comparison table ships neither of those arrays -- they were 105 MB across the
    // grid -- so anything computed from them silently read as zero.
    positionsOpened: number;
    openedAtRebalance: number;
    openedAsReplacement: number;
    closedAtRebalance: number;
    closedMidPeriod: number;
  };
  equityCurve: PortfolioPoint[];
  holdings: PortfolioHolding[];
  rebalances: PortfolioRebalanceEvent[];
  trades: PortfolioTrade[];
  warnings: string[];
};

const portfolioRatingAllowed = (rating: Rating, filter: PortfolioRatingFilter) =>
  filter === 'strong-buy' ? rating === 'Strong Buy' : isBullish(rating);

const portfolioPeriodKey = (date: Date, rebalance: PortfolioRebalance) => {
  if (rebalance === 'weekly') {
    const first = new Date(date.getFullYear(), 0, 1);
    const week = Math.floor((date.getTime() - first.getTime()) / (7 * 24 * 60 * 60 * 1000));
    return date.getFullYear() + '-w' + week;
  }
  const period = rebalance === 'quarterly' ? Math.floor(date.getMonth() / 3) : date.getMonth();
  return date.getFullYear() + '-' + period;
};

// Day-by-day simulation rather than period-return arithmetic. Three things depend on it:
// an exit rule can fire between rebalances, drawdown can be measured on daily values instead of
// only at rebalance dates, and the pool baseline runs through exactly the same machinery so the
// comparison is apples to apples.

type AlignedIndex = {
  calendar: string[];
  // For each ticker, the record in force on each calendar day (last one on or before it), so
  // "what was this rated that day" is an array lookup rather than a scan. Built once per dataset
  // load and reused by every configuration in the grid.
  byTicker: Map<string, { dataset: CaptureDataset; records: Array<CaptureRecord | null> }>;
};

let portfolioIndex: AlignedIndex | null = null;
const poolCache = new Map<string, ReturnType<typeof simulatePortfolio>>();

const buildPortfolioIndex = (): AlignedIndex => {
  if (portfolioIndex) return portfolioIndex;
  const calendar = [...new Set(extendedDatasets.flatMap((dataset) => dataset.records.map((record) => record.date)))].sort();
  const byTicker = new Map<string, { dataset: CaptureDataset; records: Array<CaptureRecord | null> }>();
  for (const dataset of extendedDatasets) {
    const aligned: Array<CaptureRecord | null> = new Array(calendar.length).fill(null);
    let cursor = 0;
    let current: CaptureRecord | null = null;
    for (let index = 0; index < calendar.length; index += 1) {
      while (cursor < dataset.records.length && dataset.records[cursor].date <= calendar[index]) {
        current = dataset.records[cursor];
        cursor += 1;
      }
      aligned[index] = current;
    }
    byTicker.set(dataset.capture.source.ticker, { dataset, records: aligned });
  }
  portfolioIndex = { calendar, byTicker };
  return portfolioIndex;
};

const portfolioRatingAllowedAt = (record: CaptureRecord | null, filter: PortfolioRatingFilter, asOf: string) => {
  if (!record || record.price <= 0) return false;
  // A rating more than ten days stale is not a live signal; the same guard the previous
  // implementation applied at selection time, now applied on every day it matters.
  const ageDays = (Date.parse(asOf) - Date.parse(record.date)) / (24 * 60 * 60 * 1000);
  if (ageDays > 10) return false;
  return portfolioRatingAllowed(record.quantRating, filter);
};

type OpenPosition = {
  ticker: string;
  shares: number;
  entryDate: string;
  entryPrice: number;
  lastPrice: number;
};

type SimulationOptions = {
  config: PortfolioConfig;
  ownEverything: boolean;   // the pool baseline: no ranking, no size cap, no exit rules
};

const simulatePortfolio = ({ config, ownEverything }: SimulationOptions) => {
  const { calendar, byTicker } = buildPortfolioIndex();
  const allowedTickers = config.universeTickers ? new Set(config.universeTickers) : null;
  const tickerEntries = [...byTicker.entries()].filter(([ticker]) => !allowedTickers || allowedTickers.has(ticker));
  const indices: number[] = [];
  for (let index = 0; index < calendar.length; index += 1) {
    if (calendar[index] >= config.startDate && calendar[index] <= config.endDate) indices.push(index);
  }

  const rebalanceDays = new Set<number>();
  let previousPeriod = '';
  for (const index of indices) {
    const key = portfolioPeriodKey(new Date(calendar[index]), config.rebalance);
    if (key !== previousPeriod) { rebalanceDays.add(index); previousPeriod = key; }
  }

  const size = ownEverything ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.min(500, config.portfolioSize));
  const positions = new Map<string, OpenPosition>();
  const equityCurve: PortfolioPoint[] = [];
  const rebalances: PortfolioRebalanceEvent[] = [];
  const trades: PortfolioTrade[] = [];
  const exitReasons: Record<PortfolioExitReason, number> = { rebalance: 0, 'rating-drop': 0, 'max-hold': 0, 'end-of-test': 0 };
  const warnings: string[] = [];

  let cash = 100;
  let peak = 100;
  let maxDrawdown = 0;
  let tradeCount = 0;
  let holdingsSeen = 0;
  let holdingsSamples = 0;
  // Signals are computed at one session's close and executed at the next, so a rating published
  // on day d never buys at day d's price.
  // `target` is always the full intended book, not just the new names, so a rebalance can
  // re-weight everything that should be held rather than only what is being added.
  let pending: { sells: Set<string>; sellReasons: Map<string, PortfolioTrade['reason']>; target: string[]; retarget: boolean } | null = null;

  const priceAt = (ticker: string, index: number) => {
    const entry = byTicker.get(ticker);
    const record = entry?.records[index];
    return record && record.price > 0 ? record.price : null;
  };

  const valueOf = (position: OpenPosition) => position.shares * position.lastPrice;

  for (const index of indices) {
    const date = calendar[index];

    // 1. Mark open positions to today's prices (carry the last known price if a ticker did not
    //    trade), so the equity curve is daily rather than one point per rebalance.
    for (const position of positions.values()) {
      const price = priceAt(position.ticker, index);
      if (price !== null) position.lastPrice = price;
    }

    // 2. Execute whatever yesterday's close decided.
    if (pending) {
      for (const ticker of pending.sells) {
        const position = positions.get(ticker);
        if (!position) continue;
        const price = priceAt(ticker, index) ?? position.lastPrice;
        cash += position.shares * price;
        positions.delete(ticker);
        trades.push({ date, ticker, action: 'sell', kind: 'close', price, reason: pending.sellReasons.get(ticker) ?? 'rebalance', heldDays: Math.max(0, Math.round((Date.parse(date) - Date.parse(position.entryDate)) / (24 * 60 * 60 * 1000))) });
        tradeCount += 1;
      }
      const investable = pending.target.filter((ticker) => priceAt(ticker, index) !== null);
      if (investable.length) {
        // Weights are computed over the names that can actually be bought today, so a ticker that
        // cannot be priced does not silently leave part of the book sitting in cash.
        const weights = investable.map((ticker) => {
          if (config.weighting !== 'score' || ownEverything) return 1;
          const record = byTicker.get(ticker)?.records[index];
          return Math.max(0.01, record?.quantScore ?? 1);
        });
        const weightTotal = weights.reduce((sum, value) => sum + value, 0);

        if (pending.retarget) {
          // A rebalance re-weights the whole book, not just the new names. Without this, a holding
          // that was kept from last period simply carries its drifted value forward while the new
          // names split whatever cash happens to be free -- so an "equal weight" portfolio ended up
          // anywhere from 5% to 22% per name, quietly turning past winners into oversized bets and
          // adding a momentum tilt nobody asked for.
          let total = cash;
          for (const position of positions.values()) total += valueOf(position);
          investable.forEach((ticker, slot) => {
            const price = priceAt(ticker, index)!;
            const desired = total * (weights[slot] / weightTotal);
            const existing = positions.get(ticker);
            const current = existing ? valueOf(existing) : 0;
            if (Math.abs(desired - current) < total * 1e-6) return;
            cash += current - desired;
            if (!existing) {
              positions.set(ticker, { ticker, shares: desired / price, entryDate: date, entryPrice: price, lastPrice: price });
              trades.push({ date, ticker, action: 'buy', kind: 'open', price, reason: 'rebalance', heldDays: null });
            } else {
              // Topping up moves the cost basis, so entry price is a weighted average of what was
              // actually paid; the entry date stays at first purchase.
              const addedValue = desired - current;
              const heldDays = Math.max(0, Math.round((Date.parse(date) - Date.parse(existing.entryDate)) / (24 * 60 * 60 * 1000)));
              if (addedValue > 0) {
                const totalCost = existing.shares * existing.entryPrice + addedValue;
                existing.shares = desired / price;
                existing.entryPrice = totalCost / existing.shares;
              } else {
                existing.shares = desired / price;
              }
              existing.lastPrice = price;
              // Trimming a position sells shares. Recording it as a buy was simply wrong.
              trades.push({
                date, ticker,
                action: addedValue > 0 ? 'buy' : 'sell',
                kind: addedValue > 0 ? 'add' : 'trim',
                price, reason: 'rebalance', heldDays,
              });
            }
            tradeCount += 1;
          });
        } else {
          // Mid-period: a holding was sold on a downgrade or a hold limit. Only the freed cash is
          // deployed -- re-weighting the entire book on every downgrade would be enormous turnover
          // and is not what the rule says to do.
          const fresh = investable.filter((ticker) => !positions.has(ticker));
          if (fresh.length) {
            const freshWeights = fresh.map((ticker) => weights[investable.indexOf(ticker)]);
            const freshTotal = freshWeights.reduce((sum, value) => sum + value, 0);
            const available = cash;
            fresh.forEach((ticker, slot) => {
              const price = priceAt(ticker, index)!;
              const allocation = available * (freshWeights[slot] / freshTotal);
              if (allocation <= 0) return;
              positions.set(ticker, { ticker, shares: allocation / price, entryDate: date, entryPrice: price, lastPrice: price });
              trades.push({ date, ticker, action: 'buy', kind: 'open', price, reason: 'replacement', heldDays: null });
              cash -= allocation;
              tradeCount += 1;
            });
          }
        }
      }
      pending = null;
    }

    // 3. Today's signals, for execution tomorrow.
    const sells = new Set<string>();
    const sellReasons = new Map<string, PortfolioTrade['reason']>();
    let buys: string[] = [];
    let isRebalance = false;

    if (!ownEverything && config.exitOnRatingDrop) {
      for (const position of positions.values()) {
        const record = byTicker.get(position.ticker)?.records[index] ?? null;
        if (!portfolioRatingAllowedAt(record, config.ratingFilter, date)) {
          sells.add(position.ticker);
          sellReasons.set(position.ticker, 'rating-drop');
          exitReasons['rating-drop'] += 1;
        }
      }
    }
    if (!ownEverything && config.maxHoldDays !== null) {
      for (const position of positions.values()) {
        const heldDays = (Date.parse(date) - Date.parse(position.entryDate)) / (24 * 60 * 60 * 1000);
        if (heldDays >= config.maxHoldDays && !sells.has(position.ticker)) {
          sells.add(position.ticker);
          sellReasons.set(position.ticker, 'max-hold');
          exitReasons['max-hold'] += 1;
        }
      }
    }

    if (rebalanceDays.has(index)) {
      const eligible: Array<{ ticker: string; score: number }> = [];
      for (const [ticker, entry] of tickerEntries) {
        const record = entry.records[index];
        if (portfolioRatingAllowedAt(record, config.ratingFilter, date)) eligible.push({ ticker, score: record!.quantScore });
      }
      eligible.sort((left, right) => (right.score - left.score) || left.ticker.localeCompare(right.ticker));
      const target = eligible.slice(0, size).map((item) => item.ticker);
      const targetSet = new Set(target);
      const held = [...positions.keys()];
      for (const ticker of held) {
        if (!targetSet.has(ticker) && !sells.has(ticker)) { sells.add(ticker); sellReasons.set(ticker, 'rebalance'); exitReasons.rebalance += 1; }
      }
      buys = target;
      isRebalance = true;
      if (!eligible.length) warnings.push('No eligible stocks were available on ' + date + '.');
      else if (!ownEverything && eligible.length < config.portfolioSize) {
        warnings.push('Some rebalance dates had fewer eligible stocks than the requested portfolio size.');
      }
      rebalances.push({
        date,
        selected: target,
        added: target.filter((ticker) => !positions.has(ticker)),
        removed: held.filter((ticker) => !targetSet.has(ticker)),
      });
      holdingsSeen += target.length;
      holdingsSamples += 1;
    } else if (sells.size) {
      // A mid-period exit frees cash. Redeploy it into the best names that qualify right now,
      // otherwise "sell early" would just be "hold cash", which is a different strategy.
      const wanted = new Set([...positions.keys()].filter((ticker) => !sells.has(ticker)));
      const eligible: Array<{ ticker: string; score: number }> = [];
      for (const [ticker, entry] of tickerEntries) {
        if (wanted.has(ticker)) continue;
        const record = entry.records[index];
        if (portfolioRatingAllowedAt(record, config.ratingFilter, date)) eligible.push({ ticker, score: record!.quantScore });
      }
      eligible.sort((left, right) => (right.score - left.score) || left.ticker.localeCompare(right.ticker));
      buys = [...wanted, ...eligible.slice(0, Math.max(0, size - wanted.size)).map((item) => item.ticker)];
    }

    if (sells.size || buys.length) pending = { sells, sellReasons, target: buys, retarget: isRebalance };

    // 4. Record today's value.
    let held = cash;
    for (const position of positions.values()) held += valueOf(position);
    peak = Math.max(peak, held);
    maxDrawdown = Math.min(maxDrawdown, ((held / peak) - 1) * 100);
    equityCurve.push({ date, portfolioValue: held, benchmarkValue: 0, poolValue: 0 });
  }

  const lastIndex = indices[indices.length - 1];
  const finalHoldings: PortfolioHolding[] = [];
  let finalValue = cash;
  for (const position of positions.values()) finalValue += valueOf(position);
  for (const position of positions.values()) {
    finalHoldings.push({
      ticker: position.ticker,
      company: byTicker.get(position.ticker)?.dataset.capture.source.companyName ?? position.ticker,
      weight: finalValue > 0 ? valueOf(position) / finalValue : 0,
      entryDate: position.entryDate,
      entryPrice: position.entryPrice,
      returnPercent: ((position.lastPrice / position.entryPrice) - 1) * 100,
      daysHeld: Math.round((Date.parse(calendar[lastIndex]) - Date.parse(position.entryDate)) / (24 * 60 * 60 * 1000)),
    });
    exitReasons['end-of-test'] += 1;
  }
  finalHoldings.sort((left, right) => right.weight - left.weight);

  return {
    finalValue,
    equityCurve,
    rebalances,
    finalHoldings,
    trades,
    maxDrawdown,
    tradeCount,
    exitReasons,
    warnings,
    averageHoldings: holdingsSamples ? holdingsSeen / holdingsSamples : 0,
    lastIndex,
  };
};

export const buildPortfolioBacktest = (config: PortfolioConfig): PortfolioBacktestResult => {
  const empty = (warning: string): PortfolioBacktestResult => ({
    config,
    summary: {
      portfolioReturn: 0, benchmarkReturn: 0, excessReturn: 0,
      poolReturn: 0, excessVsPool: 0, poolHoldings: 0,
      maxDrawdown: 0, rebalanceCount: 0, averageHoldings: 0, periods: 0, tradeCount: 0,
      exitReasons: { rebalance: 0, 'rating-drop': 0, 'max-hold': 0, 'end-of-test': 0 },
      positionsOpened: 0, openedAtRebalance: 0, openedAsReplacement: 0,
      closedAtRebalance: 0, closedMidPeriod: 0,
    },
    equityCurve: [], holdings: [], rebalances: [], trades: [], warnings: [warning],
  });

  const start = new Date(config.startDate);
  const end = new Date(config.endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    return empty('Choose a valid start date before the end date.');
  }

  const run = simulatePortfolio({ config, ownEverything: false });
  if (!run.equityCurve.length) return empty('There are no captured rating dates in this period.');

  // Same engine, same dates, same rebalance cadence, no ranking and no exit rules. It depends only
  // on the date range, the filter and the cadence -- not on size, weighting or the exit rules --
  // so the grid search would otherwise recompute the same handful of baselines hundreds of times.
  const universeKey = config.universeTickers ? [...config.universeTickers].sort().join(',') : 'all';
  const poolKey = [config.startDate, config.endDate, config.ratingFilter, config.rebalance, universeKey].join('|');
  let pool = poolCache.get(poolKey);
  if (!pool) {
    pool = simulatePortfolio({ config, ownEverything: true });
    poolCache.set(poolKey, pool);
  }

  const spy = benchmarkByTicker.get(MARKET_TICKER) ?? [];
  const firstDate = new Date(run.equityCurve[0].date);
  const spyStart = quoteOnOrBefore(spy, firstDate);
  const benchmarkFor = (date: string) => {
    const quote = quoteOnOrBefore(spy, new Date(date));
    return spyStart && quote && spyStart.adjClose > 0 ? 100 * (quote.adjClose / spyStart.adjClose) : 100;
  };

  const poolByDate = new Map(pool.equityCurve.map((point) => [point.date, point.portfolioValue]));
  const equityCurve = run.equityCurve.map((point) => ({
    date: point.date,
    portfolioValue: point.portfolioValue,
    benchmarkValue: benchmarkFor(point.date),
    poolValue: poolByDate.get(point.date) ?? 100,
  }));

  const portfolioReturn = run.finalValue - 100;
  const benchmarkReturn = (equityCurve[equityCurve.length - 1]?.benchmarkValue ?? 100) - 100;
  const poolReturn = pool.finalValue - 100;

  return {
    config,
    summary: {
      portfolioReturn,
      benchmarkReturn,
      excessReturn: portfolioReturn - benchmarkReturn,
      poolReturn,
      excessVsPool: portfolioReturn - poolReturn,
      poolHoldings: pool.averageHoldings,
      maxDrawdown: run.maxDrawdown,
      rebalanceCount: run.rebalances.length,
      averageHoldings: run.averageHoldings,
      periods: equityCurve.length,
      tradeCount: run.tradeCount,
      exitReasons: run.exitReasons,
      // Counted off the executed trade log, which is the record of what actually happened, rather
      // than off the signals that scheduled them.
      positionsOpened: run.trades.filter((trade) => trade.kind === 'open').length,
      openedAtRebalance: run.trades.filter((trade) => trade.kind === 'open' && trade.reason === 'rebalance').length,
      openedAsReplacement: run.trades.filter((trade) => trade.kind === 'open' && trade.reason === 'replacement').length,
      closedAtRebalance: run.trades.filter((trade) => trade.kind === 'close' && trade.reason === 'rebalance').length,
      closedMidPeriod: run.trades.filter((trade) => trade.kind === 'close'
        && (trade.reason === 'rating-drop' || trade.reason === 'max-hold')).length,
    },
    equityCurve,
    holdings: run.finalHoldings,
    rebalances: run.rebalances,
    trades: run.trades,
    warnings: [...new Set(run.warnings)],
  };
};


export type PortfolioSearchResult = {
  results: PortfolioBacktestResult[];
  // Everything needed to read the winner honestly: how many configurations were tried, and where
  // the winner sits in that spread. A maximum over a large search is not an estimate of what the
  // strategy earns -- it is an estimate of the luckiest configuration, and the two are only the
  // same thing when the search is small and the spread is tight.
  search: {
    configurationsTried: number;
    beatPoolCount: number;
    bestExcessVsPool: number;
    medianExcessVsPool: number;
    worstExcessVsPool: number;
    poolReturn: number;
    benchmarkReturn: number;
  };
};

export const buildBestPortfolioBacktests = (
  base: Omit<PortfolioConfig, 'portfolioSize' | 'ratingFilter' | 'rebalance' | 'weighting' | 'exitOnRatingDrop' | 'maxHoldDays'>,
): PortfolioSearchResult => {
  const sizes = [10, 20, 50, 100];
  const filters: PortfolioRatingFilter[] = ['strong-buy', 'bullish-plus'];
  const rebalances: PortfolioRebalance[] = ['weekly', 'monthly', 'quarterly'];
  const weightings: PortfolioWeighting[] = ['equal', 'score'];
  const exits = [false, true];
  const holds: Array<number | null> = [null, 90, 180];

  // The comparison table renders one row per configuration: config, summary, nothing else. Shipping
  // each result's full trade log and daily equity curve as well took this response to 105 MB
  // (746,648 trade rows, 148,320 curve points) for data the table never touches. Selecting a row
  // re-runs that single configuration, which is where the detail belongs.
  const strip = (result: PortfolioBacktestResult): PortfolioBacktestResult =>
    ({ ...result, equityCurve: [], holdings: [], rebalances: [], trades: [] });

  const results = sizes.flatMap((portfolioSize) => filters.flatMap((ratingFilter) =>
    rebalances.flatMap((rebalance) => weightings.flatMap((weighting) =>
      exits.flatMap((exitOnRatingDrop) => holds.map((maxHoldDays) =>
        strip(buildPortfolioBacktest({ ...base, portfolioSize, ratingFilter, rebalance, weighting, exitOnRatingDrop, maxHoldDays })),
      ))))))
    // Ranked by what the selection rule added over owning the same pool, not by what it made in
    // total. Ranking on total return just finds whichever configuration rode the pool hardest.
    .sort((left, right) => right.summary.excessVsPool - left.summary.excessVsPool);

  const spread = results.map((result) => result.summary.excessVsPool).sort((left, right) => right - left);
  return {
    results,
    search: {
      configurationsTried: results.length,
      beatPoolCount: spread.filter((value) => value > 0).length,
      bestExcessVsPool: spread[0] ?? 0,
      medianExcessVsPool: spread[Math.floor(spread.length / 2)] ?? 0,
      worstExcessVsPool: spread[spread.length - 1] ?? 0,
      poolReturn: results[0]?.summary.poolReturn ?? 0,
      benchmarkReturn: results[0]?.summary.benchmarkReturn ?? 0,
    },
  };
};

export type PortfolioHoldoutRun = {
  seed: number;
  trainingTickers: number;
  holdoutTickers: number;
  winnerConfig: Omit<PortfolioConfig, 'universeTickers'>;
  trainingExcessVsPool: number;
  holdout: {
    portfolioReturn: number;
    poolReturn: number;
    excessVsPool: number;
    excessReturn: number;
    maxDrawdown: number;
  };
};

export type PortfolioHoldoutValidationResult = {
  repetitions: number;
  holdoutFraction: number;
  totalTickers: number;
  runs: PortfolioHoldoutRun[];
  summary: {
    holdoutBeatPoolCount: number;
    holdoutBeatPoolRate: number;
    meanHoldoutExcessVsPool: number;
    medianHoldoutExcessVsPool: number;
    worstHoldoutExcessVsPool: number;
    bestHoldoutExcessVsPool: number;
  };
};

const holdoutMedian = (values: number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const seededShuffle = <T,>(values: T[], seed: number) => {
  const shuffled = [...values];
  let state = seed >>> 0;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const swapIndex = state % (index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
};

/**
 * Selects the best rule on one random ticker subset, then evaluates that frozen rule on different
 * tickers. Repeating this prevents a rule from receiving credit merely because it was the luckiest
 * of the 288 configurations on the same names used to judge it.
 */
export const buildPortfolioHoldoutValidation = (
  base: Omit<PortfolioConfig, 'portfolioSize' | 'ratingFilter' | 'rebalance' | 'weighting' | 'exitOnRatingDrop' | 'maxHoldDays'>,
  options: { repetitions?: number; holdoutFraction?: number; seed?: number } = {},
): PortfolioHoldoutValidationResult => {
  const repetitions = Math.max(1, Math.min(50, options.repetitions ?? 20));
  const holdoutFraction = Math.max(0.2, Math.min(0.5, options.holdoutFraction ?? 0.3));
  const seed = options.seed ?? 20260806;
  const allTickers = [...new Set(extendedDatasets.map((dataset) => dataset.capture.source.ticker))].sort();
  const runs: PortfolioHoldoutRun[] = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const runSeed = seed + repetition;
    const shuffled = seededShuffle(allTickers, runSeed);
    const holdoutCount = Math.max(1, Math.floor(shuffled.length * holdoutFraction));
    const holdoutTickers = shuffled.slice(0, holdoutCount);
    const trainingTickers = shuffled.slice(holdoutCount);
    const trainingSearch = buildBestPortfolioBacktests({ ...base, universeTickers: trainingTickers });
    const winner = trainingSearch.results[0];
    if (!winner) continue;
    const holdoutResult = buildPortfolioBacktest({ ...winner.config, universeTickers: holdoutTickers });
    const { universeTickers: _trainingUniverse, ...winnerConfig } = winner.config;
    runs.push({
      seed: runSeed,
      trainingTickers: trainingTickers.length,
      holdoutTickers: holdoutTickers.length,
      winnerConfig,
      trainingExcessVsPool: winner.summary.excessVsPool,
      holdout: {
        portfolioReturn: holdoutResult.summary.portfolioReturn,
        poolReturn: holdoutResult.summary.poolReturn,
        excessVsPool: holdoutResult.summary.excessVsPool,
        excessReturn: holdoutResult.summary.excessReturn,
        maxDrawdown: holdoutResult.summary.maxDrawdown,
      },
    });
  }
  const holdoutValues = runs.map((run) => run.holdout.excessVsPool);
  const holdoutBeatPoolCount = holdoutValues.filter((value) => value > 0).length;
  return {
    repetitions,
    holdoutFraction,
    totalTickers: allTickers.length,
    runs,
    summary: {
      holdoutBeatPoolCount,
      holdoutBeatPoolRate: runs.length ? holdoutBeatPoolCount / runs.length : 0,
      meanHoldoutExcessVsPool: holdoutValues.length ? holdoutValues.reduce((sum, value) => sum + value, 0) / holdoutValues.length : 0,
      medianHoldoutExcessVsPool: holdoutMedian(holdoutValues),
      worstHoldoutExcessVsPool: holdoutValues.length ? Math.min(...holdoutValues) : 0,
      bestHoldoutExcessVsPool: holdoutValues.length ? Math.max(...holdoutValues) : 0,
    },
  };
};

// ---------------------------------------------------------------------------
// Signal discovery
// ---------------------------------------------------------------------------
export type SignalDiscoveryFilter = 'strong-buy' | 'bullish-plus';
export type SignalDiscoveryUniverse = 'stocks' | 'etf';
export type SignalDiscoveryStats = {
  observations: number;
  tickers: number;
  medianReturn: number | null;
  medianExcessSpy: number | null;
  medianExcessPool: number | null;
  positiveRate: number | null;
  beatPoolRate: number | null;
};
export type SignalDiscoveryRule = {
  filter: SignalDiscoveryFilter;
  persistenceDays: number;
  holdDays: number;
  discoveryRank: number;
  discovery: SignalDiscoveryStats;
  validation: SignalDiscoveryStats;
  status: 'survived-validation' | 'failed-validation' | 'too-thin';
};
export type SignalDiscoveryTrustTest = {
  filter: SignalDiscoveryFilter;
  persistenceDays: number;
  holdDays: number;
  observations: number;
  tickers: number;
  spyMedianReturn: number;
  nonBullishMedianReturn: number;
  poolMedianReturn: number;
  winnerMedianReturn: number;
  poolMedianExcessSpy: number;
  poolMedianExcessNonBullish: number;
  winnerMedianExcessPool: number;
  winnerMedianExcessSpy: number;
  poolBeatSpyRate: number;
  poolBeatNonBullishRate: number;
  winnerBeatPoolRate: number;
  winnerBeatSpyRate: number;
  ratingSupported: boolean;
  ruleAddsValue: boolean;
  verdict: 'rating-and-rule-supported' | 'rating-supported-rule-not-supported' | 'rating-not-supported';
};
export type SignalDiscoveryResult = {
  generatedAt: string;
  universe: SignalDiscoveryUniverse;
  universeTickers: number;
  splitDate: string;
  discoveryStart: string;
  validationEnd: string;
  rulesTested: number;
  methodology: {
    version: number;
    filters: SignalDiscoveryFilter[];
    persistenceDays: number[];
    holdDays: number[];
    minimumTickers: number;
    returnUnit: string;
    universeRule: string;
    usableRecordRule: string;
    timeSplitRule: string;
    episodeRule: string;
    entryRule: string;
    exitRule: string;
    poolRule: string;
    spyRule: string;
    selectionRule: string;
    trustRule: string;
  };
  bestRule: SignalDiscoveryRule | null;
  trustTest: SignalDiscoveryTrustTest | null;
  rules: SignalDiscoveryRule[];
  tickerMatches: Array<{
    ticker: string;
    company: string;
    latestDate: string;
    latestRating: Rating;
    persistenceDays: number;
    qualifies: boolean;
  }>;
};

type SignalDiscoveryOutcome = {
  ticker: string;
  signalDate: string;
  exitDate: string;
  returnPercent: number;
  spyReturn: number | null;
  nonBullishPoolReturn: number | null;
  poolReturn: number | null;
  excessSpy: number | null;
  excessPool: number | null;
};

const signalAllowed = (rating: Rating, filter: SignalDiscoveryFilter) =>
  filter === 'strong-buy' ? rating === 'Strong Buy' : isBullish(rating);

const firstIndexAfter = (records: CaptureRecord[], date: string) => {
  for (let index = 0; index < records.length; index += 1) if (records[index].date > date) return index;
  return null;
};

const ratingAtOrBefore = (records: CaptureRecord[], date: string) => {
  let current: CaptureRecord | null = null;
  for (const record of records) {
    if (record.date > date) break;
    current = record;
  }
  return current;
};

const summarizeDiscovery = (outcomes: SignalDiscoveryOutcome[]): SignalDiscoveryStats => {
  const raw = outcomes.map((outcome) => outcome.returnPercent);
  const spy = outcomes.flatMap((outcome) => outcome.excessSpy === null ? [] : [outcome.excessSpy]);
  const pool = outcomes.flatMap((outcome) => outcome.excessPool === null ? [] : [outcome.excessPool]);
  return {
    observations: outcomes.length,
    tickers: new Set(outcomes.map((outcome) => outcome.ticker)).size,
    medianReturn: raw.length ? median(raw) : null,
    medianExcessSpy: spy.length ? median(spy) : null,
    medianExcessPool: pool.length ? median(pool) : null,
    positiveRate: raw.length ? raw.filter((value) => value > 0).length / raw.length : null,
    beatPoolRate: pool.length ? pool.filter((value) => value > 0).length / pool.length : null,
  };
};

export const buildSignalDiscovery = (universe: SignalDiscoveryUniverse = 'stocks'): SignalDiscoveryResult => {
  const cachedResult = signalDiscoveryResultCache.get(universe);
  if (cachedResult) return cachedResult;
  const filters: SignalDiscoveryFilter[] = ['strong-buy', 'bullish-plus'];
  const persistenceDays = [30, 60, 90, 180];
  const holdDays = [30, 90, 180];
  const minimumTickers = 15;
  const universeDatasets = extendedDatasets.filter((dataset) => universe === 'etf'
    ? dataset.capture.source.fundType?.toUpperCase() === 'ETF'
    : dataset.capture.source.fundType?.toUpperCase() !== 'ETF');
  const usableByTicker = new Map(universeDatasets.map((dataset) => [dataset.capture.source.ticker, dataset.records.filter(isUsableRecord)]));
  const allDates = [...usableByTicker.values()].flatMap((records) => records.map((record) => record.date)).sort();
  const validationEnd = allDates[allDates.length - 1] ?? '';
  const splitDate = validationEnd ? new Date(Date.parse(validationEnd) - 365 * 86_400_000).toISOString().slice(0, 10) : '';
  const discoveryStart = validationEnd ? new Date(Date.parse(validationEnd) - 3 * 365 * 86_400_000).toISOString().slice(0, 10) : '';
  const poolCache = new Map<string, number | null>();

  const poolReturn = (signalTicker: string, signalDate: string, filter: SignalDiscoveryFilter | 'non-bullish', horizon: number) => {
    // Leave the evaluated ticker out of its own benchmark. Including it would mechanically pull
    // the pool mean toward that ticker's return and dilute measured excess, especially in small
    // qualifying pools. The ticker belongs in the cache key because every leave-one-out pool can
    // have a different mean even when date, filter, and horizon are identical.
    const key = `${signalTicker}|${signalDate}|${filter}|${horizon}`;
    if (poolCache.has(key)) return poolCache.get(key) ?? null;
    const returns: number[] = [];
    for (const [poolTicker, records] of usableByTicker) {
      if (poolTicker === signalTicker) continue;
      const ratingRecord = ratingAtOrBefore(records, signalDate);
      if (!ratingRecord) continue;
      const qualifiesForPool = filter === 'non-bullish'
        ? !isBullish(ratingRecord.quantRating)
        : signalAllowed(ratingRecord.quantRating, filter);
      if (!qualifiesForPool) continue;
      const ratingAgeDays = (Date.parse(signalDate) - Date.parse(ratingRecord.date)) / 86_400_000;
      if (ratingAgeDays > 10) continue;
      const entryIndex = firstIndexAfter(records, signalDate);
      if (entryIndex === null) continue;
      const exit = findForwardRecord(records, entryIndex, horizon);
      if (!exit) continue;
      returns.push(((exit.price / records[entryIndex].price) - 1) * 100);
    }
    const result = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null;
    poolCache.set(key, result);
    return result;
  };

  const outcomesFor = (filter: SignalDiscoveryFilter, persistence: number, horizon: number) => {
    const outcomes: SignalDiscoveryOutcome[] = [];
    for (const [ticker, records] of usableByTicker) {
      let episodeStart: number | null = null;
      let emitted = false;
      for (let index = 0; index < records.length; index += 1) {
        if (!signalAllowed(records[index].quantRating, filter)) { episodeStart = null; emitted = false; continue; }
        if (episodeStart === null) episodeStart = index;
        if (emitted) continue;
        const ageDays = (Date.parse(records[index].date) - Date.parse(records[episodeStart].date)) / 86_400_000;
        if (ageDays < persistence) continue;
        emitted = true;
        const entryIndex = index + 1 < records.length ? index + 1 : null;
        if (entryIndex === null) continue;
        const exit = findForwardRecord(records, entryIndex, horizon);
        if (!exit) continue;
        const entry = records[entryIndex];
        const returnPercent = ((exit.price / entry.price) - 1) * 100;
        const spyReturn = marketReturnBetween(entry.date, exit.date);
        const baseline = poolReturn(ticker, records[index].date, filter, horizon);
        const nonBullishBaseline = poolReturn(ticker, records[index].date, 'non-bullish', horizon);
        outcomes.push({
          ticker,
          signalDate: records[index].date,
          exitDate: exit.date,
          returnPercent,
          spyReturn,
          nonBullishPoolReturn: nonBullishBaseline,
          poolReturn: baseline,
          excessSpy: spyReturn === null ? null : returnPercent - spyReturn,
          excessPool: baseline === null ? null : returnPercent - baseline,
        });
      }
    }
    return outcomes;
  };

  const outcomesByRule = new Map<string, SignalDiscoveryOutcome[]>();
  const candidates = filters.flatMap((filter) => persistenceDays.flatMap((persistence) => holdDays.map((hold) => {
    const outcomes = outcomesFor(filter, persistence, hold);
    outcomesByRule.set(`${filter}|${persistence}|${hold}`, outcomes);
    // Discovery outcomes must finish before validation starts; otherwise future validation-period
    // prices would leak into the rule-selection phase.
    const discovery = summarizeDiscovery(outcomes.filter((outcome) => outcome.signalDate >= discoveryStart && outcome.exitDate < splitDate));
    const validation = summarizeDiscovery(outcomes.filter((outcome) => outcome.signalDate >= splitDate));
    return { filter, persistenceDays: persistence, holdDays: hold, discovery, validation };
  })));

  const ranked = [...candidates].sort((left, right) =>
    (right.discovery.medianExcessPool ?? -Infinity) - (left.discovery.medianExcessPool ?? -Infinity)
    || (right.discovery.beatPoolRate ?? -Infinity) - (left.discovery.beatPoolRate ?? -Infinity));
  const rankByKey = new Map(ranked.map((rule, index) => [`${rule.filter}|${rule.persistenceDays}|${rule.holdDays}`, index + 1]));
  const rules: SignalDiscoveryRule[] = candidates.map((rule) => {
    const thin = rule.discovery.tickers < minimumTickers || rule.validation.tickers < minimumTickers;
    const survived = !thin
      && (rule.validation.medianExcessPool ?? -Infinity) > 0
      && (rule.validation.medianExcessSpy ?? -Infinity) > 0
      && (rule.validation.beatPoolRate ?? 0) > 0.5;
    const status: SignalDiscoveryRule['status'] = thin ? 'too-thin' : survived ? 'survived-validation' : 'failed-validation';
    return {
      ...rule,
      discoveryRank: rankByKey.get(`${rule.filter}|${rule.persistenceDays}|${rule.holdDays}`) ?? candidates.length,
      status,
    };
  }).sort((left, right) => left.discoveryRank - right.discoveryRank);
  const bestRule = rules.find((rule) => rule.status === 'survived-validation') ?? null;
  const trustTest = universe === 'etf' && bestRule ? (() => {
    const outcomes = (outcomesByRule.get(`${bestRule.filter}|${bestRule.persistenceDays}|${bestRule.holdDays}`) ?? [])
      .filter((outcome) => outcome.signalDate >= splitDate && outcome.spyReturn !== null && outcome.nonBullishPoolReturn !== null && outcome.poolReturn !== null);
    if (!outcomes.length) return null;
    const spyReturns = outcomes.map((outcome) => outcome.spyReturn as number);
    const nonBullishReturns = outcomes.map((outcome) => outcome.nonBullishPoolReturn as number);
    const poolReturns = outcomes.map((outcome) => outcome.poolReturn as number);
    const winnerReturns = outcomes.map((outcome) => outcome.returnPercent);
    const poolExcessSpy = outcomes.map((outcome) => (outcome.poolReturn as number) - (outcome.spyReturn as number));
    const poolExcessNonBullish = outcomes.map((outcome) => (outcome.poolReturn as number) - (outcome.nonBullishPoolReturn as number));
    const winnerExcessPool = outcomes.map((outcome) => outcome.returnPercent - (outcome.poolReturn as number));
    const winnerExcessSpy = outcomes.map((outcome) => outcome.returnPercent - (outcome.spyReturn as number));
    const tickers = new Set(outcomes.map((outcome) => outcome.ticker)).size;
    const poolBeatSpyRate = poolExcessSpy.filter((value) => value > 0).length / outcomes.length;
    const poolBeatNonBullishRate = poolExcessNonBullish.filter((value) => value > 0).length / outcomes.length;
    const winnerBeatPoolRate = winnerExcessPool.filter((value) => value > 0).length / outcomes.length;
    const winnerBeatSpyRate = winnerExcessSpy.filter((value) => value > 0).length / outcomes.length;
    const poolMedianExcessSpy = median(poolExcessSpy);
    const poolMedianExcessNonBullish = median(poolExcessNonBullish);
    const winnerMedianExcessPool = median(winnerExcessPool);
    const winnerMedianExcessSpy = median(winnerExcessSpy);
    const broadEnough = tickers >= minimumTickers;
    const ratingSupported = broadEnough
      && poolMedianExcessSpy > 0
      && poolBeatSpyRate > 0.5
      && poolMedianExcessNonBullish > 0
      && poolBeatNonBullishRate > 0.5;
    const ruleAddsValue = broadEnough && winnerMedianExcessPool > 0 && winnerBeatPoolRate > 0.5;
    return {
      filter: bestRule.filter,
      persistenceDays: bestRule.persistenceDays,
      holdDays: bestRule.holdDays,
      observations: outcomes.length,
      tickers,
      spyMedianReturn: median(spyReturns),
      nonBullishMedianReturn: median(nonBullishReturns),
      poolMedianReturn: median(poolReturns),
      winnerMedianReturn: median(winnerReturns),
      poolMedianExcessSpy,
      poolMedianExcessNonBullish,
      winnerMedianExcessPool,
      winnerMedianExcessSpy,
      poolBeatSpyRate,
      poolBeatNonBullishRate,
      winnerBeatPoolRate,
      winnerBeatSpyRate,
      ratingSupported,
      ruleAddsValue,
      verdict: ratingSupported
        ? ruleAddsValue ? 'rating-and-rule-supported' : 'rating-supported-rule-not-supported'
        : 'rating-not-supported',
    } satisfies SignalDiscoveryTrustTest;
  })() : null;
  const tickerMatches = bestRule ? universeDatasets.map((dataset) => {
    const records = dataset.records.filter(isUsableRecord);
    const latest = records[records.length - 1];
    let startIndex = records.length - 1;
    while (startIndex > 0 && signalAllowed(records[startIndex - 1].quantRating, bestRule.filter)) startIndex -= 1;
    const streak = latest && signalAllowed(latest.quantRating, bestRule.filter)
      ? Math.max(0, Math.round((Date.parse(latest.date) - Date.parse(records[startIndex].date)) / 86_400_000))
      : 0;
    return {
      ticker: dataset.capture.source.ticker,
      company: dataset.capture.source.companyName,
      latestDate: latest?.date ?? '',
      latestRating: latest?.quantRating ?? dataset.capture.source.quantRating,
      persistenceDays: streak,
      qualifies: Boolean(latest && signalAllowed(latest.quantRating, bestRule.filter) && streak >= bestRule.persistenceDays),
    };
  }).sort((left, right) => Number(right.qualifies) - Number(left.qualifies) || right.persistenceDays - left.persistenceDays) : [];
  const result: SignalDiscoveryResult = {
    generatedAt: new Date().toISOString(),
    universe,
    universeTickers: universeDatasets.length,
    splitDate,
    discoveryStart,
    validationEnd,
    rulesTested: rules.length,
    methodology: {
      version: 4,
      filters,
      persistenceDays,
      holdDays,
      minimumTickers,
      returnUnit: 'All return fields are percentage values. Differences between two returns are percentage-point values even when a UI cell renders a percent sign.',
      universeRule: universe === 'etf'
        ? 'Include only imported tickers whose normalized fundType is exactly ETF.'
        : 'Exclude imported tickers whose normalized fundType is exactly ETF; missing fundType remains in the stock universe.',
      usableRecordRule: 'Require a finite positive price, a finite quant score, and one canonical rating: Strong Buy, Buy, Hold, Sell, or Strong Sell.',
      timeSplitRule: 'Use at most the latest three calendar years. The final 365 days form validation. Discovery signals must start on or after discoveryStart and finish before splitDate; validation signals start on or after splitDate.',
      episodeRule: 'Emit one signal per continuous qualifying rating episode, on the first usable record whose calendar-day streak reaches the requested persistence. Reset only after the rating leaves that filter.',
      entryRule: 'First qualifying persistence date; buy on the next usable trading record; require a complete fixed-horizon exit within seven days of target.',
      exitRule: 'Choose the usable record closest to entry date plus holdDays, within plus or minus seven calendar days. Drop the observation if no complete exit exists; never shorten it to the last available price.',
      poolRule: 'At the signal date, find other universe tickers with a qualifying rating recorded no more than 10 calendar days earlier. Exclude the signal ticker, simulate each peer over the same hold horizon, and use their arithmetic mean return as the matched pool return.',
      spyRule: 'Use SPY adjusted-close quotes on or before the signal ticker entry and exit dates. Excess versus SPY equals signal return minus SPY return.',
      selectionRule: 'Rank on discovery-period median excess over the matching leave-one-ticker-out rating pool. Choose the highest discovery-ranked rule that independently clears positive median excess versus pool and SPY, over 50% pool wins, and the minimum ticker count in validation.',
      trustRule: 'For the ETF winner only, keep validation observations with SPY, matching bullish-pool, and non-bullish-pool baselines. Rating support requires at least minimumTickers plus positive paired median excess and over 50% wins versus both controls. Rule support requires positive paired median excess and over 50% wins versus the bullish pool.',
    },
    bestRule,
    trustTest,
    rules,
    tickerMatches,
  };
  signalDiscoveryResultCache.set(universe, result);
  return result;
};

// --- ETF check ---------------------------------------------------------------------------------
// "Check an ETF": does this specific ETF's current rating right now fit the entry condition of an
// already-confirmed Research rule? This does not re-run any statistics -- it only reports the
// ETF's live rating streak per filter; the caller matches that against the Research page's
// discoveredRule rows to decide whether it fits.
export type EtfCheckFilterState = { qualifiesNow: boolean; episodeAgeDays: number; censored: boolean };
export type EtfCheckResult = {
  ticker: string;
  company: string;
  currentPrice: number | null;
  latestDate: string;
  latestRating: Rating;
  states: Record<SignalDiscoveryFilter, EtfCheckFilterState | null>;
};

export type EtfBasketSummary = {
  tickers: string[];
  observations: number;
  meanReturn: number | null;
  medianReturn: number | null;
  positiveRate: number | null;
};

export type EtfCorrelationPair = { left: string; right: string; correlation: number; observations: number };
export type EtfCorrelationCluster = { id: number; representative: string; members: string[]; size: number };
export type EtfSectorExposure = { sector: string; tickers: string[]; percentage: number };
export type EtfBasketAnalysis = {
  horizonDays: number;
  clusterThreshold: number;
  warningsThreshold: number;
  candidateCount: number;
  priceEligibleCount: number;
  allBasket: EtfBasketSummary;
  diversifiedBasket: EtfBasketSummary;
  sectorExposure: EtfSectorExposure[];
  clusters: EtfCorrelationCluster[];
  warnings: EtfCorrelationPair[];
};

const medianNumber = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const meanNumber = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

const firstIndexAfterDate = (records: CaptureRecord[], date: string) => {
  let low = 0;
  let high = records.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (records[middle].date <= date) low = middle + 1;
    else high = middle;
  }
  return low < records.length ? low : null;
};

const returnsByDate = (records: CaptureRecord[]) => {
  const values = new Map<string, number>();
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];
    if (previous.price > 0 && current.price > 0) values.set(current.date, (current.price / previous.price) - 1);
  }
  return values;
};

// Delegates to fitLine's Pearson-correlation math (the only difference is the inputs arrive as two
// date-keyed maps that need joining on shared dates first) instead of a second, independent copy.
const correlationBetween = (left: Map<string, number>, right: Map<string, number>) => {
  const points: Array<{ x: number; y: number }> = [];
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  smaller.forEach((value, date) => {
    const otherValue = larger.get(date);
    if (otherValue !== undefined && Number.isFinite(value) && Number.isFinite(otherValue)) points.push({ x: value, y: otherValue });
  });
  if (points.length < 30) return null;
  const { correlation } = fitLine(points);
  return correlation === null ? null : { value: correlation, observations: points.length };
};

// Requiring every basket member to have a return on a date collapses toward zero observations as
// the basket grows (one illiquid or newly-listed ETF missing a day drops that whole day). A real
// equal-weight basket just excludes whichever constituents lack data that day, so a date only needs
// a majority of the selected tickers present -- enough to be representative, not unanimous.
const simulateEqualWeightBasket = (recordsByTicker: Map<string, CaptureRecord[]>, tickers: string[], horizonDays: number): EtfBasketSummary => {
  const selected = tickers.filter((ticker) => recordsByTicker.has(ticker));
  const minParticipants = Math.max(1, Math.ceil(selected.length / 2));
  const dates = [...new Set(selected.flatMap((ticker) => recordsByTicker.get(ticker)?.map((record) => record.date) ?? []))].sort();
  const returns: number[] = [];
  dates.forEach((date) => {
    const tickerReturns: number[] = [];
    selected.forEach((ticker) => {
      const records = recordsByTicker.get(ticker)!;
      const entryIndex = firstIndexAfterDate(records, date);
      if (entryIndex === null) return;
      const exit = findForwardRecord(records, entryIndex, horizonDays);
      if (!exit || records[entryIndex].price <= 0 || exit.price <= 0) return;
      tickerReturns.push((exit.price / records[entryIndex].price - 1) * 100);
    });
    if (tickerReturns.length >= minParticipants) returns.push(tickerReturns.reduce((sum, value) => sum + value, 0) / tickerReturns.length);
  });
  return {
    tickers: selected,
    observations: returns.length,
    meanReturn: meanNumber(returns),
    medianReturn: medianNumber(returns),
    positiveRate: returns.length ? returns.filter((value) => value > 0).length / returns.length : null,
  };
};

const CLUSTER_THRESHOLD = 0.9;
const WARNINGS_THRESHOLD = 0.95;

// Some historical ETF captures do not include the issuer's sector metadata. These are coarse
// portfolio-exposure labels, not a claim that every holding inside the ETF belongs to one sector.
// They are used only for the basket exposure chart; research returns and rule qualification never
// use this map. Unknown tickers remain explicitly labelled rather than being guessed from a name.
const STATIC_ETF_SECTORS: Record<string, string> = {
  CLOU: 'Technology / cloud computing', FCLD: 'Technology / cloud computing', AGIX: 'Technology / AI',
  GDMN: 'Materials / gold miners', COPP: 'Materials / copper miners', RNIN: 'Energy / nuclear',
  UDIV: 'U.S. equity / dividend tilt',
  SPY: 'U.S. large-cap equity', VOO: 'U.S. large-cap equity', IVV: 'U.S. large-cap equity',
  SPLG: 'U.S. large-cap equity', SPTM: 'U.S. broad equity', QQQ: 'U.S. technology / growth', QQQM: 'U.S. technology / growth',
  XLK: 'Technology', VGT: 'Technology', FTEC: 'Technology', XLE: 'Energy', VDE: 'Energy',
  XLF: 'Financials', VFH: 'Financials', XLI: 'Industrials', XLB: 'Materials',
  XLV: 'Healthcare', VHT: 'Healthcare', XLP: 'Consumer staples', VDC: 'Consumer staples',
  XLY: 'Consumer discretionary', XLU: 'Utilities', VPU: 'Utilities',
  GLD: 'Gold / precious metals', IAU: 'Gold / precious metals', TLT: 'U.S. bonds', AGG: 'U.S. bonds', BND: 'U.S. bonds',
  VXUS: 'International equity', IXUS: 'International equity',
};

export const buildEtfBasketAnalysis = (tickers: string[], horizonDays = 30, basketSize = 10): EtfBasketAnalysis => {
  const requested = new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean));
  const datasets = extendedDatasets.filter((dataset) => dataset.capture.source.fundType?.toUpperCase() === 'ETF'
    && requested.has(dataset.capture.source.ticker.toUpperCase()));
  const recordsByTicker = new Map(datasets.map((dataset) => [dataset.capture.source.ticker, dataset.records.filter(isUsableRecord)]));
  const usable = [...recordsByTicker.entries()].filter(([, records]) => records.length >= 31);
  const usableByTicker = new Map(usable);
  const returnMaps = new Map(usable.map(([ticker, records]) => [ticker, returnsByDate(records)]));
  // Clustering and the warnings scan both compare pairs of tickers; cache each pair's correlation
  // once so a pair already compared while clustering isn't recomputed from scratch for warnings.
  const correlationCache = new Map<string, ReturnType<typeof correlationBetween>>();
  const cachedCorrelation = (left: string, right: string) => {
    const key = left < right ? `${left}|${right}` : `${right}|${left}`;
    if (!correlationCache.has(key)) correlationCache.set(key, correlationBetween(returnMaps.get(left)!, returnMaps.get(right)!));
    return correlationCache.get(key)!;
  };
  const pairs: EtfCorrelationPair[] = [];
  const clusters: EtfCorrelationCluster[] = [];
  for (const [ticker] of usable) {
    const matchingCluster = clusters.find((cluster) => {
      const comparison = cachedCorrelation(ticker, cluster.representative);
      return comparison !== null && comparison.value >= CLUSTER_THRESHOLD;
    });
    if (matchingCluster) matchingCluster.members.push(ticker);
    else clusters.push({ id: clusters.length + 1, representative: ticker, members: [ticker], size: 1 });
  }
  clusters.forEach((cluster) => { cluster.size = cluster.members.length; });
  const sortedTickers = [...usableByTicker.keys()].sort();
  for (let leftIndex = 0; leftIndex < sortedTickers.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < sortedTickers.length; rightIndex += 1) {
      const left = sortedTickers[leftIndex];
      const right = sortedTickers[rightIndex];
      const comparison = cachedCorrelation(left, right);
      if (comparison !== null && comparison.value >= WARNINGS_THRESHOLD) pairs.push({ left, right, correlation: comparison.value, observations: comparison.observations });
    }
  }
  // Displayed cluster list: biggest (most-populated) groups first, since that's the more useful
  // read order for a human scanning "what are the common patterns here."
  const orderedClusters = [...clusters].sort((left, right) => right.size - left.size || left.representative.localeCompare(right.representative));
  // Basket selection is the opposite priority: when basketSize can't cover every cluster, keep the
  // singleton/small clusters first. Those are the most-diversifying picks (correlated with nothing
  // else in the pool); a large cluster's pattern is already the best-represented one, so it's the
  // safest one to leave out if a choice has to be made.
  const clustersBySelectionPriority = [...clusters].sort((left, right) => left.size - right.size || left.representative.localeCompare(right.representative));
  const diversifiedTickers = clustersBySelectionPriority
    .slice(0, Math.max(1, Math.min(basketSize, clustersBySelectionPriority.length)))
    .map((cluster) => cluster.representative);
  const sectorByTicker = new Map(datasets.map((dataset) => [
    dataset.capture.source.ticker,
    dataset.capture.source.sector?.trim() || STATIC_ETF_SECTORS[dataset.capture.source.ticker.toUpperCase()] || 'Unknown / not provided',
  ]));
  const sectorGroups = new Map<string, string[]>();
  diversifiedTickers.forEach((ticker) => {
    const sector = sectorByTicker.get(ticker) ?? 'Unknown / not provided';
    const members = sectorGroups.get(sector) ?? [];
    members.push(ticker);
    sectorGroups.set(sector, members);
  });
  const sectorExposure = [...sectorGroups.entries()]
    .map(([sector, members]) => ({ sector, tickers: members, percentage: members.length / Math.max(1, diversifiedTickers.length) }))
    .sort((left, right) => right.percentage - left.percentage || left.sector.localeCompare(right.sector));
  return {
    horizonDays,
    clusterThreshold: CLUSTER_THRESHOLD,
    warningsThreshold: WARNINGS_THRESHOLD,
    candidateCount: tickers.length,
    priceEligibleCount: usableByTicker.size,
    allBasket: simulateEqualWeightBasket(usableByTicker, [...usableByTicker.keys()], horizonDays),
    diversifiedBasket: simulateEqualWeightBasket(usableByTicker, diversifiedTickers, horizonDays),
    sectorExposure,
    clusters: orderedClusters,
    warnings: pairs.sort((left, right) => right.correlation - left.correlation).slice(0, 25),
  };
};

// Mirrors tickerMatches' streak calculation above (lines ~2595-2611), generalised to every filter
// rather than only the single discovered bestRule, and to "not currently qualifying" as a real,
// reportable state rather than being dropped.
const currentEpisodeState = (records: CaptureRecord[], filter: SignalDiscoveryFilter): EtfCheckFilterState | null => {
  if (!records.length) return null;
  const latest = records[records.length - 1];
  if (!signalAllowed(latest.quantRating, filter)) return { qualifiesNow: false, episodeAgeDays: 0, censored: false };
  let startIndex = records.length - 1;
  while (startIndex > 0 && signalAllowed(records[startIndex - 1].quantRating, filter)) startIndex -= 1;
  // startIndex reaching 0 means the walk hit the start of this ETF's captured history without ever
  // observing a non-qualifying predecessor -- the true episode start is unknown (left-censored), not
  // necessarily "starts here." Mirrors the same guard etf_rating_transition_events uses in the Python
  // pipeline (requires a real prior observation before counting a transition); episodeAgeDays below is
  // then only a lower bound, not a confirmed age.
  const censored = startIndex === 0;
  const episodeAgeDays = Math.max(0, Math.round((Date.parse(latest.date) - Date.parse(records[startIndex].date)) / 86_400_000));
  return { qualifiesNow: true, episodeAgeDays, censored };
};

const ETF_CHECK_FILTERS: SignalDiscoveryFilter[] = ['strong-buy', 'bullish-plus'];

export const buildEtfCheck = (tickers?: string[]): EtfCheckResult[] => {
  const wanted = tickers?.length ? new Set(tickers.map((ticker) => ticker.trim().toUpperCase())) : null;
  const etfDatasets = extendedDatasets.filter((dataset) => dataset.capture.source.fundType?.toUpperCase() === 'ETF'
    && (!wanted || wanted.has(dataset.capture.source.ticker.toUpperCase())));
  return etfDatasets.map((dataset) => {
    const records = dataset.records.filter(isUsableRecord);
    const latest = records[records.length - 1];
    const states = Object.fromEntries(
      ETF_CHECK_FILTERS.map((filter) => [filter, currentEpisodeState(records, filter)]),
    ) as Record<SignalDiscoveryFilter, EtfCheckFilterState | null>;
    return {
      ticker: dataset.capture.source.ticker,
      company: dataset.capture.source.companyName,
      currentPrice: Number.isFinite(dataset.capture.source.currentPrice) && dataset.capture.source.currentPrice > 0
        ? dataset.capture.source.currentPrice
        : (latest?.price && latest.price > 0 ? latest.price : null),
      latestDate: latest?.date ?? '',
      latestRating: latest?.quantRating ?? dataset.capture.source.quantRating,
      states,
    };
  }).sort((left, right) => left.ticker.localeCompare(right.ticker));
};

export type EtfEpisodeFixtureRow = {
  ticker: string;
  filter: SignalDiscoveryFilter;
  latestDate: string;
  qualifiesNow: boolean;
  episodeAgeDays: number;
  censored: boolean;
};

// Flat, independently-verifiable dump of exactly what currentEpisodeState() computed for every ETF
// and filter -- consumed by research/verify_episode_state.py, which recomputes the same thing from
// the Python side (build_rating_timeline) and diffs the two. This exists because the historical
// signal definition (Python, research/pipeline.py) and the live signal detection here (TypeScript)
// are two independent implementations with no shared code path; nothing else catches them drifting
// apart. See progress.md for the cross-validation this feeds.
export const buildEpisodeFixture = (): EtfEpisodeFixtureRow[] => {
  const etfDatasets = extendedDatasets.filter((dataset) => dataset.capture.source.fundType?.toUpperCase() === 'ETF');
  return etfDatasets.flatMap((dataset) => {
    const records = dataset.records.filter(isUsableRecord);
    const latest = records[records.length - 1];
    return ETF_CHECK_FILTERS.map((filter): EtfEpisodeFixtureRow => {
      const state = currentEpisodeState(records, filter);
      return {
        ticker: dataset.capture.source.ticker,
        filter,
        latestDate: latest?.date ?? '',
        qualifiesNow: state?.qualifiesNow ?? false,
        episodeAgeDays: state?.episodeAgeDays ?? 0,
        censored: state?.censored ?? false,
      };
    });
  }).sort((left, right) => left.ticker.localeCompare(right.ticker) || left.filter.localeCompare(right.filter));
};
