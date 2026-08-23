import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase } from '../src/db/client.js';
import { persistLiveStreamEvents } from '../src/providers/live-stream-events.js';

test('persists forward-only stream messages idempotently and normalizes symbols', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'unusual-whales-stream-'));
  const database = createDatabase(path.join(directory, 'test.sqlite'));
  try {
    const event = { sourceEventId: 'flow-1', topic: 'flow-alerts', messageType: 'FlowAlert', capturedAt: '2026-08-21T00:00:00Z', symbol: 'aapl', rawPayload: '{"id":"flow-1"}' };
    assert.deepEqual(persistLiveStreamEvents(database, [event, event]), { received: 2, inserted: 1, duplicates: 1 });
    const row = database.prepare('SELECT topic,message_type,symbol FROM uw_stream_events WHERE source_event_id=?').get('flow-1') as { topic: string; message_type: string; symbol: string };
    assert.equal(row.topic, 'flow-alerts');
    assert.equal(row.message_type, 'FlowAlert');
    assert.equal(row.symbol, 'AAPL');
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
