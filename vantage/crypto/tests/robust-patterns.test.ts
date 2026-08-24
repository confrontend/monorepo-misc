import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/platform/db/client.js';
import { storeGmgnSignal } from '../src/gmgn/capture/ingest.js';
import { computeRobustPatternReport } from '../src/signals/robustPatterns.js';

const seedSignal = (
  database: ReturnType<typeof openDatabase>,
  id: string,
  signalType: number,
  token: string,
  observedAt: string,
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
        : `2026-03-01T00:00:00Z#${row.checkpoint}#${row.signal_id}`,
  }));
  // completed_at must be at or after every row's target_at, or isCheckpointPending (see
  // src/dune/outcomes.ts) treats that checkpoint as "not yet reached" and nulls it out. Fixed
  // fixtures in this file spread target_at across up to 10 synthetic days, so this is set safely
  // beyond all of them rather than a fixed near-term timestamp.
  database
    .prepare(
      `
    INSERT INTO dune_outcome_runs (signal_ids, query_sql, execution_id, status, raw_result, requested_at, completed_at)
    VALUES (?, 'select 1', 'exec-1', 'completed', ?, '2026-03-15T00:00:00Z', '2026-03-15T00:00:00Z')
  `,
    )
    .run(JSON.stringify(signalIds), JSON.stringify({ result: { rows: resultRows } }));
};

test('robust report excludes any group below the reliable-sample floor entirely', () => {
  const database = openDatabase(':memory:');
  try {
    const ids = Array.from({ length: 5 }, (_, i) =>
      seedSignal(database, `s${i}`, 7, `Token${i}`, '2026-03-01T00:00:00Z'),
    );
    insertCompletedRun(
      database,
      ids,
      ids.flatMap((id) => [
        { signal_id: id, checkpoint: 'signal', price_usd: 1, target_at: '2026-03-01T00:00:00Z' },
        { signal_id: id, checkpoint: '+1h', price_usd: 1.2, target_at: '2026-03-01T01:00:00Z' },
      ]),
    );
    const report = computeRobustPatternReport(database, new Date('2026-03-02T00:00:00Z'));
    assert.equal(
      report.groups.length,
      0,
      'only 5 fresh points exist, below the 10-sample floor — must not appear at all',
    );
  } finally {
    database.close();
  }
});

test('robust report computes a bootstrap CI, a sign-test p-value, and Holm correction for a group that clears the floor', () => {
  const database = openDatabase(':memory:');
  try {
    // 15 tokens, all up, spread across 3 distinct days, so both bootstrap and holdout have real
    // date-spread to work with.
    const ids: number[] = [];
    const rows: FixtureRow[] = [];
    for (let i = 0; i < 15; i++) {
      const day = 1 + (i % 3);
      const observedAt = `2026-03-0${day}T0${i % 9}:00:00Z`;
      const id = seedSignal(database, `w${i}`, 7, `Winner${i}`, observedAt);
      ids.push(id);
      rows.push({ signal_id: id, checkpoint: 'signal', price_usd: 1, target_at: observedAt });
      rows.push({
        signal_id: id,
        checkpoint: '+1h',
        price_usd: 1.1 + i * 0.01,
        target_at: observedAt,
      }); // consistently up
    }
    insertCompletedRun(database, ids, rows);
    const report = computeRobustPatternReport(database, new Date('2026-03-10T00:00:00Z'), {
      bootstrapIterations: 500,
    });
    const group = report.groups.find((g) => g.key === '7' && g.horizon === '+1h');
    assert.ok(group, 'a 15-token, consistently-positive group must appear');
    assert.equal(group.n, 15);
    assert.ok(group.medianReturnPct! > 0);
    assert.ok(
      group.bootstrap,
      'bootstrap CI must be present for a group at/above the sample floor',
    );
    assert.ok(
      group.bootstrap.lower <= group.bootstrap.median &&
        group.bootstrap.median <= group.bootstrap.upper,
      'CI must bracket the point estimate',
    );
    assert.ok(
      group.signTest.pValue < 0.05,
      'an all-positive 15-sample group should reject the zero-median null at the uncorrected level',
    );
    assert.ok(group.holmAdjustedPValue !== null);
    assert.equal(
      group.holmAdjustedPValue,
      group.signTest.pValue,
      'a single tested group is unaffected by Holm correction (m=1)',
    );
  } finally {
    database.close();
  }
});

