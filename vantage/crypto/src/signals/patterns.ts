import type { DatabaseSync } from 'node:sqlite';
import { readAllDuneOutcomes } from '../dune/outcomes.js';

const MIN_RELIABLE_SAMPLE = 10;
const MIN_COVERAGE_PCT = 25;
const MIN_CAPTURE_DATES = 3;
// A comparison is only considered fresh when the matched trade is close enough to
// its intended checkpoint. These limits are deliberately fixed before outcome review;
// otherwise the cutoff could be tuned to make a pattern look better.
export const TRADE_AGE_POLICY = {
  baselineMaxSeconds: 15 * 60,
  targetMaxSeconds: {
    '+5m': 2 * 60,
    '+15m': 5 * 60,
    '+30m': 10 * 60,
    '+1h': 15 * 60,
    '+3h': 30 * 60,
    '+6h': 60 * 60,
    '+24h': 4 * 60 * 60,
    '+7d': 24 * 60 * 60,
  } as Record<string, number>,
} as const;
const DISCLAIMER =
  'Descriptive research only. This summarizes signals already measured; it is not proof that any signal type is profitable or predictive going forward.';
const STALE_NOTE =
  'A "stale" comparison means no new trade happened before this checkpoint, so the last known price was reused instead of a real observation. Stale comparisons are excluded from up %/avg/median below — only genuine new-trade comparisons count toward them.';

export interface SignalPatternGroup {
  key: string;
  n: number;
  nWithData: number;
  nMissing: number;
  nStale: number;
  nFresh: number;
  nDistinctTokens: number;
  nCaptured: number;
  nMatured: number;
  coveragePct: number | null;
  captureDates: number;
  nRepeatedExcluded: number;
  maxBaselineTradeAgeSeconds: number | null;
  maxTargetTradeAgeSeconds: number | null;
  upCount: number;
  upPct: number | null;
  avgReturnPct: number | null;
  medianReturnPct: number | null;
  p25ReturnPct: number | null;
  worstReturnPct: number | null;
  bestReturnPct: number | null;
  verdict: 'insufficient data' | 'promising but fragile' | 'mixed' | 'weak';
  reliable: boolean;
}

export interface SignalPatternHorizonReport {
  horizon: string;
  overall: SignalPatternGroup;
  groups: SignalPatternGroup[];
}

export interface SignalPatternReport {
  computedAt: string;
  method: 'signal-type-return-breakdown-v3';
  groupBy: 'signalType';
  upThreshold: 0;
  minReliableSample: number;
  minCoveragePct: number;
  minCaptureDates: number;
  analysisUnit: 'first-signal-per-token-type';
  tradeAgePolicy: string;
  disclaimer: string;
  staleNote: string;
  horizons: SignalPatternHorizonReport[];
  sourceRunIds: number[];
}

type CheckpointPrice =
  | {
      priceUsd: number | null;
      matchedTradeAt: string | null;
      matchedTradeAgeSeconds?: number | null;
    }
  | undefined;
type Comparison = {
  status: 'missing' | 'stale' | 'fresh';
  returnPct: number | null;
  tokenAddress: string;
  baselineAgeSeconds: number | null;
  targetAgeSeconds: number | null;
};

/**
 * A checkpoint only counts as a genuine ("fresh") observation when a new trade was matched
 * for it beyond the one already used for the signal-time price. If the query fell back to the
 * same last-known trade (no new trading activity in that window), the "0% change" it would
 * otherwise report is an artifact of no data, not evidence the price held steady.
 */
