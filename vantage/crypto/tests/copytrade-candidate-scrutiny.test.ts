import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/platform/db/client.js';
import { applyMigrations } from '../src/platform/db/schema.js';
import {
  computeCandidateScrutiny, computeCandidateScrutinyBatch, MAX_SCRUTINY_WALLETS, MIN_GROUP_SAMPLE,
} from '../src/copytrade/scrutiny/candidateScrutiny.js';
import { computeCopySimulationReport, DEFAULT_COPIER_DELAY_SECONDS, type CopySimulationWalletReport } from '../src/copytrade/simulation/copySimulation.js';
import type { CopyTradeRow, Verdict } from '../src/copytrade/scrutiny/evaluate.js';

const setup = (): DatabaseSync => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  return database;
};

let nextTradeId = 1;

const insertTradeRow = (
  database: DatabaseSync,
  over: { walletAddress: string; eventType: 'buy' | 'sell'; tokenAddress: string; observedTimestamp: number; costUsd?: string | null; buyCostUsd?: string | null },
): number => {
  const id = nextTradeId; nextTradeId += 1;
  database.prepare(
    `INSERT INTO copytrade_trades
       (id, wallet_address, chain, tx_hash, event_type, token_address, token_symbol, observed_timestamp,
        token_amount, cost_usd, buy_cost_usd, price_usd, gas_usd, dex_usd, launchpad_platform, raw_payload, fetched_at, dedup_key)
     VALUES (?, ?, 'sol', ?, ?, ?, 'TKN', ?, '100', ?, ?, '1', '0.01', '0.02', 'Pump.fun', '{}', 'now', ?)`,
  ).run(
    id, over.walletAddress, `TX${id}`, over.eventType, over.tokenAddress, over.observedTimestamp,
    over.costUsd ?? null, over.buyCostUsd ?? null, `DEDUP${id}`,
  );
  return id;
};

const seedDuneMatch = (database: DatabaseSync, tradeId: number, matchedTradeAtIso: string, priceUsd: number): void => {
  database.prepare(
    `INSERT INTO copytrade_copy_simulation_runs (trade_refs, query_sql, status, requested_at, completed_at, raw_result)
     VALUES (?, 'SELECT 1', 'completed', 'now', 'now', ?)`,
  ).run(
    JSON.stringify([tradeId]),
    JSON.stringify({ result: { rows: [{ trade_id: tradeId, matched_trade_at: matchedTradeAtIso, price_usd: priceUsd, matched_tx_id: `TXM${tradeId}`, amount_usd: 500 }] } }),
  );
};

/** A buy+sell round trip. `dune` controls whether both legs get a matching Dune row (fully
 *  matched), only one leg (partially matched, still counted as unmatched by the 'simulated'
 *  test since both legs are required), or neither (never queried). */
const seedRoundTrip = (
  database: DatabaseSync, walletAddress: string, tokenAddress: string, baseTimestamp: number, returnPercent: number,
  dune: 'both' | 'none' = 'none',
): { buyId: number; sellId: number } => {
  const buyId = insertTradeRow(database, { walletAddress, eventType: 'buy', tokenAddress, observedTimestamp: baseTimestamp, buyCostUsd: '100' });
  const sellPrice = 1 + returnPercent / 100;
  const sellId = insertTradeRow(database, { walletAddress, eventType: 'sell', tokenAddress, observedTimestamp: baseTimestamp + 100, costUsd: String(100 * sellPrice), buyCostUsd: '100' });
  if (dune === 'both') {
    seedDuneMatch(database, buyId, new Date((baseTimestamp + DEFAULT_COPIER_DELAY_SECONDS) * 1000).toISOString(), 1);
    seedDuneMatch(database, sellId, new Date((baseTimestamp + 100 + DEFAULT_COPIER_DELAY_SECONDS) * 1000).toISOString(), sellPrice);
  }
  return { buyId, sellId };
};

