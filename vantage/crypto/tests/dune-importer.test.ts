import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/platform/db/client.js';
import { importDuneFile, importDuneContent, type ImportLogger } from '../src/dune/ingest/importer.js';

const silentLogger: ImportLogger = { info() {}, warn() {}, error() {} };

test('Dune imports are idempotent and duplicate token addresses are skipped', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'crypto-dune-'));
  const file = path.join(directory, 'cohort.json');
  writeFileSync(file, JSON.stringify([
    { token_address: 'TokenA', symbol: 'AAA', first_trade_time: '2026-01-02T03:04:05.123456Z' },
    { token_address: 'TokenA', symbol: 'DUPLICATE', first_trade_time: '2026-02-01T00:00:00Z' },
  ]));
  const database = openDatabase(':memory:');

  try {
    const first = importDuneFile(database, file, silentLogger);
    const second = importDuneFile(database, file, silentLogger);
    assert.deepEqual(
      { imported: first.imported, skipped: first.skipped, errors: first.errors },
      { imported: 1, skipped: 1, errors: 0 },
    );
    assert.deepEqual(
      { imported: second.imported, skipped: second.skipped, errors: second.errors },
      { imported: 0, skipped: 2, errors: 0 },
    );
    assert.equal(second.duplicateFile, true);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM tokens').get() as { count: number }).count, 1);
    assert.equal((database.prepare('SELECT symbol FROM tokens').get() as { symbol: string }).symbol, 'AAA');
    assert.equal(
      (database.prepare('SELECT COUNT(*) AS count FROM dune_import_batches').get() as { count: number }).count,
      1,
    );
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the "token" column name (used by some Dune query exports) is recognized as the token address', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'crypto-dune-token-col-'));
  const file = path.join(directory, 'cohort.csv');
  writeFileSync(
    file,
    'token,first_trade_time,symbol,first_dex,first_tx\n'
    + '4LguLxz7EzU1Wk4shCYuzQm2QtGq3r8gKL6pPgsNpump,2026-07-01 00:00:01.000 UTC,Mayhem R,pumpdotfun,tx-1\n',
  );
  const database = openDatabase(':memory:');

  try {
    const summary = importDuneFile(database, file, silentLogger);
    assert.deepEqual(
      { imported: summary.imported, skipped: summary.skipped, errors: summary.errors },
      { imported: 1, skipped: 0, errors: 0 },
    );
    const row = database.prepare('SELECT token_address, symbol FROM tokens').get() as {
      token_address: string;
      symbol: string;
    };
    assert.equal(row.token_address, '4LguLxz7EzU1Wk4shCYuzQm2QtGq3r8gKL6pPgsNpump');
    assert.equal(row.symbol, 'Mayhem R');
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Dune first-trade timestamps retain exact source precision and formatting', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'crypto-dune-time-'));
  const file = path.join(directory, 'cohort.csv');
  const timestamp = '2026-01-02T03:04:05.123456Z';
  writeFileSync(file, `token_address,symbol,first_trade_time,first_dex,first_tx\nTokenB,BBB,${timestamp},raydium,tx-1\n`);
  const database = openDatabase(':memory:');

  try {
    importDuneFile(database, file, silentLogger);
    const row = database.prepare('SELECT first_trade_time FROM tokens WHERE token_address = ?')
      .get('TokenB') as { first_trade_time: string };
    assert.equal(row.first_trade_time, timestamp);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a targeted enrichment import is tagged with its own source and never overwrites an existing cohort row', () => {
  const database = openDatabase(':memory:');
  try {
    importDuneContent(database, 'ui-upload/cohort.json', JSON.stringify([
      { token_address: 'TokenC', symbol: 'FROM_COHORT', first_trade_time: '2026-01-01T00:00:00Z' },
    ]), silentLogger, () => new Date('2026-01-01T00:00:00Z'), 'dune');

    // A targeted lookup returns both an address already in the cohort and a brand-new one.
    const enrichment = importDuneContent(database, 'ui-upload/enrichment/lookup.json', JSON.stringify([
      { token_address: 'TokenC', symbol: 'SHOULD_NOT_OVERWRITE', first_trade_time: '2026-02-01T00:00:00Z' },
      { token_address: 'TokenD', symbol: 'NEW_FROM_ENRICHMENT', first_trade_time: '2026-02-02T00:00:00Z' },
    ]), silentLogger, () => new Date('2026-02-01T00:00:00Z'), 'dune-targeted-enrichment');

    assert.deepEqual(
      { imported: enrichment.imported, skipped: enrichment.skipped, errors: enrichment.errors },
      { imported: 1, skipped: 1, errors: 0 },
    );
    const existing = database.prepare('SELECT symbol, source FROM tokens WHERE token_address = ?').get('TokenC') as { symbol: string; source: string };
    assert.equal(existing.symbol, 'FROM_COHORT');
    assert.equal(existing.source, 'dune');
    const added = database.prepare('SELECT symbol, source FROM tokens WHERE token_address = ?').get('TokenD') as { symbol: string; source: string };
    assert.equal(added.symbol, 'NEW_FROM_ENRICHMENT');
    assert.equal(added.source, 'dune-targeted-enrichment');
  } finally {
    database.close();
  }
});

test('malformed Dune rows are retained in the audit log', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'crypto-dune-bad-'));
  const file = path.join(directory, 'cohort.json');
  writeFileSync(file, JSON.stringify([{ symbol: 'NO_ADDRESS', unexpected: { retained: true } }]));
  const database = openDatabase(':memory:');

  try {
    const summary = importDuneFile(database, file, silentLogger);
    assert.equal(summary.errors, 1);
    const row = database.prepare('SELECT status, errors, raw_payload FROM dune_import_records').get() as {
      status: string;
      errors: string;
      raw_payload: string;
    };
    assert.equal(row.status, 'error');
    assert.match(row.errors, /token_address/);
    assert.deepEqual(JSON.parse(row.raw_payload), { symbol: 'NO_ADDRESS', unexpected: { retained: true } });
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

