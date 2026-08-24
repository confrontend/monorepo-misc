import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/platform/db/client.js';
import { applyMigrations } from '../src/platform/db/schema.js';
import {
  computeEliminationReport, estimateDuneRefetchDuration, ELIMINATION_MIN_TRADES,
  ELIMINATION_MIN_DUNE_ROUND_TRIPS, ELIMINATION_STATS_MAX_AGE_HOURS,
  STRONGLY_NEGATIVE_PNL_PERCENT, TRUSTED_DUNE_COVERAGE_PERCENT,
} from '../src/copytrade/scrutiny/eliminationFilter.js';
import { DEFAULT_COPIER_DELAY_SECONDS, type CopySimulationTradeResult, type CopySimulationWalletReport } from '../src/copytrade/simulation/copySimulation.js';
import { assessCoverageGap } from '../src/copytrade/scrutiny/candidateScrutiny.js';
import { RULES, type CopyTradeRow, type Verdict } from '../src/copytrade/scrutiny/evaluate.js';

const baseRow = (walletAddress: string, over: Partial<CopyTradeRow> = {}): CopyTradeRow => ({
  walletAddress, name: null, trades: ELIMINATION_MIN_TRADES, winRatePercent: 60, medianReturnPercent: 10,
  averageReturnPercent: 10, endingCapitalUsd: 110, verdict: 'screen_pass',
  riskFlags: [], failedRules: [], excludedNoCostBasis: 0, endingCapitalUsdCompounded: 110,
  truncated: false, coveredDays: 90, lastTradeAt: null, daysSinceLastTrade: null,
  needsDuneBackfill: false, unreliableReason: null,
  riskEvidence: { fastRoundTripPercent: 5, noCostBasisPercent: 2, medianHoldSeconds: 3600, fundedByAddress: null, walletAgeDays: 300 },
  riskNotes: [], comparable: true,
  profitConcentration: {
    bestToken: null, bestThreeTokens: [], bestTokenSharePositiveProfitPercent: null, bestThreeSharePositiveProfitPercent: null,
    bestTradeProfitUsd: null, excludingBestTrade: { trades: 0, medianReturnPercent: null, endingCapitalUsd: null },
    excludingBestToken: { trades: 0, medianReturnPercent: null, endingCapitalUsd: null },
  },
  weeklyPerformance: [], monthlyPerformance: [],
  rankHistory: { walletAddress, leaderboardCaptures: 2, appearances: 2, topFiveAppearances: 1, topFiveMembershipPercent: 50, currentRank: 3, bestRank: 3, worstRank: 3, firstObservedAt: null, lastObservedAt: null },
  ...over,
});

const fixtureTrade = (status: 'simulated' | 'not_yet_queried', walletReturnPercent: number | null): CopySimulationTradeResult => ({
  tokenAddress: 'T', tokenSymbol: 'T', walletReturnPercent, simulatedReturnPercent: null,
  status, entryGapSeconds: null, exitGapSeconds: null, gasFeeSol: null,
  entryTradeAmountUsd: null, exitTradeAmountUsd: null,
});

const baseSim = (walletAddress: string, over: Partial<CopySimulationWalletReport> = {}): CopySimulationWalletReport => ({
  walletAddress, roundTripsConsidered: 100, copiedTrades: 100, missedTrades: 0, coverageRatePercent: 100,
  walletMedianReturnPercent: 10, simulatedMedianReturnPercent: 5, walletMeanReturnPercent: 10, simulatedMeanReturnPercent: 5,
  tradesAbove100Percent: 0, tradesAbove300Percent: 0, bestSimulatedReturnPercent: 20, tailShareOfMeanPercent: null,
  delayCostPercentagePoints: -5, worstSimulatedReturnPercent: -10, totalGasFeeSol: 0.1,
  gasCostComplete: true,
  portfolio: {
    startingCapitalUsd: 100, stakePerTradeUsd: 10, maxOpenPositions: 10, endingCapitalUsd: 110, realizedPnlUsd: 10,
    eligibleTrades: 100, copiedTrades: 100, skippedInsufficientCash: 0, skippedMaxOpenPositions: 0,
    maxConcurrentPositions: 1, gasFeeSol: 0.1, capitalPath: [],
  },
  // A fully-matched trade list by default, so the shared fixture represents a wallet with no
  // coverage gap at all. `trustworthy` now requires a readable hidden-loss verdict, and an
  // empty list would make every fixture unassessable for reasons unrelated to what it tests.
  trades: Array.from({ length: 20 }, () => fixtureTrade('simulated', 10)),
  ...over,
});

