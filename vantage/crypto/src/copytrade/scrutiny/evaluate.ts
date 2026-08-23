import type { DatabaseSync } from 'node:sqlite';
import { listRosterWallets, readLatestRankSnapshot, readLeaderboardProvenance, readWalletRankHistory, type LeaderboardProvenance, type WalletRankHistory } from '../screening/roster.js';
import { REPRESENTATIVE_SAMPLE_METHOD, selectRepresentativeTrades } from './representativeSample.js';

/**
 * Turns stored trade history into the one answer this feature exists to give:
 * if $100 had been copied into this trader's trades, what would it be worth now?
 *
 * Deliberate methodology choices, each one the result of a mistake already made in this repo:
 *
 * - **Median is the headline statistic, not average.** A single outlier once made a group here
 *   show +111% average against a -44% median. Both are reported; only the median gates the
 *   verdict.
 * - **A sell is the unit of analysis.** GMGN supplies `buy_cost_usd` on each sell — the cost
 *   basis of exactly what was sold — so return is computed per completed round trip rather
 *   than by trying to re-pair buys and sells ourselves.
 * - **Missing is never zero.** A sell without a usable cost basis is excluded and counted, not
 *   treated as a 0% trade, which would silently drag every statistic toward the middle.
 *
 * This measures the trader's own realized results. It is not a copy-trading simulation: it
 * applies no entry delay, slippage, or fees, so a real copier would do worse than these
 * numbers, never better.
 */

export const RULES = { minTrades: 100, minDays: 7, requiresPositiveMedian: true } as const;
export const STARTING_CAPITAL_USD = 100;
const DEFAULT_PERIOD_DAYS = 30;

/**
 * Bumped whenever a change alters what a number means rather than merely how it is produced,
 * so a frozen snapshot can never be silently compared against a report computed under
 * different rules. v2 scoped results to the roster, derived history span from usable trades
 * only, and stopped truncated wallets receiving a positive verdict.
 */
export const METHODOLOGY_VERSION = 'copytrade-evaluation-v3';

export type Verdict = 'screen_pass' | 'no' | 'thin' | 'flagged' | 'descriptive_only';

export type PeriodPerformance = {
  period: string;
  trades: number;
  winRatePercent: number | null;
  medianReturnPercent: number | null;
  averageReturnPercent: number | null;
  endingCapitalUsd: number | null;
};

export type TokenProfit = {
  tokenAddress: string;
  tokenSymbol: string | null;
  trades: number;
  profitUsd: number;
};

export type ProfitConcentration = {
  bestToken: TokenProfit | null;
  bestThreeTokens: TokenProfit[];
  bestTokenSharePositiveProfitPercent: number | null;
  bestThreeSharePositiveProfitPercent: number | null;
  bestTradeProfitUsd: number | null;
  excludingBestTrade: { trades: number; medianReturnPercent: number | null; endingCapitalUsd: number | null };
  excludingBestToken: { trades: number; medianReturnPercent: number | null; endingCapitalUsd: number | null };
};

export type CopyTradeRow = {
  walletAddress: string;
  name: string | null;
  iconUrl?: string | null;
  trades: number;
  winRatePercent: number | null;
  medianReturnPercent: number | null;
  averageReturnPercent: number | null;
  /** Equal-weight portfolio result — the headline. See equalWeightCapital. */
  endingCapitalUsd: number | null;
  verdict: Verdict;
  riskFlags: string[];
  gmgnTags?: string[];
  failedRules: string[];
  /** Sells that had no usable cost basis, so no return could be computed. Additive to the
   *  agreed contract — surfacing it lets the UI explain a small `trades` count honestly. */
  excludedNoCostBasis: number;
  /** Sequential-reinvestment result. Additive, and deliberately secondary: it explodes when
   *  returns are outlier-dominated. A large gap from endingCapitalUsd is the warning sign. */
  endingCapitalUsdCompounded: number | null;
  /** Daily equal-weight capital path, starting at the $100 baseline and ending at
   *  endingCapitalUsd. This is descriptive wallet performance, not the delayed-copy model. */
  capitalPath?: { day: string; capitalUsd: number }[];
  /** True when the fetch hit the per-wallet request cap, so this is the newest slice of the
   *  wallet's history rather than the requested window. */
  truncated: boolean;
  /** GMGN returned an error before this wallet's requested history was fetched. */
  historyFailed?: boolean;
  /** Days actually spanned by the trades used here — not the days requested. */
  coveredDays: number | null;
  /** Unix seconds of this wallet's most recent completed trade, and how long ago that was.
   *  A wallet can hold a strong historical record and still have stopped trading entirely —
   *  confirmed live on this project's own top wallet, which showed a +13.8% median over 398
   *  round trips while GMGN's own feed had no activity for it in 15 days. Ranking that beside
   *  actively-trading wallets, with nothing marking it dormant, is misleading. Null only when
   *  the wallet has no completed trades at all. */
  lastTradeAt: number | null;
  daysSinceLastTrade: number | null;
  /** Truncated wallets are exactly the high-volume ones the paged API cannot cover; a single
   *  Dune query aggregates them without paging. */
  needsDuneBackfill: boolean;
  /** Why the mean-based figures were withheld, or null when they are trustworthy. */
  unreliableReason: string | null;
  /** Measured facts behind the risk flag, so the flag can be judged rather than trusted. */
  riskEvidence: RiskEvidence;
  /** The same evidence as plain sentences, ready to render beside the verdict. */
  riskNotes: string[];
  /** Whether this wallet can be ranked beside fully covered wallets. */
  comparable: boolean;
  profitConcentration: ProfitConcentration;
  weeklyPerformance: PeriodPerformance[];
  monthlyPerformance: PeriodPerformance[];
  rankHistory: WalletRankHistory;
  representativeSampled?: boolean;
  representativePopulationTrades?: number;
  representativeSampleTrades?: number;
  /** GMGN's aggregate wallet-statistics snapshot for the requested period. */
  gmgnAggregate?: GmgnAggregateStats;
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
};

