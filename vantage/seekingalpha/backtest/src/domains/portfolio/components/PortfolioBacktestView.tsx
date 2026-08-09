import { Fragment, useMemo, useState } from 'react';
import type { PortfolioBacktestResult, PortfolioConfig, PortfolioHoldoutValidationResult, PortfolioRatingFilter, PortfolioRebalance, PortfolioSearchResult, PortfolioWeighting } from '../../../data';
import { fetchBestPortfolioBacktests, fetchPortfolioBacktest, fetchPortfolioHoldoutValidation } from '../../../api';
import { LegendPanel } from '../../../shared/components/LegendPanel';
import { LoadingState } from '../../../shared/components/LoadingState';

const defaultConfig: PortfolioConfig = {
  startDate: '2024-01-01',
  endDate: '2026-01-01',
  portfolioSize: 20,
  ratingFilter: 'strong-buy',
  rebalance: 'monthly',
  weighting: 'equal',
  exitOnRatingDrop: true,
  maxHoldDays: null,
};

const money = (value: number) => '$' + value.toFixed(2);

// "BUY"/"SELL" alone cannot distinguish opening a position from topping one up, which is why the
// first version of this timeline reported 951 weight adjustments as purchases.
const TRADE_LABELS: Record<'open' | 'add' | 'trim' | 'close', string> = {
  open: 'BUY',
  add: 'ADD TO',
  trim: 'TRIM',
  close: 'SELL',
};
const EXIT_LABELS: Record<string, string> = {
  'rating-drop': 'left the winners list',
  'max-hold': 'hit the maximum holding period',
  rebalance: 'dropped out of the selection',
  'end-of-test': 'still open at the end',
};