const setup = (): DatabaseSync => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  return database;
};

test('a wallet at mid-range Dune coverage is never eliminated, however bad it looks', () => {
  const row = baseRow('MID_COVERAGE', { gmgnAggregate: { period: '30d', fetchedAt: '2026-08-22T00:00:00.000Z', realizedProfit: -1000, realizedProfitPnlPercent: -80, nativeBalance: null, buyCount: null, sellCount: null, boughtCost: null, soldIncome: null, boughtFee: null, soldFee: null, totalCost: null, lastTimestamp: null, tokenCount: null, winRatePercent: null, averageHoldingPeriodSeconds: null } });
  const sim = baseSim('MID_COVERAGE', { coverageRatePercent: 55, missedTrades: 45, simulatedMedianReturnPercent: -30 });
  const result = computeEliminationReport([row], new Map([['MID_COVERAGE', sim]]));
  assert.equal(result.eliminated.length, 0);
  assert.equal(result.surviving.length, 1);
  assert.equal(result.surviving[0]?.trustworthy, false);
});

test('a fully covered wallet with a strongly negative 30-day PnL is eliminated', () => {
  // Pinned `now` right after fetchedAt — this test checks freshness accepts a fresh snapshot,
  // not real wall-clock elapsed time. An earlier version omitted `now` and relied on real time
  // staying within 24h of a hardcoded fetchedAt, which made the test fail on its own months
  // later purely because time passed, with nothing about the code having changed.
  const now = new Date('2026-08-22T00:30:00.000Z');
  const row = baseRow('BAD_PNL', { gmgnAggregate: { period: '30d', fetchedAt: '2026-08-22T00:00:00.000Z', realizedProfit: -1000, realizedProfitPnlPercent: STRONGLY_NEGATIVE_PNL_PERCENT - 5, nativeBalance: null, buyCount: null, sellCount: null, boughtCost: null, soldIncome: null, boughtFee: null, soldFee: null, totalCost: null, lastTimestamp: null, tokenCount: null, winRatePercent: null, averageHoldingPeriodSeconds: null } });
  const sim = baseSim('BAD_PNL', { coverageRatePercent: TRUSTED_DUNE_COVERAGE_PERCENT });
  const result = computeEliminationReport([row], new Map([['BAD_PNL', sim]]), now);
  assert.equal(result.eliminated.length, 1);
  assert.deepEqual(result.eliminated[0]?.reasons, ['strongly_negative_30d_pnl']);
});

test('a fully covered wallet with a negative delayed-copy result is eliminated', () => {
  const row = baseRow('BAD_COPY');
  const sim = baseSim('BAD_COPY', { coverageRatePercent: 100, simulatedMedianReturnPercent: -1 });
  const result = computeEliminationReport([row], new Map([['BAD_COPY', sim]]));
  assert.equal(result.eliminated.length, 1);
  assert.deepEqual(result.eliminated[0]?.reasons, ['negative_delayed_copy_result']);
});

test('a fully covered wallet whose hold time is shorter than the copy delay is eliminated', () => {
  const row = baseRow('TOO_FAST', { riskEvidence: { fastRoundTripPercent: 5, noCostBasisPercent: 2, medianHoldSeconds: DEFAULT_COPIER_DELAY_SECONDS - 1, fundedByAddress: null, walletAgeDays: 300 } });
  const sim = baseSim('TOO_FAST', { coverageRatePercent: 100 });
  const result = computeEliminationReport([row], new Map([['TOO_FAST', sim]]));
  assert.equal(result.eliminated.length, 1);
  assert.deepEqual(result.eliminated[0]?.reasons, ['hold_time_shorter_than_copy_delay']);
});

test('a fully covered wallet with no bad-outcome signal survives', () => {
  const row = baseRow('GOOD');
  const sim = baseSim('GOOD', { coverageRatePercent: 100 });
  const result = computeEliminationReport([row], new Map([['GOOD', sim]]));
  assert.equal(result.eliminated.length, 0);
  assert.equal(result.surviving[0]?.trustworthy, true);
});

