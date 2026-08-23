import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/platform/db/client.js';
import { storeGmgnSignal } from '../src/gmgn/capture/ingest.js';
import { computeSignalPatternSubgroupReport } from '../src/signals/patterns.js';

// Mirrors tests/patterns.test.ts's fixture pattern. Extends the raw event with the fields the
// subgroup extractor reads (trigger_at plus either the verbose `data.*` or abbreviated
// `cur_data.*` shape — both real shapes confirmed present in the live database).
const seedSignal = (
  database: ReturnType<typeof openDatabase>,
  id: string,
  signalType: number,
  token: string,
  extra: Record<string, unknown> = {},
  observedAt = '2026-03-01T00:00:00Z',
): number => storeGmgnSignal(
  database,
  { id, token_address: token, signal_type: signalType, observed_at: observedAt, market_cap: 1000, ...extra },
  { source: 'gmgn-cli', chain: 'sol', capturedAt: new Date(observedAt) },
).id;

type FixtureRow = { signal_id: number; checkpoint: string; price_usd: number | null; matched_trade_at?: string | null };

const insertCompletedRun = (database: ReturnType<typeof openDatabase>, signalIds: number[], rows: FixtureRow[]) => {
  const resultRows = rows.map((row) => ({
    signal_id: row.signal_id,
    checkpoint: row.checkpoint,
    target_at: '2026-03-01T00:00:00Z',
    price_usd: row.price_usd,
    matched_trade_at: row.matched_trade_at !== undefined ? row.matched_trade_at : `2026-03-01T00:00:00Z#${row.checkpoint}`,
  }));
  database.prepare(`
    INSERT INTO dune_outcome_runs (signal_ids, query_sql, execution_id, status, raw_result, requested_at, completed_at)
    VALUES (?, 'select 1', 'exec-1', 'completed', ?, '2026-03-15T00:00:00Z', '2026-03-15T00:00:05Z')
  `).run(JSON.stringify(signalIds), JSON.stringify({ result: { rows: resultRows } }));
};

const priceRows = (id: number, base: number, target: number): FixtureRow[] => [
  { signal_id: id, checkpoint: 'signal', price_usd: base },
  { signal_id: id, checkpoint: '+1h', price_usd: target },
];

test('launch platform resolves from either raw_payload shape (verbose data.launchpad or abbreviated cur_data.lp)', () => {
  const database = openDatabase(':memory:');
  try {
    const verbose = seedSignal(database, 'v1', 7, 'TokenV', { trigger_at: 1000, data: { launchpad: 'Pump.fun', created_timestamp: 0 } });
    const abbreviated = seedSignal(database, 'a1', 7, 'TokenA', { trigger_at: 1000, cur_data: { lp: 'meteora_virtual_curve', ct: 0 } });
    insertCompletedRun(database, [verbose, abbreviated], [...priceRows(verbose, 1, 1.1), ...priceRows(abbreviated, 1, 1.1)]);

    const report = computeSignalPatternSubgroupReport(database, 'launchPlatform', new Date('2026-03-01T02:00:00Z'));
    const horizon = report.horizons.find((h) => h.horizon === '+1h')!;
    assert.ok(horizon.groups.some((g) => g.key === '7::Pump.fun'), 'verbose data.launchpad shape must resolve');
    assert.ok(horizon.groups.some((g) => g.key === '7::meteora_virtual_curve'), 'abbreviated cur_data.lp shape must resolve');
    assert.equal(horizon.nUnextractable, 0);
  } finally { database.close(); }
});

