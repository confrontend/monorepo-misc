import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/client.js';
import { applyMigrations } from '../src/db/schema.js';
import { storeWalletRankSnapshot } from '../src/gmgn/walletRank.js';
import {
  syncCopyTradeRoster, listRosterWallets,
  listLeaderboardSnapshotStatuses, readCaptureHealth, filterHashFor,
} from '../src/copytrade/roster.js';
import { storeActivityPage } from '../src/copytrade/fetch.js';
import { freezeExperiment, evaluateExperiment, listExperiments, EXPERIMENT_METHODOLOGY_VERSION, DEFAULT_EVALUATION_WINDOWS_DAYS } from '../src/copytrade/experiments.js';

const setup = (): DatabaseSync => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  return database;
};

const rankItem = (walletAddress: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  wallet_address: walletAddress, name: null, pnl_30d: '1', winrate_30d: '0.5', tags: [], ...over,
});

/** A fully provenanced snapshot: has both a gmgn_wallet_rank_snapshots row and a matching
 *  gmgn_wallet_rank_capture_provenance row, and its wallets are synced into copytrade_wallets
 *  so freezeExperiment has real rank rows to read. */
const seedProvenancedSnapshot = (
  database: DatabaseSync,
  wallets: string[],
  options: { capturedAt?: string; window?: string; orderby?: string; requestPath?: string } = {},
): number => {
  storeWalletRankSnapshot(database, {
    window: options.window ?? '30d', orderby: options.orderby ?? 'pnl_30d',
    capturedAt: options.capturedAt ?? '2026-08-01T00:00:00.000Z',
    requestPath: options.requestPath ?? '/api/v1/rank/sol/wallets/30d',
    requestQuery: { orderby: options.orderby ?? 'pnl_30d' },
    // A unique marker per call so distinct payloads never dedupe onto the same snapshot row
    // (storeWalletRankSnapshot dedupes by content hash) — otherwise two calls with different
    // captured_at but the same wallet list would collapse into one snapshot.
    rawPayload: { code: 0, data: { rank: wallets.map((address) => rankItem(address)) }, _marker: `${options.capturedAt ?? ''}-${Math.random()}` },
  });
  // MAX(id), not readLatestRankSnapshot (which orders by captured_at) — this test seeds
  // snapshots out of chronological order on purpose, and must reliably get the row it just
  // inserted regardless of where its captured_at falls relative to earlier ones.
  const snapshotId = (database.prepare('SELECT MAX(id) AS id FROM gmgn_wallet_rank_snapshots').get() as { id: number }).id;
  syncCopyTradeRoster(database);
  return snapshotId;
};

/** A legacy snapshot: no provenance row, mirroring the two real captures that predate the
 *  provenance feature (docs/COPYTRADE_PROSPECTIVE_VALIDATION_PLAN.md §1). */
const seedLegacySnapshot = (database: DatabaseSync, wallets: string[], capturedAt = '2026-07-01T00:00:00.000Z'): number => {
  database.prepare(
    `INSERT INTO gmgn_wallet_rank_snapshots (window, orderby, captured_at, raw_payload, source_sha256)
     VALUES ('30d', 'pnl_30d', ?, ?, ?)`,
  ).run(capturedAt, JSON.stringify({ code: 0, data: { rank: wallets.map((address) => rankItem(address)) } }), `legacy-${Math.random()}`);
  const snapshotId = (database.prepare('SELECT MAX(id) AS id FROM gmgn_wallet_rank_snapshots').get() as { id: number }).id;
  syncCopyTradeRoster(database);
  return snapshotId;
};

const insertSell = (database: DatabaseSync, wallet: string, txHash: string, timestamp: number, over: Record<string, unknown> = {}): void => {
  storeActivityPage(database, [{
    wallet, chain: 'sol', tx_hash: txHash, event_type: 'sell',
    token: { address: 'TOKEN_A', symbol: 'AAA' }, timestamp,
    token_amount: '100', cost_usd: '110', buy_cost_usd: '100', price_usd: '1.1',
    ...over,
  }], { chain: 'sol', fetchedAt: '2026-08-15T00:00:00.000Z' });
};

// --- roster.ts: provenance status + capture health ---------------------------------------