test('an unsimulated wallet is never eliminated and is excluded from the measured target count, not zeroed', () => {
  const row = baseRow('NEVER_SIMULATED');
  const result = computeEliminationReport([row], new Map());
  assert.equal(result.eliminated.length, 0);
  assert.equal(result.surviving[0]?.duneMissedTrades, null);
  assert.equal(result.survivorsNeverSimulatedCount, 1);
  assert.equal(result.measuredDuneTargetsRemaining, 0);
});

test('measured remaining targets sum only over survivors with real simulation data', () => {
  const rows = [baseRow('A'), baseRow('B'), baseRow('C')];
  const simByWallet = new Map([
    ['A', baseSim('A', { coverageRatePercent: 60, missedTrades: 30 })],
    ['B', baseSim('B', { coverageRatePercent: 80, missedTrades: 10 })],
    // C never simulated
  ]);
  const result = computeEliminationReport(rows, simByWallet);
  assert.equal(result.survivorsNeedingDune.length, 3);
  assert.equal(result.survivorsNeverSimulatedCount, 1);
  assert.equal(result.measuredDuneTargetsRemaining, 40);
});

test('estimateDuneRefetchDuration falls back to the seeded rate with no completed runs', () => {
  const database = setup();
  const estimate = estimateDuneRefetchDuration(database, 150);
  assert.equal(estimate.basis, 'seeded');
  assert.equal(estimate.runsCounted, 0);
  assert.ok(Math.abs(estimate.estimatedSeconds - 2_941) < 5);
});

test('estimateDuneRefetchDuration uses a measured rate once a completed run exists', () => {
  const database = setup();
  const refs = JSON.stringify(Array.from({ length: 100 }, (_, index) => index + 1));
  database.prepare(
    `INSERT INTO copytrade_copy_simulation_runs (trade_refs, query_sql, status, requested_at, completed_at)
     VALUES (?, 'SELECT 1', 'completed', '2026-08-20T00:00:00.000Z', '2026-08-20T00:10:00.000Z')`,
  ).run(refs);
  const estimate = estimateDuneRefetchDuration(database, 100);
  assert.equal(estimate.basis, 'measured');
  assert.equal(estimate.runsCounted, 1);
  assert.equal(estimate.secondsPerTarget, 6);
  assert.equal(estimate.estimatedSeconds, 600);
});

const tradeAt = fixtureTrade;

test('assessCoverageGap flags a wallet whose unmeasured trades hide its big wins', () => {
  // Measured: 0/4 big wins. Unmeasured: 4/4 big wins. Gap = +100pp, well past the threshold.
  const trades = [
    ...Array.from({ length: 4 }, () => tradeAt('simulated', 10)),
    ...Array.from({ length: 4 }, () => tradeAt('not_yet_queried', 500)),
  ];
  const result = assessCoverageGap(trades);
  assert.equal(result.direction, 'conservative');
  assert.equal(result.matchedBigWinPercent, 0);
  assert.equal(result.unmatchedBigWinPercent, 100);
  assert.equal(result.gapPercentagePoints, 100);
});

test('assessCoverageGap reports an ordinary-looking gap as unclear, not as a hidden problem', () => {
  const trades = [
    tradeAt('simulated', 500), ...Array.from({ length: 3 }, () => tradeAt('simulated', 10)),
    tradeAt('not_yet_queried', 500), ...Array.from({ length: 3 }, () => tradeAt('not_yet_queried', 10)),
  ];
  const result = assessCoverageGap(trades);
  assert.equal(result.direction, 'unclear');
  assert.equal(result.gapPercentagePoints, 0);
});

test('assessCoverageGap never infers a direction from a one-sided population', () => {
  const onlyMatched = assessCoverageGap(Array.from({ length: 5 }, () => tradeAt('simulated', 10)));
  assert.equal(onlyMatched.direction, 'no_gap');
  assert.equal(onlyMatched.unmatchedN, 0);
  const onlyUnmatched = assessCoverageGap(Array.from({ length: 5 }, () => tradeAt('not_yet_queried', 10)));
  assert.equal(onlyUnmatched.direction, 'no_gap');
  assert.equal(onlyUnmatched.matchedN, 0);
  assert.equal(assessCoverageGap([]).direction, 'no_gap');
});

