import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getSignalDefinition } from './signal-catalog.js';
import { COSTS_BPS_PER_SIDE, HORIZONS, type Horizon } from './outcomes.js';

export type OosDirection = 'bullish' | 'bearish' | 'signed' | 'neutral';
export type OosPeriodName = 'inSample' | 'outOfSample';

export type OosSelection = {
  signalId: string;
  /** Omit groupId to select the complete signal family. */
  groupId?: string;
  /** Defaults to the catalog direction, then signed for non-catalog signals. */
  direction?: OosDirection;
};

export type OosPeriod = {
  /** The start is inclusive. An omitted in-sample start means all supplied history. */
  start?: string;
  /** The end is exclusive for event timestamps. */
  end: string;
};

export type OosValidationConfig = {
  methodologyVersion: string;
  inSample: OosPeriod;
  outOfSample: { start: string; end: string };
  /** Frozen data availability time used for maturity checks. */
  asOf: string;
  selections: readonly OosSelection[];
  horizons?: readonly Horizon[];
  costsBpsPerSide?: readonly number[];
  /** Requires a quiet gap between the in-sample and untouched period. */
  embargoMs?: number;
  minimumUsableOutcomes?: number;
};

export type OosOutcome = {
  horizon: Horizon;
  outcomeAt?: string | null;
  /** A supplied maturity time is useful when a target lands on a non-trading day. */
  maturityAt?: string | null;
  returnPct?: number | null;
  excessReturnPct?: number | null;
  exclusionReason?: string | null;
};

export type OosEvent = {
  eventId: string | number;
  signalId: string;
  groupId?: string | null;
  symbol: string;
  executedAt: string;
  direction?: OosDirection;
  outcomes: readonly OosOutcome[];
};

export type OosMetric = {
  rawEventN: number;
  independentEventN: number;
  matureEventN: number;
  usableOutcomeN: number;
  distinctTickers: number;
  captureDates: number;
  freshOutcomeCoveragePct: number | null;
  winRatePct: number | null;
  medianReturnPct: number | null;
  averageReturnPct: number | null;
  medianExcessPct: number | null;
  averageExcessPct: number | null;
  returnStdDevPct: number | null;
  maxDrawdownPct: number | null;
  profitFactor: number | null;
  netByCostBpsPerSide: Record<string, number | null>;
  exclusions: Record<string, number>;
  status: 'insufficient' | 'descriptive';
};

export type OosSelectionReport = {
  selection: OosSelection;
  horizons: Array<{
    horizon: Horizon;
    inSample: OosMetric;
    outOfSample: OosMetric;
  }>;
};

export type OosValidationReport = {
  methodologyVersion: string;
  frozen: {
    inSample: OosPeriod;
    outOfSample: { start: string; end: string };
    asOf: string;
    embargoMs: number;
    horizons: Horizon[];
    costsBpsPerSide: number[];
    minimumUsableOutcomes: number;
    selections: OosSelection[];
    selectionFingerprint: string;
  };
  limitations: string[];
  results: OosSelectionReport[];
};

const horizonMs: Record<Horizon, number> = {
  '+5m': 5 * 60_000,
  '+30m': 30 * 60_000,
  '+1h': 60 * 60_000,
  '+1d': 24 * 60 * 60_000,
  '+3d': 3 * 24 * 60 * 60_000,
  '+5d': 5 * 24 * 60 * 60_000,
  '+10d': 10 * 24 * 60 * 60_000,
  '+20d': 20 * 24 * 60 * 60_000,
};

const isDirection = (value: unknown): value is OosDirection =>
  value === 'bullish' || value === 'bearish' || value === 'signed' || value === 'neutral';

