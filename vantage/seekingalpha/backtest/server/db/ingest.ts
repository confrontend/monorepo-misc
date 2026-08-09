import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { getDb } from './client.js';

// This file lives at <project>/server/db/ingest.ts, so the project root is three levels up.
const projectRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// One folder. Nesting is allowed and irrelevant -- files are identified by what is inside them,
// never by their path or filename, so moving or renaming a file changes nothing except its
// rel_path. That is the whole reason the previous importer's `filename.includes('_historical_
// prices_')` check had to go: renaming a file made its contents silently invisible.
export const INPUT_DIR = path.join(projectRoot, 'input');
const PARSER_VERSION = 3;

export type FileKind = 'capture' | 'api_prices' | 'api_changes' | 'bundle' | 'benchmark' | 'unknown';
export type FileStatus = 'new' | 'changed' | 'imported' | 'failed';

export type ScannedFile = {
  relPath: string;
  absPath: string;
  bytes: number;
  mtimeMs: number;
  sha256: string;
};

export type FileReport = {
  relPath: string;
  status: FileStatus;
  kind: FileKind;
  bytes: number;
  priceRows: number;
  ratingRows: number;
  quantRows: number;
  benchmarkRows: number;
  importedAt: string | null;
  error: string | null;
};

export type ImportSummary = {
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  filesScanned: number;
  filesImported: number;
  filesFailed: number;
  filesUnchanged: number;
  filesMissing: string[];
  priceRows: number;
  ratingRows: number;
  quantRows: number;
  benchmarkRows: number;
  dataVersion: number;
};

export type RecentProcessedSymbol = {
  slug: string;
  symbol: string;
  fundType: string | null;
  processedAt: string;
  kinds: string[];
};

let recentSymbolsCache: {
  mtimeMs: number;
  bytes: number;
  symbols: RecentProcessedSymbol[];
} | null = null;

// The consolidation file is sorted alphabetically for stable diffs, so its physical last row is
// not the last symbol fetched upstream. Each wrapper retains `_ts`, the upstream processing time.
// Read those timestamps and cache the four newest unique slugs by file identity; this gives the
// Data screen a useful resume checkpoint without re-parsing the large bundle on every status poll.
const readRecentProcessedSymbols = (): RecentProcessedSymbol[] => {
  const bundlePath = path.join(INPUT_DIR, '3-year', 'consolidated_unique.json');
  let stats;
  try {
    stats = statSync(bundlePath);
  } catch {
    recentSymbolsCache = null;
    return [];
  }
  if (recentSymbolsCache?.mtimeMs === stats.mtimeMs && recentSymbolsCache.bytes === stats.size) {
    return recentSymbolsCache.symbols;
  }

  try {
    const payload = JSON.parse(readFileSync(bundlePath, 'utf8')) as Json;
    if (!Array.isArray(payload)) return [];
    const bySlug = new Map<string, { processedAtMs: number; fundType: string | null; kinds: Set<string> }>();
    payload.forEach((wrapper) => {
      const slug = typeof wrapper?._slug === 'string' ? wrapper._slug.trim().toLowerCase() : '';
      const processedAtMs = numberOrNull(wrapper?._ts) ?? 0;
      if (!slug || processedAtMs <= 0) return;
      const ticker = Array.isArray(wrapper?.body?.included)
        ? wrapper.body.included.find((entry: Json) => entry?.type === 'ticker'
          && String(entry?.attributes?.slug ?? '').toLowerCase() === slug)
        : null;
      const fundType = typeof ticker?.attributes?.fundType === 'string' && ticker.attributes.fundType.trim()
        ? ticker.attributes.fundType.trim() : null;
      const existing = bySlug.get(slug) ?? { processedAtMs: 0, fundType: null, kinds: new Set<string>() };
      existing.processedAtMs = Math.max(existing.processedAtMs, processedAtMs);
      if (fundType) existing.fundType = fundType;
      if (typeof wrapper?._kind === 'string') existing.kinds.add(wrapper._kind);
      bySlug.set(slug, existing);
    });
    const symbols = [...bySlug.entries()]
      .sort((left, right) => right[1].processedAtMs - left[1].processedAtMs || left[0].localeCompare(right[0]))
      .slice(0, 4)
      .map(([slug, value]) => ({
        slug,
        symbol: slug.toUpperCase(),
        fundType: value.fundType,
        processedAt: new Date(value.processedAtMs).toISOString(),
        kinds: [...value.kinds].sort(),
      }));
    recentSymbolsCache = { mtimeMs: stats.mtimeMs, bytes: stats.size, symbols };
    return symbols;
  } catch {
    return [];
  }
};

