import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { defaultArchivePath, openDatabase } from '../db/client.js';
import { readDatabaseStats } from '../db/stats.js';
import { readDataQuality } from '../db/quality.js';
import { readIntegrityReport } from '../db/integrity.js';
import { readSnapshotAnalysis } from '../db/analysis.js';
import { readSignalScoringReport } from '../db/scoring.js';
import { archiveDuneSource } from '../dune/archive.js';
import { importDuneContent } from '../dune/importer.js';
import { storeGmgnSignal } from '../gmgn/ingest.js';
import { listGmgnTokenAddresses } from '../gmgn/tokenAddresses.js';
import { readGmgnCredentialStatus } from '../gmgn/credentials.js';
import { probeGmgn } from '../gmgn/probe.js';
import { captureGmgnSignals } from '../gmgn/capture.js';
import { importGmgnBrowserCapture } from '../gmgn/browserImport.js';
import { listGmgnArchives } from '../gmgn/archives.js';
import { getGmgnWatchStatus, startGmgnWatch, stopGmgnWatch } from '../gmgn/watch.js';
import { RESEARCH_QUESTION } from '../research/question.js';
import { logDiagnostic, readRecentDiagnostics } from '../db/diagnostics.js';
import { redactSensitiveText } from '../security/redaction.js';
import { probeBirdeye } from '../birdeye/probe.js';
import { listOutcomeCandidates, measureSignalsOutcome } from '../birdeye/outcome.js';
import { measureDuneOutcomes, readAllDuneOutcomes, readLatestDuneOutcomes, reconcileStuckDuneRuns } from '../dune/outcomes.js';
import { buildMeasurementPlan } from '../dune/planner.js';
import { computeSignalPatternReport, computeSignalPatternSubgroupReport, listSignalPatternSnapshots, saveSignalPatternSnapshot, type SubgroupProperty } from '../db/patterns.js';
import { listRadarSnapshots, listWalletRankSnapshots, listSmartMoneyWalletStats, listTwitterMessages, readRawEndpointSummary } from '../gmgn/rawEndpointReads.js';
import { computeRobustPatternReport, type RobustPatternReport } from '../db/robustPatterns.js';
import { computeCopyTradeReport, readCopyTradeSummary, saveCopyTradeSnapshot } from '../copytrade/evaluate.js';
import { computeHistoricalConsistency } from '../copytrade/historicalConsistency.js';
import { computeCopyCandidates, computeScreenPassCandidates, type CopySimulationSurvivalInput } from '../copytrade/copyCandidates.js';
import { listLeaderboardSnapshotStatuses, listRosterWallets, readCaptureHealth, resolveSingleTrader } from '../copytrade/roster.js';
import { hasActiveFetchRun, readFetchRunState, reconcileStaleFetchRuns, requestCopyTradeFetchStop, startCopyTradeFetch } from '../copytrade/fetch.js';
import { projectFetchDuration } from '../copytrade/estimate.js';
import { evaluateExperiment, freezeExperiment, listExperiments } from '../copytrade/experiments.js';
import { computeCopySimulationReport, computeLiquidityImpactReport, runCopySimulationBatch } from '../copytrade/copySimulation.js';
import { importBrowserWalletActivity } from '../copytrade/browserActivityImport.js';
import {
  computeCallerCheckpointBreakdown, computeCallerEvaluationReport, hasActiveCollectionRun, readCallerDetail, readCollectionRunState,
  readLeaderboard, startCollectionRun, stopCollectionRuns, trackCaller, untrackCaller,
  LEADERBOARD_CAPTURE_COOLDOWN_MS, msSinceLastCollectionStart, reconcileOrphanedCollectionRuns, rearmPausedCollectionRuns, resumeCollectionRun,
  type CollectionKind,
} from '../copytrade/topCallers.js';

const database = openDatabase();
// A CopyTrade fetch only runs inside the process that started it, so anything still marked
// running at startup was orphaned by a restart and would otherwise latch the single-run guard.
reconcileStaleFetchRuns(database);
reconcileOrphanedCollectionRuns(database);
rearmPausedCollectionRuns(database);
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

