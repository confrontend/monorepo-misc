import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { readDuneApiKey } from '../dune/credentials.js';
import { waitForDuneCapacity, withDuneSubmissionLock } from './duneScheduler.js';

// Duplicated rather than imported from topCallers.ts to avoid a circular module dependency
// (topCallers.ts calls into this module's runCheckpointBatch) — same small-helper-duplication
// tolerance this project already applies to findProjectRoot across capture.ts/browserImport.ts.
const listTrackedCallerKeys = (database: DatabaseSync): string[] => {
  const rows = database.prepare(
    `SELECT caller_key AS callerKey FROM top_caller_tracked WHERE untracked_at IS NULL ORDER BY tracked_at ASC`,
  ).all() as unknown as Array<{ callerKey: string }>;
  return rows.map((row) => row.callerKey);
};

/**
 * Dune-based checkpoint measurement for Top Caller callouts — the piece explicitly deferred
 * when real KOL-trade capture was wired up (see progress.md 2026-08-17). Mirrors
 * src/dune/outcomes.ts's "latest trade at/before target time" query shape (checkpoint = a point
 * in time, not "nearest fill after a delay" like copySimulationDune.ts's copier-fill semantics)
 * and src/copytrade/copySimulationDune.ts's single-batch execute/poll/results/archive plumbing,
 * rather than inventing a third variant of either.
 *
 * Scope this deliberately does NOT cover, disclosed rather than silently approximated: unlike
 * outcomes.ts, this does not re-validate an already-measured checkpoint if a later, better-
 * indexed Dune row would change the answer (its "premature invalidation" handling). A checkpoint
 * here is measured once, when it first matures, and kept — acceptable for now since call prices
 * are cheap point observations, not the aggregate outcome stats outcomes.ts protects.
 */

export const CHECKPOINTS: Array<{ label: '5m' | '10m' | '15m' | '30m' | '45m' | '1h' | '6h' | '24h' | '3d' | '7d'; seconds: number }> = [
  { label: '5m', seconds: 5 * 60 },
  { label: '10m', seconds: 10 * 60 },
  { label: '15m', seconds: 15 * 60 },
  { label: '30m', seconds: 30 * 60 },
  { label: '45m', seconds: 45 * 60 },
  { label: '1h', seconds: 3600 },
  { label: '6h', seconds: 6 * 3600 },
  { label: '24h', seconds: 24 * 3600 },
  { label: '3d', seconds: 3 * 24 * 3600 },
  { label: '7d', seconds: 7 * 24 * 3600 },
];

export type CheckpointTarget = {
  calloutId: number;
  tokenAddress: string;
  checkpoint: string;
  targetAtIso: string;
  callPriceUsd: number | null;
};

const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const root = (() => {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, 'package.json'))) return current;
    current = path.dirname(current);
  }
  return process.cwd();
})();

/** Only tracked callers' callouts are ever measured — matches computeCallerEvaluationReport's
 *  own scope, and keeps Dune query volume tied to what the user actually asked to follow, not
 *  every KOL trade this app happens to have captured. A checkpoint is a target only once its
 *  target time has actually passed (`targetMs <= now`) and no outcome row exists for it yet —
 *  never re-measured, never guessed while still immature.
 *
 *  Explicit decision (resolves a real ambiguity raised in review): "no outcome row exists yet"
 *  means ANY row, regardless of its final status — a checkpoint that finished as
 *  'no_trade_in_window' is exactly as done as one that finished 'measured', and is never
 *  re-selected here. "Keep retrying" only ever applies to checkpoints that have no row at all
 *  (still genuinely pending, e.g. the fetch loop hasn't reached them yet, or a claim was
 *  reclaimed after a stale timeout) — it does not mean periodically re-querying Dune in case a
 *  'no_trade_in_window' result was actually an indexing-lag false negative. If Dune's indexing
 *  lag for this data source is ever shown to be a real problem, that needs its own explicit
 *  premature-invalidation mechanism (like src/dune/outcomes.ts already has for signal outcomes),
 *  not a silent reinterpretation of what "pending" means here. */
