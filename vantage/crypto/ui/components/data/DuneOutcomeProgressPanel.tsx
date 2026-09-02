import { FormattedDate } from '../FormattedDate.js';
import { StatusPill } from '../StatusPill.js';
import type { DataWorkflowDuneProgress, DataWorkflowStepResponse } from './dataWorkflowTypes.js';
export type { DataWorkflowDuneProgress } from './dataWorkflowTypes.js';

export type DuneOutcomeProgressPanelProps = {
  progress: DataWorkflowDuneProgress | null;
  step: Pick<
    DataWorkflowStepResponse,
    'status' | 'recordsTotal' | 'walletsDone' | 'startedAt' | 'completedAt' | 'updatedAt'
  >;
};

const numberFormatter = new Intl.NumberFormat('en-CA');

const statusTone = (status: DataWorkflowDuneProgress['status']): string => {
  if (status === 'completed') return 'pass';
  if (status === 'completed_with_warnings') return 'insufficient_evidence';
  if (status === 'failed') return 'fail';
  if (status === 'running') return 'active';
  return 'insufficient_evidence';
};

const statusLabel = (status: DataWorkflowDuneProgress['status']): string =>
  status.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());

export function DuneOutcomeProgressPanel({ progress, step }: DuneOutcomeProgressPanelProps) {
  const stepCompleted = step.status === 'completed' || step.status === 'completed_with_warnings';
  // Dune progress is in-memory and disappears after completion or a server restart. For a
  // completed step, the persisted step totals are authoritative; never render an empty
  // transient object as a misleading 0 / 0 result.
  const persistedProgress: DataWorkflowDuneProgress | null = stepCompleted
    ? {
        status: step.status,
        targetsTotal: step.recordsTotal,
        targetsProcessed: step.walletsDone,
        batchesRun: 0,
        batchesTotal: 0,
        currentBatch: 0,
        startedAt: step.startedAt ?? step.updatedAt,
        updatedAt: step.updatedAt,
        completedAt: step.completedAt ?? step.updatedAt,
        error: null,
      }
    : null;
  const effectiveProgress =
    progress && (progress.targetsTotal > 0 || !stepCompleted) ? progress : persistedProgress;

  if (!effectiveProgress)
    return <p className="muted">Dune outcome fetch progress is not available yet.</p>;

  const total = Math.max(0, effectiveProgress.targetsTotal);
  const done = Math.min(total, Math.max(0, effectiveProgress.targetsProcessed));
  const percent = total > 0 ? Math.min(100, (done / total) * 100) : 0;

  return (
    <div className="copytrade-fetch-progress" role="status" aria-live="polite">
      <div className="copytrade-fetch-progress-head">
        <strong>Dune delayed-copy outcomes</strong>
        <span>
          <StatusPill status={statusTone(effectiveProgress.status)}>
            {statusLabel(effectiveProgress.status)}
          </StatusPill>
        </span>
      </div>
      <progress max={100} value={percent} aria-label="Dune outcome fetch progress" />
      <div className="copytrade-fetch-progress-meta">
        <small>
          {percent.toFixed(0)}% · {numberFormatter.format(done)} / {numberFormatter.format(total)}{' '}
          targets
        </small>
        <small>
          {effectiveProgress.batchesTotal > 0
            ? `Batch ${numberFormatter.format(effectiveProgress.currentBatch)} of ${numberFormatter.format(effectiveProgress.batchesTotal)} · ${numberFormatter.format(effectiveProgress.batchesRun)} completed`
            : 'Batch details unavailable after completion'}
        </small>
      </div>
      <div className="copytrade-workflow-utility">
        <span>
          Started: <FormattedDate value={effectiveProgress.startedAt} /> · completed:{' '}
          <FormattedDate value={effectiveProgress.completedAt} />
        </span>
      </div>
      {effectiveProgress.error && (
        <p className="error-message" role="alert">
          {effectiveProgress.error}
        </p>
      )}
    </div>
  );
}
