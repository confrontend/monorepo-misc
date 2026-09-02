import type { DatabaseSync } from 'node:sqlite';

export type JsonObject = Record<string, unknown>;

export type WalletFeatureSnapshotTrigger = 'event' | 'calendar' | 'current';

export type WalletFeatureSnapshotIdentity = {
  walletAddress: string;
  chain: string;
  asOfTimestamp: string;
  lookbackDays: number | null;
  triggerKind: WalletFeatureSnapshotTrigger;
  featureEngineVersion: string;
  sourceDataRevision: number;
};

export type WalletFeatureSnapshotRecord = WalletFeatureSnapshotIdentity & {
  id: number;
  coverageStartTimestamp: string | null;
  coverageEndTimestamp: string | null;
  quality: JsonObject;
  features: JsonObject;
  createdAt: string;
};

export type WriteWalletFeatureSnapshotInput = WalletFeatureSnapshotIdentity & {
  coverageStartTimestamp?: string | null;
  coverageEndTimestamp?: string | null;
  quality: JsonObject;
  features: JsonObject;
  createdAt?: string;
};

export type WriteWalletFeatureSnapshotResult = {
  snapshot: WalletFeatureSnapshotRecord;
  inserted: boolean;
};

export type DecisionCalibrationStatus = 'pending' | 'running' | 'completed' | 'failed';

export type DecisionCalibrationWalletRecord = {
  runId: number;
  snapshotId: number;
  walletAddress: string;
  scoreInputs: JsonObject;
  futureOutcome: JsonObject | null;
  eligibility: JsonObject;
};

export type DecisionCalibrationRunRecord = {
  id: number;
  featureEngineVersion: string;
  decisionModelVersion: string;
  patternProfileKey: string | null;
  snapshotStartTimestamp: string;
  snapshotEndTimestamp: string;
  outcomeHorizonDays: number;
  methodology: JsonObject;
  status: DecisionCalibrationStatus;
  createdAt: string;
  completedAt: string | null;
  wallets: DecisionCalibrationWalletRecord[];
};

export type WriteDecisionCalibrationRunInput = {
  featureEngineVersion: string;
  decisionModelVersion: string;
  patternProfileKey?: string | null;
  snapshotStartTimestamp: string;
  snapshotEndTimestamp: string;
  outcomeHorizonDays: number;
  methodology: JsonObject;
  status?: DecisionCalibrationStatus;
  createdAt?: string;
  completedAt?: string | null;
  wallets: Array<{
    snapshotId: number;
    walletAddress: string;
    scoreInputs: JsonObject;
    futureOutcome?: JsonObject | null;
    eligibility: JsonObject;
  }>;
};

type SnapshotRow = {
  id: number;
  walletAddress: string;
  chain: string;
  asOfTimestamp: string;
  lookbackDays: number | null;
  triggerKind: WalletFeatureSnapshotTrigger;
  featureEngineVersion: string;
  sourceDataRevision: number;
  coverageStartTimestamp: string | null;
  coverageEndTimestamp: string | null;
  qualityJson: string;
  featuresJson: string;
  createdAt: string;
};

type CalibrationRunRow = {
  id: number;
  featureEngineVersion: string;
  decisionModelVersion: string;
  patternProfileKey: string | null;
  snapshotStartTimestamp: string;
  snapshotEndTimestamp: string;
  outcomeHorizonDays: number;
  methodologyJson: string;
  status: DecisionCalibrationStatus;
  createdAt: string;
  completedAt: string | null;
};

type CalibrationWalletRow = {
  runId: number;
  snapshotId: number;
  walletAddress: string;
  scoreInputsJson: string;
  futureOutcomeJson: string | null;
  eligibilityJson: string;
};

