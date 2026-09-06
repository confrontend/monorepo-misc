import { useEffect, useState } from 'react';
import { strings } from '../strings.js';
import { DataTable } from './DataTable.js';
import { FormattedDate } from './FormattedDate.js';
import { GmgnTag } from './GmgnTag.js';
import { StatusPill } from './StatusPill.js';

type LiveEvaluationCategory =
  'historicalProfitability' | 'consistency' | 'robustness' | 'copyability';
type Rule = {
  feature: string;
  kind: 'threshold' | 'correlation';
  category: LiveEvaluationCategory;
  pointsApplied: number;
  detail: string;
};
type HistoryTrend =
  | { available: false }
  | {
      available: true;
      scoreDelta: number | null;
      direction: 'better' | 'worse' | 'unchanged' | 'unknown';
      verdictChanged: boolean;
      previousSource: 'live' | 'decision_lab';
      previousGeneratedAt: string;
    };
type HistoryEntry = {
  id: number;
  source: 'live' | 'decision_lab';
  generatedAt: string;
  score: number | null;
  verdict: 'pass' | 'reject' | 'insufficient_evidence';
  evidenceLevel: string | null;
  componentScores: Record<string, number | null>;
  trend: HistoryTrend;
};
type WinnerPolicy = {
  policyVersion: string;
  status: 'WINNER' | 'REJECTED' | 'UNPROVEN';
  actionability?: 'ACTIONABLE' | 'REVIEW' | 'NOT_ACTIONABLE';
  finalScore: number | null;
  profitabilityScore: {
    score: number;
    max: number;
    portfolioScore: number;
    profitFactorScore: number;
    evidenceConfidenceScore: number;
    robustnessScore: number;
    weightedProfitFactor: number | null;
  } | null;
  gmgnRiskScore: {
    score: number;
    max: number;
    walletAgeDays: number | null;
    deductions: {
      executionSpeed: number;
      hyperactivity: number;
      tradeQuality: number;
      tokenRisk: number;
      costs: number;
      walletAge: number;
      walletAge: number;
    };
  } | null;
  gates: Array<{ label: string; status: string; detail: string }>;
  positiveReasons: string[];
  rejectionReasons: string[];
  unprovenReasons: string[];
  warnings: string[];
  evidence: {
    periodDays: number | null;
    completedCopiedBuyOutcomes: number;
    medianReturnPercent: number | null;
    endingCapitalUsd: number | null;
    riskBundle: { fetchedAt: string } | null;
    holdouts: Array<{
      index: number;
      completedCopiedBuyOutcomes: number;
      medianReturnPercent: number | null;
      endingCapitalUsd: number | null;
      profitable: boolean | null;
    }>;
  };
};
type Result = {
  walletAddress: string;
  generatedAt: string;
  disclaimer: string;
  profileLoadStatus: { status: string; reason?: string; supportingCoveragePercent?: number[] };
  evidenceLevel: 'complete' | 'partial' | 'insufficient' | 'missing';
  confidence: 'high' | 'medium' | 'low' | 'none';
  verdict: 'pass' | 'reject' | 'insufficient_evidence';
  winnerPolicy: WinnerPolicy;
  winnerPolicyStatus: WinnerPolicy['status'];
  gmgnProfitabilityLanguage: string;
  estimatedOverallScore: number | null;
  componentScores: Record<LiveEvaluationCategory, number | null>;
  weighting: {
    mode: string;
    weights?: Partial<Record<LiveEvaluationCategory, number>>;
    detail: string;
  };
  positiveReasons: string[];
  riskReasons: string[];
  rulesApplied: Rule[];
  gmgnStatsUsed: {
    period: string;
    fetchedAt: string | null;
    trades: number;
    buyCount: number | null;
    sellCount: number | null;
    medianReturnPercent: number | null;
    winRatePercent: number | null;
    medianHoldSeconds: number | null;
    under15SecondsPercent: number | null;
    bestTokenProfitSharePercent: number | null;
    realizedProfitUsd: number | null;
    gmgnTags: string[] | null;
  };
  copyabilityDiagnostics?: {
    holdContribution: number | null;
    fastRoundTripPenalty: number;
    under15SecondPenalty: number;
    sampleSize: { pairedTrades: number };
    confidence: 'insufficient' | 'low' | 'moderate' | 'high';
    gate: 'pass' | 'insufficient_sample' | 'missing_hold';
  };
  trend?: HistoryTrend;
};
type ApiResponse = { status: 'result'; result: Result };
type HistoryResponse = { entries: HistoryEntry[] };

