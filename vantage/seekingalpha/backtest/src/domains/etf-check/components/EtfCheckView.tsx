import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import type { EtfResearchPlacebo, EtfResearchRow, ImportSummary } from '../../../api';
import { fetchEtfBasketAnalysis, fetchEtfCheck, fetchResearchReport, uploadEtfFiles } from '../../../api';
import type { EtfCheckResult } from '../../../data';
import { filterLabel, pp, pValue } from '../../research/components/EtfResearchSection';
import { LoadingState } from '../../../shared/components/LoadingState';

// A rating-trust rule's tested signal is the moment of transition into the bullish family, so it
// only honestly applies to an ETF that transitioned very recently -- not one that has simply stayed
// bullish since some earlier, untested date. This is a display threshold, not a statistical one.
const RECENT_TRANSITION_DAYS = 5;

// research/pipeline.py's etf_persistence_events emits a persistence signal exactly once per episode
// -- the first calendar day its age crosses persistence_days -- and never again for the rest of that
// episode, however long it runs. Matching must mirror that: an ETF is only a fresh persistence match
// for a few days after crossing the threshold, not indefinitely. Without this bound, an ETF that has
// been bullish for 400 days would match a 30-day persistence rule every single day, which tests a
// population the Python pipeline never actually validated.
const PERSISTENCE_MATCH_WINDOW_DAYS = 5;

const MIN_BASKET_SIZE = 2;
const MAX_BASKET_SIZE = 25;

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

export type Rule = { row: EtfResearchRow; family: 'rating_trust' | 'persistence' };

export const ruleFilterStateKey = (filter: EtfResearchRow['filter']): 'strong-buy' | 'bullish-plus' =>
  (filter === 'strong_buy' ? 'strong-buy' : 'bullish-plus');

export const ruleKey = (rule: Rule) => `${rule.family}|${rule.row.filter}|${rule.row.persistence ?? ''}|${rule.row.hold}`;

const ruleDescription = (rule: Rule) =>
  rule.family === 'rating_trust'
    ? `Newly bullish vs SPY · ${filterLabel(rule.row.filter)} · ${rule.row.hold} hold`
    : `Stayed bullish ${rule.row.persistence}+ vs bullish pool · ${filterLabel(rule.row.filter)} · ${rule.row.hold} hold`;

export const simpleRuleDescription = (rule: Rule) =>
  rule.family === 'rating_trust'
    ? `Buy shortly after the ETF becomes ${filterLabel(rule.row.filter).replace(' only', '')}.`
    : `Buy after the ETF has stayed ${filterLabel(rule.row.filter).replace(' only', '')} for ${rule.row.persistence}.`;

export const ruleEdge = (rule: Rule) => rule.family === 'rating_trust' ? rule.row.meanExcessSpy : rule.row.meanExcessPool;
const ruleT = (rule: Rule) => rule.row.t ?? 0;

// Same cell-matching key the ETF Research page uses to line up a row with its placebo diagnostic
// (see EtfResearchSection.tsx's identically-shaped `sameCell`). Duplicated rather than imported
// because that one is a module-local const, not exported -- the match rule itself must stay
// identical between the two pages, or a rule could show as "confirmed" on one screen and not the
// other for no reason a reader could see.
const sameCell = (row: Pick<EtfResearchRow, 'filter' | 'persistence' | 'hold'>, other: Pick<EtfResearchRow, 'filter' | 'persistence' | 'hold'>) =>
  row.filter === other.filter && row.persistence === other.persistence && row.hold === other.hold;

export const placeboFor = (rule: Rule, placebos: EtfResearchPlacebo[]) => placebos.find((entry) => sameCell(rule.row, entry)) ?? null;

// discoveredRule (|t| >= 3, Holm p < 0.05) only says the result wasn't noise *within this dataset*.
// ETF_PRESPEC.md's own diagnostics require a cell to also beat a random-ETF placebo before it counts
// as evidence the *rating* did anything, versus every ETF in the same period just moving together
// (see ETF_PRESPEC.md section 7). A rule can clear the statistical bar with a very high t-stat and
// still fail this -- e.g. on the run this page was built against, the "Buy or Strong Buy, 180-day
// hold" rating-trust cell had t=9.26 (higher than the eventual default's 9.29 is barely above it) but
// random ETFs on the same dates matched or beat it 65% of the time. Labeling that "very strong
// evidence" without this check would be actively misleading for a tool whose whole purpose is
// suggesting ETFs to buy.
export const isPlaceboConfirmed = (rule: Rule, placebos: EtfResearchPlacebo[]) => {
  const placebo = placeboFor(rule, placebos);
  return placebo?.empirical_p !== null && placebo?.empirical_p !== undefined
    && placebo.empirical_p < 0.05
    && (placebo.observed_mean ?? Number.NEGATIVE_INFINITY) > (placebo.random_median ?? Number.POSITIVE_INFINITY);
};

