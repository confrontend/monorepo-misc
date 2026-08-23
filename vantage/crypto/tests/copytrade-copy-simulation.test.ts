import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/platform/db/client.js';
import { applyMigrations } from '../src/platform/db/schema.js';
import {
  computeCopySimulationReport, computeLiquidityImpactReport, DEFAULT_COPIER_DELAY_SECONDS, DEFAULT_FEE_BPS,
  DEFAULT_SLIPPAGE_BPS, MAX_MATCH_GAP_SECONDS, MIN_LIQUIDITY_BAND_SAMPLE, simulateFixedStakePortfolio,
  type CopySimulationReport, type CopySimulationTradeResult,
} from '../src/copytrade/simulation/copySimulation.js';
import { readAllCopySimulationMatches, rowsToMatches, sqlFor, WIDE_SEARCH_WINDOW_MINUTES } from '../src/copytrade/simulation/copySimulationDune.js';

const setup = (): DatabaseSync => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  return database;
};

let nextTradeId = 1;

test('Dune retries use the same five-minute accuracy window and preserve provenance', () => {
  const target = { tradeId: 1, tokenAddress: 'Token', delayedTargetAtIso: '2026-08-20T00:00:00.000Z' };
  assert.match(sqlFor([target]), /INTERVAL '5' MINUTE/);
  assert.match(sqlFor([target], WIDE_SEARCH_WINDOW_MINUTES), /INTERVAL '5' MINUTE/);
  const matches = rowsToMatches([target], [{ trade_id: 1, matched_trade_at: '2026-08-20T00:01:00.000Z', price_usd: 1, amount_usd: 4 }], 'wide_window');
  assert.equal(matches[0]?.matchSource, 'wide_window');
  assert.equal(matches[0]?.status, 'matched');
});

test('wide no-match provenance is terminal so the same target is not eligible for endless retries', () => {
  const database = setup();
  try {
    const raw = JSON.stringify({ result: { rows: [] } });
    database.prepare(
      `INSERT INTO copytrade_copy_simulation_runs (trade_refs, query_sql, status, requested_at, completed_at, raw_result, match_source, search_window_minutes)
       VALUES (?, 'SELECT 1', 'completed', 'now', 'now', ?, ?, ?)`
    ).run(JSON.stringify([901]), raw, 'precise', 30);
    database.prepare(
      `INSERT INTO copytrade_copy_simulation_runs (trade_refs, query_sql, status, requested_at, completed_at, raw_result, match_source, search_window_minutes)
       VALUES (?, 'SELECT 1', 'completed', 'now', 'now', ?, ?, ?)`
    ).run(JSON.stringify([901]), raw, 'wide_window', 120);

    const match = readAllCopySimulationMatches(database).get(901);
    assert.equal(match?.status, 'no_trade_in_window');
    assert.equal(match?.matchSource, 'wide_window');
  } finally { database.close(); }
});

const insertTradeRow = (
  database: DatabaseSync,
  over: { walletAddress: string; eventType: 'buy' | 'sell'; tokenAddress: string; observedTimestamp: number; tokenAmount?: string | null; costUsd?: string | null; buyCostUsd?: string | null; priceUsd?: string | null },
): number => {
  const id = nextTradeId; nextTradeId += 1;
  database.prepare(
    `INSERT INTO copytrade_trades
       (id, wallet_address, chain, tx_hash, event_type, token_address, token_symbol, observed_timestamp,
        token_amount, cost_usd, buy_cost_usd, price_usd, gas_usd, dex_usd, launchpad_platform, raw_payload, fetched_at, dedup_key)
     VALUES (?, ?, 'sol', ?, ?, ?, 'TKN', ?, ?, ?, ?, ?, '0.01', '0.02', 'Pump.fun', '{}', 'now', ?)`,
  ).run(
    id, over.walletAddress, `TX${id}`, over.eventType, over.tokenAddress, over.observedTimestamp, over.tokenAmount ?? '100',
    over.costUsd ?? null, over.buyCostUsd ?? null, over.priceUsd ?? null, `DEDUP${id}`,
  );
  return id;
};

/** Pre-seeds a completed Dune run exactly as runCopySimulationDuneBatch would store it, so
 *  computeCopySimulationReport can be tested without any network call. */
const seedDuneMatch = (
  database: DatabaseSync, tradeId: number, matchedTradeAtIso: string, priceUsd: number, amountUsd?: number,
): void => {
  database.prepare(
    `INSERT INTO copytrade_copy_simulation_runs (trade_refs, query_sql, status, requested_at, completed_at, raw_result)
     VALUES (?, 'SELECT 1', 'completed', 'now', 'now', ?)`,
  ).run(
    JSON.stringify([tradeId]),
    JSON.stringify({ result: { rows: [{ trade_id: tradeId, matched_trade_at: matchedTradeAtIso, price_usd: priceUsd, matched_tx_id: `TX_MATCH_${tradeId}`, amount_usd: amountUsd ?? null }] } }),
  );
};

const seedRoundTrip = (
  database: DatabaseSync, walletAddress: string, tokenAddress: string, baseTimestamp: number, returnPercent: number,
): void => {
  const buyId = insertTradeRow(database, { walletAddress, eventType: 'buy', tokenAddress, observedTimestamp: baseTimestamp, buyCostUsd: '100', priceUsd: '1' });
  const sellPrice = 1 + returnPercent / 100;
  const sellId = insertTradeRow(database, { walletAddress, eventType: 'sell', tokenAddress, observedTimestamp: baseTimestamp + 100, costUsd: String(100 * sellPrice), buyCostUsd: '100', priceUsd: String(sellPrice) });
  seedDuneMatch(database, buyId, new Date((baseTimestamp + DEFAULT_COPIER_DELAY_SECONDS) * 1000).toISOString(), 1);
  seedDuneMatch(database, sellId, new Date((baseTimestamp + 100 + DEFAULT_COPIER_DELAY_SECONDS) * 1000).toISOString(), sellPrice);
};

