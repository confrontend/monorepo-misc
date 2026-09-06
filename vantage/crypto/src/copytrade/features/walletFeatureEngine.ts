import {
  canonicalizeActivityType,
  TransferAwareInventory,
} from '../accounting/transferInventory.js';

export type WalletFeatureTrade = {
  id: number;
  eventType: string;
  tokenAddress: string;
  observedTimestamp: number;
  costUsd: string | null;
  buyCostUsd: string | null;
  tokenAmount?: string | null;
  launchpadPlatform?: string | null;
};

export type PreEventFeatures = {
  priorWalletTradeCount: number;
  priorTokenTradeCount: number;
  priorWalletBuyVolumeUsd: number;
  priorWalletBuyCount: number;
  priorWalletSellCount: number;
  priorWalletSellVolumeUsd: number;
  priorWalletRealizedProfitUsd: number | null;
  priorWalletMedianReturnPercent: number | null;
  priorWalletWinRatePercent: number | null;
  priorWalletPositiveDayPercent: number | null;
  priorWalletBestTokenProfitSharePercent: number | null;
  priorWalletMedianHoldSeconds: number | null;
  priorWalletUnder15SecondsPercent: number | null;
  priorWalletPairedTradeCount: number;
  priorWalletDistinctTokenCount: number;
  priorWalletTradesPerActiveDay: number | null;
  priorWalletMedianBuySizeUsd: number | null;
  priorWalletReturnVolatilityPercent: number | null;
  priorWalletTop3TokenProfitSharePercent: number | null;
  priorTokenBuyCount: number;
  priorTokenSellCount: number;
  priorTokenBuyVolumeUsd: number;
  priorTokenSellVolumeUsd: number;
  tokenMarketCapAtEntry: number | null;
  tokenAgeSecondsAtEntry: number | null;
  tokenLaunchpadPlatform: string | null;
  entryTradeAmountUsd: number | null;
};

/** The wallet-only subset is valid without a specific token-entry event. */
export type CurrentWalletFeatures = Pick<
  PreEventFeatures,
  | 'priorWalletTradeCount'
  | 'priorWalletBuyVolumeUsd'
  | 'priorWalletBuyCount'
  | 'priorWalletSellCount'
  | 'priorWalletSellVolumeUsd'
  | 'priorWalletRealizedProfitUsd'
  | 'priorWalletMedianReturnPercent'
  | 'priorWalletWinRatePercent'
  | 'priorWalletPositiveDayPercent'
  | 'priorWalletBestTokenProfitSharePercent'
  | 'priorWalletMedianHoldSeconds'
  | 'priorWalletUnder15SecondsPercent'
  | 'priorWalletPairedTradeCount'
  | 'priorWalletDistinctTokenCount'
  | 'priorWalletTradesPerActiveDay'
  | 'priorWalletMedianBuySizeUsd'
  | 'priorWalletReturnVolatilityPercent'
  | 'priorWalletTop3TokenProfitSharePercent'
>;

export type WalletDecisionCompatibilityMetrics = {
  completedTrades: number;
  sellCount: number;
  excludedNoCostBasis: number;
  medianReturnPercent: number | null;
  winRatePercent: number | null;
  positivePeriodCount: number;
  periodCount: number;
  excludingBestTokenMedianReturnPercent: number | null;
  bestTokenProfitSharePercent: number | null;
  top3TokenProfitSharePercent: number | null;
  medianHoldSeconds: number | null;
  under15SecondsPercent: number | null;
  under60SecondsPercent: number | null;
  noCostBasisPercent: number | null;
};

const numericAmount = (value: string | null): number | null => {
  if (value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

class NumberHeap {
  private readonly values: number[] = [];

  constructor(private readonly before: (left: number, right: number) => boolean) {}

  get size(): number {
    return this.values.length;
  }

  peek(): number | undefined {
    return this.values[0];
  }

  push(value: number): void {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.before(this.values[index], this.values[parent])) break;
      [this.values[index], this.values[parent]] = [this.values[parent], this.values[index]];
      index = parent;
    }
  }

  pop(): number | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (this.values.length > 0 && last !== undefined) {
      this.values[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let next = index;
        if (left < this.values.length && this.before(this.values[left], this.values[next]))
          next = left;
        if (right < this.values.length && this.before(this.values[right], this.values[next]))
          next = right;
        if (next === index) break;
        [this.values[index], this.values[next]] = [this.values[next], this.values[index]];
        index = next;
      }
    }
    return first;
  }
}

