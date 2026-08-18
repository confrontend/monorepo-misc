import type { DatabaseSync } from 'node:sqlite';
import { median } from './evaluate.js';
import {
  MAX_TARGETS_PER_RUN, alreadyCoveredTradeIds, readAllCopySimulationMatches, runCopySimulationDuneBatch,
  type CopySimulationMatch, type CopySimulationTarget,
} from './copySimulationDune.js';

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
/** Per-wallet sample cap on round trips considered, matching this project's own established
 *  "a few thousand trades is plenty for stable descriptive stats" reasoning (see
 *  src/copytrade/fetch.ts's MAX_REQUESTS_PER_WALLET comment) — keeps Dune query volume bounded
 *  and predictable for a "top 3 traders" feature rather than growing with total history size. */
export const MAX_ROUND_TRIPS_PER_WALLET = 150;

type TradeRow = {
  id: number; walletAddress: string; observedTimestamp: number; eventType: string;
  tokenAddress: string; tokenSymbol: string | null; costUsd: string | null; buyCostUsd: string | null; priceUsd: string | null;
};

type RoundTrip = {
  walletAddress: string; tokenAddress: string; tokenSymbol: string | null;
  buyTradeId: number; buyAt: number; sellTradeId: number; sellAt: number;
  walletReturnRatio: number | null;
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

/** Same "last buy before this sell, per wallet+token" pairing as holdSecondsPerSell in
 *  evaluate.ts, extended to also carry trade ids (needed to build Dune targets) rather than
 *  just the hold duration. Rows must arrive oldest-first per wallet for this to be correct. */
const pairRoundTrips = (rows: TradeRow[]): RoundTrip[] => {
  const lastBuyByWalletToken = new Map<string, { id: number; timestamp: number }>();
  const roundTrips: RoundTrip[] = [];
  for (const row of rows) {
    const key = `${row.walletAddress}|${row.tokenAddress}`;
    if (row.eventType === 'buy') { lastBuyByWalletToken.set(key, { id: row.id, timestamp: row.observedTimestamp }); continue; }
    if (row.eventType !== 'sell') continue;
    const buy = lastBuyByWalletToken.get(key);
    if (!buy) continue; // no resolvable entry — excluded, not zeroed, by simply never appearing here

    const proceeds = parseAmount(row.costUsd);
    const costBasis = parseAmount(row.buyCostUsd);
    const walletReturnRatio = proceeds !== null && costBasis !== null && costBasis > 0 ? (proceeds - costBasis) / costBasis : null;

    roundTrips.push({
      walletAddress: row.walletAddress, tokenAddress: row.tokenAddress, tokenSymbol: row.tokenSymbol,
      buyTradeId: buy.id, buyAt: buy.timestamp, sellTradeId: row.id, sellAt: row.observedTimestamp,
      walletReturnRatio,
    });
  }
  return roundTrips;
};

const readRecentRoundTrips = (
  database: DatabaseSync, walletAddresses: string[], chain: string,
): RoundTrip[] => {
  if (!walletAddresses.length) return [];
  const placeholders = walletAddresses.map(() => '?').join(',');
  const rows = database.prepare(
    `SELECT id, wallet_address AS walletAddress, observed_timestamp AS observedTimestamp, event_type AS eventType,
            token_address AS tokenAddress, token_symbol AS tokenSymbol, cost_usd AS costUsd, buy_cost_usd AS buyCostUsd,
            price_usd AS priceUsd
     FROM copytrade_trades
     WHERE chain = ? AND wallet_address IN (${placeholders}) AND event_type IN ('buy', 'sell')
     ORDER BY wallet_address ASC, observed_timestamp ASC, id ASC`,
  ).all(chain, ...walletAddresses) as unknown as TradeRow[];

  const byWallet = new Map<string, TradeRow[]>();
  for (const row of rows) {
    const list = byWallet.get(row.walletAddress) ?? [];
    list.push(row);
    byWallet.set(row.walletAddress, list);
  }
  const roundTrips: RoundTrip[] = [];
  for (const walletRows of byWallet.values()) {
    // Most recent MAX_ROUND_TRIPS_PER_WALLET round trips, per wallet — see the constant's
    // own comment. Pairing needs oldest-first order, so slice after pairing, not before.
    const paired = pairRoundTrips(walletRows);
    roundTrips.push(...paired.slice(-MAX_ROUND_TRIPS_PER_WALLET));
  }
  return roundTrips;
};

/** Upper bound on how many Dune batches one call to runCopySimulationBatch will submit. Exists
 *  only as a runaway guard — at MAX_TARGETS_PER_RUN=300 this covers 4,500 targets, several
 *  times the ~900 a 3-wallet, 150-round-trip-per-wallet scope ever needs, so it should never
 *  actually bind for this feature's current scope. If it ever does, `exhausted: true` tells the
 *  caller there is still more to do, rather than silently understating how much was covered. */
const MAX_BATCHES_PER_CALL = 15;

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
  options: { walletAddresses: string[]; chain?: string; copierDelaySeconds?: number },
): Promise<{ runIds: number[]; targetsSubmitted: number; batchesRun: number; exhausted: boolean }> => {
  const chain = options.chain ?? 'sol';
  const delaySeconds = options.copierDelaySeconds ?? DEFAULT_COPIER_DELAY_SECONDS;
  const roundTrips = readRecentRoundTrips(database, options.walletAddresses, chain);
  const covered = alreadyCoveredTradeIds(database);

  const targets: CopySimulationTarget[] = [];
  const seenTradeIds = new Set<number>();
  for (const trip of roundTrips) {
    for (const [tradeId, timestamp] of [[trip.buyTradeId, trip.buyAt], [trip.sellTradeId, trip.sellAt]] as const) {
      if (covered.has(tradeId) || seenTradeIds.has(tradeId)) continue;
      seenTradeIds.add(tradeId);
      targets.push({
        tradeId, tokenAddress: trip.tokenAddress,
        delayedTargetAtIso: new Date((timestamp + delaySeconds) * 1000).toISOString(),
      });
    }
  }
  if (!targets.length) return { runIds: [], targetsSubmitted: 0, batchesRun: 0, exhausted: false };

  const runIds: number[] = [];
  let submitted = 0;
  let batchesRun = 0;
  while (submitted < targets.length && batchesRun < MAX_BATCHES_PER_CALL) {
    const batch = targets.slice(submitted, submitted + MAX_TARGETS_PER_RUN);
    const { runId } = await runCopySimulationDuneBatch(database, batch);
    runIds.push(runId);
    submitted += batch.length;
    batchesRun += 1;
  }
  return { runIds, targetsSubmitted: submitted, batchesRun, exhausted: submitted < targets.length };
};