const ruleEvidenceLabel = (rule: Rule, placebos: EtfResearchPlacebo[]) =>
  isPlaceboConfirmed(rule, placebos) ? 'Confirmed: beat random ETF selection too' : 'Not confirmed: random ETFs did about as well';

// Ranks by |t| descending, then Holm p ascending, within one family. Only ever called on rules that
// have already passed the positive-edge filter in strongestRule/allRules below, so |t| and t agree in
// sign here -- kept as abs() for a defensive tie-break, not to let a negative rule outrank a positive one.
const byStrength = (a: Rule, b: Rule) => Math.abs(b.row.t ?? 0) - Math.abs(a.row.t ?? 0) || (a.row.holmP ?? 1) - (b.row.holmP ?? 1);

// ETF_PRESPEC.md is explicit: "A negative clearing cell is evidence against [the hypothesis]; it must
// not be labeled a winner." discoveredRule only encodes statistical significance (|t| >= 3, Holm p <
// 0.05), not direction, so a strongly negative cell can clear the bar. This tool exists to suggest ETFs
// to buy, so a rule whose own tested edge was negative must never be selectable as a strategy, let
// alone the default -- ranking by abs(t) alone would have let it win on magnitude.
export const isBuySignal = (rule: Rule) => (rule.row.mean ?? 0) > 0;

// The frozen ETF research spec (ETF_PRESPEC.md) says rating-trust "owns the main verdict" and
// persistence is secondary and may not override it. So the default is the strongest rating-trust
// winner, and a persistence rule is only the default when no rating-trust rule cleared the bar --
// not just whichever of all confirmed rules happens to have the single largest |t|.
//
// Within a family, a placebo-confirmed rule always outranks an unconfirmed one, however high the
// unconfirmed one's t-stat is -- otherwise the "recommended" default could silently become a rule
// that random ETF selection matches just as often, purely because it happened to have a slightly
// higher t-stat on this particular data refresh. byStrength only breaks ties inside each of those
// two groups.
const strongestRule = (rules: Rule[], placebos: EtfResearchPlacebo[]): Rule | null => {
  const byConfirmation = (family: Rule[]) => {
    const confirmed = family.filter((rule) => isPlaceboConfirmed(rule, placebos)).sort(byStrength);
    const unconfirmed = family.filter((rule) => !isPlaceboConfirmed(rule, placebos)).sort(byStrength);
    return confirmed[0] ?? unconfirmed[0] ?? null;
  };
  const ratingTrust = rules.filter((rule) => rule.family === 'rating_trust');
  if (ratingTrust.length) return byConfirmation(ratingTrust);
  return byConfirmation(rules.filter((rule) => rule.family === 'persistence'));
};

export const matchesRule = (etf: EtfCheckResult, rule: Rule | null): boolean => {
  if (!rule) return false;
  const state = etf.states[ruleFilterStateKey(rule.row.filter)];
  if (!state?.qualifiesNow) return false;
  if (rule.family === 'rating_trust') {
    // A left-censored episode has no confirmed transition date -- it may have been bullish for a
    // year before the captured history even starts -- so it cannot honestly be called "recently
    // transitioned." Python's own transition signal requires an observed prior non-qualifying record
    // for the identical reason (see etf_rating_transition_events).
    if (state.censored) return false;
    return state.episodeAgeDays <= RECENT_TRANSITION_DAYS;
  }
  const persistDays = Number.parseInt(rule.row.persistence ?? '', 10);
  if (!Number.isFinite(persistDays)) {
    console.warn(`[etf-check] rule ${ruleKey(rule)} has an unparseable persistence value: "${rule.row.persistence}"`);
    return false;
  }
  // A censored episode's age is only a lower bound, which is the safe direction for a >= comparison:
  // it can make a real match report as "not old enough yet," never manufacture a match that isn't
  // there. Bounded above so an episode doesn't keep re-matching indefinitely after crossing the
  // threshold -- Python emits this signal exactly once, not on every subsequent day.
  return state.episodeAgeDays >= persistDays && state.episodeAgeDays <= persistDays + PERSISTENCE_MATCH_WINDOW_DAYS;
};

export const dollarsAfterRule = (value: number | null) => (value === null ? '—' : `$100 → $${(100 * (1 + value)).toFixed(2)}`);