test('tail metrics use only simulated trades and expose median/mean divergence plus extreme wins', () => {
  const database = setup();
  try {
    seedRoundTrip(database, 'W1', 'LOSS_A', 1000, -10);
    seedRoundTrip(database, 'W1', 'LOSS_B', 2000, -5);
    seedRoundTrip(database, 'W1', 'TAIL', 3000, 2000);
    // This trade is deliberately not queried; its large wallet return must not enter tail stats.
    insertTradeRow(database, { walletAddress: 'W1', eventType: 'buy', tokenAddress: 'UNQUERIED', observedTimestamp: 4000, buyCostUsd: '100', priceUsd: '1' });
    insertTradeRow(database, { walletAddress: 'W1', eventType: 'sell', tokenAddress: 'UNQUERIED', observedTimestamp: 4100, costUsd: '10000', buyCostUsd: '100', priceUsd: '100' });

    const wallet = computeCopySimulationReport(database, { walletAddresses: ['W1'], feeBps: 0, slippageBps: 0 }).wallets[0]!;
    assert.ok(Math.abs((wallet.simulatedMedianReturnPercent ?? 0) - (-5)) < 0.01);
    assert.ok(Math.abs((wallet.simulatedMeanReturnPercent ?? 0) - 661.67) < 0.01);
    assert.ok(Math.abs((wallet.walletMeanReturnPercent ?? 0) - 661.67) < 0.01);
    assert.equal(wallet.tradesAbove100Percent, 1);
    assert.equal(wallet.tradesAbove300Percent, 1);
    assert.equal(wallet.bestSimulatedReturnPercent, 2000);
    assert.equal(wallet.tailShareOfMeanPercent, 100.8, 'tail share is not clamped when negative trades make the denominator smaller');
    assert.equal(wallet.copiedTrades, 3, 'unqueried trade is excluded from every tail metric');
  } finally { database.close(); }
});

test('tail share is null when the summed simulated return is not positive', () => {
  const database = setup();
  try {
    seedRoundTrip(database, 'W1', 'LOSS_A', 1000, -200);
    seedRoundTrip(database, 'W1', 'LOSS_B', 2000, -300);
    const wallet = computeCopySimulationReport(database, { walletAddresses: ['W1'], feeBps: 0, slippageBps: 0 }).wallets[0]!;
    assert.equal(wallet.simulatedMeanReturnPercent, -250);
    assert.equal(wallet.tailShareOfMeanPercent, null);
  } finally { database.close(); }
});

test('a sell with no preceding buy in stored history is excluded, not treated as a round trip at all', () => {
  const database = setup();
  try {
    // A sell with nothing bought first — position opened before the capture window began.
    insertTradeRow(database, { walletAddress: 'W1', eventType: 'sell', tokenAddress: 'TOKA', observedTimestamp: 1000, costUsd: '120', buyCostUsd: '100' });
    const report = computeCopySimulationReport(database, { walletAddresses: ['W1'] });
    assert.equal(report.wallets[0]?.roundTripsConsidered, 0, 'no buy to pair with means no round trip, not a missing/zero one');
  } finally { database.close(); }
});

test('a round trip with both legs matched well within the gap tolerance is simulated, fees and slippage applied', () => {
  const database = setup();
  try {
    const buyId = insertTradeRow(database, { walletAddress: 'W1', eventType: 'buy', tokenAddress: 'TOKA', observedTimestamp: 1000, buyCostUsd: '100', costUsd: null, priceUsd: '1' });
    const sellId = insertTradeRow(database, { walletAddress: 'W1', eventType: 'sell', tokenAddress: 'TOKA', observedTimestamp: 2000, costUsd: '150', buyCostUsd: '100', priceUsd: '1.5' });

    const buyDelayedAt = new Date((1000 + DEFAULT_COPIER_DELAY_SECONDS) * 1000).toISOString();
    const sellDelayedAt = new Date((2000 + DEFAULT_COPIER_DELAY_SECONDS) * 1000).toISOString();
    seedDuneMatch(database, buyId, buyDelayedAt, 1.0);
    seedDuneMatch(database, sellId, sellDelayedAt, 1.5);

    const report = computeCopySimulationReport(database, { walletAddresses: ['W1'] });
    const wallet = report.wallets[0]!;
    assert.equal(wallet.roundTripsConsidered, 1);
    assert.equal(wallet.copiedTrades, 1);
    assert.equal(wallet.missedTrades, 0);
    assert.equal(wallet.trades[0]?.status, 'simulated');
    // Entry inflated and exit deflated by fee+slippage, so the simulated return is measurably
    // below the raw (1.5 - 1.0) / 1.0 = 50% the matched prices alone would imply.
    const haircut = (DEFAULT_FEE_BPS + DEFAULT_SLIPPAGE_BPS) / 10_000;
    const expectedEntry = 1.0 * (1 + haircut);
    const expectedExit = 1.5 * (1 - haircut);
    const expectedReturnPercent = Math.round(((expectedExit - expectedEntry) / expectedEntry) * 100 * 100) / 100;
    assert.equal(wallet.trades[0]?.simulatedReturnPercent, expectedReturnPercent);
    assert.ok((wallet.simulatedMedianReturnPercent ?? wallet.trades[0]!.simulatedReturnPercent!) < 50, 'fees and slippage must reduce the return below the raw price delta');
  } finally { database.close(); }
});

/** Marks a trade id as covered by a completed run with no matching row — a real "Dune was
 *  asked, found nothing" outcome, distinct from never being asked at all. */
const seedNoMatch = (database: DatabaseSync, tradeId: number): void => {
  database.prepare(
    `INSERT INTO copytrade_copy_simulation_runs (trade_refs, query_sql, status, requested_at, completed_at, raw_result)
     VALUES (?, 'SELECT 1', 'completed', 'now', 'now', ?)`,
  ).run(JSON.stringify([tradeId]), JSON.stringify({ result: { rows: [] } }));
};

