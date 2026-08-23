import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase } from '../src/db/client.js';
import { readOutcomeSummary, refreshOutcomes, upsertMarketBars } from '../src/research/outcomes.js';
import { normalizeYahooChart } from '../src/providers/market-data.js';

const makeDb = () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'unusual-whales-outcomes-'));
  return { directory, database: createDatabase(path.join(directory, 'test.sqlite')) };
};

test('normalizes Yahoo chart timestamps and skips null closes', () => {
  const bars = normalizeYahooChart({ chart: { result: [{ timestamp: [1767366000, 1767366060], indicators: { quote: [{ open: [100, 101], high: [102, 103], low: [99, 100], close: [101, null], volume: [10, 20] }] } }] } }, {
    symbol: 'ABC', timeframe: '1m', period1: new Date('2026-01-01T00:00:00Z'), period2: new Date('2026-01-02T00:00:00Z'),
  });
  assert.equal(bars.length, 1);
  assert.equal(bars[0].symbol, 'ABC');
  assert.equal(bars[0].source, 'yahoo_chart');
  assert.equal(bars[0].close, 101);
});

test('calculates mature returns, SPY excess, costs, and excludes overlapping events', () => {
  const { directory, database } = makeDb();
  try {
    const batch = database.prepare(`INSERT INTO uw_import_batches(endpoint,query_json,requested_at,status) VALUES('test','{}','2026-01-01T00:00:00Z','completed')`).run();
    const batchId = Number(batch.lastInsertRowid);
    const addTrade = database.prepare(`INSERT INTO uw_option_trades(source_trade_id,source_batch_id,executed_at,captured_at,signal_type,underlying_symbol,option_type,raw_payload) VALUES(?,?,?,?,?,?,?,?)`);
    addTrade.run('a', batchId, '2026-01-02T15:00:00Z', '2026-01-02T15:00:00Z', 'call_sweep', 'ABC', 'call', '{}');
    addTrade.run('b', batchId, '2026-01-02T15:02:00Z', '2026-01-02T15:02:00Z', 'call_sweep', 'ABC', 'call', '{}');
    upsertMarketBars(database, [
      { symbol:'ABC', timeframe:'1m', observedAt:'2026-01-02T15:00:00Z', close:100, source:'fixture' },
      { symbol:'ABC', timeframe:'1m', observedAt:'2026-01-02T15:05:00Z', close:102, source:'fixture' },
      { symbol:'SPY', timeframe:'1m', observedAt:'2026-01-02T15:00:00Z', close:500, source:'fixture' },
      { symbol:'SPY', timeframe:'1m', observedAt:'2026-01-02T15:05:00Z', close:501, source:'fixture' },
    ]);
    refreshOutcomes(database, new Date('2026-01-03T00:00:00Z'));
    const summary = readOutcomeSummary(database)['+5m'];
    assert.equal(summary.nRaw, 2);
    assert.equal(summary.nIndependent, 1);
    assert.equal(summary.nMature, 1);
    assert.equal(summary.nWithOutcome, 1);
    assert.equal(summary.winRate, 100);
    assert.equal(Number(summary.averageReturnPct?.toFixed(4)), 2);
    assert.equal(Number(summary.averageExcessPct?.toFixed(4)), 1.8);
    assert.equal(Number(summary.netByCostBpsPerSide['10']?.toFixed(4)), 1.8);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('batches writes into transactions without dropping or duplicating rows across the batch boundary', () => {
  const { directory, database } = makeDb();
  try {
    const batch = database.prepare(`INSERT INTO uw_import_batches(endpoint,query_json,requested_at,status) VALUES('test','{}','2026-01-01T00:00:00Z','completed')`).run();
    const batchId = Number(batch.lastInsertRowid);
    const addTrade = database.prepare(`INSERT INTO uw_option_trades(source_trade_id,source_batch_id,executed_at,captured_at,signal_type,underlying_symbol,option_type,raw_payload) VALUES(?,?,?,?,?,?,?,?)`);
    // 250 trades on distinct tickers (so none are treated as overlapping) crosses the
    // internal transaction-batch boundary at least once.
    const tradeCount = 250;
    for (let i = 0; i < tradeCount; i++) {
      const symbol = `SYM${i}`;
      addTrade.run(`t${i}`, batchId, '2026-01-02T15:00:00Z', '2026-01-02T15:00:00Z', 'call_sweep', symbol, 'call', '{}');
      database.prepare(`INSERT INTO uw_market_bars (symbol,timeframe,observed_at,close,source,retrieved_at) VALUES (?,?,?,?,?,?)`)
        .run(symbol, '1m', '2026-01-02T15:00:00Z', 100, 'fixture', '2026-01-02T15:00:00Z');
      database.prepare(`INSERT INTO uw_market_bars (symbol,timeframe,observed_at,close,source,retrieved_at) VALUES (?,?,?,?,?,?)`)
        .run(symbol, '1m', '2026-01-02T15:05:00Z', 102, 'fixture', '2026-01-02T15:05:00Z');
    }
    upsertMarketBars(database, [
      { symbol: 'SPY', timeframe: '1m', observedAt: '2026-01-02T15:00:00Z', close: 500, source: 'fixture' },
      { symbol: 'SPY', timeframe: '1m', observedAt: '2026-01-02T15:05:00Z', close: 501, source: 'fixture' },
    ]);
    const written = refreshOutcomes(database, new Date('2026-01-03T00:00:00Z'));
    assert.equal(written, tradeCount * 8, 'one outcome row per trade per horizon, none dropped across the batch boundary');
    const outcomeRowCount = (database.prepare('SELECT COUNT(*) AS n FROM uw_signal_outcomes').get() as { n: number }).n;
    assert.equal(outcomeRowCount, tradeCount * 8, 'no duplicates either');
    const summary = readOutcomeSummary(database)['+5m'];
    assert.equal(summary.nWithOutcome, tradeCount);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('does not use a future outcome before the horizon is mature', () => {
  const { directory, database } = makeDb();
  try {
    const batch = database.prepare(`INSERT INTO uw_import_batches(endpoint,query_json,requested_at,status) VALUES('test','{}','2026-01-01T00:00:00Z','completed')`).run();
    database.prepare(`INSERT INTO uw_option_trades(source_trade_id,source_batch_id,executed_at,captured_at,signal_type,underlying_symbol,option_type,raw_payload) VALUES('a',?,?,?,?,?,?,?)`)
      .run(Number(batch.lastInsertRowid), '2026-01-02T15:00:00Z', '2026-01-02T15:00:00Z', 'call_sweep', 'ABC', 'call', '{}');
    upsertMarketBars(database, [{ symbol:'ABC', timeframe:'1m', observedAt:'2026-01-02T15:00:00Z', close:100, source:'fixture' }]);
    refreshOutcomes(database, new Date('2026-01-02T15:02:00Z'));
    const row = database.prepare(`SELECT exclusion_reason, outcome_price FROM uw_signal_outcomes WHERE horizon='+5m'`).get() as { exclusion_reason: string; outcome_price: number|null };
    assert.equal(row.exclusion_reason, 'outcome_not_mature');
    assert.equal(row.outcome_price, null);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('does not reuse the entry daily bar when a calendar horizon lands before the next session', () => {
  const { directory, database } = makeDb();
  try {
    const batch = database.prepare(`INSERT INTO uw_import_batches(endpoint,query_json,requested_at,status) VALUES('test','{}','2026-01-01T00:00:00Z','completed')`).run();
    database.prepare(`INSERT INTO uw_option_trades(source_trade_id,source_batch_id,executed_at,captured_at,signal_type,underlying_symbol,option_type,raw_payload) VALUES('a',?,?,?,?,?,?,?)`)
      .run(Number(batch.lastInsertRowid), '2026-01-02T15:00:00.100Z', '2026-01-02T15:00:00.100Z', 'put_sweep', 'ABC', 'put', '{}');
    upsertMarketBars(database, [
      { symbol: 'ABC', timeframe: '1d', observedAt: '2026-01-02T15:00:00Z', close: 100, source: 'fixture' },
      { symbol: 'ABC', timeframe: '1d', observedAt: '2026-01-05T15:00:00Z', close: 95, source: 'fixture' },
      { symbol: 'ABC', timeframe: '1d', observedAt: '2026-01-06T15:00:00Z', close: 90, source: 'fixture' },
      { symbol: 'SPY', timeframe: '1d', observedAt: '2026-01-05T15:00:00Z', close: 500, source: 'fixture' },
      { symbol: 'SPY', timeframe: '1d', observedAt: '2026-01-06T15:00:00Z', close: 501, source: 'fixture' },
    ]);
    refreshOutcomes(database, new Date('2026-01-10T00:00:00Z'));
    const row = database.prepare(`SELECT entry_price,outcome_price,return_pct FROM uw_signal_outcomes WHERE horizon='+1d'`).get() as { entry_price: number; outcome_price: number; return_pct: number };
    assert.equal(row.entry_price, 95);
    assert.equal(row.outcome_price, 90);
    assert.equal(Number(row.return_pct.toFixed(2)), -5.26);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('resumed passes include trades imported earlier than the old checkpoint cursor', () => {
  const { directory, database } = makeDb();
  try {
    const batch = database.prepare(`INSERT INTO uw_import_batches(endpoint,query_json,requested_at,status) VALUES('test','{}','2026-01-01T00:00:00Z','completed')`).run();
    const addTrade = database.prepare(`INSERT INTO uw_option_trades(source_trade_id,source_batch_id,executed_at,captured_at,signal_type,underlying_symbol,option_type,raw_payload) VALUES(?,?,?,?,?,?,?,?)`);
    addTrade.run('a', Number(batch.lastInsertRowid), '2026-01-02T15:00:00Z', '2026-01-02T15:00:00Z', 'call_sweep', 'ABC', 'call', '{}');
    addTrade.run('b', Number(batch.lastInsertRowid), '2026-01-02T15:05:00Z', '2026-01-02T15:05:00Z', 'call_sweep', 'ABC', 'call', '{}');
    upsertMarketBars(database, [
      { symbol:'ABC', timeframe:'1m', observedAt:'2026-01-02T15:00:00Z', close:100, source:'fixture' },
      { symbol:'ABC', timeframe:'1m', observedAt:'2026-01-02T15:05:00Z', close:101, source:'fixture' },
      { symbol:'ABC', timeframe:'1m', observedAt:'2026-01-02T15:10:00Z', close:102, source:'fixture' },
      { symbol:'SPY', timeframe:'1m', observedAt:'2026-01-02T15:00:00Z', close:500, source:'fixture' },
      { symbol:'SPY', timeframe:'1m', observedAt:'2026-01-02T15:10:00Z', close:501, source:'fixture' },
    ]);
    database.prepare(`INSERT INTO uw_outcome_checkpoints(scope,last_symbol,last_executed_at,last_trade_id,completed,total,updated_at) VALUES('historical','ABC','2026-01-02T15:10:00Z',999,999,999,'2026-01-02T15:11:00Z')`).run();
    refreshOutcomes(database, new Date('2026-01-03T00:00:00Z'));
    assert.equal((database.prepare(`SELECT COUNT(*) AS n FROM uw_signal_outcomes`).get() as { n: number }).n, 16);
    assert.equal((database.prepare(`SELECT COUNT(*) AS n FROM uw_signal_outcomes WHERE trade_id=(SELECT id FROM uw_option_trades WHERE source_trade_id='b')`).get() as { n: number }).n, 8);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('resumed passes rebuild overlap state across the checkpoint boundary', () => {
  const { directory, database } = makeDb();
  try {
    const batch = database.prepare(`INSERT INTO uw_import_batches(endpoint,query_json,requested_at,status) VALUES('test','{}','2026-01-01T00:00:00Z','completed')`).run();
    const addTrade = database.prepare(`INSERT INTO uw_option_trades(source_trade_id,source_batch_id,executed_at,captured_at,signal_type,underlying_symbol,option_type,raw_payload) VALUES(?,?,?,?,?,?,?,?)`);
    addTrade.run('a', Number(batch.lastInsertRowid), '2026-01-02T15:00:00Z', '2026-01-02T15:00:00Z', 'call_sweep', 'ABC', 'call', '{}');
    addTrade.run('b', Number(batch.lastInsertRowid), '2026-01-02T15:02:00Z', '2026-01-02T15:02:00Z', 'call_sweep', 'ABC', 'call', '{}');
    upsertMarketBars(database, [
      { symbol:'ABC', timeframe:'1m', observedAt:'2026-01-02T15:00:00Z', close:100, source:'fixture' },
      { symbol:'ABC', timeframe:'1m', observedAt:'2026-01-02T15:05:00Z', close:102, source:'fixture' },
      { symbol:'SPY', timeframe:'1m', observedAt:'2026-01-02T15:00:00Z', close:500, source:'fixture' },
      { symbol:'SPY', timeframe:'1m', observedAt:'2026-01-02T15:05:00Z', close:501, source:'fixture' },
    ]);
    database.prepare(`INSERT INTO uw_outcome_checkpoints(scope,last_symbol,last_executed_at,last_trade_id,completed,total,updated_at) VALUES('historical','ABC','2026-01-02T15:00:00Z',1,1,2,'2026-01-02T15:01:00Z')`).run();
    refreshOutcomes(database, new Date('2026-01-03T00:00:00Z'));
    const secondTradeId = (database.prepare(`SELECT id FROM uw_option_trades WHERE source_trade_id='b'`).get() as { id: number }).id;
    const row = database.prepare(`SELECT exclusion_reason FROM uw_signal_outcomes WHERE trade_id=? AND horizon='+5m'`).get(secondTradeId) as { exclusion_reason: string | null };
    assert.equal(row.exclusion_reason, 'overlapping_event');
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
