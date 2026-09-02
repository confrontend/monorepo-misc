import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useDataWorkflowStore } from '../../stores/dataWorkflowStore.js';
import { strings } from '../../strings.js';
import { FormattedDate } from '../FormattedDate.js';
import { StatusPill } from '../StatusPill.js';
import { ActivityFetchProgressPanel } from './ActivityFetchProgressPanel.js';
import { MetadataFetchProgressPanel } from './MetadataFetchProgressPanel.js';
import { DuneOutcomeProgressPanel } from './DuneOutcomeProgressPanel.js';
import {
  DataHistoryCoveragePanel,
  type DataHistoryCoverageResponse,
} from './DataHistoryCoveragePanel.js';
import {
  DATA_WORKFLOW_STEP_DEFINITIONS,
  DataWorkflowStep,
  type DataWorkflowStepResponse,
} from './DataWorkflowStep.js';
import { DatasetReadinessPanel, type DatasetReadinessResponse } from './DatasetReadinessPanel.js';
import { DataWorkflowWalletSelectionDialog } from './DataWorkflowWalletSelectionDialog.js';
import type { DataWorkflowRosterResponse } from './dataWorkflowRosterTypes.js';
import type {
  DataWorkflowProps,
  DataWorkflowRunStatus,
  DataWorkflowStatusResponse,
} from './dataWorkflowTypes.js';
import { deriveDataWorkflowUiState } from './dataWorkflowUiState.js';
export type {
  DataWorkflowProps,
  DataWorkflowRunStatus,
  DataWorkflowStatusResponse,
} from './dataWorkflowTypes.js';

const BASE_ENDPOINT = '/api/copytrade/data-workflow';
const TARGET_PERIODS = [30, 60, 90] as const;
const POLL_INTERVAL_MS = 3000;

const COPY = {
  title: 'Data workflow',
  description:
    'One resumable pipeline for roster, wallet evidence, activity history, coverage verification, outcomes, and readiness.',
  loading: 'Loading data workflow…',
  statusError: 'Data workflow status could not be loaded.',
  start: 'Create workflow run',
  starting: 'Creating run…',
  pause: 'Pause workflow',
  pausing: 'Pausing…',
  resume: 'Resume workflow',
  resuming: 'Resuming…',
  finish: strings.dataWorkflow.finish,
  finishing: strings.dataWorkflow.finishing,
  cancel: strings.dataWorkflow.cancel,
  cancelling: strings.dataWorkflow.cancelling,
  stopping: 'Stopping…',
  refresh: 'Refresh status',
  refreshing: 'Refreshing…',
} as const;

const numberFormatter = new Intl.NumberFormat('en-CA');

const queryFor = (chain: string, targetDays: number, runId?: number): string => {
  const query = new URLSearchParams({ chain, targetDays: String(targetDays) });
  if (runId !== undefined) query.set('runId', String(runId));
  return query.toString();
};

const actionError = (reason: unknown): string =>
  reason instanceof Error ? reason.message : 'The data workflow request failed.';

const phaseLabel = (phase: string): string => {
  if (phase === 'ready_for_step') return 'Ready for next step';
  if (phase === 'running_step') return 'Running';
  return phase.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
};

const workflowLabel = (phase: string, status: DataWorkflowRunStatus | undefined): string => {
  if (status === 'abandoned') return 'Cancelled';
  if (status === 'completed_with_warnings') return 'Finished with warnings';
  return phaseLabel(phase);
};

