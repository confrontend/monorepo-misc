import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { getDb } from './client.js';
import { getMethodologyVersion } from './methodologyVersion.js';
import type { AnalysisModule } from '../analysisModule.js';

// This file lives at <project>/server/db/runs.ts, so the project root is three levels up.
// Resolved lazily (not at module-evaluation time): when this module is loaded as part of Vite's
// own config-file bundling, import.meta.url can point at a transient bundled location rather than
// this file's real path, which broke a top-level version of this same computation in practice
// (it silently fell back to 'unknown'). Deferring the read until ensureRunForFingerprint() is
// actually called -- by which point the module graph has settled -- fixed it, matching the
// existing (working) lazy pattern already used by getDb() and getMethodologyVersion().
let cachedApplicationVersion: string | null = null;
const getApplicationVersion = (): string => {
  if (cachedApplicationVersion) return cachedApplicationVersion;
  try {
    const projectRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
    const pkg = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as { version?: string };
    cachedApplicationVersion = pkg.version ?? 'unknown';
  } catch {
    cachedApplicationVersion = 'unknown';
  }
  return cachedApplicationVersion;
};

const HISTORY_POLICIES = ['long-exit-hold', 'long-hold-through', 'long-short'] as const;

// Same window subset the "Rating tiers" tab already uses (vite.config.ts's 'tiers' action) --
// kept in sync manually since this loose AnalysisModule type has no shared constant to import.
const tierWindows = (windows: string[]) =>
  windows.filter((candidate) => candidate === '7d' || candidate === 'all' || Number.parseInt(candidate, 10) <= 24);

export type RunRow = {
  id: number;
  fingerprint: string;
  methodology_version: string;
  application_version: string | null;
  status: 'running' | 'completed' | 'failed';
  started_at: string;
  completed_at: string | null;
  error: string | null;
  input_summary_json: string | null;
};

const findLatestCompletedRun = (db: DatabaseSync, fingerprint: string, methodologyVersion: string): RunRow | undefined =>
  db.prepare(`
    SELECT * FROM analysis_runs
    WHERE fingerprint = ? AND methodology_version = ? AND status = 'completed'
    ORDER BY id DESC LIMIT 1
  `).get(fingerprint, methodologyVersion) as RunRow | undefined;

// Even though the raw input JSON isn't duplicated into the database, keep enough of a fingerprint
// trail that a stored result can always be traced back to what produced it: which files, how big,
// and (via the ticker rows already being computed anyway) how many records each ticker carried.
const buildInputSummary = (analysis: AnalysisModule) =>
  analysis.buildTickerResults('all', 'long-exit-hold').map((row) => ({
    ticker: row.ticker,
    company: row.company,
    capturedDays: row.detail.capturedDays,
    dateRange: row.dateRange,
    sourceFile: row.detail.sourceFile,
  }));