test('robust report Holm-corrects across every group in the same run, not per-horizon in isolation', () => {
  const database = openDatabase(':memory:');
  try {
    // Two signal types: one borderline (p just under 0.05 alone), one overwhelming. Bundling them
    // into one Holm-corrected family should make the borderline one harder to call significant.
    const strongIds: number[] = [];
    const strongRows: FixtureRow[] = [];
    for (let i = 0; i < 20; i++) {
      const observedAt = `2026-03-0${1 + (i % 3)}T0${i % 9}:00:00Z`;
      const id = seedSignal(database, `strong${i}`, 6, `Strong${i}`, observedAt);
      strongIds.push(id);
      strongRows.push({ signal_id: id, checkpoint: 'signal', price_usd: 1, target_at: observedAt });
      strongRows.push({ signal_id: id, checkpoint: '+1h', price_usd: 1.5, target_at: observedAt }); // every single one strongly up
    }
    insertCompletedRun(database, strongIds, strongRows);

    const borderlineIds: number[] = [];
    const borderlineRows: FixtureRow[] = [];
    // 11 up, 9 down out of 20 — close to a coin flip, weakly positive.
    for (let i = 0; i < 20; i++) {
      const observedAt = `2026-03-0${1 + (i % 3)}T0${i % 9}:00:00Z`;
      const id = seedSignal(database, `border${i}`, 8, `Border${i}`, observedAt);
      borderlineIds.push(id);
      borderlineRows.push({
        signal_id: id,
        checkpoint: 'signal',
        price_usd: 1,
        target_at: observedAt,
      });
      borderlineRows.push({
        signal_id: id,
        checkpoint: '+1h',
        price_usd: i < 11 ? 1.05 : 0.95,
        target_at: observedAt,
      });
    }
    insertCompletedRun(database, borderlineIds, borderlineRows);

    const report = computeRobustPatternReport(database, new Date('2026-03-10T00:00:00Z'), {
      bootstrapIterations: 500,
    });
    const strong = report.groups.find((g) => g.key === '6' && g.horizon === '+1h')!;
    const borderline = report.groups.find((g) => g.key === '8' && g.horizon === '+1h')!;
    assert.ok(
      strong.holmAdjustedPValue! < borderline.holmAdjustedPValue!,
      'the overwhelming group should end up more significant than the coin-flip one after correction',
    );
    assert.equal(
      borderline.holmRejected,
      false,
      'an 11-vs-9 split must not survive as statistically significant',
    );
  } finally {
    database.close();
  }
});

test('robust report holdout: a pattern that holds in both halves reports both_positive', () => {
  const database = openDatabase(':memory:');
  try {
    const ids: number[] = [];
    const rows: FixtureRow[] = [];
    // 10 days, 5 tokens/day (50 total), all positive — with a 30% test fraction that's ~15 on
    // the test side and ~35 on the discovery side, comfortably clearing the 10-sample floor on
    // both halves so the "both sides agree" path actually gets exercised, not just attempted.
    for (let day = 1; day <= 10; day++) {
      for (let t = 0; t < 5; t++) {
        const observedAt = `2026-03-${String(day).padStart(2, '0')}T0${t}:00:00Z`;
        const id = seedSignal(database, `h${day}-${t}`, 9, `Holdout${day}-${t}`, observedAt);
        ids.push(id);
        rows.push({ signal_id: id, checkpoint: 'signal', price_usd: 1, target_at: observedAt });
        rows.push({ signal_id: id, checkpoint: '+1h', price_usd: 1.2, target_at: observedAt });
      }
    }
    insertCompletedRun(database, ids, rows);
    const report = computeRobustPatternReport(database, new Date('2026-03-20T00:00:00Z'), {
      bootstrapIterations: 300,
      holdoutTestFraction: 0.3,
    });
    const group = report.groups.find((g) => g.key === '9' && g.horizon === '+1h')!;
    assert.ok(group, 'group must exist');
    assert.ok(group.holdout.splitDate, 'with 10 distinct dates, a split date must be found');
    assert.equal(group.holdout.agreement, 'both_positive');
    assert.ok(
      group.holdout.discoveryN >= 10 && group.holdout.testN >= 10,
      'both sides must clear the reliability floor given 50 points spread over 10 days',
    );
  } finally {
    database.close();
  }
});

test('robust report excludes a group that lacks the canonical capture-date reliability gate', () => {
  const database = openDatabase(':memory:');
  try {
    const ids: number[] = [];
    const rows: FixtureRow[] = [];
    for (let i = 0; i < 12; i++) {
      const observedAt = `2026-03-01T0${i % 9}:00:00Z`; // all the same calendar day
      const id = seedSignal(database, `one${i}`, 12, `OneDay${i}`, observedAt);
      ids.push(id);
      rows.push({ signal_id: id, checkpoint: 'signal', price_usd: 1, target_at: observedAt });
      rows.push({ signal_id: id, checkpoint: '+1h', price_usd: 1.3, target_at: observedAt });
    }
    insertCompletedRun(database, ids, rows);
    const report = computeRobustPatternReport(database, new Date('2026-03-10T00:00:00Z'), {
      bootstrapIterations: 300,
    });
    const group = report.groups.find((g) => g.key === '12' && g.horizon === '+1h');
    assert.equal(group, undefined, 'a one-date group must not enter the inferential report');
  } finally {
    database.close();
  }
});

