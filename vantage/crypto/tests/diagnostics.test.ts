import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/db/client.js';
import { logDiagnostic, readRecentDiagnostics } from '../src/db/diagnostics.js';

test('diagnostic logs are appended and read back newest first', () => {
  const database = openDatabase(':memory:');

  try {
    logDiagnostic(database, {
      level: 'info',
      event: 'request-complete',
      method: 'POST',
      path: '/api/import-dune',
      status: 200,
      durationMs: 12,
      requestBytes: 512,
    });
    logDiagnostic(database, {
      level: 'warn',
      event: 'client-disconnected',
      method: 'POST',
      path: '/api/import-dune',
      durationMs: 4021,
      requestBytes: 1_700_000,
      message: 'Connection closed before a response was sent (client abort or connection reset).',
    });
    logDiagnostic(database, {
      level: 'error',
      event: 'request-error',
      method: 'POST',
      path: '/api/gmgn',
      status: 400,
      message: 'Boom',
      detail: { stack: 'Error: Boom\n  at somewhere' },
    });

    const logs = readRecentDiagnostics(database);
    assert.equal(logs.length, 3);
    assert.equal(logs[0]!.event, 'request-error');
    assert.equal(logs[0]!.level, 'error');
    assert.equal(JSON.parse(logs[0]!.detail!).stack.startsWith('Error: Boom'), true);
    assert.equal(logs[1]!.event, 'client-disconnected');
    assert.equal(logs[1]!.requestBytes, 1_700_000);
    assert.equal(logs[2]!.event, 'request-complete');

    const limited = readRecentDiagnostics(database, 1);
    assert.equal(limited.length, 1);
    assert.equal(limited[0]!.event, 'request-error');
  } finally {
    database.close();
  }
});

test('a failing insert is swallowed so logging never breaks the caller', () => {
  const database = openDatabase(':memory:');

  try {
    // An invalid level violates the CHECK constraint; logDiagnostic must not throw.
    assert.doesNotThrow(() => {
      logDiagnostic(database, { level: 'critical' as never, event: 'bad-level' });
    });
    assert.equal(readRecentDiagnostics(database).length, 0);
  } finally {
    database.close();
  }
});

test('diagnostics redact common API-key and authorization encodings before storage', () => {
  const database = openDatabase(':memory:');
  try {
    logDiagnostic(database, {
      level: 'error', event: 'request-error',
      message: 'GMGN_API_KEY=not-for-storage Authorization: Bearer also-not-for-storage',
      detail: { api_key: 'not-for-storage', nested: 'Authorization: Bearer also-not-for-storage' },
    });
    const saved = readRecentDiagnostics(database, 1)[0]!;
    assert.doesNotMatch(saved.message!, /not-for-storage|also-not-for-storage/);
    assert.doesNotMatch(saved.detail!, /not-for-storage|also-not-for-storage/);
    assert.match(saved.message!, /\[REDACTED\]/);
  } finally {
    database.close();
  }
});
