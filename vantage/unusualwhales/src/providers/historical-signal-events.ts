import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type HistoricalEventSource = 'open_interest_spike' | 'market_etf_flow' | 'gex_gamma' | 'insider_activity' | 'congress_activity';
export type HistoricalEventRow = {
  sourceEventId: string;
  signalType: HistoricalEventSource;
  eventAt: string | null;
  publishedAt: string | null;
  observableAt: string | null;
  symbol: string | null;
  outcomeSymbol: string | null;
  predictionMode: 'directional' | 'volatility' | 'regime';
  score: number | null;
  rawPayload: string;
  validationErrors: string[];
};

const rows = (payload: unknown): Array<Record<string, unknown>> => {
  if (Array.isArray(payload)) return payload.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row));
  if (payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)) {
    return (payload as { data: unknown[] }).data.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row));
  }
  return [];
};

const text = (value: unknown) => value === null || value === undefined || String(value).trim() === '' ? null : String(value).trim();
const number = (value: unknown) => { const n = Number(value); return Number.isFinite(n) ? n : null; };
const iso = (value: unknown) => { const raw = text(value); if (!raw) return null; const parsed = new Date(raw); return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString(); };
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

export const normalizeHistoricalEvents = (signalType: HistoricalEventSource, payload: unknown, tradingDate: string, sourceSymbol?: string): HistoricalEventRow[] => rows(payload).map((row) => {
  const rawPayload = JSON.stringify(row);
  const filingDate = text(row.filed_at_date ?? row.filing_date);
  const timestamp = iso(row.timestamp ?? row.time) ?? (filingDate ? `${filingDate}T23:59:59.999Z` : null);
  const currentDate = text(row.curr_date) ?? tradingDate;
  const eventAt = timestamp ?? (signalType === 'open_interest_spike' ? `${currentDate}T23:59:59.999Z` : null);
  const symbol = text(row.underlying_symbol ?? row.ticker ?? row.symbol) ?? sourceSymbol ?? null;
  const transaction = text(row.transaction_code ?? row.txn_type) ?? '';
  const score = signalType === 'open_interest_spike'
    ? number(row.oi_change ?? row.oi_diff_plain)
    : signalType === 'gex_gamma'
      ? number(row.gamma_per_one_percent_move_oi ?? row.gamma_per_one_percent_move_dir ?? row.gamma_per_one_percent_move_vol)
      : signalType === 'insider_activity' || signalType === 'congress_activity'
        ? /sell|disposition|^s$/i.test(transaction) ? -1 : /buy|purchase|^p$/i.test(transaction) ? 1 : null
        : number(row.net_call_premium) !== null && number(row.net_put_premium) !== null
          ? number(row.net_call_premium)! - number(row.net_put_premium)!
          : number(row.net_volume);
  const validationErrors: string[] = [];
  if (!eventAt) validationErrors.push('missing event timestamp');
  if (!symbol && signalType === 'open_interest_spike') validationErrors.push('missing underlying_symbol');
  const identity = text(row.id ?? row.option_symbol ?? row.timestamp ?? row.time) ?? hash(rawPayload);
  return {
    // Include the requested market date because OI rows are contract snapshots and the
    // same option_symbol legitimately appears on many dates.
    sourceEventId: `${signalType}:${sourceSymbol ?? 'market'}:${tradingDate}:${identity}`,
    signalType,
    eventAt,
    publishedAt: timestamp,
    observableAt: timestamp ?? eventAt,
    symbol,
    outcomeSymbol: symbol ?? (signalType === 'market_etf_flow' ? sourceSymbol ?? 'SPY' : null),
    predictionMode: signalType === 'market_etf_flow' ? 'regime' : signalType === 'gex_gamma' ? 'volatility' : 'directional',
    score,
    rawPayload,
    validationErrors,
  };
});

export const persistHistoricalEvents = (database: DatabaseSync, batchId: number, capturedAt: string, events: HistoricalEventRow[]) => {
  const insert = database.prepare(`INSERT OR IGNORE INTO uw_signal_events
    (source_event_id,source_batch_id,signal_type,event_at,published_at,observable_at,captured_at,symbol,outcome_symbol,prediction_mode,score,raw_payload,validation_errors)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let inserted = 0;
  for (const event of events) {
    const result = insert.run(event.sourceEventId, batchId, event.signalType, event.eventAt, event.publishedAt, event.observableAt, capturedAt, event.symbol, event.outcomeSymbol, event.predictionMode, event.score, event.rawPayload, JSON.stringify(event.validationErrors));
    inserted += Number(result.changes);
  }
  return { received: events.length, inserted, duplicates: events.length - inserted };
};
