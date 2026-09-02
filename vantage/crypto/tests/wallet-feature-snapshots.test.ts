import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/platform/db/client.js';
import {
  listWalletFeatureSnapshots,
  readDecisionCalibrationRun,
  updateDecisionCalibrationRunStatus,
  writeDecisionCalibrationRun,
  writeWalletFeatureSnapshot,
  type WriteWalletFeatureSnapshotInput,
} from '../src/copytrade/features/walletFeatureSnapshots.js';

const snapshotInput = (
  overrides: Partial<WriteWalletFeatureSnapshotInput> = {},
): WriteWalletFeatureSnapshotInput => ({
  walletAddress: 'wallet-a',
  chain: 'sol',
  asOfTimestamp: '2026-08-01T00:00:00.000Z',
  lookbackDays: null,
  triggerKind: 'calendar',
  featureEngineVersion: 'wallet-features-v1',
  sourceDataRevision: 7,
  coverageStartTimestamp: '2026-07-01T00:00:00.000Z',
  coverageEndTimestamp: '2026-07-31T23:59:59.000Z',
  quality: { complete: true, rowsExamined: 20 },
  features: { prior_wallet_trade_count: 20, prior_wallet_win_rate_percent: 60 },
  createdAt: '2026-08-01T00:01:00.000Z',
  ...overrides,
});

test('wallet feature snapshot schema exposes immutable identity and calibration relations', () => {
  const database = openDatabase(':memory:');
  try {
    const snapshotIndexes = database
      .prepare(`PRAGMA index_list('copytrade_wallet_feature_snapshots')`)
      .all() as Array<{ name: string; unique: number }>;
    assert.ok(
      snapshotIndexes.some(
        (index) =>
          index.name === 'idx_copytrade_wallet_feature_snapshots_identity' && index.unique === 1,
      ),
    );

    const calibrationForeignKeys = database
      .prepare(`PRAGMA foreign_key_list('copytrade_decision_calibration_wallets')`)
      .all() as Array<{ table: string }>;
    assert.deepEqual(
      new Set(calibrationForeignKeys.map((foreignKey) => foreignKey.table)),
      new Set(['copytrade_decision_calibration_runs', 'copytrade_wallet_feature_snapshots']),
    );
  } finally {
    database.close();
  }
});

test('wallet feature snapshots are idempotent and immutable for the full versioned identity', () => {
  const database = openDatabase(':memory:');
  try {
    const first = writeWalletFeatureSnapshot(database, snapshotInput());
    assert.equal(first.inserted, true);
    assert.deepEqual(first.snapshot.features, {
      prior_wallet_trade_count: 20,
      prior_wallet_win_rate_percent: 60,
    });

    const retry = writeWalletFeatureSnapshot(
      database,
      snapshotInput({
        quality: { complete: false },
        features: { prior_wallet_trade_count: 999 },
        createdAt: '2026-08-01T00:02:00.000Z',
      }),
    );
    assert.equal(retry.inserted, false);
    assert.equal(retry.snapshot.id, first.snapshot.id);
    assert.deepEqual(retry.snapshot.features, first.snapshot.features);
    assert.deepEqual(retry.snapshot.quality, first.snapshot.quality);
    assert.equal(retry.snapshot.createdAt, first.snapshot.createdAt);

    const revised = writeWalletFeatureSnapshot(
      database,
      snapshotInput({
        sourceDataRevision: 8,
        features: { prior_wallet_trade_count: 21 },
        createdAt: '2026-08-01T00:03:00.000Z',
      }),
    );
    assert.equal(revised.inserted, true);
    assert.notEqual(revised.snapshot.id, first.snapshot.id);

    const snapshots = listWalletFeatureSnapshots(database, 'wallet-a');
    assert.equal(snapshots.length, 2);
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.sourceDataRevision),
      [8, 7],
    );
  } finally {
    database.close();
  }
});

