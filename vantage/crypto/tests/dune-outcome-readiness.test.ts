import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/platform/db/client.js';
import { applyMigrations } from '../src/platform/db/schema.js';
import { readDuneOutcomeReadiness } from '../src/copytrade/discovery/duneOutcomeReadiness.js';

// This is the direct regression coverage for the bug where the Data-tab summary banner said
// "Dune outcomes: ready" while Pattern Discovery's real report found zero rows for the same
// period -- readDuneOutcomeReadiness must reuse the same period-scoped, round-trip-based
// computation Pattern Discovery's report is built from, not a looser "any match, any time" check.

const DAY = 86_400;
const NOW = new Date('2026-08-30T12:00:00.000Z');
const NOW_ISO = NOW.toISOString();
const DELAY_SECONDS = 15; // DEFAULT_COPIER_DELAY_SECONDS

const setup = (): DatabaseSync => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  return database;
};

let nextTradeId = 1;

const insertTrade = (
  database: DatabaseSync,
  wallet: string,
  eventType: 'buy' | 'sell',
  tokenAddress: string,
  observedTimestamp: number,
): number => {
  const id = nextTradeId;
  nextTradeId += 1;
  database
    .prepare(
      `INSERT INTO copytrade_trades
       (id, wallet_address, chain, tx_hash, event_type, token_address, observed_timestamp,
        raw_payload, fetched_at, dedup_key)
       VALUES (?, ?, 'sol', ?, ?, ?, ?, '{}', ?, ?)`,
    )
    .run(id, wallet, `TX${id}`, eventType, tokenAddress, observedTimestamp, NOW_ISO, `DEDUP${id}`);
  return id;
};

/** Seeds one complete, Dune-matched round trip: a buy and a paired sell for the same
 *  wallet/token, each with a usable Dune match (matched_trade_at within the gap tolerance of
 *  the trade's own delayed target, matched_price_usd set so a return can be computed). */
