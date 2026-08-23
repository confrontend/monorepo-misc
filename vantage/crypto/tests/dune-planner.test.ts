import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/platform/db/client.js';
import { CHECKPOINT_LABELS } from '../src/dune/outcomes.js';
import { buildMeasurementPlan } from '../src/dune/planner.js';
import { storeGmgnSignal } from '../src/gmgn/capture/ingest.js';

const seed = (database: ReturnType<typeof openDatabase>, id: string, observedAt: string): number => storeGmgnSignal(
  database,
  { id, token_address: `${id}-token`, signal_type: 7, observed_at: observedAt },
  { source: 'gmgn-cli', chain: 'sol', capturedAt: new Date(observedAt) },
).id;

const insertRun = (database: ReturnType<typeof openDatabase>, signalId: number, rows: unknown[], completedAt: string, id = 'exec', requestedAt = completedAt): void => {
  database.prepare(`INSERT INTO dune_outcome_runs (signal_ids, query_sql, execution_id, status, raw_result, requested_at, completed_at) VALUES (?, 'select 1', ?, 'completed', ?, ?, ?)`).run(
    JSON.stringify([signalId]), id, JSON.stringify({ result: { rows } }), requestedAt, completedAt,
  );
};

test('measurement planner separates never-measured, pending, unavailable and complete signals', () => {
  const database = openDatabase(':memory:');
  try {
    // notMeasured is backdated well past the 24h observation buffer (MIN_SIGNAL_AGE_MS in
    // src/dune/prescreen.ts) so this test continues to exercise plain not_measured/eligible
    // behavior rather than accidentally landing in the newer too_fresh state — that state has
    // its own dedicated tests below.
    const notMeasured = seed(database, 'not-measured', '2026-02-25T00:00:00Z');
    const pending = seed(database, 'pending', '2026-03-01T01:30:00Z');
    // Backdated 26h before `now` so it clears the 24h retry buffer too (a retry needs
    // the signal itself to be 24h+ old now, not just its first attempt) — its single
    // completed run still fires within 24h of its own observed_at, so it stays a
    // premature (never maturely attempted) attempt as this test's other assertions expect.
    const unavailable = seed(database, 'unavailable', '2026-02-28T00:00:00Z');
    const complete = seed(database, 'complete', '2026-03-01T00:00:00Z');
    insertRun(database, pending, CHECKPOINT_LABELS.map((label) => ({ signal_id: pending, checkpoint: label, target_at: label === '+3h' ? '2026-03-01 04:30:00.000 UTC' : '2026-03-01 01:30:00.000 UTC', price_usd: 1 })), '2026-03-01T01:31:00Z', 'pending-run');
    insertRun(database, unavailable, CHECKPOINT_LABELS.map((label) => ({ signal_id: unavailable, checkpoint: label, target_at: `2026-02-28 23:00:00.000 UTC`, price_usd: null })), '2026-02-28T23:00:00Z', 'unavailable-run');
    insertRun(database, complete, CHECKPOINT_LABELS.map((label) => ({ signal_id: complete, checkpoint: label, target_at: '2026-02-28 23:00:00.000 UTC', price_usd: 1, matched_trade_at: label === 'signal' ? '2026-02-28 22:59:00.000 UTC' : `2026-02-28 22:59:0${label.length}.000 UTC` })), '2026-03-01T00:00:00Z', 'complete-run', '2026-03-02T00:00:00Z');
    const plan = buildMeasurementPlan(database, new Date('2026-03-01T02:00:00Z'));
    assert.equal(plan.version, 'measurement-plan-v11');
    assert.equal(plan.byState.not_measured, 1);
    assert.equal(plan.byState.too_fresh, 0);
    assert.equal(plan.byState.pending_target_time, 1);
    assert.equal(plan.byState.retry_eligible, 1);
    assert.equal(plan.byState.complete, 1);
    assert.deepEqual(plan.eligibleSignalIds.sort((a, b) => a - b), [notMeasured, unavailable].sort((a, b) => a - b));
    assert.deepEqual(plan.eligibleNewSignalIds, [notMeasured]);
    assert.deepEqual(plan.eligibleRetrySignalIds, [unavailable]);
    // `unavailable`'s one completed run fired at the same instant as observed_at (0h delay),
    // so it counts as never having had a mature attempt.
    assert.equal(plan.neverMaturelyAttemptedCount, 1);
    assert.deepEqual(plan.bySignalType.find((item) => item.signalType === '7'), {
      signalType: '7', captured: 4, measured: 1, unmeasured: 3, eligible: 2, pending: 1, complete: 1, retryEligible: 1, inFlight: 0, tooFresh: 0, neverMaturelyAttempted: 1, waitingOnRetryBuffer: 0,
    });
  } finally { database.close(); }
});

