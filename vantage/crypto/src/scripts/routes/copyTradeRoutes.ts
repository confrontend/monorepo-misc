import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import {
  listLeaderboardSnapshotStatuses,
  listRosterWallets,
  readCaptureHealth,
  readLatestRankSnapshot,
  syncCopyTradeRoster,
  compareLatestRosterSnapshots,
} from '../../copytrade/screening/roster.js';
import {
  importWalletRankSnapshot,
  refreshCurrentWalletRank,
  RESEARCH_RANK_MIN_WINRATE_30D,
  RESEARCH_RANK_ORDERBY,
} from '../../gmgn/walletRankFetch.js';
import {
  hasActiveFetchRun,
  readFetchRunState,
  requestCopyTradeFetchStop,
  resetCopyTradeFetchResume,
  startCopyTradeFetch,
} from '../../copytrade/screening/fetch.js';
import {
  readGmgnStatsFetchStatus,
  startGmgnStatsFetch,
  stopGmgnStatsFetch,
} from '../../copytrade/screening/statsFetch.js';
import { readGmgnTradeCounts } from '../../copytrade/screening/tradeCounts.js';
import { projectFetchDuration } from '../../copytrade/screening/estimate.js';
import { importBrowserWalletActivity } from '../../copytrade/browserActivityImport.js';

export interface CopyTradeRouteRequest {
  method: string | undefined;
  url: URL;
  request: IncomingMessage;
  readJsonBody: () => Promise<unknown>;
}

export interface CopyTradeRouteContext {
  database: DatabaseSync;
  respond: (status: number, value: unknown) => void;
}

export type CopyTradeRoute = (
  request: CopyTradeRouteRequest,
  context: CopyTradeRouteContext,
) => Promise<boolean>;

const is = (request: CopyTradeRouteRequest, method: string, pathname: string): boolean =>
  request.method === method && request.url.pathname === pathname;

/**
 * Operational CopyTrade routes. The route layer owns validation and response formatting only;
 * fetching, roster synchronization, and statistics remain in their domain modules.
 */
