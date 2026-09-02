/**
 * Pure contract for reducing the exit fragments of one original buy to one
 * copied-buy outcome.
 *
 * Compatibility notes:
 * - copySimulation.ts pairs activity FIFO and assigns each sell fragment the
 *   fraction of the original buy that it consumes. This module deliberately
 *   accepts that already-paired representation; it does not create another
 *   pairing rule.
 * - The simulator calculates a delayed return from matched Dune prices after
 *   fees and slippage. `simulatedReturnRatio` is therefore an input, rather
 *   than being recomputed here with a possibly different financial definition.
 * - The existing simulator uses `buy_cost_usd` from the sell activity row to
 *   calculate the wallet's own return. A missing value is reported, but it
 *   does not invalidate an otherwise usable delayed-copy return, because that
 *   return is based on Dune prices instead.
 */

export type CanonicalCopiedBuy = {
  tradeId: number;
};

export type CanonicalCopiedExitFragment = {
  /** Local sell activity id. It is also the deterministic tie-breaker. */
  sellTradeId: number;
  /** Null means the sell could not be paired to a local original buy. */
  buyTradeId: number | null;
  /** Fraction of the original buy consumed by this sell, as assigned by FIFO pairing. */
  copyFraction: number | null;
  /** Whether the delayed copier buy leg has a usable Dune match. */
  entryMatched: boolean;
  /** Whether the delayed copier sell leg has a usable Dune match. */
  exitMatched: boolean;
  /** Canonical delayed-copy return ratio after the simulator's fees/slippage. */
  simulatedReturnRatio: number | null;
  /** Existing wallet-return input, when it can be calculated from activity. */
  walletReturnRatio?: number | null;
  /** `buy_cost_usd` from the activity sell row used by the existing simulator. */
  buyCostUsd?: number | null;
};

export type CanonicalCopiedBuyPosition = {
  buyTradeId: number;
  /** Remaining FIFO fraction at the cutoff. */
  remainingFraction: number;
};

export type CanonicalCopiedBuyExclusionReason =
  | 'unmatched_sell'
  | 'unknown_buy'
  | 'unmatched_buy_leg'
  | 'unmatched_sell_leg'
  | 'invalid_copy_fraction'
  | 'missing_simulated_return';

export type CanonicalCopiedBuyExclusionCounts = Record<CanonicalCopiedBuyExclusionReason, number>;

export type CanonicalCopiedBuyOutcome = {
  buyTradeId: number;
  /** Number of sell fragments linked to this buy, including excluded fragments. */
  exitFragmentCount: number;
  /** Number of fragments contributing to the weighted result. */
  matchedExitFragmentCount: number;
  /** Sum of the contributing fragments' copy fractions. */
  copiedFraction: number;
  /** copy-fraction-weighted delayed-copy return ratio; null when no fragment is usable. */
  simulatedReturnRatio: number | null;
  /** True when at least one fragment was present but not all were usable. */
  partiallyMatched: boolean;
};

export type CanonicalCopiedBuyDiagnostics = {
  /** Buys plus sell fragments supplied to the pure contract. */
  activitiesExamined: number;
  /** Usable matched exit fragments, not raw activity rows. */
  matchedRoundTrips: number;
  /** Buys with no linked exit and no open position. */
  unmatchedBuys: number;
  /** Sell fragments that cannot be associated with a known buy. */
  unmatchedSells: number;
  /** Linked sell fragments without the activity cost used for wallet return. */
  sellsWithMissingBuyCost: number;
  /** Buys with a positive remaining fraction at the cutoff. */
  openPositions: number;
  /** Buys with more than one linked sell fragment. */
  sameBuyMultipleExits: number;
  /** Total linked sell fragments beyond the first for those buys. */
  additionalExitsForMultiExitBuys: number;
  /** Fragments excluded from the aggregated delayed-copy result. */
  excludedRecords: number;
  excludedByReason: CanonicalCopiedBuyExclusionCounts;
};

export type CanonicalCopiedBuyAggregation = {
  outcomes: CanonicalCopiedBuyOutcome[];
  diagnostics: CanonicalCopiedBuyDiagnostics;
};

const EPSILON = 1e-9;

const emptyExclusionCounts = (): CanonicalCopiedBuyExclusionCounts => ({
  unmatched_sell: 0,
  unknown_buy: 0,
  unmatched_buy_leg: 0,
  unmatched_sell_leg: 0,
  invalid_copy_fraction: 0,
  missing_simulated_return: 0,
});

const isFiniteNumber = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);

const isValidCopyFraction = (value: number | null): value is number =>
  isFiniteNumber(value) && value > EPSILON && value <= 1 + EPSILON;

const incrementExclusion = (
  counts: CanonicalCopiedBuyExclusionCounts,
  reason: CanonicalCopiedBuyExclusionReason,
): void => {
  counts[reason] += 1;
};

