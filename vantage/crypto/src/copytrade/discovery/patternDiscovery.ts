import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { computeCopySimulationReport, type CopySimulationTradeResult, type CopySimulationWalletReport } from '../simulation/copySimulation.js';

export const DEFAULT_PATTERN_DISCOVERY_PERIOD_DAYS = 30;
export const MAX_PATTERN_DISCOVERY_PERIOD_DAYS = 90;
export const MAX_PATTERN_DISCOVERY_WALLETS = 500;
/** Change this when the normalized export or discovery input contract changes. */
export const PATTERN_DISCOVERY_ENGINE_VERSION = 'crypto-pattern-discovery-v2-entry-wallet-balanced';

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
  coverage_rate_percent: number;
  coverage_status: 'fully_covered' | 'partially_covered';
  entry_id: string;
  exit_count: number;
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

/**
 * Fingerprint every persisted input that can change the discovery population or outcome.
 * Counts/max ids are not sufficient here: Dune runs are updated in place from running to
 * completed, so the relevant row values are included in the digest as well.
 */
export const readPatternDiscoveryDataFingerprint = (database: DatabaseSync): string => {
  const hash = createHash('sha256');
  const addRows = (label: string, rows: unknown[]): void => {
    hash.update(label, 'utf8');
    for (const row of rows) hash.update(JSON.stringify(row), 'utf8');
  };
  addRows('wallets\n', database.prepare(
    `SELECT wallet_address, chain, rank_position, source_snapshot_id, gmgn_tags
     FROM copytrade_wallets ORDER BY wallet_address, chain, source_snapshot_id, rank_position`,
  ).all());
  addRows('coverage\n', database.prepare(
    `SELECT wallet_address, chain, last_run_id, requests_used, truncated, coverage_complete,
            requested_period_days, stop_reason, updated_at
     FROM copytrade_wallet_coverage ORDER BY wallet_address, chain`,
  ).all());
  addRows('trades\n', database.prepare(
    `SELECT id, wallet_address, chain, event_type, token_address, observed_timestamp,
            cost_usd, buy_cost_usd, price_usd, gas_usd, fetched_at
     FROM copytrade_trades ORDER BY id`,
  ).all());
  addRows('dune-runs\n', database.prepare(
    `SELECT id, trade_refs, status, requested_at, completed_at, raw_result, search_window_minutes,
            match_source, dune_last_state, dune_last_status_at
     FROM copytrade_copy_simulation_runs ORDER BY id`,
  ).all());
  return hash.digest('hex');
};

export const patternDiscoveryCacheKey = (
  kind: 'export' | 'report',
  periodDays: number,
  minimumCoveragePercent: number,
  minN?: number,
  limit = MAX_PATTERN_DISCOVERY_WALLETS,
): string => [
  PATTERN_DISCOVERY_ENGINE_VERSION,
  kind,
  periodDays,
  minimumCoveragePercent,
  minN ?? '',
  limit,
].join(':');

export const readPatternDiscoveryCache = <T>(
  database: DatabaseSync,
  cacheKey: string,
  dataFingerprint: string,
): T | null => {
  const row = database.prepare(
    `SELECT report_json AS reportJson
     FROM copytrade_report_cache
     WHERE cache_key = ? AND data_fingerprint = ?`,
  ).get(cacheKey, dataFingerprint) as PatternDiscoveryCacheRow | undefined;
  if (!row) return null;
  try { return JSON.parse(row.reportJson) as T; } catch { return null; }
};

export const writePatternDiscoveryCache = (
  database: DatabaseSync,
  cacheKey: string,
  dataFingerprint: string,
  value: unknown,
): void => {
  database.prepare(
    `INSERT INTO copytrade_report_cache (cache_key, data_fingerprint, report_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       data_fingerprint = excluded.data_fingerprint,
       report_json = excluded.report_json,
       updated_at = excluded.updated_at`,
  ).run(cacheKey, dataFingerprint, JSON.stringify(value), new Date().toISOString());
};

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

type AggregatedEntry = {
  buyTradeId: number;
  trades: CopySimulationTradeResult[];
};

const aggregateEntry = (trades: CopySimulationTradeResult[]): AggregatedEntry => {
  const first = trades[0];
  if (first?.buyTradeId === undefined) throw new Error('Pattern discovery entry is missing its source buy id.');
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
    .filter((group) => group.length > 0 && group.every((trade) => trade.status === 'simulated' && trade.simulatedReturnPercent !== null && trade.buyAt && trade.sellAt))
    .map(aggregateEntry);
};

