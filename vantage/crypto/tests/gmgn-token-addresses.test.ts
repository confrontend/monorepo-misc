import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/platform/db/client.js';
import { listGmgnTokenAddresses } from '../src/gmgn/tokenAddresses.js';
import { storeGmgnSignal } from '../src/gmgn/capture/ingest.js';

test('lists unique GMGN-observed token addresses not already in the Dune cohort', () => {
  const database = openDatabase(':memory:');
  try {
    database
      .prepare(
        `
      INSERT INTO tokens (token_address, source, imported_at, raw_payload)
      VALUES ('AlreadyInCohort', 'dune', '2026-08-09T00:00:00Z', '{}')
    `,
      )
      .run();

    storeGmgnSignal(
      database,
      { observed_at: '2026-08-09T01:00:00Z', token_address: 'AlreadyInCohort', signal_type: 'buy' },
      { capturedAt: new Date('2026-08-09T01:00:01Z'), logger: { warn() {} } },
    );
    storeGmgnSignal(
      database,
      { observed_at: '2026-08-09T02:00:00Z', token_address: 'NewFromGmgn2', signal_type: 'buy' },
      { capturedAt: new Date('2026-08-09T02:00:01Z'), logger: { warn() {} } },
    );
    storeGmgnSignal(
      database,
      { observed_at: '2026-08-09T03:00:00Z', token_address: 'NewFromGmgn1', signal_type: 'watch' },
      { capturedAt: new Date('2026-08-09T03:00:01Z'), logger: { warn() {} } },
    );
    // Same unmatched address observed twice — must appear once in the address list.
    storeGmgnSignal(
      database,
      { observed_at: '2026-08-09T04:00:00Z', token_address: 'NewFromGmgn1', signal_type: 'watch' },
      { capturedAt: new Date('2026-08-09T04:00:01Z'), logger: { warn() {} } },
    );
    storeGmgnSignal(
      database,
      { observed_at: '2026-08-09T05:00:00Z', signal_type: 'malformed' },
      { capturedAt: new Date('2026-08-09T05:00:01Z'), logger: { warn() {} } },
    );

    const summary = listGmgnTokenAddresses(database);
    assert.deepEqual(summary.addresses, ['NewFromGmgn1', 'NewFromGmgn2']);
    assert.equal(summary.unmatchedToCohort, 2);
    assert.equal(summary.total, 3);
    assert.equal(summary.matchedToCohort, 1);
  } finally {
    database.close();
  }
});

test('returns an empty summary for a database with no GMGN signals', () => {
  const database = openDatabase(':memory:');
  try {
    assert.deepEqual(listGmgnTokenAddresses(database), {
      addresses: [],
      total: 0,
      matchedToCohort: 0,
      unmatchedToCohort: 0,
    });
  } finally {
    database.close();
  }
});