const classifyComparison = (
  base: CheckpointPrice,
  target: CheckpointPrice,
  tokenAddress: string,
  horizon: string,
): Comparison => {
  const baselineAgeSeconds = base?.matchedTradeAgeSeconds ?? null;
  const targetAgeSeconds = target?.matchedTradeAgeSeconds ?? null;
  if (!base || !target || base.priceUsd === null || target.priceUsd === null || base.priceUsd === 0)
    return {
      status: 'missing',
      returnPct: null,
      tokenAddress,
      baselineAgeSeconds,
      targetAgeSeconds,
    };
  const maxTargetAgeSeconds = TRADE_AGE_POLICY.targetMaxSeconds[horizon] ?? Infinity;
  // Older archived runs may not carry the derived age fields. Preserve those rows for
  // audit/backward compatibility; enforce the cutoff whenever the source provides an age.
  if (
    (baselineAgeSeconds !== null &&
      (baselineAgeSeconds < 0 || baselineAgeSeconds > TRADE_AGE_POLICY.baselineMaxSeconds)) ||
    (targetAgeSeconds !== null && (targetAgeSeconds < 0 || targetAgeSeconds > maxTargetAgeSeconds))
  ) {
    return {
      status: 'missing',
      returnPct: null,
      tokenAddress,
      baselineAgeSeconds,
      targetAgeSeconds,
    };
  }
  if (base.matchedTradeAt !== null && base.matchedTradeAt === target.matchedTradeAt)
    return { status: 'stale', returnPct: null, tokenAddress, baselineAgeSeconds, targetAgeSeconds };
  return {
    status: 'fresh',
    returnPct: ((target.priceUsd - base.priceUsd) / base.priceUsd) * 100,
    tokenAddress,
    baselineAgeSeconds,
    targetAgeSeconds,
  };
};

const summarizeGroup = (
  key: string,
  entries: Comparison[],
  nCaptured: number,
  nMatured: number,
  captureDates: number,
  nRepeatedExcluded: number,
): SignalPatternGroup => {
  const nMissing = entries.filter((entry) => entry.status === 'missing').length;
  const nStale = entries.filter((entry) => entry.status === 'stale').length;
  const fresh = entries.filter((entry) => entry.status === 'fresh' && entry.returnPct !== null);
  const freshReturns = fresh.map((entry) => entry.returnPct as number);
  const upCount = freshReturns.filter((value) => value > 0).length;
  const sorted = [...freshReturns].sort((a, b) => a - b);
  const percentile = (fraction: number): number | null =>
    sorted.length
      ? sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1))]
      : null;
  const medianReturnPct = percentile(0.5);
  const avgReturnPct = freshReturns.length
    ? freshReturns.reduce((sum, value) => sum + value, 0) / freshReturns.length
    : null;
  const p25ReturnPct = percentile(0.25);
  const worstReturnPct = sorted.length ? sorted[0] : null;
  const bestReturnPct = sorted.length ? sorted[sorted.length - 1] : null;
  // nMatured is the deduped first-observation population. Repeats never dilute or
  // inflate coverage, and captureDates is supplied from fresh deduped rows only.
  const coveragePct = nMatured ? (freshReturns.length / nMatured) * 100 : null;
  const reliable =
    freshReturns.length >= MIN_RELIABLE_SAMPLE &&
    new Set(fresh.map((entry) => entry.tokenAddress)).size >= MIN_RELIABLE_SAMPLE &&
    (coveragePct ?? 0) >= MIN_COVERAGE_PCT &&
    captureDates >= MIN_CAPTURE_DATES;
  const verdict: SignalPatternGroup['verdict'] = !reliable
    ? 'insufficient data'
    : medianReturnPct !== null &&
        medianReturnPct > 0 &&
        upCount / freshReturns.length >= 0.5 &&
        (avgReturnPct ?? -Infinity) >= 0
      ? 'promising but fragile'
      : medianReturnPct !== null && medianReturnPct > 0 && upCount / freshReturns.length >= 0.5
        ? 'mixed'
        : 'weak';
  return {
    key,
    n: entries.length,
    nWithData: entries.length - nMissing,
    nMissing,
    nStale,
    nFresh: freshReturns.length,
    nDistinctTokens: new Set(fresh.map((entry) => entry.tokenAddress)).size,
    nCaptured,
    nMatured,
    coveragePct,
    captureDates,
    nRepeatedExcluded,
    maxBaselineTradeAgeSeconds:
      Math.max(...fresh.map((entry) => entry.baselineAgeSeconds ?? -Infinity), -Infinity) ===
      -Infinity
        ? null
        : Math.max(...fresh.map((entry) => entry.baselineAgeSeconds ?? -Infinity)),
    maxTargetTradeAgeSeconds:
      Math.max(...fresh.map((entry) => entry.targetAgeSeconds ?? -Infinity), -Infinity) ===
      -Infinity
        ? null
        : Math.max(...fresh.map((entry) => entry.targetAgeSeconds ?? -Infinity)),
    upCount,
    upPct: freshReturns.length ? (upCount / freshReturns.length) * 100 : null,
    avgReturnPct: freshReturns.length
      ? freshReturns.reduce((sum, value) => sum + value, 0) / freshReturns.length
      : null,
    medianReturnPct,
    p25ReturnPct,
    worstReturnPct,
    bestReturnPct,
    verdict,
    reliable,
  };
};

