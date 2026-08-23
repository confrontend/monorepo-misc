// Shared between fetch.ts and estimate.ts. The complete-history workflow has no application-
// imposed trade or request caps; GMGN pagination, rate limits, and failures are the constraints.
export const MAX_REQUESTS_PER_WALLET = Number.POSITIVE_INFINITY;
export const DAILY_TRADE_INSERT_CAP = Number.POSITIVE_INFINITY;
/** Shared GMGN pre-Dune and post-Dune negative-PnL guardrail. */
export const STRONGLY_NEGATIVE_PNL_PERCENT = -20;
