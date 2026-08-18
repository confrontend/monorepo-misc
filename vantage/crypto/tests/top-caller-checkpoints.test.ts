import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/client.js';
import { applyMigrations } from '../src/db/schema.js';
import {
  applyCheckpointResults, CHECKPOINTS, CHECKPOINT_PENDING_TIMEOUT_MS, claimPendingCheckpointTargets,
  clearStalePendingCheckpointClaims, collectPendingCheckpointTargets, type CheckpointTarget,
} from '../src/copytrade/topCallerCheckpoints.js';

const setup = (): DatabaseSync => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  return database;
};

const trackCaller = (database: DatabaseSync, callerKey: string): void => {
  database.prepare(`INSERT INTO top_caller_tracked (caller_key, tracked_at, untracked_at) VALUES (?, ?, NULL)`).run(callerKey, new Date().toISOString());
};

const seedCallout = (database: DatabaseSync, callerKey: string, callTimestamp: number, callPriceUsd: string | null, tokenAddress = 'TOK'): number => {
  const id = Number(database.prepare(
    `INSERT INTO top_caller_callouts (caller_key, token_address, call_timestamp, call_price_usd, raw_payload, fetched_at, dedup_key)
     VALUES (?, ?, ?, ?, '{}', ?, ?)`,
  ).run(callerKey, tokenAddress, callTimestamp, callPriceUsd, new Date().toISOString(), `k${Math.random()}`).lastInsertRowid);
  return id;
};

test('collectPendingCheckpointTargets: only tracked callers are considered', () => {
  const database = setup();
  try {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 10 * 24 * 3600; // 10 days ago — every checkpoint matured
    seedCallout(database, 'UNTRACKED', oldTimestamp, '1');
    const targets = collectPendingCheckpointTargets(database);
    assert.deepEqual(targets, []);
  } finally { database.close(); }
});

test('collectPendingCheckpointTargets: only matured checkpoints are returned, immature ones are silently skipped', () => {
  const database = setup();
  try {
    trackCaller(database, 'C1');
    const now = new Date('2026-08-17T12:00:00.000Z');
    // Called exactly 2 hours ago: all short checkpoints and 1h matured, 6h/24h/3d/7d not yet.
    const callTimestamp = Math.floor(now.getTime() / 1000) - 2 * 3600;
    seedCallout(database, 'C1', callTimestamp, '1');
    const targets = collectPendingCheckpointTargets(database, now);
    assert.deepEqual(targets.map((t) => t.checkpoint), ['5m', '10m', '15m', '30m', '45m', '1h']);
  } finally { database.close(); }
});

test('collectPendingCheckpointTargets: a checkpoint already measured is never re-requested', () => {
  const database = setup();
  try {
    trackCaller(database, 'C1');
    const now = new Date('2026-08-17T12:00:00.000Z');
    const callTimestamp = Math.floor(now.getTime() / 1000) - 10 * 24 * 3600;
    const calloutId = seedCallout(database, 'C1', callTimestamp, '1');
    database.prepare(
      `INSERT INTO top_caller_outcomes (callout_id, checkpoint, requested_at_ts, status, computed_at) VALUES (?, '1h', 0, 'measured', ?)`,
    ).run(calloutId, new Date().toISOString());
    const targets = collectPendingCheckpointTargets(database, now);
    assert.equal(targets.some((t) => t.checkpoint === '1h'), false, 'the already-measured 1h checkpoint must not be requested again');
    assert.equal(targets.filter((t) => t.checkpoint !== '1h').length, CHECKPOINTS.length - 1, 'every other matured checkpoint is still pending');
  } finally { database.close(); }
});

