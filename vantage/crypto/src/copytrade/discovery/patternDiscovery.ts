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
    feature_allowlist_version: 'gmgn-v2-pre-event-only';
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
  const row = database.prepare(
    `SELECT COUNT(*) AS priorWalletTradeCount,
            COALESCE(SUM(CASE WHEN event_type = 'buy' AND CAST(cost_usd AS REAL) > 0 THEN CAST(cost_usd AS REAL) ELSE 0 END), 0) AS priorWalletBuyVolumeUsd,
            (SELECT COUNT(*) FROM copytrade_trades AS tokenTrades
             WHERE tokenTrades.chain = 'sol' AND tokenTrades.token_address = ?
               AND (tokenTrades.observed_timestamp < ? OR (tokenTrades.observed_timestamp = ? AND tokenTrades.id < ?))) AS priorTokenTradeCount
     FROM copytrade_trades
     WHERE chain = 'sol' AND wallet_address = ?
       AND (observed_timestamp < ? OR (observed_timestamp = ? AND id < ?))`,
  ).get(tokenAddress, observedTimestamp, observedTimestamp, buyTradeId, walletAddress, observedTimestamp, observedTimestamp, buyTradeId) as unknown as PreEventFeatures;
  return {
    priorWalletTradeCount: Number(row.priorWalletTradeCount) || 0,
    priorTokenTradeCount: Number(row.priorTokenTradeCount) || 0,
    priorWalletBuyVolumeUsd: Number(row.priorWalletBuyVolumeUsd) || 0,
  };
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
      feature_allowlist_version: 'gmgn-v2-pre-event-only',
      feature_source: 'features',
      feature_policy: 'Only the explicit row.features object is eligible for discovery. Identifiers and point-in-time aggregates calculated strictly before each buy are allowed; outcome, return, delay, holding-duration, fee, and post-event matching fields are rejected.',
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
