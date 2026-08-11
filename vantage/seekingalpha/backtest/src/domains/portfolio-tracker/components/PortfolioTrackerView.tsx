import { useEffect, useMemo, useState } from 'react';
import type { EtfResearchPlacebo, EtfResearchRow, TrackedPortfolio } from '../../../api';
import { createTrackedPortfolio, fetchEtfBasketAnalysis, fetchEtfCheck, fetchResearchReport, fetchTrackedPortfolios, saveTrackedPortfolioSnapshots } from '../../../api';
import type { EtfCheckResult } from '../../../data';
import {
  isBuySignal, isPlaceboConfirmed, matchesRule, portfolioNameForRule, ruleEdge, ruleKey, simpleRuleDescription,
  type Rule,
} from '../../etf-check/components/EtfCheckView';
import { pp } from '../../research/components/EtfResearchSection';
import { LoadingState } from '../../../shared/components/LoadingState';

const CHECKOUT_BASKET_SIZE = 25;

// A tracked portfolio only stores filter/persistence/hold, not a full EtfResearchRow, so this
// rebuilds just enough of a Rule for isPlaceboConfirmed's sameCell check to work against it.
const ruleForPortfolio = (portfolio: TrackedPortfolio): Rule => ({
  family: portfolio.family as Rule['family'],
  row: { filter: portfolio.filter, persistence: portfolio.persistence, hold: portfolio.hold } as EtfResearchRow,
});

const readField = (row: Element, field: string) =>
  row.querySelector(`[data-test-id="portfolio-ticker-price-${field}"] span`)?.textContent?.trim() ?? null;
const toNumber = (text: string | null) => {
  if (text === null) return null;
  const value = Number(text.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(value) ? value : null;
};

// Parses only by data-test-id, never by the hashed CSS classes Seeking Alpha's build emits -- those
// change on any frontend deploy, the test ids are the one thing worth treating as a stable contract.
const parsePastedPortfolios = (html: string): Array<{ name: string; totalValue: number; totalChangePercent: number | null }> => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const results: Array<{ name: string; totalValue: number; totalChangePercent: number | null }> = [];
  doc.querySelectorAll('[data-test-id="all-portfolio-name"]').forEach((nameEl) => {
    const name = nameEl.textContent?.trim();
    const titleId = nameEl.id;
    if (!name || !titleId) return;
    const panel = doc.querySelector(`section[aria-labelledby="${titleId}"]`);
    if (!panel) return;
    const totalRow = [...panel.querySelectorAll('tbody tr')].find((row) => row.querySelector('td')?.textContent?.trim() === 'TOTAL');
    if (!totalRow) return;
    const totalValue = toNumber(readField(totalRow, 'value'));
    if (totalValue === null) return;
    results.push({ name, totalValue, totalChangePercent: toNumber(readField(totalRow, 'totalChangePercent')) });
  });
  return results;
};

// Repeated pastes on the same calendar day (re-checking, fixing a typo, testing) shouldn't each get
// their own history row -- only the latest one for that day is worth showing. Snapshots arrive
// sorted ascending by capturedAt, so a later same-day entry simply overwrites the earlier one here.
const latestPerDay = (snapshots: TrackedPortfolio['snapshots']) => {
  const byDay = new Map<string, TrackedPortfolio['snapshots'][number]>();
  snapshots.forEach((snapshot) => byDay.set(snapshot.capturedAt.slice(0, 10), snapshot));
  return [...byDay.values()];
};

type Tab = 'build' | 'track' | 'history';

