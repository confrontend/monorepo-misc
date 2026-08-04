import { Fragment, useEffect, useMemo, useState } from 'react';
import { fetchAnalysis, fetchAnalysisMeta } from './api';
import type { AggregateResult, CohortResult, HistoryWindow, Rating, RatingCallSummary, ScoreCorrelation, SignalPolicy, StrongBuyTrade, StrongBuyTrustResult, TickerAccuracy, TickerCohortResult, TickerResult, TierWinRate } from './data';

type SortKey = 'ticker' | 'signals' | 'hitRate' | 'averageReturn';
type ActiveView = 'tickers' | 'overall' | 'strong-buy' | 'tiers' | 'accuracy';

const DEFAULT_HISTORY_WINDOW: HistoryWindow = '7d';
const DEFAULT_POLICY: SignalPolicy = 'long-exit-hold';
const DEFAULT_SORT_KEY: SortKey = 'hitRate';
const DEFAULT_ACTIVE_VIEW: ActiveView = 'tickers';
const DEFAULT_ACCURACY_HORIZON = 90;
const UI_STATE_STORAGE_KEY = 'seeking-alpha-backtest-ui-state';

type HistoryOption = { value: HistoryWindow; label: string; shortLabel: string };

const buildHistoryOptions = (values: HistoryWindow[]): HistoryOption[] => values.map((value) => {
  if (value === '7d') return { value, label: 'Past 7 days', shortLabel: '7 days' };
  if (value === 'all') return { value, label: 'All available data', shortLabel: 'All' };
  const months = Number.parseInt(value, 10);
  const duration = `${months} ${months === 1 ? 'month' : 'months'}`;
  return { value, label: `Past ${duration}`, shortLabel: duration };
});

const fallbackHistoryOptions = buildHistoryOptions(['7d', '1m', '3m', '6m', '12m', 'all']);

const policyOptions: Array<{ value: SignalPolicy; label: string; shortLabel: string }> = [
  { value: 'long-exit-hold', label: 'Long-only · Exit on Hold', shortLabel: 'Exit on Hold' },
  { value: 'long-hold-through', label: 'Long-only · Hold through Hold', shortLabel: 'Hold through Hold' },
  { value: 'long-short', label: 'Long-short · Sell ratings short', shortLabel: 'Long-short' },
];

const policyLabels: Record<SignalPolicy, string> = Object.fromEntries(policyOptions.map((option) => [option.value, option.label])) as Record<SignalPolicy, string>;
const policyExitRules: Record<SignalPolicy, string> = {
  'long-exit-hold': 'Exit when rating falls to Hold, Sell, or Strong Sell',
  'long-hold-through': 'Keep the position through Hold; exit on Sell or Strong Sell',
  'long-short': 'Exit to cash on Hold; short on Sell or Strong Sell',
};

const ratingClass = (rating: TickerResult['latestRating']) => {
  if (rating.includes('Buy')) return 'rating rating-buy';
  if (rating.includes('Sell')) return 'rating rating-sell';
  return 'rating rating-hold';
};

const signedPercent = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
const matrixKey = (window: HistoryWindow, policy: SignalPolicy) => `${window}|${policy}`;

type PersistedUiState = {
  activeView: ActiveView;
  historyWindow: HistoryWindow;
  policy: SignalPolicy;
  sortKey: SortKey;
  accuracyHorizon: number;
};

const defaultUiState: PersistedUiState = {
  activeView: DEFAULT_ACTIVE_VIEW,
  historyWindow: DEFAULT_HISTORY_WINDOW,
  policy: DEFAULT_POLICY,
  sortKey: DEFAULT_SORT_KEY,
  accuracyHorizon: DEFAULT_ACCURACY_HORIZON,
};

const readPersistedUiState = (): PersistedUiState => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(UI_STATE_STORAGE_KEY) ?? '{}') as Partial<PersistedUiState>;
    const activeView = parsed.activeView === 'tickers' || parsed.activeView === 'overall' || parsed.activeView === 'strong-buy' || parsed.activeView === 'tiers' || parsed.activeView === 'accuracy' ? parsed.activeView : DEFAULT_ACTIVE_VIEW;
    const historyWindow = parsed.historyWindow === '7d' || parsed.historyWindow === 'all' || (typeof parsed.historyWindow === 'string' && /^\d+m$/.test(parsed.historyWindow)) ? parsed.historyWindow as HistoryWindow : DEFAULT_HISTORY_WINDOW;
    const policy = policyOptions.some((option) => option.value === parsed.policy) ? parsed.policy as SignalPolicy : DEFAULT_POLICY;
    const sortKey = parsed.sortKey === 'ticker' || parsed.sortKey === 'signals' || parsed.sortKey === 'hitRate' || parsed.sortKey === 'averageReturn' ? parsed.sortKey : DEFAULT_SORT_KEY;
    const accuracyHorizon = typeof parsed.accuracyHorizon === 'number' && Number.isFinite(parsed.accuracyHorizon) && parsed.accuracyHorizon > 0 ? parsed.accuracyHorizon : DEFAULT_ACCURACY_HORIZON;
    return { activeView, historyWindow, policy, sortKey, accuracyHorizon };
  } catch {
    return defaultUiState;
  }
};

// Rating tiers view uses a shorter column set than the rest of the app: 7 days through 24
// months, plus All — per user request, the 30m-54m windows in between weren't useful here.
const fallbackTierHistoryOptions = fallbackHistoryOptions.filter((option) => {
  if (option.value === '7d' || option.value === 'all') return true;
  return Number.parseInt(option.value, 10) <= 24;
});

