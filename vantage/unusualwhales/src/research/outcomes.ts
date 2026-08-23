import type { DatabaseSync } from 'node:sqlite';

export const HORIZONS = ['+5m', '+30m', '+1h', '+1d', '+3d', '+5d', '+10d', '+20d'] as const;
export type Horizon = (typeof HORIZONS)[number];
export const COSTS_BPS_PER_SIDE = [10, 25, 50] as const;
export const DAILY_SESSION_HORIZONS: Partial<Record<Horizon, number>> = { '+1d': 1, '+3d': 3, '+5d': 5, '+10d': 10, '+20d': 20 };

const durationMs: Record<Horizon, number> = {
  '+5m': 5 * 60_000,
  '+30m': 30 * 60_000,
  '+1h': 60 * 60_000,
  '+1d': 24 * 60 * 60_000,
  '+3d': 3 * 24 * 60 * 60_000,
  '+5d': 5 * 24 * 60 * 60_000,
  '+10d': 10 * 24 * 60 * 60_000,
  '+20d': 20 * 24 * 60 * 60_000,
};

export type MarketBar = {
  symbol: string; timeframe: '1m' | '5m' | '1d'; observedAt: string;
  open?: number | null; high?: number | null; low?: number | null;
  close: number; volume?: number | null; source: string; retrievedAt?: string;
};

export const upsertMarketBars = (database: DatabaseSync, bars: MarketBar[]): number => {
  const insert = database.prepare(`INSERT INTO uw_market_bars
    (symbol,timeframe,observed_at,open,high,low,close,volume,source,retrieved_at)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(symbol,timeframe,observed_at) DO UPDATE SET
    open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,
    volume=excluded.volume,source=excluded.source,retrieved_at=excluded.retrieved_at`);
  let count = 0;
  for (const bar of bars) {
    if (!bar.symbol || !Number.isFinite(bar.close) || Number.isNaN(Date.parse(bar.observedAt))) continue;
    const result = insert.run(bar.symbol.toUpperCase(), bar.timeframe, new Date(bar.observedAt).toISOString(),
      bar.open ?? null, bar.high ?? null, bar.low ?? null, bar.close, bar.volume ?? null, bar.source,
      bar.retrievedAt ?? new Date().toISOString());
    count += Number(result.changes);
  }
  return count;
};

type Trade = { id: number; underlying_symbol: string; executed_at: string; signal_type: string };
type Bar = { observed_at: string; close: number };

const barsAfter = (database: DatabaseSync, symbol: string, timeframe: string, at: string, strictlyAfter?: string, limit = 0) =>
  database.prepare(`SELECT observed_at, close FROM uw_market_bars
    WHERE symbol = ? AND timeframe = ? AND observed_at >= ?${strictlyAfter ? ' AND observed_at > ?' : ''}
    ORDER BY observed_at ASC${limit > 0 ? ' LIMIT ?' : ''}`).all(...([symbol, timeframe, new Date(at).toISOString(), ...(strictlyAfter ? [new Date(strictlyAfter).toISOString()] : []), ...(limit > 0 ? [limit] : [])])) as unknown as Bar[];

const timeframeFor = (horizon: Horizon): '1m' | '5m' | '1d' => ['+1d', '+3d', '+5d', '+10d', '+20d'].includes(horizon) ? '1d' : '1m';

// Trades per explicit transaction. Without batching, every one of up to millions of
// individual outcome rows commits as its own autocommit transaction -- each one briefly
// taking SQLite's WAL write lock. That is what let a large outcome recalculation appear to
// starve concurrent readers (e.g. the comparison dashboard) even under WAL, where a writer
// and a reader are supposed to coexist without blocking each other. Batching turns millions
// of lock acquisitions into a few thousand.
const OUTCOME_TRANSACTION_BATCH_SIZE = 200;

