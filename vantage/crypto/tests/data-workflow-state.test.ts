import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import {
  createDataWorkflowRun,
  updateDataWorkflowStep,
} from '../src/copytrade/data/dataWorkflowRunStore.js';
import { readDataWorkflowState } from '../src/copytrade/data/dataWorkflowState.js';
import { readProductionJobLock } from '../src/copytrade/data/productionJobLock.js';
import { patternDiscoveryCacheKey } from '../src/copytrade/discovery/patternDiscovery.js';
import { PATTERN_DISCOVERY_COVERAGE_THRESHOLDS } from '../src/copytrade/discovery/patternDiscoveryRunner.js';
import { openDatabase } from '../src/platform/db/client.js';
import { applyMigrations } from '../src/platform/db/schema.js';

const DAY = 86_400;
const NOW = new Date('2026-08-29T12:00:00.000Z');
const NOW_ISO = NOW.toISOString();

const setup = (): DatabaseSync => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  return database;
};

const addRoster = (database: DatabaseSync, wallets: string[]): number => {
  database
    .prepare(
      `INSERT INTO gmgn_wallet_rank_snapshots (captured_at, raw_payload, source_sha256)
       VALUES (?, ?, ?)`,
    )
    .run(
      NOW_ISO,
      JSON.stringify({
        data: wallets.map((wallet, index) => ({ wallet_address: wallet, rank: index + 1 })),
      }),
      `snapshot-${wallets.join('-')}`,
    );
  const snapshotId = Number(
    (database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id,
  );
  const insertWallet = database.prepare(
    `INSERT INTO copytrade_wallets
     (wallet_address, chain, name, source_snapshot_id, rank_position, risk_flags, added_at)
     VALUES (?, 'sol', ?, ?, ?, '[]', ?)`,
  );
  wallets.forEach((wallet, index) =>
    insertWallet.run(wallet, wallet, snapshotId, index + 1, NOW_ISO),
  );
  return snapshotId;
};

const addWorkflow = (database: DatabaseSync, wallets: string[], threshold = 90): number =>
  createDataWorkflowRun(database, {
    chain: 'sol',
    targetDays: 90,
    traderLimit: wallets.length,
    rosterSnapshotId: addRoster(database, wallets),
    rosterWallets: wallets,
    completenessThresholdPercent: threshold,
  });

const addFetchRun = (database: DatabaseSync): number => {
  database
    .prepare(
      `INSERT INTO copytrade_fetch_runs (started_at, status, requested_period_days) VALUES (?, 'completed', 90)`,
    )
    .run(NOW_ISO);
  return Number((database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
};

const addTrade = (database: DatabaseSync, wallet: string, timestamp: number): number => {
  database
    .prepare(
      `INSERT INTO copytrade_trades
       (wallet_address, chain, tx_hash, event_type, token_address, observed_timestamp,
        raw_payload, fetched_at, dedup_key)
       VALUES (?, 'sol', ?, 'buy', 'TOKEN', ?, '{}', ?, ?)`,
    )
    .run(wallet, `TX-${wallet}-${timestamp}`, timestamp, NOW_ISO, `${wallet}-${timestamp}`);
  return Number((database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
};

const addCoverageEvent = (
  database: DatabaseSync,
  runId: number,
  wallet: string,
  oldestDaysAgo: number,
  observedAt = NOW_ISO,
  truncated = 0,
  stopReason = 'window_covered',
): void => {
  const fetchRunId = addFetchRun(database);
  database
    .prepare(
      `INSERT INTO copytrade_wallet_coverage_events
       (run_id, wallet_address, chain, requested_period_days, requests_used, truncated,
        stop_reason, oldest_held_ts, newest_held_ts, observed_at, error)
       VALUES (?, ?, 'sol', 90, 3, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      fetchRunId,
      wallet,
      truncated,
      stopReason,
      Math.floor(NOW.getTime() / 1000) - oldestDaysAgo * DAY,
      Math.floor(NOW.getTime() / 1000),
      observedAt,
    );
  database
    .prepare(
      `INSERT INTO copytrade_wallet_coverage
       (wallet_address, chain, last_run_id, requests_used, truncated, coverage_complete,
        requested_period_days, stop_reason, updated_at, pages_fetched)
       VALUES (?, 'sol', ?, 3, ?, ?, 90, ?, ?, 2)
       ON CONFLICT(wallet_address, chain) DO UPDATE SET last_run_id = excluded.last_run_id,
         truncated = excluded.truncated, coverage_complete = excluded.coverage_complete,
         requested_period_days = excluded.requested_period_days, stop_reason = excluded.stop_reason,
         updated_at = excluded.updated_at`,
    )
    .run(wallet, fetchRunId, truncated, truncated === 0 ? 1 : 0, stopReason, observedAt);
  void runId;
};

const addFreshStats = (database: DatabaseSync, wallet: string, fetchedAt = NOW_ISO): void => {
  database
    .prepare(
      `INSERT INTO copytrade_wallet_stats
       (wallet_address, chain, period, fetched_at, raw_payload)
       VALUES (?, 'sol', '30d', ?, '{}')`,
    )
    .run(wallet, fetchedAt);
};

const addStatsEvent = (database: DatabaseSync, wallet: string, fetchedAt = NOW_ISO): void => {
  database
    .prepare(
      `INSERT INTO copytrade_wallet_stats_events
       (wallet_address, chain, period, fetched_at, raw_payload)
       VALUES (?, 'sol', '30d', ?, '{}')`,
    )
    .run(wallet, fetchedAt);
};

const addCurrentPatternEvidence = (database: DatabaseSync, periodDays = 30): void => {
  database
    .prepare(
      `UPDATE pattern_discovery_data_revision SET revision = 7, dirty = 0 WHERE singleton_id = 1`,
    )
    .run();
  const fingerprint = 'pattern-discovery-revision-v1:7';
  const insert = database.prepare(
    `INSERT INTO copytrade_report_cache (cache_key, data_fingerprint, report_json, updated_at)
     VALUES (?, ?, ?, ?)`,
  );
  for (const threshold of PATTERN_DISCOVERY_COVERAGE_THRESHOLDS) {
    insert.run(
      patternDiscoveryCacheKey('report', periodDays, threshold, 10, 500),
      fingerprint,
      '{}',
      NOW_ISO,
    );
  }
  insert.run(
    patternDiscoveryCacheKey('sensitivity', periodDays, 50, 10, 500),
    fingerprint,
    JSON.stringify({ crossCoveragePromotedPatterns: [] }),
    NOW_ISO,
  );
  database
    .prepare(
      `INSERT INTO copytrade_pattern_discovery_runs
       (period_days, minimum_n, status, progress_json, started_at, heartbeat_at, completed_at)
       VALUES (?, 10, 'complete', '{}', ?, ?, ?)`,
    )
    .run(periodDays, NOW_ISO, NOW_ISO, NOW_ISO);
};

test('stored completed flags become warnings when current evidence is incomplete', () => {
  const database = setup();
  try {
    const runId = addWorkflow(database, ['WALLET']);
    updateDataWorkflowStep(database, {
      runId,
      stepKey: 'coverage_verification',
      status: 'completed',
      markSuccess: true,
    });
    updateDataWorkflowStep(database, {
      runId,
      stepKey: 'activity_history',
      status: 'completed',
      markSuccess: true,
    });
    const state = readDataWorkflowState(database, { runId, now: NOW });
    const coverageStep = state.steps.find((step) => step.stepKey === 'coverage_verification');
    const activityStep = state.steps.find((step) => step.stepKey === 'activity_history');
    assert.ok(coverageStep);
    assert.ok(activityStep);
    assert.equal(coverageStep.storedStatus, 'completed');
    assert.equal(coverageStep.status, 'completed_with_warnings');
    assert.equal(activityStep.status, 'completed_with_warnings');
    assert.equal(state.counts.coverage.completeWallets, 0);
  } finally {
    database.close();
  }
});

test('depth milestones retain an earlier verified walk while the latest truncated attempt is surfaced as a warning', () => {
  const database = setup();
  try {
    const runId = addWorkflow(database, ['WALLET']);
    addTrade(database, 'WALLET', Math.floor(NOW.getTime() / 1000) - 95 * DAY);
    addCoverageEvent(database, runId, 'WALLET', 95);
    addCoverageEvent(
      database,
      runId,
      'WALLET',
      40,
      new Date(NOW.getTime() + 1_000).toISOString(),
      1,
      'request_cap',
    );
    const state = readDataWorkflowState(database, { runId, now: NOW });
    assert.equal(state.counts.coverage.milestones[30], 1);
    assert.equal(state.counts.coverage.milestones[60], 1);
    assert.equal(state.counts.coverage.milestones[90], 1);
    assert.equal(state.counts.coverage.supersededAttemptWallets, 1);
    assert.equal(state.counts.coverage.ready, true);
    assert.match(state.warnings.join(' '), /earlier verified depth remains usable/);
  } finally {
    database.close();
  }
});

test('the configured completeness threshold uses a ceiling and durable current stats are read from SQLite', () => {
  const database = setup();
  try {
    const runId = addWorkflow(database, ['ONE', 'TWO'], 50);
    addTrade(database, 'ONE', Math.floor(NOW.getTime() / 1000) - 95 * DAY);
    addCoverageEvent(database, runId, 'ONE', 95);
    addFreshStats(database, 'ONE');
    const state = readDataWorkflowState(database, { runId, now: NOW });
    assert.equal(state.counts.coverage.requiredWallets, 1);
    assert.equal(state.counts.coverage.ready, true);
    assert.equal(state.counts.stats.freshRows, 1);
    assert.equal(state.counts.stats.durableEventRows, 0);
    assert.equal(state.counts.stats.ready, true);
  } finally {
    database.close();
  }
});

test('Dune and Pattern readiness come from persisted evidence, while Decision Lab can report neutral fallback readiness', () => {
  const database = setup();
  try {
    const runId = addWorkflow(database, ['WALLET']);
    // Dune readiness is now period-scoped (reads a genuine round trip via
    // computeCopySimulationReport), so the fixture needs a real buy+sell pair with both legs
    // usably matched -- a single matched leg with no paired trade can never produce a
    // coverageRatePercent. The sell must land inside the requested 90-day window; the buy may
    // predate it (a valid entry into that window).
    const buyTimestamp = Math.floor(NOW.getTime() / 1000) - 95 * DAY;
    const sellTimestamp = Math.floor(NOW.getTime() / 1000) - 5 * DAY;
    const buyTradeId = addTrade(database, 'WALLET', buyTimestamp);
    const sellTradeId = Number(
      database
        .prepare(
          `INSERT INTO copytrade_trades
           (wallet_address, chain, tx_hash, event_type, token_address, observed_timestamp,
            raw_payload, fetched_at, dedup_key)
           VALUES ('WALLET', 'sol', ?, 'sell', 'TOKEN', ?, '{}', ?, ?)`,
        )
        .run(
          `TX-WALLET-sell-${sellTimestamp}`,
          sellTimestamp,
          NOW_ISO,
          `WALLET-sell-${sellTimestamp}`,
        ).lastInsertRowid,
    );
    addCoverageEvent(database, runId, 'WALLET', 95);
    addFreshStats(database, 'WALLET');
    addStatsEvent(database, 'WALLET');
    database
      .prepare(
        `INSERT INTO copytrade_copy_simulation_runs
         (trade_refs, query_sql, status, requested_at, completed_at, workflow_run_id)
         VALUES (?, '', 'completed', ?, ?, ?)`,
      )
      .run(JSON.stringify([buyTradeId, sellTradeId]), NOW_ISO, NOW_ISO, runId);
    const simulationRunId = Number(
      (database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id,
    );
    const insertMatch = database.prepare(
      `INSERT INTO copytrade_copy_simulation_matches
       (run_id, trade_id, matched_trade_at, matched_price_usd, status, match_source, completed_at)
       VALUES (?, ?, ?, ?, 'matched', 'precise', ?)`,
    );
    insertMatch.run(
      simulationRunId,
      buyTradeId,
      new Date((buyTimestamp + 15) * 1000).toISOString(),
      1,
      NOW_ISO,
    );
    insertMatch.run(
      simulationRunId,
      sellTradeId,
      new Date((sellTimestamp + 15) * 1000).toISOString(),
      1.1,
      NOW_ISO,
    );
    // The simulation write marks the shared Pattern Discovery revision dirty; a current result
    // must therefore be seeded after all source evidence has been inserted. Seeded at 90 days to
    // match this workflow's targetDays -- pattern/decision readiness are now period-scoped too.
    addCurrentPatternEvidence(database, 90);
    const state = readDataWorkflowState(database, { runId, now: NOW });
    assert.equal(state.counts.dune.ready, true);
    assert.equal(state.counts.dune.targetCount, 2);
    assert.equal(state.counts.dune.matchedTargetCount, 2);
    assert.equal(state.counts.dune.noMatchTargetCount, 0);
    assert.equal(state.counts.pattern.ready, true);
    assert.equal(state.counts.decision.ready, true);
    assert.equal(state.counts.decision.weightingMode, 'neutral-fallback');
  } finally {
    database.close();
  }
});

test('combined production lock reports persistent fetch, Dune, and Pattern jobs together', () => {
  const database = setup();
  try {
    database
      .prepare(`INSERT INTO copytrade_fetch_runs (started_at, status) VALUES (?, 'running')`)
      .run(NOW_ISO);
    database
      .prepare(
        `INSERT INTO copytrade_copy_simulation_runs (trade_refs, query_sql, status, requested_at) VALUES ('[]', '', 'running', ?)`,
      )
      .run(NOW_ISO);
    database
      .prepare(
        `INSERT INTO copytrade_pattern_discovery_runs (period_days, minimum_n, status, progress_json, started_at, heartbeat_at) VALUES (30, 10, 'running', '{}', ?, ?)`,
      )
      .run(NOW_ISO, NOW_ISO);
    const lock = readProductionJobLock(database);
    assert.equal(lock.locked, true);
    assert.deepEqual(
      new Set(lock.blockers.map((blocker) => blocker.kind)),
      new Set(['gmgn_fetch', 'dune_simulation', 'pattern_research']),
    );
    assert.match(lock.reason ?? '', /Another production job is active/);
  } finally {
    database.close();
  }
});