test('measurement planner marks a signal younger than the 24h observation buffer as too_fresh, not not_measured', () => {
  const database = openDatabase(':memory:');
  try {
    const tooFresh = seed(database, 'too-fresh', '2026-03-01T01:00:00Z'); // 1h before `now`
    const now = new Date('2026-03-01T02:00:00Z');
    const plan = buildMeasurementPlan(database, now);
    assert.equal(plan.byState.too_fresh, 1);
    assert.equal(plan.byState.not_measured, 0);
    assert.equal(plan.tooFreshCount, 1);
    assert.ok(!plan.eligibleSignalIds.includes(tooFresh), 'a too-fresh signal must never be selected for Dune submission');
    assert.ok(!plan.eligibleNewSignalIds.includes(tooFresh));
    assert.ok(!plan.retryQueueSignalIds.includes(tooFresh));
    const decision = plan.prescreen.byDisposition;
    assert.equal(decision.too_fresh, 1);
  } finally { database.close(); }
});

test('measurement planner treats a signal exactly at the 24h boundary as eligible, and one second short as too_fresh', () => {
  const database = openDatabase(':memory:');
  try {
    const now = new Date('2026-03-02T00:00:00Z');
    const exactlyAtBoundary = seed(database, 'boundary-exact', '2026-03-01T00:00:00Z'); // exactly 24h before now
    const oneSecondShort = seed(database, 'boundary-short', '2026-03-01T00:00:01Z'); // 23h59m59s before now
    const plan = buildMeasurementPlan(database, now);
    assert.ok(plan.eligibleSignalIds.includes(exactlyAtBoundary), 'a signal exactly 24h old must already be eligible');
    assert.ok(!plan.eligibleSignalIds.includes(oneSecondShort), 'a signal one second short of 24h must remain too_fresh');
  } finally { database.close(); }
});

test('measurement planner never classifies an already-measured signal as too_fresh (that label is reserved for never-measured signals), even though it now also holds its retry back until 24h', () => {
  const database = openDatabase(':memory:');
  try {
    // Observed only 10 minutes before `now`, with a completed (though incomplete) outcome.
    // too_fresh must stay reserved for signals with zero prior outcome — this one has an
    // outcome, so it must read elapsed_but_unavailable (silently waiting) instead, now that
    // retries also respect the 24h buffer, not just first attempts.
    const alreadyMeasured = seed(database, 'already-measured', '2026-03-01T01:50:00Z');
    insertRun(database, alreadyMeasured, CHECKPOINT_LABELS.map((label) => ({ signal_id: alreadyMeasured, checkpoint: label, target_at: '2026-03-01 01:50:00.000 UTC', price_usd: null })), '2026-03-01T01:51:00Z', 'early-run');
    const plan = buildMeasurementPlan(database, new Date('2026-03-01T02:00:00Z'));
    assert.notEqual(plan.byState.too_fresh, 1, 'an already-measured signal must never be classified too_fresh, regardless of its own age');
    assert.equal(plan.byState.elapsed_but_unavailable, 1);
    assert.equal(plan.byState.retry_eligible, 0);
  } finally { database.close(); }
});

