import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { readDuneApiKey } from '../dune/credentials.js';
import { waitForDuneCapacity, withDuneSubmissionLock } from './duneScheduler.js';

/**
 * Fetches "the nearest real Dune trade after a delayed timestamp" for a batch of stored
 * copytrade_trades rows — the price data a Historical Copy Simulation needs. Deliberately
 * mirrors src/dune/outcomes.ts's shape and conventions (one immutable run per batch: query,
 * execution id, raw result, archive path+hash; an in-flight guard against duplicate
 * submission) rather than inventing a parallel pattern, per this project's cleared spike
 * (research/prompts/copy-simulation-dune-density-spike.md, GO decision 2026-08-16).
 *
 * The one real difference from outcomes.ts: this looks for the *nearest trade after* a target
 * time (what a delayed copier would actually get filled at), not the *latest trade before* a
 * checkpoint target (what already happened by then) — so the join direction and ORDER BY are
 * flipped relative to sqlFor in outcomes.ts.
 */

export type CopySimulationTarget = { tradeId: number; tokenAddress: string; delayedTargetAtIso: string; direction?: 'after' | 'before' };
export type CopySimulationMatchSource = 'precise' | 'wide_window';
export type DunePollUpdate = {
  executionId: string;
  state: string;
  pollCount: number;
  elapsedSeconds: number;
  isExecutionFinished: boolean;
  executionCostCredits: number | null;
  requestPhase: 'status_requesting' | 'status_received' | 'results_requesting' | 'results_received';
  statusHttpStatus: number | null;
  statusRequestMs: number | null;
  statusPayload: string | null;
};
export type CopySimulationMatch = {
  tradeId: number;
  matchedTradeAt: string | null;
  matchedPriceUsd: number | null;
  matchedTxId: string | null;
  gapSeconds: number | null;
  status: 'matched' | 'no_trade_in_window';
  /** USD size of the SPECIFIC matched trade, straight from dex_solana.trades — a real,
   *  timestamped proxy for local trading activity near the match, not pool liquidity itself.
   *  GMGN's own token-info endpoint does return a `liquidity` field, but only as a live/current
   *  value with no historical query — unusable for backfilling trades that already happened.
   *  This is what's actually available: cheap (same query, no extra Dune cost), historically
   *  accurate, and honestly labeled as a proxy rather than true liquidity. */
  matchedTradeAmountUsd: number | null;
  matchSource?: CopySimulationMatchSource;
};

const root = (() => {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, 'package.json'))) return current;
    current = path.dirname(current);
  }
  return process.cwd();
})();

/** Dune queries only 25 signals x 6 checkpoints (150 rows) in outcomes.ts; here each target is
 *  one row with no fan-out, so this can go noticeably higher per query while staying a
 *  comparably sized (or smaller) request. The caller (runCopySimulationBatch) loops across
 *  multiple batches of this size rather than requiring the UI to trigger each one by hand.
 *
 *  Lowered from 300 to 150 after two live runs (9 and 10) each submitted 300 targets and blew
 *  past the 60-second poll window, storing nothing. Earlier 300-target batches did complete, so
 *  300 sits right at the edge rather than being reliably too large — and a batch that straddles
 *  the timeout is the worst case, since it costs a full Dune query and yields no rows. Halving
 *  the per-query size trades more batches for each one finishing well inside the window; the
 *  caller loops regardless, so the only cost is more round trips, not more manual clicks. */
export const MAX_TARGETS_PER_RUN = 150;

/** Search only within the same five-minute gap accepted by the simulation. This prevents the
 *  query from finding matches that the simulation would immediately reject as stale. */
export const PRECISE_SEARCH_WINDOW_MINUTES = 5;
/** Kept as a separate provenance label for older saved retry runs; new retries use the same
 *  five-minute accuracy window rather than searching beyond the acceptance rule. */
export const WIDE_SEARCH_WINDOW_MINUTES = 5;
/** Dune queries can legitimately take longer than a minute. Keep polling until Dune reaches a
 * terminal state; this interval is deliberately conservative so status polling does not create
 * its own rate-limit pressure. The caller can still stop the local workflow between batches. */
