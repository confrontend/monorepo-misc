import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../../httpClient.js';
import { DataCandidateFetchPanel } from './DataCandidateFetchPanel.js';
import { GmgnHistorySelectionPanel } from './GmgnHistorySelectionPanel.js';

type FetchStatus = {
  status?: string;
  running?: boolean;
  traderLimit?: number;
  walletTotal?: number;
  walletDone?: number;
  tradesFetched?: number;
  error?: string | null;
  runId?: number | null;
  requestsMade?: number;
  tradesDuplicate?: number;
  pagesFetchedTotal?: number;
  currentWalletAddress?: string | null;
  currentWalletPages?: number | null;
  currentWalletProgressPercent?: number | null;
  elapsedSeconds?: number | null;
  estimatedRemainingSeconds?: number | null;
  rosterCapturedAt?: string | null;
  phase?: string | null;
  stalled?: boolean;
  requestsStarted?: number;
  requestsCompleted?: number;
  expectedTradesTotal?: number | null;
  storedTradesTotal?: number | null;
  walletsWithNewData?: number;
  walletsAlreadyCurrent?: number;
  currentWalletExpectedTrades?: number | null;
  currentWalletStoredTrades?: number | null;
  estimateExceeded?: boolean;
};
type StatsStatus = {
  running?: boolean;
  status?: string;
  walletDone?: number;
  walletTotal?: number;
  requestsMade?: number;
  error?: string | null;
};

type DataWorkflowProps = { api: ApiClient; chain?: string };
const ROSTER_LIMIT = 100;

const formatDuration = (seconds: number): string => {
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
};

const describeFetch = (status: FetchStatus | null): string => {
  if (!status) return 'No GMGN fetch has been started.';
  if (status.running) {
    const done = status.walletDone ?? 0;
    const total = status.walletTotal ?? status.traderLimit ?? ROSTER_LIMIT;
    return `${status.stalled ? 'No progress detected' : 'Fetching GMGN history'} · ${done}/${total} wallets`;
  }
  if (status.error) return status.error;
  if (status.status === 'completed') {
    return `GMGN history is current${status.tradesFetched === undefined ? '' : ` · ${status.tradesFetched.toLocaleString()} trades saved`}.`;
  }
  return status.status ? `GMGN fetch ${status.status}.` : 'No GMGN fetch has been started.';
};

