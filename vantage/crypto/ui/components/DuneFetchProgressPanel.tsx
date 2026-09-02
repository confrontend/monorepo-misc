import type { CopySimulationRunStatus } from '../types.js';

type DuneFetchProgressPanelProps = {
  status: CopySimulationRunStatus;
  onStop: () => void;
  stopBusy: boolean;
};

const formatDuration = (seconds: number | null): string => {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const safeSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return minutes ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
};

const requestPhaseLabel = (phase: CopySimulationRunStatus['duneRequestPhase']): string => {
  switch (phase) {
    case 'status_requesting':
      return 'Checking query status';
    case 'status_received':
      return 'Query status received';
    case 'results_requesting':
      return 'Downloading Dune results';
    case 'results_received':
      return 'Results received';
    default:
      return 'Preparing request';
  }
};

export const DuneFetchProgressPanel = ({
  status,
  onStop,
  stopBusy,
}: DuneFetchProgressPanelProps) => {
  const total = Math.max(0, status.targetsTotal);
  const processed = Math.min(total, Math.max(0, status.targetsProcessed));
  const progress = total > 0 ? Math.min(100, (processed / total) * 100) : 0;
  const elapsedSeconds = Math.max(0, status.duneElapsedSeconds ?? 0);
  const rate = processed > 0 && elapsedSeconds > 0 ? processed / elapsedSeconds : null;
  const estimatedRemaining = rate ? Math.ceil(Math.max(0, total - processed) / rate) : null;
  const duneState = status.duneState?.replace(/^QUERY_STATE_/, '').toLowerCase() ?? 'submitting';

  return (
    <div className="dune-fetch-progress" role="status" aria-live="polite">
      <div className="dune-fetch-progress-heading">
        <div>
          <strong>Dune diagnostics in progress</strong>
          <span>{status.message}</span>
        </div>
        <button
          type="button"
          className="secondary copytrade-stop-button"
          onClick={onStop}
          disabled={stopBusy}
        >
          {stopBusy ? 'Stopping…' : 'Stop fetch'}
        </button>
      </div>
      <progress max={100} value={progress} aria-label="Dune diagnostics fetch progress" />
      <div className="dune-fetch-progress-summary">
        <strong>{progress.toFixed(0)}%</strong>
        <span>
          {processed.toLocaleString()} / {total.toLocaleString()} targets processed
        </span>
      </div>
      <div className="dune-fetch-progress-grid">
        <span>
          <b>Batch</b>
          {status.currentBatch || '—'} / {status.batchesTotal || '—'}
        </span>
        <span>
          <b>Stored</b>
          {status.storedTargets.toLocaleString()}
        </span>
        <span>
          <b>Failed</b>
          {status.failedTargets.toLocaleString()}
        </span>
        <span>
          <b>Remaining</b>
          {status.remainingTargets.toLocaleString()}
        </span>
        <span>
          <b>Phase</b>
          {requestPhaseLabel(status.duneRequestPhase)}
        </span>
        <span>
          <b>Dune state</b>
          {duneState}
        </span>
        <span>
          <b>Elapsed</b>
          {formatDuration(elapsedSeconds)}
        </span>
        <span>
          <b>Estimated remaining</b>
          {formatDuration(estimatedRemaining)}
        </span>
      </div>
    </div>
  );
};