/** Rebuilds deterministic outcome rows. The first bar at/after the event and target are used. */
export const refreshOutcomes = (database: DatabaseSync, now = new Date(), onProgress?: (progress: { completed: number; total: number }) => void, signalTypes = ['call_sweep', 'put_sweep', 'flow_imbalance']): number => {
  const placeholders = signalTypes.map(() => '?').join(',');
  const total = Number((database.prepare(`SELECT COUNT(*) AS count FROM uw_option_trades WHERE signal_type IN (${placeholders}) AND canceled=0 AND underlying_symbol IS NOT NULL AND executed_at IS NOT NULL`).get(...signalTypes) as { count?: number } | undefined)?.count ?? 0);
  // Checkpoints are progress telemetry only. Do not use a positional cursor to
  // filter this query: historical imports can arrive out of order, so a newly
  // imported older trade would otherwise be skipped forever after a restart.
  const checkpoint = database.prepare(`SELECT completed FROM uw_outcome_checkpoints WHERE scope='historical'`).get() as { completed?: number } | undefined;
  const trades = database.prepare(`SELECT id, underlying_symbol, executed_at, signal_type FROM uw_option_trades
    WHERE signal_type IN (${placeholders}) AND canceled=0 AND underlying_symbol IS NOT NULL AND executed_at IS NOT NULL
    ORDER BY underlying_symbol, executed_at, id`).all(...signalTypes) as unknown as Trade[];
  const insert = database.prepare(`INSERT INTO uw_signal_outcomes
    (trade_id,horizon,entry_at,entry_price,outcome_at,outcome_price,spy_entry_price,spy_outcome_price,
     return_pct,spy_return_pct,excess_return_pct,exclusion_reason,calculated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(trade_id,horizon) DO UPDATE SET
    entry_at=excluded.entry_at,entry_price=excluded.entry_price,outcome_at=excluded.outcome_at,
    outcome_price=excluded.outcome_price,spy_entry_price=excluded.spy_entry_price,spy_outcome_price=excluded.spy_outcome_price,
    return_pct=excluded.return_pct,spy_return_pct=excluded.spy_return_pct,excess_return_pct=excluded.excess_return_pct,
    exclusion_reason=excluded.exclusion_reason,calculated_at=excluded.calculated_at`);
  const previous = new Map<string, number>();
  let written = 0;
  // A resumed pass starts at the beginning so the overlap state is rebuilt from
  // the complete ordered event stream. The checkpoint's completed value is only
  // for diagnostics and must not cause rows to be skipped.
  let completed = 0;
  let transactionOpen = false;
  try {
    for (const trade of trades) {
      if (!transactionOpen) { database.exec('BEGIN'); transactionOpen = true; }
      const eventMs = Date.parse(trade.executed_at);
      for (const horizon of HORIZONS) {
        const targetMs = eventMs + durationMs[horizon];
        const timeframe = timeframeFor(horizon);
        const entryBars = barsAfter(database, trade.underlying_symbol, timeframe, trade.executed_at);
        const entry = entryBars[0];
        const key = `${trade.signal_type}:${trade.underlying_symbol}:${horizon}`;
        let reason: string | null = null;
        if (!entry) reason = 'missing_entry_price';
        else if (previous.has(key) && eventMs < (previous.get(key) as number) + durationMs[horizon]) reason = 'overlapping_event';
        else if (targetMs > now.getTime()) reason = 'outcome_not_mature';
        if (entry && reason !== 'overlapping_event') previous.set(key, eventMs);
        // The target lookup must be strictly after the entry bar. With daily bars,
        // a weekend target can otherwise select the same next-session bar as both
        // entry and outcome, producing a false zero return and inflated win rates.
        const sessionCount = DAILY_SESSION_HORIZONS[horizon];
        const outcome = entry && !reason
          ? sessionCount
            ? barsAfter(database, trade.underlying_symbol, '1d', entry.observed_at, entry.observed_at, sessionCount)[sessionCount - 1]
            : barsAfter(database, trade.underlying_symbol, timeframe, new Date(targetMs).toISOString(), entry.observed_at)[0]
          : undefined;
        if (entry && !reason && !outcome) reason = 'missing_outcome_price';
        const spyEntry = entry && !reason ? barsAfter(database, 'SPY', timeframe, entry.observed_at)[0] : undefined;
        const spyOutcome = outcome && !reason ? barsAfter(database, 'SPY', timeframe, outcome.observed_at)[0] : undefined;
        if (entry && !reason && (!spyEntry || !spyOutcome)) reason = 'missing_spy_price';
        const ret = entry && outcome && !reason ? ((outcome.close - entry.close) / entry.close) * 100 : null;
        const spyRet = spyEntry && spyOutcome && !reason ? ((spyOutcome.close - spyEntry.close) / spyEntry.close) * 100 : null;
        insert.run(trade.id, horizon, entry?.observed_at ?? null, entry?.close ?? null, outcome?.observed_at ?? null,
          outcome?.close ?? null, spyEntry?.close ?? null, spyOutcome?.close ?? null, ret, spyRet,
          ret !== null && spyRet !== null ? ret - spyRet : null, reason, now.toISOString());
        written++;
        // Independence is defined by event spacing, not by whether a price outcome
        // happened to be available. A missing outcome must not make the next event
        // look independent and inflate the sample.
      }
      completed++;
      if (completed % OUTCOME_TRANSACTION_BATCH_SIZE === 0 || completed === total) {
        database.exec('COMMIT');
        transactionOpen = false;
      }
      if (completed % OUTCOME_TRANSACTION_BATCH_SIZE === 0 || completed === total) {
        database.prepare(`INSERT INTO uw_outcome_checkpoints (scope,last_symbol,last_executed_at,last_trade_id,completed,total,updated_at) VALUES ('historical',?,?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET last_symbol=excluded.last_symbol,last_executed_at=excluded.last_executed_at,last_trade_id=excluded.last_trade_id,completed=excluded.completed,total=excluded.total,updated_at=excluded.updated_at`)
          .run(trade.underlying_symbol, trade.executed_at, trade.id, completed, total, new Date().toISOString());
      }
      if (completed === total || completed % 100 === 0) onProgress?.({ completed, total });
    }
  } catch (error) {
    if (transactionOpen) { try { database.exec('ROLLBACK'); } catch { /* connection may already be closed */ } }
    throw error;
  }
  database.prepare(`DELETE FROM uw_outcome_checkpoints WHERE scope='historical'`).run();
  return written;
};

