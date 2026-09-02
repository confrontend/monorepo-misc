import type {
  CurrentWalletFeatures,
  WalletDecisionCompatibilityMetrics,
} from './walletFeatureEngine.js';

export type WalletFeatureQuality = {
  rowsExamined: number;
  contextRowsExamined: number;
  sellRowsExamined: number;
  returnRowsIncluded: number;
  rowsExcludedNoCostBasis: number;
  holdsPaired: number;
  sellsWithoutPriorBuyContext: number;
  oldestObservedAt: string | null;
  newestObservedAt: string | null;
  requestedWindowStart: string | null;
  requestedWindowEnd: string | null;
};

export const buildWalletFeatureQuality = (input: {
  rowsExamined: number;
  contextRowsExamined: number;
  oldestObservedAt: string | null;
  newestObservedAt: string | null;
  requestedWindowStart: string | null;
  requestedWindowEnd: string | null;
  features: CurrentWalletFeatures;
  decisionMetrics: WalletDecisionCompatibilityMetrics;
}): WalletFeatureQuality => ({
  rowsExamined: input.rowsExamined,
  contextRowsExamined: input.contextRowsExamined,
  sellRowsExamined: input.decisionMetrics.sellCount,
  returnRowsIncluded: input.decisionMetrics.completedTrades,
  rowsExcludedNoCostBasis: input.decisionMetrics.excludedNoCostBasis,
  holdsPaired: input.features.priorWalletPairedTradeCount,
  sellsWithoutPriorBuyContext: Math.max(
    0,
    input.decisionMetrics.sellCount - input.features.priorWalletPairedTradeCount,
  ),
  oldestObservedAt: input.oldestObservedAt,
  newestObservedAt: input.newestObservedAt,
  requestedWindowStart: input.requestedWindowStart,
  requestedWindowEnd: input.requestedWindowEnd,
});
