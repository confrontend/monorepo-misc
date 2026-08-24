import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/platform/db/client.js';
import { storeGmgnSignal } from '../src/gmgn/capture/ingest.js';
import {
  computeSignalPatternReport,
  listSignalPatternSnapshots,
  saveSignalPatternSnapshot,
} from '../src/signals/patterns.js';

const seedSignal = (
  database: ReturnType<typeof openDatabase>,
  id: string,
  signalType: number,
  token: string,
  observedAt = '2026-03-01T00:00:00Z',
): number =>
  storeGmgnSignal(
    database,
    {
      id,
      token_address: token,
      signal_type: signalType,
      observed_at: observedAt,
      market_cap: 1000,
    },
    { source: 'gmgn-cli', chain: 'sol', capturedAt: new Date(observedAt) },
  ).id;

type FixtureRow = {
  signal_id: number;
  checkpoint: string;
  price_usd: number | null;
  matched_trade_at?: string | null;
  target_at?: string;
};

// Defaults to a distinct matched-trade timestamp per checkpoint label (a genuine new trade at
// each checkpoint); pass an explicit matched_trade_at to simulate a stale/no-new-trade result.
const insertCompletedRun = (
  database: ReturnType<typeof openDatabase>,
  signalIds: number[],
  rows: FixtureRow[],
) => {
  const resultRows = rows.map((row) => ({
    signal_id: row.signal_id,
    checkpoint: row.checkpoint,
    target_at: row.target_at ?? '2026-03-01T00:00:00Z',
    price_usd: row.price_usd,
    matched_trade_at:
      row.matched_trade_at !== undefined
        ? row.matched_trade_at
        : `2026-03-01T00:00:00Z#${row.checkpoint}`,
  }));
  database
    .prepare(
      `
    INSERT INTO dune_outcome_runs (signal_ids, query_sql, execution_id, status, raw_result, requested_at, completed_at)
    VALUES (?, 'select 1', 'exec-1', 'completed', ?, '2026-03-15T00:00:00Z', '2026-03-15T00:00:05Z')
  `,
    )
    .run(JSON.stringify(signalIds), JSON.stringify({ result: { rows: resultRows } }));
};

test('pattern report defines "up" as return > 0 and excludes missing prices instead of treating them as 0', () => {
  const database = openDatabase(':memory:');
  try {
    const a1 = seedSignal(database, 'a1', 6, 'TokenA1');
    const a2 = seedSignal(database, 'a2', 6, 'TokenA2');
    const a3 = seedSignal(database, 'a3', 6, 'TokenA3');

    insertCompletedRun(
      database,
      [a1, a2, a3],
      [
        { signal_id: a1, checkpoint: 'signal', price_usd: 1 },
        { signal_id: a1, checkpoint: '+1h', price_usd: 1.5 }, // up: +50%
        { signal_id: a2, checkpoint: 'signal', price_usd: 1 },
        { signal_id: a2, checkpoint: '+1h', price_usd: 0.5 }, // down: -50%
        { signal_id: a3, checkpoint: 'signal', price_usd: 1 },
        // a3 has no +1h row at all -> must be excluded from the denominator, not counted as down
      ],
    );

    const report = computeSignalPatternReport(database, new Date('2026-03-01T02:00:00Z'));
    const horizon = report.horizons.find((h) => h.horizon === '+1h')!;
    const group = horizon.groups.find((g) => g.key === '6')!;

    assert.equal(group.n, 3);
    assert.equal(
      group.nWithData,
      2,
      'signal with a missing +1h price must not count toward n with data',
    );
    assert.equal(group.nMissing, 1);
    assert.equal(group.nStale, 0);
    assert.equal(group.nFresh, 2);
    assert.equal(group.upCount, 1);
    assert.equal(group.upPct, 50);
    assert.equal(
      group.reliable,
      false,
      'fewer than the minimum reliable sample must be flagged unreliable',
    );
  } finally {
    database.close();
  }
});

test('pattern report counts distinct tokens behind a group, not just signal instances, so a repeating token cannot inflate the apparent sample size unnoticed', () => {
  const database = openDatabase(':memory:');
  try {
    const a1 = seedSignal(database, 'a1', 12, 'TokenX'); // TokenX fires this signal type twice
    const a2 = seedSignal(database, 'a2', 12, 'TokenX');
    const a3 = seedSignal(database, 'a3', 12, 'TokenY');

    insertCompletedRun(
      database,
      [a1, a2, a3],
      [
        { signal_id: a1, checkpoint: 'signal', price_usd: 1 },
        { signal_id: a1, checkpoint: '+1h', price_usd: 1.1 },
        { signal_id: a2, checkpoint: 'signal', price_usd: 1 },
        { signal_id: a2, checkpoint: '+1h', price_usd: 1.2 },
        { signal_id: a3, checkpoint: 'signal', price_usd: 1 },
        { signal_id: a3, checkpoint: '+1h', price_usd: 0.9 },
      ],
    );

    const report = computeSignalPatternReport(database, new Date('2026-03-01T02:00:00Z'));
    const group = report.horizons
      .find((h) => h.horizon === '+1h')!
      .groups.find((g) => g.key === '12')!;
    assert.equal(group.nFresh, 2, 'first signal per token/type is the analysis unit');
    assert.equal(group.nDistinctTokens, 2, 'only two distinct tokens are analyzed');
    assert.equal(group.nRepeatedExcluded, 1);
  } finally {
    database.close();
  }
});