export const DUNE_STATUS_POLL_INTERVAL_MS = 5_000;
/** Bound a foreground poll while allowing slow interactive queries to finish. Late results are
 * recovered by reconcileStuckCopySimulationRuns on the next run/status pass. */
export const DUNE_MAX_POLL_DURATION_MS = 30 * 60_000;

export const sqlFor = (targets: CopySimulationTarget[], searchWindowMinutes = PRECISE_SEARCH_WINDOW_MINUTES): string => {
  const values = targets.map((t) =>
    `(${t.tradeId}, '${t.tokenAddress.replaceAll("'", "''")}', from_iso8601_timestamp('${t.delayedTargetAtIso}'), '${t.direction ?? 'after'}')`,
  ).join(',\n        ');
  return `WITH targets (trade_id, token_address, delayed_at, direction) AS (
    VALUES
        ${values}
), normalized_trades AS (
    SELECT token_bought_mint_address AS token_address, block_time, amount_usd / NULLIF(token_bought_amount, 0) AS price_usd, tx_id, amount_usd
    FROM dex_solana.trades
    WHERE token_bought_mint_address IN (SELECT token_address FROM targets) AND amount_usd > 0 AND token_bought_amount > 0
    UNION ALL
    SELECT token_sold_mint_address, block_time, amount_usd / NULLIF(token_sold_amount, 0), tx_id, amount_usd
    FROM dex_solana.trades
    WHERE token_sold_mint_address IN (SELECT token_address FROM targets) AND amount_usd > 0 AND token_sold_amount > 0
), ranked AS (
    SELECT tg.trade_id, t.block_time AS matched_trade_at, t.price_usd, t.tx_id AS matched_tx_id, t.amount_usd,
           row_number() OVER (PARTITION BY tg.trade_id ORDER BY abs(date_diff('second', t.block_time, tg.delayed_at)), t.tx_id ASC) AS rn
    FROM targets tg
    LEFT JOIN normalized_trades t
      ON t.token_address = tg.token_address
      AND ((tg.direction = 'after' AND t.block_time >= tg.delayed_at AND t.block_time < tg.delayed_at + INTERVAL '${searchWindowMinutes}' MINUTE)
        OR (tg.direction = 'before' AND t.block_time <= tg.delayed_at AND t.block_time > tg.delayed_at - INTERVAL '${searchWindowMinutes}' MINUTE))
)
SELECT trade_id, matched_trade_at, price_usd, matched_tx_id, amount_usd FROM ranked WHERE rn = 1 ORDER BY trade_id`;
};

const fetchWithRetry = async (url: string, init: RequestInit, attempts = 5): Promise<Response> => {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.status !== 429 || attempt + 1 >= attempts) return response;
      const retryAfter = Number(response.headers.get('retry-after') ?? '');
      const resetRaw = response.headers.get('x-ratelimit-reset') ?? response.headers.get('ratelimit-reset');
      const reset = Number(resetRaw ?? '');
      const resetDelay = Number.isFinite(reset) && reset > 0
        ? (reset > 1_000_000 ? reset - Date.now() : reset * 1000 - Date.now())
        : 0;
      const delayMs = Number.isFinite(retryAfter) && retryAfter >= 0
        ? retryAfter * 1000
        : resetDelay > 0 ? resetDelay : 2_000 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs + Math.floor(Math.random() * 500)));
    }
    catch (error) { lastError = error; if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1) + Math.floor(Math.random() * 250))); }
  }
  const cause = lastError instanceof Error && lastError.cause instanceof Error ? ` (${lastError.cause.message})` : '';
  throw new Error(`Dune network request failed after ${attempts} attempts${cause}`);
};

const parseDuneTimestamp = (value: unknown): number | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/** Pure interpretation of already-fetched Dune rows against the targets that were asked for —
 *  no network, no database. Every target gets a result, including ones Dune found nothing for
 *  (status 'no_trade_in_window'), so "we asked and got nothing" is never confused with "we
 *  never asked." */