const STORAGE_KEY = 'vantage-live-evaluation-last-result';
const copy = strings.liveEvaluation;
const pct = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}%`);
const num = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString());
const usd = (v: number | null | undefined) =>
  v == null ? '—' : `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const seconds = (v: number | null | undefined) => (v == null ? '—' : `${v.toLocaleString()}s`);
const score = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(1));
const sourceLabel = (source: HistoryEntry['source']) =>
  source === 'live' ? copy.historySourceLive : copy.historySourceDecisionLab;
const directionLabel = (trend: HistoryTrend) =>
  !trend.available
    ? copy.historyFirst
    : trend.direction === 'better'
      ? `↑ ${score(trend.scoreDelta)}`
      : trend.direction === 'worse'
        ? `↓ ${score(Math.abs(trend.scoreDelta ?? 0))}`
        : trend.direction === 'unchanged'
          ? '— 0.0'
          : '—';
const hasWinnerPolicy = (value: unknown): value is Result['winnerPolicy'] =>
  Boolean(value && typeof value === 'object' && 'finalScore' in value && 'status' in value);
const TagList = ({ tags }: { tags: string[] | null | undefined }) =>
  tags?.length ? (
    <span className="experimental-tag-list">
      {tags.map((tag) => (
        <GmgnTag key={tag} tag={tag} />
      ))}
    </span>
  ) : (
    '—'
  );

