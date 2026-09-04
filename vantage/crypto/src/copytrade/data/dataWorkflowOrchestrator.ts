import type { DatabaseSync } from 'node:sqlite';
import { syncCopyTradeRoster, listRosterWallets, type RosterWallet } from '../screening/roster.js';
import {
  hasActiveFetchRun,
  readFetchRunState,
  requestCopyTradeFetchStop,
  startCopyTradeFetch,
  type FetchRunState,
} from '../screening/fetch.js';
import {
  readGmgnStatsFetchStatus,
  startGmgnStatsFetch,
  stopGmgnStatsFetch,
} from '../screening/statsFetch.js';
import { runCopySimulationBatch } from '../simulation/copySimulation.js';
import {
  createDataWorkflowRun,
  readDataWorkflowRun,
  readLatestDataWorkflowRun,
  readDataWorkflowSteps,
  updateDataWorkflowRunStatus,
  updateDataWorkflowStep,
  type DataWorkflowRunWithSteps,
  type DataWorkflowStepKey,
} from './dataWorkflowRunStore.js';
import { readDataWorkflowState } from './dataWorkflowState.js';
import { readProductionJobLock, type ProductionJobKind } from './productionJobLock.js';
import { asWorkflowRunId, type WorkflowRunId } from './workflowIds.js';

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const runningWorkflows = new Set<number>();
const pauseRequested = new Set<number>();

export type DataWorkflowDuneProgress = {
  status: 'running' | 'completed' | 'completed_with_warnings' | 'failed' | 'cancelled' | 'paused';
  targetsTotal: number;
  targetsProcessed: number;
  batchesRun: number;
  batchesTotal: number;
  currentBatch: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
};

// In-memory only, mirroring this codebase's existing copySimulationRunState precedent (the
// legacy /copy-simulation/run route's own progress tracker) -- Dune batch progress has never
// been persisted anywhere, and a server restart already orphans any in-flight batch regardless
// (see reconcileStaleCopySimulationRuns), so there is nothing meaningful to resume progress from.
const duneProgressByWorkflow = new Map<number, DataWorkflowDuneProgress>();

const readDataWorkflowDuneProgress = (runId: number): DataWorkflowDuneProgress | null =>
  duneProgressByWorkflow.get(runId) ?? null;

const startDuneProgress = (runId: number): void => {
  const now = new Date().toISOString();
  duneProgressByWorkflow.set(runId, {
    status: 'running',
    targetsTotal: 0,
    targetsProcessed: 0,
    batchesRun: 0,
    batchesTotal: 0,
    currentBatch: 0,
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    error: null,
  });
};

const updateDuneProgress = (runId: number, patch: Partial<DataWorkflowDuneProgress>): void => {
  const current = duneProgressByWorkflow.get(runId);
  if (!current) return;
  duneProgressByWorkflow.set(runId, { ...current, ...patch, updatedAt: new Date().toISOString() });
};

export type DataWorkflowActionResult = { runId: number; status: string };

export type DataWorkflowStartOptions = {
  chain?: string;
  targetDays: number;
  traderLimit: number;
  walletAddresses?: string[];
  depthMode?: 'requested' | 'maximum_available';
};

/**
 * Applies a user's pre-start selection to the current GMGN roster while preserving the roster's
 * rank order. Explicit selections are validated against that snapshot so a stale or hand-crafted
 * address can never enter a workflow run outside the saved roster.
 */
export const selectDataWorkflowWallets = (
  wallets: RosterWallet[],
  requestedAddresses: string[] | undefined,
  traderLimit: number,
): RosterWallet[] => {
  if (requestedAddresses === undefined) return wallets.slice(0, traderLimit);
  const requested = new Set(requestedAddresses);
  const known = new Set(wallets.map((wallet) => wallet.walletAddress));
  const unknown = [...requested].filter((walletAddress) => !known.has(walletAddress));
  if (unknown.length > 0)
    throw new Error(
      'One or more selected wallets are not in the current GMGN roster. Refresh the roster and try again.',
    );
  return wallets.filter((wallet) => requested.has(wallet.walletAddress));
};

export type DataWorkflowReasonCode =
  | 'ok'
  | 'workflow_active'
  | 'workflow_paused'
  | 'workflow_ready'
  | 'workflow_continuation_available'
  | 'no_active_workflow'
  | 'workflow_terminal'
  | 'workflow_close_unsafe'
  | 'production_job_locked'
  | 'gmgn_metadata_running'
  | 'step_completed'
  | 'previous_step_incomplete'
  | 'step_prerequisite_missing';

export type DataWorkflowActionState = {
  allowed: boolean;
  reasonCode: DataWorkflowReasonCode;
  message: string | null;
};

export type DataWorkflowJobEntry = {
  kind: ProductionJobKind;
  jobRunId: number;
  workflowRunId: WorkflowRunId | null;
  relationship: 'owned' | 'external';
  status: string;
  stoppable: boolean;
  label: string;
  /** Populated only for gmgn_fetch jobs today -- Dune batches have no persisted granular
   *  progress payload (see runCopySimulationBatch's in-memory-only onProgress callback). */
  progress: ReturnType<typeof toActivityProgress> | null;
};

