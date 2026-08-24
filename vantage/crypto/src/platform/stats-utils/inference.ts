// Pure statistics primitives — no database dependency, deterministic given a seeded RNG.
// Implemented directly in TypeScript rather than shelling out to SciPy/statsmodels: bootstrap
// resampling, an exact sign test, and Holm correction are all simple enough to implement
// correctly in-language, and doing so keeps this project on a single runtime (Node + SQLite)
// rather than introducing a Python subprocess boundary. If a future reviewer wants scipy-grade
// implementations instead, these functions are the seam to swap.

// A small deterministic PRNG (mulberry32) so bootstrap results are reproducible given the same
// seed — important for a research tool where "run it again, get a different confidence interval"
// would undermine trust in the number.
export const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const median = (sorted: number[]): number => {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

export type BootstrapResult = {
  median: number;
  lower: number;
  upper: number;
  confidenceLevel: number;
  iterations: number;
  n: number;
};

/**
 * Percentile-method bootstrap confidence interval for the median. `values` must already be one
 * observation per resampling unit (here: one fresh return per token) — resampling this array
 * with replacement is therefore token-level resampling, not signal-level, as long as the caller
 * has already deduplicated to first-signal-per-token before passing values in.
 */
export const bootstrapMedianCI = (
  values: number[],
  options: { iterations?: number; confidenceLevel?: number; seed?: number } = {},
): BootstrapResult | null => {
  const n = values.length;
  if (n === 0) return null;
  const iterations = options.iterations ?? 2000;
  const confidenceLevel = options.confidenceLevel ?? 0.95;
  const rng = mulberry32(options.seed ?? 20260101);
  const sortedOriginal = [...values].sort((a, b) => a - b);
  const resampleMedians: number[] = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const sample: number[] = new Array(n);
    for (let j = 0; j < n; j++) sample[j] = values[Math.floor(rng() * n)];
    sample.sort((a, b) => a - b);
    resampleMedians[i] = median(sample);
  }
  resampleMedians.sort((a, b) => a - b);
  const alpha = 1 - confidenceLevel;
  const lowerIndex = Math.max(0, Math.floor((alpha / 2) * iterations));
  const upperIndex = Math.min(iterations - 1, Math.ceil((1 - alpha / 2) * iterations) - 1);
  return {
    median: median(sortedOriginal),
    lower: resampleMedians[lowerIndex],
    upper: resampleMedians[upperIndex],
    confidenceLevel,
    iterations,
    n,
  };
};

// log-binomial-coefficient via log-gamma, to keep the exact binomial test numerically stable
// for n in the hundreds without overflowing factorials.
const logGamma = (x: number): number => {
  const g = 7;
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const xx = x - 1;
  let a = coefficients[0];
  const t = xx + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += coefficients[i] / (xx + i);
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
};
const logChoose = (n: number, k: number): number =>
  logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
const binomialPmf = (n: number, k: number, p: number): number => {
  if (k < 0 || k > n) return 0;
  if (p === 0) return k === 0 ? 1 : 0;
  if (p === 1) return k === n ? 1 : 0;
  return Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p));
};

export type SignTestResult = {
  pValue: number;
  nPositive: number;
  nNegative: number;
  nTicked: number;
  nTotal: number;
};

/**
 * Exact two-sided sign test of "is the median return different from zero," under the null that
 * each observation is equally likely to be positive or negative (p=0.5). Exact-zero returns are
 * dropped from the tally (ties carry no directional information), matching the standard sign-test
 * convention. This is the appropriate one-sample test here — we're asking whether one group's
 * returns are skewed away from zero, not comparing two groups against each other.
 */
export const signTest = (values: number[]): SignTestResult => {
  const nPositive = values.filter((v) => v > 0).length;
  const nNegative = values.filter((v) => v < 0).length;
  const nTicked = nPositive + nNegative;
  if (nTicked === 0) return { pValue: 1, nPositive, nNegative, nTicked, nTotal: values.length };
  const k = Math.min(nPositive, nNegative);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += binomialPmf(nTicked, i, 0.5);
  const pValue = Math.min(1, tail * 2);
  return { pValue, nPositive, nNegative, nTicked, nTotal: values.length };
};

export type HolmResult = { adjustedPValues: number[]; rejected: boolean[]; alpha: number };

/**
 * Holm-Bonferroni step-down correction across a family of p-values (e.g. every subgroup/horizon
 * cell tested in one report run). Controls the family-wise error rate without the extra
 * conservatism of a flat Bonferroni correction. Returns results in the SAME order as the input
 * array, not sorted — callers should not need to re-align indices themselves.
 */
export const holmCorrection = (pValues: number[], alpha = 0.05): HolmResult => {
  const m = pValues.length;
  const indexed = pValues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
  const adjustedSorted: number[] = new Array(m);
  let runningMax = 0;
  for (let i = 0; i < m; i++) {
    const candidate = Math.min(1, indexed[i].p * (m - i));
    runningMax = Math.max(runningMax, candidate);
    adjustedSorted[i] = runningMax;
  }
  let rejectedSoFar = true;
  const rejectedSorted: boolean[] = new Array(m);
  for (let i = 0; i < m; i++) {
    rejectedSoFar = rejectedSoFar && indexed[i].p <= alpha / (m - i);
    rejectedSorted[i] = rejectedSoFar;
  }
  const adjustedPValues: number[] = new Array(m);
  const rejected: boolean[] = new Array(m);
  for (let i = 0; i < m; i++) {
    adjustedPValues[indexed[i].index] = adjustedSorted[i];
    rejected[indexed[i].index] = rejectedSorted[i];
  }
  return { adjustedPValues, rejected, alpha };
};
