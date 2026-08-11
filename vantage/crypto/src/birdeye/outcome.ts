import type { DatabaseSync } from 'node:sqlite';
import { probeBirdeye, type BirdeyeProbeResult } from './probe.js';

export type OutcomeCandidate = { id: number; tokenAddress: string; symbol: string | null; signalType: string | null; observedAt: string; marketCap: number | null };
export type OutcomeTimeline = { signal: OutcomeCandidate; checkpoints: Array<{ label: string; targetTimestamp: string; result: BirdeyeProbeResult }> };

export const listOutcomeCandidates = (database: DatabaseSync, limit = 50): OutcomeCandidate[] => database.prepare(`
  SELECT g.id, g.token_address AS tokenAddress, t.symbol, g.signal_type AS signalType, g.observed_at AS observedAt, g.market_cap AS marketCap
  FROM gmgn_signals g LEFT JOIN tokens t ON t.token_address = g.token_address
  WHERE g.token_address IS NOT NULL AND g.observed_at IS NOT NULL
  ORDER BY observed_at DESC, id DESC LIMIT ?
`).all(Math.min(Math.max(limit, 1), 200)) as unknown as OutcomeCandidate[];

export const measureSignalOutcome = async (database: DatabaseSync, signalId: number): Promise<OutcomeTimeline> => {
  const signal = database.prepare(`SELECT g.id, g.token_address AS tokenAddress, t.symbol, g.signal_type AS signalType, g.observed_at AS observedAt, g.market_cap AS marketCap FROM gmgn_signals g LEFT JOIN tokens t ON t.token_address = g.token_address WHERE g.id = ?`).get(signalId) as OutcomeCandidate | undefined;
  if (!signal?.tokenAddress || !signal.observedAt) throw new Error('Signal must have a token address and observed timestamp.');
  const base = new Date(signal.observedAt);
  if (!Number.isFinite(base.getTime())) throw new Error('Signal timestamp is invalid.');
  const offsets = [['signal', 0], ['+1h', 60 * 60 * 1000], ['+6h', 6 * 60 * 60 * 1000], ['+24h', 24 * 60 * 60 * 1000], ['+7d', 7 * 24 * 60 * 60 * 1000]] as const;
  const checkpoints: OutcomeTimeline['checkpoints'] = [];
  for (const [label, offset] of offsets) {
    const targetTimestamp = new Date(base.getTime() + offset).toISOString();
    checkpoints.push({ label, targetTimestamp, result: await probeBirdeye(database, signal.tokenAddress, targetTimestamp, new Date(), false) });
  }
  return { signal, checkpoints };
};

export const measureSignalsOutcome = async (database: DatabaseSync, signalIds: number[]): Promise<OutcomeTimeline[]> => {
  const uniqueIds = [...new Set(signalIds)].filter((id) => Number.isInteger(id)).slice(0, 25);
  const timelines: OutcomeTimeline[] = [];
  for (const signalId of uniqueIds) timelines.push(await measureSignalOutcome(database, signalId));
  return timelines;
};
