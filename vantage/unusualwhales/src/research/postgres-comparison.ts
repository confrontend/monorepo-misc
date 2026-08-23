import pg from 'pg';
import { SIGNAL_CATALOG } from './signal-catalog.js';
import { HORIZONS } from './outcomes.js';
import { comparisonWarnings, selectComparisonLeader } from './comparison-rules.js';

const { Pool } = pg;

type Summary = { raw: string; independent: string; mature: string; usable: string; wins: string; average: number | null; excess: number | null; median: number | null };

/** PostgreSQL read path for the comparison dashboard. Writes remain disabled until the
 * complete repository cutover is finished; this function is selected only explicitly. */
export const readPostgresComparison = async (pool: pg.Pool) => {
  const rows = (await pool.query(`
    WITH stats AS (
      SELECT t.signal_type, o.horizon,
        COUNT(*) AS raw,
        COUNT(*) FILTER (WHERE COALESCE(o.exclusion_reason,'') <> 'overlapping_event') AS independent,
        COUNT(*) FILTER (WHERE COALESCE(o.exclusion_reason,'') NOT IN ('overlapping_event','outcome_not_mature','missing_entry_price')) AS mature,
        COUNT(o.return_pct) AS usable,
        COUNT(*) FILTER (WHERE (t.signal_type='put_sweep' AND o.return_pct < 0) OR (t.signal_type<>'put_sweep' AND o.return_pct > 0)) AS wins,
        AVG(o.return_pct) AS average, AVG(o.excess_return_pct) AS excess,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY o.return_pct) FILTER (WHERE o.return_pct IS NOT NULL) AS median
      FROM uw_signal_outcomes o JOIN uw_option_trades t ON t.id=o.trade_id
      WHERE t.canceled=FALSE AND t.signal_type IN ('call_sweep','put_sweep')
      GROUP BY t.signal_type, o.horizon
    ) SELECT * FROM stats ORDER BY signal_type, horizon`)).rows as Array<{ signal_type: string; horizon: string } & Summary>;
  const coverage = (await pool.query(`
    SELECT signal_type, COUNT(*) AS raw, COUNT(DISTINCT underlying_symbol) AS tickers,
      MIN(executed_at) AS earliest, MAX(executed_at) AS latest
    FROM uw_option_trades WHERE canceled=FALSE GROUP BY signal_type`)).rows as Array<{ signal_type: string; raw: string; tickers: string; earliest: string|null; latest: string|null }>;
  const bySignal = new Map(coverage.map(row => [row.signal_type, row]));
  const byMetric = new Map(rows.map(row => [`${row.signal_type}:${row.horizon}`, row]));
  const signals = SIGNAL_CATALOG.map(definition => {
    const cov = bySignal.get(definition.id);
    const outcomes = HORIZONS.map(horizon => {
      const metric = byMetric.get(`${definition.id}:${horizon}`);
      if (!metric || Number(metric.usable) === 0) return { horizon, sampleSize: 0, winRatePct: null, medianReturnPct: null, averageReturnPct: null, averageExcessPct: null, afterCostsPct: { '10': null, '25': null, '50': null }, status: 'unavailable' as const };
      const direction = definition.id === 'put_sweep' ? -1 : 1;
      const average = Number(metric.average ?? 0) * direction;
      const excess = metric.excess === null ? null : Number(metric.excess) * direction;
      return { horizon, sampleSize: Number(metric.usable), winRatePct: Number(metric.wins) / Number(metric.usable) * 100, medianReturnPct: metric.median === null ? null : Number(metric.median) * direction, averageReturnPct: average, averageExcessPct: excess, afterCostsPct: { '10': average - .2, '25': average - .5, '50': average - 1 }, status: Number(metric.usable) >= 30 ? 'descriptive' as const : 'insufficient' as const };
    });
    const primaryMetric = byMetric.get(`${definition.id}:+1d`);
    const primaryOutcome = outcomes.find(outcome => outcome.horizon === '+1d')!;
    const rawEvents = Number(cov?.raw ?? 0);
    const tickers = Number(cov?.tickers ?? 0);
    return { signalId: definition.id, label: definition.label, direction: definition.direction, coverage: { status: definition.feasibility, rawEvents, independentEvents: Number(primaryMetric?.independent ?? 0), matureEvents: Number(primaryMetric?.mature ?? 0), usableOutcomes: primaryOutcome.sampleSize, tickers, earliestEvent: cov?.earliest ?? null, latestEvent: cov?.latest ?? null, availableHorizons: outcomes.filter(o => o.sampleSize > 0).map(o => o.horizon) }, outcomes, limitations: [definition.timingLimitations], warnings: comparisonWarnings({ coverageStatus: definition.feasibility, rawEvents, tickers, primaryOutcome }) };
  });
  const leader = selectComparisonLeader(signals);
  return { generatedAt: new Date().toISOString(), leader, signals };
};