// Derived here rather than read off the payload. A result object can outlive the shape it was
// fetched with -- "Use this" replays a row from an earlier search that is still sitting in React
// state -- and a missing field rendered straight into a template produced "undefinedd" on screen.
// Entry date and the last day of the run are always present, so the number is computed from those.
const daysHeldFor = (entryDate: string, lastDate: string | undefined) => {
  if (!entryDate || !lastDate) return null;
  const days = (Date.parse(lastDate) - Date.parse(entryDate)) / (24 * 60 * 60 * 1000);
  return Number.isFinite(days) ? Math.max(0, Math.round(days)) : null;
};
const percent = (value: number) => (value >= 0 ? '+' : '') + value.toFixed(2) + '%';
const labelFilter = (value: PortfolioRatingFilter) => value === 'strong-buy' ? 'Strong Buy only' : 'Bullish+ (Buy or Strong Buy)';
const labelRebalance = (value: PortfolioRebalance) => value === 'weekly' ? 'Weekly' : value === 'monthly' ? 'Monthly' : 'Quarterly';
const labelWeighting = (value: PortfolioWeighting) => value === 'equal' ? 'Equal weight' : 'Score weighted';
const labelSellRule = (value: boolean) => value ? 'Sell when rating drops' : 'Sell at rebalance';
const labelHold = (value: number | null) => value === null ? 'No maximum hold' : `${value} days`;
const downloadJson = (filename: string, rows: unknown[]) => {
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

type PatternDimension = 'portfolioSize' | 'ratingFilter' | 'rebalance' | 'weighting' | 'exitOnRatingDrop' | 'maxHoldDays';
type PatternRow = {
  dimension: string;
  value: string;
  count: number;
  wins: number;
  winRate: number;
  medianExcess: number;
  averageExcess: number;
  top20: number;
  bottom20: number;
  evidenceScore: number;
};
type SortDirection = 'asc' | 'desc';
type TableSort = { table: 'patterns' | 'failures' | 'configurations' | 'holdings'; key: string; direction: SortDirection };

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

export function PortfolioBacktestView() {
  const [mode, setMode] = useState<'explore' | 'best'>('explore');
  const [config, setConfig] = useState<PortfolioConfig>(defaultConfig);
  const [result, setResult] = useState<PortfolioBacktestResult | null>(null);
  const [bestResults, setBestResults] = useState<PortfolioBacktestResult[]>([]);
  const [search, setSearch] = useState<PortfolioSearchResult['search'] | null>(null);
  const [validation, setValidation] = useState<PortfolioHoldoutValidationResult | null>(null);
  const [expandedConfiguration, setExpandedConfiguration] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [validationRunning, setValidationRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const curve = result?.equityCurve ?? [];
  const chartBounds = useMemo(() => {
    const values = curve.flatMap((point) => [point.portfolioValue, point.benchmarkValue]);
    return values.length ? { min: Math.min(...values), max: Math.max(...values) } : { min: 0, max: 100 };
  }, [curve]);
  // Entering and exiting a name are decisions; trimming a winner back to its target weight is
  // housekeeping. On a weekly rebalance the housekeeping outnumbers the decisions roughly four to
  // one, so it is hidden by default rather than allowed to bury them.
  const [showReweights, setShowReweights] = useState(false);
  const [tableSort, setTableSort] = useState<TableSort | null>(null);
  const tradeCounts = useMemo(() => {
    const all = result?.trades ?? [];
    return {
      opens: all.filter((trade) => trade.kind === 'open').length,
      closes: all.filter((trade) => trade.kind === 'close').length,
      reweights: all.filter((trade) => trade.kind === 'add' || trade.kind === 'trim').length,
    };
  }, [result]);
  const tradeGroups = useMemo(() => {
    const groups = new Map<string, PortfolioBacktestResult['trades']>();
    for (const trade of result?.trades ?? []) {
      if (!showReweights && (trade.kind === 'add' || trade.kind === 'trim')) continue;
      groups.set(trade.date, [...(groups.get(trade.date) ?? []), trade]);
    }
    return [...groups.entries()].sort(([left], [right]) => right.localeCompare(left));
  }, [result, showReweights]);
  const update = <K extends keyof PortfolioConfig>(key: K, value: PortfolioConfig[K]) =>
    setConfig((current) => ({ ...current, [key]: value }));
  const runExplore = async () => {
    setLoading(true); setError(null);
    try { setResult((await fetchPortfolioBacktest(config)).data); setMode('explore'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  const findBest = async () => {
    setLoading(true); setError(null);
    try {
      const response = (await fetchBestPortfolioBacktests({ startDate: config.startDate, endDate: config.endDate })).data;
      setBestResults(response.results);
      setSearch(response.search);
      setMode('best');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  const validateHoldouts = async () => {
    setLoading(true); setValidationRunning(true); setError(null);
    try {
      const response = (await fetchPortfolioHoldoutValidation({ startDate: config.startDate, endDate: config.endDate }, { repetitions: 20, holdoutFraction: 0.3, seed: 20260806 })).data;
      setValidation(response);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setValidationRunning(false); setLoading(false); }
  };
  // Re-runs the chosen configuration rather than replaying the stored row. The search response
  // deliberately carries no equity curve, holdings or trades, and re-fetching also means a result
  // can never be rendered against a shape it was not fetched with.
  const useBest = async (best: PortfolioBacktestResult) => {
    setConfig(best.config);
    setMode('explore');
    setLoading(true); setError(null);
    try { setResult((await fetchPortfolioBacktest(best.config)).data); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  const configurationKey = (item: PortfolioBacktestResult) => [item.config.portfolioSize, item.config.ratingFilter, item.config.rebalance, item.config.weighting, item.config.exitOnRatingDrop, item.config.maxHoldDays].join('-');
  const toggleConfiguration = (key: string) => setExpandedConfiguration((current) => current === key ? null : key);
  const sortValue = (value: unknown) => typeof value === 'number' ? value : String(value ?? '').toLowerCase();
  const sortRows = <T,>(rows: T[], table: TableSort['table'], key: string, value: (row: T) => unknown) => {
    if (!tableSort || tableSort.table !== table || tableSort.key !== key) return rows;
    const direction = tableSort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((left, right) => {
      const a = sortValue(value(left));
      const b = sortValue(value(right));
      if (a === b) return 0;
      return (a < b ? -1 : 1) * direction;
    });
  };
  const sortButton = (table: TableSort['table'], key: string, label: string) => {
    const active = tableSort?.table === table && tableSort.key === key;
    const indicator = active ? tableSort.direction === 'asc' ? ' ↑' : ' ↓' : ' ↕';
    return <button className="table-sort-button" type="button" onClick={() => setTableSort((current) => current?.table === table && current.key === key ? { ...current, direction: current.direction === 'asc' ? 'desc' : 'asc' } : { table, key, direction: 'asc' })}>{label}{indicator}</button>;
  };
  const patternRows = useMemo<PatternRow[]>(() => {
    const dimensions: Array<{ key: PatternDimension; label: string; value: (item: PortfolioBacktestResult) => string }> = [
      { key: 'portfolioSize', label: 'Portfolio size', value: (item) => `${item.config.portfolioSize} stocks` },
      { key: 'ratingFilter', label: 'Rating filter', value: (item) => labelFilter(item.config.ratingFilter) },
      { key: 'rebalance', label: 'Rebalance', value: (item) => labelRebalance(item.config.rebalance) },
      { key: 'weighting', label: 'Weighting', value: (item) => labelWeighting(item.config.weighting) },
      { key: 'exitOnRatingDrop', label: 'Sell rule', value: (item) => labelSellRule(item.config.exitOnRatingDrop) },
      { key: 'maxHoldDays', label: 'Maximum hold', value: (item) => labelHold(item.config.maxHoldDays) },
    ];
    const topKeys = new Set(bestResults.slice(0, 20).map(configurationKey));
    const bottomKeys = new Set(bestResults.slice(-20).map(configurationKey));
    const grouped = dimensions.flatMap(({ label, value }) => {
      const groups = new Map<string, PortfolioBacktestResult[]>();
      for (const item of bestResults) groups.set(value(item), [...(groups.get(value(item)) ?? []), item]);
      return [...groups.entries()].map(([groupValue, items]) => {
        const excess = items.map((item) => item.summary.excessVsPool);
        const wins = excess.filter((item) => item > 0).length;
        return {
          dimension: label,
          value: groupValue,
          count: items.length,
          wins,
          winRate: wins / items.length,
          medianExcess: median(excess),
          averageExcess: excess.reduce((total, item) => total + item, 0) / items.length,
          top20: items.filter((item) => topKeys.has(configurationKey(item))).length,
          bottom20: items.filter((item) => bottomKeys.has(configurationKey(item))).length,
          evidenceScore: 0,
        };
      });
    });
    return grouped.map((row) => {
      const sameDimension = grouped.filter((candidate) => candidate.dimension === row.dimension);
      const medianRank = sameDimension.filter((candidate) => candidate.medianExcess <= row.medianExcess).length / sameDimension.length;
      const topRate = row.top20 / Math.min(20, bestResults.length);
      const bottomRate = row.bottom20 / Math.min(20, bestResults.length);
      // This is an evidence score, not a probability. It rewards median performance and
      // repeatability, while penalising settings that recur among the worst configurations.
      const evidenceScore = Math.max(0, Math.min(100, Math.round(
        medianRank * 40 + row.winRate * 30 + topRate * 20 + (1 - bottomRate) * 10,
      )));
      return { ...row, evidenceScore };
    }).sort((left, right) => right.evidenceScore - left.evidenceScore || right.medianExcess - left.medianExcess);
  }, [bestResults]);
  const patternVerdict = useMemo(() => {
    if (!patternRows.length) return null;
    const strongest = patternRows[0];
    const mostTop20 = [...patternRows].sort((left, right) => right.top20 - left.top20 || right.medianExcess - left.medianExcess)[0];
    const scoreByValue = new Map(patternRows.map((row) => [`${row.dimension}|${row.value}`, row.evidenceScore]));
    const scoredConfigurations = bestResults.map((item) => {
      const scores = [
        ['Portfolio size', `${item.config.portfolioSize} stocks`],
        ['Rating filter', labelFilter(item.config.ratingFilter)],
        ['Rebalance', labelRebalance(item.config.rebalance)],
        ['Weighting', labelWeighting(item.config.weighting)],
        ['Sell rule', labelSellRule(item.config.exitOnRatingDrop)],
        ['Maximum hold', labelHold(item.config.maxHoldDays)],
      ].map(([dimension, value]) => scoreByValue.get(`${dimension}|${value}`) ?? 0);
      return { item, score: scores.reduce((total, value) => total + value, 0) / scores.length };
    }).sort((left, right) => right.score - left.score);
    return { strongest, mostTop20, rule: scoredConfigurations[0] ?? null };
  }, [bestResults, patternRows]);
  const displayedPatternRows = sortRows(patternRows, 'patterns', tableSort?.key ?? '', (row) => row[tableSort?.key as keyof PatternRow]);
  const failureResults = sortRows(bestResults.slice(-20).reverse(), 'failures', tableSort?.key ?? '', (item) => {
    const summary = item.summary;
    const values: Record<string, unknown> = {
      configuration: configurationKey(item), portfolio: summary.portfolioReturn, pool: summary.poolReturn,
      excess: summary.excessVsPool, drawdown: summary.maxDrawdown, trades: summary.tradeCount,
      meaning: summary.portfolioReturn < 0 ? 'The portfolio lost money outright.' : summary.excessVsPool < 0 ? 'The stock pool gained more; selection reduced the result.' : 'It gained, but the path included a large drawdown.',
    };
    return values[tableSort?.key ?? 'configuration'];
  });
  const configurationResults = sortRows(bestResults, 'configurations', tableSort?.key ?? '', (item) => {
    const values: Record<string, unknown> = {
      size: item.config.portfolioSize, filter: labelFilter(item.config.ratingFilter), rebalance: labelRebalance(item.config.rebalance), weighting: labelWeighting(item.config.weighting), sellRule: labelSellRule(item.config.exitOnRatingDrop), portfolio: item.summary.portfolioReturn, pool: item.summary.poolReturn, excess: item.summary.excessVsPool, spy: item.summary.excessReturn, drawdown: item.summary.maxDrawdown,
    };
    return values[tableSort?.key ?? 'excess'];
  });
  const holdingResults = sortRows(result?.holdings ?? [], 'holdings', tableSort?.key ?? '', (holding) => {
    const days = daysHeldFor(holding.entryDate, curve[curve.length - 1]?.date);
    const values: Record<string, unknown> = { ticker: holding.ticker, company: holding.company, weight: holding.weight, opened: holding.entryDate, held: days ?? -1, entry: holding.entryPrice, return: holding.returnPercent };
    return values[tableSort?.key ?? 'ticker'];
  });

  return (
    <>
      <LegendPanel title="How to read a portfolio backtest" items={[
        { term: 'Portfolio size', meaning: 'How many stocks are bought together. Example: 20 means 20 holdings.' },
        { term: 'Strong Buy only', meaning: 'Only stocks rated Strong Buy can enter the basket.' },
        { term: 'Bullish+', meaning: 'Buy and Strong Buy stocks can enter the basket.' },
        { term: 'Equal weight', meaning: 'Every selected stock receives the same share of the money.' },
        { term: 'Score weight', meaning: 'Higher quant scores receive a larger share.' },
        { term: 'Best', meaning: 'Best among the tested combinations, not a guarantee for the future.' },
        { term: 'Evidence score', meaning: 'A 0–100 historical consistency score. It is not a probability or a promise of profit.' },
      ]} />
      <section className="portfolio-controls">
        <div className="portfolio-mode" role="tablist" aria-label="Portfolio backtest mode">
          <button className={mode === 'explore' ? 'nav-button active' : 'nav-button'} type="button" onClick={() => setMode('explore')}>Explore</button>
          <button className={mode === 'best' ? 'nav-button active' : 'nav-button'} type="button" onClick={() => setMode('best')}>Find best</button>
        </div>
        <div className="portfolio-fields">
          <label>Start date<input type="date" value={config.startDate} onChange={(event) => update('startDate', event.target.value)} /></label>
          <label>End date<input type="date" value={config.endDate} onChange={(event) => update('endDate', event.target.value)} /></label>
          <label>Portfolio size <output>{config.portfolioSize}</output><input type="range" min="1" max="100" value={config.portfolioSize} onChange={(event) => update('portfolioSize', Number(event.target.value))} /></label>
          <label>Rating filter<select value={config.ratingFilter} onChange={(event) => update('ratingFilter', event.target.value as PortfolioRatingFilter)}><option value="strong-buy">Strong Buy only</option><option value="bullish-plus">Bullish+ (Buy or Strong Buy)</option></select></label>
          <label>Rebalance<select value={config.rebalance} onChange={(event) => update('rebalance', event.target.value as PortfolioRebalance)}><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option></select></label>
          <label>Weighting<select value={config.weighting} onChange={(event) => update('weighting', event.target.value as PortfolioWeighting)}><option value="equal">Equal weight</option><option value="score">Score weighted</option></select></label>
          <label>Sell rule<select value={config.exitOnRatingDrop ? 'drop' : 'rebalance'} onChange={(event) => update('exitOnRatingDrop', event.target.value === 'drop')}>
            <option value="drop">Sell as soon as it leaves the list</option>
            <option value="rebalance">Sell only at the next rebalance</option>
          </select></label>
          <label>Maximum hold<select value={config.maxHoldDays === null ? 'none' : String(config.maxHoldDays)} onChange={(event) => update('maxHoldDays', event.target.value === 'none' ? null : Number(event.target.value))}>
            <option value="none">No limit</option>
            <option value="90">3 months</option>
            <option value="180">6 months</option>
            <option value="365">12 months</option>
          </select></label>
        </div>
        <div className="portfolio-actions">
          <button className="primary-button" type="button" onClick={() => void runExplore()} disabled={loading}>Run simulation</button>
          <button className="reset-button" type="button" onClick={() => void findBest()} disabled={loading}>Test all 288 combinations</button>
          <button className="reset-button" type="button" onClick={() => void validateHoldouts()} disabled={loading || bestResults.length === 0}>Validate on random holdouts</button>
          <span className="muted">Uses the next available recorded session after each rating date.</span>
        </div>
      </section>
      {loading && <LoadingState label={validationRunning ? 'Validating winners on random holdouts' : mode === 'best' ? 'Testing every combination' : 'Running portfolio simulation'} detail={validationRunning ? 'Repeating the 288-case search on random training tickers, then testing the selected rule on different unseen tickers.' : mode === 'best' ? 'Simulating each configuration day by day, plus the own-everything baseline it is measured against.' : 'Selecting stocks day by day, applying the sell rule, and comparing with the pool and SPY.'} />}
      {error && <div className="data-status data-error">{error}</div>}
      {mode === 'best' && bestResults.length > 0 && search && (
        <>
          <section className="conclusion-box exploratory" aria-labelledby="search-caveat-title">
            <div className="eyebrow">Read this before the table</div>
            <h3 id="search-caveat-title">
              This is the best of {search.configurationsTried} configurations tried, not an estimate of what the strategy earns
            </h3>
            <p>
              Owning <strong>every</strong> eligible stock over the same dates, with no stock-picking at all, returned{' '}
              <strong>{percent(search.poolReturn)}</strong> against SPY&apos;s {percent(search.benchmarkReturn)}. That head start
              belongs to the candidate list, not to the rating: the list is built from files exported today, so companies that
              were delisted or dropped from coverage never appear in it and their losses were never taken.
            </p>
            <p>
              So the column that answers &quot;did picking stocks help?&quot; is <strong>vs owning everything</strong>, not
              &quot;vs SPY&quot;. Across all {search.configurationsTried} configurations that number ranges from{' '}
              {percent(search.worstExcessVsPool)} to {percent(search.bestExcessVsPool)}, median {percent(search.medianExcessVsPool)},
              with {search.beatPoolCount} of {search.configurationsTried} beating the pool. With that many attempts, the top of a
              spread this wide is what the luckiest configuration looked like in hindsight.
            </p>
            {bestResults[0] && <div className="best-rule-action">
              <div><strong>Best historical result:</strong> {bestResults[0].config.portfolioSize} stocks, {labelFilter(bestResults[0].config.ratingFilter).toLowerCase()}, {labelRebalance(bestResults[0].config.rebalance).toLowerCase()} rebalance, {labelWeighting(bestResults[0].config.weighting).toLowerCase()} — {percent(bestResults[0].summary.excessVsPool)} versus owning the pool.</div>
              <button className="primary-button" type="button" onClick={() => void useBest(bestResults[0])} disabled={loading}>Use best historical result</button>
            </div>}
          </section>
          {validation && <section className="table-panel portfolio-panel holdout-validation" aria-labelledby="holdout-validation-title">
            <div className="table-heading">
              <div>
                <h2 id="holdout-validation-title">Does the pattern survive unseen tickers?</h2>
                <p>Each run chooses a rule from {Math.round((1 - validation.holdoutFraction) * 100)}% of the tickers, then tests that frozen rule on the other {Math.round(validation.holdoutFraction * 100)}%. No holdout ticker is used to pick the winner.</p>
              </div>
              <span className="data-badge">{validation.repetitions} random splits</span>
            </div>
            <div className="holdout-summary"><div><span>Beat pool</span><strong>{validation.summary.holdoutBeatPoolCount}/{validation.runs.length}</strong></div><div><span>Pass rate</span><strong>{(validation.summary.holdoutBeatPoolRate * 100).toFixed(0)}%</strong></div><div><span>Median vs pool</span><strong className={validation.summary.medianHoldoutExcessVsPool >= 0 ? 'positive' : 'negative'}>{percent(validation.summary.medianHoldoutExcessVsPool)}</strong></div><div><span>Range</span><strong>{percent(validation.summary.worstHoldoutExcessVsPool)} to {percent(validation.summary.bestHoldoutExcessVsPool)}</strong></div></div>
            <div className="pattern-verdict"><strong>How to read this:</strong> if the median is positive and most holdout runs beat the pool, the rule shows some repeatability across different ticker groups. If the median is negative or the pass rate is near 50%, the original winner may have been specific to the names it was discovered on. This is still survivor-only and does not prove future profitability.</div>
            <div className="table-scroll"><table className="aggregate-table pattern-table holdout-table"><thead><tr><th>Run</th><th>Winner chosen from training tickers</th><th className="number">Training vs pool</th><th className="number">Holdout portfolio</th><th className="number">Holdout pool</th><th className="number">Holdout vs pool</th><th className="number">Drawdown</th></tr></thead><tbody>{validation.runs.map((run, index) => <tr key={run.seed}><td>{index + 1}</td><td>{run.winnerConfig.portfolioSize} stocks · {labelFilter(run.winnerConfig.ratingFilter)} · {labelRebalance(run.winnerConfig.rebalance)} · {labelWeighting(run.winnerConfig.weighting)} · {labelSellRule(run.winnerConfig.exitOnRatingDrop)} · {labelHold(run.winnerConfig.maxHoldDays)}</td><td className="number">{percent(run.trainingExcessVsPool)}</td><td className={run.holdout.portfolioReturn >= 0 ? 'number positive' : 'number negative'}>{percent(run.holdout.portfolioReturn)}</td><td className="number muted">{percent(run.holdout.poolReturn)}</td><td className={run.holdout.excessVsPool >= 0 ? 'number positive' : 'number negative'}><strong>{percent(run.holdout.excessVsPool)}</strong></td><td className="number negative">{percent(run.holdout.maxDrawdown)}</td></tr>)}</tbody></table></div>
          </section>}
          <details className="table-panel portfolio-panel portfolio-patterns portfolio-analysis-panel">
            <summary className="table-heading">
              <div>
                <h2 id="portfolio-patterns-title">What the better configurations have in common</h2>
                <p>Each row groups all tested configurations that share one setting. This looks for a recurring pattern, not just the single winner.</p>
              </div>
              <span className="data-badge">{patternRows.length} patterns</span>
            </summary>
            <div className="table-toolbar"><span className="muted">Export the currently sorted pattern rows.</span><button className="table-export-button" type="button" onClick={() => downloadJson('portfolio-pattern-summary.json', displayedPatternRows)}>Export table</button></div>
            {patternVerdict && <div className="pattern-verdict">
              <strong>Historical pattern:</strong> {patternVerdict.strongest.value} under <strong>{patternVerdict.strongest.dimension.toLowerCase()}</strong> had the highest evidence score ({patternVerdict.strongest.evidenceScore}/100) and median advantage over owning the pool ({percent(patternVerdict.strongest.medianExcess)} across {patternVerdict.strongest.count} tests).
              {' '}The setting appearing most often in the top 20 was <strong>{patternVerdict.mostTop20.value}</strong> ({patternVerdict.mostTop20.top20} of 20 top configurations).
              {patternVerdict.rule && <> The highest-scoring combined rule was <strong>{patternVerdict.rule.item.config.portfolioSize} stocks, {labelFilter(patternVerdict.rule.item.config.ratingFilter).toLowerCase()}, {labelRebalance(patternVerdict.rule.item.config.rebalance).toLowerCase()} rebalance, {labelWeighting(patternVerdict.rule.item.config.weighting).toLowerCase()}</strong> with a combined evidence score of <strong>{Math.round(patternVerdict.rule.score)}/100</strong>.</>}
              <span> This is evidence of a historical pattern, not a current buy instruction or proof it will work on new data.</span>
            </div>}
            <div className="table-scroll"><table className="aggregate-table pattern-table"><thead><tr>
              <th>{sortButton('patterns', 'dimension', 'Setting')}</th><th>{sortButton('patterns', 'value', 'Value')}</th><th className="number" title="How many configurations used this setting.">{sortButton('patterns', 'count', 'Tests')}</th><th className="number" title="How many of those configurations beat owning every eligible stock.">{sortButton('patterns', 'wins', 'Beat pool')}</th><th className="number" title="Beat-pool percentage.">{sortButton('patterns', 'winRate', 'Win rate')}</th><th className="number" title="Middle result among configurations using this setting.">{sortButton('patterns', 'medianExcess', 'Median vs pool')}</th><th className="number" title="Average result among configurations using this setting.">{sortButton('patterns', 'averageExcess', 'Average vs pool')}</th><th className="number" title="How often this setting appears among the 20 best configurations.">{sortButton('patterns', 'top20', 'Top 20')}</th><th className="number" title="How often this setting appears among the 20 worst configurations.">{sortButton('patterns', 'bottom20', 'Worst 20')}</th><th className="number" title="Historical evidence score, not a probability of profit.">{sortButton('patterns', 'evidenceScore', 'Evidence score')}</th>
            </tr></thead><tbody>{displayedPatternRows.map((row) => <tr key={`${row.dimension}-${row.value}`}>
              <td><strong>{row.dimension}</strong></td><td>{row.value}</td><td className="number">{row.count}</td><td className="number">{row.wins}</td><td className="number">{(row.winRate * 100).toFixed(0)}%</td><td className={row.medianExcess >= 0 ? 'number positive' : 'number negative'}><strong>{percent(row.medianExcess)}</strong></td><td className={row.averageExcess >= 0 ? 'number positive' : 'number negative'}>{percent(row.averageExcess)}</td><td className="number">{row.top20}</td><td className="number negative">{row.bottom20}</td><td className="number"><strong>{row.evidenceScore}/100</strong></td>
            </tr>)}</tbody></table></div>
          </details>
          <details className="table-panel portfolio-panel portfolio-failures portfolio-analysis-panel">
            <summary className="table-heading">
              <div>
                <h2 id="portfolio-failures-title">Why the weaker configurations failed</h2>
                <p>The 20 worst results are shown here. “Vs pool” tells you whether stock selection hurt, while drawdown shows how painful the journey was.</p>
              </div>
              <span className="data-badge">Bottom 20</span>
            </summary>
            <div className="table-toolbar"><span className="muted">Export the currently sorted bottom-20 rows.</span><button className="table-export-button" type="button" onClick={() => downloadJson('portfolio-bottom-20-failures.json', failureResults)}>Export table</button></div>
            <div className="table-scroll"><table className="aggregate-table pattern-table failure-table"><thead><tr>
              <th>{sortButton('failures', 'configuration', 'Configuration')}</th><th className="number">{sortButton('failures', 'portfolio', 'Portfolio')}</th><th className="number">{sortButton('failures', 'pool', 'Own everything')}</th><th className="number">{sortButton('failures', 'excess', 'Vs pool')}</th><th className="number">{sortButton('failures', 'drawdown', 'Drawdown')}</th><th className="number">{sortButton('failures', 'trades', 'Trades')}</th><th>{sortButton('failures', 'meaning', 'What this means')}</th><th>Use</th>
            </tr></thead><tbody>{failureResults.map((item) => {
              const key = configurationKey(item);
              const summary = item.summary;
              const explanation = summary.portfolioReturn < 0
                ? 'The portfolio lost money outright.'
                : summary.excessVsPool < 0
                  ? 'The stock pool gained more; selection reduced the result.'
                  : 'It gained, but the path included a large drawdown.';
              return <tr key={`failure-${key}`}>
                <td>{item.config.portfolioSize} stocks · {labelFilter(item.config.ratingFilter)} · {labelRebalance(item.config.rebalance)} · {labelWeighting(item.config.weighting)} · {labelSellRule(item.config.exitOnRatingDrop)} · {labelHold(item.config.maxHoldDays)}</td>
                <td className={summary.portfolioReturn >= 0 ? 'number positive' : 'number negative'}>{percent(summary.portfolioReturn)}</td>
                <td className="number muted">{percent(summary.poolReturn)}</td>
                <td className={summary.excessVsPool >= 0 ? 'number positive' : 'number negative'}><strong>{percent(summary.excessVsPool)}</strong></td>
                <td className="number negative">{percent(summary.maxDrawdown)}</td><td className="number">{summary.tradeCount}</td><td>{explanation}</td>
                <td><button className="reset-button" type="button" onClick={() => void useBest(item)}>Inspect</button></td>
              </tr>;
            })}</tbody></table></div>
          </details>
          <details className="table-panel portfolio-panel portfolio-analysis-panel">
            <summary className="table-heading">
              <div>
                <h2 id="best-portfolios-title">All tested configurations</h2>
                <p>All {bestResults.length} tests, ranked by what stock-picking added over owning the same pool; sort or export the complete list</p>
              </div>
              <span className="data-badge">{bestResults.length} tried</span>
            </summary>
            <div className="table-toolbar"><span className="muted">Export the currently sorted visible configuration rows.</span><button className="table-export-button" type="button" onClick={() => downloadJson('portfolio-tested-configurations.json', configurationResults)}>Export table</button></div>
            <div className="table-scroll"><table className="aggregate-table portfolio-table"><thead><tr>
              <th>{sortButton('configurations', 'size', 'Size')}</th><th>{sortButton('configurations', 'filter', 'Filter')}</th><th>{sortButton('configurations', 'rebalance', 'Rebalance')}</th><th>{sortButton('configurations', 'weighting', 'Weighting')}</th><th>{sortButton('configurations', 'sellRule', 'Sell rule')}</th>
              <th className="number">{sortButton('configurations', 'portfolio', 'Portfolio')}</th>
              <th className="number" title="Owning every eligible stock over the same dates, equally weighted, with no selection.">{sortButton('configurations', 'pool', 'Own everything')}</th>
              <th className="number" title="What the stock-picking rule added over simply owning the whole eligible pool. This is the number that measures the rating's contribution.">{sortButton('configurations', 'excess', 'vs owning everything')}</th>
              <th className="number" title="Includes the head start that comes from the candidate list containing only surviving companies.">{sortButton('configurations', 'spy', 'vs SPY')}</th>
              <th className="number" title="The largest drop from a previous portfolio peak, measured on daily values.">{sortButton('configurations', 'drawdown', 'Drawdown')}</th>
              <th>Use</th>
            </tr></thead><tbody>{configurationResults.map((item) => {
              const key = configurationKey(item);
              const expanded = expandedConfiguration === key;
              // Read from the summary, not from item.rebalances / item.trades: the comparison
              // response deliberately carries neither, so anything derived from them read as zero.
              const rebalanceBuys = item.summary.positionsOpened;
              const rebalanceSells = item.summary.closedAtRebalance;
              const exitSells = item.summary.closedMidPeriod;
              return <Fragment key={key}>
              <tr key={key} className={expanded ? 'configuration-row expanded' : 'configuration-row'} tabIndex={0} aria-expanded={expanded} onClick={() => toggleConfiguration(key)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleConfiguration(key); } }}>
                <td><strong>{item === bestResults[0] ? 'Top · ' : ''}{item.config.portfolioSize}</strong></td>
                <td>{labelFilter(item.config.ratingFilter)}</td>
                <td>{item.config.rebalance}</td>
                <td>{item.config.weighting}</td>
                <td>{item.config.exitOnRatingDrop ? 'On drop' : 'At rebalance'}{item.config.maxHoldDays ? ` · max ${item.config.maxHoldDays}d` : ''}</td>
                <td className={item.summary.portfolioReturn >= 0 ? 'number positive' : 'number negative'}>{percent(item.summary.portfolioReturn)}</td>
                <td className="number muted">{percent(item.summary.poolReturn)}</td>
                <td className={item.summary.excessVsPool >= 0 ? 'number positive' : 'number negative'}><strong>{percent(item.summary.excessVsPool)}</strong></td>
                <td className="number muted">{percent(item.summary.excessReturn)}</td>
                <td className="number negative">{percent(item.summary.maxDrawdown)}</td>
                <td><button className="row-expand-button" type="button" aria-label={`${expanded ? 'Collapse' : 'Expand'} configuration details`} onClick={(event) => { event.stopPropagation(); toggleConfiguration(key); }}>{expanded ? '▾' : '▸'}</button> <button className="reset-button" type="button" onClick={(event) => { event.stopPropagation(); useBest(item); }}>Use this</button></td>
              </tr>
              {expanded && <tr className="configuration-detail-row" key={`${key}-details`}><td colSpan={11}><div className="configuration-detail">
                <div><strong>In simple words</strong>
                  <p>
                    This test bought up to {item.config.portfolioSize} {labelFilter(item.config.ratingFilter).toLowerCase()} stocks,
                    using {item.config.weighting === 'equal' ? 'the same amount of money for each stock' : 'larger amounts for higher-scoring stocks'},
                    and rebalanced back to those weights {item.config.rebalance === 'weekly' ? 'each week' : item.config.rebalance === 'monthly' ? 'each month' : 'each quarter'}.
                  </p>
                  <p>
                    {/* Both triggers have to be described. Saying only "waits for the next rebalance"
                        while a 90-day cap is set against a ~91-day quarter reads as "never sells early"
                        when in practice almost every position is cut by the cap first. */}
                    A stock was sold {item.config.exitOnRatingDrop
                      ? 'as soon as it stopped qualifying'
                      : 'when it dropped out of the selection at a rebalance'}
                    {item.config.maxHoldDays
                      ? `, and in any case after ${item.config.maxHoldDays} days — which on a ${item.config.rebalance} cycle is what ends most positions`
                      : ', with no maximum holding period'}.
                  </p>
                </div>
                <div className="configuration-detail-stats"><span><strong>{rebalanceBuys}</strong> positions opened</span><span><strong>{rebalanceSells}</strong> dropped at a rebalance</span><span><strong>{exitSells}</strong> sold early (downgrade or hold limit)</span><span><strong>{item.summary.rebalanceCount}</strong> rebalance dates</span></div>
                <div><strong>How to read the result</strong><p>The portfolio made {percent(item.summary.portfolioReturn)}. Owning every eligible stock made {percent(item.summary.poolReturn)}. The selection rule added {percent(item.summary.excessVsPool)} compared with that pool.</p><p className="muted">This result includes stocks bought and sold earlier. The end-of-test holdings are only the stocks still open on the final day.</p></div>
              </div></td></tr>}
              </Fragment>;
            })}</tbody></table></div>
          </details>
        </>
      )}
      {result && mode === 'explore' && (
        <>
          <section className="portfolio-summary" aria-label="Portfolio summary">
            <div><span>Portfolio return</span><strong className={result.summary.portfolioReturn >= 0 ? 'positive' : 'negative'}>{percent(result.summary.portfolioReturn)}</strong></div>
            <div><span>Own everything ({result.summary.poolHoldings.toFixed(0)} stocks)</span><strong>{percent(result.summary.poolReturn)}</strong></div>
            <div><span>What picking added</span><strong className={result.summary.excessVsPool >= 0 ? 'positive' : 'negative'}>{percent(result.summary.excessVsPool)}</strong></div>
            <div><span>SPY return</span><strong className="muted">{percent(result.summary.benchmarkReturn)}</strong></div>
            <div><span>Above SPY</span><strong className="muted">{percent(result.summary.excessReturn)}</strong></div>
            <div><span>Max drawdown</span><strong className="negative">{percent(result.summary.maxDrawdown)}</strong></div>
            <div><span>Average holdings</span><strong>{result.summary.averageHoldings.toFixed(1)}</strong></div>
            <div><span>Trades</span><strong>{result.summary.tradeCount}</strong></div>
            <div><span>Sold on downgrade</span><strong>{result.summary.exitReasons['rating-drop']}</strong></div>
          </section>
          <section className="table-panel portfolio-panel" aria-labelledby="portfolio-chart-title">
            <div className="table-heading">
              <div>
                <h2 id="portfolio-chart-title">Portfolio activity timeline</h2>
                <p>{config.portfolioSize} stocks · {labelFilter(config.ratingFilter)} · {config.rebalance} rebalance · newest first</p>
              </div>
              <span className="data-badge">{tradeCounts.opens} bought · {tradeCounts.closes} sold</span>
            </div>
            <section className="toolbar" aria-label="Timeline controls">
              <div className="field">
                <label htmlFor="timeline-detail">Show</label>
                <select id="timeline-detail" value={showReweights ? 'all' : 'positions'} onChange={(event) => setShowReweights(event.target.value === 'all')}>
                  <option value="positions">Entries and exits only</option>
                  <option value="all">Every execution, including rebalancing</option>
                </select>
              </div>
              <span className="toolbar-count">
                {tradeCounts.reweights} rebalancing trades {showReweights ? 'shown' : 'hidden'} — topping up and trimming
                existing holdings back to target weight, not entering or leaving a position
              </span>
            </section>
            <div className="portfolio-timeline" role="list" aria-label="Portfolio buy and sell activity">
              {tradeGroups.length === 0 && <div className="muted">No executed trades were recorded in this period.</div>}
              {tradeGroups.map(([date, trades]) => (
                <div className="portfolio-timeline-day" key={date} role="listitem">
                  <div className="portfolio-timeline-date">
                    <strong>{date}</strong>
                    <span>{trades.length} {trades.length === 1 ? 'trade' : 'trades'}</span>
                  </div>
                  <div className="portfolio-timeline-events">{trades.map((trade, index) => (
                    <div className={trade.action === 'buy' ? 'portfolio-trade buy' : 'portfolio-trade sell'} key={`${trade.ticker}-${trade.kind}-${index}`}>
                      <strong>{TRADE_LABELS[trade.kind]} {trade.ticker}</strong>
                      <span>{money(trade.price)}</span>
                      <small>{
                        trade.kind === 'close' ? `held ${trade.heldDays ?? 0} days · ${EXIT_LABELS[trade.reason] ?? trade.reason}`
                          : trade.kind === 'open' ? (trade.reason === 'replacement' ? 'replacing a name that was sold' : 'new position at rebalance')
                            : `held ${trade.heldDays ?? 0} days · back to target weight`
                      }</small>
                    </div>
                  ))}</div>
                </div>
              ))}
            </div>
            <div className="portfolio-chart-legend"><span><i className="portfolio-trade-dot buy" /> Money in</span><span><i className="portfolio-trade-dot sell" /> Money out</span></div>
          </section>
          <section className="table-panel portfolio-panel" aria-labelledby="portfolio-holdings-title">
            <div className="table-heading">
              <div>
                <h2 id="portfolio-holdings-title">What you would be holding at the end</h2>
                <p>A snapshot of the open book on the last day — not a record of how the strategy performed</p>
              </div>
              <div className="table-heading-actions"><span className="data-badge">{result.holdings.length} open</span><button className="table-export-button" type="button" onClick={() => downloadJson('portfolio-final-holdings.json', holdingResults)}>Export table</button></div>
            </div>
            <div className="aggregate-rule">
              <span>
                <strong>These returns are not the strategy&apos;s returns.</strong> Each figure is only the move
                since that position was opened, so a name bought at the last rebalance shows near 0% because it
                has had no time to move. The {percent(result.summary.portfolioReturn)} headline comes from every
                position held across the whole period, including the ones already sold — most of which are not
                in this table.
              </span>
            </div>
            <div className="table-scroll"><table className="aggregate-table portfolio-table"><thead><tr>
              <th>{sortButton('holdings', 'ticker', 'Ticker')}</th><th>{sortButton('holdings', 'company', 'Company')}</th><th className="number">{sortButton('holdings', 'weight', 'Weight')}</th><th>{sortButton('holdings', 'opened', 'Opened')}</th>
              <th className="number" title="Calendar days this position has been open at the end of the test.">{sortButton('holdings', 'held', 'Held')}</th>
              <th className="number">{sortButton('holdings', 'entry', 'Entry price')}</th>
              <th className="number" title="Unrealised move since this position was opened. Not comparable across rows with different holding periods.">{sortButton('holdings', 'return', 'Since entry')}</th>
            </tr></thead><tbody>{holdingResults.map((holding) => {
              const days = daysHeldFor(holding.entryDate, curve[curve.length - 1]?.date);
              const tooNew = days !== null && days < 7;
              return (
                <tr key={holding.ticker}>
                  <td><strong>{holding.ticker}</strong></td>
                  <td>{holding.company}</td>
                  <td className="number">{(holding.weight * 100).toFixed(1)}%</td>
                  <td>{holding.entryDate}</td>
                  <td className="number">{days === null ? '—' : days === 0 ? 'today' : `${days}d`}</td>
                  <td className="number">{money(holding.entryPrice)}</td>
                  <td className={tooNew ? 'number muted' : holding.returnPercent >= 0 ? 'number positive' : 'number negative'}>
                    {tooNew ? 'too new' : percent(holding.returnPercent)}
                  </td>
                </tr>
              );
            })}</tbody></table></div>
          </section>
          {result.warnings.map((warning) => <div className="trust-warning" key={warning}>{warning}</div>)}
        </>
      )}
    </>
  );
}
