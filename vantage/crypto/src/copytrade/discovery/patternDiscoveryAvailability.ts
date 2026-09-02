export type PatternDiscoveryHistoryAvailability = {
  available: boolean;
  periodDays: number;
  totalWallets: number;
  coveredWallets: number;
  excludedWallets: number;
  reason: string | null;
};

/**
 * Pattern Discovery operates on the covered subset itself, so it must not inherit the Data
 * workflow's 90% completeness target. That threshold is an ingestion-quality goal, not a
 * statistical prerequisite for starting a discovery run.
 */
export const assessPatternDiscoveryHistoryAvailability = (options: {
  periodDays: number;
  totalWallets: number;
  coveredWallets: number;
}): PatternDiscoveryHistoryAvailability => {
  const { periodDays, totalWallets, coveredWallets } = options;
  if (!Number.isInteger(periodDays) || periodDays <= 0)
    throw new RangeError('periodDays must be a positive integer.');
  if (!Number.isInteger(totalWallets) || totalWallets < 0)
    throw new RangeError('totalWallets must be a non-negative integer.');
  if (!Number.isInteger(coveredWallets) || coveredWallets < 0 || coveredWallets > totalWallets)
    throw new RangeError('coveredWallets must be between zero and totalWallets.');

  const excludedWallets = totalWallets - coveredWallets;
  if (totalWallets === 0) {
    return {
      available: false,
      periodDays,
      totalWallets,
      coveredWallets,
      excludedWallets,
      reason: 'Pattern Discovery requires at least one wallet in the saved GMGN roster.',
    };
  }
  if (coveredWallets === 0) {
    return {
      available: false,
      periodDays,
      totalWallets,
      coveredWallets,
      excludedWallets,
      reason: `No wallet has completed ${periodDays}-day history yet.`,
    };
  }
  return {
    available: true,
    periodDays,
    totalWallets,
    coveredWallets,
    excludedWallets,
    reason: null,
  };
};
