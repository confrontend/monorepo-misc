import type { DatabaseSync } from 'node:sqlite';
import { computeCopySimulationReport } from './simulation/copySimulation.js';
import {
  calculateMinimumCapital,
  MINIMUM_CAPITAL_CALCULATION_VERSION,
  MINIMUM_CAPITAL_FEE_MODEL_VERSION,
  MINIMUM_CAPITAL_RULE_VERSION,
  readMinimumCapitalFingerprints,
  type MinimumCapitalResult,
} from './simulation/minimumCapital.js';

export type { MinimumCapitalResult } from './simulation/minimumCapital.js';

export type MinimumCapitalApiResult = {
  walletAddress: string;
  chain: string;
  recommendedStartingCapitalUsd: number | null;
  recommendedCopyAmountUsd: number | null;
  technicallyPossibleMinimumCapitalUsd: number | null;
  technicallyPossibleCopyAmountUsd: number | null;
  executedTrades: number;
  skippedTrades: number;
  executedTradeRate: number;
  insufficientCashSkips: number;
  maxConcurrentCapitalUsd: number;
  totalCapitalDeployedUsd: number;
  feesUsd: number;
  grossPnlUsd: number;
  netPnlUsd: number;
  endingCapitalUsd: number | null;
  returnPct: number | null;
  calculationVersion: string;
  gmgnDataFingerprint: string;
  duneHistoryFingerprint: string;
  feeModelVersion: string;
  minimumCapitalRuleVersion: string;
  testedConfigurations: MinimumCapitalResult['testedConfigurations'];
  calculatedAt: string;
  cached?: boolean;
  status?: 'cached' | 'calculated';
};

export const minimumCapitalApiResult = (
  result: MinimumCapitalResult,
  cached = false,
): MinimumCapitalApiResult => {
  const recommended = result.recommendedConfiguration;
  const technical = result.technicalMinimumConfiguration;
  return {
    walletAddress: result.walletAddress,
    chain: result.chain,
    recommendedStartingCapitalUsd: recommended?.startingCapitalUsd ?? null,
    recommendedCopyAmountUsd: recommended?.copyAmountUsd ?? null,
    technicallyPossibleMinimumCapitalUsd: technical?.startingCapitalUsd ?? null,
    technicallyPossibleCopyAmountUsd: technical?.copyAmountUsd ?? null,
    executedTrades: recommended?.executedTrades ?? 0,
    skippedTrades: recommended?.skippedTrades ?? 0,
    executedTradeRate: recommended?.executedTradeRate ?? 0,
    insufficientCashSkips: recommended?.insufficientCashSkips ?? 0,
    maxConcurrentCapitalUsd: recommended?.maxConcurrentCapitalUsd ?? 0,
    totalCapitalDeployedUsd: recommended?.totalCapitalDeployedUsd ?? 0,
    feesUsd: recommended?.feesUsd ?? 0,
    grossPnlUsd: recommended?.grossPnlUsd ?? 0,
    netPnlUsd: recommended?.netPnlUsd ?? 0,
    endingCapitalUsd: recommended?.endingCapitalUsd ?? null,
    returnPct: recommended?.returnPct ?? null,
    calculationVersion: result.calculationVersion,
    gmgnDataFingerprint: result.gmgnDataFingerprint,
    duneHistoryFingerprint: result.duneHistoryFingerprint,
    feeModelVersion: result.feeModelVersion,
    minimumCapitalRuleVersion: result.minimumCapitalRuleVersion,
    testedConfigurations: result.testedConfigurations,
    calculatedAt: result.calculatedAt,
    cached,
    status: cached ? 'cached' : 'calculated',
  };
};

/** DB adapter for the pure minimum-capital grid calculator. It never calls a provider. */
export const calculateMinimumCapitalFromStoredData = (
  database: DatabaseSync,
  walletAddress: string,
  chain = 'sol',
): MinimumCapitalResult => {
  const report = computeCopySimulationReport(database, { walletAddresses: [walletAddress], chain });
  const wallet = report.wallets[0];
  const fingerprints = readMinimumCapitalFingerprints(database, walletAddress, chain);
  return calculateMinimumCapital(walletAddress, wallet?.replayTrades ?? [], fingerprints, {
    chain,
  });
};