/**
 * Reads only what is already stored locally (gmgn_signals + completed dune_outcome_runs).
 * Never issues a new Dune query. "Up" means return strictly > 0; missing prices and stale
 * (no-new-trade) comparisons are both excluded from the return denominator rather than counted as 0.
 * Groups are ranked by median, not average — a single outlier trade can swing an average by
 * a huge margin while barely moving the median, so median is the more honest "typical outcome."
 */
export const computeSignalPatternReport = (
  database: DatabaseSync,
  now = new Date(),
): SignalPatternReport => {
  const sourceRunIds = (
    database
      .prepare(
        `SELECT id FROM dune_outcome_runs WHERE status = 'completed' AND raw_result IS NOT NULL ORDER BY id ASC`,
      )
      .all() as unknown as Array<{ id: number }>
  ).map((row) => row.id);
  const outcomes = readAllDuneOutcomes(database);
  const horizonLabels = [
    ...new Set(
      outcomes.flatMap((outcome) => outcome.checkpoints.map((checkpoint) => checkpoint.label)),
    ),
  ].filter((label) => label !== 'signal');

  const horizons: SignalPatternHorizonReport[] = horizonLabels.map((horizon) => {
    const byType = new Map<string, Comparison[]>();
    const byTypeCaptured = new Map<string, number>();
    const byTypeMatured = new Map<string, number>();
    const byTypeDates = new Map<string, Set<string>>();
    const byTypeRepeated = new Map<string, number>();
    const overallEntries: Comparison[] = [];
    const firstByTokenType = new Set<string>();
    let overallCaptured = 0;
    let overallMatured = 0;
    let overallRepeated = 0;
    const overallDates = new Set<string>();
    for (const outcome of outcomes) {
      const base = outcome.checkpoints.find((checkpoint) => checkpoint.label === 'signal')?.result;
      const targetCheckpoint = outcome.checkpoints.find(
        (checkpoint) => checkpoint.label === horizon,
      );
      const target = targetCheckpoint?.result;
      const entry = classifyComparison(base, target, outcome.signal.tokenAddress, horizon);
      const key = outcome.signal.signalType ?? 'unknown';
      const targetMs = Date.parse(targetCheckpoint?.targetTimestamp ?? '');
      const matured = !Number.isNaN(targetMs) && targetMs <= now.getTime();
      overallCaptured += 1;
      byTypeCaptured.set(key, (byTypeCaptured.get(key) ?? 0) + 1);
      const tokenTypeKey = `${key}\u0000${outcome.signal.tokenAddress}`;
      if (firstByTokenType.has(tokenTypeKey)) {
        overallRepeated += 1;
        byTypeRepeated.set(key, (byTypeRepeated.get(key) ?? 0) + 1);
        continue;
      }
      firstByTokenType.add(tokenTypeKey);
      if (matured) {
        overallMatured += 1;
        byTypeMatured.set(key, (byTypeMatured.get(key) ?? 0) + 1);
        if (entry.status === 'fresh') {
          overallDates.add(outcome.signal.observedAt.slice(0, 10));
          if (!byTypeDates.has(key)) byTypeDates.set(key, new Set());
          byTypeDates.get(key)!.add(outcome.signal.observedAt.slice(0, 10));
        }
      }
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key)!.push(entry);
      overallEntries.push(entry);
    }
    const groups = [...byType.entries()]
      .map(([key, entries]) =>
        summarizeGroup(
          key,
          entries,
          byTypeCaptured.get(key) ?? 0,
          byTypeMatured.get(key) ?? 0,
          byTypeDates.get(key)?.size ?? 0,
          byTypeRepeated.get(key) ?? 0,
        ),
      )
      .sort((a, b) => (b.medianReturnPct ?? -Infinity) - (a.medianReturnPct ?? -Infinity));
    return {
      horizon,
      overall: summarizeGroup(
        'overall',
        overallEntries,
        overallCaptured,
        overallMatured,
        overallDates.size,
        overallRepeated,
      ),
      groups,
    };
  });

  return {
    computedAt: now.toISOString(),
    method: 'signal-type-return-breakdown-v3',
    groupBy: 'signalType',
    upThreshold: 0,
    minReliableSample: MIN_RELIABLE_SAMPLE,
    minCoveragePct: MIN_COVERAGE_PCT,
    minCaptureDates: MIN_CAPTURE_DATES,
    analysisUnit: 'first-signal-per-token-type',
    tradeAgePolicy: `baseline matched trade <= ${TRADE_AGE_POLICY.baselineMaxSeconds / 60}m; target matched trade <= horizon cutoff; age-invalid comparisons are excluded from fresh returns`,
    disclaimer: DISCLAIMER,
    staleNote: STALE_NOTE,
    horizons,
    sourceRunIds,
  };
};