const seedMatchedRoundTrip = (
  database: DatabaseSync,
  wallet: string,
  tokenAddress: string,
  buyTimestamp: number,
  sellTimestamp: number,
): void => {
  const buyId = insertTrade(database, wallet, 'buy', tokenAddress, buyTimestamp);
  const sellId = insertTrade(database, wallet, 'sell', tokenAddress, sellTimestamp);
  database
    .prepare(
      `INSERT INTO copytrade_copy_simulation_runs (trade_refs, query_sql, status, requested_at, completed_at)
       VALUES (?, '', 'completed', ?, ?)`,
    )
    .run(JSON.stringify([buyId, sellId]), NOW_ISO, NOW_ISO);
  const runId = Number(
    (database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id,
  );
  const insertMatch = database.prepare(
    `INSERT INTO copytrade_copy_simulation_matches
     (run_id, trade_id, matched_trade_at, matched_price_usd, status, match_source, completed_at)
     VALUES (?, ?, ?, ?, 'matched', 'precise', ?)`,
  );
  insertMatch.run(
    runId,
    buyId,
    new Date((buyTimestamp + DELAY_SECONDS) * 1000).toISOString(),
    1,
    NOW_ISO,
  );
  insertMatch.run(
    runId,
    sellId,
    new Date((sellTimestamp + DELAY_SECONDS) * 1000).toISOString(),
    1.1,
    NOW_ISO,
  );
};

/** Seeds an unpaired buy with no sell -- never a usable round trip, regardless of any Dune
 *  match, since coverageRatePercent needs a paired trip to exist at all. */
const seedUnpairedBuy = (
  database: DatabaseSync,
  wallet: string,
  tokenAddress: string,
  buyTimestamp: number,
): void => {
  insertTrade(database, wallet, 'buy', tokenAddress, buyTimestamp);
};

/** A genuine, paired round trip that was never queried against Dune at all -- counts toward
 *  roundTripsConsidered but not toward the simulated (matched) count, lowering coverageRatePercent
 *  without needing a second wallet. */
const seedUnmatchedRoundTrip = (
  database: DatabaseSync,
  wallet: string,
  tokenAddress: string,
  buyTimestamp: number,
  sellTimestamp: number,
): void => {
  insertTrade(database, wallet, 'buy', tokenAddress, buyTimestamp);
  insertTrade(database, wallet, 'sell', tokenAddress, sellTimestamp);
};

const now = Math.floor(NOW.getTime() / 1000);

test('zero roster wallets: not available, no query performed', () => {
  const database = setup();
  try {
    const readiness = readDuneOutcomeReadiness(database, { walletAddresses: [], periodDays: 30 });
    assert.equal(readiness.available, false);
    assert.equal(readiness.totalWallets, 0);
    assert.equal(readiness.coveredWallets, 0);
    assert.equal(readiness.reason, 'No roster wallets.');
  } finally {
    database.close();
  }
});

test('a matched round trip outside the requested period does not count -- the exact reported bug', () => {
  const database = setup();
  try {
    // Round trip's sell happened 120 days ago; requesting 30-day readiness must not see it.
    seedMatchedRoundTrip(database, 'WALLET', 'TOKEN', now - 121 * DAY, now - 120 * DAY);
    const readiness = readDuneOutcomeReadiness(database, {
      walletAddresses: ['WALLET'],
      periodDays: 30,
    });
    assert.equal(readiness.available, false);
    assert.equal(readiness.coveredWallets, 0);
    assert.match(readiness.reason ?? '', /No wallet has usable Dune outcome coverage/);
  } finally {
    database.close();
  }
});

test('the same evidence IS available once the requested period actually covers it', () => {
  const database = setup();
  try {
    seedMatchedRoundTrip(database, 'WALLET', 'TOKEN', now - 121 * DAY, now - 120 * DAY);
    const readiness = readDuneOutcomeReadiness(database, {
      walletAddresses: ['WALLET'],
      periodDays: 150,
    });
    assert.equal(readiness.available, true);
    assert.equal(readiness.coveredWallets, 1);
    assert.equal(readiness.targetCount, 2);
    assert.equal(readiness.matchedTargetCount, 2);
    assert.equal(readiness.noMatchTargetCount, 0);
  } finally {
    database.close();
  }
});

test('a wallet with no round trips at all (unpaired buy only) is not covered', () => {
  const database = setup();
  try {
    seedUnpairedBuy(database, 'WALLET', 'TOKEN', now - 5 * DAY);
    const readiness = readDuneOutcomeReadiness(database, {
      walletAddresses: ['WALLET'],
      periodDays: 30,
    });
    assert.equal(readiness.available, false);
    assert.equal(readiness.coveredWallets, 0);
  } finally {
    database.close();
  }
});

test('coverage is measured per wallet against minimumCoveragePercent, defaulting to 50', () => {
  const database = setup();
  try {
    // WALLET_A: one round trip, fully matched -> 100% coverage rate, clears any threshold.
    seedMatchedRoundTrip(database, 'WALLET_A', 'TOKEN_A', now - 10 * DAY, now - 9 * DAY);
    // WALLET_B: one round trip with no Dune match at all -> 0% coverage rate.
    seedUnpairedBuy(database, 'WALLET_B', 'TOKEN_B', now - 10 * DAY);

    const readiness = readDuneOutcomeReadiness(database, {
      walletAddresses: ['WALLET_A', 'WALLET_B'],
      periodDays: 30,
    });
    assert.equal(readiness.totalWallets, 2);
    assert.equal(readiness.coveredWallets, 1);
    assert.equal(readiness.excludedWallets, 1);
    assert.equal(readiness.available, true);
    assert.equal(readiness.minimumCoveragePercent, 50);
  } finally {
    database.close();
  }
});

test('a stricter minimumCoveragePercent can turn an available roster into an unavailable one', () => {
  const database = setup();
  try {
    seedMatchedRoundTrip(database, 'WALLET', 'TOKEN', now - 10 * DAY, now - 9 * DAY);
    const permissive = readDuneOutcomeReadiness(database, {
      walletAddresses: ['WALLET'],
      periodDays: 30,
      minimumCoveragePercent: 50,
    });
    assert.equal(permissive.available, true);

    // 100% coverage rate clears a 100% bar for a single fully-matched round trip, so add a
    // second, genuinely paired round trip with no Dune match to bring the rate to 50%.
    seedUnmatchedRoundTrip(database, 'WALLET', 'TOKEN_2', now - 8 * DAY, now - 7 * DAY);
    const strict = readDuneOutcomeReadiness(database, {
      walletAddresses: ['WALLET'],
      periodDays: 30,
      minimumCoveragePercent: 100,
    });
    assert.equal(strict.available, false);
    assert.equal(strict.coveredWallets, 0);
  } finally {
    database.close();
  }
});

test('the result is cached behind the data-fingerprint, not recomputed on every unchanged poll', () => {
  const database = setup();
  try {
    seedMatchedRoundTrip(database, 'WALLET', 'TOKEN', now - 10 * DAY, now - 9 * DAY);
    const first = readDuneOutcomeReadiness(database, {
      walletAddresses: ['WALLET'],
      periodDays: 30,
    });
    assert.equal(first.available, true);
    assert.equal(first.coveredWallets, 1);

    const cachedRow = database
      .prepare(
        `SELECT cache_key AS cacheKey FROM copytrade_report_cache WHERE cache_key LIKE 'duneOutcomeReadiness:%'`,
      )
      .get() as { cacheKey: string } | undefined;
    assert.ok(cachedRow, 'a cache row must exist after the first computation');

    // Corrupt the cached value directly -- if a second call at the identical fingerprint honors
    // the cache (the fix's whole point), it must return this corrupted value verbatim instead of
    // recomputing the true answer. If caching were not actually happening, this assertion would
    // fail because the real computation would silently overwrite the corruption.
    database.prepare(`UPDATE copytrade_report_cache SET report_json = ? WHERE cache_key = ?`).run(
      JSON.stringify({
        available: false,
        coveredWallets: -1,
        marker: 'from-cache',
        targetCount: 2,
        matchedTargetCount: 2,
        noMatchTargetCount: 0,
      }),
      cachedRow!.cacheKey,
    );

    const second = readDuneOutcomeReadiness(database, {
      walletAddresses: ['WALLET'],
      periodDays: 30,
    });
    assert.equal((second as unknown as { marker?: string }).marker, 'from-cache');
    assert.equal(second.coveredWallets, -1);

    // A genuine new trade changes the round-trip population (the fingerprint's own trigger
    // covers copytrade_trades inserts), so it must invalidate the corrupted cache and force a
    // real recomputation reflecting the new evidence.
    seedMatchedRoundTrip(database, 'WALLET', 'TOKEN_2', now - 8 * DAY, now - 7 * DAY);
    const third = readDuneOutcomeReadiness(database, {
      walletAddresses: ['WALLET'],
      periodDays: 30,
    });
    assert.equal(
      third.coveredWallets,
      1,
      'a real recomputation happened, not the stale corrupted cache',
    );
  } finally {
    database.close();
  }
});
