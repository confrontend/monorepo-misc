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
  };
  quantRatingHistory: { records: CaptureRecord[] };
};

type CaptureDataset = {
  capture: Capture;
  sourceFile: string;
  records: CaptureRecord[];
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

const captureModules = import.meta.glob('../input/*.json', { eager: true, import: 'default' }) as Record<string, Capture>;

const isValidCapture = (capture: Capture | undefined): capture is Capture => Boolean(
  capture?.source?.ticker
  && Array.isArray(capture.quantRatingHistory?.records)
  && capture.quantRatingHistory.records.length,
);

const datasets: CaptureDataset[] = Object.entries(captureModules)
  .filter((entry): entry is [string, Capture] => isValidCapture(entry[1]))
  .map(([path, capture]) => ({
    capture,
    sourceFile: path.split('/').pop() ?? path,
    records: [...capture.quantRatingHistory.records].sort((left, right) => Date.parse(left.date) - Date.parse(right.date)),
  }))
  .sort((left, right) => Date.parse(right.capture.capturedAt) - Date.parse(left.capture.capturedAt))
  .filter((dataset, index, all) => all.findIndex((candidate) => candidate.capture.source.ticker === dataset.capture.source.ticker) === index)
  .sort((left, right) => left.capture.source.ticker.localeCompare(right.capture.source.ticker));

// Cached, pre-fetched daily prices (see scripts/fetch-benchmark-prices.mjs). Populated by
// running `npm run fetch:benchmark` locally — never fetched over the network from the browser.
// Missing entirely (no ../benchmark/*.json files yet) is a valid, expected state.
const benchmarkModules = import.meta.glob('../benchmark/*.json', { eager: true, import: 'default' }) as Record<string, BenchmarkFile>;

const isValidBenchmarkFile = (file: BenchmarkFile | undefined): file is BenchmarkFile => Boolean(
  file?.ticker
  && Array.isArray(file.records)
  && file.records.length,
);

const benchmarkByTicker: Map<string, BenchmarkQuote[]> = new Map(
  Object.values(benchmarkModules)
    .filter(isValidBenchmarkFile)
    .map((file) => [
      file.ticker.toUpperCase(),
      [...file.records].sort((left, right) => Date.parse(left.date) - Date.parse(right.date)),
    ]),
);

// Quotes are sorted ascending; walk forward and keep the last one that is not after targetDate.
const quoteOnOrBefore = (quotes: BenchmarkQuote[], targetDate: Date): BenchmarkQuote | null => {
  let match: BenchmarkQuote | null = null;
  for (const quote of quotes) {
    if (new Date(quote.date) > targetDate) break;
    match = quote;
  }
  return match;
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

export const buildStrongBuyTrustResults = (): StrongBuyTrustResult[] => datasets.map((dataset) => {
  const { capture, records } = dataset;
  const trades: StrongBuyTrade[] = [];
  let entryRecord: CaptureRecord | null = null;
  let portfolioValue = 100;

  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];

    if (!entryRecord && previous.quantRating !== 'Strong Buy' && current.quantRating === 'Strong Buy') {
      entryRecord = current;
      continue;
    }

    if (entryRecord && current.quantRating !== 'Strong Buy') {
      const returnPercent = ((current.price / entryRecord.price) - 1) * 100;
      portfolioValue *= current.price / entryRecord.price;
      trades.push({
        entryDate: entryRecord.date,
        entryPrice: entryRecord.price,
        exitDate: current.date,
        exitPrice: current.price,
        exitRating: current.quantRating,
        returnPercent,
        status: 'Completed',
      });
      entryRecord = null;
    }
  }

  const lastRecord = records[records.length - 1];
  let openTradeReturn: number | null = null;
  if (entryRecord && lastRecord) {
    openTradeReturn = ((lastRecord.price / entryRecord.price) - 1) * 100;
    portfolioValue *= lastRecord.price / entryRecord.price;
    trades.push({
      entryDate: entryRecord.date,
      entryPrice: entryRecord.price,
      exitDate: null,
      exitPrice: null,
      exitRating: null,
      returnPercent: openTradeReturn,
      status: 'Open',
    });
  }

  const completedReturns = trades.filter((trade) => trade.status === 'Completed').map((trade) => trade.returnPercent);
  const wins = completedReturns.filter((value) => value > 0).length;
  const losses = completedReturns.filter((value) => value <= 0).length;

  return {
    ticker: capture.source.ticker,
    company: capture.source.companyName,
    completedTrades: completedReturns.length,
    wins,
    losses,
    winRate: completedReturns.length ? (wins / completedReturns.length) * 100 : null,
    averageTradeReturn: completedReturns.length ? completedReturns.reduce((total, value) => total + value, 0) / completedReturns.length : null,
    medianTradeReturn: completedReturns.length ? median(completedReturns) : null,
    endingValue: portfolioValue,
    totalReturn: ((portfolioValue / 100) - 1) * 100,
    openTradeReturn,
    dateRange: records.length ? `${records[0].date} – ${lastRecord.date}` : 'No records',
    trades,
  };
});

