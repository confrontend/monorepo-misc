import { median } from './scrutiny/evaluate.js';
import { normalizeGmgnProfitStat } from '../gmgn/normalize.js';
import type { StoredGmgnRiskResult } from './scrutiny/gmgnRisk.js';
import {
  simulateFixedStakePortfolio,
  type CopySimulationTradeResult,
  type CopySimulationWalletReport,
  type FixedStakePortfolioTrade,
} from './simulation/copySimulation.js';
import { WINNER_POLICY_V2_CONFIG } from './winnerPolicyV2Config.js';
import type {
  GmgnRiskBundleEvidence,
  WinnerPolicyActivitySignals,
  WinnerPolicyEvidence,
  WinnerPolicyExecutionFrictionSignals,
  WinnerPolicyHoldout,
  WinnerPolicyTradeQualitySignals,
} from './winnerPolicy.js';
import {
  computeRecencyWeightedMedian,
  evaluateCoverageQuality,
  WINNER_POLICY_RECENCY_HALF_LIFE_DAYS,
} from './winnerPolicy.js';

type DatedCanonicalOutcome = {
  buyTradeId: number;
  timestamp: number;
  returnPercent: number;
};

const timestamp = (value: string | undefined): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 1000 : null;
};

const medianReturn = (outcomes: readonly DatedCanonicalOutcome[]): number | null =>
  median(outcomes.map((outcome) => outcome.returnPercent));

const holdoutFor = (
  index: number,
  outcomes: DatedCanonicalOutcome[],
  trades: CopySimulationTradeResult[],
): WinnerPolicyHoldout => {
  const buyIds = new Set(outcomes.map((outcome) => outcome.buyTradeId));
  const matchingTrades = trades.filter(
    (trade) =>
      trade.status === 'simulated' &&
      trade.buyTradeId !== undefined &&
      trade.sellTradeId !== undefined &&
      buyIds.has(trade.buyTradeId),
  );
  const portfolioTrades: FixedStakePortfolioTrade[] = matchingTrades.flatMap((trade) => {
    const entryAt = timestamp(trade.buyAt);
    const exitAt = timestamp(trade.sellAt);
    if (
      entryAt === null ||
      exitAt === null ||
      trade.simulatedReturnPercent === null ||
      trade.sellTradeId === undefined ||
      trade.buyTradeId === undefined
    )
      return [];
    return [
      {
        id: trade.sellTradeId,
        entryAt,
        exitAt,
        returnRatio: trade.simulatedReturnPercent / 100,
        gasFeeSol: trade.gasFeeSol ?? 0,
        stakeUsd: trade.copyStakeUsd,
        positionId: trade.buyTradeId,
      },
    ];
  });
  const portfolio = simulateFixedStakePortfolio(portfolioTrades);
  const dates = matchingTrades.flatMap((trade) => {
    const start = timestamp(trade.buyAt);
    const end = timestamp(trade.sellAt);
    return start !== null && end !== null ? [start, end] : [];
  });
  return {
    index,
    startAt: dates.length ? new Date(Math.min(...dates) * 1000).toISOString() : null,
    endAt: dates.length ? new Date(Math.max(...dates) * 1000).toISOString() : null,
    completedCopiedBuyOutcomes: outcomes.length,
    medianReturnPercent: medianReturn(outcomes),
    startingCapitalUsd: portfolio.startingCapitalUsd,
    endingCapitalUsd: portfolioTrades.length ? portfolio.endingCapitalUsd : null,
    profitable: portfolioTrades.length
      ? portfolio.endingCapitalUsd > portfolio.startingCapitalUsd
      : null,
  };
};

const splitIntoThree = <T>(values: T[]): T[][] => {
  const windows: T[][] = [];
  const baseSize = Math.floor(values.length / 3);
  let remainder = values.length % 3;
  let offset = 0;
  for (let index = 0; index < 3; index += 1) {
    const size = baseSize + (remainder > 0 ? 1 : 0);
    remainder -= 1;
    windows.push(values.slice(offset, offset + size));
    offset += size;
  }
  return windows;
};

