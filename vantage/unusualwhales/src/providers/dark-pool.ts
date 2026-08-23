import { createHash } from 'node:crypto';
import { readUnusualWhalesApiKey } from './unusualwhales.js';

const API_BASE_URL = 'https://api.unusualwhales.com';
const DEFAULT_ENDPOINT = '/api/darkpool/recent';
type RawRecord = Record<string, unknown>;

export type DarkPoolRecord = {
  sourceId: string;
  executedAt: string | null;
  ticker: string | null;
  price: string | null;
  size: number | null;
  premium: string | null;
  canceled: boolean;
  rawPayload: string;
  validationErrors: string[];
};

export type DarkPoolFetchOptions = {
  ticker?: string;
  limit?: number;
  /** Optional trading date (YYYY-MM-DD). Documented as `Optional Market Date`; the recent
   *  endpoint defaults to the last trading day when omitted. */
  date?: string;
  endpoint?: string;
  apiBaseUrl?: string;
  apiKeyFile?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export type DarkPoolFetchResult = {
  endpoint: string;
  requestedAt: string;
  received: number;
  records: DarkPoolRecord[];
};

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result ? result : null;
};

const numberValue = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const result = typeof value === 'number' ? value : Number(String(value).replaceAll(',', ''));
  return Number.isFinite(result) ? result : null;
};

const booleanValue = (value: unknown): boolean => value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';

const first = (record: RawRecord, keys: string[]): unknown => keys.map((key) => record[key]).find((value) => value !== undefined && value !== null);

const recordsFrom = (payload: unknown): RawRecord[] => {
  const value = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : null;
  if (!value) throw new Error('Unusual Whales dark-pool response does not contain a data array');
  return value.filter((record): record is RawRecord => Boolean(record) && typeof record === 'object' && !Array.isArray(record));
};

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
 * Normalizes the documented recent dark-pool response envelope (`data: []`).
 * The provider has used both ticker/symbol and executed_at/timestamp names in
 * endpoint variants, so these aliases are accepted without changing meaning.
 */
export const normalizeDarkPoolRecords = (payload: unknown): DarkPoolRecord[] => {
  const seen = new Set<string>();
  const normalized: DarkPoolRecord[] = [];
  for (const record of recordsFrom(payload)) {
    const rawPayload = JSON.stringify(record);
    const sourceId = text(first(record, ['id', 'dark_pool_id', 'trade_id']))
      ?? `sha256:${createHash('sha256').update(rawPayload).digest('hex')}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    const errors: string[] = [];
    const executedAt = normalizedTimestamp(first(record, ['executed_at', 'timestamp', 'time', 'date']), errors);
    const ticker = text(first(record, ['ticker', 'symbol', 'underlying_symbol', 'issue_symbol']));
    const priceValue = first(record, ['price', 'execution_price', 'trade_price']);
    const sizeValue = first(record, ['size', 'quantity', 'shares', 'volume']);
    const premiumValue = first(record, ['premium', 'notional', 'value', 'trade_value']);
    const price = text(priceValue);
    const size = numberValue(sizeValue);
    const premium = text(premiumValue);
    if (!ticker) errors.push('missing ticker');
    if (price === null) errors.push('missing price');
    else if (numberValue(priceValue) === null) errors.push('invalid price');
    if (size === null) errors.push('missing size');
    normalized.push({
      sourceId,
      executedAt,
      ticker,
      price,
      size,
      premium,
      canceled: booleanValue(first(record, ['canceled', 'cancelled'])),
      rawPayload,
      validationErrors: errors,
    });
  }
  return normalized;
};

export const fetchRecentDarkPool = async (options: DarkPoolFetchOptions = {}): Promise<DarkPoolFetchResult> => {
  const requestedAt = (options.now?.() ?? new Date()).toISOString();
  // Recent Darkpool Trades documents a maximum limit of 200.
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
  // The API exposes ticker-scoped trades as /api/darkpool/{ticker}; the
  // recent endpoint does not accept a ticker query parameter.
  const endpoint = options.endpoint ?? (options.ticker ? `/api/darkpool/${encodeURIComponent(options.ticker.toUpperCase())}` : DEFAULT_ENDPOINT);
  const key = await readUnusualWhalesApiKey(options.apiKeyFile);
  const url = new URL(endpoint, options.apiBaseUrl ?? API_BASE_URL);
  url.searchParams.set('limit', String(limit));
  if (options.date) url.searchParams.set('date', options.date);
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Unusual Whales dark-pool API returned HTTP ${response.status}`);
  const payload: unknown = await response.json();
  const records = normalizeDarkPoolRecords(payload);
  return { endpoint, requestedAt, received: records.length, records };
};