export function PortfolioTrackerView() {
  const [tab, setTab] = useState<Tab>('build');
  const [ratingRows, setRatingRows] = useState<EtfResearchRow[]>([]);
  const [persistenceRows, setPersistenceRows] = useState<EtfResearchRow[]>([]);
  const [ratingPlacebos, setRatingPlacebos] = useState<EtfResearchPlacebo[]>([]);
  const [persistencePlacebos, setPersistencePlacebos] = useState<EtfResearchPlacebo[]>([]);
  const [etfResults, setEtfResults] = useState<EtfCheckResult[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutMessage, setCheckoutMessage] = useState<string | null>(null);
  const [portfolios, setPortfolios] = useState<TrackedPortfolio[]>([]);
  const [pasteText, setPasteText] = useState('');
  const [snapshotMessage, setSnapshotMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [report, checkResponse, trackerResponse] = await Promise.all([
          fetchResearchReport(), fetchEtfCheck([]), fetchTrackedPortfolios(),
        ]);
        if (cancelled) return;
        setRatingRows(report.etf.ratingRows);
        setPersistenceRows(report.etf.persistenceRows);
        setRatingPlacebos(report.etf.ratingPlacebos);
        setPersistencePlacebos(report.etf.persistencePlacebos);
        setEtfResults(checkResponse.data);
        setPortfolios(trackerResponse.portfolios);
      } catch (fetchError) {
        if (!cancelled) setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const allRules = useMemo(() => [
    ...ratingRows.filter((row) => row.discoveredRule).map((row): Rule => ({ row, family: 'rating_trust' })),
    ...persistenceRows.filter((row) => row.discoveredRule).map((row): Rule => ({ row, family: 'persistence' })),
  ].filter(isBuySignal).sort((left, right) => (ruleEdge(right) ?? 0) - (ruleEdge(left) ?? 0)), [ratingRows, persistenceRows]);
  const placebos = useMemo(() => [...ratingPlacebos, ...persistencePlacebos], [ratingPlacebos, persistencePlacebos]);

  const overlaps = useMemo(() => {
    const tickerToRules = new Map<string, string[]>();
    allRules.filter((rule) => selected.has(ruleKey(rule))).forEach((rule) => {
      etfResults.filter((result) => matchesRule(result, rule)).forEach((result) => {
        const list = tickerToRules.get(result.ticker) ?? [];
        list.push(simpleRuleDescription(rule));
        tickerToRules.set(result.ticker, list);
      });
    });
    return [...tickerToRules.entries()].filter(([, rules]) => rules.length > 1);
  }, [allRules, selected, etfResults]);

  const toggleRule = (key: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const refreshPortfolios = async () => setPortfolios((await fetchTrackedPortfolios()).portfolios);

  const handleCheckout = async () => {
    setCheckoutBusy(true);
    setCheckoutMessage(null);
    const today = new Date().toISOString().slice(0, 10);
    const outcomes: string[] = [];
    for (const rule of allRules.filter((candidate) => selected.has(ruleKey(candidate)))) {
      const horizon = Number.parseInt(rule.row.hold, 10);
      const ruleTickers = etfResults.filter((result) => matchesRule(result, rule)).map((result) => result.ticker);
      if (!ruleTickers.length || !Number.isFinite(horizon) || horizon <= 0) {
        outcomes.push(`${simpleRuleDescription(rule)}: no ETFs currently qualify.`);
        continue;
      }
      try {
        const basket = (await fetchEtfBasketAnalysis(ruleTickers, horizon, CHECKOUT_BASKET_SIZE)).data;
        const lots = basket.diversifiedBasket.tickers
          .map((ticker) => etfResults.find((result) => result.ticker === ticker))
          .filter((result): result is EtfCheckResult => Boolean(result && result.currentPrice && result.currentPrice > 0))
          .map((result) => ({ ticker: result.ticker, quantity: 1, entryPrice: result.currentPrice! }));
        if (!lots.length) { outcomes.push(`${simpleRuleDescription(rule)}: no priced ETFs available.`); continue; }
        await createTrackedPortfolio({
          name: portfolioNameForRule(rule, today), family: rule.family, filter: rule.row.filter,
          persistence: rule.row.persistence, hold: rule.row.hold, entryDate: today, lots,
        });
        outcomes.push(`${simpleRuleDescription(rule)}: saved ${lots.length} ETFs.`);
      } catch (checkoutError) {
        outcomes.push(`${simpleRuleDescription(rule)}: ${checkoutError instanceof Error ? checkoutError.message : String(checkoutError)}`);
      }
    }
    setCheckoutMessage(outcomes.join(' '));
    setCheckoutBusy(false);
    await refreshPortfolios();
  };

  const handleSaveSnapshot = async () => {
    setSnapshotMessage(null);
    const parsed = parsePastedPortfolios(pasteText);
    if (!parsed.length) { setSnapshotMessage('No recognizable portfolio totals found in that paste.'); return; }
    const capturedAt = new Date().toISOString();
    const { outcomes } = await saveTrackedPortfolioSnapshots(parsed.map((entry) => ({ ...entry, capturedAt })));
    const matched = outcomes.filter((entry) => entry.matched).length;
    const unmatched = outcomes.filter((entry) => !entry.matched).map((entry) => entry.name);
    setSnapshotMessage(`Saved ${matched} snapshot${matched === 1 ? '' : 's'}.${unmatched.length ? ` No match for: ${unmatched.join(', ')}.` : ''}`);
    setPasteText('');
    await refreshPortfolios();
  };

  if (loading) return <LoadingState label="Loading portfolios" detail="Reading confirmed rules and tracked checkouts." />;

  return (
    <section className="portfolio-tracker">
      <div className="tabbar">
        <button className={tab === 'build' ? 'tabbtn active' : 'tabbtn'} type="button" onClick={() => setTab('build')}>Build portfolio</button>
        <button className={tab === 'track' ? 'tabbtn active' : 'tabbtn'} type="button" onClick={() => setTab('track')}>Track live portfolios</button>
        <button className={tab === 'history' ? 'tabbtn active' : 'tabbtn'} type="button" onClick={() => setTab('history')}>History</button>
      </div>

      {error && <div className="data-status data-error">{error}</div>}

      {tab === 'build' && (
        <div className="table-panel">
          <p className="muted">Select strategies to check out as real, frozen portfolios. Sorted by historical edge.</p>
          <div className="portfolio-rule-list">
            {allRules.map((rule) => {
              const confirmed = isPlaceboConfirmed(rule, placebos);
              const key = ruleKey(rule);
              return (
                <label className="portfolio-rule-row" key={key}>
                  <input type="checkbox" checked={selected.has(key)} onChange={() => toggleRule(key)} />
                  <span className="portfolio-rule-desc">
                    <strong>{simpleRuleDescription(rule)}</strong>
                    <small className="muted">hold {rule.row.hold}</small>
                  </span>
                  <span className={confirmed ? 'positive' : 'negative'}>{confirmed ? 'confirmed' : 'not confirmed'}</span>
                  <span className={(ruleEdge(rule) ?? 0) >= 0 ? 'positive' : 'negative'}>{pp(ruleEdge(rule))}</span>
                </label>
              );
            })}
          </div>
          {overlaps.length > 0 && (
            <div className="trust-warning">
              {overlaps.map(([ticker, rules]) => (
                <p key={ticker}><code>{ticker.toUpperCase()}</code> appears in {rules.length} selected strategies. Keeping both allocations doubles your exposure, it doesn&apos;t add diversification.</p>
              ))}
            </div>
          )}
          <button className="primary-button" type="button" disabled={!selected.size || checkoutBusy} onClick={() => void handleCheckout()}>
            {checkoutBusy ? 'Saving…' : `Add ${selected.size || ''} to tracked portfolios`}
          </button>
          {checkoutMessage && <p className="muted">{checkoutMessage}</p>}
        </div>
      )}

      {tab === 'track' && (
        <div className="table-panel">
          {portfolios.length === 0 && <p className="muted">No tracked portfolios yet. Check one out from the Build portfolio tab.</p>}
          <div className="portfolio-card-grid">
            {portfolios.map((portfolio) => {
              const confirmed = isPlaceboConfirmed(ruleForPortfolio(portfolio), placebos);
              const change = portfolio.latestSnapshot?.totalChangePercent ?? null;
              const spy = portfolio.spyReturnSinceEntry;
              const added = change !== null && spy !== null ? change - spy : null;
              return (
                <div className="portfolio-card" key={portfolio.id}>
                  <p className="muted">{portfolio.name} <span className={confirmed ? 'positive' : 'negative'}>· {confirmed ? 'confirmed' : 'not confirmed'}</span></p>
                  <strong className="portfolio-card-value">{portfolio.latestSnapshot ? `$${portfolio.latestSnapshot.totalValue.toFixed(2)}` : `$${portfolio.costBasis.toFixed(2)} cost`}</strong>
                  <p className={change !== null && change >= 0 ? 'positive' : 'negative'}>
                    {change === null ? 'no snapshot yet' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}% since ${portfolio.entryDate}`}
                    {spy !== null && <span className="muted"> · spy {spy >= 0 ? '+' : ''}{spy.toFixed(2)}%</span>}
                  </p>
                  {added !== null && <p className="muted">Added vs spy: {added >= 0 ? '+' : ''}{added.toFixed(2)}pp</p>}
                </div>
              );
            })}
          </div>
          <p className="muted" style={{ marginTop: '1rem' }}>Paste the full Seeking Alpha portfolio page HTML to save a snapshot. Every matching tracked portfolio found in the paste gets one.</p>
          <textarea value={pasteText} onChange={(event) => setPasteText(event.target.value)} placeholder="Paste the portfolio page HTML here" style={{ width: '100%', minHeight: 100, fontFamily: 'monospace', fontSize: 12 }} />
          <div style={{ marginTop: 8 }}>
            <button className="secondary-button" type="button" disabled={!pasteText.trim()} onClick={() => void handleSaveSnapshot()}>Save snapshot</button>
          </div>
          {snapshotMessage && <p className="muted">{snapshotMessage}</p>}
        </div>
      )}

      {tab === 'history' && (
        <div className="table-panel">
          {portfolios.length === 0 && <p className="muted">No tracked portfolios yet. Check one out from the Build portfolio tab.</p>}
          {portfolios.map((portfolio) => (
            <div className="portfolio-history-block" key={portfolio.id}>
              <p className="muted">{portfolio.name}</p>
              <div className="table-scroll">
                <table className="aggregate-table">
                  <thead><tr><th>Date</th><th className="number">Value</th><th className="number">Change since entry</th></tr></thead>
                  <tbody>
                    <tr><td>{portfolio.entryDate}</td><td className="number">${portfolio.costBasis.toFixed(2)}</td><td className="number muted">entry</td></tr>
                    {latestPerDay(portfolio.snapshots).map((snapshot) => (
                      <tr key={snapshot.capturedAt}>
                        <td>{snapshot.capturedAt.slice(0, 10)}</td>
                        <td className="number">${snapshot.totalValue.toFixed(2)}</td>
                        <td className={`number ${(snapshot.totalChangePercent ?? 0) >= 0 ? 'positive' : 'negative'}`}>
                          {snapshot.totalChangePercent === null ? '—' : `${snapshot.totalChangePercent >= 0 ? '+' : ''}${snapshot.totalChangePercent.toFixed(2)}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
