import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/platform/db/client.js';
import { measureDuneOutcomes, readAllDuneOutcomes, readLatestDuneOutcomes } from '../src/dune/outcomes.js';
import { storeGmgnSignal } from '../src/gmgn/capture/ingest.js';
import { computeSignalPatternReport } from '../src/signals/patterns.js';

const seedSignal = (database: ReturnType<typeof openDatabase>, id: string, signalType: number, token: string, observedAt = '2026-03-01T00:00:00Z'): number =>
  storeGmgnSignal(database, { id, token_address: token, signal_type: signalType, observed_at: observedAt, market_cap: 1000 }, { source: 'gmgn-cli', chain: 'sol', capturedAt: new Date('2026-03-01T00:00:01Z') }).id;

type FixtureRow = { signal_id: number; checkpoint: string; target_at: string; price_usd: number | null; matched_trade_at?: string | null; matched_tx_id?: string | null };

const insertOutcomeRun = (database: ReturnType<typeof openDatabase>, signalIds: number[], rows: FixtureRow[], completedAt: string | null, requestedAt = '2026-03-02T00:00:00Z') => {
  database.prepare(`
    INSERT INTO dune_outcome_runs (signal_ids, query_sql, execution_id, status, raw_result, requested_at, completed_at)
    VALUES (?, 'select 1', 'exec-1', 'completed', ?, ?, ?)
  `).run(JSON.stringify(signalIds), JSON.stringify({ result: { rows } }), requestedAt, completedAt);
};

test('a checkpoint whose target time is before the run completed is a genuine, unaffected observation', () => {
  const database = openDatabase(':memory:');
  try {
    const a1 = seedSignal(database, 'a1', 6, 'TokenA1');
    insertOutcomeRun(database, [a1], [
      { signal_id: a1, checkpoint: '+5m', target_at: '2026-03-01 00:05:00.000 UTC', price_usd: 1.2, matched_trade_at: '2026-03-01 00:05:00.000 UTC', matched_tx_id: 'tx-1' },
    ], '2026-03-01T00:10:00.000Z');
    const [outcome] = readAllDuneOutcomes(database);
    const checkpoint = outcome.checkpoints.find((c) => c.label === '+5m')!;
    assert.equal(checkpoint.result.priceUsd, 1.2);
    assert.equal(checkpoint.result.status, 'received');
    assert.equal(checkpoint.result.matchedTradeAt, '2026-03-01 00:05:00.000 UTC');
    assert.equal(checkpoint.result.matchedTxId, 'tx-1');
  } finally { database.close(); }
});

test('a received checkpoint from a pre-buffer query is marked for re-verification without changing raw evidence', () => {
  const database = openDatabase(':memory:');
  try {
    const a1 = seedSignal(database, 'early-query', 7, 'EarlyToken', '2026-03-01T00:00:00Z');
    insertOutcomeRun(database, [a1], [
      { signal_id: a1, checkpoint: '+5m', target_at: '2026-03-01 00:05:00.000 UTC', price_usd: 12, matched_trade_at: '2026-03-01 00:04:00.000 UTC', matched_tx_id: 'early-tx' },
    ], '2026-03-01T00:10:00Z', '2026-03-01T01:00:00Z');
    const before = (database.prepare('SELECT raw_result AS rawResult FROM dune_outcome_runs').get() as { rawResult: string }).rawResult;
    const [outcome] = readAllDuneOutcomes(database);
    const checkpoint = outcome.checkpoints.find((entry) => entry.label === '+5m')!;
    assert.equal(checkpoint.result.status, 'premature query — needs re-verification');
    assert.equal(checkpoint.result.priceUsd, null);
    assert.equal(checkpoint.result.matchedTxId, null);
    assert.equal((database.prepare('SELECT raw_result AS rawResult FROM dune_outcome_runs').get() as { rawResult: string }).rawResult, before);
  } finally { database.close(); }
});