// --- scanning --------------------------------------------------------------------------------

const walk = async (dir: string): Promise<string[]> => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // an absent input folder is a valid empty state, not an error
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) found.push(full);
  }
  return found;
};

export const scanInputFolder = async (): Promise<ScannedFile[]> => {
  const files = await walk(INPUT_DIR);
  return files.map((absPath) => {
    const stats = statSync(absPath);
    return {
      absPath,
      relPath: path.relative(INPUT_DIR, absPath).split(path.sep).join('/'),
      bytes: stats.size,
      mtimeMs: stats.mtimeMs,
      // Content hash, not mtime: copying files around or restoring from a backup changes mtime
      // without changing anything that matters, and re-parsing 94 MB for nothing is worth avoiding.
      sha256: createHash('sha256').update(readFileSync(absPath)).digest('hex'),
    };
  }).sort((left, right) => left.relPath.localeCompare(right.relPath));
};

// --- content-based detection ----------------------------------------------------------------

type Json = any;

export const detectKind = (payload: Json): FileKind => {
  if (Array.isArray(payload)) {
    return payload.some((entry) => entry && typeof entry === 'object' && '_kind' in entry && 'body' in entry)
      ? 'bundle' : 'unknown';
  }
  if (!payload || typeof payload !== 'object') return 'unknown';

  if (Array.isArray(payload?.quantRatingHistory?.records)) return 'capture';
  if (typeof payload?.ticker === 'string' && Array.isArray(payload?.records)
    && payload.records.some((row: Json) => row && ('adjClose' in row || 'close' in row))) return 'benchmark';

  if (Array.isArray(payload?.data)) {
    const attributes = payload.data.find((row: Json) => row?.attributes)?.attributes;
    if (attributes) {
      if ('as_of_date' in attributes && 'close' in attributes) return 'api_prices';
      if ('createdAt' in attributes && 'newRating' in attributes) return 'api_changes';
    }
    // A ticker with no rating changes in the window returns `{data: [], included: [], meta}`.
    // That is a valid, successful API response carrying zero rows — not an unreadable file — so
    // it is identified from the endpoint path in `meta` and imported as an empty result. Marking
    // it "unknown" would leave three permanently-failed files in the UI that nobody can fix.
    const endpoint = typeof payload?.meta?.path === 'string' ? payload.meta.path : '';
    if (endpoint.includes('ticker_changes')) return 'api_changes';
    if (endpoint.includes('historical_price')) return 'api_prices';
  }
  return 'unknown';
};

// --- parsing ---------------------------------------------------------------------------------

type PriceRow = {
  slug: string; date: string; open: number | null; high: number | null; low: number | null;
  close: number; volume: number | null; divAdjFactor: number; apiId: string | null;
};
type RatingRow = {
  apiId: string; slug: string; createdAt: string; newRating: string | null; previousRating: string | null;
  ratingNew: number | null; ratingPrevious: number | null; marketCap: number | null;
  divYield: number | null; analysts: number | null; sectorDisplay: string | null;
};
type QuantRow = {
  slug: string; date: string; price: number | null; quantRating: string | null; quantScore: number | null;
  valuation: string | null; growth: string | null; profitability: string | null;
  momentum: string | null; epsRevisions: string | null;
};
type BenchmarkRow = { symbol: string; date: string; close: number | null; adjClose: number | null };
type TickerRow = {
  slug: string; name: string | null; companyName: string | null;
  exchange: string | null; currency: string | null; sector: string | null; fundType: string | null;
};

type ParsedFile = {
  prices: PriceRow[];
  ratings: RatingRow[];
  quant: QuantRow[];
  benchmark: BenchmarkRow[];
  tickers: TickerRow[];
};

const emptyParse = (): ParsedFile => ({ prices: [], ratings: [], quant: [], benchmark: [], tickers: [] });

const numberOrNull = (value: unknown): number | null =>
  (typeof value === 'number' && Number.isFinite(value) ? value : null);

// "08/03/2026" (captures, benchmark) and "2023-07-31" / ISO timestamps (API) both appear.
// Everything is normalised to YYYY-MM-DD on the way in so no consumer has to know which
// source a row came from in order to compare two dates.
const toIsoDate = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const usFormat = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (usFormat) return `${usFormat[3]}-${usFormat[1]}-${usFormat[2]}`;
  const isoPrefix = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoPrefix) return isoPrefix[1];
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
};

