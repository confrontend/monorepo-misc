import type { DatabaseSync } from 'node:sqlite';
import type pg from 'pg';
import { PostgresMarketDataWriter } from '../db/postgres-market-data.js';
import { upsertMarketBars, type MarketBar } from '../research/outcomes.js';

const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';

export type YahooChartOptions = {
  symbol: string;
  timeframe: '1m' | '1d';
  period1: Date;
  period2: Date;
  fetchImpl?: typeof fetch;
};

export type MarketRefreshResult = {
  symbols: number;
  barsInserted: number;
  failures: Array<{ symbol: string; timeframe: string; error: string }>;
};

type YahooPayload = {
  chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ open?: Array<number|null>; high?: Array<number|null>; low?: Array<number|null>; close?: Array<number|null>; volume?: Array<number|null> }> } }> ; error?: { description?: string } | null };
};

export const normalizeYahooChart = (payload: unknown, options: YahooChartOptions): MarketBar[] => {
  const result = (payload as YahooPayload)?.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  if (!result || !quote) throw new Error('Yahoo chart response contained no quote data');
  const bars: MarketBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = quote.close?.[i];
    if (!Number.isFinite(close)) continue;
    const timestamp = Number(timestamps[i]) * 1000;
    if (!Number.isFinite(timestamp)) continue;
    bars.push({ symbol: options.symbol, timeframe: options.timeframe, observedAt: new Date(timestamp).toISOString(),
      open: quote.open?.[i] ?? null, high: quote.high?.[i] ?? null, low: quote.low?.[i] ?? null,
      close: Number(close), volume: quote.volume?.[i] ?? null, source: 'yahoo_chart' });
  }
  return bars;
};

