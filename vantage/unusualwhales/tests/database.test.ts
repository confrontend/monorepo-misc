import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createDatabase } from '../src/db/client.js';

test('creates the initial SQLite schema', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'unusual-whales-'));
  const databasePath = path.join(directory, 'test.sqlite');
  const database = createDatabase(databasePath);

  try {
    const row = database.prepare('SELECT value FROM app_metadata WHERE key = ?').get('schema_version') as { value: string };
    assert.equal(row.value, '8');
    const columns = (database.prepare('PRAGMA table_info(uw_historical_coverage)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(columns.includes('bytes_received'));
    assert.ok(columns.includes('bytes_expected'));
    assert.ok(columns.includes('progress_updated_at'));
    // Without this, a connection that hits WAL lock contention from another connection's
    // in-flight write throws SQLITE_BUSY immediately instead of waiting and retrying -- this
    // is what let /api/signals/comparison intermittently fail behind a long outcome write.
    const busyTimeout = database.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    assert.ok(busyTimeout.timeout >= 5000, `expected a busy_timeout of at least 5000ms, got ${busyTimeout.timeout}`);
    const comparisonCacheColumns = (database.prepare('PRAGMA table_info(uw_comparison_cache)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.deepEqual(comparisonCacheColumns.sort(), ['generated_at', 'id', 'payload_json']);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('opening a pre-existing (schema_version 6) database adds the progress-tracking columns', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'unusual-whales-'));
  const databasePath = path.join(directory, 'legacy.sqlite');

  // Recreates the exact shape uw_historical_coverage had before bytes_received/bytes_expected/
  // progress_updated_at existed, to prove createDatabase() migrates a real pre-existing file
  // rather than only ever seeing its own freshly created schema.
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO app_metadata (key, value) VALUES ('schema_version', '6');
    CREATE TABLE uw_historical_coverage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_type TEXT NOT NULL,
      trading_date TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed')),
      received_count INTEGER NOT NULL DEFAULT 0,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      UNIQUE(signal_type, trading_date)
    );
  `);
  legacy.prepare(`INSERT INTO uw_historical_coverage (signal_type, trading_date, endpoint, started_at, status) VALUES (?, ?, ?, ?, 'processing')`)
    .run('call_sweep', '2026-01-01', '/api/option-trades/full-tape/2026-01-01', '2026-01-10T00:00:00.000Z');
  legacy.close();

  const database = createDatabase(databasePath);
  try {
    const row = database.prepare('SELECT value FROM app_metadata WHERE key = ?').get('schema_version') as { value: string };
    assert.equal(row.value, '8');
    const columns = (database.prepare('PRAGMA table_info(uw_historical_coverage)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(columns.includes('bytes_received'));
    // The pre-existing row must survive the migration untouched, not be dropped or reset.
    const preserved = database.prepare('SELECT signal_type AS signalType, status FROM uw_historical_coverage WHERE trading_date = ?').get('2026-01-01') as { signalType: string; status: string };
    assert.equal(preserved.signalType, 'call_sweep');
    assert.equal(preserved.status, 'processing');
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