export type CopySimulationTradeResult = {
  tokenAddress: string; tokenSymbol: string | null;
  walletReturnPercent: number | null; simulatedReturnPercent: number | null;
  status: 'simulated' | 'missing_entry_match' | 'missing_exit_match' | 'not_yet_queried';
  entryGapSeconds: number | null; exitGapSeconds: number | null;
  /** Two GMGN transactions per round trip (buy + sell), each paying the fixed gas priority
   *  fee — null unless the round trip was actually simulated (a trade that was never or could
   *  not be copied never paid this). Kept in SOL, separate from simulatedReturnPercent, on
   *  purpose — see DEFAULT_GAS_PRIORITY_FEE_SOL's own comment for why. */
  gasFeeSol: number | null;
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
  /** simulatedMedian - walletMedian, both computed on the same copiedTrades subset — isolates
   *  the delay+fees+slippage effect from sample-composition differences. */
  delayCostPercentagePoints: number | null;
  worstSimulatedReturnPercent: number | null;
  /** Sum of gasFeeSol across every copied round trip — a real cost this feature's own
   *  percentage-return figures cannot show, reported in the same unit GMGN's docs use. */
  totalGasFeeSol: number | null;
  trades: CopySimulationTradeResult[];
};

export type CopySimulationReport = {
  computedAt: string;
  assumptions: {
    copierDelaySeconds: number; feeBps: number; slippageBps: number; gasPriorityFeeSolPerTx: number;
    maxMatchGapSeconds: number; maxRoundTripsPerWallet: number;
  };
  wallets: CopySimulationWalletReport[];
};

/** Same reliability threshold this project already uses for pattern-group verdicts
 *  (MIN_RELIABLE_SAMPLE in src/db/patterns.ts) — reused here rather than inventing a second
 *  number, per the feature's own validity rule: "don't label a band good/bad until enough
 *  observations." A band below this count still reports its raw stats, just flagged
 *  unreliable, so the numbers stay visible rather than hidden. */
export const MIN_LIQUIDITY_BAND_SAMPLE = 10;

