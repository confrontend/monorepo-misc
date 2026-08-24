import { useEffect, useState } from 'react';
import { DataTable } from './DataTable.js';
import { Modal } from './Modal.js';
import { GmgnTag } from './GmgnTag.js';

type LabWallet = {
  walletAddress: string; name: string | null; rank: number | null; tags?: string[];
  evidence: { level: 'complete' | 'partial' | 'insufficient' | 'missing'; detail: string };
  scores: { edge: number | null; consistency: number | null; robustness: number | null; copyability: number | null; overall: number | null };
  scoreDetails?: Record<'edge' | 'consistency' | 'robustness' | 'copyability' | 'overall', { label: string; detail: string }>;
  facts: { gmgnMedianPercent: number | null; copyMedianPercent: number | null; copyCapitalUsd: number | null; duneCoveragePercent: number | null; matchedRoundTrips: number; roundTripsConsidered: number; medianHoldSeconds: number | null; under15SecondsPercent: number | null };
  scrutiny: { pass: number; fail: number; insufficient: number; checks: Array<{ label: string; verdict: string; detail: string }> } | null;
  riskDetails?: { available: boolean; metrics: Record<string, unknown> | null };
  liquidity: { low: number | null; medium: number | null; high: number | null } | null;
  risks: string[];
};
type LabResponse = { generatedAt: string; periodDays: number; readOnly: true; noProviderFetch: true; source: string; methodology: string[]; wallets: LabWallet[] };

