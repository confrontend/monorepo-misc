import { getDb } from './client.js';
import { getDataVersion } from './ingest.js';

// Builds the in-memory shapes src/data.ts used to get from import.meta.glob, straight out of the
// database instead. Deliberately produces byte-identical structures rather than a nicer schema:
// the whole point of the migration was to change where the data comes from without touching a
// single line of the analysis that consumes it.
//
// Typed structurally rather than by importing from src/data.ts — server/ compiles under
// tsconfig.node.json and src/ under tsconfig.app.json, the same split analysisModule.ts already
// works around. The shapes are asserted by the parity gate, not by the compiler.

type Rating = 'Strong Buy' | 'Buy' | 'Hold' | 'Sell' | 'Strong Sell';
type CaptureRecord = { date: string; price: number; quantRating: Rating; quantScore: number };
type CaptureDataset = {
  capture: {
    capturedAt: string;
    source: { ticker: string; companyName: string; currentPrice: number; quantRating: Rating; quantScore: number; fundType: string | null; sector: string | null };
    quantRatingHistory: { records: CaptureRecord[] };
  };
  sourceFile: string;
  records: CaptureRecord[];
  priceBasis: 'adjusted' | 'capture';
};
type BenchmarkQuote = { date: string; close: number; adjClose: number };

// Seeking Alpha's feed taxonomy -> the five labels used throughout the app. Anything outside this
// map (the real data contains stray nulls and "-") is not a rating and is dropped, exactly as the
// previous loader did.
const SA_RATING_MAP: Record<string, Rating> = {
  very_bullish: 'Strong Buy',
  bullish: 'Buy',
  neutral: 'Hold',
  bearish: 'Sell',
  very_bearish: 'Strong Sell',
};
const VALID_RATINGS = new Set<string>(['Strong Buy', 'Buy', 'Hold', 'Sell', 'Strong Sell']);

// Scores are only present on change events (rating_new). A capture row carries its own score.
// Where a reconstruction needs one and the feed didn't supply it, the tier midpoint is used —
// the same fallback the previous loader relied on by simply dropping such rows, except here the
// row is kept only when a real score exists, to avoid inventing precision.
type PriceRow = { ticker_slug: string; as_of_date: string; adj_close: number };
type ChangeRow = {
  ticker_slug: string; created_at: string;
  new_rating: string | null; previous_rating: string | null;
  rating_new: number | null; rating_previous: number | null;
  sector_display: string | null;
};
type QuantRow = {
  ticker_slug: string; as_of_date: string; price: number | null;
  quant_rating: string | null; quant_score: number | null;
};
type TickerRow = { slug: string; company_name: string | null; name: string | null; fund_type: string | null; sector: string | null };

const groupBy = <T>(rows: T[], key: (row: T) => string): Map<string, T[]> => {
  const map = new Map<string, T[]>();
  rows.forEach((row) => {
    const bucket = map.get(key(row));
    if (bucket) bucket.push(row); else map.set(key(row), [row]);
  });
  return map;
};

export type LoadedData = {
  datasets: CaptureDataset[];
  benchmarks: Array<[string, BenchmarkQuote[]]>;
  dataVersion: number;
  universe: { total: number; reconstructed: number; snapshotOnly: number };
};