test('a signal with no extractable launch platform is excluded from grouping and counted, not guessed', () => {
  const database = openDatabase(':memory:');
  try {
    const known = seedSignal(database, 'k1', 7, 'TokenK', { trigger_at: 1000, data: { launchpad: 'Pump.fun', created_timestamp: 0 } });
    const unknown = seedSignal(database, 'u1', 7, 'TokenU', { trigger_at: 1000 }); // no data/cur_data at all
    insertCompletedRun(database, [known, unknown], [...priceRows(known, 1, 1.1), ...priceRows(unknown, 1, 1.1)]);

    const report = computeSignalPatternSubgroupReport(database, 'launchPlatform', new Date('2026-03-01T02:00:00Z'));
    const horizon = report.horizons.find((h) => h.horizon === '+1h')!;
    assert.equal(horizon.nUnextractable, 1);
    const totalInGroups = horizon.groups.reduce((sum, g) => sum + g.n, 0);
    assert.equal(totalInGroups, 1, 'the unextractable signal must not appear in any group');
  } finally { database.close(); }
});

test('malformed raw_payload cannot crash extraction and is treated as unextractable', () => {
  const database = openDatabase(':memory:');
  try {
    const id = seedSignal(database, 'm1', 7, 'TokenM', { trigger_at: 1000, data: { launchpad: 'Pump.fun', created_timestamp: 0 } });
    insertCompletedRun(database, [id], priceRows(id, 1, 1.1));
    database.prepare('UPDATE gmgn_signals SET raw_payload = ? WHERE id = ?').run('not valid json{{{', id);

    const report = computeSignalPatternSubgroupReport(database, 'launchPlatform', new Date('2026-03-01T02:00:00Z'));
    const horizon = report.horizons.find((h) => h.horizon === '+1h')!;
    assert.equal(horizon.nUnextractable, 1);
    assert.equal(horizon.groups.length, 0);
  } finally { database.close(); }
});

test('token age buckets correctly, and a negative age (clock skew) is excluded rather than clipped into the youngest bucket', () => {
  const database = openDatabase(':memory:');
  try {
    const fresh = seedSignal(database, 'f1', 7, 'TokenF', { trigger_at: 1000, data: { created_timestamp: 1000 - 60 } }); // 1 minute old -> <1h
    const mid = seedSignal(database, 'm2', 7, 'TokenM2', { trigger_at: 100_000, data: { created_timestamp: 100_000 - 7200 } }); // 2h old -> 1-24h
    const days = seedSignal(database, 'd1', 7, 'TokenD', { trigger_at: 1_000_000, data: { created_timestamp: 1_000_000 - 200_000 } }); // ~2.3 days old -> 1-7d
    const weeks = seedSignal(database, 'w1', 7, 'TokenW', { trigger_at: 2_000_000, data: { created_timestamp: 2_000_000 - 15 * 86400 } }); // 15 days old -> 7-30d
    const old = seedSignal(database, 'o1', 7, 'TokenO', { trigger_at: 6_000_000, data: { created_timestamp: 6_000_000 - 60 * 86400 } }); // 60 days old -> >30d
    const skewed = seedSignal(database, 's1', 7, 'TokenS', { trigger_at: 1000, data: { created_timestamp: 5000 } }); // "created" after "triggered" -> invalid
    insertCompletedRun(database, [fresh, mid, days, weeks, old, skewed], [
      ...priceRows(fresh, 1, 1.1), ...priceRows(mid, 1, 1.1), ...priceRows(days, 1, 1.1), ...priceRows(weeks, 1, 1.1), ...priceRows(old, 1, 1.1), ...priceRows(skewed, 1, 1.1),
    ]);

    const report = computeSignalPatternSubgroupReport(database, 'tokenAge', new Date('2026-03-01T02:00:00Z'));
    const horizon = report.horizons.find((h) => h.horizon === '+1h')!;
    assert.ok(horizon.groups.some((g) => g.key === '7::<1h'));
    assert.ok(horizon.groups.some((g) => g.key === '7::1-24h'));
    assert.ok(horizon.groups.some((g) => g.key === '7::1-7d'), 'a token a few days old must land in 1-7d, not a single catch-all ">24h" bucket');
    assert.ok(horizon.groups.some((g) => g.key === '7::7-30d'));
    assert.ok(horizon.groups.some((g) => g.key === '7::>30d'));
    assert.equal(horizon.nUnextractable, 1, 'the negative-age signal must be excluded, not bucketed as <1h');
  } finally { database.close(); }
});

