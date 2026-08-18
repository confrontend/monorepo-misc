import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { readDuneApiKey } from '../dune/credentials.js';

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

export type CopySimulationTarget = { tradeId: number; tokenAddress: string; delayedTargetAtIso: string };
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
 *  multiple batches of this size rather than requiring the UI to trigger each one by hand. */
export const MAX_TARGETS_PER_RUN = 300;

/** How far past the delayed timestamp to look for a matching trade. 30 minutes matches the
 *  window used by the cleared density spike — do not widen without re-measuring, since a wider
 *  window would accept staler matches than what was actually validated. */
const SEARCH_WINDOW_MINUTES = 30;

const sqlFor = (targets: CopySimulationTarget[]): string => {
  const values = targets.map((t) =>
    `(${t.tradeId}, '${t.tokenAddress.replaceAll("'", "''")}', from_iso8601_timestamp('${t.delayedTargetAtIso}'))`,
  ).join(',\n        ');
  return `WITH targets (trade_id, token_address, delayed_at) AS (
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
           row_number() OVER (PARTITION BY tg.trade_id ORDER BY t.block_time ASC, t.tx_id ASC) AS rn
    FROM targets tg
    LEFT JOIN normalized_trades t
      ON t.token_address = tg.token_address
      AND t.block_time >= tg.delayed_at
      AND t.block_time < tg.delayed_at + INTERVAL '${SEARCH_WINDOW_MINUTES}' MINUTE
)
SELECT trade_id, matched_trade_at, price_usd, matched_tx_id, amount_usd FROM ranked WHERE rn = 1 ORDER BY trade_id`;
};