test('a checkpoint whose target time is after the run completed is invalidated, not trusted', () => {
  const database = openDatabase(':memory:');
  try {
    const a1 = seedSignal(database, 'a1', 6, 'TokenA1');
    // The run completed at 00:02, but this +30m checkpoint targets 00:30 — Dune would have
    // returned "whatever the latest trade happens to be right now" here, mislabeled as +30m.
    insertOutcomeRun(database, [a1], [
      { signal_id: a1, checkpoint: '+30m', target_at: '2026-03-01 00:30:00.000 UTC', price_usd: 99, matched_trade_at: '2026-03-01 00:01:59.000 UTC', matched_tx_id: 'tx-bogus' },
    ], '2026-03-01T00:02:00.000Z');
    const [outcome] = readAllDuneOutcomes(database);
    const checkpoint = outcome.checkpoints.find((c) => c.label === '+30m')!;
    assert.equal(checkpoint.result.priceUsd, null, 'the raw price must never be surfaced as if it were validated');
    assert.equal(checkpoint.result.status, 'checkpoint not yet reached');
    assert.equal(checkpoint.result.matchedTradeAt, null, 'the matched-trade fields are cleared too, since that trade is not meaningfully "the +30m trade"');
    assert.equal(checkpoint.result.matchedTxId, null);
  } finally { database.close(); }
});

test('a checkpoint with no matched trade at all stays "not available", distinct from "checkpoint not yet reached"', () => {
  const database = openDatabase(':memory:');
  try {
    const a1 = seedSignal(database, 'a1', 6, 'TokenA1');
    insertOutcomeRun(database, [a1], [
      { signal_id: a1, checkpoint: '+5m', target_at: '2026-03-01 00:05:00.000 UTC', price_usd: null },
    ], '2026-03-01T00:10:00.000Z');
    const [outcome] = readAllDuneOutcomes(database);
    const checkpoint = outcome.checkpoints.find((c) => c.label === '+5m')!;
    assert.equal(checkpoint.result.priceUsd, null);
    assert.equal(checkpoint.result.status, 'not available');
  } finally { database.close(); }
});

test('an unparseable target_at or missing completed_at is treated as pending, never as a validated price (fail-safe)', () => {
  const database = openDatabase(':memory:');
  try {
    const a1 = seedSignal(database, 'a1', 6, 'TokenA1');
    const a2 = seedSignal(database, 'a2', 6, 'TokenA2');
    insertOutcomeRun(database, [a1], [
      { signal_id: a1, checkpoint: '+5m', target_at: 'not-a-real-timestamp', price_usd: 5 },
    ], '2026-03-01T00:10:00.000Z');
    insertOutcomeRun(database, [a2], [
      { signal_id: a2, checkpoint: '+5m', target_at: '2026-03-01 00:05:00.000 UTC', price_usd: 5 },
    ], null); // completed_at missing/null on this run
    const outcomes = readAllDuneOutcomes(database);
    const garbage = outcomes.find((o) => o.signal.id === a1)!.checkpoints.find((c) => c.label === '+5m')!;
    const missingCompletedAt = outcomes.find((o) => o.signal.id === a2)!.checkpoints.find((c) => c.label === '+5m')!;
    assert.equal(garbage.result.status, 'checkpoint not yet reached');
    assert.equal(garbage.result.priceUsd, null);
    assert.equal(missingCompletedAt.result.status, 'checkpoint not yet reached');
    assert.equal(missingCompletedAt.result.priceUsd, null);
  } finally { database.close(); }
});

test('readLatestDuneOutcomes applies the same invalidation as readAllDuneOutcomes', () => {
  const database = openDatabase(':memory:');
  try {
    const a1 = seedSignal(database, 'a1', 6, 'TokenA1');
    insertOutcomeRun(database, [a1], [
      { signal_id: a1, checkpoint: '+1h', target_at: '2026-03-01 01:00:00.000 UTC', price_usd: 42 },
    ], '2026-03-01T00:10:00.000Z');
    const [outcome] = readLatestDuneOutcomes(database);
    const checkpoint = outcome.checkpoints.find((c) => c.label === '+1h')!;
    assert.equal(checkpoint.result.priceUsd, null);
    assert.equal(checkpoint.result.status, 'checkpoint not yet reached');
  } finally { database.close(); }
});

