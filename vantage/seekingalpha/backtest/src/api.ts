import type { HistoryWindow, Rating, SignalPolicy } from './data';

export type AnalysisMeta = {
  fingerprint: string;
  // The persisted analysis_runs.id this fingerprint's results were (or are being) written under,
  // if the local SQLite persistence layer is available; null only if that write failed.
  runId: number | null;
  windows: HistoryWindow[];
  tiers: Rating[];
  accuracyHorizons: number[];
};

type AnalysisResponse<T> = {
  data: T;
  fingerprint: string;
};

const request = async <T>(params: URLSearchParams): Promise<T> => {
  const response = await fetch(`/api/analysis?${params.toString()}`, { cache: 'no-store' });
  const payload = await response.json() as unknown;
  const errorMessage = typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string' ? payload.error : null;
  if (!response.ok) throw new Error(errorMessage ?? `Analysis request failed (${response.status})`);
  return payload as T;
};

export const fetchAnalysisMeta = () => request<AnalysisMeta>(new URLSearchParams({ action: 'meta' }));

export const fetchAnalysis = <T>(action: string, options: { window?: HistoryWindow; policy?: SignalPolicy; ticker?: string; horizon?: number } = {}) => {
  const params = new URLSearchParams({ action });
  if (options.window) params.set('window', options.window);
  if (options.policy) params.set('policy', options.policy);
  if (options.ticker) params.set('ticker', options.ticker);
  if (options.horizon) params.set('horizon', String(options.horizon));
  return request<AnalysisResponse<T>>(params);
};
