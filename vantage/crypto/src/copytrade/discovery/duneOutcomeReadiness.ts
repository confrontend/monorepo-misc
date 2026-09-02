import type { DatabaseSync } from 'node:sqlite';
import { computeCopySimulationReport } from '../simulation/copySimulation.js';
import {
  assessPatternDiscoveryHistoryAvailability,
  type PatternDiscoveryHistoryAvailability,
} from './patternDiscoveryAvailability.js';
import {
  readPatternDiscoveryDataFingerprint,
  readPatternDiscoveryCache,
  writePatternDiscoveryCache,
} from './patternDiscovery.js';

export type DuneOutcomeReadiness = PatternDiscoveryHistoryAvailability & {
  minimumCoveragePercent: number;
  targetCount: number;
  matchedTargetCount: number;
  noMatchTargetCount: number;
};

/**
 * The most permissive coverage threshold Pattern Discovery's own grid tries
 * (PATTERN_DISCOVERY_COVERAGE_THRESHOLDS' lowest value). If not even this bar is met, none of
 * the grid's coverage levels can produce a row, so this is the correct precondition floor --
 * not a claim that 50% coverage is itself sufficient for any particular analysis.
 */
const DEFAULT_MINIMUM_COVERAGE_PERCENT = 50;

/** A cheap, deterministic (non-cryptographic) digest of the wallet set for the cache key --
 *  collision risk here only ever costs a spurious cache miss, never a wrong answer, since the
 *  fingerprint+key lookup is exact-match. */
const walletSetDigest = (walletAddresses: string[]): string => {
  const sorted = [...walletAddresses].sort();
  let hash = 0;
  for (const address of sorted.join('|')) hash = (Math.imul(31, hash) + address.charCodeAt(0)) | 0;
  return `${sorted.length}-${(hash >>> 0).toString(36)}`;
};

const duneReadinessCacheKey = (
  chain: string,
  periodDays: number,
  minimumCoveragePercent: number,
  walletAddresses: string[],
): string =>
  `duneOutcomeReadiness:v2:${chain}:${periodDays}:${minimumCoveragePercent}:${walletSetDigest(walletAddresses)}`;

/**
 * The single, period-scoped answer to "does this roster have usable Dune outcome coverage for
 * this exact period." Reuses computeCopySimulationReport (the same round-trip/coverage-rate
 * computation Pattern Discovery's own report is built from) instead of a second, looser
 * approximation -- so this can never disagree with what a report for the same period finds.
 *
 * This is called from every status/coverage/readiness poll (potentially every 1.5s while a
 * workflow is active, from up to 4 endpoints in the same refresh cycle), and
 * computeCopySimulationReport reconstructs full round-trip history for the entire roster --
 * expensive enough at real roster sizes to make the server appear to hang under normal polling
 * if run uncached. Cached behind the same data-fingerprint invalidation already used for Pattern
 * Discovery reports (the fingerprint's own triggers already cover new Dune matches), so repeated
 * polls between actual data changes are a cheap cache hit, not a full recomputation.
 */
export const readDuneOutcomeReadiness = (
  database: DatabaseSync,
  options: {
    walletAddresses: string[];
    chain?: string;
    periodDays: number;
    minimumCoveragePercent?: number;
  },
): DuneOutcomeReadiness => {
  const chain = options.chain ?? 'sol';
  const minimumCoveragePercent = options.minimumCoveragePercent ?? DEFAULT_MINIMUM_COVERAGE_PERCENT;
  const totalWallets = options.walletAddresses.length;

  if (totalWallets === 0) {
    return {
      ...assessPatternDiscoveryHistoryAvailability({
        periodDays: options.periodDays,
        totalWallets: 0,
        coveredWallets: 0,
      }),
      minimumCoveragePercent,
      targetCount: 0,
      matchedTargetCount: 0,
      noMatchTargetCount: 0,
      reason: 'No roster wallets.',
    };
  }

  const cacheKey = duneReadinessCacheKey(
    chain,
    options.periodDays,
    minimumCoveragePercent,
    options.walletAddresses,
  );
  const fingerprint = readPatternDiscoveryDataFingerprint(database);
  const cached = readPatternDiscoveryCache<DuneOutcomeReadiness>(database, cacheKey, fingerprint);
  if (
    cached &&
    cached.targetCount !== undefined &&
    cached.matchedTargetCount !== undefined &&
    cached.noMatchTargetCount !== undefined
  )
    return cached;

  const simulation = computeCopySimulationReport(database, {
    walletAddresses: options.walletAddresses,
    chain,
    periodDays: options.periodDays,
  });
  const coveredWallets = simulation.wallets.filter(
    (wallet) => (wallet.coverageRatePercent ?? 0) >= minimumCoveragePercent,
  ).length;
  const availability = assessPatternDiscoveryHistoryAvailability({
    periodDays: options.periodDays,
    totalWallets,
    coveredWallets,
  });
  const result: DuneOutcomeReadiness = {
    ...availability,
    minimumCoveragePercent,
    targetCount:
      simulation.duneTargetsTotal ??
      (simulation.pendingDuneTargets ?? 0) +
        (simulation.duneMatchedTargets ?? 0) +
        (simulation.duneNoMatchTargets ?? 0),
    matchedTargetCount: simulation.duneMatchedTargets ?? 0,
    noMatchTargetCount: simulation.duneNoMatchTargets ?? 0,
    reason:
      coveredWallets === 0
        ? `No wallet has usable Dune outcome coverage for the ${options.periodDays}-day period yet.`
        : null,
  };
  writePatternDiscoveryCache(database, cacheKey, fingerprint, result);
  return result;
};