export type DataWorkflowMetadataProgress = {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  walletsTotal: number;
  walletsDone: number;
  requestsUsed: number;
  skippedFresh: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
};

export type DataWorkflowStatusResponse = {
  generatedAt: string;
  chain: string;
  targetDays: number;
  run: DataWorkflowRunWithSteps | null;
  phase:
    | 'ready_for_step'
    | 'running_step'
    | 'paused'
    | 'completed'
    | 'completed_with_warnings'
    | 'failed'
    | 'abandoned';
  steps: Array<{
    stepKey: string;
    stepOrder: number;
    status: string;
    startedAt: string | null;
    updatedAt: string;
    completedAt: string | null;
    lastSuccessAt: string | null;
    underlyingRunId: number | null;
    underlyingRunKind: string | null;
    recordsTotal: number;
    recordsNew: number;
    walletsTotal: number;
    walletsDone: number;
    walletsFailed: number;
    warnings: string[];
    error: string | null;
    disabledReason: string | null;
    action: DataWorkflowActionState;
  }>;
  actions: {
    start: DataWorkflowActionState;
    pause: DataWorkflowActionState;
    resume: DataWorkflowActionState;
    finish: DataWorkflowActionState;
    cancel: DataWorkflowActionState;
  };
  jobs: DataWorkflowJobEntry[];
  shouldPoll: boolean;
  /** GMGN wallet-metadata (stats) fetch has no persisted run row -- it is a single in-memory
   *  process singleton, unlike the activity-history walk -- so it cannot be represented as a
   *  jobs[] entry the way gmgn_fetch/dune_simulation are. Null once idle and never yet run. */
  metadataProgress: DataWorkflowMetadataProgress | null;
  /** Batch-by-batch progress for this workflow's own Dune outcomes step. Null when that step
   *  has never run for this workflow (or none is selected). */
  duneProgress: DataWorkflowDuneProgress | null;
};

const toActivityProgress = (state: FetchRunState) => ({
  runId: state.runId,
  status:
    state.status === 'paused'
      ? ('paused' as const)
      : state.status === 'failed'
        ? ('failed' as const)
        : state.status === 'completed' && state.completedWithWarnings
          ? ('completed_with_warnings' as const)
          : state.status === 'completed'
            ? ('completed' as const)
            : state.running
              ? ('running' as const)
              : ('idle' as const),
  phase: state.running ? 'activity_history' : null,
  message: state.message,
  targetDays: state.targetDays ?? 0,
  walletsTotal: state.walletTotal,
  walletsDone: state.walletDone,
  walletsFailed: state.failedWallets,
  pagesFetched: state.pagesFetchedTotal,
  activitiesFetched: state.storedTradesTotal ?? state.tradesFetched,
  recordsNew: state.tradesFetched,
  requestsUsed: state.requestsMade,
  currentWallet: state.currentWalletAddress
    ? {
        walletAddress: state.currentWalletAddress,
        name: null,
        index: state.walletDone,
        pagesFetched: state.currentWalletDetail?.pagesFetched ?? 0,
        activitiesFetched: state.currentWalletStoredTrades ?? 0,
        oldestActivityAt: state.currentWalletDetail?.oldestStoredAt ?? null,
        newestActivityAt: state.currentWalletDetail?.newestStoredAt ?? null,
        cursor: null,
        nextCursor: null,
        reachesRequestedWindow: state.currentWalletDetail?.reachedTarget ?? false,
        status: state.running ? 'running' : state.status,
        error: null,
      }
    : null,
  requestedWindowStart: null,
  requestedWindowEnd: null,
  startedAt: state.startedAt,
  updatedAt: state.completedAt ?? state.startedAt,
  completedAt: state.completedAt,
  elapsedSeconds: state.elapsedSeconds,
  estimatedRemainingSeconds: state.estimatedRemainingSeconds,
  warnings: state.completedWithWarnings ? ['Some wallets failed or reached a page budget.'] : [],
  error: state.status === 'failed' ? state.message : null,
});