/**
 * Aggregate one output row per original buy while retaining an auditable
 * diagnostic count for every input record that could not contribute.
 *
 * Inputs are sorted by ids before grouping and output, so callers get stable
 * results even when database rows arrive in a different order. The weighted
 * result is `sum(simulatedReturnRatio * copyFraction) /
 * sum(copyFraction)`, matching the simulator's position-size allocation.
 */
export const aggregateCanonicalCopiedBuyOutcomes = (
  buys: readonly CanonicalCopiedBuy[],
  exitFragments: readonly CanonicalCopiedExitFragment[],
  openPositions: readonly CanonicalCopiedBuyPosition[] = [],
): CanonicalCopiedBuyAggregation => {
  const sortedBuys = [...buys].sort((left, right) => left.tradeId - right.tradeId);
  const sortedFragments = [...exitFragments].sort(
    (left, right) =>
      (left.buyTradeId ?? Number.MAX_SAFE_INTEGER) -
        (right.buyTradeId ?? Number.MAX_SAFE_INTEGER) || left.sellTradeId - right.sellTradeId,
  );
  const openByBuy = new Map<number, CanonicalCopiedBuyPosition>();
  for (const position of openPositions) {
    if (position.remainingFraction > EPSILON) openByBuy.set(position.buyTradeId, position);
  }
  const knownBuys = new Set(sortedBuys.map((buy) => buy.tradeId));
  const fragmentsByBuy = new Map<number, CanonicalCopiedExitFragment[]>();
  const excludedByReason = emptyExclusionCounts();
  let unmatchedSells = 0;
  let sellsWithMissingBuyCost = 0;
  let excludedRecords = 0;
  let matchedRoundTrips = 0;

  const exclude = (reason: CanonicalCopiedBuyExclusionReason): void => {
    excludedRecords += 1;
    incrementExclusion(excludedByReason, reason);
  };

  for (const fragment of sortedFragments) {
    if (fragment.buyTradeId === null) {
      unmatchedSells += 1;
      exclude('unmatched_sell');
      continue;
    }
    if (!knownBuys.has(fragment.buyTradeId)) {
      unmatchedSells += 1;
      exclude('unknown_buy');
      continue;
    }
    const linked = fragmentsByBuy.get(fragment.buyTradeId) ?? [];
    linked.push(fragment);
    fragmentsByBuy.set(fragment.buyTradeId, linked);

    if (!isFiniteNumber(fragment.buyCostUsd)) sellsWithMissingBuyCost += 1;

    if (!fragment.entryMatched) {
      exclude('unmatched_buy_leg');
      continue;
    }
    if (!fragment.exitMatched) {
      exclude('unmatched_sell_leg');
      continue;
    }
    if (!isValidCopyFraction(fragment.copyFraction)) {
      exclude('invalid_copy_fraction');
      continue;
    }
    if (!isFiniteNumber(fragment.simulatedReturnRatio)) {
      exclude('missing_simulated_return');
      continue;
    }
    matchedRoundTrips += 1;
  }

  let unmatchedBuys = 0;
  let sameBuyMultipleExits = 0;
  let additionalExitsForMultiExitBuys = 0;
  const outcomes: CanonicalCopiedBuyOutcome[] = [];

  for (const buy of sortedBuys) {
    const fragments = fragmentsByBuy.get(buy.tradeId) ?? [];
    const openPosition = openByBuy.has(buy.tradeId);
    if (fragments.length === 0 && !openPosition) unmatchedBuys += 1;
    if (fragments.length > 1) {
      sameBuyMultipleExits += 1;
      additionalExitsForMultiExitBuys += fragments.length - 1;
    }

    let copiedFraction = 0;
    let weightedReturn = 0;
    let matchedExitFragmentCount = 0;
    for (const fragment of fragments) {
      if (
        fragment.entryMatched &&
        fragment.exitMatched &&
        isValidCopyFraction(fragment.copyFraction) &&
        isFiniteNumber(fragment.simulatedReturnRatio)
      ) {
        copiedFraction += fragment.copyFraction;
        weightedReturn += fragment.simulatedReturnRatio * fragment.copyFraction;
        matchedExitFragmentCount += 1;
      }
    }

    outcomes.push({
      buyTradeId: buy.tradeId,
      exitFragmentCount: fragments.length,
      matchedExitFragmentCount,
      copiedFraction,
      simulatedReturnRatio: copiedFraction > EPSILON ? weightedReturn / copiedFraction : null,
      partiallyMatched: fragments.length > 0 && matchedExitFragmentCount < fragments.length,
    });
  }

  return {
    outcomes,
    diagnostics: {
      activitiesExamined: sortedBuys.length + sortedFragments.length,
      matchedRoundTrips,
      unmatchedBuys,
      unmatchedSells,
      sellsWithMissingBuyCost,
      openPositions: openByBuy.size,
      sameBuyMultipleExits,
      additionalExitsForMultiExitBuys,
      excludedRecords,
      excludedByReason,
    },
  };
};
