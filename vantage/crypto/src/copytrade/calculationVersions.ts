import { CACHE_VERSIONS } from '../platform/cache/cacheVersions.js';
import { WALLET_FEATURE_ENGINE_VERSION } from './features/walletFeatureDefinitions.js';

/** Version of the provenance contract itself. */
export const CALCULATION_MANIFEST_VERSION = 'calculation-provenance-v1' as const;

/** Periods supported by the point-in-time evidence contract. */
export const SUPPORTED_EVIDENCE_PERIOD_DAYS = [30, 60, 90] as const;
export type EvidencePeriodDays = (typeof SUPPORTED_EVIDENCE_PERIOD_DAYS)[number];

export type CalculationSource =
  'raw_activity' | 'official_gmgn_30d' | 'dune_delayed_copy' | 'derived' | 'mixed';

/**
 * Stable calculation and schema identifiers used by new evidence-producing code.
 *
 * The existing low-level constants are deliberately imported only from dependency-free
 * modules. In particular, this module does not import the Decision Lab, Pattern Discovery, or
 * simulation implementations, so those implementations can adopt this contract later without
 * creating a cycle.
 */
export const CALCULATION_VERSION_MANIFEST = {
  manifestVersion: CALCULATION_MANIFEST_VERSION,
  walletFeatures: {
    version: WALLET_FEATURE_ENGINE_VERSION,
    source: 'raw_activity',
    pointInTime: true,
  },
  copyability: {
    // This is the current Decision Lab cache/scoring version. It intentionally preserves the
    // cache-family prefix because that is the persisted identifier currently in use.
    version: CACHE_VERSIONS.decisionLab,
    inputFeatureVersion: WALLET_FEATURE_ENGINE_VERSION,
    patternDiscoveryVersion: CACHE_VERSIONS.patternDiscovery,
    source: 'mixed',
    pointInTime: true,
  },
  delayedCopyOutcomes: {
    version: CACHE_VERSIONS.copySimulation,
    source: 'dune_delayed_copy',
    pointInTime: true,
  },
  patternDiscovery: {
    version: CACHE_VERSIONS.patternDiscovery,
    normalizedSchemaVersion: 'normalized-v1',
    featureAllowlistVersion: 'gmgn-v4-historical-context',
    source: 'mixed',
    pointInTime: true,
  },
  pitPolicy: {
    version: 'pit-exclusive-cutoff-v1',
    cutoffRule: 'observed_timestamp < asOfTimestamp',
    timestampPrecision: 'whole_utc_seconds',
    windowSemantics: 'inclusive_start_exclusive_end',
    source: 'derived',
    pointInTime: true,
  },
  evidenceSnapshot: {
    version: 'wallet-evidence-snapshot-v1',
    namespaces: ['activity', 'officialGmgn', 'delayedCopy', 'provenance'] as const,
    source: 'derived',
    pointInTime: true,
  },
} as const;

/** Convenient lookup for callers that only need the version identifier. */
export const CALCULATION_VERSIONS = {
  walletFeatures: CALCULATION_VERSION_MANIFEST.walletFeatures.version,
  copyability: CALCULATION_VERSION_MANIFEST.copyability.version,
  delayedCopyOutcomes: CALCULATION_VERSION_MANIFEST.delayedCopyOutcomes.version,
  patternDiscovery: CALCULATION_VERSION_MANIFEST.patternDiscovery.version,
  pitPolicy: CALCULATION_VERSION_MANIFEST.pitPolicy.version,
  evidenceSnapshot: CALCULATION_VERSION_MANIFEST.evidenceSnapshot.version,
} as const;

export type CalculationFamily = keyof typeof CALCULATION_VERSIONS;

export type CalculationProvenance = Readonly<{
  manifestVersion: typeof CALCULATION_MANIFEST_VERSION;
  calculation: CalculationFamily;
  calculationVersion: (typeof CALCULATION_VERSIONS)[CalculationFamily];
  source: CalculationSource;
  asOfTimestamp: string | null;
  periodDays: EvidencePeriodDays | null;
  sourceDataRevision: number | null;
}>;

export type CalculationProvenanceOptions = Readonly<{
  source?: CalculationSource;
  asOfTimestamp?: string | null;
  periodDays?: EvidencePeriodDays | null;
  sourceDataRevision?: number | null;
}>;

export type ProvenancedResult<TResult> = Readonly<{
  result: TResult;
  provenance: CalculationProvenance;
}>;

const DEFAULT_SOURCES: { readonly [TFamily in CalculationFamily]: CalculationSource } = {
  walletFeatures: CALCULATION_VERSION_MANIFEST.walletFeatures.source,
  copyability: CALCULATION_VERSION_MANIFEST.copyability.source,
  delayedCopyOutcomes: CALCULATION_VERSION_MANIFEST.delayedCopyOutcomes.source,
  patternDiscovery: CALCULATION_VERSION_MANIFEST.patternDiscovery.source,
  pitPolicy: CALCULATION_VERSION_MANIFEST.pitPolicy.source,
  evidenceSnapshot: CALCULATION_VERSION_MANIFEST.evidenceSnapshot.source,
};

/** Narrow a runtime period value without silently accepting unsupported windows. */
export const isEvidencePeriodDays = (value: number): value is EvidencePeriodDays =>
  SUPPORTED_EVIDENCE_PERIOD_DAYS.includes(value as EvidencePeriodDays);

export const requireEvidencePeriodDays = (value: number): EvidencePeriodDays => {
  if (!isEvidencePeriodDays(value)) {
    throw new RangeError(`Unsupported evidence period: ${value}. Expected 30, 60, or 90 days.`);
  }
  return value;
};

export const calculationProvenanceFor = <TFamily extends CalculationFamily>(
  calculation: TFamily,
  options: CalculationProvenanceOptions = {},
): CalculationProvenance & { calculation: TFamily } => ({
  manifestVersion: CALCULATION_MANIFEST_VERSION,
  calculation,
  calculationVersion: CALCULATION_VERSIONS[calculation],
  source: options.source ?? DEFAULT_SOURCES[calculation],
  asOfTimestamp: options.asOfTimestamp ?? null,
  periodDays: options.periodDays ?? null,
  sourceDataRevision: options.sourceDataRevision ?? null,
});

/** Attach immutable calculation metadata without mutating the calculated value. */
export const attachCalculationProvenance = <TResult, TFamily extends CalculationFamily>(
  result: TResult,
  calculation: TFamily,
  options: CalculationProvenanceOptions = {},
): ProvenancedResult<TResult> & {
  provenance: CalculationProvenance & { calculation: TFamily };
} => ({
  result,
  provenance: calculationProvenanceFor(calculation, options),
});
