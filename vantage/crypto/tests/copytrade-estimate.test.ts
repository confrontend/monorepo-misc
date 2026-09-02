import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/platform/db/client.js';
import { applyMigrations } from '../src/platform/db/schema.js';
import { syncCopyTradeRoster } from '../src/copytrade/screening/roster.js';
import { storeActivityPage } from '../src/copytrade/screening/fetch.js';
import {
  DEFAULT_REQUESTS_PER_FRESH_WALLET,
  DEFAULT_SECONDS_PER_REQUEST,
  estimateRemainingSeconds,
  projectFetchDuration,
  readFetchEstimateBasis,
  recordFetchRunEstimate,
} from '../src/copytrade/screening/estimate.js';

const setup = (): DatabaseSync => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  return database;
};

const seedRankSnapshot = (database: DatabaseSync, rank: unknown[]): void => {
  database
    .prepare(
      `INSERT INTO gmgn_wallet_rank_snapshots (window, orderby, captured_at, raw_payload, source_sha256)
     VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      '7d',
      'pnl_30d',
      '2026-08-15T00:00:00.000Z',
      JSON.stringify({ code: 0, data: { rank } }),
      `sha-${Math.random()}`,
    );
};

const seedRoster = (database: DatabaseSync, wallets: string[]): void => {
  seedRankSnapshot(
    database,
    wallets.map((w) => ({ wallet_address: w, tags: [] })),
  );
  syncCopyTradeRoster(database);
};

/** Inserts a run row plus its coverage events, mirroring exactly what runCopyTradeFetch writes
 * for a completed run: one copytrade_fetch_runs row and one copytrade_wallet_coverage_events
 * row per wallet touched. */
const seedRun = (
  database: DatabaseSync,
  options: {
    status?: string;
    startedAt: string;
    completedAt: string | null;
    requestsMade: number;
    periodDays?: number;
    events: Array<{ stopReason: string; requestsUsed: number }>;
  },
): number => {
  database
    .prepare(
      `INSERT INTO copytrade_fetch_runs
       (started_at, completed_at, status, wallet_total, wallet_done, trades_fetched, requests_made, requested_period_days, trader_limit)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(
      options.startedAt,
      options.completedAt,
      options.status ?? 'completed',
      options.events.length,
      options.events.length,
      options.requestsMade,
      options.periodDays ?? 30,
      options.events.length,
    );
  const runId = Number(
    (database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id,
  );
  for (const [index, event] of options.events.entries()) {
    database
      .prepare(
        `INSERT INTO copytrade_wallet_coverage_events
         (run_id, wallet_address, chain, requested_period_days, requests_used, truncated, stop_reason, observed_at)
       VALUES (?, ?, 'sol', ?, ?, 0, ?, ?)`,
      )
      .run(
        runId,
        `W${index}`,
        options.periodDays ?? 30,
        event.requestsUsed,
        event.stopReason,
        options.completedAt ?? options.startedAt,
      );
  }
  return runId;
};

test('estimate: with no completed run yet, the basis is the seeded default', () => {
  const database = setup();
  try {
    const basis = readFetchEstimateBasis(database);
    assert.equal(basis.source, 'default');
    assert.equal(basis.runsCounted, 0);
    assert.equal(basis.secondsPerRequest, DEFAULT_SECONDS_PER_REQUEST);
    assert.equal(basis.requestsPerFreshWallet, DEFAULT_REQUESTS_PER_FRESH_WALLET);

    const projection = projectFetchDuration(database, { limit: 25, periodDays: 30 });
    assert.equal(projection.confidence, 'seeded');
    assert.equal(
      projection.freshWallets,
      25,
      'no roster captured yet, so every requested slot counts as fresh ground',
    );
    assert.ok(projection.estimatedSeconds > 0);
  } finally {
    database.close();
  }
});

test('estimate: folding in one completed run switches the basis to measured and matches the run exactly', () => {
  const database = setup();
  try {
    seedRun(database, {
      startedAt: '2026-08-15T00:00:00.000Z',
      completedAt: '2026-08-15T00:16:40.000Z', // 1000s
      requestsMade: 100,
      periodDays: 30,
      events: [
        { stopReason: 'window_covered', requestsUsed: 90 },
        { stopReason: 'up_to_date', requestsUsed: 10 },
      ],
    });
    const changed = recordFetchRunEstimate(database, 1);
    assert.equal(changed, true);

    const basis = readFetchEstimateBasis(database);
    assert.equal(basis.source, 'measured');
    assert.equal(basis.runsCounted, 1);
    assert.equal(basis.secondsPerRequest, 10, '1000s / 100 requests');
    assert.equal(
      basis.requestsPerFreshWallet,
      90,
      'the one non-up_to_date wallet used 90 requests',
    );
    assert.equal(basis.requestsPerCoveredWallet, 10, 'the one up_to_date wallet used 10 requests');
  } finally {
    database.close();
  }
});

test('estimate: folding in the same run twice is a no-op (idempotent by watermark)', () => {
  const database = setup();
  try {
    seedRun(database, {
      startedAt: '2026-08-15T00:00:00.000Z',
      completedAt: '2026-08-15T00:16:40.000Z',
      requestsMade: 100,
      events: [{ stopReason: 'window_covered', requestsUsed: 100 }],
    });
    assert.equal(recordFetchRunEstimate(database, 1), true);
    assert.equal(
      recordFetchRunEstimate(database, 1),
      false,
      'a run at or below the watermark must be ignored',
    );
    assert.equal(readFetchEstimateBasis(database).runsCounted, 1, 'runsCounted must not double');
  } finally {
    database.close();
  }
});

test('estimate: a cancelled or failed run is never folded in, even if requested directly', () => {
  const database = setup();
  try {
    seedRun(database, {
      status: 'cancelled',
      startedAt: '2026-08-15T00:00:00.000Z',
      completedAt: '2026-08-15T00:05:00.000Z',
      requestsMade: 300,
      events: [{ stopReason: 'cancelled', requestsUsed: 300 }],
    });
    seedRun(database, {
      status: 'failed',
      startedAt: '2026-08-15T01:00:00.000Z',
      completedAt: '2026-08-15T01:05:00.000Z',
      requestsMade: 300,
      events: [{ stopReason: 'request_cap', requestsUsed: 300 }],
    });
    assert.equal(recordFetchRunEstimate(database, 1), false, 'cancelled run must not fold in');
    assert.equal(recordFetchRunEstimate(database, 2), false, 'failed run must not fold in');
    assert.equal(
      readFetchEstimateBasis(database).source,
      'default',
      'basis must remain seeded — no completed run exists',
    );
  } finally {
    database.close();
  }
});

test('estimate: two completed runs accumulate additively, not by replacement', () => {
  const database = setup();
  try {
    seedRun(database, {
      startedAt: '2026-08-15T00:00:00.000Z',
      completedAt: '2026-08-15T00:10:00.000Z',
      requestsMade: 60,
      events: [{ stopReason: 'window_covered', requestsUsed: 60 }],
    }); // 600s / 60 req = 10 s/req
    recordFetchRunEstimate(database, 1);
    seedRun(database, {
      startedAt: '2026-08-15T02:00:00.000Z',
      completedAt: '2026-08-15T02:03:20.000Z',
      requestsMade: 40,
      events: [{ stopReason: 'window_covered', requestsUsed: 40 }],
    }); // 200s / 40 req = 5 s/req
    recordFetchRunEstimate(database, 2);

    const basis = readFetchEstimateBasis(database);
    assert.equal(basis.runsCounted, 2);
    // Pooled, not averaged-of-averages: (600+200) / (60+40) = 8, not (10+5)/2 = 7.5.
    assert.equal(basis.secondsPerRequest, 8);
  } finally {
    database.close();
  }
});

test('estimate: fresh vs covered wallet classification matches what the fetcher itself would do', () => {
  const database = setup();
  try {
    seedRoster(database, ['COVERED_WALLET', 'FRESH_WALLET']);
    // COVERED_WALLET already has a trade older than the 30-day cutoff — the fetcher would
    // see this as `up_to_date` (windowAlreadyCovered in fetch.ts) and only top up newest rows.
    const oldTs = Math.floor(Date.now() / 1000) - 40 * 86_400;
    storeActivityPage(
      database,
      [
        {
          wallet: 'COVERED_WALLET',
          chain: 'sol',
          tx_hash: 'TX1',
          event_type: 'sell',
          token: { address: 'TOKEN_A', symbol: 'AAA' },
          timestamp: oldTs,
          token_amount: '1',
          cost_usd: '1',
          buy_cost_usd: '1',
          price_usd: '1',
        },
      ],
      { chain: 'sol', fetchedAt: '2026-08-15T00:00:00.000Z' },
    );
    // FRESH_WALLET has no stored trades at all — nothing to page past.

    const projection = projectFetchDuration(database, { limit: 25, periodDays: 30 });
    assert.equal(projection.walletCount, 2);
    assert.equal(projection.coveredWallets, 1);
    assert.equal(projection.freshWallets, 1);
  } finally {
    database.close();
  }
});

test('estimate: explicit wallet addresses scope the projection to the selected wallets', () => {
  const database = setup();
  try {
    const now = new Date('2026-08-15T00:00:00.000Z');
    const oldTs = Math.floor(now.getTime() / 1000) - 40 * 86_400;
    storeActivityPage(
      database,
      [
        {
          wallet: 'COVERED_WALLET',
          chain: 'sol',
          tx_hash: 'TX1',
          event_type: 'sell',
          token: { address: 'TOKEN_A', symbol: 'AAA' },
          timestamp: oldTs,
          token_amount: '1',
          cost_usd: '1',
          buy_cost_usd: '1',
          price_usd: '1',
        },
      ],
      { chain: 'sol', fetchedAt: now.toISOString() },
    );

    const projection = projectFetchDuration(database, {
      limit: 1,
      periodDays: 30,
      now,
      walletAddresses: ['FRESH_WALLET', 'COVERED_WALLET'],
    });
    assert.equal(projection.walletCount, 2);
    assert.equal(projection.freshWallets, 1);
    assert.equal(projection.coveredWallets, 1);
  } finally {
    database.close();
  }
});

test('estimate: a longer requested period scales the fresh-wallet cost without a cap', () => {
  const database = setup();
  try {
    // Measured at 30 days: 15 requests/fresh wallet. Deliberately small enough that the 3x
    // Scaling is intentionally allowed to continue for long requested windows.
    seedRun(database, {
      startedAt: '2026-08-15T00:00:00.000Z',
      completedAt: '2026-08-15T00:01:00.000Z',
      requestsMade: 15,
      periodDays: 30,
      events: [{ stopReason: 'window_covered', requestsUsed: 15 }],
    });
    recordFetchRunEstimate(database, 1);

    const at30 = projectFetchDuration(database, { limit: 1, periodDays: 30 });
    const at90 = projectFetchDuration(database, { limit: 1, periodDays: 90 });
    assert.equal(at30.estimatedRequests, 15);
    assert.equal(at90.estimatedRequests, 45, '90/30 = 3x the measured rate');

    // Asserted against the constant, not a hardcoded number, so lowering the cap (as was done
    // when a 100-wallet run projected ~34 hours) can never leave this test silently checking a
    // ceiling the fetcher no longer enforces.
    const at9000 = projectFetchDuration(database, { limit: 1, periodDays: 9000 });
    assert.equal(at9000.estimatedRequests, 4500, '15 requests per 30 days scaled across 9000 days');
  } finally {
    database.close();
  }
});

test('estimate: confidence rises with the number of completed runs folded in', () => {
  const database = setup();
  try {
    assert.equal(projectFetchDuration(database, { limit: 5, periodDays: 30 }).confidence, 'seeded');
    for (let i = 0; i < 2; i += 1) {
      seedRun(database, {
        startedAt: `2026-08-15T0${i}:00:00.000Z`,
        completedAt: `2026-08-15T0${i}:01:00.000Z`,
        requestsMade: 10,
        events: [{ stopReason: 'window_covered', requestsUsed: 10 }],
      });
      recordFetchRunEstimate(database, i + 1);
    }
    assert.equal(projectFetchDuration(database, { limit: 5, periodDays: 30 }).confidence, 'low');
  } finally {
    database.close();
  }
});

test("estimate: remaining time for a live run prefers the run's own observed pace over the historical basis", () => {
  const database = setup();
  try {
    seedRun(database, {
      startedAt: '2026-08-15T00:00:00.000Z',
      completedAt: '2026-08-15T00:00:10.000Z',
      requestsMade: 1000,
      events: [{ stopReason: 'window_covered', requestsUsed: 1000 }],
    });
    recordFetchRunEstimate(database, 1); // historical: fast, 0.01 s/req

    // A live run that has been much slower than history so far (10 wallets done in 100s = 10s/wallet).
    const now = new Date('2026-08-15T01:01:40.000Z');
    const remaining = estimateRemainingSeconds(
      database,
      { startedAt: '2026-08-15T01:00:00.000Z', walletDone: 10, walletTotal: 15, periodDays: 30 },
      now,
    );
    assert.equal(
      remaining,
      50,
      '10s/wallet observed pace x 5 wallets remaining, not the historical rate',
    );
  } finally {
    database.close();
  }
});

test('estimate: remaining time falls back to the historical basis before any wallet has finished', () => {
  const database = setup();
  try {
    const now = new Date('2026-08-15T00:00:05.000Z');
    const remaining = estimateRemainingSeconds(
      database,
      { startedAt: '2026-08-15T00:00:00.000Z', walletDone: 0, walletTotal: 3, periodDays: 30 },
      now,
    );
    assert.ok(
      remaining !== null && remaining > 0,
      'must fall back to the seeded/measured basis, not null, before the first wallet completes',
    );
  } finally {
    database.close();
  }
});
