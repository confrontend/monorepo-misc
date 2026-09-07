import type { DatabaseSync } from 'node:sqlite';
import { median } from '../scrutiny/evaluate.js';
import { readWalletCoverageRows } from '../screening/fetch.js';
import {
  MAX_TARGETS_PER_RUN,
  alreadyCoveredTradeIds,
  readAllCopySimulationMatches,
  reconcileStuckCopySimulationRuns,
  runCopySimulationDuneBatch,
  type CopySimulationMatch,
  type CopySimulationTarget,
  type DunePollUpdate,
} from './copySimulationDune.js';
import type { WorkflowRunId } from '../data/workflowIds.js';
import {
  aggregateCanonicalCopiedBuyOutcomes,
  type CanonicalCopiedBuyOutcome,
  type CanonicalCopiedBuyDiagnostics,
} from './canonicalCopiedBuyOutcome.js';
import { CALCULATION_MANIFEST_VERSION, CALCULATION_VERSIONS } from '../calculationVersions.js';
import { UNCOPYABLE_TRADE_MAX_HOLD_SECONDS } from './constants.js';
import {
  canonicalizeActivityType,
  TransferAwareInventory,
} from '../accounting/transferInventory.js';
import {
  COPY_PORTFOLIO_MAX_OPEN_POSITIONS,
  COPY_PORTFOLIO_STARTING_CAPITAL_USD,
  COPY_PORTFOLIO_STAKE_USD,
  simulateFixedStakePortfolio,
  type CopySimulationScenario,
  type FixedStakePortfolioReport,
  type FixedStakePortfolioTrade,
} from './fixedStakePortfolio.js';

export {
  COPY_PORTFOLIO_MAX_OPEN_POSITIONS,
  COPY_PORTFOLIO_STARTING_CAPITAL_USD,
  COPY_PORTFOLIO_STAKE_USD,
  simulateFixedStakePortfolio,
};
export type {
  CopySimulationScenario,
  FixedStakePortfolioReport,
  FixedStakePortfolioTrade,
} from './fixedStakePortfolio.js';

/**
 * Historical Copy Simulation: for the top qualifying wallets, estimate what a copier —
 * entering and exiting a fixed number of seconds behind the wallet's own trades — would
 * actually have gotten, using real Dune-observed prices near the delayed timestamp instead of
 * the wallet's own fill price. Cleared by a live density spike before this was built (GO
 * decision, research/prompts/copy-simulation-dune-density-spike.md, 2026-08-16): median match
 * gap was ~1s across every token-age bucket in a 120-trade sample, with occasional multi-minute
 * tails — hence MAX_MATCH_GAP_SECONDS below, not an unbounded "nearest match no matter how far".
 *
 * Entry/exit pairing reuses the exact "last buy before this sell, per wallet+token" heuristic
 * already established and shown in the UI as hold time (see holdSecondsPerSell in evaluate.ts)
 * rather than inventing a second, possibly-disagreeing pairing rule. A sell with no resolvable
 * buy in stored history (position opened before this wallet's capture window began) is excluded
 * and counted as missing, never treated as a zero-return trade.
 *
 * This is a simulation, not a live trading system: it never places an order, connects a wallet,
 * or uses a private key. It answers "how would a copier likely have done," using the wallet's
 * own already-fetched trade history and read-only Dune price data.
 */

export const DEFAULT_COPIER_DELAY_SECONDS = 15;
/** Grounded in the spike's measured gaps (median ~1s, p90 up to 117s, worst-case tail to 471s
 *  for the 1-24h token-age bucket) — comfortably above the p90 so normal matches always clear
 *  it, while still rejecting the rare multi-minute-stale tail rather than silently using it. */
export const MAX_MATCH_GAP_SECONDS = 300;

const isUsableCopyMatch = (
  match: CopySimulationMatch | undefined,
  eventTimestamp: number,
  delaySeconds: number,
): boolean => {
  if (match?.status !== 'matched' || !match.matchedTradeAt) return false;
  const matchedMs = Date.parse(match.matchedTradeAt);
  if (Number.isNaN(matchedMs)) return false;
  return Math.abs(matchedMs / 1000 - (eventTimestamp + delaySeconds)) <= MAX_MATCH_GAP_SECONDS;
};
/** GMGN's own documented copy-trade fee: "One copytrade transaction = buying/selling amount +
 *  Gas priority fee + 1% GMGN handling fee, no other factors." Documented, not assumed — still
 *  configurable per call and always reported alongside results. */
export const DEFAULT_FEE_BPS = 100;
/** Estimated price impact from a same-token copier order landing seconds after the original.
 *  This one genuinely is an assumption (GMGN's docs don't quantify it) — see DEFAULT_FEE_BPS
 *  for the fee that isn't. */
export const DEFAULT_SLIPPAGE_BPS = 50;
/**
 * Also from GMGN's docs, and not folded into the percentage return above on purpose: gas
 * priority fee is a FIXED SOL cost per transaction, not proportional to trade size, so it hits
 * a small position much harder than a large one — exactly the "profitable trades that still
 * lose money to gas" warning GMGN's own docs give. Reported in SOL, not converted to USD: this
 * project has no grounded SOL/USD price source, and inventing a conversion constant would be
 * exactly the kind of unmeasured assumption this feature otherwise avoids. GMGN's docs give a
 * range (0.002-0.006 SOL) and explicitly recommend the low end to avoid gas eating profit; this
 * default uses that recommended low end, not the range's midpoint or a guess.
 */
export const DEFAULT_GAS_PRIORITY_FEE_SOL = 0.002;
/** Tail thresholds are deliberately named constants so the definition is visible in reports
 * and tests rather than being hidden as inline numbers. */
export const TAIL_THRESHOLD_PERCENT = 100;
export const EXTREME_TAIL_THRESHOLD_PERCENT = 300;
type TradeRow = {
  id: number;
  walletAddress: string;
  observedTimestamp: number;
  eventType: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  tokenAmount: string | null;
  costUsd: string | null;
  buyCostUsd: string | null;
  priceUsd: string | null;
  gasUsd: string | null;
};

type RoundTrip = {
  walletAddress: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  buyTradeId: number;
  buyAt: number;
  sellTradeId: number;
  sellAt: number;
  walletReturnRatio: number | null;
  buyCostUsd: number | null;
  buyGasUsd: number | null;
  sellGasUsd: number | null;
  copyFraction: number;
};

type OpenPosition = {
  walletAddress: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  buyTradeId: number;
  buyAt: number;
  remainingFraction: number;
};