export type CopyTradeOverall = {
  trades: number;
  winRatePercent: number | null;
  medianReturnPercent: number | null;
  averageReturnPercent: number | null;
  endingCapitalUsd: number | null;
  endingCapitalUsdCompounded: number | null;
  unreliableReason: string | null;
  /**
   * How the wallets were combined. Both answers are correct; they answer different questions.
   *
   * `trade-weighted` pools every trade, so a wallet with 6,000 trades outvotes one with 90 by
   * about 67 to 1. It answers "across all this activity, what happened?" — the right frame if
   * you would copy every trade you saw.
   *
   * `wallet-weighted` gives each wallet one vote regardless of how much it traded. It answers
   * "how does a typical trader on this list do?" — the right frame for judging the leaderboard
   * itself rather than its busiest member.
   *
   * Neither replaces the other, so both are always returned. Reporting only the pooled figure
   * meant a single high-volume wallet could silently define the headline for all of them.
   */
  weighting: 'trade-weighted' | 'wallet-weighted';
  /** Wallets contributing, for wallet-weighted. Null for trade-weighted, where it is not the unit. */
  wallets: number | null;
};

/**
 * Truncation biases the mean but not the median.
 *
 * Capping keeps the *newest* N trades, so a truncated wallet's sample is a recent slice rather
 * than a random draw from the window — one afternoon standing in for a month. A proportion
 * (win rate) and a quantile (median) survive that: they describe the slice honestly and are
 * robust to which extreme trades happened to land in it. The mean does not, because it is
 * driven by rare extreme returns, and whether the slice caught one is arbitrary. So the
 * mean-based figures are withheld rather than shown looking equally solid.
 */
const TRUNCATION_REASON = 'Only the newest trades were fetched for this wallet, so average-based figures would be biased. Median and win rate remain valid for the period covered.';

/** A sell within this long of the matching buy is a round trip no human reaction time explains. */
const FAST_ROUND_TRIP_SECONDS = 60;
/** User-facing copyability metric: completed GMGN round trips held for 15 seconds or less. */
const UNDER_15_SECONDS = 15;

/**
 * Evidence behind a risk flag, computed from the trades we hold rather than taken on trust.
 *
 * GMGN publishes a `wash_trader` tag but not the rule behind it, which is thin ground for
 * disqualifying a wallet. Its own "Phishing check" numbers would be better, but those live
 * only on a browser endpoint — verified absent from the official API. So these are derived
 * from stored trade rows, which means they are reproducible and auditable against the raw
 * payloads, and they cost no extra requests.
 *
 * None of these prove wash trading on their own. A scalper legitimately round-trips fast, and
 * an airdrop legitimately arrives without a purchase. They are stated as observations so a
 * reader can judge, not as a verdict.
 */
export type RiskEvidence = {
  /** Sells that closed within a minute of the matching buy. */
  fastRoundTripPercent: number | null;
  /** Completed GMGN buy/sell pairs held for 15 seconds or less. */
  under15SecondsPercent?: number | null;
  /** Number of completed pairs at or below the 15-second threshold. */
  under15SecondsCount?: number;
  /** Total completed buy/sell pairs used as the denominator for the 15-second metric. */
  pairedTradeCount?: number;
  /** Sells of tokens with no recorded purchase — transferred in rather than bought. */
  noCostBasisPercent: number | null;
  /** Typical gap between buying and selling, in seconds. */
  medianHoldSeconds: number | null;
  /** Where the wallet's first funding came from, per GMGN. */
  fundedByAddress: string | null;
  walletAgeDays: number | null;
};

export type CopyTradeReport = {
  computedAt: string;
  startingCapitalUsd: number;
  periodDays: number;
  rows: CopyTradeRow[];
  /** Every trade pooled — dominated by the highest-volume wallets. */
  overall: CopyTradeOverall;
  /** One vote per wallet — how a typical trader on this list did. */
  overallByWallet: CopyTradeOverall;
  rules: { minTrades: number; minDays: number; requiresPositiveMedian: boolean };
  /** Everything needed to reproduce this exact report. Carried on the report itself so a
   *  frozen snapshot records the scope it was computed under rather than the defaults. */
  scope: {
    chain: string;
    traderLimit: number | null;
    rosterSnapshotId: number | null;
    rosterSize: number;
    methodologyVersion: string;
    rosterProvenance: LeaderboardProvenance | null;
  };
  walletPerformance: { status: 'available'; description: string };
  copySimulation: { status: 'not_available'; description: string; requiredInputs: string[] };
  representativeSampling?: {
    method: string;
    maxSellsPerWallet: number | null;
    sampledWallets: number;
    populationTrades: number;
    selectedTrades: number;
  };
};

type ReturnObservation = { timestamp: number; returnRatio: number };