test('a round trip with one leg queried-no-match and the other never queried attributes exactly one leg to each bucket', () => {
  const database = setup();
  try {
    const buyId = insertTradeRow(database, { walletAddress: 'W1', eventType: 'buy', tokenAddress: 'TOKA', observedTimestamp: 1000, buyCostUsd: '100', priceUsd: '1' });
    const sellId = insertTradeRow(database, { walletAddress: 'W1', eventType: 'sell', tokenAddress: 'TOKA', observedTimestamp: 2000, costUsd: '150', buyCostUsd: '100', priceUsd: '1.5' });
    // Only the buy leg has ever been sent to Dune, and it came back with no match. The sell leg
    // has never been queried at all — it must count as pending, not as a second "no match".
    seedNoMatch(database, buyId);

    const wallet = computeCopySimulationReport(database, { walletAddresses: ['W1'] }).wallets[0]!;
    assert.equal(wallet.pendingDuneTargets, 1, 'the never-queried sell leg is pending, not a Dune miss');
    assert.equal(wallet.duneNoMatchTargets, 1, 'the queried buy leg is a genuine Dune miss');
    assert.equal(wallet.duneMatchedTargets, 0);
    // The round trip itself is still reported as a single status (this is the coarser view the
    // decision table shows); the leg-level split above is what a Dune-fetch scope decision needs.
    assert.equal(wallet.trades[0]?.status, 'missing_entry_match');
  } finally { database.close(); }
});

test('per-wallet pending/no-match/matched target counts sum to the report-level totals across multiple wallets', () => {
  const database = setup();
  try {
    // W1: one fully simulated round trip (2 matched legs).
    seedRoundTrip(database, 'W1', 'TOKA', 1000, 10);
    // W2: one leg matched, one leg queried-no-match, one leg never queried (a second, untouched trip).
    const buyId = insertTradeRow(database, { walletAddress: 'W2', eventType: 'buy', tokenAddress: 'TOKB', observedTimestamp: 1000, buyCostUsd: '100', priceUsd: '1' });
    const sellId = insertTradeRow(database, { walletAddress: 'W2', eventType: 'sell', tokenAddress: 'TOKB', observedTimestamp: 2000, costUsd: '150', buyCostUsd: '100', priceUsd: '1.5' });
    seedDuneMatch(database, buyId, new Date((1000 + DEFAULT_COPIER_DELAY_SECONDS) * 1000).toISOString(), 1.0);
    seedNoMatch(database, sellId);
    insertTradeRow(database, { walletAddress: 'W2', eventType: 'buy', tokenAddress: 'TOKC', observedTimestamp: 3000, buyCostUsd: '100', priceUsd: '1' });
    insertTradeRow(database, { walletAddress: 'W2', eventType: 'sell', tokenAddress: 'TOKC', observedTimestamp: 4000, costUsd: '150', buyCostUsd: '100', priceUsd: '1.5' });

    const report = computeCopySimulationReport(database, { walletAddresses: ['W1', 'W2'] });
    const sum = (key: 'pendingDuneTargets' | 'duneNoMatchTargets' | 'duneMatchedTargets') =>
      report.wallets.reduce((total, wallet) => total + (wallet[key] ?? 0), 0);
    assert.equal(sum('pendingDuneTargets'), report.pendingDuneTargets, 'per-wallet pending totals must match the report-level total the fetch button reads');
    assert.equal(sum('duneNoMatchTargets'), report.duneNoMatchTargets);
    assert.equal(sum('duneMatchedTargets'), report.duneMatchedTargets);
    // Ground-truth expectation, not just internal consistency: W1 contributes 2 matched legs, 0
    // pending. W2 contributes 1 matched, 1 no-match, and 2 pending (the untouched second trip).
    const w1 = report.wallets.find((wallet) => wallet.walletAddress === 'W1')!;
    const w2 = report.wallets.find((wallet) => wallet.walletAddress === 'W2')!;
    assert.deepEqual([w1.pendingDuneTargets, w1.duneNoMatchTargets, w1.duneMatchedTargets], [0, 0, 2]);
    assert.deepEqual([w2.pendingDuneTargets, w2.duneNoMatchTargets, w2.duneMatchedTargets], [2, 1, 1]);
  } finally { database.close(); }
});

test('a match beyond MAX_MATCH_GAP_SECONDS is rejected as stale, not silently used', () => {
  const database = setup();
  try {
    const buyId = insertTradeRow(database, { walletAddress: 'W1', eventType: 'buy', tokenAddress: 'TOKA', observedTimestamp: 1000, buyCostUsd: '100', priceUsd: '1' });
    const sellId = insertTradeRow(database, { walletAddress: 'W1', eventType: 'sell', tokenAddress: 'TOKA', observedTimestamp: 2000, costUsd: '150', buyCostUsd: '100', priceUsd: '1.5' });

    const buyDelayedAt = new Date((1000 + DEFAULT_COPIER_DELAY_SECONDS) * 1000).toISOString();
    // Matched trade lands well past the staleness gate.
    const staleEntryAt = new Date((1000 + DEFAULT_COPIER_DELAY_SECONDS + MAX_MATCH_GAP_SECONDS + 60) * 1000).toISOString();
    seedDuneMatch(database, buyId, staleEntryAt, 1.0);
    const sellDelayedAt = new Date((2000 + DEFAULT_COPIER_DELAY_SECONDS) * 1000).toISOString();
    seedDuneMatch(database, sellId, sellDelayedAt, 1.5);

    const report = computeCopySimulationReport(database, { walletAddresses: ['W1'] });
    const wallet = report.wallets[0]!;
    assert.equal(wallet.trades[0]?.status, 'missing_entry_match');
    assert.equal(wallet.copiedTrades, 0);
    assert.equal(wallet.missedTrades, 1);
    assert.equal(wallet.trades[0]?.walletReturnPercent, 50, 'the wallet\'s own real return is still reported even when the simulation cannot be');
    assert.equal(wallet.trades[0]?.simulatedReturnPercent, null, 'a stale match must never be used, not even as a fallback');
  } finally { database.close(); }
});