/** Linear-interpolated quantile of an already-sorted ascending array. */
const quantile = (sortedValues: number[], q: number): number => {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0]!;
  const pos = (sortedValues.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const lower = sortedValues[base]!;
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
  const byBand = new Map<LiquidityBand, Array<CopySimulationTradeResult & { entryTradeAmountUsd: number }>>();
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
    const simulatedReturns = simulated.map((trade) => trade.simulatedReturnPercent).filter((v): v is number => v !== null);
    const walletReturns = simulated.map((trade) => trade.walletReturnPercent).filter((v): v is number => v !== null);
    const delayCosts = simulated
      .filter((trade) => trade.simulatedReturnPercent !== null && trade.walletReturnPercent !== null)
      .map((trade) => round(trade.simulatedReturnPercent! - trade.walletReturnPercent!, 2));
    const wins = simulatedReturns.filter((r) => r > 0).length;

    return {
      band,
      minEntryTradeAmountUsd: amounts.length ? round(Math.min(...amounts), 2) : 0,
      maxEntryTradeAmountUsd: amounts.length ? round(Math.max(...amounts), 2) : 0,
      tradeCount: bandTrades.length,
      simulatedCount: simulated.length,
      missedCount,
      winRatePercent: simulatedReturns.length ? round((wins / simulatedReturns.length) * 100, 1) : null,
      medianSimulatedReturnPercent: median(simulatedReturns),
      medianWalletReturnPercent: median(walletReturns),
      medianDelayCostPercentagePoints: median(delayCosts),
      missedTradeRatePercent: bandTrades.length ? round((missedCount / bandTrades.length) * 100, 1) : null,
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
  report: CopySimulationReport, now = new Date(),
): LiquidityImpactReport => {
  const allTrades = report.wallets.flatMap((wallet) => wallet.trades);
  const bandable = allTrades.filter((trade) => trade.entryTradeAmountUsd !== null) as
    Array<CopySimulationTradeResult & { entryTradeAmountUsd: number }>;
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
  const bandOf = (amount: number): LiquidityBand => (amount <= lowUpper ? 'low' : amount <= highLower ? 'medium' : 'high');

  const bands = computeBandStats(bandable, bandOf);
  const byWallet: WalletLiquidityConcentration[] = report.wallets.map((wallet) => {
    const walletBandable = wallet.trades.filter((trade) => trade.entryTradeAmountUsd !== null) as
      Array<CopySimulationTradeResult & { entryTradeAmountUsd: number }>;
    return { walletAddress: wallet.walletAddress, bands: computeBandStats(walletBandable, bandOf) };
  });

  return { ...base, bands, byWallet };
};

export const computeCopySimulationReport = (
  database: DatabaseSync,
  options: { walletAddresses: string[]; chain?: string; copierDelaySeconds?: number; feeBps?: number; slippageBps?: number; gasPriorityFeeSolPerTx?: number; now?: Date },
): CopySimulationReport => {
  const chain = options.chain ?? 'sol';
  const delaySeconds = options.copierDelaySeconds ?? DEFAULT_COPIER_DELAY_SECONDS;
  const feeBps = options.feeBps ?? DEFAULT_FEE_BPS;
  const slippageBps = options.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const gasPriorityFeeSolPerTx = options.gasPriorityFeeSolPerTx ?? DEFAULT_GAS_PRIORITY_FEE_SOL;
  const now = options.now ?? new Date();

  const roundTrips = readRecentRoundTrips(database, options.walletAddresses, chain);
  const matches = readAllCopySimulationMatches(database);

  const gapFor = (match: CopySimulationMatch | undefined, eventTimestamp: number): number | null => {
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

  const wallets: CopySimulationWalletReport[] = options.walletAddresses.map((walletAddress) => {
    const trips = byWallet.get(walletAddress) ?? [];
    const tradeResults: CopySimulationTradeResult[] = [];
    const simulatedRatiosOrdered: Array<{ sellAt: number; ratio: number }> = [];
    // Collected only for trips that actually got simulated, so the wallet's own median below is
    // computed on the same population as simulatedMedianReturnPercent — see the type's own
    // comment for why comparing against every roundTripsConsidered instead would be misleading.
    const walletReturnPercentsOnCopiedTrips: number[] = [];

    for (const trip of trips) {
      const entryMatch = matches.get(trip.buyTradeId);
      const exitMatch = matches.get(trip.sellTradeId);
      const entryGap = gapFor(entryMatch, trip.buyAt);
      const exitGap = gapFor(exitMatch, trip.sellAt);
      const walletReturnPercent = trip.walletReturnRatio !== null ? round(trip.walletReturnRatio * 100, 2) : null;

      const entryTradeAmountUsd = entryMatch?.matchedTradeAmountUsd ?? null;
      const exitTradeAmountUsd = exitMatch?.matchedTradeAmountUsd ?? null;

      if (!entryMatch && !exitMatch) {
        tradeResults.push({ tokenAddress: trip.tokenAddress, tokenSymbol: trip.tokenSymbol, walletReturnPercent, simulatedReturnPercent: null, status: 'not_yet_queried', entryGapSeconds: null, exitGapSeconds: null, gasFeeSol: null, entryTradeAmountUsd: null, exitTradeAmountUsd: null });
        continue;
      }
      const entryUsable = entryMatch?.status === 'matched' && entryGap !== null && Math.abs(entryGap) <= MAX_MATCH_GAP_SECONDS;
      const exitUsable = exitMatch?.status === 'matched' && exitGap !== null && Math.abs(exitGap) <= MAX_MATCH_GAP_SECONDS;
      if (!entryUsable) {
        tradeResults.push({ tokenAddress: trip.tokenAddress, tokenSymbol: trip.tokenSymbol, walletReturnPercent, simulatedReturnPercent: null, status: 'missing_entry_match', entryGapSeconds: entryGap, exitGapSeconds: exitGap, gasFeeSol: null, entryTradeAmountUsd, exitTradeAmountUsd });
        continue;
      }
      if (!exitUsable) {
        tradeResults.push({ tokenAddress: trip.tokenAddress, tokenSymbol: trip.tokenSymbol, walletReturnPercent, simulatedReturnPercent: null, status: 'missing_exit_match', entryGapSeconds: entryGap, exitGapSeconds: exitGap, gasFeeSol: null, entryTradeAmountUsd, exitTradeAmountUsd });
        continue;
      }

      const entryPrice = entryMatch!.matchedPriceUsd! * (1 + (feeBps + slippageBps) / 10_000);
      const exitPrice = exitMatch!.matchedPriceUsd! * (1 - (feeBps + slippageBps) / 10_000);
      const simulatedRatio = entryPrice > 0 ? (exitPrice - entryPrice) / entryPrice : null;
      if (simulatedRatio === null) {
        tradeResults.push({ tokenAddress: trip.tokenAddress, tokenSymbol: trip.tokenSymbol, walletReturnPercent, simulatedReturnPercent: null, status: 'missing_entry_match', entryGapSeconds: entryGap, exitGapSeconds: exitGap, gasFeeSol: null, entryTradeAmountUsd, exitTradeAmountUsd });
        continue;
      }
      simulatedRatiosOrdered.push({ sellAt: trip.sellAt, ratio: simulatedRatio });
      if (walletReturnPercent !== null) walletReturnPercentsOnCopiedTrips.push(walletReturnPercent);
      // One GMGN transaction to copy the buy, one to copy the sell — two gas payments per
      // round trip, not one.
      const gasFeeSol = round(gasPriorityFeeSolPerTx * 2, 6);
      tradeResults.push({
        tokenAddress: trip.tokenAddress, tokenSymbol: trip.tokenSymbol, walletReturnPercent,
        simulatedReturnPercent: round(simulatedRatio * 100, 2), status: 'simulated',
        entryGapSeconds: entryGap, exitGapSeconds: exitGap, gasFeeSol,
        entryTradeAmountUsd, exitTradeAmountUsd,
      });
    }

    const walletMedianReturnPercent = median(walletReturnPercentsOnCopiedTrips);
    const simulatedPercents = simulatedRatiosOrdered.map((s) => s.ratio * 100);
    const simulatedMedianReturnPercent = median(simulatedPercents);
    const totalGasFeeSol = simulatedRatiosOrdered.length > 0 ? round(simulatedRatiosOrdered.length * gasPriorityFeeSolPerTx * 2, 6) : null;
    const coverageRatePercent = trips.length > 0 ? round((simulatedRatiosOrdered.length / trips.length) * 100, 1) : null;

    return {
      walletAddress,
      coverageRatePercent,
      roundTripsConsidered: trips.length,
      copiedTrades: simulatedRatiosOrdered.length,
      missedTrades: trips.length - simulatedRatiosOrdered.length,
      walletMedianReturnPercent,
      simulatedMedianReturnPercent,
      totalGasFeeSol,
      delayCostPercentagePoints: walletMedianReturnPercent !== null && simulatedMedianReturnPercent !== null
        ? round(simulatedMedianReturnPercent - walletMedianReturnPercent, 2) : null,
      worstSimulatedReturnPercent: simulatedPercents.length ? round(Math.min(...simulatedPercents), 2) : null,
      trades: tradeResults,
    };
  });

  return {
    computedAt: now.toISOString(),
    assumptions: {
      copierDelaySeconds: delaySeconds, feeBps, slippageBps, gasPriorityFeeSolPerTx,
      maxMatchGapSeconds: MAX_MATCH_GAP_SECONDS, maxRoundTripsPerWallet: MAX_ROUND_TRIPS_PER_WALLET,
    },
    wallets,
  };
};