function OverallResultsTable({ rows, historyOptions }: { rows: AggregateResult[]; historyOptions: HistoryOption[] }) {
  return (
    <section className="table-panel aggregate-panel" aria-labelledby="aggregate-title">
      <div className="table-heading">
        <div><h2 id="aggregate-title">Strategy versus buy-and-hold</h2><p>Every available history and policy combination across all benchmarked tickers</p></div>
        <span className="data-badge">{rows.length} combinations</span>
      </div>
      <div className="aggregate-rule">
        <span><strong>Good:</strong> average and median extra return above 0%, with at least 60% of tickers beating hold</span>
        <span><strong>Poor:</strong> average and median below 0%, with at most 40% beating hold</span>
        <span><strong>Confidence:</strong> Low below 10 tickers, Medium from 10, High from 30</span>
      </div>
      <div className="table-scroll">
        <table className="aggregate-table">
          <thead><tr><th>Signal history</th><th>Signal policy</th><th className="number">Tickers tested</th><th className="number">Beat holding</th><th className="number">Avg extra return</th><th className="number">Median extra return</th><th className="number">Avg strategy</th><th className="number">Avg buy &amp; hold</th><th>Confidence</th><th>Verdict</th></tr></thead>
          <tbody>{rows.map((row) => {
            const historyLabel = historyOptions.find((option) => option.value === row.window)?.shortLabel ?? row.window;
            const policyLabel = policyOptions.find((option) => option.value === row.policy)?.shortLabel ?? row.policy;
            return (
              <tr key={matrixKey(row.window, row.policy)}>
                <td><strong>{historyLabel}</strong></td>
                <td>{policyLabel}</td>
                <td className="number">{row.tickersTested}/{row.totalTickers}</td>
                <td className={`number ${row.beatBenchmarkRate >= 50 ? 'positive' : 'negative'}`}>{row.beatBenchmarkCount}/{row.tickersTested} · {row.beatBenchmarkRate.toFixed(1)}%</td>
                <td className={`number ${row.averageExtraReturn >= 0 ? 'positive' : 'negative'}`}>{signedPercent(row.averageExtraReturn)}</td>
                <td className={`number ${row.medianExtraReturn >= 0 ? 'positive' : 'negative'}`}>{signedPercent(row.medianExtraReturn)}</td>
                <td className={`number ${row.averageStrategyReturn >= 0 ? 'positive' : 'negative'}`}>{signedPercent(row.averageStrategyReturn)}</td>
                <td className={`number ${row.averageBenchmarkReturn >= 0 ? 'positive' : 'negative'}`}>{signedPercent(row.averageBenchmarkReturn)}</td>
                <td><span className={`confidence confidence-${row.confidence.toLowerCase()}`}>{row.confidence}</span></td>
                <td><span className={`verdict verdict-${row.verdict.toLowerCase().replace(/ /g, '-')}`}>{row.verdict}</span></td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
      <footer className="table-footer"><span>Extra return = strategy return − buy-and-hold return</span><span>Only locally cached benchmark files are included</span></footer>
    </section>
  );
}

type StrongBuySummary = Omit<StrongBuyTrustResult, 'trades'>;

function StrongBuyTrustView({ rows }: { rows: StrongBuySummary[] }) {
  const [expandedTickers, setExpandedTickers] = useState<Set<string>>(() => new Set());
  const [tradesByTicker, setTradesByTicker] = useState<Map<string, StrongBuyTrade[]>>(() => new Map());
  const [loadingTicker, setLoadingTicker] = useState<string | null>(null);
  const completedTrades = rows.reduce((total, row) => total + row.completedTrades, 0);
  const wins = rows.reduce((total, row) => total + row.wins, 0);
  const openTrades = rows.filter((row) => row.openTradeReturn !== null).length;
  const winRate = completedTrades ? (wins / completedTrades) * 100 : null;

  const toggleTicker = async (ticker: string) => {
    if (expandedTickers.has(ticker)) {
      setExpandedTickers((current) => { const next = new Set(current); next.delete(ticker); return next; });
      return;
    }
    setExpandedTickers((current) => new Set(current).add(ticker));
    if (!tradesByTicker.has(ticker)) {
      setLoadingTicker(ticker);
      try {
        const response = await fetchAnalysis<StrongBuyTrustResult>('strongBuyTrades', { ticker });
        setTradesByTicker((current) => new Map(current).set(ticker, response.data?.trades ?? []));
      } finally {
        setLoadingTicker(null);
      }
    }
  };

  return (
    <>
      <div className="trust-warning"><strong>Scope:</strong> This tests historical Strong Buy calls only for the currently loaded tickers. It does not include stocks that disappeared from past Strong Buy lists.</div>
      <section className="trust-summary" aria-label="Strong Buy call summary">
        <div><span>Tickers tested</span><strong>{rows.length}</strong></div>
        <div><span>Completed calls</span><strong>{completedTrades}</strong></div>
        <div><span>Winning calls</span><strong>{wins}</strong></div>
        <div><span>Overall win rate</span><strong className={winRate !== null && winRate >= 50 ? 'positive' : 'negative'}>{winRate === null ? 'N/A' : `${winRate.toFixed(1)}%`}</strong></div>
        <div><span>Still open</span><strong>{openTrades}</strong></div>
      </section>
      <section className="table-panel" aria-labelledby="trust-title">
        <div className="table-heading"><div><h2 id="trust-title">Historical Strong Buy calls</h2><p>Buy on entry into Strong Buy · sell on the first change to any other rating</p></div><span className="data-badge">{rows.length} tickers</span></div>
        <div className="table-scroll">
          <table className="trust-table">
            <thead><tr><th>Ticker</th><th className="number">Completed</th><th className="number">Wins</th><th className="number">Losses</th><th className="number">Win rate</th><th className="number">Avg call return</th><th className="number">Median call return</th><th className="number">Growth of $100</th><th>Open call</th><th>Date range</th><th className="actions-heading">Calls</th></tr></thead>
            <tbody>{rows.map((row) => {
              const expanded = expandedTickers.has(row.ticker);
              const trades = tradesByTicker.get(row.ticker) ?? [];
              return (
                <Fragment key={row.ticker}>
                  <tr className={expanded ? 'ticker-row matrix-open' : 'ticker-row'}>
                    <td><span className="ticker">{row.ticker}</span><span className="company">{row.company}</span></td>
                    <td className="number">{row.completedTrades}</td>
                    <td className="number positive">{row.wins}</td>
                    <td className="number negative">{row.losses}</td>
                    <td className={`number ${row.winRate === null ? 'muted' : row.winRate >= 50 ? 'positive' : 'negative'}`}>{row.winRate === null ? 'N/A' : `${row.winRate.toFixed(1)}%`}</td>
                    <td className={`number ${row.averageTradeReturn === null ? 'muted' : row.averageTradeReturn >= 0 ? 'positive' : 'negative'}`}>{row.averageTradeReturn === null ? 'N/A' : signedPercent(row.averageTradeReturn)}</td>
                    <td className={`number ${row.medianTradeReturn === null ? 'muted' : row.medianTradeReturn >= 0 ? 'positive' : 'negative'}`}>{row.medianTradeReturn === null ? 'N/A' : signedPercent(row.medianTradeReturn)}</td>
                    <td className={`number ${row.totalReturn >= 0 ? 'positive' : 'negative'}`}>${row.endingValue.toFixed(2)}</td>
                    <td className={row.openTradeReturn === null ? 'muted' : row.openTradeReturn >= 0 ? 'positive' : 'negative'}>{row.openTradeReturn === null ? 'None' : signedPercent(row.openTradeReturn)}</td>
                    <td className="muted">{row.dateRange}</td>
                    <td><div className="row-actions"><button className={expanded ? 'icon-button active' : 'icon-button'} type="button" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${row.ticker} Strong Buy calls`} aria-expanded={expanded} onClick={() => toggleTicker(row.ticker)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM4 10h16M9 5v14M14 5v14" /></svg><svg className={expanded ? 'chevron rotated' : 'chevron'} viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4" /></svg></button></div></td>
                  </tr>
                  {expanded && <tr className="trust-calls-row"><td colSpan={11}><div className="trust-calls"><div className="strategy-matrix-heading"><strong>{row.ticker} · individual Strong Buy calls</strong><span>Repeated Strong Buy days are ignored</span></div>{loadingTicker === row.ticker ? <p className="muted">Loading calls…</p> : <><table><thead><tr><th>Entered</th><th className="number">Entry price</th><th>Exited</th><th>New rating</th><th className="number">Exit price</th><th className="number">Return</th><th>Status</th></tr></thead><tbody>{trades.map((trade, index) => <tr key={`${trade.entryDate}-${index}`}><td>{trade.entryDate}</td><td className="number">${trade.entryPrice.toFixed(2)}</td><td>{trade.exitDate ?? 'Still open'}</td><td>{trade.exitRating ?? 'Strong Buy'}</td><td className="number">{trade.exitPrice === null ? '—' : `$${trade.exitPrice.toFixed(2)}`}</td><td className={`number ${trade.returnPercent >= 0 ? 'positive' : 'negative'}`}>{signedPercent(trade.returnPercent)}</td><td><span className={`call-status call-${trade.status.toLowerCase()}`}>{trade.status}</span></td></tr>)}</tbody></table>{trades.length === 0 && <p className="muted">No recorded transitions into Strong Buy.</p>}</>}</div></td></tr>}
                </Fragment>
              );
            })}</tbody>
          </table>
        </div>
        <footer className="table-footer"><span>Growth of $100 compounds completed calls and marks any open call at the final captured price</span><span>An initial Strong Buy is skipped when its true entry date predates the captured history · no benchmark comparison</span></footer>
      </section>
    </>
  );
}

const cohortKey = (tier: CohortResult['tier'], window: HistoryWindow) => `${tier}|${window}`;

const tierDotColor = (tier: Rating) => (tier.includes('Buy') ? '#65d7aa' : tier.includes('Sell') ? '#ff9297' : '#f0c45e');

function ScoreCorrelationChart({ correlation }: { correlation: ScoreCorrelation }) {
  const { points, correlation: r, slope, intercept } = correlation;
  if (points.length < 2) return null;

  const width = 720;
  const height = 380;
  const marginLeft = 64;
  const marginRight = 20;
  const marginTop = 20;
  const marginBottom = 46;
  const plotWidth = width - marginLeft - marginRight;
  const plotHeight = height - marginTop - marginBottom;

  const scores = points.map((point) => point.score);
  const excesses = points.map((point) => point.excessReturn);
  const xMin = Math.min(1, Math.floor(Math.min(...scores) * 10) / 10 - 0.1);
  const xMax = Math.max(5, Math.ceil(Math.max(...scores) * 10) / 10 + 0.1);
  const rawYMin = Math.min(0, ...excesses);
  const rawYMax = Math.max(0, ...excesses);
  const yPadding = Math.max(10, (rawYMax - rawYMin) * 0.1);
  const yMin = rawYMin - yPadding;
  const yMax = rawYMax + yPadding;

  const xScale = (score: number) => marginLeft + ((score - xMin) / (xMax - xMin)) * plotWidth;
  const yScale = (excess: number) => marginTop + (1 - (excess - yMin) / (yMax - yMin)) * plotHeight;

  const yTickCount = 5;
  const yTickValues = Array.from({ length: yTickCount + 1 }, (_, index) => yMin + ((yMax - yMin) / yTickCount) * index);
  const xTickCount = 6;
  const xTickValues = Array.from({ length: xTickCount + 1 }, (_, index) => xMin + ((xMax - xMin) / xTickCount) * index);

  const trendEndpoints = slope !== null && intercept !== null
    ? [{ x: xMin, y: intercept + (slope * xMin) }, { x: xMax, y: intercept + (slope * xMax) }]
    : null;

  return (
    <section className="table-panel aggregate-panel" aria-labelledby="score-corr-title">
      <div className="table-heading">
        <div><h2 id="score-corr-title">Quant score vs. excess return</h2><p>Each dot is one stock's full-history return minus the S&amp;P 500's, plotted against its current score</p></div>
        <span className="data-badge">{r === null ? 'n/a' : `r = ${r.toFixed(2)}`}</span>
      </div>
      <div className="aggregate-rule">
        <span>Positive excess return = that stock beat the market · dashed horizontal line marks zero · dashed diagonal line is the trend</span>
        <span><span className="score-dot" style={{ background: tierDotColor('Strong Buy') }} />Strong Buy <span className="score-dot" style={{ background: tierDotColor('Hold') }} />Hold <span className="score-dot" style={{ background: tierDotColor('Sell') }} />Sell</span>
      </div>
      <div style={{ padding: '16px 20px' }}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Scatter plot of quant score versus excess return over the S&P 500, one dot per stock" style={{ width: '100%', height: 'auto' }}>
          {yTickValues.map((value) => (
            <Fragment key={`y-${value}`}>
              <line x1={marginLeft} x2={width - marginRight} y1={yScale(value)} y2={yScale(value)} stroke="#26334a" strokeWidth={1} />
              <text x={marginLeft - 8} y={yScale(value)} textAnchor="end" dominantBaseline="middle" fontSize={10} fill="#8292ac">{value.toFixed(0)}%</text>
            </Fragment>
          ))}
          {xTickValues.map((value) => (
            <Fragment key={`x-${value}`}>
              <line x1={xScale(value)} x2={xScale(value)} y1={marginTop} y2={marginTop + plotHeight} stroke="#1c2942" strokeWidth={1} />
              <text x={xScale(value)} y={marginTop + plotHeight + 18} textAnchor="middle" fontSize={10} fill="#8292ac">{value.toFixed(1)}</text>
            </Fragment>
          ))}
          <line x1={marginLeft} x2={width - marginRight} y1={yScale(0)} y2={yScale(0)} stroke="#5f6f8c" strokeWidth={1.4} strokeDasharray="5 4" />
          {trendEndpoints && (
            <line x1={xScale(trendEndpoints[0].x)} y1={yScale(trendEndpoints[0].y)} x2={xScale(trendEndpoints[1].x)} y2={yScale(trendEndpoints[1].y)} stroke="#8ab0ff" strokeWidth={2} strokeDasharray="7 5" />
          )}
          {points.map((point) => (
            <circle key={point.ticker} cx={xScale(point.score)} cy={yScale(point.excessReturn)} r={6} fill={tierDotColor(point.tier)} fillOpacity={0.85} stroke="#0b1220" strokeWidth={1}>
              <title>{`${point.ticker} (${point.tier}) · score ${point.score.toFixed(2)} · ${point.excessReturn >= 0 ? '+' : ''}${point.excessReturn.toFixed(1)}% vs S&P 500`}</title>
            </circle>
          ))}
          <text x={marginLeft + (plotWidth / 2)} y={height - 8} textAnchor="middle" fontSize={11} fill="#8292ac">Quant score</text>
          <text x={16} y={marginTop + (plotHeight / 2)} textAnchor="middle" fontSize={11} fill="#8292ac" transform={`rotate(-90 16 ${marginTop + (plotHeight / 2)})`}>Excess return vs S&amp;P 500 (%)</text>
        </svg>
      </div>
      <footer className="table-footer">
        <span>{points.length} stocks with cached benchmark data</span>
        <span>Caveat: score barely varies within a tier in the currently captured data, so this mostly reflects tier-to-tier separation, not fine-grained differences (e.g. 4.1 vs 4.9) — capture tickers spanning a wider score range within each tier for a stronger test</span>
      </footer>
    </section>
  );
}

function TierWinRateSummary({ rows }: { rows: TierWinRate[] }) {
  if (!rows.length) return null;
  return (
    <section className="table-panel aggregate-panel" aria-labelledby="winrate-title">
      <div className="table-heading">
        <div><h2 id="winrate-title">Win rate vs. S&amp;P 500</h2><p>Share of stocks in each tier that beat the market over their full tracked history</p></div>
      </div>
      <div className="winrate-list">
        {rows.map((row) => (
          <div className="winrate-row" key={row.tier}>
            <span className="winrate-label">{row.tier}</span>
            <div className="winrate-track"><i className={row.winRate >= 50 ? 'winrate-fill-positive' : 'winrate-fill-negative'} style={{ width: `${row.winRate}%` }} /></div>
            <span className={`winrate-value ${row.winRate >= 50 ? 'positive' : 'negative'}`}>{row.winRate.toFixed(1)}%</span>
            <span className="muted winrate-count">{row.wins}/{row.total}</span>
          </div>
        ))}
      </div>
      <footer className="table-footer"><span>Sample sizes are small — exact counts shown next to each bar</span><span>Basis: each stock's full tracked history vs. the S&amp;P 500 over the same span</span></footer>
    </section>
  );
}

function RatingTierTable({ rows, tiers, historyOptions }: { rows: CohortResult[]; tiers: Array<CohortResult['tier']>; historyOptions: HistoryOption[] }) {
  const byKey = new Map(rows.map((row) => [cohortKey(row.tier, row.window), row]));
  const comparisonTiers = tiers.filter((tier) => tier !== 'Market');
  return (
    <section className="table-panel aggregate-panel" aria-labelledby="tiers-title">
      <div className="table-heading">
        <div><h2 id="tiers-title">Rating tier vs. S&amp;P 500</h2><p>Each group&apos;s real buy-and-hold return minus the market&apos;s return for the same window</p></div>
        <span className="data-badge">{comparisonTiers.length} groups</span>
      </div>
      <div className="aggregate-rule">
        <span>Grouped by each ticker&apos;s <strong>current</strong> rating — not a rating history, so treat this as &quot;do today&apos;s Hold/Sell stocks look weaker than today&apos;s Buy stocks,&quot; not proof the rating predicted anything</span>
        <span>Uses real cached prices (same source as Buy &amp; hold column), not the strategy replay</span>
      </div>
      <div className="table-scroll">
        <table className="aggregate-table">
          <thead><tr><th>Rating tier − S&amp;P 500</th>{historyOptions.map((option) => <th key={option.value} className="number">{option.shortLabel}</th>)}</tr></thead>
          <tbody>
            {comparisonTiers.map((tier) => (
              <tr key={tier}>
                <th>{tier} − S&amp;P 500</th>
                {historyOptions.map((option) => {
                  const tierCell = byKey.get(cohortKey(tier, option.value));
                  const marketCell = byKey.get(cohortKey('Market', option.value));
                  if (!tierCell || tierCell.averageReturn === null || !marketCell || marketCell.averageReturn === null) {
                    return <td key={option.value} className="matrix-empty">No data</td>;
                  }
                  const diff = tierCell.averageReturn - marketCell.averageReturn;
                  return (
                    <td key={option.value} className={`number ${diff >= 0 ? 'positive' : 'negative'}`}>
                      {signedPercent(diff)}
                      <div className="muted" style={{ fontSize: 10, marginTop: 3 }}>{tierCell.tickerCount}/{tierCell.totalInTier} tickers</div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer className="table-footer"><span>Add tickers with Hold/Sell/Strong Sell ratings to input/ for a stronger comparison — currently skewed toward Buy/Strong Buy</span><span>Positive = that tier beat the S&amp;P 500 · Market prices cached — run npm run fetch:benchmark to refresh</span></footer>
    </section>
  );
}

const tierSortOrder: Record<string, number> = { 'Strong Buy': 0, Buy: 1, Hold: 2, Sell: 3, 'Strong Sell': 4 };

function TickerCohortTable({ results, historyOptions }: { results: TickerCohortResult[]; historyOptions: HistoryOption[] }) {
  const byTicker = new Map<string, { company: string; tier: TickerCohortResult['tier']; cells: Map<HistoryWindow, TickerCohortResult> }>();
  results.forEach((result) => {
    const entry = byTicker.get(result.ticker) ?? { company: result.company, tier: result.tier, cells: new Map<HistoryWindow, TickerCohortResult>() };
    entry.cells.set(result.window, result);
    byTicker.set(result.ticker, entry);
  });
  const rows = [...byTicker.entries()].sort(([tickerA, a], [tickerB, b]) => {
    const tierOrderDiff = (tierSortOrder[a.tier] ?? 99) - (tierSortOrder[b.tier] ?? 99);
    return tierOrderDiff !== 0 ? tierOrderDiff : tickerA.localeCompare(tickerB);
  });

  return (
    <section className="table-panel aggregate-panel" aria-labelledby="ticker-cohort-title">
      <div className="table-heading">
        <div><h2 id="ticker-cohort-title">Real performance by individual ticker</h2><p>Same real buy-and-hold prices as above, broken out per stock instead of averaged</p></div>
        <span className="data-badge">{rows.length} tickers</span>
      </div>
      <div className="table-scroll">
        <table className="aggregate-table">
          <thead><tr><th>Ticker</th><th>Rating</th>{historyOptions.map((option) => <th key={option.value} className="number">{option.shortLabel}</th>)}</tr></thead>
          <tbody>
            {rows.map(([ticker, entry]) => (
              <tr key={ticker}>
                <td><span className="ticker">{ticker}</span><span className="company">{entry.company}</span></td>
                <td><span className={ratingClass(entry.tier)}>{entry.tier}</span></td>
                {historyOptions.map((option) => {
                  const cell = entry.cells.get(option.value);
                  if (!cell || cell.totalReturn === null) return <td key={option.value} className="matrix-empty">No data</td>;
                  return <td key={option.value} className={`number ${cell.totalReturn >= 0 ? 'positive' : 'negative'}`}>{signedPercent(cell.totalReturn)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer className="table-footer"><span>Each cell is that one stock's own real buy-and-hold return for the window — no averaging</span><span>Grouped by current rating tier, ticker alphabetical within each tier</span></footer>
    </section>
  );
}

// Ticker accuracy points span a ticker's whole captured history, so the rating it carried can
// change day to day. This collapses that history down to "always one tier" (show which one) or
// "Mixed" (it moved between tiers at some point) — the metadata the ticker picker needs.
const tickerRatingSummary = (row: TickerAccuracy): { label: string; ratings: Rating[] } => {
  const seen = new Set<Rating>();
  row.points.forEach((point) => seen.add(point.rating));
  const ratings = [...seen].sort((left, right) => (tierSortOrder[left] ?? 99) - (tierSortOrder[right] ?? 99));
  return { label: ratings.length <= 1 ? (ratings[0] ?? 'Hold') : 'Mixed', ratings };
};

function TickerAccuracyChart({ accuracy, horizonDays }: { accuracy: TickerAccuracy; horizonDays: number }) {
  const { points, correlation: r, slope, intercept } = accuracy;
  if (points.length < 2) {
    return (
      <section className="table-panel aggregate-panel">
        <div className="table-heading"><div><h2>{accuracy.ticker} · score vs. {horizonDays}-day forward return</h2><p>Not enough matched observations yet for this ticker at this horizon</p></div></div>
      </section>
    );
  }

  const width = 720;
  const height = 380;
  const marginLeft = 64;
  const marginRight = 20;
  const marginTop = 20;
  const marginBottom = 46;
  const plotWidth = width - marginLeft - marginRight;
  const plotHeight = height - marginTop - marginBottom;

  const scores = points.map((point) => point.score);
  const returns = points.map((point) => point.forwardReturn);
  const xMin = Math.min(1, Math.floor(Math.min(...scores) * 10) / 10 - 0.1);
  const xMax = Math.max(5, Math.ceil(Math.max(...scores) * 10) / 10 + 0.1);
  const rawYMin = Math.min(0, ...returns);
  const rawYMax = Math.max(0, ...returns);
  const yPadding = Math.max(5, (rawYMax - rawYMin) * 0.1);
  const yMin = rawYMin - yPadding;
  const yMax = rawYMax + yPadding;

  const xScale = (score: number) => marginLeft + ((score - xMin) / (xMax - xMin)) * plotWidth;
  const yScale = (value: number) => marginTop + (1 - (value - yMin) / (yMax - yMin)) * plotHeight;

  const yTickCount = 5;
  const yTickValues = Array.from({ length: yTickCount + 1 }, (_, index) => yMin + ((yMax - yMin) / yTickCount) * index);
  const xTickCount = 6;
  const xTickValues = Array.from({ length: xTickCount + 1 }, (_, index) => xMin + ((xMax - xMin) / xTickCount) * index);

  const trendEndpoints = slope !== null && intercept !== null
    ? [{ x: xMin, y: intercept + (slope * xMin) }, { x: xMax, y: intercept + (slope * xMax) }]
    : null;

  return (
    <section className="table-panel aggregate-panel" aria-labelledby="accuracy-chart-title">
      <div className="table-heading">
        <div><h2 id="accuracy-chart-title">{accuracy.ticker} · rating vs. {horizonDays}-day forward return</h2><p>Each dot is one historical day for {accuracy.ticker}: its quant score then, plotted against its own price return over the following {horizonDays} days</p></div>
        <span className="data-badge">{r === null ? 'n/a' : `r = ${r.toFixed(2)}`}</span>
      </div>
      <div className="aggregate-rule">
        <span>Positive forward return = price was higher {horizonDays} days later · dashed horizontal line marks zero · dashed diagonal line is the trend</span>
        <span><span className="score-dot" style={{ background: tierDotColor('Strong Buy') }} />Strong Buy <span className="score-dot" style={{ background: tierDotColor('Hold') }} />Hold <span className="score-dot" style={{ background: tierDotColor('Sell') }} />Sell</span>
      </div>
      <div style={{ padding: '16px 20px' }}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Scatter plot of ${accuracy.ticker}'s quant score versus its own price return ${horizonDays} days later, one dot per historical day`} style={{ width: '100%', height: 'auto' }}>
          {yTickValues.map((value) => (
            <Fragment key={`y-${value}`}>
              <line x1={marginLeft} x2={width - marginRight} y1={yScale(value)} y2={yScale(value)} stroke="#26334a" strokeWidth={1} />
              <text x={marginLeft - 8} y={yScale(value)} textAnchor="end" dominantBaseline="middle" fontSize={10} fill="#8292ac">{value.toFixed(0)}%</text>
            </Fragment>
          ))}
          {xTickValues.map((value) => (
            <Fragment key={`x-${value}`}>
              <line x1={xScale(value)} x2={xScale(value)} y1={marginTop} y2={marginTop + plotHeight} stroke="#1c2942" strokeWidth={1} />
              <text x={xScale(value)} y={marginTop + plotHeight + 18} textAnchor="middle" fontSize={10} fill="#8292ac">{value.toFixed(1)}</text>
            </Fragment>
          ))}
          <line x1={marginLeft} x2={width - marginRight} y1={yScale(0)} y2={yScale(0)} stroke="#5f6f8c" strokeWidth={1.4} strokeDasharray="5 4" />
          {trendEndpoints && (
            <line x1={xScale(trendEndpoints[0].x)} y1={yScale(trendEndpoints[0].y)} x2={xScale(trendEndpoints[1].x)} y2={yScale(trendEndpoints[1].y)} stroke="#8ab0ff" strokeWidth={2} strokeDasharray="7 5" />
          )}
          {points.map((point, index) => (
            <circle key={`${point.date}-${index}`} cx={xScale(point.score)} cy={yScale(point.forwardReturn)} r={5} fill={tierDotColor(point.rating)} fillOpacity={0.75} stroke="#0b1220" strokeWidth={1}>
              <title>{`${point.date} (${point.rating}, score ${point.score.toFixed(2)}) → ${point.forwardDate}: ${point.forwardReturn >= 0 ? '+' : ''}${point.forwardReturn.toFixed(1)}%`}</title>
            </circle>
          ))}
          <text x={marginLeft + (plotWidth / 2)} y={height - 8} textAnchor="middle" fontSize={11} fill="#8292ac">Quant score on the day</text>
          <text x={16} y={marginTop + (plotHeight / 2)} textAnchor="middle" fontSize={11} fill="#8292ac" transform={`rotate(-90 16 ${marginTop + (plotHeight / 2)})`}>Return over next {horizonDays} days (%)</text>
        </svg>
      </div>
      <footer className="table-footer">
        <span>{points.length} matched observations for {accuracy.ticker}</span>
        <span>Uses only {accuracy.ticker}'s own captured history and its own price — no S&amp;P 500 comparison</span>
      </footer>
    </section>
  );
}

// Renamed from an earlier "Conclusion" box after review: a per-day correlation isn't a valid
// headline result (see the caveat on `buildTickerAccuracy` in data.ts), so this is now explicitly
// framed as a hedged, exploratory observation, and the event-based `RatingCallConclusion` above is
// the actual conclusion.
function ExploratoryCorrelationNote({ rows, horizonDays }: { rows: TickerAccuracy[]; horizonDays: number }) {
  const tested = rows.filter((row): row is TickerAccuracy & { correlation: number } => row.correlation !== null);
  if (!tested.length) return null;

  const positive = tested.filter((row) => row.correlation > 0).length;
  const negative = tested.filter((row) => row.correlation < 0).length;
  const positiveShare = (positive / tested.length) * 100;
  const averageR = tested.reduce((total, row) => total + row.correlation, 0) / tested.length;

  return (
    <section className="conclusion-box exploratory" aria-labelledby="accuracy-exploratory-title">
      <h3 id="accuracy-exploratory-title">Exploratory pattern (not a conclusion)</h3>
      <p>
        Across {tested.length} tickers, {positive} of {tested.length} ({positiveShare.toFixed(0)}%) show a positive per-day correlation between rating and the {horizonDays}-day forward return, {negative} show a negative correlation, and the average correlation is {averageR >= 0 ? '+' : ''}{averageR.toFixed(2)}. Treat this only as a rough visual pattern: consecutive daily observations at a fixed horizon overlap almost completely (a Monday and Tuesday observation share nearly the whole window), so these are not independent tests and the r values overstate confidence. It also scores every day's rating against a future price even when the rating changed in between. See the event-based conclusion above, which avoids both problems.
      </p>
    </section>
  );
}

function RatingCallConclusion({ summary }: { summary: RatingCallSummary | null }) {
  if (!summary) return null;
  const { horizonDays, scoredCalls, correctCalls, incorrectCalls, hitRate, hitRateLow, hitRateHigh, averageReturn, medianReturn, openCalls, neutralCalls } = summary;

  if (!scoredCalls) {
    return (
      <section className="conclusion-box" aria-labelledby="calls-conclusion-title">
        <h3 id="calls-conclusion-title">Conclusion: was the call right until it changed?</h3>
        <p>Not enough closed bullish/bearish rating episodes yet at this horizon to test ({openCalls} still open, {neutralCalls} Hold-only).</p>
      </section>
    );
  }

  const verdict = hitRateLow !== null && hitRateLow > 50
    ? 'ratings have been reliably better than a coin flip'
    : hitRateHigh !== null && hitRateHigh < 50
      ? 'ratings have been reliably worse than a coin flip'
      : 'the hit rate is not statistically distinguishable from a coin flip yet';
  const verdictClass = hitRateLow !== null && hitRateLow > 50 ? 'positive' : hitRateHigh !== null && hitRateHigh < 50 ? 'negative' : 'muted';

  return (
    <section className="conclusion-box" aria-labelledby="calls-conclusion-title">
      <h3 id="calls-conclusion-title">Conclusion: was the call right until it changed?</h3>
      <p>
        Each bullish or bearish rating episode is tested once, independently: the call opens when the rating changes and closes at the next rating change or after {horizonDays} days, whichever comes first — so long-running unchanged ratings still get scored in fresh, non-overlapping chunks instead of one call or none. Based on {scoredCalls} such calls, <strong className={verdictClass}>{verdict}</strong>: {correctCalls} of {scoredCalls} ({hitRate !== null ? hitRate.toFixed(0) : '—'}%) were correct, with a 95% confidence range of {hitRateLow !== null ? hitRateLow.toFixed(0) : '—'}%–{hitRateHigh !== null ? hitRateHigh.toFixed(0) : '—'}%. Average return per call was {averageReturn !== null ? signedPercent(averageReturn) : 'n/a'} (median {medianReturn !== null ? signedPercent(medianReturn) : 'n/a'}).
      </p>
      <div className="conclusion-stats">
        <div><span>Scored calls</span><strong>{scoredCalls}</strong></div>
        <div><span>Correct</span><strong className="positive">{correctCalls}</strong></div>
        <div><span>Incorrect</span><strong className="negative">{incorrectCalls}</strong></div>
        <div><span>Hit rate (95% CI)</span><strong className={verdictClass}>{hitRate !== null ? hitRate.toFixed(0) : '—'}% ({hitRateLow !== null ? hitRateLow.toFixed(0) : '—'}–{hitRateHigh !== null ? hitRateHigh.toFixed(0) : '—'}%)</strong></div>
        <div><span>Avg return / call</span><strong className={averageReturn !== null && averageReturn >= 0 ? 'positive' : 'negative'}>{averageReturn !== null ? signedPercent(averageReturn) : 'n/a'}</strong></div>
        <div><span>Still open</span><strong className="muted">{openCalls}</strong></div>
        <div><span>Hold-only (unscored)</span><strong className="muted">{neutralCalls}</strong></div>
      </div>
    </section>
  );
}

function RatingCallTable({ summary }: { summary: RatingCallSummary | null }) {
  if (!summary || !summary.calls.length) return null;

  const byTicker = new Map<string, { company: string; calls: RatingCallSummary['calls'] }>();
  summary.calls.forEach((call) => {
    const entry = byTicker.get(call.ticker) ?? { company: call.company, calls: [] };
    entry.calls.push(call);
    byTicker.set(call.ticker, entry);
  });

  const rows = [...byTicker.entries()].map(([ticker, entry]) => {
    const scored = entry.calls.filter((call) => call.correct !== null);
    const correct = scored.filter((call) => call.correct).length;
    const avgReturn = scored.length ? scored.reduce((total, call) => total + (call.returnPercent ?? 0), 0) / scored.length : null;
    const open = entry.calls.filter((call) => call.exitReason === 'Still open').length;
    return { ticker, company: entry.company, totalCalls: entry.calls.length, scoredCalls: scored.length, correct, avgReturn, open };
  }).sort((left, right) => left.ticker.localeCompare(right.ticker));

  return (
    <section className="table-panel aggregate-panel" aria-labelledby="calls-table-title">
      <div className="table-heading">
        <div><h2 id="calls-table-title">Calls by ticker</h2><p>Each row aggregates that ticker&apos;s own non-overlapping rating episodes at the current horizon</p></div>
        <span className="data-badge">{rows.length} tickers</span>
      </div>
      <div className="table-scroll">
        <table className="aggregate-table">
          <thead><tr><th>Ticker</th><th className="number">Total calls</th><th className="number">Scored</th><th className="number">Correct</th><th className="number">Hit rate</th><th className="number">Avg return</th><th className="number">Still open</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.ticker}>
                <td><span className="ticker">{row.ticker}</span><span className="company">{row.company}</span></td>
                <td className="number">{row.totalCalls}</td>
                <td className="number">{row.scoredCalls}</td>
                <td className="number positive">{row.correct}</td>
                <td className={`number ${row.scoredCalls ? (row.correct / row.scoredCalls >= 0.5 ? 'positive' : 'negative') : 'muted'}`}>{row.scoredCalls ? `${((row.correct / row.scoredCalls) * 100).toFixed(0)}%` : 'n/a'}</td>
                <td className={`number ${row.avgReturn === null ? 'muted' : row.avgReturn >= 0 ? 'positive' : 'negative'}`}>{row.avgReturn === null ? 'n/a' : signedPercent(row.avgReturn)}</td>
                <td className="number muted">{row.open}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer className="table-footer">
        <span>&quot;Scored&quot; excludes Hold calls (no directional prediction) and calls still open at the end of captured history</span>
        <span>Calls are non-overlapping — each uses a distinct stretch of time, unlike the exploratory scatter below</span>
      </footer>
    </section>
  );
}

const horizonLabel = (days: number) => {
  if (days === 365) return '365 days (1 year) later';
  if (days % 30 === 0 && days >= 60) return `${days} days (${days / 30} months) later`;
  return `${days} days later`;
};

function TickerAccuracyView({ rows, horizonDays, horizonOptions, selectedTicker, onSelectTicker, onHorizonChange, ratingCallSummary }: {
  rows: TickerAccuracy[];
  horizonDays: number;
  horizonOptions: number[];
  selectedTicker: string | null;
  onSelectTicker: (ticker: string) => void;
  onHorizonChange: (days: number) => void;
  ratingCallSummary: RatingCallSummary | null;
}) {
  const sorted = [...rows].sort((left, right) => left.ticker.localeCompare(right.ticker));
  const active = sorted.find((row) => row.ticker === selectedTicker) ?? sorted[0] ?? null;

  return (
    <>
      <section className="toolbar" aria-label="Rating accuracy controls">
        <div className="field">
          <label htmlFor="accuracy-horizon">Forward window</label>
          <select id="accuracy-horizon" value={horizonDays} onChange={(event) => onHorizonChange(Number(event.target.value))}>
            {horizonOptions.map((days) => <option value={days} key={days}>{horizonLabel(days)}</option>)}
          </select>
        </div>
        <div className="toolbar-count">Used by both the conclusion below and the exploratory chart further down</div>
      </section>

      <RatingCallConclusion summary={ratingCallSummary} />
      <RatingCallTable summary={ratingCallSummary} />

      <div className="section-divider">
        <span className="eyebrow">Exploratory</span>
        <p>Per-day scatter below — a rough visual pattern-finder, not an independent-observation test. See the conclusion above for that.</p>
      </div>

      <section className="toolbar" aria-label="Exploratory ticker picker">
        <div className="field">
          <label htmlFor="accuracy-ticker">Ticker</label>
          <div className="ticker-picker">
            <select id="accuracy-ticker" value={active?.ticker ?? ''} onChange={(event) => onSelectTicker(event.target.value)}>
              {sorted.map((row) => {
                const summary = tickerRatingSummary(row);
                return (
                  <option value={row.ticker} key={row.ticker}>
                    [{summary.label}] {row.ticker} · {row.points.length} pts{row.correlation !== null ? ` · r ${row.correlation.toFixed(2)}` : ''}
                  </option>
                );
              })}
            </select>
            {active && (() => {
              const summary = tickerRatingSummary(active);
              const dotColor = summary.ratings.length === 1 ? tierDotColor(summary.ratings[0]) : '#8ab0ff';
              return (
                <span className="ticker-tier-badge" title={`Ratings seen for ${active.ticker}: ${summary.ratings.join(', ')}`}>
                  <span className="score-dot" style={{ background: dotColor, margin: 0 }} />
                  <span className={summary.label === 'Mixed' ? 'rating rating-mixed' : ratingClass(summary.ratings[0])}>{summary.label}</span>
                </span>
              );
            })()}
          </div>
        </div>
        <div className="toolbar-count">{sorted.length} {sorted.length === 1 ? 'ticker' : 'tickers'} with matched observations</div>
      </section>

      {active ? <TickerAccuracyChart accuracy={active} horizonDays={horizonDays} /> : (
        <section className="table-panel aggregate-panel"><div className="table-heading"><div><h2>No data yet</h2><p>No ticker has a matched forward observation at this horizon</p></div></div></section>
      )}

      <section className="table-panel aggregate-panel" aria-labelledby="accuracy-leaderboard-title">
        <div className="table-heading">
          <div><h2 id="accuracy-leaderboard-title">Per-ticker rating accuracy (exploratory)</h2><p>Correlation between a stock&apos;s own rating and its own price {horizonDays} days later — each row uses only that ticker&apos;s history, no benchmark needed</p></div>
          <span className="data-badge">{sorted.length} tickers</span>
        </div>
        <div className="table-scroll">
          <table className="aggregate-table">
            <thead><tr><th>Ticker</th><th className="number">Observations</th><th className="number">Correlation (r)</th><th className="number">Slope (%/score point)</th></tr></thead>
            <tbody>
              {sorted.map((row) => (
                <tr key={row.ticker} className={row.ticker === active?.ticker ? 'ticker-row matrix-open' : 'ticker-row'} onClick={() => onSelectTicker(row.ticker)} style={{ cursor: 'pointer' }}>
                  <td><span className="ticker">{row.ticker}</span><span className="company">{row.company}</span></td>
                  <td className="number">{row.points.length}</td>
                  <td className={`number ${row.correlation === null ? 'muted' : row.correlation >= 0 ? 'positive' : 'negative'}`}>{row.correlation === null ? 'n/a' : row.correlation.toFixed(2)}</td>
                  <td className="number muted">{row.slope === null ? 'n/a' : `${row.slope >= 0 ? '+' : ''}${row.slope.toFixed(2)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <footer className="table-footer">
          <span>Positive r = a higher rating for that stock tended to precede a better {horizonDays}-day return for that same stock</span>
          <span>Observation counts here are inflated by overlap — see the caveat note below</span>
        </footer>
      </section>

      <ExploratoryCorrelationNote rows={sorted} horizonDays={horizonDays} />
    </>
  );
}

function App() {
  const [initialUiState] = useState(readPersistedUiState);
  const [activeView, setActiveView] = useState<ActiveView>(initialUiState.activeView);
  const [historyWindow, setHistoryWindow] = useState<HistoryWindow>(initialUiState.historyWindow);
  const [policy, setPolicy] = useState<SignalPolicy>(initialUiState.policy);
  const [sortKey, setSortKey] = useState<SortKey>(initialUiState.sortKey);
  const [exportLabel, setExportLabel] = useState('Export table');
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [expandedTickers, setExpandedTickers] = useState<Set<string>>(() => new Set());
  const [historyOptions, setHistoryOptions] = useState<HistoryOption[]>(fallbackHistoryOptions);
  const [fingerprint, setFingerprint] = useState('');
  const [tickerRows, setTickerRows] = useState<TickerResult[]>([]);
  const [aggregateRows, setAggregateRows] = useState<AggregateResult[]>([]);
  const [strongBuyRows, setStrongBuyRows] = useState<StrongBuySummary[]>([]);
  const [cohortRows, setCohortRows] = useState<CohortResult[]>([]);
  const [cohortTiers, setCohortTiers] = useState<Array<CohortResult['tier']>>([]);
  const [tickerCohortRows, setTickerCohortRows] = useState<TickerCohortResult[]>([]);
  const [tierWinRates, setTierWinRates] = useState<TierWinRate[]>([]);
  const [scoreCorrelation, setScoreCorrelation] = useState<ScoreCorrelation>({ points: [], correlation: null, slope: null, intercept: null });
  const [tierHistoryOptions, setTierHistoryOptions] = useState<HistoryOption[]>(fallbackTierHistoryOptions);
  const [accuracyRows, setAccuracyRows] = useState<TickerAccuracy[]>([]);
  const [accuracyHorizon, setAccuracyHorizon] = useState(initialUiState.accuracyHorizon);
  const [accuracyHorizonOptions, setAccuracyHorizonOptions] = useState<number[]>([30, 90, 180, 365]);
  const [selectedAccuracyTicker, setSelectedAccuracyTicker] = useState<string | null>(null);
  const [ratingCallSummary, setRatingCallSummary] = useState<RatingCallSummary | null>(null);
  const [matrixResults, setMatrixResults] = useState<Map<string, Map<string, TickerResult>>>(() => new Map());
  const [selectedResult, setSelectedResult] = useState<TickerResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const windowLabel = historyOptions.find((option) => option.value === historyWindow)?.label ?? historyWindow;
  const rows = useMemo(() => [...tickerRows].sort((left, right) => {
    if (sortKey === 'ticker') return left.ticker.localeCompare(right.ticker);
    if (sortKey === 'signals') return right.signals - left.signals;
    if (sortKey === 'averageReturn') return right.averageReturn - left.averageReturn;
    return right.hitRate - left.hitRate;
  }), [tickerRows, sortKey]);
  const hasAnyBenchmark = rows.some((row) => row.detail.benchmark.available);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setSelectedTicker(null); setSelectedResult(null); }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);

  useEffect(() => {
    try {
      const state: PersistedUiState = { activeView, historyWindow, policy, sortKey, accuracyHorizon };
      window.localStorage.setItem(UI_STATE_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage may be unavailable in private or restricted browser contexts.
    }
  }, [activeView, historyWindow, policy, sortKey, accuracyHorizon]);

  useEffect(() => {
    let cancelled = false;
    const refreshMeta = async () => {
      try {
        const meta = await fetchAnalysisMeta();
        if (cancelled) return;
        const nextOptions = buildHistoryOptions(meta.windows);
        setHistoryOptions(nextOptions);
        setTierHistoryOptions(nextOptions.filter((option) => option.value === '7d' || option.value === 'all' || Number.parseInt(option.value, 10) <= 24));
        if (!meta.windows.includes(historyWindow)) setHistoryWindow(DEFAULT_HISTORY_WINDOW);
        if (meta.accuracyHorizons?.length) {
          setAccuracyHorizonOptions(meta.accuracyHorizons);
          setAccuracyHorizon((current) => (meta.accuracyHorizons.includes(current) ? current : meta.accuracyHorizons[Math.floor(meta.accuracyHorizons.length / 2)]));
        }
        setFingerprint((current) => {
          if (current && current !== meta.fingerprint) {
            setMatrixResults(new Map());
            setSelectedTicker(null);
            setSelectedResult(null);
          }
          return meta.fingerprint;
        });
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      }
    };
    void refreshMeta();
    const timer = window.setInterval(refreshMeta, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [historyWindow]);

  useEffect(() => {
    if (!fingerprint) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    const loadActiveView = async () => {
      try {
        if (activeView === 'tickers') {
          const response = await fetchAnalysis<TickerResult[]>('tickerRows', { window: historyWindow, policy });
          if (!cancelled) setTickerRows(response.data);
        } else if (activeView === 'overall') {
          const response = await fetchAnalysis<AggregateResult[]>('aggregate');
          if (!cancelled) setAggregateRows(response.data);
        } else if (activeView === 'strong-buy') {
          const response = await fetchAnalysis<StrongBuySummary[]>('strongBuy');
          if (!cancelled) setStrongBuyRows(response.data);
        } else if (activeView === 'accuracy') {
          const response = await fetchAnalysis<{ tickerAccuracy: TickerAccuracy[]; ratingCalls: RatingCallSummary }>('accuracy', { horizon: accuracyHorizon });
          if (!cancelled) {
            setAccuracyRows(response.data.tickerAccuracy);
            setRatingCallSummary(response.data.ratingCalls);
            setSelectedAccuracyTicker((current) => (current && response.data.tickerAccuracy.some((row) => row.ticker === current) ? current : (response.data.tickerAccuracy[0]?.ticker ?? null)));
          }
        } else {
          const response = await fetchAnalysis<{
            cohortRows: CohortResult[];
            cohortTiers: Array<CohortResult['tier']>;
            tickerRows: TickerCohortResult[];
            winRates: TierWinRate[];
            correlation: ScoreCorrelation;
            windows: HistoryWindow[];
          }>('tiers');
          if (!cancelled) {
            setCohortRows(response.data.cohortRows);
            setCohortTiers(response.data.cohortTiers);
            setTickerCohortRows(response.data.tickerRows);
            setTierWinRates(response.data.winRates);
            setScoreCorrelation(response.data.correlation);
            setTierHistoryOptions(buildHistoryOptions(response.data.windows));
          }
        }
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void loadActiveView();
    return () => { cancelled = true; };
  }, [activeView, historyWindow, policy, fingerprint, accuracyHorizon]);

  const toggleMatrix = async (ticker: string) => {
    if (expandedTickers.has(ticker)) {
      setExpandedTickers((current) => { const next = new Set(current); next.delete(ticker); return next; });
      return;
    }
    setExpandedTickers((current) => new Set(current).add(ticker));
    if (!matrixResults.has(ticker)) {
      try {
        const response = await fetchAnalysis<Array<{ window: HistoryWindow; policy: SignalPolicy; result: TickerResult }>>('tickerMatrix', { ticker });
        const tickerResults = new Map(response.data.map((entry) => [matrixKey(entry.window, entry.policy), entry.result]));
        setMatrixResults((current) => new Map(current).set(ticker, tickerResults));
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error));
      }
    }
  };

  const openTickerDetails = async (ticker: string) => {
    setSelectedTicker(ticker);
    setSelectedResult(null);
    try {
      const response = await fetchAnalysis<TickerResult | null>('tickerDetail', { window: historyWindow, policy, ticker });
      setSelectedResult(response.data);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  };

  const resetFilters = () => {
    setHistoryWindow(DEFAULT_HISTORY_WINDOW);
    setPolicy(DEFAULT_POLICY);
    setSortKey(DEFAULT_SORT_KEY);
  };

  const handleExport = () => {
    const exportRows = activeView === 'tickers' ? rows
      : activeView === 'overall' ? aggregateRows
        : activeView === 'strong-buy' ? strongBuyRows
          : activeView === 'accuracy' ? accuracyRows
            : cohortRows;
    const blob = new Blob([JSON.stringify(exportRows, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = activeView === 'tickers' ? 'ticker-results.json'
      : activeView === 'overall' ? 'overall-results.json'
        : activeView === 'strong-buy' ? 'strong-buy-trust.json'
          : activeView === 'accuracy' ? 'rating-accuracy.json'
            : 'rating-tier-results.json';
    anchor.click();
    URL.revokeObjectURL(url);
    setExportLabel('Exported');
    window.setTimeout(() => setExportLabel('Export table'), 1400);
  };

  return (
    <div className="app-shell">
      <header className="page-header">
        <div>
          <div className="eyebrow">Seeking Alpha research</div>
          <h1>{activeView === 'tickers' ? 'All ticker results' : activeView === 'overall' ? 'Overall results' : activeView === 'strong-buy' ? 'Strong Buy trust' : activeView === 'accuracy' ? 'Rating accuracy' : 'Rating tiers'}</h1>
          <p>{activeView === 'tickers' ? 'One summary row per ticker · compare every strategy or open full details from the Actions column' : activeView === 'overall' ? 'Which strategies consistently beat simply holding each stock' : activeView === 'strong-buy' ? 'Were historical entries into Strong Buy profitable before the rating changed?' : activeView === 'accuracy' ? "Does a stock's own rating predict what its own price does next, per ticker" : 'Do stocks rated better today actually have stronger real track records?'}</p>
        </div>
        <button className="primary-button" type="button" onClick={handleExport}>{exportLabel}</button>
      </header>

      <nav className="section-nav" aria-label="Backtest views">
        <button className={activeView === 'tickers' ? 'nav-button active' : 'nav-button'} type="button" onClick={() => setActiveView('tickers')}>Ticker results</button>
        <button className={activeView === 'overall' ? 'nav-button active' : 'nav-button'} type="button" onClick={() => { setActiveView('overall'); setSelectedTicker(null); setSelectedResult(null); }}>Overall results</button>
        <button className={activeView === 'strong-buy' ? 'nav-button active' : 'nav-button'} type="button" onClick={() => { setActiveView('strong-buy'); setSelectedTicker(null); setSelectedResult(null); }}>Strong Buy trust</button>
        <button className={activeView === 'tiers' ? 'nav-button active' : 'nav-button'} type="button" onClick={() => { setActiveView('tiers'); setSelectedTicker(null); setSelectedResult(null); }}>Rating tiers</button>
        <button className={activeView === 'accuracy' ? 'nav-button active' : 'nav-button'} type="button" onClick={() => { setActiveView('accuracy'); setSelectedTicker(null); setSelectedResult(null); }}>Rating accuracy</button>
      </nav>

      {loadError && <div className="data-status data-error">Could not load fresh analysis: {loadError}</div>}
      {loading && <div className="data-status">Loading fresh local analysis…</div>}

      {activeView === 'tickers' ? (
        <>
      <section className="toolbar" aria-label="Table controls">
        <div className="field">
          <label htmlFor="horizon">Signal history</label>
          <select id="horizon" value={historyWindow} onChange={(event) => setHistoryWindow(event.target.value as HistoryWindow)}>
            {historyOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="policy">Signal policy</label>
          <select id="policy" value={policy} onChange={(event) => setPolicy(event.target.value as SignalPolicy)}>
            {policyOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sort">Sort rows by</label>
          <select id="sort" value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}>
            <option value="hitRate">Hit rate</option>
            <option value="averageReturn">Average return</option>
            <option value="signals">Signals</option>
            <option value="ticker">Ticker</option>
          </select>
        </div>
        <button className="reset-button" type="button" onClick={resetFilters} disabled={historyWindow === DEFAULT_HISTORY_WINDOW && policy === DEFAULT_POLICY && sortKey === DEFAULT_SORT_KEY}>Reset filters</button>
        <div className="toolbar-count">{rows.length} {rows.length === 1 ? 'ticker' : 'tickers'} · {rows.reduce((total, row) => total + row.signals, 0).toLocaleString()} eligible signals</div>
      </section>

      {!hasAnyBenchmark && (
        <div className="benchmark-hint">
          No buy-and-hold benchmark data cached yet. Run <code>npm run fetch:benchmark</code> in <code>backtest/</code> once to pull real daily prices (Yahoo Finance, cached locally — no repeated network calls).
        </div>
      )}

      <section className="table-panel" aria-labelledby="results-title">
        <div className="table-heading">
          <div><h2 id="results-title">Backtest by ticker</h2><p>{windowLabel} · {policyLabels[policy]}</p></div>
          <span className="data-badge">{rows.length} {rows.length === 1 ? 'row' : 'rows'} loaded</span>
        </div>
        <div className="table-scroll">
          <table className="results-table">
            <thead><tr><th>Ticker</th><th className="number">Signals</th><th>Latest rating</th><th className="number">Hit rate</th><th className="number">Avg return</th><th className="number">Median return</th><th className="number">Growth of $100</th><th className="number">Buy &amp; hold</th><th className="number">Rating changes</th><th>Coverage</th><th>Date range</th><th className="actions-heading">Actions</th></tr></thead>
            <tbody>
              {rows.map((row) => {
                const matrixOpen = expandedTickers.has(row.ticker);
                const tickerMatrix = matrixResults.get(row.ticker);
                const matrixEndingValues = tickerMatrix
                  ? [...tickerMatrix.values()].map((result) => Number(result.detail.endingValue.toFixed(2)))
                  : [];
                const bestEndingValue = matrixEndingValues.length ? Math.max(...matrixEndingValues) : null;
                const worstEndingValue = matrixEndingValues.length ? Math.min(...matrixEndingValues) : null;
                return (
                  <Fragment key={row.ticker}>
                    <tr className={matrixOpen ? 'ticker-row matrix-open' : 'ticker-row'}>
                      <td><span className="ticker">{row.ticker}</span><span className="company">{row.company}</span></td>
                      <td className="number">{row.signals.toLocaleString()}</td>
                      <td><span className={ratingClass(row.latestRating)}>{row.latestRating}</span></td>
                      <td className={`number ${row.hitRate >= 50 ? 'positive' : 'negative'}`}>{row.hitRate.toFixed(1)}%</td>
                      <td className={`number ${row.averageReturn >= 0 ? 'positive' : 'negative'}`}>{signedPercent(row.averageReturn)}</td>
                      <td className={`number ${row.medianReturn >= 0 ? 'positive' : 'negative'}`}>{signedPercent(row.medianReturn)}</td>
                      <td className={`number ${row.detail.totalReturn >= 0 ? 'positive' : 'negative'}`}>${row.detail.endingValue.toFixed(2)}</td>
                      <td className={`number ${row.detail.benchmark.available ? (row.detail.benchmark.totalReturn >= 0 ? 'positive' : 'negative') : 'muted'}`}>
                        {row.detail.benchmark.available ? `$${row.detail.benchmark.endingValue.toFixed(2)}` : 'Not fetched'}
                      </td>
                      <td className="number">{row.ratingChanges.toLocaleString()}</td>
                      <td><span className="coverage"><i />{row.coverage}</span></td>
                      <td className="muted">{row.dateRange}</td>
                      <td>
                        <div className="row-actions">
                          <button className={matrixOpen ? 'icon-button active' : 'icon-button'} type="button" aria-label={`${matrixOpen ? 'Collapse' : 'Expand'} ${row.ticker} strategy matrix`} aria-expanded={matrixOpen} onClick={() => toggleMatrix(row.ticker)}>
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM4 10h16M9 5v14M14 5v14" /></svg>
                            <svg className={matrixOpen ? 'chevron rotated' : 'chevron'} viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4" /></svg>
                          </button>
                          <button className="icon-button" type="button" aria-label={`Open ${row.ticker} full details`} onClick={() => void openTickerDetails(row.ticker)}>
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4zM14 4v16M7 8h4M7 12h4M7 16h4" /></svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                    {matrixOpen && (
                      <tr className="strategy-matrix-row">
                        <td colSpan={12}>
                          <div className="strategy-matrix-wrap">
                            <div className="strategy-matrix-heading"><strong>{row.ticker} · all strategy combinations</strong><span><i className="matrix-legend-best" />Best result <i className="matrix-legend-worst" />Worst result</span></div>
                            <div className="strategy-matrix-scroll">
                              <table className="strategy-matrix" style={{ minWidth: `${155 + (historyOptions.length * 130)}px` }} aria-label={`${row.ticker} signal history and policy comparison`}>
                                <thead><tr><th>Signal policy</th>{historyOptions.map((option) => <th key={option.value}>{option.shortLabel}</th>)}</tr></thead>
                                <tbody>
                                  <tr className="matrix-benchmark-row">
                                    <th>Buy &amp; hold<small>Real closing price, no rating</small></th>
                                    {historyOptions.map((historyOption) => {
                                      const referenceResult = tickerMatrix?.get(matrixKey(historyOption.value, 'long-exit-hold'));
                                      const benchmark = referenceResult?.detail.benchmark;
                                      return (
                                        <td key={historyOption.value} className="matrix-benchmark-cell">
                                          {benchmark?.available ? (
                                            <>
                                              <strong className={benchmark.totalReturn >= 0 ? 'positive' : 'negative'}>${benchmark.endingValue.toFixed(2)}</strong>
                                              <span>{signedPercent(benchmark.totalReturn)}</span>
                                            </>
                                          ) : <span className="muted">Not fetched</span>}
                                        </td>
                                      );
                                    })}
                                  </tr>
                                  {policyOptions.map((policyOption) => (
                                    <tr key={policyOption.value}>
                                      <th>{policyOption.shortLabel}<small>{policyOption.label}</small></th>
                                      {historyOptions.map((historyOption) => {
                                        const result = tickerMatrix?.get(matrixKey(historyOption.value, policyOption.value));
                                        if (!result) return <td key={historyOption.value} className="matrix-empty">No data</td>;
                                        const displayedEndingValue = Number(result.detail.endingValue.toFixed(2));
                                        const isBest = displayedEndingValue === bestEndingValue;
                                        const isWorst = displayedEndingValue === worstEndingValue;
                                        return (
                                          <td key={historyOption.value} className={`${isBest ? 'matrix-best' : ''} ${isWorst ? 'matrix-worst' : ''}`.trim() || undefined}>
                                            {(isBest || isWorst) && <div className="matrix-statuses">{isBest && <em className="matrix-status best">Best</em>}{isWorst && <em className="matrix-status worst">Worst</em>}</div>}
                                            <strong className={result.detail.totalReturn >= 0 ? 'positive' : 'negative'}>${result.detail.endingValue.toFixed(2)}</strong>
                                            <span>{signedPercent(result.detail.totalReturn)} · {result.hitRate.toFixed(1)}% hit</span>
                                            <small>{result.signals.toLocaleString()} signals</small>
                                          </td>
                                        );
                                      })}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <footer className="table-footer"><span>Use the matrix icon to compare all {historyOptions.length * policyOptions.length} combinations · use the panel icon for full details</span><span>Input folder: ./input · Buy &amp; hold benchmark: ./benchmark (Yahoo Finance, cached — run npm run fetch:benchmark to refresh)</span></footer>
      </section>
        </>
      ) : activeView === 'overall' ? (
        <OverallResultsTable rows={aggregateRows} historyOptions={historyOptions} />
      ) : activeView === 'strong-buy' ? (
        <StrongBuyTrustView key={fingerprint} rows={strongBuyRows} />
      ) : activeView === 'tiers' ? (
        <>
          <ScoreCorrelationChart correlation={scoreCorrelation} />
          <TierWinRateSummary rows={tierWinRates} />
          <RatingTierTable rows={cohortRows} tiers={cohortTiers} historyOptions={tierHistoryOptions} />
          <TickerCohortTable results={tickerCohortRows} historyOptions={tierHistoryOptions} />
        </>
      ) : (
        <TickerAccuracyView
          rows={accuracyRows}
          horizonDays={accuracyHorizon}
          horizonOptions={accuracyHorizonOptions}
          selectedTicker={selectedAccuracyTicker}
          onSelectTicker={setSelectedAccuracyTicker}
          onHorizonChange={setAccuracyHorizon}
          ratingCallSummary={ratingCallSummary}
        />
      )}

      {selectedResult && activeView === 'tickers' && (
        <aside className="detail-panel" aria-label={`${selectedResult.ticker} strategy replay details`}>
          <header className="detail-header">
            <div><div className="eyebrow">Strategy replay</div><h2>{selectedResult.ticker} · {selectedResult.company}</h2><p>{selectedResult.dateRange} · {policyLabels[policy]}</p></div>
            <button className="close-button" type="button" aria-label="Close details" onClick={() => { setSelectedTicker(null); setSelectedResult(null); }}>×</button>
          </header>

          <section className="detail-summary">
            <div><span>Starting value</span><strong>${selectedResult.detail.startingValue.toFixed(2)}</strong></div>
            <div><span>Ending value</span><strong className={selectedResult.detail.totalReturn >= 0 ? 'positive' : 'negative'}>${selectedResult.detail.endingValue.toFixed(2)}</strong></div>
            <div><span>Total return</span><strong className={selectedResult.detail.totalReturn >= 0 ? 'positive' : 'negative'}>{signedPercent(selectedResult.detail.totalReturn)}</strong></div>
            <div><span>Position</span><strong>{selectedResult.detail.positionStatus}</strong>{selectedResult.detail.openTradeReturn !== null && <small className={selectedResult.detail.openTradeReturn >= 0 ? 'positive' : 'negative'}>{signedPercent(selectedResult.detail.openTradeReturn)} unrealized</small>}</div>
            <div>
              <span>Buy &amp; hold</span>
              {selectedResult.detail.benchmark.available ? (
                <>
                  <strong className={selectedResult.detail.benchmark.totalReturn >= 0 ? 'positive' : 'negative'}>${selectedResult.detail.benchmark.endingValue.toFixed(2)}</strong>
                  <small>{signedPercent(selectedResult.detail.benchmark.totalReturn)} · real price, same window</small>
                </>
              ) : <strong className="muted">Not fetched</strong>}
            </div>
          </section>

          <section className="detail-section">
            <div className="section-title"><h3>Replay rule</h3><span>{selectedResult.detail.entries} entries · {selectedResult.detail.exits} exits</span></div>
            <div className="rule-box"><span>Enter</span><strong>{policy === 'long-short' ? 'Buy bullish ratings; short bearish ratings' : 'Buy once on Buy / Strong Buy'}</strong><span>Exit</span><strong>{policyExitRules[policy]}</strong></div>
          </section>

          <section className="detail-section">
            <div className="section-title"><h3>Rating distribution</h3><span>{selectedResult.detail.capturedDays} captured days</span></div>
            <div className="distribution-list">{selectedResult.detail.ratingDistribution.map((item) => <div className="distribution-row" key={item.rating}><span>{item.rating}</span><div><i style={{ width: `${(item.days / selectedResult.detail.capturedDays) * 100}%` }} /></div><strong>{item.days}</strong></div>)}</div>
          </section>

          <section className="detail-section">
            <div className="section-title"><h3>All decisions</h3><span>{selectedResult.detail.events.length} decisions</span></div>
            <div className="event-list">
              <div className="event-list-header"><span>Change</span><span>Decision</span><span>Price</span><span>Exit return</span></div>
              {selectedResult.detail.events.map((event, index) => <article className="event-row" key={`${event.date}-${event.decision}-${index}`}><div><time>{event.date}</time><strong>{event.change}</strong></div><span className={`event-action ${event.decision === 'Exit' || event.decision === 'Cover' ? 'exit' : event.decision === 'Buy once' || event.decision === 'Short once' ? 'buy' : 'none'}`}>{event.decision}</span><b>${event.price.toFixed(2)}</b><b className={event.tradeReturn === null ? 'muted' : event.tradeReturn >= 0 ? 'positive' : 'negative'}>{event.tradeReturn === null ? '—' : signedPercent(event.tradeReturn)}</b></article>)}
            </div>
          </section>

          <footer className="detail-footer"><span>Current price ${selectedResult.detail.currentPrice.toFixed(2)} · Quant score {selectedResult.detail.quantScore.toFixed(2)}</span><span>{selectedResult.detail.sourceFile}</span><span>Captured {selectedResult.detail.capturedAt}</span></footer>
        </aside>
      )}
    </div>
  );
}

export default App;
