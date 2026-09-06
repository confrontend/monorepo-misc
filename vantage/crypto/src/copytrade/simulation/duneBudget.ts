export const DUNE_FULL_BATCH_SIZE = 150;
export const DUNE_FULL_BATCH_AVERAGE_CREDITS_PER_TARGET = 0.019121581267501662;
export const DUNE_FULL_BATCH_P90_CREDITS_PER_TARGET = 0.03832254902;
export const DUNE_ALL_BATCH_P90_CREDITS_PER_TARGET = 0.0429460785;

export type DuneBudgetEstimate = {
  targets: number;
  batches: number;
  expectedCredits: number;
  conservativeCredits: number;
};

export const estimateDuneCredits = (targets: number): DuneBudgetEstimate => {
  const normalized = Math.max(0, Math.floor(targets));
  const batches = Math.ceil(normalized / DUNE_FULL_BATCH_SIZE);
  const fullTargets = Math.floor(normalized / DUNE_FULL_BATCH_SIZE) * DUNE_FULL_BATCH_SIZE;
  const remainder = normalized - fullTargets;
  return {
    targets: normalized,
    batches,
    expectedCredits:
      fullTargets * DUNE_FULL_BATCH_AVERAGE_CREDITS_PER_TARGET +
      remainder * DUNE_ALL_BATCH_P90_CREDITS_PER_TARGET,
    conservativeCredits:
      fullTargets * DUNE_FULL_BATCH_P90_CREDITS_PER_TARGET +
      remainder * DUNE_ALL_BATCH_P90_CREDITS_PER_TARGET,
  };
};
