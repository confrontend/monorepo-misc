import type { DatabaseSync } from 'node:sqlite';
import {
  currentWalletFeaturesFromSnapshot,
  type CurrentWalletFeatures,
  type PreEventFeatures,
  WalletFeatureAccumulator,
  type WalletDecisionCompatibilityMetrics,
  type WalletFeatureTrade,
} from './walletFeatureEngine.js';
import { buildWalletFeatureQuality, type WalletFeatureQuality } from './walletFeatureQuality.js';

const DEFAULT_CHAIN = 'sol';
const WALLET_QUERY_CHUNK = 200;
const EVENT_CONTEXT_CHUNK = 200;

export type WalletEventFeatureRequest = {
  tradeId: number;
  walletAddress: string;
  tokenAddress: string;
  observedTimestamp: number;
};

export type WalletFeatureSnapshotRequest = {
  walletAddresses: string[];
  asOfTimestamp?: string | null;
  lookbackDays?: number | null;
  includePreWindowContext?: boolean;
  trigger: 'calendar' | 'current';
  chain?: string;
};

export type { WalletFeatureQuality } from './walletFeatureQuality.js';

export type WalletFeatureSnapshot = {
  walletAddress: string;
  features: CurrentWalletFeatures;
  decisionMetrics: WalletDecisionCompatibilityMetrics;
  quality: WalletFeatureQuality;
};

type TokenEntryContext = {
  marketCap: number | null;
  tokenAgeSeconds: number | null;
};

const chunked = <T>(values: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

const parseTimestamp = (value: string, label: string): number => {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`Invalid ${label}: ${value}`);
  return Math.floor(milliseconds / 1000);
};

const isoTimestamp = (seconds: number | null): string | null =>
  seconds === null ? null : new Date(seconds * 1000).toISOString();

const readTokenEntryContext = (
  database: DatabaseSync,
  tokenAddress: string,
  observedTimestamp: number,
): TokenEntryContext => {
  const signal = database
    .prepare(
      `SELECT COALESCE(trigger_mc, first_trigger_mc, market_cap) AS marketCap
       FROM gmgn_signals
       WHERE token_address = ? AND observed_at IS NOT NULL AND observed_at < ?
       ORDER BY observed_at DESC, id DESC LIMIT 1`,
    )
    .get(tokenAddress, new Date(observedTimestamp * 1000).toISOString()) as
    { marketCap: number | null } | undefined;
  const token = database
    .prepare(`SELECT first_trade_time AS firstTradeTime FROM tokens WHERE token_address = ?`)
    .get(tokenAddress) as { firstTradeTime: string | null } | undefined;
  const firstTradeSeconds = token?.firstTradeTime
    ? Math.floor(Date.parse(token.firstTradeTime) / 1000)
    : NaN;
  return {
    marketCap: signal?.marketCap ?? null,
    tokenAgeSeconds: Number.isFinite(firstTradeSeconds)
      ? Math.max(0, observedTimestamp - firstTradeSeconds)
      : null,
  };
};

const withTokenEntryContext = (
  features: PreEventFeatures,
  context: TokenEntryContext,
): PreEventFeatures => ({
  ...features,
  tokenMarketCapAtEntry: context.marketCap,
  tokenAgeSecondsAtEntry: context.tokenAgeSeconds,
});

