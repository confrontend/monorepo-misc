import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const PRESCREEN_RULE_VERSION = 'gmgn-dune-prescreen-v2';
export const PRESCREEN_AUDIT_SEED = 'gmgn-dune-prescreen-v1-audit';
export const PRESCREEN_MAX_SIGNAL_IDS = 500;
export const PRESCREEN_AUDIT_FRACTION = 0.15;
// A global observation buffer before any signal's first Dune submission. Verified against real
// retry data before choosing this value, not guessed: of 2,316 checkpoints that eventually
// recovered from "not available" to "received," the gap between the failed attempt and the
// successful retry had a median of 18.6h and a max ever observed of 33.6h — nothing in this
// project's history has ever taken close to the originally-proposed 3 days. Separately, signals
// whose first Dune query happened 6-24h after observed_at already succeeded on the first try
// 98.4% of the time, vs. 8.6%/13.5% for queries fired within 1h/1-6h. 24h captures effectively
// all of the achievable benefit (fewer wasted retry executions) without adding latency the data
// doesn't justify. Does not apply to signals that already have some outcome (see stateFor in
// planner.ts) — this only delays a signal's FIRST attempt, never re-gates one already measured.
export const MIN_SIGNAL_AGE_HOURS = 24;
export const MIN_SIGNAL_AGE_MS = MIN_SIGNAL_AGE_HOURS * 60 * 60 * 1000;

export type PrescreenPlannerState =
  | 'not_measured'
  | 'too_fresh'
  | 'pending_target_time'
  | 'elapsed_but_unavailable'
  | 'retry_eligible'
  | 'retry_exhausted'
  | 'complete'
  | 'in_flight';
export type PrescreenDisposition =
  | 'eligible_core'
  | 'eligible_audit'
  | 'deferred_repeat'
  | 'deferred_budget'
  | 'too_fresh'
  | 'invalid_for_query'
  | 'already_measured';
export type PrescreenCandidate = {
  id: number;
  tokenAddress: string | null;
  signalType: string | null;
  observedAt: string | null;
  capturedAt: string;
  cohortMatched: boolean;
  plannerState: PrescreenPlannerState;
};
export type PrescreenDecision = {
  signalId: number;
  disposition: PrescreenDisposition;
  reason: string;
  signalType: string | null;
  captureDate: string | null;
  cohortMatched: boolean;
  plannerState: PrescreenPlannerState;
};
export type PrescreenSummary = {
  ruleVersion: string;
  auditSeed: string;
  maxSignalIds: number;
  auditFraction: number;
  minSignalAgeHours: number;
  selectedIds: number[];
  selectedNewCount: number;
  selectedRetryCount: number;
  byDisposition: Record<PrescreenDisposition, number>;
  bySignalType: Array<{
    signalType: string;
    captured: number;
    selected: number;
    core: number;
    audit: number;
    deferred: number;
    newSelected: number;
    retrySelected: number;
    tooFresh: number;
  }>;
  decisions: PrescreenDecision[];
};

const emptyCounts = (): Record<PrescreenDisposition, number> => ({
  eligible_core: 0,
  eligible_audit: 0,
  deferred_repeat: 0,
  deferred_budget: 0,
  too_fresh: 0,
  invalid_for_query: 0,
  already_measured: 0,
});
const eligibleAtIso = (observedAt: string | null): string | null => {
  const observedMs = observedAt ? Date.parse(observedAt) : NaN;
  return Number.isNaN(observedMs) ? null : new Date(observedMs + MIN_SIGNAL_AGE_MS).toISOString();
};
const captureDate = (value: string | null): string | null => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
};
// The importer currently accepts source addresses as opaque strings (tests and older
// enrichment fixtures use placeholders). The pre-screen therefore enforces presence here;
// a strict Solana base58 validator should be added only when the ingestion contract adopts one.
const validAddress = (value: string | null): boolean =>
  typeof value === 'string' && value.trim().length > 0;
const stableRank = (signalId: number): string =>
  createHash('sha256').update(`${PRESCREEN_AUDIT_SEED}:${signalId}`, 'utf8').digest('hex');

