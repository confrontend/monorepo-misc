import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/db/client.js';
import type { GmgnCaptureResult } from '../src/gmgn/capture.js';
import {
  DEFAULT_WATCH_INTERVAL_SECONDS,
  MAX_CONSECUTIVE_FAILURES,
  MIN_WATCH_INTERVAL_SECONDS,
  beginWatchSessionForTests,
  detectRateLimit,
  getGmgnWatchStatus,
  resetGmgnWatchForTests,
  runWatchTick,
  startGmgnWatch,
  stopGmgnWatch,
} from '../src/gmgn/watch.js';

const okResult = (overrides: Partial<GmgnCaptureResult> = {}): GmgnCaptureResult => ({
  pollId: 1,
  captured: 2,
  stored: 2,
  repeated: 0,
  errors: 0,
  gapDetected: false,
  archivePath: '/tmp/archive.zip',
  archiveSha256: 'abc123',
  capturedAt: '2026-08-11T00:00:00.000Z',
  ...overrides,
});

test('a successful tick records the result and resets the failure count', async () => {
  const database = openDatabase(':memory:');
  try {
    beginWatchSessionForTests(120);
    const status = await runWatchTick(database, async () => okResult({ stored: 3, repeated: 1 }));
    assert.equal(status.running, true);
    assert.equal(status.totalPolls, 1);
    assert.equal(status.totalStored, 3);
    assert.equal(status.totalRepeated, 1);
    assert.equal(status.consecutiveFailures, 0);
    assert.equal(status.lastPoll?.ok, true);
    assert.equal(status.lastPoll?.stored, 3);
  } finally {
    resetGmgnWatchForTests();
    database.close();
  }
});

test('a non-rate-limit failure increments consecutiveFailures without stopping below the threshold', async () => {
  const database = openDatabase(':memory:');
  try {
    beginWatchSessionForTests(120);
    const status = await runWatchTick(database, async () => { throw new Error('CLI crashed'); });
    assert.equal(status.running, true);
    assert.equal(status.consecutiveFailures, 1);
    assert.equal(status.lastPoll?.ok, false);
    assert.equal(status.lastPoll?.message, 'CLI crashed');
    assert.equal(status.stoppedReason, null);
  } finally {
    resetGmgnWatchForTests();
    database.close();
  }
});

test('watch mode stops itself after MAX_CONSECUTIVE_FAILURES genuine failures in a row', async () => {
  const database = openDatabase(':memory:');
  try {
    beginWatchSessionForTests(120);
    let status = getGmgnWatchStatus();
    for (let attempt = 0; attempt < MAX_CONSECUTIVE_FAILURES; attempt += 1) {
      status = await runWatchTick(database, async () => { throw new Error(`failure ${attempt}`); });
    }
    assert.equal(status.consecutiveFailures, MAX_CONSECUTIVE_FAILURES);
    assert.equal(status.running, false);
    assert.match(status.stoppedReason ?? '', new RegExp(`Stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`));

    // Once stopped, further ticks are no-ops rather than resuming on their own.
    const afterStop = await runWatchTick(database, async () => okResult());
    assert.equal(afterStop.running, false);
    assert.equal(afterStop.totalPolls, MAX_CONSECUTIVE_FAILURES);
  } finally {
    resetGmgnWatchForTests();
    database.close();
  }
});

test('a rate-limited (429) failure backs off instead of counting toward the hard stop', async () => {
  const database = openDatabase(':memory:');
  try {
    beginWatchSessionForTests(120);
    let status = getGmgnWatchStatus();
    for (let attempt = 0; attempt < MAX_CONSECUTIVE_FAILURES + 2; attempt += 1) {
      status = await runWatchTick(database, async () => { throw new Error('GMGN request failed: 429 Too Many Requests'); });
    }
    assert.equal(status.running, true, 'rate limiting alone must never trip the hard stop');
    assert.equal(status.stoppedReason, null);
    assert.ok(status.rateLimitedUntil, 'a cooldown time should be recorded');
    assert.equal(status.lastPoll?.rateLimited, true);
  } finally {
    resetGmgnWatchForTests();
    database.close();
  }
});

test('detectRateLimit recognizes 429s, extracts a documented reset time, and ignores unrelated errors', () => {
  assert.deepEqual(detectRateLimit(new Error('boom')), { limited: false, resetAt: null });

  const noReset = detectRateLimit(new Error('429 rate limit exceeded'));
  assert.equal(noReset.limited, true);
  assert.equal(noReset.resetAt, null);

  const withIsoReset = detectRateLimit(new Error('429: rate limit, reset_at: 2026-08-11T05:00:00.000Z'));
  assert.equal(withIsoReset.limited, true);
  assert.equal(withIsoReset.resetAt, '2026-08-11T05:00:00.000Z');

  const withEpochReset = detectRateLimit(new Error('429 rate limit "reset_at": 1786500000'));
  assert.equal(withEpochReset.limited, true);
  assert.equal(withEpochReset.resetAt, new Date(1786500000 * 1000).toISOString());
});

test('startGmgnWatch clamps the interval to the configured minimum and flips running synchronously', () => {
  const database = openDatabase(':memory:');
  try {
    const status = startGmgnWatch(database, 5, async () => new Promise(() => { /* never resolves during this test */ }));
    assert.equal(status.running, true);
    assert.equal(status.intervalSeconds, MIN_WATCH_INTERVAL_SECONDS);
  } finally {
    stopGmgnWatch(database);
    resetGmgnWatchForTests();
    database.close();
  }
});

test('starting an already-running watcher updates the interval without resetting counters', () => {
  const database = openDatabase(':memory:');
  try {
    beginWatchSessionForTests(120);
    const running = getGmgnWatchStatus();
    assert.equal(running.running, true);
    const restarted = startGmgnWatch(database, 900, async () => new Promise(() => { /* unused */ }));
    assert.equal(restarted.running, true);
    assert.equal(restarted.intervalSeconds, 900);
  } finally {
    stopGmgnWatch(database);
    resetGmgnWatchForTests();
    database.close();
  }
});

test('an unspecified interval on first start falls back to the documented default', () => {
  const database = openDatabase(':memory:');
  try {
    const status = startGmgnWatch(database, undefined, async () => new Promise(() => { /* unused */ }));
    assert.equal(status.intervalSeconds, DEFAULT_WATCH_INTERVAL_SECONDS);
  } finally {
    stopGmgnWatch(database);
    resetGmgnWatchForTests();
    database.close();
  }
});

test('stopGmgnWatch flips running to false and clears the scheduled next-poll time', () => {
  const database = openDatabase(':memory:');
  try {
    beginWatchSessionForTests(120);
    const stopped = stopGmgnWatch(database);
    assert.equal(stopped.running, false);
    assert.equal(stopped.nextPollAt, null);
  } finally {
    resetGmgnWatchForTests();
    database.close();
  }
});
