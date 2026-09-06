import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/platform/db/client.js';
import { applyMigrations, latestSchemaVersion } from '../src/platform/db/schema.js';
import { verifyDatabaseSchema } from '../src/platform/db/schemaVerification.js';

test('schema initialization creates V1 tables and is idempotent', () => {
  const database = openDatabase(':memory:');

  try {
    applyMigrations(database);
    const tables = database
      .prepare(
        `
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `,
      )
      .all()
      .map((row) => (row as { name: string }).name);
    assert.deepEqual(tables, [
      'copytrade_activity_probe_pages',
      'copytrade_activity_probe_runs',
      'copytrade_activity_reconstruction_runs',
      'copytrade_activity_reconstruction_steps',
      'copytrade_copy_simulation_leases',
      'copytrade_copy_simulation_match_index_runs',
      'copytrade_copy_simulation_matches',
      'copytrade_copy_simulation_runs',
      'copytrade_decision_calibration_runs',
      'copytrade_decision_calibration_wallets',
      'copytrade_dune_fetch_audits',
      'copytrade_evaluation_history',
      'copytrade_experiment_wallets',
      'copytrade_experiments',
      'copytrade_fetch_estimate',
      'copytrade_fetch_runs',
      'copytrade_gmgn_risk_stats',
      'copytrade_pattern_discovery_runs',
      'copytrade_report_cache',
      'copytrade_result_snapshots',
      'copytrade_trades',
      'copytrade_wallet_coverage',
      'copytrade_wallet_coverage_events',
      'copytrade_wallet_feature_snapshots',
      'copytrade_wallet_stats',
      'copytrade_wallet_stats_events',
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
      'pattern_discovery_data_revision',
      'signal_pattern_snapshots',
      'solana_benchmark_runs',
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

test('schema verification catches drift in an existing database', () => {
  const database = openDatabase(':memory:');
  try {
    verifyDatabaseSchema(database);
    database.exec('ALTER TABLE copytrade_dune_fetch_audits DROP COLUMN gmgn_screen_rule_version');
    assert.throws(() => verifyDatabaseSchema(database), /gmgn_screen_rule_version/);
  } finally {
    database.close();
  }
});

test('GMGN wallet stats history is append-only while latest cache remains separate', () => {
  const database = openDatabase(':memory:');
  try {
    database
      .prepare(
        `INSERT INTO copytrade_wallet_stats (wallet_address, chain, period, fetched_at, raw_payload) VALUES (?, ?, ?, ?, ?)`,
      )
      .run('W', 'sol', '30d', '2026-08-18T00:00:00.000Z', '{"realized_profit_pnl":0.1}');
    database
      .prepare(
        `INSERT INTO copytrade_wallet_stats_events (wallet_address, chain, period, fetched_at, raw_payload) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
      )
      .run(
        'W',
        'sol',
        '30d',
        '2026-08-18T00:00:00.000Z',
        '{"realized_profit_pnl":0.1}',
        'W',
        'sol',
        '30d',
        '2026-08-19T00:00:00.000Z',
        '{"realized_profit_pnl":0.2}',
      );
    database
      .prepare(
        `UPDATE copytrade_wallet_stats SET fetched_at = ?, raw_payload = ? WHERE wallet_address = ? AND chain = ? AND period = ?`,
      )
      .run('2026-08-19T00:00:00.000Z', '{"realized_profit_pnl":0.2}', 'W', 'sol', '30d');
    const rows = database
      .prepare(
        `SELECT fetched_at, raw_payload FROM copytrade_wallet_stats_events WHERE wallet_address = 'W' ORDER BY fetched_at`,
      )
      .all() as Array<{ fetched_at: string; raw_payload: string }>;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].raw_payload, '{"realized_profit_pnl":0.1}');
    assert.equal(rows[1].raw_payload, '{"realized_profit_pnl":0.2}');
    const latest = database
      .prepare(
        `SELECT fetched_at, raw_payload FROM copytrade_wallet_stats WHERE wallet_address = 'W' AND chain = 'sol' AND period = '30d'`,
      )
      .get() as { fetched_at: string; raw_payload: string };
    assert.equal(latest.fetched_at, '2026-08-19T00:00:00.000Z');
    assert.equal(latest.raw_payload, '{"realized_profit_pnl":0.2}');
  } finally {
    database.close();
  }
});
