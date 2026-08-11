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
      'diagnostic_logs',
      'dune_import_batches',
      'dune_import_records',
      'dune_outcome_runs',
      'gmgn_browser_coverage_windows',
      'gmgn_browser_import_batches',
      'gmgn_polls',
      'gmgn_signals',
      'tokens',
    ]);
    const version = database.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(version.user_version, latestSchemaVersion);
  } finally {
    database.close();
  }
});
