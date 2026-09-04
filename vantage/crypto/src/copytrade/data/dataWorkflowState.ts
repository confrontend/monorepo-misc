import type { DatabaseSync } from 'node:sqlite';
import { listRosterWallets } from '../screening/roster.js';
import {
  readHistoryDepthCoverage,
  type HistoryDepthCoverageInventory,
} from '../features/walletFeatureCoverage.js';
import {
  readDataWorkflowRun,
  readLatestDataWorkflowRun,
  DATA_WORKFLOW_STEP_ORDER,
  type DataWorkflowRunWithSteps,
  type DataWorkflowStepKey,
  type DataWorkflowStepStatus,
} from './dataWorkflowRunStore.js';
import {
  readPatternDiscoveryDataFingerprint,
  readPatternDiscoveryCache,
  patternDiscoveryCacheKey,
  MAX_PATTERN_DISCOVERY_WALLETS,
} from '../discovery/patternDiscovery.js';
import { readExperimentalDecisionWeighting } from '../experimentalDecision.js';
import { readDuneOutcomeReadiness } from '../discovery/duneOutcomeReadiness.js';
import { readProductionJobLock } from './productionJobLock.js';
import type { WorkflowRunId } from './workflowIds.js';

const DEFAULT_COMPLETENESS_THRESHOLD_PERCENT = 90;
const DEPTH_MILESTONES = [30, 60, 90];

export type DataWorkflowStepView = {
  stepKey: DataWorkflowStepKey;
  stepOrder: number;
  /** The raw, persisted status column -- never trusted on its own for gating. */
  storedStatus: DataWorkflowStepStatus;
  /** Verified against CURRENT evidence: a step stored as `completed` whose underlying evidence
   *  no longer supports that (e.g. the roster changed, or nothing was ever actually fetched)
   *  reports its real status here instead, so a stale flag can never silently unlock the next
   *  step. */
  status: DataWorkflowStepStatus;
  counts: { total: number; newRecords: number; complete: number; failed: number };
  warnings: string[];
  disabledReason: string | null;
};

export type DataWorkflowState = {
  run: DataWorkflowRunWithSteps | null;
  chain: string;
  targetDays: number;
  depthMode: 'requested' | 'maximum_available';
  completenessThresholdPercent: number;
  rosterWallets: string[];
  steps: DataWorkflowStepView[];
  counts: {
    coverage: {
      ready: boolean;
      requiredWallets: number;
      completeWallets: number;
      completePercent: number;
      thresholdPercent: number;
      milestones: Record<number, number>;
      /** Wallets whose most recent fetch attempt was worse (truncated/page-budget/cursor-stall)
       *  than an earlier genuine completion they already have. The earlier depth still counts --
       *  see the `dataWorkflowState.ts` module doc -- but this is surfaced as a warning so a
       *  regressed re-fetch is never silently invisible. */
      supersededAttemptWallets: number;
      inventory: HistoryDepthCoverageInventory | null;
    };
    stats: {
      ready: boolean;
      freshRows: number;
      durableEventRows: number;
      freshDurableRows: number;
      requiredRows: number;
      currentRows: number;
    };
    dune: {
      ready: boolean;
      status: 'ready' | 'ready_with_warnings' | 'not_ready' | 'running';
      targetCount: number;
      matchedTargetCount: number;
      noMatchTargetCount: number;
    };
    pattern: {
      ready: boolean;
      status: 'ready' | 'ready_with_warnings' | 'not_ready';
      promotedPatternCount: number;
      reason: string | null;
    };
    decision: {
      ready: boolean;
      status: 'ready' | 'not_ready';
      weightingMode: 'neutral-fallback' | 'validated-patterns' | null;
      reason: string | null;
    };
  };
  warnings: string[];
};

const requiredCount = (total: number, thresholdPercent: number): number =>
  Math.ceil((total * thresholdPercent) / 100);

