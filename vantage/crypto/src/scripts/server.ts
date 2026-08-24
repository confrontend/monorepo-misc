import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { defaultArchivePath, openDatabase } from '../platform/db/client.js';
import { readDatabaseStats } from '../platform/db/stats.js';
import { readDataQuality } from '../signals/quality.js';
import { readIntegrityReport } from '../signals/integrity.js';
import { readSnapshotAnalysis } from '../signals/analysis.js';
import { readSignalScoringReport } from '../signals/scoring.js';
import { archiveDuneSource } from '../dune/ingest/archive.js';
import { importDuneContent } from '../dune/ingest/importer.js';
import { storeGmgnSignal } from '../gmgn/capture/ingest.js';
import { asRecord, normalizeGmgnProfitStat } from '../gmgn/normalize.js';
import { listGmgnTokenAddresses } from '../gmgn/tokenAddresses.js';
import { readGmgnCredentialStatus } from '../gmgn/client/credentials.js';
import { probeGmgn } from '../gmgn/capture/probe.js';
import { captureGmgnSignals } from '../gmgn/capture/capture.js';
import { importGmgnBrowserCapture } from '../gmgn/capture/browserImport.js';
import { listGmgnArchives } from '../gmgn/archives.js';
import { RESEARCH_QUESTION } from '../research/question.js';
import { logDiagnostic, readRecentDiagnostics } from '../platform/db/diagnostics.js';
import { redactSensitiveText } from '../platform/security/redaction.js';
import { listOutcomeCandidates, measureDuneOutcomes, readAllDuneOutcomes, readLatestDuneOutcomes, reconcileStuckDuneRuns } from '../dune/outcomes.js';
import { buildMeasurementPlan } from '../dune/planner.js';
import { computeSignalPatternReport, computeSignalPatternSubgroupReport, listSignalPatternSnapshots, saveSignalPatternSnapshot, type SubgroupProperty } from '../signals/patterns.js';
import { listRadarSnapshots, listWalletRankSnapshots, listSmartMoneyWalletStats, listTwitterMessages, readRawEndpointSummary } from '../gmgn/client/rawEndpointReads.js';
import { computeRobustPatternReport, type RobustPatternReport } from '../signals/robustPatterns.js';
import { computeCopyTradeReport, readCopyTradeSummary, saveCopyTradeSnapshot } from '../copytrade/scrutiny/evaluate.js';
import { computeHistoricalConsistency } from '../copytrade/scrutiny/historicalConsistency.js';
import { computeCopyCandidates, computeHighUpsideEligibleCandidates, computeScreenPassCandidates, type CopySimulationSurvivalInput } from '../copytrade/scrutiny/copyCandidates.js';
import { listLeaderboardSnapshotStatuses, listRosterWallets, readCaptureHealth, resolveSingleTrader, syncCopyTradeRoster } from '../copytrade/screening/roster.js';
import { importWalletRankSnapshot, refreshCurrentWalletRank, RESEARCH_RANK_MIN_WINRATE_30D, RESEARCH_RANK_ORDERBY } from '../gmgn/walletRankFetch.js';
import { compareLatestRosterSnapshots } from '../copytrade/screening/roster.js';
import { hasActiveFetchRun, readFetchRunState, reconcileStaleFetchRuns, requestCopyTradeFetchStop, resetCopyTradeFetchResume, startCopyTradeFetch } from '../copytrade/screening/fetch.js';
import { readGmgnStatsFetchStatus, startGmgnStatsFetch, stopGmgnStatsFetch } from '../copytrade/screening/statsFetch.js';
import { projectFetchDuration } from '../copytrade/screening/estimate.js';
import { computeCopySimulationReport, computeLiquidityImpactReport, runCopySimulationBatch } from '../copytrade/simulation/copySimulation.js';
import { computeEliminationReport, estimateDuneRefetchDuration } from '../copytrade/scrutiny/eliminationFilter.js';
import { computeCandidateScrutinyBatch, MAX_SCRUTINY_WALLETS } from '../copytrade/scrutiny/candidateScrutiny.js';
import { DEFAULT_FULLY_COVERED_PERIOD_DAYS, readFullyCoveredWallets } from '../copytrade/scrutiny/fullyCovered.js';
import { DEFAULT_PATTERN_DISCOVERY_PERIOD_DAYS, MAX_PATTERN_DISCOVERY_PERIOD_DAYS, readPatternDiscoveryExport } from '../copytrade/discovery/patternDiscovery.js';
import { PatternDiscoveryRunnerError, runPatternDiscoveryReport } from '../copytrade/discovery/patternDiscoveryRunner.js';
import { waitForGmgnRequest } from '../gmgn/client/rateLimit.js';
import { downloadRosterIcons, walletIconDirectory } from '../copytrade/icons.js';
import { readGmgnRiskResults, saveGmgnRiskResult } from '../copytrade/scrutiny/gmgnRisk.js';
import { computeExperimentalDecisionReport } from '../copytrade/experimentalDecision.js';
import { API_CATALOG } from '../apiCatalog.js';

/** Scrutiny interrogates individually-pinned wallets, not a ranked top-N — so its roster scope
 *  must cover the whole roster (well above its current ~113-wallet size), unlike /winners's
 *  deliberate top-25 cutoff. */
const SCRUTINY_ROSTER_LIMIT = 500;

import type { DunePollUpdate } from '../copytrade/simulation/copySimulationDune.js';
import { importBrowserWalletActivity } from '../copytrade/browserActivityImport.js';

const database = openDatabase();
// A CopyTrade fetch only runs inside the process that started it, so anything still marked
// running at startup was orphaned by a restart and would otherwise latch the single-run guard.
const interruptedFetches = reconcileStaleFetchRuns(database);
// In development, a Vite/tsx restart is common and should not turn a partially fetched GMGN
// snapshot into a manual recovery task. Resume only the exact restart-interruption marker; a
// user-cancelled run, reset snapshot, ordinary provider failure, or completed run remains idle.
// The cursor and idempotent trade storage make this safe: already-saved pages are skipped or
// deduplicated, while the next saved cursor continues the unfinished wallet.
if (interruptedFetches > 0 && process.env.CRYPTO_AUTO_RESUME_INTERRUPTED_FETCHES !== 'false') {
  const interrupted = database.prepare(
    `SELECT id, requested_period_days AS periodDays, trader_limit AS traderLimit
     FROM copytrade_fetch_runs
     WHERE fetch_scope = 'roster'
       AND status = 'failed'
       AND error = 'Interrupted: the server restarted while this fetch was running. Already-fetched trades were kept.'
       AND COALESCE(resume_disabled, 0) = 0
     ORDER BY id DESC LIMIT 1`,
  ).get() as { id: number; periodDays: number | null; traderLimit: number | null } | undefined;
  if (interrupted) {
    console.log(`[copytrade] automatically resuming interrupted GMGN fetch ${interrupted.id}`);
    startCopyTradeFetch(database, {
      limit: interrupted.traderLimit ?? 100,
      periodDays: interrupted.periodDays ?? 30,
      scope: 'roster',
    });
  }
}
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const uiRoot = path.join(projectRoot, 'dist-ui');
const port = Number(process.env.CRYPTO_RESEARCH_PORT ?? 4173);
const maxBodyBytes = 512 * 1024 * 1024;

// Short-TTL cache for the robust pattern report (see its route below) — this endpoint runs a
// multi-second synchronous computation, so a burst of near-simultaneous requests should share
// one result rather than each independently blocking the event loop for the full cost.
const robustReportCache = new Map<number, { computedAtMs: number; report: RobustPatternReport }>();
const ROBUST_REPORT_CACHE_TTL_MS = 5000;
const ROBUST_REPORT_CACHE_MAX_ENTRIES = 8;

type ResearchCacheEntry = { fingerprint: string; value: unknown };
const researchReportCache = new Map<string, ResearchCacheEntry>();