export const collectPendingCheckpointTargets = (database: DatabaseSync, now = new Date()): CheckpointTarget[] => {
  const trackedKeys = listTrackedCallerKeys(database);
  if (!trackedKeys.length) return [];
  const placeholders = trackedKeys.map(() => '?').join(',');
  const callouts = database.prepare(
    `SELECT id, token_address AS tokenAddress, call_timestamp AS callTimestamp, call_price_usd AS callPriceUsd
     FROM top_caller_callouts WHERE caller_key IN (${placeholders})`,
  ).all(...trackedKeys) as unknown as Array<{ id: number; tokenAddress: string; callTimestamp: number; callPriceUsd: string | null }>;
  if (!callouts.length) return [];

  const existingRows = database.prepare(`SELECT callout_id AS calloutId, checkpoint FROM top_caller_outcomes`).all() as unknown as Array<{ calloutId: number; checkpoint: string }>;
  const existing = new Set(existingRows.map((row) => `${row.calloutId}|${row.checkpoint}`));

  const nowMs = now.getTime();
  const targets: CheckpointTarget[] = [];
  for (const callout of callouts) {
    for (const checkpoint of CHECKPOINTS) {
      const key = `${callout.id}|${checkpoint.label}`;
      if (existing.has(key)) continue;
      const targetMs = callout.callTimestamp * 1000 + checkpoint.seconds * 1000;
      if (targetMs > nowMs) continue;
      targets.push({
        calloutId: callout.id, tokenAddress: callout.tokenAddress, checkpoint: checkpoint.label,
        targetAtIso: new Date(targetMs).toISOString(),
        callPriceUsd: callout.callPriceUsd !== null ? Number(callout.callPriceUsd) : null,
      });
    }
  }
  return targets;
};

/** Runaway guard, same rationale as copySimulationDune's MAX_TARGETS_PER_RUN — one Dune query
 *  stays a bounded size even if a large backlog of matured checkpoints has built up. Excess
 *  targets are simply left pending for the next collection run. */
export const MAX_CHECKPOINT_TARGETS_PER_RUN = 300;

/** A pending row is a durable claim made before the Dune request starts. Claims older than
 * this are recoverable only when their owning collection run is no longer running (or is
 * clearly orphaned). Dune polling is bounded to about a minute, so ten minutes leaves ample
 * room for a slow response without permanently blocking a checkpoint. */
export const CHECKPOINT_PENDING_TIMEOUT_MS = 10 * 60 * 1000;

export const clearStalePendingCheckpointClaims = (
  database: DatabaseSync, now = new Date(),
): number => {
  const staleBefore = new Date(now.getTime() - CHECKPOINT_PENDING_TIMEOUT_MS).toISOString();
  return Number(database.prepare(
    `DELETE FROM top_caller_outcomes
     WHERE status = 'pending' AND computed_at < ?
       AND (
         dune_run_id IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM top_caller_collection_runs r
           WHERE r.id = top_caller_outcomes.dune_run_id AND r.status = 'running'
         )
         OR EXISTS (
           SELECT 1 FROM top_caller_collection_runs r
           WHERE r.id = top_caller_outcomes.dune_run_id
             AND r.status = 'running' AND r.started_at < ?
         )
       )`,
  ).run(staleBefore, staleBefore).changes);
};

/** Atomically reserve the next matured checkpoints. Only rows successfully inserted as
 * pending are returned, so two concurrent callers cannot submit the same target to Dune. */
export const claimPendingCheckpointTargets = (
  database: DatabaseSync, collectionRunId: number, now = new Date(),
): CheckpointTarget[] => {
  clearStalePendingCheckpointClaims(database, now);
  database.exec('BEGIN IMMEDIATE');
  try {
    const candidates = collectPendingCheckpointTargets(database, now).slice(0, MAX_CHECKPOINT_TARGETS_PER_RUN);
    const claim = database.prepare(
      `INSERT OR IGNORE INTO top_caller_outcomes
       (callout_id, checkpoint, requested_at_ts, status, dune_run_id, computed_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
    );
    const claimed: CheckpointTarget[] = [];
    const computedAt = now.toISOString();
    for (const target of candidates) {
      const targetMs = Date.parse(target.targetAtIso);
      const result = claim.run(
        target.calloutId, target.checkpoint, Math.floor(targetMs / 1000), collectionRunId, computedAt,
      );
      if (Number(result.changes) > 0) claimed.push(target);
    }
    database.exec('COMMIT');
    return claimed;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
};

const sqlFor = (targets: CheckpointTarget[]): string => {
  const values = targets.map((t) =>
    `(${t.calloutId}, '${t.checkpoint}', '${t.tokenAddress.replaceAll("'", "''")}', from_iso8601_timestamp('${t.targetAtIso}'))`,
  ).join(',\n        ');
  return `WITH targets (callout_id, checkpoint, token_address, target_at) AS (
    VALUES
        ${values}
), normalized_trades AS (
    SELECT token_bought_mint_address AS token_address, block_time, amount_usd / NULLIF(token_bought_amount, 0) AS price_usd, tx_id
    FROM dex_solana.trades
    WHERE token_bought_mint_address IN (SELECT token_address FROM targets) AND amount_usd > 0 AND token_bought_amount > 0
    UNION ALL
    SELECT token_sold_mint_address, block_time, amount_usd / NULLIF(token_sold_amount, 0), tx_id
    FROM dex_solana.trades
    WHERE token_sold_mint_address IN (SELECT token_address FROM targets) AND amount_usd > 0 AND token_sold_amount > 0
), ranked AS (
    SELECT tg.callout_id, tg.checkpoint, tg.target_at, t.price_usd, t.block_time AS matched_trade_at, t.tx_id AS matched_tx_id,
           row_number() OVER (PARTITION BY tg.callout_id, tg.checkpoint ORDER BY t.block_time DESC, t.tx_id DESC) AS rn
    FROM targets tg
    LEFT JOIN normalized_trades t
      ON t.token_address = tg.token_address
      AND t.block_time <= tg.target_at
      AND t.block_time > tg.target_at - INTERVAL '24' HOUR
)
SELECT callout_id, checkpoint, target_at, price_usd, matched_trade_at, matched_tx_id FROM ranked WHERE rn = 1 ORDER BY callout_id, checkpoint`;
};

/** How long a single Dune HTTP call may hang before it's treated as failed. `fetch` has no
 *  default timeout — without this, a request that never gets a response (a network stall, not
 *  an error Dune returns) hangs the `await` forever. This is not hypothetical: a real checkpoint
 *  run sat in 'running' with zero progress for 3.5+ minutes with no error ever surfacing before
 *  this was added — the server itself stayed healthy, only this one `await` was stuck. */
const DUNE_REQUEST_TIMEOUT_MS = 20_000;

const fetchWithRetry = async (url: string, init: RequestInit, attempts = 3): Promise<Response> => {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await fetch(url, { ...init, signal: AbortSignal.timeout(DUNE_REQUEST_TIMEOUT_MS) }); }
    catch (error) { lastError = error; if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1))); }
  }
  const cause = lastError instanceof Error && lastError.cause instanceof Error ? ` (${lastError.cause.message})` : '';
  throw new Error(`Dune network request failed after ${attempts} attempts${cause}`);
};