test('cellCount matches the number of distinct signalType::bucket combinations that actually have data', () => {
  const database = openDatabase(':memory:');
  try {
    const a = seedSignal(database, 'c1', 7, 'TokenC1', { trigger_at: 1000, data: { launchpad: 'Pump.fun', created_timestamp: 0 } });
    const b = seedSignal(database, 'c2', 7, 'TokenC2', { trigger_at: 1000, data: { launchpad: 'Pump.fun', created_timestamp: 0 } }); // same cell as a
    const c = seedSignal(database, 'c3', 12, 'TokenC3', { trigger_at: 1000, data: { launchpad: 'meteora_virtual_curve', created_timestamp: 0 } }); // distinct cell
    insertCompletedRun(database, [a, b, c], [...priceRows(a, 1, 1.1), ...priceRows(b, 1, 1.2), ...priceRows(c, 1, 0.9)]);

    const report = computeSignalPatternSubgroupReport(database, 'launchPlatform', new Date('2026-03-01T02:00:00Z'));
    const horizon = report.horizons.find((h) => h.horizon === '+1h')!;
    assert.equal(horizon.cellCount, 2, 'two signals sharing a cell must not inflate the cell count');
    assert.equal(horizon.groups.length, horizon.cellCount);
  } finally { database.close(); }
});

test('a subgroup cell reuses the same reliability/verdict logic as the top-level report (small sample stays unreliable)', () => {
  const database = openDatabase(':memory:');
  try {
    const id = seedSignal(database, 'r1', 7, 'TokenR', { trigger_at: 1000, data: { launchpad: 'Pump.fun', created_timestamp: 0 } });
    insertCompletedRun(database, [id], priceRows(id, 1, 1.5));

    const report = computeSignalPatternSubgroupReport(database, 'launchPlatform', new Date('2026-03-01T02:00:00Z'));
    const horizon = report.horizons.find((h) => h.horizon === '+1h')!;
    const cell = horizon.groups.find((g) => g.key === '7::Pump.fun')!;
    assert.equal(cell.nFresh, 1);
    assert.equal(cell.reliable, false, 'one observation must not be reliable, same gate as the top-level report');
    assert.equal(cell.verdict, 'insufficient data');
  } finally { database.close(); }
});

test('"combined" joins both properties into one bucket, and requires both to resolve', () => {
  const database = openDatabase(':memory:');
  try {
    const both = seedSignal(database, 'b1', 7, 'TokenB', { trigger_at: 1000, data: { launchpad: 'Pump.fun', created_timestamp: 1000 - 60 } }); // <1h
    const onlyPlatform = seedSignal(database, 'p1', 7, 'TokenP', { trigger_at: 1000, data: { launchpad: 'Pump.fun' } }); // no created_timestamp -> age missing
    const onlyAge = seedSignal(database, 'a1', 7, 'TokenA', { trigger_at: 1000, data: { created_timestamp: 1000 - 60 } }); // no launchpad -> platform missing
    insertCompletedRun(database, [both, onlyPlatform, onlyAge], [
      ...priceRows(both, 1, 1.1), ...priceRows(onlyPlatform, 1, 1.1), ...priceRows(onlyAge, 1, 1.1),
    ]);

    const report = computeSignalPatternSubgroupReport(database, 'combined', new Date('2026-03-01T02:00:00Z'));
    const horizon = report.horizons.find((h) => h.horizon === '+1h')!;
    assert.ok(horizon.groups.some((g) => g.key === '7::Pump.fun / <1h'), 'both properties resolved -> a combined cell must exist');
    assert.equal(horizon.nUnextractable, 2, 'a signal missing either property must be excluded, not partially bucketed');
  } finally { database.close(); }
});