export function DataWorkflow({
  api,
  chain = 'sol',
  initialTargetDays = 30,
  traderLimit = 100,
}: DataWorkflowProps) {
  const {
    targetDays,
    statusResponse,
    coverage,
    readiness,
    loadingStatus,
    loadingCoverage,
    loadingReadiness,
    error,
    coverageError,
    readinessError,
    rosterResponse,
    loadingRoster,
    rosterLoadError,
    selectedWallets,
    walletSelectionOpen,
    busyAction,
    rosterBusy,
    rosterError,
    retryingWallet,
    reset,
    setTargetDays,
    setStatusResponse,
    setCoverage,
    setReadiness,
    setLoadingStatus,
    setLoadingCoverage,
    setLoadingReadiness,
    setError,
    setCoverageError,
    setReadinessError,
    setRosterResponse,
    setLoadingRoster,
    setRosterLoadError,
    setSelectedWallets,
    toggleWallet,
    setWalletSelectionOpen,
    setBusyAction,
    setRosterBusy,
    setRosterError,
    setRetryingWallet,
  } = useDataWorkflowStore();
  const statusPollInFlight = useRef(false);
  useEffect(() => reset(initialTargetDays), [initialTargetDays, reset]);
  const workflowRunId = statusResponse?.run?.id;

  const loadStatus = useCallback(async () => {
    const result = await api<DataWorkflowStatusResponse>(
      `${BASE_ENDPOINT}/status?${queryFor(chain, targetDays)}`,
    );
    setStatusResponse(result);
    if (result.targetDays === 30 || result.targetDays === 60 || result.targetDays === 90) {
      setTargetDays(result.targetDays);
    }
    setError(null);
    return result;
  }, [api, chain, targetDays]);

  const loadCoverage = useCallback(async () => {
    setLoadingCoverage(true);
    try {
      const result = await api<DataHistoryCoverageResponse>(
        `${BASE_ENDPOINT}/coverage?${queryFor(chain, targetDays, workflowRunId)}`,
      );
      setCoverage(result);
      setCoverageError(null);
    } catch (reason: unknown) {
      setCoverageError(actionError(reason));
    } finally {
      setLoadingCoverage(false);
    }
  }, [api, chain, targetDays, workflowRunId]);

  const loadReadiness = useCallback(async () => {
    setLoadingReadiness(true);
    try {
      const result = await api<DatasetReadinessResponse>(
        `${BASE_ENDPOINT}/readiness?${queryFor(chain, targetDays, workflowRunId)}`,
      );
      setReadiness(result);
      setReadinessError(null);
    } catch (reason: unknown) {
      setReadinessError(actionError(reason));
    } finally {
      setLoadingReadiness(false);
    }
  }, [api, chain, targetDays, workflowRunId]);

  const loadRoster = useCallback(async () => {
    setLoadingRoster(true);
    try {
      const result = await api<DataWorkflowRosterResponse>(
        `${BASE_ENDPOINT}/roster?${new URLSearchParams({
          chain,
          limit: String(traderLimit),
          periodDays: String(targetDays),
        })}`,
      );
      setRosterResponse(result);
      setSelectedWallets(new Set(result.wallets.map((wallet) => wallet.walletAddress)));
      setRosterLoadError(null);
    } catch (reason: unknown) {
      setRosterLoadError(actionError(reason));
    } finally {
      setLoadingRoster(false);
    }
  }, [api, chain, targetDays, traderLimit]);

  useEffect(() => {
    let disposed = false;
    setLoadingStatus(true);
    void loadStatus()
      .catch((reason: unknown) => {
        if (!disposed) setError(actionError(reason));
      })
      .finally(() => {
        if (!disposed) setLoadingStatus(false);
      });
    return () => {
      disposed = true;
    };
  }, [loadStatus]);

  useEffect(() => {
    void loadRoster();
  }, [loadRoster]);

  useEffect(() => {
    const activeTargetDays =
      statusResponse?.run?.status === 'active' ? statusResponse.run.targetDays : null;
    if (activeTargetDays !== null && activeTargetDays !== targetDays) {
      setTargetDays(activeTargetDays);
    }
  }, [statusResponse?.run?.status, statusResponse?.run?.targetDays, targetDays]);

  const { activeRun, phase, isActive, isPaused, linkedGmgnJob, externalGmgnJob, externalBlockers } =
    deriveDataWorkflowUiState(statusResponse);
  const activityProgress = linkedGmgnJob?.progress ?? null;
  const startAction = statusResponse?.actions.start;
  const pauseAction = statusResponse?.actions.pause;
  const resumeAction = statusResponse?.actions.resume;
  const finishAction = statusResponse?.actions.finish;
  const cancelAction = statusResponse?.actions.cancel;
  const startDisabledReason = startAction?.allowed === false ? startAction.message : null;
  const pauseDisabledReason = pauseAction?.allowed === false ? pauseAction.message : null;
  const resumeDisabledReason = resumeAction?.allowed === false ? resumeAction.message : null;
  const finishDisabledReason = finishAction?.allowed === false ? finishAction.message : null;
  const cancelDisabledReason = cancelAction?.allowed === false ? cancelAction.message : null;

  useEffect(() => {
    if (!statusResponse?.shouldPoll) return undefined;
    const timer = window.setInterval(() => {
      if (statusPollInFlight.current) return;
      statusPollInFlight.current = true;
      void loadStatus()
        .catch((reason: unknown) => setError(actionError(reason)))
        .finally(() => {
          statusPollInFlight.current = false;
        });
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [statusResponse?.shouldPoll, loadStatus]);

  const runAction = async (action: 'start' | 'pause' | 'resume', walletAddresses?: string[]) => {
    setBusyAction(action);
    setError(null);
    try {
      const runId = activeRun?.id;
      const init: RequestInit = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chain,
          targetDays,
          traderLimit,
          ...(action === 'start' && walletAddresses ? { walletAddresses } : {}),
          ...(runId === undefined ? {} : { runId }),
        }),
      };
      await api<{ runId?: number; status?: DataWorkflowRunStatus }>(
        `${BASE_ENDPOINT}/${action}`,
        init,
      );
      const next = await loadStatus();
      if (next.run?.id !== activeRun?.id || action !== 'pause') {
        await Promise.all([loadCoverage(), loadReadiness()]);
      }
    } catch (reason: unknown) {
      setError(actionError(reason));
    } finally {
      setBusyAction(null);
    }
  };

  const closeWorkflow = async (action: 'finish' | 'cancel') => {
    if (!activeRun) return;
    setBusyAction(action);
    setError(null);
    try {
      await api<{ runId: number; status: DataWorkflowRunStatus }>(`${BASE_ENDPOINT}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: activeRun.id }),
      });
      await loadStatus();
      await Promise.all([loadCoverage(), loadReadiness()]);
    } catch (reason: unknown) {
      setError(actionError(reason));
    } finally {
      setBusyAction(null);
    }
  };

  const runStep = async (stepKey: DataWorkflowStepResponse['stepKey']) => {
    if (!activeRun) return;
    setBusyAction('step');
    setError(null);
    try {
      await api(`${BASE_ENDPOINT}/step`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: activeRun.id, stepKey }),
      });
      await Promise.all([loadStatus(), loadCoverage(), loadReadiness()]);
    } catch (reason: unknown) {
      setError(actionError(reason));
    } finally {
      setBusyAction(null);
    }
  };

  const refreshAll = async () => {
    setBusyAction('refresh');
    try {
      await loadStatus();
      await Promise.all([loadCoverage(), loadReadiness()]);
    } catch (reason: unknown) {
      setError(actionError(reason));
    } finally {
      setBusyAction(null);
    }
  };

  const refreshRoster = async () => {
    setRosterBusy('refresh');
    setRosterError(null);
    try {
      await api('/api/copytrade/roster/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chain, limit: traderLimit }),
      });
      await Promise.all([loadStatus(), loadRoster(), loadCoverage(), loadReadiness()]);
    } catch (reason: unknown) {
      setRosterError(actionError(reason));
    } finally {
      setRosterBusy(null);
    }
  };

  const importRoster = async (file: File) => {
    setRosterBusy('import');
    setRosterError(null);
    try {
      await api('/api/copytrade/roster/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: file.name, content: await file.text() }),
      });
      await Promise.all([loadStatus(), loadRoster(), loadCoverage(), loadReadiness()]);
    } catch (reason: unknown) {
      setRosterError(actionError(reason));
    } finally {
      setRosterBusy(null);
    }
  };

  const toggleWalletSelection = (walletAddress: string) => toggleWallet(walletAddress);

  const retryWallet = async (walletAddress: string) => {
    setRetryingWallet(walletAddress);
    setCoverageError(null);
    try {
      await api<{ accepted: boolean }>(`${BASE_ENDPOINT}/coverage/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chain,
          targetDays,
          walletAddress,
          runId: activeRun?.id ?? null,
        }),
      });
      await Promise.all([loadStatus(), loadCoverage(), loadReadiness()]);
    } catch (reason: unknown) {
      setCoverageError(actionError(reason));
    } finally {
      setRetryingWallet(null);
    }
  };

  const stopExternalFetch = async () => {
    setBusyAction('stop');
    setError(null);
    try {
      await api('/api/copytrade/fetch/stop', { method: 'POST' });
      await loadStatus();
    } catch (reason: unknown) {
      setError(actionError(reason));
    } finally {
      setBusyAction(null);
    }
  };

  const steps = useMemo(() => {
    const byKey = new Map(statusResponse?.steps.map((step) => [step.stepKey, step]));
    return DATA_WORKFLOW_STEP_DEFINITIONS.map((definition, index) => ({
      definition,
      step: (() => {
        const step =
          byKey.get(definition.key) ??
          ({
            stepKey: definition.key,
            stepOrder: index + 1,
            status: 'not_started',
            startedAt: null,
            updatedAt: statusResponse?.generatedAt ?? new Date(0).toISOString(),
            completedAt: null,
            lastSuccessAt: null,
            underlyingRunId: null,
            underlyingRunKind: null,
            recordsTotal: 0,
            recordsNew: 0,
            walletsTotal: 0,
            walletsDone: 0,
            walletsFailed: 0,
            warnings: [],
            error: null,
            action: {
              allowed: false,
              reasonCode: 'no_active_workflow',
              message: 'Create a workflow run first.',
            },
          } satisfies DataWorkflowStepResponse);
        // The activity step reports fetch execution progress. Coverage completion is a
        // separate quality gate and belongs on the following verification step; using it here
        // made a finished 25/25 fetch appear as only 17/25 complete.
        return definition.key === 'activity_history' && activityProgress
          ? {
              ...step,
              recordsTotal: activityProgress.walletsTotal,
              walletsTotal: activityProgress.walletsTotal,
              walletsDone: activityProgress.walletsDone,
              walletsFailed: activityProgress.walletsFailed,
            }
          : step;
      })(),
    }));
  }, [activeRun?.id, activityProgress, statusResponse]);

  return (
    <section className="copytrade-research-route" aria-labelledby="data-workflow-title">
      <div className="copytrade-results-meta">
        <div>
          <p className="eyebrow">CENTRALIZED DATA</p>
          <h2 id="data-workflow-title">{COPY.title}</h2>
          <p>{COPY.description}</p>
        </div>
        {activeRun && (
          <div className="copytrade-workflow-status">
            <strong>{workflowLabel(phase, activeRun.status)}</strong>
            <small>
              Run #{activeRun.id} · {activeRun.chain.toUpperCase()} ·{' '}
              {numberFormatter.format(activeRun.rosterWallets.length)} wallets
            </small>
          </div>
        )}
      </div>

      <div className="copytrade-workflow-actions">
        <div className="copytrade-workflow-row">
          <div className="copytrade-workflow-label">
            <div>
              <strong>Requested history window</strong>
              <small>Choose the depth this run must verify for each wallet.</small>
            </div>
          </div>
          <label>
            <span className="visually-hidden">Requested history window</span>
            <select
              value={targetDays}
              onChange={(event) => setTargetDays(Number(event.target.value))}
              disabled={Boolean(isActive) || loadingStatus}
            >
              {TARGET_PERIODS.map((period) => (
                <option key={period} value={period}>
                  {period} days
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="primary"
            onClick={() => setWalletSelectionOpen(true)}
            disabled={
              loadingStatus || loadingRoster || busyAction !== null || Boolean(startDisabledReason)
            }
            title={startDisabledReason ?? undefined}
          >
            {busyAction === 'start' ? COPY.starting : COPY.start}
          </button>
          {startDisabledReason && <small>Disabled: {startDisabledReason}</small>}
        </div>

        <div className="copytrade-workflow-row">
          <div className="copytrade-workflow-label">
            <div>
              <strong>Workflow controls</strong>
              <small>Pause keeps completed pages and resume continues from saved cursors.</small>
            </div>
          </div>
          <div className="copytrade-workflow-status">
            <StatusBadge status={phase} />
            {activeRun?.updatedAt && (
              <small>
                Updated <FormattedDate value={activeRun.updatedAt} />
              </small>
            )}
          </div>
          <div>
            <button
              type="button"
              className="secondary"
              onClick={() => void runAction('pause')}
              disabled={busyAction !== null || Boolean(pauseDisabledReason)}
              title={pauseDisabledReason ?? undefined}
            >
              {busyAction === 'pause' ? COPY.pausing : COPY.pause}
            </button>{' '}
            <button
              type="button"
              className="secondary"
              onClick={() => void runAction('resume')}
              disabled={busyAction !== null || Boolean(resumeDisabledReason)}
              title={resumeDisabledReason ?? undefined}
            >
              {busyAction === 'resume' ? COPY.resuming : COPY.resume}
            </button>{' '}
            <button
              type="button"
              className="secondary"
              onClick={() => void closeWorkflow('finish')}
              disabled={busyAction !== null || Boolean(finishDisabledReason)}
              title={finishDisabledReason ?? strings.dataWorkflow.finishHelp}
            >
              {busyAction === 'finish' ? COPY.finishing : COPY.finish}
            </button>{' '}
            <button
              type="button"
              className="secondary"
              onClick={() => void closeWorkflow('cancel')}
              disabled={busyAction !== null || Boolean(cancelDisabledReason)}
              title={cancelDisabledReason ?? strings.dataWorkflow.cancelHelp}
            >
              {busyAction === 'cancel' ? COPY.cancelling : COPY.cancel}
            </button>
          </div>
          {(pauseDisabledReason ||
            resumeDisabledReason ||
            finishDisabledReason ||
            cancelDisabledReason) && (
            <small>
              {pauseDisabledReason && <>Pause disabled: {pauseDisabledReason} </>}
              {resumeDisabledReason && <>Resume disabled: {resumeDisabledReason} </>}
              {finishDisabledReason && <>Finish disabled: {finishDisabledReason} </>}
              {cancelDisabledReason && <>Cancel disabled: {cancelDisabledReason}</>}
            </small>
          )}
        </div>
      </div>

      {loadingStatus && !statusResponse && (
        <p className="muted" role="status">
          {COPY.loading}
        </p>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error || COPY.statusError}
        </p>
      )}
      {externalBlockers.length > 0 && (
        <div className="copytrade-workflow-external-blocker" role="status">
          <strong>Another production job is running</strong>
          {externalBlockers.map((job) => (
            <span key={`${job.kind}-${job.jobRunId}`}>{job.label}</span>
          ))}
          {externalGmgnJob?.progress && (
            <ActivityFetchProgressPanel progress={externalGmgnJob.progress} />
          )}
          <small>
            {externalGmgnJob && !externalGmgnJob.progress
              ? 'This GMGN activity fetch is not linked to a Data workflow, so its progress and stop control are not available on this page.'
              : 'This page is monitoring the shared lock. Its progress and stop control belong to the tab or workflow that started that job.'}
          </small>
          {externalGmgnJob?.stoppable && (
            <button
              type="button"
              className="secondary"
              onClick={() => void stopExternalFetch()}
              disabled={busyAction !== null}
            >
              {busyAction === 'stop' ? COPY.stopping : 'Stop active GMGN fetch'}
            </button>
          )}
        </div>
      )}

      <div className="copytrade-workflow-actions" aria-label="Data workflow steps">
        {steps.map(({ definition, step }) => (
          <DataWorkflowStep
            key={definition.key}
            definition={definition}
            step={step}
            action={step.action}
            onAction={() => void runStep(step.stepKey)}
            actionLabel={busyAction === 'step' ? 'Running…' : 'Run step'}
            actionDisabled={busyAction !== null}
          >
            {definition.key === 'roster' && (
              <div className="copytrade-workflow-inline-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void refreshRoster()}
                  disabled={rosterBusy !== null || Boolean(isActive)}
                >
                  {rosterBusy === 'refresh' ? 'Refreshing roster…' : 'Refresh GMGN roster'}
                </button>
                <label className="secondary copytrade-file-button">
                  {rosterBusy === 'import' ? 'Importing roster…' : 'Import roster JSON'}
                  <input
                    type="file"
                    accept="application/json,.json"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file) void importRoster(file);
                    }}
                    disabled={rosterBusy !== null || Boolean(isActive)}
                  />
                </label>
                {rosterError && (
                  <small className="error-message" role="alert">
                    {rosterError}
                  </small>
                )}
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setWalletSelectionOpen(true)}
                  disabled={
                    loadingRoster ||
                    rosterBusy !== null ||
                    Boolean(isActive) ||
                    (rosterResponse?.wallets.length ?? 0) === 0
                  }
                >
                  {loadingRoster
                    ? 'Loading wallets…'
                    : `Choose wallets${rosterResponse ? ` (${selectedWallets.size}/${rosterResponse.wallets.length})` : ''}`}
                </button>
                {rosterLoadError && <small className="error-message">{rosterLoadError}</small>}
              </div>
            )}
            {definition.key === 'wallet_metadata' && (
              <MetadataFetchProgressPanel progress={statusResponse?.metadataProgress ?? null} />
            )}
            {definition.key === 'activity_history' && (
              <ActivityFetchProgressPanel progress={activityProgress} />
            )}
            {definition.key === 'coverage_verification' && (
              <DataHistoryCoveragePanel
                response={coverage}
                loading={loadingCoverage}
                error={coverageError}
                onRetryWallet={(walletAddress) => void retryWallet(walletAddress)}
                retryingWalletAddress={retryingWallet}
              />
            )}
            {definition.key === 'dune_outcomes' && (
              <DuneOutcomeProgressPanel
                progress={statusResponse?.duneProgress ?? null}
                step={step}
              />
            )}
            {definition.key === 'readiness' && (
              <DatasetReadinessPanel
                response={readiness}
                loading={loadingReadiness}
                error={readinessError}
              />
            )}
          </DataWorkflowStep>
        ))}
      </div>

      {activeRun?.error && (
        <p className="error-message" role="alert">
          {activeRun.error}
        </p>
      )}
      {walletSelectionOpen && rosterResponse && (
        <DataWorkflowWalletSelectionDialog
          wallets={rosterResponse.wallets}
          selectedWallets={selectedWallets}
          onToggleWallet={toggleWalletSelection}
          onSetSelectedWallets={(walletAddresses) => setSelectedWallets(new Set(walletAddresses))}
          onClose={() => setWalletSelectionOpen(false)}
          periodDays={targetDays}
          chain={chain}
          api={api}
          onConfirm={() => {
            setWalletSelectionOpen(false);
            void runAction('start', [...selectedWallets]);
          }}
        />
      )}
      <div className="copytrade-workflow-utility">
        <span>
          Last status generated: <FormattedDate value={statusResponse?.generatedAt ?? null} />
        </span>
        <button
          type="button"
          className="secondary"
          onClick={() => void refreshAll()}
          disabled={busyAction !== null}
        >
          {busyAction === 'refresh' ? COPY.refreshing : COPY.refresh}
        </button>
      </div>
    </section>
  );
}

type StatusBadgeProps = { status: string };

function StatusBadge({ status }: StatusBadgeProps) {
  const normalized = status === 'not_started' ? 'missing' : status;
  return <StatusPill status={normalized}>{phaseLabel(status)}</StatusPill>;
}