/** Writes every target's outcome row — including ones Dune found nothing for
 *  ('no_trade_in_window'), so "we asked and got nothing" is never confused with "we never
 *  asked." Pure DB writes, no network, so it's directly unit-testable against fixture rows. */
export const applyCheckpointResults = (
  database: DatabaseSync, targets: CheckpointTarget[], rows: Array<Record<string, unknown>>, duneRunId: number,
): { measured: number; noTradeInWindow: number } => {
  const byKey = new Map(rows.map((row) => [`${row.callout_id}|${row.checkpoint}`, row]));
  const update = database.prepare(
    `UPDATE top_caller_outcomes SET requested_at_ts = ?, status = ?, measured_price_usd = ?,
       measured_return_pct = ?, matched_trade_at = ?, gap_seconds = ?, dune_run_id = ?, computed_at = ?
     WHERE callout_id = ? AND checkpoint = ? AND status = 'pending' AND dune_run_id = ?`,
  );
  // Fallback keeps this helper useful for direct callers/older databases that have no claim row.
  const insert = database.prepare(
    `INSERT OR IGNORE INTO top_caller_outcomes
       (callout_id, checkpoint, requested_at_ts, status, measured_price_usd, measured_return_pct, matched_trade_at, gap_seconds, dune_run_id, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const computedAt = new Date().toISOString();
  let measured = 0;
  let noTradeInWindow = 0;
  for (const target of targets) {
    const row = byKey.get(`${target.calloutId}|${target.checkpoint}`);
    const priceUsd = row && typeof row.price_usd === 'number' ? row.price_usd : null;
    const matchedTradeAt = row && typeof row.matched_trade_at === 'string' ? row.matched_trade_at : null;
    const status = priceUsd !== null && matchedTradeAt !== null ? 'measured' : 'no_trade_in_window';
    const returnPct = priceUsd !== null && target.callPriceUsd !== null && target.callPriceUsd > 0
      ? round(((priceUsd - target.callPriceUsd) / target.callPriceUsd) * 100, 2) : null;
    const targetMs = Date.parse(target.targetAtIso);
    const matchedMs = matchedTradeAt !== null ? Date.parse(matchedTradeAt) : null;
    const gapSeconds = matchedMs !== null && !Number.isNaN(matchedMs) ? Math.round((matchedMs - targetMs) / 1000) : null;
    const updated = update.run(
      Math.floor(targetMs / 1000), status, priceUsd !== null ? String(priceUsd) : null, returnPct,
      matchedTradeAt, gapSeconds, duneRunId, computedAt, target.calloutId, target.checkpoint, duneRunId,
    );
    if (Number(updated.changes) === 0) {
      insert.run(
        target.calloutId, target.checkpoint, Math.floor(targetMs / 1000), status,
        priceUsd !== null ? String(priceUsd) : null, returnPct, matchedTradeAt, gapSeconds, duneRunId, computedAt,
      );
    }
    if (status === 'measured') measured += 1; else noTradeInWindow += 1;
  }
  return { measured, noTradeInWindow };
};

/**
 * Submits one Dune batch for up to MAX_CHECKPOINT_TARGETS_PER_RUN pending targets, waits for
 * completion, archives the raw result, and writes every outcome row. Exactly one Dune query
 * execution per call — same "one immutable run, in-flight guard against duplicate submission"
 * shape as copySimulationDune.ts, reusing collectionRunId (the row `startCollectionRun` already
 * created for this kind='checkpoints' call) as the outcome rows' own `dune_run_id`, rather than
 * inventing a second run-tracking table.
 */
export const runCheckpointBatch = async (
  database: DatabaseSync, collectionRunId: number,
): Promise<{ targetsSubmitted: number; measured: number; noTradeInWindow: number }> => {
  const targets = claimPendingCheckpointTargets(database, collectionRunId);
  if (!targets.length) return { targetsSubmitted: 0, measured: 0, noTradeInWindow: 0 };

  const apiKey = readDuneApiKey();
  if (!apiKey) throw new Error('Dune API key not found. Add it to .secrets/dune/api-key.txt.');
  const query = sqlFor(targets);

  const headers = { 'X-DUNE-API-KEY': apiKey, 'content-type': 'application/json', accept: 'application/json' };
  const submitted = await withDuneSubmissionLock(async () => {
    await waitForDuneCapacity(database, { reconcile: async () => undefined });
    const execute = await fetchWithRetry('https://api.dune.com/api/v1/sql/execute', {
      method: 'POST', headers, body: JSON.stringify({ sql: query, performance: 'medium' }),
    });
    const executionRaw = await execute.text();
    if (!execute.ok) throw new Error(`Dune execution HTTP ${execute.status}`);
    const execution = JSON.parse(executionRaw) as { execution_id?: string };
    if (!execution.execution_id) throw new Error('Dune did not return an execution id.');
    return { executionRaw, execution };
  });
  const { executionRaw, execution } = submitted;

  let state = 'QUERY_STATE_EXECUTING';
  let fatalError: Error | null = null;
  for (let attempt = 0; attempt < 60 && state !== 'QUERY_STATE_COMPLETED' && !fatalError; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // A single poll attempt timing out (a transient network blip, not Dune reporting a real
    // failure) must not fail the whole batch — that would kill however many batches this run
    // already drained, forcing a fresh click. Treat it as "not done yet" and keep polling up to
    // the existing attempt cap; only Dune's own reported FAILED/CANCELLED state is fatal.
    try {
      const statusResponse = await fetch(`https://api.dune.com/api/v1/execution/${execution.execution_id}/status`, { headers, signal: AbortSignal.timeout(DUNE_REQUEST_TIMEOUT_MS) });
      const statusBody = await statusResponse.json() as { state?: string; error?: string };
      state = statusBody.state ?? state;
      if (state === 'QUERY_STATE_FAILED' || state === 'QUERY_STATE_CANCELLED') fatalError = new Error(statusBody.error ?? `Dune query ${state}`);
    } catch { /* transient timeout/network error on this one poll attempt — fall through and retry */ }
  }
  if (fatalError) throw fatalError;
  if (state !== 'QUERY_STATE_COMPLETED') throw new Error('Dune query did not complete within 60 seconds.');

  const resultResponse = await fetch(`https://api.dune.com/api/v1/execution/${execution.execution_id}/results`, { headers, signal: AbortSignal.timeout(DUNE_REQUEST_TIMEOUT_MS) });
  const resultRaw = await resultResponse.text();
  if (!resultResponse.ok) throw new Error(`Dune results HTTP ${resultResponse.status}`);

  const dir = path.join(root, '.data', 'archive', 'top-callers');
  mkdirSync(dir, { recursive: true });
  const archivePayload = JSON.stringify({ collectionRunId, requestedAt: new Date().toISOString(), execution: executionRaw, query, result: JSON.parse(resultRaw) }, null, 2);
  const buffer = Buffer.from(archivePayload);
  const sha = createHash('sha256').update(buffer).digest('hex');
  const archivePath = path.join(dir, `top-caller-checkpoints-${collectionRunId}-${sha.slice(0, 16)}.json`);
  if (!existsSync(archivePath)) writeFileSync(archivePath, buffer, { flag: 'wx' });

  const rows = (JSON.parse(resultRaw) as { result?: { rows?: Array<Record<string, unknown>> } }).result?.rows ?? [];
  const { measured, noTradeInWindow } = applyCheckpointResults(database, targets, rows, collectionRunId);
  return { targetsSubmitted: targets.length, measured, noTradeInWindow };
};
