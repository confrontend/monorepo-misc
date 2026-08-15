import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const database = openDatabase();
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
