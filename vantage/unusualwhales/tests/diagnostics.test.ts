import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../src/db/client.js';
import { finishOperation, readDiagnostics, startOperation } from '../src/diagnostics.js';

test('diagnostics reports schema, operation status, and persisted error details', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'uw-diagnostics-'));
  const database = createDatabase(path.join(directory, 'diagnostics.sqlite'));
  const operationId = startOperation(database, 'test.operation', '2026-08-18T20:00:00.000Z');
  finishOperation(database, operationId, 'failed', { provider: 'fixture' }, 'fixture failure', '2026-08-18T20:00:01.000Z');
  const diagnostics = readDiagnostics(database);
  assert.equal(diagnostics.database.schemaVersion, '8');
  const latest = diagnostics.recentOperations[0] as Record<string, unknown>;
  assert.equal(latest.status, 'failed');
  assert.equal(latest.error, 'fixture failure');
  assert.deepEqual(latest.details, { provider: 'fixture' });
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

test('diagnostics reports the single in-flight historical day with its live byte progress', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'uw-diagnostics-'));
  const database = createDatabase(path.join(directory, 'diagnostics.sqlite'));

  assert.equal(readDiagnostics(database).activeHistoricalDay, null);

  database.prepare(`INSERT INTO uw_historical_coverage (signal_type, trading_date, endpoint, started_at, status, bytes_expected)
    VALUES ('call_sweep', '2026-01-01', '/api/option-trades/full-tape/2026-01-01', '2026-01-10T00:00:00.000Z', 'processing', 1400000000)`).run();
  database.prepare(`UPDATE uw_historical_coverage SET bytes_received = ?, progress_updated_at = ? WHERE trading_date = '2026-01-01'`)
    .run(350_000_000, '2026-01-10T00:00:05.000Z');

  const active = readDiagnostics(database).activeHistoricalDay as Record<string, unknown>;
  assert.equal(active.signalType, 'call_sweep');
  assert.equal(active.tradingDate, '2026-01-01');
  assert.equal(active.bytesReceived, 350_000_000);
  assert.equal(active.bytesExpected, 1_400_000_000);

  database.prepare(`UPDATE uw_historical_coverage SET status = 'completed' WHERE trading_date = '2026-01-01'`).run();
  assert.equal(readDiagnostics(database).activeHistoricalDay, null);

  database.close();
  rmSync(directory, { recursive: true, force: true });
});
