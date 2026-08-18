import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/db/client.js';
import { applyMigrations, latestSchemaVersion } from '../src/db/schema.js';

test('schema initialization creates V1 tables and is idempotent', () => {
  const database = openDatabase(':memory:');

  try {
    applyMigrations(database);
    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => (row as { name: string }).name);
    assert.deepEqual(tables, [
      'birdeye_probe_batches',
      'copytrade_copy_simulation_runs',
      'copytrade_experiment_wallets',
      'copytrade_experiments',
      'copytrade_fetch_estimate',
      'copytrade_fetch_runs',
      'copytrade_result_snapshots',
      'copytrade_trades',
      'copytrade_wallet_coverage',
      'copytrade_wallet_coverage_events',
      'copytrade_wallet_stats',
      'copytrade_wallets',
      'diagnostic_logs',
      'dune_import_batches',
      'dune_import_records',
      'dune_measurement_prescreen',
      'dune_outcome_runs',
      'gmgn_browser_coverage_windows',
      'gmgn_browser_import_batches',
      'gmgn_polls',
      'gmgn_radar_snapshots',
      'gmgn_signals',
      'gmgn_smartmoney_wallet_stats',
      'gmgn_twitter_messages',
      'gmgn_wallet_rank_capture_provenance',
      'gmgn_wallet_rank_snapshots',
      'measurement_plan_cache',
      'signal_pattern_snapshots',
      'tokens',
      'top_caller_callouts',
      'top_caller_collection_runs',
      'top_caller_outcomes',
      'top_caller_snapshot_rows',
      'top_caller_snapshots',
      'top_caller_tracked',
    ]);
    const version = database.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(version.user_version, latestSchemaVersion);
  } finally {
    database.close();
  }
});