const resolveIncludedTicker = (included: Json[] | undefined, tickerId: unknown) => {
  if (tickerId === undefined || tickerId === null) return null;
  return included?.find((entry) => entry?.type === 'ticker' && String(entry.id) === String(tickerId)) ?? null;
};

const tickerRowFrom = (included: Json[] | undefined, entry: Json): TickerRow | null => {
  const attributes = entry?.attributes;
  const slug = typeof attributes?.slug === 'string' ? attributes.slug.toLowerCase() : null;
  if (!slug) return null;
  const sectorId = entry?.relationships?.sector?.data?.id;
  const sector = included?.find((item) => item?.type === 'sector' && String(item.id) === String(sectorId));
  return {
    slug,
    name: attributes.name ?? null,
    companyName: attributes.companyName ?? attributes.company ?? null,
    exchange: attributes.exchange ?? null,
    currency: attributes.currency ?? null,
    sector: sector?.attributes?.name ?? null,
    fundType: typeof attributes.fundType === 'string' ? attributes.fundType : null,
  };
};

const parseApiPrices = (payload: Json): ParsedFile => {
  const parsed = emptyParse();
  const included: Json[] | undefined = payload.included;
  included?.forEach((entry) => {
    if (entry?.type !== 'ticker') return;
    const row = tickerRowFrom(included, entry);
    if (row) parsed.tickers.push(row);
  });
  payload.data.forEach((record: Json) => {
    const attributes = record?.attributes ?? {};
    const ticker = resolveIncludedTicker(included, record?.relationships?.ticker?.data?.id);
    const slug = typeof ticker?.attributes?.slug === 'string' ? ticker.attributes.slug.toLowerCase() : null;
    const date = toIsoDate(attributes.as_of_date);
    const close = numberOrNull(attributes.close);
    if (!slug || !date || close === null || close <= 0) return;
    parsed.prices.push({
      slug, date, close,
      open: numberOrNull(attributes.open), high: numberOrNull(attributes.high),
      low: numberOrNull(attributes.low), volume: numberOrNull(attributes.volume),
      divAdjFactor: numberOrNull(attributes.div_adj_factor) ?? 1,
      apiId: record?.id !== undefined ? String(record.id) : null,
    });
  });
  return parsed;
};

const parseApiChanges = (payload: Json): ParsedFile => {
  const parsed = emptyParse();
  const included: Json[] | undefined = payload.included;
  included?.forEach((entry) => {
    if (entry?.type !== 'ticker') return;
    const row = tickerRowFrom(included, entry);
    if (row) parsed.tickers.push(row);
  });
  payload.data.forEach((record: Json) => {
    const attributes = record?.attributes ?? {};
    const ticker = resolveIncludedTicker(included, attributes.tickerId ?? record?.relationships?.ticker?.data?.id);
    const slug = typeof ticker?.attributes?.slug === 'string' ? ticker.attributes.slug.toLowerCase() : null;
    const createdAt = toIsoDate(attributes.createdAt);
    const apiId = record?.id !== undefined ? String(record.id) : null;
    if (!slug || !createdAt || !apiId) return;
    const sectorId = ticker?.relationships?.sector?.data?.id;
    const sector = included?.find((item) => item?.type === 'sector' && String(item.id) === String(sectorId));
    parsed.ratings.push({
      apiId, slug, createdAt,
      newRating: attributes.newRating ?? null,
      previousRating: attributes.previousRating ?? null,
      ratingNew: numberOrNull(attributes.ratingNew),
      ratingPrevious: numberOrNull(attributes.ratingPrevious),
      marketCap: numberOrNull(attributes.marketCap),
      divYield: numberOrNull(attributes.divYield),
      analysts: numberOrNull(attributes.analysts),
      sectorDisplay: sector?.attributes?.name ?? null,
    });
  });
  return parsed;
};