test('provenance: a snapshot with a matching provenance row is provenanced; one without is legacy_unprovenanced', () => {
  const database = setup();
  try {
    const provenancedId = seedProvenancedSnapshot(database, ['W1']);
    const legacyId = seedLegacySnapshot(database, ['W2']);
    const statuses = listLeaderboardSnapshotStatuses(database);
    const provenanced = statuses.find((s) => s.snapshotId === provenancedId)!;
    const legacy = statuses.find((s) => s.snapshotId === legacyId)!;
    assert.equal(provenanced.provenanceStatus, 'provenanced');
    assert.ok(provenanced.filterHash !== null);
    assert.equal(legacy.provenanceStatus, 'legacy_unprovenanced');
    assert.equal(legacy.filterHash, null, 'a legacy snapshot has no exact filter to hash');
  } finally { database.close(); }
});

test('provenance: filterHashFor changes when any component of the request context differs', () => {
  const base = { window: '30d', orderby: 'pnl_30d', requestPath: '/x', requestQuery: { a: 1 } };
  const same = filterHashFor({ ...base });
  const diffWindow = filterHashFor({ ...base, window: '7d' });
  const diffQuery = filterHashFor({ ...base, requestQuery: { a: 2 } });
  assert.equal(filterHashFor(base), same);
  assert.notEqual(filterHashFor(base), diffWindow);
  assert.notEqual(filterHashFor(base), diffQuery);
});

test('capture health: counts legacy and provenanced snapshots separately and only dates matching the latest filter', () => {
  const database = setup();
  try {
    seedLegacySnapshot(database, ['W1'], '2026-07-01T00:00:00.000Z');
    seedProvenancedSnapshot(database, ['W2'], { capturedAt: '2026-08-01T00:00:00.000Z', window: '30d' });
    seedProvenancedSnapshot(database, ['W2'], { capturedAt: '2026-08-02T00:00:00.000Z', window: '30d' });
    // A capture under a different filter must not count toward the same date-consistency total.
    seedProvenancedSnapshot(database, ['W2'], { capturedAt: '2026-08-03T00:00:00.000Z', window: '7d' });

    const health = readCaptureHealth(database, new Date('2026-08-03T06:00:00.000Z'));
    assert.equal(health.legacySnapshotCount, 1);
    assert.equal(health.provenancedSnapshotCount, 3);
    assert.equal(health.latestProvenanceStatus, 'provenanced');
    assert.equal(health.distinctCaptureDatesForLatestFilter, 1, 'the 8/3 capture used window=7d, a different filter than 8/1 and 8/2');
    assert.equal(health.hoursSinceLastCapture, 6);
  } finally { database.close(); }
});

test('capture health: an empty database reports zeros and nulls, not an error', () => {
  const database = setup();
  try {
    const health = readCaptureHealth(database, new Date('2026-08-15T00:00:00.000Z'));
    assert.deepEqual(health, {
      latestSnapshotAt: null, latestSnapshotId: null, latestProvenanceStatus: null, latestFilterHash: null,
      latestProvenancedSnapshotId: null, hoursSinceLastCapture: null, distinctCaptureDatesForLatestFilter: 0,
      legacySnapshotCount: 0, provenancedSnapshotCount: 0,
    });
  } finally { database.close(); }
});

// --- experiments.ts: freeze + evaluate -----------------------------------------------------

test('freeze: a legacy snapshot cannot be frozen', () => {
  const database = setup();
  try {
    const legacyId = seedLegacySnapshot(database, ['W1']);
    assert.throws(() => freezeExperiment(database, legacyId), /legacy_unprovenanced/);
  } finally { database.close(); }
});

test('freeze: duplicate freezes of the same snapshot are idempotent', () => {
  const database = setup();
  try {
    const snapshotId = seedProvenancedSnapshot(database, ['W1', 'W2']);
    const first = freezeExperiment(database, snapshotId, { now: new Date('2026-08-10T00:00:00.000Z') });
    const second = freezeExperiment(database, snapshotId, { now: new Date('2026-08-11T00:00:00.000Z') });
    assert.equal(first.created, true);
    assert.equal(second.created, false, 'a second freeze of the same snapshot must not create a new experiment');
    assert.equal(second.experimentId, first.experimentId);
    assert.equal(second.selectedAtUtc, first.selectedAtUtc, 'the original selection time must not shift on a later duplicate call');
    const count = (database.prepare('SELECT COUNT(*) AS c FROM copytrade_experiments').get() as { c: number }).c;
    assert.equal(count, 1);
  } finally { database.close(); }
});

