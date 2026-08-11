import type { DatabaseSync } from 'node:sqlite';
import { captureGmgnSignals, type GmgnCaptureResult } from './capture.js';
import { logDiagnostic } from '../db/diagnostics.js';

export const MIN_WATCH_INTERVAL_SECONDS = 60;
export const DEFAULT_WATCH_INTERVAL_SECONDS = 300;
export const MAX_CONSECUTIVE_FAILURES = 3;
export const DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS = 300;

export type WatchCaptureFn = (database: DatabaseSync) => Promise<GmgnCaptureResult>;

export interface WatchLastPoll {
  at: string;
  ok: boolean;
  captured?: number;
  stored?: number;
  repeated?: number;
  errors?: number;
  gapDetected?: boolean;
  message?: string;
  rateLimited?: boolean;
}

export interface WatchStatus {
  running: boolean;
  intervalSeconds: number;
  nextPollAt: string | null;
  lastPoll: WatchLastPoll | null;
  totalPolls: number;
  totalStored: number;
  totalRepeated: number;
  consecutiveFailures: number;
  stoppedReason: string | null;
  rateLimitedUntil: string | null;
}

const createInitialState = (): WatchStatus => ({
  running: false,
  intervalSeconds: DEFAULT_WATCH_INTERVAL_SECONDS,
  nextPollAt: null,
  lastPoll: null,
  totalPolls: 0,
  totalStored: 0,
  totalRepeated: 0,
  consecutiveFailures: 0,
  stoppedReason: null,
  rateLimitedUntil: null,
});

let state: WatchStatus = createInitialState();
let timerHandle: NodeJS.Timeout | null = null;

/**
 * Best-effort 429/rate-limit detection. The exact GMGN header or field name for a documented
 * reset time is not yet confirmed by a real fixture, so this checks a few plausible spellings
 * and falls back to a fixed cooldown rather than guessing further.
 */
export const detectRateLimit = (error: unknown): { limited: boolean; resetAt: string | null } => {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = error && typeof error === 'object' && 'stderr' in error
    ? String((error as { stderr?: unknown }).stderr ?? '')
    : '';
  const combined = `${message} ${stderr}`;
  const text = combined.toLowerCase();
  if (!text.includes('429') && !text.includes('rate limit') && !text.includes('rate-limit')) {
    return { limited: false, resetAt: null };
  }
  const resetMatch = /"?reset_at"?\s*[:=]\s*"?([0-9]{10,13}|[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.Z+-]+)"?/i.exec(combined);
  if (resetMatch) {
    const raw = resetMatch[1]!;
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && /^[0-9]+$/.test(raw)) {
      const millis = raw.length <= 10 ? numeric * 1000 : numeric;
      const date = new Date(millis);
      if (!Number.isNaN(date.getTime())) return { limited: true, resetAt: date.toISOString() };
    } else {
      const date = new Date(raw);
      if (!Number.isNaN(date.getTime())) return { limited: true, resetAt: date.toISOString() };
    }
  }
  return { limited: true, resetAt: null };
};

