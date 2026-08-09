import { useMemo, useState } from 'react';
import type { SignalDiscoveryResult, SignalDiscoveryRule } from '../../../data';
import { LegendPanel } from '../../../shared/components/LegendPanel';

const percent = (value: number | null) => value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
const points = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}pp`;
const filterLabel = (filter: SignalDiscoveryRule['filter']) => filter === 'strong-buy' ? 'Strong Buy only' : 'Buy or Strong Buy';
const statusLabel = (status: SignalDiscoveryRule['status']) => status === 'survived-validation' ? 'Passed practical gate' : status === 'too-thin' ? 'Too thin' : 'Failed practical gate';
const moneyAfterReturn = (value: number) => `$${(100 * (1 + value / 100)).toFixed(2)}`;
const monthsLabel = (days: number) => {
  const months = Math.round(days / 30);
  return `${months} ${months === 1 ? 'month' : 'months'}`;
};
const download = (payload: unknown, filename: string) => {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

type SortKey = 'rank' | 'filter' | 'persistence' | 'hold' | 'discovery' | 'validation' | 'tickers' | 'winRate' | 'status';

export function SignalDiscoveryView({ result, onRun, universe = 'stocks', showResearchLink = true }: { result: SignalDiscoveryResult | null; onRun: () => void; universe?: 'stocks' | 'etf'; showResearchLink?: boolean }) {
  const isEtf = universe === 'etf';
  const universeLabel = isEtf ? 'ETF' : 'stock';
  const title = isEtf ? 'ETF discovery' : 'Signal discovery';
  const [tickerInput, setTickerInput] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'rank', direction: 'asc' });
  const sortedRules = useMemo(() => {
    if (!result) return [];
    const value = (rule: SignalDiscoveryRule) => ({
      rank: rule.discoveryRank,
      filter: filterLabel(rule.filter),
      persistence: rule.persistenceDays,
      hold: rule.holdDays,
      discovery: rule.discovery.medianExcessPool ?? -Infinity,
      validation: rule.validation.medianExcessPool ?? -Infinity,
      tickers: rule.validation.tickers,
      winRate: rule.validation.beatPoolRate ?? -Infinity,
      status: statusLabel(rule.status),
    })[sort.key];
    return [...result.rules].sort((left, right) => {
      const a = value(left); const b = value(right);
      const compared = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
      return compared * (sort.direction === 'asc' ? 1 : -1);
    });
  }, [result, sort]);
  const requestedTickers = tickerInput.split(/[\s,]+/).map((ticker) => ticker.trim().toUpperCase()).filter(Boolean);
  const tickerRows = result?.tickerMatches.filter((row) => requestedTickers.includes(row.ticker.toUpperCase())) ?? [];
  const exportPackage = result ? {
    schemaVersion: 3,
    exportType: isEtf ? 'etf-signal-discovery' : 'stock-signal-discovery',
    exportedAt: new Date().toISOString(),
    resultGeneratedAt: result.generatedAt,
    universe: result.universe,
    universeTickers: result.universeTickers,
    periods: {
      discoveryStart: result.discoveryStart,
      splitDate: result.splitDate,
      validationEnd: result.validationEnd,
    },
    rulesTested: result.rulesTested,
    methodology: result.methodology,
    bestRule: result.bestRule,
    trustTest: result.trustTest,
    displaySort: sort,
    rules: sortedRules,
    tickerMatches: result.tickerMatches,
  } : null;
  const changeSort = (key: SortKey) => setSort((current) => current.key === key ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' } : { key, direction: 'asc' });
  const sortHeader = (key: SortKey, label: string) => <button className="table-sort-button" type="button" onClick={() => changeSort(key)}>{label}{sort.key === key ? sort.direction === 'asc' ? ' ↑' : ' ↓' : ' ↕'}</button>;

  if (!result) return <section className="empty-trends"><h2>No {title.toLowerCase()} result loaded</h2><p>Run the fixed rule search against the imported three-year {universeLabel} data.</p><button className="primary-button" type="button" onClick={onRun}>Run {title.toLowerCase()}</button></section>;
  const best = result.bestRule;
  const trustPassedNarrowly = Boolean(result.trustTest?.verdict === 'rating-and-rule-supported'
    && Math.min(result.trustTest.poolBeatSpyRate, result.trustTest.poolBeatNonBullishRate, result.trustTest.winnerBeatPoolRate) < 0.6);
  return <>
    <LegendPanel title={`How ${title.toLowerCase()} works`} items={[
      { term: 'Discovery period', meaning: 'The earlier data chooses which rule looks strongest.' },
      { term: 'Validation period', meaning: 'The final unseen year checks the frozen rule without changing it.' },
      { term: 'Persistence', meaning: 'How long the stock continuously stayed in the required rating family before entry.' },
      { term: 'Vs pool', meaning: `Return beyond other ${isEtf ? 'ETFs' : 'stocks'} with the same bullish rating at the same time. The ticker being judged is excluded from its own comparison pool.` },
      { term: 'Passed practical gate', meaning: 'A descriptive holdout threshold only. It is not the formal statistical verdict.' },
      { term: 'Formal verdict', meaning: `For ETFs, the corrected rating-vs-SPY and persistence tests live in Research Lab. This screen is exploratory.` },
      { term: 'Too thin', meaning: 'Fewer than 15 different tickers in discovery or validation; there is not enough breadth to judge it.' },
    ]} />

    {result.universeTickers === 0 && <section className="empty-trends"><h2>No ETF data imported</h2><p>Add JSON data containing <code>"fundType": "ETF"</code>, then open Data and run Import. ETF discovery never falls back to stocks.</p></section>}

    <section className="discovery-setup">
      <div><span>Rating families</span><strong>Strong Buy · Bullish+</strong></div>
      <div><span>Persistence tested</span><strong>{result.methodology.persistenceDays.map((days) => `${Math.round(days / 30)}m`).join(' · ')}</strong></div>
      <div><span>Future holds tested</span><strong>{result.methodology.holdDays.map((days) => `${days}d`).join(' · ')}</strong></div>
      <div><span>Time split</span><strong>{result.discoveryStart}–{result.splitDate} · {result.splitDate}–{result.validationEnd}</strong></div>
      <div><span>{isEtf ? 'ETFs' : 'Stocks'} analyzed</span><strong>{result.universeTickers}</strong></div>
      <button className="reset-button" type="button" onClick={onRun}>Run {title.toLowerCase()} again</button>
    </section>

    {isEtf && showResearchLink && <section className="table-panel discovery-formal-test">
      <div className="table-heading"><div><h2>Looking for the formal ETF verdict?</h2><p>This page explores possible persistence rules. It does not decide whether the rating itself is trustworthy.</p></div><a className="secondary-button" href="/etfs/research">Open ETF Research</a></div>
      <p className="formal-bottom-line">Research Lab separately tests the main question—whether bullish-rated ETFs beat SPY—and the secondary question of whether waiting for persistence adds value over other bullish ETFs.</p>
    </section>}

    <section className="discovery-verdict">
      <div className="discovery-winner-heading"><span className="discovery-winner-badge">Exploratory</span><span className="eyebrow">Rule that passed the practical holdout gate</span></div>
      {best ? <>
        <h2>{filterLabel(best.filter)} for at least {monthsLabel(best.persistenceDays)} → hold {best.holdDays} days</h2>
        <p><strong>Practical-gate rule:</strong> Choose an {isEtf ? 'ETF' : 'stock'} after it has continuously stayed {filterLabel(best.filter)} for at least {monthsLabel(best.persistenceDays)}, then hold it for {best.holdDays} days. This is an exploratory pattern, not the formal rating-trust verdict.</p>
        {best.validation.medianReturn !== null && <div className="discovery-money-example">
          <span>Simple $100 example</span>
          <strong>$100 → {moneyAfterReturn(best.validation.medianReturn)}</strong>
          <p>Historically, the middle validation result for {isEtf ? 'ETFs' : 'stocks'} matching this rule was {percent(best.validation.medianReturn)}. Half did better and half did worse; this is not a guaranteed future return.</p>
        </div>}
        <div className="discovery-metrics">
          <div><span>Validation tickers</span><strong>{best.validation.tickers}</strong></div>
          <div><span>Median return</span><strong className={best.validation.medianReturn !== null && best.validation.medianReturn >= 0 ? 'positive' : 'negative'}>{percent(best.validation.medianReturn)}</strong></div>
          <div><span>Median vs pool</span><strong className={best.validation.medianExcessPool !== null && best.validation.medianExcessPool >= 0 ? 'positive' : 'negative'}>{percent(best.validation.medianExcessPool)}</strong></div>
          <div><span>Beat pool</span><strong>{best.validation.beatPoolRate === null ? '—' : `${(best.validation.beatPoolRate * 100).toFixed(0)}%`}</strong></div>
        </div>
      </> : <><h2>No rule survived validation</h2><p>The strongest discovery-period patterns did not meet the fixed breadth and unseen-period checks. That is a valid result; the system does not promote a winner anyway.</p></>}
    </section>

    {isEtf && result.trustTest && <section className="table-panel discovery-trust-test">
      <div className="table-heading"><div><h2>Descriptive matched controls</h2><p>Exploratory comparison using the same dates and {result.trustTest.holdDays}-day hold across all four layers.</p></div><span className={`data-badge ${result.trustTest.ratingSupported ? 'positive' : 'negative'}`}>{result.trustTest.ratingSupported ? 'Practical threshold passed' : 'Practical threshold failed'}</span></div>
      <div className="trust-test-verdict">
        <strong>{result.trustTest.verdict === 'rating-and-rule-supported' ? trustPassedNarrowly ? 'Both required checks passed, but narrowly.' : 'Both required checks passed.' : result.trustTest.verdict === 'rating-supported-rule-not-supported' ? 'The bullish rating passed, but the persistence rule did not add reliable value.' : 'The bullish rating did not beat its controls reliably in this test.'}</strong>
        <p>{result.trustTest.verdict === 'rating-and-rule-supported'
          ? `The matching ${filterLabel(result.trustTest.filter)} ETF pool beat both SPY and non-bullish ETFs, and waiting ${monthsLabel(result.trustTest.persistenceDays)} added further value over that pool.`
          : result.trustTest.verdict === 'rating-supported-rule-not-supported'
            ? `The ${filterLabel(result.trustTest.filter)} rating itself helped, but waiting ${monthsLabel(result.trustTest.persistenceDays)} was not consistently better than buying the matching rating pool.`
            : `On these matched validation cases, ordinary ${filterLabel(result.trustTest.filter)} ETFs did not beat both SPY and non-bullish ETFs often enough to call the rating dependable.`}</p>
      </div>
      <div className="trust-test-steps">
        <article><span>1 · Market baseline</span><h3>SPY</h3><strong>{percent(result.trustTest.spyMedianReturn)}</strong><p>Median market return over the same windows.</p></article>
        <article><span>2 · Neutral control</span><h3>Non-bullish ETF pool</h3><strong>{percent(result.trustTest.nonBullishMedianReturn)}</strong><p>Median return for ETFs rated Hold, Sell, or Strong Sell on the same dates.</p></article>
        <article><span>3 · Test the rating</span><h3>Matching bullish ETF pool</h3><strong>{points(result.trustTest.poolMedianExcessNonBullish)} vs control</strong><p>{(result.trustTest.poolBeatNonBullishRate * 100).toFixed(0)}% wins vs non-bullish ETFs · {points(result.trustTest.poolMedianExcessSpy)} and {(result.trustTest.poolBeatSpyRate * 100).toFixed(0)}% wins vs SPY.</p></article>
        <article><span>4 · Test the extra rule</span><h3>Winning persistence rule</h3><strong>{points(result.trustTest.winnerMedianExcessPool)} vs bullish</strong><p>{(result.trustTest.winnerBeatPoolRate * 100).toFixed(0)}% wins · raw median $100 → {moneyAfterReturn(result.trustTest.winnerMedianReturn)}.</p></article>
      </div>
      <p className="trust-test-footnote">Based on {result.trustTest.observations} matched historical signals across {result.trustTest.tickers} ETFs in the unseen validation year. Returns are medians, before costs. This tests historical evidence—not a guaranteed future return—and the imported universe may still contain survivor bias.</p>
    </section>}

    <section className="table-panel discovery-ticker-check">
      <div className="table-heading"><div><h2>Check ticker(s) against the frozen rule</h2><p>This checks the latest imported rating streak only. It does not create a buy recommendation.</p></div></div>
      {best ? <><div className="discovery-ticker-controls"><input value={tickerInput} onChange={(event) => setTickerInput(event.target.value)} placeholder="ATI, MSFT, NVDA" aria-label="Tickers to check" /><span>{requestedTickers.length ? `${tickerRows.length} found in imported data` : 'Enter one or more tickers'}</span></div>
      {requestedTickers.length > 0 && <div className="table-scroll"><table className="aggregate-table"><thead><tr><th>Ticker</th><th>Company</th><th>Latest rating</th><th className="number">Continuous streak</th><th>Matches discovered rule?</th><th>Data date</th></tr></thead><tbody>{tickerRows.map((row) => <tr key={row.ticker}><td><strong>{row.ticker}</strong></td><td>{row.company}</td><td>{row.latestRating}</td><td className="number">{row.persistenceDays}d</td><td className={row.qualifies ? 'positive' : 'muted'}>{row.qualifies ? 'Yes' : 'No'}</td><td>{row.latestDate}</td></tr>)}{tickerRows.length === 0 && <tr><td colSpan={6}>None of those tickers exist in the imported dataset.</td></tr>}</tbody></table></div>}</> : <div className="aggregate-rule"><span>No ticker check is available because no rule survived the unseen validation period.</span></div>}
    </section>

    <details className="table-panel discovery-rules" open>
      <summary className="table-heading"><div><h2>All discovered rules</h2><p>All {result.rulesTested} rules; discovery rank is fixed before the validation period is inspected.</p></div><span className="data-badge">{result.rulesTested} tested</span></summary>
      <div className="table-toolbar"><button className="table-export-button" type="button" onClick={() => download(exportPackage, isEtf ? 'etf-discovery-analysis.json' : 'signal-discovery-analysis.json')}>Export analysis</button></div>
      <div className="table-scroll"><table className="aggregate-table discovery-table"><thead><tr><th>{sortHeader('rank', 'Discovery rank')}</th><th>{sortHeader('filter', 'Rating pattern')}</th><th className="number">{sortHeader('persistence', 'Persistence')}</th><th className="number">{sortHeader('hold', 'Hold')}</th><th className="number">{sortHeader('discovery', 'Discovery vs pool')}</th><th className="number">{sortHeader('validation', 'Validation vs pool')}</th><th className="number">{sortHeader('tickers', 'Validation tickers')}</th><th className="number">{sortHeader('winRate', 'Beat pool')}</th><th>{sortHeader('status', 'Verdict')}</th></tr></thead><tbody>{sortedRules.map((rule) => {
        const isWinner = best?.filter === rule.filter && best.persistenceDays === rule.persistenceDays && best.holdDays === rule.holdDays;
        return <tr className={isWinner ? 'discovery-winner-row' : undefined} key={`${rule.filter}-${rule.persistenceDays}-${rule.holdDays}`}><td>{rule.discoveryRank}</td><td>{filterLabel(rule.filter)}</td><td className="number">{Math.round(rule.persistenceDays / 30)}m</td><td className="number">{rule.holdDays}d</td><td className="number">{percent(rule.discovery.medianExcessPool)}</td><td className={rule.validation.medianExcessPool !== null && rule.validation.medianExcessPool >= 0 ? 'number positive' : 'number negative'}>{percent(rule.validation.medianExcessPool)}</td><td className="number">{rule.validation.tickers}</td><td className="number">{rule.validation.beatPoolRate === null ? '—' : `${(rule.validation.beatPoolRate * 100).toFixed(0)}%`}</td><td>{isWinner && <span className="discovery-table-winner">Exploratory</span>}{statusLabel(rule.status)}</td></tr>;
      })}</tbody></table></div>
    </details>
  </>;
}
