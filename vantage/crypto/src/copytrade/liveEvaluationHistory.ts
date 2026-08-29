import type { DatabaseSync } from 'node:sqlite';
import type { ExperimentalDecisionWallet } from './experimentalDecision.js';

export type EvaluationHistorySource = 'live' | 'decision_lab';
export type EvaluationHistoryVerdict = 'pass' | 'reject' | 'insufficient_evidence';
export type EvaluationComponentScores = {
  historicalProfitability: number | null;
  consistency: number | null;
  robustness: number | null;
  copyability: number | null;
};

export type EvaluationHistoryEntry = {
  id: number;
  walletAddress: string;
  chain: string;
  source: EvaluationHistorySource;
  generatedAt: string;
  score: number | null;
  verdict: EvaluationHistoryVerdict;
  evidenceLevel: string | null;
  componentScores: EvaluationComponentScores;
  createdAt: string;
};

export type EvaluationTrend =
  | { available: false }
  | {
      available: true;
      scoreDelta: number | null;
      direction: 'better' | 'worse' | 'unchanged' | 'unknown';
      verdictChanged: boolean;
      previousSource: EvaluationHistorySource;
      previousGeneratedAt: string;
    };

export type RecordEvaluationHistoryInput = Omit<EvaluationHistoryEntry, 'id' | 'createdAt'>;

export const shouldRecordEvaluationHistory = (
  entry: Pick<RecordEvaluationHistoryInput, 'score' | 'evidenceLevel'>,
): boolean => entry.score !== null && entry.evidenceLevel !== 'missing';

const normalizeVerdict = (
  verdict: ExperimentalDecisionWallet['candidateStatus'],
): EvaluationHistoryVerdict => {
  if (verdict === 'eligible') return 'pass';
  if (verdict === 'rejected') return 'reject';
  return 'insufficient_evidence';
};

const decisionLabComponents = (wallet: ExperimentalDecisionWallet): EvaluationComponentScores => ({
  historicalProfitability: wallet.scores.edge,
  consistency: wallet.scores.consistency,
  robustness: wallet.scores.robustness,
  copyability: wallet.scores.copyability,
});

export const recordEvaluationHistory = (
  database: DatabaseSync,
  entry: RecordEvaluationHistoryInput,
): EvaluationHistoryEntry => {
  const createdAt = new Date().toISOString();
  const result = database
    .prepare(
      `INSERT INTO copytrade_evaluation_history
       (wallet_address, chain, source, generated_at, score, verdict, evidence_level,
        component_scores_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.walletAddress,
      entry.chain,
      entry.source,
      entry.generatedAt,
      entry.score,
      entry.verdict,
      entry.evidenceLevel,
      JSON.stringify(entry.componentScores),
      createdAt,
    );
  const id = Number(result.lastInsertRowid);
  return { ...entry, id, createdAt };
};

export const readEvaluationHistory = (
  database: DatabaseSync,
  walletAddress: string,
  options: { chain?: string; limit?: number } = {},
): EvaluationHistoryEntry[] => {
  const chain = options.chain ?? 'sol';
  const requestedLimit = options.limit ?? 50;
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(200, Math.max(1, Math.floor(requestedLimit)))
    : 50;
  const rows = database
    .prepare(
      `SELECT id, wallet_address AS walletAddress, chain, source, generated_at AS generatedAt,
              score, verdict, evidence_level AS evidenceLevel,
              component_scores_json AS componentScoresJson, created_at AS createdAt
       FROM copytrade_evaluation_history
       WHERE wallet_address = ? AND chain = ?
       ORDER BY id DESC LIMIT ?`,
    )
    .all(walletAddress, chain, limit) as Array<{
    id: number;
    walletAddress: string;
    chain: string;
    source: EvaluationHistorySource;
    generatedAt: string;
    score: number | null;
    verdict: EvaluationHistoryVerdict;
    evidenceLevel: string | null;
    componentScoresJson: string;
    createdAt: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    walletAddress: row.walletAddress,
    chain: row.chain,
    source: row.source,
    generatedAt: row.generatedAt,
    score: row.score,
    verdict: row.verdict,
    evidenceLevel: row.evidenceLevel,
    componentScores: JSON.parse(row.componentScoresJson) as EvaluationComponentScores,
    createdAt: row.createdAt,
  }));
};

export const computeEvaluationTrend = (
  current: Pick<EvaluationHistoryEntry, 'score' | 'verdict'>,
  previous: EvaluationHistoryEntry | null,
): EvaluationTrend => {
  if (!previous) return { available: false };
  const scoreDelta =
    current.score !== null && previous.score !== null
      ? Math.round((current.score - previous.score) * 10) / 10
      : null;
  const direction =
    scoreDelta === null
      ? 'unknown'
      : scoreDelta > 0
        ? 'better'
        : scoreDelta < 0
          ? 'worse'
          : 'unchanged';
  return {
    available: true,
    scoreDelta,
    direction,
    verdictChanged: current.verdict !== previous.verdict,
    previousSource: previous.source,
    previousGeneratedAt: previous.generatedAt,
  };
};

export const decisionLabHistoryEntry = (
  wallet: ExperimentalDecisionWallet,
  generatedAt: string,
  chain = 'sol',
): RecordEvaluationHistoryInput => ({
  walletAddress: wallet.walletAddress,
  chain,
  source: 'decision_lab',
  generatedAt,
  score: wallet.scores.overall,
  verdict: normalizeVerdict(wallet.candidateStatus),
  evidenceLevel: wallet.evidence.level,
  componentScores: decisionLabComponents(wallet),
});
