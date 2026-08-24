import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeCopyCandidates,
  computeScreenPassCandidates,
  MIN_MEDIAN_HOLD_SECONDS,
  MAX_FAST_ROUND_TRIP_PERCENT,
  MAX_CONCENTRATION_PERCENT,
  DORMANT_AFTER_DAYS,
  type CopyCandidatesReport,
  type CopySimulationSurvivalInput,
} from '../src/copytrade/scrutiny/copyCandidates.js';
import type { CopyTradeReport, CopyTradeRow, Verdict } from '../src/copytrade/scrutiny/evaluate.js';
import type {
  HistoricalConsistencyReport,
  HistoricalConsistencyVerdict,
} from '../src/copytrade/scrutiny/historicalConsistency.js';

const baseRow = (walletAddress: string, over: Partial<CopyTradeRow> = {}): CopyTradeRow => ({
  walletAddress,
  name: null,
  trades: 200,
  winRatePercent: 60,
  medianReturnPercent: 10,
  averageReturnPercent: 10,
  endingCapitalUsd: 110,
  verdict: 'screen_pass',
  riskFlags: [],
  failedRules: [],
  excludedNoCostBasis: 0,
  endingCapitalUsdCompounded: 110,
  truncated: false,
  coveredDays: 90,
  lastTradeAt: null,
  daysSinceLastTrade: null,
  needsDuneBackfill: false,
  unreliableReason: null,
  riskEvidence: {
    fastRoundTripPercent: 5,
    noCostBasisPercent: 2,
    medianHoldSeconds: 3600,
    fundedByAddress: null,
    walletAgeDays: 300,
  },
  riskNotes: [],
  comparable: true,
  profitConcentration: {
    bestToken: { tokenAddress: 'TOKEN_A', tokenSymbol: 'AAA', trades: 10, profitUsd: 1000 },
    bestThreeTokens: [],
    bestTokenSharePositiveProfitPercent: 15,
    bestThreeSharePositiveProfitPercent: 30,
    bestTradeProfitUsd: 100,
    excludingBestTrade: { trades: 199, medianReturnPercent: 9, endingCapitalUsd: 108 },
    excludingBestToken: { trades: 190, medianReturnPercent: 8, endingCapitalUsd: 105 },
  },
  weeklyPerformance: [],
  monthlyPerformance: [],
  rankHistory: {
    walletAddress,
    leaderboardCaptures: 2,
    appearances: 2,
    topFiveAppearances: 1,
    topFiveMembershipPercent: 50,
    currentRank: 3,
    bestRank: 3,
    worstRank: 3,
    firstObservedAt: null,
    lastObservedAt: null,
  },
  ...over,
});

const report = (rows: CopyTradeRow[]): CopyTradeReport => ({
  computedAt: '2026-08-15T00:00:00.000Z',
  startingCapitalUsd: 100,
  periodDays: 90,
  rows,
  overall: {
    trades: 0,
    winRatePercent: null,
    medianReturnPercent: null,
    averageReturnPercent: null,
    endingCapitalUsd: null,
    endingCapitalUsdCompounded: null,
    unreliableReason: null,
    weighting: 'trade-weighted',
    wallets: rows.length,
  },
  overallByWallet: {
    trades: 0,
    winRatePercent: null,
    medianReturnPercent: null,
    averageReturnPercent: null,
    endingCapitalUsd: null,
    endingCapitalUsdCompounded: null,
    unreliableReason: null,
    weighting: 'wallet-weighted',
    wallets: rows.length,
  },
  rules: { minTrades: 100, minDays: 7, requiresPositiveMedian: true },
  scope: {
    chain: 'sol',
    traderLimit: rows.length,
    rosterSnapshotId: null,
    rosterSize: rows.length,
    methodologyVersion: 'test',
    rosterProvenance: null,
  },
  walletPerformance: { status: 'available', description: '' },
  copySimulation: { status: 'not_available', description: '', requiredInputs: [] },
});

