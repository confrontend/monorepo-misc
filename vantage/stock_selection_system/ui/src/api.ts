import type {
  AddManualCandidateResult,
  CandidateRow,
  EpisodeDetail,
  EpisodeSummary,
  FetchCandidatesResult,
  FetchTradeIdeasResult,
  IngestLiveResult,
  InsufficientDataCase,
  MarkContextReviewedResult,
  RetryResult,
  RunDemoResult,
  Stats,
  TradeIdeasFilters,
} from "./types";
import { debugError, debugLog } from "./debug";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const requestInit = {
    headers: { "Content-Type": "application/json" },
    ...init,
  };
  debugLog(`API request ${requestInit.method ?? "GET"} ${path}`, {
    body: requestInit.body ? JSON.parse(String(requestInit.body)) : undefined,
  });
  const res = await fetch(path, requestInit);
  if (!res.ok) {
    const body = await res.text();
    debugError(`API error ${res.status} ${path}`, body);
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  const payload = await res.json() as T;
  debugLog(`API response ${res.status} ${path}`, payload);
  return payload;
}

export function getTickers(): Promise<string[]> {
  return request("/api/tickers");
}

export function listCandidates(params: { ticker?: string; source?: string } = {}): Promise<CandidateRow[]> {
  const qs = new URLSearchParams();
  if (params.ticker) qs.set("ticker", params.ticker);
  if (params.source) qs.set("source", params.source);
  qs.set("limit", "500");
  return request(`/api/candidates?${qs.toString()}`);
}

export function getStats(): Promise<Stats> {
  return request("/api/stats");
}

export function listEpisodes(params: { ticker?: string; decision?: string }): Promise<EpisodeSummary[]> {
  const qs = new URLSearchParams();
  if (params.ticker) qs.set("ticker", params.ticker);
  if (params.decision) qs.set("decision", params.decision);
  qs.set("limit", "200");
  return request(`/api/episodes?${qs.toString()}`);
}

export function getEpisode(episodeId: string): Promise<EpisodeDetail> {
  return request(`/api/episodes/${encodeURIComponent(episodeId)}`);
}

export function listInsufficientDataCases(params: { resolved?: boolean; ticker?: string }): Promise<InsufficientDataCase[]> {
  const qs = new URLSearchParams();
  if (params.resolved !== undefined) qs.set("resolved", String(params.resolved));
  if (params.ticker) qs.set("ticker", params.ticker);
  return request(`/api/insufficient-data-cases?${qs.toString()}`);
}

export function runDemo(asOfDate: string, seed: number): Promise<RunDemoResult> {
  return request("/api/actions/run-demo", {
    method: "POST",
    body: JSON.stringify({ as_of_date: asOfDate, seed }),
  });
}

export function retryInsufficientData(asOfDate: string): Promise<RetryResult> {
  return request("/api/actions/retry-insufficient-data", {
    method: "POST",
    body: JSON.stringify({ as_of_date: asOfDate }),
  });
}

export function ingestLive(tickers: string[], asOfDate: string, includeCandidates: boolean): Promise<IngestLiveResult> {
  return request("/api/actions/ingest-live", {
    method: "POST",
    body: JSON.stringify({ tickers, as_of_date: asOfDate, include_candidates: includeCandidates }),
  });
}

export function markContextReviewed(tickers: string[], asOfDate: string): Promise<MarkContextReviewedResult> {
  return request("/api/actions/mark-context-reviewed", {
    method: "POST",
    body: JSON.stringify({ tickers, as_of_date: asOfDate }),
  });
}

// Standalone, on-demand Danelfin eligibility-filter workflow -- distinct
// from ingestLive()'s bundled "include Danelfin candidates" step. Only
// fetches/upserts `candidates`; does not touch price/earnings or run
// episode-trigger detection.
export function fetchCandidates(tickers: string[], asOfDate: string): Promise<FetchCandidatesResult> {
  return request("/api/actions/fetch-candidates", {
    method: "POST",
    body: JSON.stringify({ tickers, as_of_date: asOfDate }),
  });
}

// Manual fallback -- adds tickers straight into `candidates` with
// source='manual', no Danelfin call, no API key needed.
export function addManualCandidate(tickers: string[], asOfDate: string): Promise<AddManualCandidateResult> {
  return request("/api/actions/add-manual-candidate", {
    method: "POST",
    body: JSON.stringify({ tickers, as_of_date: asOfDate }),
  });
}

// THE primary, no-ticker-required candidate discovery workflow -- fetches
// Danelfin Trade Ideas and upserts every discovered ticker into
// `candidates` (source='danelfin_trade_ideas'). All filters optional.
export function fetchTradeIdeas(asOfDate: string, filters: TradeIdeasFilters): Promise<FetchTradeIdeasResult> {
  return request("/api/actions/fetch-trade-ideas", {
    method: "POST",
    body: JSON.stringify({ as_of_date: asOfDate, ...filters }),
  });
}