const readTokenEntryContextsBatch = (
  database: DatabaseSync,
  requests: WalletEventFeatureRequest[],
): Map<number, TokenEntryContext> => {
  const result = new Map<number, TokenEntryContext>();
  for (const group of chunked(requests, EVENT_CONTEXT_CHUNK)) {
    if (group.length === 0) continue;
    const values = group.map(() => `(?, ?, ?)`).join(', ');
    const parameters = group.flatMap((request) => [
      request.tradeId,
      request.tokenAddress,
      new Date(request.observedTimestamp * 1000).toISOString(),
    ]);
    const rows = database
      .prepare(
        `WITH requested(requestId, tokenAddress, observedAt) AS (VALUES ${values})
         SELECT requested.requestId AS requestId,
                requested.observedAt AS observedAt,
                (SELECT COALESCE(signal.trigger_mc, signal.first_trigger_mc, signal.market_cap)
                 FROM gmgn_signals signal
                 WHERE signal.token_address = requested.tokenAddress
                   AND signal.observed_at IS NOT NULL
                   AND signal.observed_at < requested.observedAt
                 ORDER BY signal.observed_at DESC, signal.id DESC
                 LIMIT 1) AS marketCap,
                (SELECT token.first_trade_time
                 FROM tokens token
                 WHERE token.token_address = requested.tokenAddress
                 LIMIT 1) AS firstTradeTime
         FROM requested`,
      )
      .all(...parameters) as unknown as Array<{
      requestId: number;
      observedAt: string;
      marketCap: number | null;
      firstTradeTime: string | null;
    }>;
    for (const row of rows) {
      const observedTimestamp = Math.floor(Date.parse(row.observedAt) / 1000);
      const firstTradeTimestamp = row.firstTradeTime
        ? Math.floor(Date.parse(row.firstTradeTime) / 1000)
        : NaN;
      result.set(row.requestId, {
        marketCap: row.marketCap ?? null,
        tokenAgeSeconds: Number.isFinite(firstTradeTimestamp)
          ? Math.max(0, observedTimestamp - firstTradeTimestamp)
          : null,
      });
    }
  }
  return result;
};

export const readPreEventFeatures = (
  database: DatabaseSync,
  walletAddress: string,
  tokenAddress: string,
  buyAt: string,
  buyTradeId: number,
): PreEventFeatures => {
  const observedTimestamp = parseTimestamp(buyAt, 'buy timestamp for wallet features');
  const rows = database
    .prepare(
      `SELECT id, event_type AS eventType, token_address AS tokenAddress,
              observed_timestamp AS observedTimestamp, cost_usd AS costUsd,
              buy_cost_usd AS buyCostUsd
       FROM copytrade_trades
       WHERE chain = 'sol' AND wallet_address = ? AND event_type IN ('buy', 'sell')
         AND (observed_timestamp < ? OR (observed_timestamp = ? AND id < ?))
       ORDER BY observed_timestamp ASC, id ASC`,
    )
    .all(
      walletAddress,
      observedTimestamp,
      observedTimestamp,
      buyTradeId,
    ) as unknown as WalletFeatureTrade[];
  const accumulator = new WalletFeatureAccumulator();
  for (const row of rows) accumulator.apply(row);
  const entry = database
    .prepare(
      `SELECT cost_usd AS costUsd, launchpad_platform AS launchpadPlatform
       FROM copytrade_trades WHERE id = ?`,
    )
    .get(buyTradeId) as { costUsd: string | null; launchpadPlatform: string | null } | undefined;
  const features = accumulator.snapshot(
    tokenAddress,
    entry
      ? {
          ...entry,
          id: buyTradeId,
          eventType: 'buy',
          tokenAddress,
          observedTimestamp,
          buyCostUsd: null,
        }
      : undefined,
  );
  return withTokenEntryContext(
    features,
    readTokenEntryContext(database, tokenAddress, observedTimestamp),
  );
};

