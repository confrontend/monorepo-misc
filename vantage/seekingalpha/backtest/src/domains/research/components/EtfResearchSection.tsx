import type {
  EtfResearchDiagnostic,
  EtfResearchFamilyMeta,
  EtfResearchPlacebo,
  EtfResearchReport,
  EtfResearchRow,
} from '../../../api';
import { LegendPanel } from '../../../shared/components/LegendPanel';

export const pp = (value: number | null | undefined) => value === null || value === undefined
  ? '—' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}pp`;
export const returnPercent = (value: number | null | undefined) => value === null || value === undefined
  ? '—' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
export const percent = (value: number | null | undefined) => value === null || value === undefined
  ? '—' : `${(value * 100).toFixed(0)}%`;
export const pValue = (value: number | null | undefined) => value === null || value === undefined
  ? '—' : value < 0.0001 ? '<0.0001' : value.toFixed(4);
export const filterLabel = (value: EtfResearchRow['filter']) => value === 'strong_buy'
  ? 'Strong Buy only' : 'Buy or Strong Buy';
const sameCell = (row: Pick<EtfResearchRow, 'filter' | 'persistence' | 'hold'>, other: Pick<EtfResearchRow, 'filter' | 'persistence' | 'hold'>) =>
  row.filter === other.filter && row.persistence === other.persistence && row.hold === other.hold;

type FamilyPanelProps = {
  title: string;
  question: string;
  explanation: string;
  rows: EtfResearchRow[];
  meta: EtfResearchFamilyMeta;
  concentration: EtfResearchDiagnostic[];
  placebos: EtfResearchPlacebo[];
  primary: 'spy' | 'pool';
};

function FamilyPanel({ title, question, explanation, rows, meta, concentration, placebos, primary }: FamilyPanelProps) {
  const positiveClearing = rows.filter((row) => row.discoveredRule && (row.mean ?? 0) > 0);
  const negativeClearing = rows.filter((row) => row.discoveredRule && (row.mean ?? 0) < 0);
  const confirmed = positiveClearing.some((row) => {
    const placebo = placebos.find((entry) => sameCell(row, entry));
    return placebo?.empirical_p !== null && placebo?.empirical_p !== undefined
      && placebo.empirical_p < 0.05
      && (placebo.observed_mean ?? -Infinity) > (placebo.random_median ?? Infinity);
  });
  const verdict = confirmed
    ? primary === 'spy' ? 'Rating supported versus SPY' : 'Persistence adds value'
    : negativeClearing.length > 0
      ? 'Evidence against the rule'
      : primary === 'spy' ? 'No reliable rating edge' : 'No reliable persistence edge';
  const top = meta.top_candidate;
  const topPlacebo = top ? placebos.find((entry) => sameCell(top, entry)) ?? null : null;
  const topConcentration = top ? concentration.filter((entry) => sameCell(top, entry)) : [];
  const examples = primary === 'spy' ? (top?.examples ?? []) : [];

  return (
    <details className="table-panel etf-research-family" open>
      <summary className="table-heading">
        <div><h2>{title}</h2><p>{question}</p></div>
        <span className={`verdict ${confirmed ? 'verdict-good' : negativeClearing.length ? 'verdict-poor' : 'verdict-mixed'}`}>{verdict}</span>
      </summary>
      <div className="etf-research-headline">
        <div><span>Cells clearing the bar</span><strong>{meta.summary.tests_clearing_bar} of {meta.summary.tests_total}</strong></div>
        <div><span>Positive evidence</span><strong className={positiveClearing.length ? 'positive' : 'muted'}>{positiveClearing.length}</strong></div>
        <div><span>Testable cells</span><strong>{meta.summary.tests_testable}</strong></div>
        <p><strong>In simple words:</strong> {explanation}</p>
      </div>

      {top && <section className="etf-research-top">
        <div>
          <span className="eyebrow">Strongest cell</span>
          <h3>{filterLabel(top.filter)}{top.persistence ? ` for ${top.persistence}` : ''} → hold {top.hold}</h3>
          <p>{top.n} complete observations across {top.tickers} ETFs. Average ETF return {returnPercent(top.meanReturn)}, SPY {returnPercent(top.meanSpyReturn)}.</p>
        </div>
        <div className="conclusion-stats">
          <div><span>{primary === 'spy' ? 'Average edge vs SPY' : 'Average edge vs bullish ETFs'}</span><strong className={(top.mean ?? 0) >= 0 ? 'positive' : 'negative'}>{pp(top.mean)}</strong></div>
          <div><span>Clustered 95% range</span><strong>{pp(top.ciLow)} to {pp(top.ciHigh)}</strong></div>
          <div><span>Holm p</span><strong>{pValue(top.holmP)}</strong></div>
          <div><span>Random ETF placebo</span><strong className={(topPlacebo?.empirical_p ?? 1) < 0.05 ? 'positive' : 'negative'}>{pValue(topPlacebo?.empirical_p)}</strong></div>
          <div><span>Lost money outright</span><strong className={(top.absoluteLossRate ?? 0) > 0.25 ? 'negative' : 'muted'}>{percent(top.absoluteLossRate)} of trades</strong></div>
        </div>
        {topConcentration.length > 0 && <p className="muted">Concentration check: the best single observation supplied {topConcentration[0].percentOfTotal?.toFixed(1) ?? '—'}% of total measured edge; the mean after removing it was {pp(topConcentration[0].meanExcluding)}.</p>}
      </section>}

      {examples.length > 0 && <section className="etf-trade-examples" aria-labelledby={`${primary}-etf-examples-title`}>
        <div className="table-heading">
          <div>
            <h3 id={`${primary}-etf-examples-title`}>What following this rule looked like</h3>
            <p>Ten chronological examples from the validation period—not the ten best trades.</p>
          </div>
          <span className="data-badge">{examples.length} examples</span>
        </div>
        <div className="aggregate-rule">
          <span><strong>When to buy:</strong> when the ETF newly enters {filterLabel(top?.filter ?? 'bullish_plus')}, buy on the next available trading day.</span>
          <span><strong>When to sell:</strong> sell at the trading date closest to {top?.hold ?? 'the rule'} later, within the study's seven-day timing limit.</span>
        </div>
        <div className="table-scroll">
          <table className="aggregate-table etf-examples-table">
            <thead><tr>
              <th title="The ETF that received the bullish rating signal.">ETF</th>
              <th title="Date the ETF first entered the selected bullish rating family.">Signal</th>
              <th title="The next usable trading day, when the simulated purchase happened.">Buy</th>
              <th title="The simulated purchase price.">Buy price</th>
              <th title="The simulated sale date at the requested holding horizon.">Sell</th>
              <th title="The simulated sale price.">Sell price</th>
              <th className="number" title="Calendar days the simulated position was held.">Held</th>
              <th className="number" title="The ETF's actual return during this example.">ETF result</th>
              <th className="number" title="SPY's return over the exact same dates.">SPY result</th>
              <th className="number" title="What $100 became after following this example.">$100 became</th>
            </tr></thead>
            <tbody>{examples.map((example) => <tr key={`${example.ticker}|${example.signal_date}`}>
              <td><strong>{example.ticker}</strong></td>
              <td>{example.signal_date}</td>
              <td>{example.buy_date}</td>
              <td>${example.buy_price.toFixed(2)}</td>
              <td>{example.sell_date}</td>
              <td>${example.sell_price.toFixed(2)}</td>
              <td className="number">{example.days_held}d</td>
              <td className={`number ${example.etf_return >= 0 ? 'positive' : 'negative'}`}>{returnPercent(example.etf_return)}</td>
              <td className={`number muted`}>{returnPercent(example.spy_return)}</td>
              <td className={`number ${example.dollar_end >= 100 ? 'positive' : 'negative'}`}>${example.dollar_end.toFixed(2)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <p className="muted etf-examples-note">These examples use adjusted prices and fixed historical exits. They show what happened after a completed signal; they do not predict the next ETF or include fees, spread, taxes, or slippage.</p>
      </section>}

      <div className="aggregate-rule">
        <span><strong>Evidence bar:</strong> |t| ≥ 3 and Holm p &lt; 0.05, with at least 15 ETF clusters</span>
        <span><strong>Placebo:</strong> random ETFs on the same dates must not explain the strongest result</span>
      </div>
      <div className="table-scroll">
        <table className="aggregate-table etf-research-table">
          <thead><tr>
            <th title="Which bullish ratings count for this rule.">Rating</th>
            {primary === 'pool' && <th title="How long the rating had to remain continuously bullish before entry.">Persistence</th>}
            <th title="Calendar days between entry and the target exit.">Hold</th>
            <th className="number" title="Complete trades included in this cell.">Trades</th>
            <th className="number" title="Different ETFs represented; at least 15 are required.">ETFs</th>
            <th className="number" title="Average raw return of the selected ETFs.">ETF return</th>
            <th className="number" title="Average SPY return over the same entry and exit dates.">SPY</th>
            <th className="number" title="Average selected ETF return minus SPY return.">Vs SPY</th>
            {primary === 'pool' && <th className="number" title="Average selected ETF return minus other ETFs carrying the same bullish rating.">Vs bullish pool</th>}
            <th className="number" title="Fraction of trades where the ETF's own price fell, regardless of how SPY or the pool did.">Lost money</th>
            <th className="number" title="Cluster-robust signal-to-noise statistic.">t</th>
            <th className="number" title="P-value after correcting every cell in this ETF family.">Holm p</th>
            <th title="Whether this cell has enough ETFs and clears the corrected evidence bar.">Status</th>
          </tr></thead>
          <tbody>{rows.map((row) => <tr key={`${row.filter}|${row.persistence}|${row.hold}`} className={row.testable ? undefined : 'research-thin-row'}>
            <td><strong>{filterLabel(row.filter)}</strong></td>
            {primary === 'pool' && <td>{row.persistence ?? '—'}</td>}
            <td>{row.hold}</td>
            <td className="number">{row.n}</td>
            <td className="number">{row.tickers}</td>
            <td className="number">{returnPercent(row.meanReturn)}</td>
            <td className="number muted">{returnPercent(row.meanSpyReturn)}</td>
            <td className={`number ${(row.meanExcessSpy ?? 0) >= 0 ? 'positive' : 'negative'}`}>{pp(row.meanExcessSpy)}</td>
            {primary === 'pool' && <td className={`number ${(row.meanExcessPool ?? 0) >= 0 ? 'positive' : 'negative'}`}>{pp(row.meanExcessPool)}</td>}
            <td className="number muted">{percent(row.absoluteLossRate)}</td>
            <td className="number">{row.t?.toFixed(2) ?? '—'}</td>
            <td className="number">{pValue(row.holmP)}</td>
            <td>{!row.testable
              ? <span className="verdict verdict-not-enough-data">Too thin</span>
              : row.discoveredRule
                ? <span className={`verdict ${(row.mean ?? 0) > 0 ? 'verdict-good' : 'verdict-poor'}`}>{(row.mean ?? 0) > 0 ? 'Positive evidence' : 'Evidence against'}</span>
                : <span className="verdict verdict-mixed">No reliable edge</span>}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <footer className="table-footer"><span>{meta.benchmark}</span><span>Gross of costs · survivor-universe caveat applies</span></footer>
    </details>
  );
}

export function EtfResearchSection({ etf }: { etf: EtfResearchReport }) {
  if (!etf.available || !etf.meta) return (
    <section className="empty-trends"><div className="eyebrow">ETF research</div><h2>ETF statistical report not generated</h2><p>Run the Research analysis to generate the two frozen ETF families.</p></section>
  );
  return <section className="etf-research">
    <div className="section-divider">
      <div className="eyebrow">ETF research · primary decision</div>
      <h2>Can you trust bullish ETF ratings?</h2>
      <p>Two independent answers: whether the rating beats SPY, and whether waiting makes an already-bullish ETF selection better.</p>
    </div>
    <LegendPanel title="How to read ETF research" items={[
      { term: 'Rating trust', meaning: 'The main question: did bullish-rated ETFs beat SPY over the same dates?' },
      { term: 'Persistence improvement', meaning: 'A secondary question: did waiting improve on other ETFs that were already bullish?' },
      { term: 'Positive evidence', meaning: 'The cell beat its benchmark strongly enough after correcting for every rule tested.' },
      { term: 'No reliable edge', meaning: 'The measured difference could reasonably be noise. It does not prove the rating is bad.' },
      { term: 'Placebo', meaning: 'Checks whether random ETFs bought on the same dates performed just as well.' },
    ]} />
    <FamilyPanel
      title="1. Bullish ETF ratings versus SPY"
      question={etf.meta.families.rating_trust.question}
      explanation="This is the main trust test. A positive confirmed result means bullish-rated ETFs historically beat simply owning SPY over matched periods."
      rows={etf.ratingRows}
      meta={etf.meta.families.rating_trust}
      concentration={etf.ratingConcentration}
      placebos={etf.ratingPlacebos}
      primary="spy"
    />
    <FamilyPanel
      title="2. Does waiting improve the bullish selection?"
      question={etf.meta.families.persistence.question}
      explanation="This cannot invalidate Test 1. It only asks whether waiting for a bullish rating to persist produced an extra advantage over buying bullish ETFs sooner."
      rows={etf.persistenceRows}
      meta={etf.meta.families.persistence}
      concentration={etf.persistenceConcentration}
      placebos={etf.persistencePlacebos}
      primary="pool"
    />
    <details className="methodology-note">
      <summary>ETF methodology, data period, and limits</summary>
      <ul>
        <li><strong>Frozen specification:</strong> {etf.meta.spec}.</li>
        <li><strong>Data:</strong> {etf.meta.dataset.etfs} ETFs, {etf.meta.dataset.price_rows.toLocaleString()} price rows, validation {etf.meta.dataset.validation_start} to {etf.meta.dataset.validation_end}.</li>
        <li><strong>Statistics:</strong> {etf.meta.thresholds.bootstrap_reps.toLocaleString()} wild cluster bootstrap repetitions, clustered by ETF; Holm and BH are separate within each family.</li>
        <li><strong>Limits:</strong> imported survivor universe, gross of costs, and prior exploratory ETF evidence was known before this frozen implementation.</li>
      </ul>
    </details>
  </section>;
}
