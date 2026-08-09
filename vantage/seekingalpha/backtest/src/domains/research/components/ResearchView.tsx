import { useMemo, useState } from 'react';
import type { ResearchJob, ResearchReport, ResearchRow } from '../../../api';
import { LegendPanel } from '../../../shared/components/LegendPanel';
import { BearishResearchSection } from './BearishResearchSection';
import { EtfResearchSection } from './EtfResearchSection';

type ResearchSortKey = 'p' | 't' | 'mean' | 'trades' | 'tickers';

const pp = (value: number | null | undefined, digits = 2) =>
  (value === null || value === undefined ? '—' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(digits)}pp`);
const num = (value: number | null | undefined, digits = 2) =>
  (value === null || value === undefined ? '—' : value.toFixed(digits));
const pValue = (value: number | null | undefined) => {
  if (value === null || value === undefined) return '—';
  return value < 0.0001 ? '<0.0001' : value.toFixed(4);
};
const screenLabel = (row: Pick<ResearchRow, 'lookback' | 'hold' | 'floor' | 'dipTolerance'>) =>
  `${row.lookback} lookback · ${row.hold} hold · ${row.floor.replace(/_/g, ' ')} · ${row.dipTolerance.replace(/_/g, ' ')}`;

// The same screen said the way someone would describe it out loud.
const monthsLabel = (value: string) => value.replace(/^(\d+)mo$/, (_all, months) => `${months} month${months === '1' ? '' : 's'}`);
const floorLabel = (value: string) => (value === 'very_bullish_only' ? 'Strong Buy' : 'Buy or Strong Buy');
const plainScreen = (row: Pick<ResearchRow, 'lookback' | 'hold' | 'floor'>) =>
  `Rated ${floorLabel(row.floor)} for ${monthsLabel(row.lookback)} straight, then held ${monthsLabel(row.hold)}`;
const money = (start: number, ret: number | null | undefined) =>
  (ret === null || ret === undefined ? '—' : `$${(start * (1 + ret)).toFixed(2)}`);
const percent = (value: number | null | undefined, digits = 0) =>
  (value === null || value === undefined ? '—' : `${(value * 100).toFixed(digits)}%`);

const researchStages = [
  { label: 'Load prices and ratings', matches: ['Loading price + rating data', 'Loading cached SPY series'] },
  { label: 'Build rating timelines', matches: ['Building rating timeline'] },
  { label: 'Test the stock grid', matches: ['Running screen grid'] },
  { label: 'Test bearish transitions', matches: ['Running bearish transition family'] },
  { label: 'Test bearish persistence', matches: ['Running bearish persistence family'] },
  { label: 'Test ETF ratings versus SPY', matches: ['Running ETF rating-trust family'] },
  { label: 'Test ETF persistence', matches: ['Running ETF persistence family'] },
  { label: 'Run diagnostics and save report', matches: ['Running final report save', 'Saved run metadata', 'Done.'] },
];

const formatElapsed = (startedAt: string) => {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
};

function ResearchProgress({ job }: { job: ResearchJob }) {
  const log = job.log ?? '';
  const currentIndex = job.status === 'completed'
    ? researchStages.length - 1
    : Math.max(0, researchStages.reduce((latest, stage, index) => (
      stage.matches.some((marker) => log.includes(marker)) ? index : latest
    ), 0));
  const logLines = log.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const latestLine = logLines[logLines.length - 1];
  const subtask = latestLine?.match(/(?:test|completed|simulation|diagnostic)\s+(\d+)\/(\d+)/i);
  const subtaskFraction = subtask ? Math.min(1, Number(subtask[1]) / Number(subtask[2])) : 0.35;
  const overallFraction = Math.min(1, (currentIndex + (job.status === 'completed' ? 1 : subtaskFraction)) / researchStages.length);
  return (
    <div className="research-progress" role="status" aria-live="polite">
      <div className="research-progress-heading">
        <strong>Research progress</strong>
        <span>Step {currentIndex + 1} of {researchStages.length} · {formatElapsed(job.startedAt)} elapsed</span>
      </div>
      <div className="research-progress-track" aria-hidden="true">
        <i style={{ width: `${overallFraction * 100}%` }} />
      </div>
      <div className="research-progress-current">
        <strong>{researchStages[currentIndex].label}</strong>
        <span>{job.status === 'completed' ? 'Finished' : 'This stage can take a while because it runs statistical resampling.'}</span>
      </div>
      <ol className="research-progress-stages">
        {researchStages.map((stage, index) => (
          <li key={stage.label} className={index < currentIndex || job.status === 'completed' ? 'done' : index === currentIndex ? 'active' : ''}>
            <span aria-hidden="true">{index < currentIndex || job.status === 'completed' ? '✓' : index === currentIndex ? '→' : '·'}</span>
            {stage.label}
          </li>
        ))}
      </ol>
      {latestLine && <small className="research-progress-log">Latest: {latestLine}</small>}
    </div>
  );
}

// Confidence is assembled only from bars that already exist: the cluster
// floor, the pre-registered discovery bar, the descriptive bootstrap interval,
// and the placebo control. No new threshold is introduced here.
type Trust = { label: string; className: string; why: string };
const trustFor = (row: ResearchRow, isTopCandidate: boolean, placeboUninformative: boolean, minClusters: number): Trust => {
  if (!row.testable) {
    return { label: 'Not enough data', className: 'confidence-low', why: `Only ${row.tickers} stocks — below the ${minClusters} needed to test anything. Treat the figure as noise.` };
  }
  if (isTopCandidate && placeboUninformative) {
    return { label: 'No real edge', className: 'confidence-low', why: 'Picking stocks at random on the same dates did just as well, so the gain came from the market period, not the rating.' };
  }
  if (row.discoveredRule) {
    return { label: 'Strongest evidence', className: 'confidence-high', why: 'Clears the pre-registered statistical bar. Still check the placebo control below before acting on it.' };
  }
  if (row.excessCiLow !== null && row.excessCiLow > 0) {
    return { label: 'Suggestive only', className: 'confidence-medium', why: 'Beat the market in 9 of 10 resamples, but not by enough to clear the bar once every screen tested is accounted for.' };
  }
  return { label: 'Could be luck', className: 'confidence-low', why: 'The market-beating margin disappears within the range of ordinary variation.' };
};
function DollarMatrix({ rows, topCandidate, placeboUninformative, minClusters }: {
  rows: ResearchRow[];
  topCandidate: ResearchRow | null;
  placeboUninformative: boolean;
  minClusters: number;
}) {
  const best = [...rows.filter((row) => row.testable && row.t !== null)]
    .sort((left, right) => Math.abs(right.t ?? 0) - Math.abs(left.t ?? 0))
    // One row per distinct trade set: duplicate grid cells would otherwise
    // fill the table with the same screen twice.
    .filter((row, index, all) => all.findIndex((other) => other.lookback === row.lookback
      && other.hold === row.hold && other.floor === row.floor && other.n === row.n) === index)
    .slice(0, 3);
  if (!best.length) return null;

  return (
    <section className="table-panel dollar-matrix" aria-labelledby="dollar-matrix-title">
      <div className="table-heading">
        <div>
          <h2 id="dollar-matrix-title">What $100 would have done</h2>
          <p>The three strongest screens, each as a single average trade — not a compounded track record</p>
        </div>
        <span className="data-badge">Best 3 of {rows.filter((row) => row.testable).length} testable</span>
      </div>
      <div className="table-scroll">
        <table className="aggregate-table dollar-table">
          <thead>
            <tr>
              <th title="The rating rule and holding period being tested.">The rule</th>
              <th className="number" title="What one average $100 trade became under this rule.">$100 becomes</th>
              <th className="number" title="What the same $100 became in the S&amp;P 500 over the same dates.">Same $100 in the S&amp;P 500</th>
              <th className="number" title="How much the rule beat or trailed the market.">Beat the market</th>
              <th className="number" title="Number of trades and stocks behind the result.">Based on</th>
              <th title="A cautious evidence label based on sample size and diagnostics.">How much to trust it</th>
            </tr>
          </thead>
          <tbody>
            {best.map((row) => {
              const isTop = topCandidate !== null && topCandidate.lookback === row.lookback
                && topCandidate.hold === row.hold && topCandidate.floor === row.floor
                && topCandidate.dipTolerance === row.dipTolerance;
              const trust = trustFor(row, isTop, placeboUninformative, minClusters);
              const ahead = row.meanReturn !== null && row.meanSpyReturn !== null
                && row.meanReturn > row.meanSpyReturn;
              return (
                <tr key={`${row.lookback}|${row.hold}|${row.floor}|${row.dipTolerance}|${row.n}`}>
                  <td className="dollar-rule">
                    <strong>{plainScreen(row)}</strong>
                    <small>
                      {row.dipTolerance === '0pct_strict'
                        ? 'Never dipped below that rating during the run-up'
                        : 'A brief dip below that rating is allowed during the run-up'}
                      {' · '}closed after {monthsLabel(row.hold)} regardless of what the rating does next
                    </small>
                  </td>
                  <td className="number dollar-outcome">
                    <strong className={ahead ? 'positive' : 'negative'}>{money(100, row.meanReturn)}</strong>
                    <small>usually between {money(100, row.returnCiLow)} and {money(100, row.returnCiHigh)}</small>
                  </td>
                  <td className="number dollar-outcome">
                    <strong className="muted">{money(100, row.meanSpyReturn)}</strong>
                    <small>same money, same dates, no picking</small>
                  </td>
                  <td className="number dollar-outcome">
                    <strong className={(row.winRateVsSpy ?? 0) > 0.5 ? 'positive' : 'negative'}>{percent(row.winRateVsSpy)}</strong>
                    <small>of trades, vs 50% for a coin flip</small>
                  </td>
                  <td className="number dollar-outcome">
                    <strong>{row.n}</strong>
                    <small>trades across {row.tickers} stocks</small>
                  </td>
                  <td className="dollar-trust">
                    <span className={`confidence ${trust.className}`}>{trust.label}</span>
                    <small>{trust.why}</small>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="aggregate-rule">
        <span><strong>Reading this:</strong> $100 goes into one average trade and comes out at the end of the holding period. It is not rolled into the next trade, so these are not three-year totals.</span>
        <span><strong>“Usually between”:</strong> where the average landed in 9 out of 10 resamples of the same stocks.</span>
      </div>
    </section>
  );
}

export function ResearchView({ report, job, onRun, onExportResults, scope }: {
  report: ResearchReport | null;
  job: ResearchJob | null;
  onRun: () => void;
  onExportResults?: () => void;
  scope: 'stocks' | 'etf';
}) {
  const [sortKey, setSortKey] = useState<ResearchSortKey>('p');
  const [showUntestable, setShowUntestable] = useState(true);
  const running = job?.status === 'running';
  const reportIsCurrent = report?.researchStatus?.current === true;
  const currentDataVersion = report?.researchStatus?.currentDataVersion;

  const runPanel = (
    <div className="research-run">
      <button className="primary-button" type="button" onClick={onRun} disabled={running || reportIsCurrent}>
        {running ? 'Running analysis…' : reportIsCurrent ? 'Analysis is current' : 'Run analysis'}
      </button>
      {scope === 'etf' && onExportResults && (
        <button className="secondary-button" type="button" onClick={onExportResults} disabled={running}>
          Export research report
        </button>
      )}
      {running && job && <ResearchProgress job={job} />}
      {!running && reportIsCurrent && <span className="research-current-note">Data version {currentDataVersion} has already been analyzed. No rerun is needed.</span>}
      {!running && !reportIsCurrent && report?.available && <span className="research-current-note research-current-note-stale">The data changed since this report. Run analysis to refresh it.</span>}
      {!running && job?.status === 'failed' && <span className="negative">{job.error}</span>}
      {!running && job?.status === 'completed' && job.finishedAt && (
        <span className="muted">Last run finished {new Date(job.finishedAt).toLocaleString()}</span>
      )}
    </div>
  );

  const meta = report?.meta ?? null;
  const rows = report?.rows ?? [];
  const minClusters = meta?.thresholds.min_clusters ?? 15;
  const discoveryT = meta?.thresholds.discovery_t ?? 3;
  const alpha = meta?.thresholds.alpha ?? 0.05;

  const discovered = rows.filter((row) => row.discoveredRule);
  // Some grid cells are the same test twice: a 1% dip tolerance over a 63-day
  // window rounds to "no days below the floor", which is exactly the strict
  // cell. Reported as an observation about the grid -- the correction itself is
  // left exactly as the pipeline computed it, over the family it actually ran.
  const distinctKey = (row: ResearchRow) => `${row.lookback}|${row.hold}|${row.floor}|${row.n}|${row.t}`;
  const distinctDiscovered = new Set(discovered.map(distinctKey)).size;
  const duplicateCells = rows.filter((row) => row.testable).length
    - new Set(rows.filter((row) => row.testable).map(distinctKey)).size;

  const bestT = rows.reduce<number | null>((best, row) => (
    row.t === null ? best : (best === null || Math.abs(row.t) > Math.abs(best) ? row.t : best)
  ), null);

  const visibleRows = useMemo(() => {
    const filtered = showUntestable ? rows : rows.filter((row) => row.testable);
    const rank = (row: ResearchRow) => {
      if (sortKey === 't') return row.t === null ? -Infinity : Math.abs(row.t);
      if (sortKey === 'mean') return row.mean ?? -Infinity;
      if (sortKey === 'trades') return row.n;
      if (sortKey === 'tickers') return row.tickers;
      return row.p === null ? -Infinity : -row.p; // p ascending = most significant first
    };
    return [...filtered].sort((left, right) => rank(right) - rank(left));
  }, [rows, sortKey, showUntestable]);

  const placebo = report?.placebo ?? null;
  const topCandidate = meta?.top_candidate ?? null;
  const concentration = report?.concentration ?? [];
  // The one placebo statement that needs no extra threshold: random tickers on
  // the same entry dates matched or beat this cut at least alpha of the time.
  const placeboUninformative = placebo?.empirical_p !== null && placebo?.empirical_p !== undefined
    && placebo.empirical_p >= alpha;
  const randomBeatObserved = placebo?.random_median !== null && placebo?.random_median !== undefined
    && placebo?.observed_mean !== null && placebo?.observed_mean !== undefined
    && placebo.random_median >= placebo.observed_mean;

  if (report && !report.available) {
    return (
      <section className="empty-trends" aria-label="Research report missing">
        <div className="eyebrow">Persistence screens</div>
        <h2>This analysis hasn&apos;t been run yet</h2>
        <p>
          It reads the same database the Data tab fills, tests every screen in the pre-registered
          grid, and corrects across all of them at once.
        </p>
        {runPanel}
      </section>
    );
  }
  if (!report) return null;

  if (scope === 'etf') {
    return <>
      {runPanel}
      <EtfResearchSection etf={report.etf} />
    </>;
  }

  const verdictClass = discovered.length === 0 ? 'verdict-not-enough-data'
    : placeboUninformative ? 'verdict-mixed' : 'verdict-good';

  return (
    <>
      {runPanel}

      <BearishResearchSection bearish={report.bearish} />

      <section className="section-divider">
        <div className="eyebrow">Bullish persistence research</div>
        <h2>Does staying rated bullish predict better returns?</h2>
        <p>This older bullish family remains separate from the bearish tests and keeps its original correction.</p>
      </section>

      <LegendPanel
        title="How to read the research screens"
        items={[
          { term: 'Lookback', meaning: 'How long the stock had to stay strong before entry.' },
          { term: 'Hold', meaning: 'How long the trade was held after entry.' },
          { term: 'Bullish+', meaning: 'Buy or Strong Buy.' },
          { term: 'Very bullish only', meaning: 'Strong Buy only.' },
          { term: 't and p-values', meaning: 'Simple measures of how unlikely the result is to be random. Smaller p is stronger evidence.' },
          { term: 'Too thin to trust', meaning: 'Not enough different stocks were available for a reliable test.' },
        ]}
      />
      <DollarMatrix rows={rows} topCandidate={topCandidate} placeboUninformative={Boolean(placeboUninformative)} minClusters={minClusters} />

      <section className={`conclusion-box research-verdict ${discovered.length === 0 || placeboUninformative ? 'exploratory' : ''}`} aria-labelledby="research-verdict-title">
        <div className="eyebrow">Headline verdict</div>
        <h3 id="research-verdict-title">
          {discovered.length === 0
            ? `0 of ${rows.length} cuts clear the discovery bar`
            : discovered.length === distinctDiscovered
              ? `${discovered.length} of ${rows.length} cuts clear the discovery bar`
              : `${distinctDiscovered} distinct rule${distinctDiscovered === 1 ? '' : 's'} clear${distinctDiscovered === 1 ? 's' : ''} the discovery bar, across ${discovered.length} of ${rows.length} grid cells`}
        </h3>
        <p>
          The bar is <strong>|t| ≥ {discoveryT}</strong> and <strong>Holm-corrected p &lt; {alpha}</strong>, pre-registered
          across the whole grid as one family of {rows.length} tests, of which {rows.filter((row) => row.testable).length} have
          the {minClusters} ticker clusters needed to be testable at all.
        </p>
        {discovered.length > 0 && (
          <p className={placeboUninformative ? 'research-caveat' : undefined}>
            {placeboUninformative ? (
              <>
                <strong>Clearing the bar is not the finding here.</strong> The strongest cut&apos;s excess return is
                not distinguishable from picking tickers at random on the same entry dates: random draws matched or
                beat it {((placebo?.empirical_p ?? 0) * 100).toFixed(1)}% of the time
                {randomBeatObserved ? ', and the median random draw did better than the screen itself' : ''}.
                On this data that reads as a period or universe effect, not evidence the rating selected well.
              </>
            ) : (
              <>The strongest cut also separates from its random-ticker control (placebo p = {pValue(placebo?.empirical_p)}).
                Read the concentration breakdown below before treating it as a rule.</>
            )}
          </p>
        )}
        {discovered.length === 0 && (
          <p>Nothing has been discovered yet. Cuts below are shown with their uncorrected and corrected p-values so the
            weak evidence stays visible rather than being filtered out.</p>
        )}
        <div className="conclusion-stats">
          <div><span>Cuts tested</span><strong>{rows.length}</strong></div>
          <div><span>Testable (≥{minClusters} tickers)</span><strong>{rows.filter((row) => row.testable).length}</strong></div>
          <div><span>Cells clearing the bar</span><strong className={discovered.length === 0 ? 'muted' : placeboUninformative ? 'negative' : 'positive'}>{discovered.length}</strong></div>
          {discovered.length !== distinctDiscovered && (
            <div><span>Distinct rules</span><strong className={placeboUninformative ? 'negative' : 'positive'}>{distinctDiscovered}</strong></div>
          )}
          <div><span>Best |t|</span><strong>{num(bestT === null ? null : Math.abs(bestT))}</strong></div>
          <div><span>Verdict</span><strong><span className={`verdict ${verdictClass}`}>{discovered.length === 0 ? 'No edge found' : placeboUninformative ? 'Fails placebo control' : 'Survives diagnostics'}</span></strong></div>
        </div>
      </section>

      {duplicateCells > 0 && (
        <div className="trust-warning">
          {duplicateCells} of the {rows.filter((row) => row.testable).length} testable cells duplicate another cell exactly
          (a {meta?.grid.dip_tolerances.join(' / ') ?? 'dip-tolerance'} pair that resolves to the same constraint at these
          window lengths). Duplicates make the Holm correction more conservative, not less, but they would inflate any raw
          count of “rules found”{discovered.length !== distinctDiscovered ? ' — hence the distinct-rule count above' : ''}.
        </div>
      )}

      <section className="table-panel aggregate-panel" aria-labelledby="research-grid-title">
        <div className="table-heading">
          <div>
            <h2 id="research-grid-title">Full pre-registered grid</h2>
            <p>Every lookback × hold × floor × dip-tolerance combination, corrected as one family</p>
          </div>
          <span className="data-badge">{visibleRows.length} of {rows.length} cuts</span>
        </div>
        <div className="aggregate-rule">
          <span><strong>Discovered:</strong> |t| ≥ {discoveryT} and Holm p &lt; {alpha}</span>
          <span><strong>Too thin to trust:</strong> fewer than {minClusters} ticker clusters — reported, never tested</span>
          <span><strong>Mean:</strong> SPY-excess buy-and-hold return per trade, in percentage points</span>
        </div>
        <section className="toolbar" aria-label="Grid controls">
          <div className="field">
            <label htmlFor="research-sort">Sort by</label>
            <select id="research-sort" value={sortKey} onChange={(event) => setSortKey(event.target.value as ResearchSortKey)}>
              <option value="p">Most significant (raw p)</option>
              <option value="t">Largest |t|</option>
              <option value="mean">Largest mean excess return</option>
              <option value="trades">Most trades</option>
              <option value="tickers">Most tickers</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="research-thin">Thin cuts</label>
            <select id="research-thin" value={showUntestable ? 'show' : 'hide'} onChange={(event) => setShowUntestable(event.target.value === 'show')}>
              <option value="show">Show (flagged as too thin)</option>
              <option value="hide">Hide untestable cuts</option>
            </select>
          </div>
          <span className="toolbar-count">{rows.length - rows.filter((row) => row.testable).length} cuts fall below the {minClusters}-cluster floor</span>
        </section>
        <div className="table-scroll">
          <table className="aggregate-table research-table">
            <thead>
              <tr>
                <th title="How long the stock had to stay strong before entering.">Lookback</th><th title="How long the trade was held after entry.">Hold</th><th title="The minimum rating allowed by the rule.">Floor</th><th title="How much the rating could dip without ending the rule.">Dip tolerance</th>
                <th className="number" title="Number of trades tested by this rule.">Trades</th><th className="number" title="Number of different stocks tested by this rule.">Tickers</th>
                <th className="number" title="Average return above or below the S&amp;P 500, in percentage points.">Mean excess</th><th className="number" title="A signal-to-noise score. Bigger absolute values are stronger evidence.">t</th>
                <th className="number" title="The uncorrected chance of seeing a result this large by luck.">p (raw)</th><th className="number" title="The chance after correcting for testing many rules.">p (Holm)</th>
                <th title="Whether the rule clears the evidence bar or is too thin/noisy.">Status</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const key = `${row.lookback}|${row.hold}|${row.floor}|${row.dipTolerance}`;
                const isTop = topCandidate !== null && topCandidate.lookback === row.lookback
                  && topCandidate.hold === row.hold && topCandidate.floor === row.floor
                  && topCandidate.dipTolerance === row.dipTolerance;
                return (
                  <tr key={key} className={row.testable ? undefined : 'research-thin-row'}>
                    <td><strong>{row.lookback}</strong>{isTop && <span className="research-top-flag">top candidate</span>}</td>
                    <td>{row.hold}</td>
                    <td>{row.floor.replace(/_/g, ' ')}</td>
                    <td>{row.dipTolerance.replace(/_/g, ' ')}</td>
                    <td className="number">{row.n}</td>
                    <td className={`number ${row.tickers < minClusters ? 'negative' : ''}`}>{row.tickers}</td>
                    <td className={`number ${row.mean === null ? 'muted' : row.mean >= 0 ? 'positive' : 'negative'}`}>{pp(row.mean)}</td>
                    <td className="number">{num(row.t)}</td>
                    <td className="number">{pValue(row.p)}</td>
                    <td className="number">{pValue(row.holmP)}</td>
                    <td>
                      {!row.testable
                        ? <span className="verdict verdict-not-enough-data">Too thin to trust</span>
                        : row.discoveredRule
                          ? <span className={`verdict ${placeboUninformative && isTop ? 'verdict-mixed' : 'verdict-good'}`}>Clears bar</span>
                          : <span className="verdict verdict-poor">No edge</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <footer className="table-footer">
          <span>Untestable cuts have no t-stat at all — they are excluded from the correction family, not counted as failures</span>
          <span>Source: research/report/full_results.csv</span>
        </footer>
      </section>

      {topCandidate && (
        <section className="section-divider">
          <h2>Diagnostics on the strongest cut</h2>
          <p>{screenLabel(topCandidate)} · {topCandidate.n} trades across {topCandidate.tickers} tickers · mean {pp(topCandidate.mean)} · t = {num(topCandidate.t)} · Holm p = {pValue(topCandidate.holmP)}</p>
        </section>
      )}

      {concentration.length > 0 && (
        <section className="table-panel" aria-labelledby="research-concentration-title">
          <div className="table-heading">
            <div>
              <h2 id="research-concentration-title">Concentration check</h2>
              <p>How much of the cut&apos;s total excess return comes from its few best trades</p>
            </div>
            <span className="data-badge">{topCandidate?.n ?? '—'} trades</span>
          </div>
          <div className="winrate-list">
            {concentration.map((entry) => (
              <div className="winrate-row research-concentration-row" key={entry.topK}>
                <span className="winrate-label">Top {entry.topK} trade{entry.topK === 1 ? '' : 's'}</span>
                <div className="winrate-track">
                  <i className={(entry.percentOfTotal ?? 0) >= 50 ? 'winrate-fill-negative' : 'winrate-fill-positive'}
                    style={{ width: `${Math.max(0, Math.min(100, entry.percentOfTotal ?? 0))}%` }} />
                </div>
                <strong className="winrate-value">{entry.percentOfTotal === null ? '—' : `${entry.percentOfTotal.toFixed(1)}%`}</strong>
                <span className="winrate-count muted">mean {pp(entry.meanExcluding)} without them</span>
              </div>
            ))}
          </div>
          <div className="aggregate-rule">
            <span>A cut whose mean survives removing its best trades is broad. One that collapses is a few lucky names wearing a rule&apos;s clothing.</span>
          </div>
          <footer className="table-footer"><span>Source: research/report/top_candidate_concentration.csv</span></footer>
        </section>
      )}

      {placebo && (
        <section className="table-panel" aria-labelledby="research-placebo-title">
          <div className="table-heading">
            <div>
              <h2 id="research-placebo-title">Placebo control</h2>
              <p>Random tickers held over the same entry and exit dates{topCandidate?.placebo_sims ? ` · ${topCandidate.placebo_sims} draws` : ''}</p>
            </div>
            <span className={`verdict ${placeboUninformative ? 'verdict-poor' : 'verdict-good'}`}>
              {placeboUninformative ? 'Not distinguishable from random' : 'Separates from random'}
            </span>
          </div>
          <div className="research-placebo">
            <div className="research-placebo-scale" aria-hidden="true">
              {(() => {
                const low = placebo.random_p5 ?? 0;
                const high = placebo.random_p95 ?? 0;
                const observed = placebo.observed_mean ?? 0;
                const median = placebo.random_median ?? 0;
                const min = Math.min(low, observed) - 0.01;
                const max = Math.max(high, observed) + 0.01;
                const at = (value: number) => `${((value - min) / (max - min)) * 100}%`;
                return (
                  <>
                    <div className="research-placebo-band" style={{ left: at(low), width: `${((high - low) / (max - min)) * 100}%` }} />
                    <div className="research-placebo-marker median" style={{ left: at(median) }} />
                    <div className="research-placebo-marker observed" style={{ left: at(observed) }} />
                  </>
                );
              })()}
            </div>
            <div className="conclusion-stats">
              <div><span>Observed mean (this cut)</span><strong className={placeboUninformative ? 'negative' : 'positive'}>{pp(placebo.observed_mean)}</strong></div>
              <div><span>Random median</span><strong>{pp(placebo.random_median)}</strong></div>
              <div><span>Random 5th–95th percentile</span><strong>{pp(placebo.random_p5)} to {pp(placebo.random_p95)}</strong></div>
              <div><span>Random draws ≥ observed</span><strong className={placeboUninformative ? 'negative' : 'positive'}>{placebo.empirical_p === null || placebo.empirical_p === undefined ? '—' : `${(placebo.empirical_p * 100).toFixed(1)}%`}</strong></div>
            </div>
            <p className="research-placebo-note">
              {randomBeatObserved
                ? 'The median random draw returned more than the screen did. Whatever produced this excess return was available without reading the rating.'
                : 'The screen sits above the random median; the empirical p above is the share of random draws that still matched or beat it.'}
            </p>
          </div>
          <footer className="table-footer"><span>Source: research/report/top_candidate_placebo.csv</span></footer>
        </section>
      )}

      {meta && (
        <details className="methodology-note">
          <summary>Run details, thresholds, and how to refresh this page</summary>
          <ul>
            <li><strong>Data:</strong> {meta.dataset.tickers} tickers, {meta.dataset.price_rows.toLocaleString()} price rows, {meta.dataset.rating_events.toLocaleString()} rating events, {meta.dataset.price_start} to {meta.dataset.price_end}.</li>
            <li><strong>Benchmark:</strong> cached SPY series {meta.dataset.spy_start} to {meta.dataset.spy_end} ({meta.dataset.spy_days} days). Trades whose exit falls outside this range are excluded rather than extrapolated.</li>
            <li><strong>Bar:</strong> |t| ≥ {meta.thresholds.discovery_t} and Holm-corrected p &lt; {meta.thresholds.alpha}; minimum {meta.thresholds.min_clusters} ticker clusters; {meta.thresholds.bootstrap_reps.toLocaleString()} wild cluster bootstrap replications, clustered by ticker.</li>
            <li><strong>Grid:</strong> lookback {meta.grid.lookbacks.join(', ')} × hold {meta.grid.holds.join(', ')} × floor {meta.grid.floors.join(', ')} × dip tolerance {meta.grid.dip_tolerances.join(', ')}.</li>
            <li><strong>Generated:</strong> {new Date(meta.generated_at).toLocaleString()} from {meta.input_path}. Drop more data into that folder, re-run <code>python run_analysis.py</code>, and refresh — this page reads the run&apos;s output, so no code changes are needed.</li>
          </ul>
        </details>
      )}
    </>
  );
}