test('a round trip whose legs were never queried is reported as not_yet_queried, distinct from a rejected stale match', () => {
  const database = setup();
  try {
    insertTradeRow(database, { walletAddress: 'W1', eventType: 'buy', tokenAddress: 'TOKA', observedTimestamp: 1000, buyCostUsd: '100', priceUsd: '1' });
    insertTradeRow(database, { walletAddress: 'W1', eventType: 'sell', tokenAddress: 'TOKA', observedTimestamp: 2000, costUsd: '150', buyCostUsd: '100', priceUsd: '1.5' });

    const report = computeCopySimulationReport(database, { walletAddresses: ['W1'] });
    assert.equal(report.wallets[0]?.trades[0]?.status, 'not_yet_queried');
  } finally { database.close(); }
});

test('delayCostPercentagePoints is the gap between the simulated and the wallet\'s own median return', () => {
  const database = setup();
  try {
    const buyId = insertTradeRow(database, { walletAddress: 'W1', eventType: 'buy', tokenAddress: 'TOKA', observedTimestamp: 1000, buyCostUsd: '100', priceUsd: '1' });
    const sellId = insertTradeRow(database, { walletAddress: 'W1', eventType: 'sell', tokenAddress: 'TOKA', observedTimestamp: 2000, costUsd: '150', buyCostUsd: '100', priceUsd: '1.5' });
    seedDuneMatch(database, buyId, new Date((1000 + DEFAULT_COPIER_DELAY_SECONDS) * 1000).toISOString(), 1.0);
    seedDuneMatch(database, sellId, new Date((2000 + DEFAULT_COPIER_DELAY_SECONDS) * 1000).toISOString(), 1.5);

    const report = computeCopySimulationReport(database, { walletAddresses: ['W1'], feeBps: 0, slippageBps: 0 });
    const wallet = report.wallets[0]!;
    // With zero fees/slippage the simulated and matched-price returns coincide exactly (50%),
    // same as the wallet's own recorded 50% return here, so the delay cost is 0.
    assert.equal(wallet.walletMedianReturnPercent, 50);
    assert.equal(wallet.simulatedMedianReturnPercent, 50);
    assert.equal(wallet.delayCostPercentagePoints, 0);
  } finally { database.close(); }
});

test('assumptions in the report reflect the actual parameters used, not just the defaults', () => {
  const database = setup();
  try {
    const report = computeCopySimulationReport(database, { walletAddresses: ['W1'], copierDelaySeconds: 30, feeBps: 20, slippageBps: 10 });
    assert.deepEqual(report.assumptions, { copierDelaySeconds: 30, feeBps: 20, slippageBps: 10, gasPriorityFeeSolPerTx: report.assumptions.gasPriorityFeeSolPerTx, maxMatchGapSeconds: MAX_MATCH_GAP_SECONDS, maxRoundTripsPerWallet: report.assumptions.maxRoundTripsPerWallet, startingCapitalUsd: 100, stakePerTradeUsd: 10, maxOpenPositions: 10 });
  } finally { database.close(); }
});

test('period-scoped simulation uses only round trips sold inside the requested window', () => {
  const database = setup();
  try {
    const day = 24 * 60 * 60;
    const nowSeconds = 20 * day;
    // The older trade is still in stored history, but its sell is outside the seven-day scope.
    seedRoundTrip(database, 'W1', 'OLD', nowSeconds - 10 * day, 10);
    seedRoundTrip(database, 'W1', 'RECENT', nowSeconds - 2 * day, 20);

    const report = computeCopySimulationReport(database, {
      walletAddresses: ['W1'], periodDays: 7, now: new Date(nowSeconds * 1000), feeBps: 0, slippageBps: 0,
    });
    const wallet = report.wallets[0]!;
    assert.equal(wallet.roundTripsConsidered, 1);
    assert.equal(wallet.copiedTrades, 1);
    assert.equal(wallet.trades[0]?.tokenAddress, 'RECENT');
    assert.equal(report.assumptions.periodDays, 7);
  } finally { database.close(); }
});

test('walletMedianReturnPercent and coverageRatePercent are computed on the same subset as the simulated median, not every round trip considered', () => {
  const database = setup();
  try {
    // Trade 1: matched and simulated, wallet's own return was +100%.
    const buy1 = insertTradeRow(database, { walletAddress: 'W1', eventType: 'buy', tokenAddress: 'TOKA', observedTimestamp: 1000, buyCostUsd: '100', priceUsd: '1' });
    const sell1 = insertTradeRow(database, { walletAddress: 'W1', eventType: 'sell', tokenAddress: 'TOKA', observedTimestamp: 2000, costUsd: '200', buyCostUsd: '100', priceUsd: '2' });
    seedDuneMatch(database, buy1, new Date((1000 + DEFAULT_COPIER_DELAY_SECONDS) * 1000).toISOString(), 1);
    seedDuneMatch(database, sell1, new Date((2000 + DEFAULT_COPIER_DELAY_SECONDS) * 1000).toISOString(), 2);
    // Trade 2: never queried at all — must NOT drag the wallet median toward its own -90% return,
    // since it was never actually copied and has nothing to compare against.
    insertTradeRow(database, { walletAddress: 'W1', eventType: 'buy', tokenAddress: 'TOKB', observedTimestamp: 3000, buyCostUsd: '100', priceUsd: '1' });
    insertTradeRow(database, { walletAddress: 'W1', eventType: 'sell', tokenAddress: 'TOKB', observedTimestamp: 4000, costUsd: '10', buyCostUsd: '100', priceUsd: '0.1' });

    const report = computeCopySimulationReport(database, { walletAddresses: ['W1'], feeBps: 0, slippageBps: 0 });
    const wallet = report.wallets[0]!;
    assert.equal(wallet.roundTripsConsidered, 2);
    assert.equal(wallet.copiedTrades, 1);
    assert.equal(wallet.walletMedianReturnPercent, 100, 'the wallet median must reflect only the trade that was actually simulated, not the uncopied -90% one');
    assert.equal(wallet.simulatedMedianReturnPercent, 100);
    assert.equal(wallet.coverageRatePercent, 50, '1 of 2 round trips copied');
  } finally { database.close(); }
});

