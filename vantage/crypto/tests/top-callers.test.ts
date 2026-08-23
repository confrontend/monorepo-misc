import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/client.js';
import { applyMigrations } from '../src/db/schema.js';
import {
  computeCalloutDedupKey, computeCallerCheckpointBreakdown, computeCallerEvaluationReport, hasActiveCollectionRun,
  isCallerTracked, listTrackedCallerKeys, MAX_CHECKPOINT_BATCHES_PER_RUN, MAX_SINGLE_TOKEN_SHARE_PERCENT, MIN_CALLER_MEASURED_CALLS, readCallerDetail,
  readCollectionRunState, readLeaderboard, startCollectionRun, stopCollectionRuns, trackCaller, untrackCaller,
  LEADERBOARD_CAPTURE_COOLDOWN_MS, msSinceLastCollectionStart,
  type FetchKolTrades, type FetchWalletActivity, type KolTradeRow,
} from '../src/copytrade/topCallers.js';

const fixtureKolRow = (over: Partial<KolTradeRow> = {}): KolTradeRow => ({
  transaction_hash: `TX${Math.random().toString(36).slice(2)}`,
  maker: 'MakerWallet1',
  base_address: 'TokenA',
  base_token: { symbol: 'TOKA' },
  price_usd: 0.001,
  timestamp: 1_700_000_000,
  maker_info: { twitter_username: 'someone', tags: ['kol'] },
  ...over,
});

/** A stub matching FetchKolTrades so tests never hit the real GMGN CLI/network. */
const stubFetch = (rows: KolTradeRow[]): FetchKolTrades =>
  async () => ({ rows, rawStdout: JSON.stringify({ list: rows }) });

const setup = (): DatabaseSync => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  return database;
};

test('leaderboard capture cooldown is measured from the last start time', () => {
  const database = setup();
  try {
    const startedAt = '2026-08-17T12:00:00.000Z';
    database.prepare(
      `INSERT INTO top_caller_collection_runs (kind, started_at, status, requests_made) VALUES ('leaderboard', ?, 'completed', 1)`,
    ).run(startedAt);
    const now = Date.parse('2026-08-17T12:00:05.000Z');
    assert.equal(msSinceLastCollectionStart(database, 'leaderboard', now), 5_000);
    assert.equal(LEADERBOARD_CAPTURE_COOLDOWN_MS - 5_000, 5_000);
    assert.equal(msSinceLastCollectionStart(database, 'callouts', now), null);
  } finally { database.close(); }
});

test('computeCalloutDedupKey prefers the source call ID and never truncates the fallback timestamp', () => {
  assert.equal(
    computeCalloutDedupKey({ sourceCallId: 'abc123', callerKey: 'C1', tokenAddress: 'TOK', callTimestamp: 1000 }),
    'id:abc123',
  );
  const a = computeCalloutDedupKey({ sourceCallId: null, callerKey: 'C1', tokenAddress: 'TOK', callTimestamp: 1000 });
  const b = computeCalloutDedupKey({ sourceCallId: null, callerKey: 'C1', tokenAddress: 'TOK', callTimestamp: 1001 });
  assert.notEqual(a, b, 'two real calls one second apart must not collapse into the same fallback key');
});

test('track/untrack round-trips and is idempotent', () => {
  const database = setup();
  try {
    assert.equal(isCallerTracked(database, 'C1'), false);
    trackCaller(database, 'C1');
    assert.equal(isCallerTracked(database, 'C1'), true);
    trackCaller(database, 'C1');
    assert.deepEqual(listTrackedCallerKeys(database), ['C1'], 're-tracking an already-tracked caller must not duplicate it');
    untrackCaller(database, 'C1');
    assert.equal(isCallerTracked(database, 'C1'), false);
    untrackCaller(database, 'C1');
    assert.equal(isCallerTracked(database, 'C1'), false, 'untracking twice is a safe no-op');
  } finally { database.close(); }
});

test('re-tracking after an untrack clears the untracked_at watermark', () => {
  const database = setup();
  try {
    trackCaller(database, 'C1');
    untrackCaller(database, 'C1');
    assert.equal(isCallerTracked(database, 'C1'), false);
    trackCaller(database, 'C1');
    assert.equal(isCallerTracked(database, 'C1'), true, 'tracking again must clear the earlier untrack, not leave it stuck untracked');
  } finally { database.close(); }
});