const isEligibleState = (state: PrescreenPlannerState): boolean =>
  state === 'not_measured' || state === 'retry_eligible';
const statePriority = (state: PrescreenPlannerState): number => (state === 'not_measured' ? 0 : 1);

const lifetimeFirstIds = (candidates: PrescreenCandidate[]): Set<number> => {
  const first = new Set<number>();
  const seen = new Set<string>();
  [...candidates]
    .sort((a, b) => (a.observedAt ?? '').localeCompare(b.observedAt ?? '') || a.id - b.id)
    .forEach((candidate) => {
      if (!candidate.tokenAddress || !candidate.signalType || !candidate.observedAt) return;
      const key = `${candidate.tokenAddress}:${candidate.signalType}`;
      if (!seen.has(key)) {
        seen.add(key);
        first.add(candidate.id);
      }
    });
  return first;
};

const selectCore = (
  candidates: PrescreenCandidate[],
  firstIds: Set<number>,
  budget: number,
): Set<number> => {
  const eligible = candidates.filter(
    (candidate) =>
      firstIds.has(candidate.id) &&
      isEligibleState(candidate.plannerState) &&
      validAddress(candidate.tokenAddress) &&
      candidate.signalType &&
      candidate.observedAt &&
      captureDate(candidate.capturedAt),
  );
  const byTypeDate = new Map<string, PrescreenCandidate[]>();
  for (const candidate of eligible) {
    const key = `${candidate.signalType ?? 'unknown'}:${captureDate(candidate.capturedAt) ?? 'unknown'}`;
    const bucket = byTypeDate.get(key) ?? [];
    bucket.push(candidate);
    byTypeDate.set(key, bucket);
  }
  const selected = new Set<number>();
  // One per type/date first: date-spread outranks adding more observations from a busy day.
  for (const bucket of [...byTypeDate.values()].sort(
    (a, b) =>
      (a[0].signalType ?? '').localeCompare(b[0].signalType ?? '') ||
      (a[0].capturedAt ?? '').localeCompare(b[0].capturedAt ?? ''),
  )) {
    if (selected.size >= budget) break;
    const first = bucket.sort(
      (a, b) =>
        statePriority(a.plannerState) - statePriority(b.plannerState) ||
        (a.observedAt ?? '').localeCompare(b.observedAt ?? '') ||
        a.id - b.id,
    )[0];
    if (first) selected.add(first.id);
  }
  // Then round-robin signal types, preserving the first-per-token/type research unit.
  const remaining = eligible
    .filter((candidate) => !selected.has(candidate.id))
    .sort(
      (a, b) =>
        statePriority(a.plannerState) - statePriority(b.plannerState) ||
        (a.signalType ?? '').localeCompare(b.signalType ?? '') ||
        (a.capturedAt ?? '').localeCompare(b.capturedAt ?? '') ||
        a.id - b.id,
    );
  for (const candidate of remaining) {
    if (selected.size >= budget) break;
    selected.add(candidate.id);
  }
  return selected;
};

/** Build the independent retry queue without bypassing the research-unit rules.
 * Retries are limited to valid lifetime-first token/type rows, then capped to the
 * same safe per-pass budget. Later repeats and malformed rows never reach Dune. */
export const selectRetryQueueIds = (
  candidates: PrescreenCandidate[],
  budget = Number.MAX_SAFE_INTEGER,
  now = new Date(),
): number[] => {
  const firstIds = lifetimeFirstIds(candidates);
  return candidates
    .filter((candidate) => {
      const observedMs = candidate.observedAt ? Date.parse(candidate.observedAt) : NaN;
      const mature = Number.isFinite(observedMs) && now.getTime() - observedMs >= MIN_SIGNAL_AGE_MS;
      return (
        firstIds.has(candidate.id) &&
        candidate.plannerState === 'retry_eligible' &&
        mature &&
        validAddress(candidate.tokenAddress) &&
        Boolean(candidate.signalType) &&
        Boolean(candidate.observedAt) &&
        Boolean(captureDate(candidate.capturedAt))
      );
    })
    .sort((a, b) => (a.observedAt ?? '').localeCompare(b.observedAt ?? '') || a.id - b.id)
    .slice(0, budget)
    .map((candidate) => candidate.id);
};