export const readPreEventFeatureSnapshotsBatch = (
  database: DatabaseSync,
  requests: WalletEventFeatureRequest[],
  options: {
    chain?: string;
    onWallet?: (completed: number, total: number, wallet: string) => void;
  } = {},
): Map<number, PreEventFeatures> => {
  const chain = options.chain ?? DEFAULT_CHAIN;
  const uniqueRequests = [
    ...new Map<number, WalletEventFeatureRequest>(
      requests.map((request) => [request.tradeId, request]),
    ).values(),
  ];
  const requestsByWallet = new Map<string, Map<number, WalletEventFeatureRequest>>();
  for (const request of uniqueRequests) {
    const walletRequests =
      requestsByWallet.get(request.walletAddress) ?? new Map<number, WalletEventFeatureRequest>();
    walletRequests.set(request.tradeId, request);
    requestsByWallet.set(request.walletAddress, walletRequests);
  }
  const contexts = readTokenEntryContextsBatch(database, uniqueRequests);
  const snapshots = new Map<number, PreEventFeatures>();
  const wallets = [...requestsByWallet.keys()];

  for (const walletGroup of chunked(wallets, WALLET_QUERY_CHUNK)) {
    if (walletGroup.length === 0) continue;
    const placeholders = walletGroup.map(() => '?').join(', ');
    const rows = database
      .prepare(
        `SELECT id, wallet_address AS walletAddress, event_type AS eventType,
                token_address AS tokenAddress, observed_timestamp AS observedTimestamp,
                cost_usd AS costUsd, buy_cost_usd AS buyCostUsd,
                launchpad_platform AS launchpadPlatform
         FROM copytrade_trades
         WHERE chain = ? AND wallet_address IN (${placeholders})
           AND event_type IN ('buy', 'sell')
         ORDER BY wallet_address ASC, observed_timestamp ASC, id ASC`,
      )
      .all(chain, ...walletGroup) as unknown as Array<
      WalletFeatureTrade & { walletAddress: string }
    >;

    let activeWallet = '';
    let accumulator = new WalletFeatureAccumulator();
    for (const row of rows) {
      if (row.walletAddress !== activeWallet) {
        activeWallet = row.walletAddress;
        accumulator = new WalletFeatureAccumulator();
      }
      const request = requestsByWallet.get(row.walletAddress)?.get(row.id);
      if (request) {
        const context = contexts.get(row.id) ?? {
          marketCap: null,
          tokenAgeSeconds: null,
        };
        snapshots.set(
          row.id,
          withTokenEntryContext(accumulator.snapshot(request.tokenAddress, row), context),
        );
      }
      accumulator.apply(row);
    }
  }

  for (let walletIndex = 0; walletIndex < wallets.length; walletIndex += 1) {
    const walletAddress = wallets[walletIndex];
    const walletRequests =
      requestsByWallet.get(walletAddress) ?? new Map<number, WalletEventFeatureRequest>();
    for (const request of walletRequests.values()) {
      if (!snapshots.has(request.tradeId)) {
        snapshots.set(
          request.tradeId,
          readPreEventFeatures(
            database,
            request.walletAddress,
            request.tokenAddress,
            new Date(request.observedTimestamp * 1000).toISOString(),
            request.tradeId,
          ),
        );
      }
    }
    options.onWallet?.(walletIndex + 1, wallets.length, walletAddress);
  }

  return snapshots;
};