const parseAmount = (value: string | null): number | null => {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** FIFO lot pairing with proportional sell allocation. A wallet can sell a position in many
 * fragments; each fragment consumes only its share of the original copied stake. */
const pairRoundTrips = (rows: TradeRow[], openPositions: OpenPosition[] = []): RoundTrip[] => {
  type BuyLot = {
    id: number;
    timestamp: number;
    walletAddress: string;
    tokenAddress: string;
    tokenSymbol: string | null;
    gasUsd: number | null;
    originalAmount: number | null;
    remainingAmount: number | null;
  };
  const buysByWalletToken = new Map<string, BuyLot[]>();
  const inventoryByWallet = new Map<string, TransferAwareInventory>();
  const roundTrips: RoundTrip[] = [];
  for (const row of rows) {
    const key = `${row.walletAddress}|${row.tokenAddress}`;
    const canonicalType = canonicalizeActivityType(row.eventType);
    const inventory = inventoryByWallet.get(row.walletAddress) ?? new TransferAwareInventory();
    inventoryByWallet.set(row.walletAddress, inventory);
    const resolved = inventory.apply(row);
    if (canonicalType === 'buy') {
      const amount = parseAmount(row.tokenAmount);
      const list = buysByWalletToken.get(key) ?? [];
      list.push({
        id: row.id,
        timestamp: row.observedTimestamp,
        walletAddress: row.walletAddress,
        tokenAddress: row.tokenAddress,
        tokenSymbol: row.tokenSymbol,
        gasUsd: row.gasUsd === null ? null : parseAmount(row.gasUsd),
        originalAmount: amount,
        remainingAmount: amount,
      });
      buysByWalletToken.set(key, list);
      continue;
    }
    if (canonicalType !== 'sell') continue;
    const lots = buysByWalletToken.get(key) ?? [];
    if (!lots.length || resolved?.eligible !== true) {
      // Consume known lots even when the sell is excluded, so a later sell cannot reuse inventory
      // that was already sold through an unknown transfer-in position.
      const sellAmount = parseAmount(row.tokenAmount);
      let remaining = sellAmount !== null && sellAmount > 0 ? sellAmount : null;
      for (const buy of lots) {
        if (buy.remainingAmount === null || remaining === null) continue;
        const consumed = Math.min(remaining, buy.remainingAmount);
        buy.remainingAmount -= consumed;
        remaining -= consumed;
        if (remaining <= 1e-9) break;
      }
      continue; // no proven cost basis — excluded, not zeroed
    }

    const proceeds = parseAmount(row.costUsd);
    const costBasis = parseAmount(row.buyCostUsd);
    const walletReturnRatio =
      proceeds !== null && costBasis !== null && costBasis > 0
        ? (proceeds - costBasis) / costBasis
        : null;

    const sellAmount = parseAmount(row.tokenAmount);
    let remainingToAllocate = sellAmount !== null && sellAmount > 0 ? sellAmount : null;
    for (const buy of lots) {
      if (buy.remainingAmount !== null && buy.remainingAmount <= 0) continue;
      const allocation =
        remainingToAllocate === null || buy.remainingAmount === null
          ? 1
          : Math.min(remainingToAllocate, buy.remainingAmount);
      if (allocation <= 0) continue;
      const copyFraction =
        buy.originalAmount !== null && buy.originalAmount > 0
          ? Math.min(1, allocation / buy.originalAmount)
          : 1;
      roundTrips.push({
        walletAddress: row.walletAddress,
        tokenAddress: row.tokenAddress,
        tokenSymbol: row.tokenSymbol,
        buyTradeId: buy.id,
        buyAt: buy.timestamp,
        sellTradeId: row.id,
        sellAt: row.observedTimestamp,
        walletReturnRatio,
        buyCostUsd: costBasis,
        buyGasUsd: buy.gasUsd,
        sellGasUsd: row.gasUsd === null ? null : parseAmount(row.gasUsd),
        copyFraction,
      });
      if (buy.remainingAmount !== null) buy.remainingAmount -= allocation;
      if (remainingToAllocate !== null) {
        remainingToAllocate -= allocation;
        if (remainingToAllocate <= 1e-9) break;
      } else break;
    }
  }
  for (const lots of buysByWalletToken.values()) {
    for (const buy of lots) {
      if (
        buy.originalAmount !== null &&
        buy.originalAmount > 0 &&
        (buy.remainingAmount ?? 0) > 1e-9
      ) {
        openPositions.push({
          walletAddress: buy.walletAddress,
          tokenAddress: buy.tokenAddress,
          tokenSymbol: buy.tokenSymbol,
          buyTradeId: buy.id,
          buyAt: buy.timestamp,
          remainingFraction: Math.min(1, (buy.remainingAmount ?? 0) / buy.originalAmount),
        });
      }
    }
  }
  return roundTrips;
};

const readTradeRows = (
  database: DatabaseSync,
  walletAddresses: string[],
  chain: string,
): TradeRow[] => {
  if (!walletAddresses.length) return [];
  const placeholders = walletAddresses.map(() => '?').join(',');
  return database
    .prepare(
      `SELECT id, wallet_address AS walletAddress, observed_timestamp AS observedTimestamp, event_type AS eventType,
            token_address AS tokenAddress, token_symbol AS tokenSymbol, token_amount AS tokenAmount, cost_usd AS costUsd, buy_cost_usd AS buyCostUsd,
            price_usd AS priceUsd, gas_usd AS gasUsd
     FROM copytrade_trades
     WHERE chain = ? AND wallet_address IN (${placeholders}) AND event_type IN ('buy', 'sell', 'transfer_in')
     ORDER BY wallet_address ASC, observed_timestamp ASC, id ASC`,
    )
    .all(chain, ...walletAddresses) as unknown as TradeRow[];
};

const groupTradeRows = (rows: TradeRow[]): Map<string, TradeRow[]> => {
  const byWallet = new Map<string, TradeRow[]>();
  for (const row of rows) {
    const list = byWallet.get(row.walletAddress) ?? [];
    list.push(row);
    byWallet.set(row.walletAddress, list);
  }
  return byWallet;
};

const readRecentRoundTrips = (
  database: DatabaseSync,
  walletAddresses: string[],
  chain: string,
  periodDays?: number,
  now = new Date(),
): RoundTrip[] => {
  if (!walletAddresses.length) return [];
  const rows = readTradeRows(database, walletAddresses, chain);

  const byWallet = groupTradeRows(rows);
  const roundTrips: RoundTrip[] = [];
  const cutoff =
    periodDays && periodDays > 0 ? now.getTime() / 1000 - periodDays * 24 * 60 * 60 : null;
  // Preserve the caller's wallet order. The SQL query orders rows by address for deterministic
  // pairing, but the fetch queue intentionally passes wallets from lowest to highest activity.
  for (const walletAddress of walletAddresses) {
    const walletRows = byWallet.get(walletAddress);
    if (!walletRows) continue;
    // Pair against complete history first, then select round trips whose sell occurred in the
    // requested window. This keeps a buy before the window as a valid entry.
    const paired = pairRoundTrips(walletRows);
    // Use every locally stored round trip in the requested period. Dune work remains split
    // into bounded, sequential queries below; this is not a per-wallet sample.
    roundTrips.push(...paired.filter((trip) => cutoff === null || trip.sellAt >= cutoff));
  }
  return roundTrips;
};

const readRecentOpenPositions = (
  database: DatabaseSync,
  walletAddresses: string[],
  chain: string,
  periodDays: number | undefined,
  now: Date,
): OpenPosition[] => {
  if (!periodDays || periodDays <= 0 || walletAddresses.length === 0) return [];
  const cutoff = now.getTime() / 1000 - periodDays * 24 * 60 * 60;
  const byWallet = groupTradeRows(readTradeRows(database, walletAddresses, chain));
  const open: OpenPosition[] = [];
  for (const walletAddress of walletAddresses) {
    const walletOpen: OpenPosition[] = [];
    pairRoundTrips(byWallet.get(walletAddress) ?? [], walletOpen);
    open.push(
      ...walletOpen.filter(
        (position) =>
          position.buyAt >= cutoff && position.buyAt <= cutoff + periodDays * 24 * 60 * 60,
      ),
    );
  }
  return open;
};

type CopySimulationTargetPlan = {
  targets: CopySimulationTarget[];
  retryableTargetsBefore: number | null;
  coverageBeforePercent: number | null;
  allTargetIds: Set<number>;
  roundTrips: RoundTrip[];
};

/** Build the exact queue that the Dune runner will submit. Keeping this in one place is
 * important: a report row represents a round trip, but Dune needs separate buy/sell legs
 * (plus cutoff marks for open positions). */
export const planCopySimulationTargets = (
  database: DatabaseSync,
  options: {
    walletAddresses: string[];
    chain: string;
    periodDays?: number;
    copierDelaySeconds: number;
    retryNoMatch?: boolean;
    now?: Date;
    /** Callers that already read these for the same wallets/chain/periodDays/now (e.g.
     *  computeCopySimulationReport) pass them in to skip a second identical SQL read + pairing
     *  pass — at high per-wallet trade volume that pairing pass is not free. Only valid when the
     *  caller's own scope exactly matches these options; runCopySimulationBatch has no such
     *  precomputed values and omits this, falling back to reading them here as before. */
    precomputed?: { roundTrips: RoundTrip[]; openPositions: OpenPosition[] };
  },
): CopySimulationTargetPlan => {
  const now = options.now ?? new Date();
  const roundTrips =
    options.precomputed?.roundTrips ??
    readRecentRoundTrips(database, options.walletAddresses, options.chain, options.periodDays, now);
  const openPositions =
    options.precomputed?.openPositions ??
    readRecentOpenPositions(
      database,
      options.walletAddresses,
      options.chain,
      options.periodDays,
      now,
    );
  const allTargetIds = new Set(roundTrips.flatMap((trip) => [trip.buyTradeId, trip.sellTradeId]));
  const covered = alreadyCoveredTradeIds(database);
  const existingMatches = options.retryNoMatch
    ? readAllCopySimulationMatches(database, allTargetIds)
    : null;
  const targets: CopySimulationTarget[] = [];
  const seenTradeIds = new Set<number>();

  for (const trip of roundTrips) {
    for (const [tradeId, timestamp] of [
      [trip.buyTradeId, trip.buyAt],
      [trip.sellTradeId, trip.sellAt],
    ] as const) {
      const existing = existingMatches?.get(tradeId);
      const retryableNoMatch =
        options.retryNoMatch === true &&
        existing?.status === 'no_trade_in_window' &&
        existing.matchSource !== 'wide_window';
      if ((!retryableNoMatch && covered.has(tradeId)) || seenTradeIds.has(tradeId)) continue;
      seenTradeIds.add(tradeId);
      targets.push({
        tradeId,
        tokenAddress: trip.tokenAddress,
        delayedTargetAtIso: new Date((timestamp + options.copierDelaySeconds) * 1000).toISOString(),
      });
    }
  }

  const cutoffAtIso = now.toISOString();
  for (const position of openPositions) {
    const tradeId = -Math.abs(position.buyTradeId);
    if (covered.has(tradeId) || seenTradeIds.has(tradeId)) continue;
    seenTradeIds.add(tradeId);
    targets.push({
      tradeId,
      tokenAddress: position.tokenAddress,
      delayedTargetAtIso: cutoffAtIso,
      direction: 'before',
    });
  }

  const matchedBefore =
    options.retryNoMatch && existingMatches
      ? roundTrips.filter(
          (trip) =>
            isUsableCopyMatch(
              existingMatches.get(trip.buyTradeId),
              trip.buyAt,
              options.copierDelaySeconds,
            ) &&
            isUsableCopyMatch(
              existingMatches.get(trip.sellTradeId),
              trip.sellAt,
              options.copierDelaySeconds,
            ),
        ).length
      : null;
  return {
    targets,
    retryableTargetsBefore: options.retryNoMatch ? targets.length : null,
    coverageBeforePercent:
      options.retryNoMatch && roundTrips.length > 0 && matchedBefore !== null
        ? Math.round((matchedBefore / roundTrips.length) * 1000) / 10
        : null,
    allTargetIds,
    roundTrips,
  };
};

/**
 * Submits as many Dune batches as it takes to cover every round trip's entry/exit legs that
 * have not already been queried, in one call — originally this only submitted one
 * MAX_TARGETS_PER_RUN-sized batch per call (mirroring measureDuneOutcomes in
 * src/dune/outcomes.ts's one-batch-per-call shape), which meant a user had to click "run" five
 * or six times in a row to cover just 3 wallets, with no indication of how many more clicks
 * were needed. Looping here instead keeps the per-Dune-query size reasonable (still one
 * bounded query at a time, not one giant one) while making "run the simulation" actually mean
 * "run it to completion" from the caller's side.
 */
export const runCopySimulationBatch = async (
  database: DatabaseSync,
  options: {
    walletAddresses: string[];
    chain?: string;
    periodDays?: number;
    copierDelaySeconds?: number;
    shouldStop?: () => boolean;
    retryNoMatch?: boolean;
    searchWindowMinutes?: number;
    workflowRunId?: WorkflowRunId;
    onPlan?: (plan: {
      targetsTotal: number;
      batchesTotal: number;
      retryableTargetsBefore: number | null;
      coverageBeforePercent: number | null;
    }) => void;
    onBatchStart?: (progress: {
      targetsTotal: number;
      targetsProcessed: number;
      batchesRun: number;
      currentBatch: number;
      batchesTotal: number;
      batchTargets: number;
    }) => void;
    onBatchEnd?: (outcome: {
      currentBatch: number;
      batchTargets: number;
      runId: number | null;
      error: string | null;
    }) => void;
    onDuneStatus?: (status: DunePollUpdate) => void;
    onProgress?: (progress: {
      targetsTotal: number;
      targetsProcessed: number;
      batchesRun: number;
      currentBatch: number;
      batchesTotal: number;
    }) => void;
  },
): Promise<{
  runIds: number[];
  targetsSubmitted: number;
  batchesRun: number;
  exhausted: boolean;
  cancelled: boolean;
  targetsTotal: number;
  failedBatches: string[];
  retryableTargetsBefore: number | null;
  retryableTargetsRemaining: number | null;
  coverageBeforePercent: number | null;
  coverageAfterPercent: number | null;
}> => {
  const chain = options.chain ?? 'sol';
  const delaySeconds = options.copierDelaySeconds ?? DEFAULT_COPIER_DELAY_SECONDS;
  // Recover anything that timed out locally but finished on Dune's side before planning new
  // work — otherwise those targets stay counted as "covered" forever and are silently skipped
  // below, which is how two earlier runs permanently lost 300 targets each.
  await reconcileStuckCopySimulationRuns(database);
  const plan = planCopySimulationTargets(database, {
    ...options,
    chain,
    copierDelaySeconds: delaySeconds,
  });
  const { targets, retryableTargetsBefore, coverageBeforePercent, allTargetIds, roundTrips } = plan;
  if (!targets.length) {
    options.onPlan?.({
      targetsTotal: 0,
      batchesTotal: 0,
      retryableTargetsBefore,
      coverageBeforePercent,
    });
    return {
      runIds: [],
      targetsSubmitted: 0,
      batchesRun: 0,
      exhausted: false,
      cancelled: false,
      targetsTotal: 0,
      failedBatches: [],
      retryableTargetsBefore,
      retryableTargetsRemaining: 0,
      coverageBeforePercent,
      coverageAfterPercent: coverageBeforePercent,
    };
  }

  const batchesTotal = Math.ceil(targets.length / MAX_TARGETS_PER_RUN);
  options.onPlan?.({
    targetsTotal: targets.length,
    batchesTotal,
    retryableTargetsBefore,
    coverageBeforePercent,
  });

  const runIds: number[] = [];
  let submitted = 0;
  let batchesRun = 0;
  let cancelled = false;
  const failedBatches: string[] = [];
  // Drain the complete planned queue. MAX_TARGETS_PER_RUN remains a per-query size guard,
  // not a cap on total work. The shared Dune scheduler remains sequential and rate-limited;
  // shouldStop is the user-controlled way to interrupt a long run.
  while (submitted < targets.length) {
    if (options.shouldStop?.()) {
      cancelled = true;
      break;
    }
    const batch = targets.slice(submitted, submitted + MAX_TARGETS_PER_RUN);
    options.onBatchStart?.({
      targetsTotal: targets.length,
      targetsProcessed: submitted,
      batchesRun,
      currentBatch: batchesRun + 1,
      batchesTotal,
      batchTargets: batch.length,
    });
    // One batch failing must not abandon the rest. Targets are ordered by wallet, so batch 1 is
    // essentially the first wallet's trades — letting its Dune timeout propagate meant a single
    // slow query silently cost every remaining batch, which read as "the run stops after the
    // first wallet". Each batch is independently claimed and archived, so skipping past a
    // failure loses only that batch; the failed run row already records why (and keeps its
    // targets protected from an immediate duplicate retry).
    try {
      const { runId } = await runCopySimulationDuneBatch(database, batch, {
        onStatus: options.onDuneStatus,
        shouldStop: options.shouldStop,
        searchWindowMinutes: options.searchWindowMinutes,
        matchSource: options.retryNoMatch ? 'wide_window' : 'precise',
        workflowRunId: options.workflowRunId,
      });
      runIds.push(runId);
      options.onBatchEnd?.({
        currentBatch: batchesRun + 1,
        batchTargets: batch.length,
        runId,
        error: null,
      });
    } catch (error) {
      if (options.shouldStop?.()) {
        cancelled = true;
        break;
      }
      const message = error instanceof Error ? error.message : String(error);
      failedBatches.push(message);
      options.onBatchEnd?.({
        currentBatch: batchesRun + 1,
        batchTargets: batch.length,
        runId: null,
        error: message,
      });
    }
    submitted += batch.length;
    batchesRun += 1;
    options.onProgress?.({
      targetsTotal: targets.length,
      targetsProcessed: submitted,
      batchesRun,
      currentBatch: batchesRun + 1,
      batchesTotal,
    });
  }
  const afterMatches = options.retryNoMatch
    ? readAllCopySimulationMatches(database, allTargetIds)
    : null;
  const matchedAfter =
    options.retryNoMatch && afterMatches
      ? roundTrips.filter(
          (trip) =>
            isUsableCopyMatch(afterMatches.get(trip.buyTradeId), trip.buyAt, delaySeconds) &&
            isUsableCopyMatch(afterMatches.get(trip.sellTradeId), trip.sellAt, delaySeconds),
        ).length
      : null;
  const coverageAfterPercent =
    options.retryNoMatch && allTargetIds.size > 0 && matchedAfter !== null
      ? Math.round((matchedAfter / roundTrips.length) * 1000) / 10
      : null;
  const retryableTargetsRemaining =
    options.retryNoMatch && afterMatches
      ? [...allTargetIds].filter((tradeId) => {
          const match = afterMatches.get(tradeId);
          return match?.status === 'no_trade_in_window' && match.matchSource !== 'wide_window';
        }).length
      : null;
  return {
    runIds,
    targetsSubmitted: submitted,
    batchesRun,
    exhausted: failedBatches.length > 0 || (submitted < targets.length && !cancelled),
    cancelled,
    targetsTotal: targets.length,
    failedBatches,
    retryableTargetsBefore,
    retryableTargetsRemaining,
    coverageBeforePercent,
    coverageAfterPercent,
  };
};

export type CopySimulationTradeResult = {
  /** Local source id for the wallet buy. Used only for point-in-time feature joins. */
  buyTradeId?: number;
  tokenAddress: string;
  tokenSymbol: string | null;
  /** Original wallet round-trip timing, retained for the per-trade audit view. */
  buyAt?: string;
  sellAt?: string;
  sellTradeId?: number;
  holdSeconds?: number;
  walletReturnPercent: number | null;
  simulatedReturnPercent: number | null;
  copyStakeUsd?: number;
  /** Simulated return as a percentage of the wallet's positive return; null for losses or missing data. */
  edgeKeptPercent?: number | null;
  status: 'simulated' | 'missing_entry_match' | 'missing_exit_match' | 'not_yet_queried';
  entryMatchedAt?: string | null;
  exitMatchedAt?: string | null;
  entryGapSeconds: number | null;
  exitGapSeconds: number | null;
  /** Two GMGN transactions per round trip (buy + sell), each paying the fixed gas priority
   *  fee — null unless the round trip was actually simulated (a trade that was never or could
   *  not be copied never paid this). Kept in SOL, separate from simulatedReturnPercent, on
   *  purpose — see DEFAULT_GAS_PRIORITY_FEE_SOL's own comment for why. */
  gasFeeSol: number | null;
  gasFeeUsd?: number | null;
  /** USD size of the real Dune trade matched for entry/exit — a PROXY for local liquidity/
   *  trading activity near the delayed timestamp, not true pool liquidity. GMGN's own
   *  `liquidity` field is live-only with no historical query, so it can't backfill trades that
   *  already happened; this is what's actually available: real, timestamped, and free (same
   *  Dune query, no extra cost). Null whenever the corresponding leg wasn't matched at all. */
  entryTradeAmountUsd: number | null;
  exitTradeAmountUsd: number | null;
};

export type CopySimulationWalletReport = {
  walletAddress: string;
  roundTripsConsidered: number;
  copiedTrades: number;
  missedTrades: number;
  /** copiedTrades / roundTripsConsidered — reported on its own so a high delay-cost or median
   *  swing can be read against how much of the wallet's activity it's actually based on. */
  coverageRatePercent: number | null;
  /** Computed over the SAME copiedTrades subset as simulatedMedianReturnPercent, not every
   *  roundTripsConsidered — Dune's coverage is denser for older/more liquid tokens, so the
   *  missed trades are not a random sample, and comparing against a different population than
   *  the simulated one would confound sample composition with the actual cost of the delay. */
  walletMedianReturnPercent: number | null;
  simulatedMedianReturnPercent: number | null;
  /** Arithmetic mean over the same simulated round trips as the medians. This answers the
   * equal-position-size copier question and is intentionally reported beside, not instead of,
   * the typical (median) outcome. */
  walletMeanReturnPercent: number | null;
  simulatedMeanReturnPercent: number | null;
  tradesAbove100Percent: number;
  tradesAbove300Percent: number;
  bestSimulatedReturnPercent: number | null;
  /** Share of the positive total simulated return contributed by >+100% trades. Null when the
   * total is not positive because the fraction would not be meaningful. */
  tailShareOfMeanPercent: number | null;
  /** simulatedMedian - walletMedian, both computed on the same copiedTrades subset — isolates
   *  the delay+fees+slippage effect from sample-composition differences. */
  delayCostPercentagePoints: number | null;
  worstSimulatedReturnPercent: number | null;
  /** Sum of gasFeeSol across every copied round trip — a real cost this feature's own
   *  percentage-return figures cannot show, reported in the same unit GMGN's docs use. */
  totalGasFeeSol: number | null;
  totalGasFeeUsd?: number | null;
  gasCostComplete?: boolean;
  coverageStatus?:
    | 'fully_covered'
    | 'partially_covered'
    | 'missing_local_history'
    | 'no_dune_match'
    | 'small_sample';
  coverageStatusReason?: string;
  localHistoryTruncated?: boolean;
  localHistoryStopReason?: string | null;
  /** The realistic small-account result using the same delayed Dune prices as the trade stats. */
  portfolio: FixedStakePortfolioReport;
  /** Pure replay inputs exposed once so clients can run amount scenarios without Dune/API calls. */
  replayTrades?: FixedStakePortfolioTrade[];
  /** Exact chronological portfolio rerun after excluding the best copied-buy position. */
  portfolioWithoutBestTradeEndingCapitalUsd?: number | null;
  /** Exact chronological portfolio rerun after excluding sub-60-second copied round trips. */
  portfolioWithoutUncopyableTradesEndingCapitalUsd?: number | null;
  /** Number of simulated round trips excluded by the uncopyable-trade counterfactual. */
  uncopyableTradeCount?: number;
  /** Share of profitable portfolio outcome attributable to the excluded trades. */
  uncopyableProfitDependencyPercent?: number | null;
  trades: CopySimulationTradeResult[];
  /** Leg-level Dune coverage for THIS wallet only, using the exact same definitions as the
   *  report-level pendingDuneTargets/duneNoMatchTargets/duneMatchedTargets fields (see their own
   *  comments) — exposed per wallet so a caller can re-total these over any wallet subset (e.g.
   *  after client-side exclusion filters) and still match what the real Dune submission planner
   *  would do, rather than falling back to a coarser per-round-trip status count that conflates
   *  "leg never queried" with "leg queried, no match" whenever the other leg has data. */
  pendingDuneTargets?: number;
  duneNoMatchTargets?: number;
  duneMatchedTargets?: number;
  /** One auditable diagnostic contract for reducing multiple exits of one buy into one outcome. */
  canonicalCopiedBuyOutcomes?: CanonicalCopiedBuyOutcome[];
  canonicalCopiedBuyDiagnostics?: CanonicalCopiedBuyDiagnostics;
};

export type CopySimulationReport = {
  computedAt: string;
  /** Versioned contract metadata makes the delayed-copy result auditable without changing its
   * legacy assumptions or trade fields. */
  calculationVersions?: typeof CALCULATION_VERSIONS;
  calculationManifestVersion?: typeof CALCULATION_MANIFEST_VERSION;
  /** Total current-period Dune target legs, including matched, no-match, unqueried, and in-flight targets. */
  duneTargetsTotal?: number;
  /** Exact number of unplanned Dune targets from the same planner used by the fetch runner. */
  pendingDuneTargets?: number;
  /** Dune target legs that were actually queried and returned no usable match. */
  duneNoMatchTargets?: number;
  /** Dune target legs with a usable matched price, counted at leg level. */
  duneMatchedTargets?: number;
  assumptions: {
    copierDelaySeconds: number;
    feeBps: number;
    slippageBps: number;
    gasPriorityFeeSolPerTx: number;
    maxMatchGapSeconds: number;
    maxRoundTripsPerWallet: number | null;
    periodDays?: number;
    startingCapitalUsd: number;
    stakePerTradeUsd: number;
    maxOpenPositions: number;
  };
  /** Scenario parameters when this report was explicitly run with a local scenario. */
  scenario?: CopySimulationScenario;
  wallets: CopySimulationWalletReport[];
};

/** Same reliability threshold this project already uses for pattern-group verdicts
 *  (MIN_RELIABLE_SAMPLE in src/db/patterns.ts) — reused here rather than inventing a second
 *  number, per the feature's own validity rule: "don't label a band good/bad until enough
 *  observations." A band below this count still reports its raw stats, just flagged
 *  unreliable, so the numbers stay visible rather than hidden. */
export const MIN_LIQUIDITY_BAND_SAMPLE = 10;
export const MIN_COPY_SIMULATION_SAMPLE = 10;

/** Linear-interpolated quantile of an already-sorted ascending array. */
const quantile = (sortedValues: number[], q: number): number => {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const pos = (sortedValues.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const lower = sortedValues[base];
  const upper = sortedValues[base + 1];
  return upper === undefined ? lower : lower + rest * (upper - lower);
};

export type LiquidityBand = 'low' | 'medium' | 'high';

export type LiquidityBandStats = {
  band: LiquidityBand;
  minEntryTradeAmountUsd: number;
  maxEntryTradeAmountUsd: number;
  /** Every bandable round trip that fell in this band, whether or not it was actually simulated. */
  tradeCount: number;
  simulatedCount: number;
  missedCount: number;
  /** % of simulatedCount with a positive simulatedReturnPercent — null, not 0, when nothing in
   *  the band was ever simulated. */
  winRatePercent: number | null;
  medianSimulatedReturnPercent: number | null;
  medianWalletReturnPercent: number | null;
  /** Per-trade (simulatedReturnPercent - walletReturnPercent), median across the band — same
   *  sign convention as CopySimulationWalletReport.delayCostPercentagePoints, just computed per
   *  trade instead of from two separately-computed medians. */
  medianDelayCostPercentagePoints: number | null;
  missedTradeRatePercent: number | null;
  /** False below MIN_LIQUIDITY_BAND_SAMPLE simulated trades — the caller should show the numbers
   *  but not treat them as a verdict. */
  reliable: boolean;
};

/** A single wallet's own trades re-sliced into the SAME bands (same thresholds) as the
 *  aggregate report — so "small trade" means the same dollar range for every winner, and one
 *  winner's small trades aren't being compared against a different winner's idea of small.
 *  This is what lets a reader see whether a winner's edge survives on their own smaller trades,
 *  not just in aggregate across every winner. */
export type WalletLiquidityConcentration = {
  walletAddress: string;
  bands: LiquidityBandStats[];
};

export type LiquidityImpactReport = {
  computedAt: string;
  /** Explicit per the feature's own validity rules: this is a real, timestamped Dune trade-size
   *  observation near the entry fill, used as a PROXY for local liquidity/trading activity — not
   *  a directly measured pool-liquidity figure. See CopySimulationTradeResult.entryTradeAmountUsd
   *  for why a true historical liquidity figure isn't available at all. */
  dataSource: 'dune_matched_trade_amount_usd';
  measuredVsProxied: 'proxied';
  bandedOnField: 'entryTradeAmountUsd';
  minReliableSample: number;
  totalTradesConsidered: number;
  /** Round trips with no entryTradeAmountUsd at all (entry never matched) — excluded from every
   *  band rather than defaulted into one, per "never treat missing liquidity as zero." */
  unbandableCount: number;
  /** Empty when fewer than 3 bandable trades exist — too few to form even one meaningful split. */
  bands: LiquidityBandStats[];
  /** Same three bands, sliced per wallet using the identical thresholds above. Empty array (not
   *  a missing key) for a wallet with nothing bandable — see computeLiquidityImpactReport. */
  byWallet: WalletLiquidityConcentration[];
};

/** Groups an already-bandable set of trades into low/medium/high and computes each band's
 *  stats — shared by the aggregate report and every per-wallet slice so "low band" means
 *  identically-computed numbers everywhere, just over a different trade set. */
const computeBandStats = (
  trades: Array<CopySimulationTradeResult & { entryTradeAmountUsd: number }>,
  bandOf: (amount: number) => LiquidityBand,
): LiquidityBandStats[] => {
  const byBand = new Map<
    LiquidityBand,
    Array<CopySimulationTradeResult & { entryTradeAmountUsd: number }>
  >();
  for (const trade of trades) {
    const band = bandOf(trade.entryTradeAmountUsd);
    const list = byBand.get(band) ?? [];
    list.push(trade);
    byBand.set(band, list);
  }

  return (['low', 'medium', 'high'] as const).map((band) => {
    const bandTrades = byBand.get(band) ?? [];
    const amounts = bandTrades.map((trade) => trade.entryTradeAmountUsd);
    const simulated = bandTrades.filter((trade) => trade.status === 'simulated');
    const missedCount = bandTrades.length - simulated.length;
    const simulatedReturns = simulated
      .map((trade) => trade.simulatedReturnPercent)
      .filter((v): v is number => v !== null);
    const walletReturns = simulated
      .map((trade) => trade.walletReturnPercent)
      .filter((v): v is number => v !== null);
    const delayCosts = simulated
      .filter(
        (trade) => trade.simulatedReturnPercent !== null && trade.walletReturnPercent !== null,
      )
      .map((trade) => round(trade.simulatedReturnPercent! - trade.walletReturnPercent!, 2));
    const wins = simulatedReturns.filter((r) => r > 0).length;

    return {
      band,
      minEntryTradeAmountUsd: amounts.length ? round(Math.min(...amounts), 2) : 0,
      maxEntryTradeAmountUsd: amounts.length ? round(Math.max(...amounts), 2) : 0,
      tradeCount: bandTrades.length,
      simulatedCount: simulated.length,
      missedCount,
      winRatePercent: simulatedReturns.length
        ? round((wins / simulatedReturns.length) * 100, 1)
        : null,
      medianSimulatedReturnPercent: median(simulatedReturns),
      medianWalletReturnPercent: median(walletReturns),
      medianDelayCostPercentagePoints: median(delayCosts),
      missedTradeRatePercent: bandTrades.length
        ? round((missedCount / bandTrades.length) * 100, 1)
        : null,
      reliable: simulated.length >= MIN_LIQUIDITY_BAND_SAMPLE,
    };
  });
};

/**
 * Purely a re-slice of an already-computed CopySimulationReport by entry-trade USD size — takes
 * no database argument and runs no new query, matching this project's existing
 * computeScreenPassCandidates pattern of separating DB-touching code from pure computation.
 * Bands are data-driven terciles of the bandable population's entryTradeAmountUsd, not guessed
 * fixed dollar thresholds — this project has no established sense of what counts as "low"
 * liquidity for GMGN-observed tokens, so splitting the actual observed distribution into three
 * equal-count groups is more honest than inventing round-number cutoffs. Each band's own
 * min/max is reported so the reader can see exactly what range "low"/"medium"/"high" meant for
 * this particular run, rather than assuming a universal scale.
 *
 * Thresholds are computed once from every wallet's trades combined, then reused unchanged for
 * each wallet's own byWallet slice — a shared scale is what makes "this winner's edge holds up
 * on their own small trades" a meaningful, comparable statement across different winners.
 */
export const computeLiquidityImpactReport = (
  report: CopySimulationReport,
  now = new Date(),
): LiquidityImpactReport => {
  const allTrades = report.wallets.flatMap((wallet) => wallet.trades);
  const bandable = allTrades.filter((trade) => trade.entryTradeAmountUsd !== null) as Array<
    CopySimulationTradeResult & { entryTradeAmountUsd: number }
  >;
  const unbandableCount = allTrades.length - bandable.length;

  const base = {
    computedAt: now.toISOString(),
    dataSource: 'dune_matched_trade_amount_usd' as const,
    measuredVsProxied: 'proxied' as const,
    bandedOnField: 'entryTradeAmountUsd' as const,
    minReliableSample: MIN_LIQUIDITY_BAND_SAMPLE,
    totalTradesConsidered: allTrades.length,
    unbandableCount,
  };

  if (bandable.length < 3) return { ...base, bands: [], byWallet: [] };

  const sortedAmounts = bandable.map((trade) => trade.entryTradeAmountUsd).sort((a, b) => a - b);
  const lowUpper = quantile(sortedAmounts, 1 / 3);
  const highLower = quantile(sortedAmounts, 2 / 3);
  const bandOf = (amount: number): LiquidityBand =>
    amount <= lowUpper ? 'low' : amount <= highLower ? 'medium' : 'high';

  const bands = computeBandStats(bandable, bandOf);
  const byWallet: WalletLiquidityConcentration[] = report.wallets.map((wallet) => {
    const walletBandable = wallet.trades.filter(
      (trade) => trade.entryTradeAmountUsd !== null,
    ) as Array<CopySimulationTradeResult & { entryTradeAmountUsd: number }>;
    return { walletAddress: wallet.walletAddress, bands: computeBandStats(walletBandable, bandOf) };
  });

  return { ...base, bands, byWallet };
};

export const computeCopySimulationReport = (
  database: DatabaseSync,
  options: {
    walletAddresses: string[];
    chain?: string;
    periodDays?: number;
    copierDelaySeconds?: number;
    feeBps?: number;
    slippageBps?: number;
    gasPriorityFeeSolPerTx?: number;
    /** Optional local scenario. Omitted callers retain the canonical $100/$10 baseline. */
    scenario?: CopySimulationScenario;
    /** Maximum simultaneous positions for this replay. Omit for the canonical GMGN baseline. */
    maxOpenPositions?: number;
    now?: Date;
    onMatchIndexProgress?: (progress: {
      completedRuns: number;
      totalRuns: number;
      currentRunId: number | null;
      indexedTradeLegs: number;
    }) => void;
  },
): CopySimulationReport => {
  const chain = options.chain ?? 'sol';
  const delaySeconds = options.copierDelaySeconds ?? DEFAULT_COPIER_DELAY_SECONDS;
  const feeBps = options.feeBps ?? DEFAULT_FEE_BPS;
  const slippageBps = options.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const gasPriorityFeeSolPerTx = options.gasPriorityFeeSolPerTx ?? DEFAULT_GAS_PRIORITY_FEE_SOL;
  const maxOpenPositions = options.maxOpenPositions ?? COPY_PORTFOLIO_MAX_OPEN_POSITIONS;
  const startingCapitalUsd =
    options.scenario?.startingBankrollUsd ?? COPY_PORTFOLIO_STARTING_CAPITAL_USD;
  const stakePerTradeUsd = options.scenario?.copyAmountUsd ?? COPY_PORTFOLIO_STAKE_USD;
  const now = options.now ?? new Date();

  const roundTrips = readRecentRoundTrips(
    database,
    options.walletAddresses,
    chain,
    options.periodDays,
    now,
  );
  const openPositions = readRecentOpenPositions(
    database,
    options.walletAddresses,
    chain,
    options.periodDays,
    now,
  );
  const relevantTradeIds = new Set<number>();
  for (const trip of roundTrips) {
    relevantTradeIds.add(trip.buyTradeId);
    relevantTradeIds.add(trip.sellTradeId);
  }
  for (const position of openPositions) {
    relevantTradeIds.add(position.buyTradeId);
    relevantTradeIds.add(-Math.abs(position.buyTradeId));
  }
  const matches = readAllCopySimulationMatches(
    database,
    relevantTradeIds,
    options.onMatchIndexProgress,
  );
  // This is deliberately the same planner used by the fetch runner. A report trade is one
  // round trip, while the fetch queue contains its separate buy/sell legs and open marks.
  // roundTrips/openPositions are passed in (same wallets/chain/periodDays/now as above) so the
  // planner doesn't re-read and re-pair them from scratch -- at high per-wallet trade volume
  // that second pass was measured costing seconds per call.
  const pendingTargetPlan = planCopySimulationTargets(database, {
    walletAddresses: options.walletAddresses,
    chain,
    periodDays: options.periodDays,
    copierDelaySeconds: delaySeconds,
    now,
    precomputed: { roundTrips, openPositions },
  });
  const coverageByWallet = readWalletCoverageRows(database, chain, options.walletAddresses);

  const gapFor = (
    match: CopySimulationMatch | undefined,
    eventTimestamp: number,
  ): number | null => {
    if (!match?.matchedTradeAt) return null;
    const matchedMs = Date.parse(match.matchedTradeAt);
    if (Number.isNaN(matchedMs)) return null;
    return matchedMs / 1000 - (eventTimestamp + delaySeconds);
  };

  const byWallet = new Map<string, RoundTrip[]>();
  for (const trip of roundTrips) {
    const list = byWallet.get(trip.walletAddress) ?? [];
    list.push(trip);
    byWallet.set(trip.walletAddress, list);
  }
  const openByWallet = new Map<string, OpenPosition[]>();
  for (const position of openPositions) {
    const list = openByWallet.get(position.walletAddress) ?? [];
    list.push(position);
    openByWallet.set(position.walletAddress, list);
  }
  // Lets a per-wallet pending count be derived from the same plan the fetch runner submits from,
  // even though planCopySimulationTargets itself has no notion of "wallet" on its targets.
  const walletForTradeId = new Map<number, string>();
  for (const trip of roundTrips) {
    walletForTradeId.set(trip.buyTradeId, trip.walletAddress);
    walletForTradeId.set(trip.sellTradeId, trip.walletAddress);
  }
  for (const position of openPositions) {
    walletForTradeId.set(-Math.abs(position.buyTradeId), position.walletAddress);
  }
  const pendingByWallet = new Map<string, number>();
  for (const target of pendingTargetPlan.targets) {
    const wallet = walletForTradeId.get(target.tradeId);
    if (!wallet) continue;
    pendingByWallet.set(wallet, (pendingByWallet.get(wallet) ?? 0) + 1);
  }

  let duneNoMatchTargets = 0;
  let duneMatchedTargets = 0;
  const wallets: CopySimulationWalletReport[] = options.walletAddresses.map((walletAddress) => {
    const trips = byWallet.get(walletAddress) ?? [];
    let walletNoMatchTargets = 0;
    let walletMatchedTargets = 0;
    const tradeResults: CopySimulationTradeResult[] = [];
    const simulatedRatiosOrdered: Array<{ sellAt: number; ratio: number }> = [];
    const portfolioTrades: FixedStakePortfolioTrade[] = [];
    const walletOpenPositions = openByWallet.get(walletAddress) ?? [];
    // Collected only for trips that actually got simulated, so the wallet's own median below is
    // computed on the same population as simulatedMedianReturnPercent — see the type's own
    // comment for why comparing against every roundTripsConsidered instead would be misleading.
    const walletReturnPercentsOnCopiedTrips: number[] = [];

    for (const trip of trips) {
      const entryMatch = matches.get(trip.buyTradeId);
      const exitMatch = matches.get(trip.sellTradeId);
      const entryGap = gapFor(entryMatch, trip.buyAt);
      const exitGap = gapFor(exitMatch, trip.sellAt);
      const walletReturnPercent =
        trip.walletReturnRatio !== null ? round(trip.walletReturnRatio * 100, 2) : null;
      const buyAt = new Date(trip.buyAt * 1000).toISOString();
      const sellAt = new Date(trip.sellAt * 1000).toISOString();
      const baseTrade = {
        buyTradeId: trip.buyTradeId,
        sellTradeId: trip.sellTradeId,
        tokenAddress: trip.tokenAddress,
        tokenSymbol: trip.tokenSymbol,
        buyAt,
        sellAt,
        holdSeconds: Math.max(0, trip.sellAt - trip.buyAt),
        walletReturnPercent,
        copyStakeUsd: round(stakePerTradeUsd * trip.copyFraction, 4),
        edgeKeptPercent: null as number | null,
        entryMatchedAt: entryMatch?.matchedTradeAt ?? null,
        exitMatchedAt: exitMatch?.matchedTradeAt ?? null,
      };

      const entryTradeAmountUsd = entryMatch?.matchedTradeAmountUsd ?? null;
      const exitTradeAmountUsd = exitMatch?.matchedTradeAmountUsd ?? null;

      if (!entryMatch && !exitMatch) {
        tradeResults.push({
          ...baseTrade,
          simulatedReturnPercent: null,
          status: 'not_yet_queried',
          entryGapSeconds: null,
          exitGapSeconds: null,
          gasFeeSol: null,
          entryTradeAmountUsd: null,
          exitTradeAmountUsd: null,
        });
        continue;
      }
      const entryUsable = isUsableCopyMatch(entryMatch, trip.buyAt, delaySeconds);
      const exitUsable = isUsableCopyMatch(exitMatch, trip.sellAt, delaySeconds);
      // Count only queried legs that lack a usable Dune result. A round trip with one queried
      // no-match leg and one never-queried leg must not make the latter look like a Dune miss.
      if (entryMatch && entryUsable) {
        duneMatchedTargets += 1;
        walletMatchedTargets += 1;
      } else if (entryMatch) {
        duneNoMatchTargets += 1;
        walletNoMatchTargets += 1;
      }
      if (exitMatch && exitUsable) {
        duneMatchedTargets += 1;
        walletMatchedTargets += 1;
      } else if (exitMatch) {
        duneNoMatchTargets += 1;
        walletNoMatchTargets += 1;
      }
      if (!entryUsable) {
        tradeResults.push({
          ...baseTrade,
          simulatedReturnPercent: null,
          status: 'missing_entry_match',
          entryGapSeconds: entryGap,
          exitGapSeconds: exitGap,
          gasFeeSol: null,
          entryTradeAmountUsd,
          exitTradeAmountUsd,
        });
        continue;
      }
      if (!exitUsable) {
        tradeResults.push({
          ...baseTrade,
          simulatedReturnPercent: null,
          status: 'missing_exit_match',
          entryGapSeconds: entryGap,
          exitGapSeconds: exitGap,
          gasFeeSol: null,
          entryTradeAmountUsd,
          exitTradeAmountUsd,
        });
        continue;
      }

      const entryPrice = entryMatch!.matchedPriceUsd! * (1 + (feeBps + slippageBps) / 10_000);
      const exitPrice = exitMatch!.matchedPriceUsd! * (1 - (feeBps + slippageBps) / 10_000);
      const simulatedRatio = entryPrice > 0 ? (exitPrice - entryPrice) / entryPrice : null;
      if (simulatedRatio === null) {
        tradeResults.push({
          ...baseTrade,
          simulatedReturnPercent: null,
          status: 'missing_entry_match',
          entryGapSeconds: entryGap,
          exitGapSeconds: exitGap,
          gasFeeSol: null,
          entryTradeAmountUsd,
          exitTradeAmountUsd,
        });
        continue;
      }
      simulatedRatiosOrdered.push({ sellAt: trip.sellAt, ratio: simulatedRatio });
      if (walletReturnPercent !== null) walletReturnPercentsOnCopiedTrips.push(walletReturnPercent);
      // One GMGN transaction to copy the buy, one to copy the sell — two gas payments per
      // round trip, not one.
      const gasFeeSol = round(gasPriorityFeeSolPerTx * 2, 6);
      const gasFeeUsd =
        trip.buyGasUsd !== null && trip.sellGasUsd !== null
          ? round(trip.buyGasUsd + trip.sellGasUsd, 2)
          : null;
      portfolioTrades.push({
        id: trip.sellTradeId,
        entryAt: trip.buyAt + delaySeconds,
        exitAt: trip.sellAt + delaySeconds,
        returnRatio: simulatedRatio,
        positionId: trip.buyTradeId,
        copyFraction: trip.copyFraction,
        stakeUsd: stakePerTradeUsd * trip.copyFraction,
        entryGasFeeSol: gasPriorityFeeSolPerTx,
        exitGasFeeSol: gasPriorityFeeSolPerTx,
        entryGasFeeUsd: trip.buyGasUsd,
        exitGasFeeUsd: trip.sellGasUsd,
        gasFeeSol,
        gasFeeUsd,
      });
      tradeResults.push({
        ...baseTrade,
        simulatedReturnPercent: round(simulatedRatio * 100, 2),
        status: 'simulated',
        edgeKeptPercent:
          walletReturnPercent !== null && walletReturnPercent > 0
            ? round(((simulatedRatio * 100) / walletReturnPercent) * 100, 1)
            : null,
        entryGapSeconds: entryGap,
        exitGapSeconds: exitGap,
        gasFeeSol,
        gasFeeUsd,
        entryTradeAmountUsd,
        exitTradeAmountUsd,
      });
    }

    const haircut = (feeBps + slippageBps) / 10_000;
    for (const position of walletOpenPositions) {
      const entryMatch = matches.get(position.buyTradeId);
      const cutoffMatch = matches.get(-Math.abs(position.buyTradeId));
      const entryPrice =
        entryMatch?.status === 'matched' && entryMatch.matchedPriceUsd !== null
          ? entryMatch.matchedPriceUsd * (1 + haircut)
          : null;
      const cutoffPrice =
        cutoffMatch?.status === 'matched' && cutoffMatch.matchedPriceUsd !== null
          ? cutoffMatch.matchedPriceUsd * (1 - haircut)
          : null;
      const cutoffReturnRatio =
        entryPrice !== null && cutoffPrice !== null && entryPrice > 0
          ? (cutoffPrice - entryPrice) / entryPrice
          : null;
      portfolioTrades.push({
        id: -Math.abs(position.buyTradeId),
        positionId: position.buyTradeId,
        entryAt: position.buyAt + delaySeconds,
        exitAt: now.getTime() / 1000,
        returnRatio: 0,
        copyFraction: position.remainingFraction,
        stakeUsd: stakePerTradeUsd * position.remainingFraction,
        entryGasFeeSol: gasPriorityFeeSolPerTx,
        entryGasFeeUsd: null,
        cutoffReturnRatio,
        isOpenAtCutoff: true,
        gasFeeSol: gasPriorityFeeSolPerTx,
        gasFeeUsd: null,
      });
    }

    const walletMedianReturnPercent = median(walletReturnPercentsOnCopiedTrips);
    const simulatedPercents = simulatedRatiosOrdered.map((s) => s.ratio * 100);
    const simulatedMedianReturnPercent = median(simulatedPercents);
    const walletMeanReturnPercent = walletReturnPercentsOnCopiedTrips.length
      ? round(
          walletReturnPercentsOnCopiedTrips.reduce((sum, value) => sum + value, 0) /
            walletReturnPercentsOnCopiedTrips.length,
          2,
        )
      : null;
    const simulatedMeanReturnPercent = simulatedPercents.length
      ? round(
          simulatedPercents.reduce((sum, value) => sum + value, 0) / simulatedPercents.length,
          2,
        )
      : null;
    const totalSimulatedReturn = simulatedPercents.reduce((sum, value) => sum + value, 0);
    const tailReturn = simulatedPercents
      .filter((value) => value > TAIL_THRESHOLD_PERCENT)
      .reduce((sum, value) => sum + value, 0);
    const tailShareOfMeanPercent =
      totalSimulatedReturn > 0 ? round((tailReturn / totalSimulatedReturn) * 100, 1) : null;
    const simulatedTrips = trips.filter((trip) => {
      const result = tradeResults.find(
        (candidate) =>
          candidate.buyTradeId === trip.buyTradeId && candidate.sellTradeId === trip.sellTradeId,
      );
      return result?.status === 'simulated';
    });
    const uniqueBuyIds = new Set(simulatedTrips.map((trip) => trip.buyTradeId));
    const totalGasFeeSol =
      simulatedTrips.length > 0
        ? round((uniqueBuyIds.size + simulatedTrips.length) * gasPriorityFeeSolPerTx, 6)
        : null;
    const simulatedTrades = tradeResults.filter((trade) => trade.status === 'simulated');
    const totalGasFeeUsd =
      simulatedTrips.length > 0 &&
      simulatedTrips.every((trip) => trip.buyGasUsd !== null && trip.sellGasUsd !== null)
        ? round(
            [...uniqueBuyIds].reduce(
              (sum, buyId) =>
                sum + (simulatedTrips.find((trip) => trip.buyTradeId === buyId)?.buyGasUsd ?? 0),
              0,
            ) + simulatedTrips.reduce((sum, trip) => sum + (trip.sellGasUsd ?? 0), 0),
            2,
          )
        : null;
    const coverageRatePercent =
      trips.length > 0 ? round((simulatedRatiosOrdered.length / trips.length) * 100, 1) : null;
    const coverage = coverageByWallet.get(walletAddress);
    const localHistoryTruncated = coverage?.truncated === 1;
    const notQueriedCount = tradeResults.filter(
      (trade) => trade.status === 'not_yet_queried',
    ).length;
    const noMatchCount = tradeResults.filter(
      (trade) => trade.status === 'missing_entry_match' || trade.status === 'missing_exit_match',
    ).length;
    const coverageStatus: CopySimulationWalletReport['coverageStatus'] =
      trips.length < MIN_COPY_SIMULATION_SAMPLE
        ? 'small_sample'
        : localHistoryTruncated
          ? 'missing_local_history'
          : notQueriedCount > 0
            ? 'partially_covered'
            : simulatedRatiosOrdered.length === 0 && noMatchCount > 0
              ? 'no_dune_match'
              : simulatedRatiosOrdered.length === trips.length
                ? 'fully_covered'
                : 'partially_covered';
    const coverageStatusReason =
      coverageStatus === 'small_sample'
        ? `Only ${trips.length} paired trades are available.`
        : coverageStatus === 'missing_local_history'
          ? `GMGN history was truncated${coverage?.stopReason ? ` (${coverage.stopReason})` : ''}; more local trades may be missing.`
          : coverageStatus === 'no_dune_match'
            ? 'Dune was queried, but no usable trade matched the precise window.'
            : coverageStatus === 'partially_covered'
              ? [
                  notQueriedCount > 0
                    ? `${notQueriedCount} trades are still pending Dune.`
                    : 'No trades are pending Dune.',
                  noMatchCount > 0 ? `${noMatchCount} trades have no usable Dune match.` : null,
                ]
                  .filter((detail): detail is string => detail !== null)
                  .join(' ')
              : 'Every paired trade has a usable Dune match.';

    // Keep the canonical one-buy aggregation beside the legacy per-fragment report fields. This
    // is intentionally diagnostic-only for now: changing the existing medians would be a
    // scoring/output behavior change. The shared contract makes the handling of partial exits,
    // missing cost basis, and open positions available to future consumers without re-pairing.
    const canonicalCopiedBuyAggregation = aggregateCanonicalCopiedBuyOutcomes(
      [...new Set(trips.map((trip) => trip.buyTradeId))].map((tradeId) => ({ tradeId })),
      trips.map((trip) => {
        const trade = tradeResults.find(
          (candidate) =>
            candidate.buyTradeId === trip.buyTradeId && candidate.sellTradeId === trip.sellTradeId,
        );
        return {
          sellTradeId: trip.sellTradeId,
          buyTradeId: trip.buyTradeId,
          copyFraction: trip.copyFraction,
          entryMatched: trade?.status === 'simulated' || trade?.status === 'missing_exit_match',
          exitMatched: trade?.status === 'simulated' || trade?.status === 'missing_entry_match',
          simulatedReturnRatio:
            trade?.simulatedReturnPercent === null || trade?.simulatedReturnPercent === undefined
              ? null
              : trade.simulatedReturnPercent / 100,
          walletReturnRatio: trip.walletReturnRatio,
          buyCostUsd: trip.buyCostUsd,
        };
      }),
      walletOpenPositions.map((position) => ({
        buyTradeId: position.buyTradeId,
        remainingFraction: position.remainingFraction,
      })),
    );
    const bestCanonicalOutcome = canonicalCopiedBuyAggregation.outcomes
      .filter((outcome) => outcome.simulatedReturnRatio !== null)
      .sort(
        (left, right) =>
          (right.simulatedReturnRatio ?? -Infinity) - (left.simulatedReturnRatio ?? -Infinity),
      )[0];
    const portfolio = simulateFixedStakePortfolio(portfolioTrades, {
      startingCapitalUsd,
      stakePerTradeUsd,
      maxOpenPositions,
    });
    const portfolioWithoutBestTradeEndingCapitalUsd = bestCanonicalOutcome
      ? simulateFixedStakePortfolio(
          portfolioTrades.filter((trade) => trade.positionId !== bestCanonicalOutcome.buyTradeId),
          { startingCapitalUsd, stakePerTradeUsd, maxOpenPositions },
        ).endingCapitalUsd
      : null;
    const uncopyableTradeIds = new Set(
      tradeResults
        .filter(
          (trade) =>
            trade.status === 'simulated' &&
            trade.sellTradeId !== undefined &&
            trade.holdSeconds !== undefined &&
            trade.holdSeconds <= UNCOPYABLE_TRADE_MAX_HOLD_SECONDS,
        )
        .map((trade) => trade.sellTradeId!),
    );
    const portfolioWithoutUncopyableTradesEndingCapitalUsd = simulateFixedStakePortfolio(
      portfolioTrades.filter((trade) => !uncopyableTradeIds.has(trade.id)),
      { startingCapitalUsd, stakePerTradeUsd, maxOpenPositions },
    ).endingCapitalUsd;
    const portfolioProfitUsd = portfolio.endingCapitalUsd - portfolio.startingCapitalUsd;
    const uncopyableProfitDependencyPercent =
      portfolioProfitUsd > 0
        ? round(
            (Math.max(
              0,
              portfolio.endingCapitalUsd - portfolioWithoutUncopyableTradesEndingCapitalUsd,
            ) /
              portfolioProfitUsd) *
              100,
            1,
          )
        : 0;

    return {
      walletAddress,
      coverageRatePercent,
      roundTripsConsidered: trips.length,
      copiedTrades: simulatedRatiosOrdered.length,
      missedTrades: trips.length - simulatedRatiosOrdered.length,
      walletMedianReturnPercent,
      simulatedMedianReturnPercent,
      walletMeanReturnPercent,
      simulatedMeanReturnPercent,
      tradesAbove100Percent: simulatedPercents.filter((value) => value > TAIL_THRESHOLD_PERCENT)
        .length,
      tradesAbove300Percent: simulatedPercents.filter(
        (value) => value > EXTREME_TAIL_THRESHOLD_PERCENT,
      ).length,
      bestSimulatedReturnPercent: simulatedPercents.length
        ? round(Math.max(...simulatedPercents), 2)
        : null,
      tailShareOfMeanPercent,
      totalGasFeeSol,
      totalGasFeeUsd,
      gasCostComplete: simulatedTrades.every((trade) => trade.gasFeeUsd !== null),
      coverageStatus,
      coverageStatusReason,
      localHistoryTruncated,
      localHistoryStopReason: coverage?.stopReason ?? null,
      portfolio,
      replayTrades: portfolioTrades,
      portfolioWithoutBestTradeEndingCapitalUsd,
      portfolioWithoutUncopyableTradesEndingCapitalUsd,
      uncopyableTradeCount: uncopyableTradeIds.size,
      uncopyableProfitDependencyPercent,
      delayCostPercentagePoints:
        walletMedianReturnPercent !== null && simulatedMedianReturnPercent !== null
          ? round(simulatedMedianReturnPercent - walletMedianReturnPercent, 2)
          : null,
      worstSimulatedReturnPercent: simulatedPercents.length
        ? round(Math.min(...simulatedPercents), 2)
        : null,
      trades: tradeResults,
      pendingDuneTargets: pendingByWallet.get(walletAddress) ?? 0,
      duneNoMatchTargets: walletNoMatchTargets,
      duneMatchedTargets: walletMatchedTargets,
      canonicalCopiedBuyOutcomes: canonicalCopiedBuyAggregation.outcomes,
      canonicalCopiedBuyDiagnostics: canonicalCopiedBuyAggregation.diagnostics,
    };
  });

  return {
    computedAt: now.toISOString(),
    calculationVersions: CALCULATION_VERSIONS,
    calculationManifestVersion: CALCULATION_MANIFEST_VERSION,
    duneTargetsTotal: new Set([
      ...pendingTargetPlan.allTargetIds,
      ...openPositions.map((position) => -Math.abs(position.buyTradeId)),
    ]).size,
    pendingDuneTargets: pendingTargetPlan.targets.length,
    duneNoMatchTargets,
    duneMatchedTargets,
    assumptions: {
      copierDelaySeconds: delaySeconds,
      feeBps,
      slippageBps,
      gasPriorityFeeSolPerTx,
      maxMatchGapSeconds: MAX_MATCH_GAP_SECONDS,
      maxRoundTripsPerWallet: null,
      ...(options.periodDays ? { periodDays: options.periodDays } : {}),
      startingCapitalUsd,
      stakePerTradeUsd,
      maxOpenPositions,
    },
    ...(options.scenario ? { scenario: options.scenario } : {}),
    wallets,
  };
};
