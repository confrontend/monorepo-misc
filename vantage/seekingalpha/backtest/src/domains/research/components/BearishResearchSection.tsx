import type {
  BearishConcentrationRow,
  BearishResearchReport,
  BearishResearchRow,
  ResearchPlacebo,
} from '../../../api';
import { LegendPanel } from '../../../shared/components/LegendPanel';

const percent = (value: number | null | undefined, digits = 2) => (
  value === null || value === undefined
    ? '—'
    : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(digits)}%`
);
const rate = (value: number | null | undefined) => (
  value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`
);
const number = (value: number | null | undefined, digits = 2) => (
  value === null || value === undefined ? '—' : value.toFixed(digits)
);
const pValue = (value: number | null | undefined) => {
  if (value === null || value === undefined) return '—';
  return value < 0.0001 ? '<0.0001' : value.toFixed(4);
};
const signalLabel = (signal: BearishResearchRow['signal']) => (
  signal === 'strong_sell_only' ? 'Strong Sell only' : 'Sell or Strong Sell'
);
const outcomeLabel = (outcome: BearishResearchRow['outcome']) => (
  outcome === 'raw_short' ? 'Outright short' : 'Short stock + hold SPY'
);
const statusFor = (row: BearishResearchRow) => {
  if (!row.testable) return { label: 'Too thin', className: 'verdict-not-enough-data' };
  if (!row.discoveredRule) return { label: 'No reliable edge', className: 'verdict-poor' };
  if ((row.mean ?? 0) > 0) return { label: 'Supports short', className: 'verdict-good' };
  return { label: 'Evidence against short', className: 'verdict-mixed' };
};

function DiagnosticSummary({
  topCandidate,
  concentration,
  placebo,
}: {
  topCandidate: BearishResearchRow | null;
  concentration: BearishConcentrationRow[];
  placebo: ResearchPlacebo | null;
}) {
  if (!topCandidate) return null;
  const firstConcentration = concentration[0];
  return (
    <div className="aggregate-rule bearish-diagnostics">
      <span>
        <strong>Strongest statistical result:</strong>{' '}
        {signalLabel(topCandidate.signal)}, {topCandidate.lookback ? `${topCandidate.lookback} bearish first, ` : ''}
        {topCandidate.hold} hold, {outcomeLabel(topCandidate.outcome).toLowerCase()} = {percent(topCandidate.mean)}
        {' '}({topCandidate.n} complete trades / {topCandidate.tickers} tickers; Holm p {pValue(topCandidate.holmP)}).
      </span>
      {placebo && (
        <span>
          <strong>Random-name control:</strong> observed {percent(placebo.observed_mean)}, random median {percent(placebo.random_median)},
          {' '}two-sided placebo p {pValue(placebo.empirical_p)}.
        </span>
      )}
      {firstConcentration && (
        <span>
          <strong>Concentration:</strong> the {firstConcentration.topK === 1 ? 'single most influential trade' : `top ${firstConcentration.topK} trades`}
          {' '}accounted for {firstConcentration.percentOfTotal === null ? 'an unknown share' : `${firstConcentration.percentOfTotal.toFixed(1)}%`}
          {' '}of the result; mean after removing it {percent(firstConcentration.meanExcluding)}.
        </span>
      )}
    </div>
  );
}

