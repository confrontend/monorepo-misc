import type { DataWorkflowRosterResponse } from './dataWorkflowRosterTypes.js';
import type { WorkflowRunId } from './dataWorkflowIds.js';

export type ActivityFetchStatus =
  'idle' | 'running' | 'paused' | 'completed' | 'completed_with_warnings' | 'failed';

export type ActivityFetchWalletProgress = {
  walletAddress: string;
  name: string | null;
  index: number;
  pagesFetched: number;
  activitiesFetched: number;
  oldestActivityAt: string | null;
  newestActivityAt: string | null;
  cursor: string | null;
  nextCursor: string | null;
  reachesRequestedWindow: boolean;
  status: string;
  error: string | null;
};

export type ActivityFetchProgressResponse = {
  runId: number | null; // the underlying copytrade_fetch_runs id -- not a WorkflowRunId
  status: ActivityFetchStatus;
  phase: string | null;
  message: string;
  targetDays: number;
  walletsTotal: number;
  walletsDone: number;
  walletsFailed: number;
  pagesFetched: number;
  activitiesFetched: number;
  recordsNew: number;
  requestsUsed: number;
  currentWallet: ActivityFetchWalletProgress | null;
  requestedWindowStart: string | null;
  requestedWindowEnd: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  elapsedSeconds: number | null;
  estimatedRemainingSeconds: number | null;
  warnings: string[];
  error: string | null;
};

export type HistoryDepthStatus =
  'reached_target' | 'pagination_exhausted' | 'partial' | 'not_fetched' | 'error';

export type DataHistoryCoverageRow = {
  walletAddress: string;
  name: string | null;
  rankPosition: number | null;
  oldestTradeAt: string | null;
  newestTradeAt: string | null;
  daysAvailable: number | null;
  tradeCount: number;
  pagesFetched: number | null;
  deepestCompletedDays: number | null;
  milestones: Record<number, boolean>;
  status: HistoryDepthStatus;
  stopReason: string | null;
  truncated: boolean | null;
  lastError: string | null;
  lastRunId: number | null;
  updatedAt: string | null;
};

export type DataHistoryCoverageResponse = {
  chain: string;
  targetDays: number;
  depthMilestones: number[];
  generatedAt: string;
  availabilitySemantics: {
    oldestRowMeaning?: 'availability_only';
    oldestRowProvesContinuousCoverage?: false;
    description: string;
  };
  rows: DataHistoryCoverageRow[];
  summary: {
    total: number;
    byMilestone: Record<number, number>;
    byStatus: Record<HistoryDepthStatus, number>;
  };
};

export type DatasetReadinessStatus =
  'ready' | 'ready_with_warnings' | 'blocked' | 'not_ready' | 'unknown';

export type DatasetReadinessCheck = {
  key: string;
  label: string;
  status: DatasetReadinessStatus | 'pass' | 'fail' | 'warning' | 'missing';
  required: boolean;
  available: boolean;
  value: string | number | null;
  detail: string;
  disabledReason?: string | null;
};

export type DatasetReadinessResponse = {
  generatedAt: string;
  chain: string;
  targetDays: number;
  status: DatasetReadinessStatus;
  completenessThresholdPercent: number;
  output: {
    totalWallets: number;
    eligibleWallets: number;
    completeWallets: number;
    incompleteWallets: number;
    historicalEvidenceWallets: number;
    currentMetadataWallets: number;
    outcomeCoveredWallets: number;
    analysisWindowStart: string | null;
    analysisWindowEnd: string | null;
  };
  checks: DatasetReadinessCheck[];
  blockers: string[];
  warnings: string[];
};

export type DataWorkflowStepKey =
  | 'roster'
  | 'wallet_metadata'
  | 'activity_history'
  | 'coverage_verification'
  | 'dune_outcomes'
  | 'readiness';

export type DataWorkflowStepStatus =
  'not_started' | 'running' | 'paused' | 'completed' | 'completed_with_warnings' | 'failed';

export type DataWorkflowStepResponse = {
  stepKey: DataWorkflowStepKey;
  stepOrder: number;
  status: DataWorkflowStepStatus;
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
  disabledReason?: string | null;
  action: DataWorkflowActionState;
};

export type DataWorkflowRunStatus =
  'active' | 'paused' | 'completed' | 'completed_with_warnings' | 'failed' | 'abandoned';

export type DataWorkflowRunResponse = {
  id: WorkflowRunId;
  chain: string;
  targetDays: number;
  traderLimit: number;
  rosterSnapshotId: number | null;
  rosterWallets: string[];
  status: DataWorkflowRunStatus;
  completenessThresholdPercent: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
};

export type DataWorkflowJobKind =
  'gmgn_fetch' | 'dune_simulation' | 'dune_outcomes' | 'pattern_research';

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
  kind: DataWorkflowJobKind;
  jobRunId: number;
  workflowRunId: WorkflowRunId | null;
  relationship: 'owned' | 'external';
  status: string;
  stoppable: boolean;
  label: string;
  progress: ActivityFetchProgressResponse | null;
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

export type DataWorkflowStatusResponse = {
  generatedAt: string;
  chain: string;
  targetDays: number;
  run: DataWorkflowRunResponse | null;
  phase:
    | 'ready_for_step'
    | 'running_step'
    | 'paused'
    | 'completed'
    | 'completed_with_warnings'
    | 'failed'
    | 'abandoned';
  steps: DataWorkflowStepResponse[];
  actions: {
    start: DataWorkflowActionState;
    pause: DataWorkflowActionState;
    resume: DataWorkflowActionState;
    finish: DataWorkflowActionState;
    cancel: DataWorkflowActionState;
  };
  jobs: DataWorkflowJobEntry[];
  shouldPoll: boolean;
  metadataProgress: DataWorkflowMetadataProgress | null;
  duneProgress: DataWorkflowDuneProgress | null;
};

export type DataWorkflowProps = {
  api: <T>(url: string, init?: RequestInit) => Promise<T>;
  chain?: string;
  initialTargetDays?: 30 | 60 | 90;
  traderLimit?: number;
};

export type DataWorkflowState = {
  targetDays: number;
  statusResponse: DataWorkflowStatusResponse | null;
  coverage: DataHistoryCoverageResponse | null;
  readiness: DatasetReadinessResponse | null;
  loadingStatus: boolean;
  loadingCoverage: boolean;
  loadingReadiness: boolean;
  error: string | null;
  coverageError: string | null;
  readinessError: string | null;
  rosterResponse: DataWorkflowRosterResponse | null;
  loadingRoster: boolean;
  rosterLoadError: string | null;
  selectedWallets: Set<string>;
  walletSelectionOpen: boolean;
  busyAction:
    'start' | 'pause' | 'resume' | 'finish' | 'cancel' | 'step' | 'refresh' | 'stop' | null;
  rosterBusy: 'refresh' | 'import' | null;
  rosterError: string | null;
  retryingWallet: string | null;
};
