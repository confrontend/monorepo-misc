import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
import pg from 'pg';
import { startPostgresOperation, cancelPostgresOperation, claimPostgresOperation, readPostgresOperation } from '../src/diagnostics.js';
import { PostgresIngestionRepository } from '../src/db/postgres-ingestion.js';
import { PostgresMarketDataWriter } from '../src/db/postgres-market-data.js';
import { runPostgresHistoricalWorker } from '../src/providers/postgres-historical-backfill.js';
import { readPostgresComparison } from '../src/research/postgres-comparison.js';
import { refreshPostgresOutcomes } from '../src/research/postgres-outcomes.js';

const { Pool } = pg;
const url = process.env.POSTGRES_URL ?? 'postgres://unusualwhales:unusualwhales-local-only@127.0.0.1:54329/unusualwhales';
const temporaryDatabaseName = `uw_e2e_${process.pid}_${Date.now()}`;
const databaseUrl = (database: string) => {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
};

const zipStoredCsv = (csv: string): Uint8Array => {
  const name = Buffer.from('fixture-option-trades.csv');
  const data = Buffer.from(csv);
  const compressed = deflateRawSync(data);
  const header = Buffer.alloc(30 + name.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  name.copy(header, 30);
  return Buffer.concat([header, compressed]);
};

const bars = (symbol: string, timeframe: '1m' | '1d', closes: Array<[string, number]>) => closes.map(([observedAt, close]) => ({
  symbol, timeframe, observedAt, close, open: close, high: close, low: close, volume: 1000, source: 'fixture', retrievedAt: '2026-01-10T00:00:00.000Z',
}));

test('live PostgreSQL fixture E2E: import -> bars -> outcomes -> comparison -> cancel/resume', { skip: !process.env.RUN_POSTGRES_E2E }, async () => {
  const admin = new Pool({ connectionString: databaseUrl('postgres') });
  await admin.query(`CREATE DATABASE "${temporaryDatabaseName}"`);
  const pool = new Pool({ connectionString: databaseUrl(temporaryDatabaseName) });
  const sourcePrefix = `e2e-${Date.now()}-`;
  const fixtureDay = new Date(Date.UTC(2200, 0, 6 + (Date.now() % 20) * 7));
  const fixtureDate = fixtureDay.toISOString().slice(0, 10);
  const nextFixtureDate = new Date(`${fixtureDate}T00:00:00.000Z`);
  nextFixtureDate.setUTCDate(nextFixtureDate.getUTCDate() + 1);
  const fixtureTo = nextFixtureDate.toISOString().slice(0, 10);
  const thirdFixtureDate = new Date(`${fixtureDate}T00:00:00.000Z`);
  thirdFixtureDate.setUTCDate(thirdFixtureDate.getUTCDate() + 4);
  const fixtureThreeDays = thirdFixtureDate.toISOString().slice(0, 10);
  const outcomeNow = new Date(`${fixtureDate}T00:00:00.000Z`);
  outcomeNow.setUTCDate(outcomeNow.getUTCDate() + 30);
  const keyDir = await mkdtemp(path.join(os.tmpdir(), 'uw-postgres-e2e-'));
  const keyFile = path.join(keyDir, 'key.txt');
  await writeFile(keyFile, 'fixture-key');
  let jobId: number | null = null;
  try {
    await pool.query(await readFile(path.join(process.cwd(), 'infra', 'postgres', '001_core.sql'), 'utf8'));
    await pool.query(await readFile(path.join(process.cwd(), 'infra', 'postgres', '002_research.sql'), 'utf8'));
    await pool.query('SELECT 1');
    const ingestion = new PostgresIngestionRepository(pool);
    const market = new PostgresMarketDataWriter(pool);
    await ingestion.ensureSchema();
    await market.ensureSchema();
    await pool.query(`DELETE FROM uw_historical_coverage WHERE signal_type='call_sweep' AND trading_date=$1`, [fixtureDate]);
    await pool.query(`DELETE FROM uw_import_batches WHERE query_json->>'from' LIKE '2200-%'`);

    const csv = [
      'id,executed_at,underlying_symbol,option_type,report_flags,option_chain_id,expiry,strike,premium,price,size,underlying_price,open_interest,volume,nbbo_bid,nbbo_ask,tags,canceled',
      `${sourcePrefix}call,${fixtureDate} 15:00:00+00,AAPL,call,{intermarket_sweep},chain,2200-02-20,100,10000,2.00,10,200,100,1000,1.99,2.01,{},false`,
      `${sourcePrefix}ignored,${fixtureDate} 15:01:00+00,AAPL,put,{intermarket_sweep},chain,2200-02-20,100,10000,2.00,10,200,100,1000,1.99,2.01,{},false`,
    ].join('\n') + '\n';
    const zip = zipStoredCsv(csv);
    let fetchCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      fetchCalls++;
      const requestUrl = String(input);
      if (requestUrl.includes(`/api/option-trades/full-tape/${fixtureDate}`)) {
        return new Response(zip, { status: 200, headers: { 'content-type': 'application/zip', 'content-length': String(zip.byteLength) } });
      }
      throw new Error(`unexpected fixture URL: ${requestUrl}`);
    };

    jobId = await startPostgresOperation(pool, `validation.postgres.historical.${sourcePrefix}`, '2200-01-12T00:00:00.000Z', {
      from: `${fixtureDate}T00:00:00.000Z`, to: `${fixtureTo}T00:00:00.000Z`, signalTypes: ['call_sweep'],
    });
    const imported = await runPostgresHistoricalWorker(pool, jobId, {
      apiKeyFile: keyFile,
      fetchImpl, now: () => outcomeNow, maxRequests: 2,
    });
    assert.equal(imported.status, 'completed');
    assert.equal(fetchCalls, 1, `${JSON.stringify(imported)} fetchCalls=${fetchCalls}`);
    assert.equal(imported.inserted, 1, JSON.stringify(imported));

    await market.upsertBars([
      ...bars('AAPL', '1m', [[`${fixtureDate}T15:00:00.000Z`, 200], [`${fixtureDate}T15:05:00.000Z`, 202], [`${fixtureDate}T15:30:00.000Z`, 203], [`${fixtureDate}T16:00:00.000Z`, 204]]),
      ...bars('AAPL', '1d', [[`${fixtureDate}T15:00:00.000Z`, 200], [`${fixtureTo}T15:00:00.000Z`, 205], [`${fixtureThreeDays}T15:00:00.000Z`, 210]]),
      ...bars('SPY', '1m', [[`${fixtureDate}T15:00:00.000Z`, 500], [`${fixtureDate}T15:05:00.000Z`, 501], [`${fixtureDate}T15:30:00.000Z`, 502], [`${fixtureDate}T16:00:00.000Z`, 503]]),
      ...bars('SPY', '1d', [[`${fixtureDate}T15:00:00.000Z`, 500], [`${fixtureTo}T15:00:00.000Z`, 501], [`${fixtureThreeDays}T15:00:00.000Z`, 502]]),
    ]);
    const outcomeRows = await refreshPostgresOutcomes(pool, { jobId, now: outcomeNow });
    assert.equal(outcomeRows, 5);

    const comparison = await readPostgresComparison(pool);
    const call = comparison.signals.find((signal) => signal.signalId === 'call_sweep');
    assert.ok(call);
    const outcomeDebug = await pool.query(`SELECT horizon, exclusion_reason, entry_price, outcome_price, spy_entry_price, spy_outcome_price FROM uw_signal_outcomes ORDER BY horizon`);
    assert.equal(call.outcomes.some((outcome) => outcome.sampleSize > 0), true, JSON.stringify({ outcomes: call.outcomes, outcomeDebug: outcomeDebug.rows }));

    const diagnostics = await pool.query(`SELECT (SELECT COUNT(*) FROM uw_option_trades WHERE source_trade_id LIKE $1) AS trades, (SELECT COUNT(*) FROM uw_market_bars WHERE source='fixture') AS bars, (SELECT COUNT(*) FROM uw_signal_outcomes WHERE trade_id IN (SELECT id FROM uw_option_trades WHERE source_trade_id LIKE $1)) AS outcomes, (SELECT status FROM uw_job_runs WHERE id=$2) AS status`, [`${sourcePrefix}%`, jobId]);
    assert.equal(Number(diagnostics.rows[0].trades), 1);
    assert.ok(Number(diagnostics.rows[0].bars) >= 14);
    assert.equal(Number(diagnostics.rows[0].outcomes), 5);
    assert.equal(diagnostics.rows[0].status, 'completed');

    const cancelledJob = await startPostgresOperation(pool, `validation.postgres.cancel.${sourcePrefix}`, '2200-02-01T00:00:00.000Z', { from: `${fixtureDate}T00:00:00.000Z`, to: `${fixtureTo}T00:00:00.000Z`, signalTypes: ['call_sweep'] });
    assert.equal(await cancelPostgresOperation(pool, cancelledJob, 'fixture cancellation'), true);
    assert.equal((await readPostgresOperation(pool, cancelledJob))?.status, 'cancelled');
    assert.equal(await claimPostgresOperation(pool, cancelledJob), null);
    const resumedJob = await startPostgresOperation(pool, `validation.postgres.resume.${sourcePrefix}`, '2200-02-01T00:00:00.000Z', { from: `${fixtureDate}T00:00:00.000Z`, to: `${fixtureTo}T00:00:00.000Z`, signalTypes: ['call_sweep'] });
    const resumed = await runPostgresHistoricalWorker(pool, resumedJob, { apiKeyFile: keyFile, fetchImpl, now: () => outcomeNow, maxRequests: 2 });
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.inserted, 0);
  } finally {
    await pool.query(`DELETE FROM uw_signal_outcomes WHERE trade_id IN (SELECT id FROM uw_option_trades WHERE source_trade_id LIKE $1)`, [`${sourcePrefix}%`]);
    await pool.query(`DELETE FROM uw_option_trades WHERE source_trade_id LIKE $1`, [`${sourcePrefix}%`]);
    await pool.query(`DELETE FROM uw_market_bars WHERE source='fixture'`);
    await pool.query(`DELETE FROM uw_historical_coverage WHERE signal_type='call_sweep' AND trading_date=$1`, [fixtureDate]);
    await pool.query(`DELETE FROM uw_import_batches WHERE query_json->>'from' LIKE '2200-%'`);
    if (jobId !== null) await pool.query('DELETE FROM uw_job_runs WHERE id=$1 OR kind LIKE $2', [jobId, `validation.postgres.%${sourcePrefix}`]);
    else await pool.query('DELETE FROM uw_job_runs WHERE kind LIKE $1', [`validation.postgres.%${sourcePrefix}`]);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS "${temporaryDatabaseName}"`);
    await admin.end();
    await rm(keyDir, { recursive: true, force: true });
  }
});
