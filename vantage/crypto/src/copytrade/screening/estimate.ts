import type { DatabaseSync } from 'node:sqlite';
import { MAX_REQUESTS_PER_WALLET } from '../simulation/constants.js';
import { listRosterWallets } from './roster.js';

export const FETCH_ESTIMATE_KEY = 'default';

/**
 * Used only until at least one completed run has been folded in — measured rates replace
 * them entirely from the first run onward. The seed values come from this project's own
 * run history rather than being invented: across every run that reached a terminal state,
 * seconds-per-request sat between 0.65 and 0.75 regardless of run size, because GMGN's
 * leaky-bucket limiter (rate 20, capacity 20) dominates wall-clock time; the fresh-wallet
 * request count is the mean of run 9's non-`up_to_date` wallets at a 30-day window.
 */
export const DEFAULT_SECONDS_PER_REQUEST = 0.7;
export const DEFAULT_REQUESTS_PER_FRESH_WALLET = 92;
export const DEFAULT_REQUESTS_PER_COVERED_WALLET = 1;
/** The window the seeded fresh-wallet request count was measured at, for period scaling. */
export const DEFAULT_OBSERVED_PERIOD_DAYS = 30;

export type FetchEstimateBasis = {
  source: 'measured' | 'default';
  runsCounted: number;
  lastRunId: number | null;
  secondsPerRequest: number;
  requestsPerFreshWallet: number;
  requestsPerCoveredWallet: number;
  observedPeriodDays: number;
  updatedAt: string | null;
};

export type FetchProjection = {
  walletCount: number;
  freshWallets: number;
  coveredWallets: number;
  periodDays: number;
  estimatedRequests: number;
  estimatedSeconds: number;
  basis: FetchEstimateBasis;
  /** How much history the estimate rests on. Surfaced so the UI never implies false precision. */
  confidence: 'seeded' | 'low' | 'medium' | 'high';
};

type EstimateRow = {
  lastRunId: number;
  runsCounted: number;
  totalSeconds: number;
  totalRequests: number;
  freshWallets: number;
  freshRequests: number;
  coveredWallets: number;
  coveredRequests: number;
  freshWalletPeriodDays: number;
};

const readRow = (database: DatabaseSync): EstimateRow | undefined =>
  database
    .prepare(
      `SELECT last_run_id AS lastRunId, runs_counted AS runsCounted, total_seconds AS totalSeconds,
          total_requests AS totalRequests, fresh_wallets AS freshWallets, fresh_requests AS freshRequests,
          covered_wallets AS coveredWallets, covered_requests AS coveredRequests,
          fresh_wallet_period_days AS freshWalletPeriodDays
   FROM copytrade_fetch_estimate WHERE cache_key = ?`,
    )
    .get(FETCH_ESTIMATE_KEY) as EstimateRow | undefined;

const confidenceFor = (runsCounted: number): FetchProjection['confidence'] =>
  runsCounted === 0 ? 'seeded' : runsCounted < 3 ? 'low' : runsCounted < 8 ? 'medium' : 'high';

/**
 * A wallet is "covered" when its stored history already reaches past the requested cutoff,
 * so the fetcher only tops up the newest rows (observed: 1 request). Everything else has to
 * page real ground. Mirrors `windowAlreadyCovered` in fetch.ts — the two must agree, or the
 * estimate would classify wallets differently than the fetcher actually treats them.
 */
const classifyWallets = (
  database: DatabaseSync,
  options: {
    chain: string;
    limit: number;
    periodDays: number;
    now: Date;
    walletAddresses?: string[];
  },
): { walletCount: number; freshWallets: number; coveredWallets: number } => {
  const cutoffSeconds = Math.floor(options.now.getTime() / 1000) - options.periodDays * 86_400;
  const walletAddresses =
    options.walletAddresses ??
    listRosterWallets(database, {
      chain: options.chain,
      limit: options.limit,
    }).map((wallet) => wallet.walletAddress);
  if (!walletAddresses.length) {
    // No roster captured yet: the fetch will pull one, so every requested slot is fresh ground.
    return {
      walletCount: options.walletAddresses?.length ?? options.limit,
      freshWallets: options.walletAddresses?.length ?? options.limit,
      coveredWallets: 0,
    };
  }
  const readOldest = database.prepare(
    `SELECT MIN(observed_timestamp) AS oldest FROM copytrade_trades WHERE wallet_address = ? AND chain = ?`,
  );
  let covered = 0;
  for (const walletAddress of walletAddresses) {
    const row = readOldest.get(walletAddress, options.chain) as { oldest: number | null };
    if (row.oldest !== null && row.oldest <= cutoffSeconds) covered += 1;
  }
  return {
    walletCount: walletAddresses.length,
    freshWallets: walletAddresses.length - covered,
    coveredWallets: covered,
  };
};