test('readLeaderboard returns an honest empty state with no snapshot ever captured', () => {
  const database = setup();
  try {
    const report = readLeaderboard(database);
    assert.deepEqual(report, { snapshot: null, rows: [] });
  } finally { database.close(); }
});

test('readLeaderboard marks tracked callers correctly against a real snapshot', () => {
  const database = setup();
  try {
    const runId = Number(database.prepare(
      `INSERT INTO top_caller_collection_runs (kind, started_at, status) VALUES ('leaderboard', ?, 'completed')`,
    ).run(new Date().toISOString()).lastInsertRowid);
    const snapshotId = Number(database.prepare(
      `INSERT INTO top_caller_snapshots (run_id, captured_at, raw_payload) VALUES (?, ?, '{}')`,
    ).run(runId, new Date().toISOString()).lastInsertRowid);
    database.prepare(
      `INSERT INTO top_caller_snapshot_rows (snapshot_id, caller_key, rank_position, raw_payload) VALUES (?, 'C1', 1, '{}'), (?, 'C2', 2, '{}')`,
    ).run(snapshotId, snapshotId);
    trackCaller(database, 'C2');

    const report = readLeaderboard(database);
    assert.equal(report.rows.length, 2);
    assert.equal(report.rows.find((r) => r.callerKey === 'C1')!.tracked, false);
    assert.equal(report.rows.find((r) => r.callerKey === 'C2')!.tracked, true);
  } finally { database.close(); }
});

test('startCollectionRun: checkpoints completes honestly with zero targets when nothing is pending', async () => {
  const database = setup();
  try {
    const result = await startCollectionRun(database, 'checkpoints');
    assert.equal(result.status, 'completed', 'no tracked callers means nothing to measure — that is success, not failure');
    const state = readCollectionRunState(database, 'checkpoints');
    assert.equal(state.running, false);
    assert.equal(state.status, 'completed');
    assert.match(state.message, /no matured checkpoints pending/i);
  } finally { database.close(); }
});

test('startCollectionRun: checkpoints delegates to the injected runCheckpointBatch and reports its real counts', async () => {
  const database = setup();
  try {
    let calls = 0;
    const stub = async () => {
      calls += 1;
      return calls === 1
        ? { targetsSubmitted: 300, measured: 3, noTradeInWindow: 2 }
        : { targetsSubmitted: 0, measured: 0, noTradeInWindow: 0 };
    };
    const result = await startCollectionRun(database, 'checkpoints', { runCheckpointBatch: stub });
    assert.equal(result.status, 'completed');
    assert.equal(calls, 2, 'one click drains batches until the durable queue is empty');
    const state = readCollectionRunState(database, 'checkpoints');
    assert.match(state.message, /measured 3 checkpoints across 2 Dune batches \(300 of 0 pending at the start\), 2 had no qualifying/i);
  } finally { database.close(); }
});

test('startCollectionRun: a checkpoints failure (e.g. Dune error) is recorded honestly, not silently swallowed', async () => {
  const database = setup();
  try {
    const failing = async () => { throw new Error('Dune execution HTTP 500'); };
    const result = await startCollectionRun(database, 'checkpoints', { runCheckpointBatch: failing });
    assert.equal(result.status, 'failed');
    const state = readCollectionRunState(database, 'checkpoints');
    assert.match(state.message, /Dune execution HTTP 500/);
  } finally { database.close(); }
});

test('startCollectionRun: checkpoint draining stops at the bounded batch safety limit', async () => {
  const database = setup();
  try {
    let calls = 0;
    const stub = async () => { calls += 1; return { targetsSubmitted: 300, measured: 300, noTradeInWindow: 0 }; };
    const result = await startCollectionRun(database, 'checkpoints', { runCheckpointBatch: stub });
    assert.equal(result.status, 'completed');
    assert.equal(calls, MAX_CHECKPOINT_BATCHES_PER_RUN);
    const state = readCollectionRunState(database, 'checkpoints');
    assert.match(state.message, new RegExp(`${MAX_CHECKPOINT_BATCHES_PER_RUN}-batch runaway guard`));
  } finally { database.close(); }
});