test('collectPendingCheckpointTargets: a checkpoint that finished no_trade_in_window is never re-requested either — resolves a real reviewed ambiguity', () => {
  // "Keep retrying incomplete rows" must never be read as "periodically re-query Dune in case a
  // no_trade_in_window result was an indexing-lag false negative." A finished 'no_trade_in_window'
  // row is exactly as done as a finished 'measured' row; only checkpoints with NO row at all are
  // ever real retry candidates. See the comment on collectPendingCheckpointTargets for the
  // decision this test locks in.
  const database = setup();
  try {
    trackCaller(database, 'C1');
    const now = new Date('2026-08-17T12:00:00.000Z');
    const callTimestamp = Math.floor(now.getTime() / 1000) - 10 * 24 * 3600;
    const calloutId = seedCallout(database, 'C1', callTimestamp, '1');
    database.prepare(
      `INSERT INTO top_caller_outcomes (callout_id, checkpoint, requested_at_ts, status, computed_at) VALUES (?, '1h', 0, 'no_trade_in_window', ?)`,
    ).run(calloutId, new Date().toISOString());
    const targets = collectPendingCheckpointTargets(database, now);
    assert.equal(targets.some((t) => t.checkpoint === '1h'), false, 'a no_trade_in_window checkpoint is finished, not pending — it must never be re-submitted to Dune');
    assert.equal(targets.filter((t) => t.checkpoint !== '1h').length, CHECKPOINTS.length - 1, 'every other matured checkpoint is still genuinely pending');
  } finally { database.close(); }
});

test('checkpoint claims reserve targets atomically and exclude them from a second claim', () => {
  const database = setup();
  try {
    trackCaller(database, 'C1');
    const now = new Date('2026-08-17T12:00:00.000Z');
    const calloutId = seedCallout(database, 'C1', Math.floor(now.getTime() / 1000) - 2 * 3600, '1');
    const first = claimPendingCheckpointTargets(database, 101, now);
    const second = claimPendingCheckpointTargets(database, 102, now);
    assert.equal(first.length, 6);
    assert.equal(second.length, 0);
    const pending = database.prepare(`SELECT COUNT(*) AS count FROM top_caller_outcomes WHERE callout_id = ? AND status = 'pending'`).get(calloutId) as { count: number };
    assert.equal(pending.count, 6);
  } finally { database.close(); }
});

test('stale pending checkpoint claims are cleared only after their owner is no longer live', () => {
  const database = setup();
  try {
    trackCaller(database, 'C1');
    const now = new Date('2026-08-17T12:00:00.000Z');
    const calloutId = seedCallout(database, 'C1', Math.floor(now.getTime() / 1000) - 2 * 3600, '1');
    const oldComputedAt = new Date(now.getTime() - CHECKPOINT_PENDING_TIMEOUT_MS - 1_000).toISOString();
    database.prepare(
      `INSERT INTO top_caller_outcomes (callout_id, checkpoint, requested_at_ts, status, dune_run_id, computed_at) VALUES (?, '1h', 0, 'pending', NULL, ?)`,
    ).run(calloutId, oldComputedAt);
    assert.equal(clearStalePendingCheckpointClaims(database, now), 1);
    const remaining = database.prepare(`SELECT COUNT(*) AS count FROM top_caller_outcomes WHERE callout_id = ? AND checkpoint = '1h'`).get(calloutId) as { count: number };
    assert.equal(remaining.count, 0);
    const targets = collectPendingCheckpointTargets(database, now);
    assert.equal(targets.some((target) => target.calloutId === calloutId && target.checkpoint === '1h'), true);
  } finally { database.close(); }
});

test('applyCheckpointResults resolves a claimed pending row instead of ignoring it', () => {
  const database = setup();
  try {
    trackCaller(database, 'C1');
    const now = new Date('2026-08-17T12:00:00.000Z');
    const calloutId = seedCallout(database, 'C1', Math.floor(now.getTime() / 1000) - 2 * 3600, '1');
    const [target] = claimPendingCheckpointTargets(database, 201, now);
    assert.ok(target);
    applyCheckpointResults(database, [target], [{ callout_id: calloutId, checkpoint: target.checkpoint, price_usd: 1.5, matched_trade_at: target.targetAtIso }], 201);
    const outcome = database.prepare(`SELECT status, dune_run_id FROM top_caller_outcomes WHERE callout_id = ? AND checkpoint = ?`).get(calloutId, target.checkpoint) as { status: string; dune_run_id: number };
    assert.equal(outcome.status, 'measured');
    assert.equal(outcome.dune_run_id, 201);
  } finally { database.close(); }
});

