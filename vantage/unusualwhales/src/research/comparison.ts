import type { DatabaseSync } from 'node:sqlite';
import { SIGNAL_CATALOG, type SignalDefinition } from './signal-catalog.js';
import { HORIZONS, readOutcomeSummary, type OutcomeMetric } from './outcomes.js';
import { readSignalDataSummary } from '../providers/unusualwhales-ingest.js';
import { comparisonWarnings, selectComparisonLeader, type ComparisonLeader } from './comparison-rules.js';
import { readEventOutcomeMetrics } from './event-outcomes.js';

export type { ComparisonLeader } from './comparison-rules.js';

export type SignalComparisonRow = {
  signalId: string;
  label: string;
  direction: SignalDefinition['direction'];
  coverage: {
    status: SignalDefinition['feasibility'];
    rawEvents: number;
    independentEvents: number;
    matureEvents: number;
    usableOutcomes: number;
    tickers: number;
    earliestEvent: string | null;
    latestEvent: string | null;
    availableHorizons: string[];
  };
  outcomes: Array<{
    horizon: string;
    sampleSize: number;
    winRatePct: number | null;
    medianReturnPct: number | null;
    averageReturnPct: number | null;
    averageExcessPct: number | null;
    afterCostsPct: Record<'10' | '25' | '50', number | null>;
    status: OutcomeMetric['status'] | 'unavailable';
  }>;
  limitations: string[];
  warnings: string[];
};

const emptyOutcomes = (status: OutcomeMetric['status'] | 'unavailable') =>
  HORIZONS.map((horizon) => ({
    horizon,
    sampleSize: 0,
    winRatePct: null,
    medianReturnPct: null,
    averageReturnPct: null,
    averageExcessPct: null,
    afterCostsPct: { '10': null, '25': null, '50': null },
    status,
  }));