const parseTime = (value: string | null | undefined, label: string): number => {
  if (!value) throw new Error(`${label} is required`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO timestamp`);
  return parsed;
};

const optionalTime = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const stableEventId = (eventId: string | number) => String(eventId);

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

const selectionSort = (left: OosSelection, right: OosSelection) =>
  compareText(`${left.signalId}\u0000${left.groupId ?? ''}`, `${right.signalId}\u0000${right.groupId ?? ''}`);

const normalizeSelection = (selection: OosSelection): OosSelection => {
  const signalId = selection.signalId.trim();
  const groupId = selection.groupId?.trim();
  if (!signalId) throw new Error('every OOS selection needs a signalId');
  if (selection.groupId !== undefined && !groupId) throw new Error(`empty groupId for ${signalId}`);
  const catalogDirection = getSignalDefinition(signalId)?.direction;
  if (selection.direction !== undefined && !isDirection(selection.direction)) {
    throw new Error(`invalid direction for ${signalId}`);
  }
  return { signalId, ...(groupId ? { groupId } : {}), direction: selection.direction ?? catalogDirection ?? 'signed' };
};

const normalizeConfig = (config: OosValidationConfig) => {
  if (!config.methodologyVersion.trim()) throw new Error('methodologyVersion is required');
  const inStart = config.inSample.start ? parseTime(config.inSample.start, 'inSample.start') : null;
  const inEnd = parseTime(config.inSample.end, 'inSample.end');
  const outStart = parseTime(config.outOfSample.start, 'outOfSample.start');
  const outEnd = parseTime(config.outOfSample.end, 'outOfSample.end');
  const asOf = parseTime(config.asOf, 'asOf');
  if (inStart !== null && inStart >= inEnd) throw new Error('inSample.start must precede inSample.end');
  if (outStart >= outEnd) throw new Error('outOfSample.start must precede outOfSample.end');
  if (outStart < inEnd) throw new Error('outOfSample.start must not precede inSample.end');
  if (asOf < outStart) throw new Error('asOf must be on or after outOfSample.start');

  const embargoMs = config.embargoMs ?? 0;
  if (!Number.isInteger(embargoMs) || embargoMs < 0 || outStart - inEnd < embargoMs) {
    throw new Error('the configured embargo does not fit between the sample periods');
  }

  const horizons = [...new Set(config.horizons ?? HORIZONS)];
  if (!horizons.length || horizons.some((horizon) => !HORIZONS.includes(horizon))) {
    throw new Error('horizons must be a non-empty subset of the canonical horizons');
  }
  horizons.sort((left, right) => HORIZONS.indexOf(left) - HORIZONS.indexOf(right));

  const costs = [...new Set(config.costsBpsPerSide ?? COSTS_BPS_PER_SIDE)].sort((left, right) => left - right);
  if (costs.some((cost) => !Number.isFinite(cost) || cost < 0)) throw new Error('costs must be finite non-negative bps-per-side values');

  const selections = config.selections.map(normalizeSelection).sort(selectionSort);
  if (!selections.length) throw new Error('at least one preselected signal or group is required');
  const selectionKeys = selections.map(selectionKey);
  if (new Set(selectionKeys).size !== selectionKeys.length) throw new Error('duplicate OOS signal/group selection');

  const minimumUsableOutcomes = config.minimumUsableOutcomes ?? 30;
  if (!Number.isInteger(minimumUsableOutcomes) || minimumUsableOutcomes < 1) throw new Error('minimumUsableOutcomes must be a positive integer');

  const inSample: OosPeriod = { ...(config.inSample.start ? { start: new Date(inStart as number).toISOString() } : {}), end: new Date(inEnd).toISOString() };
  const outOfSample = { start: new Date(outStart).toISOString(), end: new Date(outEnd).toISOString() };
  const asOfIso = new Date(asOf).toISOString();
  return { methodologyVersion: config.methodologyVersion.trim(), inSample, outOfSample, asOf: asOfIso, asOfMs: asOf, inStart, inEnd, outStart, outEnd, embargoMs, horizons, costs, selections, minimumUsableOutcomes };
};

const selectionKey = (selection: OosSelection) => `${selection.signalId}\u0000${selection.groupId ?? '*'}`;

const eventMatches = (event: OosEvent, selection: OosSelection) =>
  event.signalId === selection.signalId && (selection.groupId === undefined || event.groupId === selection.groupId);

const periodFor = (eventMs: number, config: ReturnType<typeof normalizeConfig>): OosPeriodName | null => {
  if (eventMs >= config.outStart && eventMs < config.outEnd) return 'outOfSample';
  if (eventMs < config.inEnd && (config.inStart === null || eventMs >= config.inStart)) return 'inSample';
  return null;
};

const directed = (value: number | null | undefined, direction: OosDirection) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return direction === 'bearish' ? -value : value;
};

const median = (values: readonly number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const average = (values: readonly number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

const standardDeviation = (values: readonly number[], mean: number | null) => mean === null || !values.length
  ? null
  : Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);

const maxDrawdown = (values: readonly number[]) => {
  if (!values.length) return null;
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const value of values) { equity += value; peak = Math.max(peak, equity); drawdown = Math.min(drawdown, equity - peak); }
  return drawdown;
};

const profitFactor = (values: readonly number[]) => {
  const gains = values.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(values.filter(value => value < 0).reduce((sum, value) => sum + value, 0));
  return losses > 0 ? gains / losses : null;
};

type MutableMetric = {
  rawEventN: number;
  independentEventN: number;
  matureEventN: number;
  usableOutcomeN: number;
  tickers: Set<string>;
  captureDates: Set<string>;
  returns: number[];
  excess: number[];
  exclusions: Record<string, number>;
};

const emptyMetric = (): MutableMetric => ({ rawEventN: 0, independentEventN: 0, matureEventN: 0, usableOutcomeN: 0, tickers: new Set(), captureDates: new Set(), returns: [], excess: [], exclusions: {} });

const exclude = (metric: MutableMetric, reason: string) => { metric.exclusions[reason] = (metric.exclusions[reason] ?? 0) + 1; };

const finishMetric = (metric: MutableMetric, costs: readonly number[], minimumUsableOutcomes: number): OosMetric => {
  const averageReturnPct = average(metric.returns);
  const averageExcessPct = average(metric.excess);
  return {
    rawEventN: metric.rawEventN,
    independentEventN: metric.independentEventN,
    matureEventN: metric.matureEventN,
    usableOutcomeN: metric.usableOutcomeN,
    distinctTickers: metric.tickers.size,
    captureDates: metric.captureDates.size,
    freshOutcomeCoveragePct: metric.independentEventN ? metric.usableOutcomeN / metric.independentEventN * 100 : null,
    winRatePct: metric.returns.length ? metric.returns.filter((value) => value > 0).length / metric.returns.length * 100 : null,
    medianReturnPct: median(metric.returns),
    averageReturnPct,
    medianExcessPct: median(metric.excess),
    averageExcessPct,
    returnStdDevPct: standardDeviation(metric.returns, averageReturnPct),
    maxDrawdownPct: maxDrawdown(metric.returns),
    profitFactor: profitFactor(metric.returns),
    netByCostBpsPerSide: Object.fromEntries(costs.map((cost) => [String(cost), averageReturnPct === null ? null : averageReturnPct - cost * 2 / 100])),
    exclusions: Object.fromEntries(Object.entries(metric.exclusions).sort(([left], [right]) => compareText(left, right))),
    status: metric.usableOutcomeN >= minimumUsableOutcomes ? 'descriptive' : 'insufficient',
  };
};

const validateEvent = (event: OosEvent) => {
  if (!String(event.eventId).trim()) throw new Error('every OOS event needs an eventId');
  if (!event.signalId.trim() || !event.symbol.trim()) throw new Error('every OOS event needs a signalId and symbol');
  parseTime(event.executedAt, `event ${event.eventId}.executedAt`);
  const horizons = new Set<Horizon>();
  for (const outcome of event.outcomes) {
    if (!HORIZONS.includes(outcome.horizon)) throw new Error(`invalid ${String(outcome.horizon)} outcome for event ${event.eventId}`);
    if (horizons.has(outcome.horizon)) throw new Error(`duplicate ${outcome.horizon} outcome for event ${event.eventId}`);
    horizons.add(outcome.horizon);
  }
};

const outcomeFor = (event: OosEvent, horizon: Horizon) => event.outcomes.find((outcome) => outcome.horizon === horizon);

/**
 * Runs a deterministic, read-only chronological validation over normalized events.
 * The overlap state is built from all supplied prior events, including events in an
 * embargo gap, so the first holdout event cannot be made independent by the split.
 */
export const validateOutOfSample = (events: readonly OosEvent[], config: OosValidationConfig): OosValidationReport => {
  const normalized = normalizeConfig(config);
  const seenEventIds = new Set<string>();
  for (const event of events) {
    validateEvent(event);
    const id = stableEventId(event.eventId);
    if (seenEventIds.has(id)) throw new Error(`duplicate OOS eventId ${id}`);
    seenEventIds.add(id);
  }
  const orderedEvents = [...events].sort((left, right) => {
    const timeOrder = parseTime(left.executedAt, 'event.executedAt') - parseTime(right.executedAt, 'event.executedAt');
    return timeOrder || compareText(stableEventId(left.eventId), stableEventId(right.eventId));
  });

  const mutable = new Map<string, { inSample: MutableMetric; outOfSample: MutableMetric }>();
  for (const selection of normalized.selections) {
    for (const horizon of normalized.horizons) mutable.set(`${selectionKey(selection)}\u0000${horizon}`, { inSample: emptyMetric(), outOfSample: emptyMetric() });
  }

  for (const selection of normalized.selections) {
    for (const horizon of normalized.horizons) {
      const metrics = mutable.get(`${selectionKey(selection)}\u0000${horizon}`) as { inSample: MutableMetric; outOfSample: MutableMetric };
      const previousIndependentAt = new Map<string, number>();
      for (const event of orderedEvents) {
        if (!eventMatches(event, selection)) continue;
        const eventMs = parseTime(event.executedAt, `event ${event.eventId}.executedAt`);
        if (eventMs >= normalized.outEnd) continue;
        const period = periodFor(eventMs, normalized);
        const overlapKey = event.symbol.trim().toUpperCase();
        const previous = previousIndependentAt.get(overlapKey);
        const isOverlapping = previous !== undefined && eventMs < previous + horizonMs[horizon];
        if (!isOverlapping) previousIndependentAt.set(overlapKey, eventMs);
        if (!period) continue;

        const metric = metrics[period];
        metric.rawEventN++;
        metric.tickers.add(overlapKey);
        metric.captureDates.add(new Date(eventMs).toISOString().slice(0, 10));
        if (isOverlapping) {
          exclude(metric, 'overlapping_event');
          continue;
        }
        metric.independentEventN++;

        const outcome = outcomeFor(event, horizon);
        const maturityMs = optionalTime(outcome?.maturityAt) ?? eventMs + horizonMs[horizon];
        const outcomeAtMs = optionalTime(outcome?.outcomeAt);
        let reason: string | null = null;
        if (maturityMs > normalized.asOfMs || (outcomeAtMs !== null && outcomeAtMs > normalized.asOfMs)) reason = 'outcome_not_mature';
        else if (period === 'inSample' && maturityMs >= normalized.inEnd) reason = 'outcome_outside_in_sample';
        else {
          metric.matureEventN++;
          if (outcome?.exclusionReason && outcome.exclusionReason !== 'overlapping_event') reason = outcome.exclusionReason;
          else if (!outcome || outcomeAtMs === null) reason = 'missing_outcome';
          else {
            const direction = selection.direction ?? event.direction ?? 'signed';
            const returnPct = directed(outcome.returnPct, direction);
            const excessPct = directed(outcome.excessReturnPct, direction);
            if (returnPct === null) reason = 'missing_return';
            else {
              metric.usableOutcomeN++;
              metric.returns.push(returnPct);
              if (excessPct !== null) metric.excess.push(excessPct);
            }
          }
        }
        if (reason) exclude(metric, reason);
      }
    }
  }

  const canonicalConfig = {
    methodologyVersion: normalized.methodologyVersion,
    inSample: normalized.inSample,
    outOfSample: normalized.outOfSample,
    asOf: normalized.asOf,
    embargoMs: normalized.embargoMs,
    horizons: normalized.horizons,
    costsBpsPerSide: normalized.costs,
    minimumUsableOutcomes: normalized.minimumUsableOutcomes,
    selections: normalized.selections,
  };
  const selectionFingerprint = createHash('sha256').update(JSON.stringify(canonicalConfig)).digest('hex');
  return {
    methodologyVersion: normalized.methodologyVersion,
    frozen: { ...canonicalConfig, selectionFingerprint },
    limitations: [
      'Selections and groups are fixed by the frozen configuration; no OOS result can add or optimize a signal.',
      'Overlap is recomputed chronologically per selected signal/group, ticker, and horizon, including events before the split.',
      'Cost results are estimated round-trip costs from the named bps-per-side scenarios, not historical fill measurements.',
      'In-sample outcomes must mature before the split boundary; holdout outcomes must mature by the frozen as-of time.',
    ],
    results: normalized.selections.map((selection) => ({
      selection,
      horizons: normalized.horizons.map((horizon) => {
        const metrics = mutable.get(`${selectionKey(selection)}\u0000${horizon}`) as { inSample: MutableMetric; outOfSample: MutableMetric };
        return { horizon, inSample: finishMetric(metrics.inSample, normalized.costs, normalized.minimumUsableOutcomes), outOfSample: finishMetric(metrics.outOfSample, normalized.costs, normalized.minimumUsableOutcomes) };
      }),
    })),
  };
};

type OosTradeRow = { id: number; signalId: string; symbol: string; executedAt: string; horizon: Horizon | null; outcomeAt: string | null; returnPct: number | null; excessReturnPct: number | null; exclusionReason: string | null };
type OosGenericRow = { id: number; signalId: string; symbol: string; executedAt: string; horizon: Horizon | null; outcomeAt: string | null; returnPct: number | null; excessReturnPct: number | null; exclusionReason: string | null };

/** Reads the existing normalized tables without changing or refreshing them. */
export const readOosEvents = (database: DatabaseSync, config: OosValidationConfig): OosEvent[] => {
  const normalized = normalizeConfig(config);
  const signalIds = normalized.selections.map((selection) => selection.signalId);
  const placeholders = signalIds.map(() => '?').join(',');
  const horizonPlaceholders = normalized.horizons.map(() => '?').join(',');
  // Only load the frozen windows plus enough history to reconstruct overlap
  // state for the first selected event. This keeps validation bounded on the
  // production database while preserving chronological correctness.
  const maximumLookbackMs = Math.max(...normalized.horizons.map((horizon) => horizonMs[horizon]));
  const lowerBound = new Date((normalized.inStart ?? normalized.inEnd) - maximumLookbackMs).toISOString();
  const rows = database.prepare(`SELECT t.id, t.signal_type AS signalId, t.underlying_symbol AS symbol, t.executed_at AS executedAt,
      o.horizon, o.outcome_at AS outcomeAt, o.return_pct AS returnPct, o.excess_return_pct AS excessReturnPct, o.exclusion_reason AS exclusionReason
    FROM uw_option_trades t LEFT JOIN uw_signal_outcomes o ON o.trade_id=t.id AND o.horizon IN (${horizonPlaceholders})
    WHERE t.canceled=0 AND t.executed_at IS NOT NULL AND t.underlying_symbol IS NOT NULL
      AND t.signal_type IN (${placeholders}) AND t.executed_at >= ? AND t.executed_at < ?
    ORDER BY t.executed_at ASC, t.id ASC, o.horizon ASC`).all(...normalized.horizons, ...signalIds, lowerBound, normalized.outOfSample.end) as unknown as OosTradeRow[];
  const events = new Map<string, OosEvent>();
  for (const row of rows) {
    const key = `trade:${row.id}`;
    const event = events.get(key) ?? { eventId: key, signalId: row.signalId, symbol: row.symbol, executedAt: row.executedAt, outcomes: [] };
    if (row.horizon) event.outcomes = [...event.outcomes, { horizon: row.horizon, outcomeAt: row.outcomeAt, maturityAt: new Date(parseTime(row.executedAt, 'executedAt') + horizonMs[row.horizon]).toISOString(), returnPct: row.returnPct, excessReturnPct: row.excessReturnPct, exclusionReason: row.exclusionReason }];
    events.set(key, event);
  }
  const genericRows = database.prepare(`SELECT e.id, e.signal_type AS signalId, e.symbol, e.event_at AS executedAt,
      o.horizon, o.outcome_at AS outcomeAt, o.return_pct AS returnPct, o.excess_return_pct AS excessReturnPct, o.exclusion_reason AS exclusionReason
    FROM uw_signal_events e LEFT JOIN uw_signal_event_outcomes o ON o.event_id=e.id AND o.horizon IN (${horizonPlaceholders})
    WHERE e.event_at IS NOT NULL AND e.symbol IS NOT NULL AND e.signal_type IN (${placeholders})
      AND (e.signal_type <> 'gex_gamma' OR e.id IN (
        SELECT MIN(g.id)
        FROM uw_signal_events g
        WHERE g.signal_type = 'gex_gamma' AND g.event_at IS NOT NULL AND g.symbol IS NOT NULL
        GROUP BY g.symbol, substr(g.event_at, 1, 10)
      ))
      AND e.event_at >= ? AND e.event_at < ?
    ORDER BY e.event_at ASC, e.id ASC, o.horizon ASC`).all(...normalized.horizons, ...signalIds, lowerBound, normalized.outOfSample.end) as unknown as OosGenericRow[];
  for (const row of genericRows) {
    const key = `event:${row.signalId}:${row.id}`;
    const event = events.get(key) ?? { eventId: key, signalId: row.signalId, symbol: row.symbol, executedAt: row.executedAt, outcomes: [] };
    if (row.horizon) event.outcomes = [...event.outcomes, { horizon: row.horizon, outcomeAt: row.outcomeAt, maturityAt: new Date(parseTime(row.executedAt, 'eventAt') + horizonMs[row.horizon]).toISOString(), returnPct: row.returnPct, excessReturnPct: row.excessReturnPct, exclusionReason: row.exclusionReason }];
    events.set(key, event);
  }
  return [...events.values()];
};

type DatabaseOosRow = {
  id: number;
  signalId: string;
  symbol: string;
  executedAt: string;
  outcomeAt: string | null;
  returnPct: number | null;
  excessReturnPct: number | null;
  exclusionReason: string | null;
};

const processDatabaseRow = (
  row: DatabaseOosRow,
  selection: OosSelection,
  horizon: Horizon,
  normalized: ReturnType<typeof normalizeConfig>,
  metrics: { inSample: MutableMetric; outOfSample: MutableMetric },
  previousIndependentAt: Map<string, number>,
) => {
  const eventMs = parseTime(row.executedAt, `event ${row.id}.executedAt`);
  if (eventMs >= normalized.outEnd) return;
  const period = periodFor(eventMs, normalized);
  const overlapKey = row.symbol.trim().toUpperCase();
  const previous = previousIndependentAt.get(overlapKey);
  const isOverlapping = previous !== undefined && eventMs < previous + horizonMs[horizon];
  if (!isOverlapping) previousIndependentAt.set(overlapKey, eventMs);
  if (!period) return;

  const metric = metrics[period];
  metric.rawEventN++;
  metric.tickers.add(overlapKey);
  metric.captureDates.add(new Date(eventMs).toISOString().slice(0, 10));
  if (isOverlapping) {
    exclude(metric, 'overlapping_event');
    return;
  }
  metric.independentEventN++;

  const maturityMs = eventMs + horizonMs[horizon];
  const outcomeAtMs = optionalTime(row.outcomeAt);
  let reason: string | null = null;
  if (maturityMs > normalized.asOfMs || (outcomeAtMs !== null && outcomeAtMs > normalized.asOfMs)) reason = 'outcome_not_mature';
  else if (period === 'inSample' && maturityMs >= normalized.inEnd) reason = 'outcome_outside_in_sample';
  else {
    metric.matureEventN++;
    if (row.exclusionReason && row.exclusionReason !== 'overlapping_event') reason = row.exclusionReason;
    else if (outcomeAtMs === null) reason = 'missing_outcome';
    else {
      const returnPct = directed(row.returnPct, selection.direction ?? 'signed');
      const excessPct = directed(row.excessReturnPct, selection.direction ?? 'signed');
      if (returnPct === null) reason = 'missing_return';
      else {
        metric.usableOutcomeN++;
        metric.returns.push(returnPct);
        if (excessPct !== null) metric.excess.push(excessPct);
      }
    }
  }
  if (reason) exclude(metric, reason);
};

/**
 * Runs the database validation one selected signal and one horizon at a time.
 * The SQL cursor is consumed row-by-row, so the production option history is
 * never copied into a multi-million-row JavaScript array.
 */
const validateDatabaseOutOfSample = (database: DatabaseSync, config: OosValidationConfig): OosValidationReport => {
  const normalized = normalizeConfig(config);
  const maximumLookbackMs = Math.max(...normalized.horizons.map((horizon) => horizonMs[horizon]));
  const lowerBound = new Date((normalized.inStart ?? normalized.inEnd) - maximumLookbackMs).toISOString();
  const reports: OosSelectionReport[] = [];

  for (const selection of normalized.selections) {
    const horizons = normalized.horizons.map((horizon) => {
      const metrics = { inSample: emptyMetric(), outOfSample: emptyMetric() };
      const previousIndependentAt = new Map<string, number>();
      const isOptionSignal = ['call_sweep', 'put_sweep', 'flow_imbalance'].includes(selection.signalId);
      const query = isOptionSignal
        ? `SELECT t.id, t.signal_type AS signalId, t.underlying_symbol AS symbol, t.executed_at AS executedAt,
             o.outcome_at AS outcomeAt, o.return_pct AS returnPct, o.excess_return_pct AS excessReturnPct, o.exclusion_reason AS exclusionReason
           FROM uw_option_trades t LEFT JOIN uw_signal_outcomes o ON o.trade_id=t.id AND o.horizon=?
           WHERE t.canceled=0 AND t.executed_at IS NOT NULL AND t.underlying_symbol IS NOT NULL
             AND t.signal_type=? AND t.executed_at>=? AND t.executed_at<?
           ORDER BY t.executed_at ASC, t.id ASC`
        : `SELECT e.id, e.signal_type AS signalId, e.symbol, e.event_at AS executedAt,
             o.outcome_at AS outcomeAt, o.return_pct AS returnPct, o.excess_return_pct AS excessReturnPct, o.exclusion_reason AS exclusionReason
           FROM uw_signal_events e LEFT JOIN uw_signal_event_outcomes o ON o.event_id=e.id AND o.horizon=?
           WHERE e.event_at IS NOT NULL AND e.symbol IS NOT NULL AND e.signal_type=?
             AND (e.signal_type <> 'gex_gamma' OR e.id IN (
               SELECT MIN(g.id) FROM uw_signal_events g
               WHERE g.signal_type='gex_gamma' AND g.event_at IS NOT NULL AND g.symbol IS NOT NULL
               GROUP BY g.symbol, substr(g.event_at, 1, 10)
             ))
             AND e.event_at>=? AND e.event_at<?
           ORDER BY e.event_at ASC, e.id ASC`;
      const rows = database.prepare(query).iterate(horizon, selection.signalId, lowerBound, normalized.outOfSample.end) as Iterable<DatabaseOosRow>;
      for (const row of rows) processDatabaseRow(row, selection, horizon, normalized, metrics, previousIndependentAt);
      return { horizon, inSample: finishMetric(metrics.inSample, normalized.costs, normalized.minimumUsableOutcomes), outOfSample: finishMetric(metrics.outOfSample, normalized.costs, normalized.minimumUsableOutcomes) };
    });
    reports.push({ selection, horizons });
  }

  const canonicalConfig = {
    methodologyVersion: normalized.methodologyVersion,
    inSample: normalized.inSample,
    outOfSample: normalized.outOfSample,
    asOf: normalized.asOf,
    embargoMs: normalized.embargoMs,
    horizons: normalized.horizons,
    costsBpsPerSide: normalized.costs,
    minimumUsableOutcomes: normalized.minimumUsableOutcomes,
    selections: normalized.selections,
  };
  const selectionFingerprint = createHash('sha256').update(JSON.stringify(canonicalConfig)).digest('hex');
  return { methodologyVersion: normalized.methodologyVersion, frozen: { ...canonicalConfig, selectionFingerprint }, limitations: [
    'Selections and groups are fixed by the frozen configuration; no OOS result can add or optimize a signal.',
    'Overlap is recomputed chronologically per selected signal/group, ticker, and horizon, including events before the split.',
    'Cost results are estimated round-trip costs from the named bps-per-side scenarios, not historical fill measurements.',
    'In-sample outcomes must mature before the split boundary; holdout outcomes must mature by the frozen as-of time.',
  ], results: reports };
};

export const runOutOfSampleValidation = (database: DatabaseSync, config: OosValidationConfig) =>
  validateDatabaseOutOfSample(database, config);
