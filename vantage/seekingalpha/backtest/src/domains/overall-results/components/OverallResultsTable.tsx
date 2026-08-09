import type { AggregateResult } from '../../../data';
import { matrixKey, policyOptions, signedPercent, type HistoryOption } from '../../../shared/analysisUi';
import { LegendPanel } from '../../../shared/components/LegendPanel';

export function OverallResultsTable({ rows, historyOptions }: { rows: AggregateResult[]; historyOptions: HistoryOption[] }) {
  return (
    <>
      <LegendPanel
        title="How to read the overall comparison"
        items={[
          { term: 'Extra return', meaning: 'Strategy return minus buy-and-hold return. Positive means the strategy did better.' },
          { term: 'Beat holding', meaning: 'How many stocks the strategy beat. Example: 8/10 means it won on 8 stocks.' },
          { term: 'Confidence', meaning: 'How much evidence we have, mainly based on the number of stocks tested.' },
          { term: 'Verdict', meaning: 'A short summary; it is not a guarantee about future performance.' },
        ]}
      />
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
          <thead><tr><th title="How far back the rating signals were tested.">Signal history</th><th title="The rule used to enter, hold, or exit a position.">Signal policy</th><th className="number" title="How many stocks had enough data for this comparison.">Tickers tested</th><th className="number" title="How many stocks the strategy beat versus simply holding.">Beat holding</th><th className="number" title="Average strategy return minus buy-and-hold return.">Avg extra return</th><th className="number" title="The middle extra return across all tested stocks.">Median extra return</th><th className="number" title="Average return from following the selected strategy.">Avg strategy</th><th className="number" title="Average return from holding each stock without using ratings.">Avg buy &amp; hold</th><th title="How much evidence supports the result, based mainly on sample size.">Confidence</th><th title="A simple summary of whether the strategy looks useful in this comparison.">Verdict</th></tr></thead>
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
    </>
  );
}








