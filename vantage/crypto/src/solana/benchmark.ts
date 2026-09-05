/**
 * Research-only comparison of a Solana delayed-price provider with persisted Dune
 * matches. This module deliberately has no database or network dependency: callers
 * load the immutable Dune rows and provider results, then pass them here.
 */

export type BenchmarkFailureReason =
  | 'TARGET_SLOT_SEARCH_LIMIT_EXCEEDED'
  | 'BLOCK_SCAN_LIMIT_EXCEEDED'
  | 'RPC_TIME_BUDGET_EXCEEDED'
  | 'RPC_HISTORY_UNAVAILABLE'
  | 'ORIGINAL_TRANSACTION_NOT_FOUND'
  | 'TARGET_SLOT_NOT_FOUND'
  | 'NO_MARKET_TRADE_WITHIN_WINDOW'
  | 'TARGET_MINT_NOT_FOUND_IN_TRANSACTION'
  | 'QUOTE_ASSET_NOT_IDENTIFIED'
  | 'NATIVE_SOL_SWAP_AMBIGUOUS'
  | 'UNSUPPORTED_VENUE'
  | 'PARSER_FAILED'
  | 'RPC_RATE_LIMITED'
  | 'RPC_ERROR';

export type BenchmarkLeg = {
  id: string | number;
  walletAddress?: string;
  tokenMint: string;
  direction: 'buy' | 'sell';
  delaySeconds: number;
  targetTimestamp: number;
  dune: BenchmarkObservation | null;
  solana: BenchmarkObservation | null;
  rpcStats?: import('./types.js').SolanaRpcStats;
};

export type BenchmarkObservation = {
  found: boolean;
  timestamp?: number | null;
  gapSeconds?: number | null;
  signature?: string | null;
  slot?: number | null;
  price?: number | null;
  tokenAmount?: number | null;
  quoteAmount?: number | null;
  venue?: string | null;
  parser?: string | null;
  failureReason?: BenchmarkFailureReason;
};

export type BenchmarkFailureSummary = {
  total: number;
  byReason: Partial<Record<BenchmarkFailureReason, number>>;
  byVenue: Record<string, number>;
  byParser: Record<string, number>;
  byDirection: Record<'buy' | 'sell', number>;
  byDelaySeconds: Record<string, number>;
};

export type SolanaDuneBenchmarkReport = {
  sampleSize: number;
  solanaFound: number;
  duneFound: number;
  bothFound: number;
  solanaCoveragePercent: number;
  duneCoveragePercent: number;
  bothFoundPercent: number;
  sameSignature: number;
  sameSignaturePercent: number;
  sameSlot: number;
  sameSlotPercent: number;
  medianAbsolutePriceDifferencePercent: number | null;
  p90AbsolutePriceDifferencePercent: number | null;
  p95AbsolutePriceDifferencePercent: number | null;
  medianTimestampGapDifferenceSeconds: number | null;
  failures: BenchmarkFailureSummary;
  disagreements: Array<{ legId: string | number; priceDifferencePercent: number }>;
  recommendation: 'KEEP_DUNE' | 'SOLANA_RPC_PRIMARY_DUNE_FALLBACK' | 'SOLANA_RPC_REPLACE_DUNE';
};

const finite = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const percent = (value: number, total: number): number =>
  total > 0 ? Math.round((value / total) * 10000) / 100 : 0;

const percentile = (values: number[], p: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return Math.round(sorted[lower] * 100) / 100;
  return (
    Math.round((sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)) * 100) / 100
  );
};

const increment = (record: Record<string, number>, key: string): void => {
  record[key] = (record[key] ?? 0) + 1;
};

export const benchmarkSolanaAgainstDune = (legs: BenchmarkLeg[]): SolanaDuneBenchmarkReport => {
  const sampleSize = legs.length;
  const solanaFound = legs.filter((leg) => leg.solana?.found).length;
  const duneFound = legs.filter((leg) => leg.dune?.found).length;
  const both = legs.filter((leg) => leg.solana?.found && leg.dune?.found);
  const priceDifferences: number[] = [];
  const gapDifferences: number[] = [];
  const disagreements: SolanaDuneBenchmarkReport['disagreements'] = [];
  let sameSignature = 0;
  let sameSlot = 0;

  for (const leg of both) {
    if (leg.solana?.signature && leg.solana.signature === leg.dune?.signature) sameSignature++;
    if (finite(leg.solana?.slot) && leg.solana.slot === leg.dune?.slot) sameSlot++;
    if (finite(leg.solana?.price) && finite(leg.dune?.price) && leg.dune.price !== 0) {
      const difference = Math.abs((leg.solana.price - leg.dune.price) / leg.dune.price) * 100;
      priceDifferences.push(difference);
      disagreements.push({
        legId: leg.id,
        priceDifferencePercent: Math.round(difference * 100) / 100,
      });
    }
    if (finite(leg.solana?.gapSeconds) && finite(leg.dune?.gapSeconds)) {
      gapDifferences.push(Math.abs(leg.solana.gapSeconds - leg.dune.gapSeconds));
    }
  }
  disagreements.sort((a, b) => b.priceDifferencePercent - a.priceDifferencePercent);

  const failures: BenchmarkFailureSummary = {
    total: 0,
    byReason: {},
    byVenue: {},
    byParser: {},
    byDirection: { buy: 0, sell: 0 },
    byDelaySeconds: {},
  };
  for (const leg of legs) {
    const observation = leg.solana;
    if (observation?.found) continue;
    failures.total++;
    if (observation?.failureReason) {
      failures.byReason[observation.failureReason] =
        (failures.byReason[observation.failureReason] ?? 0) + 1;
    }
    increment(failures.byVenue, observation?.venue ?? 'unknown');
    increment(failures.byParser, observation?.parser ?? 'unknown');
    failures.byDirection[leg.direction]++;
    increment(failures.byDelaySeconds, String(leg.delaySeconds));
  }

  // This is deliberately conservative: a report can recommend a fallback only when
  // every sampled leg was found and the observed prices agree tightly with Dune.
  const medianDifference = percentile(priceDifferences, 0.5);
  const recommendation =
    sampleSize > 0 &&
    solanaFound === sampleSize &&
    both.length === sampleSize &&
    medianDifference !== null &&
    medianDifference <= 2 &&
    (percent(sameSignature, sampleSize) >= 80 || percent(sameSlot, sampleSize) >= 95)
      ? 'SOLANA_RPC_PRIMARY_DUNE_FALLBACK'
      : 'KEEP_DUNE';

  return {
    sampleSize,
    solanaFound,
    duneFound,
    bothFound: both.length,
    solanaCoveragePercent: percent(solanaFound, sampleSize),
    duneCoveragePercent: percent(duneFound, sampleSize),
    bothFoundPercent: percent(both.length, sampleSize),
    sameSignature,
    sameSignaturePercent: percent(sameSignature, both.length),
    sameSlot,
    sameSlotPercent: percent(sameSlot, both.length),
    medianAbsolutePriceDifferencePercent: medianDifference,
    p90AbsolutePriceDifferencePercent: percentile(priceDifferences, 0.9),
    p95AbsolutePriceDifferencePercent: percentile(priceDifferences, 0.95),
    medianTimestampGapDifferenceSeconds: percentile(gapDifferences, 0.5),
    failures,
    disagreements: disagreements.slice(0, 20),
    recommendation,
  };
};