export const readSignalComparison = (database: DatabaseSync) => {
  const summary = readSignalDataSummary(database);
  const outcomeMetrics = readOutcomeSummary(database);
  const putOutcomeMetrics = readOutcomeSummary(database, 'put_sweep');
  const putCoverage = database.prepare(`SELECT COUNT(*) AS raw, COUNT(DISTINCT underlying_symbol) AS tickers, MIN(executed_at) AS earliest, MAX(executed_at) AS latest FROM uw_option_trades WHERE signal_type='put_sweep' AND canceled=0`).get() as { raw: number; tickers: number; earliest: string | null; latest: string | null };
  const darkPoolCoverage = database.prepare(`SELECT COUNT(*) AS raw, COUNT(DISTINCT ticker) AS tickers, MIN(executed_at) AS earliest, MAX(executed_at) AS latest FROM uw_dark_pool_trades WHERE canceled=0`).get() as { raw: number; tickers: number; earliest: string | null; latest: string | null };
  const signals = SIGNAL_CATALOG.map((definition): SignalComparisonRow => {
      if (definition.id === 'call_sweep') {
        const outcomes = HORIZONS.map((horizon) => {
          const metric = outcomeMetrics[horizon];
          return {
            horizon,
            sampleSize: metric.nWithOutcome,
            winRatePct: metric.winRate,
            medianReturnPct: metric.medianReturnPct,
            averageReturnPct: metric.averageReturnPct,
            averageExcessPct: metric.averageExcessPct,
            afterCostsPct: {
              '10': metric.netByCostBpsPerSide['10'] ?? null,
              '25': metric.netByCostBpsPerSide['25'] ?? null,
              '50': metric.netByCostBpsPerSide['50'] ?? null,
            },
            status: metric.nWithOutcome > 0 ? metric.status : 'unavailable' as const,
          };
        });
        return {
          signalId: definition.id,
          label: definition.label,
          direction: definition.direction,
          coverage: {
            status: definition.feasibility,
            rawEvents: summary.callSweepEvents,
            independentEvents: outcomeMetrics['+1d'].nIndependent,
            matureEvents: outcomeMetrics['+1d'].nMature,
            usableOutcomes: outcomes.find((outcome) => outcome.horizon === '+1d')!.sampleSize,
            tickers: summary.distinctTickers,
            earliestEvent: summary.earliestExecutedAt,
            latestEvent: summary.latestExecutedAt,
            availableHorizons: outcomes.filter((outcome) => outcome.sampleSize > 0).map((outcome) => outcome.horizon),
          },
          outcomes,
          limitations: [definition.timingLimitations],
          warnings: [],
        };
      }

      if (definition.id === 'put_sweep') {
        const outcomes = HORIZONS.map((horizon) => {
          const metric = putOutcomeMetrics[horizon];
          const inverse = (value: number | null) => value === null ? null : -value;
          return { horizon, sampleSize: metric.nWithOutcome, winRatePct: metric.winRate === null ? null : 100 - metric.winRate,
            medianReturnPct: inverse(metric.medianReturnPct), averageReturnPct: inverse(metric.averageReturnPct),
            averageExcessPct: inverse(metric.averageExcessPct),
            // Costs are always paid, regardless of signal direction. Apply the
            // bearish sign to the gross return first, then subtract round-trip
            // costs; negating a pre-cost-adjusted return would incorrectly make
            // costs beneficial for puts.
            afterCostsPct: { '10': inverse(metric.averageReturnPct) === null ? null : inverse(metric.averageReturnPct)! - 0.2, '25': inverse(metric.averageReturnPct) === null ? null : inverse(metric.averageReturnPct)! - 0.5, '50': inverse(metric.averageReturnPct) === null ? null : inverse(metric.averageReturnPct)! - 1 },
            status: metric.nWithOutcome > 0 ? metric.status : 'unavailable' as const };
        });
        return { signalId: definition.id, label: definition.label, direction: definition.direction,
          coverage: { status: definition.feasibility, rawEvents: summary.putSweepEvents,
            independentEvents: putOutcomeMetrics['+1d'].nIndependent,
            matureEvents: putOutcomeMetrics['+1d'].nMature,
            usableOutcomes: outcomes.find((outcome) => outcome.horizon === '+1d')!.sampleSize, tickers: Number(putCoverage.tickers ?? 0),
            earliestEvent: putCoverage.earliest ?? null, latestEvent: putCoverage.latest ?? null, availableHorizons: outcomes.filter((outcome) => outcome.sampleSize > 0).map((outcome) => outcome.horizon) },
          outcomes, limitations: [definition.timingLimitations, 'Put outcomes are direction-adjusted: stock declines are favorable.'], warnings: [] };
      }

      if (definition.id === 'dark_pool_block') {
        const eventMetrics = readEventOutcomeMetrics(database, 'dark_pool_block');
        const primary = eventMetrics['+1d'];
        return { signalId: definition.id, label: definition.label, direction: definition.direction,
          coverage: { status: definition.feasibility, rawEvents: Number(darkPoolCoverage.raw ?? 0), independentEvents: primary.nIndependent,
            matureEvents: primary.nMature, usableOutcomes: primary.nWithOutcome, tickers: Number(darkPoolCoverage.tickers ?? 0),
            earliestEvent: darkPoolCoverage.earliest ?? null, latestEvent: darkPoolCoverage.latest ?? null, availableHorizons: [] },
          outcomes: emptyOutcomes('unavailable').map((outcome) => { const metric = eventMetrics[outcome.horizon]; const status: OutcomeMetric['status'] | 'unavailable' = metric.nWithOutcome === 0 ? 'unavailable' : metric.nWithOutcome >= 30 ? 'descriptive' : 'insufficient'; return { ...outcome, sampleSize: metric.nWithOutcome, averageReturnPct: metric.averageReturnPct, averageExcessPct: metric.averageExcessPct, winRatePct: metric.winRate, afterCostsPct: metric.netByCostBpsPerSide, status }; }), limitations: [definition.timingLimitations, 'Dark Pool direction/side remains ambiguous where the provider does not report it.'], warnings: [] };
      }

      if (definition.id === 'flow_imbalance') {
        const flowOutcomeMetrics = readOutcomeSummary(database, 'flow_imbalance');
        const outcomes = HORIZONS.map((horizon) => {
          const metric = flowOutcomeMetrics[horizon];
          return { horizon, sampleSize: metric.nWithOutcome, winRatePct: metric.winRate, medianReturnPct: metric.medianReturnPct, averageReturnPct: metric.averageReturnPct, averageExcessPct: metric.averageExcessPct,
            afterCostsPct: { '10': metric.netByCostBpsPerSide['10'] ?? null, '25': metric.netByCostBpsPerSide['25'] ?? null, '50': metric.netByCostBpsPerSide['50'] ?? null },
            status: metric.nWithOutcome > 0 ? metric.status : 'unavailable' as const };
        });
        const flowCoverage = database.prepare(`SELECT COUNT(*) AS raw, COUNT(DISTINCT underlying_symbol) AS tickers, MIN(executed_at) AS earliest, MAX(executed_at) AS latest FROM uw_option_trades WHERE signal_type='flow_imbalance' AND canceled=0`).get() as { raw: number; tickers: number; earliest: string | null; latest: string | null };
        return { signalId: definition.id, label: definition.label, direction: definition.direction,
          coverage: { status: definition.feasibility, rawEvents: Number(flowCoverage.raw ?? 0), independentEvents: flowOutcomeMetrics['+1d'].nIndependent, matureEvents: flowOutcomeMetrics['+1d'].nMature, usableOutcomes: outcomes.find((outcome) => outcome.horizon === '+1d')!.sampleSize, tickers: Number(flowCoverage.tickers ?? 0), earliestEvent: flowCoverage.earliest ?? null, latestEvent: flowCoverage.latest ?? null, availableHorizons: outcomes.filter((outcome) => outcome.sampleSize > 0).map((outcome) => outcome.horizon) },
          outcomes, limitations: [definition.timingLimitations], warnings: [] };
      }

      if (definition.id === 'open_interest_spike' || definition.id === 'market_etf_flow' || definition.id === 'gex_gamma' || definition.id === 'insider_activity' || definition.id === 'congress_activity') {
        const eventCoverage = database.prepare(`SELECT COUNT(*) AS raw, COUNT(DISTINCT symbol) AS tickers, MIN(event_at) AS earliest, MAX(event_at) AS latest FROM uw_signal_events WHERE signal_type=?`).get(definition.id) as { raw: number; tickers: number; earliest: string | null; latest: string | null };
        const eventMetrics = readEventOutcomeMetrics(database, definition.id);
        const primary = eventMetrics['+1d'];
        return {
          signalId: definition.id, label: definition.label, direction: definition.direction,
          coverage: { status: definition.feasibility, rawEvents: Number(eventCoverage.raw ?? 0), independentEvents: primary.nIndependent, matureEvents: primary.nMature, usableOutcomes: primary.nWithOutcome, tickers: Number(eventCoverage.tickers ?? 0), earliestEvent: eventCoverage.earliest ?? null, latestEvent: eventCoverage.latest ?? null, availableHorizons: HORIZONS.filter((horizon) => eventMetrics[horizon].nWithOutcome > 0) },
          outcomes: emptyOutcomes('unavailable').map((outcome) => { const metric = eventMetrics[outcome.horizon]; const status: OutcomeMetric['status'] | 'unavailable' = metric.nWithOutcome === 0 ? 'unavailable' : metric.nWithOutcome >= 30 ? 'descriptive' : 'insufficient'; return { ...outcome, sampleSize: metric.nWithOutcome, averageReturnPct: metric.averageReturnPct, averageExcessPct: metric.averageExcessPct, winRatePct: metric.winRate, afterCostsPct: metric.netByCostBpsPerSide, status }; }),
          limitations: [definition.timingLimitations, 'Event outcomes use the first market bar at or after observable_at; results remain descriptive until out-of-sample validation.'],
          warnings: [],
        };
      }

      return {
        signalId: definition.id,
        label: definition.label,
        direction: definition.direction,
        coverage: {
          status: definition.feasibility,
          rawEvents: 0,
          independentEvents: 0,
          matureEvents: 0,
          usableOutcomes: 0,
          tickers: 0,
          earliestEvent: null,
          latestEvent: null,
          availableHorizons: [],
        },
        outcomes: emptyOutcomes('unavailable'),
        limitations: ['No normalized historical events have been ingested yet.', definition.timingLimitations],
        warnings: [],
      };
    });
  for (const signal of signals) {
    const primaryOutcome = signal.outcomes.find((outcome) => outcome.horizon === '+1d')!;
    signal.warnings = comparisonWarnings({
      coverageStatus: signal.coverage.status,
      rawEvents: signal.coverage.rawEvents,
      tickers: signal.coverage.tickers,
      primaryOutcome,
    });
  }
  const leader: ComparisonLeader = selectComparisonLeader(signals);
  return {
    generatedAt: new Date().toISOString(),
    leader,
    signals,
  };
};