const parseJsonObject = (value: string, field: string): JsonObject => {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${field} must contain a JSON object.`);
  }
  return parsed as JsonObject;
};

const snapshotFromRow = (row: SnapshotRow): WalletFeatureSnapshotRecord => ({
  id: row.id,
  walletAddress: row.walletAddress,
  chain: row.chain,
  asOfTimestamp: row.asOfTimestamp,
  lookbackDays: row.lookbackDays,
  triggerKind: row.triggerKind,
  featureEngineVersion: row.featureEngineVersion,
  sourceDataRevision: row.sourceDataRevision,
  coverageStartTimestamp: row.coverageStartTimestamp,
  coverageEndTimestamp: row.coverageEndTimestamp,
  quality: parseJsonObject(row.qualityJson, 'quality_json'),
  features: parseJsonObject(row.featuresJson, 'features_json'),
  createdAt: row.createdAt,
});

const SNAPSHOT_SELECT = `
  SELECT id, wallet_address AS walletAddress, chain, as_of_timestamp AS asOfTimestamp,
         lookback_days AS lookbackDays, trigger_kind AS triggerKind,
         feature_engine_version AS featureEngineVersion,
         source_data_revision AS sourceDataRevision,
         coverage_start_timestamp AS coverageStartTimestamp,
         coverage_end_timestamp AS coverageEndTimestamp,
         quality_json AS qualityJson, features_json AS featuresJson, created_at AS createdAt
  FROM copytrade_wallet_feature_snapshots`;

const readWalletFeatureSnapshot = (
  database: DatabaseSync,
  identity: WalletFeatureSnapshotIdentity,
): WalletFeatureSnapshotRecord | null => {
  const row = database
    .prepare(
      `${SNAPSHOT_SELECT}
       WHERE wallet_address = ? AND chain = ? AND as_of_timestamp = ?
         AND lookback_days IS ? AND trigger_kind = ? AND feature_engine_version = ?
         AND source_data_revision = ?`,
    )
    .get(
      identity.walletAddress,
      identity.chain,
      identity.asOfTimestamp,
      identity.lookbackDays,
      identity.triggerKind,
      identity.featureEngineVersion,
      identity.sourceDataRevision,
    ) as SnapshotRow | undefined;
  return row ? snapshotFromRow(row) : null;
};

export const writeWalletFeatureSnapshot = (
  database: DatabaseSync,
  input: WriteWalletFeatureSnapshotInput,
): WriteWalletFeatureSnapshotResult => {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const result = database
    .prepare(
      `INSERT OR IGNORE INTO copytrade_wallet_feature_snapshots
       (wallet_address, chain, as_of_timestamp, lookback_days, trigger_kind,
        feature_engine_version, source_data_revision, coverage_start_timestamp,
        coverage_end_timestamp, quality_json, features_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.walletAddress,
      input.chain,
      input.asOfTimestamp,
      input.lookbackDays,
      input.triggerKind,
      input.featureEngineVersion,
      input.sourceDataRevision,
      input.coverageStartTimestamp ?? null,
      input.coverageEndTimestamp ?? null,
      JSON.stringify(input.quality),
      JSON.stringify(input.features),
      createdAt,
    ) as { changes: number | bigint };
  const snapshot = readWalletFeatureSnapshot(database, input);
  if (!snapshot) throw new Error('Wallet feature snapshot could not be persisted.');
  return { snapshot, inserted: Number(result.changes) === 1 };
};

export const listWalletFeatureSnapshots = (
  database: DatabaseSync,
  walletAddress: string,
  options: { chain?: string; limit?: number } = {},
): WalletFeatureSnapshotRecord[] => {
  const requestedLimit = options.limit ?? 100;
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(1_000, Math.max(1, Math.floor(requestedLimit)))
    : 100;
  const rows = database
    .prepare(
      `${SNAPSHOT_SELECT}
       WHERE wallet_address = ? AND chain = ?
       ORDER BY as_of_timestamp DESC, id DESC LIMIT ?`,
    )
    .all(walletAddress, options.chain ?? 'sol', limit) as SnapshotRow[];
  return rows.map(snapshotFromRow);
};

const calibrationWalletFromRow = (row: CalibrationWalletRow): DecisionCalibrationWalletRecord => ({
  runId: row.runId,
  snapshotId: row.snapshotId,
  walletAddress: row.walletAddress,
  scoreInputs: parseJsonObject(row.scoreInputsJson, 'score_inputs_json'),
  futureOutcome: row.futureOutcomeJson
    ? parseJsonObject(row.futureOutcomeJson, 'future_outcome_json')
    : null,
  eligibility: parseJsonObject(row.eligibilityJson, 'eligibility_json'),
});

