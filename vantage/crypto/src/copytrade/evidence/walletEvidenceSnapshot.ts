import {
  createHistoricalEvidenceContext,
  normalizeEvidenceTimestamp,
  type HistoricalEvidenceCompleteness,
  type HistoricalEvidenceContext,
  type HistoricalEvidenceContextInput,
  type HistoricalEvidenceDateInput,
} from './historicalEvidenceContext.js';

export type EvidenceSourceRevision = number | null;

export type WalletEvidenceNamespaceStatus = 'available' | 'partial' | 'missing';

export type WalletEvidenceNamespace<T> = {
  value: T | null;
  status: WalletEvidenceNamespaceStatus;
  sourceRevision: EvidenceSourceRevision;
  completeness: HistoricalEvidenceCompleteness;
};

export type WalletEvidenceNamespaceInput<T> = {
  value?: T | null;
  status?: WalletEvidenceNamespaceStatus;
  sourceRevision?: EvidenceSourceRevision;
  completeness?: Partial<HistoricalEvidenceCompleteness>;
};

export type WalletEvidenceSourceProvenance = {
  source: string;
  sourceRevision: EvidenceSourceRevision;
  exact: boolean;
  calculationVersion: string | null;
};

export type WalletEvidenceProvenance = {
  contractVersion: 'wallet-evidence-snapshot-v1';
  generatedAt: string;
  activity: WalletEvidenceSourceProvenance;
  officialGmgn: WalletEvidenceSourceProvenance;
  delayedCopy: WalletEvidenceSourceProvenance;
};

export type WalletEvidenceProvenanceInput = {
  contractVersion?: 'wallet-evidence-snapshot-v1';
  generatedAt?: HistoricalEvidenceDateInput;
  activity?: Partial<WalletEvidenceSourceProvenance>;
  officialGmgn?: Partial<WalletEvidenceSourceProvenance>;
  delayedCopy?: Partial<WalletEvidenceSourceProvenance>;
};

export type WalletEvidenceSnapshot<
  TActivity = ReadonlyArray<Record<string, unknown>>,
  TOfficialGmgn = Record<string, unknown>,
  TDelayedCopy = ReadonlyArray<Record<string, unknown>>,
> = {
  walletAddress: string;
  context: HistoricalEvidenceContext;
  activity: WalletEvidenceNamespace<TActivity>;
  officialGmgn: WalletEvidenceNamespace<TOfficialGmgn>;
  delayedCopy: WalletEvidenceNamespace<TDelayedCopy>;
  provenance: WalletEvidenceProvenance;
};

export type BuildWalletEvidenceSnapshotInput<
  TActivity = ReadonlyArray<Record<string, unknown>>,
  TOfficialGmgn = Record<string, unknown>,
  TDelayedCopy = ReadonlyArray<Record<string, unknown>>,
> = {
  walletAddress: string;
  context: HistoricalEvidenceContext | HistoricalEvidenceContextInput;
  activity?: WalletEvidenceNamespaceInput<TActivity>;
  officialGmgn?: WalletEvidenceNamespaceInput<TOfficialGmgn>;
  delayedCopy?: WalletEvidenceNamespaceInput<TDelayedCopy>;
  provenance?: WalletEvidenceProvenanceInput;
};

const isHistoricalEvidenceContext = (
  value: HistoricalEvidenceContext | HistoricalEvidenceContextInput,
): value is HistoricalEvidenceContext =>
  'windowStart' in value && 'exclusiveCutoff' in value && 'asOfTimestamp' in value;

const namespaceCompleteness = (
  context: HistoricalEvidenceContext,
  input: WalletEvidenceNamespaceInput<unknown> | undefined,
): HistoricalEvidenceCompleteness => ({
  ...context.completeness,
  ...(input?.completeness ?? {}),
  coverageStart:
    input?.completeness?.coverageStart === undefined
      ? context.completeness.coverageStart
      : input.completeness.coverageStart,
  coverageEnd:
    input?.completeness?.coverageEnd === undefined
      ? context.completeness.coverageEnd
      : input.completeness.coverageEnd,
});

const buildNamespace = <T>(
  context: HistoricalEvidenceContext,
  input: WalletEvidenceNamespaceInput<T> | undefined,
): WalletEvidenceNamespace<T> => {
  const hasValue = input?.value !== undefined && input.value !== null;
  const status = input?.status ?? (hasValue ? 'available' : 'missing');
  if (status === 'available' && !hasValue) {
    throw new Error('An available evidence namespace must provide a value.');
  }
  if (status !== 'missing' && !hasValue) {
    throw new Error('A partial evidence namespace must provide a value.');
  }
  return {
    value: hasValue ? (input?.value ?? null) : null,
    status,
    sourceRevision: input?.sourceRevision ?? context.sourceRevision,
    completeness: namespaceCompleteness(context, input as WalletEvidenceNamespaceInput<unknown>),
  };
};

const buildSourceProvenance = (
  context: HistoricalEvidenceContext,
  input: Partial<WalletEvidenceSourceProvenance> | undefined,
): WalletEvidenceSourceProvenance => ({
  source: input?.source ?? 'unspecified',
  sourceRevision: input?.sourceRevision ?? context.sourceRevision,
  exact: input?.exact ?? false,
  calculationVersion: input?.calculationVersion ?? null,
});

/**
 * Creates a namespaced wallet evidence snapshot. The builder does not fetch,
 * persist, or derive values; it only normalizes identity and makes provenance
 * explicit so consumers cannot confuse local activity with official GMGN data.
 */
export const buildWalletEvidenceSnapshot = <
  TActivity = ReadonlyArray<Record<string, unknown>>,
  TOfficialGmgn = Record<string, unknown>,
  TDelayedCopy = ReadonlyArray<Record<string, unknown>>,
>(
  input: BuildWalletEvidenceSnapshotInput<TActivity, TOfficialGmgn, TDelayedCopy>,
): WalletEvidenceSnapshot<TActivity, TOfficialGmgn, TDelayedCopy> => {
  const walletAddress = input.walletAddress.trim();
  if (!walletAddress) throw new Error('walletAddress must not be empty.');

  const context = isHistoricalEvidenceContext(input.context)
    ? input.context
    : createHistoricalEvidenceContext(input.context);
  const generatedAt = normalizeEvidenceTimestamp(
    input.provenance?.generatedAt ?? context.asOf,
    'provenance.generatedAt',
  );

  return {
    walletAddress,
    context,
    activity: buildNamespace(context, input.activity),
    officialGmgn: buildNamespace(context, input.officialGmgn),
    delayedCopy: buildNamespace(context, input.delayedCopy),
    provenance: {
      contractVersion: 'wallet-evidence-snapshot-v1',
      generatedAt,
      activity: buildSourceProvenance(context, input.provenance?.activity),
      officialGmgn: buildSourceProvenance(context, input.provenance?.officialGmgn),
      delayedCopy: buildSourceProvenance(context, input.provenance?.delayedCopy),
    },
  };
};

/** Descriptive alias for callers that use the noun as the factory name. */
export const createWalletEvidenceSnapshot = buildWalletEvidenceSnapshot;
