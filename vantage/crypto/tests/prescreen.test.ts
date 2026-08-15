import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/db/client.js';
import { runPrescreen, selectRetryQueueIds, type PrescreenCandidate } from '../src/dune/prescreen.js';

const candidate = (id: number, token: string, type: string, observedAt: string, capturedAt = observedAt): PrescreenCandidate => ({ id, tokenAddress: token, signalType: type, observedAt, capturedAt, cohortMatched: false, plannerState: 'not_measured' });
const seedSignals = (database: ReturnType<typeof openDatabase>, candidates: PrescreenCandidate[]) => {
  const insert = database.prepare('INSERT INTO gmgn_signals (id, token_address, signal_type, observed_at, raw_payload, captured_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const row of candidates) insert.run(row.id, row.tokenAddress, row.signalType, row.observedAt, '{}', row.capturedAt);
};

test('pre-screen selects only the lifetime-first token/type observation and preserves later repeats as deferred', () => {
  const database = openDatabase(':memory:');
  try {
    const candidates = [
      candidate(1, 'TokenA', '7', '2026-08-01T01:00:00.000Z'),
      candidate(2, 'TokenA', '7', '2026-08-01T02:00:00.000Z'),
      candidate(3, 'TokenA', '7', '2026-08-01T03:00:00.000Z'),
      candidate(4, 'TokenB', '7', '2026-08-02T01:00:00.000Z'),
    ];
    seedSignals(database, candidates);
    const result = runPrescreen(database, candidates, new Date('2026-08-14T00:00:00.000Z'));
    assert.ok(result.selectedIds.includes(1));
    assert.ok(result.selectedIds.includes(4));
    assert.notEqual(result.decisions.find((row) => row.signalId === 2)?.disposition, 'eligible_core');
    assert.notEqual(result.decisions.find((row) => row.signalId === 3)?.disposition, 'eligible_core');
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM dune_measurement_prescreen').get() as { count: number }).count, 4);
  } finally { database.close(); }
});

test('pre-screen audit selection is deterministic and versioned', () => {
  const database = openDatabase(':memory:');
  try {
    const candidates = Array.from({ length: 20 }, (_, index) => candidate(index + 1, `Token${index + 1}`, String((index % 2) + 1), `2026-08-${String((index % 3) + 1).padStart(2, '0')}T01:00:00.000Z`));
    seedSignals(database, candidates);
    const first = runPrescreen(database, candidates, new Date('2026-08-14T00:00:00.000Z'));
    const second = runPrescreen(database, candidates, new Date('2026-08-14T00:00:00.000Z'));
    assert.deepEqual(second.selectedIds, first.selectedIds);
    assert.equal(first.ruleVersion, 'gmgn-dune-prescreen-v2');
    assert.equal(first.auditSeed, 'gmgn-dune-prescreen-v1-audit');
    assert.ok(first.byDisposition.eligible_audit >= 0);
    // Exact, not >=: a re-run with the same rule version/seed/planner state must produce the
    // same decision_key for every candidate, so INSERT OR IGNORE is a true no-op the second
    // time. A >= assertion here would still pass even if idempotency broke and a re-run started
    // duplicating rows.
    const third = runPrescreen(database, candidates, new Date('2026-08-14T00:00:00.000Z'));
    assert.deepEqual(third.selectedIds, first.selectedIds);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM dune_measurement_prescreen').get() as { count: number }).count, candidates.length);
  } finally { database.close(); }
});

test('pre-screen prioritizes never-measured rows before retries', () => {
  const database = openDatabase(':memory:');
  try {
    const newRows = Array.from({ length: 500 }, (_, index) => candidate(index + 1, `NewToken${index + 1}`, '7', `2026-08-${String((index % 10) + 1).padStart(2, '0')}T01:00:00.000Z`));
    const retryRows = Array.from({ length: 100 }, (_, index) => ({ ...candidate(index + 501, `RetryToken${index + 1}`, '7', `2026-08-${String((index % 10) + 1).padStart(2, '0')}T02:00:00.000Z`), plannerState: 'retry_eligible' as const }));
    const candidates = [...newRows, ...retryRows];
    seedSignals(database, candidates);
    const result = runPrescreen(database, candidates, new Date('2026-08-14T00:00:00.000Z'));
    assert.equal(result.selectedIds.length, 500);
    assert.equal(result.selectedNewCount, 500);
    assert.equal(result.selectedRetryCount, 0);
  } finally { database.close(); }
});

test('retry queue applies lifetime-first and required-field screening independently of new-row budget', () => {
  const candidates: PrescreenCandidate[] = [
    { ...candidate(1, 'RetryToken', '7', '2026-08-01T01:00:00.000Z'), plannerState: 'retry_eligible' },
    { ...candidate(2, 'RetryToken', '7', '2026-08-01T02:00:00.000Z'), plannerState: 'retry_eligible' },
    { ...candidate(3, 'Malformed', '', '2026-08-01T03:00:00.000Z'), plannerState: 'retry_eligible' },
    { ...candidate(4, 'FreshToken', '7', '2026-08-01T04:00:00.000Z'), plannerState: 'pending_target_time' },
    { ...candidate(5, 'OtherRetry', '8', '2026-08-02T01:00:00.000Z'), plannerState: 'retry_eligible' },
  ];
  assert.deepEqual(selectRetryQueueIds(candidates), [1, 5]);
});

test('too_fresh candidates are never selected and get an explicit audit reason with eligible_at', () => {
  const database = openDatabase(':memory:');
  try {
    const candidates: PrescreenCandidate[] = [
      { ...candidate(1, 'TooFreshToken', '7', '2026-08-13T12:00:00.000Z'), plannerState: 'too_fresh' },
    ];
    seedSignals(database, candidates);
    const result = runPrescreen(database, candidates, new Date('2026-08-14T00:00:00.000Z'));
    assert.ok(!result.selectedIds.includes(1), 'a too_fresh candidate must never be selected for Dune submission');
    const decision = result.decisions.find((row) => row.signalId === 1)!;
    assert.equal(decision.disposition, 'too_fresh');
    assert.match(decision.reason, /younger than the required 24-hour observation buffer/);
    assert.match(decision.reason, /eligible_at: 2026-08-14T12:00:00\.000Z/, 'eligible_at must be exactly observed_at + 24h');
    assert.equal(result.byDisposition.too_fresh, 1);
  } finally { database.close(); }
});

test('too_fresh candidates are excluded from the retry queue too, defensively (they can never actually reach retry_eligible in practice)', () => {
  const candidates: PrescreenCandidate[] = [
    { ...candidate(1, 'TooFreshToken', '7', '2026-08-13T12:00:00.000Z'), plannerState: 'too_fresh' },
  ];
  assert.deepEqual(selectRetryQueueIds(candidates), []);
});

test('retry queue re-checks the 24-hour age boundary even when planner state is stale', () => {
  const candidates: PrescreenCandidate[] = [
    { ...candidate(1, 'FreshRetry', '7', '2026-08-13T12:01:00.000Z'), plannerState: 'retry_eligible' },
    { ...candidate(2, 'MatureRetry', '7', '2026-08-13T00:00:00.000Z'), plannerState: 'retry_eligible' },
  ];
  assert.deepEqual(selectRetryQueueIds(candidates, Number.MAX_SAFE_INTEGER, new Date('2026-08-14T00:00:00.000Z')), [2]);
});