/** A completed sell, already ordered by time. `returnRatio` is a fraction: 0.05 = +5%. */
type CompletedTrade = ReturnObservation & {
  sourceId: number;
  timestamp: number;
  returnRatio: number;
  profitUsd: number;
  tokenAddress: string;
  tokenSymbol: string | null;
};

const parseAmount = (value: string | null): number | null => {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseJsonObject = (value: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

const numberField = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const readGmgnAggregate = (row: { period: string; fetchedAt: string; rawPayload: string }): GmgnAggregateStats | null => {
  const payload = parseJsonObject(row.rawPayload);
  if (!payload) return null;
  const pnlStat = payload.pnl_stat && typeof payload.pnl_stat === 'object' ? payload.pnl_stat as Record<string, unknown> : {};
  const winRate = numberField(pnlStat.winrate);
  const realizedProfitPnl = numberField(payload.realized_profit_pnl);
  return {
    period: row.period,
    fetchedAt: row.fetchedAt,
    realizedProfit: numberField(payload.realized_profit),
    realizedProfitPnlPercent: realizedProfitPnl === null ? null : realizedProfitPnl * 100,
    nativeBalance: numberField(payload.native_balance),
    buyCount: numberField(payload.buy),
    sellCount: numberField(payload.sell),
    boughtCost: numberField(payload.bought_cost),
    soldIncome: numberField(payload.sold_income),
    boughtFee: numberField(payload.bought_fee),
    soldFee: numberField(payload.sold_fee),
    totalCost: numberField(payload.total_cost),
    lastTimestamp: numberField(payload.last_timestamp),
    tokenCount: numberField(pnlStat.token_num),
    winRatePercent: winRate === null ? null : winRate * 100,
    averageHoldingPeriodSeconds: numberField(pnlStat.avg_holding_period),
  };
};

const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

export const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export const mean = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;

/**
 * Sequential reinvestment: put the whole balance into each trade, in time order.
 *
 * This is the literal reading of "what would $100 have become", and it is the wrong model for
 * these traders. It assumes one position at a time, while a memecoin trader runs many
 * concurrently — so a +5000% return on one small position is credited as a 50x on the entire
 * bankroll. Against real data this produced $1.35e+22 for a wallet whose *median* trade lost
 * 0.67%. It is kept and reported because it is the honest output of the obvious model, and
 * seeing it diverge from the equal-weight figure is exactly what tells you the returns are
 * outlier-dominated. It is not the headline number.
 *
 * A -100% trade takes the balance to zero and it stays there: with nothing left there is
 * nothing to place on the next trade. The multiplier is floored at zero so a malformed return
 * below -100% cannot produce negative capital, and a non-finite result becomes null rather
 * than Infinity.
 */
export const compoundCapital = (trades: ReturnObservation[], startingCapital: number): number | null => {
  if (trades.length === 0) return null;
  const ordered = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  let capital = startingCapital;
  for (const trade of ordered) {
    capital *= Math.max(0, 1 + trade.returnRatio);
    if (capital === 0) break;
  }
  return Number.isFinite(capital) ? round(capital, 2) : null;
};

/**
 * Equal-weight portfolio: split the starting capital evenly across every trade the trader
 * made, and add up what comes back. This is the headline figure.
 *
 * It is the defensible model for copy-trading because it does not assume positions are
 * sequential, and no single trade can multiply the whole bankroll. The mean is the correct
 * aggregator here — for a portfolio, the average return *is* the portfolio return — which is
 * a different question from "what did a typical trade do", and that one is answered by the
 * median. Both are reported because both are true and they routinely disagree.
 */
export const equalWeightCapital = (trades: ReturnObservation[], startingCapital: number): number | null => {
  const meanRatio = mean(trades.map((trade) => trade.returnRatio));
  if (meanRatio === null) return null;
  const capital = Math.max(0, startingCapital * (1 + meanRatio));
  return Number.isFinite(capital) ? round(capital, 2) : null;
};

/**
 * The single implementation of the summary statistics, used for both a per-wallet row and the
 * overall row. Two separate implementations drifted apart in this repo before; there is
 * deliberately only one here.
 */
export const summarizeTrades = (trades: ReturnObservation[]): {
  trades: number;
  winRatePercent: number | null;
  medianReturnPercent: number | null;
  averageReturnPercent: number | null;
  endingCapitalUsd: number | null;
  endingCapitalUsdCompounded: number | null;
} => {
  const ratios = trades.map((trade) => trade.returnRatio);
  const medianRatio = median(ratios);
  const meanRatio = mean(ratios);
  return {
    trades: trades.length,
    winRatePercent: ratios.length === 0 ? null : round((ratios.filter((r) => r > 0).length / ratios.length) * 100, 1),
    medianReturnPercent: medianRatio === null ? null : round(medianRatio * 100, 2),
    averageReturnPercent: meanRatio === null ? null : round(meanRatio * 100, 2),
    endingCapitalUsd: equalWeightCapital(trades, STARTING_CAPITAL_USD),
    endingCapitalUsdCompounded: compoundCapital(trades, STARTING_CAPITAL_USD),
  };
};

const periodPerformance = (period: string, trades: CompletedTrade[]): PeriodPerformance => {
  const summary = summarizeTrades(trades);
  return {
    period,
    trades: summary.trades,
    winRatePercent: summary.winRatePercent,
    medianReturnPercent: summary.medianReturnPercent,
    averageReturnPercent: summary.averageReturnPercent,
    endingCapitalUsd: summary.endingCapitalUsd,
  };
};

/** Build a small, deterministic equal-weight chart series from the same completed trades used
 * by the row. The original chart fully compounded the bankroll through every trade, even when
 * positions overlapped, and produced astronomical fiction. Here every trade receives exactly
 * $100 / N of notional weight; cumulative P&L therefore ends at equalWeightCapital(). */
const capitalPathByDay = (trades: CompletedTrade[], startingCapital = STARTING_CAPITAL_USD): { day: string; capitalUsd: number }[] => {
  if (trades.length === 0) return [];
  const ordered = [...trades].sort((left, right) => left.timestamp - right.timestamp || left.sourceId - right.sourceId);
  const stakePerTrade = startingCapital / ordered.length;
  let cumulativePnl = 0;
  const firstDay = new Date(ordered[0].timestamp * 1000).toISOString().slice(0, 10);
  const points: { day: string; capitalUsd: number }[] = [{ day: `${firstDay} start`, capitalUsd: startingCapital }];
  let currentDay = firstDay;
  for (const trade of ordered) {
    const day = new Date(trade.timestamp * 1000).toISOString().slice(0, 10);
    if (day !== currentDay) {
      points.push({ day: currentDay, capitalUsd: round(Math.max(0, startingCapital + cumulativePnl), 2) });
      currentDay = day;
    }
    cumulativePnl += stakePerTrade * trade.returnRatio;
  }
  points.push({ day: currentDay, capitalUsd: round(Math.max(0, startingCapital + cumulativePnl), 2) });
  return points;
};

const utcWeekStart = (timestamp: number): string => {
  const date = new Date(timestamp * 1000);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
};

export const performanceByPeriod = (
  trades: CompletedTrade[],
  period: 'week' | 'month',
): PeriodPerformance[] => {
  const groups = new Map<string, CompletedTrade[]>();
  for (const trade of trades) {
    const key = period === 'week' ? utcWeekStart(trade.timestamp)
      : new Date(trade.timestamp * 1000).toISOString().slice(0, 7);
    const group = groups.get(key) ?? [];
    group.push(trade);
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, values]) => periodPerformance(key, values));
};