// The one place a real portfolio's identity turns into a name -- used for both the CSV export
// filename and the live tracker's checkout name, so a portfolio named after one always matches the
// other. Persistence and hold get their own labelled segments (not just concatenated) because a
// 30-day persistence rule held for 30 days would otherwise read as "-30d-30d-", which looks like an
// accidental duplication rather than two different numbers that happen to coincide.
export const portfolioNameForRule = (rule: Rule, date: string) =>
  `seeking-alpha-${rule.row.filter}${rule.row.persistence ? `-persist${rule.row.persistence}` : ''}-hold${rule.row.hold}-${date}`;
const csvCell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;

const SECTOR_COLORS = ['#6d9cff', '#65d7aa', '#f0c45e', '#ff9297', '#b58cff', '#53c5d8', '#f19b62', '#9aa9c2'];
const sectorPieGradient = (exposure: Array<{ percentage: number }>) => {
  let cursor = 0;
  const segments = exposure.map((item, index) => {
    const start = cursor * 100;
    cursor += item.percentage;
    return `${SECTOR_COLORS[index % SECTOR_COLORS.length]} ${start.toFixed(2)}% ${(cursor * 100).toFixed(2)}%`;
  });
  return `conic-gradient(${segments.join(', ')})`;
};

export function EtfCheckView({ showAllOnLoad = false }: { showAllOnLoad?: boolean }) {
  const [ratingRows, setRatingRows] = useState<EtfResearchRow[]>([]);
  const [persistenceRows, setPersistenceRows] = useState<EtfResearchRow[]>([]);
  const [ratingPlacebos, setRatingPlacebos] = useState<EtfResearchPlacebo[]>([]);
  const [persistencePlacebos, setPersistencePlacebos] = useState<EtfResearchPlacebo[]>([]);
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
  // Not a target to hit -- a cap. The diversified basket already picks one ETF per distinct
  // price-movement cluster automatically, so defaulting this to the max means "use every distinct
  // cluster the system finds" out of the box; the user only needs to lower it to force fewer
  // positions (e.g. because they can't realistically afford MAX_BASKET_SIZE separate holdings).
  const [basketSize, setBasketSize] = useState(MAX_BASKET_SIZE);
  const [basketAnalysis, setBasketAnalysis] = useState<import('../../../data').EtfBasketAnalysis | null>(null);
  const [basketLoading, setBasketLoading] = useState(false);
  const [basketError, setBasketError] = useState<string | null>(null);
  const [exportingRuleKey, setExportingRuleKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const report = await fetchResearchReport();
        if (cancelled) return;
        setResearchAvailable(report.etf.available);
        setRatingRows(report.etf.ratingRows);
        setPersistenceRows(report.etf.persistenceRows);
        setRatingPlacebos(report.etf.ratingPlacebos);
        setPersistencePlacebos(report.etf.persistencePlacebos);
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
  ].filter(isBuySignal), [ratingRows, persistenceRows]);
  const placebos = useMemo(() => [...ratingPlacebos, ...persistencePlacebos], [ratingPlacebos, persistencePlacebos]);

  const defaultRule = useMemo(() => strongestRule(allRules, placebos), [allRules, placebos]);
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
  const exportSpreadForRule = async (rule: Rule) => {
    const key = ruleKey(rule);
    setExportingRuleKey(key);
    try {
      const ruleTickers = results.filter((etf) => matchesRule(etf, rule)).map((etf) => etf.ticker);
      const horizon = Number.parseInt(rule.row.hold, 10);
      if (!ruleTickers.length || !Number.isFinite(horizon) || horizon <= 0) return;
      const analysis = activeRule && ruleKey(activeRule) === key && basketAnalysis
        ? basketAnalysis
        : (await fetchEtfBasketAnalysis(ruleTickers, horizon, basketSize)).data;
      const today = new Date().toISOString().slice(0, 10);
      const rows = analysis.diversifiedBasket.tickers
        .map((ticker) => results.find((result) => result.ticker === ticker))
        .filter((result): result is EtfCheckResult => Boolean(result && result.currentPrice && result.currentPrice > 0));
      if (!rows.length) return;
      const csv = [
        ['Ticker symbol', 'Quantity of shares', 'Cost per share', 'Date purchased'],
        ...rows.map((result) => [result.ticker, '1', result.currentPrice!.toFixed(2), today]),
      ].map((row) => row.map(csvCell).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([`${csv}\r\n`], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${portfolioNameForRule(rule, today)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setExportingRuleKey(null);
    }
  };
  // null (not a guessed 30) when the rule's own hold value doesn't parse -- silently defaulting the
  // horizon here would apply an untested hold period to this rule's basket instead of surfacing the
  // data problem, exactly the "one rule controls everything downstream" invariant this page exists to
  // enforce.
  const lockedHorizon = useMemo(() => {
    if (!activeRule) return null;
    const parsed = Number.parseInt(activeRule.row.hold, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.warn(`[etf-check] rule ${ruleKey(activeRule)} has an unparseable hold value: "${activeRule.row.hold}"`);
      return null;
    }
    return parsed;
  }, [activeRule]);

  useEffect(() => {
    // lockedHorizon === null is rendered inline in JSX below (the strategy's own hold value didn't
    // parse), not via basketError -- nothing to fetch in that case.
    if (!matchingTickers.length || !activeRule || lockedHorizon === null) {
      setBasketAnalysis(null);
      setBasketError(null);
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
          <div className="field legacy-rule-selector">
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
          {defaultRule && (
            <div className="etf-recommended-rule">
              <div>
                <span className="eyebrow">Recommended strategy</span>
                <h3>{simpleRuleDescription(defaultRule)}</h3>
                <p>This is the default because, among everything that cleared the statistical bar, it's the strongest result that also beat a
                  random-ETF check — not the biggest historical percentage. It is a strategy recommendation, not a guarantee about any one ETF.</p>
              </div>
              <div className="etf-recommended-rule-stats">
                <span className={isPlaceboConfirmed(defaultRule, placebos) ? 'positive' : 'negative'}>{ruleEvidenceLabel(defaultRule, placebos)}</span>
                <strong>{pp(ruleEdge(defaultRule))} extra vs its benchmark</strong>
                <small>t-stat {ruleT(defaultRule).toFixed(2)} · Holm p {pValue(defaultRule.row.holmP)}</small>
                <small>{defaultRule.row.n} historical trades across {defaultRule.row.tickers} ETFs · hold {defaultRule.row.hold}</small>
              </div>
            </div>
          )}

          <section className="etf-plain-comparison">
            <div className="etf-plain-comparison-heading">
              <h3>Compare every result in plain terms</h3>
              <p>Sorted by historical edge, biggest first, so you can weigh a bigger reward against how sure we are it wasn't luck.
                <strong> Confirmed</strong> means random ETFs bought on the same dates did not do just as well.
                <strong> Not confirmed</strong> means they did — so that edge may just be "the whole ETF market moved," not this rating specifically.
                A bigger edge that is not confirmed is a real bet on more risk, not a better version of the recommended strategy.</p>
            </div>
            <div className="table-scroll">
              <table className="aggregate-table etf-plain-comparison-table">
                <thead>
                  <tr>
                    <th>Strategy, in plain words</th>
                    <th className="number">Historical edge</th>
                    <th>Confidence</th>
                    <th>Based on</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {[...allRules].sort((left, right) => (ruleEdge(right) ?? Number.NEGATIVE_INFINITY) - (ruleEdge(left) ?? Number.NEGATIVE_INFINITY)).map((rule) => {
                    const selected = activeRule !== null && ruleKey(activeRule) === ruleKey(rule);
                    const confirmed = isPlaceboConfirmed(rule, placebos);
                    return (
                      <tr key={ruleKey(rule)} className={selected ? 'selected' : undefined}>
                        <td>
                          <strong>{simpleRuleDescription(rule)}</strong>
                          <div className="muted">hold {rule.row.hold}{ruleKey(rule) === (defaultRule ? ruleKey(defaultRule) : '') ? ' · currently recommended' : ''}</div>
                        </td>
                        <td className="number">
                          <span className={(ruleEdge(rule) ?? 0) >= 0 ? 'positive' : 'negative'}>{pp(ruleEdge(rule))}</span>
                          <div className="muted">{dollarsAfterRule(rule.row.mean)}</div>
                        </td>
                        <td>
                          <span className={confirmed ? 'positive' : 'negative'}>{confirmed ? 'Confirmed' : 'Not confirmed'}</span>
                          <div className="muted">{confirmed ? 'beat random ETFs too' : 'random ETFs did about as well'}</div>
                        </td>
                        <td className="muted">{rule.row.n} trades / {rule.row.tickers} ETFs</td>
                        <td className="etf-strategy-actions">
                          <button className={selected ? 'secondary-button selected' : 'secondary-button'} type="button" onClick={() => setSelectedRuleKey(ruleKey(rule))}>
                            {selected ? 'Selected' : 'Use this'}
                          </button>
                          {confirmed && (
                            <button className="secondary-button" type="button" onClick={() => void exportSpreadForRule(rule)} disabled={exportingRuleKey !== null}>
                              {exportingRuleKey === ruleKey(rule) ? 'Preparing…' : 'Export CSV'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
          {activeRule && (
            <details className="etf-rule-technical">
              <summary>Show the technical evidence behind this recommendation</summary>
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
                <div><span>Random-ETF check</span><strong className={isPlaceboConfirmed(activeRule, placebos) ? 'positive' : 'negative'}>
                  {pValue(placeboFor(activeRule, placebos)?.empirical_p)}
                </strong></div>
                <div><span>Sample</span><strong>{activeRule.row.n} trades · {activeRule.row.tickers} ETFs</strong></div>
                <div><span>Hold</span><strong>{activeRule.row.hold}</strong></div>
              </div>
              <p className="muted">Evidence taken directly from the ETF Research page, not recomputed here. Random-ETF check is the empirical p-value
                against a random-ETF placebo — below 0.05 (and on the right side of the random distribution) means real ETFs beat picking randomly on the same dates.</p>
              </div>
            </details>
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
            <p className="muted etf-no-match-note">No ETFs currently match this strategy. Open “Compare another validated strategy” above, or check back after new ratings come in.</p>
          ) : lockedHorizon === null ? (
            <p className="data-status data-error">Could not determine a hold period for this strategy (raw value: &quot;{activeRule.row.hold}&quot;). Basket comparison is unavailable until this is fixed upstream, rather than guessing a horizon this rule was never tested at.</p>
          ) : (
            <div className="etf-basket-panel">
              <div className="etf-basket-heading">
                <div>
                  <strong>How should I spread a small amount of money?</strong>
                  <span>This compares owning every matching ETF with a smaller basket containing one representative from different price-movement clusters.</span>
                </div>
                <div className="etf-basket-controls">
                  <span className="etf-basket-locked-hold">Hold: {lockedHorizon} days <small>(locked to the selected strategy&apos;s tested hold period)</small></span>
                  <label>Limit to at most
                    <input type="number" min={MIN_BASKET_SIZE} max={basketAnalysis ? Math.min(MAX_BASKET_SIZE, basketAnalysis.clusters.length) : MAX_BASKET_SIZE}
                      value={basketSize}
                      onChange={(event) => setBasketSize(Math.max(MIN_BASKET_SIZE, Math.min(MAX_BASKET_SIZE, Number(event.target.value) || MIN_BASKET_SIZE)))} />
                  </label>
                </div>
              </div>
              {basketAnalysis && (
                <p className="muted etf-basket-size-note">
                  Automatically uses one ETF per distinct price-movement cluster — {basketAnalysis.clusters.length} found for this strategy&apos;s current candidates.
                  {basketAnalysis.diversifiedBasket.tickers.length < basketSize
                    ? ` The limit above (${basketSize}) is higher than that, so all ${basketAnalysis.diversifiedBasket.tickers.length} clusters are already used — raising it further will do nothing until more clusters appear.`
                    : ' Lower the limit only if you want fewer positions than that.'}
                </p>
              )}
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
                  {basketAnalysis.sectorExposure.length > 0 && (
                    <div className="etf-sector-exposure">
                      <div>
                        <strong>Approximate sector exposure of the suggested spread</strong>
                        <span>Each selected ETF has equal weight. Sector labels come from imported metadata; unknown labels are shown explicitly.</span>
                      </div>
                      <div className="etf-sector-chart">
                        <div className="etf-sector-pie" style={{ background: sectorPieGradient(basketAnalysis.sectorExposure) }} aria-label="Pie chart of suggested ETF sector exposure" />
                        <div className="etf-sector-legend">
                          {basketAnalysis.sectorExposure.map((exposure, index) => (
                            <div className="etf-sector-legend-item" key={exposure.sector}>
                              <i style={{ background: SECTOR_COLORS[index % SECTOR_COLORS.length] }} />
                              <span><strong>{exposure.sector}</strong> · {(exposure.percentage * 100).toFixed(0)}% <small>({exposure.tickers.join(', ')})</small></span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
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
                const filterState = etf.states[ruleFilterStateKey(activeRule.row.filter)];
                const streak = filterState?.episodeAgeDays ?? 0;
                const censored = filterState?.censored ?? false;
                return (
                  <tr key={etf.ticker}>
                    <td><strong>{etf.ticker}</strong><small className="table-subvalue">{etf.company || 'Unknown company'}</small></td>
                    <td>{etf.latestRating}<small className="table-subvalue">{etf.latestDate || 'unknown date'}</small></td>
                    <td className="number" title={censored ? 'Captured history begins mid-episode -- this is a lower bound on the true streak, not a confirmed age.' : undefined}>
                      {streak}d{censored ? '+' : ''}
                    </td>
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
