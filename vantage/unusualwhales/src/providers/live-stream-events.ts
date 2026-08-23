import type { DatabaseSync } from 'node:sqlite';

export type LiveStreamEvent = {
  sourceEventId: string;
  topic: string;
  messageType?: string | null;
  eventAt?: string | null;
  publishedAt?: string | null;
  capturedAt: string;
  symbol?: string | null;
  rawPayload: string;
  validationErrors?: readonly string[];
};

export type LiveStreamPersistResult = { received: number; inserted: number; duplicates: number };

/**
 * Persists already-decoded provider stream messages idempotently. The transport
 * is intentionally outside this function: Kafka offsets/WebSocket reconnects
 * can call it with the same message again without duplicating evidence.
 */
export const persistLiveStreamEvents = (database: DatabaseSync, events: Iterable<LiveStreamEvent>): LiveStreamPersistResult => {
  const insert = database.prepare(`INSERT OR IGNORE INTO uw_stream_events
    (source_event_id,topic,message_type,event_at,published_at,captured_at,symbol,raw_payload,validation_errors)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  let received = 0;
  let inserted = 0;
  for (const event of events) {
    received++;
    if (!event.sourceEventId.trim() || !event.topic.trim() || !event.capturedAt || !event.rawPayload) continue;
    const result = insert.run(event.sourceEventId, event.topic.trim(), event.messageType ?? null,
      event.eventAt ?? null, event.publishedAt ?? null, event.capturedAt,
      event.symbol?.trim().toUpperCase() || null, event.rawPayload,
      JSON.stringify(event.validationErrors ?? []));
    inserted += Number(result.changes);
  }
  return { received, inserted, duplicates: received - inserted };
};