export const computeProfitConcentration = (trades: CompletedTrade[]): ProfitConcentration => {
  const byToken = new Map<string, TokenProfit>();
  for (const trade of trades) {
    const current = byToken.get(trade.tokenAddress) ?? {
      tokenAddress: trade.tokenAddress, tokenSymbol: trade.tokenSymbol, trades: 0, profitUsd: 0,
    };
    current.trades += 1;
    current.profitUsd += trade.profitUsd;
    if (!current.tokenSymbol && trade.tokenSymbol) current.tokenSymbol = trade.tokenSymbol;
    byToken.set(trade.tokenAddress, current);
  }
  const tokens = [...byToken.values()].map((token) => ({ ...token, profitUsd: round(token.profitUsd, 2) }))
    .sort((left, right) => right.profitUsd - left.profitUsd || left.tokenAddress.localeCompare(right.tokenAddress));
  const positiveProfit = tokens.reduce((total, token) => total + Math.max(0, token.profitUsd), 0);
  const share = (profit: number): number | null => positiveProfit <= 0 ? null
    : round((Math.max(0, profit) / positiveProfit) * 100, 1);
  const bestTrade = trades.reduce<CompletedTrade | null>((best, trade) => !best || trade.profitUsd > best.profitUsd ? trade : best, null);
  const bestToken = tokens[0] ?? null;
  const withoutBestTrade = bestTrade ? trades.filter((trade) => trade.sourceId !== bestTrade.sourceId) : [...trades];
  const withoutBestToken = bestToken ? trades.filter((trade) => trade.tokenAddress !== bestToken.tokenAddress) : [...trades];
  const withoutTradeSummary = summarizeTrades(withoutBestTrade);
  const withoutTokenSummary = summarizeTrades(withoutBestToken);
  const bestThreeTokens = tokens.slice(0, 3);
  return {
    bestToken,
    bestThreeTokens,
    bestTokenSharePositiveProfitPercent: bestToken ? share(bestToken.profitUsd) : null,
    bestThreeSharePositiveProfitPercent: share(bestThreeTokens.reduce((total, token) => total + Math.max(0, token.profitUsd), 0)),
    bestTradeProfitUsd: bestTrade ? round(bestTrade.profitUsd, 2) : null,
    excludingBestTrade: {
      trades: withoutTradeSummary.trades,
      medianReturnPercent: withoutTradeSummary.medianReturnPercent,
      endingCapitalUsd: withoutTradeSummary.endingCapitalUsd,
    },
    excludingBestToken: {
      trades: withoutTokenSummary.trades,
      medianReturnPercent: withoutTokenSummary.medianReturnPercent,
      endingCapitalUsd: withoutTokenSummary.endingCapitalUsd,
    },
  };
};

