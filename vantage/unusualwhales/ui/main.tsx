import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

/** Fixed research horizons. The selector never derives its options from the payload. */
const HORIZONS = ['+5m', '+30m', '+1h', '+1d', '+3d', '+5d', '+10d', '+20d'] as const;
// Start on the first horizon with mature live observations; longer horizons remain selectable.
const DEFAULT_HORIZON = '+5m' as const;
/** Estimated round-trip cost scenarios, in basis points per side. */
const COST_BPS_PER_SIDE = ['10', '25', '50'] as const;
/** The scenario shown in the main table. The other two live in the row detail. */
const PRIMARY_COST_BPS = '25' as const;
const DASH = '—';
const TABLE_COLUMNS = 10;

/**
 * Breadth-first comparison feed. The backend serves the standardized
 * SignalComparisonResponse here; this screen introduces no provider and no route of its
 * own, and never manufactures rows when the response does not match the contract.
 */
const COMPARISON_ENDPOINT = '/api/signals/comparison';
const SYNC_ENDPOINT = '/api/signals/sync';
const BACKFILL_ENDPOINT = '/api/signals/backfill';
const RESUME_BACKFILL_ENDPOINT = '/api/signals/backfill/resume';
const STREAM_STATUS_ENDPOINT = '/api/research/stream/status';
const OPTION_FEATURE_REFRESH_ENDPOINT = '/api/research/option-features/refresh';

type Horizon = (typeof HORIZONS)[number];
type CostBps = (typeof COST_BPS_PER_SIDE)[number];
type Direction = 'bullish' | 'bearish' | 'signed' | 'neutral';
type CoverageStatus = 'ready' | 'candidate' | 'limited' | 'blocked';
type OutcomeStatus = 'insufficient' | 'descriptive' | 'unavailable';

type SignalCoverage = {
  status: CoverageStatus | null;
  rawEvents: number | null;
  independentEvents: number | null;
  matureEvents: number | null;
  usableOutcomes: number | null;
  tickers: number | null;
  earliestEvent: string | null;
  latestEvent: string | null;
  availableHorizons: string[];
};

type SignalOutcome = {
  horizon: string;
  sampleSize: number | null;
  winRatePct: number | null;
  medianReturnPct: number | null;
  averageReturnPct: number | null;
  averageExcessPct: number | null;
  afterCostsPct: Record<CostBps, number | null>;
  status: OutcomeStatus | null;
};

type SignalRow = {
  signalId: string;
  label: string;
  direction: Direction | null;
  coverage: SignalCoverage;
  outcomes: SignalOutcome[];
  limitations: string[];
};

type Leader = { status: 'candidate' | 'early' | 'none'; horizon: string; signalId: string | null; label: string | null; afterCostsPct: number | null; message: string };
type SignalComparison = { generatedAt: string | null; leader: Leader; signals: SignalRow[] };

type SyncResult = { received: number | null; inserted: number | null };
type BackfillResult = {
  received: number | null;
  inserted: number | null;
  skipped: number | null;
  from: string | null;
  to: string | null;
  signalTypes: string[];
  errors: string[];
  perSignal: Record<string, { received: number | null; inserted: number | null; skipped: number | null; status: string | null; reason: string | null }>;
};
type BackfillProgress = { operationStatus: string; completedDays: number; processingDays: number; failedDays: number; failures: string[] };
/** The single currently-downloading day, if any, from GET /api/diagnostics -> activeHistoricalDay.
 *  This is what turns the bar determinate: day-count totals alone go static for the whole
 *  duration of a single full-tape day, which is the common case and can run for minutes. */
type ActiveHistoricalDay = {
  signalType: string | null;
  tradingDate: string | null;
  bytesReceived: number | null;
  bytesExpected: number | null;
  receivedCount: number | null;
  insertedCount: number | null;
  progressUpdatedAt: string | null;
};
type HistoricalActivity = { status: string; signalType: string | null; tradingDate: string | null; requestUrl: string | null; requestStartedAt: string | null; progressUpdatedAt: string | null; received: number; inserted: number; bytesReceived: number; bytesExpected: number | null };
type PersistedBackfillStatus = { status: string; error: string | null; stage: string | null; stageStartedAt: string | null; retryScheduled: boolean; retryAttempt: number | null; retryInMs: number | null; stageProgress: { completed: number; total: number; symbol?: string; timeframe?: string } | null; startedAt: string | null; completedAt: string | null; activeDay: ActiveHistoricalDay | null; activity: HistoricalActivity | null; coverage: Array<{ signalType: string; status: string; days: number; error: string | null }>; resumeFrom: string | null; resumeTo: string | null };
type BackendInfo = { configured: 'sqlite' | 'postgres' | null; cutoverReady: boolean | null; note: string | null; postgresReachable: boolean | null };
type RequestTrace = { method: string; url: string; status: number | null; ok: boolean; startedAt: string; completedAt: string; durationMs: number; error: string | null };
type StreamStatus = { configured: boolean; total: number; topics: number; firstCapturedAt: string | null; lastCapturedAt: string | null };

const operationName = (value: Record<string, unknown>): string | null => str(value.operation) ?? str(value.kind);
const operationStatus = (value: Record<string, unknown>): string => {
  const status = str(value.status) ?? 'unknown';
  return status === 'running' || status === 'queued' || status === 'retrying' ? 'processing' : status;
};
const operationDetails = (value: Record<string, unknown>): Record<string, unknown> => {
  if (isRecord(value.details)) return value.details;
  if (isRecord(value.progress)) return value.progress;
  return {};
};

const BACKFILL_CATALOG = [
  { id: 'call_sweep', label: 'Call Sweeps' },
  { id: 'put_sweep', label: 'Put Sweeps' },
  { id: 'repeated_sweeps', label: 'Repeated Sweeps / Hits' },
  { id: 'dark_pool_block', label: 'Dark Pool Blocks' },
  { id: 'flow_imbalance', label: 'Flow Imbalance' },
  { id: 'open_interest_spike', label: 'Open Interest Spikes' },
  { id: 'gex_gamma', label: 'GEX / Gamma' },
  { id: 'market_etf_flow', label: 'Market / ETF Flow' },
  { id: 'insider_activity', label: 'Insider Activity' },
  { id: 'congress_activity', label: 'Congress Activity' },
] as const;
type BackfillSignalId = (typeof BACKFILL_CATALOG)[number]['id'];

/** Every screen state the research API can put this dashboard into. */
type LoadState =
  | { kind: 'loading' }
  | { kind: 'unreachable'; detail: string | null }
  | { kind: 'unexpected'; detail: string | null }
  | { kind: 'ready'; data: SignalComparison };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Numbers are only accepted when finite, so a missing metric can never render as 0 or NaN. */
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | null =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;

const errorDetail = (error: unknown): string | null =>
  error instanceof Error && error.message ? error.message : null;

/** Raised only when the API cannot be contacted at all, so a reachable API that answers
 *  with an error, a bad body, or an unexpected shape is never reported as offline. */
class ApiUnreachableError extends Error {}

/** Raised when the API answers but the payload cannot be read as the agreed contract. */
class UnexpectedResponseError extends Error {}

const requestJson = async (url: string, init?: RequestInit, onTrace?: (trace: RequestTrace) => void): Promise<unknown> => {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const method = init?.method ?? 'GET';
  const report = (status: number | null, ok: boolean, error: string | null) => onTrace?.({ method, url, status, ok, startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - startedMs, error });
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    report(null, false, 'Network request failed.');
    throw new ApiUnreachableError('Confirm the local research API is running.');
  }

  if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
    const detail = response.ok ? `${url} did not return JSON. The endpoint may not be implemented yet.` : `${url} failed with HTTP ${response.status}.`;
    report(response.status, false, detail);
    throw new UnexpectedResponseError(
      detail,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    report(response.status, false, `${url} returned a malformed JSON body.`);
    throw new UnexpectedResponseError(`${url} returned a malformed JSON body.`);
  }

  if (!response.ok) {
    const reported = isRecord(payload) ? str(payload.error) : null;
    report(response.status, false, reported ?? `${url} failed with HTTP ${response.status}.`);
    throw new UnexpectedResponseError(reported ?? `${url} failed with HTTP ${response.status}.`);
  }

  report(response.status, true, null);
  return payload;
};