const hcRow = (walletAddress: string, verdict: HistoricalConsistencyVerdict) => ({
  walletAddress,
  availableDays: 90,
  split: 'fixed_60_30' as const,
  splitPointAt: null,
  early: {
    label: 'early' as const,
    startAt: null,
    endAt: null,
    trades: 50,
    summary: {
      trades: 50,
      winRatePercent: 60,
      medianReturnPercent: 8,
      averageReturnPercent: 8,
      endingCapitalUsd: 108,
      endingCapitalUsdCompounded: 108,
    },
    weeklyPerformance: [],
    monthlyPerformance: [],
    weeklyConsistency: { positivePeriods: 4, periodsWithData: 4, positivePercent: 100 },
    profitConcentration: {
      bestToken: null,
      bestThreeTokens: [],
      bestTokenSharePositiveProfitPercent: null,
      bestThreeSharePositiveProfitPercent: null,
      bestTradeProfitUsd: null,
      excludingBestTrade: { trades: 0, medianReturnPercent: null, endingCapitalUsd: null },
      excludingBestToken: { trades: 0, medianReturnPercent: null, endingCapitalUsd: null },
    },
  },
  recent: {
    label: 'recent' as const,
    startAt: null,
    endAt: null,
    trades: 50,
    summary: {
      trades: 50,
      winRatePercent: 60,
      medianReturnPercent: 8,
      averageReturnPercent: 8,
      endingCapitalUsd: 108,
      endingCapitalUsdCompounded: 108,
    },
    weeklyPerformance: [],
    monthlyPerformance: [],
    weeklyConsistency: { positivePeriods: 4, periodsWithData: 4, positivePercent: 100 },
    profitConcentration: {
      bestToken: null,
      bestThreeTokens: [],
      bestTokenSharePositiveProfitPercent: null,
      bestThreeSharePositiveProfitPercent: null,
      bestTradeProfitUsd: null,
      excludingBestTrade: { trades: 0, medianReturnPercent: null, endingCapitalUsd: null },
      excludingBestToken: { trades: 0, medianReturnPercent: null, endingCapitalUsd: null },
    },
  },
  verdict,
});

const hcReport = (rows: ReturnType<typeof hcRow>[]): HistoricalConsistencyReport => ({
  computedAt: '2026-08-15T00:00:00.000Z',
  rules: { minimumHistoryDays: 30, fixedHistoryDays: 90, recentDays: 30, description: '' },
  totalWallets: rows.length,
  counts: {
    consistent: 0,
    declining: 0,
    recent_only: 0,
    consistently_negative: 0,
    insufficient: 0,
  },
  rows,
});

/** Every wallet named here is given a healthy copy-simulation result, so tests about the
 *  earlier gates (screen/hc/hold/fastRT/concentration) aren't confounded by the new
 *  copy-survival gate this test file didn't set out to exercise. */
const survives = (...walletAddresses: string[]): Map<string, CopySimulationSurvivalInput> =>
  new Map(
    walletAddresses.map((walletAddress) => [
      walletAddress,
      { simulatedMedianReturnPercent: 10, coverageRatePercent: 100 },
    ]),
  );

test('a wallet passing every gate becomes a winner, with the GMGN profile URL built from its address', () => {
  const result = computeCopyCandidates(
    report([baseRow('W1')]),
    hcReport([hcRow('W1', 'consistent')]),
    survives('W1'),
  );
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].gmgnProfileUrl, 'https://gmgn.ai/sol/address/W1');
  assert.equal(result.candidates[0].copySurvivalStatus, 'survives');
  assert.equal(result.excludedCount, 0);
});

test('a non-screen_pass wallet never becomes a winner, even with perfect risk evidence', () => {
  const result = computeCopyCandidates(
    report([baseRow('W1', { verdict: 'thin' as Verdict })]),
    hcReport([hcRow('W1', 'consistent')]),
    survives('W1'),
  );
  assert.equal(result.candidates.length, 0);
});

test('requires historical-consistency verdict exactly "consistent" — recent_only and declining are excluded', () => {
  const result = computeCopyCandidates(
    report([baseRow('W1'), baseRow('W2'), baseRow('W3')]),
    hcReport([hcRow('W1', 'recent_only'), hcRow('W2', 'declining'), hcRow('W3', 'consistent')]),
    survives('W1', 'W2', 'W3'),
  );
  assert.deepEqual(
    result.candidates.map((c) => c.walletAddress),
    ['W3'],
  );
});