// The bundle carries its slug on the record (`_slug`). Newer exports also retain each response's
// `included` ticker metadata, which is where fundType lives. Older bundles without it continue to
// contribute their prices and ratings, but cannot be classified as an ETF.
const parseBundle = (payload: Json[]): ParsedFile => {
  const parsed = emptyParse();
  payload.forEach((record) => {
    const slug = typeof record?._slug === 'string' ? record._slug.toLowerCase() : null;
    const entries: Json[] = record?.body?.data ?? [];
    if (!slug || !Array.isArray(entries)) return;
    const included: Json[] | undefined = record?.body?.included;
    const tickerEntry = included?.find((entry) => entry?.type === 'ticker'
      && entry?.attributes?.slug?.toLowerCase() === slug);
    if (tickerEntry) {
      const ticker = tickerRowFrom(included, tickerEntry);
      if (ticker) parsed.tickers.push(ticker);
    }
    if (record._kind === 'prices') {
      entries.forEach((entry) => {
        const attributes = entry?.attributes ?? {};
        const date = toIsoDate(attributes.as_of_date);
        const close = numberOrNull(attributes.close);
        if (!date || close === null || close <= 0) return;
        parsed.prices.push({
          slug, date, close,
          open: numberOrNull(attributes.open), high: numberOrNull(attributes.high),
          low: numberOrNull(attributes.low), volume: numberOrNull(attributes.volume),
          divAdjFactor: numberOrNull(attributes.div_adj_factor) ?? 1,
          apiId: entry?.id !== undefined ? String(entry.id) : null,
        });
      });
    } else if (record._kind === 'changes') {
      entries.forEach((entry) => {
        const attributes = entry?.attributes ?? {};
        const createdAt = toIsoDate(attributes.createdAt);
        const apiId = entry?.id !== undefined ? String(entry.id) : null;
        if (!createdAt || !apiId) return;
        parsed.ratings.push({
          apiId, slug, createdAt,
          newRating: attributes.newRating ?? null,
          previousRating: attributes.previousRating ?? null,
          ratingNew: numberOrNull(attributes.ratingNew),
          ratingPrevious: numberOrNull(attributes.ratingPrevious),
          marketCap: numberOrNull(attributes.marketCap),
          divYield: numberOrNull(attributes.divYield),
          analysts: numberOrNull(attributes.analysts),
          sectorDisplay: attributes.sectorDisplay ?? null,
        });
      });
    } else if (record._kind === 'quant') {
      entries.forEach((entry) => {
        const date = toIsoDate(entry?.date);
        if (!date) return;
        parsed.quant.push({
          slug, date,
          price: numberOrNull(entry.price),
          quantRating: typeof entry.quantRating === 'string' ? entry.quantRating : null,
          quantScore: numberOrNull(entry.quantScore),
          valuation: entry.valuation ?? null,
          growth: entry.growth ?? null,
          profitability: entry.profitability ?? null,
          momentum: entry.momentum ?? null,
          epsRevisions: entry.epsRevisions ?? null,
        });
      });
    }
  });
  return parsed;
};

const parseCapture = (payload: Json): ParsedFile => {
  const parsed = emptyParse();
  const slug = typeof payload?.source?.ticker === 'string' ? payload.source.ticker.toLowerCase() : null;
  if (!slug) return parsed;
  parsed.tickers.push({
    slug,
    name: payload.source.ticker ?? null,
    companyName: payload.source.companyName ?? null,
    exchange: payload.source.exchange ?? null,
    currency: payload.source.currency ?? null,
    sector: null,
    fundType: typeof payload.source.fundType === 'string' ? payload.source.fundType : null,
  });
  payload.quantRatingHistory.records.forEach((record: Json) => {
    const date = toIsoDate(record?.date);
    if (!date) return;
    parsed.quant.push({
      slug, date,
      price: numberOrNull(record.price),
      quantRating: typeof record.quantRating === 'string' ? record.quantRating : null,
      quantScore: numberOrNull(record.quantScore),
      valuation: record.valuation ?? null, growth: record.growth ?? null,
      profitability: record.profitability ?? null, momentum: record.momentum ?? null,
      epsRevisions: record.epsRevisions ?? null,
    });
  });
  return parsed;
};

const parseBenchmark = (payload: Json): ParsedFile => {
  const parsed = emptyParse();
  const symbol = String(payload.ticker).toUpperCase();
  payload.records.forEach((record: Json) => {
    const date = toIsoDate(record?.date);
    if (!date) return;
    parsed.benchmark.push({
      symbol, date,
      close: numberOrNull(record.close),
      adjClose: numberOrNull(record.adjClose) ?? numberOrNull(record.close),
    });
  });
  return parsed;
};

export const parseFile = (payload: Json, kind: FileKind): ParsedFile => {
  if (kind === 'api_prices') return parseApiPrices(payload);
  if (kind === 'api_changes') return parseApiChanges(payload);
  if (kind === 'bundle') return parseBundle(payload);
  if (kind === 'capture') return parseCapture(payload);
  if (kind === 'benchmark') return parseBenchmark(payload);
  return emptyParse();
};

// --- writing ---------------------------------------------------------------------------------

