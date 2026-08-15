import type { DatabaseSync } from 'node:sqlite';
import { CHECKPOINT_LABELS, readAllDuneOutcomes } from './outcomes.js';
import { MIN_SIGNAL_AGE_MS, readPrescreenCandidates, runPrescreen, selectRetryQueueIds, type PrescreenSummary } from './prescreen.js';

export const MEASUREMENT_PLAN_VERSION = 'measurement-plan-v11';
export const RETRY_DELAYS_MS = [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000, 12 * 60 * 60_000];

export type MeasurementState =
  | 'not_measured'
  | 'too_fresh'
  | 'pending_target_time'
  | 'elapsed_but_unavailable'
  | 'retry_eligible'
  | 'retry_exhausted'
  | 'complete'
  | 'in_flight';

export type MeasurementPlan = {
  version: string;
  generatedAt: string;
  retryDelaysMinutes: number[];
  maxAttempts: number;
  capturedCount: number;
  parsedCount: number;
  latestCapturedAt: string | null;
  latestObservedAt: string | null;
  latestDuneCompletedAt: string | null;
  measuredCount: number;
  unmeasuredCount: number;
  tooFreshCount: number;
  inFlightCount: number;
  /** Signals that already have one or more completed Dune attempts, none of which fired
   * at or after the signal was MIN_SIGNAL_AGE_MS old, and which still have no real
   * (received) data on any checkpoint. Distinct from tooFreshCount (never measured at
   * all): these were queried, just always too soon to have a fair chance. They are a
   * subset of byState.retry_eligible, called out separately so the difference between
   * "never tried" and "tried too early every time" stays visible. */
  neverMaturelyAttemptedCount: number;
  eligibleSignalIds: number[];
  eligibleNewSignalIds: number[];
  eligibleRetrySignalIds: number[];
  retryQueueSignalIds: number[];
  byState: Record<MeasurementState, number>;
  bySignalType: Array<{ signalType: string; captured: number; measured: number; unmeasured: number; eligible: number; pending: number; complete: number; retryEligible: number; inFlight: number; tooFresh: number; neverMaturelyAttempted: number; waitingOnRetryBuffer: number }>;
  prescreen: Omit<PrescreenSummary, 'decisions'>;
};

const parseTime = (value: unknown): number | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

const emptyStates = (): Record<MeasurementState, number> => ({
  not_measured: 0,
  too_fresh: 0,
  pending_target_time: 0,
  elapsed_but_unavailable: 0,
  retry_eligible: 0,
  retry_exhausted: 0,
  complete: 0,
  in_flight: 0,
});

/** Signal IDs belonging to a request that was submitted to Dune but has not
 * produced a completed result yet. A local timeout is deliberately retained as
 * in-flight: retrying it would create a second Dune execution for the same IDs. */
const signalIdsInFlight = (database: DatabaseSync): Set<number> => {
  const result = new Set<number>();
  const runs = database.prepare(`SELECT signal_ids AS signalIds FROM dune_outcome_runs WHERE status IN ('submitted', 'running', 'timed_out')`).all() as unknown as Array<{ signalIds: string }>;
  for (const run of runs) {
    let ids: unknown;
    try { ids = JSON.parse(run.signalIds); } catch { continue; }
    if (!Array.isArray(ids)) continue;
    for (const rawId of ids) {
      const id = Number(rawId);
      if (Number.isInteger(id)) result.add(id);
    }
  }
  return result;
};

/** Attempts fired before a signal was MIN_SIGNAL_AGE_MS old don't count toward the
 * retry budget or exhaustion clock. Before the 24h buffer existed, a large share of
 * historical first attempts fired minutes after capture, before any real trade data
 * could exist, exhausting all 4 retries on attempts that never had a fair chance —
 * verified live: 28 signals are permanently stuck in retry_exhausted this way. Once a
 * signal is past the buffer, every subsequent attempt (including all future ones,
 * since too_fresh gates the very first attempt for new signals) counts normally, so
 * this only forgives stale, pre-rule history and cannot be used to retry forever. */
