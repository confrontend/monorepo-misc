import type { DatabaseSync } from 'node:sqlite';
import { summarizeTrades } from './evaluate.js';
import { filterHashFor, listLeaderboardSnapshotStatuses } from './roster.js';

/**
 * Walk-forward experiments (docs/COPYTRADE_PROSPECTIVE_VALIDATION_PLAN.md Phase 1).
 *
 * A frozen roster answers "if we had selected these wallets at time T, what did they actually
 * do afterward?" — the opposite question from the existing historical screen, which describes
 * a wallet's past without any selection-time boundary. The two must never be presented as the
 * same kind of evidence; see the Phase 5 label split in the plan doc.
 */

export const EXPERIMENT_METHODOLOGY_VERSION = 'copytrade-experiment-v1';
/** Forward-validation windows shown for newly frozen rosters.
 *
 * The one-day checkpoint gives an early read without waiting for the former 90-day
 * horizon. Existing experiments keep the windows they were frozen with so their
 * historical evidence remains immutable.
 */
const MINUTES_PER_DAY = 24 * 60;
/** Forward checkpoints, stored as day fractions for backwards-compatible persistence. */
export const DEFAULT_EVALUATION_WINDOWS_DAYS = [
  10 / MINUTES_PER_DAY,
  30 / MINUTES_PER_DAY,
  1 / 24,
  3 / 24,
  1,
  7,
  30,
];
export const DEFAULT_PRIMARY_TOP_N = 5;
export const DEFAULT_ROSTER_TOP_N = 25;
/** Below this many post-selection completed trades in a matured window, the window is reported
 *  as insufficient rather than as a number — the same floor RULES.minTrades in evaluate.ts uses
 *  for the descriptive screen, reapplied here rather than inventing a second threshold. */
const MIN_MATURED_TRADES = 10;

/** Keep already-frozen default experiments readable after the default window policy changes.
 * The source JSON remains untouched for auditability; only the derived report replaces the
 * former default 90-day checkpoint with the new one-day checkpoint. Explicit custom windows
 * are preserved exactly as frozen. */
const reportWindows = (windows: number[]): number[] => {
  const sorted = [...windows].sort((left, right) => left - right);
  if (sorted.length === 3 && sorted[0] === 7 && sorted[1] === 30 && sorted[2] === 90) return [...DEFAULT_EVALUATION_WINDOWS_DAYS];
  return windows;
};

export type SelectedGroup = 'primary' | 'comparison';

export type FreezeExperimentResult = {
  experimentId: number;
  /** false when an experiment for this snapshot already existed — freezing is idempotent by
   *  leaderboard_snapshot_id, enforced by the schema's UNIQUE constraint, not just app logic. */
  created: boolean;
  selectedAtUtc: string;
  walletCount: number;
};

/**
 * Freezes ranks 1..rosterTopN of a fully provenanced snapshot into an immutable experiment.
 * Throws for a legacy_unprovenanced snapshot (a frozen experiment must be reproducible from its
 * exact source filters) and for a snapshot with no synced roster wallets. Never mutates an
 * existing experiment — a second call for the same snapshot returns the first result untouched.
 */