const writeParsed = (db: DatabaseSync, fileId: number, parsed: ParsedFile) => {
  // Everything this file previously contributed goes first. A file that shrank between imports
  // would otherwise leave its removed rows behind forever, still attributed to it.
  for (const table of ['prices', 'rating_changes', 'quant_history', 'benchmark_prices']) {
    db.prepare(`DELETE FROM ${table} WHERE source_file_id = ?`).run(fileId);
  }

  const insertTicker = db.prepare(`
    INSERT INTO tickers (slug, name, company_name, exchange, currency, sector, fund_type, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET
      name = COALESCE(excluded.name, tickers.name),
      company_name = COALESCE(excluded.company_name, tickers.company_name),
      exchange = COALESCE(excluded.exchange, tickers.exchange),
      currency = COALESCE(excluded.currency, tickers.currency),
      sector = COALESCE(excluded.sector, tickers.sector),
      fund_type = COALESCE(excluded.fund_type, tickers.fund_type),
      last_seen = datetime('now')`);
  parsed.tickers.forEach((row) => insertTicker.run(
    row.slug, row.name, row.companyName, row.exchange, row.currency, row.sector, row.fundType));

  // The bundle carries no ticker metadata at all, so a slug that only ever appears there would
  // otherwise never reach the tickers table and would be invisible to anything that starts from
  // the ticker list. Register every slug that contributed a row, metadata or not.
  const seenSlugs = new Set<string>([
    ...parsed.prices.map((row) => row.slug),
    ...parsed.ratings.map((row) => row.slug),
    ...parsed.quant.map((row) => row.slug),
  ]);
  const registerSlug = db.prepare(`
    INSERT INTO tickers (slug, first_seen, last_seen) VALUES (?, datetime('now'), datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET last_seen = datetime('now')`);
  seenSlugs.forEach((slug) => registerSlug.run(slug));

  const insertPrice = db.prepare(`
    INSERT INTO prices (ticker_slug, as_of_date, open, high, low, close, volume,
                        div_adj_factor, adj_close, api_id, source_file_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker_slug, as_of_date) DO UPDATE SET
      open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
      volume = excluded.volume, div_adj_factor = excluded.div_adj_factor,
      adj_close = excluded.adj_close, api_id = excluded.api_id,
      source_file_id = excluded.source_file_id`);
  parsed.prices.forEach((row) => insertPrice.run(
    row.slug, row.date, row.open, row.high, row.low, row.close, row.volume,
    row.divAdjFactor, row.close * row.divAdjFactor, row.apiId, fileId));

  const insertRating = db.prepare(`
    INSERT INTO rating_changes (api_id, ticker_slug, created_at, new_rating, previous_rating,
                                rating_new, rating_previous, market_cap, div_yield, analysts,
                                sector_display, source_file_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(api_id) DO UPDATE SET
      ticker_slug = excluded.ticker_slug, created_at = excluded.created_at,
      new_rating = excluded.new_rating, previous_rating = excluded.previous_rating,
      rating_new = excluded.rating_new, rating_previous = excluded.rating_previous,
      market_cap = excluded.market_cap, div_yield = excluded.div_yield,
      analysts = excluded.analysts,
      sector_display = COALESCE(excluded.sector_display, rating_changes.sector_display),
      source_file_id = excluded.source_file_id`);
  parsed.ratings.forEach((row) => insertRating.run(
    row.apiId, row.slug, row.createdAt, row.newRating, row.previousRating, row.ratingNew,
    row.ratingPrevious, row.marketCap, row.divYield, row.analysts, row.sectorDisplay, fileId));

  const insertQuant = db.prepare(`
    INSERT INTO quant_history (ticker_slug, as_of_date, price, quant_rating, quant_score,
                               valuation, growth, profitability, momentum, eps_revisions, source_file_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker_slug, as_of_date) DO UPDATE SET
      price = excluded.price, quant_rating = excluded.quant_rating, quant_score = excluded.quant_score,
      valuation = excluded.valuation, growth = excluded.growth, profitability = excluded.profitability,
      momentum = excluded.momentum, eps_revisions = excluded.eps_revisions,
      source_file_id = excluded.source_file_id`);
  parsed.quant.forEach((row) => insertQuant.run(
    row.slug, row.date, row.price, row.quantRating, row.quantScore, row.valuation, row.growth,
    row.profitability, row.momentum, row.epsRevisions, fileId));

  const insertBenchmark = db.prepare(`
    INSERT INTO benchmark_prices (symbol, as_of_date, close, adj_close, source, source_file_id)
    VALUES (?, ?, ?, ?, 'yahoo', ?)
    ON CONFLICT(symbol, as_of_date) DO UPDATE SET
      close = excluded.close, adj_close = excluded.adj_close, source_file_id = excluded.source_file_id`);
  parsed.benchmark.forEach((row) => insertBenchmark.run(
    row.symbol, row.date, row.close, row.adjClose, fileId));
};