const parseOutcome = (value: unknown): SignalOutcome | null => {
  if (!isRecord(value)) return null;
  const horizon = str(value.horizon);
  if (!horizon) return null;
  const costs = isRecord(value.afterCostsPct) ? value.afterCostsPct : {};

  return {
    horizon,
    sampleSize: num(value.sampleSize),
    winRatePct: num(value.winRatePct),
    medianReturnPct: num(value.medianReturnPct),
    averageReturnPct: num(value.averageReturnPct),
    averageExcessPct: num(value.averageExcessPct),
    afterCostsPct: Object.fromEntries(COST_BPS_PER_SIDE.map((bps) => [bps, num(costs[bps])])) as Record<
      CostBps,
      number | null
    >,
    status: oneOf<OutcomeStatus>(value.status, ['insufficient', 'descriptive', 'unavailable']),
  };
};

const parseCoverage = (value: unknown): SignalCoverage => {
  const record = isRecord(value) ? value : {};
  const horizons = Array.isArray(record.availableHorizons) ? record.availableHorizons : [];

  return {
    status: oneOf<CoverageStatus>(record.status, ['ready', 'candidate', 'limited', 'blocked']),
    rawEvents: num(record.rawEvents),
    independentEvents: num(record.independentEvents),
    matureEvents: num(record.matureEvents),
    usableOutcomes: num(record.usableOutcomes),
    tickers: num(record.tickers),
    earliestEvent: str(record.earliestEvent),
    latestEvent: str(record.latestEvent),
    availableHorizons: horizons.flatMap((entry) => {
      const label = str(entry);
      return label ? [label] : [];
    }),
  };
};

/** A row needs an identity to be rendered at all; every metric below that may be absent. */
const parseSignalRow = (value: unknown, index: number): SignalRow => {
  if (!isRecord(value)) {
    throw new UnexpectedResponseError(`signals[${index}] is not an object.`);
  }
  const signalId = str(value.signalId);
  const label = str(value.label);
  if (!signalId || !label) {
    throw new UnexpectedResponseError(`signals[${index}] is missing signalId or label.`);
  }
  const limitations = Array.isArray(value.limitations) ? value.limitations : [];
  const outcomes = Array.isArray(value.outcomes) ? value.outcomes : [];

  return {
    signalId,
    label,
    direction: oneOf<Direction>(value.direction, ['bullish', 'bearish', 'signed', 'neutral']),
    coverage: parseCoverage(value.coverage),
    outcomes: outcomes.flatMap((entry) => {
      const parsed = parseOutcome(entry);
      return parsed ? [parsed] : [];
    }),
    limitations: limitations.flatMap((entry) => {
      const text = str(entry);
      return text ? [text] : [];
    }),
  };
};

const parseComparison = (payload: unknown): SignalComparison => {
  if (!isRecord(payload) || !Array.isArray(payload.signals)) {
    throw new UnexpectedResponseError(`${COMPARISON_ENDPOINT} did not return a signals array.`);
  }
  const leaderRecord = isRecord(payload.leader) ? payload.leader : {};
  const leaderStatus = oneOf<'candidate' | 'early' | 'none'>(leaderRecord.status, ['candidate', 'early', 'none']) ?? 'none';
  return {
    generatedAt: str(payload.generatedAt),
    leader: {
      status: leaderStatus,
      horizon: str(leaderRecord.horizon) ?? '+1d',
      signalId: str(leaderRecord.signalId),
      label: str(leaderRecord.label),
      afterCostsPct: num(leaderRecord.afterCostsPct),
      message: str(leaderRecord.message) ?? 'No reliable leader yet.',
    },
    signals: payload.signals.map(parseSignalRow),
  };
};

const parseSyncResult = (payload: unknown): SyncResult => {
  const record = isRecord(payload) ? payload : {};
  return { received: num(record.received), inserted: num(record.inserted) };
};

const parseBackfillResult = (payload: unknown): BackfillResult => {
  const record = isRecord(payload) ? payload : {};
  const counts = isRecord(record.counts) ? record.counts : record;
  const signalResults = Array.isArray(record.signalResults) ? record.signalResults : [];
  const perSignalPayload = isRecord(record.bySignal)
    ? Object.entries(record.bySignal)
    : signalResults.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.signalType !== 'string') return [];
      return [[entry.signalType, entry] as [string, Record<string, unknown>]];
    });
  return {
    received: num(counts.received ?? counts.eventsReceived ?? counts.total),
    inserted: num(counts.inserted ?? counts.eventsInserted),
    skipped: num(counts.skipped ?? counts.duplicates ?? counts.eventsSkipped),
    from: str(record.from),
    to: str(record.to),
    signalTypes: Array.isArray(record.signalTypes) ? record.signalTypes.flatMap((value) => typeof value === 'string' ? [value] : []) : [],
    errors: Array.isArray(record.errors) ? record.errors.flatMap((value) => typeof value === 'string' ? [value] : []) : [],
    perSignal: Object.fromEntries(perSignalPayload.map(([id, value]) => {
      const item = isRecord(value) ? value : {};
      return [id, { received: num(item.received), inserted: num(item.inserted), skipped: num(item.skipped), status: str(item.status), reason: str(item.reason) }];
    })),
  };
};

const dateInputValue = (daysAgo: number) => {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().slice(0, 10);
};

const formatCount = (value: number | null) => (value === null ? DASH : Math.round(value).toLocaleString());