const signalIdsWithRuns = (database: DatabaseSync, observedAtById: Map<number, string>): Map<number, { attempts: number; lastCompletedAt: number | null; rawAttempts: number }> => {
  const result = new Map<number, { attempts: number; lastCompletedAt: number | null; rawAttempts: number }>();
  const runs = database.prepare(`SELECT signal_ids AS signalIds, requested_at AS requestedAt, completed_at AS completedAt FROM dune_outcome_runs WHERE status = 'completed' ORDER BY id ASC`).all() as unknown as Array<{ signalIds: string; requestedAt: string | null; completedAt: string | null }>;
  for (const run of runs) {
    let ids: unknown;
    try { ids = JSON.parse(run.signalIds); } catch { continue; }
    if (!Array.isArray(ids)) continue;
    const requestedMs = parseTime(run.requestedAt);
    for (const rawId of ids) {
      const id = Number(rawId);
      if (!Number.isInteger(id)) continue;
      const previous = result.get(id) ?? { attempts: 0, lastCompletedAt: null, rawAttempts: 0 };
      previous.rawAttempts += 1;
      const observedMs = parseTime(observedAtById.get(id) ?? null);
      if (observedMs !== null && requestedMs !== null && requestedMs - observedMs < MIN_SIGNAL_AGE_MS) { result.set(id, previous); continue; }
      previous.attempts += 1;
      previous.lastCompletedAt = parseTime(run.completedAt);
      result.set(id, previous);
    }
  }
  return result;
};

const stateFor = (
  signalId: number,
  observedAt: string,
  outcome: ReturnType<typeof readAllDuneOutcomes>[number] | undefined,
  runInfo: { attempts: number; lastCompletedAt: number | null } | undefined,
  nowMs: number,
): MeasurementState => {
  if (!outcome) {
    // Never re-gates a signal that already has some outcome — this only delays a signal's
    // FIRST Dune submission, never touches one already measured (see MIN_SIGNAL_AGE_MS's own
    // comment in prescreen.ts for why 24h, backed by real retry-recovery data).
    const observedMs = Date.parse(observedAt);
    if (!Number.isNaN(observedMs) && nowMs - observedMs < MIN_SIGNAL_AGE_MS) return 'too_fresh';
    return 'not_measured';
  }
  const byLabel = new Map(outcome.checkpoints.map((checkpoint) => [checkpoint.label, checkpoint]));
  const hasFuturePending = CHECKPOINT_LABELS.some((label) => {
    const checkpoint = byLabel.get(label);
    const targetMs = checkpoint ? parseTime(checkpoint.targetTimestamp) : null;
    return checkpoint?.result.status === 'checkpoint not yet reached' && targetMs !== null && targetMs > nowMs;
  });
  const unresolved = CHECKPOINT_LABELS.filter((label) => {
    const checkpoint = byLabel.get(label);
    if (!checkpoint) return true;
    if (checkpoint.result.status === 'received') return false;
    if (checkpoint.result.status === 'not available') return true;
    if (checkpoint.result.status === 'checkpoint not yet reached') {
      const targetMs = parseTime(checkpoint.targetTimestamp);
      return targetMs === null || targetMs <= nowMs;
    }
    return true;
  });
  // A signal with any future checkpoint is still too fresh for a retry. Keep it
  // in the waiting queue even when an earlier checkpoint is currently missing;
  // otherwise the missing earlier cell would make the whole signal look retryable
  // before its later horizon has matured.
  if (hasFuturePending) return 'pending_target_time';
  if (unresolved.length === 0) return 'complete';
  // The 24h buffer isn't just about a signal's first-ever attempt — a retry on data
  // younger than 24h hits the same Dune indexing-lag problem. Verified live: signals
  // retried under 6h old succeeded only 59.7% of the time vs. 95.9% at 6-24h. Until a
  // signal turns 24h old it simply waits here, same as a normal mid-delay signal.
  const observedMs = Date.parse(observedAt);
  if (!Number.isNaN(observedMs) && nowMs - observedMs < MIN_SIGNAL_AGE_MS) return 'elapsed_but_unavailable';
  const attempts = runInfo?.attempts ?? 0;
  const lastAttemptMs = runInfo?.lastCompletedAt ?? null;
  const retryIndex = Math.max(0, Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1));
  const delay = RETRY_DELAYS_MS[retryIndex] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  if (attempts >= RETRY_DELAYS_MS.length && lastAttemptMs !== null && nowMs - lastAttemptMs >= delay) return 'retry_exhausted';
  if (lastAttemptMs === null || nowMs - lastAttemptMs >= delay) return 'retry_eligible';
  return 'elapsed_but_unavailable';
};