/** Large-loss-rate and per-token profitability, derived purely from already-simulated trades. */
export const computeTradeQualitySignals = (
  trades: CopySimulationTradeResult[],
): WinnerPolicyTradeQualitySignals => {
  const simulated = trades.filter(
    (trade) => trade.status === 'simulated' && trade.simulatedReturnPercent !== null,
  );
  if (simulated.length === 0) {
    return {
      largeLossRatePercent: null,
      profitableTokenPercent: null,
      simulatedTradeCount: 0,
      distinctTokenCount: 0,
    };
  }
  const largeLossCount = simulated.filter(
    (trade) =>
      trade.simulatedReturnPercent! <= WINNER_POLICY_V2_CONFIG.largeLossReturnThresholdPercent,
  ).length;
  const netByToken = new Map<string, number>();
  for (const trade of simulated) {
    const stakeUsd = trade.copyStakeUsd ?? 0;
    const netUsd = (trade.simulatedReturnPercent! / 100) * stakeUsd;
    netByToken.set(trade.tokenAddress, (netByToken.get(trade.tokenAddress) ?? 0) + netUsd);
  }
  const profitableTokens = [...netByToken.values()].filter((net) => net > 0).length;
  return {
    largeLossRatePercent: (largeLossCount / simulated.length) * 100,
    profitableTokenPercent: (profitableTokens / netByToken.size) * 100,
    simulatedTradeCount: simulated.length,
    distinctTokenCount: netByToken.size,
  };
};

/** Simulated round-trip gas cost as a percentage of stake, derived purely from simulated trades. */
export const computeExecutionFrictionSignals = (
  trades: CopySimulationTradeResult[],
): WinnerPolicyExecutionFrictionSignals => {
  const qualifying = trades.filter(
    (trade) =>
      trade.status === 'simulated' &&
      trade.gasFeeUsd !== null &&
      trade.gasFeeUsd !== undefined &&
      (trade.copyStakeUsd ?? 0) > 0,
  );
  if (qualifying.length === 0) {
    return { gasRatioPercent: null, tradesWithGasData: 0 };
  }
  const totalGasUsd = qualifying.reduce((sum, trade) => sum + (trade.gasFeeUsd ?? 0), 0);
  const totalStakeUsd = qualifying.reduce((sum, trade) => sum + (trade.copyStakeUsd ?? 0), 0);
  return {
    gasRatioPercent: totalStakeUsd > 0 ? (totalGasUsd / totalStakeUsd) * 100 : null,
    tradesWithGasData: qualifying.length,
  };
};

/** Adapt an optional, current-only Chrome-extension GMGN risk-bundle row into evidence. Returns
 *  null when no usable bundle exists -- absence must never be treated as zero risk. */
export const buildGmgnRiskBundleEvidence = (
  stored: StoredGmgnRiskResult | undefined | null,
): GmgnRiskBundleEvidence | null => {
  if (!stored || !stored.available || !stored.metrics) return null;
  const { risk } = normalizeGmgnProfitStat(stored.metrics);
  return {
    fetchedAt: stored.fetchedAt,
    periodLabel: '30d',
    noBuyHoldRatio: risk.noBuyHoldRatio,
    sellPassBuyRatio: risk.sellPassBuyRatio,
    fastTxRatio: risk.fastTxRatio,
    honeypotRatio: null,
    honeypotRatioMissing: true,
  };
};