const pct = (value: number | null) => value === null ? '—' : `${value.toFixed(1)}%`;
const usd = (value: number | null) => value === null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: value < 10 ? 2 : 0 }).format(value);
const score = (value: number | null) => value === null ? '—' : `${Math.round(value)}`;
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const gmgnUrl = (address: string) => `https://gmgn.ai/sol/address/${encodeURIComponent(address)}`;
const ScoreCell = ({ value }: { value: number | null }) => <strong className={value === null ? 'muted' : value >= 70 ? 'change-positive' : value < 40 ? 'change-negative' : ''}>{score(value)}</strong>;
const legacyScoreDetail = (wallet: LabWallet, key: 'edge' | 'consistency' | 'robustness' | 'copyability' | 'overall') => {
  if (key === 'edge') return { label: 'Delayed-copy edge', detail: `Based on the saved delayed-copy median return (${pct(wallet.facts.copyMedianPercent)}).` };
  if (key === 'copyability') return { label: 'Copyability', detail: `Combines saved Dune coverage (${pct(wallet.facts.duneCoveragePercent)}) and median hold time (${wallet.facts.medianHoldSeconds === null ? '—' : `${(wallet.facts.medianHoldSeconds / 3600).toFixed(1)}h`}) against the 15-second delay reference.` };
  if (key === 'consistency') return { label: 'Consistency', detail: 'Calculated from the saved weekly and monthly GMGN performance periods.' };
  if (key === 'robustness') return { label: 'Robustness', detail: 'Calculated from saved profit concentration and the return after removing the best token.' };
  return { label: 'Overall', detail: 'Weighted from edge 35%, consistency 25%, robustness 20%, and copyability 20%; missing inputs prevent a complete overall score.' };
};
const exportDecisionLab = (response: LabResponse) => {
  const payload = { format: 'vantage-crypto-decision-lab-v1', exportedAt: new Date().toISOString(), ...response };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `decision-lab-30d-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
};

export function ExperimentalDecisionLab({ api }: { api: <T>(path: string) => Promise<T> }) {
  const [response, setResponse] = useState<LabResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedWallet, setSelectedWallet] = useState<LabWallet | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const load = () => {
    setLoading(true); setError(null);
    void api<LabResponse>('/api/copytrade/experimental-decision?periodDays=30&limit=100')
      .then(setResponse).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [api]);
  const importRiskBundle = async (file: File) => {
    setImporting(true); setImportMessage(null);
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
      const captures = root && Array.isArray(root.captures) ? root.captures : Array.isArray(parsed) ? parsed : [];
      let ignoredNon30d = 0;
      let ignoredUnavailable = 0;
      const results = captures.flatMap((value) => {
        if (!value || typeof value !== 'object') return [];
        const capture = value as { walletAddress?: unknown; period?: unknown; status?: unknown; responseBody?: unknown };
        if (typeof capture.walletAddress !== 'string' || capture.period !== '30d') { ignoredNon30d += 1; return []; }
        if (capture.responseBody === undefined) { ignoredUnavailable += 1; return []; }
        const status = typeof capture.status === 'number' ? capture.status : 200;
        return [{ walletAddress: capture.walletAddress, period: '30d', available: status === 200, metrics: capture.responseBody, error: status === 200 ? undefined : `GMGN returned HTTP ${status}` }];
      });
      if (!results.length) throw new Error('No 30-day wallet risk captures were found in this JSON file.');
      const saved = await fetch('/api/copytrade/scrutiny/gmgn-risk/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ results }) });
      if (!saved.ok) throw new Error(`Import failed (${saved.status}).`);
      const outcome = await saved.json() as { imported?: number; ignored?: number; results?: Array<{ walletAddress?: unknown; available?: unknown; metrics?: unknown }> };
      const ignored = (outcome.ignored ?? 0) + ignoredNon30d + ignoredUnavailable;
      setImportMessage(`Imported ${outcome.imported ?? 0} 30-day risk response(s).${ignored ? ` Ignored ${ignored} non-usable or non-30-day entr${ignored === 1 ? 'y' : 'ies'}.` : ''}`);
      // Importing risk JSON only changes the saved GMGN-risk column. Do not recompute the
      // entire Decision Lab report here; that expensive read is unnecessary because risk
      // details are descriptive context and do not affect the four scores.
      const importedByWallet = new Map(
        (outcome.results ?? [])
          .filter((result): result is { walletAddress: string; available: boolean; metrics?: unknown } => typeof result.walletAddress === 'string' && typeof result.available === 'boolean')
          .map((result) => [result.walletAddress, result]),
      );
      if (importedByWallet.size > 0) {
        setResponse((current) => current ? {
          ...current,
          wallets: current.wallets.map((wallet) => {
            const imported = importedByWallet.get(wallet.walletAddress);
            return imported ? { ...wallet, riskDetails: { available: imported.available, metrics: imported.metrics && typeof imported.metrics === 'object' ? imported.metrics as Record<string, unknown> : null } } : wallet;
          }),
        } : current);
      }
    } catch (reason: unknown) { setImportMessage(reason instanceof Error ? reason.message : 'Could not import the risk JSON.'); }
    finally { setImporting(false); }
  };
  return <section className="menu-section panel experimental-decision-panel">
    <div className="panel-heading"><div><p className="eyebrow">EXPERIMENTAL · READ-ONLY</p><h2>Decision Lab</h2></div><div className="experimental-actions"><button type="button" className="secondary" onClick={load} disabled={loading || importing}>Reload saved evidence</button>{response && <button type="button" className="secondary" onClick={() => exportDecisionLab(response)} disabled={loading || importing}>Export table + details</button>}<label className="experimental-import-button">Import GMGN risk bundle<input type="file" accept="application/json,.json" disabled={importing} onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void importRiskBundle(file); event.currentTarget.value = ''; }} /></label></div></div>
    <p className="muted">A separate, exploratory score built from saved 30-day GMGN and Dune evidence. Only GMGN 30-day risk is imported and scored; 7-day and all-time responses are ignored. It never calls a provider, changes the production verdict, or spends credits.</p>
    {loading && <p className="copytrade-analysis-status running"><span className="loading-spinner" /> Reading saved SQLite evidence…</p>}
    {error && <p className="copytrade-status-warning">Could not load the experiment: {error}</p>}
    {importMessage && <p className="copytrade-analysis-status">{importMessage}</p>}
    {response && !loading && <>
      <div className="experimental-note"><strong>Experimental only.</strong> Overall scores require all four component scores. A dash means that evidence is missing, not zero. Generated {new Date(response.generatedAt).toLocaleString()}.</div>
      <p className="experimental-score-legend"><strong>Score legend:</strong> every score is from 0 to 100. Higher is better. Rows marked <strong>insufficient</strong> are unrankable and are not comparable to scored wallets. Click a row for the calculation details.</p>
      <DataTable wrapClassName="experimental-table-wrap" tableClassName="experimental-table" rows={response.wallets} getRowKey={(wallet) => wallet.walletAddress} rowProps={(wallet) => ({ className: 'experimental-clickable-row', onClick: () => setSelectedWallet(wallet), title: 'Open score details' })} columns={[
        { key: 'rank', header: 'Rank', render: (wallet) => wallet.rank === null ? '—' : `#${wallet.rank}` },
        { key: 'wallet', header: 'Wallet', headerProps: { className: 'experimental-wallet-column' }, cellProps: () => ({ className: 'experimental-wallet-column' }), render: (wallet) => <span title={wallet.walletAddress}><a className="gmgn-wallet-link" href={gmgnUrl(wallet.walletAddress)} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}><strong>{wallet.name?.trim() || short(wallet.walletAddress)}</strong>{wallet.name?.trim() && <small>{short(wallet.walletAddress)}</small>}</a></span> },
        { key: 'evidence', header: 'Evidence', render: (wallet) => <span className={`experimental-evidence ${wallet.evidence.level}`} title={wallet.evidence.detail}>{wallet.evidence.level}</span> },
        { key: 'edge', header: <>Edge<br />score</>, headerProps: { className: 'experimental-score-column' }, cellProps: () => ({ className: 'experimental-score-column' }), render: (wallet) => <ScoreCell value={wallet.scores.edge} /> },
        { key: 'consistency', header: <>Consistency<br />score</>, headerProps: { className: 'experimental-score-column' }, cellProps: () => ({ className: 'experimental-score-column' }), render: (wallet) => <ScoreCell value={wallet.scores.consistency} /> },
        { key: 'robustness', header: <>Robustness<br />score</>, headerProps: { className: 'experimental-score-column' }, cellProps: () => ({ className: 'experimental-score-column' }), render: (wallet) => <ScoreCell value={wallet.scores.robustness} /> },
        { key: 'copyability', header: <>Copyability<br />score</>, headerProps: { className: 'experimental-score-column' }, cellProps: () => ({ className: 'experimental-score-column' }), render: (wallet) => <ScoreCell value={wallet.scores.copyability} /> },
        { key: 'overall', header: <>Overall<br />score</>, headerProps: { className: 'experimental-score-column' }, cellProps: () => ({ className: 'experimental-score-column' }), render: (wallet) => <ScoreCell value={wallet.scores.overall} /> },
        { key: 'facts', header: 'Saved facts', render: (wallet) => <span title={wallet.risks.join(' · ') || 'No recorded warning'}>{pct(wallet.facts.copyMedianPercent)} · {usd(wallet.facts.copyCapitalUsd)}<small>{wallet.facts.matchedRoundTrips}/{wallet.facts.roundTripsConsidered} round trips</small></span> },
        { key: 'scrutiny', header: 'Scrutiny', render: (wallet) => wallet.scrutiny ? <span title={wallet.scrutiny.checks.map((check) => `${check.label}: ${check.verdict} — ${check.detail}`).join('\n')}>{wallet.scrutiny.pass} pass · {wallet.scrutiny.fail} fail<small>{wallet.scrutiny.insufficient} insufficient</small></span> : '—' },
        { key: 'liquidity', header: 'Size bands', render: (wallet) => wallet.liquidity ? <span title="Median simulated return by saved Dune entry-size band">L {pct(wallet.liquidity.low)}<small>M {pct(wallet.liquidity.medium)} · H {pct(wallet.liquidity.high)}</small></span> : '—' },
        { key: 'risk', header: 'GMGN risk', render: (wallet) => wallet.riskDetails?.available ? <span className="experimental-evidence complete" title="Saved GMGN 30-day risk details are available">available</span> : <span className="muted" title="No saved GMGN risk JSON for this wallet">not imported</span> },
        { key: 'tags', header: 'Tags', render: (wallet) => wallet.tags?.length ? <span className="experimental-tag-list">{wallet.tags.map((tag) => <GmgnTag key={tag} tag={tag} />)}</span> : '—' },
      ]} emptyMessage="No saved wallet evidence is available yet." />
      {selectedWallet && <Modal onClose={() => setSelectedWallet(null)} ariaLabel={`Decision Lab details for ${selectedWallet.name?.trim() || short(selectedWallet.walletAddress)}`} dialogClassName="experimental-detail-modal">
        <div className="copytrade-modal-head"><div><p className="eyebrow">DECISION LAB · SAVED EVIDENCE</p><h3>{selectedWallet.name?.trim() || short(selectedWallet.walletAddress)}</h3><a className="gmgn-wallet-link" href={gmgnUrl(selectedWallet.walletAddress)} target="_blank" rel="noreferrer">View wallet on GMGN ↗</a><small title={selectedWallet.walletAddress}>{selectedWallet.walletAddress}</small></div><button type="button" className="secondary" onClick={() => setSelectedWallet(null)}>Close</button></div>
        <p className="muted">Exploratory only. This dialog explains the score inputs; it does not change the production verdict or fetch anything.</p>
        <div className="experimental-detail-score-grid">{(['overall', 'edge', 'consistency', 'robustness', 'copyability'] as const).map((key) => { const value = selectedWallet.scores[key]; const details = selectedWallet.scoreDetails?.[key] ?? legacyScoreDetail(selectedWallet, key); return <div className={`experimental-score-card ${key}`} key={key}><div><span>{details.label}</span><strong>{score(value)}</strong></div><div className="experimental-score-track"><i style={{ width: `${value ?? 0}%` }} /></div><small>{details.detail}</small></div>; })}</div>
        <div className="experimental-detail-grid"><section><h4>Evidence used</h4><p className={`experimental-evidence ${selectedWallet.evidence.level}`}>{selectedWallet.evidence.level}</p><p className="muted">{selectedWallet.evidence.detail}</p><dl><dt>GMGN median</dt><dd>{pct(selectedWallet.facts.gmgnMedianPercent)}</dd><dt>Delayed-copy median</dt><dd>{pct(selectedWallet.facts.copyMedianPercent)}</dd><dt>$100 after copy</dt><dd>{usd(selectedWallet.facts.copyCapitalUsd)}</dd><dt>Dune coverage</dt><dd>{pct(selectedWallet.facts.duneCoveragePercent)}</dd><dt>Round trips</dt><dd>{selectedWallet.facts.matchedRoundTrips}/{selectedWallet.facts.roundTripsConsidered}</dd><dt>Median hold</dt><dd>{selectedWallet.facts.medianHoldSeconds === null ? '—' : `${(selectedWallet.facts.medianHoldSeconds / 3600).toFixed(1)}h`}</dd></dl></section><section><h4>Warnings and context</h4>{selectedWallet.risks.length ? <ul className="experimental-risk-list">{selectedWallet.risks.map((risk) => <li key={risk}>{risk}</li>)}</ul> : <p className="change-positive">No recorded warnings.</p>}<p><strong>Tags:</strong> {selectedWallet.tags?.join(', ') || '—'}</p><p><strong>GMGN risk:</strong> {selectedWallet.riskDetails?.available ? 'Imported' : 'Not imported'}</p>{selectedWallet.liquidity && <p><strong>Size bands:</strong> Low {pct(selectedWallet.liquidity.low)} · Medium {pct(selectedWallet.liquidity.medium)} · High {pct(selectedWallet.liquidity.high)}</p>}</section></div>
        {selectedWallet.scrutiny && <section className="experimental-detail-checks"><h4>Scrutiny checks</h4><div>{selectedWallet.scrutiny.checks.map((check) => <article className={`experimental-check ${check.verdict}`} key={check.label}><strong>{check.verdict === 'pass' ? '✓' : check.verdict === 'fail' ? '×' : '…'} {check.label}</strong><span>{check.detail}</span></article>)}</div></section>}
      </Modal>}
    </>}
  </section>;
}