// generatedAt is widened to allow null here (unlike readSignalComparison's own return type,
// which always has a real timestamp): the HTTP route uses this same shape for its "cache is
// still warming" placeholder, where there genuinely is no generation time yet.
export type CachedSignalComparison = Omit<ReturnType<typeof readSignalComparison>, 'generatedAt'> & { generatedAt: string | null };

/**
 * Recomputes the comparison payload and persists it as the single row other requests read.
 * This is the only place the expensive cross-signal aggregation (readOutcomeSummary, twice,
 * each running a median subquery per horizon over uw_signal_outcomes) should run against live
 * data outside of tests -- call it after refreshOutcomes() completes, not from the HTTP GET
 * handler, so a dashboard poll never has to wait on that aggregation.
 */
export const refreshComparisonCache = (database: DatabaseSync): CachedSignalComparison => {
  const payload = readSignalComparison(database);
  database.prepare(`INSERT INTO uw_comparison_cache (id, payload_json, generated_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, generated_at = excluded.generated_at`)
    .run(JSON.stringify(payload), payload.generatedAt);
  return payload;
};

/**
 * Serves the last cached comparison payload. Falls back to a live compute (and populates the
 * cache from it) only when nothing has been cached yet -- a fresh or just-migrated database,
 * where the underlying tables are empty or small enough that a live read costs nothing.
 */
export const readCachedComparison = (database: DatabaseSync): CachedSignalComparison => {
  const row = database.prepare(`SELECT payload_json AS payloadJson FROM uw_comparison_cache WHERE id = 1`).get() as { payloadJson: string } | undefined;
  if (!row) return refreshComparisonCache(database);
  return JSON.parse(row.payloadJson) as CachedSignalComparison;
};

/**
 * Reads the cached row only -- never falls back to a live compute. On a database with a
 * genuinely large uw_signal_outcomes table (millions of rows), that live-compute fallback in
 * readCachedComparison can itself take well over a minute; that's fine for a fresh/empty test
 * database but not for the real production one, especially right after a restart when the
 * cache is empty again. The HTTP route uses this instead, together with a background warm-up,
 * so a cold cache is reported honestly rather than blocking the request.
 */
export const peekCachedComparison = (database: DatabaseSync): CachedSignalComparison | null => {
  const row = database.prepare(`SELECT payload_json AS payloadJson FROM uw_comparison_cache WHERE id = 1`).get() as { payloadJson: string } | undefined;
  return row ? (JSON.parse(row.payloadJson) as CachedSignalComparison) : null;
};