export function DataWorkflow({ api, chain = 'sol' }: DataWorkflowProps) {
  const [status, setStatus] = useState<FetchStatus | null>(null);
  const [statsStatus, setStatsStatus] = useState<StatsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'import' | 'fetch' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    const result = await api<FetchStatus>('/api/copytrade/fetch/status');
    setStatus(result);
    const stats = await api<StatsStatus>('/api/copytrade/stats/status');
    setStatsStatus(stats);
    return result;
  }, [api]);

  useEffect(() => {
    let disposed = false;
    void loadStatus()
      .catch((error) => {
        if (!disposed)
          setMessage(error instanceof Error ? error.message : 'Could not read GMGN status.');
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [loadStatus]);

  useEffect(() => {
    // Stage 2 history fetches are started by the child panel. Keep polling while
    // that panel reports a request in flight, even before the first status refresh
    // has observed `status.running`.
    if (!status?.running && !statsStatus?.running && !historyBusy) return undefined;
    const timer = window.setInterval(() => {
      void loadStatus().catch(() => undefined);
    }, 1500);
    void loadStatus().catch(() => undefined);
    return () => window.clearInterval(timer);
  }, [historyBusy, loadStatus, status?.running, statsStatus?.running]);

  useEffect(() => {
    if (historyBusy && status && !status.running) setHistoryBusy(false);
  }, [historyBusy, status]);

  useEffect(() => {
    if (
      statsStatus &&
      !statsStatus.running &&
      message ===
        'GMGN summary fetch started. Select wallets below when it finishes to fetch history.'
    ) {
      setMessage(null);
    }
  }, [message, statsStatus]);

  const importRoster = async (file: File) => {
    setBusy('import');
    setMessage(null);
    try {
      await api('/api/copytrade/roster/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: file.name, content: await file.text() }),
      });
      setMessage('Roster imported.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not import the roster.');
    } finally {
      setBusy(null);
    }
  };

  const refreshAndFetch = async () => {
    setBusy('fetch');
    setMessage(null);
    try {
      await api('/api/copytrade/stats/fetch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ limit: ROSTER_LIMIT }),
      });
      setMessage(
        'GMGN summary fetch started. Select wallets below when it finishes to fetch history.',
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'GMGN summary fetch could not start.');
    } finally {
      setBusy(null);
    }
  };

  const stopGmgn = async () => {
    setBusy('fetch');
    try {
      await api('/api/copytrade/fetch/stop', { method: 'POST' });
      await loadStatus();
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="copytrade-research-route" aria-labelledby="gmgn-data-title">
      <div className="copytrade-results-meta">
        <div>
          <p className="eyebrow">GMGN DATA</p>
          <h2 id="gmgn-data-title">Collect GMGN evidence</h2>
          <p>
            Import a roster, fetch lightweight GMGN summaries, then choose which wallets deserve
            full history and Dune analysis.
          </p>
          <p className="copytrade-status-warning">
            Stage 1 does not fetch full activity history. It only loads summary data for the saved
            roster so you can choose the history workload.
          </p>
        </div>
        <span className="copytrade-workflow-status">
          <strong>
            {loading ? 'Loading…' : status?.running || statsStatus?.running ? 'Fetching' : 'Ready'}
          </strong>
        </span>
      </div>
      <div className="copytrade-workflow-actions">
        <div className="copytrade-workflow-row">
          <div className="copytrade-workflow-status">
            <strong>History depth: Maximum available</strong>
            <small>GMGN fetches as far back as the provider makes available.</small>
            <small>
              Roster snapshot:{' '}
              {status?.rosterCapturedAt
                ? new Date(status.rosterCapturedAt).toLocaleString()
                : 'No imported roster available'}
            </small>
          </div>
          <div className="copytrade-workflow-inline-actions">
            <label className="secondary copytrade-file-button">
              {busy === 'import' ? 'Importing…' : 'Import roster JSON'}
              <input
                type="file"
                accept="application/json,.json"
                disabled={
                  busy !== null || status?.running === true || statsStatus?.running === true
                }
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (file) void importRoster(file);
                }}
              />
            </label>
            <button
              type="button"
              className="primary"
              onClick={() => void refreshAndFetch()}
              disabled={busy !== null || status?.running === true || statsStatus?.running === true}
            >
              {busy === 'fetch' ? 'Fetching GMGN summaries…' : 'Fetch GMGN summaries'}
            </button>
            {status?.running && (
              <button
                type="button"
                className="secondary"
                onClick={() => void stopGmgn()}
                disabled={busy !== null}
              >
                Stop
              </button>
            )}
          </div>
        </div>
        <p className="copytrade-fetch-status" role="status">
          {statsStatus?.running
            ? `Fetching GMGN summaries · ${statsStatus.walletDone ?? 0}/${statsStatus.walletTotal ?? ROSTER_LIMIT} wallets`
            : statsStatus?.status === 'failed'
              ? (statsStatus.error ?? 'GMGN summary fetch failed.')
              : status?.running || !status?.runId
                ? describeFetch(status)
                : 'Ready'}
        </p>
        {status?.running && (
          <div className="copytrade-fetch-detail" role="status" aria-label="GMGN fetch progress">
            <div className="copytrade-fetch-detail-header">
              <strong>
                Wallet {Math.min((status.walletDone ?? 0) + 1, status.walletTotal ?? 0)} /{' '}
                {status.walletTotal ?? 0}
              </strong>
              <span>
                {status.currentWalletProgressPercent == null
                  ? 'Progress from saved rows'
                  : `${status.currentWalletProgressPercent.toFixed(0)}% current wallet`}
              </span>
            </div>
            <progress max={status.walletTotal || 1} value={status.walletDone ?? 0} />
            <small>
              {status.currentWalletAddress
                ? `Current: ${status.currentWalletAddress.slice(0, 8)}…${status.currentWalletAddress.slice(-6)} · `
                : ''}
              {status.currentWalletPages ?? 0} pages ·{' '}
              {status.requestsCompleted ?? status.requestsMade ?? 0}/
              {status.requestsStarted ?? status.requestsMade ?? 0} GMGN requests ·{' '}
              {(status.tradesFetched ?? 0).toLocaleString()} new ·{' '}
              {(status.tradesDuplicate ?? 0).toLocaleString()} duplicates skipped ·{' '}
              {(status.storedTradesTotal ?? 0).toLocaleString()} total saved
              {status.phase ? ` · ${status.phase.replaceAll('_', ' ')}` : ''}
            </small>
            <small>
              Workload estimate:{' '}
              {status.expectedTradesTotal == null
                ? 'unavailable'
                : `${status.expectedTradesTotal.toLocaleString()} trades across ${status.walletTotal ?? 0} wallets`}
              {status.estimateExceeded
                ? ' (estimate already exceeded; remaining count is not reliable)'
                : ''}
              {status.currentWalletExpectedTrades != null
                ? ` · current wallet estimate ${status.currentWalletExpectedTrades.toLocaleString()}, stored ${status.currentWalletStoredTrades?.toLocaleString() ?? '0'}`
                : ''}
            </small>
            <small>
              {status.elapsedSeconds == null
                ? ''
                : `Elapsed ${formatDuration(status.elapsedSeconds)}`}
              {status.estimatedRemainingSeconds == null
                ? ''
                : ` · about ${formatDuration(status.estimatedRemainingSeconds)} remaining`}
            </small>
          </div>
        )}
        {status?.runId && !status.running && status.status !== 'idle' && (
          <p className="copytrade-fetch-status" role="status">
            Last history fetch: {(status.status ?? 'finished').trim()} ·{' '}
            {status.requestsCompleted ?? status.requestsMade ?? 0} requests ·{' '}
            {(status.tradesFetched ?? 0).toLocaleString()} new ·{' '}
            {(status.tradesDuplicate ?? 0).toLocaleString()} duplicates skipped.
          </p>
        )}
        {message && (
          <p className="copytrade-status-warning" role="status">
            {message}
          </p>
        )}
      </div>
      <GmgnHistorySelectionPanel
        api={api}
        busy={historyBusy || status?.running === true}
        completed={status?.status === 'completed' && status.running !== true}
        onBusyChange={setHistoryBusy}
      />
      <DataCandidateFetchPanel api={api} />
    </section>
  );
}