export type CohortResult = {
  tier: Rating | 'Market';
  window: HistoryWindow;
  tickerCount: number;
  totalInTier: number;
  averageReturn: number | null;
  medianReturn: number | null;
};

const ratingTierOrder: Rating[] = ['Strong Buy', 'Buy', 'Hold', 'Sell', 'Strong Sell'];

// Grouped by each ticker's CURRENT Seeking Alpha rating (the rating at capture time), not a
// historical point-in-time rating — we only have one rating snapshot per ticker, not a rating
// history for the whole coverage universe. So this answers "do stocks Seeking Alpha rates X
// today tend to have had stronger real (buy-and-hold) returns than stocks it rates Y today,"
// not "did the rating correctly predict what happened after it was assigned." Since trailing
// momentum is itself one of the five Quant factors, expect some of this correlation to be
// mechanical rather than predictive — see progress.md for the fuller caveat.
export const getAvailableRatingTiers = (): Rating[] =>
  ratingTierOrder.filter((tier) => datasets.some((dataset) => dataset.capture.source.quantRating === tier));

const MARKET_TICKER = 'SPY';

// "Market" uses fixed anchor dates (the earliest and most recent record across every loaded
// ticker) so every window's market return is comparable across tiers, rather than each ticker
// silently using its own captured date range as "today"/"the beginning".
const globalLatestDate = (): Date | null => datasets.reduce<Date | null>((latest, dataset) => {
  const last = dataset.records[dataset.records.length - 1];
  if (!last) return latest;
  const candidate = new Date(last.date);
  if (Number.isNaN(candidate.getTime())) return latest;
  return !latest || candidate > latest ? candidate : latest;
}, null);