test('calibration run and wallet rows persist atomically with parsed JSON payloads', () => {
  const database = openDatabase(':memory:');
  try {
    const firstSnapshot = writeWalletFeatureSnapshot(
      database,
      snapshotInput({ lookbackDays: 30 }),
    ).snapshot;
    const secondSnapshot = writeWalletFeatureSnapshot(
      database,
      snapshotInput({
        walletAddress: 'wallet-b',
        lookbackDays: 30,
        features: { prior_wallet_trade_count: 8 },
      }),
    ).snapshot;

    const run = writeDecisionCalibrationRun(database, {
      featureEngineVersion: 'wallet-features-v1',
      decisionModelVersion: 'decision-v9',
      patternProfileKey: 'pattern-profile-1',
      snapshotStartTimestamp: '2026-08-01T00:00:00.000Z',
      snapshotEndTimestamp: '2026-08-01T00:00:00.000Z',
      outcomeHorizonDays: 30,
      methodology: { walletBalanced: true, cutoffExclusive: true },
      status: 'running',
      createdAt: '2026-08-02T00:00:00.000Z',
      wallets: [
        {
          snapshotId: firstSnapshot.id,
          walletAddress: 'wallet-a',
          scoreInputs: { edge: 72 },
          futureOutcome: { delayedCopyMedianReturn: 14.2 },
          eligibility: { eligible: true },
        },
        {
          snapshotId: secondSnapshot.id,
          walletAddress: 'wallet-b',
          scoreInputs: { edge: 51 },
          futureOutcome: null,
          eligibility: { eligible: false, reason: 'missing future evidence' },
        },
      ],
    });

    assert.equal(run.wallets.length, 2);
    assert.deepEqual(run.methodology, { walletBalanced: true, cutoffExclusive: true });
    assert.deepEqual(run.wallets[0].futureOutcome, { delayedCopyMedianReturn: 14.2 });
    assert.equal(run.wallets[1].futureOutcome, null);
    assert.deepEqual(readDecisionCalibrationRun(database, run.id), run);

    const completed = updateDecisionCalibrationRunStatus(
      database,
      run.id,
      'completed',
      '2026-09-02T00:00:00.000Z',
    );
    assert.equal(completed.status, 'completed');
    assert.equal(completed.completedAt, '2026-09-02T00:00:00.000Z');
    assert.equal(completed.wallets.length, 2);
  } finally {
    database.close();
  }
});

test('calibration persistence rolls back the run when any wallet snapshot is invalid', () => {
  const database = openDatabase(':memory:');
  try {
    const snapshot = writeWalletFeatureSnapshot(
      database,
      snapshotInput({ lookbackDays: 30 }),
    ).snapshot;

    assert.throws(
      () =>
        writeDecisionCalibrationRun(database, {
          featureEngineVersion: 'wallet-features-v1',
          decisionModelVersion: 'decision-v9',
          snapshotStartTimestamp: '2026-08-01T00:00:00.000Z',
          snapshotEndTimestamp: '2026-08-01T00:00:00.000Z',
          outcomeHorizonDays: 30,
          methodology: { walletBalanced: true },
          wallets: [
            {
              snapshotId: snapshot.id,
              walletAddress: 'wallet-a',
              scoreInputs: { edge: 72 },
              eligibility: { eligible: true },
            },
            {
              snapshotId: 999_999,
              walletAddress: 'wallet-missing',
              scoreInputs: {},
              eligibility: { eligible: false },
            },
          ],
        }),
      /snapshot 999999 does not exist/,
    );

    const runCount = database
      .prepare(`SELECT COUNT(*) AS count FROM copytrade_decision_calibration_runs`)
      .get() as { count: number };
    const walletCount = database
      .prepare(`SELECT COUNT(*) AS count FROM copytrade_decision_calibration_wallets`)
      .get() as { count: number };
    assert.equal(runCount.count, 0);
    assert.equal(walletCount.count, 0);
  } finally {
    database.close();
  }
});
