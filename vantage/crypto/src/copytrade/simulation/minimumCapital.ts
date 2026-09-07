import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  simulateFixedStakePortfolio,
  type CopySimulationScenario,
  type FixedStakePortfolioReport,
  type FixedStakePortfolioTrade,
} from './fixedStakePortfolio.js';

/** Version of the minimum-capital calculation contract and its search behavior. */
export const MINIMUM_CAPITAL_CALCULATION_VERSION = 'minimum-capital-v1' as const;
export const MINIMUM_CAPITAL_RULE_VERSION = 'minimum-capital-rules-v1' as const;
export const MINIMUM_CAPITAL_FEE_MODEL_VERSION = 'gmgn-fee-model-v1' as const;

export const DEFAULT_MINIMUM_CAPITAL_COPY_AMOUNTS_USD = [0.5, 1, 2, 3, 5, 10] as const;
export const DEFAULT_MINIMUM_CAPITAL_STARTING_AMOUNTS_USD = [
  2, 3, 5, 7.5, 10, 15, 20, 25, 50,
] as const;

export type MinimumCapitalRules = Readonly<{
  minimumExecutedTradeRate: number;
  maximumInsufficientCashSkipRate: number;
  minimumEndingCapitalUsd: number;
  maximumFeeToGrossProfitRate: number;
}>;

export const DEFAULT_MINIMUM_CAPITAL_RULES: MinimumCapitalRules = {
  minimumExecutedTradeRate: 0.95,
  maximumInsufficientCashSkipRate: 0.05,
  minimumEndingCapitalUsd: 0,
  // This is an economic warning, not a passing gate. A configuration can pass the execution
  // gates while still being flagged when fixed gas consumes most of its gross profit.
  maximumFeeToGrossProfitRate: 0.5,
};

export type MinimumCapitalSearchOptions = Readonly<{
  copyAmountsUsd?: readonly number[];
  startingCapitalAmountsUsd?: readonly number[];
  rules?: Partial<MinimumCapitalRules>;
  calculatedAt?: Date;
}>;

export type MinimumCapitalConfiguration = Readonly<{
  startingCapitalUsd: number;
  copyAmountUsd: number;
  executedTrades: number;
  eligibleTrades: number;
  skippedTrades: number;
  insufficientCashSkips: number;
  executedTradeRate: number;
  insufficientCashSkipRate: number;
  maxConcurrentCapitalUsd: number;
  totalCapitalDeployedUsd: number;
  feesUsd: number;
  feesComplete: boolean;
  grossPnlUsd: number;
  netPnlUsd: number;
  endingCapitalUsd: number;
  returnPct: number;
  feesToGrossProfitPct: number | null;
  feesToDeployedCapitalPct: number | null;
  passesExecutionGates: boolean;
  feeWarning: boolean;
  status: 'pass' | 'fail';
}>;

export type MinimumCapitalResult = Readonly<{
  walletAddress: string;
  chain: string;
  calculationVersion: typeof MINIMUM_CAPITAL_CALCULATION_VERSION;
  gmgnDataFingerprint: string;
  duneHistoryFingerprint: string;
  feeModelVersion: typeof MINIMUM_CAPITAL_FEE_MODEL_VERSION;
  minimumCapitalRuleVersion: typeof MINIMUM_CAPITAL_RULE_VERSION;
  recommendedConfiguration: MinimumCapitalConfiguration | null;
  technicalMinimumConfiguration: MinimumCapitalConfiguration | null;
  testedConfigurations: readonly MinimumCapitalConfiguration[];
  calculatedAt: string;
}>;

type Fingerprints = Readonly<{ gmgnDataFingerprint: string; duneHistoryFingerprint: string }>;

const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const normalizeAmounts = (values: readonly number[], label: string): number[] => {
  const normalized = [...new Set(values)]
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  if (normalized.length === 0) throw new RangeError(`${label} must contain a positive amount.`);
  return normalized;
};

const rulesFor = (overrides?: Partial<MinimumCapitalRules>): MinimumCapitalRules => ({
  ...DEFAULT_MINIMUM_CAPITAL_RULES,
  ...overrides,
});