const baseRow = (walletAddress: string, over: Partial<CopyTradeRow> = {}): CopyTradeRow => ({
  walletAddress, name: null, trades: 10, winRatePercent: 60, medianReturnPercent: 10,
  averageReturnPercent: 10, endingCapitalUsd: 110, verdict: 'screen_pass',
  riskFlags: [], failedRules: [], excludedNoCostBasis: 0, endingCapitalUsdCompounded: 110,
  truncated: false, coveredDays: 90, lastTradeAt: 1_000_000, daysSinceLastTrade: 1,
  needsDuneBackfill: false, unreliableReason: null,
  riskEvidence: { fastRoundTripPercent: 5, noCostBasisPercent: 2, medianHoldSeconds: 3600, fundedByAddress: null, walletAgeDays: 300 },
  riskNotes: [], comparable: true,
  profitConcentration: {
    bestToken: { tokenAddress: 'TOKEN_A', tokenSymbol: 'AAA', trades: 3, profitUsd: 1000 },
    bestThreeTokens: [], bestTokenSharePositiveProfitPercent: 15, bestThreeSharePositiveProfitPercent: 30,
    bestTradeProfitUsd: 100, excludingBestTrade: { trades: 9, medianReturnPercent: 9, endingCapitalUsd: 108 },
    excludingBestToken: { trades: 7, medianReturnPercent: 8, endingCapitalUsd: 105 },
  },
  weeklyPerformance: [], monthlyPerformance: [],
  rankHistory: { walletAddress, leaderboardCaptures: 2, appearances: 2, topFiveAppearances: 1, topFiveMembershipPercent: 50, currentRank: 3, bestRank: 3, worstRank: 3, firstObservedAt: null, lastObservedAt: null },
  ...over,
});

const emptySim = (walletAddress: string): CopySimulationWalletReport => ({
  walletAddress, roundTripsConsidered: 0, copiedTrades: 0, missedTrades: 0, coverageRatePercent: null,
  walletMedianReturnPercent: null, simulatedMedianReturnPercent: null, walletMeanReturnPercent: null,
  simulatedMeanReturnPercent: null, tradesAbove100Percent: 0, tradesAbove300Percent: 0,
  bestSimulatedReturnPercent: null, tailShareOfMeanPercent: null, delayCostPercentagePoints: null,
  worstSimulatedReturnPercent: null, totalGasFeeSol: null,
  portfolio: { startingCapitalUsd: 100, stakePerTradeUsd: 10, maxOpenPositions: 10, endingCapitalUsd: 100, realizedPnlUsd: 0, eligibleTrades: 0, copiedTrades: 0, skippedInsufficientCash: 0, skippedMaxOpenPositions: 0, maxConcurrentPositions: 0, gasFeeSol: 0, capitalPath: [] },
  trades: [],
});

test('a wallet whose profit is dominated by one token fails concentration, and the without-token median is materially lower', () => {
  const database = setup();
  try {
    const row = baseRow('W_CONC', {
      medianReturnPercent: 40,
      profitConcentration: {
        bestToken: { tokenAddress: 'DOM', tokenSymbol: 'DOM', trades: 1, profitUsd: 5000 },
        bestThreeTokens: [], bestTokenSharePositiveProfitPercent: 88, bestThreeSharePositiveProfitPercent: 95,
        bestTradeProfitUsd: 5000, excludingBestTrade: { trades: 9, medianReturnPercent: -5, endingCapitalUsd: 90 },
        excludingBestToken: { trades: 9, medianReturnPercent: -8, endingCapitalUsd: 88 },
      },
    });
    const sim = emptySim('W_CONC');
    const result = computeCandidateScrutiny(database, 'W_CONC', {
      row, simInWindow: sim, simFullHistory: sim, candidateCount: 5, screenedCount: 50, scopePeriodDays: 90,
      now: new Date('2026-08-20T00:00:00.000Z'),
    });
    assert.equal(result.checks.concentration.verdict, 'fail');
    assert.equal(result.checks.concentration.metrics.bestTokenSharePercent, 88);
    assert.ok(result.checks.concentration.metrics.medianWithoutToken !== null);
    assert.ok(result.checks.concentration.metrics.medianWithoutToken < result.checks.concentration.metrics.medianWithToken! - 10);
  } finally { database.close(); }
});

test('a wallet with a negative median and positive mean is flagged as diverging with both figures kept', () => {
  const database = setup();
  try {
    const row = baseRow('W_DIVERGE', { medianReturnPercent: -8, averageReturnPercent: 45 });
    const sim = emptySim('W_DIVERGE');
    const result = computeCandidateScrutiny(database, 'W_DIVERGE', {
      row, simInWindow: sim, simFullHistory: sim, candidateCount: 5, screenedCount: 50, scopePeriodDays: 90,
    });
    assert.equal(result.checks.medianMeanDivergence.verdict, 'fail');
    assert.equal(result.checks.medianMeanDivergence.metrics.medianReturnPercent, -8);
    assert.equal(result.checks.medianMeanDivergence.metrics.averageReturnPercent, 45);
    assert.equal(result.checks.medianMeanDivergence.metrics.diverges, true);
  } finally { database.close(); }
});

