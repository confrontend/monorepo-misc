import { Fragment } from 'react';
import type { CohortResult, HistoryWindow, Rating, ScoreCorrelation, TickerCohortResult, TierWinRate } from '../../../data';
import { matrixKey, ratingClass, signedPercent, type HistoryOption } from '../../../shared/analysisUi';
import { LegendPanel } from '../../../shared/components/LegendPanel';

const cohortKey = (tier: CohortResult['tier'], window: HistoryWindow) => `${tier}|${window}`;

const tierDotColor = (tier: Rating) => (tier.includes('Buy') ? '#65d7aa' : tier.includes('Sell') ? '#ff9297' : '#f0c45e');

export function ScoreCorrelationChart({ correlation }: { correlation: ScoreCorrelation }) {
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
      <LegendPanel
        title="How to read rating groups"
        items={[
          { term: 'Bullish+', meaning: 'Buy or Strong Buy.' },
          { term: 'Very bullish only', meaning: 'Strong Buy only; the strictest bullish group.' },
          { term: 'Rating tier', meaning: 'A group of stocks with the same rating strength.' },
          { term: '− S&P 500', meaning: 'The group return minus the market return over the same dates.' },
        ]}
      />
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
        <span>{points.length} stocks with price and rating data</span>
        <span>Caveat: score barely varies within a tier in the currently captured data, so this mostly reflects tier-to-tier separation, not fine-grained differences (e.g. 4.1 vs 4.9) — capture tickers spanning a wider score range within each tier for a stronger test</span>
      </footer>
    </section>
  );
}

export function TierWinRateSummary({ rows }: { rows: TierWinRate[] }) {
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
      <footer className="table-footer"><span>Exact sample sizes are shown next to each bar</span><span>Basis: each stock's full tracked history vs. the S&amp;P 500 over that stock's same dates</span></footer>
    </section>
  );
}

export function RatingTierTable({ rows, tiers, historyOptions }: { rows: CohortResult[]; tiers: Array<CohortResult['tier']>; historyOptions: HistoryOption[] }) {
  const byKey = new Map(rows.map((row) => [cohortKey(row.tier, row.window), row]));
  const comparisonTiers = tiers.filter((tier) => tier !== 'Market');
  return (
    <section className="table-panel aggregate-panel" aria-labelledby="tiers-title">
      <div className="table-heading">
        <div><h2 id="tiers-title">Rating tier vs. S&amp;P 500</h2><p>Each group&apos;s real buy-and-hold return minus the market&apos;s return for the same window</p></div>
        <span className="data-badge">{comparisonTiers.length} groups</span>
      </div>
      <div className="aggregate-rule">
        <span>Grouped by each ticker&apos;s <strong>latest</strong> rating, so treat this as &quot;do the latest Hold/Sell stocks have weaker trailing returns than the latest Buy stocks,&quot; not proof the rating predicted those returns</span>
        <span>Uses adjusted daily prices from the 3-year data when available; otherwise the existing cached prices</span>
      </div>
      <div className="table-scroll">
        <table className="aggregate-table">
          <thead><tr><th>Rating tier − S&amp;P 500</th>{historyOptions.map((option) => <th key={option.value} className="number" title="The return comparison for this history length.">{option.shortLabel}</th>)}</tr></thead>
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
      <footer className="table-footer"><span>Uses all tickers with usable rating changes and prices from input/3-year, plus original-only captures</span><span>Positive = that tier beat the S&amp;P 500 · Market prices remain locally cached</span></footer>
    </section>
  );
}

const tierSortOrder: Record<string, number> = { 'Strong Buy': 0, Buy: 1, Hold: 2, Sell: 3, 'Strong Sell': 4 };

export function TickerCohortTable({ results, historyOptions }: { results: TickerCohortResult[]; historyOptions: HistoryOption[] }) {
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
          <thead><tr><th title="The stock symbol, for example ATI.">Ticker</th><th title="The stock's rating group.">Rating</th>{historyOptions.map((option) => <th key={option.value} className="number" title="The return comparison for this history length.">{option.shortLabel}</th>)}</tr></thead>
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










