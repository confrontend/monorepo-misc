/**
 * A normalized point-in-time boundary for historical wallet evidence.
 *
 * The cutoff is exclusive: a record observed exactly at `asOf` is not available
 * to a calculation for that observation. This keeps historical feature reads
 * deterministic when several records share a timestamp.
 */

export type HistoricalEvidenceDateInput = string | Date | number;

export type HistoricalEvidenceCompletenessStatus = 'complete' | 'partial' | 'unknown';

export type HistoricalEvidenceCompleteness = {
  status: HistoricalEvidenceCompletenessStatus;
  rowsExamined: number;
  rowsIncluded: number;
  rowsExcluded: number;
  coverageStart: string | null;
  coverageEnd: string | null;
  reason: string | null;
};

export type HistoricalEvidenceCompletenessInput = {
  status?: HistoricalEvidenceCompletenessStatus;
  rowsExamined?: number;
  rowsIncluded?: number;
  rowsExcluded?: number;
  coverageStart?: HistoricalEvidenceDateInput | null;
  coverageEnd?: HistoricalEvidenceDateInput | null;
  reason?: string | null;
};

export type HistoricalEvidenceContext = {
  chain: string;
  /** Canonical ISO timestamp for the observation. */
  asOf: string;
  /** Alias retained for callers that use the database vocabulary. */
  asOfTimestamp: string;
  periodDays: number;
  /** Inclusive lower boundary of the requested historical window. */
  windowStart: string;
  /** Exclusive upper boundary of the requested historical window. */
  exclusiveCutoff: string;
  /** Monotonic source revision when available; null means it was not supplied. */
  sourceRevision: number | null;
  completeness: HistoricalEvidenceCompleteness;
};

export type HistoricalEvidenceContextInput = {
  chain: string;
  asOf?: HistoricalEvidenceDateInput;
  asOfTimestamp?: HistoricalEvidenceDateInput;
  periodDays: number;
  sourceRevision?: number | null;
  completeness?: HistoricalEvidenceCompletenessInput;
};

const MILLISECONDS_PER_DAY = 86_400_000;

const assertNonNegativeInteger = (value: number, field: string): number => {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer.`);
  }
  return value;
};

const parseDateInput = (value: HistoricalEvidenceDateInput, field: string): number => {
  const milliseconds =
    value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new RangeError(`${field} must be a valid date.`);
  return milliseconds;
};

/** Converts supported date inputs to a canonical UTC ISO timestamp. */
export const normalizeEvidenceTimestamp = (
  value: HistoricalEvidenceDateInput,
  field = 'timestamp',
): string => new Date(parseDateInput(value, field)).toISOString();

const normalizeCompleteness = (
  input: HistoricalEvidenceCompletenessInput | undefined,
): HistoricalEvidenceCompleteness => ({
  status: input?.status ?? 'unknown',
  rowsExamined: assertNonNegativeInteger(input?.rowsExamined ?? 0, 'completeness.rowsExamined'),
  rowsIncluded: assertNonNegativeInteger(input?.rowsIncluded ?? 0, 'completeness.rowsIncluded'),
  rowsExcluded: assertNonNegativeInteger(input?.rowsExcluded ?? 0, 'completeness.rowsExcluded'),
  coverageStart:
    input?.coverageStart === null || input?.coverageStart === undefined
      ? null
      : normalizeEvidenceTimestamp(input.coverageStart, 'completeness.coverageStart'),
  coverageEnd:
    input?.coverageEnd === null || input?.coverageEnd === undefined
      ? null
      : normalizeEvidenceTimestamp(input.coverageEnd, 'completeness.coverageEnd'),
  reason: input?.reason ?? null,
});

const resolveAsOf = (input: HistoricalEvidenceContextInput): HistoricalEvidenceDateInput => {
  if (input.asOf !== undefined && input.asOfTimestamp !== undefined) {
    const asOf = normalizeEvidenceTimestamp(input.asOf, 'asOf');
    const asOfTimestamp = normalizeEvidenceTimestamp(input.asOfTimestamp, 'asOfTimestamp');
    if (asOf !== asOfTimestamp)
      throw new Error('asOf and asOfTimestamp must refer to the same instant.');
    return asOf;
  }
  if (input.asOf !== undefined) return input.asOf;
  if (input.asOfTimestamp !== undefined) return input.asOfTimestamp;
  throw new Error('Either asOf or asOfTimestamp is required.');
};

/** Builds a normalized historical evidence context without reading or mutating state. */
export const createHistoricalEvidenceContext = (
  input: HistoricalEvidenceContextInput,
): HistoricalEvidenceContext => {
  const chain = input.chain.trim().toLowerCase();
  if (!chain) throw new Error('chain must not be empty.');
  if (!Number.isInteger(input.periodDays) || input.periodDays <= 0) {
    throw new RangeError('periodDays must be a positive integer.');
  }
  if (input.sourceRevision !== null && input.sourceRevision !== undefined) {
    assertNonNegativeInteger(input.sourceRevision, 'sourceRevision');
  }

  const asOf = normalizeEvidenceTimestamp(resolveAsOf(input), 'asOf');
  const windowStart = new Date(
    parseDateInput(asOf, 'asOf') - input.periodDays * MILLISECONDS_PER_DAY,
  ).toISOString();

  return {
    chain,
    asOf,
    asOfTimestamp: asOf,
    periodDays: input.periodDays,
    windowStart,
    exclusiveCutoff: asOf,
    sourceRevision: input.sourceRevision ?? null,
    completeness: normalizeCompleteness(input.completeness),
  };
};

/** Alias for callers that prefer the normalization verb in the API name. */
export const normalizeHistoricalEvidenceContext = createHistoricalEvidenceContext;

const contextCutoffMilliseconds = (context: HistoricalEvidenceContext): number =>
  parseDateInput(context.exclusiveCutoff, 'context.exclusiveCutoff');

/** True when an observation is strictly earlier than the point-in-time cutoff. */
export const isBeforeExclusiveCutoff = (
  observedAt: HistoricalEvidenceDateInput,
  context: HistoricalEvidenceContext,
): boolean => parseDateInput(observedAt, 'observedAt') < contextCutoffMilliseconds(context);

/** True when an observation belongs to the inclusive-start/exclusive-end window. */
export const isWithinHistoricalEvidenceWindow = (
  observedAt: HistoricalEvidenceDateInput,
  context: HistoricalEvidenceContext,
): boolean => {
  const timestamp = parseDateInput(observedAt, 'observedAt');
  return (
    timestamp >= parseDateInput(context.windowStart, 'context.windowStart') &&
    timestamp < contextCutoffMilliseconds(context)
  );
};

/** Descriptive alias for point-in-time readers. */
export const isPointInTimeIncluded = isWithinHistoricalEvidenceWindow;

/** Returns true for records usable as pre-cutoff context, including older rows. */
export const isAvailableAtPointInTime = isBeforeExclusiveCutoff;