test(`a wallet with a median hold under ${MIN_MEDIAN_HOLD_SECONDS}s is excluded even with a great return`, () => {
  const result = computeCopyCandidates(
    report([
      baseRow('FAST', {
        medianReturnPercent: 500,
        riskEvidence: {
          fastRoundTripPercent: 1,
          noCostBasisPercent: 0,
          medianHoldSeconds: MIN_MEDIAN_HOLD_SECONDS - 1,
          fundedByAddress: null,
          walletAgeDays: 300,
        },
      }),
    ]),
    hcReport([hcRow('FAST', 'consistent')]),
    survives('FAST'),
  );
  assert.equal(result.candidates.length, 0);
  assert.equal(result.excludedCount, 1);
});

test(`a wallet with fast-round-trip over ${MAX_FAST_ROUND_TRIP_PERCENT}% is excluded`, () => {
  const result = computeCopyCandidates(
    report([
      baseRow('MECH', {
        riskEvidence: {
          fastRoundTripPercent: MAX_FAST_ROUND_TRIP_PERCENT + 1,
          noCostBasisPercent: 0,
          medianHoldSeconds: 3600,
          fundedByAddress: null,
          walletAgeDays: 300,
        },
      }),
    ]),
    hcReport([hcRow('MECH', 'consistent')]),
    survives('MECH'),
  );
  assert.equal(result.candidates.length, 0);
});

test(`a wallet whose best token is over ${MAX_CONCENTRATION_PERCENT}% of profit is excluded`, () => {
  const result = computeCopyCandidates(
    report([
      baseRow('LUCKY', {
        profitConcentration: {
          bestToken: { tokenAddress: 'X', tokenSymbol: 'X', trades: 1, profitUsd: 1 },
          bestThreeTokens: [],
          bestTokenSharePositiveProfitPercent: MAX_CONCENTRATION_PERCENT + 1,
          bestThreeSharePositiveProfitPercent: 90,
          bestTradeProfitUsd: 1,
          excludingBestTrade: { trades: 0, medianReturnPercent: null, endingCapitalUsd: null },
          excludingBestToken: { trades: 0, medianReturnPercent: null, endingCapitalUsd: null },
        },
      }),
    ]),
    hcReport([hcRow('LUCKY', 'consistent')]),
    survives('LUCKY'),
  );
  assert.equal(result.candidates.length, 0);
});

test('winners are sorted by median return descending, after every gate already qualified them', () => {
  const result = computeCopyCandidates(
    report([
      baseRow('LOW', { medianReturnPercent: 5 }),
      baseRow('HIGH', { medianReturnPercent: 50 }),
      baseRow('MID', { medianReturnPercent: 20 }),
    ]),
    hcReport([hcRow('LOW', 'consistent'), hcRow('HIGH', 'consistent'), hcRow('MID', 'consistent')]),
    survives('LOW', 'HIGH', 'MID'),
  );
  assert.deepEqual(
    result.candidates.map((c) => c.walletAddress),
    ['HIGH', 'MID', 'LOW'],
  );
});

test('a fast, mechanical, but high-return wallet ranks behind a slower, cleaner one that qualified — speed can never win by outranking a gate', () => {
  const result = computeCopyCandidates(
    report([
      baseRow('FAST_HIGH', {
        medianReturnPercent: 500,
        riskEvidence: {
          fastRoundTripPercent: 60,
          noCostBasisPercent: 0,
          medianHoldSeconds: 10,
          fundedByAddress: null,
          walletAgeDays: 300,
        },
      }),
      baseRow('SLOW_MODEST', { medianReturnPercent: 12 }),
    ]),
    hcReport([hcRow('FAST_HIGH', 'consistent'), hcRow('SLOW_MODEST', 'consistent')]),
    survives('FAST_HIGH', 'SLOW_MODEST'),
  );
  assert.deepEqual(
    result.candidates.map((c) => c.walletAddress),
    ['SLOW_MODEST'],
    'FAST_HIGH must be gated out entirely, never merely ranked lower',
  );
});

test('a wallet missing from the historical-consistency report at all is excluded, not silently passed', () => {
  const result: CopyCandidatesReport = computeCopyCandidates(
    report([baseRow('NO_HC')]),
    hcReport([]),
    survives('NO_HC'),
  );
  assert.equal(result.candidates.length, 0);
});