// --- status and import -----------------------------------------------------------------------

type SourceFileRow = {
  id: number; rel_path: string; sha256: string; kind: string; status: string; error: string | null;
  parser_version: number;
  price_rows: number; rating_rows: number; quant_rows: number; benchmark_rows: number; imported_at: string;
};

const readSourceFiles = (db: DatabaseSync) =>
  new Map((db.prepare('SELECT * FROM source_files').all() as unknown as SourceFileRow[])
    .map((row) => [row.rel_path, row]));

export const getDataVersion = (db: DatabaseSync = getDb()) =>
  db.prepare('SELECT * FROM data_version WHERE id = 1').get() as unknown as {
    version: number; updated_at: string; file_count: number; price_rows: number;
    rating_rows: number; last_import_json: string | null;
  };

export const getProcessedSymbols = () => {
  const db = getDb();
  const version = getDataVersion(db);
  const rows = db.prepare(`
    SELECT ticker_slug AS slug
    FROM prices
    JOIN source_files ON source_files.id = prices.source_file_id
    WHERE source_files.rel_path = '3-year/consolidated_unique.json'
    UNION
    SELECT ticker_slug AS slug
    FROM rating_changes
    JOIN source_files ON source_files.id = rating_changes.source_file_id
    WHERE source_files.rel_path = '3-year/consolidated_unique.json'
    UNION
    SELECT ticker_slug AS slug
    FROM quant_history
    JOIN source_files ON source_files.id = quant_history.source_file_id
    WHERE source_files.rel_path = '3-year/consolidated_unique.json'
    ORDER BY slug`).all() as unknown as Array<{ slug: string }>;

  return {
    symbols: rows.map((row) => row.slug.toUpperCase()),
    dataVersion: version.version,
    updatedAt: version.updated_at,
  };
};