test('a checkpoint that reused the signal-time trade (no new trade occurred) is stale, not a genuine 0% result', () => {
  const database = openDatabase(':memory:');
  try {
    const a1 = seedSignal(database, 'a1', 9, 'TokenA1');
    const a2 = seedSignal(database, 'a2', 9, 'TokenA2');

    insertCompletedRun(
      database,
      [a1, a2],
      [
        // a1: no new trade before +1h -> same matched_trade_at as the signal checkpoint -> stale
        {
          signal_id: a1,
          checkpoint: 'signal',
          price_usd: 1,
          matched_trade_at: '2026-03-01T00:00:00Z',
        },
        {
          signal_id: a1,
          checkpoint: '+1h',
          target_at: '2026-03-01T00:00:01Z',
          price_usd: 1,
          matched_trade_at: '2026-03-01T00:00:00Z',
        },
        // a2: a genuine new trade at +1h that happens to be at the same price -> real, not stale
        {
          signal_id: a2,
          checkpoint: 'signal',
          price_usd: 1,
          matched_trade_at: '2026-03-01T00:00:00Z',
        },
        {
          signal_id: a2,
          checkpoint: '+1h',
          price_usd: 1,
          matched_trade_at: '2026-03-01T00:00:00Z#new-trade',
        },
      ],
    );

    const report = computeSignalPatternReport(database, new Date('2026-03-01T02:00:00Z'));
    const group = report.horizons
      .find((h) => h.horizon === '+1h')!
      .groups.find((g) => g.key === '9')!;

    assert.equal(group.n, 2);
    assert.equal(
      group.nWithData,
      2,
      'both signals have a price at each end, so neither is "missing"',
    );
    assert.equal(group.nStale, 1, 'the no-new-trade comparison must be counted as stale');
    assert.equal(
      group.nFresh,
      1,
      'only the genuine new-trade comparison counts toward the stats below',
    );
    assert.equal(group.upPct, 0, 'a flat genuine trade is not "up" (return must be strictly > 0)');
    assert.ok(
      report.staleNote.toLowerCase().includes('stale'),
      'report must explain what "stale" means',
    );
  } finally {
    database.close();
  }
});

test('trade-age cutoff excludes a checkpoint whose matched trade is too old for its horizon', () => {
  const database = openDatabase(':memory:');
  try {
    const id = seedSignal(database, 'age-cutoff', 7, 'TokenAgeCutoff');
    insertCompletedRun(
      database,
      [id],
      [
        {
          signal_id: id,
          checkpoint: 'signal',
          price_usd: 1,
          matched_trade_at: '2026-03-01T00:00:00Z',
        },
        // +1h permits at most 15 minutes of trade age; this is 30 minutes old.
        {
          signal_id: id,
          checkpoint: '+1h',
          target_at: '2026-03-01T01:00:00Z',
          price_usd: 1.2,
          matched_trade_at: '2026-03-01T00:30:00Z',
        },
      ],
    );
    const report = computeSignalPatternReport(database, new Date('2026-03-01T02:00:00Z'));
    const group = report.horizons
      .find((h) => h.horizon === '+1h')!
      .groups.find((g) => g.key === '7')!;
    assert.equal(group.nFresh, 0);
    assert.equal(group.nMissing, 1);
    assert.equal(group.coveragePct, 0);
  } finally {
    database.close();
  }
});

test('coverage and capture-date gates use the deduped first row, not repeated matured rows', () => {
  const database = openDatabase(':memory:');
  try {
    const first = seedSignal(database, 'dedupe-first', 12, 'TokenRepeat', '2026-03-01T00:00:00Z');
    const repeat = seedSignal(database, 'dedupe-repeat', 12, 'TokenRepeat', '2026-03-02T00:00:00Z');
    insertCompletedRun(
      database,
      [first, repeat],
      [
        { signal_id: first, checkpoint: 'signal', price_usd: 1 },
        { signal_id: first, checkpoint: '+1h', price_usd: 1.1 },
        { signal_id: repeat, checkpoint: 'signal', price_usd: 1 },
        { signal_id: repeat, checkpoint: '+1h', price_usd: 1.2 },
      ],
    );
    const report = computeSignalPatternReport(database, new Date('2026-03-03T00:00:00Z'));
    const group = report.horizons
      .find((h) => h.horizon === '+1h')!
      .groups.find((g) => g.key === '12')!;
    assert.equal(group.n, 1);
    assert.equal(group.nMatured, 1);
    assert.equal(group.nFresh, 1);
    assert.equal(group.coveragePct, 100);
    assert.equal(group.captureDates, 1);
    assert.equal(group.nRepeatedExcluded, 1);
  } finally {
    database.close();
  }
});

