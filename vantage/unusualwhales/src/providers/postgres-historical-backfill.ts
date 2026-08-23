import { createHash } from 'node:crypto';
import type pg from 'pg';
import { readUnusualWhalesApiKey } from './unusualwhales.js';
import { normalizeDarkPoolRecords } from './dark-pool.js';
import { parsePostgresArrayLiteral, streamFullTapeCsvRows } from './full-tape-csv.js';
import { PostgresIngestionRepository, type PostgresOptionTradeInput } from '../db/postgres-ingestion.js';
import {
  claimPostgresOperation,
  finishPostgresHistoricalCoverage,
  finishPostgresOperation,
  readPostgresOperation,
  retryPostgresOperation,
  updatePostgresHistoricalProgress,
  updatePostgresOperation,
  upsertPostgresHistoricalCoverage,
  type PostgresQueryRunner,
} from '../diagnostics.js';

const API_BASE_URL = 'https://api.unusualwhales.com';
const FULL_TAPE = '/api/option-trades/full-tape';
const DARK_POOL = '/api/darkpool/recent';
const MAX_DAYS = 366;
const DARK_POOL_LIMIT = 200;
const CHUNK_SIZE = 500;

export type PostgresHistoricalWorkerOptions = {
  apiBaseUrl?: string;
  apiKeyFile?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  maxRequests?: number;
  fullTapeTimeoutMs?: number;
  maxDecompressedBytesPerDay?: number;
  maxAttempts?: number;
  abortSignal?: AbortSignal;
};

export type PostgresHistoricalWorkerResult = {
  status: 'completed' | 'partial' | 'failed' | 'cancelled' | 'retrying';
  jobId: number;
  from: string;
  to: string;
  signalTypes: string[];
  received: number;
  inserted: number;
  duplicates: number;
  skippedDays: number;
  errors: string[];
};

class CancelledError extends Error { constructor() { super('Historical PostgreSQL job cancelled'); } }

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
};
const integer = (value: unknown): number | null => {
  const result = Number(value);
  return Number.isFinite(result) ? Math.trunc(result) : null;
};
const jsonArray = (value: unknown): unknown[] => Array.isArray(value) ? value : value == null ? [] : [value];
const isWeekend = (date: Date) => date.getUTCDay() === 0 || date.getUTCDay() === 6;
const normalizeTimestamp = (value: unknown): string | null => {
  const valueText = text(value);
  if (!valueText) return null;
  const parsed = new Date(valueText);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};
const parseRange = (from: string, to: string) => {
  const fromDate = new Date(from); const toDate = new Date(to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate >= toDate) throw new Error('from and to must be valid ISO dates with from earlier than to');
  if (toDate.getTime() - fromDate.getTime() > MAX_DAYS * 86_400_000) throw new Error(`historical backfill is limited to ${MAX_DAYS} days per request`);
  return { from: fromDate.toISOString(), to: toDate.toISOString() };
};
const recordsFrom = (payload: unknown): Array<Record<string, unknown>> => {
  const records = Array.isArray(payload) ? payload : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data) ? (payload as { data: unknown[] }).data : [];
  return records.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row));
};
const asPayload = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') { try { return asPayload(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
};