test('measurement planner blocks a retry on a signal under 24h old even though its normal per-attempt delay has already elapsed', () => {
  const database = openDatabase(':memory:');
  try {
    const observedAt = '2026-03-01T00:00:00Z';
    const tooYoungForRetry = seed(database, 'too-young-for-retry', observedAt);
    // One mature-timed attempt (fired well after the signal existed) whose 15m retry delay
    // has long elapsed, but the signal itself is still under 24h old at `now`.
    insertRun(database, tooYoungForRetry, CHECKPOINT_LABELS.map((label) => ({ signal_id: tooYoungForRetry, checkpoint: label, target_at: '2026-03-01 00:05:00.000 UTC', price_usd: null })), '2026-03-01T00:10:00Z', 'young-run');
    const plan = buildMeasurementPlan(database, new Date('2026-03-01T05:00:00Z')); // signal is 5h old
    assert.equal(plan.byState.retry_eligible, 0, 'a retry must not fire before the signal itself is 24h old');
    assert.equal(plan.byState.elapsed_but_unavailable, 1);
  } finally { database.close(); }
});

test('measurement planner forgives attempts fired before the 24h buffer, so a signal stuck by pre-rule premature retries is retry_eligible again, not retry_exhausted', () => {
  const database = openDatabase(':memory:');
  try {
    const observedAt = '2026-03-01T00:00:00Z';
    const stuck = seed(database, 'stuck-by-premature-attempts', observedAt);
    // 4 completed attempts, all fired within 20 minutes of capture — long before the 24h
    // buffer existed. Under the old logic these alone would exhaust the retry budget forever.
    ['2026-03-01T00:05:00Z', '2026-03-01T00:10:00Z', '2026-03-01T00:15:00Z', '2026-03-01T00:20:00Z'].forEach((completedAt, index) => {
      insertRun(database, stuck, CHECKPOINT_LABELS.map((label) => ({ signal_id: stuck, checkpoint: label, target_at: '2026-02-28 23:00:00.000 UTC', price_usd: null })), completedAt, `premature-${index}`);
    });
    const plan = buildMeasurementPlan(database, new Date('2026-03-02T01:00:00Z')); // 25h after observedAt
    assert.equal(plan.byState.retry_exhausted, 0, 'premature pre-buffer attempts must not exhaust the retry budget');
    assert.equal(plan.byState.retry_eligible, 1);
    assert.ok(plan.eligibleRetrySignalIds.includes(stuck));
    // All 4 real attempts were premature, so this signal has never actually had a fair
    // post-24h check — distinct from tooFreshCount (which only counts never-queried-at-all
    // signals) and distinct from an ordinary retry_eligible signal with a legitimate mature
    // failed attempt (covered by the next test).
    assert.equal(plan.neverMaturelyAttemptedCount, 1);
    assert.equal(plan.tooFreshCount, 0, 'this signal was queried, so it must not also show up as never-measured');
  } finally { database.close(); }
});

test('measurement planner does not count an ordinary retry_eligible signal (one legitimate mature failed attempt) as neverMaturelyAttempted', () => {
  const database = openDatabase(':memory:');
  try {
    const observedAt = '2026-03-01T00:00:00Z';
    const normalRetry = seed(database, 'normal-retry', observedAt);
    // A single attempt fired well after the 24h buffer and long enough ago that its
    // 15m retry delay has already elapsed — a completely ordinary retry_eligible signal.
    insertRun(database, normalRetry, CHECKPOINT_LABELS.map((label) => ({ signal_id: normalRetry, checkpoint: label, target_at: '2026-02-28 23:00:00.000 UTC', price_usd: null })), '2026-03-02T00:00:00Z', 'mature-once');
    const plan = buildMeasurementPlan(database, new Date('2026-03-02T01:00:00Z'));
    assert.equal(plan.byState.retry_eligible, 1);
    assert.equal(plan.neverMaturelyAttemptedCount, 0, 'a signal with a real mature attempt must not be double-counted as never-measured-fairly');
  } finally { database.close(); }
});