test('gas fee is reported separately in SOL, two transactions per copied round trip, and is null for anything not actually simulated', () => {
  const database = setup();
  try {
    // W1: one simulated round trip.
    const buy1 = insertTradeRow(database, { walletAddress: 'W1', eventType: 'buy', tokenAddress: 'TOKA', observedTimestamp: 1000, buyCostUsd: '100', priceUsd: '1' });
    const sell1 = insertTradeRow(database, { walletAddress: 'W1', eventType: 'sell', tokenAddress: 'TOKA', observedTimestamp: 2000, costUsd: '150', buyCostUsd: '100', priceUsd: '1.5' });
    seedDuneMatch(database, buy1, new Date((1000 + DEFAULT_COPIER_DELAY_SECONDS) * 1000).toISOString(), 1.0);
    seedDuneMatch(database, sell1, new Date((2000 + DEFAULT_COPIER_DELAY_SECONDS) * 1000).toISOString(), 1.5);
    // W1: a second sell with a stale entry match — never actually copied, so no gas paid.
    const buy2 = insertTradeRow(database, { walletAddress: 'W1', eventType: 'buy', tokenAddress: 'TOKB', observedTimestamp: 3000, buyCostUsd: '100', priceUsd: '1' });
    const sell2 = insertTradeRow(database, { walletAddress: 'W1', eventType: 'sell', tokenAddress: 'TOKB', observedTimestamp: 4000, costUsd: '110', buyCostUsd: '100', priceUsd: '1.1' });
    seedDuneMatch(database, buy2, new Date((3000 + DEFAULT_COPIER_DELAY_SECONDS + MAX_MATCH_GAP_SECONDS + 60) * 1000).toISOString(), 1.0);
    seedDuneMatch(database, sell2, new Date((4000 + DEFAULT_COPIER_DELAY_SECONDS) * 1000).toISOString(), 1.1);

    const report = computeCopySimulationReport(database, { walletAddresses: ['W1'], gasPriorityFeeSolPerTx: 0.002 });
    const wallet = report.wallets[0]!;
    assert.equal(wallet.copiedTrades, 1);
    assert.equal(wallet.trades.find((t) => t.tokenAddress === 'TOKA')?.gasFeeSol, 0.004, 'one buy + one sell = two gas payments');
    assert.equal(wallet.trades.find((t) => t.tokenAddress === 'TOKB')?.gasFeeSol, null, 'a trade that was never actually copied paid no gas');
    assert.equal(wallet.totalGasFeeSol, 0.004);
    assert.equal(report.assumptions.gasPriorityFeeSolPerTx, 0.002);
  } finally { database.close(); }
});

test('fixed-stake portfolio never reinvests the full bankroll and caps each loss at its stake', () => {
  const portfolio = simulateFixedStakePortfolio([
    { id: 1, entryAt: 1, exitAt: 2, returnRatio: 0.5, gasFeeSol: 0.004 },
    { id: 2, entryAt: 3, exitAt: 4, returnRatio: -5, gasFeeSol: 0.004 },
  ]);
  assert.equal(portfolio.endingCapitalUsd, 95, '$10 gains $5, then the next $10 can lose at most $10');
  assert.equal(portfolio.realizedPnlUsd, -5);
  assert.equal(portfolio.copiedTrades, 2);
  assert.equal(portfolio.maxConcurrentPositions, 1);
  assert.equal(portfolio.gasFeeSol, 0.008, 'fixed SOL gas is reported, not silently converted with a guessed price');
});

test('fixed-stake portfolio enforces both cash and concurrent-position limits', () => {
  const overlapping = Array.from({ length: 11 }, (_, index) => ({
    id: index + 1, entryAt: 1 + index, exitAt: 100 + index, returnRatio: 0.1, gasFeeSol: 0,
  }));
  const portfolio = simulateFixedStakePortfolio(overlapping);
  assert.equal(portfolio.copiedTrades, 10);
  assert.equal(portfolio.skippedMaxOpenPositions, 1);
  assert.equal(portfolio.maxConcurrentPositions, 10);
  assert.equal(portfolio.endingCapitalUsd, 110);

  const cashLimited = simulateFixedStakePortfolio([
    { id: 1, entryAt: 1, exitAt: 10, returnRatio: 1, gasFeeSol: 0 },
    { id: 2, entryAt: 2, exitAt: 9, returnRatio: 1, gasFeeSol: 0 },
  ], { startingCapitalUsd: 15, stakePerTradeUsd: 10, maxOpenPositions: 10 });
  assert.equal(cashLimited.copiedTrades, 1);
  assert.equal(cashLimited.skippedInsufficientCash, 1);
  assert.equal(cashLimited.endingCapitalUsd, 25);
});

test('partial sells allocate one copied position proportionally instead of opening duplicate stakes', () => {
  const database = setup();
  try {
    const buyId = insertTradeRow(database, { walletAddress: 'PARTIAL', eventType: 'buy', tokenAddress: 'TOKP', observedTimestamp: 1000, tokenAmount: '100', buyCostUsd: '100', priceUsd: '1' });
    const sellOneId = insertTradeRow(database, { walletAddress: 'PARTIAL', eventType: 'sell', tokenAddress: 'TOKP', observedTimestamp: 1100, tokenAmount: '40', costUsd: '80', buyCostUsd: '40', priceUsd: '2' });
    const sellTwoId = insertTradeRow(database, { walletAddress: 'PARTIAL', eventType: 'sell', tokenAddress: 'TOKP', observedTimestamp: 1200, tokenAmount: '60', costUsd: '180', buyCostUsd: '60', priceUsd: '3' });
    for (const [id, at, price] of [[buyId, 1000, 1], [sellOneId, 1100, 2], [sellTwoId, 1200, 3]] as const) {
      seedDuneMatch(database, id, new Date((at + DEFAULT_COPIER_DELAY_SECONDS) * 1000).toISOString(), price);
    }
    const wallet = computeCopySimulationReport(database, { walletAddresses: ['PARTIAL'], feeBps: 0, slippageBps: 0, gasPriorityFeeSolPerTx: 0 }).wallets[0]!;
    assert.equal(wallet.roundTripsConsidered, 2);
    assert.equal(wallet.copiedTrades, 2);
    assert.equal(wallet.portfolio.maxConcurrentPositions, 1);
    assert.deepEqual(wallet.trades.map((trade) => trade.copyStakeUsd), [4, 6]);
    assert.equal(wallet.portfolio.endingCapitalUsd, 115.97, 'one $10 position is split 40/60 and recorded gas is charged once for the buy and once per sell');
  } finally { database.close(); }
});

