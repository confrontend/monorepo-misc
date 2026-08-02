// Mirrors the shapes returned by api/main.py. Kept intentionally close to
// the raw sqlite3.Row -> dict(...) shapes the backend returns, rather than
// remapping field names, so this file stays a straightforward reference for
// "what does the API actually send."

export type Decision = "Confirm" | "Mixed" | "Reject" | "Wait";

export interface EpisodeSummary {
  episode_id: string;
  ticker: string;
  decision: Decision | null;
  confidence: string | null;
  episode_trigger: string;
  eligibility_date: string;
  review_date: string;
  decision_timestamp_utc: string;
  earnings_score: number | null;
  market_score: number | null;
  context_score: number | null;
  total_score: number | null;
  red_flag: 0 | 1 | null;
  earnings_within_5d: 0 | 1 | null;
  corrects_episode_id: string | null;
  resolved_from_audit_id: number | null;
}

export interface ReviewRow extends EpisodeSummary {
  created_at: string;
  rule_version: string;
  earnings_fact: string | null;
  market_fact: string | null;
  context_fact: string | null;
  explanation: string | null;
}

export interface EpisodeEntry {
  episode_id: string;
  entry_date: string;
  stock_entry_open: number;
  spy_entry_open: number;
  sector_entry_open: number;
  sector_benchmark_ticker: string;
  recorded_at: string;
}

export interface RecommendationOutcome {
  outcome_id: number;
  episode_id: string;
  measurement_date: string;
  horizon_days: number;
  exit_date: string;
  stock_exit_close: number;
  spy_exit_close: number;
  sector_exit_close: number;
  stock_return: number;
  spy_return: number;
  sector_return: number;
  recommendation_result: string;
}

export interface EpisodeDetail {
  review: ReviewRow;
  entry: EpisodeEntry | null;
  outcomes: RecommendationOutcome[];
  report_text: string;
}

export interface MissingField {
  missing_group: string;
  missing_field: string;
}

export interface InsufficientDataCase {
  audit_id: number;
  ticker: string;
  as_of_date: string;
  checked_at: string;
  episode_trigger: string;
  eligibility_date: string;
  source_candidate_id: number | null;
  trigger_source_table: string | null;
  trigger_source_row_id: number | null;
  resolved: 0 | 1;
  resolved_episode_id: string | null;
  retry_after: string | null;
  missing_fields: MissingField[];
}

export interface Stats {
  total_episodes: number;
  by_decision: Record<string, number>;
  unresolved_insufficient_data_cases: number;
  tickers_tracked: number;
}

export interface CandidateRow {
  candidate_id: number;
  date: string;
  ticker: string;
  source: string;
  source_rank: string | null;
  ai_score: number | null;
  technical_score: number | null;
  fundamental_score: number | null;
  expected_return: number | null;
  direction: string | null;
}

export interface RunDemoResult {
  episode_id: string | null;
  report?: string;
  insufficient_data_cases?: InsufficientDataCase[];
}

export interface RetryResult {
  resolved_episode_ids: string[];
  count: number;
}

export interface TickerIngestResult {
  ticker: string;
  wrote: {
    price_signal?: boolean;
    earnings_history?: boolean;
    estimate_snapshots?: boolean;
    earnings_calendar?: boolean;
  };
  warnings: string[];
}

export interface CandidatesIngestResult {
  upserted: string[];
  warnings: string[];
}

export interface IngestLiveResult {
  price_and_earnings: TickerIngestResult[];
  candidates: CandidatesIngestResult | null;
  episodes: Record<string, string[]>;
}

export interface FetchCandidatesResult {
  as_of_date: string;
  requested: string[];
  successful: string[];
  skipped: string[];
  failed: Record<string, string>;
  successful_count: number;
  skipped_count: number;
  failed_count: number;
}

export interface AddManualCandidateResult {
  as_of_date: string;
  requested: string[];
  added: string[];
  failed: Record<string, string>;
  added_count: number;
  failed_count: number;
}

export interface TradeIdeasFilters {
  market?: string;
  direction?: string;
  asset_type?: string;
  aiscore?: number;
  limit?: number;
}

export interface TradeIdeaPreviewRow {
  index: number;
  status: "successful" | "skipped" | "failed";
  ticker: string | null;
  reason: string | null;
  source_rank: string | null;
  ai_score: number | null;
  technical_score: number | null;
  fundamental_score: number | null;
  expected_return: number | null;
  direction: string | null;
}

export interface FetchTradeIdeasResult {
  source: string;
  as_of_date: string;
  filters: TradeIdeasFilters;
  total_ideas: number;
  successful: string[];
  skipped: { index: number; reason: string }[];
  failed: { index: number; ticker: string | null; reason: string }[];
  ideas: TradeIdeaPreviewRow[];
  warnings: string[];
  successful_count: number;
  skipped_count: number;
  failed_count: number;
}

export interface MarkContextReviewedResult {
  marked: string[];
  as_of_date: string;
}