class StreamingMedian {
  private readonly lower = new NumberHeap((left, right) => left > right);
  private readonly upper = new NumberHeap((left, right) => left < right);

  add(value: number): void {
    if (this.lower.size === 0 || value <= (this.lower.peek() ?? value)) this.lower.push(value);
    else this.upper.push(value);
    if (this.lower.size > this.upper.size + 1) this.upper.push(this.lower.pop()!);
    if (this.upper.size > this.lower.size) this.lower.push(this.upper.pop()!);
  }

  value(): number | null {
    if (this.lower.size === 0) return null;
    return this.lower.size === this.upper.size
      ? ((this.lower.peek() ?? 0) + (this.upper.peek() ?? 0)) / 2
      : (this.lower.peek() ?? null);
  }
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? null);
};

const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

type ReturnObservation = {
  timestamp: number;
  tokenAddress: string;
  profitUsd: number;
  returnPercent: number;
};

/**
 * Canonical ordered GMGN activity accumulator.
 *
 * Sell returns still use cost_usd/buy_cost_usd, but only when the shared inventory resolver
 * proves a purchase and finds no unresolved transfer-in inventory. Hold time retains the latest
 * prior-buy approximation for compatible metrics.
 */
export class WalletFeatureAccumulator {
  private tradeCount = 0;
  private buyCount = 0;
  private sellCount = 0;
  private buyVolume = 0;
  private sellVolume = 0;
  private realizedProfit = 0;
  private returnCount = 0;
  private winningReturns = 0;
  private positiveDays = 0;
  private positiveTokenProfit = 0;
  private pairedTradeCount = 0;
  private under15Seconds = 0;
  private excludedReturnCount = 0;
  private readonly activeDays = new Set<string>();
  private readonly buySizeMedian = new StreamingMedian();
  private readonly returns: number[] = [];
  private readonly returnObservations: ReturnObservation[] = [];
  private readonly holds: number[] = [];
  private readonly tokenBuyCount = new Map<string, number>();
  private readonly tokenSellCount = new Map<string, number>();
  private readonly tokenBuyVolume = new Map<string, number>();
  private readonly tokenSellVolume = new Map<string, number>();
  private readonly tokenTradeCount = new Map<string, number>();
  private readonly lastBuyByToken = new Map<string, number>();
  private readonly profitByToken = new Map<string, number>();
  private readonly profitByDay = new Map<string, number>();
  private readonly returnMedian = new StreamingMedian();
  private readonly holdMedian = new StreamingMedian();
  private readonly inventory = new TransferAwareInventory();

  /** Seed only state needed to pair an in-window sell without counting older activity. */
  applyPreWindowContext(row: WalletFeatureTrade): void {
    this.inventory.apply({
      id: row.id,
      eventType: row.eventType,
      tokenAddress: row.tokenAddress,
      observedTimestamp: row.observedTimestamp,
      tokenAmount: row.tokenAmount ?? null,
      costUsd: row.costUsd,
      buyCostUsd: row.buyCostUsd,
    });
    if (canonicalizeActivityType(row.eventType) === 'buy') {
      this.lastBuyByToken.set(row.tokenAddress, row.observedTimestamp);
    }
  }