function BearishFamilyTable({
  title,
  description,
  rows,
  correctionScope,
  topCandidate,
  concentration,
  placebo,
  open = false,
}: {
  title: string;
  description: string;
  rows: BearishResearchRow[];
  correctionScope: number;
  topCandidate: BearishResearchRow | null;
  concentration: BearishConcentrationRow[];
  placebo: ResearchPlacebo | null;
  open?: boolean;
}) {
  const completeRows = [...rows].sort((left, right) => {
    if (left.lookback !== right.lookback) return (left.lookback ?? '').localeCompare(right.lookback ?? '');
    if (left.hold !== right.hold) return Number.parseInt(left.hold, 10) - Number.parseInt(right.hold, 10);
    if (left.signal !== right.signal) return left.signal.localeCompare(right.signal);
    return left.outcome.localeCompare(right.outcome);
  });
  const clearing = rows.filter((row) => row.discoveredRule);
  const profitable = clearing.filter((row) => (row.mean ?? 0) > 0);

  return (
    <details className="table-panel bearish-family" open={open}>
      <summary className="table-heading">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <span className="data-badge">
          {profitable.length} profitable rule{profitable.length === 1 ? '' : 's'} clear the bar
        </span>
      </summary>
      <div className="aggregate-rule">
        <span><strong>Correction:</strong> all {correctionScope} tests below are one Holm family.</span>
        <span><strong>Complete only:</strong> a {rows[0]?.hold ?? 'fixed'} horizon is counted only when the full exit date exists.</span>
        <span><strong>Sign:</strong> positive mean helps a short; negative mean means the short lost before costs.</span>
      </div>
      <div className="table-scroll">
        <table className="aggregate-table bearish-table">
          <thead>
            <tr>
              <th title="Transition has no lookback. Persistence requires the stock to stay bearish for this long before the signal.">Lookback</th>
              <th title="The bearish rating rule that produced the signal.">Signal</th>
              <th title="The complete calendar-day holding period after next-session entry.">Hold</th>
              <th title="Outright short asks if the stock fell. Hedged asks if it lagged SPY.">Outcome</th>
              <th className="number" title="Qualifying rating events before incomplete and overlapping cases were removed.">Signals</th>
              <th className="number" title="Trades with a valid next-session entry and the full requested exit horizon.">Complete</th>
              <th className="number" title="Different stocks represented by the complete trades. At least 15 are required for testing.">Tickers</th>
              <th className="number" title="Signals excluded because the full horizon or required stock/SPY prices were unavailable.">Incomplete</th>
              <th className="number" title="Signals skipped because another trade in the same ticker was already open in this test cell.">Overlap</th>
              <th className="number" title="Average gross short or hedged return. Positive helps the tested short rule.">Mean</th>
              <th className="number" title="Share of complete trades where the tested short outcome was positive.">Profitable</th>
              <th className="number" title="Share of stocks whose adjusted price actually fell. This is the direct test for an outright short.">Stock fell</th>
              <th className="number" title="Share of stocks that returned less than SPY, even if both rose.">Lagged SPY</th>
              <th className="number" title="Ticker-cluster signal-to-noise statistic. Larger absolute values are stronger evidence.">t</th>
              <th className="number" title="P-value after correcting every test in this family with Holm's method.">Holm p</th>
              <th title="Whether the result clears the frozen evidence bar and which direction it supports.">Status</th>
            </tr>
          </thead>
          <tbody>
            {completeRows.map((row) => {
              const status = statusFor(row);
              return (
                <tr key={`${row.family}|${row.lookback}|${row.signal}|${row.hold}|${row.outcome}`}
                  className={row.testable ? undefined : 'research-thin-row'}>
                  <td>{row.lookback ?? 'None'}</td>
                  <td>{signalLabel(row.signal)}</td>
                  <td>{row.hold}</td>
                  <td>{outcomeLabel(row.outcome)}</td>
                  <td className="number">{row.candidateSignals}</td>
                  <td className="number"><strong>{row.n}</strong></td>
                  <td className="number">{row.tickers}</td>
                  <td className={`number ${row.incompleteTrades > 0 ? 'negative' : ''}`}>{row.incompleteTrades}</td>
                  <td className="number">{row.overlapSkipped}</td>
                  <td className={`number ${(row.mean ?? 0) > 0 ? 'positive' : 'negative'}`}>{percent(row.mean)}</td>
                  <td className="number">{rate(row.positiveRate)}</td>
                  <td className="number">{rate(row.stockFellRate)}</td>
                  <td className="number">{rate(row.underperformedSpyRate)}</td>
                  <td className="number">{number(row.t)}</td>
                  <td className="number">{pValue(row.holmP)}</td>
                  <td><span className={`verdict ${status.className}`}>{status.label}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <DiagnosticSummary topCandidate={topCandidate} concentration={concentration} placebo={placebo} />
    </details>
  );
}

export function BearishResearchSection({ bearish }: { bearish: BearishResearchReport }) {
  if (!bearish.available || !bearish.meta) {
    return (
      <section className="conclusion-box exploratory bearish-unavailable">
        <div className="eyebrow">Bearish / short research</div>
        <h3>Run the analysis to generate the new bearish report</h3>
        <p>The runner now tests both transitions into bearish ratings and ratings that stayed bearish. Existing bullish results remain separate.</p>
      </section>
    );
  }

  const { meta } = bearish;
  const realEarly = meta.universe_audit.real_early_end_count;
  const transitionTop = meta.families.transition.top_candidate;
  const persistenceTop = meta.families.persistence.top_candidate;
  const transitionRaw = bearish.transitionRows.filter((row) => (
    row.signal === 'sell_or_strong_sell' && row.outcome === 'raw_short'
  )).sort((left, right) => Number.parseInt(left.hold, 10) - Number.parseInt(right.hold, 10));
  const allRows = [...bearish.transitionRows, ...bearish.persistenceRows];
  const profitableClearing = allRows.filter((row) => row.discoveredRule && (row.mean ?? 0) > 0);
  const losingClearing = allRows.filter((row) => row.discoveredRule && (row.mean ?? 0) < 0);

  return (
    <section className="bearish-research" aria-labelledby="bearish-research-title">
      <div className="section-divider">
        <div className="eyebrow">Bearish / short research</div>
        <h2 id="bearish-research-title">Do Sell ratings support a profitable short?</h2>
        <p>Two separately corrected tests: newly turning bearish, and staying bearish for months.</p>
      </div>

      <LegendPanel
        title="How to read the bearish tests"
        items={[
          { term: 'Outright short', meaning: 'You profit only if the stock price falls. A negative result means the short lost money before costs.' },
          { term: 'Short + SPY', meaning: 'Short the stock and hold the same amount of SPY. This tests underperformance, not whether the stock itself fell.' },
          { term: 'Transition', meaning: 'The rating newly crossed into Sell/Strong Sell. Entry is the next market session.' },
          { term: 'Persistence', meaning: 'The rating stayed bearish for the full lookback before next-session entry.' },
          { term: 'Incomplete', meaning: 'The requested 30/90/180-day exit did not exist. It is dropped, never shortened.' },
          { term: 'Survivor-only', meaning: 'The export mostly contains companies still present at the end, so missing failed/delisted firms may change a short test.' },
          { term: 'Too thin', meaning: 'Fewer than 15 different stocks were available. The result is shown for transparency, but it is not statistically tested.' },
          { term: 'No reliable edge', meaning: 'There was not enough corrected evidence that this short rule works. This does not mean the rule is proven useless.' },
          { term: 'Supports short', meaning: 'The result cleared the statistical bar and the average tested short outcome was positive. It is still gross and survivor-only.' },
          { term: 'Evidence against short', meaning: 'The result cleared the statistical bar in the negative direction: the stocks rose on average, so the tested shorts lost money before costs.' },
        ]}
      />

      <section className="conclusion-box exploratory bearish-verdict" aria-labelledby="bearish-verdict-title">
        <div className="eyebrow">Headline verdict</div>
        <h3 id="bearish-verdict-title">
          {profitableClearing.length === 0
            ? 'No profitable short rule cleared the corrected evidence bar'
            : `${profitableClearing.length} profitable short rule${profitableClearing.length === 1 ? '' : 's'} cleared the corrected bar`}
        </h3>
        <p>
          {losingClearing.length > 0
            ? `${losingClearing.length} tests did clear the bar in the opposite direction: the stocks rose, so those shorts lost money before implementation costs.`
            : 'No tested rule produced statistically corrected evidence either for or against a profitable short.'}
          {' '}This statement applies only to companies present in the survivor-filtered export.
        </p>
      </section>

      <section className="table-panel bearish-headline" aria-labelledby="bearish-transition-summary">
        <div className="table-heading">
          <div>
            <h2 id="bearish-transition-summary">Plain result: transition into Sell or Strong Sell</h2>
            <p>Gross outright short return after next-session entry; every row requires the complete horizon</p>
          </div>
          <span className="data-badge">Observed survivors only</span>
        </div>
        <div className="table-scroll">
          <table className="aggregate-table">
            <thead>
              <tr>
                <th title="Requested calendar-day hold after next-session entry.">Hold</th>
                <th className="number" title="Complete trades used at this exact horizon.">Complete trades</th>
                <th className="number" title="Different ticker clusters represented by those complete trades.">Tickers</th>
                <th className="number" title="Signals that could not reach the full requested horizon.">Dropped incomplete</th>
                <th className="number" title="Average gross return to an outright short. Negative means the stock rose.">Short return</th>
                <th className="number" title="Share of complete trades where the stock's adjusted price fell.">Stocks that fell</th>
                <th className="number" title="Share of complete trades where the stock returned less than SPY.">Lagged SPY</th>
              </tr>
            </thead>
            <tbody>
              {transitionRaw.map((row) => (
                <tr key={row.hold}>
                  <td><strong>{row.hold}</strong></td>
                  <td className="number">{row.n}</td>
                  <td className="number">{row.tickers}</td>
                  <td className="number">{row.incompleteTrades}</td>
                  <td className={`number ${(row.mean ?? 0) > 0 ? 'positive' : 'negative'}`}>{percent(row.mean)}</td>
                  <td className="number">{rate(row.stockFellRate)}</td>
                  <td className="number">{rate(row.underperformedSpyRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="trust-warning">
        <strong>Universe limit:</strong> {realEarly} non-fixture ticker series end more than {meta.universe_audit.stale_days} days before
        {' '}{meta.universe_audit.global_end}. Having essentially no early-ending real ticker across {meta.universe_audit.tickers_total} names is evidence the export is survivor-filtered,
        but it is not proof that the provider removes every delisted company. These results apply only to observed survivors.
        {meta.universe_audit.early_end_tickers.length > 0 && (
          <> Early-ending series: {meta.universe_audit.early_end_tickers.map((entry) => `${entry.ticker} (${entry.last_date})`).join(', ')}.</>
        )}
      </div>
      <div className="trust-warning">
        <strong>Research-history disclosure:</strong> exploratory bearish numbers were seen before this durable specification was frozen.
        The rules are now fixed in <code>{meta.spec}</code>, but this first report must not be described as a blind pre-registration.
      </div>

      <BearishFamilyTable
        title="Family 1: new bearish transitions"
        description="A rating newly crosses into Sell/Strong Sell; no lookback is used."
        rows={bearish.transitionRows}
        correctionScope={meta.families.transition.correction_scope}
        topCandidate={transitionTop}
        concentration={bearish.transitionConcentration}
        placebo={bearish.transitionPlacebo}
        open
      />
      <BearishFamilyTable
        title="Family 2: persistent bearish ratings"
        description="The rating remained strictly bearish for 3, 6, 12, or 18 months before entry."
        rows={bearish.persistenceRows}
        correctionScope={meta.families.persistence.correction_scope}
        topCandidate={persistenceTop}
        concentration={bearish.persistenceConcentration}
        placebo={bearish.persistencePlacebo}
      />
    </section>
  );
}
