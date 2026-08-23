import type { DatabaseSync } from 'node:sqlite';
import { DAILY_SESSION_HORIZONS, HORIZONS, type Horizon } from './outcomes.js';

const durationMs: Record<Horizon, number> = { '+5m': 5 * 60_000, '+30m': 30 * 60_000, '+1h': 60 * 60_000, '+1d': 24 * 60 * 60_000, '+3d': 3 * 24 * 60 * 60_000, '+5d': 5 * 24 * 60 * 60_000, '+10d': 10 * 24 * 60 * 60_000, '+20d': 20 * 24 * 60 * 60_000 };
type EventRow = { id: number; signal_type: string; symbol: string; event_at: string; observable_at: string };
type Bar = { observed_at: string; close: number };

/** Bridges already-imported Dark Pool rows into the generic event model. */
export const materializeDarkPoolEvents = (database: DatabaseSync, capturedAt = new Date().toISOString()) => {
  const batch = database.prepare(`SELECT id FROM uw_import_batches WHERE endpoint='/api/darkpool/recent' ORDER BY id LIMIT 1`).get() as { id?: number } | undefined;
  const batchId = Number(batch?.id ?? database.prepare(`INSERT INTO uw_import_batches (endpoint,query_json,requested_at,status,completed_at) VALUES ('derived://dark-pool-events','{}',?,'completed',?)`).run(capturedAt, capturedAt).lastInsertRowid);
  const rows = database.prepare(`SELECT source_trade_id,executed_at,captured_at,ticker,raw_payload,validation_errors FROM uw_dark_pool_trades WHERE executed_at IS NOT NULL AND ticker IS NOT NULL`).all() as unknown as Array<{ source_trade_id: string; executed_at: string; captured_at: string; ticker: string; raw_payload: string; validation_errors: string }>;
  const insert = database.prepare(`INSERT OR IGNORE INTO uw_signal_events (source_event_id,source_batch_id,signal_type,event_at,published_at,observable_at,captured_at,symbol,outcome_symbol,prediction_mode,score,raw_payload,validation_errors) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let inserted = 0;
  for (const row of rows) {
    const result = insert.run(`dark_pool_block:${row.source_trade_id}`, batchId, 'dark_pool_block', row.executed_at, row.captured_at, row.captured_at, row.captured_at, row.ticker.toUpperCase(), row.ticker.toUpperCase(), 'directional', null, row.raw_payload, row.validation_errors ?? '[]');
    inserted += Number(result.changes);
  }
  return inserted;
};

const barsAfter = (database: DatabaseSync, symbol: string, timeframe: string, at: string, strictlyAfter?: string, limit = 0) => database.prepare(`SELECT observed_at,close FROM uw_market_bars WHERE symbol=? AND timeframe=? AND observed_at>=?${strictlyAfter ? ' AND observed_at>?' : ''} ORDER BY observed_at ASC${limit > 0 ? ' LIMIT ?' : ''}`).all(...([symbol, timeframe, new Date(at).toISOString(), ...(strictlyAfter ? [new Date(strictlyAfter).toISOString()] : []), ...(limit > 0 ? [limit] : [])])) as unknown as Bar[];
const timeframeFor = (horizon: Horizon): '1m' | '1d' => ['+1d', '+3d', '+5d', '+10d', '+20d'].includes(horizon) ? '1d' : '1m';

/** Price-matches non-trade events without using prices before the event became observable. */
export const refreshEventOutcomes = (database: DatabaseSync, now = new Date(), signalTypes?: string[]) => {
  const filter = signalTypes?.length ? ` WHERE signal_type IN (${signalTypes.map(() => '?').join(',')}) AND event_at IS NOT NULL AND observable_at IS NOT NULL AND symbol IS NOT NULL` : ' WHERE event_at IS NOT NULL AND observable_at IS NOT NULL AND symbol IS NOT NULL';
  const events = database.prepare(`SELECT id,signal_type,symbol,event_at,observable_at FROM uw_signal_events${filter}${filter.includes(' WHERE ') ? ' AND' : ' WHERE'} (signal_type <> 'gex_gamma' OR id IN (SELECT MIN(id) FROM uw_signal_events WHERE signal_type='gex_gamma' GROUP BY symbol,substr(event_at,1,10))) ORDER BY signal_type,symbol,event_at,id`).all(...(signalTypes ?? [])) as unknown as EventRow[];
  const insert = database.prepare(`INSERT INTO uw_signal_event_outcomes (event_id,horizon,entry_at,entry_price,outcome_at,outcome_price,spy_entry_price,spy_outcome_price,return_pct,spy_return_pct,excess_return_pct,exclusion_reason,calculated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id,horizon) DO UPDATE SET entry_at=excluded.entry_at,entry_price=excluded.entry_price,outcome_at=excluded.outcome_at,outcome_price=excluded.outcome_price,spy_entry_price=excluded.spy_entry_price,spy_outcome_price=excluded.spy_outcome_price,return_pct=excluded.return_pct,spy_return_pct=excluded.spy_return_pct,excess_return_pct=excluded.excess_return_pct,exclusion_reason=excluded.exclusion_reason,calculated_at=excluded.calculated_at`);
  const previous = new Map<string, number>();
  let written = 0;
  for (const event of events) {
    const eventMs = Date.parse(event.event_at);
    const observableMs = Date.parse(event.observable_at);
    for (const horizon of HORIZONS) {
      const timeframe = timeframeFor(horizon);
      const entry = barsAfter(database, event.symbol, timeframe, new Date(Math.max(eventMs, observableMs)).toISOString())[0];
      const key = `${event.signal_type}:${event.symbol}:${horizon}`;
      let reason: string | null = entry ? null : 'missing_entry_price';
      if (previous.has(key) && eventMs < previous.get(key)! + durationMs[horizon]) reason = 'overlapping_event';
      if (durationMs[horizon] + observableMs > now.getTime()) reason = 'outcome_not_mature';
      if (entry && reason !== 'overlapping_event') previous.set(key, eventMs);
      const sessionCount = DAILY_SESSION_HORIZONS[horizon];
      const outcome = entry && !reason
        ? sessionCount
          ? barsAfter(database, event.symbol, '1d', entry.observed_at, entry.observed_at, sessionCount)[sessionCount - 1]
          : barsAfter(database, event.symbol, timeframe, new Date(eventMs + durationMs[horizon]).toISOString(), entry.observed_at)[0]
        : undefined;
      if (entry && !reason && !outcome) reason = 'missing_outcome_price';
      const spyEntry = entry && !reason ? barsAfter(database, 'SPY', timeframe, entry.observed_at)[0] : undefined;
      const spyOutcome = outcome && !reason ? barsAfter(database, 'SPY', timeframe, outcome.observed_at)[0] : undefined;
      if (entry && !reason && (!spyEntry || !spyOutcome)) reason = 'missing_spy_price';
      const ret = entry && outcome && !reason ? ((outcome.close - entry.close) / entry.close) * 100 : null;
      const spyRet = spyEntry && spyOutcome && !reason ? ((spyOutcome.close - spyEntry.close) / spyEntry.close) * 100 : null;
      insert.run(event.id, horizon, entry?.observed_at ?? null, entry?.close ?? null, outcome?.observed_at ?? null, outcome?.close ?? null, spyEntry?.close ?? null, spyOutcome?.close ?? null, ret, spyRet, ret !== null && spyRet !== null ? ret - spyRet : null, reason, now.toISOString());
      written++;
    }
  }
  return written;
};

export const readEventOutcomeMetrics = (database: DatabaseSync, signalType: string) => Object.fromEntries(HORIZONS.map((horizon) => {
  const row = database.prepare(`SELECT COUNT(*) AS raw, SUM(CASE WHEN COALESCE(o.exclusion_reason,'') <> 'overlapping_event' THEN 1 ELSE 0 END) AS independent, SUM(CASE WHEN COALESCE(o.exclusion_reason,'') NOT IN ('overlapping_event','outcome_not_mature','missing_entry_price') THEN 1 ELSE 0 END) AS mature, SUM(CASE WHEN o.return_pct IS NOT NULL THEN 1 ELSE 0 END) AS usable, SUM(CASE WHEN o.return_pct > 0 THEN 1 ELSE 0 END) AS wins, AVG(o.return_pct) AS averageReturn, AVG(o.excess_return_pct) AS averageExcess FROM uw_signal_event_outcomes o JOIN uw_signal_events e ON e.id=o.event_id WHERE o.horizon=? AND e.signal_type=?`).get(horizon, signalType) as { raw: number; independent: number; mature: number; usable: number; wins: number; averageReturn: number|null; averageExcess: number|null };
  const usable = Number(row.usable ?? 0);
  return [horizon, { nRaw: Number(row.raw ?? 0), nIndependent: Number(row.independent ?? 0), nMature: Number(row.mature ?? 0), nWithOutcome: usable, winRate: usable ? Number(row.wins ?? 0) / usable * 100 : null, averageReturnPct: row.averageReturn === null ? null : Number(row.averageReturn), averageExcessPct: row.averageExcess === null ? null : Number(row.averageExcess), medianReturnPct: null, medianExcessPct: null, netByCostBpsPerSide: { '10': row.averageReturn === null ? null : Number(row.averageReturn) - 0.2, '25': row.averageReturn === null ? null : Number(row.averageReturn) - 0.5, '50': row.averageReturn === null ? null : Number(row.averageReturn) - 1 }, status: usable >= 30 ? 'descriptive' : 'insufficient' }];
}));