test('startCollectionRun: leaderboard/callouts run a real capture via the injected fetch function and write real rows', async () => {
  const database = setup();
  try {
    const rows: KolTradeRow[] = [
      fixtureKolRow({ maker: 'MakerA', transaction_hash: 'TX1', timestamp: 1_700_000_000 }),
      fixtureKolRow({ maker: 'MakerA', transaction_hash: 'TX2', timestamp: 1_700_000_100 }),
      fixtureKolRow({ maker: 'MakerB', transaction_hash: 'TX3', timestamp: 1_700_000_200 }),
    ];
    const result = await startCollectionRun(database, 'leaderboard', { fetchKolTrades: stubFetch(rows), archive: false });
    assert.equal(result.status, 'completed');

    const leaderboard = readLeaderboard(database);
    assert.equal(leaderboard.snapshot !== null, true);
    assert.equal(leaderboard.rows.length, 2, 'two distinct makers observed');
    assert.equal(leaderboard.rows[0]!.callerKey, 'MakerA', 'ranked by observed call count within this batch, MakerA (2) before MakerB (1)');
    assert.equal(leaderboard.rows[0]!.callCount, 2);
    assert.equal(leaderboard.rows[0]!.reportedAvgMultiplier, null, 'GMGN gives no rank/multiplier for KOL trades — never fabricated');

    const calloutCount = (database.prepare('SELECT COUNT(*) AS c FROM top_caller_callouts').get() as { c: number }).c;
    assert.equal(calloutCount, 3, 'every observed trade is captured as a callout regardless of tracking');
  } finally { database.close(); }
});

test('startCollectionRun: callouts kind dedupes by transaction hash on a repeat capture', async () => {
  const database = setup();
  try {
    const rows: KolTradeRow[] = [fixtureKolRow({ maker: 'MakerA', transaction_hash: 'TX1', timestamp: 1_700_000_000 })];
    await startCollectionRun(database, 'callouts', { fetchKolTrades: stubFetch(rows), archive: false });
    await startCollectionRun(database, 'callouts', { fetchKolTrades: stubFetch(rows), archive: false });
    const calloutCount = (database.prepare('SELECT COUNT(*) AS c FROM top_caller_callouts').get() as { c: number }).c;
    assert.equal(calloutCount, 1, 'the same transaction hash captured twice must not duplicate the callout');
  } finally { database.close(); }
});

test('startCollectionRun: callouts fetches tracked wallet activity history, not the leaderboard feed', async () => {
  const database = setup();
  try {
    trackCaller(database, 'TrackedWallet');
    const rows = [fixtureKolRow({ maker: 'TrackedWallet', transaction_hash: 'HIST-1', timestamp: 1_700_000_000 })];
    const calls: string[] = [];
    const fetchWalletActivity: FetchWalletActivity = async (_chain, wallet) => {
      calls.push(wallet);
      return { rows, rawStdout: JSON.stringify({ data: { activities: rows } }) };
    };
    const result = await startCollectionRun(database, 'callouts', { fetchWalletActivity, archive: false });
    assert.equal(result.status, 'completed');
    assert.deepEqual(calls, ['TrackedWallet']);
    assert.equal((database.prepare('SELECT COUNT(*) AS c FROM top_caller_callouts').get() as { c: number }).c, 1);
    // A real per-wallet 'callouts' run must NEVER create a top_caller_snapshots row — that table
    // is what readLeaderboard always reads the single most-recent row from, so a per-wallet
    // snapshot would silently replace the real leaderboard with a one-caller "leaderboard".
    assert.equal((database.prepare('SELECT COUNT(*) AS c FROM top_caller_snapshots').get() as { c: number }).c, 0);
  } finally { database.close(); }
});

test('startCollectionRun: callout history passes the latest stored timestamp as a resume boundary', async () => {
  const database = setup();
  try {
    trackCaller(database, 'TrackedWallet');
    const stopBoundaries: Array<number | null> = [];
    let run = 0;
    const fetchWalletActivity: FetchWalletActivity = async (_chain, wallet, _limit, stopAtTimestamp) => {
      stopBoundaries.push(stopAtTimestamp ?? null);
      run += 1;
      const timestamp = run === 1 ? 1_700_000_000 : 1_700_000_100;
      return { rows: [fixtureKolRow({ maker: wallet, transaction_hash: `HIST-${run}`, timestamp })], rawStdout: '{}' };
    };
    await startCollectionRun(database, 'callouts', { fetchWalletActivity, archive: false });
    await startCollectionRun(database, 'callouts', { fetchWalletActivity, archive: false });
    assert.deepEqual(stopBoundaries, [null, 1_700_000_000], 'the second fetch resumes at the newest stored call instead of refetching older pages');
  } finally { database.close(); }
});

