import {
  computeProfitConcentration,
  performanceByPeriod,
  summarizeTrades,
  type PeriodPerformance,
  type ProfitConcentration,
} from './evaluate.js';

const DAY_SECONDS = 86_400;
const MIN_HISTORY_DAYS = 30;
const FIXED_HISTORY_DAYS = 90;
const RECENT_DAYS = 30;

export type HistoricalConsistencyTrade = {
  id?: number;
  walletAddress: string;
  observedTimestamp: number;
  eventType: string;
  tokenAddress: string;
  tokenSymbol?: string | null;
  costUsd?: string | number | null;
  buyCostUsd?: string | number | null;
};

type CompletedTrade = {
  sourceId: number;
  timestamp: number;
  returnRatio: number;
  profitUsd: number;
  tokenAddress: string;
  tokenSymbol: string | null;
};

export type HistoricalConsistencyVerdict = 'consistent' | 'declining' | 'recent_only' | 'consistently_negative' | 'insufficient';
export type HistoricalConsistencySplit = 'fixed_60_30' | 'relative_half' | 'insufficient_depth';

export type HistoricalPeriodReport = {
  label: 'early' | 'recent';
  startAt: string | null;
  endAt: string | null;
  trades: number;
  summary: ReturnType<typeof summarizeTrades>;
  weeklyPerformance: PeriodPerformance[];
  monthlyPerformance: PeriodPerformance[];
  weeklyConsistency: {
    positivePeriods: number;
    periodsWithData: number;
    positivePercent: number | null;
  };
  profitConcentration: ProfitConcentration;
};

export type HistoricalConsistencyRow = {
  walletAddress: string;
  availableDays: number | null;
  split: HistoricalConsistencySplit;
  splitPointAt: string | null;
  early: HistoricalPeriodReport;
  recent: HistoricalPeriodReport;
  verdict: HistoricalConsistencyVerdict;
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
};

const parseAmount = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const isoAt = (timestamp: number | null): string | null =>
  timestamp === null ? null : new Date(timestamp * 1000).toISOString();

const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const emptyConcentration = (): ProfitConcentration => ({
  bestToken: null,
  bestThreeTokens: [],
  bestTokenSharePositiveProfitPercent: null,
  bestThreeSharePositiveProfitPercent: null,
  bestTradeProfitUsd: null,
  excludingBestTrade: { trades: 0, medianReturnPercent: null, endingCapitalUsd: null },
  excludingBestToken: { trades: 0, medianReturnPercent: null, endingCapitalUsd: null },
});

const weeklyConsistency = (periods: PeriodPerformance[]): HistoricalPeriodReport['weeklyConsistency'] => {
  const withData = periods.filter((period) => period.medianReturnPercent !== null);
  const positivePeriods = withData.filter((period) => (period.medianReturnPercent ?? 0) > 0).length;
  return {
    positivePeriods,
    periodsWithData: withData.length,
    positivePercent: withData.length === 0 ? null : round((positivePeriods / withData.length) * 100, 1),
  };
};

const periodReport = (
  label: 'early' | 'recent',
  trades: CompletedTrade[],
  startAt: number | null,
  endAt: number | null,
): HistoricalPeriodReport => ({
  label,
  startAt: isoAt(startAt),
  endAt: isoAt(endAt),
  trades: trades.length,
  summary: summarizeTrades(trades),
  weeklyPerformance: performanceByPeriod(trades, 'week'),
  monthlyPerformance: performanceByPeriod(trades, 'month'),
  weeklyConsistency: weeklyConsistency(performanceByPeriod(trades, 'week')),
  profitConcentration: trades.length === 0 ? emptyConcentration() : computeProfitConcentration(trades),
});

const isPositive = (period: HistoricalPeriodReport): boolean =>
  period.summary.medianReturnPercent !== null && period.summary.medianReturnPercent > 0;

const classify = (
  split: HistoricalConsistencySplit,
  early: HistoricalPeriodReport,
  recent: HistoricalPeriodReport,
): HistoricalConsistencyVerdict => {
  if (split === 'insufficient_depth' || early.trades === 0 || recent.trades === 0) return 'insufficient';
  const earlyPositive = isPositive(early);
  const recentPositive = isPositive(recent);
  if (earlyPositive && recentPositive) return 'consistent';
  if (!earlyPositive && recentPositive) return 'recent_only';
  if (earlyPositive && !recentPositive) return 'declining';
  // Both periods have real data and both are non-positive: a distinct outcome from
  // `insufficient`, which means "not enough data to judge" — this wallet has plenty of data
  // and it consistently says no. Collapsing the two into one label would let a wallet with
  // thousands of losing trades read as if nothing were known about it.
  return 'consistently_negative';
};