const formatPercent = (value: number | null, options: { signed?: boolean; digits?: number } = {}) => {
  if (value === null) return DASH;
  const digits = options.digits ?? 2;
  if (!options.signed) return `${value.toFixed(digits)}%`;
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(digits)}%`;
};

const formatDay = (value: string | null) => {
  if (!value) return DASH;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? DASH : parsed.toISOString().slice(0, 10);
};

const formatTimestamp = (value: string | null) => {
  if (!value) return DASH;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return DASH;
  return parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const formatElapsed = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
};

const formatBytes = (value: number | null) => {
  if (value === null || value < 0) return DASH;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value / 1024;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) { scaled /= 1024; unitIndex++; }
  return `${scaled.toFixed(scaled >= 10 ? 0 : 1)} ${units[unitIndex]}`;
};

const parseActiveHistoricalDay = (value: unknown): ActiveHistoricalDay | null => {
  if (!isRecord(value)) return null;
  return {
    signalType: str(value.signalType),
    tradingDate: str(value.tradingDate),
    bytesReceived: num(value.bytesReceived),
    bytesExpected: num(value.bytesExpected),
    receivedCount: num(value.receivedCount),
    insertedCount: num(value.insertedCount),
    progressUpdatedAt: str(value.progressUpdatedAt),
  };
};

const BACKFILL_LABEL: Record<string, string> = Object.fromEntries(BACKFILL_CATALOG.map((entry) => [entry.id, entry.label]));

/** Trading days requested this run, counted the same way the backend's day loop counts them
 *  (one iteration per calendar day in [from, to), no weekend skip) x adapter-backed signal
 *  types selected. This is the honest denominator for a "day N of M" progress bar -- it is
 *  never derived from the response, since the response for a long-running backfill doesn't
 *  exist yet while this is being computed. */
const countRequestedDays = (from: string, to: string, signalCount: number): number => {
  if (!from || !to) return 0;
  const fromMs = new Date(`${from}T00:00:00Z`).getTime();
  const toMs = new Date(`${to}T00:00:00Z`).getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return 0;
  const days = Math.round((toMs - fromMs) / (24 * 60 * 60_000));
  return days * signalCount;
};

const COVERAGE_STATUS_LABEL: Record<CoverageStatus, string> = {
  ready: 'Ready',
  candidate: 'Candidate',
  limited: 'Limited',
  blocked: 'Blocked',
};

/** Research-readiness order. Never reordered by return, win rate, or after-cost figures. */
const COVERAGE_STATUS_RANK: Record<CoverageStatus, number> = { ready: 0, candidate: 1, limited: 2, blocked: 3 };
const statusRank = (status: CoverageStatus | null) => (status === null ? 4 : COVERAGE_STATUS_RANK[status]);

/** Grouping cues drawn from the wording the backend already used. The original text is
 *  always rendered verbatim as well, so no warning is restated more strongly. */
const TIMING_RISK_PATTERNS = [/lag/i, /delay/i, /look[-\s]?ahead/i, /timing/i];
const LIMITED_HISTORY_PATTERNS = [/limited history/i, /daily[-\s]?only/i, /historical data unavailable/i];

const matchesAny = (texts: string[], patterns: RegExp[]) =>
  texts.some((text) => patterns.some((pattern) => pattern.test(text)));

const outcomeFor = (row: SignalRow, horizon: string): SignalOutcome | null =>
  row.outcomes.find((entry) => entry.horizon === horizon) ?? null;

/** An outcome block marked `unavailable` is a placeholder, not a reported result, so it
 *  never counts towards horizon coverage. */
const hasReportedOutcome = (row: SignalRow, horizon: string): boolean => {
  const outcome = outcomeFor(row, horizon);
  return outcome !== null && outcome.status !== 'unavailable';
};

/** Short state chips for the selected horizon. Absence is always reported as absence. */
const rowFlags = (row: SignalRow, outcome: SignalOutcome | null): string[] => {
  const flags: string[] = [];
  if (outcome === null || outcome.status === 'unavailable') flags.push('Unavailable');
  if (outcome?.status === 'insufficient') flags.push('Insufficient data');
  if (row.coverage.status === 'limited' || matchesAny(row.limitations, LIMITED_HISTORY_PATTERNS)) {
    flags.push('Limited history');
  }
  if (matchesAny(row.limitations, TIMING_RISK_PATTERNS)) flags.push('Timing risk');
  return flags;
};

/** Factual note about this horizon only. Kept separate from backend limitation text. */
const horizonNote = (row: SignalRow, outcome: SignalOutcome | null, horizon: Horizon): string | null => {
  if (!row.coverage.availableHorizons.includes(horizon)) {
    return `${horizon} is not listed among the available horizons for this signal.`;
  }
  if (outcome === null) return `No ${horizon} outcome block was returned.`;
  return null;
};

function StatusBadge({ status }: { status: CoverageStatus | null }) {
  if (status === null) return <span className="badge unknown">{DASH}</span>;
  return <span className={`badge ${status}`}>{COVERAGE_STATUS_LABEL[status]}</span>;
}

function DirectionBadge({ direction }: { direction: Direction | null }) {
  if (direction === null) return <span className="direction unknown">Direction {DASH}</span>;
  return <span className={`direction ${direction}`}>{direction}</span>;
}

function Figure({ value }: { value: string }) {
  return <span className={value === DASH ? 'figure missing' : 'figure'}>{value}</span>;
}

function DetailPair({ label, value }: { label: string; value: string }) {
  return (
    <li>
      <span>{label}</span>
      <b>{value}</b>
    </li>
  );
}

function RowDetail({ row, horizon }: { row: SignalRow; horizon: Horizon }) {
  const outcome = outcomeFor(row, horizon);
  const coverage = row.coverage;

  return (
    <div className="detail">
      <div className="detail-block">
        <h4>Estimated costs at {horizon}</h4>
        <ul className="detail-list">
          {COST_BPS_PER_SIDE.map((bps) => (
            <DetailPair
              key={bps}
              label={`${bps} bps per side (estimated)`}
              value={formatPercent(outcome?.afterCostsPct[bps] ?? null, { signed: true })}
            />
          ))}
          <DetailPair
            label="Median return, gross"
            value={formatPercent(outcome?.medianReturnPct ?? null, { signed: true })}
          />
        </ul>
        <p className="cost-note">
          Cost assumptions, not measured execution. Each figure subtracts two sides from the gross return; no fill,
          spread, or slippage data is used.
        </p>
      </div>

      <div className="detail-block">
        <h4>Coverage detail</h4>
        <ul className="detail-list">
          <DetailPair label="Raw events" value={formatCount(coverage.rawEvents)} />
          <DetailPair label="Independent events" value={formatCount(coverage.independentEvents)} />
          <DetailPair label="Mature events" value={formatCount(coverage.matureEvents)} />
          <DetailPair label="Usable outcomes" value={formatCount(coverage.usableOutcomes)} />
          <DetailPair label="Distinct tickers" value={formatCount(coverage.tickers)} />
          <DetailPair label="Earliest event" value={formatTimestamp(coverage.earliestEvent)} />
          <DetailPair label="Latest event" value={formatTimestamp(coverage.latestEvent)} />
          <DetailPair
            label="Available horizons"
            value={coverage.availableHorizons.length > 0 ? coverage.availableHorizons.join(', ') : DASH}
          />
        </ul>
      </div>

      <div className="detail-block">
        <h4>Horizons returned</h4>
        {row.outcomes.length > 0 ? (
          <ul className="detail-list">
            {row.outcomes.map((entry) => (
              <DetailPair
                key={entry.horizon}
                label={`${entry.horizon} · ${entry.status ?? `status ${DASH}`}`}
                value={`N ${formatCount(entry.sampleSize)}`}
              />
            ))}
          </ul>
        ) : (
          <p className="detail-empty">No outcome blocks were returned for this signal.</p>
        )}
      </div>

      <div className="detail-block">
        <h4>Reported limitations</h4>
        {row.limitations.length > 0 ? (
          <ul className="limit-list">
            {row.limitations.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        ) : (
          <p className="detail-empty">The API reported no limitations for this signal.</p>
        )}
      </div>
    </div>
  );
}

function ComparisonRow({
  row,
  horizon,
  expanded,
  onToggle,
}: {
  row: SignalRow;
  horizon: Horizon;
  expanded: boolean;
  onToggle: () => void;
}) {
  const outcome = outcomeFor(row, horizon);
  const coverage = row.coverage;
  const flags = rowFlags(row, outcome);
  const note = horizonNote(row, outcome, horizon);
  const detailId = `detail-${row.signalId}`;

  return (
    <>
      <tr>
        <td className="signal-cell">
          <strong>{row.label}</strong>
          <span className="signal-id">{row.signalId}</span>
          <DirectionBadge direction={row.direction} />
          <button
            className="detail-toggle"
            type="button"
            aria-expanded={expanded}
            aria-controls={detailId}
            onClick={onToggle}
          >
            {expanded ? 'Hide detail' : 'Coverage and cost detail'}
          </button>
        </td>
        <td>
          <StatusBadge status={coverage.status} />
          {flags.length > 0 && (
            <span className="flags">
              {flags.map((flag) => (
                <span className="flag" key={flag}>
                  {flag}
                </span>
              ))}
            </span>
          )}
        </td>
        <td className="numeric">
          <Figure value={formatCount(coverage.independentEvents)} />
        </td>
        <td className="numeric">
          <Figure value={formatCount(coverage.matureEvents)} />
        </td>
        <td>
          {coverage.availableHorizons.length > 0 ? (
            <span className="horizon-list">
              {coverage.availableHorizons.map((entry) => (
                <span className={entry === horizon ? 'horizon-tag active' : 'horizon-tag'} key={entry}>
                  {entry}
                </span>
              ))}
            </span>
          ) : (
            <Figure value={DASH} />
          )}
        </td>
        <td className="numeric">
          <Figure value={formatPercent(outcome?.averageReturnPct ?? null, { signed: true })} />
        </td>
        <td className="numeric">
          <Figure value={formatPercent(outcome?.winRatePct ?? null, { digits: 1 })} />
        </td>
        <td className="numeric">
          <Figure value={formatPercent(outcome?.averageExcessPct ?? null, { signed: true })} />
        </td>
        <td className="numeric">
          <Figure value={formatPercent(outcome?.afterCostsPct[PRIMARY_COST_BPS] ?? null, { signed: true })} />
          <small className="cell-note">{PRIMARY_COST_BPS} bps/side, estimated</small>
        </td>
        <td className="coverage-cell">
          <span className="coverage-lines">
            N <b>{formatCount(coverage.independentEvents)}</b> independent
            <br />
            <b>{formatCount(coverage.matureEvents)}</b> mature
            <br />
            <b>{formatCount(coverage.usableOutcomes)}</b> usable
            <br />
            <b>{formatCount(coverage.rawEvents)}</b> raw events · <b>{formatCount(coverage.tickers)}</b> tickers
            <br />
            Coverage: {formatDay(coverage.earliestEvent)} → {formatDay(coverage.latestEvent)}
          </span>
          {note && <p className="horizon-note">{note}</p>}
          {row.limitations.length > 0 && (
            <ul className="warnings">
              {row.limitations.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="detail-row" id={detailId}>
          <td colSpan={TABLE_COLUMNS}>
            <RowDetail row={row} horizon={horizon} />
          </td>
        </tr>
      )}
    </>
  );
}

function ComparisonTable({ signals, horizon }: { signals: SignalRow[]; horizon: Horizon }) {
  const [expanded, setExpanded] = useState<string[]>([]);

  const toggle = (signalId: string) =>
    setExpanded((current) =>
      current.includes(signalId) ? current.filter((id) => id !== signalId) : [...current, signalId],
    );

  return (
    <div className="table-scroll" role="region" aria-label="Signal comparison" tabIndex={0}>
      <p className="coverage-legend">
        <b>Coverage:</b> raw = provider events · independent = non-overlapping events · mature = horizon completed · usable = matched price return.
      </p>
      <table className="comparison">
        <thead>
          <tr>
            <th scope="col">Signal</th>
            <th scope="col">Status</th>
            <th scope="col">
              Independent N<span className="sub">non-overlapping events</span>
            </th>
            <th scope="col">
              Mature N<span className="sub">horizon completed</span>
            </th>
            <th scope="col">Available horizons</th>
            <th scope="col">
              Average return<span className="sub">gross, {horizon}</span>
            </th>
            <th scope="col">
              Win rate<span className="sub">{horizon}</span>
            </th>
            <th scope="col">
              Average vs SPY<span className="sub">excess, {horizon}</span>
            </th>
            <th scope="col">
              After costs<span className="sub">{PRIMARY_COST_BPS} bps/side, estimated</span>
            </th>
            <th scope="col">Coverage / warning</th>
          </tr>
        </thead>
        <tbody>
          {signals.map((row) => (
            <ComparisonRow
              key={row.signalId}
              row={row}
              horizon={horizon}
              expanded={expanded.includes(row.signalId)}
              onToggle={() => toggle(row.signalId)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Reports how much of the selected horizon the API actually filled in. */
function CoverageBanner({ signals, horizon }: { signals: SignalRow[]; horizon: Horizon }) {
  const withOutcome = signals.filter((row) => hasReportedOutcome(row, horizon)).length;

  if (withOutcome === 0) {
    return (
      <div className="status-banner" role="status">
        <span className="status-icon">◌</span>
        <div>
          <strong>No {horizon} price outcomes yet</strong>
          <p>
            Coverage is shown for every signal below, but no signal has a computed {horizon} outcome. Outcomes appear
            only once events mature and matching underlying and SPY bars are stored, so each metric stays {DASH}.
          </p>
        </div>
      </div>
    );
  }

  if (withOutcome < signals.length) {
    return (
      <div className="status-banner" role="status">
        <span className="status-icon">◌</span>
        <div>
          <strong>
            Partial {horizon} coverage · {withOutcome} of {signals.length} signals
          </strong>
          <p>
            Signals without a reported {horizon} outcome keep {DASH} in every metric column and show the coverage and
            warnings the API reported. Missing values are never filled in with zero.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="status-banner settled" role="status">
      <span className="status-icon">≈</span>
      <div>
        <strong>
          Descriptive result only · all {signals.length} signals returned a {horizon} outcome
        </strong>
        <p>
          These are historical measurements of past events. They have not survived out-of-sample validation, and no row
          here is a recommendation to trade.
        </p>
      </div>
    </div>
  );
}

function App() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [backend, setBackend] = useState<BackendInfo | null>(null);
  const [streamStatus, setStreamStatus] = useState<StreamStatus | null>(null);
  const [featureRefreshing, setFeatureRefreshing] = useState(false);
  const [featureNotice, setFeatureNotice] = useState<string | null>(null);
  const [healthTrace, setHealthTrace] = useState<RequestTrace | null>(null);
  const [lastRequest, setLastRequest] = useState<RequestTrace | null>(null);
  const [horizon, setHorizon] = useState<Horizon>(DEFAULT_HORIZON);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [backfillFrom, setBackfillFrom] = useState(() => dateInputValue(30));
  const [backfillTo, setBackfillTo] = useState(() => dateInputValue(4));
  const [backfillSignals, setBackfillSignals] = useState<BackfillSignalId[]>(['call_sweep', 'put_sweep']);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillStartedAt, setBackfillStartedAt] = useState<number | null>(null);
  const [backfillElapsedSeconds, setBackfillElapsedSeconds] = useState(0);
  const [backfillProgress, setBackfillProgress] = useState<BackfillProgress | null>(null);
  const [backfillActiveDay, setBackfillActiveDay] = useState<ActiveHistoricalDay | null>(null);
  const [backfillActivity, setBackfillActivity] = useState<HistoricalActivity | null>(null);
  const [backfillDiagnosticsOnline, setBackfillDiagnosticsOnline] = useState(true);
  const [backfillError, setBackfillError] = useState<string | null>(null);
  const [backfillNotice, setBackfillNotice] = useState<string | null>(null);
  const [backfillResult, setBackfillResult] = useState<BackfillResult | null>(null);
  const [persistedBackfillStatus, setPersistedBackfillStatus] = useState<PersistedBackfillStatus | null>(null);
  const [backfillOperationId, setBackfillOperationId] = useState<number | null>(null);
  const [backfillCanceling, setBackfillCanceling] = useState(false);
  const activeDiagnosticsInFlight = useRef(false);
  const persistedDiagnosticsInFlight = useRef(false);

  useEffect(() => {
    void requestJson('/api/health', undefined, setHealthTrace).then((payload) => {
      if (!isRecord(payload)) return;
      const configured = oneOf<'sqlite' | 'postgres'>(isRecord(payload.databaseBackend) ? payload.databaseBackend.configured : null, ['sqlite', 'postgres']);
      const postgres = isRecord(payload.databaseBackend) && isRecord(payload.databaseBackend.postgres) ? payload.databaseBackend.postgres : null;
      setBackend({
        configured,
        cutoverReady: isRecord(payload.databaseBackend) && typeof payload.databaseBackend.cutoverReady === 'boolean' ? payload.databaseBackend.cutoverReady : null,
        note: isRecord(payload.databaseBackend) ? str(payload.databaseBackend.note) : null,
        postgresReachable: postgres && typeof postgres.reachable === 'boolean' ? postgres.reachable : null,
      });
    }).catch(() => setBackend(null));
  }, []);

  useEffect(() => {
    const poll = () => { void requestJson(STREAM_STATUS_ENDPOINT, undefined, setLastRequest).then((payload) => {
      if (!isRecord(payload)) return;
      setStreamStatus({ configured: payload.configured === true, total: num(payload.total) ?? 0, topics: num(payload.topics) ?? 0, firstCapturedAt: str(payload.firstCapturedAt), lastCapturedAt: str(payload.lastCapturedAt) });
    }).catch(() => setStreamStatus(null)); };
    poll();
    const timer = window.setInterval(poll, 30000);
    return () => window.clearInterval(timer);
  }, []);

  const refreshFeatures = async () => {
    setFeatureRefreshing(true);
    setFeatureNotice(null);
    try {
      const payload = await requestJson(OPTION_FEATURE_REFRESH_ENDPOINT, { method: 'POST' }, setLastRequest);
      if (isRecord(payload) && (payload.status === 'processing' || payload.status === 'completed')) setFeatureNotice('Option feature refresh started. Its durable operation status is visible in diagnostics.');
      else setFeatureNotice('Option feature refresh returned an unexpected status.');
    } catch (error) { setFeatureNotice(errorDetail(error) ?? 'Option feature refresh failed.'); }
    finally { setFeatureRefreshing(false); }
  };

  useEffect(() => {
    if (!backfilling || backfillStartedAt === null) return;
    const timer = window.setInterval(() => setBackfillElapsedSeconds(Math.floor((Date.now() - backfillStartedAt) / 1000)), 250);
    return () => window.clearInterval(timer);
  }, [backfilling, backfillStartedAt]);

  useEffect(() => {
    if (!backfilling) return;
    const poll = async () => {
      if (activeDiagnosticsInFlight.current) return;
      activeDiagnosticsInFlight.current = true;
      try {
        const payload = await requestJson('/api/diagnostics', undefined, setLastRequest);
        setBackfillDiagnosticsOnline(true);
        if (!isRecord(payload)) return;
        const operations = Array.isArray(payload.recentOperations) ? payload.recentOperations : [];
        const active = operations.find((entry) => isRecord(entry) && operationName(entry) === 'signals.historical_backfill' && (backfillOperationId === null || num(entry.id) === backfillOperationId)) as Record<string, unknown> | undefined;
        const coverage = Array.isArray(payload.historicalCoverage) ? payload.historicalCoverage : [];
        const totals = { completedDays: 0, processingDays: 0, failedDays: 0, failures: [] as string[] };
        for (const entry of coverage) {
          if (!isRecord(entry)) continue;
          const status = str(entry.status);
          const days = num(entry.days) ?? 0;
          if (status === 'completed') totals.completedDays += days;
          if (status === 'processing') totals.processingDays += days;
          if (status === 'failed') totals.failedDays += days;
          const error = str(entry.error);
          if (status === 'failed' && error && !totals.failures.includes(`${str(entry.signalType) ?? 'source'}: ${error}`)) totals.failures.push(`${str(entry.signalType) ?? 'source'}: ${error}`);
        }
        const status = active ? operationStatus(active) : 'unknown';
        setBackfillProgress({ operationStatus: status, ...totals });

        const activeDay = parseActiveHistoricalDay(payload.activeHistoricalDay);
        setBackfillActiveDay(activeDay);
        setBackfillActivity(isRecord(payload.historicalActivity) ? {
          status: str(payload.historicalActivity.status) ?? 'requesting_provider_file',
          signalType: str(payload.historicalActivity.signalType),
          tradingDate: str(payload.historicalActivity.tradingDate), requestUrl: str(payload.historicalActivity.requestUrl), requestStartedAt: str(payload.historicalActivity.requestStartedAt), progressUpdatedAt: str(payload.historicalActivity.progressUpdatedAt),
          received: num(payload.historicalActivity.received) ?? 0,
          inserted: num(payload.historicalActivity.inserted) ?? 0,
          bytesReceived: num(payload.historicalActivity.bytesReceived) ?? 0,
          bytesExpected: num(payload.historicalActivity.bytesExpected),
        } : null);
        if (active && backfillOperationId !== null && status !== 'processing') {
          setBackfilling(false);
          setBackfillStartedAt(null);
          setBackfillCanceling(false);
        }
      } catch {
        // The main backfill request remains authoritative; diagnostics is advisory.
        setBackfillDiagnosticsOnline(false);
      } finally {
        activeDiagnosticsInFlight.current = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5000);
    return () => window.clearInterval(timer);
  }, [backfilling, backfillOperationId]);

  // Keep the last server-side job state visible after refresh or after the request
  // has returned. This prevents an interrupted job from looking like a clean finish.
  useEffect(() => {
    const poll = async () => {
      if (persistedDiagnosticsInFlight.current) return;
      persistedDiagnosticsInFlight.current = true;
      try {
        const payload = await requestJson('/api/diagnostics', undefined, setLastRequest);
        if (!isRecord(payload)) return;
        const operations = Array.isArray(payload.recentOperations) ? payload.recentOperations : [];
        const latest = operations.find((entry) => isRecord(entry) && operationName(entry) === 'signals.historical_backfill') as Record<string, unknown> | undefined;
        if (!latest) { setPersistedBackfillStatus(null); return; }
        const latestStatus = operationStatus(latest);
        const details = operationDetails(latest);
        const latestId = num(latest.id);
        if (latestStatus === 'processing') {
          setBackfilling(true);
          setBackfillOperationId(current => current ?? latestId);
          setBackfillStartedAt(current => current ?? Date.now());
        } else if (backfilling && (backfillOperationId === null || latestId === backfillOperationId)) {
          setBackfilling(false);
          setBackfillStartedAt(null);
          setBackfillCanceling(false);
        }
        const historicalRequests = (Array.isArray(payload.historicalRequests) ? payload.historicalRequests : []).filter(isRecord);
        const resumable = historicalRequests.find((entry) => str(entry.endpoint) === '/api/option-trades/full-tape' && str(entry.from) && str(entry.to));
        setPersistedBackfillStatus({
          status: latestStatus,
          error: str(latest.error),
          stage: str(details.stage),
          stageStartedAt: str(details.stageStartedAt),
          retryScheduled: details.retryScheduled === true,
          retryAttempt: num(details.retryAttempt),
          retryInMs: num(details.retryInMs),
          stageProgress: isRecord(details.progress) ? { completed: num(details.progress.completed) ?? 0, total: num(details.progress.total) ?? 0, symbol: str(details.progress.symbol) ?? undefined, timeframe: str(details.progress.timeframe) ?? undefined } : null,
          startedAt: str(latest.startedAt),
          completedAt: str(latest.completedAt),
          activeDay: parseActiveHistoricalDay(payload.activeHistoricalDay),
          activity: isRecord(payload.historicalActivity) ? { status: str(payload.historicalActivity.status) ?? 'requesting_provider_file', signalType: str(payload.historicalActivity.signalType), tradingDate: str(payload.historicalActivity.tradingDate), requestUrl: str(payload.historicalActivity.requestUrl), requestStartedAt: str(payload.historicalActivity.requestStartedAt), progressUpdatedAt: str(payload.historicalActivity.progressUpdatedAt), received: num(payload.historicalActivity.received) ?? 0, inserted: num(payload.historicalActivity.inserted) ?? 0, bytesReceived: num(payload.historicalActivity.bytesReceived) ?? 0, bytesExpected: num(payload.historicalActivity.bytesExpected) } : null,
          coverage: (Array.isArray(payload.historicalCoverage) ? payload.historicalCoverage : []).filter(isRecord).map((entry) => ({ signalType: str(entry.signalType) ?? 'unknown', status: str(entry.status) ?? 'unknown', days: num(entry.days) ?? 0, error: str(entry.error) })),
          resumeFrom: resumable ? str(resumable.from) : null,
          resumeTo: resumable ? str(resumable.to) : null,
        });
      } catch { /* comparison state remains authoritative */ }
      finally { persistedDiagnosticsInFlight.current = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 15000);
    return () => window.clearInterval(timer);
  }, []);

  const loadComparison = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      setState({ kind: 'ready', data: parseComparison(await requestJson(COMPARISON_ENDPOINT, undefined, setLastRequest)) });
    } catch (error) {
      setState(
        error instanceof ApiUnreachableError
          ? { kind: 'unreachable', detail: errorDetail(error) }
          : { kind: 'unexpected', detail: errorDetail(error) },
      );
    }
  }, []);

  useEffect(() => {
    void loadComparison();
  }, [loadComparison]);

  const syncSignalData = async () => {
    setSyncing(true);
    setSyncError(null);
    setSyncResult(null);
    try {
      setSyncResult(parseSyncResult(await requestJson(SYNC_ENDPOINT, { method: 'POST' }, setLastRequest)));
      await loadComparison();
    } catch (error) {
      setSyncError(errorDetail(error) ?? 'Signal data sync failed.');
    } finally {
      setSyncing(false);
    }
  };

  const backfillSignalData = async () => {
    setBackfilling(true);
    setBackfillStartedAt(Date.now());
    setBackfillElapsedSeconds(0);
    setBackfillError(null);
    setBackfillNotice(null);
    setBackfillDiagnosticsOnline(true);
    setBackfillResult(null);
    setBackfillOperationId(null);
    setBackfillCanceling(false);
    setBackfillProgress(null);
    setBackfillActiveDay(null);
    if (!backfillFrom || !backfillTo || backfillFrom > backfillTo) {
      setBackfillError('Choose a valid date range. The From date must be before the To date.');
      setBackfilling(false);
      setBackfillStartedAt(null);
      return;
    }
    let waitingForWorker = false;
    try {
      const payload = await requestJson(BACKFILL_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: backfillFrom, to: backfillTo, signalTypes: backfillSignals }),
      }, setLastRequest);
      if (isRecord(payload) && payload.status === 'processing') {
        waitingForWorker = true;
        setBackfillOperationId(num(payload.operationId));
        setBackfillResult(null);
        setBackfillError(null);
      } else {
        setBackfillResult(parseBackfillResult(payload));
      }
      await loadComparison();
    } catch (error) {
      setBackfillError(errorDetail(error) ?? 'Historical backfill failed.');
    } finally {
      if (!waitingForWorker) {
        setBackfilling(false);
        setBackfillStartedAt(null);
      }
    }
  };

  const resumeMissingBackfill = async () => {
    if (!persistedBackfillStatus?.resumeFrom || !persistedBackfillStatus.resumeTo) return;
    const from = persistedBackfillStatus.resumeFrom.slice(0, 10);
    const to = persistedBackfillStatus.resumeTo.slice(0, 10);
    setBackfillFrom(from);
    setBackfillTo(to);
    setBackfilling(true);
    setBackfillStartedAt(Date.now());
    setBackfillElapsedSeconds(0);
    setBackfillError(null);
    setBackfillNotice(null);
    setBackfillDiagnosticsOnline(true);
    setBackfillResult(null);
    setBackfillOperationId(null);
    setBackfillCanceling(false);
    let waitingForWorker = false;
    setBackfillProgress(null);
    setBackfillActiveDay(null);
    try {
      const payload = await requestJson(RESUME_BACKFILL_ENDPOINT, { method: 'POST' }, setLastRequest);
      if (isRecord(payload) && payload.status === 'processing') {
        waitingForWorker = true;
        setBackfillOperationId(num(payload.operationId));
        setBackfillResult(null);
        setBackfillError(null);
      } else {
        setBackfillResult(parseBackfillResult(payload));
      }
      await loadComparison();
    } catch (error) {
      setBackfillError(errorDetail(error) ?? 'Could not resume the historical download.');
    } finally {
      if (!waitingForWorker) {
        setBackfilling(false);
        setBackfillStartedAt(null);
      }
    }
  };

  const cancelBackfill = async () => {
    if (backfillCanceling) return;
    setBackfillCanceling(true);
    try {
      const payload = await requestJson('/api/signals/backfill/cancel', { method: 'POST' }, setLastRequest);
      setBackfillNotice(isRecord(payload) && (payload.status === 'cancelled' || payload.cancelled === true)
        ? 'Stop requested. Saved data is preserved; the final cancelled state will appear after diagnostics refresh.'
        : 'Stop request was accepted, but the server has not confirmed cancellation yet.');
    } catch (error) {
      setBackfillError(errorDetail(error) ?? 'Could not stop the download.');
      setBackfillCanceling(false);
    }
  };

  /** Research-readiness order only; backend order is preserved inside each status group. */
  const signals = useMemo(() => {
    if (state.kind !== 'ready') return [];
    return [...state.data.signals].sort((a, b) => statusRank(a.coverage.status) - statusRank(b.coverage.status));
  }, [state]);

  const signalById = useMemo(() => new Map(signals.map((signal) => [signal.signalId, signal])), [signals]);
  const toggleBackfillSignal = (id: BackfillSignalId) => {
    setBackfillSignals((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  };

  const connectionLabel =
    state.kind === 'loading'
      ? 'Loading signal comparison'
      : state.kind === 'unreachable'
        ? 'Research API unreachable'
        : state.kind === 'unexpected'
          ? 'Research API responded unexpectedly'
          : 'Research API connected';

  return (
    <main>
      <nav className="topbar" aria-label="Primary">
        <span className="brand">
          <span className="brand-mark">◒</span> Unusual Whales
        </span>
        <span className={state.kind === 'ready' ? 'connection connected' : 'connection'}>
          <i />
          {connectionLabel}
        </span>
        <span className="backend-chip" aria-label="Active database backend">
          Backend: <strong>{backend?.configured ?? DASH}</strong>
        </span>
      </nav>

      <header className="hero">
        <p className="eyebrow">Breadth-first comparison</p>
        <h1>Unusual Whales</h1>
        <p className="lede">Signal discovery and historical outcome research</p>
      </header>

      <section className="reliability-strip" aria-label="System reliability status">
        <div className="reliability-card">
          <span className="reliability-label">Active backend</span>
          <strong>{backend?.configured ?? DASH}</strong>
          <small>{backend?.note ?? 'Backend identity is not reported yet.'}</small>
        </div>
        <div className="reliability-card">
          <span className="reliability-label">Health response</span>
          <strong>{healthTrace?.status === null || healthTrace?.status === undefined ? DASH : `HTTP ${healthTrace.status}`}</strong>
          <small>{healthTrace ? `${healthTrace.ok ? 'reachable' : 'failed'} · ${healthTrace.durationMs} ms${healthTrace.error ? ` · ${healthTrace.error}` : ''}` : 'Waiting for /api/health.'}</small>
        </div>
        <div className="reliability-card">
          <span className="reliability-label">Last API exchange</span>
          <strong>{lastRequest ? `${lastRequest.method} · ${lastRequest.status === null ? DASH : `HTTP ${lastRequest.status}`}` : DASH}</strong>
          <small>{lastRequest ? `${lastRequest.url} · ${lastRequest.ok ? 'success' : 'error'} · ${lastRequest.durationMs} ms` : 'No request recorded yet.'}</small>
        </div>
      </section>

      <section className="panel" aria-labelledby="explainer-title">
        <p className="eyebrow">How to read this screen</p>
        <h2 id="explainer-title">Which signal types have enough clean history to research?</h2>
        <p className="section-intro">
          This screen compares simple historical outcomes across Unusual Whales data sources. Results are descriptive
          and are not trading recommendations.
        </p>
        <p className="section-intro">
          It is a shortlist for deeper research, not a ranking. Rows are ordered by data readiness, never by return, win
          rate, or after-cost figures, so nothing here answers which signal to trade.
        </p>
      </section>

      <section className="panel backfill-panel" aria-labelledby="backfill-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Historical data</p>
            <h2 id="backfill-title">Backfill past signals</h2>
            <p className="section-intro">
              Download older events so completed +1d through +20d outcomes can be measured as they mature. This is separate from the
              recent signal sync.
            </p>
          </div>
        </div>
        <div className="backfill-form">
          <label>
            <span>From date</span>
            <input type="date" value={backfillFrom} max={backfillTo || undefined} onChange={(event) => setBackfillFrom(event.target.value)} />
          </label>
          <label>
            <span>To date</span>
            <input type="date" value={backfillTo} min={backfillFrom || undefined} max={dateInputValue(0)} onChange={(event) => setBackfillTo(event.target.value)} />
          </label>
          <fieldset className="backfill-signals">
            <legend>Signal types to download</legend>
            <div className="signal-options">
              {BACKFILL_CATALOG.map((option) => {
                const catalogRow = signalById.get(option.id);
                const status = catalogRow?.coverage.status ?? null;
                const available = option.id === 'call_sweep' || option.id === 'put_sweep' || option.id === 'dark_pool_block';
                return (
                  <label className={`signal-option ${status ?? 'unknown'}`} key={option.id}>
                    <input
                      type="checkbox"
                      checked={backfillSignals.includes(option.id)}
                      onChange={() => toggleBackfillSignal(option.id)}
                      disabled={backfilling}
                    />
                    <span className="signal-option-copy">
                      <strong>{option.label}</strong>
                      <small>{status ? COVERAGE_STATUS_LABEL[status] : 'Not reported'} · {available ? 'adapter available' : 'historical adapter unavailable'}</small>
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="backfill-selection-note">Select every source you want checked. Sources without a verified historical adapter will be reported as unavailable and will not be sent as a fake download.</p>
          </fieldset>
          <div className="backfill-actions">
            <button className="sync-button backfill-button" type="button" onClick={backfillSignalData} disabled={backfilling}>
              {backfilling ? 'Downloading…' : 'Download historical data'}
            </button>
            {backfilling && <button className="cancel-button" type="button" onClick={() => void cancelBackfill()} disabled={backfillCanceling}>{backfillCanceling ? 'Stopping…' : 'Stop download'}</button>}
          </div>
        </div>
        <p className="backfill-hint">Choose a range ending at least three trading days ago for the fullest mature results.</p>
        {persistedBackfillStatus && !backfilling && persistedBackfillStatus.status !== 'processing' && (
          <div className={`backfill-server-status ${persistedBackfillStatus.status === 'processing' ? 'warning' : persistedBackfillStatus.status === 'completed' ? 'success' : 'error'}`} role="status">
            <strong>Last historical backfill: {persistedBackfillStatus.error?.toLowerCase().includes('interrupted') || persistedBackfillStatus.error?.toLowerCase().includes('cancelled') ? 'interrupted' : persistedBackfillStatus.status}</strong>
            {persistedBackfillStatus.activeDay && <span> · {BACKFILL_LABEL[persistedBackfillStatus.activeDay.signalType ?? ''] ?? persistedBackfillStatus.activeDay.signalType} · {persistedBackfillStatus.activeDay.tradingDate}</span>}
            {persistedBackfillStatus.error && <small> · {persistedBackfillStatus.error}</small>}
            {persistedBackfillStatus.status === 'processing' && persistedBackfillStatus.stage && <div className="backfill-server-progress"><p><strong>Worker stage:</strong> {persistedBackfillStatus.stage === 'historical_fetch' ? 'fetching historical signal files' : persistedBackfillStatus.stage === 'refreshing_market_prices' ? 'refreshing market prices' : persistedBackfillStatus.stage === 'refreshing_outcomes' ? 'calculating outcomes' : persistedBackfillStatus.stage}{persistedBackfillStatus.stageProgress && persistedBackfillStatus.stageProgress.total > 0 ? ` · ${persistedBackfillStatus.stageProgress.completed.toLocaleString()} / ${persistedBackfillStatus.stageProgress.total.toLocaleString()} (${Math.round(persistedBackfillStatus.stageProgress.completed / persistedBackfillStatus.stageProgress.total * 100)}%)` : ''}</p><small>{persistedBackfillStatus.stageProgress?.symbol ? `Latest: ${persistedBackfillStatus.stageProgress.symbol} ${persistedBackfillStatus.stageProgress.timeframe ?? ''} · ` : ''}{(() => { const p = persistedBackfillStatus.stageProgress; const started = persistedBackfillStatus.stageStartedAt ? Date.parse(persistedBackfillStatus.stageStartedAt) : NaN; const elapsed = Number.isFinite(started) && p && p.completed > 0 ? (Date.now() - started) / 1000 : 0; const eta = p && p.total > p.completed && elapsed > 0 ? Math.round((p.total - p.completed) * elapsed / p.completed) : null; return eta !== null ? `Estimated time remaining: ${eta >= 3600 ? `${Math.floor(eta / 3600)}h ${Math.floor(eta % 3600 / 60)}m` : eta >= 60 ? `${Math.floor(eta / 60)}m ${eta % 60}s` : `${eta}s`}. ` : 'Estimating time remaining. '; })()}The worker is alive even when no provider request is currently open.</small></div>}
            {persistedBackfillStatus.retryScheduled && <div className="backfill-server-progress"><p><strong>Automatic retry scheduled</strong>{persistedBackfillStatus.retryInMs ? ` in ${Math.ceil(persistedBackfillStatus.retryInMs / 1000)} seconds` : ''}.</p><small>Retry {((persistedBackfillStatus.retryAttempt ?? 0) + 1)} of 3 will reuse the same range and skip saved days.</small></div>}
            {persistedBackfillStatus.activity && <div className="backfill-server-progress"><p><strong>Server activity:</strong> {persistedBackfillStatus.activity.status === 'requesting_provider_file' ? 'waiting for the provider file' : 'downloading provider file'}{persistedBackfillStatus.activity.signalType ? ` · ${BACKFILL_LABEL[persistedBackfillStatus.activity.signalType] ?? persistedBackfillStatus.activity.signalType}` : ''} · {formatBytes(persistedBackfillStatus.activity.bytesReceived)}{persistedBackfillStatus.activity.bytesExpected !== null ? ` / ${formatBytes(persistedBackfillStatus.activity.bytesExpected)}` : ' downloaded'}</p><small>Request: {persistedBackfillStatus.activity.requestUrl ?? DASH}{persistedBackfillStatus.activity.tradingDate ? ` · date ${persistedBackfillStatus.activity.tradingDate}` : ''}</small></div>}
            <div className="backfill-coverage-summary">
              {(['call_sweep', 'put_sweep', 'dark_pool_block'] as const).map((signalType) => {
                const rows = persistedBackfillStatus.coverage.filter((row) => row.signalType === signalType);
                const completed = rows.find((row) => row.status === 'completed')?.days ?? 0;
                const failed = rows.find((row) => row.status === 'failed')?.days ?? 0;
                const label = BACKFILL_LABEL[signalType];
                return <span key={signalType}><strong>{label}:</strong> {completed} completed{failed ? ` · ${failed} failed/interrupted` : ''}</span>;
              })}
            </div>
            <p className="backfill-next-step"><strong>Next action:</strong> {persistedBackfillStatus.resumeFrom && persistedBackfillStatus.resumeTo ? 'resume the missing Call/Put days below. Saved days are skipped automatically, and outcomes refresh when it finishes.' : 'choose a date range and download historical data.'} Other signal families remain unavailable until their historical adapters are implemented.</p>
            {persistedBackfillStatus.resumeFrom && persistedBackfillStatus.resumeTo && persistedBackfillStatus.status !== 'processing' && (persistedBackfillStatus.status !== 'completed' || persistedBackfillStatus.coverage.some((row) => row.signalType === 'call_sweep' || row.signalType === 'put_sweep' ? row.status === 'failed' : false)) && (
              <button className="sync-button backfill-button" type="button" onClick={() => void resumeMissingBackfill()}>Resume missing Call/Put data</button>
            )}
          </div>
        )}
        {(backfilling || persistedBackfillStatus?.status === 'processing') && (() => {
          const dayBytePct = backfillActiveDay?.bytesExpected
            ? Math.min(100, Math.round(((backfillActiveDay.bytesReceived ?? 0) / backfillActiveDay.bytesExpected) * 100))
            : null;
          const isFullTape = backfillActiveDay?.signalType === 'call_sweep' || backfillActiveDay?.signalType === 'put_sweep';
          const savedRows = backfillActiveDay?.insertedCount ?? backfillActivity?.inserted ?? null;

          return (
            <div className="backfill-progress" role="status" aria-live="polite">
              <div className="backfill-progress-heading">
                <strong>Downloading historical data…</strong>
                <span>{formatElapsed(backfillElapsedSeconds)} elapsed</span>
              </div>
              <div className="progress-track" aria-label="Historical download progress">
                {dayBytePct !== null
                  ? <div className="progress-fill" style={{ width: `${dayBytePct}%` }} />
                  : <div className="progress-indeterminate" />}
              </div>
              <div className="reliability-metrics">
                <span><b>Saved rows:</b> {formatCount(savedRows)}</span>
                <span><b>Completed days:</b> {formatCount(backfillProgress?.completedDays ?? null)}</span>
                <span><b>Failed days:</b> {formatCount(backfillProgress?.failedDays ?? null)}</span>
                <span><b>Remaining work:</b> <em>Not reported by API</em></span>
              </div>
              {backfillActiveDay?.tradingDate && <p className="backfill-progress-summary">Current day: {formatDay(backfillActiveDay.tradingDate)} ({BACKFILL_LABEL[backfillActiveDay.signalType ?? ''] ?? backfillActiveDay.signalType}) · byte progress is for this day only.</p>}
              {backfillActivity?.status === 'requesting_provider_file' && (
                <p className="backfill-progress-summary">Waiting for the Unusual Whales file to begin downloading{backfillActivity.signalType ? <> · {BACKFILL_LABEL[backfillActivity.signalType] ?? backfillActivity.signalType}</> : null} · request is active</p>
              )}
              {backfillActivity?.requestUrl && <p className="backfill-progress-summary">Request: {backfillActivity.requestUrl}{backfillActivity.tradingDate ? ` · date ${backfillActivity.tradingDate}` : ''}</p>}
              {isFullTape && (
                <p className="backfill-progress-summary">
                  {formatBytes(backfillActiveDay?.bytesReceived ?? backfillActivity?.bytesReceived ?? 0)} {backfillActiveDay?.bytesExpected !== null ? <>/ {formatBytes(backfillActiveDay.bytesExpected)}</> : <>downloaded (provider size not supplied)</>}
                  {backfillActiveDay?.receivedCount !== null && <> · {formatCount(backfillActiveDay?.receivedCount ?? null)} sweep rows matched so far</>}
                  {backfillActiveDay?.progressUpdatedAt && <> · updated {new Date(backfillActiveDay.progressUpdatedAt).toLocaleTimeString()}</>}
                </p>
              )}
              <p>Full-tape files can be large (roughly 1-1.5 GB per trading day). Results and coverage refresh once the whole request finishes.</p>
              {!backfillDiagnosticsOnline && <p className="backfill-live-error">Live diagnostics are not responding. The current request cannot be verified; no current failure is being inferred from older coverage.</p>}
              {backfillProgress?.failures.length ? <p className="backfill-live-error">Recorded failures in this backfill: {backfillProgress.failures.join(' · ')}</p> : null}
            </div>
          );
        })()}
        {backfillError && <p className="notice error" role="alert">{backfillError}</p>}
        {backfillNotice && !backfillError && <p className="notice warning" role="status">{backfillNotice}</p>}
        {backfillResult && !backfillError && (
          <div className="backfill-results" role="status">
            <p className="notice success">Historical download complete · {formatCount(backfillResult.received)} events received · {formatCount(backfillResult.inserted)} inserted{backfillResult.skipped !== null && <> · {formatCount(backfillResult.skipped)} skipped</>}</p>
            <div className="backfill-result-list">
              {BACKFILL_CATALOG.filter((option) => backfillSignals.includes(option.id)).map((option) => {
                const result = backfillResult.perSignal[option.id];
                const catalogRow = signalById.get(option.id);
                const unsupported = !result || result.status === 'unsupported';
                return <div className="backfill-result-row" key={option.id}>
                  <strong>{option.label}</strong>
                  <span className={unsupported ? 'backfill-source-status unavailable' : 'backfill-source-status'}>{result?.status ?? 'Unavailable'}</span>
                  <span>{result ? (unsupported ? (result.reason ?? 'No verified historical adapter; no request was made.') : `received ${formatCount(result.received)} · inserted ${formatCount(result.inserted)}`) : unsupported ? (catalogRow?.limitations[0] ?? 'No verified historical adapter; no request was made.') : 'No per-source counts returned by the API.'}</span>
                </div>;
              })}
            </div>
            {backfillResult.errors.length > 0 && <p className="backfill-errors">{backfillResult.errors.join(' · ')}</p>}
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="comparison-title">
        {state.kind === 'ready' && (
          <div className={state.data.leader.status === 'none' ? 'leader-banner' : 'leader-banner positive'} role="status">
            <p className="eyebrow">Automatic evidence summary</p>
            <h2>
              {state.data.leader.status === 'none'
                ? 'No reliable leader yet'
                : `${state.data.leader.label} is the current ${state.data.leader.status === 'early' ? 'early' : 'best-supported'} leader`}
            </h2>
            <p>
              {state.data.leader.message}
              {state.data.leader.afterCostsPct !== null && <> Current estimated after-cost return: {formatPercent(state.data.leader.afterCostsPct, { signed: true })}.</>}
            </p>
          </div>
        )}
        <div className="section-heading">
          <div>
            <p className="eyebrow">All signal types returned by the backend</p>
            <h2 id="comparison-title">Signal comparison</h2>
          </div>
          <div className="section-actions">
            <span className="pill">Exploratory</span>
            <button className="sync-button" type="button" onClick={syncSignalData} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync signal data'}
            </button>
          </div>
        </div>

        <div className="research-tools" role="status">
          <div>
            <strong>Research infrastructure</strong>
            <span>{streamStatus?.configured ? `Live stream configured · ${formatCount(streamStatus.total)} captured messages across ${formatCount(streamStatus.topics)} topics` : 'Live stream capture is not configured; historical data remains unaffected.'}</span>
          </div>
          <button className="sync-button" type="button" onClick={() => void refreshFeatures()} disabled={featureRefreshing}>
            {featureRefreshing ? 'Starting feature refresh…' : 'Refresh option features'}
          </button>
        </div>
        {featureNotice && <p className="notice warning" role="status">{featureNotice}</p>}

        <div className="horizon-row" role="group" aria-label="Outcome horizon">
          <span className="label">Outcome horizon</span>
          {HORIZONS.map((option) => (
            <button
              className={option === horizon ? 'horizon selected' : 'horizon'}
              type="button"
              key={option}
              aria-pressed={option === horizon}
              onClick={() => setHorizon(option)}
            >
              {option}
            </button>
          ))}
          <span className="horizon-hint">Changing the horizon updates every row.</span>
        </div>

        <p className="direction-note">
          Returns are direction-adjusted only where the backend marks the signal as directional.
        </p>

        {syncError && (
          <p className="notice error" role="alert">
            {syncError}
          </p>
        )}
        {syncResult && !syncError && (
          <p className="notice success" role="status">
            Sync complete · {formatCount(syncResult.received)} events received · {formatCount(syncResult.inserted)}{' '}
            inserted
          </p>
        )}

        {state.kind === 'loading' && (
          <p className="state-message" role="status">
            Loading signal comparison…
          </p>
        )}

        {state.kind === 'unreachable' && (
          <div className="notice error" role="alert">
            <strong>The research API is unreachable.</strong>
            {state.detail && <span className="notice-detail">{state.detail}</span>}
            <button className="link-button" type="button" onClick={() => void loadComparison()}>
              Retry
            </button>
          </div>
        )}

        {state.kind === 'unexpected' && (
          <div className="notice error" role="alert">
            <strong>The research API returned an unexpected response.</strong>
            {state.detail && <span className="notice-detail">{state.detail}</span>}
            <span className="notice-detail">
              No rows are shown, because this screen never substitutes placeholder signals for a payload it cannot read.
            </span>
            <button className="link-button" type="button" onClick={() => void loadComparison()}>
              Retry
            </button>
          </div>
        )}

        {state.kind === 'ready' && signals.length === 0 && (
          <p className="state-message" role="status">
            No signal sources are available yet.
          </p>
        )}

        {state.kind === 'ready' && signals.length > 0 && (
          <>
            <CoverageBanner signals={signals} horizon={horizon} />
            <ComparisonTable signals={signals} horizon={horizon} />
            <p className="cost-note">
              Descriptive only. Every figure is a historical measurement of stored events at the selected horizon, shown
              for research triage. After-cost columns are cost assumptions, not measured execution, and no row on this
              screen is a recommendation to trade.
            </p>
            {state.data.generatedAt && (
              <p className="generated-at">Generated {formatTimestamp(state.data.generatedAt)}</p>
            )}
          </>
        )}
      </section>

      <section className="panel limitations" aria-labelledby="limits-title">
        <p className="eyebrow">Shared caveats</p>
        <h2 id="limits-title">Known limitations</h2>
        <div className="limit-copy">
          <p>
            Provider data carries a publication delay. Entry uses the first underlying price at or after the event
            timestamp, never a price published before it.
          </p>
          <p>
            Historical price coverage can be incomplete. Events without matched bars are recorded with a reason and
            excluded from the denominator rather than filled in.
          </p>
          <p>
            Per-signal warnings in the table come from the backend and are shown as written. This screen does not
            reword, soften, or strengthen them.
          </p>
          <p>
            Results here are descriptive, not validated. A descriptive group is not a strategy, and this comparison is
            not a recommendation to trade.
          </p>
        </div>
      </section>

      <footer>
        <span>Unusual Whales research</span>
        <span>Local-first · source-grounded · no trading advice</span>
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
