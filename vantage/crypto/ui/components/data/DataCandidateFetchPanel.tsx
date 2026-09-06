import { useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../../httpClient.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js';
import {
  loadDuneCandidateFilters,
  loadDuneCandidateSelection,
  saveDuneCandidateFilters,
  saveDuneCandidateSelection,
} from '../../state/duneCandidatePreferences.js';

type Candidate = {
  walletAddress: string;
  name: string | null;
  rank: number | null;
  gmgnScreen: {
    classification: 'POTENTIAL' | 'REJECTED_PRE_DUNE' | 'UNPROVEN';
    reasons: string[];
  };
  pendingTargets: number;
  tradeCount: number;
  realizedPnlUsd: number | null;
  winRatePercent: number | null;
  preDuneScore: number | null;
  preDuneScoreMax: number;
  preDuneScoreBreakdown: string[];
};

type SortKey = 'wallet' | 'rank' | 'screen' | 'trades' | 'pnl' | 'winRate' | 'pending' | 'score';

type FetchStatus = {
  running?: boolean;
  outcome?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  targetsTotal?: number;
  targetsProcessed?: number;
  batchesRun?: number;
  currentBatch?: number;
  batchesTotal?: number;
  storedTargets?: number;
  remainingTargets?: number;
  message?: string;
  duneRequestPhase?: string;
  duneState?: string | null;
  failedTargets?: number;
  audit?: {
    status?: string;
    requestedAt?: string;
    plannedTargets?: number;
    message?: string;
  } | null;
  persistedRun?: {
    status?: string;
    requestedAt?: string;
  } | null;
};

const gmgnWalletUrl = (walletAddress: string): string =>
  `https://gmgn.ai/sol/address/${encodeURIComponent(walletAddress)}`;
const shortWalletAddress = (walletAddress: string): string =>
  walletAddress.length > 14
    ? `${walletAddress.slice(0, 7)}…${walletAddress.slice(-5)}`
    : walletAddress;
const DUNE_CREDITS_PER_TARGET = 0.04;
const DUNE_CREDIT_BUDGET = 2_500;

export function DataCandidateFetchPanel({ api }: { api: ApiClient }) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(loadDuneCandidateSelection);
  const [potentialOnly, setPotentialOnly] = useState(
    () => loadDuneCandidateFilters().potentialOnly,
  );
  const [hideNonPositivePnl, setHideNonPositivePnl] = useState(
    () => loadDuneCandidateFilters().hideNonPositivePnl,
  );
  const [minimumScore, setMinimumScore] = useState(() => loadDuneCandidateFilters().minimumScore);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [progress, setProgress] = useState<FetchStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [riskImporting, setRiskImporting] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({
    key: 'rank',
    direction: 'asc',
  });

  const importRiskBundle = async (file: File) => {
    setRiskImporting(true);
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const root =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      const captures =
        root && Array.isArray(root.captures) ? root.captures : Array.isArray(parsed) ? parsed : [];
      const results = captures.flatMap((value) => {
        if (!value || typeof value !== 'object') return [];
        const capture = value as Record<string, unknown>;
        if (
          typeof capture.walletAddress !== 'string' ||
          capture.period !== '30d' ||
          capture.responseBody === undefined
        )
          return [];
        const status = typeof capture.status === 'number' ? capture.status : 200;
        return [
          {
            walletAddress: capture.walletAddress,
            period: '30d',
            available: status === 200,
            metrics: capture.responseBody,
            error: status === 200 ? undefined : `GMGN returned HTTP ${status}`,
          },
        ];
      });
      if (!results.length) throw new Error('No usable 30-day GMGN risk captures found.');
      const saved = await api('/api/copytrade/scrutiny/gmgn-risk/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ results }),
      });
      setMessage(
        `Imported ${(saved as { imported?: number }).imported ?? 0} GMGN risk response(s).`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not import the GMGN risk bundle.');
    } finally {
      setRiskImporting(false);
    }
  };

  const loadCandidates = async () => {
    setLoading(true);
    try {
      const report = await api<{ wallets: Array<Record<string, unknown>> }>(
        '/api/copytrade/experimental-decision?limit=100',
      );
      const addresses = report.wallets.map((wallet) => String(wallet.walletAddress));
      const plans = addresses.length
        ? await api<{
            wallets?: Array<{ walletAddress: string; pendingTargets: number; tradeCount: number }>;
          }>(
            `/api/copytrade/decision/dune?walletAddresses=${encodeURIComponent(addresses.join(','))}`,
          )
        : { wallets: [] };
      const byAddress = new Map((plans.wallets ?? []).map((plan) => [plan.walletAddress, plan]));
      setCandidates(
        report.wallets.map((wallet) => {
          const rawScreen = wallet.gmgnScreen as Partial<Candidate['gmgnScreen']> | undefined;
          const screen: Candidate['gmgnScreen'] = {
            classification:
              rawScreen?.classification === 'POTENTIAL' ||
              rawScreen?.classification === 'REJECTED_PRE_DUNE' ||
              rawScreen?.classification === 'UNPROVEN'
                ? rawScreen.classification
                : 'UNPROVEN',
            reasons: Array.isArray(rawScreen?.reasons)
              ? rawScreen.reasons.filter((reason): reason is string => typeof reason === 'string')
              : ['GMGN screening evidence is not available in this saved report.'],
          };
          const plan = byAddress.get(String(wallet.walletAddress));
          const facts =
            wallet.facts && typeof wallet.facts === 'object'
              ? (wallet.facts as Record<string, unknown>)
              : {};
          const winnerPolicy = wallet.winnerPolicy;
          const gmgnRiskScore =
            winnerPolicy && typeof winnerPolicy === 'object'
              ? (winnerPolicy as { gmgnRiskScore?: { score?: unknown } }).gmgnRiskScore?.score
              : null;
          const risk =
            winnerPolicy && typeof winnerPolicy === 'object'
              ? (
                  winnerPolicy as {
                    gmgnRiskScore?: {
                      score?: unknown;
                      max?: unknown;
                      deductions?: Record<string, unknown>;
                      deductionDetails?: Record<string, unknown>;
                    };
                  }
                ).gmgnRiskScore
              : null;
          const breakdown =
            typeof gmgnRiskScore === 'number' && Number.isFinite(gmgnRiskScore)
              ? [
                  `GMGN risk: ${Math.round(gmgnRiskScore)} / ${typeof risk?.max === 'number' ? risk.max : 30}`,
                  'Dune delayed-copyability: 0 / 70 (not fetched yet)',
                  `Available pre-Dune score: ${Math.round(gmgnRiskScore)} / ${typeof risk?.max === 'number' ? risk.max : 30}`,
                  'Final score will be out of 100 after Dune data is fetched.',
                  ...(risk?.deductions
                    ? Object.entries(risk.deductions).map(
                        ([name, value]) =>
                          `${name}: −${typeof value === 'number' ? value.toFixed(2) : '—'} points`,
                      )
                    : []),
                  ...screen.reasons,
                ]
              : ['GMGN score is unavailable until the saved risk inputs are complete.'];
          return {
            walletAddress: String(wallet.walletAddress),
            name: typeof wallet.name === 'string' ? wallet.name : null,
            rank: typeof wallet.rank === 'number' ? wallet.rank : null,
            gmgnScreen: screen,
            pendingTargets: plan?.pendingTargets ?? 0,
            tradeCount: plan?.tradeCount ?? 0,
            realizedPnlUsd:
              typeof facts.officialGmgnRealizedProfitUsd === 'number' &&
              Number.isFinite(facts.officialGmgnRealizedProfitUsd)
                ? facts.officialGmgnRealizedProfitUsd
                : null,
            winRatePercent:
              typeof facts.officialGmgnWinRatePercent === 'number' &&
              Number.isFinite(facts.officialGmgnWinRatePercent)
                ? facts.officialGmgnWinRatePercent
                : null,
            // The final score is 70 Dune points + 30 GMGN risk points. Before Dune,
            // deliberately show only the existing GMGN component; delayed-copyability is 0.
            preDuneScore:
              typeof gmgnRiskScore === 'number' && Number.isFinite(gmgnRiskScore)
                ? gmgnRiskScore
                : null,
            preDuneScoreMax:
              typeof risk?.max === 'number' && Number.isFinite(risk.max) ? risk.max : 30,
            preDuneScoreBreakdown: breakdown,
          };
        }),
      );
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not load GMGN candidates.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadCandidates();
  }, [api]);

  const visible = useMemo(() => {
    const threshold = minimumScore === '' ? null : Number(minimumScore);
    const filtered = candidates.filter(
      (candidate) =>
        candidate.pendingTargets > 0 &&
        (!hideNonPositivePnl ||
          candidate.realizedPnlUsd === null ||
          candidate.realizedPnlUsd > 0) &&
        (!potentialOnly || candidate.gmgnScreen.classification === 'POTENTIAL') &&
        (threshold === null ||
          !Number.isFinite(threshold) ||
          (candidate.preDuneScore !== null && candidate.preDuneScore >= threshold)),
    );
    const direction = sort.direction === 'asc' ? 1 : -1;
    return [...filtered].sort((left, right) => {
      let comparison = 0;
      if (sort.key === 'wallet')
        comparison = (left.name ?? left.walletAddress).localeCompare(
          right.name ?? right.walletAddress,
        );
      if (sort.key === 'rank')
        comparison =
          (left.rank ?? Number.POSITIVE_INFINITY) - (right.rank ?? Number.POSITIVE_INFINITY);
      if (sort.key === 'screen')
        comparison = left.gmgnScreen.classification.localeCompare(right.gmgnScreen.classification);
      if (sort.key === 'trades') comparison = left.tradeCount - right.tradeCount;
      if (sort.key === 'pnl')
        comparison =
          (left.realizedPnlUsd ?? Number.NEGATIVE_INFINITY) -
          (right.realizedPnlUsd ?? Number.NEGATIVE_INFINITY);
      if (sort.key === 'winRate')
        comparison = (left.winRatePercent ?? -1) - (right.winRatePercent ?? -1);
      if (sort.key === 'pending') comparison = left.pendingTargets - right.pendingTargets;
      if (sort.key === 'score') comparison = (left.preDuneScore ?? -1) - (right.preDuneScore ?? -1);
      return comparison === 0
        ? left.walletAddress.localeCompare(right.walletAddress)
        : comparison * direction;
    });
  }, [candidates, hideNonPositivePnl, minimumScore, potentialOnly, sort]);
  const selectedVisible = visible.filter((candidate) => selected.has(candidate.walletAddress));
  // Pending-target counts are loaded with the candidate rows. Keep selection local so a
  // checkbox click never triggers a full database preflight request.
  const selectedPendingTargets = candidates.reduce(
    (sum, candidate) =>
      sum + (selected.has(candidate.walletAddress) ? candidate.pendingTargets : 0),
    0,
  );
  const estimatedCredits = selectedPendingTargets * DUNE_CREDITS_PER_TARGET;
  const budgetPercent = Math.min(100, (estimatedCredits / DUNE_CREDIT_BUDGET) * 100);

  useEffect(() => {
    const visibleAddresses = new Set(visible.map((candidate) => candidate.walletAddress));
    if (!candidates.length) return;
    setSelected((current) => {
      const next = new Set([...current].filter((address) => visibleAddresses.has(address)));
      return next.size === current.size ? current : next;
    });
  }, [visible]);

  useEffect(() => {
    saveDuneCandidateSelection(selected);
  }, [selected]);

  useEffect(() => {
    saveDuneCandidateFilters({ potentialOnly, hideNonPositivePnl, minimumScore });
  }, [hideNonPositivePnl, minimumScore, potentialOnly]);

  useEffect(() => {
    if (!busy) return undefined;
    let disposed = false;
    const poll = async () => {
      try {
        const query = new URLSearchParams({ walletAddresses: [...selected].join(',') });
        if (startedAt) query.set('startedAt', startedAt);
        const rawStatus = await api<FetchStatus>(`/api/copytrade/copy-simulation/status?${query}`);
        const persistedRunActive =
          rawStatus.audit?.status === 'running' ||
          rawStatus.persistedRun?.status === 'submitted' ||
          rawStatus.persistedRun?.status === 'running';
        const status: FetchStatus = {
          ...rawStatus,
          running: rawStatus.running === true || persistedRunActive,
          startedAt:
            rawStatus.startedAt ??
            rawStatus.persistedRun?.requestedAt ??
            rawStatus.audit?.requestedAt ??
            null,
          targetsTotal:
            rawStatus.targetsTotal || rawStatus.audit?.plannedTargets || selectedPendingTargets,
          message:
            rawStatus.message && rawStatus.message !== 'Idle'
              ? rawStatus.message
              : (rawStatus.audit?.message ?? rawStatus.message),
        };
        if (disposed) return;
        setProgress(status);
        // The POST starts asynchronously. Ignore an idle/completed response from the previous
        // run until the status belongs to the run we just started.
        const statusStartedAt = status.startedAt ? Date.parse(status.startedAt) : NaN;
        const requestStartedAt = startedAt ? Date.parse(startedAt) : NaN;
        const belongsToCurrentRun =
          Number.isFinite(statusStartedAt) &&
          Number.isFinite(requestStartedAt) &&
          statusStartedAt >= requestStartedAt - 1_000;
        if (status.running === false && belongsToCurrentRun) {
          setBusy(false);
          setMessage(
            status.failedTargets
              ? `Dune fetch finished with ${status.failedTargets} failed targets.`
              : status.outcome && status.outcome !== 'complete'
                ? (status.message ?? 'Dune fetch stopped before completion.')
                : null,
          );
          await loadCandidates();
        }
      } catch {
        // Keep polling; transient status failures must not interrupt the fetch.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [api, busy, selected, startedAt]);

  const startFetch = async () => {
    if (!selected.size || !selectedPendingTargets) return;
    setBusy(true);
    setMessage(null);
    const now = new Date().toISOString();
    setStartedAt(now);
    try {
      await api('/api/copytrade/decision/dune', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ walletAddresses: [...selected] }),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Dune fetch could not start.';
      if (
        /another dune fetch is already running|another provider fetch is already running/i.test(
          errorMessage,
        )
      ) {
        // Attach to the existing persisted run instead of hiding its progress behind the 409.
        try {
          const existing = await api<FetchStatus>('/api/copytrade/copy-simulation/status');
          const existingStartedAt =
            existing.startedAt ??
            existing.persistedRun?.requestedAt ??
            existing.audit?.requestedAt ??
            null;
          setStartedAt(existingStartedAt);
          setProgress(existing);
          setMessage(null);
          setBusy(
            existing.running === true ||
              existing.audit?.status === 'running' ||
              existing.persistedRun?.status === 'submitted' ||
              existing.persistedRun?.status === 'running',
          );
        } catch {
          setBusy(false);
          setMessage(errorMessage);
        }
      } else {
        setBusy(false);
        setMessage(errorMessage);
      }
    }
  };

  const toggleAll = () => {
    const next = new Set(selected);
    if (
      selectedVisible.every((candidate) => next.has(candidate.walletAddress)) &&
      selectedVisible.length
    ) {
      visible.forEach((candidate) => next.delete(candidate.walletAddress));
    } else {
      visible.forEach((candidate) => {
        if (candidate.pendingTargets > 0) next.add(candidate.walletAddress);
      });
    }
    setSelected(next);
  };

  const toggleSort = (key: SortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' },
    );
  const sortIndicator = (key: SortKey) =>
    sort.key === key ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : '';

  return (
    <section className="copytrade-data-fetch-panel" aria-labelledby="candidate-fetch-title">
      <div className="copytrade-results-meta">
        <div>
          <p className="eyebrow">STAGE 3 · SELECTIVE DUNE FETCH</p>
          <h3 id="candidate-fetch-title">Choose GMGN candidates for Dune</h3>
          <p>Screening is GMGN-only. Dune credits are used only for wallets you select.</p>
        </div>
        <button
          type="button"
          className="secondary"
          onClick={() => void loadCandidates()}
          disabled={loading || busy}
        >
          {loading ? 'Loading candidates…' : 'Refresh candidates'}
        </button>
      </div>
      <label className="copytrade-data-toggle">
        <input
          type="checkbox"
          checked={potentialOnly}
          onChange={(event) => setPotentialOnly(event.target.checked)}
        />
        Potential candidates only
      </label>
      <div className="copytrade-data-fetch-toolbar">
        <label className="secondary copytrade-file-button">
          {riskImporting ? 'Importing GMGN risk…' : 'Import GMGN risk bundle'}
          <input
            type="file"
            accept="application/json,.json"
            disabled={riskImporting || busy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) void importRiskBundle(file);
            }}
          />
        </label>
        <label className="copytrade-filter-label">
          Min pre-Dune score
          <input
            type="number"
            min="0"
            max="30"
            step="1"
            inputMode="numeric"
            placeholder="0–30"
            value={minimumScore}
            disabled={busy}
            onChange={(event) => setMinimumScore(event.currentTarget.value)}
          />
        </label>
        <label className="copytrade-toggle-label">
          <input
            type="checkbox"
            checked={hideNonPositivePnl}
            disabled={busy}
            onChange={(event) => setHideNonPositivePnl(event.currentTarget.checked)}
          />{' '}
          Hide non-positive P&amp;L
        </label>
        <button
          type="button"
          className="primary"
          onClick={() => void startFetch()}
          disabled={busy || !selected.size || !selectedPendingTargets}
        >
          {busy
            ? `Fetching Dune (${progress?.targetsProcessed ?? 0}/${progress?.targetsTotal ?? selectedPendingTargets})`
            : `Fetch selected Dune data (${selected.size})`}
        </button>
      </div>
      {(busy || selected.size > 0) &&
        (() => {
          const total = Math.max(0, progress?.targetsTotal ?? selectedPendingTargets);
          const processed = Math.min(total, Math.max(0, progress?.targetsProcessed ?? 0));
          const phase = progress?.duneRequestPhase?.replace(/_/g, ' ') ?? '';
          return (
            <div className="copytrade-dune-live-progress" role="status" aria-live="polite">
              <div className="copytrade-dune-progress-line">
                <strong>{busy ? 'Dune fetch' : 'Dune estimate'}</strong>
                <span>
                  {busy
                    ? `${processed.toLocaleString()} / ${total.toLocaleString()} targets · batch ${progress?.currentBatch ?? 0}/${progress?.batchesTotal ?? 0}`
                    : `${selectedPendingTargets.toLocaleString()} targets · ~${estimatedCredits.toFixed(1)} / ${DUNE_CREDIT_BUDGET.toLocaleString()} credits`}
                </span>
              </div>
              {busy && (
                <progress max={total || 1} value={processed} aria-label="Dune fetch progress" />
              )}
              {busy && (
                <small>
                  {progress?.message ?? 'Preparing Dune request'}
                  {phase ? ` · ${phase}` : ''}
                  {progress?.storedTargets !== undefined
                    ? ` · ${progress.storedTargets.toLocaleString()} saved`
                    : ''}
                  {progress?.failedTargets ? ` · ${progress.failedTargets} failed` : ''}
                </small>
              )}
              {!busy && selectedPendingTargets > 0 && (
                <small>
                  {DUNE_CREDITS_PER_TARGET.toFixed(2)} credits per target · budget use{' '}
                  {budgetPercent.toFixed(1)}%
                  {estimatedCredits > DUNE_CREDIT_BUDGET ? ' · over budget' : ''}
                </small>
              )}
            </div>
          );
        })()}
      {message && (
        <p className="copytrade-status-warning" role="status">
          {message}
        </p>
      )}
      <div className="table-wrap">
        <table className="copytrade-data-fetch-table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="Select all visible candidates"
                  checked={visible.length > 0 && selectedVisible.length === visible.length}
                  onChange={toggleAll}
                />
              </th>
              <th>
                <button
                  type="button"
                  className="sortable-header"
                  onClick={() => toggleSort('wallet')}
                >
                  Wallet{sortIndicator('wallet')}
                </button>
              </th>
              <th>
                <button
                  type="button"
                  className="sortable-header"
                  onClick={() => toggleSort('rank')}
                >
                  Rank{sortIndicator('rank')}
                </button>
              </th>
              <th>
                <button
                  type="button"
                  className="sortable-header"
                  onClick={() => toggleSort('screen')}
                >
                  GMGN screen{sortIndicator('screen')}
                </button>
              </th>
              <th>
                <button
                  type="button"
                  className="sortable-header"
                  onClick={() => toggleSort('trades')}
                >
                  Trades{sortIndicator('trades')}
                </button>
              </th>
              <th>
                <button type="button" className="sortable-header" onClick={() => toggleSort('pnl')}>
                  Realized P&amp;L{sortIndicator('pnl')}
                </button>
              </th>
              <th>
                <button
                  type="button"
                  className="sortable-header"
                  onClick={() => toggleSort('winRate')}
                >
                  Win rate{sortIndicator('winRate')}
                </button>
              </th>
              <th>
                <button
                  type="button"
                  className="sortable-header"
                  onClick={() => toggleSort('pending')}
                >
                  Pending Dune{sortIndicator('pending')}
                </button>
              </th>
              <th>
                <button
                  type="button"
                  className="sortable-header"
                  onClick={() => toggleSort('score')}
                >
                  Pre-Dune GMGN score{sortIndicator('score')}
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((candidate) => (
              <tr key={candidate.walletAddress}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(candidate.walletAddress)}
                    disabled={candidate.pendingTargets <= 0 || busy}
                    onChange={() =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(candidate.walletAddress)) next.delete(candidate.walletAddress);
                        else next.add(candidate.walletAddress);
                        return next;
                      })
                    }
                  />
                </td>
                <td>
                  <a
                    className="gmgn-wallet-link"
                    href={gmgnWalletUrl(candidate.walletAddress)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <strong>{candidate.name || candidate.walletAddress.slice(0, 10)}</strong>
                    <small title={candidate.walletAddress}>
                      {shortWalletAddress(candidate.walletAddress)}
                    </small>
                  </a>
                </td>
                <td>{candidate.rank ?? '—'}</td>
                <td>{candidate.gmgnScreen.classification}</td>
                <td>{candidate.tradeCount}</td>
                <td>
                  {candidate.realizedPnlUsd === null
                    ? '—'
                    : `$${candidate.realizedPnlUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                </td>
                <td>
                  {candidate.winRatePercent === null
                    ? '—'
                    : `${candidate.winRatePercent.toFixed(1)}%`}
                </td>
                <td>{candidate.pendingTargets}</td>
                <td>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="copytrade-score-tooltip-trigger"
                        aria-label="Explain pre-Dune score"
                      >
                        {candidate.preDuneScore === null
                          ? '—'
                          : `${Math.round(candidate.preDuneScore)} / ${Math.round(candidate.preDuneScoreMax)}`}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" align="end">
                      <strong>Pre-Dune score</strong>
                      {candidate.preDuneScoreBreakdown.map((line, index) => (
                        <div key={`${candidate.walletAddress}-score-${index}`}>{line}</div>
                      ))}
                    </TooltipContent>
                  </Tooltip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