export interface SignalPatternSnapshot {
  id: number;
  computedAt: string;
  params: {
    groupBy: string;
    upThreshold: number;
    minReliableSample: number;
    minCoveragePct: number;
    minCaptureDates: number;
    analysisUnit: string;
  };
  sourceRunIds: number[];
  report: SignalPatternReport;
}

export const saveSignalPatternSnapshot = (
  database: DatabaseSync,
  report: SignalPatternReport,
): SignalPatternSnapshot => {
  const params = {
    groupBy: report.groupBy,
    upThreshold: report.upThreshold,
    minReliableSample: report.minReliableSample,
    minCoveragePct: report.minCoveragePct,
    minCaptureDates: report.minCaptureDates,
    analysisUnit: report.analysisUnit,
  };
  const inserted = database
    .prepare(
      `
    INSERT INTO signal_pattern_snapshots (computed_at, params_json, source_run_ids_json, report_json) VALUES (?, ?, ?, ?)
  `,
    )
    .run(
      report.computedAt,
      JSON.stringify(params),
      JSON.stringify(report.sourceRunIds),
      JSON.stringify(report),
    );
  return {
    id: Number(inserted.lastInsertRowid),
    computedAt: report.computedAt,
    params,
    sourceRunIds: report.sourceRunIds,
    report,
  };
};

export const listSignalPatternSnapshots = (database: DatabaseSync): SignalPatternSnapshot[] => {
  const rows = database
    .prepare(
      `
    SELECT id, computed_at AS computedAt, params_json AS paramsJson, source_run_ids_json AS sourceRunIdsJson, report_json AS reportJson
    FROM signal_pattern_snapshots ORDER BY id DESC
  `,
    )
    .all() as unknown as Array<{
    id: number;
    computedAt: string;
    paramsJson: string;
    sourceRunIdsJson: string;
    reportJson: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    computedAt: row.computedAt,
    params: JSON.parse(row.paramsJson) as SignalPatternSnapshot['params'],
    sourceRunIds: JSON.parse(row.sourceRunIdsJson) as number[],
    report: JSON.parse(row.reportJson) as SignalPatternReport,
  }));
};

// --- Signal-type x property subgroup breakdown -----------------------------------------
//
// Deliberately limited to two static, structural properties that describe a fixed fact
// about the token rather than a live, drifting one. query_cur_data also carries fast-moving
// snapshot fields (liquidity, volume, holder count, price) captured whenever GMGN happened to
// be queried, not necessarily at the signal timestamp — using those as "conditions at signal
// time" would repeat the same query-time-vs-trigger-time mistake already fixed twice this
// session (stale trades, premature checkpoints). Launch platform and token age at signal time
// are both fixed once the token exists, so they're safe to read from raw_payload as-is.
//
// The raw_payload schema itself is not uniform across this dataset's history: older/REST-
// captured signals carry a verbose `data.launchpad`/`data.created_timestamp`; newer WebSocket-
// sourced signals (see src/gmgn/browserImport.ts's mapWebSocketSignal) carry the same facts
// abbreviated under `cur_data.lp`/`cur_data.ct`. Verified against live data before writing this:
// 0 of 5013 real signals failed to resolve a launch platform via `data.launchpad ?? cur_data.lp`.
export type SubgroupProperty = 'launchPlatform' | 'tokenAge' | 'combined';