  apply(row: WalletFeatureTrade): void {
    const canonicalType = canonicalizeActivityType(row.eventType);
    const resolved = this.inventory.apply({
      id: row.id,
      eventType: row.eventType,
      tokenAddress: row.tokenAddress,
      observedTimestamp: row.observedTimestamp,
      tokenAmount: row.tokenAmount ?? null,
      costUsd: row.costUsd,
      buyCostUsd: row.buyCostUsd,
    });
    if (canonicalType !== 'buy' && canonicalType !== 'sell') return;
    this.tradeCount += 1;
    this.tokenTradeCount.set(
      row.tokenAddress,
      (this.tokenTradeCount.get(row.tokenAddress) ?? 0) + 1,
    );
    this.activeDays.add(new Date(row.observedTimestamp * 1000).toISOString().slice(0, 10));
    if (canonicalType === 'buy') {
      this.buyCount += 1;
      this.buyVolume += numericAmount(row.costUsd) ?? 0;
      this.tokenBuyCount.set(row.tokenAddress, (this.tokenBuyCount.get(row.tokenAddress) ?? 0) + 1);
      this.tokenBuyVolume.set(
        row.tokenAddress,
        (this.tokenBuyVolume.get(row.tokenAddress) ?? 0) + (numericAmount(row.costUsd) ?? 0),
      );
      const buySize = numericAmount(row.costUsd);
      if (buySize !== null) this.buySizeMedian.add(buySize);
      this.lastBuyByToken.set(row.tokenAddress, row.observedTimestamp);
      return;
    }

    this.sellCount += 1;
    this.sellVolume += numericAmount(row.costUsd) ?? 0;
    this.tokenSellCount.set(row.tokenAddress, (this.tokenSellCount.get(row.tokenAddress) ?? 0) + 1);
    this.tokenSellVolume.set(
      row.tokenAddress,
      (this.tokenSellVolume.get(row.tokenAddress) ?? 0) + (numericAmount(row.costUsd) ?? 0),
    );
    const boughtAt = this.lastBuyByToken.get(row.tokenAddress);
    if (resolved?.eligible === true && boughtAt !== undefined) {
      const hold = Math.max(0, row.observedTimestamp - boughtAt);
      this.holdMedian.add(hold);
      this.holds.push(hold);
      this.pairedTradeCount += 1;
      if (hold <= 15) this.under15Seconds += 1;
    }

    const proceeds = numericAmount(row.costUsd);
    const costBasis = numericAmount(row.buyCostUsd);
    if (resolved?.eligible !== true || proceeds === null || costBasis === null || costBasis <= 0) {
      this.excludedReturnCount += 1;
      return;
    }
    const profitUsd = proceeds - costBasis;
    const returnPercent = (profitUsd / costBasis) * 100;
    this.realizedProfit += profitUsd;
    this.returnCount += 1;
    this.returns.push(returnPercent);
    this.returnObservations.push({
      timestamp: row.observedTimestamp,
      tokenAddress: row.tokenAddress,
      profitUsd,
      returnPercent,
    });
    if (returnPercent > 0) this.winningReturns += 1;
    this.returnMedian.add(returnPercent);

    const priorTokenProfit = this.profitByToken.get(row.tokenAddress) ?? 0;
    if (priorTokenProfit > 0) this.positiveTokenProfit -= priorTokenProfit;
    const tokenProfit = priorTokenProfit + profitUsd;
    this.profitByToken.set(row.tokenAddress, tokenProfit);
    if (tokenProfit > 0) this.positiveTokenProfit += tokenProfit;

    const day = new Date(row.observedTimestamp * 1000).toISOString().slice(0, 10);
    const priorDayProfit = this.profitByDay.get(day) ?? 0;
    if (priorDayProfit > 0) this.positiveDays -= 1;
    const dayProfit = priorDayProfit + profitUsd;
    this.profitByDay.set(day, dayProfit);
    if (dayProfit > 0) this.positiveDays += 1;
  }

  snapshot(tokenAddress: string, entry?: WalletFeatureTrade): PreEventFeatures {
    const positiveProfits = [...this.profitByToken.values()]
      .filter((profit) => profit > 0)
      .sort((left, right) => right - left);
    const bestTokenProfit = positiveProfits[0] ?? 0;
    const top3TokenProfit = positiveProfits.slice(0, 3).reduce((sum, profit) => sum + profit, 0);
    const meanReturn = this.returns.length
      ? this.returns.reduce((sum, value) => sum + value, 0) / this.returns.length
      : 0;
    const returnVariance =
      this.returns.length > 1
        ? this.returns.reduce((sum, value) => sum + (value - meanReturn) ** 2, 0) /
          this.returns.length
        : null;

    return {
      priorWalletTradeCount: this.tradeCount,
      priorTokenTradeCount: this.tokenTradeCount.get(tokenAddress) ?? 0,
      priorWalletBuyVolumeUsd: this.buyVolume,
      priorWalletBuyCount: this.buyCount,
      priorWalletSellCount: this.sellCount,
      priorWalletSellVolumeUsd: this.sellVolume,
      priorWalletRealizedProfitUsd: this.returnCount === 0 ? null : this.realizedProfit,
      priorWalletMedianReturnPercent: this.returnMedian.value(),
      priorWalletWinRatePercent:
        this.returnCount === 0 ? null : (this.winningReturns / this.returnCount) * 100,
      priorWalletPositiveDayPercent:
        this.profitByDay.size === 0 ? null : (this.positiveDays / this.profitByDay.size) * 100,
      priorWalletBestTokenProfitSharePercent:
        this.positiveTokenProfit <= 0 ? null : (bestTokenProfit / this.positiveTokenProfit) * 100,
      priorWalletMedianHoldSeconds: this.holdMedian.value(),
      priorWalletUnder15SecondsPercent:
        this.pairedTradeCount === 0 ? null : (this.under15Seconds / this.pairedTradeCount) * 100,
      priorWalletPairedTradeCount: this.pairedTradeCount,
      priorWalletDistinctTokenCount: this.tokenTradeCount.size,
      priorWalletTradesPerActiveDay:
        this.activeDays.size === 0 ? null : this.tradeCount / this.activeDays.size,
      priorWalletMedianBuySizeUsd: this.buySizeMedian.value(),
      priorWalletReturnVolatilityPercent:
        returnVariance === null ? null : Math.sqrt(returnVariance),
      priorWalletTop3TokenProfitSharePercent:
        this.positiveTokenProfit <= 0 ? null : (top3TokenProfit / this.positiveTokenProfit) * 100,
      priorTokenBuyCount: this.tokenBuyCount.get(tokenAddress) ?? 0,
      priorTokenSellCount: this.tokenSellCount.get(tokenAddress) ?? 0,
      priorTokenBuyVolumeUsd: this.tokenBuyVolume.get(tokenAddress) ?? 0,
      priorTokenSellVolumeUsd: this.tokenSellVolume.get(tokenAddress) ?? 0,
      tokenMarketCapAtEntry: null,
      tokenAgeSecondsAtEntry: null,
      tokenLaunchpadPlatform: entry?.launchpadPlatform ?? null,
      entryTradeAmountUsd: entry ? numericAmount(entry.costUsd) : null,
    };
  }