test('open positions are marked at the period cutoff and reported separately from realized PnL', () => {
  const portfolio = simulateFixedStakePortfolio([{
    id: -7, positionId: 7, entryAt: 100, exitAt: 200, returnRatio: 0, stakeUsd: 10,
    gasFeeSol: 0, gasFeeUsd: null, entryGasFeeSol: 0, entryGasFeeUsd: null,
    cutoffReturnRatio: 0.5, isOpenAtCutoff: true,
  }]);
  assert.equal(portfolio.openPositionsMarked, 1);
  assert.equal(portfolio.openPositionsUnpriced, 0);
  assert.equal(portfolio.realizedPnlUsd, 0);
  assert.equal(portfolio.markToMarketPnlUsd, 5);
  assert.equal(portfolio.endingCapitalUsd, 105);
  assert.equal(portfolio.copiedTrades, 0);
});

test('copy simulation exposes the fixed-stake portfolio from the same delayed fee-adjusted prices', () => {
  const database = setup();
  try {
    const buyId = insertTradeRow(database, { walletAddress: 'W1', eventType: 'buy', tokenAddress: 'TOKA', observedTimestamp: 1000, buyCostUsd: '100', priceUsd: '1' });
    const sellId = insertTradeRow(database, { walletAddress: 'W1', eventType: 'sell', tokenAddress: 'TOKA', observedTimestamp: 2000, costUsd: '150', buyCostUsd: '100', priceUsd: '1.5' });
    seedDuneMatch(database, buyId, new Date((1000 + DEFAULT_COPIER_DELAY_SECONDS) * 1000).toISOString(), 1);
    seedDuneMatch(database, sellId, new Date((2000 + DEFAULT_COPIER_DELAY_SECONDS) * 1000).toISOString(), 1.5);
    const wallet = computeCopySimulationReport(database, { walletAddresses: ['W1'] }).wallets[0]!;
    assert.equal(wallet.portfolio.copiedTrades, 1);
  assert.equal(wallet.portfolio.endingCapitalUsd, 104.54, 'the $10 stake receives the fee/slippage-adjusted return minus recorded gas USD');
    assert.equal(wallet.portfolio.capitalPath.at(-1)?.capitalUsd, 104.54);
  } finally { database.close(); }
});

test('entry/exit trade USD size (the liquidity proxy) is carried through when present, and stays null rather than zero when a leg has no usable match', () => {
  const database = setup();
  try {
    // W1: both legs matched with a real amount_usd from Dune.
    const buy1 = insertTradeRow(database, { walletAddress: 'W1', eventType: 'buy', tokenAddress: 'TOKA', observedTimestamp: 1000, buyCostUsd: '100', priceUsd: '1' });
    const sell1 = insertTradeRow(database, { walletAddress: 'W1', eventType: 'sell', tokenAddress: 'TOKA', observedTimestamp: 2000, costUsd: '150', buyCostUsd: '100', priceUsd: '1.5' });
    seedDuneMatch(database, buy1, new Date((1000 + DEFAULT_COPIER_DELAY_SECONDS) * 1000).toISOString(), 1.0, 4321.5);
    seedDuneMatch(database, sell1, new Date((2000 + DEFAULT_COPIER_DELAY_SECONDS) * 1000).toISOString(), 1.5, 9876.25);

    const report = computeCopySimulationReport(database, { walletAddresses: ['W1'] });
    const wallet = report.wallets[0]!;
    const simulated = wallet.trades.find((t) => t.tokenAddress === 'TOKA')!;
    assert.equal(simulated.status, 'simulated');
    assert.equal(simulated.entryTradeAmountUsd, 4321.5);
    assert.equal(simulated.exitTradeAmountUsd, 9876.25);

    // Trade 3: never queried at all — both fields must be null, not zero.
    insertTradeRow(database, { walletAddress: 'W1', eventType: 'buy', tokenAddress: 'TOKC', observedTimestamp: 5000, buyCostUsd: '100', priceUsd: '1' });
    insertTradeRow(database, { walletAddress: 'W1', eventType: 'sell', tokenAddress: 'TOKC', observedTimestamp: 6000, costUsd: '90', buyCostUsd: '100', priceUsd: '0.9' });
    const report2 = computeCopySimulationReport(database, { walletAddresses: ['W1'] });
    const neverQueried = report2.wallets[0]!.trades.find((t) => t.tokenAddress === 'TOKC')!;
    assert.equal(neverQueried.status, 'not_yet_queried');
    assert.equal(neverQueried.entryTradeAmountUsd, null);
    assert.equal(neverQueried.exitTradeAmountUsd, null);
  } finally { database.close(); }
});

test('a wallet with no round trips at all returns null summary stats, not zeros', () => {
  const database = setup();
  try {
    const report = computeCopySimulationReport(database, { walletAddresses: ['GHOST'] });
    const wallet = report.wallets[0]!;
    assert.equal(wallet.walletMedianReturnPercent, null);
    assert.equal(wallet.simulatedMedianReturnPercent, null);
    assert.equal(wallet.coverageRatePercent, null);
    assert.equal(wallet.delayCostPercentagePoints, null);
    assert.equal(wallet.totalGasFeeSol, null);
  } finally { database.close(); }
});

const makeTrade = (over: Partial<CopySimulationTradeResult> & { entryTradeAmountUsd: number | null }): CopySimulationTradeResult => ({
  tokenAddress: 'TOK', tokenSymbol: null, walletReturnPercent: null, simulatedReturnPercent: null,
  status: 'not_yet_queried', entryGapSeconds: null, exitGapSeconds: null, gasFeeSol: null,
  exitTradeAmountUsd: null, ...over,
});