export const readDecisionCalibrationRun = (
  database: DatabaseSync,
  runId: number,
): DecisionCalibrationRunRecord | null => {
  const row = database
    .prepare(
      `SELECT id, feature_engine_version AS featureEngineVersion,
              decision_model_version AS decisionModelVersion,
              pattern_profile_key AS patternProfileKey,
              snapshot_start_timestamp AS snapshotStartTimestamp,
              snapshot_end_timestamp AS snapshotEndTimestamp,
              outcome_horizon_days AS outcomeHorizonDays,
              methodology_json AS methodologyJson, status, created_at AS createdAt,
              completed_at AS completedAt
       FROM copytrade_decision_calibration_runs WHERE id = ?`,
    )
    .get(runId) as CalibrationRunRow | undefined;
  if (!row) return null;
  const walletRows = database
    .prepare(
      `SELECT run_id AS runId, snapshot_id AS snapshotId, wallet_address AS walletAddress,
              score_inputs_json AS scoreInputsJson, future_outcome_json AS futureOutcomeJson,
              eligibility_json AS eligibilityJson
       FROM copytrade_decision_calibration_wallets
       WHERE run_id = ? ORDER BY wallet_address, snapshot_id`,
    )
    .all(runId) as CalibrationWalletRow[];
  return {
    id: row.id,
    featureEngineVersion: row.featureEngineVersion,
    decisionModelVersion: row.decisionModelVersion,
    patternProfileKey: row.patternProfileKey,
    snapshotStartTimestamp: row.snapshotStartTimestamp,
    snapshotEndTimestamp: row.snapshotEndTimestamp,
    outcomeHorizonDays: row.outcomeHorizonDays,
    methodology: parseJsonObject(row.methodologyJson, 'methodology_json'),
    status: row.status,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    wallets: walletRows.map(calibrationWalletFromRow),
  };
};

export const writeDecisionCalibrationRun = (
  database: DatabaseSync,
  input: WriteDecisionCalibrationRunInput,
): DecisionCalibrationRunRecord => {
  let runId: number;
  database.exec('BEGIN IMMEDIATE;');
  try {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const runResult = database
      .prepare(
        `INSERT INTO copytrade_decision_calibration_runs
         (feature_engine_version, decision_model_version, pattern_profile_key,
          snapshot_start_timestamp, snapshot_end_timestamp, outcome_horizon_days,
          methodology_json, status, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.featureEngineVersion,
        input.decisionModelVersion,
        input.patternProfileKey ?? null,
        input.snapshotStartTimestamp,
        input.snapshotEndTimestamp,
        input.outcomeHorizonDays,
        JSON.stringify(input.methodology),
        input.status ?? 'pending',
        createdAt,
        input.completedAt ?? null,
      ) as { lastInsertRowid: number | bigint };
    runId = Number(runResult.lastInsertRowid);
    const readSnapshot = database.prepare(
      `SELECT wallet_address AS walletAddress,
              feature_engine_version AS featureEngineVersion
       FROM copytrade_wallet_feature_snapshots WHERE id = ?`,
    );
    const insertWallet = database.prepare(
      `INSERT INTO copytrade_decision_calibration_wallets
       (run_id, snapshot_id, wallet_address, score_inputs_json,
        future_outcome_json, eligibility_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const wallet of input.wallets) {
      const snapshot = readSnapshot.get(wallet.snapshotId) as
        { walletAddress: string; featureEngineVersion: string } | undefined;
      if (!snapshot)
        throw new Error(`Wallet feature snapshot ${wallet.snapshotId} does not exist.`);
      if (snapshot.walletAddress !== wallet.walletAddress) {
        throw new Error(
          `Snapshot ${wallet.snapshotId} does not belong to ${wallet.walletAddress}.`,
        );
      }
      if (snapshot.featureEngineVersion !== input.featureEngineVersion) {
        throw new Error(
          `Snapshot ${wallet.snapshotId} uses feature engine ${snapshot.featureEngineVersion}, not ${input.featureEngineVersion}.`,
        );
      }
      insertWallet.run(
        runId,
        wallet.snapshotId,
        wallet.walletAddress,
        JSON.stringify(wallet.scoreInputs),
        wallet.futureOutcome === null || wallet.futureOutcome === undefined
          ? null
          : JSON.stringify(wallet.futureOutcome),
        JSON.stringify(wallet.eligibility),
      );
    }
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
  const run = readDecisionCalibrationRun(database, runId);
  if (!run) throw new Error(`Decision calibration run ${runId} could not be read after commit.`);
  return run;
};

export const updateDecisionCalibrationRunStatus = (
  database: DatabaseSync,
  runId: number,
  status: DecisionCalibrationStatus,
  completedAt: string | null = null,
): DecisionCalibrationRunRecord => {
  const result = database
    .prepare(
      `UPDATE copytrade_decision_calibration_runs
       SET status = ?, completed_at = ? WHERE id = ?`,
    )
    .run(status, completedAt, runId) as { changes: number | bigint };
  if (Number(result.changes) !== 1)
    throw new Error(`Decision calibration run ${runId} was not found.`);
  const run = readDecisionCalibrationRun(database, runId);
  if (!run) throw new Error(`Decision calibration run ${runId} could not be read after update.`);
  return run;
};