// These aggregate reads are intentionally tiny compared with recomputing a report. They make
// the cache correct even when an async GMGN/Dune job writes later in the same server process.
const researchDataFingerprint = (): string => {
  const row = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM copytrade_trades) AS tradesCount,
      (SELECT COALESCE(MAX(id), 0) FROM copytrade_trades) AS tradesMaxId,
      (SELECT COUNT(*) FROM copytrade_wallets) AS walletsCount,
      (SELECT COALESCE(MAX(source_snapshot_id), 0) FROM copytrade_wallets) AS walletsMaxSnapshot,
      (SELECT COUNT(*) FROM copytrade_wallet_stats) AS statsCount,
      (SELECT COALESCE(MAX(rowid), 0) FROM copytrade_wallet_stats) AS statsMaxRowid,
      (SELECT COUNT(*) FROM copytrade_gmgn_risk_stats) AS gmgnRiskCount,
      (SELECT COALESCE(MAX(fetched_at), '') FROM copytrade_gmgn_risk_stats) AS gmgnRiskMaxFetchedAt,
      (SELECT COUNT(*) FROM copytrade_copy_simulation_runs) AS simulationCount,
      (SELECT COALESCE(MAX(id), 0) FROM copytrade_copy_simulation_runs) AS simulationMaxId
  `).get() as Record<string, unknown>;
  return JSON.stringify(row);
};

const readCachedResearch = <T>(key: string, compute: () => T): T => {
  const fingerprint = researchDataFingerprint();
  const cached = researchReportCache.get(key);
  if (cached?.fingerprint === fingerprint) return cached.value as T;
  const persisted = database.prepare(
    `SELECT report_json AS reportJson FROM copytrade_report_cache WHERE cache_key = ? AND data_fingerprint = ?`,
  ).get(key, fingerprint) as { reportJson: string } | undefined;
  if (persisted) {
    try {
      const value = JSON.parse(persisted.reportJson) as T;
      researchReportCache.set(key, { fingerprint, value });
      return value;
    } catch { /* discard malformed cache and recompute below */ }
  }
  const value = compute();
  researchReportCache.set(key, { fingerprint, value });
  database.prepare(
    `INSERT INTO copytrade_report_cache (cache_key, data_fingerprint, report_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       data_fingerprint = excluded.data_fingerprint,
       report_json = excluded.report_json,
       updated_at = excluded.updated_at`,
  ).run(key, fingerprint, JSON.stringify(value), new Date().toISOString());
  return value;
};

// Bump the v-suffix whenever CopySimulationReport/CopySimulationWalletReport's shape changes
// (new/renamed/removed fields). readCachedResearch's fingerprint only tracks DATA changes (row
// counts/max ids); it has no way to detect that the CODE summarizing that data changed shape.
// Without a version bump here, a stale JSON already persisted in copytrade_report_cache (which
// survives server restarts, unlike the in-memory Map layered on top of it) keeps being served
// forever once the underlying trade/simulation rows stop changing — confirmed live, 2026-08-23:
// adding pendingDuneTargets/duneNoMatchTargets/duneMatchedTargets to CopySimulationWalletReport
// was correctly computed by fresh calls but kept invisible to a browser tab that had already
// triggered a cache write, and no server restart or browser action fixed it — only this bump
// does. Same pattern this file already uses for the wallet-stats results cache (`results-v3`).
const COPY_SIMULATION_CACHE_VERSION = 2;
const copySimulationCacheKey = (walletAddresses: string[], periodDays?: number): string => {
  const scope = [...new Set(walletAddresses)].sort().join(',');
  const scopeHash = createHash('sha256').update(scope, 'utf8').digest('hex').slice(0, 24);
  return `copy-simulation-v${COPY_SIMULATION_CACHE_VERSION}:${periodDays ?? 'all'}:${scopeHash}`;
};

/** `batches` records every batch this run attempted and how it ended, so "it stopped" can always
 *  be read as one of: finished everything, hit the per-call batch ceiling with work remaining,
 *  was stopped by the user, or had specific batches fail. Dune query time for an identical
 *  batch size has been measured anywhere from 6 seconds to 24 minutes, so an in-flight batch
 *  showing no progress is normal and must be visually distinct from a failed one. */
type CopySimulationBatchOutcome = {
  batch: number; targets: number; status: 'running' | 'stored' | 'failed'; seconds: number | null; error: string | null;
};
type CopySimulationRunState = {
  mode: 'precise' | 'wide_retry';
  running: boolean; cancelRequested: boolean; targetsTotal: number; targetsProcessed: number;
  batchesRun: number; currentBatch: number; batchesTotal: number; message: string;
  batches: CopySimulationBatchOutcome[]; startedAt: string | null; finishedAt: string | null;
  storedTargets: number; failedTargets: number; remainingTargets: number;
  outcome: 'idle' | 'running' | 'complete' | 'partial' | 'stopped' | 'error';
  duneExecutionId: string | null; duneState: string | null; dunePollCount: number; duneElapsedSeconds: number;
  duneIsExecutionFinished: boolean; duneExecutionCostCredits: number | null; duneLastStatusAt: string | null;
  duneRequestPhase: DunePollUpdate['requestPhase'] | 'idle'; duneLastHttpStatus: number | null; duneLastRequestMs: number | null; duneLastPayload: string | null;
  retryableTargetsBefore: number | null; retryableTargetsRemaining: number | null; coverageBeforePercent: number | null; coverageAfterPercent: number | null;
};
const idleCopySimulationRunState: CopySimulationRunState = {
  mode: 'precise',
  running: false, cancelRequested: false, targetsTotal: 0, targetsProcessed: 0,
  batchesRun: 0, currentBatch: 0, batchesTotal: 0, message: 'Idle',
  batches: [], startedAt: null, finishedAt: null,
  storedTargets: 0, failedTargets: 0, remainingTargets: 0, outcome: 'idle',
  duneExecutionId: null, duneState: null, dunePollCount: 0, duneElapsedSeconds: 0,
  duneIsExecutionFinished: false, duneExecutionCostCredits: null, duneLastStatusAt: null,
  duneRequestPhase: 'idle', duneLastHttpStatus: null, duneLastRequestMs: null, duneLastPayload: null,
  retryableTargetsBefore: null, retryableTargetsRemaining: null, coverageBeforePercent: null, coverageAfterPercent: null,
};
let copySimulationRunState: CopySimulationRunState = { ...idleCopySimulationRunState };
let copySimulationBatchStartedAt = 0;

// Disabled for now (kept in place, not removed): unattended continuous polling needs more
// runway on the manual one-off capture path first. /status and /stop stay live (harmless,
// idempotent) so the UI can still reflect state; only /start is blocked. Flip this back to
// true to re-enable — no other changes needed.

const json = (response: ServerResponse, status: number, value: unknown): void => {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(body);
};

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBodyBytes) throw new Error(`Request is larger than ${Math.floor(maxBodyBytes / (1024 * 1024))} MB.`);
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const mimeType = (filePath: string): string => {
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  return 'text/html; charset=utf-8';
};

const staticFile = (requestPath: string, response: ServerResponse): void => {
  const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\//, '');
  const filePath = path.resolve(uiRoot, relative);
  if (!filePath.startsWith(`${uiRoot}${path.sep}`) || !existsSync(filePath)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  response.writeHead(200, { 'content-type': mimeType(filePath) });
  response.end(readFileSync(filePath));
};

/** Shared by /historical-consistency and /winners so the trade-loading query and the
 *  roster/consistency join live in exactly one place, not two. */
const readHistoricalConsistencyForRoster = (
  database: DatabaseSync,
  limit: number,
  rosterSnapshotId?: number,
): { roster: ReturnType<typeof listRosterWallets>; computed: ReturnType<typeof computeHistoricalConsistency> } => {
  const roster = listRosterWallets(database, { chain: 'sol', limit, snapshotId: rosterSnapshotId });
  const wallets = roster.map((wallet) => wallet.walletAddress);
  if (wallets.length === 0) return { roster, computed: computeHistoricalConsistency([], new Date()) };
  const placeholders = wallets.map(() => '?').join(', ');
  const rows = database.prepare(
    `SELECT id, wallet_address AS walletAddress, observed_timestamp AS observedTimestamp,
            event_type AS eventType, token_address AS tokenAddress,
            token_symbol AS tokenSymbol, cost_usd AS costUsd, buy_cost_usd AS buyCostUsd
     FROM copytrade_trades
     WHERE chain = ? AND wallet_address IN (${placeholders})
     ORDER BY wallet_address ASC, observed_timestamp ASC, id ASC`,
  ).all('sol', ...wallets) as unknown as Parameters<typeof computeHistoricalConsistency>[0];
  return { roster, computed: computeHistoricalConsistency(rows, new Date()) };
};

/**
 * Read-only: builds the copy-survival map computeCopyCandidates needs, from whatever Dune
 * copy-simulation runs already exist — never triggers a new Dune query itself (that only
 * happens from the explicit /copy-simulation/run action). A wallet that hasn't been simulated
 * yet is simply absent from the map, and computeCopyCandidates already treats "absent" as
 * "not_yet_simulated", not as passing.
 */
const readCopySimulationSurvivalMap = (
  database: DatabaseSync,
  screenReport: ReturnType<typeof computeCopyTradeReport>,
  historicalConsistency: ReturnType<typeof computeHistoricalConsistency>,
): Map<string, CopySimulationSurvivalInput> => {
  const walletAddresses = copySimulationWalletAddresses(screenReport, historicalConsistency);
  if (!walletAddresses.length) return new Map();
  const simReport = computeCopySimulationReport(database, { walletAddresses, periodDays: 30 });
  return new Map(simReport.wallets.map((wallet) => [wallet.walletAddress, {
    simulatedMedianReturnPercent: wallet.simulatedMedianReturnPercent,
    simulatedMeanReturnPercent: wallet.simulatedMeanReturnPercent,
    tradesAbove100Percent: wallet.tradesAbove100Percent,
    tailShareOfMeanPercent: wallet.tailShareOfMeanPercent,
    coverageRatePercent: wallet.coverageRatePercent,
    roundTripsConsidered: wallet.roundTripsConsidered,
    portfolioRealizedPnlUsd: wallet.portfolio.realizedPnlUsd,
    gasCostComplete: wallet.gasCostComplete,
  }]));
};

const copySimulationWalletAddresses = (
  screenReport: ReturnType<typeof computeCopyTradeReport>,
  historicalConsistency: ReturnType<typeof computeHistoricalConsistency>,
): string[] => [...new Set([
    ...computeScreenPassCandidates(screenReport, historicalConsistency).candidates.map((candidate) => candidate.walletAddress),
    ...computeHighUpsideEligibleCandidates(screenReport, historicalConsistency).map((candidate) => candidate.walletAddress),
  ])];

const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const startedAt = Date.now();
  const requestBytes = Number(request.headers['content-length'] ?? '') || null;
  let responded = false;

  // Detects the exact failure class that reset/ECANCELED errors are invisible for otherwise:
  // the client (or an intermediary proxy) drops the connection before a response is ever sent.
  response.once('close', () => {
    if (!responded) {
      logDiagnostic(database, {
        level: 'warn',
        event: 'client-disconnected',
        method: request.method ?? null,
        path: requestUrl.pathname,
        durationMs: Date.now() - startedAt,
        requestBytes,
        message: 'Connection closed before a response was sent (client abort or connection reset).',
      });
    }
  });

  const respond = (status: number, value: unknown): void => {
    responded = true;
    json(response, status, value);
    if (request.method !== 'GET' || status >= 400) {
      logDiagnostic(database, {
        level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
        event: 'request-complete',
        method: request.method ?? null,
        path: requestUrl.pathname,
        status,
        durationMs: Date.now() - startedAt,
        requestBytes,
      });
    }
  };

  try {
    if (request.method === 'GET' && requestUrl.pathname === '/api/docs') {
      respond(200, { generatedAt: new Date().toISOString(), source: 'server API catalog', count: API_CATALOG.length, endpoints: API_CATALOG });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/stats') {
      respond(200, readDatabaseStats(database));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/quality') {
      respond(200, readDataQuality(database));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/integrity') {
      respond(200, readIntegrityReport(database));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/analysis/snapshot') {
      respond(200, readSnapshotAnalysis(database));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/analysis/scores') {
      respond(200, readSignalScoringReport(database));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/research-question') {
      respond(200, RESEARCH_QUESTION);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/dune/candidates') {
      const rawLimit = requestUrl.searchParams.get('limit');
      const limit = rawLimit === null ? undefined : Number(rawLimit);
      if (rawLimit !== null && (!Number.isFinite(limit) || (limit as number) <= 0)) { respond(400, { error: 'limit must be a positive number when provided.' }); return; }
      respond(200, listOutcomeCandidates(database, limit));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/dune/outcomes') {
      const payload = await readJsonBody(request) as { signalIds?: unknown };
      if (!Array.isArray(payload.signalIds) || payload.signalIds.some((id) => typeof id !== 'number' || !Number.isInteger(id))) { respond(400, { error: 'Dune outcome measurement requires signal ids.' }); return; }
      respond(200, await measureDuneOutcomes(database, payload.signalIds));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/dune/outcomes/latest') {
      respond(200, readLatestDuneOutcomes(database));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/dune/outcomes/all') {
      respond(200, readAllDuneOutcomes(database));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/dune/reconcile') {
      respond(200, await reconcileStuckDuneRuns(database));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/dune/measurement-plan') {
      respond(200, buildMeasurementPlan(database));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/analysis/patterns') {
      respond(200, computeSignalPatternReport(database));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/analysis/patterns/snapshot') {
      respond(200, saveSignalPatternSnapshot(database, computeSignalPatternReport(database)));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/analysis/patterns/snapshots') {
      respond(200, listSignalPatternSnapshots(database));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/analysis/patterns/subgroups') {
      const property = requestUrl.searchParams.get('property');
      if (property !== 'launchPlatform' && property !== 'tokenAge' && property !== 'combined') { respond(400, { error: 'property must be "launchPlatform", "tokenAge", or "combined".' }); return; }
      respond(200, computeSignalPatternSubgroupReport(database, property));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/analysis/patterns/robust') {
      const rawIterations = Number(requestUrl.searchParams.get('iterations') ?? '');
      // Default kept modest (not the module's own 2000-iteration default) because this runs
      // synchronously on Node's single event loop, same class of concern as the prescreen
      // write-loop fix earlier this session — 1000 iterations is still a standard, reasonable
      // bootstrap sample count for a percentile-method CI, just faster to compute at this data
      // volume. A heavier run is available via ?iterations= for offline/one-off use, at the cost
      // of blocking the event loop longer — the short-TTL cache below exists specifically so a
      // burst of near-simultaneous requests (a UI double-fetch, several open tabs) only pays
      // that cost once rather than once per request.
      const iterations = Number.isFinite(rawIterations) && rawIterations > 0 ? Math.min(rawIterations, 5000) : 1000;
      const cached = robustReportCache.get(iterations);
      const nowMs = Date.now();
      if (cached && nowMs - cached.computedAtMs < ROBUST_REPORT_CACHE_TTL_MS) {
        respond(200, cached.report);
        return;
      }
      const report = computeRobustPatternReport(database, new Date(nowMs), { bootstrapIterations: iterations });
      if (robustReportCache.size >= ROBUST_REPORT_CACHE_MAX_ENTRIES) robustReportCache.clear(); // bounded, not a real LRU — this endpoint only ever sees a handful of distinct iteration values in practice
      robustReportCache.set(iterations, { computedAtMs: nowMs, report });
      respond(200, report);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/gmgn/raw-endpoints/summary') {
      respond(200, readRawEndpointSummary(database));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname.startsWith('/api/gmgn/raw-endpoints/')) {
      const type = requestUrl.pathname.slice('/api/gmgn/raw-endpoints/'.length);
      const limitParam = Number(requestUrl.searchParams.get('limit') ?? '');
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;
      if (type === 'radar') { respond(200, listRadarSnapshots(database, limit)); return; }
      if (type === 'wallet-rank') { respond(200, listWalletRankSnapshots(database, limit)); return; }
      if (type === 'smart-money') { respond(200, listSmartMoneyWalletStats(database, requestUrl.searchParams.get('wallet') ?? undefined, limit)); return; }
      if (type === 'twitter') { respond(200, listTwitterMessages(database, limit)); return; }
      respond(400, { error: 'type must be one of "radar", "wallet-rank", "smart-money", or "twitter".' });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/gmgn/status') {
      respond(200, readGmgnCredentialStatus());
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/summary') {
      respond(200, readCachedResearch('summary', () => readCopyTradeSummary(database)));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/fully-covered') {
      const rawPeriodDays = requestUrl.searchParams.get('periodDays') ?? String(DEFAULT_FULLY_COVERED_PERIOD_DAYS);
      const periodDays = Number(rawPeriodDays);
      if (!Number.isInteger(periodDays) || periodDays <= 0 || periodDays > 365) {
        respond(400, { error: 'periodDays must be an integer between 1 and 365.' });
        return;
      }
      respond(200, readFullyCoveredWallets(database, periodDays));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/pattern-discovery/export') {
      const rawPeriodDays = requestUrl.searchParams.get('periodDays') ?? String(DEFAULT_PATTERN_DISCOVERY_PERIOD_DAYS);
      const periodDays = Number(rawPeriodDays);
      const rawLimit = requestUrl.searchParams.get('limit') ?? '500';
      const limit = Number(rawLimit);
      if (!Number.isInteger(periodDays) || periodDays <= 0 || periodDays > MAX_PATTERN_DISCOVERY_PERIOD_DAYS) {
        respond(400, { error: `periodDays must be an integer between 1 and ${MAX_PATTERN_DISCOVERY_PERIOD_DAYS}.` });
        return;
      }
      if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
        respond(400, { error: 'limit must be an integer between 1 and 500.' });
        return;
      }
      try {
        respond(200, readPatternDiscoveryExport(database, periodDays, limit));
      } catch (error) {
        respond(400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/copytrade/pattern-discovery/run/report') {
      let payload: { periodDays?: unknown; minN?: unknown } = {};
      try {
        payload = (await readJsonBody(request)) as { periodDays?: unknown; minN?: unknown };
      } catch (error) {
        respond(400, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      const periodDays = payload.periodDays === undefined ? DEFAULT_PATTERN_DISCOVERY_PERIOD_DAYS : Number(payload.periodDays);
      const minN = payload.minN === undefined ? 10 : Number(payload.minN);
      try {
        respond(200, await runPatternDiscoveryReport(database, { projectRoot, periodDays, minN }));
      } catch (error) {
        const statusCode = error instanceof PatternDiscoveryRunnerError ? error.statusCode : 500;
        respond(statusCode, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/copytrade/fetch') {
      const payload = (await readJsonBody(request)) as { limit?: unknown; periodDays?: unknown };
      const limit = Number(payload.limit);
      const periodDays = Number(payload.periodDays);
      if (!Number.isInteger(limit) || limit <= 0 || limit > 500) { respond(400, { error: 'limit must be an integer between 1 and 500.' }); return; }
      if (!Number.isInteger(periodDays) || periodDays <= 0 || periodDays > 365) { respond(400, { error: 'periodDays must be an integer between 1 and 365.' }); return; }
      // One run at a time: concurrent runs would double the request rate against a limiter
      // whose penalty for overshooting is a multi-minute ban.
      if (hasActiveFetchRun(database)) { respond(409, { error: 'A fetch run is already in progress.' }); return; }
      respond(200, startCopyTradeFetch(database, { limit, periodDays }));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/copytrade/fetch/single') {
      const payload = (await readJsonBody(request)) as { query?: unknown; periodDays?: unknown };
      const query = typeof payload.query === 'string' ? payload.query.trim() : '';
      const periodDays = Number(payload.periodDays);
      if (!query) { respond(400, { error: 'Enter a wallet address or trader name.' }); return; }
      if (!Number.isInteger(periodDays) || periodDays <= 0 || periodDays > 365) { respond(400, { error: 'periodDays must be an integer between 1 and 365.' }); return; }
      if (hasActiveFetchRun(database)) { respond(409, { error: 'A fetch run is already in progress.' }); return; }
      const resolved = resolveSingleTrader(database, query);
      if (resolved.kind === 'not_found') {
        respond(404, { error: `No wallet address matches "${query}", and no stored trader has that exact name. Try the wallet address directly, or capture a leaderboard snapshot that includes them first.` });
        return;
      }
      const result = startCopyTradeFetch(database, { limit: 1, periodDays, walletAddresses: [resolved.walletAddress], scope: 'single' });
      respond(200, { ...result, resolved });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/copytrade/fetch/stop') {
      respond(200, requestCopyTradeFetchStop(database));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/copytrade/fetch/resume') {
      if (hasActiveFetchRun(database)) { respond(409, { error: 'A fetch run is already in progress.' }); return; }
      const previous = database.prepare(
        `SELECT requested_period_days AS periodDays, trader_limit AS traderLimit
         FROM copytrade_fetch_runs
         WHERE fetch_scope = 'roster' AND status IN ('cancelled', 'failed', 'rate_limited')
           AND COALESCE(resume_disabled, 0) = 0
         ORDER BY id DESC LIMIT 1`,
      ).get() as { periodDays: number | null; traderLimit: number | null } | undefined;
      if (!previous) { respond(409, { error: 'No resumable GMGN top-100 snapshot exists.' }); return; }
      respond(200, startCopyTradeFetch(database, {
        limit: previous.traderLimit ?? 100, periodDays: previous.periodDays ?? 30, scope: 'roster',
      }));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/copytrade/fetch/reset') {
      if (hasActiveFetchRun(database)) { respond(409, { error: 'Stop the active fetch before resetting its resumable snapshot.' }); return; }
      respond(200, resetCopyTradeFetchResume(database));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/copytrade/stats/fetch') {
      const payload = (await readJsonBody(request)) as { limit?: unknown; snapshotId?: unknown; maxAgeHours?: unknown };
      const limit = Number(payload.limit);
      if (!Number.isInteger(limit) || limit <= 0 || limit > 500) { respond(400, { error: 'limit must be an integer between 1 and 500.' }); return; }
      if (readGmgnStatsFetchStatus().running) { respond(409, { error: 'A GMGN stats fetch is already in progress.' }); return; }
      const snapshotId = Number(payload.snapshotId);
      const maxAgeHours = Number(payload.maxAgeHours);
      respond(200, startGmgnStatsFetch(database, {
        limit,
        snapshotId: Number.isInteger(snapshotId) && snapshotId > 0 ? snapshotId : undefined,
        maxAgeHours: Number.isFinite(maxAgeHours) && maxAgeHours > 0 ? maxAgeHours : undefined,
      }));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/stats/status') {
      respond(200, readGmgnStatsFetchStatus());
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/copytrade/stats/stop') {
      respond(200, stopGmgnStatsFetch());
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/stats') {
      const limitParam = Number(requestUrl.searchParams.get('limit') ?? '25');
      const limit = Number.isInteger(limitParam) && limitParam > 0 ? limitParam : 25;
      const snapshotParam = Number(requestUrl.searchParams.get('snapshotId') ?? '');
      const snapshotId = Number.isInteger(snapshotParam) && snapshotParam > 0 ? snapshotParam : undefined;
      const roster = listRosterWallets(database, { chain: 'sol', limit, snapshotId });
      const addresses = roster.map((wallet) => wallet.walletAddress);
      const stats = addresses.length === 0 ? [] : database.prepare(
        `SELECT wallet_address AS walletAddress, period, fetched_at AS fetchedAt, raw_payload AS rawPayload
         FROM copytrade_wallet_stats WHERE chain = ? AND wallet_address IN (${addresses.map(() => '?').join(',')})
         ORDER BY wallet_address, period`,
      ).all('sol', ...addresses) as unknown as Array<{ walletAddress: string; period: string; fetchedAt: string; rawPayload: string }>;
      const snapshotRow = snapshotId
        ? database.prepare(`SELECT raw_payload AS rawPayload FROM gmgn_wallet_rank_snapshots WHERE id = ?`).get(snapshotId) as { rawPayload: string } | undefined
        : database.prepare(`SELECT raw_payload AS rawPayload FROM gmgn_wallet_rank_snapshots ORDER BY id DESC LIMIT 1`).get() as { rawPayload: string } | undefined;
      const leaderboard = new Map<string, { pnl1d: unknown; pnl7d: unknown; pnl30d: unknown; dailyProfit7d: unknown }>();
      try {
        const parsed = JSON.parse(snapshotRow?.rawPayload ?? '{}') as { data?: unknown; rank?: unknown; list?: unknown };
        const data = parsed.data;
        const candidateRank = Array.isArray(data)
          ? data
          : data && typeof data === 'object' && !Array.isArray(data)
            ? ((data as { rank?: unknown; list?: unknown }).rank ?? (data as { rank?: unknown; list?: unknown }).list)
            : (parsed.rank ?? parsed.list);
        const rank = Array.isArray(candidateRank) ? candidateRank : [];
        for (const item of rank) {
          if (!item || typeof item !== 'object') continue;
          const record = item as Record<string, unknown>;
          const address = typeof record.wallet_address === 'string' ? record.wallet_address : typeof record.address === 'string' ? record.address : null;
          if (address) leaderboard.set(address, { pnl1d: record.pnl_1d ?? null, pnl7d: record.pnl_7d ?? null, pnl30d: record.pnl_30d ?? null, dailyProfit7d: record.daily_profit_7d ?? null });
        }
      } catch { /* malformed historical leaderboard payload remains preserved, but contributes no derived metrics */ }
      respond(200, { roster, stats, leaderboard: Object.fromEntries([...leaderboard.entries()].filter(([address]) => addresses.includes(address))) });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/copytrade/import-browser-activity') {
      const payload = await readJsonBody(request) as { name?: unknown; content?: unknown };
      if (typeof payload.content !== 'string') { respond(400, { error: 'Upload must include a text content field.' }); return; }
      try {
        respond(200, importBrowserWalletActivity(database, typeof payload.name === 'string' ? payload.name : 'gmgn-investigation.json', payload.content));
      } catch (error) {
        respond(400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/fetch/status') {
      respond(200, readFetchRunState(database));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/fetch/estimate') {
      const limitParam = Number(requestUrl.searchParams.get('limit') ?? '');
      const limit = Number.isInteger(limitParam) && limitParam > 0 ? limitParam : 25;
      const periodParam = Number(requestUrl.searchParams.get('periodDays') ?? '');
      const periodDays = Number.isInteger(periodParam) && periodParam > 0 ? periodParam : 30;
      respond(200, projectFetchDuration(database, { limit, periodDays }));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/capture-health') {
      respond(200, readCaptureHealth(database));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/rosters') {
      const snapshots = listLeaderboardSnapshotStatuses(database);
      const health = readCaptureHealth(database);
      respond(200, {
        selectedByDefault: health.latestProvenancedSnapshotId ?? health.latestSnapshotId,
        snapshots,
      });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/copytrade/roster/sync') {
      const payload = await readJsonBody(request).catch(() => ({})) as { limit?: unknown };
      const limit = Number(payload.limit);
      const result = syncCopyTradeRoster(database, {
        chain: 'sol',
        limit: Number.isInteger(limit) && limit > 0 ? limit : undefined,
      });
      respond(200, result);
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/copytrade/roster/import') {
      const payload = await readJsonBody(request) as { name?: unknown; content?: unknown };
      if (typeof payload.content !== 'string' || payload.content.trim().length === 0) { respond(400, { error: 'A non-empty roster JSON file is required.' }); return; }
      try {
        const imported = importWalletRankSnapshot(database, JSON.parse(payload.content));
        const roster = syncCopyTradeRoster(database, { chain: 'sol', limit: 100 });
        respond(200, { ...imported, roster, sourceName: typeof payload.name === 'string' ? payload.name : 'roster.json' });
      } catch (error) {
        respond(400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/copytrade/roster/refresh') {
      const payload = await readJsonBody(request).catch(() => ({})) as { limit?: unknown; orderby?: unknown; minWinrate30d?: unknown; useSavedSnapshot?: unknown };
      const limit = Number(payload.limit);
      const orderby = RESEARCH_RANK_ORDERBY;
      const minWinrate30d = RESEARCH_RANK_MIN_WINRATE_30D;
      try {
        const refreshed = await refreshCurrentWalletRank(database, {
          limit: Number.isInteger(limit) && limit > 0 ? limit : 100,
          chain: 'sol', orderby, minWinrate30d, useSavedSnapshot: payload.useSavedSnapshot === true,
        });
        const roster = syncCopyTradeRoster(database, { chain: 'sol', limit: Number.isInteger(limit) && limit > 0 ? limit : 100 });
        respond(200, { ...refreshed, roster, researchFilter: { orderby, minWinrate30d } });
      } catch (error) {
        respond(502, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/copytrade/icons/fetch') {
      respond(200, { directory: walletIconDirectory, ...(await downloadRosterIcons(database)) });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/roster/compare') {
      respond(200, compareLatestRosterSnapshots(database, { chain: 'sol', limit: 100 }));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/results') {
      const periodParam = Number(requestUrl.searchParams.get('periodDays') ?? '');
      const periodDays = Number.isInteger(periodParam) && periodParam > 0 ? periodParam : undefined;
      const limitParam = Number(requestUrl.searchParams.get('limit') ?? '');
      const traderLimit = Number.isInteger(limitParam) && limitParam > 0 ? limitParam : undefined;
      const snapshotParam = Number(requestUrl.searchParams.get('snapshotId') ?? '');
      const rosterSnapshotId = Number.isInteger(snapshotParam) && snapshotParam > 0 ? snapshotParam : undefined;
      // Bump when the report row contract changes. Otherwise a valid fingerprint can
      // resurrect an older persisted JSON report that lacks newly-added evidence fields.
      const key = `results-v3:${periodDays ?? 'default'}:${traderLimit ?? 'default'}:${rosterSnapshotId ?? 'latest'}`;
      respond(200, readCachedResearch(key, () => computeCopyTradeReport(database, { periodDays, traderLimit, rosterSnapshotId })));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/copytrade/results/snapshot') {
      // The snapshot must freeze the report the user is looking at, so it takes the same
      // parameters the results route does rather than recomputing under the defaults.
      const payload = (await readJsonBody(request)) as { periodDays?: unknown; limit?: unknown; snapshotId?: unknown };
      const periodDays = Number.isInteger(payload.periodDays) && Number(payload.periodDays) > 0 ? Number(payload.periodDays) : undefined;
      const traderLimit = Number.isInteger(payload.limit) && Number(payload.limit) > 0 ? Number(payload.limit) : undefined;
      const rosterSnapshotId = Number.isInteger(payload.snapshotId) && Number(payload.snapshotId) > 0 ? Number(payload.snapshotId) : undefined;
      respond(200, saveCopyTradeSnapshot(database, computeCopyTradeReport(database, { periodDays, traderLimit, rosterSnapshotId })));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/copytrade/trades/bulk') {
      const payload = await readJsonBody(request) as { walletAddresses?: unknown };
      const walletAddresses = Array.isArray(payload.walletAddresses)
        ? [...new Set(payload.walletAddresses.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean))]
        : [];
      if (walletAddresses.length === 0) { respond(400, { error: 'At least one wallet address is required.' }); return; }
      if (walletAddresses.length > 500) { respond(400, { error: 'A maximum of 500 wallet addresses can be requested.' }); return; }

      // Read-only history endpoint. It returns every locally stored row for each requested
      // wallet; no GMGN/Dune request is made and no rows are modified. Keeping the same
      // response shape as the single-wallet endpoint lets export consume one authoritative
      // stored-history representation.
      const placeholders = walletAddresses.map(() => '?').join(', ');
      const rows = database.prepare(
        `SELECT id, wallet_address AS walletAddress, chain, tx_hash AS txHash,
                event_type AS eventType, token_address AS tokenAddress,
                token_symbol AS tokenSymbol, observed_timestamp AS observedTimestamp,
                token_amount AS tokenAmount, cost_usd AS costUsd,
                buy_cost_usd AS buyCostUsd, price_usd AS priceUsd,
                gas_usd AS gasUsd, dex_usd AS dexUsd,
                launchpad_platform AS launchpadPlatform, fetched_at AS fetchedAt
         FROM copytrade_trades
         WHERE wallet_address IN (${placeholders}) AND chain = 'sol'
         ORDER BY wallet_address, observed_timestamp DESC, id DESC`,
      ).all(...walletAddresses) as Array<Record<string, unknown>>;
      const coverageRows = database.prepare(
        `SELECT wallet_address AS walletAddress, requests_used AS requestsUsed,
                requested_period_days AS periodDays, truncated,
                stop_reason AS stopReason, updated_at AS updatedAt,
                resume_cursor AS resumeCursor
         FROM copytrade_wallet_coverage
         WHERE wallet_address IN (${placeholders}) AND chain = 'sol'`,
      ).all(...walletAddresses) as Array<Record<string, unknown>>;
      const rowsByWallet = new Map<string, Array<Record<string, unknown>>>();
      for (const row of rows) {
        const walletAddress = String(row.walletAddress);
        const walletRows = rowsByWallet.get(walletAddress) ?? [];
        walletRows.push(row);
        rowsByWallet.set(walletAddress, walletRows);
      }
      const coverageByWallet = new Map(coverageRows.map((row) => [String(row.walletAddress), row]));
      respond(200, {
        histories: walletAddresses.map((walletAddress) => ({
          walletAddress,
          chain: 'sol',
          total: rowsByWallet.get(walletAddress)?.length ?? 0,
          rows: rowsByWallet.get(walletAddress) ?? [],
          coverage: coverageByWallet.get(walletAddress) ?? null,
        })),
      });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname.startsWith('/api/copytrade/trades/')) {
      const walletAddress = decodeURIComponent(requestUrl.pathname.slice('/api/copytrade/trades/'.length)).trim();
      if (!walletAddress) { respond(400, { error: 'Wallet address is required.' }); return; }
      // Read-only history endpoint. It returns every locally stored row for this wallet;
      // no GMGN/Dune request is made and no rows are modified. The fetch layer may have
      // stopped at a provider/page/daily cap, so callers must treat this as full *stored*
      // history rather than proof that the provider returned a complete lifetime feed.
      const rows = database.prepare(
        `SELECT id, wallet_address AS walletAddress, chain, tx_hash AS txHash,
                event_type AS eventType, token_address AS tokenAddress,
                token_symbol AS tokenSymbol, observed_timestamp AS observedTimestamp,
                token_amount AS tokenAmount, cost_usd AS costUsd,
                buy_cost_usd AS buyCostUsd, price_usd AS priceUsd,
                gas_usd AS gasUsd, dex_usd AS dexUsd,
                launchpad_platform AS launchpadPlatform, fetched_at AS fetchedAt
         FROM copytrade_trades
         WHERE wallet_address = ? AND chain = 'sol'
         ORDER BY observed_timestamp DESC, id DESC`,
      ).all(walletAddress) as Array<Record<string, unknown>>;
      const coverage = database.prepare(
        `SELECT requests_used AS requestsUsed, requested_period_days AS periodDays,
                truncated, stop_reason AS stopReason, updated_at AS updatedAt,
                resume_cursor AS resumeCursor
         FROM copytrade_wallet_coverage
         WHERE wallet_address = ? AND chain = 'sol'
         LIMIT 1`,
      ).get(walletAddress) as Record<string, unknown> | undefined;
      respond(200, {
        walletAddress,
        chain: 'sol',
        total: rows.length,
        rows,
        coverage: coverage ?? null,
      });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/historical-consistency') {
      const limitParam = Number(requestUrl.searchParams.get('limit') ?? '25');
      const limit = Number.isInteger(limitParam) && limitParam > 0 ? limitParam : 25;
      const snapshotParam = Number(requestUrl.searchParams.get('snapshotId') ?? '');
      const rosterSnapshotId = Number.isInteger(snapshotParam) && snapshotParam > 0 ? snapshotParam : undefined;
      const key = `historical:${limit}:${rosterSnapshotId ?? 'latest'}`;
      respond(200, readCachedResearch(key, () => {
        const { roster, computed } = readHistoricalConsistencyForRoster(database, limit, rosterSnapshotId);
        const rosterByAddress = new Map(roster.map((wallet) => [wallet.walletAddress, wallet]));
        return {
          ...computed,
          rows: computed.rows.map((row) => {
            const wallet = rosterByAddress.get(row.walletAddress);
            return {
              ...row,
              name: wallet?.name ?? null,
              rankPosition: wallet?.rankPosition ?? null,
              riskFlags: wallet?.riskFlags ?? [],
            };
          }),
          scope: { chain: 'sol', traderLimit: limit, rosterSize: roster.length, rosterSnapshotId: rosterSnapshotId ?? null },
        };
      }));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/winners') {
      const limitParam = Number(requestUrl.searchParams.get('limit') ?? '25');
      const limit = Number.isInteger(limitParam) && limitParam > 0 ? limitParam : 25;
      const snapshotParam = Number(requestUrl.searchParams.get('snapshotId') ?? '');
      const rosterSnapshotId = Number.isInteger(snapshotParam) && snapshotParam > 0 ? snapshotParam : undefined;
      // 90 days: the copy-viability gates (hold time, concentration, fast-round-trip) and the
      // historical-consistency check both want the deepest available history, not the app's
      // general-purpose default period used elsewhere.
      const screenReport = computeCopyTradeReport(database, { periodDays: 90, traderLimit: limit, rosterSnapshotId });
      const { computed: historicalConsistency } = readHistoricalConsistencyForRoster(database, limit, rosterSnapshotId);
      respond(200, computeCopyCandidates(screenReport, historicalConsistency, readCopySimulationSurvivalMap(database, screenReport, historicalConsistency)));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/elimination') {
      // Runs against the whole cohort, not just current screen-pass candidates — the point is
      // to decide which wallets still deserve further Dune investment before they ever reach
      // the candidate gates, not to re-rank wallets that already passed them.
      const limitParam = Number(requestUrl.searchParams.get('limit') ?? '100');
      const limit = Number.isInteger(limitParam) && limitParam > 0 ? limitParam : 100;
      const snapshotParam = Number(requestUrl.searchParams.get('snapshotId') ?? '');
      const rosterSnapshotId = Number.isInteger(snapshotParam) && snapshotParam > 0 ? snapshotParam : undefined;
      // ONE window for every input to the verdict, and it is 30 days because the GMGN
      // realized-PnL snapshot this view eliminates on is only published as a rolling 7d/30d
      // figure — GMGN exposes no arbitrary date range. That number is therefore fixed at 30d
      // and cannot be widened, so every other input is narrowed to meet it rather than left
      // wider. A previous version scored trades and the copy test over 90 days against that
      // same 30-day PnL, which compared different spans of the wallet's life inside a single
      // verdict.
      //
      // Passing this to the simulation explicitly is required, not cosmetic: readRecentRoundTrips
      // treats an omitted periodDays as "no cutoff at all", which silently scored Dune results
      // over the wallet's ENTIRE stored history. Measured on the live cohort, that mismatch
      // flipped 100%-coverage status for 10 of 100 wallets and the simulated-median sign for 2.
      //
      // Deliberately NOT matched to /api/copytrade/winners' 90 days: that endpoint wants the
      // deepest history for its copy-viability gates and has no 30-day-only input to reconcile
      // with. Different question, different window — the two are not required to agree.
      const ELIMINATION_PERIOD_DAYS = 30;
      const screenReport = computeCopyTradeReport(database, { periodDays: ELIMINATION_PERIOD_DAYS, traderLimit: limit, rosterSnapshotId });
      const walletAddresses = screenReport.rows.map((row) => row.walletAddress);
      const simReport = walletAddresses.length
        ? computeCopySimulationReport(database, { walletAddresses, periodDays: ELIMINATION_PERIOD_DAYS })
        : { wallets: [] };
      const simulationByWallet = new Map(simReport.wallets.map((wallet) => [wallet.walletAddress, wallet]));
      const eliminationReport = computeEliminationReport(screenReport.rows, simulationByWallet);
      const duneEstimate = estimateDuneRefetchDuration(database, eliminationReport.measuredDuneTargetsRemaining);
      respond(200, { ...eliminationReport, duneEstimate, periodDays: ELIMINATION_PERIOD_DAYS });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/copytrade/winners/fetch') {
      // Dynamically scoped to whoever currently qualifies as a Winner at request time — never a
      // frozen list. Reuses the exact same fetch loop as the discovery fetch above (resume-cursor,
      // daily cap, etc.), just pointed at these specific wallet addresses instead of the top-N
      // roster, so it only ever pulls what's missing since each wallet's own last fetch.
      const snapshotParam = Number(requestUrl.searchParams.get('snapshotId') ?? '');
      const rosterSnapshotId = Number.isInteger(snapshotParam) && snapshotParam > 0 ? snapshotParam : undefined;
      const screenReport = computeCopyTradeReport(database, { periodDays: 90, traderLimit: 25, rosterSnapshotId });
      const { computed: historicalConsistency } = readHistoricalConsistencyForRoster(database, 25, rosterSnapshotId);
      const walletAddresses = computeCopyCandidates(
        screenReport, historicalConsistency, readCopySimulationSurvivalMap(database, screenReport, historicalConsistency),
      ).candidates.map((candidate) => candidate.walletAddress);
      if (!walletAddresses.length) { respond(400, { error: 'No current Winners to fetch trades for.' }); return; }
      if (hasActiveFetchRun(database)) { respond(409, { error: 'A fetch run is already in progress.' }); return; }
      respond(200, startCopyTradeFetch(database, { limit: walletAddresses.length, periodDays: 90, walletAddresses, scope: 'winners' }));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/scrutiny') {
      // Read-only over data /api/copytrade/winners already computes — no new gate, no re-ranking.
      // Bounded at the 100-wallet GMGN cohort size; Scrutiny now mirrors the full Wallet Stats table.
      const requestedWallets = [...new Set((requestUrl.searchParams.get('wallets') ?? '').split(',').map((value) => value.trim()).filter(Boolean))];
      if (!requestedWallets.length) { respond(400, { error: 'wallets must be a non-empty comma-separated list of wallet addresses.' }); return; }
      const snapshotParam = Number(requestUrl.searchParams.get('snapshotId') ?? '');
      const rosterSnapshotId = Number.isInteger(snapshotParam) && snapshotParam > 0 ? snapshotParam : undefined;
      // 30 days, not 90: a deliberate cost tradeoff (matches the 30-day window the GMGN
      // wallet-stats decision table already uses) — fetching a full 90 days of history for every
      // pinned wallet is expensive, and Scrutiny should work with whatever's already fetched.
      const scopePeriodDays = 30;
      // Unlike /winners (a ranked top-N view), Scrutiny interrogates whatever wallet the reader
      // pinned or typed in — it must not silently drop a wallet just because it fell outside a
      // top-25 rank cutoff. SCRUTINY_ROSTER_LIMIT covers the full roster (well above its current
      // ~113-wallet size) while still bounding the underlying query.
      const key = `scrutiny:${scopePeriodDays}:${rosterSnapshotId ?? 'latest'}:${[...requestedWallets].sort().join(',')}`;
      respond(200, readCachedResearch(key, () => {
        const screenReport = computeCopyTradeReport(database, { periodDays: scopePeriodDays, traderLimit: SCRUTINY_ROSTER_LIMIT, rosterSnapshotId });
        const { computed: historicalConsistency } = readHistoricalConsistencyForRoster(database, SCRUTINY_ROSTER_LIMIT, rosterSnapshotId);
        const winners = computeCopyCandidates(screenReport, historicalConsistency, readCopySimulationSurvivalMap(database, screenReport, historicalConsistency));
        const candidateCount = new Set([
          ...winners.candidates.map((c) => c.walletAddress),
          ...winners.highUpsideCandidates.map((c) => c.walletAddress),
        ]).size;
        const rowsByWallet = new Map(screenReport.rows.map((row) => [row.walletAddress, row]));
        const reports = computeCandidateScrutinyBatch(database, requestedWallets, {
          rowsByWallet, candidateCount, screenedCount: screenReport.rows.length, scopePeriodDays,
        });
        const missingWallets = requestedWallets.filter((address) => !rowsByWallet.has(address));
        return { reports, cappedAt: MAX_SCRUTINY_WALLETS, requested: requestedWallets.length, missingWallets };
      }));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/experimental-decision') {
      const limitRaw = Number(requestUrl.searchParams.get('limit') ?? '100');
      const snapshotRaw = Number(requestUrl.searchParams.get('snapshotId') ?? '');
      const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, Math.floor(limitRaw))) : 100;
      const rosterSnapshotId = Number.isInteger(snapshotRaw) && snapshotRaw > 0 ? snapshotRaw : undefined;
      // This endpoint is intentionally not wired to any fetch runner. It only computes a
      // separately named experiment from saved SQLite evidence and cannot spend provider credits.
      respond(200, readCachedResearch(`experimental-decision-v4:${limit}:${rosterSnapshotId ?? 'latest'}`, () => computeExperimentalDecisionReport(database, { limit, rosterSnapshotId })));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/copytrade/scrutiny/refresh-trades') {
      // Scoped re-fetch for the pinned candidates only — same startCopyTradeFetch call and the
      // same 'single' scope as POST /api/copytrade/fetch/single above, just for several wallets
      // at once instead of one resolved-by-name wallet. Goes through the same GMGN request gate
      // (src/gmgn/rateLimit.ts) as every other fetch; no new concurrency.
      const payload = (await readJsonBody(request)) as { walletAddresses?: unknown; periodDays?: unknown };
      const walletAddresses = Array.isArray(payload.walletAddresses)
        ? [...new Set(payload.walletAddresses.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))]
        : [];
      if (!walletAddresses.length) { respond(400, { error: 'walletAddresses must be a non-empty array of wallet addresses.' }); return; }
      if (walletAddresses.length > MAX_SCRUTINY_WALLETS) { respond(400, { error: `At most ${MAX_SCRUTINY_WALLETS} wallets can be refreshed at once.` }); return; }
      const periodDaysRaw = Number(payload.periodDays);
      // Default matches the 30-day Scrutiny scoring window (see /api/copytrade/scrutiny's own
      // comment) rather than the 90-day default used elsewhere — fetching 90 days for every
      // pinned wallet on every refresh is expensive and not what Scrutiny actually scores against.
      const periodDays = Number.isInteger(periodDaysRaw) && periodDaysRaw > 0 && periodDaysRaw <= 365 ? periodDaysRaw : 30;
      if (hasActiveFetchRun(database)) { respond(409, { error: 'A fetch run is already in progress.' }); return; }
      respond(200, startCopyTradeFetch(database, { limit: walletAddresses.length, periodDays, walletAddresses, scope: 'single' }));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/copytrade/scrutiny/gmgn-risk') {
      const payload = (await readJsonBody(request)) as { walletAddresses?: unknown; periods?: unknown };
      const walletAddresses = Array.isArray(payload.walletAddresses)
        ? [...new Set(payload.walletAddresses.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))]
        : [];
      // Scrutiny is a 30-day decision surface. Keep this endpoint single-period so it cannot
      // accidentally fan out into redundant 7d/all-time requests.
      const periods = ['30d'];
      if (!walletAddresses.length) { respond(400, { error: 'walletAddresses must be a non-empty array of wallet addresses.' }); return; }
      if (walletAddresses.length > MAX_SCRUTINY_WALLETS) { respond(400, { error: `At most ${MAX_SCRUTINY_WALLETS} wallets can be requested at once.` }); return; }
      const results: Array<Record<string, unknown>> = [];
      for (const walletAddress of walletAddresses) {
        for (const period of periods) {
          const endpoint = `https://gmgn.ai/pf/api/v1/wallet/sol/${encodeURIComponent(walletAddress)}/profit_stat/${period}`;
          try {
            await waitForGmgnRequest();
            const response = await fetch(endpoint, {
              headers: {
                accept: 'application/json',
                'user-agent': process.env.GMGN_USER_AGENT ?? 'Mozilla/5.0',
                ...(process.env.GMGN_COOKIE ? { cookie: process.env.GMGN_COOKIE } : {}),
                ...(process.env.GMGN_API_KEY ? { 'x-api-key': process.env.GMGN_API_KEY } : {}),
              }, signal: AbortSignal.timeout(30_000),
            });
            const text = await response.text();
            if (!response.ok) throw new Error(`GMGN returned HTTP ${response.status}`);
            let parsed: unknown;
            try { parsed = JSON.parse(text); } catch { throw new Error('GMGN returned non-JSON data (browser session or Cloudflare may be required).'); }
            results.push({ walletAddress, period, available: true, metrics: normalizeGmgnProfitStat(parsed) });
          } catch (error: unknown) {
            results.push({ walletAddress, period, available: false, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      const savedResults = results.map((result) => saveGmgnRiskResult(database, {
        walletAddress: String(result.walletAddress), period: '30d', available: result.available === true,
        metrics: result.metrics, error: typeof result.error === 'string' ? result.error : undefined,
      }));
      logDiagnostic(database, { level: savedResults.some((result) => !result.available) ? 'warn' : 'info', event: 'scrutiny_gmgn_risk_fetch', method: request.method, path: requestUrl.pathname, status: 200, message: 'Fetched and persisted Scrutiny GMGN 30d risk details.', detail: { requestedWallets: walletAddresses.length, saved: savedResults.filter((result) => result.available).length, failed: savedResults.filter((result) => !result.available).length } });
      respond(200, { results: savedResults, requestedWallets: walletAddresses.length, requestedPeriods: periods });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/copytrade/scrutiny/gmgn-risk/import') {
      const payload = (await readJsonBody(request)) as { results?: unknown };
      const imported = Array.isArray(payload.results) ? payload.results : [];
      let ignored = 0;
      const savedResults = imported.flatMap((value) => {
        const result = asRecord(value);
        const walletAddress = typeof result.walletAddress === 'string' ? result.walletAddress.trim() : '';
        if (!walletAddress || result.period !== '30d' || result.available !== true || !('metrics' in result)) { ignored += 1; return []; }
        return [saveGmgnRiskResult(database, { walletAddress, period: '30d', available: true, metrics: normalizeGmgnProfitStat(result.metrics) })];
      });
      respond(200, { results: savedResults, imported: savedResults.length, ignored });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/scrutiny/gmgn-risk') {
      const walletAddresses = [...new Set((requestUrl.searchParams.get('wallets') ?? '').split(',').map((value) => value.trim()).filter(Boolean))];
      respond(200, { results: readGmgnRiskResults(database, walletAddresses), requestedWallets: walletAddresses.length, requestedPeriods: ['30d'] });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/copy-simulation') {
      const snapshotParam = Number(requestUrl.searchParams.get('snapshotId') ?? '');
      const rosterSnapshotId = Number.isInteger(snapshotParam) && snapshotParam > 0 ? snapshotParam : undefined;
      const requestedWallets = (requestUrl.searchParams.get('walletAddresses') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
      let walletAddresses: string[];
      if (requestedWallets.length > 0) {
        walletAddresses = [...new Set(requestedWallets)];
      } else {
        const screenReport = computeCopyTradeReport(database, { periodDays: 90, traderLimit: 25, rosterSnapshotId });
        const { computed: historicalConsistency } = readHistoricalConsistencyForRoster(database, 25, rosterSnapshotId);
        walletAddresses = copySimulationWalletAddresses(screenReport, historicalConsistency);
      }
      const periodRaw = requestUrl.searchParams.get('periodDays');
      const periodParam = Number(periodRaw ?? '');
      const periodDays = periodRaw !== null && Number.isFinite(periodParam) && periodParam > 0 ? Math.min(90, Math.floor(periodParam)) : undefined;
      const cacheKey = copySimulationCacheKey(walletAddresses, periodDays);
      respond(200, readCachedResearch(cacheKey, () => computeCopySimulationReport(database, { walletAddresses, ...(periodDays ? { periodDays } : {}) })));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/liquidity-impact') {
      // Same wallet scope as /api/copytrade/copy-simulation above (every screen-pass candidate,
      // not just final Winners) — the liquidity-band breakdown re-slices the exact same
      // already-computed simulation results, never a separate query or a different population.
      const snapshotParam = Number(requestUrl.searchParams.get('snapshotId') ?? '');
      const rosterSnapshotId = Number.isInteger(snapshotParam) && snapshotParam > 0 ? snapshotParam : undefined;
      const periodParam = Number(requestUrl.searchParams.get('periodDays') ?? '30');
      const periodDays = Number.isInteger(periodParam) && periodParam > 0 && periodParam <= 90 ? periodParam : 30;
      const screenReport = computeCopyTradeReport(database, { periodDays: 90, traderLimit: 25, rosterSnapshotId });
      const { computed: historicalConsistency } = readHistoricalConsistencyForRoster(database, 25, rosterSnapshotId);
      const walletAddresses = copySimulationWalletAddresses(screenReport, historicalConsistency);
      const simReport = computeCopySimulationReport(database, { walletAddresses, periodDays });
      respond(200, computeLiquidityImpactReport(simReport));
      return;
    }
    if (request.method === 'POST' && (requestUrl.pathname === '/api/copytrade/copy-simulation/run' || requestUrl.pathname === '/api/copytrade/copy-simulation/wide-retry')) {
      if (copySimulationRunState.running) { respond(409, { error: 'A copy simulation is already running.' }); return; }
      // Scoped to every wallet that still needs copy-survival verification — the wallets that
      // already pass every other gate (screen, historical consistency, hold time,
      // fast-round-trip, concentration) — not just whoever is already a final Winner. A wallet
      // can only ever earn its first simulation this way; scoping to final Winners instead would
      // be circular, since copy-survival is itself one of the gates that makes a Winner.
      //
      // An explicit `walletAddresses` body overrides that default scope. Research questions
      // legitimately need a different wallet set than the pipeline's own candidates — e.g. a
      // retrospective out-of-sample test selects wallets by a rule of its own (positive
      // pre-cutoff median) and then needs copier numbers for exactly those, several of which
      // fail the live gates by design. The simulation itself is read-only and identical either
      // way; only which wallets it covers changes.
      const wideRetry = requestUrl.pathname.endsWith('/wide-retry');
      const body = request.headers['content-length'] && request.headers['content-length'] !== '0'
        ? (await readJsonBody(request)) as { walletAddresses?: unknown; periodDays?: unknown; searchWindowMinutes?: unknown }
        : {};
      const requested = Array.isArray(body.walletAddresses)
        ? body.walletAddresses.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : null;
      if (requested !== null && requested.length === 0) { respond(400, { error: 'walletAddresses must be a non-empty array of wallet addresses when provided.' }); return; }
      // This endpoint powers the 30-day decision view. Never let an omitted period
      // silently expand the Dune queue to all locally stored history: that made the
      // UI's small missing-target estimate disagree with the actual submitted work.
      const requestedPeriod = typeof body.periodDays === 'number' && Number.isFinite(body.periodDays) ? Math.floor(body.periodDays) : 30;
      // The decision tab is exclusively 30-day now. Rejecting other horizons is deliberate:
      // silently accepting an omitted or different period makes the displayed estimate and the
      // actual Dune queue answer different questions.
      if (requestedPeriod !== 30) { respond(400, { error: 'Dune copy simulation is fixed to the 30-day decision period.' }); return; }
      const periodDays = 30;
      const requestedSearchWindow = typeof body.searchWindowMinutes === 'number' && Number.isFinite(body.searchWindowMinutes)
        ? Math.floor(body.searchWindowMinutes) : 120;
      const searchWindowMinutes = wideRetry && [15, 30, 60, 120].includes(requestedSearchWindow) ? requestedSearchWindow : wideRetry ? 120 : undefined;

      let walletAddresses: string[];
      if (requested) {
        walletAddresses = requested;
      } else {
        const snapshotParam = Number(requestUrl.searchParams.get('snapshotId') ?? '');
        const rosterSnapshotId = Number.isInteger(snapshotParam) && snapshotParam > 0 ? snapshotParam : undefined;
        const screenReport = computeCopyTradeReport(database, { periodDays: 90, traderLimit: 25, rosterSnapshotId });
        const { computed: historicalConsistency } = readHistoricalConsistencyForRoster(database, 25, rosterSnapshotId);
        walletAddresses = copySimulationWalletAddresses(screenReport, historicalConsistency);
        if (!walletAddresses.length) { respond(400, { error: 'No candidates pass the other gates yet — nothing to simulate.' }); return; }
      }
      const auditRequestedAt = new Date().toISOString();
      const auditInsert = database.prepare(`INSERT INTO copytrade_dune_fetch_audits
        (requested_at, mode, wallet_count, wallet_addresses, status)
        VALUES (?, ?, ?, ?, 'running')`).run(
        auditRequestedAt, wideRetry ? 'wide_retry' : 'precise', walletAddresses.length, JSON.stringify(walletAddresses),
      );
      const auditId = Number(auditInsert.lastInsertRowid);
      try {
        // Runs to completion for the current candidate scope in one call (see
        // runCopySimulationBatch's own comment) — the UI should never need to click this
        // repeatedly.
        copySimulationRunState = { ...idleCopySimulationRunState, mode: wideRetry ? 'wide_retry' : 'precise', running: true, outcome: 'running', message: wideRetry ? 'Planning wider-window retry…' : 'Planning…', startedAt: new Date().toISOString() };
        const result = await runCopySimulationBatch(database, {
          walletAddresses,
          periodDays,
          retryNoMatch: wideRetry,
            searchWindowMinutes,
          shouldStop: () => copySimulationRunState.cancelRequested,
          onPlan: (plan) => {
            database.prepare('UPDATE copytrade_dune_fetch_audits SET planned_targets = ? WHERE id = ?').run(plan.targetsTotal, auditId);
            copySimulationRunState = {
              ...copySimulationRunState, ...plan, remainingTargets: plan.targetsTotal,
              retryableTargetsRemaining: wideRetry ? plan.retryableTargetsBefore : null,
              message: plan.targetsTotal
                ? `Planned ${plan.targetsTotal} targets across ${plan.batchesTotal} Dune ${plan.batchesTotal === 1 ? 'query' : 'queries'}`
                : wideRetry ? 'No more wider retries available — every precise no-match has already had one wider attempt.' : 'Nothing new to fetch — every target in scope already has Dune data',
            };
          },
          onBatchStart: (progress) => {
            copySimulationBatchStartedAt = Date.now();
            copySimulationRunState = {
              ...copySimulationRunState, ...progress,
              batches: [...copySimulationRunState.batches, { batch: progress.currentBatch, targets: progress.batchTargets, status: 'running', seconds: null, error: null }],
              message: `Dune query ${progress.currentBatch} of ${progress.batchesTotal} — ${progress.batchTargets} targets (can take seconds or many minutes)`,
              duneExecutionId: null, duneState: 'SUBMITTING', dunePollCount: 0, duneElapsedSeconds: 0,
              duneIsExecutionFinished: false, duneExecutionCostCredits: null, duneLastStatusAt: new Date().toISOString(),
              duneRequestPhase: 'idle', duneLastHttpStatus: null, duneLastRequestMs: null, duneLastPayload: null,
            };
          },
          onDuneStatus: (status: DunePollUpdate) => {
            copySimulationRunState = {
              ...copySimulationRunState,
              duneExecutionId: status.executionId, duneState: status.state, dunePollCount: status.pollCount,
              duneElapsedSeconds: status.elapsedSeconds, duneIsExecutionFinished: status.isExecutionFinished,
              duneExecutionCostCredits: status.executionCostCredits, duneLastStatusAt: new Date().toISOString(),
              duneRequestPhase: status.requestPhase, duneLastHttpStatus: status.statusHttpStatus, duneLastRequestMs: status.statusRequestMs, duneLastPayload: status.statusPayload,
              message: status.requestPhase === 'status_requesting' ? `Dune status request in flight · poll ${status.pollCount}`
                : status.requestPhase === 'results_requesting' ? 'Dune finished execution; downloading raw results'
                : status.requestPhase === 'results_received' ? 'Dune raw results received; saving response'
                : `Dune ${status.state.replace('QUERY_STATE_', '').toLowerCase()} · ${status.elapsedSeconds}s · poll ${status.pollCount}`,
            };
          },
          onBatchEnd: (outcome) => {
            // The batch's real failure reason (e.g. Dune's own error text) was previously only
            // ever caught and discarded here — `status='failed'` persisted with no message
            // anywhere retrievable, so diagnosing a real incident (an exhausted Dune billing
            // quota, confirmed live 2026-08-22) required manually reproducing the call by hand.
            if (outcome.error) {
              logDiagnostic(database, {
                level: 'error', event: 'dune-batch-failed',
                message: outcome.error,
                detail: { batch: outcome.currentBatch, batchTargets: outcome.batchTargets, wideRetry },
              });
            }
            const seconds = copySimulationBatchStartedAt ? Math.round((Date.now() - copySimulationBatchStartedAt) / 1000) : null;
            const batches = copySimulationRunState.batches.map((entry) => entry.batch === outcome.currentBatch && entry.status === 'running'
              ? { ...entry, status: outcome.error ? 'failed' as const : 'stored' as const, seconds, error: outcome.error }
              : entry);
            const storedTargets = batches.filter((b) => b.status === 'stored').reduce((sum, b) => sum + b.targets, 0);
            const failedTargets = batches.filter((b) => b.status === 'failed').reduce((sum, b) => sum + b.targets, 0);
            copySimulationRunState = {
              ...copySimulationRunState, batches, storedTargets, failedTargets,
              remainingTargets: Math.max(0, copySimulationRunState.targetsTotal - storedTargets - failedTargets),
            };
          },
          onProgress: (progress) => { copySimulationRunState = { ...copySimulationRunState, ...progress }; },
        });
        const { storedTargets, failedTargets } = copySimulationRunState;
        const remainingTargets = Math.max(0, result.targetsTotal - storedTargets - failedTargets);
        const outcome: CopySimulationRunState['outcome'] = result.cancelled ? 'stopped'
          : failedTargets > 0 ? 'partial'
          : remainingTargets > 0 ? 'partial'
          : 'complete';
        const message = result.targetsTotal === 0
          ? 'Nothing new to fetch — every target in scope already has Dune data'
          : outcome === 'stopped' ? `Stopped by you. ${storedTargets} targets stored, ${remainingTargets} left — click again to continue.`
          : outcome === 'partial' ? `${storedTargets} stored, ${failedTargets} failed, ${remainingTargets} left — click again to continue.`
          : `Complete. All ${storedTargets} targets stored.`;
        copySimulationRunState = {
          ...copySimulationRunState, running: false, outcome, remainingTargets,
          retryableTargetsBefore: result.retryableTargetsBefore,
          retryableTargetsRemaining: result.retryableTargetsRemaining,
          coverageBeforePercent: result.coverageBeforePercent,
          coverageAfterPercent: result.coverageAfterPercent,
          message: wideRetry && result.retryableTargetsRemaining === 0
            ? `No more wider retries available. Coverage ${result.coverageBeforePercent ?? '—'}% → ${result.coverageAfterPercent ?? '—'}%.`
            : message,
          finishedAt: new Date().toISOString(),
        };
        database.prepare(`UPDATE copytrade_dune_fetch_audits
          SET completed_at = ?, planned_targets = ?, submitted_targets = ?, stored_targets = ?,
              failed_targets = ?, remaining_targets = ?, status = ?, message = ?
          WHERE id = ?`).run(
          copySimulationRunState.finishedAt, result.targetsTotal, result.targetsSubmitted, storedTargets,
          failedTargets, remainingTargets, outcome, message, auditId,
        );
        respond(200, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const finishedAt = new Date().toISOString();
        copySimulationRunState = { ...copySimulationRunState, running: false, outcome: 'error', finishedAt, message };
        database.prepare(`UPDATE copytrade_dune_fetch_audits SET completed_at = ?, status = 'error', message = ? WHERE id = ?`).run(finishedAt, message, auditId);
        respond(502, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/copy-simulation/status') {
      const latestSavedRun = database.prepare(
        `SELECT id, status, requested_at AS requestedAt, completed_at AS completedAt,
                trade_refs AS tradeRefs, search_window_minutes AS searchWindowMinutes,
                match_source AS matchSource
         FROM copytrade_copy_simulation_runs ORDER BY id DESC LIMIT 1`,
      ).get() as { id: number; status: string; requestedAt: string; completedAt: string | null; tradeRefs: string; searchWindowMinutes: number; matchSource: string } | undefined;
      const savedTradeCount = latestSavedRun?.status === 'completed'
        ? (() => { try { const refs = JSON.parse(latestSavedRun.tradeRefs) as unknown; return Array.isArray(refs) ? refs.length : 0; } catch { return 0; } })()
        : 0;
      const latestAudit = database.prepare(`SELECT id, requested_at AS requestedAt, completed_at AS completedAt,
        mode, wallet_count AS walletCount, planned_targets AS plannedTargets, submitted_targets AS submittedTargets,
        stored_targets AS storedTargets, failed_targets AS failedTargets, remaining_targets AS remainingTargets,
        status, message FROM copytrade_dune_fetch_audits ORDER BY id DESC LIMIT 1`).get();
      respond(200, {
        ...copySimulationRunState,
        audit: latestAudit ?? null,
        persistedRun: latestSavedRun ? {
          id: latestSavedRun.id, status: latestSavedRun.status, requestedAt: latestSavedRun.requestedAt,
          completedAt: latestSavedRun.completedAt, storedTargets: savedTradeCount,
          searchWindowMinutes: latestSavedRun.searchWindowMinutes, matchSource: latestSavedRun.matchSource,
        } : null,
      });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/copy-simulation/dune-responses') {
      // Read-only evidence view. The raw Dune result is already persisted with each immutable
      // run; expose it here so the UI can show exactly what Dune returned without re-querying.
      const requestedLimit = Number(requestUrl.searchParams.get('limit') ?? '20');
      const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(50, requestedLimit)) : 20;
      const runs = database.prepare(
        `SELECT id, execution_id AS executionId, status, requested_at AS requestedAt,
                completed_at AS completedAt, archive_path AS archivePath,
                archive_sha256 AS archiveSha256, trade_refs AS tradeRefs, raw_result AS rawResult,
                search_window_minutes AS searchWindowMinutes, match_source AS matchSource
         FROM copytrade_copy_simulation_runs
         ORDER BY id DESC LIMIT ?`,
      ).all(limit) as unknown as Array<{
        id: number; executionId: string | null; status: string; requestedAt: string;
        completedAt: string | null; archivePath: string | null; archiveSha256: string | null;
        tradeRefs: string; rawResult: string | null; searchWindowMinutes: number; matchSource: string;
      }>;
      respond(200, runs.map((run) => {
        let tradeCount = 0;
        try { const refs = JSON.parse(run.tradeRefs) as unknown; tradeCount = Array.isArray(refs) ? refs.length : 0; } catch { /* retain evidence even if refs are malformed */ }
        return {
          id: run.id, executionId: run.executionId, status: run.status, requestedAt: run.requestedAt,
          completedAt: run.completedAt, tradeCount, archivePath: run.archivePath,
          archiveSha256: run.archiveSha256, rawResult: run.rawResult,
          searchWindowMinutes: run.searchWindowMinutes, matchSource: run.matchSource,
        };
      }));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/copytrade/copy-simulation/stop') {
      if (copySimulationRunState.running) copySimulationRunState = { ...copySimulationRunState, cancelRequested: true, message: 'Stop requested; waiting for the current Dune batch to finish…' };
      respond(200, copySimulationRunState);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/logs') {
      const limitParam = Number(requestUrl.searchParams.get('limit') ?? '100');
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 100;
      respond(200, readRecentDiagnostics(database, limit));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/gmgn/probe') {
      respond(200, await probeGmgn());
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/gmgn/capture') {
      respond(200, await captureGmgnSignals(database));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/gmgn/import-browser-capture') {
      const payload = await readJsonBody(request) as { name?: unknown; content?: unknown };
      if (typeof payload.content !== 'string') { respond(400, { error: 'Upload must include a text content field.' }); return; }
      respond(200, importGmgnBrowserCapture(database, typeof payload.name === 'string' ? payload.name : 'gmgn-browser-capture.json', payload.content));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/gmgn/archives') {
      respond(200, listGmgnArchives());
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/imports') {
      const rows = database.prepare(`
        SELECT id, source_path AS sourcePath, source_sha256 AS sourceSha256,
               status, imported_count AS imported, skipped_count AS skipped,
               error_count AS errors, imported_at AS importedAt,
               completed_at AS completedAt, archive_path AS archivePath,
               archived_at AS archivedAt
        FROM dune_import_batches ORDER BY id DESC LIMIT 25
      `).all();
      respond(200, rows);
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/import-dune') {
      const payload = await readJsonBody(request) as { name?: unknown; content?: unknown };
      const name = typeof payload.name === 'string' ? path.basename(payload.name) : 'dune-export.json';
      const content = typeof payload.content === 'string' ? payload.content : null;
      if (content === null) {
        respond(400, { error: 'Upload must include a text content field.' });
        return;
      }
      const summary = importDuneContent(database, `ui-upload/${name}`, content);
      let archivePath: string | null = null;
      let archiveSha256: string | null = null;
      if (!summary.duplicateFile) {
        const archived = archiveDuneSource({
          archiveDirectory: defaultArchivePath,
          batchId: summary.batchId,
          sourceName: name,
          sourceSha256: summary.sourceSha256,
          rawSource: content,
          summary,
          archivedAt: new Date().toISOString(),
        });
        archivePath = archived.archivePath;
        archiveSha256 = archived.archiveSha256;
        database.prepare(`
          UPDATE dune_import_batches
          SET archive_path = ?, archive_sha256 = ?, archived_at = ?
          WHERE id = ?
        `).run(archivePath, archiveSha256, new Date().toISOString(), summary.batchId);
      } else {
        const existing = database.prepare(`
          SELECT archive_path AS archivePath, archive_sha256 AS archiveSha256
          FROM dune_import_batches WHERE id = ?
        `).get(summary.batchId) as { archivePath: string | null; archiveSha256: string | null } | undefined;
        archivePath = existing?.archivePath ?? null;
        archiveSha256 = existing?.archiveSha256 ?? null;
      }
      respond(200, { ...summary, archivePath, archiveSha256 });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/gmgn/token-addresses') {
      respond(200, listGmgnTokenAddresses(database));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/import-dune-enrichment') {
      const payload = await readJsonBody(request) as { name?: unknown; content?: unknown };
      const name = typeof payload.name === 'string' ? path.basename(payload.name) : 'dune-enrichment.json';
      const content = typeof payload.content === 'string' ? payload.content : null;
      if (content === null) {
        respond(400, { error: 'Upload must include a text content field.' });
        return;
      }
      // Reuses the cohort importer unmodified (same field aliases, same audit trail, same
      // ON CONFLICT DO NOTHING so an address already in the cohort is never overwritten) but
      // tags rows as targeted enrichment so provenance stays distinguishable from the original
      // Dune cohort export.
      const summary = importDuneContent(database, `ui-upload/enrichment/${name}`, content, undefined, undefined, 'dune-targeted-enrichment');
      let archivePath: string | null = null;
      let archiveSha256: string | null = null;
      if (!summary.duplicateFile) {
        const archived = archiveDuneSource({
          archiveDirectory: path.join(defaultArchivePath, 'dune-enrichment'),
          batchId: summary.batchId,
          sourceName: name,
          sourceSha256: summary.sourceSha256,
          rawSource: content,
          summary,
          archivedAt: new Date().toISOString(),
        });
        archivePath = archived.archivePath;
        archiveSha256 = archived.archiveSha256;
        database.prepare(`
          UPDATE dune_import_batches
          SET archive_path = ?, archive_sha256 = ?, archived_at = ?
          WHERE id = ?
        `).run(archivePath, archiveSha256, new Date().toISOString(), summary.batchId);
      } else {
        const existing = database.prepare(`
          SELECT archive_path AS archivePath, archive_sha256 AS archiveSha256
          FROM dune_import_batches WHERE id = ?
        `).get(summary.batchId) as { archivePath: string | null; archiveSha256: string | null } | undefined;
        archivePath = existing?.archivePath ?? null;
        archiveSha256 = existing?.archiveSha256 ?? null;
      }
      respond(200, { ...summary, archivePath, archiveSha256 });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/gmgn') {
      const rawEvent = await readJsonBody(request);
      const stored = storeGmgnSignal(database, rawEvent);
      respond(201, stored);
      return;
    }
    if (request.method === 'GET') {
      responded = true;
      staticFile(requestUrl.pathname, response);
      return;
    }
    respond(405, { error: 'Method not allowed.' });
  } catch (error) {
    responded = true;
    const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
    logDiagnostic(database, {
      level: 'error',
      event: 'request-error',
      method: request.method ?? null,
      path: requestUrl.pathname,
      status: 400,
      durationMs: Date.now() - startedAt,
      requestBytes,
      message,
      detail: error instanceof Error ? { stack: error.stack } : undefined,
    });
    json(response, 400, { error: message });
  }
};

createServer((request, response) => { void handle(request, response); })
  .listen(port, () => console.log(`Crypto research UI: http://localhost:${port}`));
