import type pg from 'pg';
import { DAILY_SESSION_HORIZONS, HORIZONS, type Horizon } from './outcomes.js';
import { PostgresOutcomeRepository, type PostgresOutcomeRow } from '../db/postgres-outcomes.js';

const durations: Record<Horizon, number> = { '+5m': 5 * 60_000, '+30m': 30 * 60_000, '+1h': 60 * 60_000, '+1d': 24 * 60 * 60_000, '+3d': 3 * 24 * 60 * 60_000, '+5d': 5 * 24 * 60 * 60_000, '+10d': 10 * 24 * 60 * 60_000, '+20d': 20 * 24 * 60 * 60_000 };
const timeframeFor = (horizon: Horizon): '1m' | '1d' => ['+1d', '+3d', '+5d', '+10d', '+20d'].includes(horizon) ? '1d' : '1m';
const BATCH_SIZE = 200;
const PAGE_SIZE = 500;

export type PostgresOutcomeRefreshOptions = { jobId: number; now?: Date; onProgress?: (progress: { completed: number; total: number }) => void; underlyingSymbols?: string[] };

/** Rebuilds outcomes in PostgreSQL with the same deterministic rules as SQLite. */
export async function refreshPostgresOutcomes(pool: pg.Pool, options: PostgresOutcomeRefreshOptions): Promise<number> {
  const repo = new PostgresOutcomeRepository();
  const client = await pool.connect();
  const now = options.now ?? new Date();
  const calculatedAt = now.toISOString();
  let transactionOpen = false;
  let completed = 0;
  let written = 0;
  try {
    await repo.ensureSchema(client);
    const total = await repo.countEligibleTrades(client, options.underlyingSymbols);
    const previous = new Map<string, number>();
    let cursor: { symbol: string; executedAt: string; id: number } | null = null;
    let page = await repo.listEligibleTrades(client, cursor, PAGE_SIZE, options.underlyingSymbols);
    while (page.length) {
      const rows: PostgresOutcomeRow[] = [];
      for (const trade of page) {
        const eventMs = Date.parse(trade.executedAt);
        for (const horizon of HORIZONS) {
          const targetMs = eventMs + durations[horizon];
          const timeframe = timeframeFor(horizon);
          const entry = await repo.firstBarAtOrAfter(client, trade.underlyingSymbol, timeframe, trade.executedAt);
          const key = `${trade.signalType}:${trade.underlyingSymbol}:${horizon}`;
          let exclusionReason: string | null = null;
          if (!entry) exclusionReason = 'missing_entry_price';
          else if (previous.has(key) && eventMs < (previous.get(key) as number) + durations[horizon]) exclusionReason = 'overlapping_event';
          else if (targetMs > now.getTime()) exclusionReason = 'outcome_not_mature';
          if (entry && exclusionReason !== 'overlapping_event') previous.set(key, eventMs);
          const sessionCount = DAILY_SESSION_HORIZONS[horizon];
          const outcome = entry && !exclusionReason
            ? sessionCount
              ? await repo.nthBarAfter(client, trade.underlyingSymbol, '1d', entry.observedAt, sessionCount)
              : await repo.firstBarAtOrAfter(client, trade.underlyingSymbol, timeframe, new Date(targetMs).toISOString(), entry.observedAt)
            : null;
          if (entry && !exclusionReason && !outcome) exclusionReason = 'missing_outcome_price';
          const spyEntry = entry && !exclusionReason ? await repo.firstBarAtOrAfter(client, 'SPY', timeframe, entry.observedAt) : null;
          const spyOutcome = outcome && !exclusionReason ? await repo.firstBarAtOrAfter(client, 'SPY', timeframe, outcome.observedAt) : null;
          if (entry && !exclusionReason && (!spyEntry || !spyOutcome)) exclusionReason = 'missing_spy_price';
          const returnPct = entry && outcome && !exclusionReason ? ((outcome.close - entry.close) / entry.close) * 100 : null;
          const spyReturnPct = spyEntry && spyOutcome && !exclusionReason ? ((spyOutcome.close - spyEntry.close) / spyEntry.close) * 100 : null;
          rows.push({ tradeId: trade.id, horizon, entryAt: entry?.observedAt ?? null, entryPrice: entry?.close ?? null,
            outcomeAt: outcome?.observedAt ?? null, outcomePrice: outcome?.close ?? null, spyEntryPrice: spyEntry?.close ?? null,
            spyOutcomePrice: spyOutcome?.close ?? null, returnPct, spyReturnPct,
            excessReturnPct: returnPct !== null && spyReturnPct !== null ? returnPct - spyReturnPct : null,
            exclusionReason, calculatedAt });
        }
        completed++;
        written += HORIZONS.length;
        if (rows.length >= BATCH_SIZE * HORIZONS.length) {
          await client.query('BEGIN'); transactionOpen = true;
          await repo.writeOutcomeBatch(client, rows.splice(0));
          await repo.saveCheckpoint(client, { jobId: options.jobId, lastSymbol: trade.underlyingSymbol, lastExecutedAt: trade.executedAt, lastTradeId: trade.id, completed, total, updatedAt: calculatedAt });
          await client.query('COMMIT'); transactionOpen = false;
          options.onProgress?.({ completed, total });
        }
        cursor = { symbol: trade.underlyingSymbol, executedAt: trade.executedAt, id: trade.id };
      }
      if (rows.length) {
        await client.query('BEGIN'); transactionOpen = true;
        await repo.writeOutcomeBatch(client, rows);
        const last = page[page.length - 1];
        await repo.saveCheckpoint(client, { jobId: options.jobId, lastSymbol: last.underlyingSymbol, lastExecutedAt: last.executedAt, lastTradeId: last.id, completed, total, updatedAt: calculatedAt });
        await client.query('COMMIT'); transactionOpen = false;
      }
      options.onProgress?.({ completed, total });
      page = await repo.listEligibleTrades(client, cursor, PAGE_SIZE, options.underlyingSymbols);
    }
    await client.query('BEGIN'); transactionOpen = true;
    await repo.clearCheckpoint(client, options.jobId);
    await client.query('COMMIT'); transactionOpen = false;
    return written;
  } catch (error) {
    if (transactionOpen) { try { await client.query('ROLLBACK'); } catch { /* preserve original error */ } }
    throw error;
  } finally { client.release(); }
}
