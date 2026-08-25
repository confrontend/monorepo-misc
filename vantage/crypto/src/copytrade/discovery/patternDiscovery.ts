import type { DatabaseSync } from 'node:sqlite';
import { CACHE_VERSIONS, versionedCacheKey } from '../../platform/cache/cacheVersions.js';
import {
  computeCopySimulationReport,
  type CopySimulationTradeResult,
  type CopySimulationWalletReport,
} from '../simulation/copySimulation.js';

export const DEFAULT_PATTERN_DISCOVERY_PERIOD_DAYS = 30;
export const MAX_PATTERN_DISCOVERY_PERIOD_DAYS = 90;
export const MAX_PATTERN_DISCOVERY_WALLETS = 500;
/** @deprecated Use CACHE_VERSIONS.patternDiscovery for new cache consumers. */
export const PATTERN_DISCOVERY_ENGINE_VERSION = CACHE_VERSIONS.patternDiscovery;

export type PatternDiscoveryExportRow = {
  project: 'crypto';
  event_id: string;
  event_time: string;
  entity_id: string;
  signal_type: 'gmgn_copy_round_trip';
  independence_group: string;
  wallet_address: string;
  token_address: string;
  token_symbol: string | null;
  features: {
    wallet_address: string;
    token_symbol: string | null;
    token_address: string;
    chain: 'sol';
    signal_type: 'gmgn_copy_round_trip';
    prior_wallet_trade_count: number;
    prior_token_trade_count: number;
    prior_wallet_buy_volume_usd: number;
    prior_wallet_buy_count: number;
    prior_wallet_sell_count: number;
    prior_wallet_sell_volume_usd: number;
    prior_wallet_realized_profit_usd: number | null;
    prior_wallet_median_return_percent: number | null;
    prior_wallet_win_rate_percent: number | null;
    prior_wallet_positive_day_percent: number | null;
    prior_wallet_best_token_profit_share_percent: number | null;
    prior_wallet_median_hold_seconds: number | null;
    prior_wallet_under_15_seconds_percent: number | null;
    prior_wallet_paired_trade_count: number;
    prior_wallet_distinct_token_count: number;
    prior_wallet_trades_per_active_day: number | null;
    prior_wallet_median_buy_size_usd: number | null;
    prior_wallet_return_volatility_percent: number | null;
    prior_wallet_top3_token_profit_share_percent: number | null;
    prior_token_buy_count: number;
    prior_token_sell_count: number;
    prior_token_buy_volume_usd: number;
    prior_token_sell_volume_usd: number;
    token_market_cap_at_entry: number | null;
    token_age_seconds_at_entry: number | null;
    token_launchpad_platform: string | null;
    entry_trade_amount_usd: number | null;
  };
  hold_seconds: number;
  wallet_return_percent: number | null;
  entry_trade_amount_usd: number | null;
  exit_trade_amount_usd: number | null;
  edge_kept_percent: number | null;
  entry_gap_seconds: number | null;
  exit_gap_seconds: number | null;
  gas_fee_usd: number | null;
  outcome_at: string;
  outcome_horizon: string;
  benchmark_return: number | null;
  excess_return: number | null;
  net_return_after_costs: number;
  mature: true;
  usable: true;
  coverage_rate_percent: number;
  coverage_status: 'fully_covered' | 'partially_covered';
  entry_id: string;
  exit_count: number;
};

export type PatternDiscoveryExport = {
  metadata: {
    project: 'crypto';
    schema_version: 'normalized-v1';
    feature_allowlist_version: 'gmgn-v4-historical-context';
    feature_source: 'features';
    feature_policy: string;
    outcome: 'net_return_after_costs';
    outcome_horizon: string;
    period_days: number;
    coverage_scope: 'outcome_minimum_percent';
    minimum_coverage_percent: number;
    coverage_semantics: string;
    selection_rule: string;
    source_access: 'crypto_adapter_read_only_sqlite';
    shared_engine_database_opened: false;
    selected_wallet_count: number;
    exported_rows: number;
    eligible_wallets_before_threshold: number;
    excluded_wallets_below_threshold: number;
    coverage_distribution_percent: number[];
    aggregation: 'one_row_per_buy_entry_all_exits_usable';
    independent_entry_count: number;
    exit_rows_collapsed: number;
    wallet_balanced_validation: string;
    export_generated_at: string;
  };
  rows: PatternDiscoveryExportRow[];
};