export const decideVerdict = (input: {
  trades: number;
  spanDays: number;
  medianReturnPercent: number | null;
  riskFlags: string[];
  /** True when the fetch stopped at the per-wallet request cap, so the requested window was
   *  never fully covered. Without this gate a wallet could earn a positive verdict from a
   *  recent slice while its average was being withheld as untrustworthy in the same row. */
  truncated?: boolean;
}): { verdict: Verdict; failedRules: string[] } => {
  const failedRules: string[] = [];
  if (input.riskFlags.length > 0) failedRules.push(`carries risk flag: ${input.riskFlags.join(', ')}`);
  if (input.truncated) failedRules.push('requested history window incomplete');
  if (input.trades < RULES.minTrades) failedRules.push(`fewer than ${RULES.minTrades} completed trades`);
  if (input.spanDays < RULES.minDays) failedRules.push(`less than ${RULES.minDays} days of history`);
  if (input.medianReturnPercent === null) failedRules.push('no median return could be computed');
  else if (input.medianReturnPercent <= 0) failedRules.push('median return is not positive');

  if (failedRules.length === 0) return { verdict: 'screen_pass', failedRules };
  // Precedence is deliberate. A risk flag questions whether the numbers mean anything at all,
  // so it outranks everything. Incomplete coverage comes next: it says the sample is not the
  // one that was asked for, which is a different and more serious problem than it merely being
  // small, and it must never be reported as "thin data" that more of the same would fix.
  if (input.riskFlags.length > 0) return { verdict: 'flagged', failedRules };
  if (input.truncated) return { verdict: 'descriptive_only', failedRules };
  if (input.trades < RULES.minTrades || input.spanDays < RULES.minDays) return { verdict: 'thin', failedRules };
  return { verdict: 'no', failedRules };
};

type TradeRow = {
  id?: number; walletAddress: string; observedTimestamp: number; eventType: string;
  tokenAddress: string; tokenSymbol?: string | null; costUsd: string | null; buyCostUsd: string | null;
};

/**
 * Hold times per sell, measured against the most recent prior buy of the same token by the
 * same wallet. Approximate by design — it is "time since that wallet last bought this token",
 * not a FIFO lot match — but it is the right shape for spotting instant round trips, and it
 * cannot be gamed by partial fills the way a stricter pairing could silently drop them.
 */
export const holdSecondsPerSell = (rows: TradeRow[]): number[] => {
  const lastBuyByToken = new Map<string, number>();
  const holds: number[] = [];
  // Rows arrive oldest-first per wallet, so a buy is always seen before the sell it precedes.
  for (const row of rows) {
    const key = row.tokenAddress;
    if (row.eventType === 'buy') { lastBuyByToken.set(key, row.observedTimestamp); continue; }
    if (row.eventType !== 'sell') continue;
    const boughtAt = lastBuyByToken.get(key);
    if (boughtAt === undefined) continue;
    holds.push(Math.max(0, row.observedTimestamp - boughtAt));
  }
  return holds;
};

export const buildRiskNotes = (evidence: RiskEvidence, riskFlags: string[]): string[] => {
  const notes: string[] = [];
  if (riskFlags.includes('wash_trader')) notes.push('GMGN tags this wallet wash_trader. GMGN does not publish how it decides that, so the measurements below are ours.');
  if (evidence.fastRoundTripPercent !== null && evidence.fastRoundTripPercent >= 10) {
    notes.push(`${evidence.fastRoundTripPercent}% of sells closed within ${FAST_ROUND_TRIP_SECONDS} seconds of the buy.`);
  }
  if (evidence.noCostBasisPercent !== null && evidence.noCostBasisPercent >= 10) {
    notes.push(`${evidence.noCostBasisPercent}% of sells were tokens with no recorded purchase — received, not bought.`);
  }
  if (evidence.medianHoldSeconds !== null) {
    const seconds = evidence.medianHoldSeconds;
    // Seconds matter here: these wallets routinely hold for under a minute, and rounding that
    // to "0 minutes" reads as missing data rather than as the finding it actually is.
    notes.push(seconds < 60 ? `Typical hold is ${seconds} seconds.`
      : seconds < 3600 ? `Typical hold is ${Math.round(seconds / 60)} minutes.`
      : `Typical hold is ${(seconds / 3600).toFixed(1)} hours.`);
  }
  if (evidence.fundedByAddress) notes.push(`First funded from ${evidence.fundedByAddress}.`);
  if (evidence.walletAgeDays !== null && evidence.walletAgeDays < 30) {
    notes.push(`Wallet is only ${Math.round(evidence.walletAgeDays)} days old.`);
  }
  return notes;
};