export const fetchYahooBars = async (options: YahooChartOptions): Promise<MarketBar[]> => {
  const url = new URL(`${YAHOO_CHART}/${encodeURIComponent(options.symbol)}`);
  url.searchParams.set('period1', String(Math.floor(options.period1.getTime() / 1000)));
  url.searchParams.set('period2', String(Math.floor(options.period2.getTime() / 1000)));
  url.searchParams.set('interval', options.timeframe);
  url.searchParams.set('events', 'div,splits');
  const response = await (options.fetchImpl ?? fetch)(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Yahoo Finance returned HTTP ${response.status}`);
  const payload = await response.json() as YahooPayload;
  if (payload.chart?.error) throw new Error(payload.chart.error.description ?? 'Yahoo Finance chart error');
  return normalizeYahooChart(payload, options);
};

export const refreshMarketPrices = async (database: DatabaseSync, options: { fetchImpl?: typeof fetch; now?: Date; onProgress?: (progress: { completed: number; total: number; symbol: string; timeframe: string }) => void } = {}): Promise<MarketRefreshResult> => {
  const rows = database.prepare(`SELECT MIN(executed_at) AS earliest, MAX(executed_at) AS latest FROM uw_option_trades WHERE canceled=0 AND executed_at IS NOT NULL`).get() as { earliest: string|null; latest: string|null };
  if (!rows.earliest || !rows.latest) return { symbols: 0, barsInserted: 0, failures: [] };
  const symbols = (database.prepare(`SELECT DISTINCT underlying_symbol AS symbol FROM uw_option_trades WHERE canceled=0 AND underlying_symbol IS NOT NULL`).all() as unknown as { symbol: string }[]).map(row => row.symbol).filter(Boolean);
  if (!symbols.includes('SPY')) symbols.push('SPY');
  const now = options.now ?? new Date();
  const period1 = new Date(new Date(rows.earliest).getTime() - 60 * 60_000);
  const period2 = new Date(Math.min(new Date(rows.latest).getTime() + 4 * 24 * 60 * 60_000, now.getTime() + 60_000));
  let barsInserted = 0;
  const failures: MarketRefreshResult['failures'] = [];
  let completed = 0;
  const total = symbols.length * 2;
  for (const symbol of symbols) {
    for (const timeframe of ['1m', '1d'] as const) {
      try {
        const bars = await fetchYahooBars({ symbol, timeframe, period1, period2, fetchImpl: options.fetchImpl });
        barsInserted += upsertMarketBars(database, bars);
      } catch (error) {
        failures.push({ symbol, timeframe, error: error instanceof Error ? error.message : 'Market data fetch failed' });
      }
      completed++;
      options.onProgress?.({ completed, total, symbol, timeframe });
    }
  }
  return { symbols: symbols.length, barsInserted, failures };
};

/** Refreshes only daily bars needed by generic point-in-time signal events. */
export const refreshEventMarketPrices = async (database: DatabaseSync, signalTypes: string[], options: { fetchImpl?: typeof fetch; now?: Date; onProgress?: (progress: { completed: number; total: number; symbol: string; timeframe: string }) => void } = {}): Promise<MarketRefreshResult> => {
  if (!signalTypes.length) return { symbols: 0, barsInserted: 0, failures: [] };
  const placeholders = signalTypes.map(() => '?').join(',');
  const bounds = database.prepare(`SELECT MIN(event_at) AS earliest, MAX(event_at) AS latest FROM uw_signal_events WHERE signal_type IN (${placeholders}) AND event_at IS NOT NULL`).get(...signalTypes) as { earliest: string | null; latest: string | null };
  if (!bounds.earliest || !bounds.latest) return { symbols: 0, barsInserted: 0, failures: [] };
  const symbols = (database.prepare(`SELECT DISTINCT symbol FROM uw_signal_events WHERE signal_type IN (${placeholders}) AND symbol IS NOT NULL`).all(...signalTypes) as unknown as Array<{ symbol: string }>).map((row) => row.symbol.toUpperCase());
  if (!symbols.includes('SPY')) symbols.push('SPY');
  const now = options.now ?? new Date();
  const period1 = new Date(new Date(bounds.earliest).getTime() - 24 * 60 * 60_000);
  const period2 = new Date(Math.min(new Date(bounds.latest).getTime() + 4 * 24 * 60 * 60_000, now.getTime() + 60_000));
  let barsInserted = 0;
  const failures: MarketRefreshResult['failures'] = [];
  let completed = 0;
  for (const symbol of symbols) {
    try {
      const bars = await fetchYahooBars({ symbol, timeframe: '1d', period1, period2, fetchImpl: options.fetchImpl });
      barsInserted += upsertMarketBars(database, bars);
    } catch (error) {
      failures.push({ symbol, timeframe: '1d', error: error instanceof Error ? error.message : 'Market data fetch failed' });
    }
    completed++;
    options.onProgress?.({ completed, total: symbols.length, symbol, timeframe: '1d' });
  }
  return { symbols: symbols.length, barsInserted, failures };
};

/** PostgreSQL market refresh boundary. Yahoo fetch semantics and failure reporting match SQLite. */
export const refreshMarketPricesPostgres = async (pool: pg.Pool, options: { fetchImpl?: typeof fetch; now?: Date; onProgress?: (progress: { completed: number; total: number; symbol: string; timeframe: string }) => void } = {}): Promise<MarketRefreshResult> => {
  const bounds = await pool.query<{ earliest: string | null; latest: string | null }>(`SELECT MIN(executed_at) AS earliest, MAX(executed_at) AS latest FROM uw_option_trades WHERE canceled=FALSE AND executed_at IS NOT NULL`);
  const rows = bounds.rows[0];
  if (!rows?.earliest || !rows.latest) return { symbols: 0, barsInserted: 0, failures: [] };
  const symbolsResult = await pool.query<{ symbol: string }>(`SELECT DISTINCT underlying_symbol AS symbol FROM uw_option_trades WHERE canceled=FALSE AND underlying_symbol IS NOT NULL`);
  const symbols = symbolsResult.rows.map(row => row.symbol).filter(Boolean);
  if (!symbols.includes('SPY')) symbols.push('SPY');
  const now = options.now ?? new Date();
  const period1 = new Date(new Date(rows.earliest).getTime() - 60 * 60_000);
  const period2 = new Date(Math.min(new Date(rows.latest).getTime() + 4 * 24 * 60 * 60_000, now.getTime() + 60_000));
  const writer = new PostgresMarketDataWriter(pool);
  await writer.ensureSchema();
  let barsInserted = 0;
  const failures: MarketRefreshResult['failures'] = [];
  let completed = 0;
  const total = symbols.length * 2;
  for (const symbol of symbols) {
    for (const timeframe of ['1m', '1d'] as const) {
      try {
        const bars = await fetchYahooBars({ symbol, timeframe, period1, period2, fetchImpl: options.fetchImpl });
        barsInserted += await writer.upsertBars(bars);
      } catch (error) {
        failures.push({ symbol, timeframe, error: error instanceof Error ? error.message : 'Market data fetch failed' });
      }
      completed++;
      options.onProgress?.({ completed, total, symbol, timeframe });
    }
  }
  return { symbols: symbols.length, barsInserted, failures };
};
