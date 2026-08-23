import { createHash } from 'node:crypto';
import type pg from 'pg';
import { readUnusualWhalesApiKey } from './unusualwhales.js';
import { PostgresIngestionRepository, type PostgresOptionTradeInput } from '../db/postgres-ingestion.js';

type SweepKind = 'call' | 'put';
type Raw = Record<string, unknown>;
const text = (v: unknown) => v == null || !String(v).trim() ? null : String(v).trim();
const integer = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; };
const json = (v: unknown) => Array.isArray(v) ? v : v == null ? [] : [v];

/** Live provider sync which writes only to PostgreSQL. It intentionally has no SQLite handle. */
export async function syncRecentSweepsToPostgres(pool: pg.Pool, kind: SweepKind, options: {
  limit?: number; apiBaseUrl?: string; apiKeyFile?: string; fetchImpl?: typeof fetch; now?: () => Date;
} = {}) {
  const now = options.now ?? (() => new Date());
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const query = { limit, type: kind, report_flag: 'intermarket_sweep', canceled: false, force_15_min_delay: true };
  const repo = new PostgresIngestionRepository(pool);
  await repo.ensureSchema();
  const batch = await repo.beginBatch('/api/option-trades', query, now().toISOString());
  try {
    const key = await readUnusualWhalesApiKey(options.apiKeyFile);
    const url = new URL('/api/option-trades', options.apiBaseUrl ?? 'https://api.unusualwhales.com');
    url.searchParams.set('limit', String(limit)); url.searchParams.set('type', kind);
    url.searchParams.set('report_flag[]', 'intermarket_sweep'); url.searchParams.set('canceled', 'false'); url.searchParams.set('force_15_min_delay', 'true');
    const response = await (options.fetchImpl ?? fetch)(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Unusual Whales API returned HTTP ${response.status}`);
    const payload = await response.json() as unknown;
    const records = Array.isArray(payload) ? payload : payload && typeof payload === 'object' && Array.isArray((payload as {data?: unknown}).data) ? (payload as {data: unknown[]}).data : null;
    if (!records) throw new Error('Unusual Whales API response does not contain a data array');
    const capturedAt = now().toISOString();
    const rows: PostgresOptionTradeInput[] = records.filter((r): r is Raw => Boolean(r) && typeof r === 'object' && !Array.isArray(r)).map((r) => {
      const rawPayload = JSON.stringify(r); const errors: string[] = [];
      const sourceTradeId = text(r.id) ?? `sha256:${createHash('sha256').update(rawPayload).digest('hex')}`;
      const rawTime = text(r.executed_at); const parsed = rawTime ? new Date(rawTime) : null;
      const executedAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
      if (!executedAt) errors.push(rawTime ? 'invalid executed_at' : 'missing executed_at');
      const symbol = text(r.underlying_symbol); if (!symbol) errors.push('missing underlying_symbol');
      const optionType = text(r.option_type)?.toLowerCase() ?? null; if (optionType !== kind) errors.push(`option_type is not ${kind}`);
      return { sourceTradeId, sourceBatchId: batch.id, executedAt, capturedAt, signalType: `${kind}_sweep` as 'call_sweep'|'put_sweep', underlyingSymbol: symbol,
        optionChainId: text(r.option_chain_id), optionType, expiry: text(r.expiry), strike: text(r.strike), premium: text(r.premium), price: text(r.price),
        size: integer(r.size), underlyingPrice: text(r.underlying_price), openInterest: integer(r.open_interest), volume: integer(r.volume), nbboBid: text(r.nbbo_bid), nbboAsk: text(r.nbbo_ask),
        reportFlags: json(r.report_flags), tags: json(r.tags), canceled: r.canceled === true, rawPayload, validationErrors: errors };
    });
    const imported = await repo.importOptionTrades(batch.id, rows);
    const rawResponse = JSON.stringify(payload);
    await repo.finishBatch(batch.id, { completedAt: now().toISOString(), httpStatus: response.status, received: rows.length, inserted: imported.inserted, duplicates: imported.duplicates,
      responseSha256: createHash('sha256').update(rawResponse).digest('hex'), rawResponse: payload });
    return { batchId: batch.id, received: rows.length, ...imported, completedAt: now().toISOString() };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'PostgreSQL sweep sync failed';
    await repo.failBatch(batch.id, now().toISOString(), message); throw new Error(message);
  }
}