const fetchWithRetry = async (url: string, init: RequestInit, attempts = 3): Promise<Response> => {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await fetch(url, init); }
    catch (error) { lastError = error; if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1))); }
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
  targets: CopySimulationTarget[], rows: Array<Record<string, unknown>>,
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
  database: DatabaseSync, targets: CopySimulationTarget[],
): Promise<{ runId: number; matches: CopySimulationMatch[] }> => {
  if (!targets.length) throw new Error('No trade targets to query.');
  const batch = targets.slice(0, MAX_TARGETS_PER_RUN);

  const keyFor = (t: CopySimulationTarget): string => `${t.tokenAddress}|${t.delayedTargetAtIso}`;
  const uniqueByKey = new Map<string, CopySimulationTarget>();
  for (const target of batch) if (!uniqueByKey.has(keyFor(target))) uniqueByKey.set(keyFor(target), target);
  const uniqueTargets = [...uniqueByKey.values()];

  const apiKey = readDuneApiKey();
  if (!apiKey) throw new Error('Dune API key not found. Add it to .secrets/dune/api-key.txt.');
  const query = sqlFor(uniqueTargets);
  const requestedAt = new Date().toISOString();
  const inserted = database.prepare(
    `INSERT INTO copytrade_copy_simulation_runs (trade_refs, query_sql, status, requested_at)
     VALUES (?, ?, 'submitted', ?)`,
  ).run(JSON.stringify(batch.map((t) => t.tradeId)), query, requestedAt);
  const runId = Number(inserted.lastInsertRowid);

  const headers = { 'X-DUNE-API-KEY': apiKey, 'content-type': 'application/json', accept: 'application/json' };
  const execute = await fetchWithRetry('https://api.dune.com/api/v1/sql/execute', {
    method: 'POST', headers, body: JSON.stringify({ sql: query, performance: 'medium' }),
  });
  const executionRaw = await execute.text();
  if (!execute.ok) {
    database.prepare(`UPDATE copytrade_copy_simulation_runs SET status = 'failed', completed_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), runId);
    throw new Error(`Dune execution HTTP ${execute.status}`);
  }
  const execution = JSON.parse(executionRaw) as { execution_id?: string };
  if (!execution.execution_id) {
    database.prepare(`UPDATE copytrade_copy_simulation_runs SET status = 'failed', completed_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), runId);
    throw new Error('Dune did not return an execution id.');
  }
  database.prepare(`UPDATE copytrade_copy_simulation_runs SET execution_id = ?, status = 'running' WHERE id = ?`)
    .run(execution.execution_id, runId);

  let state = 'QUERY_STATE_EXECUTING';
  for (let attempt = 0; attempt < 60 && state !== 'QUERY_STATE_COMPLETED'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const statusResponse = await fetch(`https://api.dune.com/api/v1/execution/${execution.execution_id}/status`, { headers });
    const statusBody = await statusResponse.json() as { state?: string; error?: string };
    state = statusBody.state ?? 'QUERY_STATE_FAILED';
    if (state === 'QUERY_STATE_FAILED' || state === 'QUERY_STATE_CANCELLED') {
      database.prepare(`UPDATE copytrade_copy_simulation_runs SET status = 'failed', completed_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), runId);
      throw new Error(statusBody.error ?? `Dune query ${state}`);
    }
  }
  if (state !== 'QUERY_STATE_COMPLETED') {
    database.prepare(`UPDATE copytrade_copy_simulation_runs SET status = 'timed_out' WHERE id = ?`).run(runId);
    throw new Error(`Dune query did not complete within 60 seconds (run ${runId} remains protected from duplicate retries).`);
  }

  const resultResponse = await fetch(`https://api.dune.com/api/v1/execution/${execution.execution_id}/results`, { headers });
  const resultRaw = await resultResponse.text();
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
  const uniqueMatches = rowsToMatches(uniqueTargets, rows);
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

/** Reads every completed run's matches, merged by trade id (a trade covered by more than one
 *  run keeps its earliest completed match — append-only history, same convention as
 *  readAllDuneOutcomes). */
export const readAllCopySimulationMatches = (database: DatabaseSync): Map<number, CopySimulationMatch> => {
  const runs = database.prepare(
    `SELECT id, trade_refs AS tradeRefs, raw_result AS rawResult, completed_at AS completedAt
     FROM copytrade_copy_simulation_runs WHERE status = 'completed' AND raw_result IS NOT NULL ORDER BY id ASC`,
  ).all() as unknown as Array<{ id: number; tradeRefs: string; rawResult: string; completedAt: string | null }>;
  const merged = new Map<number, CopySimulationMatch>();
  for (const run of runs) {
    let ids: number[];
    try { ids = JSON.parse(run.tradeRefs) as number[]; } catch { continue; }
    if (!ids.length) continue;
    let rows: Array<Record<string, unknown>> = [];
    try { rows = ((JSON.parse(run.rawResult) as { result?: { rows?: Array<Record<string, unknown>> } }).result?.rows ?? []); } catch { continue; }
    const byTradeId = new Map(rows.map((row) => [Number(row.trade_id), row]));
    for (const id of ids) {
      if (merged.has(id)) continue; // earliest completed match wins
      const row = byTradeId.get(id);
      const matchedTradeAt = row && typeof row.matched_trade_at === 'string' ? row.matched_trade_at : null;
      const priceUsd = row && typeof row.price_usd === 'number' ? row.price_usd : null;
      merged.set(id, {
        tradeId: id,
        matchedTradeAt,
        matchedPriceUsd: priceUsd,
        matchedTxId: row && typeof row.matched_tx_id === 'string' ? row.matched_tx_id : null,
        gapSeconds: null, // recomputed by the caller against that trade's own delayed target
        status: matchedTradeAt !== null && priceUsd !== null ? 'matched' : 'no_trade_in_window',
        // Older archived runs (before this field was added) simply won't have this column —
        // absent, not zero, exactly like any other pre-migration gap in this project's data.
        matchedTradeAmountUsd: row && typeof row.amount_usd === 'number' ? row.amount_usd : null,
      });
    }
  }
  return merged;
};