test('startCollectionRun: callouts persists each tracked wallet incrementally and reports real N-of-M progress', async () => {
  const database = setup();
  try {
    trackCaller(database, 'W1');
    trackCaller(database, 'W2');
    trackCaller(database, 'W3');
    const seenAtSecondCall: { walletDone: number | null; walletTotal: number | null } = { walletDone: null, walletTotal: null };
    let callIndex = 0;
    const fetchWalletActivity: FetchWalletActivity = async (_chain, wallet) => {
      callIndex += 1;
      if (callIndex === 2) {
        // Mid-run: wallet 1 must already be persisted and progress must reflect exactly 1 done.
        const state = readCollectionRunState(database, 'callouts');
        seenAtSecondCall.walletDone = state.walletDone;
        seenAtSecondCall.walletTotal = state.walletTotal;
        assert.equal((database.prepare('SELECT COUNT(*) AS c FROM top_caller_callouts').get() as { c: number }).c, 1, 'wallet 1\'s callout must already be in the database before wallet 2 is even fetched');
      }
      return { rows: [fixtureKolRow({ maker: wallet, transaction_hash: `TX-${wallet}`, timestamp: 1_700_000_000 + callIndex })], rawStdout: '{}' };
    };
    const result = await startCollectionRun(database, 'callouts', { fetchWalletActivity, archive: false });
    assert.equal(result.status, 'completed');
    assert.deepEqual(seenAtSecondCall, { walletDone: 1, walletTotal: 3 });
    const finalState = readCollectionRunState(database, 'callouts');
    assert.equal(finalState.walletDone, 3);
    assert.equal(finalState.walletTotal, 3);
    assert.equal((database.prepare('SELECT COUNT(*) AS c FROM top_caller_callouts').get() as { c: number }).c, 3);
  } finally { database.close(); }
});

test('startCollectionRun: callouts keeps every wallet already fetched when a later wallet fails mid-run', async () => {
  const database = setup();
  try {
    trackCaller(database, 'Good1');
    trackCaller(database, 'BadWallet');
    trackCaller(database, 'NeverReached');
    const fetchWalletActivity: FetchWalletActivity = async (_chain, wallet) => {
      if (wallet === 'BadWallet') throw new Error('HTTP 429 RATE_LIMIT_EXCEEDED');
      return { rows: [fixtureKolRow({ maker: wallet, transaction_hash: `TX-${wallet}`, timestamp: 1_700_000_000 })], rawStdout: '{}' };
    };
    const result = await startCollectionRun(database, 'callouts', { fetchWalletActivity, archive: false });
    assert.notEqual(result.status, 'completed', 'the failure on BadWallet must still surface as a real failure, not be swallowed');
    // The whole point of persisting per-wallet instead of batching at the end: Good1's callout
    // must survive even though the run as a whole failed on the very next wallet.
    const callouts = database.prepare('SELECT caller_key AS callerKey FROM top_caller_callouts').all() as Array<{ callerKey: string }>;
    assert.deepEqual(callouts.map((c) => c.callerKey), ['Good1']);
    const state = readCollectionRunState(database, 'callouts');
    assert.equal(state.walletDone, 1, 'progress must reflect exactly the one wallet that completed before the failure');
    assert.equal(state.walletTotal, 3);
  } finally { database.close(); }
});

test('startCollectionRun: a rate-limit failure is persisted with a cooldown', async () => {
  const database = setup();
  try {
    const failingFetch: FetchKolTrades = async () => { throw new Error('HTTP 429 RATE_LIMIT_BANNED (~15s remaining)'); };
    const result = await startCollectionRun(database, 'leaderboard', { fetchKolTrades: failingFetch, archive: false });
    assert.equal(result.status, 'rate_limited');
    const state = readCollectionRunState(database, 'leaderboard');
    assert.equal(state.status, 'rate_limited');
    assert.match(state.message, /429 RATE_LIMIT_BANNED/);
    assert.ok(state.rateLimitedUntil);
    assert.ok(Date.parse(state.rateLimitedUntil) > Date.now());
  } finally { database.close(); }
});

