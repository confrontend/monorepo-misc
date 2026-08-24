import type { DatabaseSync } from 'node:sqlite';
import type { NormalizedGmgnSignal, StoredGmgnSignal } from '../models.js';

export interface GmgnIngestionLogger {
  warn: (message: string) => void;
}

export interface GmgnIngestionOptions {
  capturedAt?: Date;
  logger?: GmgnIngestionLogger;
  source?: string;
  chain?: string;
}

const defaultLogger: GmgnIngestionLogger = {
  warn: (message) => console.warn(message),
};

const textOrNull = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const textOrNumberOrNull = (value: unknown): string | null =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : textOrNull(value);

const numberOrNull = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const utcTimestampOrNull = (value: unknown, errors: string[]): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }
  const input = textOrNull(value);
  if (!input) return null;
  // A source timestamp with no zone is treated as UTC, never as the collector machine's zone.
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(input);
  const timestamp = new Date(hasExplicitZone ? input : `${input}Z`);
  if (Number.isNaN(timestamp.getTime())) {
    errors.push('invalid field: observed_at');
    return null;
  }
  return timestamp.toISOString();
};

const rawObject = (rawEvent: unknown): Record<string, unknown> => {
  if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) return {};
  return rawEvent as Record<string, unknown>;
};

export const normalizeGmgnSignal = (
  rawEvent: unknown,
  capturedAt: Date,
): { signal: NormalizedGmgnSignal; validationErrors: string[] } => {
  const event = rawObject(rawEvent);
  const validationErrors: string[] = [];
  if (Object.keys(event).length === 0) validationErrors.push('raw event is not an object');

  const triggerAt = utcTimestampOrNull(event.trigger_at, validationErrors);
  const observedAt = utcTimestampOrNull(event.observed_at ?? event.trigger_at, validationErrors);
  const tokenAddress = textOrNull(event.token_address);
  const signalType = textOrNumberOrNull(event.signal_type);
  const marketCap = numberOrNull(event.market_cap);
  const triggeringWallet = textOrNull(event.triggering_wallet);
  const rawWalletLabels = event.raw_wallet_labels ?? null;
  const sourceUrl = textOrNull(event.source_url);
  const source = textOrNull(event.source);
  const chain = textOrNull(event.chain);
  const sourceEventId = textOrNumberOrNull(event.id);

  if (!observedAt && !validationErrors.includes('invalid field: observed_at')) {
    validationErrors.push('missing field: observed_at');
  }
  if (!tokenAddress) validationErrors.push('missing required field: token_address');
  if (!signalType) validationErrors.push('missing required field: signal_type');
  if (event.market_cap === undefined) validationErrors.push('missing optional field: market_cap');
  else if (marketCap === null) validationErrors.push('invalid optional field: market_cap');
  if (!triggeringWallet) validationErrors.push('missing optional field: triggering_wallet');
  if (event.raw_wallet_labels === undefined)
    validationErrors.push('missing optional field: raw_wallet_labels');
  if (!sourceUrl) validationErrors.push('missing optional field: source_url');

  const ingestionLatencyMs = observedAt
    ? capturedAt.getTime() - new Date(observedAt).getTime()
    : null;

  return {
    signal: {
      observedAt,
      tokenAddress,
      signalType,
      marketCap,
      triggeringWallet,
      rawWalletLabels,
      sourceUrl,
      ingestionLatencyMs,
      source,
      chain,
      sourceEventId,
      triggerAt,
      triggerMc: numberOrNull(event.trigger_mc),
      firstTriggerMc: numberOrNull(event.first_trigger_mc),
      signalTimes: numberOrNull(event.signal_times),
      signalTimesByType: event.signal_times_by_type ?? null,
      queryMarketCap: numberOrNull(event.market_cap),
      queryAth: numberOrNull(event.ath),
      queryCurData: event.cur_data ?? null,
    },
    validationErrors,
  };
};

/**
 * Append one raw GMGN observation. Missing normalized fields never prevent raw capture.
 * The caller can later be a browser/network/API adapter without changing persistence.
 */
export const storeGmgnSignal = (
  database: DatabaseSync,
  rawEvent: unknown,
  options: GmgnIngestionOptions = {},
): StoredGmgnSignal => {
  const capturedAtDate = options.capturedAt ?? new Date();
  const capturedAt = capturedAtDate.toISOString();
  const logger = options.logger ?? defaultLogger;
  const rawPayload = JSON.stringify(rawEvent);
  if (rawPayload === undefined) {
    throw new TypeError('GMGN raw event must be JSON-serializable.');
  }

  const event = rawObject(rawEvent);
  const enrichedEvent = {
    ...event,
    source: options.source ?? event.source,
    chain: options.chain ?? event.chain,
  };
  const { signal, validationErrors } = normalizeGmgnSignal(enrichedEvent, capturedAtDate);
  if (validationErrors.length > 0) {
    logger.warn(`[gmgn] captured event with validation issues: ${validationErrors.join('; ')}`);
  }

  const result = database
    .prepare(
      `
    INSERT OR IGNORE INTO gmgn_signals
      (observed_at, token_address, signal_type, market_cap, triggering_wallet,
       raw_wallet_labels, source_url, ingestion_latency_ms, raw_payload, captured_at,
       validation_errors, source, chain, source_event_id, trigger_at, trigger_mc,
       first_trigger_mc, signal_times, signal_times_by_type, query_market_cap,
       query_ath, query_cur_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      signal.observedAt,
      signal.tokenAddress,
      signal.signalType,
      signal.marketCap,
      signal.triggeringWallet,
      signal.rawWalletLabels === null ? null : JSON.stringify(signal.rawWalletLabels),
      signal.sourceUrl,
      signal.ingestionLatencyMs,
      rawPayload,
      capturedAt,
      JSON.stringify(validationErrors),
      signal.source,
      signal.chain,
      signal.sourceEventId,
      signal.triggerAt,
      signal.triggerMc,
      signal.firstTriggerMc,
      signal.signalTimes,
      signal.signalTimesByType === null ? null : JSON.stringify(signal.signalTimesByType),
      signal.queryMarketCap,
      signal.queryAth,
      signal.queryCurData === null ? null : JSON.stringify(signal.queryCurData),
    );

  const duplicate = result.changes === 0;
  const id = duplicate
    ? Number(
        (
          database
            .prepare(
              `
        SELECT id FROM gmgn_signals WHERE source = ? AND chain = ? AND source_event_id = ?
      `,
            )
            .get(signal.source, signal.chain, signal.sourceEventId) as { id: number }
        ).id,
      )
    : Number(result.lastInsertRowid);

  return {
    id,
    ...signal,
    rawPayload,
    capturedAt,
    validationErrors,
    duplicate,
  };
};