const readStatsCoverage = (
  database: DatabaseSync,
  chain: string,
  walletAddresses: string[],
  requiredRows: number,
): DataWorkflowState['counts']['stats'] => {
  if (walletAddresses.length === 0) {
    return {
      ready: false,
      freshRows: 0,
      durableEventRows: 0,
      freshDurableRows: 0,
      requiredRows,
      currentRows: 0,
    };
  }
  const placeholders = walletAddresses.map(() => '?').join(',');
  const freshRow = database
    .prepare(
      `SELECT COUNT(DISTINCT wallet_address) AS count FROM copytrade_wallet_stats
       WHERE chain = ? AND period = '30d' AND wallet_address IN (${placeholders})`,
    )
    .get(chain, ...walletAddresses) as { count: number };
  const durableRow = database
    .prepare(
      `SELECT COUNT(DISTINCT wallet_address) AS count FROM copytrade_wallet_stats_events
       WHERE chain = ? AND period = '30d' AND wallet_address IN (${placeholders})`,
    )
    .get(chain, ...walletAddresses) as { count: number };
  const unionRow = database
    .prepare(
      `SELECT COUNT(DISTINCT wallet_address) AS count FROM (
         SELECT wallet_address FROM copytrade_wallet_stats WHERE chain = ? AND period = '30d' AND wallet_address IN (${placeholders})
         UNION
         SELECT wallet_address FROM copytrade_wallet_stats_events WHERE chain = ? AND period = '30d' AND wallet_address IN (${placeholders})
       )`,
    )
    .get(chain, ...walletAddresses, chain, ...walletAddresses) as { count: number };
  const freshRows = Number(freshRow.count);
  const durableEventRows = Number(durableRow.count);
  const freshDurableRows = Number(unionRow.count);
  return {
    ready: freshDurableRows >= requiredRows,
    freshRows,
    durableEventRows,
    freshDurableRows,
    requiredRows,
    currentRows: freshRows,
  };
};

/** Read only the Dune target legs owned by one Data workflow run. Readiness remains based on all
 * reusable saved evidence, but the Step 5 progress counter must not turn another run's matches
 * into progress for the run currently displayed. */
const readDuneRunProgress = (
  database: DatabaseSync,
  workflowRunId: WorkflowRunId,
): Pick<
  DataWorkflowState['counts']['dune'],
  'targetCount' | 'matchedTargetCount' | 'noMatchTargetCount'
> => {
  const runs = database
    .prepare(
      `SELECT id, trade_refs AS tradeRefs
       FROM copytrade_copy_simulation_runs
       WHERE workflow_run_id = ?
       ORDER BY id ASC`,
    )
    .all(workflowRunId) as unknown as Array<{ id: number; tradeRefs: string }>;
  const targetIds = new Set<number>();
  const runIds: number[] = [];
  for (const run of runs) {
    runIds.push(run.id);
    try {
      const refs = JSON.parse(run.tradeRefs) as unknown;
      if (Array.isArray(refs)) {
        for (const tradeId of refs) if (Number.isInteger(tradeId)) targetIds.add(Number(tradeId));
      }
    } catch {
      // A malformed Dune run is still visible through its run status, but contributes no
      // fabricated target count here.
    }
  }
  if (runIds.length === 0) return { targetCount: 0, matchedTargetCount: 0, noMatchTargetCount: 0 };

  const placeholders = runIds.map(() => '?').join(', ');
  const resultRows = database
    .prepare(
      `SELECT status, COUNT(DISTINCT trade_id) AS count
       FROM copytrade_copy_simulation_matches
       WHERE run_id IN (${placeholders})
       GROUP BY status`,
    )
    .all(...runIds) as unknown as Array<{ status: string; count: number }>;
  const matchedTargetCount = Number(resultRows.find((row) => row.status === 'matched')?.count ?? 0);
  const noMatchTargetCount = Number(
    resultRows.find((row) => row.status === 'no_trade_in_window')?.count ?? 0,
  );
  return {
    targetCount: targetIds.size,
    matchedTargetCount,
    noMatchTargetCount,
  };
};

const readDuneCoverage = (
  database: DatabaseSync,
  chain: string,
  walletAddresses: string[],
  targetDays: number,
  workflowRunId: WorkflowRunId | undefined,
): DataWorkflowState['counts']['dune'] => {
  if (walletAddresses.length === 0) {
    return {
      ready: false,
      status: 'not_ready',
      targetCount: 0,
      matchedTargetCount: 0,
      noMatchTargetCount: 0,
    };
  }
  // Reuse the same chain/period-scoped report for readiness, so old saved outcomes remain usable
  // without making the current run appear complete. Progress itself is scoped below to the
  // current workflow's owned Dune batches.
  const availability = readDuneOutcomeReadiness(database, {
    walletAddresses,
    chain,
    periodDays: targetDays,
  });

  // Reuse the production-job lock as the single source of truth for "is a Dune job running" --
  // this step's status intentionally counts BOTH a workflow-owned batch and a genuinely external
  // one as "running" (the stepper shows running activity either way), whereas the lock used to
  // gate start/resume elsewhere counts only external blockers. Same underlying data, two
  // legitimate questions -- not two competing state machines.
  const lock = readProductionJobLock(database, { workflowRunId });
  const duneRunning = lock.blockers.some(
    (blocker) => blocker.kind === 'dune_simulation' || blocker.kind === 'dune_outcomes',
  );
  const progress =
    workflowRunId === undefined ? availability : readDuneRunProgress(database, workflowRunId);

  return {
    ready: availability.available,
    status: duneRunning ? 'running' : availability.available ? 'ready' : 'not_ready',
    targetCount: progress.targetCount,
    matchedTargetCount: progress.matchedTargetCount,
    noMatchTargetCount: progress.noMatchTargetCount,
  };
};