export const freezeExperiment = (
  database: DatabaseSync,
  snapshotId: number,
  options: { primaryTopN?: number; rosterTopN?: number; evaluationWindowsDays?: number[]; now?: Date } = {},
): FreezeExperimentResult => {
  const now = options.now ?? new Date();
  const primaryTopN = options.primaryTopN ?? DEFAULT_PRIMARY_TOP_N;
  const rosterTopN = options.rosterTopN ?? DEFAULT_ROSTER_TOP_N;
  const evaluationWindowsDays = options.evaluationWindowsDays ?? DEFAULT_EVALUATION_WINDOWS_DAYS;

  const existing = database.prepare(
    `SELECT id, selected_at_utc AS selectedAtUtc FROM copytrade_experiments WHERE leaderboard_snapshot_id = ?`,
  ).get(snapshotId) as { id: number; selectedAtUtc: string } | undefined;
  if (existing) {
    const walletCount = (database.prepare(
      `SELECT COUNT(*) AS c FROM copytrade_experiment_wallets WHERE experiment_id = ?`,
    ).get(existing.id) as { c: number }).c;
    return { experimentId: existing.id, created: false, selectedAtUtc: existing.selectedAtUtc, walletCount };
  }

  const status = listLeaderboardSnapshotStatuses(database).find((entry) => entry.snapshotId === snapshotId);
  if (!status) throw new Error(`No leaderboard snapshot found for id ${snapshotId}.`);
  if (status.provenanceStatus !== 'provenanced' || status.filterHash === null) {
    throw new Error(`Snapshot ${snapshotId} is legacy_unprovenanced and cannot be frozen into a walk-forward experiment.`);
  }
  const provenanceRow = database.prepare(
    `SELECT id FROM gmgn_wallet_rank_capture_provenance WHERE snapshot_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1`,
  ).get(snapshotId) as { id: number } | undefined;
  if (!provenanceRow) throw new Error(`Snapshot ${snapshotId} has no provenance row despite reporting provenanced status.`);

  // Ranks come from copytrade_wallets, the already-validated wallet/rank mapping the roster
  // sync produced for this exact snapshot (rankItemToWallet in roster.ts) — re-parsing the raw
  // leaderboard payload here would risk a second, possibly divergent interpretation of it.
  const walletRows = database.prepare(
    `SELECT wallet_address AS walletAddress, rank_position AS rankPosition, name,
            reported_pnl_30d AS reportedPnl30d, reported_winrate_30d AS reportedWinrate30d, risk_flags AS riskFlags
     FROM copytrade_wallets
     WHERE source_snapshot_id = ? AND rank_position IS NOT NULL AND rank_position <= ?
     ORDER BY rank_position ASC`,
  ).all(snapshotId, rosterTopN) as unknown as Array<{
    walletAddress: string; rankPosition: number; name: string | null;
    reportedPnl30d: string | null; reportedWinrate30d: string | null; riskFlags: string;
  }>;
  if (walletRows.length === 0) {
    throw new Error(`No synced roster wallets found for snapshot ${snapshotId}. Sync the roster from this snapshot before freezing.`);
  }

  const selectedAtUtc = now.toISOString();
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(
      `INSERT INTO copytrade_experiments
         (selected_at_utc, leaderboard_snapshot_id, leaderboard_provenance_id, filter_hash,
          primary_top_n, roster_top_n, evaluation_windows_json, methodology_version, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    ).run(
      selectedAtUtc, snapshotId, provenanceRow.id, status.filterHash,
      primaryTopN, rosterTopN, JSON.stringify(evaluationWindowsDays), EXPERIMENT_METHODOLOGY_VERSION, selectedAtUtc,
    );
    const experimentId = Number((database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);

    const insertWallet = database.prepare(
      `INSERT INTO copytrade_experiment_wallets
         (experiment_id, wallet_address, rank_at_selection, selected_group, captured_source_fields_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const wallet of walletRows) {
      const group: SelectedGroup = wallet.rankPosition <= primaryTopN ? 'primary' : 'comparison';
      insertWallet.run(
        experimentId, wallet.walletAddress, wallet.rankPosition, group,
        JSON.stringify({ name: wallet.name, reportedPnl30d: wallet.reportedPnl30d, reportedWinrate30d: wallet.reportedWinrate30d, riskFlags: wallet.riskFlags }),
        selectedAtUtc,
      );
    }
    database.exec('COMMIT');
    return { experimentId, created: true, selectedAtUtc, walletCount: walletRows.length };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
};

export type WindowState = 'pending' | 'matured' | 'insufficient_coverage';

export type ExperimentWindowResult = {
  windowDays: number;
  state: WindowState;
  windowEndUtc: string;
  trades: number;
  medianReturnPercent: number | null;
  winRatePercent: number | null;
  averageReturnPercent: number | null;
  endingCapitalUsd: number | null;
};

export type ExperimentWalletResult = {
  walletAddress: string;
  rankAtSelection: number;
  selectedGroup: SelectedGroup;
  windows: ExperimentWindowResult[];
};

export type ExperimentReport = {
  experimentId: number;
  selectedAtUtc: string;
  filterHash: string;
  methodologyVersion: string;
  primaryTopN: number;
  rosterTopN: number;
  wallets: ExperimentWalletResult[];
};

/**
 * Evaluates a frozen experiment against trades observed strictly after selection time.
 *
 * The future-only boundary is enforced in the SQL itself (`observed_timestamp > selectedAtSeconds`)
 * rather than only in application code afterward, so there is no code path that can accidentally
 * let a pre-selection trade into a window result.
 */
export const evaluateExperiment = (database: DatabaseSync, experimentId: number, now = new Date()): ExperimentReport => {
  const experiment = database.prepare(
    `SELECT id, selected_at_utc AS selectedAtUtc, filter_hash AS filterHash, primary_top_n AS primaryTopN,
            roster_top_n AS rosterTopN, evaluation_windows_json AS evaluationWindowsJson, methodology_version AS methodologyVersion
     FROM copytrade_experiments WHERE id = ?`,
  ).get(experimentId) as {
    id: number; selectedAtUtc: string; filterHash: string; primaryTopN: number; rosterTopN: number;
    evaluationWindowsJson: string; methodologyVersion: string;
  } | undefined;
  if (!experiment) throw new Error(`No experiment found for id ${experimentId}.`);

  const windowsDays = reportWindows(JSON.parse(experiment.evaluationWindowsJson) as number[]);
  const selectedAtSeconds = Math.floor(Date.parse(experiment.selectedAtUtc) / 1000);
  const nowSeconds = Math.floor(now.getTime() / 1000);

  const walletRows = database.prepare(
    `SELECT wallet_address AS walletAddress, rank_at_selection AS rankAtSelection, selected_group AS selectedGroup
     FROM copytrade_experiment_wallets WHERE experiment_id = ? ORDER BY rank_at_selection ASC`,
  ).all(experimentId) as unknown as Array<{ walletAddress: string; rankAtSelection: number; selectedGroup: SelectedGroup }>;

  const byWallet = new Map<string, Array<{ timestamp: number; returnRatio: number }>>();
  if (walletRows.length > 0) {
    // chain = 'sol' matches every other CopyTrade path today; experiments do not yet carry
    // their own chain column since nothing in this project fetches a non-sol roster.
    const tradeRows = database.prepare(
      `SELECT wallet_address AS walletAddress, observed_timestamp AS observedTimestamp,
              cost_usd AS costUsd, buy_cost_usd AS buyCostUsd
       FROM copytrade_trades
       WHERE chain = 'sol' AND event_type = 'sell' AND observed_timestamp > ?
         AND wallet_address IN (${walletRows.map(() => '?').join(',')})`,
    ).all(selectedAtSeconds, ...walletRows.map((wallet) => wallet.walletAddress)) as unknown as Array<{
      walletAddress: string; observedTimestamp: number; costUsd: string | null; buyCostUsd: string | null;
    }>;
    for (const row of tradeRows) {
      const proceeds = row.costUsd === null ? null : Number(row.costUsd);
      const costBasis = row.buyCostUsd === null ? null : Number(row.buyCostUsd);
      // Same exclusion rule as computeCopyTradeReport: a sell with no known cost basis (tokens
      // transferred in rather than bought) has an unknowable return and is dropped, never zeroed.
      if (proceeds === null || costBasis === null || !Number.isFinite(proceeds) || !Number.isFinite(costBasis) || costBasis <= 0) continue;
      const list = byWallet.get(row.walletAddress) ?? [];
      list.push({ timestamp: row.observedTimestamp, returnRatio: (proceeds - costBasis) / costBasis });
      byWallet.set(row.walletAddress, list);
    }
  }

  const wallets: ExperimentWalletResult[] = walletRows.map((wallet) => {
    const trades = byWallet.get(wallet.walletAddress) ?? [];
    const windows = windowsDays.map((windowDays): ExperimentWindowResult => {
      const windowEndSeconds = selectedAtSeconds + windowDays * 86_400;
      const windowEndUtc = new Date(windowEndSeconds * 1000).toISOString();
      if (nowSeconds < windowEndSeconds) {
        return { windowDays, state: 'pending', windowEndUtc, trades: 0, medianReturnPercent: null, winRatePercent: null, averageReturnPercent: null, endingCapitalUsd: null };
      }
      // A trade exactly on the window boundary still belongs to it; the pending check above
      // already guarantees `now` has reached windowEndSeconds by this point.
      const inWindow = trades.filter((trade) => trade.timestamp <= windowEndSeconds);
      if (inWindow.length < MIN_MATURED_TRADES) {
        return { windowDays, state: 'insufficient_coverage', windowEndUtc, trades: inWindow.length, medianReturnPercent: null, winRatePercent: null, averageReturnPercent: null, endingCapitalUsd: null };
      }
      const summary = summarizeTrades(inWindow);
      return {
        windowDays, state: 'matured', windowEndUtc, trades: summary.trades,
        medianReturnPercent: summary.medianReturnPercent, winRatePercent: summary.winRatePercent,
        averageReturnPercent: summary.averageReturnPercent, endingCapitalUsd: summary.endingCapitalUsd,
      };
    });
    return { walletAddress: wallet.walletAddress, rankAtSelection: wallet.rankAtSelection, selectedGroup: wallet.selectedGroup, windows };
  });

  return {
    experimentId: experiment.id, selectedAtUtc: experiment.selectedAtUtc, filterHash: experiment.filterHash,
    methodologyVersion: experiment.methodologyVersion, primaryTopN: experiment.primaryTopN, rosterTopN: experiment.rosterTopN,
    wallets,
  };
};

export type ExperimentSummary = {
  experimentId: number;
  selectedAtUtc: string;
  filterHash: string;
  /** False whenever the current leaderboard configuration has drifted from the one this
   *  experiment was frozen under (or nothing provenanced has been captured since) — the plan
   *  doc's "do not compare captures produced with different filter hashes as if they were one
   *  history" applies just as much to an experiment as to a raw snapshot. */
  filterMatchesLatestCapture: boolean;
  primaryTopN: number;
  rosterTopN: number;
  walletCount: number;
  windowsDays: number[];
  maturedWindowsDays: number[];
  pendingWindowsDays: number[];
};

/**
 * Lists every frozen experiment, newest first, with a maturity summary computed purely from
 * wall-clock time against selected_at_utc — this never touches copytrade_trades, so listing
 * stays cheap regardless of how many experiments or trades accumulate. Call evaluateExperiment
 * for the real per-wallet numbers once a specific experiment is selected.
 */
export const listExperiments = (database: DatabaseSync, now = new Date()): ExperimentSummary[] => {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const rows = database.prepare(
    `SELECT e.id AS experimentId, e.selected_at_utc AS selectedAtUtc, e.filter_hash AS filterHash,
            e.primary_top_n AS primaryTopN, e.roster_top_n AS rosterTopN, e.evaluation_windows_json AS evaluationWindowsJson,
            (SELECT COUNT(*) FROM copytrade_experiment_wallets w WHERE w.experiment_id = e.id) AS walletCount
     FROM copytrade_experiments e ORDER BY e.selected_at_utc DESC, e.id DESC`,
  ).all() as unknown as Array<{
    experimentId: number; selectedAtUtc: string; filterHash: string; primaryTopN: number; rosterTopN: number;
    evaluationWindowsJson: string; walletCount: number;
  }>;

  const latestProvenanced = listLeaderboardSnapshotStatuses(database)
    .filter((status) => status.provenanceStatus === 'provenanced')
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
    .at(-1);
  const latestFilterHash = latestProvenanced?.filterHash ?? null;

  return rows.map((row): ExperimentSummary => {
    const windowsDays = reportWindows(JSON.parse(row.evaluationWindowsJson) as number[]);
    const selectedAtSeconds = Math.floor(Date.parse(row.selectedAtUtc) / 1000);
    const maturedWindowsDays = windowsDays.filter((days) => nowSeconds >= selectedAtSeconds + days * 86_400);
    const pendingWindowsDays = windowsDays.filter((days) => nowSeconds < selectedAtSeconds + days * 86_400);
    return {
      experimentId: row.experimentId,
      selectedAtUtc: row.selectedAtUtc,
      filterHash: row.filterHash,
      filterMatchesLatestCapture: latestFilterHash !== null && latestFilterHash === row.filterHash,
      primaryTopN: row.primaryTopN,
      rosterTopN: row.rosterTopN,
      walletCount: row.walletCount,
      windowsDays,
      maturedWindowsDays,
      pendingWindowsDays,
    };
  });
};