export async function runPostgresHistoricalWorker(pool: pg.Pool, jobId: number, options: PostgresHistoricalWorkerOptions = {}): Promise<PostgresHistoricalWorkerResult> {
  const runner = pool as unknown as PostgresQueryRunner;
  const job = await readPostgresOperation(runner, jobId);
  if (!job) throw new Error(`PostgreSQL historical job ${jobId} was not found`);
  if (job.status === 'queued' || job.status === 'retrying') {
    const claimed = await claimPostgresOperation(runner, jobId, (options.now ?? (() => new Date()))().toISOString());
    if (!claimed) throw new Error(`PostgreSQL historical job ${jobId} could not be claimed`);
  }
  const payload = asPayload(job.payload);
  const from = String(payload.from ?? ''); const to = String(payload.to ?? '');
  const range = parseRange(from, to);
  const signalTypes = [...new Set((Array.isArray(payload.signalTypes) && payload.signalTypes.length ? payload.signalTypes : ['call_sweep', 'put_sweep', 'dark_pool_block']).map(String))];
  const maxRequests = Math.min(Math.max(options.maxRequests ?? 100, 1), 100);
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetchImpl ?? fetch;
  const repository = new PostgresIngestionRepository(pool);
  await repository.ensureSchema();
  const errors: string[] = [];
  let received = 0; let inserted = 0; let duplicates = 0; let skippedDays = 0; let requests = 0;

  const ensureActive = async () => {
    if (options.abortSignal?.aborted) throw new CancelledError();
    const current = await readPostgresOperation(runner, jobId);
    if (current?.status === 'cancelled') throw new CancelledError();
  };
  const progress = async (details: Record<string, unknown>) => updatePostgresOperation(runner, jobId, details);

  await progress({ stage: 'historical_fetch', from: range.from, to: range.to, signalTypes, updatedAt: now().toISOString() });
  try {
    const key = await readUnusualWhalesApiKey(options.apiKeyFile);
    for (const signalType of signalTypes) {
      if (!['call_sweep', 'put_sweep', 'dark_pool_block'].includes(signalType)) {
        errors.push(`${signalType}: no verified PostgreSQL historical adapter`);
        continue;
      }
      const isDarkPool = signalType === 'dark_pool_block';
      const endpoint = isDarkPool ? DARK_POOL : FULL_TAPE;
      const query = isDarkPool ? { from: range.from, to: range.to, limit: DARK_POOL_LIMIT } : { type: signalType === 'call_sweep' ? 'call' : 'put', report_flag: 'intermarket_sweep', canceled: false, full_tape: true, from: range.from, to: range.to };
      const batch = await repository.beginBatch(endpoint, query, now().toISOString());
      let typeReceived = 0; let typeInserted = 0; let typeDuplicates = 0;
      try {
        for (let cursor = new Date(new Date(range.to).getTime() - 86_400_000); cursor >= new Date(range.from); cursor = new Date(cursor.getTime() - 86_400_000)) {
          await ensureActive();
          if (isWeekend(cursor)) continue;
          if (requests >= maxRequests && !isDarkPool) break;
          const tradingDate = cursor.toISOString().slice(0, 10);
          const existing = await pool.query<{ status: string }>('SELECT status FROM uw_historical_coverage WHERE signal_type=$1 AND trading_date=$2', [signalType, tradingDate]);
          if (existing.rows[0]?.status === 'completed') { skippedDays++; continue; }
          requests++;
          await upsertPostgresHistoricalCoverage(runner, { signalType, tradingDate, endpoint: `${endpoint}/${tradingDate}`, startedAt: now().toISOString() });
          await progress({ stage: 'historical_fetch', signalType, tradingDate, received: typeReceived, inserted: typeInserted, total: null, updatedAt: now().toISOString() });
          const url = new URL(isDarkPool ? endpoint : `${endpoint}/${tradingDate}`, options.apiBaseUrl ?? API_BASE_URL);
          if (isDarkPool) { url.searchParams.set('limit', String(DARK_POOL_LIMIT)); url.searchParams.set('date', tradingDate); }
          const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: options.abortSignal ?? AbortSignal.timeout(options.fullTapeTimeoutMs ?? 20 * 60_000) });
          if (!response.ok) throw new Error(`Unusual Whales historical API returned HTTP ${response.status}`);
          const capturedAt = now().toISOString();
          let dayReceived = 0; let dayInserted = 0; let dayDuplicates = 0;
          if (isDarkPool) {
            const records = normalizeDarkPoolRecords(await response.json());
            const rows = records.filter((record) => record.executedAt && record.executedAt >= range.from && record.executedAt < range.to);
            dayReceived = rows.length;
            const client = await pool.connect();
            try {
              await client.query('BEGIN');
              for (const record of rows) {
                const result = await client.query(`INSERT INTO uw_dark_pool_trades (source_trade_id,executed_at,captured_at,ticker,price,size,premium,canceled,raw_payload,validation_errors) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb) ON CONFLICT (source_trade_id) DO NOTHING`, [record.sourceId, record.executedAt, capturedAt, record.ticker, record.price, record.size, record.premium, record.canceled, record.rawPayload, JSON.stringify(record.validationErrors)]);
                dayInserted += result.rowCount ?? 0;
                if (dayReceived % 100 === 0) await ensureActive();
              }
              await client.query('COMMIT');
            } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
            dayDuplicates = dayReceived - dayInserted;
          } else {
            if (!response.body) throw new Error('Unusual Whales full-tape response had no body');
            const optionType = signalType === 'call_sweep' ? 'call' : 'put';
            let chunk: PostgresOptionTradeInput[] = [];
            const flush = async () => { if (!chunk.length) return; const result = await repository.importOptionTrades(batch.id, chunk); dayInserted += result.inserted; dayDuplicates += result.duplicates; chunk = []; await progress({ stage: 'historical_fetch', signalType, tradingDate, received: typeReceived + dayReceived, inserted: typeInserted + dayInserted, updatedAt: now().toISOString() }); };
            let bytesReceived = 0;
            for await (const row of streamFullTapeCsvRows(response.body, { maxDecompressedBytes: options.maxDecompressedBytesPerDay, onBytes: (bytes) => { bytesReceived += bytes; void updatePostgresHistoricalProgress(runner, { signalType, tradingDate, bytesReceived, bytesExpected: Number(response.headers.get('content-length')) || null }); } })) {
              const flags = parsePostgresArrayLiteral(row.report_flags ?? '');
              if ((row.option_type ?? '').toLowerCase() !== optionType || !flags.some((flag) => flag.toLowerCase() === 'intermarket_sweep')) continue;
              const rawPayload = JSON.stringify(row); const executedAt = normalizeTimestamp(row.executed_at);
              if (!executedAt || executedAt < range.from || executedAt >= range.to) continue;
              const validation: string[] = []; const symbol = text(row.underlying_symbol); if (!symbol) validation.push('missing underlying_symbol');
              const sourceTradeId = text(row.id) ?? `sha256:${createHash('sha256').update(rawPayload).digest('hex')}`;
              chunk.push({ sourceTradeId, sourceBatchId: batch.id, executedAt, capturedAt, signalType: signalType as 'call_sweep' | 'put_sweep', underlyingSymbol: symbol, optionChainId: text(row.option_chain_id), optionType, expiry: text(row.expiry), strike: text(row.strike), premium: text(row.premium), price: text(row.price), size: integer(row.size), underlyingPrice: text(row.underlying_price), openInterest: integer(row.open_interest), volume: integer(row.volume), nbboBid: text(row.nbbo_bid), nbboAsk: text(row.nbbo_ask), reportFlags: jsonArray(flags), tags: parsePostgresArrayLiteral(row.tags ?? ''), canceled: /^(t|true|1)$/i.test(String(row.canceled ?? '')), rawPayload, validationErrors: validation });
              dayReceived++;
              if (chunk.length >= CHUNK_SIZE) { await flush(); await ensureActive(); }
            }
            await flush();
          }
          typeReceived += dayReceived; typeInserted += dayInserted; typeDuplicates += dayDuplicates; received += dayReceived; inserted += dayInserted; duplicates += dayDuplicates;
          const coverageWarning = isDarkPool && dayReceived >= DARK_POOL_LIMIT
            ? `Hit the ${DARK_POOL_LIMIT}-record dark-pool request cap; this day may be undercounted because the endpoint has no verified pagination.`
            : null;
          await finishPostgresHistoricalCoverage(runner, { signalType, tradingDate, status: 'completed', receivedCount: dayReceived, insertedCount: dayInserted, duplicateCount: dayDuplicates, error: coverageWarning, completedAt: now().toISOString() });
        }
        await repository.finishBatch(batch.id, { completedAt: now().toISOString(), received: typeReceived, inserted: typeInserted, duplicates: typeDuplicates });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'PostgreSQL historical import failed';
        await repository.failBatch(batch.id, now().toISOString(), message);
        await pool.query(`UPDATE uw_historical_coverage SET completed_at=$1,status='failed',error=$2 WHERE signal_type=$3 AND status='processing'`, [now().toISOString(), message, signalType]);
        if (error instanceof CancelledError) throw error;
        throw error instanceof Error ? error : new Error(message);
      }
    }
    const hasUnsupported = signalTypes.some((signalType) => !['call_sweep', 'put_sweep', 'dark_pool_block'].includes(signalType));
    const result: PostgresHistoricalWorkerResult = { status: errors.length ? (inserted || hasUnsupported ? 'partial' : 'failed') : 'completed', jobId, from: range.from, to: range.to, signalTypes, received, inserted, duplicates, skippedDays, errors };
    await finishPostgresOperation(runner, jobId, result.status === 'failed' ? 'failed' : 'completed', result, errors.join('; ') || null);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'PostgreSQL historical worker failed';
    const current = await readPostgresOperation(runner, jobId);
    if (error instanceof CancelledError || current?.status === 'cancelled') {
      return { status: 'cancelled', jobId, from: range.from, to: range.to, signalTypes, received, inserted, duplicates, skippedDays, errors: [message] };
    }
    const attempt = Number(current?.attempt ?? 1); const maxAttempts = options.maxAttempts ?? 3;
    if (attempt < maxAttempts) {
      await retryPostgresOperation(runner, jobId, message);
      return { status: 'retrying', jobId, from: range.from, to: range.to, signalTypes, received, inserted, duplicates, skippedDays, errors: [message] };
    }
    await finishPostgresOperation(runner, jobId, 'failed', { jobId, received, inserted, duplicates }, message);
    return { status: 'failed', jobId, from: range.from, to: range.to, signalTypes, received, inserted, duplicates, skippedDays, errors: [message] };
  }
}
