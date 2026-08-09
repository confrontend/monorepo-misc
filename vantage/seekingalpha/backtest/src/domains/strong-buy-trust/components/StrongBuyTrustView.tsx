import { Fragment, useState } from 'react';
import { fetchAnalysis } from '../../../api';
import type { StrongBuyOutlierAnalysis, StrongBuyTrade, StrongBuyTrustResult } from '../../../data';
import { signedPercent } from '../../../shared/analysisUi';
import { LegendPanel } from '../../../shared/components/LegendPanel';

export type StrongBuySummary = Omit<StrongBuyTrustResult, 'trades'>;

// Aggregate outlier/concentration diagnostics for the pooled Strong Buy trades (item 5/8 of the
// methodology review this responds to). Never hides the raw mean — shows it next to statistics
// that aren't dominated by one or two extreme winners, and flags when they disagree.
function StrongBuyOutlierPanel({ outliers }: { outliers: StrongBuyOutlierAnalysis | null }) {
  if (!outliers || outliers.completedTrades === 0) return null;
  const fmt = (value: number | null) => (value === null ? 'n/a' : signedPercent(value));
  const fmtPct = (value: number | null) => (value === null ? 'n/a' : `${value.toFixed(0)}%`);

  return (
    <section className={outliers.outlierSensitive ? 'conclusion-box exploratory' : 'conclusion-box'} aria-labelledby="outlier-title">
      <h3 id="outlier-title">Outlier &amp; concentration check</h3>
      <p>
        Pooled across {outliers.completedTrades} completed calls from {outliers.tickers} tickers: raw mean {fmt(outliers.rawMeanReturn)}, median {fmt(outliers.medianReturn)}, 10% trimmed mean {fmt(outliers.trimmedMeanReturn)}, winsorized mean {fmt(outliers.winsorizedMeanReturn)}, geometric mean {fmt(outliers.geometricMeanReturn)}. Largest winner {fmt(outliers.largestWinnerReturn)}, largest loser {fmt(outliers.largestLoserReturn)}. The top 10% of calls account for {fmtPct(outliers.top10PercentContributionPercent)} of total profit (top 5%: {fmtPct(outliers.top5PercentContributionPercent)}, top 1%: {fmtPct(outliers.top1PercentContributionPercent)}). Leaving one ticker out at a time moves the mean between {fmt(outliers.leaveOneTickerOutMinMeanReturn)} and {fmt(outliers.leaveOneTickerOutMaxMeanReturn)}.
      </p>
      {outliers.outlierSensitive ? (
        <p><strong className="negative">Outlier-sensitive:</strong> {outliers.outlierSensitiveReasons.join(' ')} Treat the raw mean above as unrepresentative of a typical call.</p>
      ) : (
        <p><strong className="positive">Not outlier-sensitive</strong> by the checks above (sign stable after trimming, no single ticker flips the conclusion, top 10% of calls don&apos;t dominate total profit).</p>
      )}
    </section>
  );
}

export function StrongBuyTrustView({ rows, outliers }: { rows: StrongBuySummary[]; outliers: StrongBuyOutlierAnalysis | null }) {
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
      <LegendPanel
        title="How to read Strong Buy results"
        items={[
          { term: 'Strong Buy', meaning: 'The highest rating group in this dataset.' },
          { term: 'Completed', meaning: 'Calls with both a start date and an end date.' },
          { term: 'Open call', meaning: 'A call that has started but has not ended yet.' },
          { term: 'Win rate', meaning: 'The percentage of completed calls that made money.' },
        ]}
      />
      <div className="trust-warning"><strong>Scope:</strong> This tests historical Strong Buy calls only for the currently loaded tickers. It does not include stocks that disappeared from past Strong Buy lists.</div>
      <StrongBuyOutlierPanel outliers={outliers} />
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
            <thead><tr><th title="The stock symbol, for example ATI.">Ticker</th><th className="number" title="Strong Buy calls that have both an entry and an exit.">Completed</th><th className="number" title="Completed calls with a positive return.">Wins</th><th className="number" title="Completed calls with a negative return.">Losses</th><th className="number" title="The percentage of completed calls that made money.">Win rate</th><th className="number" title="Average return from one Strong Buy call.">Avg call return</th><th className="number" title="The middle return from all Strong Buy calls.">Median call return</th><th className="number" title="What $100 would become after following this stock's completed calls.">Growth of $100</th><th title="The return so far for a call that has not ended yet.">Open call</th><th title="The period covered by the calls shown.">Date range</th><th className="actions-heading" title="Expand to see each individual Strong Buy call.">Calls</th></tr></thead>
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
                  {expanded && <tr className="trust-calls-row"><td colSpan={11}><div className="trust-calls"><div className="strategy-matrix-heading"><strong>{row.ticker} · individual Strong Buy calls</strong><span>Repeated Strong Buy days are ignored</span></div>{loadingTicker === row.ticker ? <p className="muted">Loading calls…</p> : <><table><thead><tr><th title="Date the Strong Buy call started.">Entered</th><th className="number" title="Stock price when the call started.">Entry price</th><th title="Date the call ended, if it ended.">Exited</th><th title="The rating that ended the Strong Buy call.">New rating</th><th className="number" title="Stock price when the call ended.">Exit price</th><th className="number" title="The percentage gain or loss from entry to exit.">Return</th><th title="Whether the call is complete or still open.">Status</th></tr></thead><tbody>{trades.map((trade, index) => <tr key={`${trade.entryDate}-${index}`}><td>{trade.entryDate}</td><td className="number">${trade.entryPrice.toFixed(2)}</td><td>{trade.exitDate ?? 'Still open'}</td><td>{trade.exitRating ?? 'Strong Buy'}</td><td className="number">{trade.exitPrice === null ? '—' : `$${trade.exitPrice.toFixed(2)}`}</td><td className={`number ${trade.returnPercent >= 0 ? 'positive' : 'negative'}`}>{signedPercent(trade.returnPercent)}</td><td><span className={`call-status call-${trade.status.toLowerCase()}`}>{trade.status}</span></td></tr>)}</tbody></table>{trades.length === 0 && <p className="muted">No recorded transitions into Strong Buy.</p>}</>}</div></td></tr>}
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








