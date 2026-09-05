import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { listRosterWallets } from '../../copytrade/screening/roster.js';
import { readWalletFeatureCoverageInventory } from '../../copytrade/features/walletFeatureCoverage.js';
import { generateWalletFeatureCalendarSnapshots } from '../../copytrade/features/walletFeatureCalendar.js';
import { listWalletFeatureSnapshots } from '../../copytrade/features/walletFeatureSnapshots.js';
import { WALLET_FEATURE_ENGINE_VERSION } from '../../copytrade/features/walletFeatureDefinitions.js';

export interface FeatureRouteRequest {
  method: string | undefined;
  url: URL;
  request: IncomingMessage;
  readJsonBody: () => Promise<unknown>;
}

export interface FeatureRouteContext {
  database: DatabaseSync;
  respond: (status: number, value: unknown) => void;
}

export type FeatureRoute = (
  request: FeatureRouteRequest,
  context: FeatureRouteContext,
) => Promise<boolean>;

/** Feature coverage and calendar snapshot endpoints. These are intentionally kept separate
 * from the Decision Lab report route: feature snapshots are descriptive evidence, not a
 * winner-policy calculation. */
export const createFeatureRoutes = (): FeatureRoute[] => [
  async ({ method, url }, { database, respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/copytrade/feature-coverage') return false;
    const periodRaw = Number(url.searchParams.get('periodDays') ?? '30');
    const limitRaw = Number(url.searchParams.get('limit') ?? '100');
    if (!Number.isInteger(periodRaw) || periodRaw < 1 || periodRaw > 365) {
      respond(400, { error: 'periodDays must be an integer between 1 and 365.' });
      return true;
    }
    const limit = Number.isFinite(limitRaw)
      ? Math.min(500, Math.max(1, Math.floor(limitRaw)))
      : 100;
    const roster = listRosterWallets(database, { chain: 'sol', limit });
    const walletAddresses = roster.map((wallet) => wallet.walletAddress);
    const inventory = readWalletFeatureCoverageInventory(database, {
      walletAddresses,
      chain: 'sol',
      periodDays: periodRaw,
    });
    const snapshotByWallet = new Map<
      string,
      { snapshotCount: number; latestFeatureSnapshotAt: string | null }
    >();
    if (walletAddresses.length > 0) {
      const placeholders = walletAddresses.map(() => '?').join(', ');
      const snapshotRows = database
        .prepare(
          `SELECT wallet_address AS walletAddress, COUNT(*) AS snapshotCount,
                  MAX(as_of_timestamp) AS latestFeatureSnapshotAt
           FROM copytrade_wallet_feature_snapshots
           WHERE chain = 'sol' AND wallet_address IN (${placeholders})
           GROUP BY wallet_address`,
        )
        .all(...walletAddresses) as unknown as Array<{
        walletAddress: string;
        snapshotCount: number;
        latestFeatureSnapshotAt: string | null;
      }>;
      for (const row of snapshotRows) snapshotByWallet.set(row.walletAddress, row);
    }
    const rosterByWallet = new Map(roster.map((wallet) => [wallet.walletAddress, wallet]));
    const rows = inventory.rows.map((row) => {
      const wallet = rosterByWallet.get(row.walletAddress);
      const snapshot = snapshotByWallet.get(row.walletAddress);
      return {
        ...row,
        name: wallet?.name ?? null,
        rankPosition: wallet?.rankPosition ?? null,
        snapshotCount: Number(snapshot?.snapshotCount ?? 0),
        latestFeatureSnapshotAt: snapshot?.latestFeatureSnapshotAt ?? null,
      };
    });
    respond(200, {
      generatedAt: new Date().toISOString(),
      ...inventory,
      rows,
      summary: {
        total: rows.length,
        complete: rows.filter((row) => row.assessment === 'complete_requested_window').length,
        incomplete: rows.filter((row) => row.assessment === 'incomplete').length,
        unknown: rows.filter((row) => row.assessment === 'unknown').length,
      },
    });
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/copytrade/feature-snapshots') return false;
    const walletAddress = url.searchParams.get('walletAddress')?.trim() ?? '';
    const limitRaw = Number(url.searchParams.get('limit') ?? '100');
    if (!walletAddress) {
      respond(400, { error: 'walletAddress is required.' });
      return true;
    }
    const limit = Number.isFinite(limitRaw)
      ? Math.min(1_000, Math.max(1, Math.floor(limitRaw)))
      : 100;
    respond(200, {
      walletAddress,
      chain: 'sol',
      snapshots: listWalletFeatureSnapshots(database, walletAddress, { chain: 'sol', limit }),
    });
    return true;
  },
  async ({ method, url, readJsonBody }, { database, respond }) => {
    if (method !== 'POST' || url.pathname !== '/api/copytrade/feature-snapshots') return false;
    const body = (await readJsonBody()) as {
      walletAddresses?: unknown;
      asOfTimestamp?: unknown;
      lookbackDays?: unknown;
      triggerKind?: unknown;
      limit?: unknown;
    };
    const requestedWallets = Array.isArray(body.walletAddresses)
      ? body.walletAddresses.filter((value): value is string => typeof value === 'string')
      : [];
    const requestedLimit = typeof body.limit === 'number' ? body.limit : 100;
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(500, Math.max(1, Math.floor(requestedLimit)))
      : 100;
    const walletAddresses =
      requestedWallets.length > 0
        ? [...new Set(requestedWallets.map((wallet) => wallet.trim()).filter(Boolean))].slice(
            0,
            limit,
          )
        : listRosterWallets(database, { chain: 'sol', limit }).map(
            (wallet) => wallet.walletAddress,
          );
    const asOfTimestamp =
      typeof body.asOfTimestamp === 'string' && body.asOfTimestamp.trim()
        ? body.asOfTimestamp
        : new Date().toISOString();
    const lookbackDays = body.lookbackDays === null ? null : Number(body.lookbackDays ?? 30);
    if (lookbackDays !== null && (!Number.isInteger(lookbackDays) || lookbackDays <= 0)) {
      respond(400, { error: 'lookbackDays must be a positive integer or null.' });
      return true;
    }
    const triggerKind = body.triggerKind === 'current' ? 'current' : 'calendar';
    const generated = generateWalletFeatureCalendarSnapshots(database, {
      walletAddresses,
      asOfTimestamp,
      lookbackDays,
      chain: 'sol',
      triggerKind,
    });
    respond(200, {
      asOfTimestamp: generated[0]?.snapshot.asOfTimestamp ?? asOfTimestamp,
      featureEngineVersion:
        generated[0]?.snapshot.featureEngineVersion ?? WALLET_FEATURE_ENGINE_VERSION,
      requested: walletAddresses.length,
      inserted: generated.filter((result) => result.inserted).length,
      existing: generated.filter((result) => !result.inserted).length,
      snapshots: generated.map((result) => result.snapshot),
    });
    return true;
  },
];
