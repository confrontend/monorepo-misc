import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import type { EtfResearchRow, ImportSummary } from '../../../api';
import { fetchEtfBasketAnalysis, fetchEtfCheck, fetchResearchReport, uploadEtfFiles } from '../../../api';
import type { EtfCheckResult } from '../../../data';
import { filterLabel, pp, pValue } from '../../research/components/EtfResearchSection';
import { LoadingState } from '../../../shared/components/LoadingState';

// A rating-trust rule's tested signal is the moment of transition into the bullish family, so it
// only honestly applies to an ETF that transitioned very recently -- not one that has simply stayed
// bullish since some earlier, untested date. This is a display threshold, not a statistical one.
const RECENT_TRANSITION_DAYS = 5;

const readFileAsText = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result ?? ''));
  reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
  reader.readAsText(file);
});

// Best-effort only, for pre-filling the ticker filter after an upload -- not a substitute for the
// server's own classification (server/db/ingest.ts detectKind/parseFile), which is authoritative.
const guessTickers = (content: string): string[] => {
  const found = new Set<string>();
  try {
    const payload = JSON.parse(content);
    const scanIncluded = (included: unknown) => {
      if (!Array.isArray(included)) return;
      included.forEach((entry) => {
        if (entry?.type === 'ticker' && typeof entry?.attributes?.slug === 'string') found.add(entry.attributes.slug);
      });
    };
    if (typeof payload?.source?.ticker === 'string') found.add(payload.source.ticker);
    scanIncluded(payload?.included);
    if (Array.isArray(payload)) {
      payload.forEach((wrapper) => {
        if (typeof wrapper?._slug === 'string') found.add(wrapper._slug);
        scanIncluded(wrapper?.body?.included);
      });
    }
  } catch {
    // Unparseable content is reported by the server upload response; nothing to guess here.
  }
  return [...found];
};

type Rule = { row: EtfResearchRow; family: 'rating_trust' | 'persistence' };

const ruleFilterStateKey = (filter: EtfResearchRow['filter']): 'strong-buy' | 'bullish-plus' =>
  (filter === 'strong_buy' ? 'strong-buy' : 'bullish-plus');

const ruleKey = (rule: Rule) => `${rule.family}|${rule.row.filter}|${rule.row.persistence ?? ''}|${rule.row.hold}`;

const ruleDescription = (rule: Rule) =>
  rule.family === 'rating_trust'
    ? `Newly bullish vs SPY · ${filterLabel(rule.row.filter)} · ${rule.row.hold} hold`
    : `Stayed bullish ${rule.row.persistence}+ vs bullish pool · ${filterLabel(rule.row.filter)} · ${rule.row.hold} hold`;

// Ranks by |t| descending, then Holm p ascending, within one family.
const byStrength = (a: Rule, b: Rule) => Math.abs(b.row.t ?? 0) - Math.abs(a.row.t ?? 0) || (a.row.holmP ?? 1) - (b.row.holmP ?? 1);

// The frozen ETF research spec (ETF_PRESPEC.md) says rating-trust "owns the main verdict" and
// persistence is secondary and may not override it. So the default is the strongest rating-trust
// winner, and a persistence rule is only the default when no rating-trust rule cleared the bar --
// not just whichever of all confirmed rules happens to have the single largest |t|.
const strongestRule = (rules: Rule[]): Rule | null => {
  const ratingTrust = rules.filter((rule) => rule.family === 'rating_trust').sort(byStrength);
  if (ratingTrust.length) return ratingTrust[0];
  const persistence = rules.filter((rule) => rule.family === 'persistence').sort(byStrength);
  return persistence[0] ?? null;
};

const matchesRule = (etf: EtfCheckResult, rule: Rule | null): boolean => {
  if (!rule) return false;
  const state = etf.states[ruleFilterStateKey(rule.row.filter)];
  if (!state?.qualifiesNow) return false;
  if (rule.family === 'rating_trust') return state.episodeAgeDays <= RECENT_TRANSITION_DAYS;
  const persistDays = Number.parseInt(rule.row.persistence ?? '', 10);
  return Number.isFinite(persistDays) && state.episodeAgeDays >= persistDays;
};

const dollarsAfterRule = (value: number | null) => (value === null ? '—' : `$100 → $${(100 * (1 + value)).toFixed(2)}`);