const emptyPortfolio = () => ({
  startingCapitalUsd: 100, stakePerTradeUsd: 10, maxOpenPositions: 10, endingCapitalUsd: 100,
  realizedPnlUsd: 0, eligibleTrades: 0, copiedTrades: 0, skippedInsufficientCash: 0,
  skippedMaxOpenPositions: 0, maxConcurrentPositions: 0, gasFeeSol: 0, capitalPath: [],
});

const makeReport = (trades: CopySimulationTradeResult[]): CopySimulationReport => ({
  computedAt: new Date().toISOString(),
  assumptions: { copierDelaySeconds: 15, feeBps: 100, slippageBps: 50, gasPriorityFeeSolPerTx: 0.002, maxMatchGapSeconds: MAX_MATCH_GAP_SECONDS, maxRoundTripsPerWallet: 150, startingCapitalUsd: 100, stakePerTradeUsd: 10, maxOpenPositions: 10 },
  wallets: [{
    walletAddress: 'W1', roundTripsConsidered: trades.length, copiedTrades: trades.filter((t) => t.status === 'simulated').length,
    missedTrades: trades.filter((t) => t.status !== 'simulated').length, coverageRatePercent: null,
    walletMedianReturnPercent: null, simulatedMedianReturnPercent: null, delayCostPercentagePoints: null,
    walletMeanReturnPercent: null, simulatedMeanReturnPercent: null, tradesAbove100Percent: 0,
    tradesAbove300Percent: 0, bestSimulatedReturnPercent: null, tailShareOfMeanPercent: null,
    worstSimulatedReturnPercent: null, totalGasFeeSol: null, portfolio: emptyPortfolio(), trades,
  }],
});

test('liquidity impact: trades with no entry match at all are excluded from every band, not defaulted into one', () => {
  const trades = [
    makeTrade({ entryTradeAmountUsd: null, status: 'not_yet_queried' }),
    makeTrade({ entryTradeAmountUsd: 100, status: 'simulated', simulatedReturnPercent: 5, walletReturnPercent: 6 }),
    makeTrade({ entryTradeAmountUsd: 200, status: 'simulated', simulatedReturnPercent: 5, walletReturnPercent: 6 }),
    makeTrade({ entryTradeAmountUsd: 300, status: 'simulated', simulatedReturnPercent: 5, walletReturnPercent: 6 }),
  ];
  const impact = computeLiquidityImpactReport(makeReport(trades));
  assert.equal(impact.totalTradesConsidered, 4);
  assert.equal(impact.unbandableCount, 1, 'the never-queried trade has no entryTradeAmountUsd and must be excluded, not zero-banded');
  const totalBanded = impact.bands.reduce((sum, b) => sum + b.tradeCount, 0);
  assert.equal(totalBanded, 3);
});

test('liquidity impact: fewer than 3 bandable trades returns no bands at all rather than a degenerate split', () => {
  const trades = [makeTrade({ entryTradeAmountUsd: 100 }), makeTrade({ entryTradeAmountUsd: 200 })];
  const impact = computeLiquidityImpactReport(makeReport(trades));
  assert.deepEqual(impact.bands, []);
  assert.equal(impact.unbandableCount, 0);
});

test('liquidity impact: terciles split into low/medium/high by entry trade USD size, win rate and delay cost computed per band', () => {
  const trades = [
    // Low band: small entries, all wins, zero delay cost.
    makeTrade({ entryTradeAmountUsd: 10, status: 'simulated', simulatedReturnPercent: 20, walletReturnPercent: 20 }),
    makeTrade({ entryTradeAmountUsd: 20, status: 'simulated', simulatedReturnPercent: 10, walletReturnPercent: 10 }),
    makeTrade({ entryTradeAmountUsd: 30, status: 'simulated', simulatedReturnPercent: 15, walletReturnPercent: 15 }),
    // Medium band: one win, one loss, real delay cost.
    makeTrade({ entryTradeAmountUsd: 1000, status: 'simulated', simulatedReturnPercent: -5, walletReturnPercent: 5 }),
    makeTrade({ entryTradeAmountUsd: 1100, status: 'simulated', simulatedReturnPercent: 8, walletReturnPercent: 8 }),
    makeTrade({ entryTradeAmountUsd: 1200, status: 'missing_exit_match' }),
    // High band: large entries, missed trade included.
    makeTrade({ entryTradeAmountUsd: 50000, status: 'simulated', simulatedReturnPercent: 3, walletReturnPercent: 3 }),
    makeTrade({ entryTradeAmountUsd: 60000, status: 'simulated', simulatedReturnPercent: -1, walletReturnPercent: 1 }),
    makeTrade({ entryTradeAmountUsd: 70000, status: 'not_yet_queried' }),
  ];
  const impact = computeLiquidityImpactReport(makeReport(trades));
  assert.equal(impact.bands.length, 3);
  assert.equal(impact.dataSource, 'dune_matched_trade_amount_usd');
  assert.equal(impact.measuredVsProxied, 'proxied');

  const low = impact.bands.find((b) => b.band === 'low')!;
  assert.equal(low.tradeCount, 3);
  assert.equal(low.simulatedCount, 3);
  assert.equal(low.winRatePercent, 100);
  assert.equal(low.medianDelayCostPercentagePoints, 0, 'no fees/slippage modeled here — simulated equals wallet return, so delay cost is 0');

  const medium = impact.bands.find((b) => b.band === 'medium')!;
  assert.equal(medium.tradeCount, 3);
  assert.equal(medium.simulatedCount, 2);
  assert.equal(medium.missedCount, 1);
  assert.equal(medium.winRatePercent, 50);

  const high = impact.bands.find((b) => b.band === 'high')!;
  assert.equal(high.tradeCount, 3);
  assert.equal(high.simulatedCount, 2);
  assert.equal(high.missedCount, 1);

  // Every band here has under MIN_LIQUIDITY_BAND_SAMPLE simulated trades — none should claim reliability.
  for (const band of impact.bands) assert.equal(band.reliable, false, `band ${band.band} has fewer than ${MIN_LIQUIDITY_BAND_SAMPLE} simulated trades`);
});

