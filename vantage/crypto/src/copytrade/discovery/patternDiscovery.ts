import type { DatabaseSync } from 'node:sqlite';
import { computeCopySimulationReport, type CopySimulationTradeResult, type CopySimulationWalletReport } from '../simulation/copySimulation.js';

export const DEFAULT_PATTERN_DISCOVERY_PERIOD_DAYS = 30;
export const MAX_PATTERN_DISCOVERY_PERIOD_DAYS = 90;
export const MAX_PATTERN_DISCOVERY_WALLETS = 500;

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
  coverage_rate_percent: 100;
  coverage_status: 'fully_covered';
};

export type PatternDiscoveryExport = {
  metadata: {
    project: 'crypto';
    schema_version: 'normalized-v1';
    feature_allowlist_version: 'gmgn-v3-pre-event-only';
    feature_source: 'features';
    feature_policy: string;
    outcome: 'net_return_after_costs';
    outcome_horizon: string;
    period_days: number;
    coverage_scope: 'outcome_exact_100_percent';
    coverage_semantics: string;
    selection_rule: string;
    source_access: 'crypto_adapter_read_only_sqlite';
    shared_engine_database_opened: false;
    selected_wallet_count: number;
    exported_rows: number;
    excluded_wallets_not_exactly_100_percent: number;
    export_generated_at: string;
  };
  rows: PatternDiscoveryExportRow[];
};

type FullyCoveredWallet = { walletAddress: string };

const validatePeriodDays = (periodDays: number): number => {
  if (!Number.isInteger(periodDays) || periodDays <= 0 || periodDays > MAX_PATTERN_DISCOVERY_PERIOD_DAYS) {
    throw new RangeError(`periodDays must be an integer between 1 and ${MAX_PATTERN_DISCOVERY_PERIOD_DAYS}.`);
  }
  return periodDays;
};

const validateWalletLimit = (limit: number): number => {
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_PATTERN_DISCOVERY_WALLETS) {
    throw new RangeError(`limit must be an integer between 1 and ${MAX_PATTERN_DISCOVERY_WALLETS}.`);
  }
  return limit;
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
};

type PriorTrade = { id: number; eventType: string; tokenAddress: string; observedTimestamp: number; costUsd: string | null; buyCostUsd: string | null };