const completeTrades = (trades: HistoricalConsistencyTrade[]): CompletedTrade[] => trades
  .filter((trade) => trade.eventType === 'sell')
  .map((trade, index) => {
    const proceeds = parseAmount(trade.costUsd);
    const costBasis = parseAmount(trade.buyCostUsd);
    if (proceeds === null || costBasis === null || costBasis <= 0) return null;
    return {
      // A caller may provide no database ID (for example, an imported fixture). Use a
      // per-wallet deterministic fallback so excluding the best trade cannot remove every
      // no-ID trade that happens to share the old sentinel value.
      sourceId: trade.id ?? index,
      timestamp: trade.observedTimestamp,
      returnRatio: (proceeds - costBasis) / costBasis,
      profitUsd: proceeds - costBasis,
      tokenAddress: trade.tokenAddress,
      tokenSymbol: trade.tokenSymbol ?? null,
    } satisfies CompletedTrade;
  })
  .filter((trade): trade is CompletedTrade => trade !== null)
  .sort((left, right) => left.timestamp - right.timestamp || left.sourceId - right.sourceId);

const splitWallet = (trades: CompletedTrade[], nowSeconds: number): {
  split: HistoricalConsistencySplit;
  availableDays: number | null;
  splitPoint: number | null;
  earlyTrades: CompletedTrade[];
  recentTrades: CompletedTrade[];
  earlyStart: number | null;
  earlyEnd: number | null;
  recentStart: number | null;
  recentEnd: number | null;
} => {
  if (trades.length === 0) {
    return {
      split: 'insufficient_depth', availableDays: null, splitPoint: null,
      earlyTrades: [], recentTrades: [], earlyStart: null, earlyEnd: null, recentStart: null, recentEnd: null,
    };
  }

  const first = trades[0].timestamp;
  const last = trades[trades.length - 1].timestamp;
  const availableDays = Math.max(0, (last - first) / DAY_SECONDS);
  if (availableDays < MIN_HISTORY_DAYS) {
    return {
      split: 'insufficient_depth', availableDays: round(availableDays, 2), splitPoint: null,
      earlyTrades: [], recentTrades: [], earlyStart: first, earlyEnd: last, recentStart: null, recentEnd: null,
    };
  }

  if (availableDays < FIXED_HISTORY_DAYS) {
    const splitPoint = first + Math.floor((last - first) / 2);
    return {
      split: 'relative_half', availableDays: round(availableDays, 2), splitPoint,
      earlyTrades: trades.filter((trade) => trade.timestamp <= splitPoint),
      recentTrades: trades.filter((trade) => trade.timestamp > splitPoint),
      earlyStart: first, earlyEnd: splitPoint, recentStart: splitPoint + 1, recentEnd: last,
    };
  }

  const recentStart = nowSeconds - RECENT_DAYS * DAY_SECONDS;
  const earlyStart = nowSeconds - FIXED_HISTORY_DAYS * DAY_SECONDS;
  const splitPoint = recentStart;
  return {
    split: 'fixed_60_30', availableDays: round(availableDays, 2), splitPoint,
    earlyTrades: trades.filter((trade) => trade.timestamp >= earlyStart && trade.timestamp < recentStart),
    recentTrades: trades.filter((trade) => trade.timestamp >= recentStart && trade.timestamp <= nowSeconds),
    earlyStart, earlyEnd: recentStart - 1, recentStart, recentEnd: nowSeconds,
  };
};

export const computeHistoricalConsistency = (
  trades: HistoricalConsistencyTrade[],
  now: Date = new Date(),
): HistoricalConsistencyReport => {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const byWallet = new Map<string, HistoricalConsistencyTrade[]>();
  for (const trade of trades) {
    if (!trade.walletAddress || !Number.isFinite(trade.observedTimestamp) || trade.observedTimestamp > nowSeconds) continue;
    const walletTrades = byWallet.get(trade.walletAddress) ?? [];
    walletTrades.push(trade);
    byWallet.set(trade.walletAddress, walletTrades);
  }

  const rows = [...byWallet.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([walletAddress, walletTrades]) => {
    const completed = completeTrades(walletTrades);
    const split = splitWallet(completed, nowSeconds);
    const early = periodReport('early', split.earlyTrades, split.earlyStart, split.earlyEnd);
    const recent = periodReport('recent', split.recentTrades, split.recentStart, split.recentEnd);
    return {
      walletAddress,
      availableDays: split.availableDays,
      split: split.split,
      splitPointAt: isoAt(split.splitPoint),
      early,
      recent,
      verdict: classify(split.split, early, recent),
    } satisfies HistoricalConsistencyRow;
  });

  const counts: Record<HistoricalConsistencyVerdict, number> = {
    consistent: 0, declining: 0, recent_only: 0, consistently_negative: 0, insufficient: 0,
  };
  for (const row of rows) counts[row.verdict] += 1;
  return {
    computedAt: now.toISOString(),
    rules: {
      minimumHistoryDays: MIN_HISTORY_DAYS,
      fixedHistoryDays: FIXED_HISTORY_DAYS,
      recentDays: RECENT_DAYS,
      description: 'Under 30 days is insufficient; 30–90 days uses a relative half-split; 90+ days uses fixed early 60-day and recent 30-day windows.',
    },
    totalWallets: rows.length,
    counts,
    rows,
  };
};
