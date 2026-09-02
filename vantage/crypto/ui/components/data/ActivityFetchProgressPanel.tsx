import { FormattedDate } from '../FormattedDate.js';
import { StatusPill } from '../StatusPill.js';
import type { ActivityFetchProgressResponse, ActivityFetchStatus } from './dataWorkflowTypes.js';
export type { ActivityFetchProgressResponse, ActivityFetchStatus } from './dataWorkflowTypes.js';

export type ActivityFetchProgressPanelProps = {
  progress: ActivityFetchProgressResponse | null;
  loading?: boolean;
  error?: string | null;
};

const numberFormatter = new Intl.NumberFormat('en-CA');

const formatDuration = (seconds: number | null): string => {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const safeSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainder = safeSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${String(remainder).padStart(2, '0')}s`;
};

const statusTone = (status: ActivityFetchStatus): string => {
  if (status === 'completed') return 'pass';
  if (status === 'completed_with_warnings') return 'insufficient_evidence';
  if (status === 'failed') return 'fail';
  if (status === 'running') return 'active';
  if (status === 'paused') return 'insufficient_evidence';
  return 'missing';
};

const statusLabel = (status: ActivityFetchStatus): string =>
  status.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());

export function ActivityFetchProgressPanel({
  progress,
  loading = false,
  error = null,
}: ActivityFetchProgressPanelProps) {
  if (loading && !progress) {
    return (
      <div className="copytrade-fetch-progress" role="status" aria-live="polite">
        <span className="loading-spinner" aria-hidden="true" /> Loading activity fetch progress…
      </div>
    );
  }
  if (error) {
    return (
      <p className="error-message" role="alert">
        {error}
      </p>
    );
  }
  if (!progress) return <p className="muted">Activity fetch progress is not available yet.</p>;

  const total = Math.max(0, progress.walletsTotal);
  const done = Math.min(total, Math.max(0, progress.walletsDone));
  const percent = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  const current = progress.currentWallet;

  return (
    <div className="copytrade-fetch-progress" role="status" aria-live="polite">
      <div className="copytrade-fetch-progress-head">
        <strong>{progress.message}</strong>
        <span>
          <StatusPill status={statusTone(progress.status)}>
            {statusLabel(progress.status)}
          </StatusPill>
        </span>
      </div>
      <progress max={100} value={percent} aria-label="Activity history fetch progress" />
      <div className="copytrade-fetch-progress-meta">
        <small>
          {percent.toFixed(0)}% · {numberFormatter.format(done)} / {numberFormatter.format(total)}{' '}
          wallets
        </small>
        <small>
          {formatDuration(progress.elapsedSeconds)} elapsed ·{' '}
          {formatDuration(progress.estimatedRemainingSeconds)} remaining
        </small>
      </div>
      <div className="copytrade-update-summary-grid" aria-label="Activity fetch diagnostics">
        <div>
          <b>{numberFormatter.format(progress.pagesFetched)}</b>
          <span>Pages fetched</span>
        </div>
        <div>
          <b>{numberFormatter.format(progress.activitiesFetched)}</b>
          <span>Activities fetched</span>
          <small>{numberFormatter.format(progress.recordsNew)} new rows saved</small>
        </div>
        <div>
          <b>{numberFormatter.format(progress.requestsUsed)}</b>
          <span>Provider requests</span>
          <small>{numberFormatter.format(progress.walletsFailed)} wallets failed</small>
        </div>
        <div>
          <b>{progress.phase ?? '—'}</b>
          <span>Current phase</span>
        </div>
      </div>
      {current && (
        <div className="copytrade-update-changes">
          <strong>Current wallet: {current.name?.trim() || current.walletAddress}</strong>
          <span>
            {numberFormatter.format(current.pagesFetched)} pages ·{' '}
            {numberFormatter.format(current.activitiesFetched)} activities
          </span>
          <span>
            Window reached: {current.reachesRequestedWindow ? 'Yes' : 'No'} · status:{' '}
            {current.status}
          </span>
          <small>
            Cursor: {current.cursor ?? 'start'} · next: {current.nextCursor ?? 'none'} · oldest:{' '}
            <FormattedDate value={current.oldestActivityAt} /> · newest:{' '}
            <FormattedDate value={current.newestActivityAt} />
          </small>
          {current.error && <small>{current.error}</small>}
        </div>
      )}
      <div className="copytrade-workflow-utility">
        <span>
          Requested window: <FormattedDate value={progress.requestedWindowStart} /> →{' '}
          <FormattedDate value={progress.requestedWindowEnd} />
        </span>
        <span>
          Started: <FormattedDate value={progress.startedAt} /> · updated:{' '}
          <FormattedDate value={progress.updatedAt} />
        </span>
      </div>
      {progress.error && (
        <p className="error-message" role="alert">
          {progress.error}
        </p>
      )}
      {progress.warnings.map((warning) => (
        <p className="muted" key={warning}>
          {warning}
        </p>
      ))}
    </div>
  );
}