export const getDataStatus = async () => {
  const db = getDb();
  const scanned = await scanInputFolder();
  const known = readSourceFiles(db);
  const seen = new Set(scanned.map((file) => file.relPath));

  const files: FileReport[] = scanned.map((file) => {
    const existing = known.get(file.relPath);
    const status: FileStatus = !existing ? 'new'
      : existing.status === 'failed' ? 'failed'
        : existing.sha256 !== file.sha256 || existing.parser_version !== PARSER_VERSION ? 'changed' : 'imported';
    return {
      relPath: file.relPath,
      status,
      kind: (existing?.kind as FileKind) ?? 'unknown',
      bytes: file.bytes,
      priceRows: existing?.price_rows ?? 0,
      ratingRows: existing?.rating_rows ?? 0,
      quantRows: existing?.quant_rows ?? 0,
      benchmarkRows: existing?.benchmark_rows ?? 0,
      importedAt: existing?.imported_at ?? null,
      error: existing?.error ?? null,
    };
  });

  // Rows whose file is gone are reported, never deleted. Losing data because someone moved a
  // folder is not a failure mode worth having.
  const missing = [...known.keys()].filter((relPath) => !seen.has(relPath));

  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM tickers) AS tickers,
      (SELECT COUNT(*) FROM prices) AS priceRows,
      (SELECT COUNT(*) FROM rating_changes) AS ratingRows,
      (SELECT COUNT(*) FROM quant_history) AS quantRows,
      (SELECT COUNT(*) FROM benchmark_prices) AS benchmarkRows,
      (SELECT MIN(as_of_date) FROM prices) AS priceStart,
      (SELECT MAX(as_of_date) FROM prices) AS priceEnd`).get() as Record<string, number | string | null>;

  const version = getDataVersion(db);
  return {
    files,
    missing,
    counts,
    recentProcessedSymbols: readRecentProcessedSymbols(),
    dataVersion: version.version,
    updatedAt: version.updated_at,
    lastImport: version.last_import_json ? JSON.parse(version.last_import_json) as ImportSummary : null,
    pending: files.filter((file) => file.status === 'new' || file.status === 'changed').length,
  };
};

export const runImport = async (): Promise<ImportSummary> => {
  const db = getDb();
  const startedAt = new Date();
  const scanned = await scanInputFolder();
  const known = readSourceFiles(db);

  let imported = 0;
  let failed = 0;
  let unchanged = 0;

  for (const file of scanned) {
    const existing = known.get(file.relPath);
    if (existing && existing.sha256 === file.sha256 && existing.status === 'imported'
      && existing.parser_version === PARSER_VERSION) {
      unchanged += 1;
      continue;
    }

    let kind: FileKind = 'unknown';
    let parsed = emptyParse();
    let error: string | null = null;
    try {
      const payload = JSON.parse(readFileSync(file.absPath, 'utf8'));
      kind = detectKind(payload);
      if (kind === 'unknown') {
        error = 'Unrecognised JSON shape — not a capture, API response, bundle, or benchmark file';
      } else {
        parsed = parseFile(payload, kind);
      }
    } catch (cause) {
      error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    }

    // One transaction per file: a malformed file fails alone and the rest of the import still
    // lands, rather than an all-or-nothing run that a single bad file can block entirely.
    db.exec('BEGIN');
    try {
      const status = error ? 'failed' : 'imported';
      db.prepare(`
        INSERT INTO source_files (rel_path, sha256, bytes, mtime_ms, kind, status, error, parser_version,
                                  price_rows, rating_rows, quant_rows, benchmark_rows, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(rel_path) DO UPDATE SET
          sha256 = excluded.sha256, bytes = excluded.bytes, mtime_ms = excluded.mtime_ms,
          kind = excluded.kind, status = excluded.status, error = excluded.error,
          parser_version = excluded.parser_version,
          price_rows = excluded.price_rows, rating_rows = excluded.rating_rows,
          quant_rows = excluded.quant_rows, benchmark_rows = excluded.benchmark_rows,
          imported_at = excluded.imported_at`).run(
        file.relPath, file.sha256, file.bytes, file.mtimeMs, kind, status, error, PARSER_VERSION,
        parsed.prices.length, parsed.ratings.length, parsed.quant.length, parsed.benchmark.length,
        new Date().toISOString());

      const fileId = (db.prepare('SELECT id FROM source_files WHERE rel_path = ?')
        .get(file.relPath) as unknown as { id: number }).id;
      if (!error) writeParsed(db, fileId, parsed);
      db.exec('COMMIT');
      if (error) failed += 1; else imported += 1;
    } catch (cause) {
      db.exec('ROLLBACK');
      failed += 1;
      console.error(`[ingest] ${file.relPath} failed:`, cause);
    }
  }

  const seen = new Set(scanned.map((file) => file.relPath));
  const missingBeforeCleanup = [...known.keys()].filter((relPath) => !seen.has(relPath));
  return finishImport(db, startedAt, scanned.length, imported, failed, unchanged, seen, missingBeforeCleanup);
};

// Shared by runImport() (disk-scanned files) and importUploadedFiles() (browser-uploaded files):
// dedupe cleanup, totals, and the data_version bump that tells /api/analysis to reload.
const finishImport = (
  db: DatabaseSync, startedAt: Date, filesScanned: number, imported: number, failed: number,
  unchanged: number, seen: Set<string>, missingBeforeCleanup: string[],
): ImportSummary => {
  // Consolidation deliberately replaces hundreds of source files with one verified bundle. Once
  // every row has been reassigned to that bundle, retaining the old empty source-file records only
  // creates a false "missing files" warning. Remove a missing record only when no data table still
  // references it; real missing sources that remain the sole owner of rows stay visible.
  const removeUnreferencedMissingSource = db.prepare(`
    DELETE FROM source_files
    WHERE rel_path = ?
      AND NOT EXISTS (SELECT 1 FROM prices WHERE source_file_id = source_files.id)
      AND NOT EXISTS (SELECT 1 FROM rating_changes WHERE source_file_id = source_files.id)
      AND NOT EXISTS (SELECT 1 FROM quant_history WHERE source_file_id = source_files.id)
      AND NOT EXISTS (SELECT 1 FROM benchmark_prices WHERE source_file_id = source_files.id)`);
  missingBeforeCleanup.forEach((relPath) => removeUnreferencedMissingSource.run(relPath));
  const remainingSources = readSourceFiles(db);
  const totals = db.prepare(`
    SELECT (SELECT COUNT(*) FROM prices) AS priceRows,
           (SELECT COUNT(*) FROM rating_changes) AS ratingRows,
           (SELECT COUNT(*) FROM quant_history) AS quantRows,
           (SELECT COUNT(*) FROM benchmark_prices) AS benchmarkRows`)
    .get() as unknown as Record<string, number>;

  const finishedAt = new Date();
  const summary: ImportSummary = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    elapsedMs: finishedAt.getTime() - startedAt.getTime(),
    filesScanned,
    filesImported: imported,
    filesFailed: failed,
    filesUnchanged: unchanged,
    filesMissing: [...remainingSources.keys()].filter((relPath) => !seen.has(relPath)),
    priceRows: totals.priceRows,
    ratingRows: totals.ratingRows,
    quantRows: totals.quantRows,
    benchmarkRows: totals.benchmarkRows,
    dataVersion: 0,
  };

  // Only a real change bumps the version. An import that found nothing new must not invalidate
  // every cached result downstream.
  const current = getDataVersion(db);
  const nextVersion = imported > 0 || failed > 0 ? current.version + 1 : current.version;
  summary.dataVersion = nextVersion;
  db.prepare(`
    UPDATE data_version SET version = ?, updated_at = ?, file_count = ?, price_rows = ?,
                            rating_rows = ?, last_import_json = ? WHERE id = 1`).run(
    nextVersion, finishedAt.toISOString(), filesScanned, totals.priceRows, totals.ratingRows,
    JSON.stringify(summary));

  return summary;
};

// Browser-uploaded counterpart to runImport(): same per-file classify/parse/write pipeline and the
// same permanent writer (tickers/prices/rating_changes/...), just sourced from an in-memory upload
// instead of a disk scan. relPath is namespaced under uploads/ so it can never collide with a file
// someone later drops into input/.
export const importUploadedFiles = async (
  files: Array<{ name: string; content: string }>,
): Promise<ImportSummary> => {
  const db = getDb();
  const startedAt = new Date();
  const known = readSourceFiles(db);

  let imported = 0;
  let failed = 0;
  let unchanged = 0;
  // Uploads never rescan the disk, so every previously known file (disk-imported or uploaded
  // earlier) must count as "seen" here -- otherwise finishImport's missing-file detection would
  // wrongly report every file this particular upload didn't happen to include as newly missing.
  const seen = new Set<string>(known.keys());

  for (const file of files) {
    const relPath = `uploads/${startedAt.toISOString().replace(/[:.]/g, '-')}-${file.name}`;
    seen.add(relPath);
    const sha256 = createHash('sha256').update(file.content, 'utf8').digest('hex');
    const existing = known.get(relPath);
    if (existing && existing.sha256 === sha256 && existing.status === 'imported'
      && existing.parser_version === PARSER_VERSION) {
      unchanged += 1;
      continue;
    }

    let kind: FileKind = 'unknown';
    let parsed = emptyParse();
    let error: string | null = null;
    try {
      const payload = JSON.parse(file.content);
      kind = detectKind(payload);
      if (kind === 'unknown') {
        error = 'Unrecognised JSON shape — not a capture, API response, bundle, or benchmark file';
      } else {
        parsed = parseFile(payload, kind);
      }
    } catch (cause) {
      error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    }

    db.exec('BEGIN');
    try {
      const status = error ? 'failed' : 'imported';
      db.prepare(`
        INSERT INTO source_files (rel_path, sha256, bytes, mtime_ms, kind, status, error, parser_version,
                                  price_rows, rating_rows, quant_rows, benchmark_rows, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(rel_path) DO UPDATE SET
          sha256 = excluded.sha256, bytes = excluded.bytes, mtime_ms = excluded.mtime_ms,
          kind = excluded.kind, status = excluded.status, error = excluded.error,
          parser_version = excluded.parser_version,
          price_rows = excluded.price_rows, rating_rows = excluded.rating_rows,
          quant_rows = excluded.quant_rows, benchmark_rows = excluded.benchmark_rows,
          imported_at = excluded.imported_at`).run(
        relPath, sha256, Buffer.byteLength(file.content, 'utf8'), startedAt.getTime(), kind, status, error,
        PARSER_VERSION, parsed.prices.length, parsed.ratings.length, parsed.quant.length,
        parsed.benchmark.length, new Date().toISOString());

      const fileId = (db.prepare('SELECT id FROM source_files WHERE rel_path = ?')
        .get(relPath) as unknown as { id: number }).id;
      if (!error) writeParsed(db, fileId, parsed);
      db.exec('COMMIT');
      if (error) failed += 1; else imported += 1;
    } catch (cause) {
      db.exec('ROLLBACK');
      failed += 1;
      console.error(`[ingest] upload ${file.name} failed:`, cause);
    }
  }

  return finishImport(db, startedAt, files.length, imported, failed, unchanged, seen, []);
};