test('assessCoverageGap excludes trades with no wallet return rather than scoring them as losses', () => {
  const trades = [
    tradeAt('simulated', 500), tradeAt('simulated', null),
    tradeAt('not_yet_queried', 10), tradeAt('not_yet_queried', null),
  ];
  const result = assessCoverageGap(trades);
  assert.equal(result.matchedN, 1);
  assert.equal(result.unmatchedN, 1);
  assert.equal(result.matchedBigWinPercent, 100);
});

test('the elimination report carries the coverage-gap reading per wallet, and null when unsimulated', () => {
  const withSim = computeEliminationReport(
    [baseRow('HAS_SIM')],
    new Map([['HAS_SIM', baseSim('HAS_SIM', { coverageRatePercent: 60, trades: [tradeAt('simulated', 10), tradeAt('not_yet_queried', 500)] })]]),
  );
  assert.equal(withSim.surviving[0]?.coverageGap?.matchedN, 1);
  assert.equal(withSim.surviving[0]?.coverageGap?.unmatchedN, 1);
  const withoutSim = computeEliminationReport([baseRow('NO_SIM')], new Map());
  assert.equal(withoutSim.surviving[0]?.coverageGap, null);
});

test('hidden-loss risk is coverage-weighted: the same population difference is harmless at high coverage and fatal at low', () => {
  // Identical shape in both: measured trades never lose, unmeasured always lose.
  const build = (matchedCount: number, unmatchedCount: number) => [
    ...Array.from({ length: matchedCount }, () => tradeAt('simulated', 10)),
    ...Array.from({ length: unmatchedCount }, () => tradeAt('not_yet_queried', -60)),
  ];
  const highCoverage = assessCoverageGap(build(99, 1));
  const lowCoverage = assessCoverageGap(build(9, 91));
  // Raw population difference is +100pp in BOTH cases — only the weighting separates them.
  assert.equal(highCoverage.shownLossRatePercent, 0);
  assert.equal(lowCoverage.shownLossRatePercent, 0);
  assert.equal(highCoverage.hiddenLossRisk, 'negligible');
  assert.equal(lowCoverage.hiddenLossRisk, 'high');
  assert.ok((lowCoverage.lossRateUnderstatedPercentagePoints ?? 0) > 90);
  assert.ok((highCoverage.lossRateUnderstatedPercentagePoints ?? 99) < 2);
});

test('hidden-loss risk never flags a wallet whose unmeasured trades look better than its measured ones', () => {
  const trades = [
    ...Array.from({ length: 10 }, () => tradeAt('simulated', -60)),
    ...Array.from({ length: 10 }, () => tradeAt('not_yet_queried', 40)),
  ];
  const result = assessCoverageGap(trades);
  assert.equal(result.hiddenLossRisk, 'negligible');
  assert.ok((result.lossRateUnderstatedPercentagePoints ?? 0) < 0, 'true loss rate should be BELOW the shown rate');
});

test('a fully covered wallet has negligible risk, not unknown — nothing missing is not the same as nothing measured', () => {
  const fullyCovered = assessCoverageGap(Array.from({ length: 5 }, () => tradeAt('simulated', -10)));
  assert.equal(fullyCovered.hiddenLossRisk, 'negligible');
  assert.equal(fullyCovered.lossRateUnderstatedPercentagePoints, 0, 'with nothing unmatched the true rate IS the shown rate');
  // Nothing measured at all stays genuinely unknown.
  assert.equal(assessCoverageGap([]).hiddenLossRisk, 'unknown');
  assert.equal(assessCoverageGap(Array.from({ length: 5 }, () => tradeAt('not_yet_queried', -10))).hiddenLossRisk, 'unknown');
});

test('the shown-vs-true loss rates reported are the real rates a reader can check by hand', () => {
  const trades = [
    tradeAt('simulated', 10), tradeAt('simulated', -10),          // measured: 1 of 2 lose = 50%
    tradeAt('not_yet_queried', -10), tradeAt('not_yet_queried', -10), // all 4 together: 3 of 4 = 75%
  ];
  const result = assessCoverageGap(trades);
  assert.equal(result.shownLossRatePercent, 50);
  assert.equal(result.trueLossRatePercent, 75);
  assert.equal(result.lossRateUnderstatedPercentagePoints, 25);
  assert.equal(result.hiddenLossRisk, 'high');
});