test('startCollectionRun: non-rate-limit capture failures remain failed', async () => {
  const database = setup();
  try {
    const failingFetch: FetchKolTrades = async () => { throw new Error('GMGN request failed: network unreachable'); };
    const result = await startCollectionRun(database, 'leaderboard', { fetchKolTrades: failingFetch, archive: false });
    assert.equal(result.status, 'failed');
    assert.equal(readCollectionRunState(database, 'leaderboard').status, 'failed');
  } finally { database.close(); }
});

test('readCollectionRunState infers a cooldown from a legacy failed 429 row', () => {
  const database = setup();
  try {
    database.prepare(
      `INSERT INTO top_caller_collection_runs (kind, started_at, status, error) VALUES ('leaderboard', ?, 'failed', ?)`,
    ).run(new Date().toISOString(), 'HTTP 429 RATE_LIMIT_BANNED (~20s remaining)');
    const state = readCollectionRunState(database, 'leaderboard');
    assert.equal(state.status, 'rate_limited');
    assert.ok(state.rateLimitedUntil);
  } finally { database.close(); }
});

test('startCollectionRun rejects a second run of the same kind while one claims to be active', async () => {
  const database = setup();
  try {
    // Simulate an in-flight run by inserting one directly, bypassing the fast-fail path.
    database.prepare(
      `INSERT INTO top_caller_collection_runs (kind, started_at, status) VALUES ('callouts', ?, 'running')`,
    ).run(new Date().toISOString());
    assert.equal(hasActiveCollectionRun(database, 'callouts'), true);
    await assert.rejects(startCollectionRun(database, 'callouts', { fetchKolTrades: stubFetch([]), archive: false }));
  } finally { database.close(); }
});

test('stopCollectionRuns cancels active work without removing already-fetched data', () => {
  const database = setup();
  try {
    database.prepare(
      `INSERT INTO top_caller_collection_runs (kind, started_at, status, requests_made) VALUES (?, ?, 'running', 1)`,
    ).run('callouts', new Date().toISOString());
    database.prepare(
      `INSERT INTO top_caller_collection_runs (kind, started_at, status, requests_made) VALUES (?, ?, 'completed', 1)`,
    ).run('leaderboard', new Date().toISOString());

    assert.equal(stopCollectionRuns(database), 1);
    const callouts = readCollectionRunState(database, 'callouts');
    assert.equal(callouts.running, false);
    assert.equal(callouts.status, 'cancelled');
    assert.match(callouts.message, /data already fetched is retained/i);
    assert.equal(readCollectionRunState(database, 'leaderboard').status, 'completed');
  } finally {
    database.close();
  }
});

test('readCollectionRunState reports idle with no run ever attempted', () => {
  const database = setup();
  try {
    const state = readCollectionRunState(database, 'checkpoints');
    assert.deepEqual(state, { running: false, runId: null, status: 'idle', requestsMade: 0, walletTotal: null, walletDone: null, rateLimitedUntil: null, retryCount: 0, nextRetryAt: null, message: 'No collection has run yet.' });
  } finally { database.close(); }
});