test('the stored raw_result is never modified, even for a run containing an invalidated checkpoint', () => {
  const database = openDatabase(':memory:');
  try {
    const a1 = seedSignal(database, 'a1', 6, 'TokenA1');
    const rawRows = [{ signal_id: a1, checkpoint: '+30m', target_at: '2026-03-01 00:30:00.000 UTC', price_usd: 99 }];
    insertOutcomeRun(database, [a1], rawRows, '2026-03-01T00:02:00.000Z');
    const beforeRead = (database.prepare('SELECT raw_result AS rawResult FROM dune_outcome_runs').get() as { rawResult: string }).rawResult;
    readAllDuneOutcomes(database); // exercise the read path
    const afterRead = (database.prepare('SELECT raw_result AS rawResult FROM dune_outcome_runs').get() as { rawResult: string }).rawResult;
    assert.equal(afterRead, beforeRead, 'reading outcomes must never mutate the archived raw response');
    assert.equal(JSON.parse(afterRead).result.rows[0].price_usd, 99, 'the raw stored value stays 99 even though the interpreted result nulls it out');
  } finally { database.close(); }
});

test('a checkpoint invalidated for being premature is classified as missing (not stale, not fresh) by the Patterns report', () => {
  const database = openDatabase(':memory:');
  try {
    const a1 = seedSignal(database, 'a1', 9, 'TokenA1');
    insertOutcomeRun(database, [a1], [
      { signal_id: a1, checkpoint: 'signal', target_at: '2026-03-01 00:00:00.000 UTC', price_usd: 1, matched_trade_at: '2026-03-01 00:00:00.000 UTC' },
      { signal_id: a1, checkpoint: '+5m', target_at: '2026-03-01 00:05:00.000 UTC', price_usd: 50, matched_trade_at: '2026-03-01 00:00:00.000 UTC' }, // premature
    ], '2026-03-01T00:01:00.000Z');
    const report = computeSignalPatternReport(database, new Date('2026-03-01T02:00:00Z'));
    const group = report.horizons.find((h) => h.horizon === '+5m')!.groups.find((g) => g.key === '9')!;
    assert.equal(group.nMissing, 1, 'a premature checkpoint must count as missing');
    assert.equal(group.nStale, 0);
    assert.equal(group.nFresh, 0);
  } finally { database.close(); }
});

test('readAllDuneOutcomes selects the earliest valid observation independently per checkpoint', () => {
  const database = openDatabase(':memory:');
  try {
    const a1 = seedSignal(database, 'canonical', 7, 'CanonicalToken');
    insertOutcomeRun(database, [a1], [
      { signal_id: a1, checkpoint: 'signal', target_at: '2026-03-01 00:00:00.000 UTC', price_usd: 1, matched_trade_at: '2026-03-01 00:00:00.000 UTC' },
      { signal_id: a1, checkpoint: '+1h', target_at: '2026-03-01 01:00:00.000 UTC', price_usd: null },
    ], '2026-03-01T01:05:00Z');
    insertOutcomeRun(database, [a1], [
      { signal_id: a1, checkpoint: 'signal', target_at: '2026-03-01 00:00:00.000 UTC', price_usd: 9, matched_trade_at: '2026-03-01 00:00:00.000 UTC' },
      { signal_id: a1, checkpoint: '+1h', target_at: '2026-03-01 01:00:00.000 UTC', price_usd: 2, matched_trade_at: '2026-03-01 01:00:00.000 UTC' },
    ], '2026-03-01T02:05:00Z');
    const [outcome] = readAllDuneOutcomes(database);
    const signal = outcome.checkpoints.find((checkpoint) => checkpoint.label === 'signal')!;
    const hour = outcome.checkpoints.find((checkpoint) => checkpoint.label === '+1h')!;
    assert.equal(signal.result.priceUsd, 1);
    assert.equal(signal.result.sourceRunId, 1);
    assert.equal(hour.result.priceUsd, 2);
    assert.equal(hour.result.sourceRunId, 2);
  } finally { database.close(); }
});

test('measureDuneOutcomes refuses a signal already attached to an in-flight run', async () => {
  const database = openDatabase(':memory:');
  try {
    const signalId = seedSignal(database, 'in-flight', 7, 'InFlightToken');
    database.prepare(`INSERT INTO dune_outcome_runs (signal_ids, query_sql, status, requested_at) VALUES (?, 'select 1', 'running', ?)`)
      .run(JSON.stringify([signalId]), '2026-03-01T00:01:00Z');
    await assert.rejects(
      () => measureDuneOutcomes(database, [signalId]),
      /already in flight.*no duplicate request was sent/,
    );
  } finally { database.close(); }
});