const configurationFor = (
  report: FixedStakePortfolioReport,
  startingCapitalUsd: number,
  copyAmountUsd: number,
  trades: readonly FixedStakePortfolioTrade[],
  rules: MinimumCapitalRules,
): MinimumCapitalConfiguration => {
  // Open positions are needed for concurrent-capital and mark-to-market accounting, but are not
  // completed trades and therefore do not lower the execution-rate denominator.
  const eligibleTrades = trades.filter((trade) => !trade.isOpenAtCutoff).length;
  const executedTrades = Math.min(report.copiedTrades, eligibleTrades);
  const skippedTrades = report.skippedInsufficientCash + report.skippedMaxOpenPositions;
  const executedTradeRate = eligibleTrades ? executedTrades / eligibleTrades : 0;
  const insufficientCashSkipRate = eligibleTrades
    ? report.skippedInsufficientCash / eligibleTrades
    : 0;
  const feesUsd = report.gasFeeUsd ?? 0;
  const grossPnlUsd = report.grossPnlUsd ?? 0;
  const netPnlUsd = report.endingCapitalUsd - startingCapitalUsd;
  const feesToGrossProfitRate = grossPnlUsd > 0 ? feesUsd / grossPnlUsd : null;
  const feesToDeployedCapitalRate = report.totalCapitalDeployedUsd
    ? feesUsd / report.totalCapitalDeployedUsd
    : null;
  const passesExecutionGates =
    executedTradeRate >= rules.minimumExecutedTradeRate &&
    insufficientCashSkipRate <= rules.maximumInsufficientCashSkipRate &&
    report.endingCapitalUsd > rules.minimumEndingCapitalUsd;
  return {
    startingCapitalUsd,
    copyAmountUsd,
    executedTrades,
    eligibleTrades,
    skippedTrades,
    insufficientCashSkips: report.skippedInsufficientCash,
    executedTradeRate: round(executedTradeRate * 100, 1),
    insufficientCashSkipRate: round(insufficientCashSkipRate * 100, 1),
    maxConcurrentCapitalUsd: round(report.maxConcurrentCapitalUsd ?? 0),
    totalCapitalDeployedUsd: round(report.totalCapitalDeployedUsd ?? 0),
    feesUsd: round(feesUsd),
    feesComplete: report.gasCostComplete ?? false,
    grossPnlUsd: round(grossPnlUsd),
    netPnlUsd: round(netPnlUsd),
    endingCapitalUsd: round(report.endingCapitalUsd),
    returnPct: startingCapitalUsd > 0 ? round((netPnlUsd / startingCapitalUsd) * 100, 1) : 0,
    feesToGrossProfitPct:
      feesToGrossProfitRate === null ? null : round(feesToGrossProfitRate * 100, 1),
    feesToDeployedCapitalPct:
      feesToDeployedCapitalRate === null ? null : round(feesToDeployedCapitalRate * 100, 1),
    passesExecutionGates,
    feeWarning:
      feesToGrossProfitRate !== null && feesToGrossProfitRate > rules.maximumFeeToGrossProfitRate,
    status: passesExecutionGates ? 'pass' : 'fail',
  };
};

const scenarioFor = (
  startingCapitalUsd: number,
  copyAmountUsd: number,
): CopySimulationScenario => ({
  startingBankrollUsd: startingCapitalUsd,
  copyAmountUsd,
});

/**
 * Search the small, explicit practical grid for the lowest capital configuration that can copy
 * the supplied already-matched Dune replay. This function is pure: it performs no DB or network
 * access. The artificial ten-position simulator cap is intentionally disabled for this planning
 * calculation; available cash, not an invented position count, is the constraint.
 */
