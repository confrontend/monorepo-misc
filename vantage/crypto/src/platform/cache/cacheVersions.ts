/**
 * Single source of truth for persisted report-cache versions.
 * Bump the relevant entry whenever that cache family's calculation or serialized shape changes.
 */
export const CACHE_VERSIONS = {
  patternDiscovery: 'crypto-pattern-discovery-v6-period-aware-coverage-grid',
  decisionLab: 'experimental-decision:decision-lab-scoring-v12-copyability-diagnostics',
  copySimulation: 'copy-simulation-v2',
} as const;

export type CacheFamily = keyof typeof CACHE_VERSIONS;

export const versionedCacheKey = (family: CacheFamily, ...parts: Array<string | number>): string =>
  `${CACHE_VERSIONS[family]}:${parts.join(':')}`;