  /** Exact compatibility metrics used by the current GMGN-only Decision Lab formulas. */
  decisionCompatibilityMetrics(): WalletDecisionCompatibilityMetrics {
    const periodMedians: number[] = [];
    for (const period of ['week', 'month'] as const) {
      const groups = new Map<string, number[]>();
      for (const observation of this.returnObservations) {
        const date = new Date(observation.timestamp * 1000);
        let key: string;
        if (period === 'week') {
          const weekStart = new Date(date);
          const day = weekStart.getUTCDay() || 7;
          weekStart.setUTCDate(weekStart.getUTCDate() - day + 1);
          key = weekStart.toISOString().slice(0, 10);
        } else {
          key = date.toISOString().slice(0, 7);
        }
        const returns = groups.get(key) ?? [];
        returns.push(observation.returnPercent);
        groups.set(key, returns);
      }
      for (const returns of groups.values()) {
        const value = median(returns);
        if (value !== null) periodMedians.push(round(value, 2));
      }
    }

    const tokenProfit = new Map<string, number>();
    for (const observation of this.returnObservations) {
      tokenProfit.set(
        observation.tokenAddress,
        (tokenProfit.get(observation.tokenAddress) ?? 0) + observation.profitUsd,
      );
    }
    const tokens = [...tokenProfit]
      .map(([tokenAddress, profitUsd]) => ({ tokenAddress, profitUsd: round(profitUsd, 2) }))
      .sort(
        (left, right) =>
          right.profitUsd - left.profitUsd || left.tokenAddress.localeCompare(right.tokenAddress),
      );
    const positiveProfit = tokens.reduce((total, token) => total + Math.max(0, token.profitUsd), 0);
    const bestToken = tokens[0]?.tokenAddress ?? null;
    const excludingBestTokenReturns = this.returnObservations
      .filter((observation) => observation.tokenAddress !== bestToken)
      .map((observation) => observation.returnPercent);
    const share = (profitUsd: number): number | null =>
      positiveProfit <= 0 ? null : round((Math.max(0, profitUsd) / positiveProfit) * 100, 1);
    const bestProfit = tokens[0]?.profitUsd ?? 0;
    const top3Profit = tokens
      .slice(0, 3)
      .reduce((total, token) => total + Math.max(0, token.profitUsd), 0);
    const medianReturn = median(this.returns);
    const medianHold = median(this.holds);

    return {
      completedTrades: this.returnObservations.length,
      sellCount: this.sellCount,
      excludedNoCostBasis: this.excludedReturnCount,
      medianReturnPercent: medianReturn === null ? null : round(medianReturn, 2),
      winRatePercent:
        this.returnObservations.length === 0
          ? null
          : round((this.winningReturns / this.returnObservations.length) * 100, 1),
      positivePeriodCount: periodMedians.filter((value) => value > 0).length,
      periodCount: periodMedians.length,
      excludingBestTokenMedianReturnPercent:
        excludingBestTokenReturns.length === 0
          ? null
          : round(median(excludingBestTokenReturns) ?? 0, 2),
      bestTokenProfitSharePercent: bestToken === null ? null : share(bestProfit),
      top3TokenProfitSharePercent: share(top3Profit),
      medianHoldSeconds: medianHold === null ? null : Math.round(medianHold),
      under15SecondsPercent:
        this.holds.length === 0
          ? null
          : round(
              (this.holds.filter((seconds) => seconds <= 15).length / this.holds.length) * 100,
              1,
            ),
      under60SecondsPercent:
        this.holds.length === 0
          ? null
          : round(
              (this.holds.filter((seconds) => seconds <= 60).length / this.holds.length) * 100,
              1,
            ),
      noCostBasisPercent:
        this.sellCount === 0 ? null : round((this.excludedReturnCount / this.sellCount) * 100, 1),
    };
  }
}