test('pattern report flags a group reliable only once it reaches the minimum sample size', () => {
  const database = openDatabase(':memory:');
  try {
    const ids: number[] = [];
    const rows: FixtureRow[] = [];
    for (let i = 0; i < 12; i += 1) {
      const id = seedSignal(
        database,
        `big-${i}`,
        7,
        `TokenBig${i}`,
        `2026-03-0${1 + (i % 3)}T00:00:00Z`,
      );
      ids.push(id);
      rows.push({ signal_id: id, checkpoint: 'signal', price_usd: 1 });
      rows.push({ signal_id: id, checkpoint: '+1h', price_usd: i < 8 ? 1.1 : 0.9 }); // 8 up, 4 down
    }
    insertCompletedRun(database, ids, rows);

    const report = computeSignalPatternReport(database, new Date('2026-03-01T02:00:00Z'));
    const group = report.horizons
      .find((h) => h.horizon === '+1h')!
      .groups.find((g) => g.key === '7')!;
    assert.equal(group.nFresh, 12);
    assert.equal(group.reliable, true);
    assert.ok(
      report.disclaimer.toLowerCase().includes('descriptive'),
      'report must carry a plain-language non-profitability disclaimer',
    );
  } finally {
    database.close();
  }
});

test('groups are ranked by median, not average, so a single outlier cannot fake the top spot', () => {
  const database = openDatabase(':memory:');
  try {
    // Group "outlier": one huge winner plus mostly losers -> big average, bad median.
    const outlierIds: number[] = [];
    const outlierRows: FixtureRow[] = [];
    for (let i = 0; i < 10; i += 1) {
      const id = seedSignal(database, `out-${i}`, 12, `TokenOut${i}`);
      outlierIds.push(id);
      outlierRows.push({ signal_id: id, checkpoint: 'signal', price_usd: 1 });
      outlierRows.push({ signal_id: id, checkpoint: '+1h', price_usd: i === 0 ? 50 : 0.6 }); // one +4900%, rest -40%
    }
    // Group "steady": consistently mildly positive, no outliers.
    const steadyIds: number[] = [];
    const steadyRows: FixtureRow[] = [];
    for (let i = 0; i < 10; i += 1) {
      const id = seedSignal(database, `steady-${i}`, 7, `TokenSteady${i}`);
      steadyIds.push(id);
      steadyRows.push({ signal_id: id, checkpoint: 'signal', price_usd: 1 });
      steadyRows.push({ signal_id: id, checkpoint: '+1h', price_usd: 1.05 }); // consistent +5%
    }
    insertCompletedRun(database, [...outlierIds, ...steadyIds], [...outlierRows, ...steadyRows]);

    const report = computeSignalPatternReport(database, new Date('2026-03-01T02:00:00Z'));
    const horizon = report.horizons.find((h) => h.horizon === '+1h')!;
    const outlierGroup = horizon.groups.find((g) => g.key === '12')!;
    const steadyGroup = horizon.groups.find((g) => g.key === '7')!;

    assert.ok(
      outlierGroup.avgReturnPct! > steadyGroup.avgReturnPct!,
      'the outlier group should have the higher average',
    );
    assert.ok(
      steadyGroup.medianReturnPct! > outlierGroup.medianReturnPct!,
      'the steady group should have the better (higher) median',
    );
    assert.equal(
      horizon.groups[0].key,
      '7',
      'ranking must put the group with the better median first, not the group with the higher average',
    );
  } finally {
    database.close();
  }
});

test('saving a snapshot freezes the exact params and source run ids used to compute it', () => {
  const database = openDatabase(':memory:');
  try {
    const a1 = seedSignal(database, 'a1', 6, 'TokenA1');
    insertCompletedRun(
      database,
      [a1],
      [
        { signal_id: a1, checkpoint: 'signal', price_usd: 1 },
        { signal_id: a1, checkpoint: '+1h', price_usd: 1.2 },
      ],
    );
    const report = computeSignalPatternReport(database, new Date('2026-03-01T02:00:00Z'));
    const saved = saveSignalPatternSnapshot(database, report);
    assert.equal(saved.sourceRunIds.length, 1);
    assert.deepEqual(saved.params, {
      groupBy: 'signalType',
      upThreshold: 0,
      minReliableSample: report.minReliableSample,
      minCoveragePct: 25,
      minCaptureDates: 3,
      analysisUnit: 'first-signal-per-token-type',
    });

    const listed = listSignalPatternSnapshots(database);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, saved.id);
    assert.deepEqual(listed[0].sourceRunIds, saved.sourceRunIds);
    assert.deepEqual(listed[0].report, report);
  } finally {
    database.close();
  }
});
