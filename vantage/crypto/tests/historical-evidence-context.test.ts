import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createHistoricalEvidenceContext,
  isAvailableAtPointInTime,
  isBeforeExclusiveCutoff,
  isPointInTimeIncluded,
  isWithinHistoricalEvidenceWindow,
} from '../src/copytrade/evidence/historicalEvidenceContext.js';

test('normalizes the historical context and uses an exclusive cutoff', () => {
  const context = createHistoricalEvidenceContext({
    chain: ' SOL ',
    asOf: '2026-08-30T12:00:00-07:00',
    periodDays: 60,
    sourceRevision: 42,
    completeness: { status: 'complete', rowsExamined: 10, rowsIncluded: 9, rowsExcluded: 1 },
  });

  assert.equal(context.chain, 'sol');
  assert.equal(context.asOf, '2026-08-30T19:00:00.000Z');
  assert.equal(context.asOfTimestamp, context.asOf);
  assert.equal(context.windowStart, '2026-07-01T19:00:00.000Z');
  assert.equal(context.exclusiveCutoff, context.asOf);
  assert.equal(context.sourceRevision, 42);
  assert.deepEqual(context.completeness, {
    status: 'complete',
    rowsExamined: 10,
    rowsIncluded: 9,
    rowsExcluded: 1,
    coverageStart: null,
    coverageEnd: null,
    reason: null,
  });

  assert.equal(isPointInTimeIncluded('2026-07-01T19:00:00.000Z', context), true);
  assert.equal(isPointInTimeIncluded('2026-08-30T18:59:59.999Z', context), true);
  assert.equal(isPointInTimeIncluded(context.asOf, context), false);
  assert.equal(isPointInTimeIncluded('2026-07-01T18:59:59.999Z', context), false);
});

test('supports database-style asOfTimestamp and pre-cutoff context checks', () => {
  const context = createHistoricalEvidenceContext({
    chain: 'SoL',
    asOfTimestamp: Date.parse('2026-01-01T00:00:00.000Z'),
    periodDays: 30,
  });

  assert.equal(context.asOf, '2026-01-01T00:00:00.000Z');
  assert.equal(isBeforeExclusiveCutoff('2025-12-31T23:59:59.999Z', context), true);
  assert.equal(isBeforeExclusiveCutoff(context.asOf, context), false);
  assert.equal(isAvailableAtPointInTime('2025-01-01T00:00:00.000Z', context), true);
  assert.equal(isWithinHistoricalEvidenceWindow('2025-01-01T00:00:00.000Z', context), false);
});

test('rejects ambiguous or invalid context inputs', () => {
  assert.throws(
    () => createHistoricalEvidenceContext({ chain: 'sol', periodDays: 30 }),
    /Either asOf or asOfTimestamp is required/,
  );
  assert.throws(
    () =>
      createHistoricalEvidenceContext({
        chain: 'sol',
        asOf: '2026-01-01T00:00:00Z',
        asOfTimestamp: '2026-01-01T00:00:01Z',
        periodDays: 30,
      }),
    /same instant/,
  );
  assert.throws(
    () =>
      createHistoricalEvidenceContext({
        chain: 'sol',
        asOf: 'not-a-date',
        periodDays: 30,
      }),
    /valid date/,
  );
});
