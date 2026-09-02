import type { ReactNode } from 'react';
import { FormattedDate } from '../FormattedDate.js';
import { StatusPill } from '../StatusPill.js';
import { WorkflowStep } from '../WorkflowStep.js';
import type {
  DataWorkflowStepKey,
  DataWorkflowStepResponse,
  DataWorkflowStepStatus,
} from './dataWorkflowTypes.js';
export type {
  DataWorkflowStepKey,
  DataWorkflowStepResponse,
  DataWorkflowStepStatus,
} from './dataWorkflowTypes.js';

export type DataWorkflowStepDefinition = {
  key: DataWorkflowStepKey;
  title: string;
  description: string;
};

export const DATA_WORKFLOW_STEP_DEFINITIONS: DataWorkflowStepDefinition[] = [
  {
    key: 'roster',
    title: 'Freeze roster',
    description: 'Select and preserve the wallet roster for this run.',
  },
  {
    key: 'wallet_metadata',
    title: 'Capture wallet metadata',
    description: 'Save names, ranks, tags, and official wallet snapshots with timestamps.',
  },
  {
    key: 'activity_history',
    title: 'Fetch activity history',
    description: 'Walk each wallet’s GMGN activity pages through the requested history window.',
  },
  {
    key: 'coverage_verification',
    title: 'Verify history coverage',
    description: 'Check cursor completion, available depth, gaps, and retryable wallets.',
  },
  {
    key: 'dune_outcomes',
    title: 'Collect Dune outcomes',
    description: 'Attach delayed-copy outcome evidence after the GMGN observation window.',
  },
  {
    key: 'readiness',
    title: 'Assess dataset readiness',
    description: 'Report which wallets and evidence meet the declared analysis requirements.',
  },
];

export type DataWorkflowStepProps = {
  definition: DataWorkflowStepDefinition;
  step: DataWorkflowStepResponse;
  onAction?: () => void;
  actionLabel?: string;
  actionDisabled?: boolean;
  actionDisabledReason?: string | null;
  children?: ReactNode;
  action?: DataWorkflowStepResponse['action'];
};

const numberFormatter = new Intl.NumberFormat('en-CA');

const statusLabel = (status: DataWorkflowStepStatus): string =>
  status.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());

const statusTone = (status: DataWorkflowStepStatus): string => {
  if (status === 'completed') return 'pass';
  if (status === 'completed_with_warnings') return 'insufficient_evidence';
  if (status === 'failed') return 'fail';
  if (status === 'running') return 'active';
  if (status === 'paused') return 'insufficient_evidence';
  return 'missing';
};

export function DataWorkflowStep({
  definition,
  step,
  onAction,
  actionLabel,
  actionDisabled = false,
  actionDisabledReason,
  children,
  action,
}: DataWorkflowStepProps) {
  const disabledReason = actionDisabledReason ?? step.disabledReason;
  const isDuneOutcomeStep = definition.key === 'dune_outcomes';
  const hasWalletProgress = step.walletsTotal > 0;
  const walletProgress = hasWalletProgress
    ? `${numberFormatter.format(step.walletsDone)} / ${numberFormatter.format(step.walletsTotal)} ${isDuneOutcomeStep ? 'targets' : 'wallets'}`
    : null;

  return (
    <article
      className="copytrade-method-card"
      aria-labelledby={`data-workflow-step-${step.stepKey}`}
    >
      <div className="copytrade-results-meta">
        <div className="copytrade-workflow-label">
          <WorkflowStep number={step.stepOrder} title={definition.title} />
          <div>
            <strong id={`data-workflow-step-${step.stepKey}`}>{definition.title}</strong>
            <small>{definition.description}</small>
          </div>
        </div>
        <StatusPill status={statusTone(step.status)}>{statusLabel(step.status)}</StatusPill>
      </div>

      <div className="copytrade-update-summary-grid" aria-label={`${definition.title} details`}>
        <div>
          <b>{numberFormatter.format(step.recordsTotal)}</b>
          <span>{isDuneOutcomeStep ? 'Targets' : 'Records'}</span>
          {step.recordsNew > 0 && <small>{numberFormatter.format(step.recordsNew)} new</small>}
        </div>
        <div>
          <b>{walletProgress ?? '—'}</b>
          <span>{isDuneOutcomeStep ? 'Target progress' : 'Wallet progress'}</span>
          {step.walletsFailed > 0 && (
            <small>
              {numberFormatter.format(step.walletsFailed)}{' '}
              {isDuneOutcomeStep ? 'no-match targets' : 'failed'}
            </small>
          )}
        </div>
        <div>
          <b>{step.underlyingRunId === null ? '—' : `#${step.underlyingRunId}`}</b>
          <span>Source run</span>
          <small>{step.underlyingRunKind ?? 'No linked run'}</small>
        </div>
        <div>
          <b>
            <FormattedDate value={step.lastSuccessAt ?? step.completedAt ?? step.updatedAt} />
          </b>
          <span>Last success</span>
        </div>
      </div>

      {hasWalletProgress && (
        <div className="copytrade-fetch-progress" role="status" aria-live="polite">
          <progress
            max={100}
            value={Math.min(100, Math.max(0, (step.walletsDone / step.walletsTotal) * 100))}
            aria-label={`${definition.title} progress`}
          />
          <div className="copytrade-fetch-progress-meta">
            <small>
              {Math.min(100, Math.max(0, (step.walletsDone / step.walletsTotal) * 100)).toFixed(0)}%
              {' · '}
              {walletProgress}
            </small>
            <small>
              {step.status === 'completed' || step.status === 'completed_with_warnings'
                ? 'Saved step result'
                : step.status === 'running'
                  ? 'Current step progress'
                  : 'Available evidence'}
            </small>
          </div>
        </div>
      )}

      {disabledReason && (
        <p className="muted" role="note">
          Disabled: {disabledReason}
        </p>
      )}
      {step.error && (
        <p className="error-message" role="alert">
          {step.error}
        </p>
      )}
      {step.warnings.length > 0 && (
        <div className="copytrade-update-changes" role="note">
          {step.warnings.map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
        </div>
      )}
      {children}
      {action && (
        <button
          type="button"
          className="secondary"
          onClick={onAction}
          disabled={!onAction || actionDisabled || !action.allowed}
          title={action.message ?? undefined}
        >
          {action.allowed ? (actionLabel ?? 'Run step') : (action.message ?? 'Unavailable')}
        </button>
      )}
    </article>
  );
}