export const readCachedMinimumCapital = (
  database: DatabaseSync,
  walletAddress: string,
  chain = 'sol',
): (MinimumCapitalResult & { cached: true }) | null => {
  const row = database
    .prepare(
      `SELECT wallet_address AS walletAddress, chain, calculation_version AS calculationVersion,
          gmgn_data_fingerprint AS gmgnDataFingerprint, dune_history_fingerprint AS duneHistoryFingerprint,
          fee_model_version AS feeModelVersion, minimum_capital_rule_version AS minimumCapitalRuleVersion,
          recommended_starting_capital_usd AS recommendedStartingCapitalUsd,
          recommended_copy_amount_usd AS recommendedCopyAmountUsd,
          technical_minimum_starting_capital_usd AS technicalMinimumStartingCapitalUsd,
          technical_minimum_copy_amount_usd AS technicalMinimumCopyAmountUsd,
          executed_trade_count AS executedTradeCount, skipped_trade_count AS skippedTradeCount,
          insufficient_cash_skips AS insufficientCashSkips, max_concurrent_capital_usd AS maxConcurrentCapitalUsd,
          total_capital_deployed_usd AS totalCapitalDeployedUsd, fees_usd AS feesUsd,
          gross_pnl_usd AS grossPnlUsd, net_pnl_usd AS netPnlUsd, ending_capital_usd AS endingCapitalUsd,
          return_pct AS returnPct, tested_configurations AS testedConfigurations, calculated_at AS calculatedAt
       FROM copytrade_minimum_capital_results
       WHERE wallet_address = ? AND chain = ?
       ORDER BY calculated_at DESC LIMIT 1`,
    )
    .get(walletAddress, chain) as Record<string, unknown> | undefined;
  if (!row) return null;
  if (
    row.calculationVersion !== MINIMUM_CAPITAL_CALCULATION_VERSION ||
    row.feeModelVersion !== MINIMUM_CAPITAL_FEE_MODEL_VERSION ||
    row.minimumCapitalRuleVersion !== MINIMUM_CAPITAL_RULE_VERSION
  )
    return null;
  const fingerprints = readMinimumCapitalFingerprints(database, walletAddress, chain);
  if (
    row.gmgnDataFingerprint !== fingerprints.gmgnDataFingerprint ||
    row.duneHistoryFingerprint !== fingerprints.duneHistoryFingerprint
  )
    return null;
  let testedConfigurations: unknown;
  try {
    testedConfigurations = JSON.parse(String(row.testedConfigurations));
  } catch {
    return null;
  }
  if (!Array.isArray(testedConfigurations)) return null;
  const configurations = testedConfigurations as MinimumCapitalResult['testedConfigurations'];
  const recommendedConfiguration =
    configurations.find(
      (configuration) =>
        configuration.startingCapitalUsd === Number(row.recommendedStartingCapitalUsd) &&
        configuration.copyAmountUsd === Number(row.recommendedCopyAmountUsd),
    ) ?? null;
  const technicalMinimumConfiguration =
    configurations.find(
      (configuration) =>
        configuration.startingCapitalUsd === Number(row.technicalMinimumStartingCapitalUsd) &&
        configuration.copyAmountUsd === Number(row.technicalMinimumCopyAmountUsd),
    ) ?? null;
  return {
    walletAddress: String(row.walletAddress),
    chain: String(row.chain),
    calculationVersion: row.calculationVersion,
    gmgnDataFingerprint: String(row.gmgnDataFingerprint),
    duneHistoryFingerprint: String(row.duneHistoryFingerprint),
    feeModelVersion: row.feeModelVersion,
    minimumCapitalRuleVersion: row.minimumCapitalRuleVersion,
    recommendedConfiguration,
    technicalMinimumConfiguration,
    testedConfigurations: configurations,
    calculatedAt: String(row.calculatedAt),
    cached: true,
  } as unknown as MinimumCapitalResult & {
    cached: true;
  };
};

export const saveMinimumCapital = (database: DatabaseSync, result: MinimumCapitalResult): void => {
  const recommended = result.recommendedConfiguration;
  const technical = result.technicalMinimumConfiguration;
  database
    .prepare(
      `INSERT INTO copytrade_minimum_capital_results
       (wallet_address, chain, calculation_version, gmgn_data_fingerprint, dune_history_fingerprint,
        fee_model_version, minimum_capital_rule_version, recommended_starting_capital_usd,
        recommended_copy_amount_usd, technical_minimum_starting_capital_usd, technical_minimum_copy_amount_usd,
        executed_trade_count, skipped_trade_count, insufficient_cash_skips, max_concurrent_capital_usd,
        total_capital_deployed_usd, fees_usd, gross_pnl_usd, net_pnl_usd, ending_capital_usd, return_pct,
        tested_configurations, calculated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(
         wallet_address, chain, calculation_version, gmgn_data_fingerprint,
         dune_history_fingerprint, fee_model_version, minimum_capital_rule_version
       ) DO UPDATE SET
         recommended_starting_capital_usd=excluded.recommended_starting_capital_usd,
         recommended_copy_amount_usd=excluded.recommended_copy_amount_usd,
         technical_minimum_starting_capital_usd=excluded.technical_minimum_starting_capital_usd,
         technical_minimum_copy_amount_usd=excluded.technical_minimum_copy_amount_usd,
         executed_trade_count=excluded.executed_trade_count,
         skipped_trade_count=excluded.skipped_trade_count,
         insufficient_cash_skips=excluded.insufficient_cash_skips,
         max_concurrent_capital_usd=excluded.max_concurrent_capital_usd,
         total_capital_deployed_usd=excluded.total_capital_deployed_usd,
         fees_usd=excluded.fees_usd, gross_pnl_usd=excluded.gross_pnl_usd,
         net_pnl_usd=excluded.net_pnl_usd, ending_capital_usd=excluded.ending_capital_usd,
         return_pct=excluded.return_pct, tested_configurations=excluded.tested_configurations,
         calculated_at=excluded.calculated_at`,
    )
    .run(
      result.walletAddress,
      result.chain,
      result.calculationVersion,
      result.gmgnDataFingerprint,
      result.duneHistoryFingerprint,
      result.feeModelVersion,
      result.minimumCapitalRuleVersion,
      recommended?.startingCapitalUsd ?? 0,
      recommended?.copyAmountUsd ?? 0,
      technical?.startingCapitalUsd ?? null,
      technical?.copyAmountUsd ?? null,
      recommended?.executedTrades ?? 0,
      recommended?.skippedTrades ?? 0,
      recommended?.insufficientCashSkips ?? 0,
      recommended?.maxConcurrentCapitalUsd ?? 0,
      recommended?.totalCapitalDeployedUsd ?? 0,
      recommended?.feesUsd ?? 0,
      recommended?.grossPnlUsd ?? 0,
      recommended?.netPnlUsd ?? 0,
      recommended?.endingCapitalUsd ?? 0,
      recommended?.returnPct ?? 0,
      JSON.stringify(result.testedConfigurations),
      result.calculatedAt,
    );
};