export const computeCopyTradeReport = (
  database: DatabaseSync,
  options: { periodDays?: number; chain?: string; now?: Date; traderLimit?: number; rosterSnapshotId?: number } = {},
): CopyTradeReport => {
  const periodDays = options.periodDays ?? DEFAULT_PERIOD_DAYS;
  const chain = options.chain ?? 'sol';
  const now = options.now ?? new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const cutoffSeconds = nowSeconds - periodDays * 86_400;

  const roster = listRosterWallets(database, { chain, limit: options.traderLimit, snapshotId: options.rosterSnapshotId });
  const rosterByAddress = new Map(roster.map((wallet) => [wallet.walletAddress, wallet]));
  const rosterSnapshotId = options.rosterSnapshotId ?? readLatestRankSnapshot(database).snapshotId;
  const rankHistoryByAddress = new Map(readWalletRankHistory(
    database, roster.map((wallet) => wallet.walletAddress), rosterSnapshotId,
  ).map((history) => [history.walletAddress, history]));

  const truncatedWallets = new Set(
    (database.prepare(
      `SELECT wallet_address AS walletAddress FROM copytrade_wallet_coverage WHERE chain = ? AND truncated = 1`,
    ).all(chain) as unknown as Array<{ walletAddress: string }>).map((row) => row.walletAddress),
  );
  const failedHistoryWallets = new Set(
    (database.prepare(
      `SELECT wallet_address AS walletAddress FROM copytrade_wallet_coverage WHERE chain = ? AND stop_reason = 'failed'`,
    ).all('sol') as Array<{ walletAddress: string }>).map((row) => row.walletAddress),
  );

  // Buys are pulled alongside sells so hold time can be measured; only sells become trades.
  const storedRows = database.prepare(
    `SELECT id, wallet_address AS walletAddress, observed_timestamp AS observedTimestamp,
            event_type AS eventType, token_address AS tokenAddress,
            token_symbol AS tokenSymbol,
            cost_usd AS costUsd, buy_cost_usd AS buyCostUsd
     FROM copytrade_trades
     WHERE chain = ? AND event_type IN ('buy', 'sell') AND observed_timestamp >= ?
     ORDER BY wallet_address ASC, observed_timestamp ASC, id ASC`,
  ).all(chain, cutoffSeconds) as unknown as TradeRow[];
  // This is an analysis-only boundary. All rows remain in SQLite; the sample is computed
  // locally and therefore does not trigger any additional GMGN or Dune requests.
  const representative = selectRepresentativeTrades(storedRows);
  const rows = representative.rows;

  const walletStats = new Map<string, {
    walletAddress: string; period: string; fetchedAt: string; fundFromAddress: string | null;
    createdAtTs: number | null; rawPayload: string; aggregate?: GmgnAggregateStats;
  }>();
  const walletStatRows = database.prepare(
    `SELECT wallet_address AS walletAddress, period, fetched_at AS fetchedAt,
            fund_from_address AS fundFromAddress, created_at_ts AS createdAtTs, raw_payload AS rawPayload
     FROM copytrade_wallet_stats WHERE chain = ?
     ORDER BY CASE WHEN period = '30d' THEN 0 ELSE 1 END, fetched_at DESC`,
  ).all(chain) as unknown as Array<{ walletAddress: string; period: string; fetchedAt: string; fundFromAddress: string | null; createdAtTs: number | null; rawPayload: string }>;
  for (const row of walletStatRows) {
    // Prefer the requested 30-day aggregate, but retain the older 7-day stats as a fallback
    // for risk context and for already-created databases that have not fetched 30d yet.
    if (walletStats.has(row.walletAddress)) continue;
    walletStats.set(row.walletAddress, { ...row, aggregate: row.period === '30d' ? readGmgnAggregate(row) ?? undefined : undefined });
  }

  type WalletEntry = { completed: CompletedTrade[]; excluded: number; sells: number; rows: TradeRow[] };
  const byWallet = new Map<string, WalletEntry>();
  for (const row of rows) {
    let entry = byWallet.get(row.walletAddress);
    if (!entry) { entry = { completed: [], excluded: 0, sells: 0, rows: [] }; byWallet.set(row.walletAddress, entry); }
    entry.rows.push(row);
    if (row.eventType !== 'sell') continue;

    entry.sells += 1;
    const proceeds = parseAmount(row.costUsd);
    const costBasis = parseAmount(row.buyCostUsd);
    // A sell of tokens that were transferred in rather than bought has no cost basis, so its
    // return is genuinely unknowable from this data. Excluded and counted — never zeroed.
    if (proceeds === null || costBasis === null || costBasis <= 0) { entry.excluded += 1; continue; }
    entry.completed.push({
      sourceId: row.id ?? -1,
      timestamp: row.observedTimestamp,
      returnRatio: (proceeds - costBasis) / costBasis,
      profitUsd: proceeds - costBasis,
      tokenAddress: row.tokenAddress,
      tokenSymbol: row.tokenSymbol ?? null,
    });
  }

  /**
   * History span, measured over the trades the statistics are actually computed from.
   *
   * Previously the first/last timestamps were updated before the cost-basis check, and were
   * seeded from whichever row appeared first — including a buy. Either path let a row that
   * contributes nothing to the results stretch the measured history: a wallet with 120 usable
   * trades inside five minutes plus one unusable sell from 20 days earlier reported 19.96 days
   * of history and earned a full `yes`. The span must come from the same population as the
   * numbers it is used to qualify.
   */
  const spanDaysOf = (completed: CompletedTrade[]): number => {
    if (completed.length === 0) return 0;
    let first = completed[0].timestamp;
    let last = completed[0].timestamp;
    for (const trade of completed) {
      if (trade.timestamp < first) first = trade.timestamp;
      if (trade.timestamp > last) last = trade.timestamp;
    }
    return (last - first) / 86_400;
  };

  /** Same population as spanDaysOf on purpose — the newest trade actually used in the numbers,
   *  not the newest row in the table. */
  const lastTradeAtOf = (completed: CompletedTrade[]): number | null => {
    if (completed.length === 0) return null;
    let last = completed[0].timestamp;
    for (const trade of completed) if (trade.timestamp > last) last = trade.timestamp;
    return last;
  };

  const reportRows: CopyTradeRow[] = [];
  const allCompleted: CompletedTrade[] = [];
  let anyTruncatedContributes = false;
  for (const [walletAddress, entry] of byWallet) {
    const rosterEntry = rosterByAddress.get(walletAddress);
    // Always scoped to the current roster, with no opt-out. Previously the roster was only
    // enforced when a trader limit was supplied, so the default report showed every wallet
    // ever fetched — including wallets that had since dropped off the leaderboard, and worse,
    // showing them with an EMPTY risk-flag list because their roster entry was gone. A wallet
    // GMGN had tagged wash_trader therefore rendered as clean.
    if (!rosterEntry) continue;
    const riskFlags = rosterEntry.riskFlags;
    const summary = summarizeTrades(entry.completed);
    const spanDays = spanDaysOf(entry.completed);
    const lastTradeAt = lastTradeAtOf(entry.completed);
    const truncated = truncatedWallets.has(walletAddress);
    const historyFailed = failedHistoryWallets.has(walletAddress);
    const { verdict, failedRules } = decideVerdict({ trades: summary.trades, spanDays, medianReturnPercent: summary.medianReturnPercent, riskFlags, truncated });
    if (truncated) anyTruncatedContributes = true;

    const holds = holdSecondsPerSell(entry.rows);
    const stats = walletStats.get(walletAddress);
    const medianHold = median(holds);
    const riskEvidence: RiskEvidence = {
      fastRoundTripPercent: holds.length === 0 ? null
        : round((holds.filter((seconds) => seconds <= FAST_ROUND_TRIP_SECONDS).length / holds.length) * 100, 1),
      under15SecondsPercent: holds.length === 0 ? null
        : round((holds.filter((seconds) => seconds <= UNDER_15_SECONDS).length / holds.length) * 100, 1),
      under15SecondsCount: holds.filter((seconds) => seconds <= UNDER_15_SECONDS).length,
      pairedTradeCount: holds.length,
      noCostBasisPercent: entry.sells === 0 ? null : round((entry.excluded / entry.sells) * 100, 1),
      medianHoldSeconds: medianHold === null ? null : Math.round(medianHold),
      fundedByAddress: stats?.fundFromAddress ?? null,
      walletAgeDays: stats?.createdAtTs
        ? round((now.getTime() / 1000 - stats.createdAtTs) / 86_400, 1)
        : null,
    };
    const riskNotes = buildRiskNotes(riskEvidence, riskFlags);
    const rankHistory = rankHistoryByAddress.get(walletAddress) ?? {
      walletAddress, leaderboardCaptures: 0, appearances: 0, topFiveAppearances: 0,
      topFiveMembershipPercent: null, currentRank: rosterEntry.rankPosition,
      bestRank: rosterEntry.rankPosition, worstRank: rosterEntry.rankPosition,
      firstObservedAt: null, lastObservedAt: null,
    };
    const sampleInfo = representative.byWallet.get(walletAddress) ?? {
      populationSellCount: entry.sells, selectedSellCount: entry.sells, sampled: false,
    };

    reportRows.push({
      walletAddress,
      name: rosterEntry?.name ?? null,
      iconUrl: rosterEntry?.iconUrl ?? null,
      ...summary,
      // Withheld, not zeroed: null already means "not computable" everywhere in this contract,
      // and the UI renders it as an em dash rather than a number that invites trust.
      averageReturnPercent: truncated ? null : summary.averageReturnPercent,
      endingCapitalUsd: truncated ? null : summary.endingCapitalUsd,
      endingCapitalUsdCompounded: truncated ? null : summary.endingCapitalUsdCompounded,
      capitalPath: truncated ? [] : capitalPathByDay(entry.completed),
      verdict,
      riskFlags,
      gmgnTags: rosterEntry.gmgnTags,
      failedRules,
      excludedNoCostBasis: entry.excluded,
      truncated,
      historyFailed,
      // Four decimals, not two: a wallet capped to a short slice can span well under an hour,
      // and rounding that to 0.00 days would read as "no coverage" instead of "very little".
      coveredDays: entry.completed.length === 0 ? null : round(spanDays, 4),
      lastTradeAt,
      daysSinceLastTrade: lastTradeAt === null ? null : round((nowSeconds - lastTradeAt) / 86_400, 1),
      needsDuneBackfill: truncated,
      unreliableReason: truncated ? TRUNCATION_REASON : null,
      riskEvidence,
      riskNotes,
      comparable: !truncated,
      profitConcentration: computeProfitConcentration(entry.completed),
      weeklyPerformance: performanceByPeriod(entry.completed, 'week'),
      monthlyPerformance: performanceByPeriod(entry.completed, 'month'),
      rankHistory,
      representativeSampled: sampleInfo.sampled,
      representativePopulationTrades: sampleInfo.populationSellCount,
      representativeSampleTrades: sampleInfo.selectedSellCount,
      ...(stats?.aggregate ? { gmgnAggregate: stats.aggregate } : {}),
    });
    allCompleted.push(...entry.completed);
  }

  // Worst first: the point of the table is to show who fails, not to flatter the roster.
  reportRows.sort((a, b) => {
    if (a.endingCapitalUsd === null && b.endingCapitalUsd === null) return a.walletAddress.localeCompare(b.walletAddress);
    if (a.endingCapitalUsd === null) return 1;
    if (b.endingCapitalUsd === null) return -1;
    return b.endingCapitalUsd - a.endingCapitalUsd;
  });

  const overallSummary = summarizeTrades(allCompleted);

  /**
   * Wallet-weighted aggregation: average each per-wallet statistic across wallets, so every
   * wallet counts once. Wallets whose own figure was withheld (truncated) are excluded from
   * that particular average rather than counted as zero — same rule as everywhere else here.
   */
  const across = (pick: (row: CopyTradeRow) => number | null): number | null => {
    const values = reportRows.map(pick).filter((value): value is number => value !== null);
    const average = mean(values);
    return average === null ? null : round(average, 2);
  };
  const walletWeighted: CopyTradeOverall = {
    trades: reportRows.reduce((total, row) => total + row.trades, 0),
    // A median of per-wallet medians, not of pooled trades — the typical trader's typical trade.
    winRatePercent: across((row) => row.winRatePercent),
    medianReturnPercent: (() => {
      const medians = reportRows.map((row) => row.medianReturnPercent).filter((value): value is number => value !== null);
      const middle = median(medians);
      return middle === null ? null : round(middle, 2);
    })(),
    averageReturnPercent: across((row) => row.averageReturnPercent),
    endingCapitalUsd: across((row) => row.endingCapitalUsd),
    endingCapitalUsdCompounded: across((row) => row.endingCapitalUsdCompounded),
    unreliableReason: anyTruncatedContributes
      ? 'Truncated wallets are excluded from the average-based figures here rather than biasing them.'
      : null,
    weighting: 'wallet-weighted',
    wallets: reportRows.length,
  };

  return {
    computedAt: now.toISOString(),
    startingCapitalUsd: STARTING_CAPITAL_USD,
    periodDays,
    rows: reportRows,
    overall: {
      trades: overallSummary.trades,
      winRatePercent: overallSummary.winRatePercent,
      medianReturnPercent: overallSummary.medianReturnPercent,
      // One truncated wallet biases the pooled mean just as it biases its own, so the overall
      // mean-based figures are withheld too rather than quietly inheriting the bias.
      averageReturnPercent: anyTruncatedContributes ? null : overallSummary.averageReturnPercent,
      endingCapitalUsd: anyTruncatedContributes ? null : overallSummary.endingCapitalUsd,
      endingCapitalUsdCompounded: anyTruncatedContributes ? null : overallSummary.endingCapitalUsdCompounded,
      unreliableReason: anyTruncatedContributes
        ? 'At least one wallet was truncated, so pooled average-based figures would be biased.'
        : null,
      weighting: 'trade-weighted',
      wallets: null,
    },
    overallByWallet: walletWeighted,
    rules: { minTrades: RULES.minTrades, minDays: RULES.minDays, requiresPositiveMedian: RULES.requiresPositiveMedian },
    scope: {
      chain,
      traderLimit: options.traderLimit ?? null,
      rosterSnapshotId,
      rosterSize: roster.length,
      methodologyVersion: METHODOLOGY_VERSION,
      rosterProvenance: rosterSnapshotId === null ? null : readLeaderboardProvenance(database, rosterSnapshotId),
    },
    walletPerformance: {
      status: 'available',
      description: 'Historical realized performance of the target wallets. It does not include copy delay, slippage, fees, liquidity, or failed orders.',
    },
    copySimulation: {
      status: 'not_available',
      description: 'Copy performance is intentionally separate and has not been simulated.',
      requiredInputs: ['detection delay', 'entry and exit slippage', 'priority and platform fees', 'liquidity limits', 'failed-order assumptions'],
    },
    representativeSampling: {
      method: REPRESENTATIVE_SAMPLE_METHOD,
      maxSellsPerWallet: null,
      sampledWallets: reportRows.filter((row) => row.representativeSampled === true).length,
      populationTrades: reportRows.reduce((total, row) => total + (row.representativePopulationTrades ?? row.trades), 0),
      selectedTrades: reportRows.reduce((total, row) => total + (row.representativeSampleTrades ?? row.trades), 0),
    },
  };
};

