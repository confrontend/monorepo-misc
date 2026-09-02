export type WorkflowRunId = number & { readonly __brand: 'WorkflowRunId' };
export type FetchRunId = number & { readonly __brand: 'FetchRunId' };
export type DuneRunId = number & { readonly __brand: 'DuneRunId' };
export type RosterSnapshotId = number & { readonly __brand: 'RosterSnapshotId' };

export const asWorkflowRunId = (id: number): WorkflowRunId => id as WorkflowRunId;
export const asFetchRunId = (id: number): FetchRunId => id as FetchRunId;
export const asDuneRunId = (id: number): DuneRunId => id as DuneRunId;
export const asRosterSnapshotId = (id: number): RosterSnapshotId => id as RosterSnapshotId;