export const readFetchEstimateBasis = (database: DatabaseSync): FetchEstimateBasis => {
  const row = readRow(database);
  if (!row || row.runsCounted === 0 || row.totalRequests === 0) {
    return {
      source: 'default',
      runsCounted: 0,
      lastRunId: row?.lastRunId ?? null,
      secondsPerRequest: DEFAULT_SECONDS_PER_REQUEST,
      requestsPerFreshWallet: DEFAULT_REQUESTS_PER_FRESH_WALLET,
      requestsPerCoveredWallet: DEFAULT_REQUESTS_PER_COVERED_WALLET,
      observedPeriodDays: DEFAULT_OBSERVED_PERIOD_DAYS,
      updatedAt: null,
    };
  }
  return {
    source: 'measured',
    runsCounted: row.runsCounted,
    lastRunId: row.lastRunId,
    secondsPerRequest: row.totalSeconds / row.totalRequests,
    requestsPerFreshWallet:
      row.freshWallets > 0
        ? row.freshRequests / row.freshWallets
        : DEFAULT_REQUESTS_PER_FRESH_WALLET,
    requestsPerCoveredWallet:
      row.coveredWallets > 0
        ? row.coveredRequests / row.coveredWallets
        : DEFAULT_REQUESTS_PER_COVERED_WALLET,
    observedPeriodDays:
      row.freshWallets > 0
        ? row.freshWalletPeriodDays / row.freshWallets
        : DEFAULT_OBSERVED_PERIOD_DAYS,
    updatedAt:
      (
        database
          .prepare(
            `SELECT updated_at AS updatedAt FROM copytrade_fetch_estimate WHERE cache_key = ?`,
          )
          .get(FETCH_ESTIMATE_KEY) as { updatedAt: string } | undefined
      )?.updatedAt ?? null,
  };
};

/**
 * Folds one finished run into the running aggregate. Only `completed` runs count — a run that
 * stalled on a rate limit lands in `rate_limited`, and one the user stopped lands in
 * `cancelled`, so neither can drag the seconds-per-request rate away from its true value.
 *
 * Idempotent by watermark: a run at or below `last_run_id` is ignored, so re-calling this for
 * the same run (or replaying an old one) can never double-count. Nothing here reads more than
 * the single run being folded in.
 */
export const recordFetchRunEstimate = (
  database: DatabaseSync,
  runId: number,
  now = new Date(),
): boolean => {
  const existing = readRow(database);
  if (existing && runId <= existing.lastRunId) return false;

  const run = database
    .prepare(
      `SELECT id, started_at AS startedAt, completed_at AS completedAt, status, requests_made AS requestsMade
     FROM copytrade_fetch_runs WHERE id = ?`,
    )
    .get(runId) as
    | {
        id: number;
        startedAt: string;
        completedAt: string | null;
        status: string;
        requestsMade: number;
      }
    | undefined;
  if (!run || run.status !== 'completed' || !run.completedAt) return false;

  const seconds = (Date.parse(run.completedAt) - Date.parse(run.startedAt)) / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0 || run.requestsMade <= 0) return false;

  // `up_to_date` is the fetcher's own name for "stored history already covers the window",
  // which is exactly the covered/fresh split the projection needs.
  const events = database
    .prepare(
      `SELECT stop_reason AS stopReason, requests_used AS requestsUsed, requested_period_days AS periodDays
     FROM copytrade_wallet_coverage_events WHERE run_id = ?`,
    )
    .all(runId) as unknown as Array<{
    stopReason: string | null;
    requestsUsed: number;
    periodDays: number | null;
  }>;

  let freshWallets = 0;
  let freshRequests = 0;
  let coveredWallets = 0;
  let coveredRequests = 0;
  let freshPeriodDays = 0;
  for (const event of events) {
    if (event.stopReason === 'cancelled') continue;
    if (event.stopReason === 'up_to_date') {
      coveredWallets += 1;
      coveredRequests += event.requestsUsed;
      continue;
    }
    freshWallets += 1;
    freshRequests += event.requestsUsed;
    freshPeriodDays += event.periodDays ?? DEFAULT_OBSERVED_PERIOD_DAYS;
  }

  database
    .prepare(
      `INSERT INTO copytrade_fetch_estimate
       (cache_key, last_run_id, runs_counted, total_seconds, total_requests,
        fresh_wallets, fresh_requests, covered_wallets, covered_requests, fresh_wallet_period_days, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       last_run_id = excluded.last_run_id,
       runs_counted = copytrade_fetch_estimate.runs_counted + 1,
       total_seconds = copytrade_fetch_estimate.total_seconds + excluded.total_seconds,
       total_requests = copytrade_fetch_estimate.total_requests + excluded.total_requests,
       fresh_wallets = copytrade_fetch_estimate.fresh_wallets + excluded.fresh_wallets,
       fresh_requests = copytrade_fetch_estimate.fresh_requests + excluded.fresh_requests,
       covered_wallets = copytrade_fetch_estimate.covered_wallets + excluded.covered_wallets,
       covered_requests = copytrade_fetch_estimate.covered_requests + excluded.covered_requests,
       fresh_wallet_period_days = copytrade_fetch_estimate.fresh_wallet_period_days + excluded.fresh_wallet_period_days,
       updated_at = excluded.updated_at`,
    )
    .run(
      FETCH_ESTIMATE_KEY,
      runId,
      seconds,
      run.requestsMade,
      freshWallets,
      freshRequests,
      coveredWallets,
      coveredRequests,
      freshPeriodDays,
      now.toISOString(),
    );
  return true;
};