export const readPrescreenCandidates = (
  database: DatabaseSync,
  states: Map<number, PrescreenPlannerState>,
): PrescreenCandidate[] => {
  const rows = database
    .prepare(
      `
    SELECT g.id, g.token_address AS tokenAddress, g.signal_type AS signalType,
           g.observed_at AS observedAt, g.captured_at AS capturedAt,
           CASE WHEN t.token_address IS NULL THEN 0 ELSE 1 END AS cohortMatched
    FROM gmgn_signals g LEFT JOIN tokens t ON t.token_address = g.token_address
    ORDER BY g.id ASC
  `,
    )
    .all() as unknown as Array<{
    id: number;
    tokenAddress: string | null;
    signalType: string | null;
    observedAt: string | null;
    capturedAt: string;
    cohortMatched: number;
  }>;
  return rows.map((row) => ({
    ...row,
    cohortMatched: row.cohortMatched === 1,
    plannerState: states.get(row.id) ?? 'not_measured',
  }));
};

export const runPrescreen = (
  database: DatabaseSync,
  candidates: PrescreenCandidate[],
  now = new Date(),
): PrescreenSummary => {
  const firstIds = lifetimeFirstIds(candidates);
  const coreBudget = Math.floor(PRESCREEN_MAX_SIGNAL_IDS * (1 - PRESCREEN_AUDIT_FRACTION));
  const coreIds = selectCore(candidates, firstIds, coreBudget);
  const auditBudget = PRESCREEN_MAX_SIGNAL_IDS - coreIds.size;
  const auditPool = candidates
    .filter(
      (candidate) =>
        !coreIds.has(candidate.id) &&
        isEligibleState(candidate.plannerState) &&
        validAddress(candidate.tokenAddress) &&
        candidate.signalType &&
        candidate.observedAt,
    )
    .sort(
      (a, b) =>
        statePriority(a.plannerState) - statePriority(b.plannerState) ||
        stableRank(a.id).localeCompare(stableRank(b.id)) ||
        a.id - b.id,
    );
  const auditIds = new Set(auditPool.slice(0, auditBudget).map((candidate) => candidate.id));
  const decisions: PrescreenDecision[] = candidates.map((candidate) => {
    const date = captureDate(candidate.capturedAt);
    let disposition: PrescreenDisposition;
    let reason: string;
    if (
      !validAddress(candidate.tokenAddress) ||
      !candidate.signalType ||
      !candidate.observedAt ||
      !date
    ) {
      disposition = 'invalid_for_query';
      reason =
        'missing or invalid token address, signal type, UTC observation time, or capture date';
    } else if (candidate.plannerState === 'too_fresh') {
      disposition = 'too_fresh';
      reason = `signal is younger than the required ${MIN_SIGNAL_AGE_HOURS}-hour observation buffer; eligible_at: ${eligibleAtIso(candidate.observedAt) ?? 'unknown'}`;
    } else if (candidate.plannerState === 'in_flight') {
      disposition = 'already_measured';
      reason = 'Dune run is in flight or protected from duplicate retry';
    } else if (
      candidate.plannerState === 'complete' ||
      candidate.plannerState === 'pending_target_time' ||
      candidate.plannerState === 'retry_exhausted' ||
      candidate.plannerState === 'elapsed_but_unavailable'
    ) {
      disposition = 'already_measured';
      reason = `measurement planner state is ${candidate.plannerState}`;
    } else if (coreIds.has(candidate.id)) {
      disposition = 'eligible_core';
      reason = firstIds.has(candidate.id)
        ? 'lifetime-first token/type observation selected for core budget'
        : 'selected for core budget';
    } else if (auditIds.has(candidate.id)) {
      disposition = 'eligible_audit';
      reason = 'deterministic audit sample from a deferred stratum';
    } else if (!firstIds.has(candidate.id)) {
      disposition = 'deferred_repeat';
      reason = 'later observation for a token/type already represented by its lifetime-first row';
    } else {
      disposition = 'deferred_budget';
      reason = 'valid lifetime-first row outside the current Dune budget';
    }
    return {
      signalId: candidate.id,
      disposition,
      reason,
      signalType: candidate.signalType,
      captureDate: date,
      cohortMatched: candidate.cohortMatched,
      plannerState: candidate.plannerState,
    };
  });
  const byDisposition = emptyCounts();
  const byType = new Map<
    string,
    {
      captured: number;
      selected: number;
      core: number;
      audit: number;
      deferred: number;
      newSelected: number;
      retrySelected: number;
      tooFresh: number;
    }
  >();
  // Preparing once and wrapping every candidate's write in a single transaction, rather than
  // one auto-committing statement per candidate, is not a micro-optimization here: on a
  // production-scale candidate set (~11,700 signals) the per-statement auto-commit version
  // measured ~27s (reproduced directly, cold and warm/idempotent alike — the cost is the disk
  // sync per statement, not the decision logic); wrapped in one transaction, the same writes
  // measured ~50ms. This function runs synchronously on every /api/dune/measurement-plan
  // request, blocking Node's single-threaded event loop for every other in-flight request too.
  const insertDecision = database.prepare(
    `INSERT OR IGNORE INTO dune_measurement_prescreen (signal_id, rule_version, decision_key, disposition, reason, signal_type, capture_date, cohort_matched, planner_state, audit_seed, evaluated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  database.exec('BEGIN');
  try {
    for (const decision of decisions) {
      byDisposition[decision.disposition] += 1;
      const key = decision.signalType ?? 'unknown';
      const count = byType.get(key) ?? {
        captured: 0,
        selected: 0,
        core: 0,
        audit: 0,
        deferred: 0,
        newSelected: 0,
        retrySelected: 0,
        tooFresh: 0,
      };
      count.captured += 1;
      if (decision.disposition === 'eligible_core') {
        count.selected += 1;
        count.core += 1;
      }
      if (decision.disposition === 'eligible_audit') {
        count.selected += 1;
        count.audit += 1;
      }
      if (
        (decision.disposition === 'eligible_core' || decision.disposition === 'eligible_audit') &&
        decision.plannerState === 'not_measured'
      )
        count.newSelected += 1;
      if (
        (decision.disposition === 'eligible_core' || decision.disposition === 'eligible_audit') &&
        decision.plannerState === 'retry_eligible'
      )
        count.retrySelected += 1;
      if (decision.disposition === 'deferred_repeat' || decision.disposition === 'deferred_budget')
        count.deferred += 1;
      if (decision.disposition === 'too_fresh') count.tooFresh += 1;
      byType.set(key, count);
      const decisionKey = createHash('sha256')
        .update(
          `${PRESCREEN_RULE_VERSION}:${decision.signalId}:${decision.disposition}:${decision.plannerState}:${PRESCREEN_AUDIT_SEED}`,
          'utf8',
        )
        .digest('hex');
      insertDecision.run(
        decision.signalId,
        PRESCREEN_RULE_VERSION,
        decisionKey,
        decision.disposition,
        decision.reason,
        decision.signalType,
        decision.captureDate,
        decision.cohortMatched ? 1 : 0,
        decision.plannerState,
        PRESCREEN_AUDIT_SEED,
        now.toISOString(),
      );
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  const selectedDecisions = decisions.filter(
    (decision) =>
      decision.disposition === 'eligible_core' || decision.disposition === 'eligible_audit',
  );
  return {
    ruleVersion: PRESCREEN_RULE_VERSION,
    auditSeed: PRESCREEN_AUDIT_SEED,
    maxSignalIds: PRESCREEN_MAX_SIGNAL_IDS,
    auditFraction: PRESCREEN_AUDIT_FRACTION,
    minSignalAgeHours: MIN_SIGNAL_AGE_HOURS,
    selectedIds: [...coreIds, ...auditIds],
    selectedNewCount: selectedDecisions.filter(
      (decision) => decision.plannerState === 'not_measured',
    ).length,
    selectedRetryCount: selectedDecisions.filter(
      (decision) => decision.plannerState === 'retry_eligible',
    ).length,
    byDisposition,
    bySignalType: [...byType.entries()]
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([signalType, counts]) => ({ signalType, ...counts })),
    decisions,
  };
};