const amount = (value: string | null): number | null => {
  if (value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
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
  if (!Number.isFinite(observedTimestamp)) throw new Error(`Invalid buy timestamp for pattern discovery: ${buyAt}`);
  const rows = database.prepare(
    `SELECT id, event_type AS eventType, token_address AS tokenAddress,
            observed_timestamp AS observedTimestamp, cost_usd AS costUsd, buy_cost_usd AS buyCostUsd
     FROM copytrade_trades
     WHERE chain = 'sol' AND wallet_address = ? AND event_type IN ('buy', 'sell')
       AND (observed_timestamp < ? OR (observed_timestamp = ? AND id < ?))
     ORDER BY observed_timestamp ASC, id ASC`,
  ).all(walletAddress, observedTimestamp, observedTimestamp, buyTradeId) as unknown as PriorTrade[];
  const priorWalletTradeCount = rows.length;
  const buys = rows.filter((row) => row.eventType === 'buy');
  const sells = rows.filter((row) => row.eventType === 'sell');
  const buyVolume = buys.reduce((sum, row) => sum + (amount(row.costUsd) ?? 0), 0);
  const sellVolume = sells.reduce((sum, row) => sum + (amount(row.costUsd) ?? 0), 0);
  const returns: Array<{ tokenAddress: string; returnPercent: number; profitUsd: number; day: string }> = [];
  const lastBuyByToken = new Map<string, number>();
  const profitByToken = new Map<string, number>();
  const profitByDay = new Map<string, number>();
  const holds: number[] = [];
  for (const row of rows) {
    if (row.eventType === 'buy') { lastBuyByToken.set(row.tokenAddress, row.observedTimestamp); continue; }
    const proceeds = amount(row.costUsd);
    const costBasis = amount(row.buyCostUsd);
    const boughtAt = lastBuyByToken.get(row.tokenAddress);
    if (boughtAt !== undefined) holds.push(Math.max(0, row.observedTimestamp - boughtAt));
    if (proceeds === null || costBasis === null || costBasis <= 0) continue;
    const profitUsd = proceeds - costBasis;
    const returnPercent = (profitUsd / costBasis) * 100;
    const day = new Date(row.observedTimestamp * 1000).toISOString().slice(0, 10);
    returns.push({ tokenAddress: row.tokenAddress, returnPercent, profitUsd, day });
    profitByToken.set(row.tokenAddress, (profitByToken.get(row.tokenAddress) ?? 0) + profitUsd);
    profitByDay.set(day, (profitByDay.get(day) ?? 0) + profitUsd);
  }
  const positiveProfit = [...profitByToken.values()].filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const bestTokenProfit = Math.max(0, ...profitByToken.values());
  const positiveDays = [...profitByDay.values()].filter((value) => value > 0).length;
  const realizedProfit = returns.length === 0 ? null : returns.reduce((sum, row) => sum + row.profitUsd, 0);
  const winningReturns = returns.filter((row) => row.returnPercent > 0).length;
  const positiveDaysWithData = profitByDay.size;
  const row: PreEventFeatures = {
    priorWalletTradeCount,
    priorTokenTradeCount: rows.filter((prior) => prior.tokenAddress === tokenAddress).length,
    priorWalletBuyVolumeUsd: buyVolume,
    priorWalletBuyCount: buys.length,
    priorWalletSellCount: sells.length,
    priorWalletSellVolumeUsd: sellVolume,
    priorWalletRealizedProfitUsd: realizedProfit,
    priorWalletMedianReturnPercent: median(returns.map((entry) => entry.returnPercent)),
    priorWalletWinRatePercent: returns.length === 0 ? null : (winningReturns / returns.length) * 100,
    priorWalletPositiveDayPercent: positiveDaysWithData === 0 ? null : (positiveDays / positiveDaysWithData) * 100,
    priorWalletBestTokenProfitSharePercent: positiveProfit <= 0 ? null : (bestTokenProfit / positiveProfit) * 100,
    priorWalletMedianHoldSeconds: median(holds),
    priorWalletUnder15SecondsPercent: holds.length === 0 ? null : (holds.filter((seconds) => seconds <= 15).length / holds.length) * 100,
    priorWalletPairedTradeCount: holds.length,
  };
  return row;
};

const fullyCoveredWalletAddresses = (database: DatabaseSync, periodDays: number, limit: number): string[] => {
  const rows = database.prepare(
    `SELECT wallet_address AS walletAddress
     FROM copytrade_wallet_coverage
     WHERE chain = 'sol'
       AND coverage_complete = 1
       AND truncated = 0
       AND requested_period_days = ?
     ORDER BY updated_at DESC, wallet_address ASC
     LIMIT ?`,
  ).all(periodDays, limit) as unknown as FullyCoveredWallet[];
  return rows.map((row) => row.walletAddress);
};

const normalizedRow = (database: DatabaseSync, wallet: CopySimulationWalletReport, trade: CopySimulationTradeResult, index: number, periodDays: number): PatternDiscoveryExportRow => {
  if (trade.status !== 'simulated' || trade.simulatedReturnPercent === null || !trade.buyAt || !trade.sellAt) {
    throw new Error(`Fully covered wallet ${wallet.walletAddress} contained a non-simulated or incomplete round trip.`);
  }
  if (trade.buyTradeId === undefined) throw new Error(`Fully covered wallet ${wallet.walletAddress} contained a trade without its source buy id.`);
  const prior = readPreEventFeatures(database, wallet.walletAddress, trade.tokenAddress, trade.buyAt, trade.buyTradeId);
  return {
    project: 'crypto',
    event_id: `gmgn-copy-round-trip:${wallet.walletAddress}:${index}:${trade.buyAt}:${trade.sellAt}:${trade.tokenAddress}`,
    event_time: trade.buyAt,
    entity_id: trade.tokenAddress,
    signal_type: 'gmgn_copy_round_trip',
    independence_group: wallet.walletAddress,
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
    },
    hold_seconds: trade.holdSeconds ?? 0,
    wallet_return_percent: trade.walletReturnPercent,
    entry_trade_amount_usd: trade.entryTradeAmountUsd,
    exit_trade_amount_usd: trade.exitTradeAmountUsd,
    edge_kept_percent: trade.edgeKeptPercent ?? null,
    entry_gap_seconds: trade.entryGapSeconds,
    exit_gap_seconds: trade.exitGapSeconds,
    gas_fee_usd: trade.gasFeeUsd ?? null,
    outcome_at: trade.sellAt,
    outcome_horizon: `copy-${periodDays}d`,
    benchmark_return: trade.walletReturnPercent,
    excess_return: trade.walletReturnPercent === null ? null : trade.simulatedReturnPercent - trade.walletReturnPercent,
    net_return_after_costs: trade.simulatedReturnPercent,
    mature: true,
    usable: true,
    coverage_rate_percent: 100,
    coverage_status: 'fully_covered',
  };
};

