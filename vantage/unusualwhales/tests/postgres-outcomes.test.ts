import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshPostgresOutcomes } from '../src/research/postgres-outcomes.js';

type Row = Record<string, unknown>;

class FakePostgresClient {
  readonly calls: string[] = [];
  readonly outcomes: Row[] = [];
  readonly checkpoints: Row[] = [];
  private readonly trades = [
    { id: 1, underlying_symbol: 'ABC', executed_at: '2026-01-02T15:00:00.000Z', signal_type: 'call_sweep' },
    { id: 2, underlying_symbol: 'ABC', executed_at: '2026-01-02T15:02:00.000Z', signal_type: 'call_sweep' },
  ];
  private readonly bars = [
    ['ABC', '1m', '2026-01-02T15:00:00.000Z', 100], ['ABC', '1m', '2026-01-02T15:05:00.000Z', 102],
    ['SPY', '1m', '2026-01-02T15:00:00.000Z', 500], ['SPY', '1m', '2026-01-02T15:05:00.000Z', 501],
  ];

  async query(text: string, values: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
    this.calls.push(text.trim().split(/\s+/).slice(0, 2).join(' '));
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (text.includes('CREATE SEQUENCE IF NOT EXISTS uw_signal_outcomes_id_seq')) return { rows: [], rowCount: 0 };
    if (text.includes('COUNT(*)::bigint')) return { rows: [{ count: '2' }], rowCount: 1 };
    if (text.includes('SELECT id, underlying_symbol')) {
      const after = values.length === 4 ? String(values[0]) : null;
      const rows = after ? [] : this.trades;
      return { rows, rowCount: rows.length };
    }
    if (text.includes('SELECT observed_at, close')) {
      const [symbol, timeframe, at, strict] = values.map(String);
      const row = this.bars
        .filter(([s, tf, observed]) => s === symbol && tf === timeframe && new Date(String(observed)).getTime() >= new Date(at).getTime() && (!strict || new Date(String(observed)).getTime() > new Date(strict).getTime()))
        .sort((a, b) => new Date(String(a[2])).getTime() - new Date(String(b[2])).getTime())[0];
      return { rows: row ? [{ observed_at: row[2], close: row[3] }] : [], rowCount: row ? 1 : 0 };
    }
    if (text.includes('INSERT INTO uw_signal_outcomes')) {
      this.outcomes.push(Object.fromEntries(['tradeId', 'horizon', 'entryAt', 'entryPrice', 'outcomeAt', 'outcomePrice', 'spyEntryPrice', 'spyOutcomePrice', 'returnPct', 'spyReturnPct', 'excessReturnPct', 'exclusionReason', 'calculatedAt'].map((key, i) => [key, values[i]])));
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('INSERT INTO uw_outcome_checkpoints')) { this.checkpoints.push({ values }); return { rows: [], rowCount: 1 }; }
    if (text.includes('DELETE FROM uw_outcome_checkpoints')) { this.checkpoints.length = 0; return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 1 };
  }
  release() { /* fake pool client */ }
}

test('PostgreSQL outcome engine preserves matching, overlap, maturity, SPY excess, and checkpoint cleanup', async () => {
  const client = new FakePostgresClient();
  const pool = { connect: async () => client } as never;
  const written = await refreshPostgresOutcomes(pool, { jobId: 77, now: new Date('2026-01-03T00:00:00.000Z') });
  assert.equal(written, 16);
  assert.equal(client.outcomes.length, 16);
  const first = client.outcomes.find((row) => row.tradeId === 1 && row.horizon === '+5m')!;
  assert.equal(first.entryPrice, 100);
  assert.equal(first.outcomePrice, 102);
  assert.equal(first.excessReturnPct, 1.8);
  const overlapping = client.outcomes.find((row) => row.tradeId === 2 && row.horizon === '+5m')!;
  assert.equal(overlapping.exclusionReason, 'overlapping_event');
  assert.equal(overlapping.outcomePrice, null);
  assert.equal(client.checkpoints.length, 0, 'successful completion removes the resumable checkpoint');
  assert.ok(client.calls.includes('BEGIN'));
  assert.ok(client.calls.includes('COMMIT'));
});

test('PostgreSQL outcome engine rolls back the active batch on a write failure', async () => {
  const client = new FakePostgresClient();
  const original = client.query.bind(client);
  client.query = async (text: string, values: unknown[] = []) => {
    if (text.includes('INSERT INTO uw_signal_outcomes')) throw new Error('simulated write failure');
    return original(text, values);
  };
  const pool = { connect: async () => client } as never;
  await assert.rejects(() => refreshPostgresOutcomes(pool, { jobId: 78, now: new Date('2026-01-03T00:00:00.000Z') }), /simulated write failure/);
  assert.ok(client.calls.includes('ROLLBACK'));
  assert.equal(client.checkpoints.length, 0);
});

test('PostgreSQL outcome engine never writes a future outcome before maturity', async () => {
  const client = new FakePostgresClient();
  const pool = { connect: async () => client } as never;
  await refreshPostgresOutcomes(pool, { jobId: 79, now: new Date('2026-01-02T15:02:00.000Z') });
  const row = client.outcomes.find((candidate) => candidate.tradeId === 1 && candidate.horizon === '+5m')!;
  assert.equal(row.exclusionReason, 'outcome_not_mature');
  assert.equal(row.outcomePrice, null);
});
