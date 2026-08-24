import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/platform/db/client.js';
import { storeGmgnSignal } from '../src/gmgn/capture/ingest.js';
import { triggerBounds } from '../src/gmgn/capture/polls.js';
import fixture from './fixtures/gmgn-signal-response.json' with { type: 'json' };

test('GMGN ingestion preserves the complete raw payload', () => {
  const database = openDatabase(':memory:');
  const rawEvent = {
    observed_at: '2026-03-01T10:00:00-08:00',
    token_address: 'TokenC',
    signal_type: 'smart_money_buy',
    market_cap: 123456,
    triggering_wallet: 'Wallet1',
    raw_wallet_labels: ['smart-money', { confidence: 0.8 }],
    source_url: 'https://example.test/signal/1',
    undocumented_nested_data: { must: ['remain', 'intact'] },
  };

  try {
    const stored = storeGmgnSignal(database, rawEvent, {
      capturedAt: new Date('2026-03-01T18:00:00.250Z'),
      logger: { warn() {} },
    });
    const row = database.prepare('SELECT * FROM gmgn_signals WHERE id = ?').get(stored.id) as {
      observed_at: string;
      ingestion_latency_ms: number;
      raw_payload: string;
      raw_wallet_labels: string;
    };
    assert.equal(row.observed_at, '2026-03-01T18:00:00.000Z');
    assert.equal(row.ingestion_latency_ms, 250);
    assert.deepEqual(JSON.parse(row.raw_payload), rawEvent);
    assert.deepEqual(JSON.parse(row.raw_wallet_labels), rawEvent.raw_wallet_labels);
  } finally {
    database.close();
  }
});

test('missing optional GMGN fields remain null and are logged explicitly', () => {
  const database = openDatabase(':memory:');
  const warnings: string[] = [];

  try {
    storeGmgnSignal(
      database,
      {
        observed_at: '2026-03-02T00:00:00Z',
        token_address: 'TokenD',
        signal_type: 'watch',
      },
      {
        capturedAt: new Date('2026-03-02T00:00:01Z'),
        logger: { warn: (message) => warnings.push(message) },
      },
    );
    const row = database
      .prepare(
        `
      SELECT market_cap, triggering_wallet, raw_wallet_labels, source_url, validation_errors
      FROM gmgn_signals
    `,
      )
      .get() as Record<string, number | string | null>;
    assert.equal(row.market_cap, null);
    assert.equal(row.triggering_wallet, null);
    assert.equal(row.raw_wallet_labels, null);
    assert.equal(row.source_url, null);
    assert.match(String(row.validation_errors), /missing optional field: market_cap/);
    assert.equal(warnings.length, 1);
  } finally {
    database.close();
  }
});

test('missing required normalized GMGN fields do not discard the raw observation', () => {
  const database = openDatabase(':memory:');

  try {
    storeGmgnSignal(database, { unknown_event: true }, { logger: { warn() {} } });
    const row = database
      .prepare('SELECT raw_payload, token_address, signal_type FROM gmgn_signals')
      .get() as {
      raw_payload: string;
      token_address: string | null;
      signal_type: string | null;
    };
    assert.deepEqual(JSON.parse(row.raw_payload), { unknown_event: true });
    assert.equal(row.token_address, null);
    assert.equal(row.signal_type, null);
  } finally {
    database.close();
  }
});

test('GMGN source event identity prevents duplicate event rows while retaining the first raw event', () => {
  const database = openDatabase(':memory:');
  const rawEvent = {
    id: 'gmgn-event-42',
    token_address: 'TokenE',
    signal_type: 12,
    trigger_at: 1_772_359_200,
    trigger_mc: 25_000,
    first_trigger_mc: 20_000,
    market_cap: 30_000,
    ath: 32_000,
    signal_times: 2,
    signal_times_by_type: { 12: 2 },
    cur_data: { liquidity: 9_000 },
  };
  try {
    const first = storeGmgnSignal(database, rawEvent, {
      source: 'gmgn-cli',
      chain: 'sol',
      capturedAt: new Date('2026-03-01T12:00:00Z'),
      logger: { warn() {} },
    });
    const second = storeGmgnSignal(database, rawEvent, {
      source: 'gmgn-cli',
      chain: 'sol',
      capturedAt: new Date('2026-03-01T12:01:00Z'),
      logger: { warn() {} },
    });
    const row = database
      .prepare(
        `
      SELECT source, chain, source_event_id, trigger_at, trigger_mc, first_trigger_mc,
             query_market_cap, query_ath, raw_payload
      FROM gmgn_signals
    `,
      )
      .get() as Record<string, string | number>;
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(first.id, second.id);
    const count = (
      database.prepare('SELECT COUNT(*) AS count FROM gmgn_signals').get() as { count: number }
    ).count;
    assert.equal(count, 1);
    assert.equal(row.source, 'gmgn-cli');
    assert.equal(row.chain, 'sol');
    assert.equal(row.source_event_id, 'gmgn-event-42');
    assert.equal(row.trigger_at, '2026-03-01T10:00:00.000Z');
    assert.equal(row.trigger_mc, 25_000);
    assert.equal(row.first_trigger_mc, 20_000);
    assert.equal(row.query_market_cap, 30_000);
    assert.equal(row.query_ath, 32_000);
    assert.deepEqual(JSON.parse(String(row.raw_payload)), rawEvent);
  } finally {
    database.close();
  }
});

test('redacted fixture preserves documented source fields and trigger bounds', () => {
  const database = openDatabase(':memory:');
  try {
    const event = fixture[0] as Record<string, unknown>;
    const stored = storeGmgnSignal(database, event, {
      source: 'gmgn-cli',
      chain: 'sol',
      logger: { warn() {} },
    });
    assert.equal(stored.sourceEventId, 'fixture-event-001');
    assert.equal(stored.signalType, '12');
    assert.equal(stored.triggerMc, 25_000);
    assert.equal(stored.queryMarketCap, 30_000);
    assert.equal(triggerBounds(fixture).oldestTriggerAt, '2026-03-01T10:00:00.000Z');
    assert.equal(triggerBounds(fixture).newestTriggerAt, '2026-03-01T10:00:00.000Z');
  } finally {
    database.close();
  }
});
