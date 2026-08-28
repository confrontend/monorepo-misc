import { useEffect, useRef, useState } from 'react';
import { strings } from '../strings.js';
import { DataTable } from './DataTable.js';
import { FormattedDate } from './FormattedDate.js';
import { GmgnTag } from './GmgnTag.js';
import { StatusPill } from './StatusPill.js';

type LiveEvaluationCategory = 'historicalProfitability' | 'consistency' | 'robustness' | 'copyability';
type Rule = { feature: string; kind: 'threshold' | 'correlation'; category: LiveEvaluationCategory; pointsApplied: number; detail: string };
type HistoryTrend = { available: false } | { available: true; scoreDelta: number | null; direction: 'better' | 'worse' | 'unchanged' | 'unknown'; verdictChanged: boolean; previousSource: 'live' | 'decision_lab'; previousGeneratedAt: string };
type HistoryEntry = { id: number; source: 'live' | 'decision_lab'; generatedAt: string; score: number | null; verdict: 'pass' | 'reject' | 'insufficient_evidence'; evidenceLevel: string | null; componentScores: Record<string, number | null>; trend: HistoryTrend };
type FetchRunState = { running: boolean; status: string; currentWalletProgressPercent: number | null; error: string | null };
type Result = {
  walletAddress: string; generatedAt: string; disclaimer: string; profileLoadStatus: { status: string; reason?: string; supportingCoveragePercent?: number[] };
  evidenceLevel: 'complete' | 'partial' | 'insufficient' | 'missing'; confidence: 'high' | 'medium' | 'low' | 'none'; verdict: 'pass' | 'reject' | 'insufficient_evidence';
  gmgnProfitabilityLanguage: string; estimatedOverallScore: number | null; componentScores: Record<LiveEvaluationCategory, number | null>;
  weighting: { mode: string; weights?: Partial<Record<LiveEvaluationCategory, number>>; detail: string }; positiveReasons: string[]; riskReasons: string[]; rulesApplied: Rule[];
  gmgnStatsUsed: { period: string; fetchedAt: string | null; trades: number; buyCount: number | null; sellCount: number | null; medianReturnPercent: number | null; winRatePercent: number | null; medianHoldSeconds: number | null; under15SecondsPercent: number | null; bestTokenProfitSharePercent: number | null; realizedProfitUsd: number | null; gmgnTags: string[] | null };
  trend?: HistoryTrend;
};
type ApiResponse = { status: 'result'; result: Result } | { status: 'fetching'; runId: number; walletAddress: string };
type HistoryResponse = { entries: HistoryEntry[] };