export const readWalletFeatureSnapshotsBatch = (
  database: DatabaseSync,
  request: WalletFeatureSnapshotRequest,
): Map<string, WalletFeatureSnapshot> => {
  const chain = request.chain ?? DEFAULT_CHAIN;
  const walletAddresses = [
    ...new Set(request.walletAddresses.map((wallet) => wallet.trim()).filter(Boolean)),
  ];
  if (walletAddresses.length === 0) return new Map();
  const windowEnd = request.asOfTimestamp
    ? parseTimestamp(request.asOfTimestamp, 'feature snapshot cutoff')
    : null;
  if (request.lookbackDays !== null && request.lookbackDays !== undefined) {
    if (!Number.isInteger(request.lookbackDays) || request.lookbackDays <= 0) {
      throw new RangeError('lookbackDays must be a positive integer or null.');
    }
    if (windowEnd === null) {
      throw new Error('asOfTimestamp is required when lookbackDays is specified.');
    }
  }
  const windowStart =
    windowEnd !== null && request.lookbackDays
      ? windowEnd - request.lookbackDays * 24 * 60 * 60
      : null;
  const includePreWindowContext = request.includePreWindowContext ?? true;
  const snapshots = new Map<string, WalletFeatureSnapshot>();

  for (const walletGroup of chunked(walletAddresses, WALLET_QUERY_CHUNK)) {
    const placeholders = walletGroup.map(() => '?').join(', ');
    const predicates = [
      `chain = ?`,
      `wallet_address IN (${placeholders})`,
      `event_type IN ('buy', 'sell')`,
    ];
    const parameters: Array<string | number> = [chain, ...walletGroup];
    if (windowEnd !== null) {
      predicates.push(`observed_timestamp < ?`);
      parameters.push(windowEnd);
    }
    if (windowStart !== null && !includePreWindowContext) {
      predicates.push(`observed_timestamp >= ?`);
      parameters.push(windowStart);
    }
    const rows = database
      .prepare(
        `SELECT id, wallet_address AS walletAddress, event_type AS eventType,
                token_address AS tokenAddress, observed_timestamp AS observedTimestamp,
                cost_usd AS costUsd, buy_cost_usd AS buyCostUsd
         FROM copytrade_trades
         WHERE ${predicates.join(' AND ')}
         ORDER BY wallet_address ASC, observed_timestamp ASC, id ASC`,
      )
      .all(...parameters) as unknown as Array<WalletFeatureTrade & { walletAddress: string }>;

    let activeWallet = '';
    let accumulator = new WalletFeatureAccumulator();
    let rowsExamined = 0;
    let contextRowsExamined = 0;
    let oldestTimestamp: number | null = null;
    let newestTimestamp: number | null = null;
    const finishWallet = (): void => {
      if (!activeWallet || rowsExamined === 0) return;
      const features = currentWalletFeaturesFromSnapshot(accumulator.snapshot(''));
      const decisionMetrics = accumulator.decisionCompatibilityMetrics();
      snapshots.set(activeWallet, {
        walletAddress: activeWallet,
        features,
        decisionMetrics,
        quality: buildWalletFeatureQuality({
          rowsExamined,
          contextRowsExamined,
          oldestObservedAt: isoTimestamp(oldestTimestamp),
          newestObservedAt: isoTimestamp(newestTimestamp),
          requestedWindowStart: isoTimestamp(windowStart),
          requestedWindowEnd: isoTimestamp(windowEnd),
          features,
          decisionMetrics,
        }),
      });
    };

    for (const row of rows) {
      if (row.walletAddress !== activeWallet) {
        finishWallet();
        activeWallet = row.walletAddress;
        accumulator = new WalletFeatureAccumulator();
        rowsExamined = 0;
        contextRowsExamined = 0;
        oldestTimestamp = null;
        newestTimestamp = null;
      }
      if (includePreWindowContext && windowStart !== null && row.observedTimestamp < windowStart) {
        accumulator.applyPreWindowContext(row);
        contextRowsExamined += 1;
        continue;
      }
      accumulator.apply(row);
      rowsExamined += 1;
      oldestTimestamp = oldestTimestamp ?? row.observedTimestamp;
      newestTimestamp = row.observedTimestamp;
    }
    finishWallet();
  }
  return snapshots;
};

export const readCurrentWalletFeaturesBatch = (
  database: DatabaseSync,
  walletAddresses: string[],
  options: { chain?: string } = {},
): Map<string, CurrentWalletFeatures> => {
  const snapshots = readWalletFeatureSnapshotsBatch(database, {
    walletAddresses,
    trigger: 'current',
    chain: options.chain,
    asOfTimestamp: null,
    lookbackDays: null,
  });
  return new Map(
    [...snapshots].map(([walletAddress, snapshot]) => [walletAddress, snapshot.features]),
  );
};

export const readCurrentWalletFeatures = (
  database: DatabaseSync,
  walletAddress: string,
  options: { chain?: string } = {},
): CurrentWalletFeatures | null =>
  readCurrentWalletFeaturesBatch(database, [walletAddress], options).get(walletAddress) ?? null;