test('freeze: assigns primary vs comparison group by rank, and rejects a snapshot with no synced roster', () => {
  const database = setup();
  try {
    const snapshotId = seedProvenancedSnapshot(database, ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7']);
    const result = freezeExperiment(database, snapshotId, { primaryTopN: 5, rosterTopN: 7 });
    assert.equal(result.walletCount, 7);
    const rows = database.prepare(
      `SELECT wallet_address AS walletAddress, rank_at_selection AS rank, selected_group AS selectedGroup
       FROM copytrade_experiment_wallets WHERE experiment_id = ? ORDER BY rank_at_selection ASC`,
    ).all(result.experimentId) as Array<{ walletAddress: string; rank: number; selectedGroup: string }>;
    assert.deepEqual(rows.map((r) => r.selectedGroup), ['primary', 'primary', 'primary', 'primary', 'primary', 'comparison', 'comparison']);

    const empty = seedProvenancedSnapshot(database, []);
    assert.throws(() => freezeExperiment(database, empty), /No synced roster wallets/);
  } finally { database.close(); }
});

test('freeze: a roster remains unchanged after a newer snapshot arrives for the same wallets', () => {
  const database = setup();
  try {
    const firstSnapshotId = seedProvenancedSnapshot(database, ['W1', 'W2'], { capturedAt: '2026-08-01T00:00:00.000Z' });
    const frozen = freezeExperiment(database, firstSnapshotId, { now: new Date('2026-08-01T00:00:00.000Z') });
    // A later capture reorders the same wallets (W2 now ranks first) — must never mutate the
    // already-frozen experiment, which locked in the original rank_at_selection values.
    seedProvenancedSnapshot(database, ['W2', 'W1'], { capturedAt: '2026-08-05T00:00:00.000Z' });

    const rows = (database.prepare(
      `SELECT wallet_address AS walletAddress, rank_at_selection AS rank FROM copytrade_experiment_wallets WHERE experiment_id = ? ORDER BY rank ASC`,
    ).all(frozen.experimentId) as Array<{ walletAddress: string; rank: number }>).map((row) => ({ walletAddress: row.walletAddress, rank: row.rank }));
    assert.deepEqual(rows, [{ walletAddress: 'W1', rank: 1 }, { walletAddress: 'W2', rank: 2 }], 'the frozen roster keeps its original ranks despite the newer snapshot');
  } finally { database.close(); }
});

test('evaluate: a pre-selection trade can never enter a forward result', () => {
  const database = setup();
  try {
    const snapshotId = seedProvenancedSnapshot(database, ['W1']);
    const selectedAt = new Date('2026-08-01T00:00:00.000Z');
    const frozen = freezeExperiment(database, snapshotId, { now: selectedAt, evaluationWindowsDays: [7] });
    const selectedAtSeconds = Math.floor(selectedAt.getTime() / 1000);

    // One trade before selection (must be excluded), enough trades after selection to mature.
    insertSell(database, 'W1', 'BEFORE', selectedAtSeconds - 3600, { cost_usd: '999999', buy_cost_usd: '1' });
    for (let i = 0; i < 10; i += 1) insertSell(database, 'W1', `AFTER-${i}`, selectedAtSeconds + 3600 + i);

    const report = evaluateExperiment(database, frozen.experimentId, new Date('2026-08-10T00:00:00.000Z'));
    const window = report.wallets[0].windows[0];
    assert.equal(window.state, 'matured');
    assert.equal(window.trades, 10, 'the pre-selection trade must never be counted, even though its huge fake profit would otherwise be obvious in the average');
  } finally { database.close(); }
});

test('evaluate: evaluation windows stay pending until their UTC end time, then become matured or insufficient_coverage', () => {
  const database = setup();
  try {
    const snapshotId = seedProvenancedSnapshot(database, ['W1']);
    const selectedAt = new Date('2026-08-01T00:00:00.000Z');
    const frozen = freezeExperiment(database, snapshotId, { now: selectedAt, evaluationWindowsDays: [7, 30] });
    const selectedAtSeconds = Math.floor(selectedAt.getTime() / 1000);
    for (let i = 0; i < 15; i += 1) insertSell(database, 'W1', `T-${i}`, selectedAtSeconds + 3600 + i);

    // Before the 7-day window ends: both windows pending.
    const early = evaluateExperiment(database, frozen.experimentId, new Date('2026-08-05T00:00:00.000Z'));
    assert.equal(early.wallets[0].windows[0].state, 'pending');
    assert.equal(early.wallets[0].windows[1].state, 'pending');

    // Past the 7-day window, before the 30-day window: 7d matured (15 trades, well above the
    // floor), 30d still pending.
    const mid = evaluateExperiment(database, frozen.experimentId, new Date('2026-08-09T00:00:00.000Z'));
    assert.equal(mid.wallets[0].windows[0].state, 'matured');
    assert.equal(mid.wallets[0].windows[0].trades, 15);
    assert.equal(mid.wallets[0].windows[1].state, 'pending');

    // Past both: 30d matured too (same 15 trades, no new ones added).
    const late = evaluateExperiment(database, frozen.experimentId, new Date('2026-09-05T00:00:00.000Z'));
    assert.equal(late.wallets[0].windows[1].state, 'matured');
  } finally { database.close(); }
});

test('evaluate: a matured window with too few post-selection trades reports insufficient_coverage, not a number', () => {
  const database = setup();
  try {
    const snapshotId = seedProvenancedSnapshot(database, ['W1']);
    const selectedAt = new Date('2026-08-01T00:00:00.000Z');
    const frozen = freezeExperiment(database, snapshotId, { now: selectedAt, evaluationWindowsDays: [7] });
    const selectedAtSeconds = Math.floor(selectedAt.getTime() / 1000);
    // Only 3 trades — under the MIN_MATURED_TRADES floor.
    for (let i = 0; i < 3; i += 1) insertSell(database, 'W1', `T-${i}`, selectedAtSeconds + 3600 + i);

    const report = evaluateExperiment(database, frozen.experimentId, new Date('2026-08-10T00:00:00.000Z'));
    const window = report.wallets[0].windows[0];
    assert.equal(window.state, 'insufficient_coverage');
    assert.equal(window.medianReturnPercent, null, 'insufficient coverage must never report a number that looks like a real result');
    assert.equal(window.trades, 3);
  } finally { database.close(); }
});

test('evaluate: results are reproducible from the saved snapshot, provenance, trades, and methodology version', () => {
  const database = setup();
  try {
    const snapshotId = seedProvenancedSnapshot(database, ['W1']);
    const selectedAt = new Date('2026-08-01T00:00:00.000Z');
    const frozen = freezeExperiment(database, snapshotId, { now: selectedAt, evaluationWindowsDays: [7] });
    const selectedAtSeconds = Math.floor(selectedAt.getTime() / 1000);
    for (let i = 0; i < 10; i += 1) insertSell(database, 'W1', `T-${i}`, selectedAtSeconds + 3600 + i);

    const first = evaluateExperiment(database, frozen.experimentId, new Date('2026-08-10T00:00:00.000Z'));
    const second = evaluateExperiment(database, frozen.experimentId, new Date('2026-08-10T00:00:00.000Z'));
    assert.deepEqual(first, second, 're-running the evaluator against the same stored data must reproduce byte-identical results');
    assert.equal(first.methodologyVersion, EXPERIMENT_METHODOLOGY_VERSION);
    assert.equal(first.selectedAtUtc, selectedAt.toISOString());
  } finally { database.close(); }
});

test('freeze: default forward-validation windows are 1, 7, and 30 days when none are specified', () => {
  const database = setup();
  try {
    const snapshotId = seedProvenancedSnapshot(database, ['W1']);
    const frozen = freezeExperiment(database, snapshotId);
    const report = evaluateExperiment(database, frozen.experimentId);
    assert.deepEqual(report.wallets[0].windows.map((w) => w.windowDays), DEFAULT_EVALUATION_WINDOWS_DAYS);
  } finally { database.close(); }
});

test('evaluate: legacy default 7/30/90 experiment reports the replacement 1/7/30 windows', () => {
  const database = setup();
  try {
    const snapshotId = seedProvenancedSnapshot(database, ['W1']);
    const frozen = freezeExperiment(database, snapshotId, {
      now: new Date('2026-08-01T00:00:00.000Z'),
      evaluationWindowsDays: [7, 30, 90],
    });
    const report = evaluateExperiment(database, frozen.experimentId, new Date('2026-08-03T00:00:00.000Z'));
    assert.deepEqual(report.wallets[0].windows.map((window) => window.windowDays), DEFAULT_EVALUATION_WINDOWS_DAYS);
  } finally { database.close(); }
});

test('evaluate: throws a clear error for an unknown experiment id', () => {
  const database = setup();
  try {
    assert.throws(() => evaluateExperiment(database, 999999), /No experiment found/);
  } finally { database.close(); }
});

// Sanity check that the roster/listRosterWallets import above is exercised, avoiding an unused import.
test('roster: listRosterWallets sees wallets synced from a provenanced snapshot', () => {
  const database = setup();
  try {
    seedProvenancedSnapshot(database, ['W1', 'W2']);
    assert.equal(listRosterWallets(database).length, 2);
  } finally { database.close(); }
});

// --- experiments.ts: listExperiments -------------------------------------------------------

test('listExperiments: newest first, with a maturity summary computed from wall-clock time alone', () => {
  const database = setup();
  try {
    const snapshotOld = seedProvenancedSnapshot(database, ['W1'], { capturedAt: '2026-08-01T00:00:00.000Z' });
    freezeExperiment(database, snapshotOld, { now: new Date('2026-08-01T00:00:00.000Z'), evaluationWindowsDays: [7, 30] });
    const snapshotNew = seedProvenancedSnapshot(database, ['W2'], { capturedAt: '2026-08-10T00:00:00.000Z' });
    freezeExperiment(database, snapshotNew, { now: new Date('2026-08-10T00:00:00.000Z'), evaluationWindowsDays: [7, 30] });

    // 12 days after the OLD experiment's selection: its 7d window matured, 30d still pending.
    // The NEW experiment is only 3 days old at this point: both windows pending.
    const list = listExperiments(database, new Date('2026-08-13T00:00:00.000Z'));
    assert.equal(list.length, 2);
    assert.equal(list[0].selectedAtUtc, '2026-08-10T00:00:00.000Z', 'newest experiment listed first');
    assert.deepEqual(list[0].maturedWindowsDays, []);
    assert.deepEqual(list[0].pendingWindowsDays, [7, 30]);
    assert.deepEqual(list[1].maturedWindowsDays, [7]);
    assert.deepEqual(list[1].pendingWindowsDays, [30]);
  } finally { database.close(); }
});

test('listExperiments: flags an experiment whose filter no longer matches the latest capture', () => {
  const database = setup();
  try {
    const snapshotA = seedProvenancedSnapshot(database, ['W1'], { capturedAt: '2026-08-01T00:00:00.000Z', window: '30d' });
    const frozen = freezeExperiment(database, snapshotA, { now: new Date('2026-08-01T00:00:00.000Z') });
    let list = listExperiments(database, new Date('2026-08-01T00:00:00.000Z'));
    assert.equal(list.find((e) => e.experimentId === frozen.experimentId)?.filterMatchesLatestCapture, true, 'matches while it is still the latest capture');

    // A newer capture under a different filter arrives; the old experiment's filter is now stale.
    seedProvenancedSnapshot(database, ['W2'], { capturedAt: '2026-08-05T00:00:00.000Z', window: '7d' });
    list = listExperiments(database, new Date('2026-08-05T00:00:00.000Z'));
    assert.equal(list.find((e) => e.experimentId === frozen.experimentId)?.filterMatchesLatestCapture, false);
  } finally { database.close(); }
});

test('listExperiments: an empty database returns an empty list, not an error', () => {
  const database = setup();
  try {
    assert.deepEqual(listExperiments(database), []);
  } finally { database.close(); }
});