const normalizedRow = (database: DatabaseSync, wallet: CopySimulationWalletReport, entry: AggregatedEntry, periodDays: number): PatternDiscoveryExportRow => {
  const trade = entry.trades[0];
  if (trade.status !== 'simulated' || trade.simulatedReturnPercent === null || !trade.buyAt || !trade.sellAt) {
    throw new Error(`Fully covered wallet ${wallet.walletAddress} contained a non-simulated or incomplete round trip.`);
  }
  const prior = readPreEventFeatures(database, wallet.walletAddress, trade.tokenAddress, trade.buyAt, entry.buyTradeId);
  const stake = entry.trades.reduce((sum, item) => sum + (item.copyStakeUsd ?? 0), 0) || entry.trades.length;
  const simulatedPnl = entry.trades.reduce((sum, item) => sum + ((item.copyStakeUsd ?? 1) * (item.simulatedReturnPercent ?? 0) / 100), 0);
  const walletPnl = entry.trades.reduce((sum, item) => sum + ((item.copyStakeUsd ?? 1) * (item.walletReturnPercent ?? 0) / 100), 0);
  const simulatedReturnPercent = (simulatedPnl / stake) * 100;
  const walletReturnPercent = entry.trades.every((item) => item.walletReturnPercent !== null) ? (walletPnl / stake) * 100 : null;
  const lastTrade = entry.trades[entry.trades.length - 1];
  const exitTradeAmountUsd = entry.trades.reduce((sum, item) => sum + (item.exitTradeAmountUsd ?? 0), 0) || null;
  const gasFeeUsd = entry.trades.every((item) => item.gasFeeUsd !== null && item.gasFeeUsd !== undefined)
    ? entry.trades.reduce((sum, item) => sum + (item.gasFeeUsd ?? 0), 0) : null;
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
    excess_return: walletReturnPercent === null ? null : simulatedReturnPercent - walletReturnPercent,
    net_return_after_costs: simulatedReturnPercent,
    mature: true,
    usable: true,
    coverage_rate_percent: wallet.coverageRatePercent ?? 0,
    coverage_status: wallet.coverageStatus === 'fully_covered' ? 'fully_covered' : 'partially_covered',
    entry_id: String(entry.buyTradeId),
    exit_count: entry.trades.length,
  };
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
  const selectedPeriod = validatePeriodDays(periodDays);
  const selectedLimit = validateWalletLimit(limit);
  const selectedCoverage = validateCoveragePercent(minimumCoveragePercent);
  const walletAddresses = fullyCoveredWalletAddresses(database, selectedPeriod, selectedLimit);
  const simulation = computeCopySimulationReport(database, { walletAddresses, periodDays: selectedPeriod });
  const eligibleWallets = simulation.wallets.filter((wallet) => (wallet.coverageRatePercent ?? 0) >= selectedCoverage);
  const entries = eligibleWallets.flatMap((wallet) => aggregateEntries(wallet.trades).map((entry) => ({ wallet, entry })));
  const rows = entries.map(({ wallet, entry }) => normalizedRow(database, wallet, entry, selectedPeriod));

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
      coverage_scope: 'outcome_minimum_percent',
      minimum_coverage_percent: selectedCoverage,
      coverage_semantics: `At least ${selectedCoverage}% of paired round trips in the selected period have usable copy-simulation outcomes after the configured delay, fees, slippage, and Dune matching. This is outcome coverage, not merely local GMGN history coverage, and is not a profitability claim. Lower thresholds may introduce missing-outcome bias.`,
      selection_rule: `Predeclared by local history coverage_complete=1, truncated=0, and requested_period_days; final inclusion requires coverageRatePercent>=${selectedCoverage}. No return metric is used for wallet selection.`,
      source_access: 'crypto_adapter_read_only_sqlite',
      shared_engine_database_opened: false,
      selected_wallet_count: eligibleWallets.length,
      exported_rows: rows.length,
      eligible_wallets_before_threshold: simulation.wallets.length,
      excluded_wallets_below_threshold: simulation.wallets.length - eligibleWallets.length,
      coverage_distribution_percent: simulation.wallets.map((wallet) => wallet.coverageRatePercent ?? 0),
      aggregation: 'one_row_per_buy_entry_all_exits_usable',
      independent_entry_count: rows.length,
      exit_rows_collapsed: entries.reduce((sum, item) => sum + item.entry.trades.length, 0) - rows.length,
      wallet_balanced_validation: 'The shared engine weights each eligible entry by 1 / entries_per_wallet so every wallet contributes equal total weight; chronological validation remains unchanged.',
      export_generated_at: new Date().toISOString(),
    },
    rows,
  };
};