export const rowsToMatches = (
  targets: CopySimulationTarget[], rows: Array<Record<string, unknown>>, matchSource: CopySimulationMatchSource = 'precise',
): CopySimulationMatch[] => {
  const byTradeId = new Map(rows.map((row) => [Number(row.trade_id), row]));
  return targets.map((target) => {
    const row = byTradeId.get(target.tradeId);
    const matchedTradeAt = row && typeof row.matched_trade_at === 'string' ? row.matched_trade_at : null;
    const priceUsd = row && typeof row.price_usd === 'number' ? row.price_usd : null;
    const matchedMs = parseDuneTimestamp(matchedTradeAt);
    const targetMs = parseDuneTimestamp(target.delayedTargetAtIso);
    const gapSeconds = matchedMs !== null && targetMs !== null ? (matchedMs - targetMs) / 1000 : null;
    return {
      tradeId: target.tradeId,
      matchedTradeAt,
      matchedPriceUsd: priceUsd,
      matchedTxId: row && typeof row.matched_tx_id === 'string' ? row.matched_tx_id : null,
      gapSeconds,
      status: matchedTradeAt !== null && priceUsd !== null ? 'matched' : 'no_trade_in_window',
      matchedTradeAmountUsd: row && typeof row.amount_usd === 'number' ? row.amount_usd : null,
      matchSource,
    };
  });
};

/** Trade ids already covered by a submitted/running/timed_out/completed run — never re-asked. */
export const alreadyCoveredTradeIds = (database: DatabaseSync): Set<number> => {
  const rows = database.prepare(
    `SELECT trade_refs AS tradeRefs FROM copytrade_copy_simulation_runs
     WHERE status IN ('submitted', 'running', 'timed_out', 'completed')`,
  ).all() as unknown as Array<{ tradeRefs: string }>;
  const covered = new Set<number>();
  for (const row of rows) {
    try {
      const ids = JSON.parse(row.tradeRefs) as unknown;
      if (Array.isArray(ids)) for (const id of ids) if (Number.isInteger(id)) covered.add(Number(id));
    } catch { /* a malformed row covers nothing; it will surface via the run's own status */ }
  }
  return covered;
};

/**
 * Submits one Dune batch for up to MAX_TARGETS_PER_RUN targets, deduplicating identical
 * (token, delayed-timestamp) pairs into a single query row and fanning the result back out to
 * every trade that shared it — the "deduplicate identical token/time requests" requirement.
 * Caller is responsible for excluding already-covered trade ids first (alreadyCoveredTradeIds).
 */
