import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/platform/db/client.js';
import { readDataQuality } from '../src/signals/quality.js';
import { storeGmgnSignal } from '../src/gmgn/capture/ingest.js';

test('data quality links GMGN signals to cohort tokens without dropping unmatched observations', () => {
  const database = openDatabase(':memory:');
  try {
    database
      .prepare(
        `
      INSERT INTO tokens (token_address, source, imported_at, raw_payload)
      VALUES (?, 'dune', ?, '{}'), (?, 'dune', ?, '{}')
    `,
      )
      .run('MatchedToken', '2026-08-09T00:00:00.000Z', 'SilentToken', '2026-08-09T00:00:00.000Z');

    storeGmgnSignal(
      database,
      {
        observed_at: '2026-08-09T01:00:00Z',
        token_address: 'MatchedToken',
        signal_type: 'buy',
      },
      { capturedAt: new Date('2026-08-09T01:00:01Z'), logger: { warn() {} } },
    );
    storeGmgnSignal(
      database,
      {
        observed_at: '2026-08-09T02:00:00Z',
        token_address: 'OutsideCohort',
        signal_type: 'watch',
      },
      { capturedAt: new Date('2026-08-09T02:00:01Z'), logger: { warn() {} } },
    );
    storeGmgnSignal(
      database,
      { signal_type: 'malformed' },
      {
        capturedAt: new Date('2026-08-09T03:00:00Z'),
        logger: { warn() {} },
      },
    );

    assert.deepEqual(readDataQuality(database), {
      cohortTokenCount: 2,
      signalCount: 3,
      matchedSignalCount: 1,
      unmatchedSignalCount: 2,
      tokensWithSignals: 1,
      tokensWithoutSignals: 1,
      coveragePercent: 33.3,
      missingTokenAddressSignals: 1,
      missingSignalTypeSignals: 0,
      missingObservedAtSignals: 1,
      signalsWithValidationIssues: 3,
    });
  } finally {
    database.close();
  }
});