test('screenedCount reflects the full report population, independent of how many became winners', () => {
  const result = computeCopyCandidates(
    report([
      baseRow('W1'),
      baseRow('W2', { verdict: 'thin' as Verdict }),
      baseRow('W3', { verdict: 'flagged' as Verdict }),
    ]),
    hcReport([hcRow('W1', 'consistent')]),
    survives('W1'),
  );
  assert.equal(result.screenedCount, 3);
  assert.equal(result.candidates.length, 1);
});

test('a wallet passing every other gate is excluded by default when no copy-simulation data is passed at all — the gate fails closed', () => {
  const result = computeCopyCandidates(
    report([baseRow('W1')]),
    hcReport([hcRow('W1', 'consistent')]),
  );
  assert.equal(
    result.candidates.length,
    0,
    'omitting the copy-simulation map entirely must not silently pass everyone',
  );
});

test('a wallet with no entry in the copy-simulation map is excluded as not_yet_simulated, not silently passed', () => {
  const screenReport = report([baseRow('W1')]);
  const hc = hcReport([hcRow('W1', 'consistent')]);
  const result = computeCopyCandidates(screenReport, hc, new Map());
  assert.equal(result.candidates.length, 0);
  // Confirm it really did clear every other gate, so the copy-survival gate is what's excluding it.
  assert.equal(computeScreenPassCandidates(screenReport, hc).candidates.length, 1);
});

test('a wallet with a non-positive simulated median is excluded as fails_copy_survival', () => {
  const result = computeCopyCandidates(
    report([baseRow('W1')]),
    hcReport([hcRow('W1', 'consistent')]),
    new Map([['W1', { simulatedMedianReturnPercent: 0, coverageRatePercent: 80 }]]),
  );
  assert.equal(result.candidates.length, 0, 'exactly 0% or negative must not survive');
});

test('a wallet that was queried but got no usable match at all (null simulated median) is not_yet_simulated, not treated as passing', () => {
  const result = computeCopyCandidates(
    report([baseRow('W1')]),
    hcReport([hcRow('W1', 'consistent')]),
    new Map([['W1', { simulatedMedianReturnPercent: null, coverageRatePercent: 0 }]]),
  );
  assert.equal(result.candidates.length, 0);
});

test('a wallet with a positive simulated median survives and carries its simulation fields into the report', () => {
  const result = computeCopyCandidates(
    report([baseRow('W1')]),
    hcReport([hcRow('W1', 'consistent')]),
    new Map([['W1', { simulatedMedianReturnPercent: 12.5, coverageRatePercent: 64.7 }]]),
  );
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].copySurvivalStatus, 'survives');
  assert.equal(result.candidates[0].simulatedMedianReturnPercent, 12.5);
  assert.equal(result.candidates[0].copySimulationCoverageRatePercent, 64.7);
});

test('tail metrics are carried onto candidates without changing the median-only survival gate', () => {
  const result = computeCopyCandidates(
    report([baseRow('TAIL')]),
    hcReport([hcRow('TAIL', 'consistent')]),
    new Map([
      [
        'TAIL',
        {
          simulatedMedianReturnPercent: -4.5,
          simulatedMeanReturnPercent: 51.4,
          tradesAbove100Percent: 17,
          tailShareOfMeanPercent: 95,
          coverageRatePercent: 84,
        },
      ],
    ]),
  );
  assert.equal(
    result.candidates.length,
    0,
    'a positive mean must not bypass the existing positive-median gate',
  );
  const screened = computeScreenPassCandidates(
    report([baseRow('TAIL')]),
    hcReport([hcRow('TAIL', 'consistent')]),
  ).candidates[0];
  assert.equal(screened.walletAddress, 'TAIL');
  const withSurvival = computeCopyCandidates(
    report([baseRow('TAIL')]),
    hcReport([hcRow('TAIL', 'consistent')]),
    new Map([
      [
        'TAIL',
        {
          simulatedMedianReturnPercent: 5,
          simulatedMeanReturnPercent: 51.4,
          tradesAbove100Percent: 17,
          tailShareOfMeanPercent: 95,
          coverageRatePercent: 84,
        },
      ],
    ]),
  ).candidates[0];
  assert.equal(withSurvival.simulatedMeanReturnPercent, 51.4);
  assert.equal(withSurvival.tradesAbove100Percent, 17);
  assert.equal(withSurvival.tailShareOfMeanPercent, 95);
});

