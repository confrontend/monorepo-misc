import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { readUnusualWhalesApiKey } from './unusualwhales.js';
import type pg from 'pg';
import { PostgresIngestionRepository } from '../db/postgres-ingestion.js';

const API_BASE_URL = 'https://api.unusualwhales.com';
const ENDPOINT = '/api/option-trades';

type RawRecord = Record<string, unknown>;

export type PutSweepSyncOptions = {
  limit?: number;
  apiBaseUrl?: string;
  apiKeyFile?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Optional production PostgreSQL sink; SQLite remains the default until cutover. */
  postgresPool?: pg.Pool;
};

export type PutSweepSyncSummary = {
  batchId: number;
  received: number;
  inserted: number;
  duplicates: number;
  completedAt: string;
};

export const createPostgresPutSweepRepository = (pool: pg.Pool): PostgresIngestionRepository => new PostgresIngestionRepository(pool);

const recordsFrom = (payload: unknown): RawRecord[] => {
  const value = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : null;
  if (!value) throw new Error('Unusual Whales API response does not contain a data array');
  return value.filter((record): record is RawRecord => Boolean(record) && typeof record === 'object' && !Array.isArray(record));
};

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result ? result : null;
};

const integer = (value: unknown): number | null => {
  const result = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(result) ? Math.trunc(result) : null;
};

const jsonArray = (value: unknown): string => JSON.stringify(
  Array.isArray(value) ? value : value === null || value === undefined ? [] : [value],
);

const normalizedTimestamp = (value: unknown, errors: string[]): string | null => {
  const source = text(value);
  if (!source) {
    errors.push('missing executed_at');
    return null;
  }
  const parsed = new Date(source);
  if (Number.isNaN(parsed.getTime())) {
    errors.push('invalid executed_at');
    return null;
  }
  return parsed.toISOString();
};

/**
 * Imports provider-defined put intermarket sweeps into the shared option-trade
 * table. The provider event is retained verbatim so later research can audit
 * normalization decisions. This function deliberately does not infer whether
 * a put sweep is bullish or bearish.
 */
export const syncRecentPutSweeps = async (
  database: DatabaseSync,
  options: PutSweepSyncOptions = {},
): Promise<PutSweepSyncSummary> => {
  const requestedAt = (options.now?.() ?? new Date()).toISOString();
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const query = {
    limit,
    type: 'put',
    report_flag: 'intermarket_sweep',
    canceled: false,
    force_15_min_delay: true,
  };
  const batchResult = database.prepare(`
    INSERT INTO uw_import_batches (endpoint, query_json, requested_at, status)
    VALUES (?, ?, ?, 'processing')
  `).run(ENDPOINT, JSON.stringify(query), requestedAt);
  const batchId = Number(batchResult.lastInsertRowid);

  try {
    const key = await readUnusualWhalesApiKey(options.apiKeyFile);
    const url = new URL(ENDPOINT, options.apiBaseUrl ?? API_BASE_URL);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('type', 'put');
    url.searchParams.set('report_flag[]', 'intermarket_sweep');
    url.searchParams.set('canceled', 'false');
    url.searchParams.set('force_15_min_delay', 'true');

    const response = await (options.fetchImpl ?? fetch)(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Unusual Whales API returned HTTP ${response.status}`);
    const payload: unknown = await response.json();
    const rawResponse = JSON.stringify(payload);
    const responseSha256 = createHash('sha256').update(rawResponse).digest('hex');
    const records = recordsFrom(payload);
    const capturedAt = (options.now?.() ?? new Date()).toISOString();
    const insert = database.prepare(`
      INSERT OR IGNORE INTO uw_option_trades (
        source_trade_id, source_batch_id, executed_at, captured_at, signal_type,
        underlying_symbol, option_chain_id, option_type, expiry, strike, premium,
        price, size, underlying_price, open_interest, volume, nbbo_bid, nbbo_ask,
        report_flags, tags, canceled, raw_payload, validation_errors
      ) VALUES (?, ?, ?, ?, 'put_sweep', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let inserted = 0;
    database.exec('BEGIN');
    try {
      for (const record of records) {
        const rawPayload = JSON.stringify(record);
        const sourceTradeId = text(record.id) ?? `sha256:${createHash('sha256').update(rawPayload).digest('hex')}`;
        const errors: string[] = [];
        const executedAt = normalizedTimestamp(record.executed_at, errors);
        const symbol = text(record.underlying_symbol);
        const optionType = text(record.option_type)?.toLowerCase() ?? null;
        if (!symbol) errors.push('missing underlying_symbol');
        if (optionType !== 'put') errors.push('option_type is not put');
        const result = insert.run(
          sourceTradeId,
          batchId,
          executedAt,
          capturedAt,
          symbol,
          text(record.option_chain_id),
          optionType,
          text(record.expiry),
          text(record.strike),
          text(record.premium),
          text(record.price),
          integer(record.size),
          text(record.underlying_price),
          integer(record.open_interest),
          integer(record.volume),
          text(record.nbbo_bid),
          text(record.nbbo_ask),
          jsonArray(record.report_flags),
          jsonArray(record.tags),
          record.canceled === true ? 1 : 0,
          rawPayload,
          JSON.stringify(errors),
        );
        inserted += Number(result.changes);
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }

    const completedAt = (options.now?.() ?? new Date()).toISOString();
    const duplicates = records.length - inserted;
    database.prepare(`
      UPDATE uw_import_batches
      SET completed_at = ?, status = 'completed', http_status = ?, received_count = ?,
          inserted_count = ?, duplicate_count = ?, response_sha256 = ?, raw_response = ?
      WHERE id = ?
    `).run(completedAt, response.status, records.length, inserted, duplicates, responseSha256, rawResponse, batchId);
    return { batchId, received: records.length, inserted, duplicates, completedAt };
  } catch (error) {
    const completedAt = (options.now?.() ?? new Date()).toISOString();
    const message = error instanceof Error ? error.message : 'Unusual Whales put sweep sync failed';
    database.prepare(`
      UPDATE uw_import_batches SET completed_at = ?, status = 'failed', error = ? WHERE id = ?
    `).run(completedAt, message, batchId);
    throw new Error(message);
  }
};