const globalEarliestDate = (): Date | null => datasets.reduce<Date | null>((earliest, dataset) => {
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
      const tierDatasets = datasets.filter((dataset) => dataset.capture.source.quantRating === tier);
      const returns = tierDatasets
        .map((dataset) => buildBenchmarkResult(dataset.capture.source.ticker, recordsInWindow(dataset.records, window)))
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
  windows.flatMap((window) => datasets.map((dataset) => {
    const result = buildBenchmarkResult(dataset.capture.source.ticker, recordsInWindow(dataset.records, window));
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
  const market = buildMarketReturn('all');
  if (!market.available) return [];

  return getAvailableRatingTiers().map((tier) => {
    const tierDatasets = datasets.filter((dataset) => dataset.capture.source.quantRating === tier);
    let wins = 0;
    let total = 0;
    tierDatasets.forEach((dataset) => {
      const result = buildBenchmarkResult(dataset.capture.source.ticker, recordsInWindow(dataset.records, 'all'));
      if (!result.available) return;
      total += 1;
      if (result.totalReturn > market.totalReturn) wins += 1;
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
  const market = buildMarketReturn('all');
  if (!market.available) return { points: [], correlation: null, slope: null, intercept: null };

  const points: ScoreCorrelationPoint[] = [];
  datasets.forEach((dataset) => {
    const result = buildBenchmarkResult(dataset.capture.source.ticker, recordsInWindow(dataset.records, 'all'));
    if (!result.available) return;
    points.push({
      ticker: dataset.capture.source.ticker,
      company: dataset.capture.source.companyName,
      tier: dataset.capture.source.quantRating,
      score: dataset.capture.source.quantScore,
      excessReturn: result.totalReturn - market.totalReturn,
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
  datasets
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
  entryDate: string;
  entryPrice: number;
  exitDate: string | null;
  exitPrice: number | null;
  exitReason: 'Rating changed' | 'Horizon reached' | 'Still open';
  daysHeld: number | null;
  returnPercent: number | null;
  correct: boolean | null;
};

export type RatingCallSummary = {
  horizonDays: number;
  calls: RatingCall[];
  scoredCalls: number;
  correctCalls: number;
  incorrectCalls: number;
  hitRate: number | null;
  hitRateLow: number | null;
  hitRateHigh: number | null;
  averageReturn: number | null;
  medianReturn: number | null;
  openCalls: number;
  neutralCalls: number;
};

const callDirection = (rating: Rating): RatingCallDirection => {
  if (rating === 'Strong Buy' || rating === 'Buy') return 'Bullish';
  if (rating === 'Sell' || rating === 'Strong Sell') return 'Bearish';
  return 'Neutral';
};

// 95% Wilson score interval for a binomial proportion — better-behaved than a normal-approximation
// interval at the small-n, near-0%/100% sample sizes these per-ticker hit rates can have.
const wilsonInterval = (successes: number, n: number): { low: number; high: number } | null => {
  if (n <= 0) return null;
  const z = 1.96;
  const phat = successes / n;
  const denominator = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((phat * (1 - phat) / n) + (z * z) / (4 * n * n))) / denominator;
  return { low: Math.max(0, (center - margin) * 100), high: Math.min(100, (center + margin) * 100) };
};

// Event-based accuracy test, added in response to review feedback on `buildTickerAccuracy` above:
// that per-day scatter suffers from heavy pseudo-replication (overlapping horizon windows are not
// independent observations) and never checks whether the rating changed mid-window. This test
// instead walks each ticker's history and opens a "call" whenever the rating changes (or at the
// very start of its captured history). A call closes at the first of: (a) the rating changing
// again, or (b) `horizonDays` elapsing — whichever comes first. If a rating never changes for a
// long stretch, closing on the horizon cap still produces fresh, non-overlapping calls back to
// back (each using a genuinely different stretch of time) rather than either double-counting
// overlapping windows or discarding the whole stretch after the first horizon. A call that reaches
// neither the next rating change nor the horizon before the captured history ends is "Still open"
// and excluded from scoring. A bullish call (Buy/Strong Buy) is correct if price rose over the
// call; a bearish call (Sell/Strong Sell) is correct if price fell. Hold calls have no directional
// prediction, so they are tracked but excluded from the hit rate and average/median return.
export const buildRatingCallSummary = (horizonDays: number): RatingCallSummary => {
  const calls: RatingCall[] = [];

  datasets.forEach((dataset) => {
    const { capture, records } = dataset;
    const usable = records.filter(isUsableRecord);
    let index = 0;
    while (index < usable.length) {
      const entry = usable[index];
      const rating = entry.quantRating;
      const direction = callDirection(rating);
      const cutoffTime = new Date(entry.date).getTime() + horizonDays * 86_400_000;

      let exitIndex = -1;
      for (let j = index + 1; j < usable.length; j += 1) {
        if (usable[j].quantRating !== rating) { exitIndex = j; break; }
        if (new Date(usable[j].date).getTime() >= cutoffTime) { exitIndex = j; break; }
      }

      if (exitIndex === -1) {
        calls.push({
          ticker: capture.source.ticker,
          company: capture.source.companyName,
          rating,
          direction,
          entryDate: entry.date,
          entryPrice: entry.price,
          exitDate: null,
          exitPrice: null,
          exitReason: 'Still open',
          daysHeld: null,
          returnPercent: null,
          correct: null,
        });
        break;
      }

      const exit = usable[exitIndex];
      const exitReason: RatingCall['exitReason'] = exit.quantRating !== rating ? 'Rating changed' : 'Horizon reached';
      const returnPercent = ((exit.price / entry.price) - 1) * 100;
      const correct = direction === 'Neutral' ? null : direction === 'Bullish' ? returnPercent > 0 : returnPercent < 0;
      calls.push({
        ticker: capture.source.ticker,
        company: capture.source.companyName,
        rating,
        direction,
        entryDate: entry.date,
        entryPrice: entry.price,
        exitDate: exit.date,
        exitPrice: exit.price,
        exitReason,
        daysHeld: (new Date(exit.date).getTime() - new Date(entry.date).getTime()) / 86_400_000,
        returnPercent,
        correct,
      });
      index = exitIndex;
    }
  });

  const scored = calls.filter((call): call is RatingCall & { correct: boolean; returnPercent: number } => call.correct !== null);
  const correctCalls = scored.filter((call) => call.correct).length;
  const incorrectCalls = scored.length - correctCalls;
  const interval = wilsonInterval(correctCalls, scored.length);
  const scoredReturns = scored.map((call) => call.returnPercent);

  return {
    horizonDays,
    calls,
    scoredCalls: scored.length,
    correctCalls,
    incorrectCalls,
    hitRate: scored.length ? (correctCalls / scored.length) * 100 : null,
    hitRateLow: interval?.low ?? null,
    hitRateHigh: interval?.high ?? null,
    averageReturn: scoredReturns.length ? scoredReturns.reduce((total, value) => total + value, 0) / scoredReturns.length : null,
    medianReturn: scoredReturns.length ? median(scoredReturns) : null,
    openCalls: calls.filter((call) => call.exitReason === 'Still open').length,
    neutralCalls: calls.filter((call) => call.direction === 'Neutral').length,
  };
};