const statsAt = (fetchedAt: string, pnlPercent: number): CopyTradeRow['gmgnAggregate'] => ({
  period: '30d', fetchedAt, realizedProfit: -1000, realizedProfitPnlPercent: pnlPercent,
  nativeBalance: null, buyCount: null, sellCount: null, boughtCost: null, soldIncome: null,
  boughtFee: null, soldFee: null, totalCost: null, lastTimestamp: null, tokenCount: null,
  winRatePercent: null, averageHoldingPeriodSeconds: null,
});

test('a wallet whose GMGN history fetch FAILED is never trustworthy, even at full Dune coverage', () => {
  const row = baseRow('HISTORY_FAILED', { historyFailed: true });
  const sim = baseSim('HISTORY_FAILED', { coverageRatePercent: 100, simulatedMedianReturnPercent: -1 });
  const result = computeEliminationReport([row], new Map([['HISTORY_FAILED', sim]]));
  assert.equal(result.eliminated.length, 0, 'a failed-history wallet must never be eliminated');
  assert.equal(result.surviving[0]?.trustworthy, false);
});

test('100% Dune coverage over too few round trips is not enough to eliminate', () => {
  const row = baseRow('THIN_SAMPLE');
  const thin = baseSim('THIN_SAMPLE', {
    coverageRatePercent: 100, simulatedMedianReturnPercent: -1,
    roundTripsConsidered: ELIMINATION_MIN_DUNE_ROUND_TRIPS - 1, copiedTrades: ELIMINATION_MIN_DUNE_ROUND_TRIPS - 1,
  });
  assert.equal(computeEliminationReport([row], new Map([['THIN_SAMPLE', thin]])).eliminated.length, 0);
  const enough = baseSim('THIN_SAMPLE', {
    coverageRatePercent: 100, simulatedMedianReturnPercent: -1,
    roundTripsConsidered: ELIMINATION_MIN_DUNE_ROUND_TRIPS, copiedTrades: ELIMINATION_MIN_DUNE_ROUND_TRIPS,
  });
  assert.equal(computeEliminationReport([row], new Map([['THIN_SAMPLE', enough]])).eliminated.length, 1);
});

test('a stale GMGN stats snapshot cannot drive the negative-PnL elimination', () => {
  const now = new Date('2026-08-22T12:00:00.000Z');
  const staleAt = new Date(now.getTime() - (ELIMINATION_STATS_MAX_AGE_HOURS + 1) * 3_600_000).toISOString();
  const freshAt = new Date(now.getTime() - 1 * 3_600_000).toISOString();
  const sim = baseSim('W', { coverageRatePercent: 100 });
  const stale = computeEliminationReport([baseRow('W', { gmgnAggregate: statsAt(staleAt, STRONGLY_NEGATIVE_PNL_PERCENT - 50) })], new Map([['W', sim]]), now);
  assert.equal(stale.eliminated.length, 0, 'stale stats must not eliminate');
  const fresh = computeEliminationReport([baseRow('W', { gmgnAggregate: statsAt(freshAt, STRONGLY_NEGATIVE_PNL_PERCENT - 50) })], new Map([['W', sim]]), now);
  assert.deepEqual(fresh.eliminated[0]?.reasons, ['strongly_negative_30d_pnl']);
});

test('stale stats still allow the reasons that do not depend on the stats snapshot', () => {
  const now = new Date('2026-08-22T12:00:00.000Z');
  const staleAt = new Date(now.getTime() - (ELIMINATION_STATS_MAX_AGE_HOURS + 1) * 3_600_000).toISOString();
  const row = baseRow('W', { gmgnAggregate: statsAt(staleAt, STRONGLY_NEGATIVE_PNL_PERCENT - 50) });
  const sim = baseSim('W', { coverageRatePercent: 100, simulatedMedianReturnPercent: -5 });
  const result = computeEliminationReport([row], new Map([['W', sim]]), now);
  assert.deepEqual(result.eliminated[0]?.reasons, ['negative_delayed_copy_result']);
});