export const readDataWorkflowStatus = (
  database: DatabaseSync,
  options: { chain?: string; targetDays?: number; runId?: number } = {},
): DataWorkflowStatusResponse => {
  const chain = options.chain ?? 'sol';
  const selectedRun =
    options.runId !== undefined
      ? readDataWorkflowRun(database, options.runId)
      : (() => {
          const latest = readLatestDataWorkflowRun(database, chain);
          // An active run must remain visible even if the page was opened with a different
          // period selected. Once there is no active run, only reuse the latest run when it
          // matches the requested period; otherwise the response describes current evidence.
          return latest?.status === 'active' ||
            options.targetDays === undefined ||
            latest?.targetDays === options.targetDays
            ? latest
            : null;
        })();
  const state = selectedRun
    ? readDataWorkflowState(database, { runId: selectedRun.id })
    : readDataWorkflowState(database, options);
  const run = state.run;
  const workflowRunId = run?.id !== undefined ? asWorkflowRunId(run.id) : undefined;
  const fetchState = readFetchRunState(database);
  const activityWarning = (step: (typeof state.steps)[number]): string[] => {
    if (
      step.stepKey !== 'activity_history' ||
      step.warnings.length === 0 ||
      run?.steps.find((item) => item.stepKey === step.stepKey)?.underlyingRunId !== fetchState.runId
    ) {
      return step.warnings;
    }
    const details = [
      fetchState.failedWallets > 0
        ? `${fetchState.failedWallets} wallet${fetchState.failedWallets === 1 ? '' : 's'} failed`
        : null,
      fetchState.truncatedWallets > 0
        ? `${fetchState.truncatedWallets} wallet${fetchState.truncatedWallets === 1 ? '' : 's'} were truncated`
        : null,
    ].filter((part): part is string => part !== null);
    return [details.length > 0 ? `${details.join('; ')}.` : step.warnings[0]];
  };
  const steps = state.steps.map((step) => ({
    stepKey: step.stepKey,
    stepOrder: step.stepOrder,
    // The workflow card represents this run's execution state. Do not replace a newly-created
    // step's `not_started` status with a terminal-looking status derived from older shared
    // evidence; that made an active run display every step as completed and disabled its actions.
    status: step.storedStatus,
    startedAt: run?.steps.find((item) => item.stepKey === step.stepKey)?.startedAt ?? null,
    updatedAt:
      run?.steps.find((item) => item.stepKey === step.stepKey)?.updatedAt ??
      new Date().toISOString(),
    completedAt: run?.steps.find((item) => item.stepKey === step.stepKey)?.completedAt ?? null,
    lastSuccessAt: run?.steps.find((item) => item.stepKey === step.stepKey)?.lastSuccessAt ?? null,
    underlyingRunId:
      run?.steps.find((item) => item.stepKey === step.stepKey)?.underlyingRunId ?? null,
    underlyingRunKind:
      run?.steps.find((item) => item.stepKey === step.stepKey)?.underlyingRunKind ?? null,
    recordsTotal: step.counts.total,
    recordsNew: step.counts.newRecords,
    walletsTotal: step.counts.total,
    walletsDone: step.counts.complete,
    walletsFailed: step.counts.failed,
    warnings: activityWarning(step),
    error: run?.steps.find((item) => item.stepKey === step.stepKey)?.error ?? null,
    disabledReason: step.disabledReason,
    action: {
      allowed: false,
      reasonCode: 'no_active_workflow' as const,
      message: 'Create a workflow run first.',
    },
  }));

  const lock = readProductionJobLock(database, { workflowRunId });
  const active = run?.status === 'active' || runningWorkflows.has(run?.id ?? -1);
  const paused = run?.status === 'paused';
  const statsStatus = readGmgnStatsFetchStatus();
  const metadataFetchActive = statsStatus.running;
  const hasIncompleteSteps =
    run?.steps.some(
      (step) =>
        step.status !== 'completed' &&
        step.status !== 'completed_with_warnings' &&
        step.status !== 'failed',
    ) === true;
  const canContinue =
    run !== null &&
    !paused &&
    (active ||
      (hasIncompleteSteps &&
        (run.status === 'completed' || run.status === 'completed_with_warnings')));
  const externalLocked = lock.blockers.some((blocker) => blocker.relationship === 'external');
  const metadataProgress: DataWorkflowMetadataProgress | null =
    statsStatus.status === 'idle'
      ? null
      : {
          status: statsStatus.status,
          walletsTotal: statsStatus.walletTotal,
          walletsDone: statsStatus.walletDone,
          requestsUsed: statsStatus.requestsMade,
          skippedFresh: statsStatus.skippedFresh,
          startedAt: statsStatus.startedAt,
          completedAt: statsStatus.completedAt,
          error: statsStatus.error,
        };

  // One enumeration path for every job the tab might need to show, built directly from the
  // production-job lock's blockers rather than a second parallel list -- the run itself is
  // already represented by `run`, so `data_workflow` entries are excluded here.
  const jobs: DataWorkflowJobEntry[] = lock.blockers
    .filter((blocker) => blocker.kind !== 'data_workflow')
    .map((blocker) => ({
      kind: blocker.kind,
      jobRunId: blocker.jobRunId,
      workflowRunId: blocker.workflowRunId,
      relationship: blocker.relationship,
      status: blocker.status,
      stoppable: blocker.stoppable,
      label: blocker.label,
      progress:
        blocker.kind === 'gmgn_fetch' && fetchState.runId === blocker.jobRunId
          ? toActivityProgress(fetchState)
          : null,
    }));
  const hasRunningStep =
    runningWorkflows.has(run?.id ?? -1) ||
    run?.steps.some((step) => step.status === 'running') === true ||
    jobs.some(
      (job) =>
        job.relationship === 'owned' && ['submitted', 'running', 'timed_out'].includes(job.status),
    ) ||
    metadataFetchActive;
  const hasOwnedRunningJob = jobs.some(
    (job) =>
      job.relationship === 'owned' && ['submitted', 'running', 'timed_out'].includes(job.status),
  );
  const closeUnsafe = hasRunningStep || hasOwnedRunningJob;
  const closableRun = run !== null && (run.status === 'active' || run.status === 'paused');
  const phase: DataWorkflowStatusResponse['phase'] = paused
    ? 'paused'
    : hasRunningStep
      ? 'running_step'
      : canContinue
        ? 'ready_for_step'
        : run?.status === 'active'
          ? 'ready_for_step'
          : (run?.status ?? 'ready_for_step');

  const canContinueExistingRun =
    run !== null &&
    !paused &&
    hasIncompleteSteps &&
    (run.status === 'completed' || run.status === 'completed_with_warnings');
  const start: DataWorkflowActionState = canContinue
    ? {
        allowed: false,
        reasonCode: hasRunningStep ? 'workflow_active' : 'workflow_ready',
        message: hasRunningStep
          ? 'A workflow step is already running.'
          : 'Continue the existing workflow before creating another run.',
      }
    : paused
      ? {
          allowed: false,
          reasonCode: 'workflow_paused',
          message: 'Resume or finish the paused workflow before creating another run.',
        }
      : canContinueExistingRun
        ? {
            allowed: false,
            reasonCode: 'workflow_continuation_available',
            message: 'Continue the existing workflow before creating another run.',
          }
        : metadataFetchActive
          ? {
              allowed: false,
              reasonCode: 'gmgn_metadata_running',
              message: 'A GMGN metadata fetch is already running.',
            }
          : externalLocked
            ? { allowed: false, reasonCode: 'production_job_locked', message: lock.reason }
            : { allowed: true, reasonCode: 'ok', message: null };

  const closeAction = (): DataWorkflowActionState => {
    if (!run) {
      return {
        allowed: false,
        reasonCode: 'no_active_workflow',
        message: 'Create a workflow run first.',
      };
    }
    if (!closableRun) {
      return {
        allowed: false,
        reasonCode: 'workflow_terminal',
        message: 'This workflow is already finished.',
      };
    }
    if (closeUnsafe) {
      return {
        allowed: false,
        reasonCode: 'workflow_close_unsafe',
        message: 'Wait for the current workflow step to stop before closing this workflow.',
      };
    }
    return {
      allowed: true,
      reasonCode: 'ok',
      message: null,
    };
  };
  const finish = closeAction();
  const cancel = closeAction();

  const pause: DataWorkflowActionState =
    active && hasRunningStep
      ? { allowed: true, reasonCode: 'ok', message: null }
      : {
          allowed: false,
          reasonCode: canContinue ? 'workflow_ready' : 'no_active_workflow',
          message: canContinue
            ? 'No workflow step is currently running. Run the next step instead.'
            : 'Pause is available only while a workflow step is running.',
        };

  const resume: DataWorkflowActionState = !paused
    ? {
        allowed: false,
        reasonCode: 'no_active_workflow',
        message: 'Resume is available only after the workflow is paused.',
      }
    : externalLocked
      ? { allowed: false, reasonCode: 'production_job_locked', message: lock.reason }
      : { allowed: true, reasonCode: 'ok', message: null };

  const terminal = (status: string): boolean =>
    status === 'completed' || status === 'completed_with_warnings';
  const stepActions = steps.map((step, index) => {
    if (!run) return step;
    if (step.status === 'running') {
      return {
        ...step,
        action: {
          allowed: false,
          reasonCode: 'workflow_active' as const,
          message: 'This step is already running.',
        },
      };
    }
    if (step.status === 'paused') {
      const allowed = canContinue && !externalLocked;
      return {
        ...step,
        action: {
          allowed,
          reasonCode: (allowed
            ? 'ok'
            : paused
              ? 'workflow_paused'
              : !canContinue
                ? 'no_active_workflow'
                : 'production_job_locked') as DataWorkflowReasonCode,
          message: allowed
            ? null
            : paused
              ? 'Resume the workflow before continuing this step.'
              : !canContinue
                ? 'This workflow is finished; create a new workflow run.'
                : lock.reason,
        },
      };
    }
    if (step.status === 'completed' || step.status === 'completed_with_warnings') {
      return {
        ...step,
        action: {
          allowed: false,
          reasonCode: 'step_completed' as const,
          message: 'This step has already completed.',
        },
      };
    }
    const previous = index === 0 ? true : terminal(steps[index - 1].status);
    const coverageReady = step.stepKey !== 'dune_outcomes' || state.counts.coverage.ready;
    const metadataAvailable = step.stepKey !== 'wallet_metadata' || !metadataFetchActive;
    const allowed =
      canContinue && previous && coverageReady && !externalLocked && metadataAvailable;
    return {
      ...step,
      action: {
        allowed,
        reasonCode: (!canContinue
          ? paused
            ? 'workflow_paused'
            : canContinueExistingRun
              ? 'workflow_continuation_available'
              : run
                ? 'workflow_terminal'
                : 'no_active_workflow'
          : !previous
            ? 'previous_step_incomplete'
            : !coverageReady
              ? 'step_prerequisite_missing'
              : externalLocked
                ? 'production_job_locked'
                : !metadataAvailable
                  ? 'gmgn_metadata_running'
                  : 'ok') as DataWorkflowReasonCode,
        message: !canContinue
          ? paused
            ? 'Resume the workflow first.'
            : canContinueExistingRun
              ? null
              : run
                ? 'This workflow was closed; create a new workflow run.'
                : 'Create a workflow run first.'
          : !previous
            ? `Complete ${steps[index - 1].stepKey.replaceAll('_', ' ')} first.`
            : !coverageReady
              ? 'The requested history coverage is not complete yet.'
              : externalLocked
                ? lock.reason
                : metadataFetchActive
                  ? 'A GMGN metadata fetch is already running.'
                  : null,
      },
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    chain,
    targetDays: state.targetDays,
    run,
    steps: stepActions,
    actions: { start, pause, resume, finish, cancel },
    jobs,
    phase,
    shouldPoll: hasRunningStep || (paused && !resume.allowed),
    metadataProgress,
    duneProgress: run?.id !== undefined ? readDataWorkflowDuneProgress(run.id) : null,
  };
};

const setStepRunning = (
  database: DatabaseSync,
  runId: number,
  stepKey: DataWorkflowStepKey,
  kind: string,
) => {
  updateDataWorkflowStep(database, {
    runId,
    stepKey,
    status: 'running',
    startedAt: new Date().toISOString(),
    underlyingRunKind: kind,
  });
};

const finishStep = (
  database: DatabaseSync,
  runId: number,
  stepKey: DataWorkflowStepKey,
  status: 'completed' | 'completed_with_warnings' | 'paused' | 'failed',
  options: { underlyingRunId?: number | null; warning?: string; error?: string } = {},
) => {
  updateDataWorkflowStep(database, {
    runId,
    stepKey,
    status,
    underlyingRunId: options.underlyingRunId,
    warnings: options.warning ? [options.warning] : [],
    error: options.error ?? null,
    markSuccess: status === 'completed' || status === 'completed_with_warnings',
    markCompletedAt: status !== 'paused',
  });
};

const invalidateEvidenceDependentSteps = (database: DatabaseSync, runId: number): void => {
  for (const stepKey of ['coverage_verification', 'dune_outcomes', 'readiness'] as const) {
    updateDataWorkflowStep(database, {
      runId,
      stepKey,
      status: 'not_started',
      startedAt: null,
      underlyingRunId: null,
      underlyingRunKind: null,
      warnings: [],
      error: null,
      clearCompletedAt: true,
      clearLastSuccessAt: true,
    });
  }
};

const waitForStats = async (database: DatabaseSync, runId: number): Promise<boolean> => {
  for (;;) {
    if (pauseRequested.has(runId)) return false;
    const status = readGmgnStatsFetchStatus();
    if (!status.running) return status.status === 'completed';
    await sleep(500);
  }
};

const waitForActivity = async (
  database: DatabaseSync,
  runId: number,
  fetchRunId: number,
): Promise<FetchRunState> => {
  for (;;) {
    const state = readFetchRunState(database);
    if (state.runId === fetchRunId && !state.running) return state;
    if (pauseRequested.has(runId) && state.running) requestCopyTradeFetchStop(database, runId);
    await sleep(500);
  }
};

const stepFinished = (run: DataWorkflowRunWithSteps, stepKey: DataWorkflowStepKey): boolean => {
  const status = run.steps.find((step) => step.stepKey === stepKey)?.status;
  return status === 'completed' || status === 'completed_with_warnings';
};

const executeDataWorkflow = async (database: DatabaseSync, runId: number): Promise<void> => {
  const run = readDataWorkflowRun(database, runId);
  if (!run || runningWorkflows.has(runId)) return;
  runningWorkflows.add(runId);
  pauseRequested.delete(runId);
  try {
    const wallets = run.rosterWallets;
    if (!stepFinished(run, 'wallet_metadata')) {
      setStepRunning(database, runId, 'wallet_metadata', 'gmgn_stats_fetch');
      startGmgnStatsFetch(database, {
        limit: wallets.length,
        snapshotId: run.rosterSnapshotId ?? undefined,
        chain: run.chain,
        workflowRunId: runId,
      });
      const statsComplete = await waitForStats(database, runId);
      if (pauseRequested.has(runId)) {
        finishStep(database, runId, 'wallet_metadata', 'paused', { underlyingRunId: null });
        updateDataWorkflowRunStatus(database, {
          runId,
          status: 'paused',
          error: 'Paused by user.',
        });
        return;
      }
      finishStep(
        database,
        runId,
        'wallet_metadata',
        statsComplete ? 'completed' : 'completed_with_warnings',
        {
          underlyingRunId: null,
          warning: statsComplete
            ? undefined
            : (readGmgnStatsFetchStatus().error ?? 'GMGN metadata fetch completed with warnings.'),
        },
      );
      return;
    }

    if (!stepFinished(run, 'activity_history')) {
      setStepRunning(database, runId, 'activity_history', 'gmgn_activity_fetch');
      const activity = startCopyTradeFetch(database, {
        limit: wallets.length,
        periodDays: run.depthMode === 'maximum_available' ? 365 : run.targetDays,
        chain: run.chain,
        walletAddresses: wallets,
        scope: 'roster',
        workflowRunId: runId,
        pageBudgetPerWallet: 500,
        skipCompletedWallets: true,
        terminalStatusOnCancel: 'paused',
      });
      const activityState = await waitForActivity(database, runId, activity.runId);
      if (pauseRequested.has(runId) || activityState.status === 'paused') {
        finishStep(database, runId, 'activity_history', 'paused', {
          underlyingRunId: activity.runId,
        });
        updateDataWorkflowRunStatus(database, {
          runId,
          status: 'paused',
          error: 'Paused by user.',
        });
        return;
      }
      finishStep(
        database,
        runId,
        'activity_history',
        activityState.status === 'completed' && !activityState.completedWithWarnings
          ? 'completed'
          : activityState.status === 'failed'
            ? 'failed'
            : 'completed_with_warnings',
        {
          underlyingRunId: activity.runId,
          warning: activityState.completedWithWarnings
            ? [
                activityState.failedWallets > 0
                  ? `${activityState.failedWallets} wallet${activityState.failedWallets === 1 ? '' : 's'} failed`
                  : null,
                activityState.truncatedWallets > 0
                  ? `${activityState.truncatedWallets} wallet${activityState.truncatedWallets === 1 ? '' : 's'} were truncated`
                  : null,
              ]
                .filter((part): part is string => part !== null)
                .join('; ') || 'Some wallets were incomplete or truncated.'
            : undefined,
          error: activityState.status === 'failed' ? activityState.message : undefined,
        },
      );
      return;
    }
    // Every invocation runs at most one external step. Later local/Dune steps are explicitly
    // dispatched through runDataWorkflowStep after the user confirms the preceding result.
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateDataWorkflowRunStatus(database, {
      runId,
      status: 'failed',
      error: message,
      completed: true,
    });
  } finally {
    runningWorkflows.delete(runId);
    pauseRequested.delete(runId);
  }
};

export const startDataWorkflow = (
  database: DatabaseSync,
  options: DataWorkflowStartOptions,
): DataWorkflowActionResult => {
  const chain = options.chain ?? 'sol';
  const roster = syncCopyTradeRoster(database, { chain, limit: options.traderLimit });
  const rosterWallets =
    roster.snapshotId === null
      ? []
      : listRosterWallets(database, {
          chain,
          limit: options.traderLimit,
          snapshotId: roster.snapshotId,
        });
  const wallets = selectDataWorkflowWallets(
    rosterWallets,
    options.walletAddresses,
    options.traderLimit,
  );
  if (wallets.length === 0)
    throw new Error(
      'No saved GMGN roster is available. Import or refresh the roster before starting the Data workflow.',
    );
  const runId = createDataWorkflowRun(database, {
    chain,
    targetDays: options.targetDays,
    traderLimit: wallets.length,
    rosterSnapshotId: roster.snapshotId,
    rosterWallets: wallets.map((wallet) => wallet.walletAddress),
    depthMode: options.depthMode ?? 'maximum_available',
  });
  finishStep(database, runId, 'roster', 'completed', {
    underlyingRunId: roster.snapshotId,
    warning: undefined,
  });
  return { runId, status: 'active' };
};

export const runDataWorkflowStep = (
  database: DatabaseSync,
  options: { runId: number; stepKey: DataWorkflowStepKey },
): DataWorkflowActionResult => {
  const status = readDataWorkflowStatus(database, { runId: options.runId });
  const step = status.steps.find((item) => item.stepKey === options.stepKey);
  if (!step) throw new Error('Workflow step not found.');
  if (!step.action.allowed) throw new Error(step.action.message ?? 'This step cannot run yet.');
  if (options.stepKey === 'coverage_verification') {
    const state = readDataWorkflowState(database, { runId: options.runId });
    finishStep(
      database,
      options.runId,
      'coverage_verification',
      state.counts.coverage.ready ? 'completed' : 'completed_with_warnings',
      {
        warning: state.counts.coverage.ready
          ? undefined
          : state.depthMode === 'maximum_available'
            ? `Fetch has not reached the provider’s available end for ${state.counts.coverage.requiredWallets - state.counts.coverage.completeWallets} wallet${state.counts.coverage.requiredWallets - state.counts.coverage.completeWallets === 1 ? '' : 's'}.`
            : `Coverage is ${state.counts.coverage.completePercent}% at the requested depth; ${state.counts.coverage.thresholdPercent}% is required.`,
      },
    );
    return { runId: options.runId, status: 'active' };
  }
  if (options.stepKey === 'dune_outcomes') return runDataWorkflowDune(database, options);
  if (options.stepKey === 'readiness') {
    const state = readDataWorkflowState(database, { runId: options.runId });
    const ready = state.counts.pattern.ready && state.counts.decision.ready;
    setStepRunning(database, options.runId, 'readiness', 'derived_readiness');
    finishStep(
      database,
      options.runId,
      'readiness',
      ready ? 'completed' : 'completed_with_warnings',
      { warning: ready ? undefined : 'Analysis readiness still has current-data blockers.' },
    );
    updateDataWorkflowRunStatus(database, {
      runId: options.runId,
      status: ready ? 'completed' : 'completed_with_warnings',
      completed: true,
    });
    return { runId: options.runId, status: ready ? 'completed' : 'completed_with_warnings' };
  }
  void executeDataWorkflow(database, options.runId);
  return { runId: options.runId, status: 'active' };
};

export const pauseDataWorkflow = (
  database: DatabaseSync,
  runId: number,
): DataWorkflowActionResult => {
  const run = readDataWorkflowRun(database, runId);
  if (!run || run.status !== 'active') throw new Error('That workflow is not active.');
  const runningStep = readDataWorkflowSteps(database, runId).find(
    (step) => step.status === 'running',
  );
  const ownedFetchRunning = hasActiveFetchRun(database, runId);
  const statsStatus = readGmgnStatsFetchStatus();
  const ownedStatsRunning = statsStatus.running && statsStatus.workflowRunId === runId;
  if (!runningStep && !ownedFetchRunning && !ownedStatsRunning)
    throw new Error('No workflow step is currently running. Run the next step instead.');
  pauseRequested.add(runId);
  requestCopyTradeFetchStop(database, runId);
  if (ownedStatsRunning) stopGmgnStatsFetch(runId);
  if (runningStep?.stepKey === 'dune_outcomes') {
    updateDataWorkflowStep(database, {
      runId,
      stepKey: 'dune_outcomes',
      status: 'paused',
      error: 'Pause requested; the current Dune request will finish before stopping.',
    });
  }
  updateDataWorkflowRunStatus(database, {
    runId,
    status: 'paused',
    error: 'Pause requested; current provider request will finish before stopping.',
  });
  return { runId, status: 'paused' };
};

const terminalWorkflowRunStatuses = new Set([
  'completed',
  'completed_with_warnings',
  'failed',
  'abandoned',
]);

/**
 * Closes a workflow that cannot continue without pretending that missing provider evidence was
 * fetched. Finish preserves the run as completed-with-warnings and explicitly marks unrun steps;
 * cancel uses the existing abandoned terminal status. Neither operation removes evidence.
 */
const closeIncompleteDataWorkflow = (
  database: DatabaseSync,
  runId: number,
  mode: 'finish' | 'cancel',
): DataWorkflowActionResult => {
  const run = readDataWorkflowRun(database, runId);
  if (!run) throw new Error('Workflow run not found.');
  if (terminalWorkflowRunStatuses.has(run.status)) return { runId, status: run.status };

  const status = readDataWorkflowStatus(database, { runId });
  const action = mode === 'finish' ? status.actions.finish : status.actions.cancel;
  if (!action.allowed) throw new Error(action.message ?? 'This workflow cannot be closed yet.');

  if (mode === 'finish') {
    const warning = 'This step was not run; existing evidence was retained.';
    for (const step of run.steps) {
      if (terminalWorkflowRunStatuses.has(step.status) || step.status === 'failed') continue;
      updateDataWorkflowStep(database, {
        runId,
        stepKey: step.stepKey,
        status: 'completed_with_warnings',
        warnings: [...step.warnings, warning],
        error: null,
        markCompletedAt: true,
      });
    }
    const message =
      'Workflow finished before all steps ran; incomplete evidence was retained and this run cannot be resumed.';
    updateDataWorkflowRunStatus(database, {
      runId,
      status: 'completed_with_warnings',
      error: message,
      completed: true,
    });
    return { runId, status: 'completed_with_warnings' };
  }

  const message = 'Workflow cancelled before completion; saved evidence was retained.';
  updateDataWorkflowRunStatus(database, {
    runId,
    status: 'abandoned',
    error: message,
    completed: true,
  });
  return { runId, status: 'abandoned' };
};

export const finishDataWorkflow = (
  database: DatabaseSync,
  runId: number,
): DataWorkflowActionResult => closeIncompleteDataWorkflow(database, runId, 'finish');

export const cancelDataWorkflow = (
  database: DatabaseSync,
  runId: number,
): DataWorkflowActionResult => closeIncompleteDataWorkflow(database, runId, 'cancel');

export const resumeDataWorkflow = (
  database: DatabaseSync,
  runId: number,
): DataWorkflowActionResult => {
  const run = readDataWorkflowRun(database, runId);
  if (!run || run.status !== 'paused') throw new Error('That workflow is not paused.');
  pauseRequested.delete(runId);
  updateDataWorkflowRunStatus(database, { runId, status: 'active', error: null });
  const pausedStep = run.steps.find((step) => step.status === 'paused');
  if (pausedStep?.stepKey === 'dune_outcomes') void runDataWorkflowDune(database, { runId });
  else void executeDataWorkflow(database, runId);
  return { runId, status: 'active' };
};

/** Runs only the depth-aware Dune outcome step for an existing workflow run. This is kept as a
 * separate entry point from the legacy 30-day copy-simulation route; callers may use it to
 * repair outcomes after GMGN coverage is already complete without changing that legacy route's
 * invariant. */
export const runDataWorkflowDune = (
  database: DatabaseSync,
  options: { runId: number; allowPartialDepth?: boolean },
): DataWorkflowActionResult => {
  const run = readDataWorkflowRun(database, options.runId);
  if (!run) throw new Error('Workflow run not found.');
  if (hasActiveFetchRun(database) || readGmgnStatsFetchStatus().running)
    throw new Error('Another GMGN fetch is already running.');
  const state = readDataWorkflowState(database, { runId: run.id });
  if (
    !state.counts.coverage.ready &&
    !options.allowPartialDepth &&
    run.depthMode !== 'maximum_available'
  ) {
    throw new Error(
      `Dune outcomes are blocked until ${state.counts.coverage.requiredWallets} wallets complete ${run.targetDays}-day history.`,
    );
  }
  if (state.counts.dune.status === 'running') throw new Error('Dune outcomes are already running.');
  setStepRunning(database, run.id, 'dune_outcomes', 'dune_copy_simulation');
  startDuneProgress(run.id);
  void runCopySimulationBatch(database, {
    walletAddresses: run.rosterWallets,
    chain: run.chain,
    periodDays: run.depthMode === 'maximum_available' ? 365 : run.targetDays,
    workflowRunId: asWorkflowRunId(run.id),
    shouldStop: () => pauseRequested.has(run.id),
    onPlan: (plan) =>
      updateDuneProgress(run.id, {
        targetsTotal: plan.targetsTotal,
        batchesTotal: plan.batchesTotal,
      }),
    onProgress: (progress) =>
      updateDuneProgress(run.id, {
        targetsTotal: progress.targetsTotal,
        targetsProcessed: progress.targetsProcessed,
        batchesRun: progress.batchesRun,
        currentBatch: progress.currentBatch,
        batchesTotal: progress.batchesTotal,
      }),
  }).then(
    (result) => {
      const finalStatus = result.cancelled
        ? 'paused'
        : result.failedBatches.length > 0
          ? 'completed_with_warnings'
          : 'completed';
      updateDuneProgress(run.id, {
        status: finalStatus,
        completedAt: new Date().toISOString(),
      });
      finishStep(database, run.id, 'dune_outcomes', finalStatus, {
        warning: result.cancelled
          ? 'Paused by user; resume to continue from saved Dune progress.'
          : result.failedBatches.length > 0
            ? `${result.failedBatches.length} Dune batch(es) failed.`
            : undefined,
      });
      updateDataWorkflowRunStatus(database, {
        runId: run.id,
        status: result.cancelled ? 'paused' : 'active',
        // Completing Dune completes only Step 5. Step 6 (readiness) is the run's terminal
        // transition, so keep the workflow continuable until that explicit step is executed.
        completed: false,
        error: result.cancelled ? 'Paused by user; resume to continue.' : null,
      });
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      updateDuneProgress(run.id, {
        status: 'failed',
        error: message,
        completedAt: new Date().toISOString(),
      });
      finishStep(database, run.id, 'dune_outcomes', 'failed', { error: message });
      updateDataWorkflowRunStatus(database, {
        runId: run.id,
        status: 'failed',
        error: message,
        completed: true,
      });
    },
  );
  return { runId: run.id, status: 'active' };
};

export const retryDataWorkflowWallet = (
  database: DatabaseSync,
  options: { runId: number; walletAddress: string },
): DataWorkflowActionResult => {
  const run = readDataWorkflowRun(database, options.runId);
  if (!run) throw new Error('Workflow run not found.');
  if (hasActiveFetchRun(database)) throw new Error('A GMGN activity fetch is already running.');
  invalidateEvidenceDependentSteps(database, run.id);
  updateDataWorkflowRunStatus(database, { runId: run.id, status: 'active', error: null });
  setStepRunning(database, run.id, 'activity_history', 'gmgn_activity_fetch');
  const activity = startCopyTradeFetch(database, {
    limit: 1,
    periodDays: run.depthMode === 'maximum_available' ? 365 : run.targetDays,
    chain: run.chain,
    walletAddresses: [options.walletAddress],
    refreshWallets: [options.walletAddress],
    scope: 'single',
    workflowRunId: run.id,
    pageBudgetPerWallet: 500,
    terminalStatusOnCancel: 'paused',
  });
  void waitForActivity(database, run.id, activity.runId).then((activityState) => {
    const stepStatus =
      activityState.status === 'failed'
        ? 'failed'
        : activityState.status === 'paused'
          ? 'paused'
          : activityState.completedWithWarnings
            ? 'completed_with_warnings'
            : 'completed';
    finishStep(database, run.id, 'activity_history', stepStatus, {
      underlyingRunId: activity.runId,
      warning: activityState.completedWithWarnings
        ? [
            activityState.failedWallets > 0
              ? `${activityState.failedWallets} wallet${activityState.failedWallets === 1 ? '' : 's'} failed`
              : null,
            activityState.truncatedWallets > 0
              ? `${activityState.truncatedWallets} wallet${activityState.truncatedWallets === 1 ? '' : 's'} were truncated`
              : null,
          ]
            .filter((part): part is string => part !== null)
            .join('; ') || 'The retried wallet is still incomplete or truncated.'
        : undefined,
      error: activityState.status === 'failed' ? activityState.message : undefined,
    });
    updateDataWorkflowRunStatus(database, {
      runId: run.id,
      // A retry is recovery inside the same workflow, not completion of the workflow. Keep the
      // run active so the next coverage verification (and any remaining wallet retries) remains
      // available without creating a misleading new run.
      status: 'active',
      error: stepStatus === 'failed' ? activityState.message : null,
      completed: false,
    });
  });
  return { runId: activity.runId, status: 'active' };
};
