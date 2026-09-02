import { FormattedDate } from '../FormattedDate.js';
import { StatusPill } from '../StatusPill.js';
import type { DataWorkflowMetadataProgress } from './dataWorkflowTypes.js';
export type { DataWorkflowMetadataProgress } from './dataWorkflowTypes.js';

export type MetadataFetchProgressPanelProps = {
  progress: DataWorkflowMetadataProgress | null;
};

const numberFormatter = new Intl.NumberFormat('en-CA');

const statusTone = (status: DataWorkflowMetadataProgress['status']): string => {
  if (status === 'completed') return 'pass';
  if (status === 'failed') return 'fail';
  if (status === 'running') return 'active';
  return 'insufficient_evidence';
};

const statusLabel = (status: DataWorkflowMetadataProgress['status']): string =>
  status.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());

export function MetadataFetchProgressPanel({ progress }: MetadataFetchProgressPanelProps) {
  if (!progress)
    return <p className="muted">Wallet metadata fetch progress is not available yet.</p>;

  const total = Math.max(0, progress.walletsTotal);
  const done = Math.min(total, Math.max(0, progress.walletsDone));
  const percent = total > 0 ? Math.min(100, (done / total) * 100) : 0;

  return (
    <div className="copytrade-fetch-progress" role="status" aria-live="polite">
      <div className="copytrade-fetch-progress-head">
        <strong>GMGN wallet metadata</strong>
        <span>
          <StatusPill status={statusTone(progress.status)}>
            {statusLabel(progress.status)}
          </StatusPill>
        </span>
      </div>
      <progress max={100} value={percent} aria-label="Wallet metadata fetch progress" />
      <div className="copytrade-fetch-progress-meta">
        <small>
          {percent.toFixed(0)}% · {numberFormatter.format(done)} / {numberFormatter.format(total)}{' '}
          wallets
        </small>
        <small>
          {numberFormatter.format(progress.requestsUsed)} requests ·{' '}
          {numberFormatter.format(progress.skippedFresh)} skipped (already fresh)
        </small>
      </div>
      <div className="copytrade-workflow-utility">
        <span>
          Started: <FormattedDate value={progress.startedAt} /> · completed:{' '}
          <FormattedDate value={progress.completedAt} />
        </span>
      </div>
      {progress.error && (
        <p className="error-message" role="alert">
          {progress.error}
        </p>
      )}
    </div>
  );
}
