import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_API_BASE_URL = 'https://api.unusualwhales.com';
const DEFAULT_KEY_FILE = path.resolve(process.cwd(), '.secrets', 'unusualwhales', 'unusual-whales-api-key.txt');

export type ProbeOptions = {
  ticker?: string;
  limit?: number;
  apiBaseUrl?: string;
  apiKeyFile?: string;
  fetchImpl?: typeof fetch;
};

export type ProbeResult = {
  ok: boolean;
  status: number | null;
  durationMs: number;
  recordCount: number | null;
  fields?: string[];
  error?: string;
};

/** Reads the local secret without ever returning it to callers that serve UI data. */
export const readUnusualWhalesApiKey = async (filePath = process.env.UNUSUAL_WHALES_API_KEY_FILE ?? DEFAULT_KEY_FILE) => {
  let value: string;
  try {
    value = (await readFile(filePath, 'utf8')).trim();
  } catch {
    throw new Error(`Unusual Whales API key file is not readable: ${filePath}`);
  }
  if (!value) throw new Error('Unusual Whales API key file is empty');
  if (/\s/.test(value)) throw new Error('Unusual Whales API key must be a single token');
  return value;
};

const recordsFrom = (payload: unknown): unknown[] | null => {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;
  const data = (payload as { data?: unknown }).data;
  return Array.isArray(data) ? data : null;
};

/** Performs one bounded, read-only request. Raw provider payloads are intentionally not returned. */
export const probeOptionTrades = async (options: ProbeOptions = {}): Promise<ProbeResult> => {
  let key: string;
  try {
    key = await readUnusualWhalesApiKey(options.apiKeyFile);
  } catch (error) {
    return {
      ok: false,
      status: null,
      durationMs: 0,
      recordCount: null,
      error: error instanceof Error && error.message.includes('empty') ? 'Unusual Whales API key is not configured' : 'Unusual Whales API key is unavailable',
    };
  }
  const baseUrl = options.apiBaseUrl ?? process.env.UNUSUAL_WHALES_API_BASE_URL ?? DEFAULT_API_BASE_URL;
  const url = new URL('/api/option-trades', baseUrl);
  url.searchParams.set('limit', String(Math.min(Math.max(options.limit ?? 1, 1), 10)));
  url.searchParams.set('force_15_min_delay', 'true');
  // The documented option-trades filter is `ticker_symbol` (not `ticker`).
  if (options.ticker) url.searchParams.set('ticker_symbol', options.ticker.toUpperCase());

  const fetchImpl = options.fetchImpl ?? fetch;
  const started = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return { ok: false, status: null, durationMs: Date.now() - started, recordCount: null, error: error instanceof Error ? error.message : 'request failed' };
  }

  if (!response.ok) {
    return { ok: false, status: response.status, durationMs: Date.now() - started, recordCount: null, error: `Unusual Whales API returned HTTP ${response.status}` };
  }
  try {
    const payload: unknown = await response.json();
    const records = recordsFrom(payload);
    const first = records?.[0];
    const fields = first && typeof first === 'object' && !Array.isArray(first)
      ? Object.keys(first as Record<string, unknown>).sort()
      : undefined;
    return { ok: true, status: response.status, durationMs: Date.now() - started, recordCount: records?.length ?? null, fields };
  } catch {
    return { ok: false, status: response.status, durationMs: Date.now() - started, recordCount: null, error: 'Unusual Whales API returned invalid JSON' };
  }
};