/** Runs one poll and updates watcher state. Exported directly so tests never depend on real timers. */
export const runWatchTick = async (
  database: DatabaseSync,
  capture: WatchCaptureFn = captureGmgnSignals,
  now: () => Date = () => new Date(),
): Promise<WatchStatus> => {
  if (!state.running) return { ...state };
  try {
    const result = await capture(database);
    state.totalPolls += 1;
    state.totalStored += result.stored;
    state.totalRepeated += result.repeated;
    state.consecutiveFailures = 0;
    state.rateLimitedUntil = null;
    state.lastPoll = {
      at: result.capturedAt,
      ok: true,
      captured: result.captured,
      stored: result.stored,
      repeated: result.repeated,
      errors: result.errors,
      gapDetected: result.gapDetected,
    };
    logDiagnostic(database, {
      level: result.errors > 0 || result.gapDetected ? 'warn' : 'info',
      event: 'watch-poll-complete',
      message: `captured ${result.captured}; stored ${result.stored}; repeated ${result.repeated}; errors ${result.errors}${result.gapDetected ? '; gap flagged' : ''}`,
    });
  } catch (error) {
    state.totalPolls += 1;
    state.consecutiveFailures += 1;
    const rateLimit = detectRateLimit(error);
    const message = error instanceof Error ? error.message : String(error);
    state.lastPoll = { at: now().toISOString(), ok: false, message, rateLimited: rateLimit.limited };
    logDiagnostic(database, {
      level: 'error',
      event: 'watch-poll-failed',
      message,
      detail: { consecutiveFailures: state.consecutiveFailures, rateLimited: rateLimit.limited },
    });
    if (rateLimit.limited) {
      // A 429 is an expected, self-resolving condition: back off to the reset time (or a fixed
      // cooldown) instead of retrying aggressively. It never counts toward the hard stop below.
      state.rateLimitedUntil = rateLimit.resetAt
        ?? new Date(now().getTime() + DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS * 1000).toISOString();
    } else if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      state.running = false;
      state.nextPollAt = null;
      state.stoppedReason = `Stopped after ${state.consecutiveFailures} consecutive failures: ${message}`;
      logDiagnostic(database, { level: 'error', event: 'watch-stopped', message: state.stoppedReason });
    }
  }
  return { ...state };
};

const computeNextDelaySeconds = (): number => {
  if (state.rateLimitedUntil) {
    const remaining = Math.ceil((new Date(state.rateLimitedUntil).getTime() - Date.now()) / 1000);
    return Math.max(MIN_WATCH_INTERVAL_SECONDS, remaining);
  }
  return state.intervalSeconds;
};

const scheduleNext = (database: DatabaseSync, capture: WatchCaptureFn): void => {
  const delaySeconds = computeNextDelaySeconds();
  state.nextPollAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
  timerHandle = setTimeout(() => { void loop(database, capture); }, delaySeconds * 1000);
  timerHandle.unref?.();
};

const loop = async (database: DatabaseSync, capture: WatchCaptureFn): Promise<void> => {
  await runWatchTick(database, capture);
  if (state.running) scheduleNext(database, capture);
};

/**
 * Starts polling in the background and returns immediately — the caller (an HTTP route) must
 * not block on a full poll cycle. Runs only for the lifetime of this process: no persistence,
 * no separate service, nothing that outlives the running application.
 */
export const startGmgnWatch = (
  database: DatabaseSync,
  intervalSeconds?: number,
  capture: WatchCaptureFn = captureGmgnSignals,
): WatchStatus => {
  const clamped = intervalSeconds !== undefined && Number.isFinite(intervalSeconds)
    ? Math.max(MIN_WATCH_INTERVAL_SECONDS, Math.floor(intervalSeconds))
    : state.intervalSeconds;
  if (state.running) {
    state.intervalSeconds = clamped;
    return { ...state };
  }
  if (timerHandle) { clearTimeout(timerHandle); timerHandle = null; }
  state = { ...createInitialState(), running: true, intervalSeconds: clamped };
  logDiagnostic(database, { level: 'info', event: 'watch-started', message: `interval ${clamped}s` });
  void loop(database, capture);
  return { ...state };
};

export const stopGmgnWatch = (database: DatabaseSync): WatchStatus => {
  if (timerHandle) { clearTimeout(timerHandle); timerHandle = null; }
  const wasRunning = state.running;
  state.running = false;
  state.nextPollAt = null;
  if (wasRunning) logDiagnostic(database, { level: 'info', event: 'watch-stopped', message: 'Stopped by user.' });
  return { ...state };
};

export const getGmgnWatchStatus = (): WatchStatus => ({ ...state });

/** Test-only: primes running=true without scheduling a real timer, so runWatchTick can be exercised directly. */
export const beginWatchSessionForTests = (intervalSeconds = DEFAULT_WATCH_INTERVAL_SECONDS): void => {
  if (timerHandle) { clearTimeout(timerHandle); timerHandle = null; }
  state = { ...createInitialState(), running: true, intervalSeconds };
};

/** Test-only: resets module state between test cases. */
export const resetGmgnWatchForTests = (): void => {
  if (timerHandle) { clearTimeout(timerHandle); timerHandle = null; }
  state = createInitialState();
};