const computeMeasurementPlan = (database: DatabaseSync, now = new Date()): MeasurementPlan => {
  const signals = database.prepare(`SELECT id, observed_at AS observedAt, captured_at AS capturedAt, signal_type AS signalType FROM gmgn_signals WHERE token_address IS NOT NULL AND observed_at IS NOT NULL ORDER BY id ASC`).all() as unknown as Array<{ id: number; observedAt: string; capturedAt: string; signalType: string | null }>;
  const outcomes = new Map(readAllDuneOutcomes(database).map((outcome) => [outcome.signal.id, outcome]));
  const observedAtById = new Map(signals.map((signal) => [signal.id, signal.observedAt]));
  const runInfo = signalIdsWithRuns(database, observedAtById);
  const inFlightIds = signalIdsInFlight(database);
  const byState = emptyStates();
  const plannerStates = new Map<number, MeasurementState>();
  const typeStates = new Map<string, { captured: number; measured: number; unmeasured: number; eligible: number; pending: number; complete: number; retryEligible: number; inFlight: number; tooFresh: number; neverMaturelyAttempted: number; waitingOnRetryBuffer: number }>();
  const signalTypeById = new Map<number, string>();
  const prematureAttemptIds = new Set<number>();
  for (const signal of signals) {
    const info = runInfo.get(signal.id);
    const state = inFlightIds.has(signal.id) ? 'in_flight' : stateFor(signal.id, signal.observedAt, outcomes.get(signal.id), info, now.getTime());
    byState[state] += 1;
    plannerStates.set(signal.id, state);
    const signalType = signal.signalType ?? 'unknown';
    signalTypeById.set(signal.id, signalType);
    const current = typeStates.get(signalType) ?? { captured: 0, measured: 0, unmeasured: 0, eligible: 0, pending: 0, complete: 0, retryEligible: 0, inFlight: 0, tooFresh: 0, neverMaturelyAttempted: 0, waitingOnRetryBuffer: 0 };
    current.captured += 1;
    if (state === 'complete') current.measured += 1; else current.unmeasured += 1;
    if (state === 'not_measured' || state === 'retry_eligible') current.eligible += 1;
    if (state === 'pending_target_time') current.pending += 1;
    if (state === 'complete') current.complete += 1;
    if (state === 'retry_eligible') current.retryEligible += 1;
    if (state === 'in_flight') current.inFlight += 1;
    if (state === 'too_fresh') current.tooFresh += 1;
    if (state === 'elapsed_but_unavailable') current.waitingOnRetryBuffer += 1;
    // Already queried at least once, but every attempt fired before the 24h buffer, so
    // none of them counted — distinct from a signal that legitimately failed a mature
    // attempt and is now waiting out its normal retry delay.
    if (state === 'retry_eligible' && info && info.rawAttempts > 0 && info.attempts === 0) prematureAttemptIds.add(signal.id);
    typeStates.set(signalType, current);
  }
  const prescreenCandidates = readPrescreenCandidates(database, plannerStates);
  const prescreen = runPrescreen(database, prescreenCandidates, now);
  const selectedDecisions = prescreen.decisions.filter((decision) => decision.disposition === 'eligible_core' || decision.disposition === 'eligible_audit');
  const eligibleNewSignalIds = selectedDecisions.filter((decision) => decision.plannerState === 'not_measured').map((decision) => decision.signalId);
  const eligibleRetrySignalIds = selectedDecisions.filter((decision) => decision.plannerState === 'retry_eligible').map((decision) => decision.signalId);
  // Keep a separate retry queue so a large influx of never-measured rows cannot
  // starve matured re-fetches. It is fully screened and deterministic; the UI
  // still submits it in small batches to avoid one giant Dune request.
  // Defense in depth: planner state applies the same age rule, but the queue itself
  // re-checks the timestamp so stale cached state can never submit a too-fresh signal.
  const retryQueueSignalIds = selectRetryQueueIds(prescreenCandidates, Number.MAX_SAFE_INTEGER, now);
  const prematureAttemptIdsInQueue = new Set(retryQueueSignalIds.filter((id) => prematureAttemptIds.has(id)));
  for (const id of prematureAttemptIdsInQueue) {
    const signalType = signalTypeById.get(id) ?? 'unknown';
    const current = typeStates.get(signalType);
    if (current) current.neverMaturelyAttempted += 1;
  }
  const neverMaturelyAttemptedCount = prematureAttemptIdsInQueue.size;
  const selectedByType = new Map<string, number>();
  for (const decision of prescreen.decisions) if (decision.disposition === 'eligible_core' || decision.disposition === 'eligible_audit') selectedByType.set(decision.signalType ?? 'unknown', (selectedByType.get(decision.signalType ?? 'unknown') ?? 0) + 1);
  const bySignalType = [...typeStates.entries()].sort(([a], [b]) => Number(a) - Number(b)).map(([signalType, counts]) => ({ signalType, ...counts, eligible: selectedByType.get(signalType) ?? 0 }));
  return {
    version: MEASUREMENT_PLAN_VERSION,
    generatedAt: now.toISOString(),
    retryDelaysMinutes: RETRY_DELAYS_MS.map((value) => value / 60_000),
    maxAttempts: RETRY_DELAYS_MS.length,
    capturedCount: signals.length,
    parsedCount: signals.length,
    latestCapturedAt: signals.reduce<string | null>((latest, signal) => !latest || signal.capturedAt > latest ? signal.capturedAt : latest, null),
    latestObservedAt: signals.reduce<string | null>((latest, signal) => !latest || signal.observedAt > latest ? signal.observedAt : latest, null),
    latestDuneCompletedAt: (database.prepare(`SELECT max(completed_at) AS completedAt FROM dune_outcome_runs WHERE status = 'completed'`).get() as { completedAt: string | null }).completedAt,
    measuredCount: byState.complete,
    // This is deliberately the complement of genuinely complete outcomes (excluding
    // in-flight rows, which are reported separately), not merely `not_measured`.
    // A retry-eligible or waiting signal is not complete just because a raw run exists.
    unmeasuredCount: signals.length - byState.complete - byState.in_flight,
    tooFreshCount: byState.too_fresh,
    inFlightCount: byState.in_flight,
    neverMaturelyAttemptedCount,
    eligibleSignalIds: prescreen.selectedIds,
    eligibleNewSignalIds,
    eligibleRetrySignalIds,
    retryQueueSignalIds,
    byState,
    bySignalType,
    prescreen,
  };
};