export const calculateMinimumCapital = (
  walletAddress: string,
  trades: readonly FixedStakePortfolioTrade[],
  fingerprints: Fingerprints,
  options: MinimumCapitalSearchOptions & { chain?: string } = {},
): MinimumCapitalResult => {
  const copyAmounts = normalizeAmounts(
    options.copyAmountsUsd ?? DEFAULT_MINIMUM_CAPITAL_COPY_AMOUNTS_USD,
    'copyAmountsUsd',
  );
  const startingAmounts = normalizeAmounts(
    options.startingCapitalAmountsUsd ?? DEFAULT_MINIMUM_CAPITAL_STARTING_AMOUNTS_USD,
    'startingCapitalAmountsUsd',
  );
  const rules = rulesFor(options.rules);
  const configurations: MinimumCapitalConfiguration[] = [];
  for (const startingCapitalUsd of startingAmounts) {
    for (const copyAmountUsd of copyAmounts) {
      const report = simulateFixedStakePortfolio([...trades], {
        scenario: scenarioFor(startingCapitalUsd, copyAmountUsd),
        // Number.POSITIVE_INFINITY is intentional and documented: this calculation must not
        // inherit the canonical report's artificial ten-position limit.
        maxOpenPositions: Number.POSITIVE_INFINITY,
      });
      configurations.push(
        configurationFor(report, startingCapitalUsd, copyAmountUsd, trades, rules),
      );
    }
  }
  const passing = configurations
    .filter((configuration) => configuration.passesExecutionGates)
    .sort(
      (left, right) =>
        left.startingCapitalUsd - right.startingCapitalUsd ||
        left.copyAmountUsd - right.copyAmountUsd,
    );
  const technicallyPossible = configurations
    .filter(
      (configuration) => configuration.executedTrades > 0 && configuration.endingCapitalUsd > 0,
    )
    .sort(
      (left, right) =>
        left.startingCapitalUsd - right.startingCapitalUsd ||
        left.copyAmountUsd - right.copyAmountUsd,
    );
  return {
    walletAddress,
    chain: options.chain ?? 'sol',
    calculationVersion: MINIMUM_CAPITAL_CALCULATION_VERSION,
    gmgnDataFingerprint: fingerprints.gmgnDataFingerprint,
    duneHistoryFingerprint: fingerprints.duneHistoryFingerprint,
    feeModelVersion: MINIMUM_CAPITAL_FEE_MODEL_VERSION,
    minimumCapitalRuleVersion: MINIMUM_CAPITAL_RULE_VERSION,
    recommendedConfiguration: passing[0] ?? null,
    technicalMinimumConfiguration: technicallyPossible[0] ?? null,
    testedConfigurations: configurations,
    calculatedAt: (options.calculatedAt ?? new Date()).toISOString(),
  };
};

/** Stable fingerprints of the wallet's persisted GMGN rows and Dune-delayed match rows. */
export const readMinimumCapitalFingerprints = (
  database: DatabaseSync,
  walletAddress: string,
  chain = 'sol',
): Fingerprints => {
  const gmgnRows = database
    .prepare(
      `SELECT id, wallet_address AS walletAddress, chain, tx_hash AS txHash, event_type AS eventType,
              token_address AS tokenAddress, observed_timestamp AS observedTimestamp,
              token_amount AS tokenAmount, cost_usd AS costUsd, buy_cost_usd AS buyCostUsd,
              price_usd AS priceUsd, gas_usd AS gasUsd, raw_payload AS rawPayload, fetched_at AS fetchedAt
       FROM copytrade_trades WHERE wallet_address = ? AND chain = ? ORDER BY id`,
    )
    .all(walletAddress, chain);
  const duneRows = database
    .prepare(
      `SELECT m.run_id AS runId, m.trade_id AS tradeId, m.matched_trade_at AS matchedTradeAt,
              m.matched_price_usd AS matchedPriceUsd, m.matched_tx_id AS matchedTxId,
              m.matched_trade_amount_usd AS matchedTradeAmountUsd, m.status,
              m.match_source AS matchSource, m.completed_at AS completedAt, r.status AS runStatus
       FROM copytrade_copy_simulation_matches m
       JOIN copytrade_trades t ON t.id = m.trade_id
       JOIN copytrade_copy_simulation_runs r ON r.id = m.run_id
       WHERE t.wallet_address = ? AND t.chain = ? ORDER BY m.trade_id, m.run_id`,
    )
    .all(walletAddress, chain);
  return {
    gmgnDataFingerprint: digest(gmgnRows),
    duneHistoryFingerprint: digest(duneRows),
  };
};