type FullyCoveredWallet = { walletAddress: string };

type PatternDiscoveryCacheRow = { reportJson: string };

/** Return an exact, constant-size evidence revision. Write triggers mark the revision dirty;
 * the first reader after a change advances it once. This replaces serializing and hashing the
 * multi-gigabyte trade/Dune tables on every coverage level. */
export const readPatternDiscoveryDataFingerprint = (database: DatabaseSync): string => {
  database
    .prepare(
      `UPDATE pattern_discovery_data_revision
       SET revision = revision + 1, dirty = 0, updated_at = CURRENT_TIMESTAMP
       WHERE singleton_id = 1 AND dirty = 1`,
    )
    .run();
  const row = database
    .prepare(`SELECT revision FROM pattern_discovery_data_revision WHERE singleton_id = 1`)
    .get() as { revision: number } | undefined;
  if (!row) throw new Error('Pattern Discovery data revision is unavailable.');
  return `pattern-discovery-revision-v1:${row.revision}`;
};

export const patternDiscoveryCacheKey = (
  kind: 'export' | 'report' | 'sensitivity',
  periodDays: number,
  minimumCoveragePercent: number,
  minN?: number,
  limit = MAX_PATTERN_DISCOVERY_WALLETS,
): string =>
  versionedCacheKey(
    'patternDiscovery',
    kind,
    periodDays,
    minimumCoveragePercent,
    minN ?? '',
    limit,
  );

export const readPatternDiscoveryCache = <T>(
  database: DatabaseSync,
  cacheKey: string,
  dataFingerprint: string,
): T | null => {
  const row = database
    .prepare(
      `SELECT report_json AS reportJson
     FROM copytrade_report_cache
     WHERE cache_key = ? AND data_fingerprint = ?`,
    )
    .get(cacheKey, dataFingerprint) as PatternDiscoveryCacheRow | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.reportJson) as T;
  } catch {
    return null;
  }
};

export const writePatternDiscoveryCache = (
  database: DatabaseSync,
  cacheKey: string,
  dataFingerprint: string,
  value: unknown,
): void => {
  database
    .prepare(
      `INSERT INTO copytrade_report_cache (cache_key, data_fingerprint, report_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       data_fingerprint = excluded.data_fingerprint,
       report_json = excluded.report_json,
       updated_at = excluded.updated_at`,
    )
    .run(cacheKey, dataFingerprint, JSON.stringify(value), new Date().toISOString());
};

const validatePeriodDays = (periodDays: number): number => {
  if (
    !Number.isInteger(periodDays) ||
    periodDays <= 0 ||
    periodDays > MAX_PATTERN_DISCOVERY_PERIOD_DAYS
  ) {
    throw new RangeError(
      `periodDays must be an integer between 1 and ${MAX_PATTERN_DISCOVERY_PERIOD_DAYS}.`,
    );
  }
  return periodDays;
};

const validateWalletLimit = (limit: number): number => {
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_PATTERN_DISCOVERY_WALLETS) {
    throw new RangeError(
      `limit must be an integer between 1 and ${MAX_PATTERN_DISCOVERY_WALLETS}.`,
    );
  }
  return limit;
};

const validateCoveragePercent = (coveragePercent: number): number => {
  if (!Number.isInteger(coveragePercent) || coveragePercent < 50 || coveragePercent > 100) {
    throw new RangeError('minimumCoveragePercent must be an integer between 50 and 100.');
  }
  return coveragePercent;
};