/**
 * Projects how long a fetch of `limit` traders over `periodDays` will take.
 *
 * Fresh-wallet cost is scaled linearly by the ratio of the requested window to the window the
 * rate was measured at. Linear scaling is an approximation (trade volume is not uniform across
 * a wallet's history); the returned `confidence` exists so the UI can say so rather than
 * implying a precise figure.
 */
export const projectFetchDuration = (
  database: DatabaseSync,
  options: {
    limit: number;
    periodDays: number;
    chain?: string;
    now?: Date;
    walletAddresses?: string[];
  },
): FetchProjection => {
  const chain = options.chain ?? 'sol';
  const now = options.now ?? new Date();
  const basis = readFetchEstimateBasis(database);
  const { walletCount, freshWallets, coveredWallets } = classifyWallets(database, {
    chain,
    limit: options.limit,
    periodDays: options.periodDays,
    now,
    walletAddresses: options.walletAddresses,
  });

  const periodScale =
    basis.observedPeriodDays > 0 ? options.periodDays / basis.observedPeriodDays : 1;
  const perFresh = Math.min(MAX_REQUESTS_PER_WALLET, basis.requestsPerFreshWallet * periodScale);
  const estimatedRequests = Math.round(
    freshWallets * perFresh + coveredWallets * basis.requestsPerCoveredWallet,
  );

  return {
    walletCount,
    freshWallets,
    coveredWallets,
    periodDays: options.periodDays,
    estimatedRequests,
    estimatedSeconds: Math.round(estimatedRequests * basis.secondsPerRequest),
    basis,
    confidence: confidenceFor(basis.runsCounted),
  };
};

/**
 * Remaining seconds for a run already in flight. Prefers the run's own observed pace — its
 * real elapsed time per finished wallet — over the historical average, because a run's actual
 * conditions (rate-limit pressure, how much of the roster was already covered) beat any prior.
 * Falls back to the stored basis until the first wallet finishes and a pace exists to measure.
 */
export const estimateRemainingSeconds = (
  database: DatabaseSync,
  run: {
    startedAt: string;
    walletDone: number;
    walletTotal: number;
    periodDays: number | null;
    chain?: string;
  },
  now = new Date(),
): number | null => {
  const remaining = run.walletTotal - run.walletDone;
  if (remaining <= 0 || run.walletTotal <= 0) return null;
  if (run.walletDone > 0) {
    const elapsed = (now.getTime() - Date.parse(run.startedAt)) / 1000;
    if (Number.isFinite(elapsed) && elapsed > 0)
      return Math.round((elapsed / run.walletDone) * remaining);
  }
  const basis = readFetchEstimateBasis(database);
  const periodScale =
    basis.observedPeriodDays > 0 && run.periodDays ? run.periodDays / basis.observedPeriodDays : 1;
  const perFresh = Math.min(MAX_REQUESTS_PER_WALLET, basis.requestsPerFreshWallet * periodScale);
  return Math.round(remaining * perFresh * basis.secondsPerRequest);
};
