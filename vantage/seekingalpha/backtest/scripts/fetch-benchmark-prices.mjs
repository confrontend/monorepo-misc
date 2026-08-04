#!/usr/bin/env node
//
// Fetches full daily price history for every ticker found in backtest/input/*.json
// from Yahoo Finance's unofficial chart endpoint, and caches it to backtest/benchmark/<TICKER>.json.
//
// This is a deliberately one-time (or on-demand) fetch, never called from the browser:
// history for a closed trading day never changes, so once a ticker has a cache file it is
// never re-fetched again unless you pass --force or delete the file. The React app only
// ever reads the cached JSON.
//
// Usage:
//   node scripts/fetch-benchmark-prices.mjs             fetch only tickers missing a cache file
//   node scripts/fetch-benchmark-prices.mjs --force      re-fetch every ticker, overwriting caches
//   node scripts/fetch-benchmark-prices.mjs AMD MU       fetch/refresh only the given ticker(s)
//
// Data source: https://query1.finance.yahoo.com/v8/finance/chart/{TICKER}
// This is an unofficial, undocumented Yahoo Finance endpoint (no API key, no official terms
// of support) — it is widely used (it's what the `yfinance` Python library wraps) and has
// been stable for years, but Yahoo could rate-limit, block, or change it without notice.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const INPUT_DIR = path.join(ROOT, 'input');
const BENCHMARK_DIR = path.join(ROOT, 'benchmark');

const args = process.argv.slice(2);
const force = args.includes('--force');
const explicitTickers = args.filter((arg) => !arg.startsWith('--')).map((ticker) => ticker.toUpperCase());

const yahooChartUrl = (ticker) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
  `?period1=0&period2=${Math.floor(Date.now() / 1000)}&interval=1d&events=div%2Csplit`;

// Captures in backtest/input use MM/DD/YYYY (see data.ts). Match that format here so both
// datasets can share the same date-parsing/comparison logic in data.ts without a second format.
// Yahoo's daily timestamp marks that trading day's US market session; reading the UTC date
// components lands on the correct calendar day in every case that matters for a daily bar.
const toMonthDayYear = (date) => {
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${month}/${day}/${year}`;
};

// Always fetched alongside whatever tickers are captured, as a fixed "the market" reference
// (S&P 500 ETF) so rating-tier cohorts can be compared against something other than each other.
const MARKET_TICKER = 'SPY';

async function discoverTickers() {
  if (explicitTickers.length) return explicitTickers;
  const files = await readdir(INPUT_DIR);
  const tickers = new Set([MARKET_TICKER]);
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await readFile(path.join(INPUT_DIR, file), 'utf8'));
      const ticker = raw?.source?.ticker;
      if (ticker) tickers.add(String(ticker).toUpperCase());
    } catch {
      // Skip unreadable/invalid capture files rather than failing the whole run.
    }
  }
  return [...tickers].sort();
}

async function fetchTicker(ticker) {
  const response = await fetch(yahooChartUrl(ticker), {
    headers: {
      // Yahoo's unofficial endpoint frequently rejects requests with no browser-like UA.
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept: 'application/json',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  if (!result) {
    const errorMessage = payload?.chart?.error?.description;
    throw new Error(errorMessage || 'No result in Yahoo Finance response');
  }

  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const adjCloses = result.indicators?.adjclose?.[0]?.adjclose ?? closes;

  const records = timestamps
    .map((timestamp, index) => ({
      date: toMonthDayYear(new Date(timestamp * 1000)),
      close: closes[index],
      adjClose: adjCloses[index] ?? closes[index],
    }))
    .filter((record) => typeof record.close === 'number' && Number.isFinite(record.close));

  if (!records.length) throw new Error('Response had no usable daily records');

  return {
    schemaVersion: 1,
    ticker,
    currency: result.meta?.currency ?? 'USD',
    exchangeName: result.meta?.exchangeName ?? null,
    source: 'https://query1.finance.yahoo.com/v8/finance/chart/ (unofficial Yahoo Finance endpoint)',
    fetchedAt: new Date().toISOString(),
    records,
  };
}

async function main() {
  await mkdir(BENCHMARK_DIR, { recursive: true });
  const tickers = await discoverTickers();
  if (!tickers.length) {
    console.log('No tickers found in backtest/input — nothing to fetch.');
    return;
  }

  console.log(`Found ${tickers.length} ticker(s): ${tickers.join(', ')}`);
  let fetched = 0;
  let skipped = 0;
  let failed = 0;

  for (const ticker of tickers) {
    const cachePath = path.join(BENCHMARK_DIR, `${ticker}.json`);
    if (!force && existsSync(cachePath)) {
      console.log(`  ${ticker}: already cached, skipping (pass --force to re-fetch)`);
      skipped += 1;
      continue;
    }
    try {
      const data = await fetchTicker(ticker);
      await writeFile(cachePath, JSON.stringify(data, null, 2));
      console.log(`  ${ticker}: fetched ${data.records.length} daily records -> benchmark/${ticker}.json`);
      fetched += 1;
    } catch (error) {
      console.error(`  ${ticker}: FAILED (${error instanceof Error ? error.message : error})`);
      failed += 1;
    }
    // Small delay between requests to stay polite to an unofficial, unrate-limited-by-us endpoint.
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  console.log(`\nDone. Fetched ${fetched}, skipped ${skipped} (already cached), failed ${failed}.`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exitCode = 1;
});