type PreEventFeatures = {
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

type PriorTrade = {
  id: number;
  eventType: string;
  tokenAddress: string;
  observedTimestamp: number;
  costUsd: string | null;
  buyCostUsd: string | null;
  launchpadPlatform?: string | null;
};

const amount = (value: string | null): number | null => {
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

class PreEventAccumulator {
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
  private readonly activeDays = new Set<string>();
  private readonly buySizeMedian = new StreamingMedian();
  private readonly returns: number[] = [];
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

  apply(row: PriorTrade): void {
    this.tradeCount += 1;
    this.tokenTradeCount.set(
      row.tokenAddress,
      (this.tokenTradeCount.get(row.tokenAddress) ?? 0) + 1,
    );
    this.activeDays.add(new Date(row.observedTimestamp * 1000).toISOString().slice(0, 10));
    if (row.eventType === 'buy') {
      this.buyCount += 1;
      this.buyVolume += amount(row.costUsd) ?? 0;
      this.tokenBuyCount.set(row.tokenAddress, (this.tokenBuyCount.get(row.tokenAddress) ?? 0) + 1);
      this.tokenBuyVolume.set(
        row.tokenAddress,
        (this.tokenBuyVolume.get(row.tokenAddress) ?? 0) + (amount(row.costUsd) ?? 0),
      );
      const buySize = amount(row.costUsd);
      if (buySize !== null) this.buySizeMedian.add(buySize);
      this.lastBuyByToken.set(row.tokenAddress, row.observedTimestamp);
      return;
    }
    this.sellCount += 1;
    this.sellVolume += amount(row.costUsd) ?? 0;
    this.tokenSellCount.set(row.tokenAddress, (this.tokenSellCount.get(row.tokenAddress) ?? 0) + 1);
    this.tokenSellVolume.set(
      row.tokenAddress,
      (this.tokenSellVolume.get(row.tokenAddress) ?? 0) + (amount(row.costUsd) ?? 0),
    );
    const boughtAt = this.lastBuyByToken.get(row.tokenAddress);
    if (boughtAt !== undefined) {
      const hold = Math.max(0, row.observedTimestamp - boughtAt);
      this.holdMedian.add(hold);
      this.pairedTradeCount += 1;
      if (hold <= 15) this.under15Seconds += 1;
    }
    const proceeds = amount(row.costUsd);
    const costBasis = amount(row.buyCostUsd);
    if (proceeds === null || costBasis === null || costBasis <= 0) return;
    const profitUsd = proceeds - costBasis;
    const returnPercent = (profitUsd / costBasis) * 100;
    this.realizedProfit += profitUsd;
    this.returnCount += 1;
    this.returns.push(returnPercent);
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

  snapshot(tokenAddress: string, entry?: PriorTrade): PreEventFeatures {
    const positiveProfits = [...this.profitByToken.values()]
      .filter((profit) => profit > 0)
      .sort((a, b) => b - a);
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
      entryTradeAmountUsd: entry ? amount(entry.costUsd) : null,
    };
  }
}

const addTokenEntryContext = (
  database: DatabaseSync,
  features: PreEventFeatures,
  tokenAddress: string,
  observedTimestamp: number,
): PreEventFeatures => {
  const signal = database
    .prepare(
      `SELECT COALESCE(trigger_mc, first_trigger_mc, market_cap) AS marketCap
       FROM gmgn_signals
       WHERE token_address = ? AND observed_at IS NOT NULL AND observed_at < ?
       ORDER BY observed_at DESC, id DESC LIMIT 1`,
    )
    .get(tokenAddress, new Date(observedTimestamp * 1000).toISOString()) as
    { marketCap: number | null } | undefined;
  const token = database
    .prepare(`SELECT first_trade_time AS firstTradeTime FROM tokens WHERE token_address = ?`)
    .get(tokenAddress) as { firstTradeTime: string | null } | undefined;
  const firstTradeSeconds = token?.firstTradeTime
    ? Math.floor(Date.parse(token.firstTradeTime) / 1000)
    : NaN;
  return {
    ...features,
    tokenMarketCapAtEntry: signal?.marketCap ?? null,
    tokenAgeSecondsAtEntry: Number.isFinite(firstTradeSeconds)
      ? Math.max(0, observedTimestamp - firstTradeSeconds)
      : null,
  };
};

/** Build aggregates using only rows strictly before the wallet buy, including id as a
 * deterministic tie-breaker when multiple trades share the same observed second. */
export const readPreEventFeatures = (
  database: DatabaseSync,
  walletAddress: string,
  tokenAddress: string,
  buyAt: string,
  buyTradeId: number,
): PreEventFeatures => {
  const observedTimestamp = Math.floor(Date.parse(buyAt) / 1000);
  if (!Number.isFinite(observedTimestamp))
    throw new Error(`Invalid buy timestamp for pattern discovery: ${buyAt}`);
  const rows = database
    .prepare(
      `SELECT id, event_type AS eventType, token_address AS tokenAddress,
            observed_timestamp AS observedTimestamp, cost_usd AS costUsd, buy_cost_usd AS buyCostUsd
     FROM copytrade_trades
     WHERE chain = 'sol' AND wallet_address = ? AND event_type IN ('buy', 'sell')
       AND (observed_timestamp < ? OR (observed_timestamp = ? AND id < ?))
     ORDER BY observed_timestamp ASC, id ASC`,
    )
    .all(
      walletAddress,
      observedTimestamp,
      observedTimestamp,
      buyTradeId,
    ) as unknown as PriorTrade[];
  const accumulator = new PreEventAccumulator();
  for (const row of rows) accumulator.apply(row);
  const entry = database
    .prepare(
      `SELECT cost_usd AS costUsd, launchpad_platform AS launchpadPlatform FROM copytrade_trades WHERE id = ?`,
    )
    .get(buyTradeId) as { costUsd: string | null; launchpadPlatform: string | null } | undefined;
  return addTokenEntryContext(
    database,
    accumulator.snapshot(
      tokenAddress,
      entry
        ? {
            ...entry,
            id: buyTradeId,
            eventType: 'buy',
            tokenAddress,
            observedTimestamp,
            buyCostUsd: null,
          }
        : undefined,
    ),
    tokenAddress,
    observedTimestamp,
  );
};

const fullyCoveredWalletAddresses = (
  database: DatabaseSync,
  periodDays: number,
  limit: number,
): string[] => {
  const rows = database
    .prepare(
      `SELECT wallet_address AS walletAddress
     FROM copytrade_wallet_coverage
     WHERE chain = 'sol'
       AND coverage_complete = 1
       AND truncated = 0
       AND requested_period_days = ?
     ORDER BY updated_at DESC, wallet_address ASC
     LIMIT ?`,
    )
    .all(periodDays, limit) as unknown as FullyCoveredWallet[];
  return rows.map((row) => row.walletAddress);
};

type AggregatedEntry = {
  buyTradeId: number;
  trades: CopySimulationTradeResult[];
};

const aggregateEntry = (trades: CopySimulationTradeResult[]): AggregatedEntry => {
  const first = trades[0];
  if (first?.buyTradeId === undefined)
    throw new Error('Pattern discovery entry is missing its source buy id.');
  return { buyTradeId: first.buyTradeId, trades };
};

const aggregateEntries = (trades: CopySimulationTradeResult[]): AggregatedEntry[] => {
  const groups = new Map<number, CopySimulationTradeResult[]>();
  for (const trade of trades) {
    if (trade.buyTradeId === undefined) continue;
    const group = groups.get(trade.buyTradeId) ?? [];
    group.push(trade);
    groups.set(trade.buyTradeId, group);
  }
  return [...groups.values()]
    .filter(
      (group) =>
        group.length > 0 &&
        group.every(
          (trade) =>
            trade.status === 'simulated' &&
            trade.simulatedReturnPercent !== null &&
            trade.buyAt &&
            trade.sellAt,
        ),
    )
    .map(aggregateEntry);
};

type PatternDiscoveryEntry = {
  wallet: CopySimulationWalletReport;
  entry: AggregatedEntry;
};

const readPreEventFeatureSnapshots = (
  database: DatabaseSync,
  entries: PatternDiscoveryEntry[],
  onWallet?: (completed: number, total: number, walletAddress: string) => void,
): Map<number, PreEventFeatures> => {
  const entriesByWallet = new Map<string, PatternDiscoveryEntry[]>();
  for (const item of entries) {
    const group = entriesByWallet.get(item.wallet.walletAddress) ?? [];
    group.push(item);
    entriesByWallet.set(item.wallet.walletAddress, group);
  }
  const snapshots = new Map<number, PreEventFeatures>();
  const wallets = [...entriesByWallet.entries()];
  for (let walletIndex = 0; walletIndex < wallets.length; walletIndex += 1) {
    const [walletAddress, walletEntries] = wallets[walletIndex];
    const requested = new Map(
      walletEntries.map((item) => [
        item.entry.buyTradeId,
        item.entry.trades[0]?.tokenAddress ?? '',
      ]),
    );
    const rows = database
      .prepare(
        `SELECT id, event_type AS eventType, token_address AS tokenAddress,
                observed_timestamp AS observedTimestamp, cost_usd AS costUsd,
                buy_cost_usd AS buyCostUsd, launchpad_platform AS launchpadPlatform
         FROM copytrade_trades
         WHERE chain = 'sol' AND wallet_address = ? AND event_type IN ('buy', 'sell')
         ORDER BY observed_timestamp ASC, id ASC`,
      )
      .all(walletAddress) as unknown as PriorTrade[];
    const accumulator = new PreEventAccumulator();
    for (const row of rows) {
      const tokenAddress = requested.get(row.id);
      if (tokenAddress !== undefined) {
        snapshots.set(
          row.id,
          addTokenEntryContext(
            database,
            accumulator.snapshot(tokenAddress, row),
            tokenAddress,
            row.observedTimestamp,
          ),
        );
      }
      accumulator.apply(row);
    }
    for (const item of walletEntries) {
      if (!snapshots.has(item.entry.buyTradeId)) {
        const trade = item.entry.trades[0];
        if (!trade?.buyAt) throw new Error('Pattern Discovery entry is missing its buy time.');
        snapshots.set(
          item.entry.buyTradeId,
          readPreEventFeatures(
            database,
            walletAddress,
            trade.tokenAddress,
            trade.buyAt,
            item.entry.buyTradeId,
          ),
        );
      }
    }
    onWallet?.(walletIndex + 1, wallets.length, walletAddress);
  }
  return snapshots;
};

const normalizedRow = (
  wallet: CopySimulationWalletReport,
  entry: AggregatedEntry,
  periodDays: number,
  prior: PreEventFeatures,
): PatternDiscoveryExportRow => {
  const trade = entry.trades[0];
  if (
    trade.status !== 'simulated' ||
    trade.simulatedReturnPercent === null ||
    !trade.buyAt ||
    !trade.sellAt
  ) {
    throw new Error(
      `Fully covered wallet ${wallet.walletAddress} contained a non-simulated or incomplete round trip.`,
    );
  }
  const stake =
    entry.trades.reduce((sum, item) => sum + (item.copyStakeUsd ?? 0), 0) || entry.trades.length;
  const simulatedPnl = entry.trades.reduce(
    (sum, item) => sum + ((item.copyStakeUsd ?? 1) * (item.simulatedReturnPercent ?? 0)) / 100,
    0,
  );
  const walletPnl = entry.trades.reduce(
    (sum, item) => sum + ((item.copyStakeUsd ?? 1) * (item.walletReturnPercent ?? 0)) / 100,
    0,
  );
  const simulatedReturnPercent = (simulatedPnl / stake) * 100;
  const walletReturnPercent = entry.trades.every((item) => item.walletReturnPercent !== null)
    ? (walletPnl / stake) * 100
    : null;
  const lastTrade = entry.trades[entry.trades.length - 1];
  const exitTradeAmountUsd =
    entry.trades.reduce((sum, item) => sum + (item.exitTradeAmountUsd ?? 0), 0) || null;
  const gasFeeUsd = entry.trades.every(
    (item) => item.gasFeeUsd !== null && item.gasFeeUsd !== undefined,
  )
    ? entry.trades.reduce((sum, item) => sum + (item.gasFeeUsd ?? 0), 0)
    : null;
  return {
    project: 'crypto',
    event_id: `gmgn-copy-entry:${wallet.walletAddress}:${entry.buyTradeId}:${trade.buyAt}:${trade.tokenAddress}`,
    event_time: trade.buyAt,
    entity_id: trade.tokenAddress,
    signal_type: 'gmgn_copy_round_trip',
    independence_group: `${wallet.walletAddress}:entry:${entry.buyTradeId}`,
    wallet_address: wallet.walletAddress,
    token_address: trade.tokenAddress,
    token_symbol: trade.tokenSymbol,
    features: {
      wallet_address: wallet.walletAddress,
      token_symbol: trade.tokenSymbol,
      token_address: trade.tokenAddress,
      chain: 'sol',
      signal_type: 'gmgn_copy_round_trip',
      prior_wallet_trade_count: prior.priorWalletTradeCount,
      prior_token_trade_count: prior.priorTokenTradeCount,
      prior_wallet_buy_volume_usd: prior.priorWalletBuyVolumeUsd,
      prior_wallet_buy_count: prior.priorWalletBuyCount,
      prior_wallet_sell_count: prior.priorWalletSellCount,
      prior_wallet_sell_volume_usd: prior.priorWalletSellVolumeUsd,
      prior_wallet_realized_profit_usd: prior.priorWalletRealizedProfitUsd,
      prior_wallet_median_return_percent: prior.priorWalletMedianReturnPercent,
      prior_wallet_win_rate_percent: prior.priorWalletWinRatePercent,
      prior_wallet_positive_day_percent: prior.priorWalletPositiveDayPercent,
      prior_wallet_best_token_profit_share_percent: prior.priorWalletBestTokenProfitSharePercent,
      prior_wallet_median_hold_seconds: prior.priorWalletMedianHoldSeconds,
      prior_wallet_under_15_seconds_percent: prior.priorWalletUnder15SecondsPercent,
      prior_wallet_paired_trade_count: prior.priorWalletPairedTradeCount,
      prior_wallet_distinct_token_count: prior.priorWalletDistinctTokenCount,
      prior_wallet_trades_per_active_day: prior.priorWalletTradesPerActiveDay,
      prior_wallet_median_buy_size_usd: prior.priorWalletMedianBuySizeUsd,
      prior_wallet_return_volatility_percent: prior.priorWalletReturnVolatilityPercent,
      prior_wallet_top3_token_profit_share_percent: prior.priorWalletTop3TokenProfitSharePercent,
      prior_token_buy_count: prior.priorTokenBuyCount,
      prior_token_sell_count: prior.priorTokenSellCount,
      prior_token_buy_volume_usd: prior.priorTokenBuyVolumeUsd,
      prior_token_sell_volume_usd: prior.priorTokenSellVolumeUsd,
      token_market_cap_at_entry: prior.tokenMarketCapAtEntry,
      token_age_seconds_at_entry: prior.tokenAgeSecondsAtEntry,
      token_launchpad_platform: prior.tokenLaunchpadPlatform,
      entry_trade_amount_usd: prior.entryTradeAmountUsd,
    },
    hold_seconds: Math.max(0, (Date.parse(lastTrade.sellAt!) - Date.parse(trade.buyAt)) / 1000),
    wallet_return_percent: walletReturnPercent,
    entry_trade_amount_usd: trade.entryTradeAmountUsd,
    exit_trade_amount_usd: exitTradeAmountUsd,
    edge_kept_percent: trade.edgeKeptPercent ?? null,
    entry_gap_seconds: trade.entryGapSeconds,
    exit_gap_seconds: trade.exitGapSeconds,
    gas_fee_usd: gasFeeUsd,
    outcome_at: lastTrade.sellAt!,
    outcome_horizon: `copy-${periodDays}d`,
    benchmark_return: walletReturnPercent,
    excess_return:
      walletReturnPercent === null ? null : simulatedReturnPercent - walletReturnPercent,
    net_return_after_costs: simulatedReturnPercent,
    mature: true,
    usable: true,
    coverage_rate_percent: wallet.coverageRatePercent ?? 0,
    coverage_status:
      wallet.coverageStatus === 'fully_covered' ? 'fully_covered' : 'partially_covered',
    entry_id: String(entry.buyTradeId),
    exit_count: entry.trades.length,
  };
};

export type PatternDiscoveryGridProgress = {
  stage: 'simulation' | 'indexing Dune evidence' | 'features' | 'finalizing';
  message: string;
  walletsCompleted?: number;
  walletsTotal?: number;
  independentEntries?: number;
};

const buildPatternDiscoveryExport = (
  simulationWallets: CopySimulationWalletReport[],
  rowsWithCoverage: Array<{ row: PatternDiscoveryExportRow; coverage: number }>,
  selectedPeriod: number,
  selectedCoverage: number,
  exitRowsByWallet: Map<string, number>,
): PatternDiscoveryExport => {
  const eligibleWallets = simulationWallets.filter(
    (wallet) => (wallet.coverageRatePercent ?? 0) >= selectedCoverage,
  );
  const eligibleAddresses = new Set(eligibleWallets.map((wallet) => wallet.walletAddress));
  const rows = rowsWithCoverage
    .filter((item) => item.coverage >= selectedCoverage)
    .map((item) => item.row);
  const exitRows = [...eligibleAddresses].reduce(
    (sum, walletAddress) => sum + (exitRowsByWallet.get(walletAddress) ?? 0),
    0,
  );
  return {
    metadata: {
      project: 'crypto',
      schema_version: 'normalized-v1',
      feature_allowlist_version: 'gmgn-v4-historical-context',
      feature_source: 'features',
      feature_policy:
        'Only the explicit row.features object is eligible for discovery. Historical aggregates use trades strictly before the event buy with the buy id as a same-second tie-breaker. Token market cap is sourced strictly before the buy; token age, launchpad, and entry size are event-time context. Future outcome, return, delay, fee, coverage, and post-event matching fields are labels or metadata, never discovery inputs. GMGN tags and true historical liquidity are not included because the current source does not provide them.',
      outcome: 'net_return_after_costs',
      outcome_horizon: `copy-${selectedPeriod}d`,
      period_days: selectedPeriod,
      coverage_scope: 'outcome_minimum_percent',
      minimum_coverage_percent: selectedCoverage,
      coverage_semantics: `At least ${selectedCoverage}% of paired round trips in the selected period have usable copy-simulation outcomes after the configured delay, fees, slippage, and Dune matching. This is outcome coverage, not merely local GMGN history coverage, and is not a profitability claim. Lower thresholds may introduce missing-outcome bias.`,
      selection_rule: `Predeclared by local history coverage_complete=1, truncated=0, and requested_period_days; final inclusion requires coverageRatePercent>=${selectedCoverage}. No return metric is used for wallet selection.`,
      source_access: 'crypto_adapter_read_only_sqlite',
      shared_engine_database_opened: false,
      selected_wallet_count: eligibleWallets.length,
      exported_rows: rows.length,
      eligible_wallets_before_threshold: simulationWallets.length,
      excluded_wallets_below_threshold: simulationWallets.length - eligibleWallets.length,
      coverage_distribution_percent: simulationWallets.map(
        (wallet) => wallet.coverageRatePercent ?? 0,
      ),
      aggregation: 'one_row_per_buy_entry_all_exits_usable',
      independent_entry_count: rows.length,
      exit_rows_collapsed: Math.max(0, exitRows - rows.length),
      wallet_balanced_validation:
        'The shared engine weights each eligible entry by 1 / entries_per_wallet so every wallet contributes equal total weight; chronological validation remains unchanged.',
      export_generated_at: new Date().toISOString(),
    },
    rows,
  };
};

/** Build the complete coverage grid from one simulation and one chronological wallet scan. */
export const readPatternDiscoveryExportGrid = (
  database: DatabaseSync,
  periodDays = DEFAULT_PATTERN_DISCOVERY_PERIOD_DAYS,
  limit = MAX_PATTERN_DISCOVERY_WALLETS,
  coverageThresholds: number[] = [100],
  onProgress?: (progress: PatternDiscoveryGridProgress) => void,
): Map<number, PatternDiscoveryExport> => {
  const selectedPeriod = validatePeriodDays(periodDays);
  const selectedLimit = validateWalletLimit(limit);
  const thresholds = [...new Set(coverageThresholds.map(validateCoveragePercent))].sort(
    (left, right) => left - right,
  );
  const minimumCoverage = thresholds[0] ?? 100;
  const walletAddresses = fullyCoveredWalletAddresses(database, selectedPeriod, selectedLimit);
  onProgress?.({
    stage: 'simulation',
    message: `Reconstructing delayed-copy outcomes once for ${walletAddresses.length} wallets…`,
    walletsTotal: walletAddresses.length,
  });
  const simulation = computeCopySimulationReport(database, {
    walletAddresses,
    periodDays: selectedPeriod,
    onMatchIndexProgress: (indexProgress) =>
      onProgress?.({
        stage: 'indexing Dune evidence',
        message: `One-time Dune index: run ${indexProgress.completedRuns}/${indexProgress.totalRuns}; ${indexProgress.indexedTradeLegs.toLocaleString()} trade legs indexed.`,
        walletsTotal: walletAddresses.length,
      }),
  });
  const candidateWallets = simulation.wallets.filter(
    (wallet) => (wallet.coverageRatePercent ?? 0) >= minimumCoverage,
  );
  const entries: PatternDiscoveryEntry[] = candidateWallets.flatMap((wallet) =>
    aggregateEntries(wallet.trades).map((entry) => ({ wallet, entry })),
  );
  onProgress?.({
    stage: 'features',
    message: `Building point-in-time features for ${entries.length} independent entries…`,
    walletsCompleted: 0,
    walletsTotal: candidateWallets.length,
    independentEntries: entries.length,
  });
  const snapshots = readPreEventFeatureSnapshots(
    database,
    entries,
    (completed, total, walletAddress) =>
      onProgress?.({
        stage: 'features',
        message: `Point-in-time features: wallet ${completed}/${total} (${walletAddress.slice(0, 6)}…)`,
        walletsCompleted: completed,
        walletsTotal: total,
        independentEntries: entries.length,
      }),
  );
  const rowsWithCoverage = entries.map(({ wallet, entry }) => {
    const prior = snapshots.get(entry.buyTradeId);
    if (!prior) throw new Error(`Missing pre-event snapshot for trade ${entry.buyTradeId}.`);
    return {
      row: normalizedRow(wallet, entry, selectedPeriod, prior),
      coverage: wallet.coverageRatePercent ?? 0,
    };
  });
  const exitRowsByWallet = new Map<string, number>();
  for (const { wallet, entry } of entries) {
    exitRowsByWallet.set(
      wallet.walletAddress,
      (exitRowsByWallet.get(wallet.walletAddress) ?? 0) + entry.trades.length,
    );
  }
  onProgress?.({
    stage: 'finalizing',
    message: `Finalizing ${thresholds.length} coverage datasets from the shared feature rows…`,
    walletsCompleted: candidateWallets.length,
    walletsTotal: candidateWallets.length,
    independentEntries: entries.length,
  });
  return new Map(
    thresholds.map((threshold) => [
      threshold,
      buildPatternDiscoveryExport(
        simulation.wallets,
        rowsWithCoverage,
        selectedPeriod,
        threshold,
        exitRowsByWallet,
      ),
    ]),
  );
};

/**
 * Read-only adapter boundary for the shared pattern finder. Wallets enter the population only
 * through persisted local-history coverage markers; returns are never used for selection. The
 * copy-simulation report then applies the requested minimum outcome-coverage threshold.
 */
export const readPatternDiscoveryExport = (
  database: DatabaseSync,
  periodDays = DEFAULT_PATTERN_DISCOVERY_PERIOD_DAYS,
  limit = MAX_PATTERN_DISCOVERY_WALLETS,
  minimumCoveragePercent = 100,
): PatternDiscoveryExport => {
  const selectedCoverage = validateCoveragePercent(minimumCoveragePercent);
  const result = readPatternDiscoveryExportGrid(database, periodDays, limit, [
    selectedCoverage,
  ]).get(selectedCoverage);
  if (!result) throw new Error(`Pattern Discovery could not build ${selectedCoverage}% export.`);
  return result;
};