test('measurement planner still exhausts a signal whose 4 attempts all fired at or after the 24h buffer', () => {
  const database = openDatabase(':memory:');
  try {
    const observedAt = '2026-03-01T00:00:00Z';
    const genuinelyExhausted = seed(database, 'genuinely-exhausted', observedAt);
    // All 4 attempts fired at/after observedAt + 24h, spaced past each retry delay
    // (15m, 1h, 4h, 12h) — a legitimately exhausted signal must stay exhausted.
    ['2026-03-02T00:00:00Z', '2026-03-02T00:16:00Z', '2026-03-02T01:20:00Z', '2026-03-02T05:25:00Z'].forEach((completedAt, index) => {
      insertRun(database, genuinelyExhausted, CHECKPOINT_LABELS.map((label) => ({ signal_id: genuinelyExhausted, checkpoint: label, target_at: '2026-02-28 23:00:00.000 UTC', price_usd: null })), completedAt, `mature-${index}`);
    });
    const plan = buildMeasurementPlan(database, new Date('2026-03-02T18:00:00Z'));
    assert.equal(plan.byState.retry_exhausted, 1);
    assert.equal(plan.byState.retry_eligible, 0);
  } finally { database.close(); }
});

test('measurement planner blocks signals in submitted, running, and timed-out runs', () => {
  const database = openDatabase(':memory:');
  try {
    const running = seed(database, 'running', '2026-03-01T00:00:00Z');
    const timedOut = seed(database, 'timed-out', '2026-03-01T00:00:00Z');
    database.prepare(`INSERT INTO dune_outcome_runs (signal_ids, query_sql, status, requested_at) VALUES (?, 'select 1', 'running', ?), (?, 'select 1', 'timed_out', ?)`)
      .run(JSON.stringify([running]), '2026-03-01T00:01:00Z', JSON.stringify([timedOut]), '2026-03-01T00:01:00Z');
    const plan = buildMeasurementPlan(database, new Date('2026-03-01T02:00:00Z'));
    assert.equal(plan.byState.in_flight, 2);
    assert.equal(plan.inFlightCount, 2);
    assert.deepEqual(plan.eligibleSignalIds, []);
    assert.equal(plan.bySignalType[0].inFlight, 2);
  } finally { database.close(); }
});

test('measurement planner cache never expires on its own — a call hours later with no new data still returns the original snapshot', () => {
  const database = openDatabase(':memory:');
  try {
    seed(database, 'no-ttl-one', '2026-02-25T00:00:00Z');
    const first = buildMeasurementPlan(database, new Date('2026-03-01T02:00:00Z'));
    // Called with a `now` far beyond any old 60s TTL and with zero new signals/runs written —
    // must replay the cached snapshot rather than recompute, per the explicit "no recalculation
    // unless new data is added" requirement.
    const muchLater = buildMeasurementPlan(database, new Date('2026-03-05T02:00:00Z'));
    assert.equal(muchLater.generatedAt, first.generatedAt);
    assert.deepEqual(muchLater, first);
  } finally { database.close(); }
});

test('measurement planner caches the compact snapshot and invalidates it when signals change', () => {
  const database = openDatabase(':memory:');
  try {
    // Backdated past the 24h observation buffer so both signals stay eligible for selection —
    // this test is about cache invalidation, not the buffer, and needs selectedIds to be
    // non-empty to prove the cache actually recomputed rather than replaying a stale entry.
    seed(database, 'cached-one', '2026-02-25T00:00:00Z');
    const now = new Date('2026-03-01T02:00:00Z');
    const first = buildMeasurementPlan(database, now);
    const second = buildMeasurementPlan(database, now);
    assert.equal(first.generatedAt, second.generatedAt);
    assert.equal('decisions' in second.prescreen, false);
    assert.equal((database.prepare('SELECT count(*) AS count FROM measurement_plan_cache').get() as { count: number }).count, 1);
    seed(database, 'cached-two', '2026-02-25T00:01:00Z');
    const changed = buildMeasurementPlan(database, now);
    assert.equal(changed.capturedCount, 2);
    assert.equal(changed.prescreen.selectedIds.length > 0, true);
  } finally { database.close(); }
});