const seedCallout = (
  database: DatabaseSync, callerKey: string, callTimestamp: number, tokenAddress = 'TOK',
  side: 'buy' | 'sell' | null = 'buy',
): number => {
  const rawPayload = side === null ? '{}' : JSON.stringify({ side });
  const id = Number(database.prepare(
    `INSERT INTO top_caller_callouts (caller_key, token_address, token_symbol, call_timestamp, raw_payload, fetched_at, dedup_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(callerKey, tokenAddress, tokenAddress, callTimestamp, rawPayload, new Date().toISOString(), `fallback:${callerKey}|${tokenAddress}|${callTimestamp}`).lastInsertRowid);
  return id;
};

const seedOutcome = (
  database: DatabaseSync, calloutId: number, checkpoint: string, status: string, measuredReturnPct: number | null,
): void => {
  database.prepare(
    `INSERT INTO top_caller_outcomes (callout_id, checkpoint, requested_at_ts, status, measured_return_pct, computed_at)
     VALUES (?, ?, 0, ?, ?, ?)`,
  ).run(calloutId, checkpoint, status, measuredReturnPct, new Date().toISOString());
};

test('caller evaluation: an untracked caller never appears in the report even if it has callouts', () => {
  const database = setup();
  try {
    const calloutId = seedCallout(database, 'C1', 1_000);
    seedOutcome(database, calloutId, '24h', 'measured', 10);
    const report = computeCallerEvaluationReport(database);
    assert.deepEqual(report.rows, [], 'evaluation is scoped to tracked callers only');
  } finally { database.close(); }
});

test('caller evaluation: a tracked caller with no callouts reports zeros/nulls, not a crash', () => {
  const database = setup();
  try {
    trackCaller(database, 'C1');
    const report = computeCallerEvaluationReport(database);
    assert.deepEqual(report.rows, [{
      callerKey: 'C1', callCount: 0, measuredCallCount: 0, winRatePercent: null,
      medianReturnPercent: null, reliable: false, waitingCallCount: 0,
      unavailableCallCount: 0, coverageRatePercent: null, coverageSufficient: false,
      sellCallCount: 0, topTokenSharePercent: null, topTokenSymbol: null,
      medianReturnPercentByToken: null,
    }]);
  } finally { database.close(); }
});

test('caller evaluation: median, not average, and win rate/reliable computed only on measured outcomes', () => {
  const database = setup();
  try {
    trackCaller(database, 'C1');
    const dayOne = 1_700_000_000;
    const c1 = seedCallout(database, 'C1', dayOne, 'TOKA');
    const c2 = seedCallout(database, 'C1', dayOne + 3600, 'TOKB');
    const c3 = seedCallout(database, 'C1', dayOne + 7200, 'TOKC');
    seedOutcome(database, c1, '24h', 'measured', 100);
    seedOutcome(database, c2, '24h', 'measured', -10);
    seedOutcome(database, c3, '24h', 'not_yet_matured', null);

    const report = computeCallerEvaluationReport(database, '24h');
    const row = report.rows[0]!;
    assert.equal(row.callCount, 3);
    assert.equal(row.measuredCallCount, 2, 'not_yet_matured must not count as measured');
    assert.equal(row.winRatePercent, 50);
    assert.equal(row.medianReturnPercent, 45, 'median of [100, -10] is 45, not the skewed average an outlier would give');
  } finally { database.close(); }
});

test('caller evaluation: reliable flips only once both the sample size and the distinct-date gates are met', () => {
  const database = setup();
  try {
    trackCaller(database, 'C1');
    const baseDay = 1_700_000_000;
    // The minimum measured-call gate, but all on the SAME calendar day — must stay unreliable.
    for (let i = 0; i < MIN_CALLER_MEASURED_CALLS; i += 1) {
      const c = seedCallout(database, 'C1', baseDay + i, `TOK${i}`);
      seedOutcome(database, c, '24h', 'measured', 5);
    }
    let report = computeCallerEvaluationReport(database, '24h');
    assert.equal(report.rows[0]!.measuredCallCount, MIN_CALLER_MEASURED_CALLS);
    assert.equal(report.rows[0]!.reliable, false, 'sample size alone is not enough — date diversity is required too');

    // Spread two more calls across two more distinct days to clear MIN_CALLER_CAPTURE_DATES too.
    const dayTwo = baseDay + 86_400;
    const dayThree = baseDay + 172_800;
    const c2 = seedCallout(database, 'C1', dayTwo, 'TOKX');
    seedOutcome(database, c2, '24h', 'measured', 5);
    const c3 = seedCallout(database, 'C1', dayThree, 'TOKY');
    seedOutcome(database, c3, '24h', 'measured', 5);

    report = computeCallerEvaluationReport(database, '24h');
    assert.equal(report.rows[0]!.reliable, true);
  } finally { database.close(); }
});

test('computeCallerCheckpointBreakdown: the exact same wallet can be reliable at one horizon and merely "awaiting Dune fetch" at another', () => {
  // Real-world motivating case: a caller fully measured at 1h can still be mostly unprocessed at
  // 24h. "Reliable" must be read per-checkpoint, never as one caller-wide verdict.
  const database = setup();
  try {
    trackCaller(database, 'C1');
    const baseDay = 1_700_000_000;
    for (let i = 0; i < MIN_CALLER_MEASURED_CALLS; i += 1) {
      const c = seedCallout(database, 'C1', baseDay + i, `TOK${i}`);
      seedOutcome(database, c, '1h', 'measured', 5);
      // 24h checkpoint deliberately left with no outcome row at all — still pending.
    }
    const dayTwo = baseDay + 86_400;
    const dayThree = baseDay + 172_800;
    const c2 = seedCallout(database, 'C1', dayTwo, 'TOKX'); seedOutcome(database, c2, '1h', 'measured', 5);
    const c3 = seedCallout(database, 'C1', dayThree, 'TOKY'); seedOutcome(database, c3, '1h', 'measured', 5);

    const rows = computeCallerCheckpointBreakdown(database, 'C1');
    const oneHour = rows.find((r) => r.checkpoint === '1h')!;
    const oneDay = rows.find((r) => r.checkpoint === '24h')!;
    assert.equal(oneHour.reliable, true, '1h is fully measured across 3 distinct dates — genuinely reliable');
    assert.deepEqual(oneHour.reasons, []);
    assert.equal(oneDay.reliable, false);
    assert.deepEqual(oneDay.reasons, ['awaiting_dune_fetch'], '24h has zero outcome rows at all — this is a collection gap, not a real negative result');
  } finally { database.close(); }
});

test('computeCallerCheckpointBreakdown: distinguishes "still waiting on Dune" from "Dune looked and found nothing" — the second can never be fixed by fetching again', () => {
  const database = setup();
  try {
    trackCaller(database, 'C1');
    const baseDay = 1_700_000_000;
    // Fully processed (no waiting left) but almost everything came back no_trade_in_window —
    // a real, permanent coverage shortfall, not something more collection runs will resolve.
    for (let i = 0; i < MIN_CALLER_MEASURED_CALLS; i += 1) {
      const c = seedCallout(database, 'C1', baseDay + i, `TOK${i}`);
      seedOutcome(database, c, '1h', i < 5 ? 'measured' : 'no_trade_in_window', i < 5 ? 5 : null);
    }
    const dayTwo = baseDay + 86_400;
    const dayThree = baseDay + 172_800;
    const c2 = seedCallout(database, 'C1', dayTwo, 'TOKX'); seedOutcome(database, c2, '1h', 'no_trade_in_window', null);
    const c3 = seedCallout(database, 'C1', dayThree, 'TOKY'); seedOutcome(database, c3, '1h', 'no_trade_in_window', null);

    const rows = computeCallerCheckpointBreakdown(database, 'C1');
    const oneHour = rows.find((r) => r.checkpoint === '1h')!;
    assert.equal(oneHour.waitingCallCount, 0, 'every callout has a final outcome row — nothing left to fetch');
    assert.equal(oneHour.reliable, false);
    assert.deepEqual(oneHour.reasons, ['insufficient_coverage'], 'must not say "awaiting_dune_fetch" — fetching again cannot change a finished no_trade_in_window result');
  } finally { database.close(); }
});

test('computeCallerCheckpointBreakdown: a caller with no callouts at all reports the no_callouts reason on every checkpoint', () => {
  const database = setup();
  try {
    trackCaller(database, 'C1');
    const rows = computeCallerCheckpointBreakdown(database, 'C1');
    assert.equal(rows.length > 0, true);
    for (const row of rows) {
      assert.equal(row.reliable, false);
      assert.deepEqual(row.reasons, ['no_callouts']);
    }
  } finally { database.close(); }
});

test('caller evaluation: sell-side calls are excluded from returns, never scored as wins', () => {
  // Price rising after a SELL means the caller exited before a rally — the opposite of a win.
  // Real case that motivated this: wallet 98T65wc… had 52 of 148 calls on the sell side.
  const database = setup();
  try {
    trackCaller(database, 'C1');
    const baseDay = 1_700_000_000;
    // 2 buys at a real loss, 2 sells followed by big rises that must NOT be counted as wins.
    const b1 = seedCallout(database, 'C1', baseDay, 'TOKA', 'buy'); seedOutcome(database, b1, '1h', 'measured', -10);
    const b2 = seedCallout(database, 'C1', baseDay + 86_400, 'TOKB', 'buy'); seedOutcome(database, b2, '1h', 'measured', -20);
    const s1 = seedCallout(database, 'C1', baseDay + 172_800, 'TOKC', 'sell'); seedOutcome(database, s1, '1h', 'measured', 500);
    const s2 = seedCallout(database, 'C1', baseDay + 259_200, 'TOKD', 'sell'); seedOutcome(database, s2, '1h', 'measured', 500);

    const row = computeCallerEvaluationReport(database, '1h').rows[0]!;
    assert.equal(row.sellCallCount, 2, 'both sells are counted and reported, not silently dropped');
    assert.equal(row.measuredCallCount, 2, 'only the two buys are scored');
    assert.equal(row.medianReturnPercent, -15, 'median of the two buys (-10, -20); the +500% sells must not rescue it');
    assert.equal(row.winRatePercent, 0, 'a sell followed by a rally is not a win');
  } finally { database.close(); }
});

test('caller evaluation: one heavily-repeated token cannot make a caller reliable', () => {
  // The exact shape found live on 98T65wc…: many buys of one token carrying the median, while
  // the same caller's other tokens are negative.
  const database = setup();
  try {
    trackCaller(database, 'C1');
    const baseDay = 1_700_000_000;
    // 30 buys of the SAME token, all strongly positive.
    for (let i = 0; i < 30; i += 1) {
      const c = seedCallout(database, 'C1', baseDay + i * 3_600, 'HOTTOKEN', 'buy');
      seedOutcome(database, c, '1h', 'measured', 65);
    }
    // 10 buys across other tokens, negative — spread over more days to clear the date gate.
    for (let i = 0; i < 10; i += 1) {
      const c = seedCallout(database, 'C1', baseDay + 86_400 * (i + 1), `OTHER${i}`, 'buy');
      seedOutcome(database, c, '1h', 'measured', -5);
    }

    const row = computeCallerEvaluationReport(database, '1h').rows[0]!;
    assert.equal(row.topTokenSymbol, 'HOTTOKEN');
    assert.ok(row.topTokenSharePercent !== null && row.topTokenSharePercent > MAX_SINGLE_TOKEN_SHARE_PERCENT, 'one token dominates the measured buys');
    assert.equal(row.reliable, false, 'a one-token result is never reliable, however large the sample');
    // Pooled median is flattered by the repeated token; per-token median exposes the truth.
    assert.equal(row.medianReturnPercent, 65, 'pooled median is dominated by the 30 repeats');
    assert.equal(row.medianReturnPercentByToken, -5, 'counting each token once, the caller is actually negative');
  } finally { database.close(); }
});

test('caller checkpoint breakdown: single-token concentration surfaces as its own explicit reason', () => {
  const database = setup();
  try {
    trackCaller(database, 'C1');
    const baseDay = 1_700_000_000;
    for (let i = 0; i < 30; i += 1) {
      const c = seedCallout(database, 'C1', baseDay + 86_400 * (i % 5) + i, 'HOTTOKEN', 'buy');
      seedOutcome(database, c, '1h', 'measured', 40);
    }
    const row = computeCallerCheckpointBreakdown(database, 'C1').find((r) => r.checkpoint === '1h')!;
    assert.equal(row.reliable, false);
    assert.ok(row.reasons.includes('single_token_concentration'), 'the UI must be able to say WHY, not just "unreliable"');
  } finally { database.close(); }
});

test('readCallerDetail orders checkpoints 1h..7d regardless of insertion order and reports the raw message untouched', () => {
  const database = setup();
  try {
    const calloutId = seedCallout(database, 'C1', 1_000, 'TOKA');
    database.prepare(`UPDATE top_caller_callouts SET message = ? WHERE id = ?`).run('thesis text', calloutId);
    seedOutcome(database, calloutId, '7d', 'not_yet_matured', null);
    seedOutcome(database, calloutId, '1h', 'measured', 8);
    seedOutcome(database, calloutId, '24h', 'measured', 6);

    const detail = readCallerDetail(database, 'C1');
    assert.equal(detail.callouts.length, 1);
    assert.equal(detail.callouts[0]!.message, 'thesis text');
    assert.deepEqual(detail.callouts[0]!.outcomes.map((o) => o.checkpoint), ['1h', '24h', '7d']);
  } finally { database.close(); }
});
