import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/platform/db/client.js';
import { applyMigrations } from '../src/platform/db/schema.js';
import { listRosterWallets, rankItemToWallet, readLeaderboardProvenance, readWalletRankHistory, resolveSingleTrader, syncCopyTradeRoster } from '../src/copytrade/screening/roster.js';
import { storeWalletRankSnapshot } from '../src/gmgn/walletRank.js';
import {
  detectRateLimit, hasActiveFetchRun, parseActivityPage, readFetchRunState,
  reconcileStaleFetchRuns, requestCopyTradeFetchStop, storeActivityPage,
  listWalletCoverageHistory, recordCoverage,
} from '../src/copytrade/screening/fetch.js';
import {
  compoundCapital, computeCopyTradeReport, computeProfitConcentration, decideVerdict, equalWeightCapital,
  holdSecondsPerSell, mean, median,
  performanceByPeriod, readCopyTradeSummary, saveCopyTradeSnapshot, summarizeTrades,
} from '../src/copytrade/scrutiny/evaluate.js';

const setup = (): DatabaseSync => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  return database;
};

const seedRankSnapshot = (database: DatabaseSync, rank: unknown[]): number => {
  database.prepare(
    `INSERT INTO gmgn_wallet_rank_snapshots (window, orderby, captured_at, raw_payload, source_sha256)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('7d', 'pnl_30d', '2026-08-14T18:28:35.448Z', JSON.stringify({ code: 0, data: { rank } }), `sha-${Math.random()}`);
  return Number((database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
};

// A real captured activity row, trimmed to the fields the importer reads.
const activity = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  wallet: 'WALLET_A', chain: 'sol', tx_hash: 'TX1', event_type: 'sell',
  token: { address: 'TOKEN_A', symbol: 'AAA' }, timestamp: 1_786_719_207,
  token_amount: '100', cost_usd: '110', buy_cost_usd: '100', price_usd: '0.1',
  gas_usd: '0.01', dex_usd: '0.02', launchpad_platform: 'Pump.fun', ...over,
});

const insertTrade = (database: DatabaseSync, over: Record<string, unknown>): void => {
  storeActivityPage(database, [activity(over)], { chain: 'sol', fetchedAt: '2026-08-15T00:00:00.000Z' });
};

test('roster: rank items become wallets, and re-syncing the same snapshot adds nothing', () => {
  const database = setup();
  try {
    seedRankSnapshot(database, [
      { wallet_address: 'W1', name: 'alpha', pnl_30d: '5.31', winrate_30d: 0.254, tags: ['kol', 'wash_trader'] },
      { wallet_address: 'W2', twitter_name: 'beta', pnl_30d: '0.29', winrate_30d: 0.626, tags: ['kol'] },
    ]);

    const first = syncCopyTradeRoster(database);
    assert.equal(first.added, 2);
    assert.equal(first.alreadyPresent, 0);

    const second = syncCopyTradeRoster(database);
    assert.equal(second.added, 0, 're-syncing the same snapshot must be a no-op');
    assert.equal(second.alreadyPresent, 2);

    const wallets = listRosterWallets(database);
    assert.equal(wallets.length, 2);
    assert.deepEqual(wallets[0].riskFlags, ['wash_trader'], 'wash_trader is a risk flag');
    assert.deepEqual(wallets[1].riskFlags, [], 'kol alone is descriptive, not a risk flag');
    assert.equal(wallets[1].name, 'beta', 'twitter_name is the fallback when name is absent');
  } finally { database.close(); }
});

test('roster: an item with no address is skipped rather than stored as a blank wallet', () => {
  assert.equal(rankItemToWallet({ name: 'no address' }, 0, 'sol'), null);
  assert.equal(rankItemToWallet({ address: 'W9' }, 4, 'sol')?.rankPosition, 5);
});

test('resolveSingleTrader: a real-looking Solana address is used directly, no database lookup needed', () => {
  const database = setup();
  try {
    const result = resolveSingleTrader(database, 'DxM1hfY8FQ8dNGrucuJzhJcF8KRbjk8WBwrgKvQ9spPv');
    assert.deepEqual(result, { kind: 'address', walletAddress: 'DxM1hfY8FQ8dNGrucuJzhJcF8KRbjk8WBwrgKvQ9spPv' });
  } finally { database.close(); }
});

test('resolveSingleTrader: a name matching a wallet already captured from a real leaderboard snapshot resolves to its address, case-insensitively', () => {
  const database = setup();
  try {
    seedRankSnapshot(database, [{ wallet_address: 'W1', name: 'alpha', pnl_30d: '5.31', winrate_30d: 0.254, tags: [] }]);
    syncCopyTradeRoster(database);
    const result = resolveSingleTrader(database, 'ALPHA');
    assert.deepEqual(result, { kind: 'name_match', walletAddress: 'W1', matchedName: 'alpha' });
  } finally { database.close(); }
});

test('resolveSingleTrader: a name with no stored match is reported as not_found, never silently treated as an address', () => {
  const database = setup();
  try {
    const result = resolveSingleTrader(database, 'nobody-weve-ever-captured');
    assert.deepEqual(result, { kind: 'not_found', query: 'nobody-weve-ever-captured' });
  } finally { database.close(); }
});

test('fetch: activity pages parse from both the unwrapped and enveloped shapes', () => {
  const unwrapped = parseActivityPage(JSON.stringify({ activities: [activity()], next: 'CURSOR1' }));
  assert.equal(unwrapped.activities.length, 1);
  assert.equal(unwrapped.next, 'CURSOR1');

  const enveloped = parseActivityPage(JSON.stringify({ code: 0, data: { activities: [activity()], next: '' } }));
  assert.equal(enveloped.activities.length, 1);
  assert.equal(enveloped.next, null, 'an empty next string means the last page');

  assert.deepEqual(parseActivityPage('{}'), { activities: [], next: null });
  assert.throws(() => parseActivityPage('not json'), /not JSON/);
});

test('fetch: rate limits are detected with their reset time, other failures are not', () => {
  const limited = detectRateLimit('Request failed: 429 {"code":429,"error":"RATE_LIMIT_BANNED","reset_at":1775184222}');
  assert.equal(limited?.rateLimited, true);
  assert.equal(limited?.resetAt, new Date(1775184222 * 1000).toISOString());

  assert.equal(detectRateLimit('RATE_LIMIT_EXCEEDED with no reset field')?.resetAt, null);
  assert.equal(detectRateLimit('connect ETIMEDOUT'), null, 'a network failure must not be mistaken for throttling');
});

test('fetch: the dedup key tolerates multi-leg transactions but rejects true repeats', () => {
  const database = setup();
  try {
    const page = [
      activity({ tx_hash: 'TX_MULTI', token: { address: 'TOKEN_A' }, token_amount: '100' }),
      // Same transaction, different leg — a real, distinct trade that must survive.
      activity({ tx_hash: 'TX_MULTI', token: { address: 'TOKEN_B' }, token_amount: '200' }),
    ];
    const first = storeActivityPage(database, page, { chain: 'sol', fetchedAt: 'now' });
    assert.equal(first.inserted, 2, 'two legs of one transaction are two trades');

    const second = storeActivityPage(database, page, { chain: 'sol', fetchedAt: 'later' });
    assert.equal(second.inserted, 0, 're-fetching an overlapping window inserts nothing');
    assert.equal(second.duplicates, 2, 'already-held rows count as duplicates');
    assert.equal(second.malformed, 0, 'and must not be confused with unparseable rows');
  } finally { database.close(); }
});

test('fetch: rows missing identity fields are skipped, never stored half-formed', () => {
  const database = setup();
  try {
    const result = storeActivityPage(database, [
      activity({ tx_hash: null }),
      activity({ timestamp: 'not a number' }),
      activity({ token: {} }),
    ], { chain: 'sol', fetchedAt: 'now' });
    assert.equal(result.inserted, 0);
    assert.equal(result.malformed, 3, 'unparseable rows are reported as data loss, not as duplicates');
    assert.equal(result.duplicates, 0);
    assert.equal((database.prepare('SELECT COUNT(*) AS c FROM copytrade_trades').get() as { c: number }).c, 0);
  } finally { database.close(); }
});

test('fetch: stop targets the active run, and is a no-op when nothing is running', () => {
  const database = setup();
  try {
    assert.deepEqual(requestCopyTradeFetchStop(database), { stopped: false, runId: null });

    database.prepare(
      `INSERT INTO copytrade_fetch_runs (started_at, status, wallet_total, wallet_done, trades_fetched, requests_made)
       VALUES ('2026-08-15T04:00:00.000Z', 'running', 10, 2, 500, 40)`,
    ).run();
    assert.deepEqual(requestCopyTradeFetchStop(database), { stopped: true, runId: 1 });

    // Stopping only flags the run; the loop is what transitions it, so state is unchanged here.
    assert.equal(readFetchRunState(database).status, 'running');
  } finally { database.close(); }
});

test('fetch: a cancelled run reports what it kept rather than looking like a failure', () => {
  const database = setup();
  try {
    database.prepare(
      `INSERT INTO copytrade_fetch_runs (started_at, completed_at, status, wallet_total, wallet_done, trades_fetched, requests_made)
       VALUES ('2026-08-15T04:00:00.000Z', '2026-08-15T04:01:00.000Z', 'cancelled', 100, 4, 28650, 900)`,
    ).run();
    const state = readFetchRunState(database);
    assert.equal(state.status, 'cancelled');
    assert.equal(state.running, false);
    assert.match(state.message, /28650 trades from 4 wallets were kept/);
  } finally { database.close(); }
});

test('fetch: a run orphaned by a restart is cleared so the single-run guard cannot latch', () => {
  const database = setup();
  try {
    database.prepare(
      `INSERT INTO copytrade_fetch_runs (started_at, status, wallet_total, wallet_done, trades_fetched, requests_made)
       VALUES ('2026-08-15T04:07:25.137Z', 'running', 3, 1, 5100, 102)`,
    ).run();
    assert.equal(hasActiveFetchRun(database), true, 'the orphan blocks new runs until reconciled');

    assert.equal(reconcileStaleFetchRuns(database), 1);
    assert.equal(hasActiveFetchRun(database), false, 'a new fetch can now be started');

    const state = readFetchRunState(database);
    assert.equal(state.status, 'failed');
    assert.match(state.message, /restarted/);
    assert.equal(state.tradesFetched, 5100, 'trades already fetched are kept, not discarded');
    assert.equal(reconcileStaleFetchRuns(database), 0, 'reconciling again is a no-op');
  } finally { database.close(); }
});

/** Results are always scoped to the current roster, so any wallet under test must be in it. */
const seedRoster = (database: DatabaseSync, wallets: Array<string | Record<string, unknown>>): void => {
  seedRankSnapshot(database, wallets.map((w) => typeof w === 'string' ? { wallet_address: w, tags: [] } : w));
  syncCopyTradeRoster(database);
};

const markCoverage = (database: DatabaseSync, wallet: string, over: Record<string, unknown> = {}): void => {
  database.prepare(
    `INSERT INTO copytrade_wallet_coverage
       (wallet_address, chain, last_run_id, requests_used, truncated, requested_period_days, stop_reason, updated_at)
     VALUES (?, 'sol', NULL, ?, ?, ?, ?, '2026-08-15T00:00:00.000Z')`,
  ).run(wallet, Number(over.requestsUsed ?? 200), Number(over.truncated ?? 1), Number(over.periodDays ?? 30), String(over.stopReason ?? 'request_cap'));
};

test('evaluate: a truncated wallet keeps median and win rate but withholds the mean-based figures', () => {
  const database = setup();
  try {
    seedRoster(database, ['HEAVY']);
    const now = new Date('2026-08-15T00:00:00.000Z');
    const base = Math.floor(now.getTime() / 1000) - 86_400;
    insertTrade(database, { wallet: 'HEAVY', tx_hash: 'A', timestamp: base, cost_usd: '200', buy_cost_usd: '100' });
    insertTrade(database, { wallet: 'HEAVY', tx_hash: 'B', timestamp: base + 60, cost_usd: '50', buy_cost_usd: '100', token_amount: '9' });
    markCoverage(database, 'HEAVY');

    const row = computeCopyTradeReport(database, { now }).rows[0];
    assert.equal(row.truncated, true);
    assert.equal(row.needsDuneBackfill, true, 'a capped wallet is exactly the case Dune handles');
    assert.equal(row.trades, 2);
    assert.equal(row.medianReturnPercent, 25, 'median survives truncation');
    assert.equal(row.winRatePercent, 50, 'win rate survives truncation');
    assert.equal(row.averageReturnPercent, null, 'the mean is biased by a newest-N sample');
    assert.equal(row.endingCapitalUsd, null);
    assert.equal(row.endingCapitalUsdCompounded, null);
    assert.match(row.unreliableReason ?? '', /newest trades/);
    assert.ok((row.coveredDays ?? 0) > 0, 'the span actually covered is reported');
  } finally { database.close(); }
});

test('evaluate: one truncated wallet also withholds the pooled mean-based figures', () => {
  const database = setup();
  try {
    seedRoster(database, ['CLEAN', 'HEAVY']);
    const now = new Date('2026-08-15T00:00:00.000Z');
    const base = Math.floor(now.getTime() / 1000) - 86_400;
    insertTrade(database, { wallet: 'CLEAN', tx_hash: 'C', timestamp: base, cost_usd: '150', buy_cost_usd: '100' });
    insertTrade(database, { wallet: 'HEAVY', tx_hash: 'D', timestamp: base, cost_usd: '200', buy_cost_usd: '100' });
    markCoverage(database, 'HEAVY');

    const report = computeCopyTradeReport(database, { now });
    assert.equal(report.overall.medianReturnPercent, 75, 'pooled median is still reported');
    assert.equal(report.overall.averageReturnPercent, null);
    assert.equal(report.overall.endingCapitalUsd, null);
    assert.match(report.overall.unreliableReason ?? '', /truncated/);

    const clean = report.rows.find((r) => r.walletAddress === 'CLEAN');
    assert.equal(clean?.averageReturnPercent, 50, 'an untruncated wallet keeps its own figures');
  } finally { database.close(); }
});

test('evaluate: reducing the trader count actually shrinks the report', () => {
  const database = setup();
  try {
    seedRankSnapshot(database, [
      { wallet_address: 'W1', name: 'first', tags: [] },
      { wallet_address: 'W2', name: 'second', tags: [] },
    ]);
    syncCopyTradeRoster(database);

    const now = new Date('2026-08-15T00:00:00.000Z');
    const base = Math.floor(now.getTime() / 1000) - 86_400;
    insertTrade(database, { wallet: 'W1', tx_hash: 'A', timestamp: base, cost_usd: '150', buy_cost_usd: '100' });
    insertTrade(database, { wallet: 'W2', tx_hash: 'B', timestamp: base, cost_usd: '150', buy_cost_usd: '100' });

    assert.equal(computeCopyTradeReport(database, { now }).rows.length, 2, 'unscoped shows everything');
    const scoped = computeCopyTradeReport(database, { now, traderLimit: 1 });
    assert.equal(scoped.rows.length, 1, 'top-1 must not render the wallet that dropped out');
    assert.equal(scoped.rows[0].walletAddress, 'W1');
    assert.equal(scoped.overall.trades, 1, 'the overall row is scoped too');
  } finally { database.close(); }
});

test('roster: "top N" follows the newest snapshot instead of every snapshot ever taken', () => {
  const database = setup();
  try {
    seedRankSnapshot(database, [{ wallet_address: 'OLD_LEADER', name: 'was first', tags: [] }]);
    syncCopyTradeRoster(database);
    seedRankSnapshot(database, [{ wallet_address: 'NEW_LEADER', name: 'now first', tags: [] }]);
    syncCopyTradeRoster(database);

    const current = listRosterWallets(database);
    assert.deepEqual(current.map((w) => w.walletAddress), ['NEW_LEADER'],
      'a wallet that fell off the leaderboard is no longer part of the current roster');
    assert.equal(current[0].rankPosition, 1);

    const everything = listRosterWallets(database, { allSnapshots: true });
    assert.equal(everything.length, 2, 'history is still reachable when explicitly asked for');
    // Both hold rank_position 1 from their own snapshot — precisely the collision that made
    // ordering arbitrary before the roster was scoped to one snapshot.
    assert.deepEqual(everything.map((w) => w.rankPosition), [1, 1]);
  } finally { database.close(); }
});

test('roster: an explicit snapshot keeps reports on the selected wallet population', () => {
  const database = setup();
  try {
    const selectedSnapshotId = seedRankSnapshot(database, [{ wallet_address: 'SELECTED', name: 'selected', tags: [] }]);
    syncCopyTradeRoster(database);
    seedRankSnapshot(database, [{ wallet_address: 'NEWER', name: 'newer', tags: [] }]);
    syncCopyTradeRoster(database);

    assert.deepEqual(listRosterWallets(database, { snapshotId: selectedSnapshotId }).map((wallet) => wallet.walletAddress), ['SELECTED']);
    assert.deepEqual(listRosterWallets(database).map((wallet) => wallet.walletAddress), ['NEWER']);
  } finally { database.close(); }
});

test('REGRESSION: a wallet from an older roster cannot leak into the default report', () => {
  const database = setup();
  try {
    seedRankSnapshot(database, [{ wallet_address: 'DROPPED', name: 'was ranked', tags: ['wash_trader'] }]);
    syncCopyTradeRoster(database);
    seedRankSnapshot(database, [{ wallet_address: 'CURRENT', name: 'now ranked', tags: [] }]);
    syncCopyTradeRoster(database);

    const now = new Date('2026-08-15T00:00:00.000Z');
    const base = Math.floor(now.getTime() / 1000) - 3600;
    insertTrade(database, { wallet: 'DROPPED', tx_hash: 'd1', timestamp: base, cost_usd: '150', buy_cost_usd: '100' });
    insertTrade(database, { wallet: 'CURRENT', tx_hash: 'c1', timestamp: base, cost_usd: '150', buy_cost_usd: '100' });

    // No traderLimit — this is the exact call the UI made, and the leak path.
    const report = computeCopyTradeReport(database, { now });
    assert.deepEqual(report.rows.map((r) => r.walletAddress), ['CURRENT']);
    assert.equal(report.overall.trades, 1, 'the dropped wallet must not reach the pooled row either');
  } finally { database.close(); }
});

test('REGRESSION: unusable sells cannot stretch history past the seven-day gate', () => {
  const database = setup();
  try {
    seedRankSnapshot(database, [{ wallet_address: 'S', name: 'short history', tags: [] }]);
    syncCopyTradeRoster(database);

    const now = new Date('2026-08-15T00:00:00.000Z');
    const T = Math.floor(now.getTime() / 1000);
    // 120 usable trades inside two hours, all profitable.
    for (let i = 0; i < 120; i += 1) {
      insertTrade(database, { wallet: 'S', tx_hash: `v${i}`, timestamp: T - 3600 - i * 60, cost_usd: '110', buy_cost_usd: '100', token_amount: String(i) });
    }
    // One sell with no cost basis, 20 days earlier — excluded from every statistic.
    insertTrade(database, { wallet: 'S', tx_hash: 'bad', timestamp: T - 20 * 86_400, cost_usd: '50', buy_cost_usd: null, token_amount: 'x' });

    const row = computeCopyTradeReport(database, { now }).rows[0];
    assert.ok((row.coveredDays ?? 0) < 1, `span must come from usable trades only, got ${row.coveredDays}`);
    assert.equal(row.verdict, 'thin', 'this previously returned a spurious "yes"');
    assert.ok(row.failedRules.some((r) => r.includes('7 days')));
  } finally { database.close(); }
});

test('REGRESSION: a truncated wallet cannot receive a positive verdict', () => {
  const database = setup();
  try {
    seedRankSnapshot(database, [{ wallet_address: 'HEAVY', name: 'capped', tags: [] }]);
    syncCopyTradeRoster(database);

    const now = new Date('2026-08-15T00:00:00.000Z');
    const T = Math.floor(now.getTime() / 1000);
    for (let i = 0; i < 150; i += 1) {
      insertTrade(database, { wallet: 'HEAVY', tx_hash: `h${i}`, timestamp: T - i * 3 * 3600, cost_usd: '150', buy_cost_usd: '100', token_amount: String(i) });
    }
    // Without the coverage row this wallet clears every gate.
    assert.equal(computeCopyTradeReport(database, { now }).rows[0].verdict, 'screen_pass');

    markCoverage(database, 'HEAVY');
    const row = computeCopyTradeReport(database, { now }).rows[0];
    assert.equal(row.verdict, 'descriptive_only', 'truncated history is descriptive only and cannot be compared');
    assert.ok(row.failedRules.includes('requested history window incomplete'));
  } finally { database.close(); }
});

test('REGRESSION: unparseable risk flags are treated as risk, not as safety', () => {
  const database = setup();
  try {
    seedRankSnapshot(database, [{ wallet_address: 'W', name: 'corrupt flags', tags: [] }]);
    syncCopyTradeRoster(database);
    database.prepare(`UPDATE copytrade_wallets SET risk_flags = '{not json' WHERE wallet_address = 'W'`).run();

    assert.deepEqual(listRosterWallets(database)[0].riskFlags, ['unknown_risk_flags']);

    const now = new Date('2026-08-15T00:00:00.000Z');
    const T = Math.floor(now.getTime() / 1000);
    for (let i = 0; i < 150; i += 1) {
      insertTrade(database, { wallet: 'W', tx_hash: `u${i}`, timestamp: T - i * 3 * 3600, cost_usd: '150', buy_cost_usd: '100', token_amount: String(i) });
    }
    const row = computeCopyTradeReport(database, { now }).rows[0];
    assert.equal(row.verdict, 'flagged', 'an unknown risk state must never pass as clean');
  } finally { database.close(); }
});

test('REGRESSION: a saved snapshot freezes the same scope the report was computed under', () => {
  const database = setup();
  try {
    seedRankSnapshot(database, [
      { wallet_address: 'W1', name: 'first', tags: [] },
      { wallet_address: 'W2', name: 'second', tags: [] },
    ]);
    syncCopyTradeRoster(database);
    const now = new Date('2026-08-15T00:00:00.000Z');
    const base = Math.floor(now.getTime() / 1000) - 3600;
    insertTrade(database, { wallet: 'W1', tx_hash: 'a', timestamp: base, cost_usd: '150', buy_cost_usd: '100' });
    insertTrade(database, { wallet: 'W2', tx_hash: 'b', timestamp: base, cost_usd: '150', buy_cost_usd: '100' });

    const displayed = computeCopyTradeReport(database, { now, periodDays: 7, traderLimit: 1 });
    const saved = saveCopyTradeSnapshot(database, displayed);
    const stored = database.prepare('SELECT params_json AS p, report_json AS r FROM copytrade_result_snapshots WHERE id = ?').get(saved.snapshotId) as { p: string; r: string };

    assert.deepEqual(JSON.parse(stored.r), displayed, 'the frozen report is byte-identical to the displayed one');
    const params = JSON.parse(stored.p) as Record<string, unknown>;
    assert.equal(params.periodDays, 7, 'not the 30-day default');
    assert.equal(params.traderLimit, 1);
    assert.equal(params.chain, 'sol');
    assert.equal(params.methodologyVersion, 'copytrade-evaluation-v3');
    assert.ok(typeof params.rosterSnapshotId === 'number');
  } finally { database.close(); }
});

test('evaluate: hold time is measured against the wallet\'s last buy of that same token', () => {
  const rows = [
    { walletAddress: 'W', observedTimestamp: 100, eventType: 'buy', tokenAddress: 'A', costUsd: null, buyCostUsd: null },
    { walletAddress: 'W', observedTimestamp: 107, eventType: 'sell', tokenAddress: 'A', costUsd: null, buyCostUsd: null },
    { walletAddress: 'W', observedTimestamp: 200, eventType: 'buy', tokenAddress: 'B', costUsd: null, buyCostUsd: null },
    { walletAddress: 'W', observedTimestamp: 8_000, eventType: 'sell', tokenAddress: 'B', costUsd: null, buyCostUsd: null },
    // Sold without ever buying — no hold time exists, so it must not be counted as zero.
    { walletAddress: 'W', observedTimestamp: 300, eventType: 'sell', tokenAddress: 'C', costUsd: null, buyCostUsd: null },
  ];
  assert.deepEqual(holdSecondsPerSell(rows), [7, 7800]);
});

test('evaluate: a risk flag comes with measured evidence, not just the tag', () => {
  const database = setup();
  try {
    seedRankSnapshot(database, [{ wallet_address: 'W', name: 'flagged one', tags: ['wash_trader'] }]);
    syncCopyTradeRoster(database);
    database.prepare(
      `INSERT INTO copytrade_wallet_stats (wallet_address, chain, period, fetched_at, fund_from_address, created_at_ts, raw_payload)
       VALUES ('W', 'sol', '7d', '2026-08-15T00:00:00.000Z', 'AxiomRXZAq1Jgjj9pHmNqVP7Lhu67wLXZJZbaK87TTSk', ?, '{}')`,
    ).run(Math.floor(new Date('2026-08-05T00:00:00.000Z').getTime() / 1000));

    const now = new Date('2026-08-15T00:00:00.000Z');
    const base = Math.floor(now.getTime() / 1000) - 86_400;
    // Two instant round trips, plus one sell of a token that was never bought.
    insertTrade(database, { wallet: 'W', tx_hash: 'b1', event_type: 'buy', token: { address: 'A' }, timestamp: base, token_amount: '1' });
    insertTrade(database, { wallet: 'W', tx_hash: 's1', event_type: 'sell', token: { address: 'A' }, timestamp: base + 7, cost_usd: '90', buy_cost_usd: '100', token_amount: '1' });
    insertTrade(database, { wallet: 'W', tx_hash: 'b2', event_type: 'buy', token: { address: 'B' }, timestamp: base + 20, token_amount: '2' });
    insertTrade(database, { wallet: 'W', tx_hash: 's2', event_type: 'sell', token: { address: 'B' }, timestamp: base + 25, cost_usd: '120', buy_cost_usd: '100', token_amount: '2' });
    insertTrade(database, { wallet: 'W', tx_hash: 's3', event_type: 'sell', token: { address: 'C' }, timestamp: base + 40, cost_usd: '50', buy_cost_usd: null, token_amount: '3' });

    const row = computeCopyTradeReport(database, { now }).rows[0];
    assert.equal(row.riskEvidence.fastRoundTripPercent, 100, 'both measurable round trips closed inside a minute');
    assert.equal(row.riskEvidence.under15SecondsPercent, 100, 'both measurable round trips closed within 15 seconds');
    assert.equal(row.riskEvidence.under15SecondsCount, 2);
    assert.equal(row.riskEvidence.pairedTradeCount, 2);
    assert.equal(row.riskEvidence.noCostBasisPercent, 33.3, '1 of 3 sells had no recorded purchase');
    assert.equal(row.riskEvidence.medianHoldSeconds, 6, 'median of a 7s and a 5s hold');
    assert.equal(row.riskEvidence.fundedByAddress, 'AxiomRXZAq1Jgjj9pHmNqVP7Lhu67wLXZJZbaK87TTSk');
    assert.equal(row.riskEvidence.walletAgeDays, 10);

    const notes = row.riskNotes.join(' | ');
    assert.match(notes, /does not publish how it decides/, 'the tag is presented as an opinion, not proof');
    assert.match(notes, /100% of sells closed within 60 seconds/);
    assert.match(notes, /33.3% of sells were tokens with no recorded purchase/);
    assert.match(notes, /First funded from Axiom/);
    assert.match(notes, /only 10 days old/);
  } finally { database.close(); }
});

test('evaluate: a clean wallet reports evidence without accusatory notes', () => {
  const database = setup();
  try {
    seedRoster(database, ['CLEAN']);
    const now = new Date('2026-08-15T00:00:00.000Z');
    const base = Math.floor(now.getTime() / 1000) - 86_400;
    insertTrade(database, { wallet: 'CLEAN', tx_hash: 'b1', event_type: 'buy', token: { address: 'A' }, timestamp: base, token_amount: '1' });
    insertTrade(database, { wallet: 'CLEAN', tx_hash: 's1', event_type: 'sell', token: { address: 'A' }, timestamp: base + 7200, cost_usd: '150', buy_cost_usd: '100', token_amount: '1' });

    const row = computeCopyTradeReport(database, { now }).rows[0];
    assert.equal(row.riskEvidence.fastRoundTripPercent, 0);
    assert.equal(row.riskEvidence.noCostBasisPercent, 0);
    assert.equal(row.riskEvidence.medianHoldSeconds, 7200);
    assert.equal(row.riskEvidence.fundedByAddress, null, 'absent stats are null, not invented');
    const notes = row.riskNotes.join(' | ');
    assert.doesNotMatch(notes, /wash_trader|no recorded purchase|closed within/);
    assert.match(notes, /Typical hold is 2.0 hours/);
  } finally { database.close(); }
});

test('evaluate: median resists the outlier that swings the average', () => {
  // Four small losses and one enormous win — the exact shape that produced a misleading
  // positive average elsewhere in this project.
  const trades = [
    { timestamp: 1, returnRatio: -0.5 }, { timestamp: 2, returnRatio: -0.5 },
    { timestamp: 3, returnRatio: -0.5 }, { timestamp: 4, returnRatio: -0.5 },
    { timestamp: 5, returnRatio: 40 },
  ];
  const summary = summarizeTrades(trades);
  assert.ok((summary.averageReturnPercent ?? 0) > 700, 'average is dragged up by the outlier');
  assert.equal(summary.medianReturnPercent, -50, 'median reports the typical trade');
  assert.equal(summary.winRatePercent, 20);
  assert.equal(median([]), null);
  assert.equal(mean([]), null);
});

test('evaluate: sequential compounding is time-ordered and a total loss is terminal', () => {
  assert.equal(compoundCapital([{ timestamp: 1, returnRatio: 1 }], 100), 200);
  assert.equal(compoundCapital([{ timestamp: 1, returnRatio: 0.1 }, { timestamp: 2, returnRatio: 0.1 }], 100), 121);
  assert.equal(compoundCapital([{ timestamp: 1, returnRatio: -0.5 }, { timestamp: 2, returnRatio: 0.5 }], 100), 75);

  // Order must not change the product, but a wipe-out must stop everything after it.
  assert.equal(compoundCapital([{ timestamp: 2, returnRatio: 0.5 }, { timestamp: 1, returnRatio: -0.5 }], 100), 75);
  assert.equal(compoundCapital([{ timestamp: 1, returnRatio: -1 }, { timestamp: 2, returnRatio: 100 }], 100), 0);
  assert.equal(compoundCapital([{ timestamp: 1, returnRatio: -5 }], 100), 0, 'capital can never go negative');
  assert.equal(compoundCapital([], 100), null, 'no trades means no answer, not $100');

  // Real data overflowed this model to 1.35e+22. Non-finite must become null, never Infinity.
  const explosive = Array.from({ length: 400 }, (_, i) => ({ timestamp: i, returnRatio: 50 }));
  assert.equal(compoundCapital(explosive, 100), null);
});

test('evaluate: the headline figure is equal-weight, which one outlier cannot explode', () => {
  assert.equal(equalWeightCapital([{ timestamp: 1, returnRatio: 1 }], 100), 200);
  // Splitting $100 across a +100% and a -50% trade ends at $125, not the $100 compounding gives.
  assert.equal(equalWeightCapital([{ timestamp: 1, returnRatio: 1 }, { timestamp: 2, returnRatio: -0.5 }], 100), 125);
  assert.equal(equalWeightCapital([], 100), null);

  // The same input that overflows sequential compounding stays bounded and readable here.
  const explosive = Array.from({ length: 400 }, (_, i) => ({ timestamp: i, returnRatio: 50 }));
  assert.equal(compoundCapital(explosive, 100), null);
  assert.equal(equalWeightCapital(explosive, 100), 5100);

  // Four losses and one huge win: equal-weight is lifted but finite, median stays negative.
  const skewed = [
    { timestamp: 1, returnRatio: -0.5 }, { timestamp: 2, returnRatio: -0.5 },
    { timestamp: 3, returnRatio: -0.5 }, { timestamp: 4, returnRatio: -0.5 },
    { timestamp: 5, returnRatio: 40 },
  ];
  assert.equal(equalWeightCapital(skewed, 100), 860, 'mean of the five returns is 7.6');
  assert.equal(summarizeTrades(skewed).medianReturnPercent, -50, 'median still reports the typical trade');
});

test('evaluate: every verdict gate is enforced, and risk outranks a thin sample', () => {
  const passing = { trades: 150, spanDays: 30, medianReturnPercent: 1.2, riskFlags: [] as string[] };
  assert.equal(decideVerdict(passing).verdict, 'screen_pass');
  assert.deepEqual(decideVerdict(passing).failedRules, []);

  assert.equal(decideVerdict({ ...passing, medianReturnPercent: -0.4 }).verdict, 'no');
  assert.equal(decideVerdict({ ...passing, medianReturnPercent: 0 }).verdict, 'no', 'zero median is not positive');
  assert.equal(decideVerdict({ ...passing, trades: 99 }).verdict, 'thin');
  assert.equal(decideVerdict({ ...passing, spanDays: 6 }).verdict, 'thin');
  assert.equal(decideVerdict({ ...passing, medianReturnPercent: null }).verdict, 'no');

  const flagged = decideVerdict({ ...passing, trades: 10, riskFlags: ['wash_trader'] });
  assert.equal(flagged.verdict, 'flagged', 'a risk flag outranks a thin sample');
  assert.equal(flagged.failedRules.length, 2, 'both failures are still reported');
});

test('evaluate: sells with no cost basis are excluded and counted, never treated as 0%', () => {
  const database = setup();
  try {
    seedRankSnapshot(database, [{ wallet_address: 'WALLET_A', name: 'alpha', tags: [] }]);
    syncCopyTradeRoster(database);

    const now = new Date('2026-08-15T00:00:00.000Z');
    const base = Math.floor(now.getTime() / 1000) - 86_400;
    insertTrade(database, { tx_hash: 'T1', timestamp: base, cost_usd: '110', buy_cost_usd: '100' });
    // Transferred-in tokens sold: proceeds exist, cost basis does not.
    insertTrade(database, { tx_hash: 'T2', timestamp: base + 10, cost_usd: '50', buy_cost_usd: null, token_amount: '5' });
    insertTrade(database, { tx_hash: 'T3', timestamp: base + 20, cost_usd: '90', buy_cost_usd: '100', token_amount: '7' });

    const report = computeCopyTradeReport(database, { now });
    const row = report.rows[0];
    assert.equal(row.trades, 2, 'only the two trades with a cost basis are counted');
    assert.equal(row.excludedNoCostBasis, 1);
    assert.equal(row.medianReturnPercent, 0, 'median of +10% and -10%');
    assert.equal(row.endingCapitalUsd, 100, 'equal-weight: +10% and -10% average out');
    assert.equal(row.endingCapitalUsdCompounded, 99, 'sequential: 100 -> 110 -> 99');
    assert.equal(row.verdict, 'thin', 'two trades cannot clear the sample gate');
  } finally { database.close(); }
});

test('evaluate: buys are ignored and only trades inside the period are used', () => {
  const database = setup();
  try {
    seedRoster(database, ['W']);
    const now = new Date('2026-08-15T00:00:00.000Z');
    const nowSeconds = Math.floor(now.getTime() / 1000);
    insertTrade(database, { wallet: 'W', tx_hash: 'B1', event_type: 'buy', timestamp: nowSeconds - 3600 });
    insertTrade(database, { wallet: 'W', tx_hash: 'S1', event_type: 'sell', timestamp: nowSeconds - 3600, cost_usd: '150', buy_cost_usd: '100' });
    insertTrade(database, { wallet: 'W', tx_hash: 'S2', event_type: 'sell', timestamp: nowSeconds - 60 * 86_400, cost_usd: '10', buy_cost_usd: '100' });

    const report = computeCopyTradeReport(database, { periodDays: 30, now });
    assert.equal(report.rows.length, 1);
    assert.equal(report.rows[0].trades, 1, 'the buy and the 60-day-old sell are both excluded');
    assert.equal(report.rows[0].endingCapitalUsd, 150);
    assert.equal(report.periodDays, 30);
  } finally { database.close(); }
});

test('evaluate: the overall row uses the same statistics as the per-wallet rows', () => {
  const database = setup();
  try {
    seedRoster(database, ['W1', 'W2']);
    const now = new Date('2026-08-15T00:00:00.000Z');
    const base = Math.floor(now.getTime() / 1000) - 86_400;
    insertTrade(database, { wallet: 'W1', tx_hash: 'A', timestamp: base, cost_usd: '200', buy_cost_usd: '100' });
    insertTrade(database, { wallet: 'W2', tx_hash: 'B', timestamp: base + 1, cost_usd: '50', buy_cost_usd: '100' });

    const report = computeCopyTradeReport(database, { now });
    assert.equal(report.overall.trades, 2);
    assert.equal(report.overall.medianReturnPercent, 25, 'median of +100% and -50%');
    assert.equal(report.overall.endingCapitalUsd, 125, 'equal-weight across both wallets');
    assert.equal(report.overall.endingCapitalUsdCompounded, 100, 'sequential: 100 -> 200 -> 100');
    assert.equal(report.rows[0].endingCapitalUsd, 200, 'rows are ordered best-first');
    assert.equal(report.rows[1].endingCapitalUsd, 50);
  } finally { database.close(); }
});

test('an empty database returns a well-formed payload, not zeros or a crash', () => {
  const database = setup();
  try {
    const report = computeCopyTradeReport(database);
    assert.deepEqual(report.rows, []);
    assert.equal(report.startingCapitalUsd, 100);
    assert.equal(report.overall.trades, 0);
    assert.equal(report.overall.medianReturnPercent, null, 'unknown must be null, never 0');
    assert.equal(report.overall.endingCapitalUsd, null);
    assert.deepEqual(report.rules, { minTrades: 100, minDays: 7, requiresPositiveMedian: true });

    const summary = readCopyTradeSummary(database);
    assert.deepEqual(summary, { traders: 0, trades: 0, historyDays: 0, verifiedPercent: null, lastRunAt: null });

    const state = readFetchRunState(database);
    assert.equal(state.running, false);
    assert.equal(state.status, 'idle');
    assert.equal(state.runId, null);
  } finally { database.close(); }
});

test('a saved snapshot freezes the report it was computed from', () => {
  const database = setup();
  try {
    seedRoster(database, ['W1']);
    const now = new Date('2026-08-15T00:00:00.000Z');
    insertTrade(database, { wallet: 'W1', tx_hash: 'A', timestamp: Math.floor(now.getTime() / 1000) - 3600, cost_usd: '200', buy_cost_usd: '100' });
    const report = computeCopyTradeReport(database, { now });
    const saved = saveCopyTradeSnapshot(database, report);
    assert.ok(saved.snapshotId > 0);

    const stored = database.prepare('SELECT report_json AS json FROM copytrade_result_snapshots WHERE id = ?').get(saved.snapshotId) as { json: string };
    assert.deepEqual(JSON.parse(stored.json), report, 'the stored snapshot is the exact report');
  } finally { database.close(); }
});

test('evaluate: trade-weighted and wallet-weighted overalls are both reported and differ', () => {
  const database = setup();
  try {
    seedRoster(database, ['BUSY', 'QUIET']);
    const now = new Date('2026-08-15T00:00:00.000Z');
    const base = Math.floor(now.getTime() / 1000) - 86_400;
    // BUSY makes 20 losing trades; QUIET makes 1 large winner. Pooling lets BUSY define the
    // headline; one-vote-per-wallet does not.
    for (let i = 0; i < 20; i += 1) {
      insertTrade(database, { wallet: 'BUSY', tx_hash: `b${i}`, timestamp: base + i, cost_usd: '90', buy_cost_usd: '100', token_amount: String(i) });
    }
    insertTrade(database, { wallet: 'QUIET', tx_hash: 'q1', timestamp: base, cost_usd: '300', buy_cost_usd: '100' });

    const report = computeCopyTradeReport(database, { now });

    assert.equal(report.overall.weighting, 'trade-weighted');
    assert.equal(report.overall.wallets, null, 'the wallet is not the unit for the pooled row');
    assert.equal(report.overall.trades, 21);
    assert.equal(report.overall.medianReturnPercent, -10, 'pooled median is BUSY’s, by weight of numbers');

    assert.equal(report.overallByWallet.weighting, 'wallet-weighted');
    assert.equal(report.overallByWallet.wallets, 2);
    assert.equal(report.overallByWallet.trades, 21, 'trade count is the same population, only the weighting differs');
    // Per-wallet medians are -10 and +200; their median is the midpoint.
    assert.equal(report.overallByWallet.medianReturnPercent, 95);
    assert.equal(report.overallByWallet.endingCapitalUsd, 195, 'mean of $90 and $300');
    assert.notEqual(report.overall.medianReturnPercent, report.overallByWallet.medianReturnPercent);
  } finally { database.close(); }
});

test('evaluate: wallet-weighted averages exclude truncated wallets rather than zeroing them', () => {
  const database = setup();
  try {
    seedRoster(database, ['CLEAN', 'HEAVY']);
    const now = new Date('2026-08-15T00:00:00.000Z');
    const base = Math.floor(now.getTime() / 1000) - 86_400;
    insertTrade(database, { wallet: 'CLEAN', tx_hash: 'c1', timestamp: base, cost_usd: '150', buy_cost_usd: '100' });
    insertTrade(database, { wallet: 'HEAVY', tx_hash: 'h1', timestamp: base, cost_usd: '900', buy_cost_usd: '100' });
    markCoverage(database, 'HEAVY');

    const byWallet = computeCopyTradeReport(database, { now }).overallByWallet;
    // HEAVY's own $100 figure was withheld, so it contributes nothing here — not a zero.
    assert.equal(byWallet.endingCapitalUsd, 150, 'only CLEAN has a usable capital figure');
    assert.equal(byWallet.averageReturnPercent, 50);
    assert.equal(byWallet.wallets, 2, 'but both wallets are still counted as present');
    assert.match(byWallet.unreliableReason ?? '', /excluded/);
  } finally { database.close(); }
});

test('coverage history keeps one immutable event per wallet per run while latest state stays current', () => {
  const database = setup();
  try {
    const run = database.prepare(`INSERT INTO copytrade_fetch_runs (started_at, status) VALUES (?, 'completed')`);
    run.run('2026-08-15T00:00:00.000Z');
    const firstRunId = Number((database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
    run.run('2026-08-15T01:00:00.000Z');
    const secondRunId = Number((database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);

    recordCoverage(database, { walletAddress: 'WALLET_A', chain: 'sol', runId: firstRunId, requestsUsed: 200, truncated: true, periodDays: 30, stopReason: 'request_cap' });
    recordCoverage(database, { walletAddress: 'WALLET_A', chain: 'sol', runId: secondRunId, requestsUsed: 3, truncated: false, periodDays: 30, stopReason: 'up_to_date' });

    const events = listWalletCoverageHistory(database, { walletAddress: 'WALLET_A' });
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((event) => event.runId), [secondRunId, firstRunId]);
    const latestCount = database.prepare('SELECT COUNT(*) AS count FROM copytrade_wallet_coverage WHERE wallet_address = ?').get('WALLET_A') as { count: number };
    assert.equal(latestCount.count, 1);
    const latest = database.prepare('SELECT last_run_id AS runId, truncated, stop_reason AS stopReason FROM copytrade_wallet_coverage WHERE wallet_address = ?').get('WALLET_A') as { runId: number; truncated: number; stopReason: string };
    assert.equal(latest.runId, secondRunId);
    assert.equal(latest.truncated, 0);
    assert.equal(latest.stopReason, 'up_to_date');
  } finally { database.close(); }
});

test('coverage history preserves a truncated event after a later complete run', () => {
  const database = setup();
  try {
    const run = database.prepare(`INSERT INTO copytrade_fetch_runs (started_at, status) VALUES (?, 'completed')`);
    run.run('2026-08-15T00:00:00.000Z');
    const firstRunId = Number((database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
    run.run('2026-08-16T00:00:00.000Z');
    const secondRunId = Number((database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
    recordCoverage(database, { walletAddress: 'WALLET_A', chain: 'sol', runId: firstRunId, requestsUsed: 200, truncated: true, periodDays: 30, stopReason: 'request_cap' });
    recordCoverage(database, { walletAddress: 'WALLET_A', chain: 'sol', runId: secondRunId, requestsUsed: 1, truncated: false, periodDays: 30, stopReason: 'window_covered' });

    const history = listWalletCoverageHistory(database, { walletAddress: 'WALLET_A' });
    const earlier = history.find((event) => event.runId === firstRunId);
    const later = history.find((event) => event.runId === secondRunId);
    assert.deepEqual({ truncated: earlier?.truncated, stopReason: earlier?.stopReason }, { truncated: true, stopReason: 'request_cap' });
    assert.deepEqual({ truncated: later?.truncated, stopReason: later?.stopReason }, { truncated: false, stopReason: 'window_covered' });
  } finally { database.close(); }
});

test('coverage history filters by wallet and run without clamping the requested limit', () => {
  const database = setup();
  try {
    const run = database.prepare(`INSERT INTO copytrade_fetch_runs (started_at, status) VALUES (?, 'completed')`);
    for (let index = 0; index < 505; index += 1) {
      run.run(`2026-08-15T00:${String(index % 60).padStart(2, '0')}:00.000Z`);
      const runId = Number((database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
      recordCoverage(database, { walletAddress: index === 504 ? 'WALLET_B' : 'WALLET_A', chain: 'sol', runId, requestsUsed: index + 1, truncated: false, periodDays: 30, stopReason: 'no_more_data' });
    }

    assert.equal(listWalletCoverageHistory(database, { limit: 999 }).length, 505);
    assert.ok(listWalletCoverageHistory(database, { walletAddress: 'WALLET_B' }).every((event) => event.walletAddress === 'WALLET_B'));
    const bEvents = listWalletCoverageHistory(database, { walletAddress: 'WALLET_B' });
    const bEvent = bEvents[0];
    assert.ok(bEvent);
    assert.deepEqual(listWalletCoverageHistory(database, { runId: bEvent.runId }).map((event) => event.id), [bEvent.id]);
  } finally { database.close(); }
});

test('coverage event watermarks capture the trades held when that run ended', () => {
  const database = setup();
  try {
    insertTrade(database, { wallet: 'WALLET_A', tx_hash: 'EARLY', timestamp: 100 });
    insertTrade(database, { wallet: 'WALLET_A', tx_hash: 'MIDDLE', timestamp: 200 });
    database.prepare(`INSERT INTO copytrade_fetch_runs (started_at, status) VALUES (?, 'completed')`).run('2026-08-15T00:00:00.000Z');
    const runId = Number((database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
    recordCoverage(database, { walletAddress: 'WALLET_A', chain: 'sol', runId, requestsUsed: 2, truncated: false, periodDays: 30, stopReason: 'window_covered' });
    insertTrade(database, { wallet: 'WALLET_A', tx_hash: 'LATE', timestamp: 300 });

    const event = listWalletCoverageHistory(database, { runId })[0];
    assert.equal(event.oldestHeldTs, 100);
    assert.equal(event.newestHeldTs, 200);
  } finally { database.close(); }
});

test('recordCoverage persists a resume cursor for a truncated wallet and clears it once the window is covered', () => {
  const database = setup();
  try {
    database.prepare(`INSERT INTO copytrade_fetch_runs (started_at, status) VALUES (?, 'completed')`).run('2026-08-15T00:00:00.000Z');
    const firstRunId = Number((database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
    recordCoverage(database, {
      walletAddress: 'WALLET_A', chain: 'sol', runId: firstRunId, requestsUsed: 200,
      truncated: true, periodDays: 90, stopReason: 'request_cap', resumeCursor: 'CURSOR_AT_REQUEST_CAP',
    });
    const afterFirst = database.prepare('SELECT resume_cursor AS resumeCursor FROM copytrade_wallet_coverage WHERE wallet_address = ?').get('WALLET_A') as { resumeCursor: string | null };
    assert.equal(afterFirst.resumeCursor, 'CURSOR_AT_REQUEST_CAP', 'a truncated wallet must save where to resume next time');

    database.prepare(`INSERT INTO copytrade_fetch_runs (started_at, status) VALUES (?, 'completed')`).run('2026-08-16T00:00:00.000Z');
    const secondRunId = Number((database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
    recordCoverage(database, {
      walletAddress: 'WALLET_A', chain: 'sol', runId: secondRunId, requestsUsed: 30,
      truncated: false, periodDays: 90, stopReason: 'window_covered', resumeCursor: null,
    });
    const afterSecond = database.prepare('SELECT resume_cursor AS resumeCursor FROM copytrade_wallet_coverage WHERE wallet_address = ?').get('WALLET_A') as { resumeCursor: string | null };
    assert.equal(afterSecond.resumeCursor, null, 'once the window is fully covered there is nothing left to resume');
  } finally { database.close(); }
});

test('recordCoverage without a resumeCursor argument defaults to null, not undefined leaking into SQLite', () => {
  const database = setup();
  try {
    database.prepare(`INSERT INTO copytrade_fetch_runs (started_at, status) VALUES (?, 'completed')`).run('2026-08-15T00:00:00.000Z');
    const runId = Number((database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
    recordCoverage(database, { walletAddress: 'WALLET_A', chain: 'sol', runId, requestsUsed: 1, truncated: false, periodDays: 30, stopReason: 'no_more_data' });
    const row = database.prepare('SELECT resume_cursor AS resumeCursor FROM copytrade_wallet_coverage WHERE wallet_address = ?').get('WALLET_A') as { resumeCursor: string | null };
    assert.equal(row.resumeCursor, null);
  } finally { database.close(); }
});

test('storeActivityPage: a daily cap stops inserting once a calendar day has enough trades, without touching other days', () => {
  const database = setup();
  try {
    const day1Start = Math.floor(Date.parse('2026-08-10T00:00:00.000Z') / 1000);
    const dailyCap = { limit: 2, countsByDay: new Map<string, number>() };

    const day1 = [
      activity({ tx_hash: 'D1_A', timestamp: day1Start + 1 }),
      activity({ tx_hash: 'D1_B', timestamp: day1Start + 2 }),
      activity({ tx_hash: 'D1_C', timestamp: day1Start + 3 }),
      activity({ tx_hash: 'D1_D', timestamp: day1Start + 4 }),
    ];
    const storedDay1 = storeActivityPage(database, day1, { chain: 'sol', fetchedAt: 'now', dailyCap });
    assert.equal(storedDay1.inserted, 2, 'only the first two trades of the day are stored, matching the cap');
    assert.equal(storedDay1.dailyCapped, 2, 'the remaining two are explicitly counted as capped, not silently dropped');
    assert.equal(storedDay1.duplicates, 0, 'capped trades are not duplicates — they were never seen before');

    const day2Start = day1Start + 86_400;
    const day2 = [activity({ tx_hash: 'D2_A', timestamp: day2Start + 1 }), activity({ tx_hash: 'D2_B', timestamp: day2Start + 2 })];
    const storedDay2 = storeActivityPage(database, day2, { chain: 'sol', fetchedAt: 'now', dailyCap });
    assert.equal(storedDay2.inserted, 2, 'a new calendar day gets its own fresh cap, unaffected by the previous day being full');

    const totalStored = database.prepare('SELECT COUNT(*) AS count FROM copytrade_trades').get() as { count: number };
    assert.equal(totalStored.count, 4, '2 from day 1 + 2 from day 2');
  } finally { database.close(); }
});

test('storeActivityPage: the daily cap is seeded from trades already stored, so a resumed run does not exceed it', () => {
  const database = setup();
  try {
    const dayStart = Math.floor(Date.parse('2026-08-10T00:00:00.000Z') / 1000);
    // Simulate two trades already stored for this day by an earlier run, before any cap tracker existed for this run.
    storeActivityPage(database, [
      activity({ tx_hash: 'PRIOR_A', timestamp: dayStart + 1 }),
      activity({ tx_hash: 'PRIOR_B', timestamp: dayStart + 2 }),
    ], { chain: 'sol', fetchedAt: 'earlier-run' });

    const dailyCap = { limit: 2, countsByDay: new Map<string, number>() };
    const stored = storeActivityPage(database, [
      activity({ tx_hash: 'NEW_A', timestamp: dayStart + 3 }),
    ], { chain: 'sol', fetchedAt: 'this-run', dailyCap });
    assert.equal(stored.inserted, 0, 'the day already has 2 stored trades from a prior run, matching the cap of 2');
    assert.equal(stored.dailyCapped, 1);
  } finally { database.close(); }
});

test('storeActivityPage: re-confirming an already-stored trade on a day at its cap counts as a duplicate, not capped', () => {
  const database = setup();
  try {
    const dayStart = Math.floor(Date.parse('2026-08-10T00:00:00.000Z') / 1000);
    // Seed the day past its cap with real stored trades, the way an earlier (pre-cap) run would have.
    storeActivityPage(database, [
      activity({ tx_hash: 'OLD_A', timestamp: dayStart + 1 }),
      activity({ tx_hash: 'OLD_B', timestamp: dayStart + 2 }),
    ], { chain: 'sol', fetchedAt: 'earlier-run' });

    const dailyCap = { limit: 2, countsByDay: new Map<string, number>() };
    // Re-fetching the same page again (a normal catch-up re-walk) re-sends OLD_A alongside one
    // genuinely new trade for the same already-full day.
    const stored = storeActivityPage(database, [
      activity({ tx_hash: 'OLD_A', timestamp: dayStart + 1 }),
      activity({ tx_hash: 'NEW_C', timestamp: dayStart + 3 }),
    ], { chain: 'sol', fetchedAt: 'this-run', dailyCap });
    assert.equal(stored.duplicates, 1, 'OLD_A was already stored — a harmless re-confirm, not data the cap turned away');
    assert.equal(stored.dailyCapped, 1, 'only NEW_C, which would have been genuinely new, was actually capped');
    assert.equal(stored.inserted, 0);
  } finally { database.close(); }
});

test('storeActivityPage: without a dailyCap option, behavior is unchanged (uncapped, as before this feature)', () => {
  const database = setup();
  try {
    const dayStart = Math.floor(Date.parse('2026-08-10T00:00:00.000Z') / 1000);
    const many = Array.from({ length: 10 }, (_, index) => activity({ tx_hash: `T${index}`, timestamp: dayStart + index }));
    const stored = storeActivityPage(database, many, { chain: 'sol', fetchedAt: 'now' });
    assert.equal(stored.inserted, 10);
    assert.equal(stored.dailyCapped, 0);
  } finally { database.close(); }
});

test('leaderboard provenance preserves the exact query even when the normalized response repeats', () => {
  const database = setup();
  try {
    const payload = { code: 0, data: { rank: [{ wallet_address: 'W1' }] } };
    const first = storeWalletRankSnapshot(database, {
      window: '30d', orderby: 'pnl_30d', capturedAt: '2026-08-01T00:00:00.000Z',
      requestPath: '/api/v1/rank/sol/wallets/30d',
      requestQuery: { orderby: 'pnl_30d', winrate: '0.5', direction: 'desc' }, rawPayload: payload,
    });
    const second = storeWalletRankSnapshot(database, {
      window: '30d', orderby: 'pnl_30d', capturedAt: '2026-08-02T00:00:00.000Z',
      requestPath: '/api/v1/rank/sol/wallets/30d',
      requestQuery: { orderby: 'pnl_30d', winrate: '0.6', direction: 'desc' }, rawPayload: payload,
    });
    assert.equal(first.inserted, 1);
    assert.equal(second.skipped, 1, 'the identical response body stays normalized once');
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM gmgn_wallet_rank_capture_provenance').get() as { count: number }).count, 2, 'both request observations remain immutable');
    const provenance = readLeaderboardProvenance(database, 1);
    assert.equal(provenance?.capturedAt, '2026-08-02T00:00:00.000Z');
    assert.equal(provenance?.requestQuery.winrate, '0.6');
  } finally { database.close(); }
});

test('rank history counts absence against top-five persistence and reports current rank', () => {
  const database = setup();
  try {
    const firstId = seedRankSnapshot(database, [
      { wallet_address: 'W1' }, { wallet_address: 'A' }, { wallet_address: 'B' },
    ]);
    const secondId = seedRankSnapshot(database, [
      { wallet_address: 'A' }, { wallet_address: 'B' }, { wallet_address: 'C' },
      { wallet_address: 'D' }, { wallet_address: 'E' }, { wallet_address: 'W1' },
    ]);
    assert.notEqual(firstId, secondId);
    const history = readWalletRankHistory(database, ['W1'], secondId)[0];
    assert.equal(history.leaderboardCaptures, 2);
    assert.equal(history.appearances, 2);
    assert.equal(history.topFiveAppearances, 1);
    assert.equal(history.topFiveMembershipPercent, 50);
    assert.equal(history.currentRank, 6);
    assert.equal(history.bestRank, 1);
    assert.equal(history.worstRank, 6);
  } finally { database.close(); }
});

test('profit concentration exposes best-token dependence and results without the winner', () => {
  const trades = [
    { sourceId: 1, timestamp: 1_785_715_200, returnRatio: 1, profitUsd: 100, tokenAddress: 'T1', tokenSymbol: 'ONE' },
    { sourceId: 2, timestamp: 1_785_801_600, returnRatio: -0.1, profitUsd: -10, tokenAddress: 'T1', tokenSymbol: 'ONE' },
    { sourceId: 3, timestamp: 1_786_320_000, returnRatio: 0.2, profitUsd: 20, tokenAddress: 'T2', tokenSymbol: 'TWO' },
  ];
  const result = computeProfitConcentration(trades);
  assert.equal(result.bestToken?.tokenAddress, 'T1');
  assert.equal(result.bestToken?.profitUsd, 90);
  assert.equal(result.bestTokenSharePositiveProfitPercent, 81.8);
  assert.equal(result.excludingBestTrade.trades, 2);
  assert.equal(result.excludingBestToken.trades, 1);
  assert.equal(result.excludingBestToken.endingCapitalUsd, 120);
});

test('weekly and monthly performance use UTC periods and preserve every usable trade', () => {
  const trades = [
    { sourceId: 1, timestamp: Date.parse('2026-08-03T10:00:00Z') / 1000, returnRatio: 0.1, profitUsd: 10, tokenAddress: 'T1', tokenSymbol: 'ONE' },
    { sourceId: 2, timestamp: Date.parse('2026-08-10T10:00:00Z') / 1000, returnRatio: -0.2, profitUsd: -20, tokenAddress: 'T2', tokenSymbol: 'TWO' },
    { sourceId: 3, timestamp: Date.parse('2026-09-01T10:00:00Z') / 1000, returnRatio: 0.3, profitUsd: 30, tokenAddress: 'T3', tokenSymbol: 'THREE' },
  ];
  const weeks = performanceByPeriod(trades, 'week');
  const months = performanceByPeriod(trades, 'month');
  assert.deepEqual(weeks.map((row) => row.period), ['2026-08-03', '2026-08-10', '2026-08-31']);
  assert.deepEqual(months.map((row) => [row.period, row.trades]), [['2026-08', 2], ['2026-09', 1]]);
});