const writeSnapshot = (db: DatabaseSync, runId: number, analysis: AnalysisModule) => {
  const windows = analysis.getAvailableHistoryWindows();

  const insertTicker = db.prepare(`
    INSERT INTO ticker_strategy_results
      (run_id, ticker, company, window, policy, signals, latest_rating, hit_rate, average_return,
       median_return, rating_changes, ending_value, total_return, benchmark_available,
       benchmark_total_return, detail_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  windows.forEach((window) => {
    HISTORY_POLICIES.forEach((policy) => {
      analysis.buildTickerResults(window, policy).forEach((row) => {
        insertTicker.run(
          runId, row.ticker, row.company, window, policy, row.signals, row.latestRating,
          row.hitRate, row.averageReturn, row.medianReturn, row.ratingChanges,
          row.detail.endingValue, row.detail.totalReturn, row.detail.benchmark.available ? 1 : 0,
          row.detail.benchmark.totalReturn, JSON.stringify(row),
        );
      });
    });
  });

  const insertOverall = db.prepare(`
    INSERT INTO overall_results
      (run_id, window, policy, tickers_tested, total_tickers, beat_benchmark_count,
       beat_benchmark_rate, average_extra_return, median_extra_return, average_strategy_return,
       average_benchmark_return, confidence, verdict)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  analysis.buildAggregateResults(windows, [...HISTORY_POLICIES]).forEach((row) => {
    insertOverall.run(
      runId, row.window, row.policy, row.tickersTested, row.totalTickers, row.beatBenchmarkCount,
      row.beatBenchmarkRate, row.averageExtraReturn, row.medianExtraReturn,
      row.averageStrategyReturn, row.averageBenchmarkReturn, row.confidence, row.verdict,
    );
  });

  const insertStrongBuy = db.prepare(`
    INSERT INTO strong_buy_results
      (run_id, ticker, company, completed_trades, wins, losses, win_rate, average_trade_return,
       median_trade_return, ending_value, total_return, open_trade_return, date_range, trades_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  analysis.buildStrongBuyTrustResults().forEach((row) => {
    insertStrongBuy.run(
      runId, row.ticker, row.company, row.completedTrades, row.wins, row.losses, row.winRate,
      row.averageTradeReturn, row.medianTradeReturn, row.endingValue, row.totalReturn,
      row.openTradeReturn, row.dateRange, JSON.stringify(row.trades),
    );
  });

  const tWindows = tierWindows(windows);

  const insertTier = db.prepare(`
    INSERT INTO rating_tier_results (run_id, tier, window, ticker_count, total_in_tier, average_return, median_return)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  analysis.buildCohortResults(tWindows).forEach((row) => {
    insertTier.run(runId, row.tier, row.window, row.tickerCount, row.totalInTier, row.averageReturn, row.medianReturn);
  });

  const insertTierTicker = db.prepare(`
    INSERT INTO rating_tier_ticker_results (run_id, ticker, company, tier, window, available, total_return)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  analysis.buildTickerCohortResults(tWindows).forEach((row) => {
    insertTierTicker.run(runId, row.ticker, row.company, row.tier, row.window, row.available ? 1 : 0, row.totalReturn);
  });

  const insertWinRate = db.prepare(`
    INSERT INTO rating_tier_win_rates (run_id, tier, wins, total, win_rate)
    VALUES (?, ?, ?, ?, ?)
  `);
  analysis.buildTierWinRates().forEach((row) => {
    insertWinRate.run(runId, row.tier, row.wins, row.total, row.winRate);
  });

  const correlation = analysis.buildScoreCorrelation();
  db.prepare(`
    INSERT INTO rating_score_correlation (run_id, correlation, slope, intercept, points_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(runId, correlation.correlation, correlation.slope, correlation.intercept, JSON.stringify(correlation.points));

  const insertAccuracy = db.prepare(`
    INSERT INTO rating_accuracy_results
      (run_id, horizon_days, ticker, company, point_count, correlation, slope, intercept, points_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCalls = db.prepare(`
    INSERT INTO rating_call_results
      (run_id, horizon_days, scored_calls, correct_calls, incorrect_calls, hit_rate, hit_rate_low,
       hit_rate_high, average_return, median_return, open_calls, neutral_calls, calls_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  analysis.getAvailableAccuracyHorizons().forEach((horizonDays) => {
    analysis.buildTickerAccuracy(horizonDays).forEach((row) => {
      insertAccuracy.run(
        runId, horizonDays, row.ticker, row.company, row.points.length, row.correlation,
        row.slope, row.intercept, JSON.stringify(row.points),
      );
    });

    const callSummary = analysis.buildRatingCallSummary(horizonDays);
    insertCalls.run(
      runId, horizonDays, callSummary.scoredCalls, callSummary.correctCalls,
      callSummary.incorrectCalls, callSummary.hitRate, callSummary.hitRateLow,
      callSummary.hitRateHigh, callSummary.averageReturn, callSummary.medianReturn,
      callSummary.openCalls, callSummary.neutralCalls, JSON.stringify(callSummary.calls),
    );
  });
};

// The core flow: has this exact (fingerprint, methodology_version) pair already produced a
// completed run? If so, reuse it -- no wasted recompute or duplicate history. If not, insert a
// 'running' row immediately (visible right away for anyone inspecting the table), compute every
// tab, and write the whole snapshot in one transaction so a run is either fully there or not there
// at all; a failure rolls back the snapshot writes but leaves a 'failed' row with the error message
// rather than silently vanishing. Existing completed/failed runs are never edited or deleted --
// each fingerprint+methodology combination that has actually been calculated stays queryable
// forever, which is the whole point (compare before/after adding tickers, detect when a
// calculation-code change moved the numbers, etc.).
export const ensureRunForFingerprint = (analysis: AnalysisModule, fingerprint: string): RunRow => {
  const db = getDb();
  const methodologyVersion = getMethodologyVersion();

  const existing = findLatestCompletedRun(db, fingerprint, methodologyVersion);
  if (existing) return existing;

  const startedAt = new Date().toISOString();
  const inputSummary = buildInputSummary(analysis);
  const insertRun = db.prepare(`
    INSERT INTO analysis_runs (fingerprint, methodology_version, application_version, status, started_at, input_summary_json)
    VALUES (?, ?, ?, 'running', ?, ?)
  `);
  const info = insertRun.run(fingerprint, methodologyVersion, getApplicationVersion(), startedAt, JSON.stringify(inputSummary));
  const runId = Number(info.lastInsertRowid);

  try {
    db.exec('BEGIN');
    writeSnapshot(db, runId, analysis);
    const completedAt = new Date().toISOString();
    db.prepare(`UPDATE analysis_runs SET status = 'completed', completed_at = ? WHERE id = ?`).run(completedAt, runId);
    db.exec('COMMIT');
    return db.prepare(`SELECT * FROM analysis_runs WHERE id = ?`).get(runId) as RunRow;
  } catch (error) {
    db.exec('ROLLBACK');
    const message = error instanceof Error ? error.message : String(error);
    db.prepare(`UPDATE analysis_runs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?`)
      .run(new Date().toISOString(), message, runId);
    throw error;
  }
};
