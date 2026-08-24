import type { DatabaseSync } from 'node:sqlite';
import { listRosterWallets } from './roster.js';
import { fetchAndStoreWalletStats, readApiKey } from './fetch.js';

export type GmgnStatsFetchStatus = {
  running: boolean;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  walletDone: number;
  walletTotal: number;
  periods: string[];
  requestsMade: number;
  skippedFresh: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

let state: GmgnStatsFetchStatus = {
  running: false,
  status: 'idle',
  walletDone: 0,
  walletTotal: 0,
  periods: ['7d', '30d'],
  requestsMade: 0,
  skippedFresh: 0,
  error: null,
  startedAt: null,
  completedAt: null,
};
let stopRequested = false;

export const readGmgnStatsFetchStatus = (): GmgnStatsFetchStatus => ({ ...state });

const isFresh = (fetchedAt: string, maxAgeHours: number): boolean => {
  const timestamp = Date.parse(fetchedAt);
  return Number.isFinite(timestamp) && Date.now() - timestamp < maxAgeHours * 3_600_000;
};

export const stopGmgnStatsFetch = (): GmgnStatsFetchStatus => {
  if (state.running) stopRequested = true;
  return readGmgnStatsFetchStatus();
};

export const startGmgnStatsFetch = (
  database: DatabaseSync,
  options: {
    limit: number;
    snapshotId?: number;
    chain?: string;
    periods?: Array<'7d' | '30d'>;
    maxAgeHours?: number;
  },
): GmgnStatsFetchStatus => {
  if (state.running) return readGmgnStatsFetchStatus();
  const chain = options.chain ?? 'sol';
  const periods: Array<'7d' | '30d'> = options.periods
    ? [...new Set(options.periods)]
    : ['7d', '30d'];
  const wallets = listRosterWallets(database, {
    chain,
    limit: options.limit,
    snapshotId: options.snapshotId,
  });
  state = {
    running: true,
    status: 'running',
    walletDone: 0,
    walletTotal: wallets.length,
    periods,
    requestsMade: 0,
    skippedFresh: 0,
    error: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  stopRequested = false;
  void (async () => {
    try {
      const apiKey = readApiKey();
      const maxAgeHours = options.maxAgeHours ?? 24;
      for (const wallet of wallets) {
        if (stopRequested) break;
        for (const period of periods) {
          if (stopRequested) break;
          const existing = database
            .prepare(
              `SELECT fetched_at AS fetchedAt FROM copytrade_wallet_stats WHERE wallet_address = ? AND chain = ? AND period = ?`,
            )
            .get(wallet.walletAddress, chain, period) as { fetchedAt?: string } | undefined;
          if (existing?.fetchedAt && isFresh(existing.fetchedAt, maxAgeHours)) {
            state = { ...state, skippedFresh: state.skippedFresh + 1 };
            continue;
          }
          state = { ...state, requestsMade: state.requestsMade + 1 };
          await fetchAndStoreWalletStats(database, {
            wallet: wallet.walletAddress,
            chain,
            period,
            apiKey,
          });
        }
        state = { ...state, walletDone: state.walletDone + 1 };
      }
      state = {
        ...state,
        running: false,
        status: stopRequested ? 'cancelled' : 'completed',
        completedAt: new Date().toISOString(),
      };
    } catch (error) {
      state = {
        ...state,
        running: false,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString(),
      };
    } finally {
      stopRequested = false;
    }
  })();
  return readGmgnStatsFetchStatus();
};