const readPatternReadiness = (
  database: DatabaseSync,
  periodDays: number,
): DataWorkflowState['counts']['pattern'] => {
  const fingerprint = readPatternDiscoveryDataFingerprint(database);
  const cacheKey = patternDiscoveryCacheKey(
    'sensitivity',
    periodDays,
    50,
    10,
    MAX_PATTERN_DISCOVERY_WALLETS,
  );
  const cached = readPatternDiscoveryCache<{ crossCoveragePromotedPatterns?: unknown[] }>(
    database,
    cacheKey,
    fingerprint,
  );
  if (!cached) {
    return {
      ready: false,
      status: 'not_ready',
      promotedPatternCount: 0,
      reason: 'No current Pattern Research result exists for this evidence.',
    };
  }
  const promotedPatternCount = Array.isArray(cached.crossCoveragePromotedPatterns)
    ? cached.crossCoveragePromotedPatterns.length
    : 0;
  return {
    ready: true,
    status: promotedPatternCount > 0 ? 'ready' : 'ready_with_warnings',
    promotedPatternCount,
    reason:
      promotedPatternCount > 0
        ? null
        : 'A current Pattern Research result exists but has no cross-coverage promoted patterns yet.',
  };
};

const readDecisionReadiness = (
  database: DatabaseSync,
  rosterWallets: string[],
  periodDays: number,
): DataWorkflowState['counts']['decision'] => {
  if (rosterWallets.length === 0) {
    return {
      ready: false,
      status: 'not_ready',
      weightingMode: null,
      reason: 'No wallet roster is prepared yet.',
    };
  }
  try {
    const weighting = readExperimentalDecisionWeighting(database, undefined, periodDays);
    return { ready: true, status: 'ready', weightingMode: weighting.mode, reason: null };
  } catch (error) {
    return {
      ready: false,
      status: 'not_ready',
      weightingMode: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

const stepCountsFor = (
  key: DataWorkflowStepKey,
  roster: string[],
  coverage: DataWorkflowState['counts']['coverage'],
  stats: DataWorkflowState['counts']['stats'],
  dune: DataWorkflowState['counts']['dune'],
): DataWorkflowStepView['counts'] => {
  switch (key) {
    case 'roster':
      return { total: roster.length, newRecords: 0, complete: roster.length, failed: 0 };
    case 'wallet_metadata':
      return {
        total: roster.length,
        newRecords: 0,
        complete: stats.freshRows,
        failed: Math.max(0, roster.length - stats.freshRows),
      };
    case 'activity_history':
    case 'coverage_verification':
      return {
        total: coverage.inventory?.summary.total ?? 0,
        newRecords: 0,
        complete: coverage.completeWallets,
        failed: coverage.inventory?.summary.byStatus.error ?? 0,
      };
    case 'dune_outcomes':
      return {
        total: dune.targetCount,
        newRecords: 0,
        complete: dune.matchedTargetCount,
        failed: dune.noMatchTargetCount,
      };
    case 'readiness':
    default:
      return { total: 0, newRecords: 0, complete: 0, failed: 0 };
  }
};

/** True verified completion for a step -- computed from CURRENT evidence, never from the stored
 *  flag alone (see DataWorkflowStepView.status doc). */
const verifiedStatusFor = (
  key: DataWorkflowStepKey,
  storedStatus: DataWorkflowStepStatus,
  roster: string[],
  coverage: DataWorkflowState['counts']['coverage'],
  stats: DataWorkflowState['counts']['stats'],
  dune: DataWorkflowState['counts']['dune'],
): DataWorkflowStepStatus => {
  // A step actively running/paused reports that live state regardless of what current evidence
  // shows -- those are process states, not evidence claims.
  if (storedStatus === 'running' || storedStatus === 'paused' || storedStatus === 'failed') {
    return storedStatus;
  }
  const evidenceStatus = (ready: boolean): DataWorkflowStepStatus => {
    if (ready) return storedStatus === 'completed_with_warnings' ? storedStatus : 'completed';
    // The process can finish while the evidence remains below the declared completeness
    // threshold. Preserve that fact as a warning instead of relabelling completed work as
    // "Not Started".
    return storedStatus === 'completed' || storedStatus === 'completed_with_warnings'
      ? 'completed_with_warnings'
      : 'not_started';
  };
  switch (key) {
    case 'roster':
      return roster.length > 0 ? 'completed' : 'not_started';
    case 'wallet_metadata':
      return stats.ready
        ? storedStatus === 'completed_with_warnings'
          ? storedStatus
          : 'completed'
        : 'not_started';
    case 'activity_history':
      return evidenceStatus(coverage.ready);
    case 'coverage_verification':
      return evidenceStatus(coverage.ready);
    case 'dune_outcomes':
      return dune.ready
        ? storedStatus === 'completed_with_warnings'
          ? storedStatus
          : 'completed'
        : 'not_started';
    case 'readiness':
      return coverage.ready && stats.ready && dune.ready ? 'completed' : 'not_started';
    default:
      return storedStatus;
  }
};

const disabledReasonFor = (
  key: DataWorkflowStepKey,
  roster: string[],
  coverage: DataWorkflowState['counts']['coverage'],
): string | null => {
  switch (key) {
    case 'wallet_metadata':
      return roster.length === 0 ? 'Prepare the wallet roster first.' : null;
    case 'activity_history':
      return roster.length === 0 ? 'Prepare the wallet roster first.' : null;
    case 'dune_outcomes':
      return coverage.ready
        ? null
        : `Complete GMGN wallet-history fetch before Dune outcome fetching (${coverage.completeWallets}/${coverage.requiredWallets} wallets have reached the provider limit).`;
    default:
      return null;
  }
};

export const readDataWorkflowState = (
  database: DatabaseSync,
  options: { runId?: number; chain?: string; targetDays?: number; now?: Date } = {},
): DataWorkflowState => {
  const run = options.runId !== undefined ? readDataWorkflowRun(database, options.runId) : null;
  const chain = run?.chain ?? options.chain ?? 'sol';
  const targetDays = run?.targetDays ?? options.targetDays ?? 30;
  const depthMode = run?.depthMode ?? 'requested';
  const coverageTargetDays = depthMode === 'maximum_available' ? 365 : targetDays;
  const completenessThresholdPercent =
    run?.completenessThresholdPercent ??
    readLatestDataWorkflowRun(database, chain)?.completenessThresholdPercent ??
    DEFAULT_COMPLETENESS_THRESHOLD_PERCENT;

  const rosterWallets =
    run?.rosterWallets ??
    listRosterWallets(database, { chain }).map((wallet) => wallet.walletAddress);

  const requiredWallets =
    depthMode === 'maximum_available'
      ? rosterWallets.length
      : requiredCount(rosterWallets.length, completenessThresholdPercent);
  const inventory =
    rosterWallets.length > 0
      ? readHistoryDepthCoverage(database, {
          walletAddresses: rosterWallets,
          chain,
          targetDays: coverageTargetDays,
          depthMilestones: DEPTH_MILESTONES,
        })
      : null;
  const completeWallets =
    depthMode === 'maximum_available'
      ? (inventory?.rows.filter(
          (row) => row.status === 'reached_target' || row.status === 'pagination_exhausted',
        ).length ?? 0)
      : (inventory?.summary.byMilestone[targetDays] ?? 0);
  const supersededAttemptWallets =
    inventory?.rows.filter((row) => row.truncated === true && row.deepestCompletedDays !== null)
      .length ?? 0;

  const coverage: DataWorkflowState['counts']['coverage'] = {
    ready: completeWallets >= requiredWallets && requiredWallets > 0,
    requiredWallets,
    completeWallets,
    completePercent: rosterWallets.length > 0 ? (completeWallets / rosterWallets.length) * 100 : 0,
    thresholdPercent: completenessThresholdPercent,
    milestones: inventory?.summary.byMilestone ?? {},
    supersededAttemptWallets,
    inventory,
  };

  const stats = readStatsCoverage(database, chain, rosterWallets, requiredWallets);
  const dune = readDuneCoverage(
    database,
    chain,
    rosterWallets,
    targetDays,
    run?.id as WorkflowRunId | undefined,
  );
  const pattern = readPatternReadiness(database, targetDays);
  const decision = readDecisionReadiness(database, rosterWallets, targetDays);

  const steps: DataWorkflowStepView[] = DATA_WORKFLOW_STEP_ORDER.map((key, index) => {
    const persisted = run?.steps.find((step) => step.stepKey === key);
    const storedStatus = persisted?.status ?? 'not_started';
    return {
      stepKey: key,
      stepOrder: index + 1,
      storedStatus,
      status: verifiedStatusFor(key, storedStatus, rosterWallets, coverage, stats, dune),
      counts: stepCountsFor(key, rosterWallets, coverage, stats, dune),
      warnings: persisted?.warnings ?? [],
      disabledReason: disabledReasonFor(key, rosterWallets, coverage),
    };
  });

  const warnings: string[] = [];
  if (supersededAttemptWallets > 0) {
    warnings.push(
      `${supersededAttemptWallets} wallet${supersededAttemptWallets === 1 ? '' : 's'} had a later fetch attempt that was truncated or interrupted; the earlier verified depth remains usable for research.`,
    );
  }

  return {
    run,
    chain,
    targetDays,
    depthMode,
    completenessThresholdPercent,
    rosterWallets,
    steps,
    counts: { coverage, stats, dune, pattern, decision },
    warnings,
  };
};