// Disabled for now (kept in place, not removed): unattended continuous polling needs more
// runway on the manual one-off capture path first. /status and /stop stay live (harmless,
// idempotent) so the UI can still reflect state; only /start is blocked. Flip this back to
// true to re-enable — no other changes needed.
const GMGN_WATCH_MODE_ENABLED = false;

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
  const walletAddresses = computeScreenPassCandidates(screenReport, historicalConsistency).candidates.map((candidate) => candidate.walletAddress);
  if (!walletAddresses.length) return new Map();
  const simReport = computeCopySimulationReport(database, { walletAddresses });
  return new Map(simReport.wallets.map((wallet) => [wallet.walletAddress, {
    simulatedMedianReturnPercent: wallet.simulatedMedianReturnPercent,
    coverageRatePercent: wallet.coverageRatePercent,
  }]));
};

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
    if (request.method === 'POST' && requestUrl.pathname === '/api/birdeye/probe') {
      const payload = await readJsonBody(request) as { tokenAddress?: unknown; targetTimestamp?: unknown };
      if (typeof payload.tokenAddress !== 'string' || typeof payload.targetTimestamp !== 'string') { respond(400, { error: 'Probe requires tokenAddress and targetTimestamp.' }); return; }
      respond(200, await probeBirdeye(database, payload.tokenAddress, payload.targetTimestamp));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/dune/candidates') {
      const rawLimit = requestUrl.searchParams.get('limit');
      const limit = rawLimit === null ? undefined : Number(rawLimit);
      if (rawLimit !== null && (!Number.isFinite(limit) || (limit as number) <= 0)) { respond(400, { error: 'limit must be a positive number when provided.' }); return; }
      respond(200, listOutcomeCandidates(database, limit));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/birdeye/outcomes') {
      const payload = await readJsonBody(request) as { signalIds?: unknown };
      if (!Array.isArray(payload.signalIds) || payload.signalIds.some((id) => typeof id !== 'number' || !Number.isInteger(id))) { respond(400, { error: 'Outcome measurement requires signal ids.' }); return; }
      respond(200, await measureSignalsOutcome(database, payload.signalIds));
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
      respond(200, computeSignalPatternSubgroupReport(database, property as SubgroupProperty));
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
      respond(200, readCopyTradeSummary(database));
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
    if (request.method === 'POST' && requestUrl.pathname === '/api/copytrade/experiments/freeze') {
      const payload = (await readJsonBody(request)) as { snapshotId?: unknown; primaryTopN?: unknown; rosterTopN?: unknown; evaluationWindowsDays?: unknown };
      const snapshotId = Number(payload.snapshotId);
      if (!Number.isInteger(snapshotId) || snapshotId <= 0) { respond(400, { error: 'snapshotId must be a positive integer.' }); return; }
      const primaryTopN = Number.isInteger(payload.primaryTopN) && Number(payload.primaryTopN) > 0 ? Number(payload.primaryTopN) : undefined;
      const rosterTopN = Number.isInteger(payload.rosterTopN) && Number(payload.rosterTopN) > 0 ? Number(payload.rosterTopN) : undefined;
      const evaluationWindowsDays = Array.isArray(payload.evaluationWindowsDays) && payload.evaluationWindowsDays.every((value) => Number.isInteger(value) && value > 0)
        ? payload.evaluationWindowsDays as number[] : undefined;
      try {
        respond(200, freezeExperiment(database, snapshotId, { primaryTopN, rosterTopN, evaluationWindowsDays }));
      } catch (error: unknown) {
        respond(400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/experiments') {
      respond(200, listExperiments(database));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname.startsWith('/api/copytrade/experiments/')) {
      const experimentId = Number(requestUrl.pathname.slice('/api/copytrade/experiments/'.length));
      if (!Number.isInteger(experimentId) || experimentId <= 0) { respond(400, { error: 'Experiment id must be a positive integer.' }); return; }
      try {
        // Forward validation is intentionally scoped to the first-stage Winners set. The frozen
        // roster remains 25 wallets for provenance/comparison, but only wallets that currently
        // clear the research gates should consume attention in this detailed report.
        const screenReport = computeCopyTradeReport(database, { periodDays: 90, traderLimit: 25 });
        const { computed: historicalConsistency } = readHistoricalConsistencyForRoster(database, 25);
        const winnerAddresses = new Set(computeCopyCandidates(
          screenReport,
          historicalConsistency,
          readCopySimulationSurvivalMap(database, screenReport, historicalConsistency),
        ).candidates.map((candidate) => candidate.walletAddress));
        const report = evaluateExperiment(database, experimentId);
        respond(200, {
          ...report,
          wallets: report.wallets.filter((wallet) => winnerAddresses.has(wallet.walletAddress)),
          evaluatedScope: { kind: 'first_stage_winners', winnerCount: winnerAddresses.size, frozenRosterCount: report.wallets.length },
        });
      } catch (error: unknown) {
        respond(404, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/results') {
      const periodParam = Number(requestUrl.searchParams.get('periodDays') ?? '');
      const periodDays = Number.isInteger(periodParam) && periodParam > 0 ? periodParam : undefined;
      const limitParam = Number(requestUrl.searchParams.get('limit') ?? '');
      const traderLimit = Number.isInteger(limitParam) && limitParam > 0 ? limitParam : undefined;
      const snapshotParam = Number(requestUrl.searchParams.get('snapshotId') ?? '');
      const rosterSnapshotId = Number.isInteger(snapshotParam) && snapshotParam > 0 ? snapshotParam : undefined;
      respond(200, computeCopyTradeReport(database, { periodDays, traderLimit, rosterSnapshotId }));
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
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/historical-consistency') {
      const limitParam = Number(requestUrl.searchParams.get('limit') ?? '25');
      const limit = Number.isInteger(limitParam) && limitParam > 0 ? limitParam : 25;
      const snapshotParam = Number(requestUrl.searchParams.get('snapshotId') ?? '');
      const rosterSnapshotId = Number.isInteger(snapshotParam) && snapshotParam > 0 ? snapshotParam : undefined;
      const { roster, computed } = readHistoricalConsistencyForRoster(database, limit, rosterSnapshotId);
      const rosterByAddress = new Map(roster.map((wallet) => [wallet.walletAddress, wallet]));
      respond(200, {
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
      });
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
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/copy-simulation') {
      const snapshotParam = Number(requestUrl.searchParams.get('snapshotId') ?? '');
      const rosterSnapshotId = Number.isInteger(snapshotParam) && snapshotParam > 0 ? snapshotParam : undefined;
      const screenReport = computeCopyTradeReport(database, { periodDays: 90, traderLimit: 25, rosterSnapshotId });
      const { computed: historicalConsistency } = readHistoricalConsistencyForRoster(database, 25, rosterSnapshotId);
      const walletAddresses = computeScreenPassCandidates(screenReport, historicalConsistency).candidates.map((candidate) => candidate.walletAddress);
      respond(200, computeCopySimulationReport(database, { walletAddresses }));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/copytrade/liquidity-impact') {
      // Same wallet scope as /api/copytrade/copy-simulation above (every screen-pass candidate,
      // not just final Winners) — the liquidity-band breakdown re-slices the exact same
      // already-computed simulation results, never a separate query or a different population.
      const snapshotParam = Number(requestUrl.searchParams.get('snapshotId') ?? '');
      const rosterSnapshotId = Number.isInteger(snapshotParam) && snapshotParam > 0 ? snapshotParam : undefined;
      const screenReport = computeCopyTradeReport(database, { periodDays: 90, traderLimit: 25, rosterSnapshotId });
      const { computed: historicalConsistency } = readHistoricalConsistencyForRoster(database, 25, rosterSnapshotId);
      const walletAddresses = computeScreenPassCandidates(screenReport, historicalConsistency).candidates.map((candidate) => candidate.walletAddress);
      const simReport = computeCopySimulationReport(database, { walletAddresses });
      respond(200, computeLiquidityImpactReport(simReport));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/copytrade/copy-simulation/run') {
      // Scoped to every wallet that still needs copy-survival verification — the wallets that
      // already pass every other gate (screen, historical consistency, hold time,
      // fast-round-trip, concentration) — not just whoever is already a final Winner. A wallet
      // can only ever earn its first simulation this way; scoping to final Winners instead would
      // be circular, since copy-survival is itself one of the gates that makes a Winner.
      const snapshotParam = Number(requestUrl.searchParams.get('snapshotId') ?? '');
      const rosterSnapshotId = Number.isInteger(snapshotParam) && snapshotParam > 0 ? snapshotParam : undefined;
      const screenReport = computeCopyTradeReport(database, { periodDays: 90, traderLimit: 25, rosterSnapshotId });
      const { computed: historicalConsistency } = readHistoricalConsistencyForRoster(database, 25, rosterSnapshotId);
      const walletAddresses = computeScreenPassCandidates(screenReport, historicalConsistency).candidates.map((candidate) => candidate.walletAddress);
      if (!walletAddresses.length) { respond(400, { error: 'No candidates pass the other gates yet — nothing to simulate.' }); return; }
      try {
        // Runs to completion for the current candidate scope in one call (see
        // runCopySimulationBatch's own comment) — the UI should never need to click this
        // repeatedly.
        respond(200, await runCopySimulationBatch(database, { walletAddresses }));
      } catch (error) {
        respond(502, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/top-callers/leaderboard') {
      respond(200, readLeaderboard(database));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/top-callers/track') {
      const payload = (await readJsonBody(request)) as { callerKey?: unknown };
      if (typeof payload.callerKey !== 'string' || !payload.callerKey.trim()) { respond(400, { error: 'callerKey is required.' }); return; }
      trackCaller(database, payload.callerKey.trim());
      respond(200, { tracked: true });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/top-callers/untrack') {
      const payload = (await readJsonBody(request)) as { callerKey?: unknown };
      if (typeof payload.callerKey !== 'string' || !payload.callerKey.trim()) { respond(400, { error: 'callerKey is required.' }); return; }
      untrackCaller(database, payload.callerKey.trim());
      respond(200, { tracked: false });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/top-callers/collect') {
      const payload = (await readJsonBody(request)) as { kind?: unknown };
      const validKinds: CollectionKind[] = ['leaderboard', 'callouts', 'checkpoints'];
      if (typeof payload.kind !== 'string' || !validKinds.includes(payload.kind as CollectionKind)) {
        respond(400, { error: `kind must be one of: ${validKinds.join(', ')}.` });
        return;
      }
      const kind = payload.kind as CollectionKind;
      if (kind === 'leaderboard') {
        const elapsed = msSinceLastCollectionStart(database, kind);
        if (elapsed !== null && elapsed < LEADERBOARD_CAPTURE_COOLDOWN_MS) {
          const retryAfterSeconds = Math.ceil((LEADERBOARD_CAPTURE_COOLDOWN_MS - elapsed) / 1000);
          respond(429, {
            error: `Leaderboard capture cooldown active. Try again in ${retryAfterSeconds}s.`,
            retryAfterSeconds,
          });
          return;
        }
      }
      if (hasActiveCollectionRun(database, kind)) { respond(409, { error: `A collection run of kind "${kind}" is already in progress.` }); return; }
      // Start the network work in the background so the browser receives an immediate running
      // state and can show progress/countdown instead of appearing frozen until GMGN/Dune
      // finishes. The durable run row is the source of truth polled by the UI.
      void startCollectionRun(database, kind).catch((error: unknown) => {
        logDiagnostic(database, { level: 'error', event: 'top_caller_collection_background_failure', method: request.method, path: requestUrl.pathname, message: error instanceof Error ? error.message : String(error) });
      });
      respond(202, { status: 'running', kind });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/top-callers/collect/status') {
      const kindParam = requestUrl.searchParams.get('kind');
      const validKinds: CollectionKind[] = ['leaderboard', 'callouts', 'checkpoints'];
      if (!kindParam || !validKinds.includes(kindParam as CollectionKind)) { respond(400, { error: `kind must be one of: ${validKinds.join(', ')}.` }); return; }
      respond(200, readCollectionRunState(database, kindParam as CollectionKind));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/top-callers/collect/stop') {
      const payload = (await readJsonBody(request)) as { kind?: unknown };
      const validKinds: CollectionKind[] = ['leaderboard', 'callouts', 'checkpoints'];
      const kind = typeof payload.kind === 'string' && validKinds.includes(payload.kind as CollectionKind)
        ? payload.kind as CollectionKind : undefined;
      if (payload.kind !== undefined && kind === undefined) { respond(400, { error: `kind must be one of: ${validKinds.join(', ')}.` }); return; }
      respond(200, { stopped: stopCollectionRuns(database, kind), status: 'cancelled', message: 'Stopped by user; data already fetched is retained.' });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/top-callers/resume') {
      const payload = (await readJsonBody(request)) as { runId?: unknown };
      const runId = payload.runId === undefined ? undefined : Number(payload.runId);
      if (runId !== undefined && (!Number.isInteger(runId) || runId <= 0)) { respond(400, { error: 'runId must be a positive integer.' }); return; }
      try {
        const row = (runId
          ? database.prepare(`SELECT id FROM top_caller_collection_runs WHERE id = ? AND status = 'paused'`).get(runId)
          : database.prepare(`SELECT id FROM top_caller_collection_runs WHERE status = 'paused' ORDER BY id DESC LIMIT 1`).get()) as { id: number } | undefined;
        if (!row) { respond(404, { error: 'No paused Top Caller collection run exists.' }); return; }
        void resumeCollectionRun(database, row.id).catch((error: unknown) => {
          logDiagnostic(database, { level: 'error', event: 'top_caller_resume_background_failure', message: error instanceof Error ? error.message : String(error) });
        });
        respond(200, { runId: row.id, status: 'running' });
      } catch (error) {
        respond(404, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/top-callers/callers') {
      const checkpoint = requestUrl.searchParams.get('checkpoint') ?? undefined;
      respond(200, checkpoint ? computeCallerEvaluationReport(database, checkpoint) : computeCallerEvaluationReport(database));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname.startsWith('/api/top-callers/callers/') && requestUrl.pathname.endsWith('/checkpoints')) {
      const callerKey = decodeURIComponent(requestUrl.pathname.slice('/api/top-callers/callers/'.length, -'/checkpoints'.length));
      if (!callerKey) { respond(400, { error: 'callerKey is required.' }); return; }
      respond(200, { callerKey, rows: computeCallerCheckpointBreakdown(database, callerKey) });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname.startsWith('/api/top-callers/callers/')) {
      const callerKey = decodeURIComponent(requestUrl.pathname.slice('/api/top-callers/callers/'.length));
      if (!callerKey) { respond(400, { error: 'callerKey is required.' }); return; }
      respond(200, readCallerDetail(database, callerKey));
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
    if (request.method === 'GET' && requestUrl.pathname === '/api/gmgn/watch/status') {
      respond(200, getGmgnWatchStatus());
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/gmgn/watch/start') {
      // See GMGN_WATCH_MODE_ENABLED above — continuous polling is intentionally disabled for now.
      if (!GMGN_WATCH_MODE_ENABLED) {
        respond(503, { error: 'Watch mode is temporarily disabled. Use "Fetch once" for now.' });
        return;
      }
      const payload = await readJsonBody(request).catch(() => ({})) as { intervalSeconds?: unknown };
      const intervalSeconds = typeof payload.intervalSeconds === 'number' ? payload.intervalSeconds : undefined;
      respond(200, startGmgnWatch(database, intervalSeconds));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/gmgn/watch/stop') {
      respond(200, stopGmgnWatch(database));
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