// Boundaries chosen against the real data, not guessed: among signals older than 24h, the
// median was 2.7 days and the max was 302.7 days — a single ">24h" bucket was lumping a
// brand-new token together with one that had been trading for nearly a year. These five
// buckets keep resolution where the real data actually lives (median 2.7d, p90 22.5d).
const TOKEN_AGE_BUCKETS: Array<{ label: string; maxSeconds: number }> = [
  { label: '<1h', maxSeconds: 3600 },
  { label: '1-24h', maxSeconds: 86400 },
  { label: '1-7d', maxSeconds: 7 * 86400 },
  { label: '7-30d', maxSeconds: 30 * 86400 },
  { label: '>30d', maxSeconds: Infinity },
];

const parseRawPayload = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Returns null (excluded from the subgroup, counted separately as unextractable) whenever the
 * fact genuinely cannot be determined — never a guessed default. For token age, a negative
 * result (trigger_at before the token's own created_timestamp — confirmed present in ~11% of
 * real rows, likely clock skew between GMGN's data sources) is treated the same way rather
 * than silently clipped into the youngest bucket.
 */
const extractSingleProperty = (
  property: 'launchPlatform' | 'tokenAge',
  rawPayload: Record<string, unknown> | null,
): string | null => {
  if (!rawPayload) return null;
  const data = asRecord(rawPayload.data);
  const curData = asRecord(rawPayload.cur_data);
  if (property === 'launchPlatform') {
    const value = data?.launchpad ?? curData?.lp;
    return typeof value === 'string' && value.trim() ? value : null;
  }
  const created = data?.created_timestamp ?? curData?.ct;
  const triggerAt = rawPayload.trigger_at;
  if (typeof created !== 'number' || typeof triggerAt !== 'number') return null;
  const ageSeconds = triggerAt - created;
  if (!(ageSeconds >= 0)) return null;
  return TOKEN_AGE_BUCKETS.find((bucket) => ageSeconds < bucket.maxSeconds)?.label ?? '>24h';
};

/**
 * "combined" joins both properties into one bucket (e.g. "Pump.fun / <1h") so a single table
 * can show signal type x platform x age together, per explicit user request, instead of only
 * ever viewing one property at a time. A signal is only included if *both* properties resolve —
 * partial combinations are excluded and counted, same conservative rule as the single-property
 * views, rather than mixing a real platform with a guessed/blank age or vice versa.
 */
const extractSubgroupValue = (
  property: SubgroupProperty,
  rawPayload: Record<string, unknown> | null,
): string | null => {
  if (property !== 'combined') return extractSingleProperty(property, rawPayload);
  const platform = extractSingleProperty('launchPlatform', rawPayload);
  const age = extractSingleProperty('tokenAge', rawPayload);
  return platform === null || age === null ? null : `${platform} / ${age}`;
};

export interface SignalPatternSubgroupHorizonReport {
  horizon: string;
  cellCount: number;
  nUnextractable: number;
  groups: SignalPatternGroup[];
}

export interface SignalPatternSubgroupReport {
  computedAt: string;
  method: 'signal-type-property-subgroup-v1';
  property: SubgroupProperty;
  minReliableSample: number;
  minCoveragePct: number;
  minCaptureDates: number;
  disclaimer: string;
  horizons: SignalPatternSubgroupHorizonReport[];
}

/**
 * Same statistics engine as computeSignalPatternReport (classifyComparison/summarizeGroup,
 * unmodified), grouped by `${signalType}::${bucketValue}` instead of signal type alone. Every
 * cell scanned is reported via `cellCount` so a good-looking cell can be weighed against how
 * many were tested, rather than looking meaningful in isolation — there is no statistical
 * multiple-comparisons correction here, just visibility into the number of comparisons made.
 */
export const computeSignalPatternSubgroupReport = (
  database: DatabaseSync,
  property: SubgroupProperty,
  now = new Date(),
): SignalPatternSubgroupReport => {
  const outcomes = readAllDuneOutcomes(database);
  const ids = outcomes.map((outcome) => outcome.signal.id);
  const rawPayloadRows = ids.length
    ? (database
        .prepare(
          `SELECT id, raw_payload AS rawPayload FROM gmgn_signals WHERE id IN (${ids.map(() => '?').join(',')})`,
        )
        .all(...ids) as unknown as Array<{ id: number; rawPayload: string | null }>)
    : [];
  const rawPayloadById = new Map(
    rawPayloadRows.map((row) => [row.id, parseRawPayload(row.rawPayload)]),
  );

  let nUnextractable = 0;
  const bucketBySignalId = new Map<number, string>();
  for (const outcome of outcomes) {
    const value = extractSubgroupValue(property, rawPayloadById.get(outcome.signal.id) ?? null);
    if (value === null) {
      nUnextractable += 1;
      continue;
    }
    bucketBySignalId.set(outcome.signal.id, value);
  }

  const horizonLabels = [
    ...new Set(
      outcomes.flatMap((outcome) => outcome.checkpoints.map((checkpoint) => checkpoint.label)),
    ),
  ].filter((label) => label !== 'signal');

  const horizons: SignalPatternSubgroupHorizonReport[] = horizonLabels.map((horizon) => {
    const byKey = new Map<string, Comparison[]>();
    const byKeyCaptured = new Map<string, number>();
    const byKeyMatured = new Map<string, number>();
    const byKeyDates = new Map<string, Set<string>>();
    const byKeyRepeated = new Map<string, number>();
    const firstByTokenKey = new Set<string>();
    for (const outcome of outcomes) {
      const bucketValue = bucketBySignalId.get(outcome.signal.id);
      if (bucketValue === undefined) continue;
      const key = `${outcome.signal.signalType ?? 'unknown'}::${bucketValue}`;
      const base = outcome.checkpoints.find((checkpoint) => checkpoint.label === 'signal')?.result;
      const targetCheckpoint = outcome.checkpoints.find(
        (checkpoint) => checkpoint.label === horizon,
      );
      const target = targetCheckpoint?.result;
      const entry = classifyComparison(base, target, outcome.signal.tokenAddress, horizon);
      const targetMs = Date.parse(targetCheckpoint?.targetTimestamp ?? '');
      const matured = !Number.isNaN(targetMs) && targetMs <= now.getTime();
      byKeyCaptured.set(key, (byKeyCaptured.get(key) ?? 0) + 1);
      const tokenKey = `${key} ${outcome.signal.tokenAddress}`;
      if (firstByTokenKey.has(tokenKey)) {
        byKeyRepeated.set(key, (byKeyRepeated.get(key) ?? 0) + 1);
        continue;
      }
      firstByTokenKey.add(tokenKey);
      if (matured) {
        byKeyMatured.set(key, (byKeyMatured.get(key) ?? 0) + 1);
        if (entry.status === 'fresh') {
          if (!byKeyDates.has(key)) byKeyDates.set(key, new Set());
          byKeyDates.get(key)!.add(outcome.signal.observedAt.slice(0, 10));
        }
      }
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(entry);
    }
    const groups = [...byKey.entries()]
      .map(([key, entries]) =>
        summarizeGroup(
          key,
          entries,
          byKeyCaptured.get(key) ?? 0,
          byKeyMatured.get(key) ?? 0,
          byKeyDates.get(key)?.size ?? 0,
          byKeyRepeated.get(key) ?? 0,
        ),
      )
      .sort((a, b) => (b.medianReturnPct ?? -Infinity) - (a.medianReturnPct ?? -Infinity));
    return { horizon, cellCount: groups.length, nUnextractable, groups };
  });

  return {
    computedAt: now.toISOString(),
    method: 'signal-type-property-subgroup-v1',
    property,
    minReliableSample: MIN_RELIABLE_SAMPLE,
    minCoveragePct: MIN_COVERAGE_PCT,
    minCaptureDates: MIN_CAPTURE_DATES,
    disclaimer: DISCLAIMER,
    horizons,
  };
};