test('liquidity impact: a band only becomes reliable once it reaches MIN_LIQUIDITY_BAND_SAMPLE simulated trades', () => {
  // All the same entry size, so the whole cluster lands in one band regardless of exact quantile
  // interpolation — keeps this test about the reliability threshold, not tercile arithmetic.
  const manyLow = Array.from({ length: MIN_LIQUIDITY_BAND_SAMPLE + 1 }, () =>
    makeTrade({ entryTradeAmountUsd: 10, status: 'simulated', simulatedReturnPercent: 1, walletReturnPercent: 1 }));
  const fewHigh = [
    makeTrade({ entryTradeAmountUsd: 90000, status: 'simulated', simulatedReturnPercent: 1, walletReturnPercent: 1 }),
    makeTrade({ entryTradeAmountUsd: 95000, status: 'simulated', simulatedReturnPercent: 1, walletReturnPercent: 1 }),
  ];
  const impact = computeLiquidityImpactReport(makeReport([...manyLow, ...fewHigh]));
  const low = impact.bands.find((b) => b.band === 'low')!;
  const high = impact.bands.find((b) => b.band === 'high')!;
  assert.equal(low.simulatedCount, MIN_LIQUIDITY_BAND_SAMPLE + 1);
  assert.equal(low.reliable, true);
  assert.ok(high.simulatedCount < MIN_LIQUIDITY_BAND_SAMPLE);
  assert.equal(high.reliable, false);
});

const makeReportForWallets = (wallets: Array<{ walletAddress: string; trades: CopySimulationTradeResult[] }>): CopySimulationReport => ({
  computedAt: new Date().toISOString(),
  assumptions: { copierDelaySeconds: 15, feeBps: 100, slippageBps: 50, gasPriorityFeeSolPerTx: 0.002, maxMatchGapSeconds: MAX_MATCH_GAP_SECONDS, maxRoundTripsPerWallet: 150, startingCapitalUsd: 100, stakePerTradeUsd: 10, maxOpenPositions: 10 },
  wallets: wallets.map(({ walletAddress, trades }) => ({
    walletAddress, roundTripsConsidered: trades.length, copiedTrades: trades.filter((t) => t.status === 'simulated').length,
    missedTrades: trades.filter((t) => t.status !== 'simulated').length, coverageRatePercent: null,
    walletMedianReturnPercent: null, simulatedMedianReturnPercent: null, delayCostPercentagePoints: null,
    walletMeanReturnPercent: null, simulatedMeanReturnPercent: null, tradesAbove100Percent: 0,
    tradesAbove300Percent: 0, bestSimulatedReturnPercent: null, tailShareOfMeanPercent: null,
    worstSimulatedReturnPercent: null, totalGasFeeSol: null, portfolio: emptyPortfolio(), trades,
  })),
});

test('liquidity impact: byWallet slices each winner using the SAME thresholds as the aggregate, so small trades mean the same size for every wallet', () => {
  // Same 9 entry amounts as the tercile test above (10,20,30 / 1000,1100,1200 / 50000,60000,70000),
  // just spread across three wallets so the low band's threshold is set from the combined pool,
  // not any single wallet's own trades.
  const report = makeReportForWallets([
    { walletAddress: 'WA', trades: [
      makeTrade({ entryTradeAmountUsd: 10, status: 'simulated', simulatedReturnPercent: 20, walletReturnPercent: 20 }),
      makeTrade({ entryTradeAmountUsd: 1000, status: 'simulated', simulatedReturnPercent: 5, walletReturnPercent: 5 }),
    ] },
    { walletAddress: 'WB', trades: [
      makeTrade({ entryTradeAmountUsd: 20, status: 'simulated', simulatedReturnPercent: -5, walletReturnPercent: 5 }),
      makeTrade({ entryTradeAmountUsd: 1100, status: 'simulated', simulatedReturnPercent: 5, walletReturnPercent: 5 }),
    ] },
    { walletAddress: 'WC', trades: [
      makeTrade({ entryTradeAmountUsd: 30, status: 'simulated', simulatedReturnPercent: 1, walletReturnPercent: 1 }),
      makeTrade({ entryTradeAmountUsd: 1200, status: 'simulated', simulatedReturnPercent: 1, walletReturnPercent: 1 }),
      makeTrade({ entryTradeAmountUsd: 50000, status: 'simulated', simulatedReturnPercent: 1, walletReturnPercent: 1 }),
      makeTrade({ entryTradeAmountUsd: 60000, status: 'simulated', simulatedReturnPercent: 1, walletReturnPercent: 1 }),
      makeTrade({ entryTradeAmountUsd: 70000, status: 'simulated', simulatedReturnPercent: 1, walletReturnPercent: 1 }),
    ] },
  ]);

  const impact = computeLiquidityImpactReport(report);
  assert.equal(impact.bands.find((b) => b.band === 'low')!.tradeCount, 3, 'aggregate low band still holds all three wallets\' small trades combined');
  assert.equal(impact.byWallet.length, 3);

  const walletA = impact.byWallet.find((w) => w.walletAddress === 'WA')!;
  const lowA = walletA.bands.find((b) => b.band === 'low')!;
  assert.equal(lowA.tradeCount, 1, 'wallet A contributes exactly its own one small trade to its own slice');
  assert.equal(lowA.medianSimulatedReturnPercent, 20, 'wallet A\'s small trade is a real win');

  const walletB = impact.byWallet.find((w) => w.walletAddress === 'WB')!;
  const lowB = walletB.bands.find((b) => b.band === 'low')!;
  assert.equal(lowB.tradeCount, 1);
  assert.equal(lowB.medianSimulatedReturnPercent, -5, 'wallet B\'s small trade is a real loss — the whole point of a per-wallet slice');

  const walletC = impact.byWallet.find((w) => w.walletAddress === 'WC')!;
  assert.equal(walletC.bands.find((b) => b.band === 'low')!.tradeCount, 1, 'wallet C\'s 30-size trade still lands in low using the shared threshold, not a wallet-specific one');
  assert.equal(walletC.bands.find((b) => b.band === 'high')!.tradeCount, 3);
});