test('the triage trade bar is intentionally forked below the shared candidacy bar, and stays high enough to exclude thin samples', () => {
  // Pinned deliberately: this view judges "stop spending Dune budget", a weaker and cheaper
  // claim than candidacy, so it sits below RULES.minTrades. It must never drift back into
  // silently matching it, nor drop low enough to call a handful of trades trustworthy.
  assert.ok(ELIMINATION_MIN_TRADES < RULES.minTrades, 'triage bar must stay below the candidacy bar');
  assert.ok(ELIMINATION_MIN_TRADES >= 50, 'must stay high enough to exclude the four-trade-winner failure mode');

  const clean = (address: string) => baseSim(address, { coverageRatePercent: 95, simulatedMedianReturnPercent: -5, roundTripsConsidered: 60, copiedTrades: 57 });
  const justUnder = computeEliminationReport([baseRow('THIN', { trades: ELIMINATION_MIN_TRADES - 1 })], new Map([['THIN', clean('THIN')]]));
  assert.equal(justUnder.surviving[0]?.trustworthy, false, 'one trade under the bar is not judgeable');
  const atBar = computeEliminationReport([baseRow('OK', { trades: ELIMINATION_MIN_TRADES })], new Map([['OK', clean('OK')]]));
  assert.equal(atBar.eliminated.length, 1, 'exactly at the bar is judgeable');
});

test('"needs Dune" counts wallets blocked by a non-negligible hidden-loss reading, not just by the coverage floor', () => {
  // Above the coverage floor, but the gap still flatters it — more Dune shrinks the unmeasured
  // population and would resolve this, so it must be counted and costed.
  const risky = baseSim('RISKY', {
    coverageRatePercent: 95, missedTrades: 20, roundTripsConsidered: 60, copiedTrades: 57,
    trades: [
      ...Array.from({ length: 10 }, () => tradeAt('simulated', 10)),
      ...Array.from({ length: 10 }, () => tradeAt('not_yet_queried', -60)),
    ],
  });
  const report = computeEliminationReport([baseRow('RISKY')], new Map([['RISKY', risky]]));
  assert.equal(report.surviving[0]?.trustworthy, false);
  assert.notEqual(report.surviving[0]?.coverageGap?.hiddenLossRisk, 'negligible');
  assert.equal(report.survivorsNeedingDune.length, 1, 'a risk-blocked wallet still needs Dune');
  assert.equal(report.measuredDuneTargetsRemaining, 20);
});

test('hidden-upside risk is also coverage-weighted, so a tiny unmatched tail cannot reject a wallet', () => {
  const highCoverage = assessCoverageGap([
    ...Array.from({ length: 75 }, () => tradeAt('simulated', 10)),
    tradeAt('not_yet_queried', 500), tradeAt('not_yet_queried', 500),
  ]);
  assert.equal(highCoverage.gapPercentagePoints, 100);
  assert.ok((highCoverage.upsideBiasWeightedPercentagePoints ?? 99) < 3);
  assert.equal(highCoverage.hiddenUpsideBias, 'negligible');

  const lowCoverage = assessCoverageGap([
    ...Array.from({ length: 9 }, () => tradeAt('simulated', 10)),
    ...Array.from({ length: 91 }, () => tradeAt('not_yet_queried', 500)),
  ]);
  assert.equal(lowCoverage.hiddenUpsideBias, 'high');
});

test('"needs Dune" excludes a wallet that more Dune cannot help', () => {
  // Not trustworthy, but nothing is left to fetch — its blocker is trade count, not coverage.
  // Counting it would inflate both the wallet count and the refetch-time estimate.
  const complete = baseSim('DONE', { coverageRatePercent: 100, missedTrades: 0, roundTripsConsidered: 60, copiedTrades: 60 });
  const report = computeEliminationReport([baseRow('DONE', { trades: ELIMINATION_MIN_TRADES - 1 })], new Map([['DONE', complete]]));
  assert.equal(report.surviving[0]?.trustworthy, false);
  assert.equal(report.survivorsNeedingDune.length, 0);
  assert.equal(report.measuredDuneTargetsRemaining, 0);
});

test('a trustworthy wallet never counts as needing Dune, even with targets outstanding', () => {
  const partial = baseSim('OK', { coverageRatePercent: 95, missedTrades: 5, roundTripsConsidered: 60, copiedTrades: 57 });
  const report = computeEliminationReport([baseRow('OK')], new Map([['OK', partial]]));
  assert.equal(report.surviving[0]?.trustworthy, true);
  assert.equal(report.survivorsNeedingDune.length, 0);
});