const STORAGE_KEY = 'vantage-live-evaluation-last-result';
const POLL_INTERVAL_MS = 1500;
const copy = strings.liveEvaluation;
const pct = (v: number | null | undefined) => v == null ? '—' : `${v.toFixed(1)}%`;
const num = (v: number | null | undefined) => v == null ? '—' : v.toLocaleString();
const usd = (v: number | null | undefined) => v == null ? '—' : `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const seconds = (v: number | null | undefined) => v == null ? '—' : `${v.toLocaleString()}s`;
const score = (v: number | null | undefined) => v == null ? '—' : v.toFixed(1);
const sourceLabel = (source: HistoryEntry['source']) => source === 'live' ? copy.historySourceLive : copy.historySourceDecisionLab;
const directionLabel = (trend: HistoryTrend) => !trend.available ? copy.historyFirst : trend.direction === 'better' ? `↑ ${score(trend.scoreDelta)}` : trend.direction === 'worse' ? `↓ ${score(Math.abs(trend.scoreDelta ?? 0))}` : trend.direction === 'unchanged' ? '— 0.0' : '—';
const TagList = ({ tags }: { tags: string[] | null | undefined }) => tags?.length ? <span className="experimental-tag-list">{tags.map((tag) => <GmgnTag key={tag} tag={tag} />)}</span> : '—';

export function LiveEvaluation({ api }: { api: <T>(path: string, init?: RequestInit) => Promise<T> }) {
  const [walletAddress, setWalletAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [fetchStatus, setFetchStatus] = useState<FetchRunState | null>(null);
  const [stopping, setStopping] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved) as { walletAddress: string; result: Result };
      setWalletAddress(parsed.walletAddress); setResult(parsed.result);
      void loadHistory(parsed.walletAddress);
    } catch { /* local storage is optional */ }
  }, []);
  useEffect(() => () => { if (pollTimer.current) clearInterval(pollTimer.current); }, []);

  const loadHistory = async (address: string) => {
    try { const response = await api<HistoryResponse>(`/api/live-evaluation/history?walletAddress=${encodeURIComponent(address)}&chain=sol&limit=50`); setHistory(response.entries); } catch { setHistory([]); }
  };
  const finishEvaluation = (address: string, response: ApiResponse) => {
    if (response.status !== 'result') return;
    setResult(response.result); setLoading(false); setFetchStatus(null);
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ walletAddress: address, result: response.result })); } catch { /* optional */ }
    void loadHistory(address);
  };
  const requestEvaluation = async (address: string) => {
    const response = await api<ApiResponse>('/api/live-evaluation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ walletAddress: address }) });
    if (response.status === 'result') { finishEvaluation(address, response); return; }
    pollTimer.current = setInterval(() => { void (async () => {
      try { const status = await api<FetchRunState>('/api/copytrade/fetch/status'); setFetchStatus(status); if (status.running) return; if (pollTimer.current) clearInterval(pollTimer.current); pollTimer.current = null; finishEvaluation(address, await api<ApiResponse>('/api/live-evaluation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ walletAddress: address }) })); }
      catch (caught) { if (pollTimer.current) clearInterval(pollTimer.current); pollTimer.current = null; setError(caught instanceof Error ? caught.message : String(caught)); setLoading(false); }
    })(); }, POLL_INTERVAL_MS);
  };
  const evaluate = async () => { if (pollTimer.current) clearInterval(pollTimer.current); const address = walletAddress.trim(); setLoading(true); setError(null); setFetchStatus(null); try { await requestEvaluation(address); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); setLoading(false); } };
  const stopFetch = async () => { setStopping(true); try { await api('/api/copytrade/fetch/stop', { method: 'POST' }); } catch { /* status poll is authoritative */ } finally { setStopping(false); } };

  return <section className="menu-section panel live-evaluation-panel">
    <div className="panel-heading"><div><p className="eyebrow">{copy.title.toUpperCase()}</p><h2>{copy.subtitle}</h2></div></div>
    <p className="live-evaluation-disclaimer">{copy.disclaimer}</p>
    <div className="live-evaluation-form"><label>{copy.addressLabel}<input value={walletAddress} onChange={(e) => setWalletAddress(e.target.value)} placeholder={copy.addressPlaceholder} onKeyDown={(e) => { if (e.key === 'Enter' && !loading && walletAddress.trim()) void evaluate(); }} /></label><button type="button" disabled={loading || !walletAddress.trim()} onClick={() => void evaluate()}>{loading ? copy.evaluatingButton : copy.evaluateButton}</button></div>
    {loading && !fetchStatus && <p className="muted">{copy.fetchingNotice}</p>}
    {loading && fetchStatus && <div className="live-evaluation-fetch-progress"><p className="muted">{copy.fetchingNotice}</p><progress max={100} value={fetchStatus.currentWalletProgressPercent ?? 0} /><button type="button" className="secondary" disabled={stopping} onClick={() => void stopFetch()}>{stopping ? copy.stoppingButton : copy.stopButton}</button></div>}
    {error && <p className="live-evaluation-error">{error}</p>}
    {!result && !loading && !error && <p className="muted">{copy.emptyState}</p>}
    {result && <div className="live-evaluation-result">
      <div className="live-evaluation-status-strip"><span>{copy.confidenceLabel}: <strong>{result.confidence}</strong></span><span>{copy.evidenceLevelLabel}: <strong>{result.evidenceLevel}</strong></span><span>{copy.profileStatusLabel}: <strong>{result.profileLoadStatus.status}</strong></span></div>
      <section className="live-evaluation-history" aria-labelledby="live-history-title"><h4 id="live-history-title">{copy.historyTitle}</h4><p className="muted"><small>{copy.historyCaption}</small></p>
        <DataTable rows={history} getRowKey={(row) => row.id} columns={[{ key: 'date', header: 'Date', render: (row) => <FormattedDate value={row.generatedAt} /> }, { key: 'source', header: 'Source', render: (row) => <StatusPill status={sourceLabel(row.source)} /> }, { key: 'score', header: 'Score', render: (row) => <strong>{score(row.score)}</strong> }, { key: 'verdict', header: 'Verdict', render: (row) => <StatusPill status={row.verdict} /> }, { key: 'trend', header: 'Change', render: (row) => <span className={row.trend.available && row.trend.direction === 'worse' ? 'comparison-deteriorated' : row.trend.available && row.trend.direction === 'better' ? 'comparison-improved' : ''}>{directionLabel(row.trend)}</span> }]} tableClassName="live-evaluation-history-table" enableExport exportFilename="live-evaluation-history.csv" />
        {history.length === 0 && <p className="muted"><small>{copy.historyEmpty}</small></p>}
        {result.trend?.available && <p className="muted">Current result: <strong className={result.trend.direction === 'worse' ? 'comparison-deteriorated' : 'comparison-improved'}>{directionLabel(result.trend)}</strong> vs. the previous {sourceLabel(result.trend.previousSource)}.</p>}
      </section>
      <details className="live-evaluation-details"><summary>Details</summary><div className="live-evaluation-reasons">
        <div><h4>GMGN stats used</h4><dl className="live-evaluation-stats"><dt>Period</dt><dd>{result.gmgnStatsUsed.period}</dd><dt>Fetched</dt><dd><FormattedDate value={result.gmgnStatsUsed.fetchedAt} /></dd><dt>Trades</dt><dd>{num(result.gmgnStatsUsed.trades)}</dd><dt>Buy / sell count</dt><dd>{num(result.gmgnStatsUsed.buyCount)} / {num(result.gmgnStatsUsed.sellCount)}</dd><dt>Median return</dt><dd>{pct(result.gmgnStatsUsed.medianReturnPercent)}</dd><dt>Win rate</dt><dd>{pct(result.gmgnStatsUsed.winRatePercent)}</dd><dt>Median hold</dt><dd>{seconds(result.gmgnStatsUsed.medianHoldSeconds)}</dd><dt>Under 15s</dt><dd>{pct(result.gmgnStatsUsed.under15SecondsPercent)}</dd><dt>Best-token share</dt><dd>{pct(result.gmgnStatsUsed.bestTokenProfitSharePercent)}</dd><dt>Realized profit</dt><dd>{usd(result.gmgnStatsUsed.realizedProfitUsd)}</dd><dt>Tags</dt><dd><TagList tags={result.gmgnStatsUsed.gmgnTags} /></dd></dl></div>
        <div><h4>Score</h4><p><strong>{score(result.estimatedOverallScore)}</strong> · <StatusPill status={result.verdict} /></p>{result.weighting.mode === 'unavailable' && <p className="muted">{result.weighting.detail}</p>}<dl className="live-evaluation-stats"><dt>Profitability</dt><dd>{score(result.componentScores.historicalProfitability)}</dd><dt>Consistency</dt><dd>{score(result.componentScores.consistency)}</dd><dt>Robustness</dt><dd>{score(result.componentScores.robustness)}</dd><dt>Copyability</dt><dd>{score(result.componentScores.copyability)}</dd></dl></div>
        <div><h4>{copy.positiveReasonsTitle}</h4>{result.positiveReasons.length ? <ul>{result.positiveReasons.map((item, i) => <li key={i}>{item}</li>)}</ul> : <p className="muted">{copy.noReasons}</p>}<h4>{copy.riskReasonsTitle}</h4>{result.riskReasons.length ? <ul>{result.riskReasons.map((item, i) => <li key={i}>{item}</li>)}</ul> : <p className="muted">{copy.noReasons}</p>}</div>
        <div><h4>{copy.rulesAppliedTitle}</h4>{result.rulesApplied.length ? <DataTable rows={result.rulesApplied} getRowKey={(row, i) => `${row.feature}-${i}`} columns={[{ key: 'feature', header: 'Rule', render: (row) => row.feature }, { key: 'points', header: 'Points', render: (row) => row.pointsApplied.toFixed(1) }, { key: 'detail', header: 'Detail', render: (row) => row.detail }]} /> : <p className="muted">{copy.noRulesApplied}</p>}</div>
      </div></details>
    </div>}
  </section>;
}