/**
 * Read-only adapter boundary for the shared pattern finder. Wallets enter the population only
 * through persisted local-history coverage markers; returns are never used for selection. The
 * copy-simulation report then applies the separate exact-100%-outcome gate for this period.
 */
export const readPatternDiscoveryExport = (
  database: DatabaseSync,
  periodDays = DEFAULT_PATTERN_DISCOVERY_PERIOD_DAYS,
  limit = MAX_PATTERN_DISCOVERY_WALLETS,
): PatternDiscoveryExport => {
  const selectedPeriod = validatePeriodDays(periodDays);
  const selectedLimit = validateWalletLimit(limit);
  const walletAddresses = fullyCoveredWalletAddresses(database, selectedPeriod, selectedLimit);
  const simulation = computeCopySimulationReport(database, { walletAddresses, periodDays: selectedPeriod });
  const exactWallets = simulation.wallets.filter((wallet) => wallet.coverageStatus === 'fully_covered' && wallet.coverageRatePercent === 100);
  const rows = exactWallets.flatMap((wallet) => wallet.trades.map((trade, index) => normalizedRow(database, wallet, trade, index, selectedPeriod)));

  return {
    metadata: {
      project: 'crypto',
      schema_version: 'normalized-v1',
      feature_allowlist_version: 'gmgn-v3-pre-event-only',
      feature_source: 'features',
      feature_policy: 'Only the explicit row.features object is eligible for discovery. Every historical aggregate is calculated strictly before the event buy, with the buy id as a same-second tie-breaker. Future outcome, return, delay, fee, and post-event matching fields are labels or metadata, never discovery inputs; prior holding-time metrics are allowed because they are known before the event.',
      outcome: 'net_return_after_costs',
      outcome_horizon: `copy-${selectedPeriod}d`,
      period_days: selectedPeriod,
      coverage_scope: 'outcome_exact_100_percent',
      coverage_semantics: 'Exactly 100% of paired round trips in the selected period have usable copy-simulation outcomes after the configured delay, fees, slippage, and Dune matching. This is outcome coverage, not merely local GMGN history coverage, and is not a profitability claim.',
      selection_rule: 'Predeclared by local history coverage_complete=1, truncated=0, and requested_period_days; final inclusion requires coverageRatePercent=100 and coverageStatus=fully_covered. No return metric is used for wallet selection.',
      source_access: 'crypto_adapter_read_only_sqlite',
      shared_engine_database_opened: false,
      selected_wallet_count: exactWallets.length,
      exported_rows: rows.length,
      excluded_wallets_not_exactly_100_percent: simulation.wallets.length - exactWallets.length,
      export_generated_at: new Date().toISOString(),
    },
    rows,
  };
};
