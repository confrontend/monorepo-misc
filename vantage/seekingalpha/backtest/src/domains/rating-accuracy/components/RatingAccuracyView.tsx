import { Fragment, useMemo, useState } from 'react';
import type { AnalysisMeta } from '../../../api';
import type { PredictiveAccuracySummary, Rating, RatingCallSummary, TickerAccuracy, TierStats } from '../../../data';
import { ratingClass, signedPercent, tierDotColor, tierSortOrder } from '../../../shared/analysisUi';
import { LegendPanel } from '../../../shared/components/LegendPanel';

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

// Shared per-tier breakdown, used by both the predictive-accuracy and strategy-style conclusions.
// Buy is never silently merged into Strong Buy, nor Sell into Strong Sell — each of the five tiers
// gets its own row with the ticker-cluster bootstrap interval as the primary confidence range.
function TierBreakdownTable({ byTier, idPrefix }: { byTier: Partial<Record<Rating, TierStats>>; idPrefix: string }) {
  const tiers: Rating[] = ['Strong Buy', 'Buy', 'Hold', 'Sell', 'Strong Sell'];
  const present = tiers.filter((tier) => byTier[tier] && (byTier[tier]!.scoredCalls > 0 || byTier[tier]!.medianExcessReturn !== null));
  if (!present.length) return null;

  return (
    <div className="table-scroll">
      <table className="aggregate-table" aria-label="Hit rate by rating tier">
        <thead><tr><th title="The rating that was active when the test started.">Rating</th><th className="number" title="Signals with enough future price data to judge.">Scored</th><th className="number" title="Scored signals where the future move matched the rating direction.">Correct</th><th className="number" title="The percentage of scored signals that were correct.">Hit rate</th><th className="number" title="A likely range for the true hit rate. Narrower means more certainty.">Bootstrap 95% CI</th><th className="number" title="The middle return above or below the S&amp;P 500.">Median excess return</th><th className="number" title="How many different stocks contributed data.">Tickers</th></tr></thead>
        <tbody>
          {present.map((tier) => {
            const stats = byTier[tier]!;
            const cls = stats.hitRate === null ? 'muted' : stats.hitRate >= 50 ? 'positive' : 'negative';
            return (
              <tr key={`${idPrefix}-${tier}`}>
                <td>{tier}</td>
                <td className="number">{stats.scoredCalls}</td>
                <td className="number positive">{stats.correctCalls}</td>
                <td className={`number ${cls}`}>{stats.hitRate === null ? 'n/a' : `${stats.hitRate.toFixed(0)}%`}</td>
                <td className="number muted">{stats.hitRateBootstrapLow === null ? 'n/a' : `${stats.hitRateBootstrapLow.toFixed(0)}–${stats.hitRateBootstrapHigh!.toFixed(0)}%`}</td>
                <td className={`number ${stats.medianExcessReturn === null ? 'muted' : stats.medianExcessReturn >= 0 ? 'positive' : 'negative'}`}>{stats.medianExcessReturn === null ? 'n/a' : signedPercent(stats.medianExcessReturn)}</td>
                <td className="number muted">{stats.tickers}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Primary conclusion: does the ORIGINAL rating, held fixed, predict the market-adjusted direction
// over a fixed horizon — regardless of whether the rating changed afterward? This is the direct
// answer to "does a Seeking Alpha rating contain forward information," separate from (and not to be
// confused with) the strategy-style test below, which intentionally exits early on a rating change.
function PredictiveAccuracyConclusion({ summary }: { summary: PredictiveAccuracySummary | null }) {
  if (!summary) return null;
  const { horizonDays, scoredCalls, correctCalls, hitRate, hitRateBootstrapLow, hitRateBootstrapHigh, hitRateLow, hitRateHigh, tickerWeightedHitRate, averageReturn, medianReturn, censoredCalls, neutralCalls, byTier } = summary;

  if (!scoredCalls) {
    return (
      <section className="conclusion-box" aria-labelledby="predictive-conclusion-title">
        <h3 id="predictive-conclusion-title">Primary conclusion: was the original rating right at {horizonDays} days?</h3>
        <p>Not enough episodes with a reachable {horizonDays}-day outcome yet ({censoredCalls} right-censored, {neutralCalls} Hold-only).</p>
      </section>
    );
  }

  const verdict = hitRateBootstrapLow !== null && hitRateBootstrapLow > 50
    ? 'ratings have shown a market-adjusted directional edge'
    : hitRateBootstrapHigh !== null && hitRateBootstrapHigh < 50
      ? 'ratings have performed worse than a coin flip, market-adjusted'
      : 'the market-adjusted hit rate is not distinguishable from a coin flip yet';
  const verdictClass = hitRateBootstrapLow !== null && hitRateBootstrapLow > 50 ? 'positive' : hitRateBootstrapHigh !== null && hitRateBootstrapHigh < 50 ? 'negative' : 'muted';

  return (
    <section className="conclusion-box" aria-labelledby="predictive-conclusion-title">
      <h3 id="predictive-conclusion-title">Primary conclusion: was the original rating right at {horizonDays} days?</h3>
      <p>
        Each bullish/bearish rating episode keeps its ORIGINAL rating fixed and is scored against the market-adjusted (excess-over-SPY) outcome exactly {horizonDays} days after next-trading-day entry, regardless of whether the rating changed in between — a different question from the strategy-style test below. Based on {scoredCalls} such episodes, <strong className={verdictClass}>{verdict}</strong>: {correctCalls} of {scoredCalls} ({hitRate !== null ? hitRate.toFixed(0) : '—'}%) were correct. The primary interval — a ticker-cluster bootstrap, which accounts for calls from the same ticker being correlated — is {hitRateBootstrapLow !== null ? hitRateBootstrapLow.toFixed(0) : '—'}%–{hitRateBootstrapHigh !== null ? hitRateBootstrapHigh.toFixed(0) : '—'}% (the naive Wilson interval, which assumes independent calls, is narrower at {hitRateLow !== null ? hitRateLow.toFixed(0) : '—'}%–{hitRateHigh !== null ? hitRateHigh.toFixed(0) : '—'}%). The ticker-weighted hit rate (each ticker counted once, regardless of how many calls it contributed) is {tickerWeightedHitRate !== null ? `${tickerWeightedHitRate.toFixed(0)}%` : 'n/a'}. Median excess return per call was {medianReturn !== null ? signedPercent(medianReturn) : 'n/a'} (mean {averageReturn !== null ? signedPercent(averageReturn) : 'n/a'}).
      </p>
      <div className="conclusion-stats">
        <div><span>Scored episodes</span><strong>{scoredCalls}</strong></div>
        <div><span>Hit rate</span><strong className={verdictClass}>{hitRate !== null ? hitRate.toFixed(0) : '—'}%</strong></div>
        <div><span>Bootstrap 95% CI (primary)</span><strong className={verdictClass}>{hitRateBootstrapLow !== null ? hitRateBootstrapLow.toFixed(0) : '—'}–{hitRateBootstrapHigh !== null ? hitRateBootstrapHigh.toFixed(0) : '—'}%</strong></div>
        <div><span>Wilson 95% CI (descriptive)</span><strong className="muted">{hitRateLow !== null ? hitRateLow.toFixed(0) : '—'}–{hitRateHigh !== null ? hitRateHigh.toFixed(0) : '—'}%</strong></div>
        <div><span>Ticker-weighted hit rate</span><strong>{tickerWeightedHitRate !== null ? `${tickerWeightedHitRate.toFixed(0)}%` : 'n/a'}</strong></div>
        <div><span>Right-censored</span><strong className="muted">{censoredCalls}</strong></div>
        <div><span>Hold-only (unscored)</span><strong className="muted">{neutralCalls}</strong></div>
      </div>
      <TierBreakdownTable byTier={byTier} idPrefix="predictive" />
    </section>
  );
}

function RatingCallConclusion({ summary }: { summary: RatingCallSummary | null }) {
  if (!summary) return null;
  const { horizonDays, scoredCalls, correctCalls, incorrectCalls, hitRate, hitRateLow, hitRateHigh, hitRateBootstrapLow, hitRateBootstrapHigh, tickerWeightedHitRate, averageReturn, medianReturn, openCalls, unenterableCalls, neutralCalls, byTier } = summary;

  if (!scoredCalls) {
    return (
      <section className="conclusion-box exploratory" aria-labelledby="calls-conclusion-title">
        <h3 id="calls-conclusion-title">Secondary: would a rating-follower's position have been right?</h3>
        <p>Not enough closed bullish/bearish rating episodes yet at this horizon to test ({openCalls} still open, {unenterableCalls} with no next trading day, {neutralCalls} Hold-only).</p>
      </section>
    );
  }

  const verdict = hitRateBootstrapLow !== null && hitRateBootstrapLow > 50
    ? 'reliably better than a coin flip'
    : hitRateBootstrapHigh !== null && hitRateBootstrapHigh < 50
      ? 'reliably worse than a coin flip'
      : 'not statistically distinguishable from a coin flip yet';
  const verdictClass = hitRateBootstrapLow !== null && hitRateBootstrapLow > 50 ? 'positive' : hitRateBootstrapHigh !== null && hitRateBootstrapHigh < 50 ? 'negative' : 'muted';

  return (
    <section className="conclusion-box exploratory" aria-labelledby="calls-conclusion-title">
      <h3 id="calls-conclusion-title">Secondary: would a rating-follower's position have been right?</h3>
      <p>
        A different question from the primary conclusion above: this test exits a position early when the rating changes (rather than keeping the original rating fixed to the horizon), because that is what an investor who reacted to every rating change would have done — so treat it as a portfolio-behavior check, not a test of the rating&apos;s original forward information. Correctness is market-adjusted (excess return over SPY) whenever benchmark data covers the entry/exit dates. Based on {scoredCalls} such calls, the hit rate is <strong className={verdictClass}>{verdict}</strong>: {correctCalls} of {scoredCalls} ({hitRate !== null ? hitRate.toFixed(0) : '—'}%) were correct, bootstrap 95% CI {hitRateBootstrapLow !== null ? hitRateBootstrapLow.toFixed(0) : '—'}%–{hitRateBootstrapHigh !== null ? hitRateBootstrapHigh.toFixed(0) : '—'}% (Wilson: {hitRateLow !== null ? hitRateLow.toFixed(0) : '—'}%–{hitRateHigh !== null ? hitRateHigh.toFixed(0) : '—'}%). Ticker-weighted hit rate: {tickerWeightedHitRate !== null ? `${tickerWeightedHitRate.toFixed(0)}%` : 'n/a'}. Average return per call was {averageReturn !== null ? signedPercent(averageReturn) : 'n/a'} (median {medianReturn !== null ? signedPercent(medianReturn) : 'n/a'}).
      </p>
      <div className="conclusion-stats">
        <div><span>Scored calls</span><strong>{scoredCalls}</strong></div>
        <div><span>Correct</span><strong className="positive">{correctCalls}</strong></div>
        <div><span>Incorrect</span><strong className="negative">{incorrectCalls}</strong></div>
        <div><span>Hit rate (bootstrap 95% CI)</span><strong className={verdictClass}>{hitRate !== null ? hitRate.toFixed(0) : '—'}% ({hitRateBootstrapLow !== null ? hitRateBootstrapLow.toFixed(0) : '—'}–{hitRateBootstrapHigh !== null ? hitRateBootstrapHigh.toFixed(0) : '—'}%)</strong></div>
        <div><span>Avg return / call</span><strong className={averageReturn !== null && averageReturn >= 0 ? 'positive' : 'negative'}>{averageReturn !== null ? signedPercent(averageReturn) : 'n/a'}</strong></div>
        <div><span>Still open</span><strong className="muted">{openCalls}</strong></div>
        <div><span>Hold-only (unscored)</span><strong className="muted">{neutralCalls}</strong></div>
      </div>
      <TierBreakdownTable byTier={byTier} idPrefix="strategy" />
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
    const avgReturn = scored.length ? scored.reduce((total, call) => total + (call.excessReturnPercent ?? call.returnPercent ?? 0), 0) / scored.length : null;
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
          <thead><tr><th>Ticker</th><th className="number" title="All rating calls found for this stock.">Total calls</th><th className="number" title="Signals with enough future price data to judge.">Scored</th><th className="number" title="Scored signals where the future move matched the rating direction.">Correct</th><th className="number" title="The percentage of scored signals that were correct.">Hit rate</th><th className="number">Avg return</th><th className="number" title="Calls that do not have enough later data to close yet.">Still open</th></tr></thead>
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

// Item 1 (Freeze the research rules): a compact, always-visible readout of the frozen methodology
// config every DB run saves alongside its methodology_version hash — so the rules behind the
// numbers above are visible, not just documented in a comment somewhere.
function MethodologyNote({ methodology }: { methodology: AnalysisMeta['methodology'] | null }) {
  if (!methodology) return null;
  return (
    <details className="methodology-note">
      <summary>Frozen methodology (v{methodology.version}) — entry rule, benchmark, bootstrap, minimum evidence</summary>
      <ul>
        <li><strong>Entry rule:</strong> {methodology.entryRule}</li>
        <li><strong>Benchmark:</strong> {methodology.benchmarkTicker} · forward-match tolerance ±{methodology.forwardMatchToleranceDays} days</li>
        <li><strong>Hold treatment:</strong> {methodology.holdNeutralityRule}</li>
        <li><strong>Transaction costs:</strong> {methodology.transactionCostAssumption}</li>
        <li><strong>Primary confidence interval:</strong> ticker-cluster bootstrap, {methodology.bootstrapRepetitions} repetitions, seed {methodology.bootstrapSeed}</li>
        <li><strong>Multiple testing:</strong> {methodology.multipleTestingMethod}</li>
        <li><strong>Minimum evidence:</strong> {methodology.minimumEvidenceNotes}</li>
      </ul>
    </details>
  );
}

export function TickerAccuracyView({ rows, horizonDays, horizonOptions, selectedTicker, onSelectTicker, onHorizonChange, ratingCallSummary, predictiveAccuracySummary, methodology }: {
  rows: TickerAccuracy[];
  horizonDays: number;
  horizonOptions: number[];
  selectedTicker: string | null;
  onSelectTicker: (ticker: string) => void;
  onHorizonChange: (days: number) => void;
  ratingCallSummary: RatingCallSummary | null;
  predictiveAccuracySummary: PredictiveAccuracySummary | null;
  methodology: AnalysisMeta['methodology'] | null;
}) {
  const sorted = [...rows].sort((left, right) => left.ticker.localeCompare(right.ticker));
  const active = sorted.find((row) => row.ticker === selectedTicker) ?? sorted[0] ?? null;

  return (
    <>
      <LegendPanel
        title="How to read prediction accuracy"
        items={[
          { term: 'Scored', meaning: 'Signals with enough future price data to check.' },
          { term: 'Correct', meaning: 'Signals where the later price move matched the rating direction.' },
          { term: '95% CI', meaning: 'A likely range for the true result; a wide range means more uncertainty.' },
          { term: 'Correlation', meaning: 'Whether higher ratings tend to be followed by higher returns.' },
        ]}
      />
      <section className="toolbar" aria-label="Rating accuracy controls">
        <div className="field">
          <label htmlFor="accuracy-horizon">Forward window</label>
          <select id="accuracy-horizon" value={horizonDays} onChange={(event) => onHorizonChange(Number(event.target.value))}>
            {horizonOptions.map((days) => <option value={days} key={days}>{horizonLabel(days)}</option>)}
          </select>
        </div>
        <div className="toolbar-count">Used by the conclusions below and the exploratory chart further down</div>
      </section>

      <MethodologyNote methodology={methodology} />
      <PredictiveAccuracyConclusion summary={predictiveAccuracySummary} />
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
            <thead><tr><th>Ticker</th><th className="number">Observations</th><th className="number" title="Whether higher ratings tend to go with higher future returns. 1 is strong positive, 0 is none.">Correlation (r)</th><th className="number" title="Average return change for one rating-score point.">Slope (%/score point)</th></tr></thead>
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

// ---------------------------------------------------------------------------
// Persistence-screen research view. Renders research/report/*.csv, produced by
// research/run_analysis.py. Nothing here recomputes a statistic: every number
// is read from that run, and the pass/fail bar comes from run_meta.json (i.e.
// from pipeline.py's own constants) rather than being restated in this file,
// so the two can't drift apart.
// ---------------------------------------------------------------------------








