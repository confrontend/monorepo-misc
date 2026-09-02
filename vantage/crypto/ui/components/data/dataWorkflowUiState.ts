import type { DataWorkflowJobEntry, DataWorkflowStatusResponse } from './dataWorkflowTypes.js';

export type DataWorkflowUiState = {
  activeRun: DataWorkflowStatusResponse['run'];
  phase: DataWorkflowStatusResponse['phase'];
  isActive: boolean;
  isPaused: boolean;
  linkedGmgnJob: DataWorkflowJobEntry | null;
  externalGmgnJob: DataWorkflowJobEntry | null;
  externalBlockers: DataWorkflowJobEntry[];
};

/**
 * Pure selectors over the server's own structured contract -- no string parsing, no
 * re-derivation of what the server's booleans "should" be. `actions`/`jobs`/`shouldPoll` on
 * `DataWorkflowStatusResponse` are authoritative; this module only reshapes them for rendering.
 */
export const deriveDataWorkflowUiState = (
  statusResponse: DataWorkflowStatusResponse | null,
): DataWorkflowUiState => {
  const activeRun = statusResponse?.run ?? null;
  const jobs = statusResponse?.jobs ?? [];
  return {
    activeRun,
    phase: statusResponse?.phase ?? 'ready_for_step',
    isActive: statusResponse?.phase === 'running_step',
    isPaused: activeRun?.status === 'paused',
    linkedGmgnJob:
      jobs.find((job) => job.kind === 'gmgn_fetch' && job.relationship === 'owned') ?? null,
    externalGmgnJob:
      jobs.find((job) => job.kind === 'gmgn_fetch' && job.relationship === 'external') ?? null,
    externalBlockers: jobs.filter((job) => job.relationship === 'external'),
  };
};