export const runCopySimulationDuneBatch = async (
  database: DatabaseSync, targets: CopySimulationTarget[], options: { onStatus?: (update: DunePollUpdate) => void; shouldStop?: () => boolean; searchWindowMinutes?: number; matchSource?: CopySimulationMatchSource } = {},
): Promise<{ runId: number; matches: CopySimulationMatch[] }> => {
  if (!targets.length) throw new Error('No trade targets to query.');
  const batch = targets.slice(0, MAX_TARGETS_PER_RUN);

  const keyFor = (t: CopySimulationTarget): string => `${t.tokenAddress}|${t.delayedTargetAtIso}`;
  const uniqueByKey = new Map<string, CopySimulationTarget>();
  for (const target of batch) if (!uniqueByKey.has(keyFor(target))) uniqueByKey.set(keyFor(target), target);
  const uniqueTargets = [...uniqueByKey.values()];

  const apiKey = readDuneApiKey();
  if (!apiKey) throw new Error('Dune API key not found. Add it to .secrets/dune/api-key.txt.');
  const searchWindowMinutes = options.searchWindowMinutes ?? PRECISE_SEARCH_WINDOW_MINUTES;
  const matchSource = options.matchSource ?? 'precise';
  if (!Number.isFinite(searchWindowMinutes) || searchWindowMinutes < PRECISE_SEARCH_WINDOW_MINUTES) throw new Error('Dune search window must be at least the precise 5-minute window.');
  const query = sqlFor(uniqueTargets, searchWindowMinutes);
  const requestedAt = new Date().toISOString();
  const headers = { 'X-DUNE-API-KEY': apiKey, 'content-type': 'application/json', accept: 'application/json' };
  const submitted = await withDuneSubmissionLock(async () => {
    await waitForDuneCapacity(database, { shouldStop: options.shouldStop, reconcile: async () => { await reconcileStuckCopySimulationRuns(database); } });
    const inserted = database.prepare(
      `INSERT INTO copytrade_copy_simulation_runs (trade_refs, query_sql, status, requested_at, search_window_minutes, match_source)
       VALUES (?, ?, 'submitted', ?, ?, ?)`,
    ).run(JSON.stringify(batch.map((t) => t.tradeId)), query, requestedAt, searchWindowMinutes, matchSource);
    const runId = Number(inserted.lastInsertRowid);
    const execute = await fetchWithRetry('https://api.dune.com/api/v1/sql/execute', {
      method: 'POST', headers, body: JSON.stringify({ sql: query, performance: 'medium' }),
    });
    const executionRaw = await execute.text();
    if (!execute.ok) {
      database.prepare(`UPDATE copytrade_copy_simulation_runs SET status = 'failed', completed_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), runId);
      // Dune's response body carries the actual reason (e.g. "this api request would exceed
      // your configured datapoint limit per billing cycle") — discarding it and keeping only
      // the status code is exactly what made a real billing-quota incident (confirmed live,
      // 2026-08-22) require manually reproducing the call by hand to find out why.
      let reason = '';
      try {
        const parsed = JSON.parse(executionRaw) as { error?: unknown };
        if (typeof parsed.error === 'string' && parsed.error.trim()) reason = parsed.error.trim();
      } catch { /* not JSON: fall through to the raw text below */ }
      if (!reason && executionRaw.trim()) reason = executionRaw.trim().slice(0, 300);
      throw new Error(reason ? `Dune execution HTTP ${execute.status}: ${reason}` : `Dune execution HTTP ${execute.status}`);
    }
    const execution = JSON.parse(executionRaw) as { execution_id?: string; max_inflight_interactive_executions?: number };
    if (!execution.execution_id) {
      database.prepare(`UPDATE copytrade_copy_simulation_runs SET status = 'failed', completed_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), runId);
      throw new Error('Dune did not return an execution id.');
    }
    database.prepare(`UPDATE copytrade_copy_simulation_runs SET execution_id = ?, status = 'running', dune_execution_payload = ?, dune_max_inflight_interactive_executions = ? WHERE id = ?`)
      .run(execution.execution_id, executionRaw, typeof execution.max_inflight_interactive_executions === 'number' ? execution.max_inflight_interactive_executions : null, runId);
    return { runId, executionRaw, execution };
  });
  const { runId, executionRaw, execution } = submitted;
  const executionId = execution.execution_id;
  if (!executionId) throw new Error('Dune execution id was lost after submission.');

  let state = 'QUERY_STATE_EXECUTING';
  const pollStartedAt = Date.now();
  let pollCount = 0;
  while (state !== 'QUERY_STATE_COMPLETED') {
    if (Date.now() - pollStartedAt >= DUNE_MAX_POLL_DURATION_MS) {
      database.prepare(`UPDATE copytrade_copy_simulation_runs SET status = 'timed_out' WHERE id = ?`).run(runId);
      throw new Error(`Dune query exceeded the ${Math.round(DUNE_MAX_POLL_DURATION_MS / 60_000)}-minute poll limit; it remains resumable as run ${runId}.`);
    }
    if (options.shouldStop?.()) throw new Error(`Stopped while waiting for Dune execution ${executionId}.`);
    await new Promise((resolve) => setTimeout(resolve, DUNE_STATUS_POLL_INTERVAL_MS + Math.floor(Math.random() * 750)));
    pollCount += 1;
    options.onStatus?.({ executionId, state, pollCount, elapsedSeconds: Math.round((Date.now() - pollStartedAt) / 1000), isExecutionFinished: false, executionCostCredits: null, requestPhase: 'status_requesting', statusHttpStatus: null, statusRequestMs: null, statusPayload: null });
    const statusRequestedAt = Date.now();
    const statusResponse = await fetchWithRetry(`https://api.dune.com/api/v1/execution/${executionId}/status`, { headers, signal: AbortSignal.timeout(20_000) });
    const statusRequestMs = Date.now() - statusRequestedAt;
    const statusRaw = await statusResponse.text();
    const statusBody = JSON.parse(statusRaw) as { state?: string; error?: string; is_execution_finished?: boolean; execution_cost_credits?: number; max_inflight_interactive_executions?: number };
    state = statusBody.state ?? 'QUERY_STATE_FAILED';
    database.prepare(`UPDATE copytrade_copy_simulation_runs
      SET dune_status_payload = ?, dune_max_inflight_interactive_executions = ?, dune_last_state = ?, dune_last_status_at = ?
      WHERE id = ?`).run(statusRaw, typeof statusBody.max_inflight_interactive_executions === 'number' ? statusBody.max_inflight_interactive_executions : null, state, new Date().toISOString(), runId);
    if (!statusResponse.ok) throw new Error(`Dune status HTTP ${statusResponse.status}`);
    options.onStatus?.({
      executionId,
      state,
      pollCount,
      elapsedSeconds: Math.round((Date.now() - pollStartedAt) / 1000),
      isExecutionFinished: statusBody.is_execution_finished === true || state === 'QUERY_STATE_COMPLETED' || state === 'QUERY_STATE_FAILED' || state === 'QUERY_STATE_CANCELLED',
      executionCostCredits: typeof statusBody.execution_cost_credits === 'number' ? statusBody.execution_cost_credits : null,
      requestPhase: 'status_received', statusHttpStatus: statusResponse.status, statusRequestMs, statusPayload: statusRaw,
    });
    if (state === 'QUERY_STATE_FAILED' || state === 'QUERY_STATE_CANCELLED') {
      database.prepare(`UPDATE copytrade_copy_simulation_runs SET status = 'failed', completed_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), runId);
      throw new Error(statusBody.error ?? `Dune query ${state}`);
    }
  }

  options.onStatus?.({ executionId, state, pollCount, elapsedSeconds: Math.round((Date.now() - pollStartedAt) / 1000), isExecutionFinished: true, executionCostCredits: null, requestPhase: 'results_requesting', statusHttpStatus: null, statusRequestMs: null, statusPayload: null });
  const resultRequestedAt = Date.now();
  const resultResponse = await fetchWithRetry(`https://api.dune.com/api/v1/execution/${executionId}/results`, { headers, signal: AbortSignal.timeout(20_000) });
  const resultRaw = await resultResponse.text();
  options.onStatus?.({ executionId, state, pollCount, elapsedSeconds: Math.round((Date.now() - pollStartedAt) / 1000), isExecutionFinished: true, executionCostCredits: null, requestPhase: 'results_received', statusHttpStatus: resultResponse.status, statusRequestMs: Date.now() - resultRequestedAt, statusPayload: resultRaw });
  if (!resultResponse.ok) throw new Error(`Dune results HTTP ${resultResponse.status}`);

  const archivePayload = JSON.stringify({ runId, requestedAt, execution: executionRaw, query, result: JSON.parse(resultRaw) }, null, 2);
  const buffer = Buffer.from(archivePayload);
  const sha = createHash('sha256').update(buffer).digest('hex');
  const dir = path.join(root, '.data', 'archive', 'copy-simulation');
  mkdirSync(dir, { recursive: true });
  const archivePath = path.join(dir, `copy-simulation-${runId}-${sha.slice(0, 16)}.json`);
  if (!existsSync(archivePath)) writeFileSync(archivePath, buffer, { flag: 'wx' });
  const completedAt = new Date().toISOString();
  database.prepare(
    `UPDATE copytrade_copy_simulation_runs SET status = 'completed', raw_result = ?, archive_path = ?, archive_sha256 = ?, completed_at = ? WHERE id = ?`,
  ).run(resultRaw, archivePath, sha, completedAt, runId);

  const rows = ((JSON.parse(resultRaw) as { result?: { rows?: Array<Record<string, unknown>> } }).result?.rows ?? []);
  const uniqueMatches = rowsToMatches(uniqueTargets, rows, matchSource);
  const matchByKey = new Map(uniqueMatches.map((match) => {
    const target = uniqueTargets.find((t) => t.tradeId === match.tradeId)!;
    return [keyFor(target), match] as const;
  }));
  // Fan the deduplicated result back out to every trade that shared the same (token, delayed
  // timestamp) key, preserving each trade's own id in the returned match.
  const matches: CopySimulationMatch[] = batch.map((target) => {
    const shared = matchByKey.get(keyFor(target))!;
    return { ...shared, tradeId: target.tradeId };
  });
  return { runId, matches };
};

export type CopySimulationReconcileSummary = {
  checked: number; completed: number; failed: number; stillRunning: number; noApiKey: number;
};

/**
 * Recovers runs whose Dune execution outlived our local 60-second poll window.
 *
 * Without this, a timed-out run was a permanent hole: the query almost always finishes on Dune's
 * side moments later, but we had already stopped waiting, and `alreadyCoveredTradeIds` counts
 * `timed_out` as covered — so those 300 targets were never re-asked and never resolved. Two real
 * runs (9 and 10) each lost 300 targets exactly this way.
 *
 * Mirrors reconcileDuneRun in src/dune/outcomes.ts deliberately: same status-poll-then-fetch
 * shape, same archive-and-hash step, same "transient Dune-side issue leaves it still_running for
 * the next pass" tolerance. A run with no execution id gets a grace period before being written
 * off, since the process may simply have died between submitting and recording the id.
 */
export const reconcileStuckCopySimulationRuns = async (
  database: DatabaseSync,
): Promise<CopySimulationReconcileSummary> => {
  const stuck = database.prepare(
    `SELECT id, status, execution_id AS executionId, dune_execution_payload AS executionPayload, requested_at AS requestedAt, query_sql AS querySql
     FROM copytrade_copy_simulation_runs WHERE status IN ('submitted', 'running', 'timed_out') ORDER BY id ASC`,
  ).all() as unknown as Array<{ id: number; status: string; executionId: string | null; executionPayload: string | null; requestedAt: string; querySql: string }>;

  const summary: CopySimulationReconcileSummary = { checked: stuck.length, completed: 0, failed: 0, stillRunning: 0, noApiKey: 0 };
  if (!stuck.length) return summary;

  const apiKey = readDuneApiKey();
  if (!apiKey) { summary.noApiKey = stuck.length; return summary; }
  const headers = { 'X-DUNE-API-KEY': apiKey, accept: 'application/json' };

  for (const run of stuck) {
    if (!run.executionId) {
      const ageMs = Date.now() - new Date(run.requestedAt).getTime();
      if (ageMs < 10 * 60_000) { summary.stillRunning += 1; continue; }
      database.prepare(`UPDATE copytrade_copy_simulation_runs SET status = 'failed', completed_at = ? WHERE id = ?`).run(new Date().toISOString(), run.id);
      summary.failed += 1;
      continue;
    }

    let statusBody: { state?: string; error?: string; max_inflight_interactive_executions?: number };
    let statusRaw = '';
    try {
      const statusResponse = await fetchWithRetry(`https://api.dune.com/api/v1/execution/${run.executionId}/status`, { headers, signal: AbortSignal.timeout(20_000) });
      statusRaw = await statusResponse.text();
      statusBody = JSON.parse(statusRaw) as typeof statusBody;
      database.prepare(`UPDATE copytrade_copy_simulation_runs SET dune_status_payload = ?, dune_max_inflight_interactive_executions = ?, dune_last_state = ?, dune_last_status_at = ? WHERE id = ?`).run(statusRaw, typeof statusBody.max_inflight_interactive_executions === 'number' ? statusBody.max_inflight_interactive_executions : null, statusBody.state ?? null, new Date().toISOString(), run.id);
      if (!statusResponse.ok) throw new Error(`Dune status HTTP ${statusResponse.status}`);
    } catch { summary.stillRunning += 1; continue; }

    const state = statusBody.state ?? '';
    if (state === 'QUERY_STATE_FAILED' || state === 'QUERY_STATE_CANCELLED') {
      database.prepare(`UPDATE copytrade_copy_simulation_runs SET status = 'failed', completed_at = ? WHERE id = ?`).run(new Date().toISOString(), run.id);
      summary.failed += 1;
      continue;
    }
    if (state !== 'QUERY_STATE_COMPLETED') { summary.stillRunning += 1; continue; }

    let resultRaw: string;
    try {
      const resultResponse = await fetchWithRetry(`https://api.dune.com/api/v1/execution/${run.executionId}/results`, { headers, signal: AbortSignal.timeout(20_000) });
      resultRaw = await resultResponse.text();
      if (!resultResponse.ok) { summary.stillRunning += 1; continue; }
    } catch { summary.stillRunning += 1; continue; }

    const archivePayload = JSON.stringify({ runId: run.id, requestedAt: run.requestedAt, execution: run.executionPayload, query: run.querySql, reconciledFrom: 'status-poll', statusAtReconcile: statusBody, result: JSON.parse(resultRaw) }, null, 2);
    const buffer = Buffer.from(archivePayload);
    const sha = createHash('sha256').update(buffer).digest('hex');
    const dir = path.join(root, '.data', 'archive', 'copy-simulation');
    mkdirSync(dir, { recursive: true });
    const archivePath = path.join(dir, `copy-simulation-${run.id}-${sha.slice(0, 16)}.json`);
    if (!existsSync(archivePath)) writeFileSync(archivePath, buffer, { flag: 'wx' });
    database.prepare(
      `UPDATE copytrade_copy_simulation_runs SET status = 'completed', raw_result = ?, archive_path = ?, archive_sha256 = ?, completed_at = ? WHERE id = ?`,
    ).run(resultRaw, archivePath, sha, new Date().toISOString(), run.id);
    summary.completed += 1;
  }
  return summary;
};

/** Reads every completed run's matches, merged by trade id (a trade covered by more than one
 *  run keeps its earliest completed match — append-only history, same convention as
 *  readAllDuneOutcomes). */
export const readAllCopySimulationMatches = (database: DatabaseSync): Map<number, CopySimulationMatch> => {
  const runs = database.prepare(
    `SELECT id, trade_refs AS tradeRefs, raw_result AS rawResult, completed_at AS completedAt, match_source AS matchSource
     FROM copytrade_copy_simulation_runs WHERE status = 'completed' AND raw_result IS NOT NULL ORDER BY id ASC`,
  ).all() as unknown as Array<{ id: number; tradeRefs: string; rawResult: string; completedAt: string | null; matchSource: CopySimulationMatchSource | null }>;
  const merged = new Map<number, CopySimulationMatch>();
  for (const run of runs) {
    let ids: number[];
    try { ids = JSON.parse(run.tradeRefs) as number[]; } catch { continue; }
    if (!ids.length) continue;
    let rows: Array<Record<string, unknown>> = [];
    try { rows = ((JSON.parse(run.rawResult) as { result?: { rows?: Array<Record<string, unknown>> } }).result?.rows ?? []); } catch { continue; }
    const byTradeId = new Map(rows.map((row) => [Number(row.trade_id), row]));
    const source = run.matchSource === 'wide_window' ? 'wide_window' : 'precise';
    for (const id of ids) {
      const row = byTradeId.get(id);
      const matchedTradeAt = row && typeof row.matched_trade_at === 'string' ? row.matched_trade_at : null;
      const priceUsd = row && typeof row.price_usd === 'number' ? row.price_usd : null;
      const next: CopySimulationMatch = {
        tradeId: id,
        matchedTradeAt,
        matchedPriceUsd: priceUsd,
        matchedTxId: row && typeof row.matched_tx_id === 'string' ? row.matched_tx_id : null,
        gapSeconds: null, // recomputed by the caller against that trade's own delayed target
        status: matchedTradeAt !== null && priceUsd !== null ? 'matched' : 'no_trade_in_window',
        // Older archived runs (before this field was added) simply won't have this column —
        // absent, not zero, exactly like any other pre-migration gap in this project's data.
        matchedTradeAmountUsd: row && typeof row.amount_usd === 'number' ? row.amount_usd : null,
        matchSource: source,
      };
      const previous = merged.get(id);
      // A wide-window no-match is terminal for the controlled retry path. Prefer it over an
      // earlier precise no-match so a later run cannot keep treating the same target as retryable
      // forever. A precise match still wins over a wide match for provenance quality.
      const score = (match: CopySimulationMatch): number => (match.status === 'matched'
        ? (match.matchSource === 'precise' ? 0 : 1)
        : (match.matchSource === 'wide_window' ? 2 : 3));
      if (!previous || score(next) < score(previous)) merged.set(id, next);
    }
  }
  return merged;
};
