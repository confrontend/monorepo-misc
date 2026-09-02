import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWalletEvidenceSnapshot,
  createWalletEvidenceSnapshot,
} from '../src/copytrade/evidence/walletEvidenceSnapshot.js';
import { createHistoricalEvidenceContext } from '../src/copytrade/evidence/historicalEvidenceContext.js';

test('builds explicit activity, official GMGN, delayed-copy, and provenance namespaces', () => {
  const context = createHistoricalEvidenceContext({
    chain: 'SOL',
    asOf: '2026-08-30T00:00:00Z',
    periodDays: 60,
    sourceRevision: 7,
    completeness: { status: 'partial', rowsExamined: 4, rowsIncluded: 3, rowsExcluded: 1 },
  });
  const snapshot = buildWalletEvidenceSnapshot({
    walletAddress: ' wallet-a ',
    context,
    activity: {
      value: [{ eventType: 'buy' }],
      status: 'partial',
      sourceRevision: 8,
      completeness: { rowsExamined: 5, rowsIncluded: 4, rowsExcluded: 1 },
    },
    officialGmgn: { value: { period: '30d', tradeCount: 12 }, status: 'available' },
    delayedCopy: { value: [{ returnRatio: 0.2 }], status: 'available' },
    provenance: {
      generatedAt: '2026-08-30T00:01:00-07:00',
      activity: { source: 'copytrade_trades', exact: true, calculationVersion: 'activity-v2' },
      officialGmgn: { source: 'gmgn_stats', exact: true },
      delayedCopy: { source: 'dune', exact: false },
    },
  });

  assert.equal(snapshot.walletAddress, 'wallet-a');
  assert.equal(snapshot.context.chain, 'sol');
  assert.equal(snapshot.context.periodDays, 60);
  assert.equal(snapshot.activity.status, 'partial');
  assert.equal(snapshot.activity.sourceRevision, 8);
  assert.equal(snapshot.activity.completeness.rowsIncluded, 4);
  assert.deepEqual(snapshot.officialGmgn.value, { period: '30d', tradeCount: 12 });
  assert.equal(snapshot.delayedCopy.status, 'available');
  assert.equal(snapshot.provenance.contractVersion, 'wallet-evidence-snapshot-v1');
  assert.equal(snapshot.provenance.activity.source, 'copytrade_trades');
  assert.equal(snapshot.provenance.activity.exact, true);
  assert.equal(snapshot.provenance.officialGmgn.sourceRevision, 7);
  assert.equal(snapshot.provenance.generatedAt, '2026-08-30T07:01:00.000Z');
});

test('defaults absent namespaces to missing and carries context revision/completeness', () => {
  const snapshot = createWalletEvidenceSnapshot({
    walletAddress: 'wallet-empty',
    context: {
      chain: 'sol',
      asOfTimestamp: '2026-08-30T00:00:00Z',
      periodDays: 30,
      sourceRevision: 3,
      completeness: { status: 'unknown', reason: 'not fetched' },
    },
  });

  assert.equal(snapshot.activity.value, null);
  assert.equal(snapshot.activity.status, 'missing');
  assert.equal(snapshot.officialGmgn.status, 'missing');
  assert.equal(snapshot.delayedCopy.status, 'missing');
  assert.equal(snapshot.activity.sourceRevision, 3);
  assert.equal(snapshot.activity.completeness.status, 'unknown');
  assert.equal(snapshot.provenance.delayedCopy.source, 'unspecified');
});

test('does not allow an available or partial namespace without data', () => {
  const context = createHistoricalEvidenceContext({
    chain: 'sol',
    asOf: '2026-08-30T00:00:00Z',
    periodDays: 30,
  });
  assert.throws(
    () =>
      buildWalletEvidenceSnapshot({
        walletAddress: 'wallet-a',
        context,
        activity: { status: 'available' },
      }),
    /available evidence namespace must provide a value/,
  );
  assert.throws(
    () =>
      buildWalletEvidenceSnapshot({
        walletAddress: 'wallet-a',
        context,
        activity: { status: 'partial' },
      }),
    /partial evidence namespace must provide a value/,
  );
});