export type OutcomeMetric = {
  nRaw: number; nIndependent: number; nMature: number; nWithOutcome: number;
  winRate: number | null; medianReturnPct: number | null; averageReturnPct: number | null;
  medianExcessPct: number | null; averageExcessPct: number | null;
  netByCostBpsPerSide: Record<string, number | null>; status: 'insufficient' | 'descriptive';
};

const median = (values: number[]) => { if (!values.length) return null; const sorted = [...values].sort((a,b) => a-b); const mid = Math.floor(sorted.length/2); return sorted.length % 2 ? sorted[mid] : (sorted[mid-1] + sorted[mid]) / 2; };
const avg = (values: number[]) => values.length ? values.reduce((a,b) => a+b, 0) / values.length : null;

export const readOutcomeSummary = (database: DatabaseSync, signalType = 'call_sweep'): Record<Horizon, OutcomeMetric> => {
  const result = {} as Record<Horizon, OutcomeMetric>;
  for (const horizon of HORIZONS) {
    // Outcomes are persisted during refresh. Use SQL counts/averages and fetch only
    // non-null returns for medians; never repeat per-trade price matching here.
    const stats = database.prepare(`SELECT COUNT(*) AS raw,
      SUM(CASE WHEN COALESCE(o.exclusion_reason,'') <> 'overlapping_event' THEN 1 ELSE 0 END) AS independent,
      SUM(CASE WHEN COALESCE(o.exclusion_reason,'') NOT IN ('overlapping_event','outcome_not_mature','missing_entry_price') THEN 1 ELSE 0 END) AS mature,
      SUM(CASE WHEN o.return_pct IS NOT NULL THEN 1 ELSE 0 END) AS usable,
      SUM(CASE WHEN o.return_pct > 0 THEN 1 ELSE 0 END) AS wins,
      AVG(o.return_pct) AS averageReturn, AVG(o.excess_return_pct) AS averageExcess
      FROM uw_signal_outcomes o JOIN uw_option_trades t ON t.id=o.trade_id
      WHERE o.horizon=? AND t.canceled=0 AND t.signal_type=?`).get(horizon, signalType) as { raw: number; independent: number; mature: number; usable: number; wins: number; averageReturn: number|null; averageExcess: number|null };
    const medianValue = (column: 'return_pct' | 'excess_return_pct') => {
      if (!Number(stats.usable)) return null;
      const row = database.prepare(`SELECT AVG(value) AS median FROM (SELECT o.${column} AS value
        FROM uw_signal_outcomes o JOIN uw_option_trades t ON t.id=o.trade_id
        WHERE o.horizon=? AND t.canceled=0 AND t.signal_type=? AND o.${column} IS NOT NULL
        ORDER BY o.${column} LIMIT 2 OFFSET ?)`)
        .get(horizon, signalType, Math.floor((Number(stats.usable) - 1) / 2)) as { median: number|null } | undefined;
      return row?.median === null || row?.median === undefined ? null : Number(row.median);
    };
    const returnsCount = Number(stats.usable ?? 0);
    const metric: OutcomeMetric = { nRaw: Number(stats.raw ?? 0), nIndependent: Number(stats.independent ?? 0), nMature: Number(stats.mature ?? 0), nWithOutcome: Number(stats.usable ?? 0),
      winRate: returnsCount ? Number(stats.wins ?? 0) / returnsCount * 100 : null,
      medianReturnPct: medianValue('return_pct'), averageReturnPct: stats.averageReturn === null ? null : Number(stats.averageReturn), medianExcessPct: medianValue('excess_return_pct'), averageExcessPct: stats.averageExcess === null ? null : Number(stats.averageExcess),
      netByCostBpsPerSide: Object.fromEntries(COSTS_BPS_PER_SIDE.map(cost => [String(cost), stats.averageReturn === null ? null : Number(stats.averageReturn) - cost * 2 / 100])),
      status: returnsCount >= 30 ? 'descriptive' : 'insufficient' };
    result[horizon] = metric;
  }
  return result;
};