test('insufficient and fail are distinguishable verdicts, never rendered or coded the same', () => {
  const database = setup();
  try {
    const failRow = baseRow('W_FAIL', {
      profitConcentration: {
        bestToken: { tokenAddress: 'DOM', tokenSymbol: 'DOM', trades: 1, profitUsd: 5000 },
        bestThreeTokens: [], bestTokenSharePositiveProfitPercent: 90, bestThreeSharePositiveProfitPercent: 95,
        bestTradeProfitUsd: 5000, excludingBestTrade: { trades: 9, medianReturnPercent: -5, endingCapitalUsd: 90 },
        excludingBestToken: { trades: 9, medianReturnPercent: -5, endingCapitalUsd: 90 },
      },
    });
    const insufficientRow = baseRow('W_INSUFFICIENT', {
      profitConcentration: {
        bestToken: null, bestThreeTokens: [], bestTokenSharePositiveProfitPercent: null, bestThreeSharePositiveProfitPercent: null,
        bestTradeProfitUsd: null, excludingBestTrade: { trades: 0, medianReturnPercent: null, endingCapitalUsd: null },
        excludingBestToken: { trades: 0, medianReturnPercent: null, endingCapitalUsd: null },
      },
    });
    const simFail = emptySim('W_FAIL');
    const simInsufficient = emptySim('W_INSUFFICIENT');
    const failResult = computeCandidateScrutiny(database, 'W_FAIL', { row: failRow, simInWindow: simFail, simFullHistory: simFail, candidateCount: 5, screenedCount: 50, scopePeriodDays: 90 });
    const insufficientResult = computeCandidateScrutiny(database, 'W_INSUFFICIENT', { row: insufficientRow, simInWindow: simInsufficient, simFullHistory: simInsufficient, candidateCount: 5, screenedCount: 50, scopePeriodDays: 90 });
    assert.equal(failResult.checks.concentration.verdict, 'fail');
    assert.equal(insufficientResult.checks.concentration.verdict, 'insufficient');
    assert.notEqual(failResult.checks.concentration.verdict, insufficientResult.checks.concentration.verdict);
    // Both are legitimate three-state members, not aliases of each other or of 'pass'.
    const verdicts: ReadonlySet<string> = new Set(['pass', 'fail', 'insufficient']);
    assert.ok(verdicts.has(failResult.checks.concentration.verdict));
    assert.ok(verdicts.has(insufficientResult.checks.concentration.verdict));
  } finally { database.close(); }
});

test('a wallet with no Dune coverage yields insufficient for every coverage-dependent check, never a pass', () => {
  const database = setup();
  try {
    // Enough round trips to be a real candidate, but never queried against Dune.
    for (let i = 0; i < 15; i += 1) seedRoundTrip(database, 'W_NODUNE', `TOKEN_${i}`, 1000 + i * 1000, 5, 'none');
    const row = baseRow('W_NODUNE', { trades: 15 });
    const simInWindow = computeCopySimulationReport(database, { walletAddresses: ['W_NODUNE'], periodDays: 90 }).wallets[0];
    const simFullHistory = computeCopySimulationReport(database, { walletAddresses: ['W_NODUNE'] }).wallets[0];
    assert.equal(simFullHistory.copiedTrades, 0, 'test setup sanity: nothing should be Dune-matched');
    const result = computeCandidateScrutiny(database, 'W_NODUNE', {
      row, simInWindow, simFullHistory, candidateCount: 5, screenedCount: 50, scopePeriodDays: 90,
    });
    assert.equal(result.checks.coverage.verdict, 'insufficient');
    assert.equal(result.checks.coverageBias.verdict, 'insufficient');
    assert.equal(result.checks.tailFragility.verdict, 'insufficient');
    assert.notEqual(result.checks.coverage.verdict, 'pass');
    assert.notEqual(result.checks.coverageBias.verdict, 'pass');
    assert.notEqual(result.checks.tailFragility.verdict, 'pass');
  } finally { database.close(); }
});