export type CopyTradeSummary = {
  traders: number;
  trades: number;
  historyDays: number;
  verifiedPercent: number | null;
  lastRunAt: string | null;
};

export const readCopyTradeSummary = (database: DatabaseSync, options: { chain?: string } = {}): CopyTradeSummary => {
  const chain = options.chain ?? 'sol';
  const stats = database.prepare(
    `SELECT COUNT(*) AS trades, COUNT(DISTINCT wallet_address) AS traders,
            MIN(observed_timestamp) AS first, MAX(observed_timestamp) AS last
     FROM copytrade_trades WHERE chain = ?`,
  ).get(chain) as { trades: number; traders: number; first: number | null; last: number | null };

  const lastRun = database.prepare(
    `SELECT COALESCE(completed_at, started_at) AS at FROM copytrade_fetch_runs ORDER BY id DESC LIMIT 1`,
  ).get() as { at: string | null } | undefined;

  return {
    traders: stats.traders,
    trades: stats.trades,
    historyDays: stats.first !== null && stats.last !== null ? Math.max(0, Math.round((stats.last - stats.first) / 86_400)) : 0,
    // Dune cross-verification is a later step; null means "not measured", never "0% verified".
    verifiedPercent: null,
    lastRunAt: lastRun?.at ?? null,
  };
};

export const saveCopyTradeSnapshot = (
  database: DatabaseSync,
  report: CopyTradeReport,
): { snapshotId: number; computedAt: string } => {
  database.prepare(
    `INSERT INTO copytrade_result_snapshots (computed_at, params_json, report_json) VALUES (?, ?, ?)`,
  ).run(
    report.computedAt,
    // Params are read off the report itself, never recomputed from defaults. The snapshot
    // endpoint previously called computeCopyTradeReport() with no arguments, so a snapshot
    // saved while viewing "top 25, 7 days" silently froze "all traders, 30 days" instead.
    JSON.stringify({
      periodDays: report.periodDays,
      startingCapitalUsd: report.startingCapitalUsd,
      rules: report.rules,
      ...report.scope,
    }),
    JSON.stringify(report),
  );
  const row = database.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number };
  return { snapshotId: Number(row.id), computedAt: report.computedAt };
};