test('high-upside candidates are reported separately when mean is positive but median is not', () => {
  const result = computeCopyCandidates(
    report([
      baseRow('TAIL', { medianReturnPercent: -4, averageReturnPercent: 42 }),
      baseRow('CONSISTENT', { medianReturnPercent: 8, averageReturnPercent: 12 }),
    ]),
    hcReport([hcRow('TAIL', 'consistent'), hcRow('CONSISTENT', 'consistent')]),
    new Map([
      [
        'TAIL',
        {
          simulatedMedianReturnPercent: -2,
          simulatedMeanReturnPercent: 38,
          tradesAbove100Percent: 2,
          coverageRatePercent: 82,
        },
      ],
      [
        'CONSISTENT',
        {
          simulatedMedianReturnPercent: 7,
          simulatedMeanReturnPercent: 11,
          tradesAbove100Percent: 0,
          coverageRatePercent: 90,
        },
      ],
    ]),
  );
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.walletAddress),
    ['CONSISTENT'],
  );
  assert.deepEqual(
    result.highUpsideCandidates.map((candidate) => candidate.walletAddress),
    ['TAIL'],
  );
  assert.equal(result.highUpsideCandidates[0]?.simulatedMeanReturnPercent, 38);
});

test('high-upside candidates fail closed without enough copy coverage or a large winning trade', () => {
  const result = computeCopyCandidates(
    report([baseRow('TAIL', { medianReturnPercent: -4, averageReturnPercent: 42 })]),
    hcReport([hcRow('TAIL', 'consistent')]),
    new Map([
      [
        'TAIL',
        {
          simulatedMedianReturnPercent: -2,
          simulatedMeanReturnPercent: 38,
          tradesAbove100Percent: 0,
          coverageRatePercent: 69,
        },
      ],
    ]),
  );
  assert.equal(result.highUpsideCandidates.length, 0);
});

test('computeScreenPassCandidates does not require or apply the copy-survival gate at all', () => {
  const result = computeScreenPassCandidates(
    report([baseRow('W1')]),
    hcReport([hcRow('W1', 'consistent')]),
  );
  assert.equal(
    result.candidates.length,
    1,
    'the pre-gate list exists precisely so copy-simulation knows who to check, before any verdict exists',
  );
});

test('a wallet that stopped trading is flagged dormant but keeps its real historical numbers', () => {
  // The real case: this project's own top wallet held a +13.8% median over 398 round trips while
  // having no activity for over two weeks. Its history is genuine; presenting it as a live,
  // actionable candidate with nothing marking it dormant is what was misleading.
  const stale = computeCopyCandidates(
    report([baseRow('W1', { daysSinceLastTrade: DORMANT_AFTER_DAYS + 1 })]),
    hcReport([hcRow('W1', 'consistent')]),
    new Map([['W1', { simulatedMedianReturnPercent: 12.5, coverageRatePercent: 80 }]]),
  );
  assert.equal(
    stale.candidates.length,
    1,
    'a dormant wallet is still reported, never silently dropped',
  );
  assert.equal(stale.candidates[0].dormant, true);
  assert.equal(stale.candidates[0].daysSinceLastTrade, DORMANT_AFTER_DAYS + 1);
  assert.equal(
    stale.candidates[0].medianReturnPercent,
    10,
    'its measured history is untouched by the dormancy flag',
  );

  const active = computeCopyCandidates(
    report([baseRow('W1', { daysSinceLastTrade: 1 })]),
    hcReport([hcRow('W1', 'consistent')]),
    new Map([['W1', { simulatedMedianReturnPercent: 12.5, coverageRatePercent: 80 }]]),
  );
  assert.equal(active.candidates[0].dormant, false, 'a recently-active wallet is not flagged');

  const unknown = computeCopyCandidates(
    report([baseRow('W1', { daysSinceLastTrade: null })]),
    hcReport([hcRow('W1', 'consistent')]),
    new Map([['W1', { simulatedMedianReturnPercent: 12.5, coverageRatePercent: 80 }]]),
  );
  assert.equal(
    unknown.candidates[0].dormant,
    false,
    'unknown recency is never asserted as dormant',
  );
});