export const createCopyTradeRoutes = (): CopyTradeRoute[] => [
  async ({ method, url, readJsonBody }, { database, respond }) => {
    if (method !== 'POST' || url.pathname !== '/api/copytrade/fetch') return false;
    const payload = (await readJsonBody()) as { limit?: unknown; periodDays?: unknown };
    const limit = Number(payload.limit);
    const periodDays = Number(payload.periodDays);
    if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
      respond(400, { error: 'limit must be an integer between 1 and 500.' });
      return true;
    }
    if (!Number.isInteger(periodDays) || periodDays <= 0 || periodDays > 365) {
      respond(400, { error: 'periodDays must be an integer between 1 and 365.' });
      return true;
    }
    if (hasActiveFetchRun(database)) {
      respond(409, { error: 'A fetch run is already in progress.' });
      return true;
    }
    respond(200, startCopyTradeFetch(database, { limit, periodDays }));
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'POST' || url.pathname !== '/api/copytrade/fetch/stop') return false;
    respond(200, requestCopyTradeFetchStop(database));
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'POST' || url.pathname !== '/api/copytrade/fetch/reset') return false;
    if (hasActiveFetchRun(database)) {
      respond(409, { error: 'Stop the active fetch before resetting its resumable snapshot.' });
      return true;
    }
    respond(200, resetCopyTradeFetchResume(database));
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/copytrade/fetch/status') return false;
    respond(200, readFetchRunState(database));
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/copytrade/fetch/estimate') return false;
    const limitParam = Number(url.searchParams.get('limit') ?? '');
    const limit = Number.isInteger(limitParam) && limitParam > 0 ? limitParam : 25;
    const periodParam = Number(url.searchParams.get('periodDays') ?? '');
    const periodDays = Number.isInteger(periodParam) && periodParam > 0 ? periodParam : 30;
    const chain = url.searchParams.get('chain')?.trim() || 'sol';
    const addresses = url.searchParams.get('walletAddresses');
    const walletAddresses =
      addresses === null
        ? undefined
        : [
            ...new Set(
              addresses
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean),
            ),
          ];
    respond(200, projectFetchDuration(database, { chain, limit, periodDays, walletAddresses }));
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/copytrade/capture-health') return false;
    respond(200, readCaptureHealth(database));
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/copytrade/rosters') return false;
    const snapshots = listLeaderboardSnapshotStatuses(database);
    const health = readCaptureHealth(database);
    respond(200, {
      selectedByDefault: health.latestProvenancedSnapshotId ?? health.latestSnapshotId,
      snapshots,
    });
    return true;
  },
  async ({ method, url, readJsonBody }, { database, respond }) => {
    if (method !== 'POST' || url.pathname !== '/api/copytrade/roster/sync') return false;
    const payload = (await readJsonBody().catch(() => ({}))) as { limit?: unknown };
    const limit = Number(payload.limit);
    respond(
      200,
      syncCopyTradeRoster(database, {
        chain: 'sol',
        limit: Number.isInteger(limit) && limit > 0 ? limit : undefined,
      }),
    );
    return true;
  },
  async ({ method, url, readJsonBody }, { database, respond }) => {
    if (method !== 'POST' || url.pathname !== '/api/copytrade/roster/import') return false;
    const payload = (await readJsonBody()) as { name?: unknown; content?: unknown };
    if (typeof payload.content !== 'string' || payload.content.trim().length === 0) {
      respond(400, { error: 'A non-empty roster JSON file is required.' });
      return true;
    }
    try {
      const imported = importWalletRankSnapshot(database, JSON.parse(payload.content));
      const roster = syncCopyTradeRoster(database, { chain: 'sol', limit: 100 });
      respond(200, {
        ...imported,
        roster,
        sourceName: typeof payload.name === 'string' ? payload.name : 'roster.json',
      });
    } catch (error) {
      respond(400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  },
  async ({ method, url, readJsonBody }, { database, respond }) => {
    if (method !== 'POST' || url.pathname !== '/api/copytrade/roster/refresh') return false;
    const payload = (await readJsonBody().catch(() => ({}))) as {
      limit?: unknown;
      useSavedSnapshot?: unknown;
    };
    const limit = Number(payload.limit);
    try {
      const refreshed = await refreshCurrentWalletRank(database, {
        limit: Number.isInteger(limit) && limit > 0 ? limit : 100,
        chain: 'sol',
        orderby: RESEARCH_RANK_ORDERBY,
        minWinrate30d: RESEARCH_RANK_MIN_WINRATE_30D,
        useSavedSnapshot: payload.useSavedSnapshot === true,
      });
      const roster = syncCopyTradeRoster(database, {
        chain: 'sol',
        limit: Number.isInteger(limit) && limit > 0 ? limit : 100,
      });
      respond(200, {
        ...refreshed,
        roster,
        researchFilter: {
          orderby: RESEARCH_RANK_ORDERBY,
          minWinrate30d: RESEARCH_RANK_MIN_WINRATE_30D,
        },
      });
    } catch (error) {
      respond(502, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/copytrade/roster/compare') return false;
    respond(200, compareLatestRosterSnapshots(database, { chain: 'sol', limit: 100 }));
    return true;
  },
  async ({ method, url, readJsonBody }, { database, respond }) => {
    if (method !== 'POST' || url.pathname !== '/api/copytrade/import-browser-activity')
      return false;
    const payload = (await readJsonBody()) as { name?: unknown; content?: unknown };
    if (typeof payload.content !== 'string') {
      respond(400, { error: 'Upload must include a text content field.' });
      return true;
    }
    try {
      respond(
        200,
        importBrowserWalletActivity(
          database,
          typeof payload.name === 'string' ? payload.name : 'gmgn-investigation.json',
          payload.content,
        ),
      );
    } catch (error) {
      respond(400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/copytrade/stats/status') return false;
    respond(200, readGmgnStatsFetchStatus());
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'POST' || url.pathname !== '/api/copytrade/stats/stop') return false;
    respond(200, stopGmgnStatsFetch());
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/copytrade/stats/trade-counts') return false;
    const periodParam = Number(url.searchParams.get('periodDays') ?? '30');
    const periodDays = Number.isInteger(periodParam) && periodParam > 0 ? periodParam : 30;
    const limitParam = Number(url.searchParams.get('limit') ?? '100');
    const limit = Number.isInteger(limitParam) && limitParam > 0 ? limitParam : 100;
    const snapshotParam = Number(url.searchParams.get('snapshotId') ?? '');
    const snapshotId =
      Number.isInteger(snapshotParam) && snapshotParam > 0 ? snapshotParam : undefined;
    respond(200, {
      periodDays,
      counts: readGmgnTradeCounts(database, { periodDays, limit, snapshotId }),
    });
    return true;
  },
  async ({ method, url, readJsonBody }, { database, respond }) => {
    if (method !== 'POST' || url.pathname !== '/api/copytrade/stats/fetch') return false;
    const payload = (await readJsonBody()) as {
      limit?: unknown;
      snapshotId?: unknown;
      maxAgeHours?: unknown;
    };
    const limit = Number(payload.limit);
    if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
      respond(400, { error: 'limit must be an integer between 1 and 500.' });
      return true;
    }
    if (readGmgnStatsFetchStatus().running) {
      respond(409, { error: 'A GMGN stats fetch is already in progress.' });
      return true;
    }
    const snapshotId = Number(payload.snapshotId);
    const maxAgeHours = Number(payload.maxAgeHours);
    respond(
      200,
      startGmgnStatsFetch(database, {
        limit,
        snapshotId: Number.isInteger(snapshotId) && snapshotId > 0 ? snapshotId : undefined,
        maxAgeHours: Number.isFinite(maxAgeHours) && maxAgeHours > 0 ? maxAgeHours : undefined,
      }),
    );
    return true;
  },
];
