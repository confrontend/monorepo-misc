import { getDb } from './client.js';

export type TrackedPortfolioLotInput = { ticker: string; quantity: number; entryPrice: number };
export type CreateTrackedPortfolioInput = {
  name: string;
  family: string;
  filter: string;
  persistence: string | null;
  hold: string;
  entryDate: string;
  lots: TrackedPortfolioLotInput[];
};

export type TrackedPortfolioLot = TrackedPortfolioLotInput;
export type TrackedPortfolioSnapshot = { capturedAt: string; totalValue: number; totalChangePercent: number | null };
export type TrackedPortfolio = {
  id: number;
  name: string;
  family: string;
  filter: string;
  persistence: string | null;
  hold: string;
  entryDate: string;
  createdAt: string;
  lots: TrackedPortfolioLot[];
  costBasis: number;
  latestSnapshot: TrackedPortfolioSnapshot | null;
  snapshots: TrackedPortfolioSnapshot[];
  spyReturnSinceEntry: number | null;
};

// SPY's own return over the exact window a checkout has actually been held, read directly from the
// same benchmark_prices table the Python research pipeline and data.ts both use -- not recomputed
// with a different convention. "On or before" on both ends mirrors data.ts's quoteOnOrBefore so a
// missing exact-date row (holiday, gap) still resolves to the last real trading session.
const spyCloseOnOrBefore = (date: string): number | null => {
  const db = getDb();
  const row = db.prepare(
    'SELECT adj_close FROM benchmark_prices WHERE symbol = ? AND as_of_date <= ? ORDER BY as_of_date DESC LIMIT 1',
  ).get('SPY', date) as { adj_close: number | null } | undefined;
  return row?.adj_close ?? null;
};

const spyReturnBetween = (startDate: string, endDate: string): number | null => {
  const start = spyCloseOnOrBefore(startDate);
  const end = spyCloseOnOrBefore(endDate);
  if (start === null || end === null || start <= 0) return null;
  return (end / start - 1) * 100;
};

export const createTrackedPortfolio = (input: CreateTrackedPortfolioInput): { id: number } => {
  if (!input.lots.length) throw new Error('A tracked portfolio needs at least one lot.');
  const db = getDb();
  const existing = db.prepare('SELECT id FROM tracked_portfolios WHERE name = ?').get(input.name) as { id: number } | undefined;
  if (existing) throw new Error(`A tracked portfolio named "${input.name}" already exists.`);
  db.exec('BEGIN');
  try {
    db.prepare(
      'INSERT INTO tracked_portfolios (name, family, filter, persistence, hold, entry_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(input.name, input.family, input.filter, input.persistence, input.hold, input.entryDate, new Date().toISOString());
    const portfolioId = db.prepare('SELECT id FROM tracked_portfolios WHERE name = ?').get(input.name) as { id: number };
    const insertLot = db.prepare('INSERT INTO tracked_portfolio_lots (portfolio_id, ticker, quantity, entry_price) VALUES (?, ?, ?, ?)');
    for (const lot of input.lots) insertLot.run(portfolioId.id, lot.ticker.toLowerCase(), lot.quantity, lot.entryPrice);
    db.exec('COMMIT');
    return { id: portfolioId.id };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};

export const listTrackedPortfolios = (): TrackedPortfolio[] => {
  const db = getDb();
  const portfolios = db.prepare(
    'SELECT id, name, family, filter, persistence, hold, entry_date, created_at FROM tracked_portfolios ORDER BY created_at DESC',
  ).all() as Array<{ id: number; name: string; family: string; filter: string; persistence: string | null; hold: string; entry_date: string; created_at: string }>;
  const lotStatement = db.prepare('SELECT ticker, quantity, entry_price FROM tracked_portfolio_lots WHERE portfolio_id = ?');
  const snapshotStatement = db.prepare(
    'SELECT captured_at, total_value, total_change_percent FROM tracked_portfolio_snapshots WHERE portfolio_id = ? ORDER BY captured_at ASC',
  );
  return portfolios.map((portfolio) => {
    const lots = (lotStatement.all(portfolio.id) as Array<{ ticker: string; quantity: number; entry_price: number }>)
      .map((row) => ({ ticker: row.ticker, quantity: row.quantity, entryPrice: row.entry_price }));
    const snapshots = (snapshotStatement.all(portfolio.id) as Array<{ captured_at: string; total_value: number; total_change_percent: number | null }>)
      .map((row) => ({ capturedAt: row.captured_at, totalValue: row.total_value, totalChangePercent: row.total_change_percent }));
    const latestSnapshot = snapshots.length ? snapshots[snapshots.length - 1] : null;
    return {
      id: portfolio.id,
      name: portfolio.name,
      family: portfolio.family,
      filter: portfolio.filter,
      persistence: portfolio.persistence,
      hold: portfolio.hold,
      entryDate: portfolio.entry_date,
      createdAt: portfolio.created_at,
      lots,
      costBasis: lots.reduce((sum, lot) => sum + lot.quantity * lot.entryPrice, 0),
      latestSnapshot,
      snapshots,
      spyReturnSinceEntry: latestSnapshot ? spyReturnBetween(portfolio.entry_date, latestSnapshot.capturedAt) : null,
    };
  });
};

export type SnapshotInput = { name: string; capturedAt: string; totalValue: number; totalChangePercent: number | null };
export type SnapshotOutcome = { name: string; matched: boolean };

// Matched by name, exactly as designed: a paste can contain many Seeking Alpha portfolios at once,
// most of which are not ones this app is tracking. Unmatched names are reported, not silently
// dropped, so a rename in Seeking Alpha shows up as a visible miss instead of a quiet no-op.
export const addTrackedPortfolioSnapshots = (entries: SnapshotInput[]): SnapshotOutcome[] => {
  const db = getDb();
  const findPortfolio = db.prepare('SELECT id FROM tracked_portfolios WHERE name = ?');
  const insertSnapshot = db.prepare(
    'INSERT INTO tracked_portfolio_snapshots (portfolio_id, captured_at, total_value, total_change_percent) VALUES (?, ?, ?, ?)',
  );
  return entries.map((entry) => {
    const portfolio = findPortfolio.get(entry.name) as { id: number } | undefined;
    if (!portfolio) return { name: entry.name, matched: false };
    insertSnapshot.run(portfolio.id, entry.capturedAt, entry.totalValue, entry.totalChangePercent);
    return { name: entry.name, matched: true };
  });
};