export const loadDatasetsFromDb = (): LoadedData => {
  const db = getDb();

  const prices = db.prepare(
    'SELECT ticker_slug, as_of_date, adj_close FROM prices WHERE adj_close > 0 ORDER BY ticker_slug, as_of_date',
  ).all() as unknown as PriceRow[];
  const changes = db.prepare(
    'SELECT ticker_slug, created_at, new_rating, previous_rating, rating_new, rating_previous, sector_display '
    + 'FROM rating_changes ORDER BY ticker_slug, created_at',
  ).all() as unknown as ChangeRow[];
  const quant = db.prepare(
    'SELECT ticker_slug, as_of_date, price, quant_rating, quant_score FROM quant_history ORDER BY ticker_slug, as_of_date',
  ).all() as unknown as QuantRow[];
  const tickers = new Map((db.prepare('SELECT slug, company_name, name, fund_type, sector FROM tickers').all() as unknown as TickerRow[])
    .map((row) => [row.slug, row]));

  const pricesBySlug = groupBy(prices, (row) => row.ticker_slug);
  const changesBySlug = groupBy(changes, (row) => row.ticker_slug);
  const quantBySlug = groupBy(quant, (row) => row.ticker_slug);
  const latestSectorBySlug = new Map<string, string>();
  changes.forEach((row) => {
    if (row.sector_display?.trim()) latestSectorBySlug.set(row.ticker_slug, row.sector_display.trim());
  });

  const displayName = (slug: string) => {
    const row = tickers.get(slug);
    return row?.company_name ?? row?.name ?? slug.toUpperCase();
  };

  const datasets: CaptureDataset[] = [];
  let reconstructed = 0;
  let snapshotOnly = 0;

  // Preferred construction: real price history plus a real change-event log. Each price date takes
  // the rating from the most recent change on or before it. History before the first recorded
  // change uses that change's previous_rating as a stand-in — the feed only covers a fixed window,
  // so the true earlier rating is unknowable.
  for (const [slug, priceRows] of pricesBySlug) {
    const slugChanges = (changesBySlug.get(slug) ?? [])
      .map((row) => ({
        date: row.created_at.slice(0, 10),
        rating: row.new_rating ? SA_RATING_MAP[row.new_rating] : undefined,
        score: row.rating_new,
        previousRating: row.previous_rating ? SA_RATING_MAP[row.previous_rating] ?? null : null,
        previousScore: row.rating_previous,
      }))
      .filter((row): row is { date: string; rating: Rating; score: number; previousRating: Rating | null; previousScore: number | null } =>
        Boolean(row.rating) && typeof row.score === 'number' && Number.isFinite(row.score))
      .sort((left, right) => left.date.localeCompare(right.date));
    if (!slugChanges.length) continue;

    const leading = slugChanges[0].previousRating !== null && slugChanges[0].previousScore !== null
      ? { rating: slugChanges[0].previousRating, score: slugChanges[0].previousScore }
      : null;

    const records: CaptureRecord[] = [];
    let changeIndex = 0;
    let current: { rating: Rating; score: number } | null = leading;
    // Both arrays are date-sorted, so this is a single merge pass rather than the previous
    // loader's inner scan over every change for every price row.
    for (const priceRow of priceRows) {
      while (changeIndex < slugChanges.length && slugChanges[changeIndex].date <= priceRow.as_of_date) {
        current = { rating: slugChanges[changeIndex].rating, score: slugChanges[changeIndex].score };
        changeIndex += 1;
      }
      if (!current) continue;
      records.push({
        date: priceRow.as_of_date,
        price: priceRow.adj_close,
        quantRating: current.rating,
        quantScore: current.score,
      });
    }
    if (!records.length) continue;

    const last = records[records.length - 1];
    datasets.push({
      capture: {
        capturedAt: last.date,
        source: {
          ticker: slug.toUpperCase(),
          companyName: displayName(slug),
          currentPrice: last.price,
          quantRating: last.quantRating,
          quantScore: last.quantScore,
          fundType: tickers.get(slug)?.fund_type ?? null,
          sector: tickers.get(slug)?.sector ?? latestSectorBySlug.get(slug) ?? null,
        },
        quantRatingHistory: { records },
      },
      sourceFile: `db:${slug}`,
      records,
      priceBasis: 'adjusted',
    });
    reconstructed += 1;
  }

  // Fallback: tickers that only ever appeared as a hand-curated daily snapshot. These carry their
  // own rating per day, so nothing is reconstructed — the rows are used as they stand.
  const covered = new Set(datasets.map((dataset) => dataset.capture.source.ticker));
  for (const [slug, quantRows] of quantBySlug) {
    if (covered.has(slug.toUpperCase())) continue;
    const records: CaptureRecord[] = quantRows
      .filter((row) => typeof row.price === 'number' && row.price > 0
        && typeof row.quant_score === 'number' && Number.isFinite(row.quant_score)
        && row.quant_rating !== null && VALID_RATINGS.has(row.quant_rating))
      .map((row) => ({
        date: row.as_of_date,
        price: row.price as number,
        quantRating: row.quant_rating as Rating,
        quantScore: row.quant_score as number,
      }));
    if (!records.length) continue;
    const last = records[records.length - 1];
    datasets.push({
      capture: {
        capturedAt: last.date,
        source: {
          ticker: slug.toUpperCase(),
          companyName: displayName(slug),
          currentPrice: last.price,
          quantRating: last.quantRating,
          quantScore: last.quantScore,
          fundType: tickers.get(slug)?.fund_type ?? null,
          sector: tickers.get(slug)?.sector ?? latestSectorBySlug.get(slug) ?? null,
        },
        quantRatingHistory: { records },
      },
      sourceFile: `db:${slug}`,
      records,
      priceBasis: 'capture',
    });
    snapshotOnly += 1;
  }

  datasets.sort((left, right) => left.capture.source.ticker.localeCompare(right.capture.source.ticker));

  const benchmarkRows = db.prepare(
    'SELECT symbol, as_of_date, close, adj_close FROM benchmark_prices ORDER BY symbol, as_of_date',
  ).all() as unknown as Array<{ symbol: string; as_of_date: string; close: number; adj_close: number }>;
  const benchmarks = [...groupBy(benchmarkRows, (row) => row.symbol).entries()].map(([symbol, rows]) =>
    [symbol, rows.map((row) => ({ date: row.as_of_date, close: row.close, adjClose: row.adj_close }))] as [string, BenchmarkQuote[]]);

  return {
    datasets,
    benchmarks,
    dataVersion: getDataVersion(db).version,
    universe: { total: datasets.length, reconstructed, snapshotOnly },
  };
};
