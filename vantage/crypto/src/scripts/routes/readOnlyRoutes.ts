import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { readDatabaseStats } from '../../platform/db/stats.js';
import { readDataQuality } from '../../signals/quality.js';
import { readIntegrityReport } from '../../signals/integrity.js';
import { readSnapshotAnalysis } from '../../signals/analysis.js';
import { readSignalScoringReport } from '../../signals/scoring.js';
import { RESEARCH_QUESTION } from '../../research/question.js';
import { readRecentDiagnostics } from '../../platform/db/diagnostics.js';
import {
  listOutcomeCandidates,
  measureDuneOutcomes,
  readAllDuneOutcomes,
  readLatestDuneOutcomes,
  reconcileStuckDuneRuns,
} from '../../dune/outcomes.js';
import { buildMeasurementPlan } from '../../dune/planner.js';
import {
  computeSignalPatternReport,
  computeSignalPatternSubgroupReport,
  listSignalPatternSnapshots,
  saveSignalPatternSnapshot,
  type SubgroupProperty,
} from '../../signals/patterns.js';
import {
  computeRobustPatternReport,
  type RobustPatternReport,
} from '../../signals/robustPatterns.js';
import { API_CATALOG } from '../../apiCatalog.js';

/** The small request surface route modules need from the HTTP server. */
export interface ReadOnlyRouteRequest {
  method: string | undefined;
  url: URL;
  request: IncomingMessage;
  readJsonBody: () => Promise<unknown>;
}

export interface ReadOnlyRouteContext {
  database: DatabaseSync;
  respond: (status: number, value: unknown) => void;
}

export type ReadOnlyRoute = (
  request: ReadOnlyRouteRequest,
  context: ReadOnlyRouteContext,
) => Promise<boolean>;

const ROBUST_REPORT_CACHE_TTL_MS = 5_000;
const ROBUST_REPORT_CACHE_MAX_ENTRIES = 8;
const robustReportCache = new Map<number, { computedAtMs: number; report: RobustPatternReport }>();

const is = (methodValue: string | undefined, url: URL, method: string, pathname: string): boolean =>
  methodValue === method && url.pathname === pathname;

/**
 * Routes that only read or calculate research diagnostics.
 *
 * The handlers deliberately retain the old server response shapes. The parent server can
 * install this list before its remaining routes without changing clients or moving domain logic
 * into the HTTP layer.
 */
export const createReadOnlyRoutes = (): ReadOnlyRoute[] => [
  async ({ method, url }, { respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/docs') return false;
    respond(200, {
      generatedAt: new Date().toISOString(),
      source: 'server API catalog',
      count: API_CATALOG.length,
      endpoints: API_CATALOG,
    });
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (!is(method, url, 'GET', '/api/stats')) return false;
    respond(200, readDatabaseStats(database));
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (!is(method, url, 'GET', '/api/quality')) return false;
    respond(200, readDataQuality(database));
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (!is(method, url, 'GET', '/api/integrity')) return false;
    respond(200, readIntegrityReport(database));
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (!is(method, url, 'GET', '/api/analysis/snapshot')) return false;
    respond(200, readSnapshotAnalysis(database));
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/analysis/scores') return false;
    respond(200, readSignalScoringReport(database));
    return true;
  },
  async ({ method, url }, { respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/research-question') return false;
    respond(200, RESEARCH_QUESTION);
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/dune/candidates') return false;
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? undefined : Number(rawLimit);
    if (rawLimit !== null && (!Number.isFinite(limit) || (limit as number) <= 0)) {
      respond(400, { error: 'limit must be a positive number when provided.' });
      return true;
    }
    respond(200, listOutcomeCandidates(database, limit));
    return true;
  },
  async ({ method, url, readJsonBody }, { database, respond }) => {
    if (method !== 'POST' || url.pathname !== '/api/dune/outcomes') return false;
    const payload = (await readJsonBody()) as { signalIds?: unknown };
    if (
      !Array.isArray(payload.signalIds) ||
      payload.signalIds.some((id) => typeof id !== 'number' || !Number.isInteger(id))
    ) {
      respond(400, { error: 'Dune outcome measurement requires signal ids.' });
      return true;
    }
    respond(200, await measureDuneOutcomes(database, payload.signalIds));
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/dune/outcomes/latest') return false;
    respond(200, readLatestDuneOutcomes(database));
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/dune/outcomes/all') return false;
    respond(200, readAllDuneOutcomes(database));
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'POST' || url.pathname !== '/api/dune/reconcile') return false;
    respond(200, await reconcileStuckDuneRuns(database));
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/dune/measurement-plan') return false;
    respond(200, buildMeasurementPlan(database));
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/analysis/patterns') return false;
    respond(200, computeSignalPatternReport(database));
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'POST' || url.pathname !== '/api/analysis/patterns/snapshot') return false;
    respond(200, saveSignalPatternSnapshot(database, computeSignalPatternReport(database)));
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/analysis/patterns/snapshots') return false;
    respond(200, listSignalPatternSnapshots(database));
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/analysis/patterns/subgroups') return false;
    const property = url.searchParams.get('property');
    if (property !== 'launchPlatform' && property !== 'tokenAge' && property !== 'combined') {
      respond(400, { error: 'property must be "launchPlatform", "tokenAge", or "combined".' });
      return true;
    }
    respond(200, computeSignalPatternSubgroupReport(database, property as SubgroupProperty));
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/analysis/patterns/robust') return false;
    const rawIterations = Number(url.searchParams.get('iterations') ?? '');
    const iterations =
      Number.isFinite(rawIterations) && rawIterations > 0 ? Math.min(rawIterations, 5000) : 1000;
    const cached = robustReportCache.get(iterations);
    const nowMs = Date.now();
    if (cached && nowMs - cached.computedAtMs < ROBUST_REPORT_CACHE_TTL_MS) {
      respond(200, cached.report);
      return true;
    }
    const report = computeRobustPatternReport(database, new Date(nowMs), {
      bootstrapIterations: iterations,
    });
    if (robustReportCache.size >= ROBUST_REPORT_CACHE_MAX_ENTRIES) robustReportCache.clear();
    robustReportCache.set(iterations, { computedAtMs: nowMs, report });
    respond(200, report);
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/logs') return false;
    const limitParam = Number(url.searchParams.get('limit') ?? '100');
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 100;
    respond(200, readRecentDiagnostics(database, limit));
    return true;
  },
];