const MEASUREMENT_PLAN_CACHE_KEY = 'default';

const readMeasurementPlanFingerprint = (database: DatabaseSync): string => {
  const signals = database.prepare(`SELECT count(*) AS count, max(id) AS maxId, max(captured_at) AS latestCapturedAt, max(observed_at) AS latestObservedAt FROM gmgn_signals`).get();
  const runs = database.prepare(`SELECT count(*) AS count, max(id) AS maxId, max(requested_at) AS latestRequestedAt, max(completed_at) AS latestCompletedAt, group_concat(status, ',') AS statuses FROM dune_outcome_runs`).get();
  return JSON.stringify({ version: MEASUREMENT_PLAN_VERSION, signals, runs });
};

const compactMeasurementPlan = (plan: MeasurementPlan): MeasurementPlan => {
  const { decisions: _decisions, ...compactPrescreen } = plan.prescreen as PrescreenSummary;
  return { ...plan, prescreen: compactPrescreen };
};

// Purely data-triggered by explicit request: a page load must never recompute unless
// gmgn_signals or dune_outcome_runs actually changed (readMeasurementPlanFingerprint
// covers both). Accepted tradeoff, called out to the user before implementing: a few
// plan fields also depend on wall-clock time with no accompanying data change (a
// too_fresh signal turning 24h old; a pending_target_time checkpoint's target time
// passing) — those will keep reading their last-computed value until the next byte of
// new data arrives, rather than flipping the instant the clock allows it. Any action
// that writes new data (a capture, a Dune submission or completion) still invalidates
// the cache immediately via the fingerprint, so this only affects idle viewing.
export const buildMeasurementPlan = (database: DatabaseSync, now = new Date()): MeasurementPlan => {
  const fingerprint = readMeasurementPlanFingerprint(database);
  const cached = database.prepare(`SELECT source_fingerprint AS sourceFingerprint, plan_json AS planJson FROM measurement_plan_cache WHERE cache_key = ?`).get(MEASUREMENT_PLAN_CACHE_KEY) as { sourceFingerprint: string; planJson: string } | undefined;
  if (cached && cached.sourceFingerprint === fingerprint) {
    try { return JSON.parse(cached.planJson) as MeasurementPlan; } catch { /* discard malformed cache and rebuild */ }
  }
  const plan = compactMeasurementPlan(computeMeasurementPlan(database, now));
  const generatedAt = plan.generatedAt;
  database.prepare(`INSERT INTO measurement_plan_cache (cache_key, rule_version, source_fingerprint, generated_at, expires_at, plan_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET rule_version = excluded.rule_version, source_fingerprint = excluded.source_fingerprint, generated_at = excluded.generated_at, expires_at = excluded.expires_at, plan_json = excluded.plan_json`).run(MEASUREMENT_PLAN_CACHE_KEY, MEASUREMENT_PLAN_VERSION, fingerprint, generatedAt, generatedAt, JSON.stringify(plan));
  return plan;
};
