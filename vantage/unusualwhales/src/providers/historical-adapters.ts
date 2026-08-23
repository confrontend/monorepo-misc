import { SIGNAL_CATALOG, type SignalDefinition } from '../research/signal-catalog.js';
import { normalizeDarkPoolRecords, type DarkPoolRecord } from './dark-pool.js';

/**
 * The normalized shape shared by historical source adapters.  Adapters only
 * describe and normalize provider records; persistence and outcome calculation
 * remain separate concerns.  In particular, an adapter marked unsupported
 * never gets a fetch function, so selecting it cannot accidentally make a
 * network request.
 */
export type NormalizedHistoricalEvent = {
  sourceId: string;
  signalType: string;
  executedAt: string | null;
  symbol: string | null;
  direction: 'bullish' | 'bearish' | 'signed' | 'neutral';
  rawPayload: string;
  validationErrors: string[];
};

export type HistoricalAdapterStatus = 'available' | 'unsupported';

export type HistoricalSignalAdapter = {
  signalType: SignalDefinition['id'];
  definition: SignalDefinition;
  status: HistoricalAdapterStatus;
  endpoint: string;
  /** True only when provider history can be reconstructed without current-state lookups. */
  pointInTimeSafe: boolean;
  reason?: string;
  normalize(payload: unknown): NormalizedHistoricalEvent[];
};

const unsupportedReasons: Record<string, string> = {
  repeated_sweeps: 'Historical repeated-sweep groups are not downloaded yet; grouping must be reconstructed from timestamped raw sweeps.',
  market_etf_flow: 'The historical market/ETF flow adapter is available; it stores regime observations separately from trade outcomes.',
};

const asText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
};

const asRows = (payload: unknown): Array<Record<string, unknown>> => {
  if (Array.isArray(payload)) return payload.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row));
  if (payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)) {
    return (payload as { data: unknown[] }).data.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row));
  }
  return [];
};

const normalizeOptionSweeps = (signalType: 'call_sweep' | 'put_sweep', payload: unknown): NormalizedHistoricalEvent[] => {
  const expectedType = signalType === 'call_sweep' ? 'call' : 'put';
  return asRows(payload).flatMap((row) => {
    const optionType = asText(row.option_type)?.toLowerCase();
    const flags = Array.isArray(row.report_flags) ? row.report_flags.map(String) : asText(row.report_flags)?.split(',').map((flag) => flag.trim()) ?? [];
    if (optionType !== expectedType || !flags.some((flag) => flag.toLowerCase() === 'intermarket_sweep')) return [];
    const rawPayload = JSON.stringify(row);
    const executedAt = asText(row.executed_at);
    const parsed = executedAt ? new Date(executedAt) : null;
    const validationErrors: string[] = [];
    if (!parsed || Number.isNaN(parsed.getTime())) validationErrors.push('missing or invalid executed_at');
    const symbol = asText(row.underlying_symbol);
    if (!symbol) validationErrors.push('missing underlying_symbol');
    return [{
      sourceId: asText(row.id) ?? `sha256:${rawPayload}`,
      signalType,
      executedAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
      symbol,
      direction: signalType === 'call_sweep' ? 'bullish' : 'bearish',
      rawPayload,
      validationErrors,
    }];
  });
};

const normalizeDarkPool = (payload: unknown): NormalizedHistoricalEvent[] => normalizeDarkPoolRecords(payload).map((record: DarkPoolRecord) => ({
  sourceId: record.sourceId,
  signalType: 'dark_pool_block',
  executedAt: record.executedAt,
  symbol: record.ticker,
  direction: 'signed',
  rawPayload: record.rawPayload,
  validationErrors: record.validationErrors,
}));

const noOpNormalizer = (): NormalizedHistoricalEvent[] => [];

const available = (definition: SignalDefinition, normalize: HistoricalSignalAdapter['normalize']): HistoricalSignalAdapter => ({
  signalType: definition.id,
  definition,
  status: 'available',
  endpoint: definition.sourceEndpoint,
  pointInTimeSafe: definition.id !== 'dark_pool_block',
  normalize,
});

const unsupported = (definition: SignalDefinition): HistoricalSignalAdapter => ({
  signalType: definition.id,
  definition,
  status: 'unsupported',
  endpoint: definition.sourceEndpoint,
  pointInTimeSafe: false,
  reason: unsupportedReasons[definition.id] ?? 'No verified historical adapter is available.',
  normalize: noOpNormalizer,
});

const definition = (id: SignalDefinition['id']): SignalDefinition => SIGNAL_CATALOG.find((entry) => entry.id === id)!;

/** Canonical breadth-first registry. Keep this list complete with SIGNAL_CATALOG. */
export const HISTORICAL_ADAPTERS: readonly HistoricalSignalAdapter[] = [
  available(definition('call_sweep'), (payload) => normalizeOptionSweeps('call_sweep', payload)),
  available(definition('put_sweep'), (payload) => normalizeOptionSweeps('put_sweep', payload)),
  available(definition('dark_pool_block'), normalizeDarkPool),
  available(definition('flow_imbalance'), noOpNormalizer),
  available(definition('open_interest_spike'), noOpNormalizer),
  available(definition('market_etf_flow'), noOpNormalizer),
  available(definition('gex_gamma'), noOpNormalizer),
  available(definition('insider_activity'), noOpNormalizer),
  available(definition('congress_activity'), noOpNormalizer),
  ...SIGNAL_CATALOG.filter((entry) => !['call_sweep', 'put_sweep', 'dark_pool_block', 'flow_imbalance', 'open_interest_spike', 'market_etf_flow', 'gex_gamma', 'insider_activity', 'congress_activity'].includes(entry.id)).map(unsupported),
];

export const getHistoricalAdapter = (signalType: string): HistoricalSignalAdapter | null => HISTORICAL_ADAPTERS.find((adapter) => adapter.signalType === signalType) ?? null;

export const historicalAdapterCapabilities = () => HISTORICAL_ADAPTERS.map((adapter) => ({
  signalType: adapter.signalType,
  label: adapter.definition.label,
  status: adapter.status,
  endpoint: adapter.endpoint,
  pointInTimeSafe: adapter.pointInTimeSafe,
  reason: adapter.reason,
}));

/**
 * Build a request plan without touching the provider. This is intentionally
 * pure and is safe for UI previews, diagnostics, and dry-run backfills.
 */
export const planHistoricalAdapters = (signalTypes: string[] = HISTORICAL_ADAPTERS.map((adapter) => adapter.signalType)) => signalTypes.map((signalType) => {
  const adapter = getHistoricalAdapter(signalType);
  if (!adapter) return { signalType, status: 'unsupported' as const, reason: 'Unknown signal type.' };
  return { signalType, status: adapter.status, reason: adapter.reason };
});