export function EtfCheckView({ showAllOnLoad = false }: { showAllOnLoad?: boolean }) {
  const [ratingRows, setRatingRows] = useState<EtfResearchRow[]>([]);
  const [persistenceRows, setPersistenceRows] = useState<EtfResearchRow[]>([]);
  const [researchAvailable, setResearchAvailable] = useState(true);
  const [results, setResults] = useState<EtfCheckResult[]>([]);
  const [tickerInput, setTickerInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadSummary, setUploadSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNonMatching, setShowNonMatching] = useState(false);
  const [selectedRuleKey, setSelectedRuleKey] = useState<string | null>(null);
  const [basketSize, setBasketSize] = useState(10);
  const [basketAnalysis, setBasketAnalysis] = useState<import('../../../data').EtfBasketAnalysis | null>(null);
  const [basketLoading, setBasketLoading] = useState(false);
  const [basketError, setBasketError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const report = await fetchResearchReport();
        if (cancelled) return;
        setResearchAvailable(report.etf.available);
        setRatingRows(report.etf.ratingRows);
        setPersistenceRows(report.etf.persistenceRows);
        if (showAllOnLoad) {
          const response = await fetchEtfCheck([]);
          if (!cancelled) setResults(response.data);
        }
      } catch (fetchError) {
        if (!cancelled) setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [showAllOnLoad]);

  const runCheck = async (tickers: string[]) => {
    setChecking(true);
    setError(null);
    try {
      const response = await fetchEtfCheck(tickers);
      setResults(response.data);
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : String(checkError));
    } finally {
      setChecking(false);
    }
  };

  const handleTickerCheck = () => {
    const tickers = tickerInput.split(',').map((value) => value.trim()).filter(Boolean);
    void runCheck(tickers);
  };

  const handleFilesSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files;
    if (!fileList || !fileList.length) return;
    setUploading(true);
    setError(null);
    setUploadSummary(null);
    try {
      const files = await Promise.all([...fileList].map(async (file) => ({ name: file.name, content: await readFileAsText(file) })));
      const guessed = [...new Set(files.flatMap((file) => guessTickers(file.content)))];
      const response = await uploadEtfFiles(files);
      setUploadSummary(response.summary);
      if (guessed.length) {
        setTickerInput(guessed.join(', '));
        await runCheck(guessed);
      } else {
        // fetchEtfCheck([]) means "every ETF in the database" -- calling it here would silently
        // replace whatever the user was looking at with the entire universe. Ask them to type the
        // ticker instead of guessing wrong.
        setError('Imported the file, but could not automatically identify its ticker symbol. Type it in the box below to check it.');
      }
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  };

  const allRules = useMemo(() => [
    ...ratingRows.filter((row) => row.discoveredRule).map((row): Rule => ({ row, family: 'rating_trust' })),
    ...persistenceRows.filter((row) => row.discoveredRule).map((row): Rule => ({ row, family: 'persistence' })),
  ], [ratingRows, persistenceRows]);

  const defaultRule = useMemo(() => strongestRule(allRules), [allRules]);
  const activeRule = useMemo(
    () => (selectedRuleKey ? allRules.find((rule) => ruleKey(rule) === selectedRuleKey) ?? null : null) ?? defaultRule,
    [allRules, selectedRuleKey, defaultRule],
  );
  const isDefaultRuleActive = activeRule !== null && defaultRule !== null && ruleKey(activeRule) === ruleKey(defaultRule);

  const sortedResults = useMemo(() => [...results].sort((left, right) => {
    const leftMatches = matchesRule(left, activeRule) ? 1 : 0;
    const rightMatches = matchesRule(right, activeRule) ? 1 : 0;
    return rightMatches - leftMatches || left.ticker.localeCompare(right.ticker);
  }), [results, activeRule]);
  const visibleResults = useMemo(
    () => (showNonMatching ? sortedResults : sortedResults.filter((etf) => matchesRule(etf, activeRule))),
    [showNonMatching, sortedResults, activeRule],
  );
  const matchingTickers = useMemo(
    () => sortedResults.filter((etf) => matchesRule(etf, activeRule)).map((etf) => etf.ticker),
    [sortedResults, activeRule],
  );
  const lockedHorizon = activeRule ? Number.parseInt(activeRule.row.hold, 10) || 30 : 30;

  useEffect(() => {
    if (!matchingTickers.length || !activeRule) {
      setBasketAnalysis(null);
      return;
    }
    let cancelled = false;
    setBasketLoading(true);
    setBasketError(null);
    void fetchEtfBasketAnalysis(matchingTickers, lockedHorizon, basketSize)
      .then((response) => { if (!cancelled) setBasketAnalysis(response.data); })
      .catch((basketFetchError) => { if (!cancelled) setBasketError(basketFetchError instanceof Error ? basketFetchError.message : String(basketFetchError)); })
      .finally(() => { if (!cancelled) setBasketLoading(false); });
    return () => { cancelled = true; };
  }, [matchingTickers, lockedHorizon, basketSize, activeRule]);

  if (loading) return <LoadingState label="Loading confirmed rules" detail="Reading the ETF Research report." />;

  if (!researchAvailable) {
    return (
      <section className="empty-trends">
        <div className="eyebrow">Check an ETF</div>
        <h2>ETF Research hasn&apos;t been run yet</h2>
        <p>This tool matches an ETF's current rating against the confirmed rules on the ETF Research page. Run that analysis first.</p>
      </section>
    );
  }

  return (
    <section className="etf-check">
      <div className="section-divider">
        <div className="eyebrow">Current ETF candidates · one strategy at a time</div>
        <h2>Using a single validated strategy, which ETFs currently qualify?</h2>
        <p>Upload 3 years of ETF data, or type ticker symbols already in your database, then pick which validated strategy to apply.
          Every candidate, hold period, and basket below is scoped to that one strategy — nothing is blended across rules.</p>
      </div>

      <div className="table-panel etf-check-controls">
        <div className="field">
          <label htmlFor="etf-check-upload">Upload ETF JSON files</label>
          <input id="etf-check-upload" type="file" accept=".json" multiple onChange={(event) => void handleFilesSelected(event)} disabled={uploading} />
          <p className="muted">Uploading here adds the ETF permanently to your shared dataset, the same as the Data page&apos;s Import button — it becomes
            part of every other page&apos;s ETF universe too, not just this check.</p>
        </div>
        {uploading && <LoadingState label="Uploading and importing" detail="Parsing and writing to the database." />}
        {uploadSummary && !uploading && (
          <p className="research-current-note">Imported {uploadSummary.filesImported} file{uploadSummary.filesImported === 1 ? '' : 's'}
            {uploadSummary.filesFailed > 0 ? `, ${uploadSummary.filesFailed} failed` : ''}
            {uploadSummary.filesUnchanged > 0 ? `, ${uploadSummary.filesUnchanged} unchanged` : ''}.</p>
        )}
        <div className="field">
          <label htmlFor="etf-check-tickers">Or check ticker symbols already imported</label>
          <div className="etf-check-ticker-row">
            <input id="etf-check-tickers" type="text" placeholder="e.g. SPY, QQQ, XLK" value={tickerInput}
              onChange={(event) => setTickerInput(event.target.value)} />
            <button className="secondary-button" type="button" onClick={handleTickerCheck} disabled={checking}>
              {checking ? 'Checking…' : 'Check'}
            </button>
            <button className="secondary-button" type="button" onClick={() => void runCheck([])} disabled={checking}>
              Show every ETF
            </button>
          </div>
        </div>
      </div>

      {error && <div className="data-status data-error">{error}</div>}

      {allRules.length === 0 ? (
        <section className="empty-trends">
          <div className="eyebrow">No confirmed strategy available</div>
          <h2>No rule has cleared the statistical bar yet</h2>
          <p>Candidates and a basket can only be built once at least one rule on the ETF Research page is statistically confirmed
            (clustered bootstrap, placebo-tested, Holm-corrected). Run that analysis, or check back after more data is imported.</p>
        </section>
      ) : (
        <section className="table-panel etf-rule-panel">
          <div className="field">
            <label htmlFor="etf-rule-select">Strategy</label>
            <select id="etf-rule-select" value={activeRule ? ruleKey(activeRule) : ''} onChange={(event) => setSelectedRuleKey(event.target.value)}>
              <optgroup label="Just turned bullish · vs SPY">
                {allRules.filter((rule) => rule.family === 'rating_trust').sort(byStrength).map((rule) => (
                  <option key={ruleKey(rule)} value={ruleKey(rule)}>
                    {ruleDescription(rule)} — t={rule.row.t?.toFixed(2) ?? '—'}, edge {pp(rule.row.mean)}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Stayed bullish · vs bullish pool">
                {allRules.filter((rule) => rule.family === 'persistence').sort(byStrength).map((rule) => (
                  <option key={ruleKey(rule)} value={ruleKey(rule)}>
                    {ruleDescription(rule)} — t={rule.row.t?.toFixed(2) ?? '—'}, edge {pp(rule.row.mean)}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>
          {activeRule && (
            <div className="etf-rule-evidence">
              <div className="etf-rule-evidence-heading">
                {isDefaultRuleActive
                  ? <span className="data-badge">Strongest validated rule in this research run</span>
                  : <span className="data-badge muted">Not the strongest rule — switched manually</span>}
                <span className="muted">{ruleDescription(activeRule)}</span>
              </div>
              <div className="conclusion-stats">
                <div><span>Edge</span><strong className={(activeRule.row.mean ?? 0) >= 0 ? 'positive' : 'negative'}>{pp(activeRule.row.mean)}</strong></div>
                <div><span>t-stat</span><strong>{activeRule.row.t?.toFixed(2) ?? '—'}</strong></div>
                <div><span>Holm p</span><strong>{pValue(activeRule.row.holmP)}</strong></div>
                <div><span>Sample</span><strong>{activeRule.row.n} trades · {activeRule.row.tickers} ETFs</strong></div>
                <div><span>Hold</span><strong>{activeRule.row.hold}</strong></div>
              </div>
              <p className="muted">Evidence taken directly from the ETF Research page, not recomputed here.</p>
            </div>
          )}
        </section>
      )}

      {activeRule && sortedResults.length > 0 && (
        <section className="table-panel etf-candidates-table-panel">
          <div className="table-heading">
            <div>
              <h2>ETFs currently matching this strategy</h2>
              <p>Using {ruleDescription(activeRule)}.</p>
            </div>
            <div className="etf-candidates-heading-actions">
              <label className="etf-candidates-toggle"><input type="checkbox" checked={showNonMatching} onChange={(event) => setShowNonMatching(event.target.checked)} /> Show ETFs that do not fit</label>
              <span className="data-badge">{visibleResults.length} of {sortedResults.length} ETFs</span>
            </div>
          </div>

          {matchingTickers.length === 0 ? (
            <p className="muted etf-no-match-note">No ETFs currently match this strategy. Pick a different rule from the dropdown above, or check back after new ratings come in.</p>
          ) : (
            <div className="etf-basket-panel">
              <div className="etf-basket-heading">
                <div>
                  <strong>How should I spread a small amount of money?</strong>
                  <span>This compares owning every matching ETF with a smaller basket containing one representative from different price-movement clusters.</span>
                </div>
                <div className="etf-basket-controls">
                  <span className="etf-basket-locked-hold">Hold: {lockedHorizon} days <small>(locked to the selected strategy&apos;s tested hold period)</small></span>
                  <label>Basket size
                    <input type="number" min={2} max={25} value={basketSize} onChange={(event) => setBasketSize(Math.max(2, Math.min(25, Number(event.target.value) || 2)))} />
                  </label>
                </div>
              </div>
              {basketLoading && <LoadingState label="Building basket comparison" detail="Aligning historical prices and checking ETF correlations." />}
              {basketError && <p className="data-status data-error">Could not build basket comparison: {basketError}</p>}
              {basketAnalysis && !basketLoading && (
                <>
                  <div className="etf-basket-results">
                    <div className="etf-basket-result-card">
                      <span>All {basketAnalysis.allBasket.tickers.length} matching ETFs</span>
                      <strong className={(basketAnalysis.allBasket.meanReturn ?? 0) >= 0 ? 'positive' : 'negative'}>{basketAnalysis.allBasket.meanReturn === null ? '—' : `${basketAnalysis.allBasket.meanReturn >= 0 ? '+' : ''}${basketAnalysis.allBasket.meanReturn.toFixed(2)}%`}</strong>
                      <small>Historical average over {basketAnalysis.allBasket.observations} windows</small>
                    </div>
                    <div className="etf-basket-result-card">
                      <span>Diversified {basketAnalysis.diversifiedBasket.tickers.length}-ETF basket</span>
                      <strong className={(basketAnalysis.diversifiedBasket.meanReturn ?? 0) >= 0 ? 'positive' : 'negative'}>{basketAnalysis.diversifiedBasket.meanReturn === null ? '—' : `${basketAnalysis.diversifiedBasket.meanReturn >= 0 ? '+' : ''}${basketAnalysis.diversifiedBasket.meanReturn.toFixed(2)}%`}</strong>
                      <small>{basketAnalysis.diversifiedBasket.positiveRate === null ? 'No complete windows' : `${(basketAnalysis.diversifiedBasket.positiveRate * 100).toFixed(0)}% positive windows`} · {basketAnalysis.clusters.length} clusters found</small>
                    </div>
                    <div className="etf-basket-result-card">
                      <span>What $100 became</span>
                      <strong>{basketAnalysis.diversifiedBasket.meanReturn === null ? '—' : `$${(100 * (1 + basketAnalysis.diversifiedBasket.meanReturn / 100)).toFixed(2)}`}</strong>
                      <small>Equal weight; historical average, not a forecast</small>
                    </div>
                  </div>
                  <div className="etf-basket-detail">
                    <div><strong>Suggested spread:</strong> {basketAnalysis.diversifiedBasket.tickers.join(', ') || 'No basket available'}</div>
                    <div><strong>Near-duplicate warning:</strong> {basketAnalysis.warnings.length ? `${basketAnalysis.warnings[0].left} and ${basketAnalysis.warnings[0].right} move ${(basketAnalysis.warnings[0].correlation * 100).toFixed(0)}% together. Avoid choosing several ETFs from the same cluster.` : `No pair above the ${(basketAnalysis.warningsThreshold * 100).toFixed(0)}% correlation warning threshold was found.`}</div>
                  </div>
                  <details className="etf-basket-clusters">
                    <summary>View the {basketAnalysis.clusters.length} movement clusters and strongest duplicate warnings</summary>
                    <div className="etf-cluster-layout">
                      <div className="table-scroll etf-cluster-scroll">
                        <table className="aggregate-table etf-cluster-table">
                          <thead><tr><th>Cluster</th><th>Representative</th><th>ETFs in group</th><th>Members</th></tr></thead>
                          <tbody>{basketAnalysis.clusters.map((cluster) => (
                            <tr key={cluster.id}><td>{cluster.id}</td><td><strong>{cluster.representative}</strong></td><td>{cluster.size}</td><td>{cluster.members.join(', ')}</td></tr>
                          ))}</tbody>
                        </table>
                      </div>
                      {basketAnalysis.warnings.length > 0 && (
                        <div className="etf-correlation-warnings">
                          <strong>Pairs moving at least {(basketAnalysis.warningsThreshold * 100).toFixed(0)}% together</strong>
                          {basketAnalysis.warnings.slice(0, 8).map((warning) => (
                            <span key={`${warning.left}-${warning.right}`}>{warning.left} + {warning.right}: {(warning.correlation * 100).toFixed(1)}%</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </details>
                </>
              )}
            </div>
          )}

          <div className="table-scroll">
            <table className="aggregate-table etf-candidates-table">
              <thead><tr>
                <th title="The ETF symbol and company name.">ETF</th>
                <th title="The latest imported rating and date.">Latest rating</th>
                <th className="number" title="How many continuous days the ETF has stayed in the current rating family.">Streak</th>
                <th className="number" title="The historical median result of following this strategy with $100.">$100 result</th>
                <th title="Whether the ETF currently fits the selected strategy.">Status</th>
              </tr></thead>
              <tbody>{visibleResults.map((etf) => {
                const matches = matchesRule(etf, activeRule);
                const streak = etf.states[ruleFilterStateKey(activeRule.row.filter)]?.episodeAgeDays ?? 0;
                return (
                  <tr key={etf.ticker}>
                    <td><strong>{etf.ticker}</strong><small className="table-subvalue">{etf.company || 'Unknown company'}</small></td>
                    <td>{etf.latestRating}<small className="table-subvalue">{etf.latestDate || 'unknown date'}</small></td>
                    <td className="number">{streak}d</td>
                    <td className={`number ${(activeRule.row.medianReturn ?? 0) >= 0 ? 'positive' : 'negative'}`}>
                      {matches ? dollarsAfterRule(activeRule.row.medianReturn) : '—'}
                      {matches && <small className="table-subvalue">historical median</small>}
                    </td>
                    <td>{matches
                      ? <span className="verdict verdict-good">Matches strategy</span>
                      : <span className="verdict verdict-not-enough-data">Does not fit</span>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        </section>
      )}
      {!checking && sortedResults.length === 0 && !error && (
        <p className="muted">Upload a file or check a ticker symbol to see a verdict.</p>
      )}

      <div className="aggregate-rule">
        <span><strong>Just turned bullish:</strong> the ETF entered Buy/Strong Buy within the last {RECENT_TRANSITION_DAYS} days — matches a rating-trust rule tested at the moment of transition.</span>
        <span><strong>Stayed bullish:</strong> the ETF has held Buy/Strong Buy for at least as long as a persistence rule's required window.</span>
        <span><strong>These verdicts only use rules that already cleared the statistical bar</strong> on the ETF Research page (clustered bootstrap, placebo-tested, Holm-corrected) — see that page for the full grid and diagnostics.</span>
      </div>
    </section>
  );
}
