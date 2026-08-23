import assert from 'node:assert/strict';
import test from 'node:test';
import { computeHistoricalConsistency, type HistoricalConsistencyTrade } from '../src/copytrade/scrutiny/historicalConsistency.js';

const NOW = new Date('2026-08-15T00:00:00.000Z');
const DAY = 86_400;

const sell = (
  walletAddress: string,
  daysAgo: number,
  returnPercent: number,
  tokenAddress = `${walletAddress}-TOKEN`,
): HistoricalConsistencyTrade => ({
  id: Math.round(daysAgo * 1000) + walletAddress.length,
  walletAddress,
  observedTimestamp: Math.floor(NOW.getTime() / 1000) - daysAgo * DAY,
  eventType: 'sell',
  tokenAddress,
  tokenSymbol: tokenAddress.slice(-5),
  costUsd: String(100 + returnPercent),
  buyCostUsd: '100',
});

test('historical consistency marks under-30-day wallets insufficient', () => {
  const report = computeHistoricalConsistency([
    sell('SHORT', 20, 25),
    sell('SHORT', 2, 10),
  ], NOW);

  assert.equal(report.rows[0].split, 'insufficient_depth');
  assert.equal(report.rows[0].verdict, 'insufficient');
  assert.equal(report.rows[0].early.trades, 0);
  assert.equal(report.rows[0].recent.trades, 0);
  assert.equal(report.counts.insufficient, 1);
});

test('30-to-90-day history uses a relative half split and computes periods independently', () => {
  const report = computeHistoricalConsistency([
    sell('RELATIVE', 80, 30, 'EARLY_A'),
    sell('RELATIVE', 55, 20, 'EARLY_B'),
    sell('RELATIVE', 25, 10, 'RECENT_A'),
    sell('RELATIVE', 5, 15, 'RECENT_B'),
  ], NOW);
  const row = report.rows[0];

  assert.equal(row.split, 'relative_half');
  assert.equal(row.verdict, 'consistent');
  assert.equal(row.early.summary.medianReturnPercent, 25);
  assert.equal(row.recent.summary.medianReturnPercent, 12.5);
  assert.equal(row.early.profitConcentration.bestToken?.tokenAddress, 'EARLY_A');
  assert.equal(row.recent.profitConcentration.bestToken?.tokenAddress, 'RECENT_B');
  assert.equal(row.early.weeklyPerformance.length, 2);
  assert.equal(row.recent.weeklyPerformance.length, 2);
  assert.equal(row.early.weeklyConsistency.positivePercent, 100);
  assert.equal(row.recent.weeklyConsistency.positivePercent, 100);
});

test('90-day history uses fixed early-60/recent-30 windows', () => {
  const report = computeHistoricalConsistency([
    sell('FIXED', 100, -50, 'OUTSIDE_WINDOW'),
    sell('FIXED', 80, 20, 'EARLY_A'),
    sell('FIXED', 45, 10, 'EARLY_B'),
    sell('FIXED', 20, 15, 'RECENT_A'),
    sell('FIXED', 4, 5, 'RECENT_B'),
  ], NOW);
  const row = report.rows[0];

  assert.equal(row.split, 'fixed_60_30');
  assert.equal(row.early.trades, 2, 'the fixed early slice excludes the older observation');
  assert.equal(row.recent.trades, 2);
  assert.equal(row.early.summary.medianReturnPercent, 15);
  assert.equal(row.recent.summary.medianReturnPercent, 10);
  assert.equal(row.verdict, 'consistent');
});

test('verdict distinguishes recent-only and declining wallets', () => {
  const report = computeHistoricalConsistency([
    sell('RECENT_ONLY', 80, -20),
    sell('RECENT_ONLY', 45, -10),
    sell('RECENT_ONLY', 20, 30),
    sell('RECENT_ONLY', 4, 20),
    sell('DECLINING', 80, 20),
    sell('DECLINING', 45, 10),
    sell('DECLINING', 20, -30),
    sell('DECLINING', 4, -20),
  ], NOW);
  const rows = new Map(report.rows.map((row) => [row.walletAddress, row]));

  assert.equal(rows.get('RECENT_ONLY')?.verdict, 'recent_only');
  assert.equal(rows.get('DECLINING')?.verdict, 'declining');
  assert.equal(report.counts.recent_only, 1);
  assert.equal(report.counts.declining, 1);
});

test('a wallet with real data in both periods that is simply negative both times is consistently_negative, not insufficient', () => {
  const report = computeHistoricalConsistency([
    sell('BAD', 80, -10), sell('BAD', 45, -5),
    sell('BAD', 20, -20), sell('BAD', 4, -15),
  ], NOW);
  const row = report.rows[0];

  assert.equal(row.verdict, 'consistently_negative');
  assert.notEqual(row.verdict, 'insufficient', 'plenty of real data exists in both periods — this must never be confused with "not enough data to judge"');
  assert.equal(report.counts.consistently_negative, 1);
  assert.equal(report.counts.insufficient, 0);
});

test('malformed or non-sell rows are retained by callers but excluded from computed outcomes', () => {
  const report = computeHistoricalConsistency([
    sell('VALID', 80, 20),
    sell('VALID', 5, 10),
    { ...sell('VALID', 4, 10), eventType: 'buy' },
    { ...sell('VALID', 3, 10), costUsd: null },
  ], NOW);

  assert.equal(report.rows[0].early.trades, 1);
  assert.equal(report.rows[0].recent.trades, 1);
  assert.equal(report.rows[0].early.summary.medianReturnPercent, 20);
  assert.equal(report.rows[0].recent.summary.medianReturnPercent, 10);
});