test('applyCheckpointResults: a matched Dune row computes a real return percent and status "measured"', () => {
  const database = setup();
  try {
    trackCaller(database, 'C1');
    const calloutId = seedCallout(database, 'C1', 1_700_000_000, '1.0');
    const targets: CheckpointTarget[] = [{ calloutId, tokenAddress: 'TOK', checkpoint: '1h', targetAtIso: new Date(1_700_003_600 * 1000).toISOString(), callPriceUsd: 1.0 }];
    const rows = [{ callout_id: calloutId, checkpoint: '1h', price_usd: 1.5, matched_trade_at: new Date(1_700_003_600 * 1000).toISOString(), matched_tx_id: 'TX1' }];
    const { measured, noTradeInWindow } = applyCheckpointResults(database, targets, rows, 999);
    assert.equal(measured, 1);
    assert.equal(noTradeInWindow, 0);
    const outcome = database.prepare(`SELECT status, measured_return_pct AS returnPct FROM top_caller_outcomes WHERE callout_id = ? AND checkpoint = '1h'`).get(calloutId) as { status: string; returnPct: number };
    assert.equal(outcome.status, 'measured');
    assert.equal(outcome.returnPct, 50, '(1.5 - 1.0) / 1.0 * 100 = 50%');
  } finally { database.close(); }
});

test('applyCheckpointResults: no matching Dune row records "no_trade_in_window", not a fabricated return', () => {
  const database = setup();
  try {
    trackCaller(database, 'C1');
    const calloutId = seedCallout(database, 'C1', 1_700_000_000, '1.0');
    const targets: CheckpointTarget[] = [{ calloutId, tokenAddress: 'TOK', checkpoint: '1h', targetAtIso: new Date(1_700_003_600 * 1000).toISOString(), callPriceUsd: 1.0 }];
    const { measured, noTradeInWindow } = applyCheckpointResults(database, targets, [], 999);
    assert.equal(measured, 0);
    assert.equal(noTradeInWindow, 1);
    const outcome = database.prepare(`SELECT status, measured_return_pct AS returnPct FROM top_caller_outcomes WHERE callout_id = ? AND checkpoint = '1h'`).get(calloutId) as { status: string; returnPct: number | null };
    assert.equal(outcome.status, 'no_trade_in_window');
    assert.equal(outcome.returnPct, null, 'never a fabricated zero return when nothing matched');
  } finally { database.close(); }
});

test('applyCheckpointResults: a missing call price never fabricates a return even when the checkpoint itself matched', () => {
  const database = setup();
  try {
    trackCaller(database, 'C1');
    const calloutId = seedCallout(database, 'C1', 1_700_000_000, null);
    const targets: CheckpointTarget[] = [{ calloutId, tokenAddress: 'TOK', checkpoint: '1h', targetAtIso: new Date(1_700_003_600 * 1000).toISOString(), callPriceUsd: null }];
    const rows = [{ callout_id: calloutId, checkpoint: '1h', price_usd: 2.0, matched_trade_at: new Date(1_700_003_600 * 1000).toISOString(), matched_tx_id: 'TX1' }];
    applyCheckpointResults(database, targets, rows, 999);
    const outcome = database.prepare(`SELECT status, measured_return_pct AS returnPct FROM top_caller_outcomes WHERE callout_id = ? AND checkpoint = '1h'`).get(calloutId) as { status: string; returnPct: number | null };
    assert.equal(outcome.status, 'measured', 'the checkpoint price itself was found');
    assert.equal(outcome.returnPct, null, 'but with no call price to compare against, the return stays null, never a guess');
  } finally { database.close(); }
});
