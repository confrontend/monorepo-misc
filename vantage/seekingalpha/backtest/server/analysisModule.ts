// Loosely-typed on purpose: this describes the shape of src/data.ts as loaded through Vite's
// server.ssrLoadModule() (needed because data.ts uses import.meta.glob, a Vite-only macro), which
// lives in the browser-facing tsconfig.app.json project. Everything under server/ is compiled
// under the separate, Node-only tsconfig.node.json project, so real types from data.ts aren't
// imported here directly — same tradeoff vite.config.ts already made for its own AnalysisModule
// type before this file existed.
export type AnalysisModule = {
  getAvailableHistoryWindows: () => string[];
  getAvailableRatingTiers: () => string[];
  getAvailableAccuracyHorizons: () => number[];
  buildTickerResults: (window: string, policy: string) => any[];
  buildAggregateResults: (windows: string[], policies: string[]) => any[];
  buildStrongBuyTrustResults: () => any[];
  buildCohortResults: (windows: string[]) => any[];
  buildTickerCohortResults: (windows: string[]) => any[];
  buildTierWinRates: () => any[];
  buildScoreCorrelation: () => any;
  buildTickerAccuracy: (horizonDays: number) => any[];
  buildRatingCallSummary: (horizonDays: number) => any;
};