export function LiveEvaluation({
  api,
}: {
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
}) {
  const [walletAddress, setWalletAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved) as { walletAddress: string; result: Result };
      if (!parsed.result || !hasWinnerPolicy(parsed.result.winnerPolicy)) {
        window.localStorage.removeItem(STORAGE_KEY);
        return;
      }
      setWalletAddress(parsed.walletAddress);
      setResult(parsed.result);
      void loadHistory(parsed.walletAddress);
    } catch {
      /* local storage is optional */
    }
  }, []);
  const loadHistory = async (address: string) => {
    try {
      const response = await api<HistoryResponse>(
        `/api/live-evaluation/history?walletAddress=${encodeURIComponent(address)}&chain=sol&limit=50`,
      );
      setHistory(response.entries);
    } catch {
      setHistory([]);
    }
  };
  const finishEvaluation = (address: string, response: ApiResponse) => {
    if (response.status !== 'result') return;
    if (!hasWinnerPolicy(response.result?.winnerPolicy)) {
      setError('Live Evaluation returned an outdated result. Restart the server and try again.');
      setLoading(false);
      return;
    }
    setResult(response.result);
    setLoading(false);
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ walletAddress: address, result: response.result }),
      );
    } catch {
      /* optional */
    }
    void loadHistory(address);
  };
  const requestEvaluation = async (address: string) => {
    const response = await api<ApiResponse>('/api/live-evaluation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ walletAddress: address }),
    });
    finishEvaluation(address, response);
  };
  const evaluate = async () => {
    const address = walletAddress.trim();
    setLoading(true);
    setError(null);
    try {
      await requestEvaluation(address);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setLoading(false);
    }
  };
  return (
    <section className="menu-section panel live-evaluation-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{copy.title.toUpperCase()}</p>
          <h2>{copy.subtitle}</h2>
        </div>
      </div>
      <p className="live-evaluation-disclaimer">{copy.disclaimer}</p>
      <div className="live-evaluation-form">
        <label>
          {copy.addressLabel}
          <input
            value={walletAddress}
            onChange={(e) => setWalletAddress(e.target.value)}
            placeholder={copy.addressPlaceholder}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !loading && walletAddress.trim()) void evaluate();
            }}
          />
        </label>
        <button
          type="button"
          disabled={loading || !walletAddress.trim()}
          onClick={() => void evaluate()}
        >
          {loading ? copy.evaluatingButton : copy.evaluateButton}
        </button>
      </div>
      {loading && <p className="muted">{copy.fetchingNotice}</p>}
      {error && <p className="live-evaluation-error">{error}</p>}
      {!result && !loading && !error && <p className="muted">{copy.emptyState}</p>}
      {result && (
        <div className="live-evaluation-result">
          <div className="live-evaluation-status-strip">
            <span>
              {copy.confidenceLabel}: <strong>{result.confidence}</strong>
            </span>
            <span>
              {copy.evidenceLevelLabel}: <strong>{result.evidenceLevel}</strong>
            </span>
            <span>
              {copy.profileStatusLabel}: <strong>{result.profileLoadStatus.status}</strong>
            </span>
            <span>
              Winner Policy: <strong>{result.winnerPolicyStatus}</strong>
              {result.winnerPolicy.finalScore !== null &&
                ` · ${result.winnerPolicy.finalScore}/100`}
            </span>
          </div>
          <section className="live-evaluation-history" aria-labelledby="live-history-title">
            <h4 id="live-history-title">{copy.historyTitle}</h4>
            <p className="muted">
              <small>{copy.historyCaption}</small>
            </p>
            <DataTable
              rows={history}
              getRowKey={(row) => row.id}
              columns={[
                {
                  key: 'date',
                  header: 'Date',
                  render: (row) => <FormattedDate value={row.generatedAt} />,
                },
                {
                  key: 'source',
                  header: 'Source',
                  render: (row) => <StatusPill status={sourceLabel(row.source)} />,
                },
                {
                  key: 'score',
                  header: 'Score',
                  render: (row) => <strong>{score(row.score)}</strong>,
                },
                {
                  key: 'verdict',
                  header: 'Verdict',
                  render: (row) => <StatusPill status={row.verdict} />,
                },
                {
                  key: 'trend',
                  header: 'Change',
                  render: (row) => (
                    <span
                      className={
                        row.trend.available && row.trend.direction === 'worse'
                          ? 'comparison-deteriorated'
                          : row.trend.available && row.trend.direction === 'better'
                            ? 'comparison-improved'
                            : ''
                      }
                    >
                      {directionLabel(row.trend)}
                    </span>
                  ),
                },
              ]}
              tableClassName="live-evaluation-history-table"
              enableExport
              exportFilename="live-evaluation-history.csv"
            />
            {history.length === 0 && (
              <p className="muted">
                <small>{copy.historyEmpty}</small>
              </p>
            )}
            {result.trend?.available && (
              <p className="muted">
                Current result:{' '}
                <strong
                  className={
                    result.trend.direction === 'worse'
                      ? 'comparison-deteriorated'
                      : 'comparison-improved'
                  }
                >
                  {directionLabel(result.trend)}
                </strong>{' '}
                vs. the previous {sourceLabel(result.trend.previousSource)}.
              </p>
            )}
          </section>
          <details className="live-evaluation-details">
            <summary>Details</summary>
            <div className="live-evaluation-reasons">
              <div>
                <h4>Authoritative Winner Policy · {result.winnerPolicy.policyVersion}</h4>
                <p>
                  <StatusPill
                    status={
                      result.winnerPolicy.actionability === 'REVIEW'
                        ? 'REVIEW'
                        : result.winnerPolicy.status
                    }
                  />{' '}
                  {result.winnerPolicy.evidence.completedCopiedBuyOutcomes} completed copied-buy
                  outcomes · median {pct(result.winnerPolicy.evidence.medianReturnPercent)} · end{' '}
                  {usd(result.winnerPolicy.evidence.endingCapitalUsd)}
                </p>
                {result.winnerPolicy.finalScore !== null && (
                  <div className="experimental-policy-score-breakdown">
                    <strong>Final score: {result.winnerPolicy.finalScore} / 100</strong>
                    {result.winnerPolicy.profitabilityScore && (
                      <p>
                        Profitability {result.winnerPolicy.profitabilityScore.score} /{' '}
                        {result.winnerPolicy.profitabilityScore.max} (portfolio{' '}
                        {result.winnerPolicy.profitabilityScore.portfolioScore}, profit factor{' '}
                        {result.winnerPolicy.profitabilityScore.profitFactorScore}, confidence{' '}
                        {result.winnerPolicy.profitabilityScore.evidenceConfidenceScore}, robustness{' '}
                        {result.winnerPolicy.profitabilityScore.robustnessScore})
                      </p>
                    )}
                    {result.winnerPolicy.gmgnRiskScore && (
                      <p>
                        GMGN risk/execution {result.winnerPolicy.gmgnRiskScore.score} /{' '}
                        {result.winnerPolicy.gmgnRiskScore.max} (deductions: execution speed{' '}
                        {result.winnerPolicy.gmgnRiskScore.deductions.executionSpeed}, hyperactivity{' '}
                        {result.winnerPolicy.gmgnRiskScore.deductions.hyperactivity}, trade quality{' '}
                        {result.winnerPolicy.gmgnRiskScore.deductions.tradeQuality}, token risk{' '}
                        {result.winnerPolicy.gmgnRiskScore.deductions.tokenRisk}, costs{' '}
                        {result.winnerPolicy.gmgnRiskScore.deductions.costs})
                      </p>
                    )}
                    {result.winnerPolicy.evidence.riskBundle && (
                      <small>
                        Risk context as of{' '}
                        <FormattedDate value={result.winnerPolicy.evidence.riskBundle.fetchedAt} />
                      </small>
                    )}
                  </div>
                )}
                <ul>
                  {result.winnerPolicy.gates.map((item) => (
                    <li key={item.label}>
                      <strong>{item.status}</strong> · {item.label}: {item.detail}
                    </li>
                  ))}
                </ul>
                {result.winnerPolicy.warnings.length > 0 && (
                  <p className="muted">{result.winnerPolicy.warnings.join(' ')}</p>
                )}
              </div>
              <div>
                <h4>GMGN stats used</h4>
                <dl className="live-evaluation-stats">
                  <dt>Period</dt>
                  <dd>{result.gmgnStatsUsed.period}</dd>
                  <dt>Fetched</dt>
                  <dd>
                    <FormattedDate value={result.gmgnStatsUsed.fetchedAt} />
                  </dd>
                  <dt>Trades</dt>
                  <dd>{num(result.gmgnStatsUsed.trades)}</dd>
                  <dt>Buy / sell count</dt>
                  <dd>
                    {num(result.gmgnStatsUsed.buyCount)} / {num(result.gmgnStatsUsed.sellCount)}
                  </dd>
                  <dt>Median return</dt>
                  <dd>{pct(result.gmgnStatsUsed.medianReturnPercent)}</dd>
                  <dt>Win rate</dt>
                  <dd>{pct(result.gmgnStatsUsed.winRatePercent)}</dd>
                  <dt>Median hold</dt>
                  <dd>{seconds(result.gmgnStatsUsed.medianHoldSeconds)}</dd>
                  <dt>Under 15s</dt>
                  <dd>{pct(result.gmgnStatsUsed.under15SecondsPercent)}</dd>
                  <dt>Best-token share</dt>
                  <dd>{pct(result.gmgnStatsUsed.bestTokenProfitSharePercent)}</dd>
                  <dt>Realized profit</dt>
                  <dd>{usd(result.gmgnStatsUsed.realizedProfitUsd)}</dd>
                  <dt>Tags</dt>
                  <dd>
                    <TagList tags={result.gmgnStatsUsed.gmgnTags} />
                  </dd>
                </dl>
              </div>
              <div>
                <h4>Score</h4>
                <p>
                  <strong>{score(result.estimatedOverallScore)}</strong> ·{' '}
                  <StatusPill status={result.verdict} />
                </p>
                {result.weighting.mode === 'unavailable' && (
                  <p className="muted">{result.weighting.detail}</p>
                )}
                <dl className="live-evaluation-stats">
                  <dt>Profitability</dt>
                  <dd>{score(result.componentScores.historicalProfitability)}</dd>
                  <dt>Consistency</dt>
                  <dd>{score(result.componentScores.consistency)}</dd>
                  <dt>Robustness</dt>
                  <dd>{score(result.componentScores.robustness)}</dd>
                  <dt>Copyability</dt>
                  <dd>{score(result.componentScores.copyability)}</dd>
                  {result.copyabilityDiagnostics && (
                    <>
                      <dt>Copyability trace</dt>
                      <dd>
                        hold {score(result.copyabilityDiagnostics.holdContribution)} − fast{' '}
                        {result.copyabilityDiagnostics.fastRoundTripPenalty.toFixed(1)} − under-15s{' '}
                        {result.copyabilityDiagnostics.under15SecondPenalty.toFixed(1)};{' '}
                        {result.copyabilityDiagnostics.confidence} confidence ({' '}
                        {result.copyabilityDiagnostics.sampleSize.pairedTrades} paired)
                      </dd>
                    </>
                  )}
                </dl>
              </div>
              <div>
                <h4>{copy.positiveReasonsTitle}</h4>
                {result.positiveReasons.length ? (
                  <ul>
                    {result.positiveReasons.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">{copy.noReasons}</p>
                )}
                <h4>{copy.riskReasonsTitle}</h4>
                {result.riskReasons.length ? (
                  <ul>
                    {result.riskReasons.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">{copy.noReasons}</p>
                )}
              </div>
              <div>
                <h4>{copy.rulesAppliedTitle}</h4>
                {result.rulesApplied.length ? (
                  <DataTable
                    rows={result.rulesApplied}
                    getRowKey={(row, i) => `${row.feature}-${i}`}
                    columns={[
                      { key: 'feature', header: 'Rule', render: (row) => row.feature },
                      {
                        key: 'points',
                        header: 'Points',
                        render: (row) => row.pointsApplied.toFixed(1),
                      },
                      { key: 'detail', header: 'Detail', render: (row) => row.detail },
                    ]}
                  />
                ) : (
                  <p className="muted">{copy.noRulesApplied}</p>
                )}
              </div>
            </div>
          </details>
        </div>
      )}
    </section>
  );
}
