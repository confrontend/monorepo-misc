import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresMarketDataWriter } from '../src/db/postgres-market-data.js';

const bar = { symbol: 'abc', timeframe: '1m' as const, observedAt: '2026-01-02T15:00:00Z', close: 101, source: 'yahoo_chart' };

test('PostgreSQL market-bar writer upserts normalized bars transactionally', async () => {
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => { queries.push(sql); return { rowCount: sql.startsWith('INSERT') ? 1 : 0, rows: [] }; },
    release: () => undefined,
  };
  const pool = { connect: async () => client, query: async () => ({ rowCount: 0, rows: [] }) } as never;
  const writer = new PostgresMarketDataWriter(pool);
  assert.equal(await writer.upsertBars([bar, { ...bar, close: Number.NaN }]), 1);
  assert.equal(queries[0], 'BEGIN');
  assert.match(queries[1], /ON CONFLICT \(symbol,timeframe,observed_at\) DO UPDATE/);
  assert.equal(queries.at(-1), 'COMMIT');
});

test('PostgreSQL market-bar writer rolls back on database errors', async () => {
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => { queries.push(sql); if (sql.startsWith('INSERT')) throw new Error('db write failed'); return { rowCount: 0, rows: [] }; },
    release: () => undefined,
  };
  const pool = { connect: async () => client, query: async () => ({ rowCount: 0, rows: [] }) } as never;
  await assert.rejects(() => new PostgresMarketDataWriter(pool).upsertBars([bar]), /db write failed/);
  assert.equal(queries.at(-1), 'ROLLBACK');
});
