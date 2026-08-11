import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/db/client.js';
import { readDatabaseStats } from '../src/db/stats.js';
import { storeGmgnSignal } from '../src/gmgn/ingest.js';

test('database statistics include counts, timestamp ranges, and signal type groups', () => {
  const database = openDatabase(':memory:');

  try {
    database.prepare(`
      INSERT INTO tokens
        (token_address, first_trade_time, source, imported_at, raw_payload)
      VALUES (?, ?, 'dune', ?, '{}'), (?, ?, 'dune', ?, '{}')
    `).run(
      'TokenEarly', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z',
      'TokenLate', '2026-01-31T00:00:00Z', '2026-02-01T00:00:00Z',
    );
    storeGmgnSignal(database, {
      observed_at: '2026-02-01T00:00:00Z', token_address: 'TokenEarly', signal_type: 'buy',
    }, { capturedAt: new Date('2026-02-01T00:00:01Z'), logger: { warn() {} } });
    storeGmgnSignal(database, {
      observed_at: '2026-02-02T00:00:00Z', token_address: 'TokenLate', signal_type: 'buy',
    }, { capturedAt: new Date('2026-02-02T00:00:02Z'), logger: { warn() {} } });
    storeGmgnSignal(database, {
      observed_at: '2026-02-03T00:00:00Z', token_address: 'TokenLate', signal_type: 'watch',
    }, { capturedAt: new Date('2026-02-03T00:00:03Z'), logger: { warn() {} } });

    const stats = readDatabaseStats(database);
    assert.equal(stats.tokenCount, 2);
    assert.equal(stats.gmgnSignalCount, 3);
    assert.deepEqual(stats.tokenFirstTrade, {
      earliest: '2026-01-01T00:00:00Z',
      latest: '2026-01-31T00:00:00Z',
    });
    assert.deepEqual(stats.gmgnObserved, {
      earliest: '2026-02-01T00:00:00.000Z',
      latest: '2026-02-03T00:00:00.000Z',
    });
    assert.deepEqual(stats.signalsByType, [
      { signalType: 'buy', count: 2 },
      { signalType: 'watch', count: 1 },
    ]);
  } finally {
    database.close();
  }
});

