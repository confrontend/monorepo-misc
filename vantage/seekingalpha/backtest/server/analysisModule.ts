// Loosely-typed on purpose: this describes the shape of src/data.ts as loaded through Vite's
// server.ssrLoadModule() (needed because data.ts uses import.meta.glob, a Vite-only macro), which
// lives in the browser-facing tsconfig.app.json project. Everything under server/ is compiled
// under the separate, Node-only tsconfig.node.json project, so real types from data.ts aren't
// imported here directly — same tradeoff vite.config.ts already made for its own AnalysisModule
// type before this file existed.
export type AnalysisModule = {
  initialiseDatasets: (payload: { datasets: any[]; benchmarks: Array<[string, any[]]>; universe: any }) => void;
  getUniverseSummary: () => { total: number; reconstructed: number; snapshotOnly: number };
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
  buildPredictiveAccuracySummary: (horizonDays: number) => any;
  buildStrongBuyOutlierAnalysis: () => any;
  buildPortfolioBacktest: (config: any) => any;
  buildBestPortfolioBacktests: (config: any) => any[];
  buildPortfolioHoldoutValidation: (config: any, options?: any) => any;
  buildSignalDiscovery: (universe?: 'stocks' | 'etf') => any;
  buildEtfCheck: (tickers?: string[]) => any;
  buildEtfBasketAnalysis: (tickers: string[], horizonDays?: number, basketSize?: number) => any;
  buildEpisodeFixture: () => any;
  getMethodologyConfig: () => any;
};