/** Adapt the existing canonical simulation report into the sole input contract for Winner Policy. */
export const buildWinnerPolicyEvidence = (
  wallet: CopySimulationWalletReport,
  periodDays: number | null = null,
  options: {
    activitySignals?: WinnerPolicyActivitySignals | null;
    riskBundle?: GmgnRiskBundleEvidence | null;
    evaluationTimestamp?: Date;
  } = {},
): WinnerPolicyEvidence => {
  const evaluationTimestamp = options.evaluationTimestamp ?? new Date();
  const evaluationSeconds = Math.floor(evaluationTimestamp.getTime() / 1000);
  const outcomes = (wallet.canonicalCopiedBuyOutcomes ?? [])
    .filter((outcome) => outcome.simulatedReturnRatio !== null)
    .flatMap((outcome) => {
      const source = wallet.trades.find((trade) => trade.buyTradeId === outcome.buyTradeId);
      const observedAt = timestamp(source?.buyAt);
      return observedAt === null
        ? []
        : [
            {
              buyTradeId: outcome.buyTradeId,
              timestamp: observedAt,
              returnPercent: outcome.simulatedReturnRatio! * 100,
            },
          ];
    })
    .sort((left, right) => left.timestamp - right.timestamp || left.buyTradeId - right.buyTradeId);
  const holdouts = splitIntoThree(outcomes).map((window, index) =>
    holdoutFor(index + 1, window, wallet.trades),
  );
  const copiedOutcomeEconomics = outcomes.map((outcome) => ({
    ...outcome,
    netPnlUsd: wallet.portfolio.stakePerTradeUsd * (outcome.returnPercent / 100),
  }));
  const warning =
    wallet.coverageStatus && wallet.coverageStatus !== 'fully_covered'
      ? `Delayed-copy evidence is ${wallet.coverageStatus}: ${wallet.coverageStatusReason ?? 'coverage is not complete.'}`
      : null;
  return {
    source: 'persisted_copy_simulation',
    periodDays,
    recency: {
      halfLifeDays: WINNER_POLICY_RECENCY_HALF_LIFE_DAYS,
      evaluationTimestamp: new Date(evaluationSeconds * 1000).toISOString(),
      oldestEvidenceTimestamp: outcomes.length
        ? new Date(outcomes[0].timestamp * 1000).toISOString()
        : null,
      newestEvidenceTimestamp: outcomes.length
        ? new Date(outcomes[outcomes.length - 1].timestamp * 1000).toISOString()
        : null,
    },
    completedCopiedBuyOutcomes: outcomes.length,
    medianReturnPercent: medianReturn(outcomes),
    recencyWeightedMedianReturnPercent: computeRecencyWeightedMedian(
      outcomes.map((outcome) => ({ value: outcome.returnPercent, timestamp: outcome.timestamp })),
      evaluationSeconds,
    ),
    startingCapitalUsd: wallet.portfolio.startingCapitalUsd,
    endingCapitalUsd: wallet.portfolio.endingCapitalUsd,
    capitalPath: wallet.portfolio.capitalPath ?? [],
    copiedOutcomeEconomics,
    portfolioWithoutBestTradeEndingCapitalUsd:
      wallet.portfolioWithoutBestTradeEndingCapitalUsd ?? null,
    portfolioWithoutUncopyableTradesEndingCapitalUsd:
      wallet.portfolioWithoutUncopyableTradesEndingCapitalUsd ?? null,
    uncopyableTradeCount: wallet.uncopyableTradeCount ?? 0,
    uncopyableProfitDependencyPercent: wallet.uncopyableProfitDependencyPercent ?? 0,
    holdouts,
    coverageStatus: wallet.coverageStatus ?? null,
    feasibility: warning
      ? { status: 'warning', detail: warning }
      : {
          status: 'pass',
          detail: 'No execution-feasibility warning was recorded by the canonical simulation.',
        },
    activitySignals: options.activitySignals ?? null,
    riskBundle: options.riskBundle ?? null,
    tradeQualitySignals: computeTradeQualitySignals(wallet.trades),
    executionFrictionSignals: computeExecutionFrictionSignals(wallet.trades),
    coverageQuality: evaluateCoverageQuality(wallet.trades, evaluationTimestamp),
    provenance: {
      delayedCopy: 'Persisted Dune matches evaluated by the canonical copy simulation.',
      portfolio:
        'Existing fixed-stake canonical copy simulation ($100 start, $10 stake, 10 max open positions).',
      featureSource: 'copytrade_trades and persisted Dune match rows only.',
      patternDiscoveryUsed: false,
      officialGmgnAggregatesUsed: false,
    },
  };
};

export const emptyWinnerPolicyEvidence = (
  periodDays: number | null = null,
): WinnerPolicyEvidence => ({
  source: 'persisted_copy_simulation',
  periodDays,
  recency: {
    halfLifeDays: WINNER_POLICY_RECENCY_HALF_LIFE_DAYS,
    evaluationTimestamp: new Date().toISOString(),
    oldestEvidenceTimestamp: null,
    newestEvidenceTimestamp: null,
  },
  completedCopiedBuyOutcomes: 0,
  medianReturnPercent: null,
  recencyWeightedMedianReturnPercent: null,
  startingCapitalUsd: 100,
  endingCapitalUsd: null,
  capitalPath: [],
  portfolioWithoutUncopyableTradesEndingCapitalUsd: null,
  uncopyableTradeCount: 0,
  uncopyableProfitDependencyPercent: 0,
  holdouts: [],
  coverageStatus: null,
  feasibility: { status: 'unavailable', detail: 'No persisted simulation report exists.' },
  activitySignals: null,
  riskBundle: null,
  tradeQualitySignals: {
    largeLossRatePercent: null,
    profitableTokenPercent: null,
    simulatedTradeCount: 0,
    distinctTokenCount: 0,
  },
  executionFrictionSignals: { gasRatioPercent: null, tradesWithGasData: 0 },
  coverageQuality: evaluateCoverageQuality([]),
  provenance: {
    delayedCopy: 'Persisted Dune matches evaluated by the canonical copy simulation.',
    portfolio: 'Existing fixed-stake canonical copy simulation.',
    featureSource: 'copytrade_trades and persisted Dune match rows only.',
    patternDiscoveryUsed: false,
    officialGmgnAggregatesUsed: false,
  },
});