export const currentWalletFeaturesFromSnapshot = (
  snapshot: PreEventFeatures,
): CurrentWalletFeatures => {
  const {
    priorWalletTradeCount,
    priorWalletBuyVolumeUsd,
    priorWalletBuyCount,
    priorWalletSellCount,
    priorWalletSellVolumeUsd,
    priorWalletRealizedProfitUsd,
    priorWalletMedianReturnPercent,
    priorWalletWinRatePercent,
    priorWalletPositiveDayPercent,
    priorWalletBestTokenProfitSharePercent,
    priorWalletMedianHoldSeconds,
    priorWalletUnder15SecondsPercent,
    priorWalletPairedTradeCount,
    priorWalletDistinctTokenCount,
    priorWalletTradesPerActiveDay,
    priorWalletMedianBuySizeUsd,
    priorWalletReturnVolatilityPercent,
    priorWalletTop3TokenProfitSharePercent,
  } = snapshot;
  return {
    priorWalletTradeCount,
    priorWalletBuyVolumeUsd,
    priorWalletBuyCount,
    priorWalletSellCount,
    priorWalletSellVolumeUsd,
    priorWalletRealizedProfitUsd,
    priorWalletMedianReturnPercent,
    priorWalletWinRatePercent,
    priorWalletPositiveDayPercent,
    priorWalletBestTokenProfitSharePercent,
    priorWalletMedianHoldSeconds,
    priorWalletUnder15SecondsPercent,
    priorWalletPairedTradeCount,
    priorWalletDistinctTokenCount,
    priorWalletTradesPerActiveDay,
    priorWalletMedianBuySizeUsd,
    priorWalletReturnVolatilityPercent,
    priorWalletTop3TokenProfitSharePercent,
  };
};

/** Stable persisted feature identifiers mapped to a standing wallet snapshot. */
export const currentWalletFeatureValueMap = (
  features: CurrentWalletFeatures,
): Record<string, number | null> => ({
  prior_wallet_trade_count: features.priorWalletTradeCount,
  prior_wallet_buy_volume_usd: features.priorWalletBuyVolumeUsd,
  prior_wallet_buy_count: features.priorWalletBuyCount,
  prior_wallet_sell_count: features.priorWalletSellCount,
  prior_wallet_sell_volume_usd: features.priorWalletSellVolumeUsd,
  prior_wallet_realized_profit_usd: features.priorWalletRealizedProfitUsd,
  prior_wallet_median_return_percent: features.priorWalletMedianReturnPercent,
  prior_wallet_win_rate_percent: features.priorWalletWinRatePercent,
  prior_wallet_positive_day_percent: features.priorWalletPositiveDayPercent,
  prior_wallet_best_token_profit_share_percent: features.priorWalletBestTokenProfitSharePercent,
  prior_wallet_median_hold_seconds: features.priorWalletMedianHoldSeconds,
  prior_wallet_under_15_seconds_percent: features.priorWalletUnder15SecondsPercent,
  prior_wallet_paired_trade_count: features.priorWalletPairedTradeCount,
  prior_wallet_distinct_token_count: features.priorWalletDistinctTokenCount,
  prior_wallet_trades_per_active_day: features.priorWalletTradesPerActiveDay,
  prior_wallet_median_buy_size_usd: features.priorWalletMedianBuySizeUsd,
  prior_wallet_return_volatility_percent: features.priorWalletReturnVolatilityPercent,
  prior_wallet_top3_token_profit_share_percent: features.priorWalletTop3TokenProfitSharePercent,
});