test('robust report keeps a missing first observation from being replaced by a later repeat', () => {
  // With only 2 signals total for the trap token, the resulting group would be absent from the
  // report (below the 10-sample floor) whether the fix is applied or not — that assertion alone
  // cannot distinguish correct from buggy behavior. This version bundles the trap token+type
  // pair alongside 10 clean, single-observation tokens spread across enough dates to clear every
  // reliability gate, so the trap's outlier return would visibly move `n` and the median if it
  // were wrongly included.
  const database = openDatabase(':memory:');
  try {
    const ids: number[] = [];
    const rows: FixtureRow[] = [];
    for (let i = 0; i < 10; i++) {
      const day = 1 + (i % 4);
      const observedAt = `2026-03-0${day}T0${i}:00:00Z`;
      const id = seedSignal(database, `clean${i}`, 7, `CleanToken${i}`, observedAt);
      ids.push(id);
      rows.push({ signal_id: id, checkpoint: 'signal', price_usd: 1, target_at: observedAt });
      rows.push({ signal_id: id, checkpoint: '+1h', price_usd: 1.01, target_at: observedAt }); // a small, consistent +1% return
    }
    // The trap: this token/type's chronologically-first observation (day 1, before any clean
    // token) has a missing +1h price; a later repeat of the SAME token/type (day 9) is fresh
    // with a huge +900% return that would be obvious if it leaked into the sample.
    const first = seedSignal(
      database,
      'trap-first-missing',
      7,
      'TrapToken',
      '2026-03-01T00:30:00Z',
    );
    const repeat = seedSignal(database, 'trap-later-fresh', 7, 'TrapToken', '2026-03-09T00:00:00Z');
    ids.push(first, repeat);
    rows.push({
      signal_id: first,
      checkpoint: 'signal',
      price_usd: 1,
      target_at: '2026-03-01T00:30:00Z',
    });
    rows.push({
      signal_id: first,
      checkpoint: '+1h',
      price_usd: null,
      target_at: '2026-03-01T00:30:00Z',
    });
    rows.push({
      signal_id: repeat,
      checkpoint: 'signal',
      price_usd: 1,
      target_at: '2026-03-09T00:00:00Z',
    });
    rows.push({
      signal_id: repeat,
      checkpoint: '+1h',
      price_usd: 10,
      target_at: '2026-03-09T00:00:00Z',
    }); // +900%, impossible to miss if leaked in

    insertCompletedRun(database, ids, rows);
    const report = computeRobustPatternReport(database, new Date('2026-03-15T00:00:00Z'), {
      bootstrapIterations: 300,
    });
    const group = report.groups.find((g) => g.key === '7' && g.horizon === '+1h');
    assert.ok(group, 'the 10 clean tokens alone must clear the reliability floor');
    assert.equal(
      group.n,
      10,
      'the trap token must contribute zero points — its first observation was missing, and a later repeat cannot substitute for it',
    );
    assert.ok(
      group.medianReturnPct! < 5,
      'a median near +1% (all 10 clean tokens) proves the +900% trap return never entered the sample',
    );
  } finally {
    database.close();
  }
});

test('robust report is reproducible: re-running against unchanged data yields identical bootstrap CIs', () => {
  const database = openDatabase(':memory:');
  try {
    const ids: number[] = [];
    const rows: FixtureRow[] = [];
    for (let i = 0; i < 12; i++) {
      const observedAt = `2026-03-0${1 + (i % 3)}T${String(i).padStart(2, '0')}:00:00Z`;
      const id = seedSignal(database, `r${i}`, 13, `Repro${i}`, observedAt);
      ids.push(id);
      rows.push({ signal_id: id, checkpoint: 'signal', price_usd: 1, target_at: observedAt });
      rows.push({
        signal_id: id,
        checkpoint: '+1h',
        price_usd: 1 + (i % 4) * 0.1 - 0.15,
        target_at: observedAt,
      });
    }
    insertCompletedRun(database, ids, rows);
    const a = computeRobustPatternReport(database, new Date('2026-03-10T00:00:00Z'), {
      bootstrapIterations: 400,
    });
    const b = computeRobustPatternReport(database, new Date('2026-03-10T00:00:00Z'), {
      bootstrapIterations: 400,
    });
    assert.deepEqual(
      a.groups.find((g) => g.key === '13')?.bootstrap,
      b.groups.find((g) => g.key === '13')?.bootstrap,
    );
  } finally {
    database.close();
  }
});