test('out-of-sample split reports both halves, and too few dates on one side is insufficient rather than a one-sided figure', () => {
  const database = setup();
  try {
    // suggestSplitDate picks a cutoff from the DISTINCT CALENDAR DATES present, at ~30% from the
    // end. Ten dense early days plus one lone distant day (11 distinct dates) puts the cutoff at
    // the 9th date, leaving only 3 trades (two dense-tail days plus the lone day) in the test half
    // — fewer than MIN_GROUP_SAMPLE.
    for (let day = 0; day < 10; day += 1) {
      seedRoundTrip(database, 'W_THIN_TAIL', `TOKEN_${day}`, day * 86_400, day % 2 === 0 ? 5 : -3, 'none');
    }
    seedRoundTrip(database, 'W_THIN_TAIL', 'TOKEN_LATE', 100 * 86_400, 10, 'none');
    const row = baseRow('W_THIN_TAIL');
    const sim = emptySim('W_THIN_TAIL');
    // now must be pinned near these epoch-based timestamps — otherwise the 30-day-style scoped
    // cutoff (now - scopePeriodDays) sits decades after them and excludes every trade.
    const thin = computeCandidateScrutiny(database, 'W_THIN_TAIL', { row, simInWindow: sim, simFullHistory: sim, candidateCount: 5, screenedCount: 50, scopePeriodDays: 9999, now: new Date(150 * 86_400 * 1000) });
    assert.equal(thin.checks.outOfSampleStability.verdict, 'insufficient');
    assert.ok(thin.checks.outOfSampleStability.metrics.lateN < MIN_GROUP_SAMPLE);

    database.exec('DELETE FROM copytrade_trades');
    // Balanced history: enough trades on both sides of the split for a real comparison.
    for (let day = 0; day < 10; day += 1) seedRoundTrip(database, 'W_BALANCED', `EARLY_${day}`, day * 86_400, 8, 'none');
    for (let day = 20; day < 30; day += 1) seedRoundTrip(database, 'W_BALANCED', `LATE_${day}`, day * 86_400, 6, 'none');
    const balancedRow = baseRow('W_BALANCED');
    const balancedSim = emptySim('W_BALANCED');
    const balanced = computeCandidateScrutiny(database, 'W_BALANCED', { row: balancedRow, simInWindow: balancedSim, simFullHistory: balancedSim, candidateCount: 5, screenedCount: 50, scopePeriodDays: 9999, now: new Date(60 * 86_400 * 1000) });
    assert.notEqual(balanced.checks.outOfSampleStability.verdict, 'insufficient');
    assert.ok(balanced.checks.outOfSampleStability.metrics.earlyN >= MIN_GROUP_SAMPLE);
    assert.ok(balanced.checks.outOfSampleStability.metrics.lateN >= MIN_GROUP_SAMPLE);
    assert.ok(balanced.checks.outOfSampleStability.metrics.earlyMedianReturnPercent !== null);
    assert.ok(balanced.checks.outOfSampleStability.metrics.lateMedianReturnPercent !== null);
  } finally { database.close(); }
});

test('repeat-entry and single-entry medians are computed over disjoint trade sets that reconstruct the full population', () => {
  const database = setup();
  try {
    // Three tokens entered twice each (repeat), four tokens entered once each (single).
    let ts = 1000;
    for (let i = 0; i < 3; i += 1) {
      seedRoundTrip(database, 'W_REPEAT', `REPEAT_${i}`, ts, 20, 'none'); ts += 1000;
      seedRoundTrip(database, 'W_REPEAT', `REPEAT_${i}`, ts, 25, 'none'); ts += 1000;
    }
    for (let i = 0; i < 4; i += 1) { seedRoundTrip(database, 'W_REPEAT', `SINGLE_${i}`, ts, -5, 'none'); ts += 1000; }
    const totalCompletedTrades = 3 * 2 + 4;
    const row = baseRow('W_REPEAT', { trades: totalCompletedTrades });
    const sim = emptySim('W_REPEAT');
    // scopePeriodDays' cutoff is relative to `now`; ts values here are small (seconds since
    // epoch), so `now` is pinned close to them rather than left at the real wall clock.
    const result = computeCandidateScrutiny(database, 'W_REPEAT', {
      row, simInWindow: sim, simFullHistory: sim, candidateCount: 5, screenedCount: 50,
      scopePeriodDays: 90, now: new Date(50_000 * 1000),
    });
    const { repeatEntryN, singleEntryN } = result.checks.repeatEntry.metrics;
    assert.equal(repeatEntryN, 6);
    assert.equal(singleEntryN, 4);
    assert.equal(repeatEntryN + singleEntryN, totalCompletedTrades);
  } finally { database.close(); }
});

test('selection context states N candidates out of M scanned, and the batch entry point caps at MAX_SCRUTINY_WALLETS', () => {
  const database = setup();
  try {
    const wallets = Array.from({ length: MAX_SCRUTINY_WALLETS + 3 }, (_, i) => `W_${i}`);
    const rowsByWallet = new Map(wallets.map((w) => [w, baseRow(w)]));
    for (const w of wallets) seedRoundTrip(database, w, 'TOK', 1000, 5, 'none');
    const reports = computeCandidateScrutinyBatch(database, wallets, {
      rowsByWallet, candidateCount: 4, screenedCount: 112, scopePeriodDays: 90,
    });
    assert.equal(reports.length, MAX_SCRUTINY_WALLETS);
    assert.equal(reports[0].selectionContext.candidateCount, 4);
    assert.equal(reports[0].selectionContext.screenedCount, 112);
    assert.match(reports[0].selectionContext.note, /one of 4 candidates from 112 wallets scanned/);
  } finally { database.close(); }
});
