import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { readDuneApiKey } from './credentials.js';
import { waitForDuneCapacity, withDuneSubmissionLock } from '../copytrade/duneScheduler.js';
import { MIN_SIGNAL_AGE_MS } from './prescreen.js';

type Signal = { id: number; tokenAddress: string; symbol: string | null; signalType: string | null; observedAt: string; marketCap: number | null };
export type DuneOutcome = { signal: Signal; checkpoints: Array<{ label: string; targetTimestamp: string; result: { priceUsd: number | null; status: string; priceHttpStatus: number | null; archivePath: string | null; matchedTradeAt: string | null; matchedTxId: string | null; matchedOuterInstructionIndex: number | null; matchedInnerInstructionIndex: number | null; matchedTradeAgeSeconds: number | null; sourceRunId: number | null } }> };
const root = (() => { let current = path.dirname(fileURLToPath(import.meta.url)); while (current !== path.dirname(current)) { if (existsSync(path.join(current, 'package.json'))) return current; current = path.dirname(current); } return process.cwd(); })();

// Every horizon after 'signal' itself. Adding a checkpoint here costs nothing extra against
// Dune — it's one more UNION ALL row scanned against trade data already fetched for the same
// token addresses in the same single query execution, not an extra API call.
const CHECKPOINT_OFFSETS: Array<{ label: string; unit: 'minute' | 'hour'; amount: number }> = [
  { label: '+5m', unit: 'minute', amount: 5 },
  { label: '+15m', unit: 'minute', amount: 15 },
  { label: '+30m', unit: 'minute', amount: 30 },
  { label: '+1h', unit: 'hour', amount: 1 },
  { label: '+3h', unit: 'hour', amount: 3 },
];
export const CHECKPOINT_LABELS = ['signal', ...CHECKPOINT_OFFSETS.map((offset) => offset.label)];

const sqlFor = (signals: Signal[]): string => {
  const values = signals.map((s) => `(${s.id}, '${s.tokenAddress.replaceAll("'", "''")}', '${(s.signalType ?? '').replaceAll("'", "''")}', from_iso8601_timestamp('${s.observedAt}'))`).join(',\n        ');
  const checkpointUnions = CHECKPOINT_OFFSETS.map((offset) => `UNION ALL SELECT signal_id, token_address, signal_type, signal_at, '${offset.label}', date_add('${offset.unit}', ${offset.amount}, signal_at) FROM target_signals`).join('\n    ');
  return `WITH target_signals (signal_id, token_address, signal_type, signal_at) AS (\n    VALUES\n        ${values}\n), checkpoints AS (\n    SELECT signal_id, token_address, signal_type, signal_at, 'signal' AS checkpoint, signal_at AS target_at FROM target_signals\n    ${checkpointUnions}\n), normalized_trades AS (\n    SELECT token_bought_mint_address AS token_address, block_time, amount_usd / NULLIF(token_bought_amount, 0) AS price_usd, tx_id, outer_instruction_index, inner_instruction_index FROM dex_solana.trades WHERE token_bought_mint_address IN (SELECT token_address FROM target_signals) AND amount_usd > 0 AND token_bought_amount > 0\n    UNION ALL SELECT token_sold_mint_address, block_time, amount_usd / NULLIF(token_sold_amount, 0), tx_id, outer_instruction_index, inner_instruction_index FROM dex_solana.trades WHERE token_sold_mint_address IN (SELECT token_address FROM target_signals) AND amount_usd > 0 AND token_sold_amount > 0\n), ranked AS (\n    SELECT c.signal_id, c.checkpoint, c.target_at, t.price_usd, t.block_time AS matched_trade_at, t.tx_id AS matched_tx_id, t.outer_instruction_index AS matched_outer_instruction_index, t.inner_instruction_index AS matched_inner_instruction_index, row_number() OVER (PARTITION BY c.signal_id, c.checkpoint ORDER BY t.block_time DESC, t.tx_id DESC, t.outer_instruction_index DESC, t.inner_instruction_index DESC) AS rn\n    FROM checkpoints c LEFT JOIN normalized_trades t ON t.token_address = c.token_address AND t.block_time <= c.target_at AND t.block_time > c.target_at - INTERVAL '24' HOUR\n) SELECT signal_id, checkpoint, target_at, price_usd, matched_trade_at, matched_tx_id, matched_outer_instruction_index, matched_inner_instruction_index FROM ranked WHERE rn = 1 ORDER BY signal_id, target_at`;
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

// Dune's target_at/completed_at-comparable strings look like "2026-08-11 05:22:21.000 UTC"
// (space-separated, trailing "UTC", not standard ISO 8601) — verified against a real archived
// response; Node's Date parser handles this format correctly. Returns null (never a value) for
// anything unparseable, so a malformed timestamp can only ever make a checkpoint look pending,
// never let a price through as if it were validated.
const parseDuneTimestamp = (value: unknown): number | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

// A checkpoint is only a genuine observation once its target time has actually passed in the
// real world by the time Dune's data reflects "now" — i.e. by the time the query *completed*,
// not when it was merely requested (execution isn't instant, so a query requested just before
// a checkpoint's target time can legitimately complete just after it). If either timestamp
// fails to parse, treat the checkpoint as pending rather than trusting whatever price Dune
// returned — conservative by design.
const isCheckpointPending = (targetAt: unknown, completedAt: string | null): boolean => {
  const targetMs = parseDuneTimestamp(targetAt);
  const completedMs = completedAt === null ? null : parseDuneTimestamp(completedAt);
  if (targetMs === null || completedMs === null) return true;
  return targetMs > completedMs;
};

const rowsToOutcomes = (signals: Signal[], rows: Array<Record<string, unknown>>, completedAt: string | null, sourceRunId: number | null = null, requestedAt: string | null = null): DuneOutcome[] => signals.map((signal) => ({
  signal,
  checkpoints: rows.filter((row) => Number(row.signal_id) === signal.id).map((row) => {
    const pending = isCheckpointPending(row.target_at, completedAt);
    const rawPriceUsd = typeof row.price_usd === 'number' ? row.price_usd : null;
    const matchedTradeAt = pending ? null : (typeof row.matched_trade_at === 'string' ? row.matched_trade_at : null);
    const targetMs = parseDuneTimestamp(row.target_at);
    const matchedMs = parseDuneTimestamp(matchedTradeAt);
    const queriedTooSoon = !pending && requestedAt !== null && parseDuneTimestamp(requestedAt) !== null && parseDuneTimestamp(signal.observedAt) !== null && parseDuneTimestamp(requestedAt)! < parseDuneTimestamp(signal.observedAt)! + MIN_SIGNAL_AGE_MS;
    return {
      label: String(row.checkpoint),
      targetTimestamp: String(row.target_at),
      result: {
        // Raw Dune data (raw_result in the DB, and the archived file) is never modified by
        // this — only the interpreted value returned here is nulled out for a pending
        // checkpoint, so the underlying evidence stays intact for later re-inspection.
        priceUsd: pending || queriedTooSoon ? null : rawPriceUsd,
        priceHttpStatus: null,
        archivePath: null,
        // 'checkpoint not yet reached' means the window hasn't elapsed — re-measuring this
        // signal later may produce a real value; it is not automatically backfilled.
        // 'not available' means the window has elapsed but no trade was found at all.
        status: pending ? 'checkpoint not yet reached' : queriedTooSoon ? 'premature query — needs re-verification' : (rawPriceUsd == null ? 'not available' : 'received'),
        matchedTradeAt: queriedTooSoon ? null : matchedTradeAt,
        matchedTxId: pending || queriedTooSoon ? null : (typeof row.matched_tx_id === 'string' ? row.matched_tx_id : null),
        matchedOuterInstructionIndex: pending || queriedTooSoon ? null : (typeof row.matched_outer_instruction_index === 'number' ? row.matched_outer_instruction_index : null),
        matchedInnerInstructionIndex: pending || queriedTooSoon ? null : (typeof row.matched_inner_instruction_index === 'number' ? row.matched_inner_instruction_index : null),
        matchedTradeAgeSeconds: matchedMs !== null && targetMs !== null && !pending && !queriedTooSoon ? (targetMs - matchedMs) / 1000 : null,
        sourceRunId,
      },
    };
  }),
}));

export const measureDuneOutcomes = async (database: DatabaseSync, signalIds: number[]): Promise<DuneOutcome[]> => {
  const requestedIds = [...new Set(signalIds.filter((id) => Number.isInteger(id)))].slice(0, 25);
  if (!requestedIds.length) throw new Error('Select at least one signal to measure.');
  const signals = database.prepare(`SELECT g.id, g.token_address AS tokenAddress, t.symbol, g.signal_type AS signalType, g.observed_at AS observedAt, g.market_cap AS marketCap FROM gmgn_signals g LEFT JOIN tokens t ON t.token_address = g.token_address WHERE g.id IN (${requestedIds.map(() => '?').join(',')}) AND g.token_address IS NOT NULL AND g.observed_at IS NOT NULL`).all(...requestedIds) as unknown as Signal[];
  if (!signals.length) throw new Error('No selected signals have usable token addresses and timestamps.');
  const inFlightRows = database.prepare(`SELECT id, signal_ids AS signalIds, status FROM dune_outcome_runs WHERE status IN ('submitted', 'running', 'timed_out')`).all() as unknown as Array<{ id: number; signalIds: string; status: string }>;
  const inFlight = new Map<number, { runId: number; status: string }>();
  for (const run of inFlightRows) {
    let ids: unknown;
    try { ids = JSON.parse(run.signalIds); } catch { continue; }
    if (!Array.isArray(ids)) continue;
    for (const rawId of ids) {
      const id = Number(rawId);
      if (Number.isInteger(id)) inFlight.set(id, { runId: run.id, status: run.status });
    }
  }
  const duplicateIds = signals.filter((signal) => inFlight.has(signal.id)).map((signal) => {
    const run = inFlight.get(signal.id)!;
    return `#${signal.id} (run ${run.runId}, ${run.status})`;
  });
  if (duplicateIds.length) throw new Error(`Dune request already in flight for ${duplicateIds.join(', ')}. Wait for it to finish; no duplicate request was sent.`);
  const apiKey = readDuneApiKey(); if (!apiKey) throw new Error('Dune API key not found. Add it to .secrets/dune/api-key.txt.');
  const query = sqlFor(signals); const requestedAt = new Date().toISOString();
  const headers = { 'X-DUNE-API-KEY': apiKey, 'content-type': 'application/json', accept: 'application/json' };
  const submitted = await withDuneSubmissionLock(async () => {
    await waitForDuneCapacity(database, { reconcile: async () => undefined });
    const inserted = database.prepare(`INSERT INTO dune_outcome_runs (signal_ids, query_sql, status, requested_at) VALUES (?, ?, 'submitted', ?)`).run(JSON.stringify(signals.map((s) => s.id)), query, requestedAt); const runId = Number(inserted.lastInsertRowid);
    const execute = await fetchWithRetry('https://api.dune.com/api/v1/sql/execute', { method: 'POST', headers, body: JSON.stringify({ sql: query, performance: 'medium' }) });
    const executionRaw = await execute.text(); if (!execute.ok) throw new Error(`Dune execution HTTP ${execute.status}`);
    const execution = JSON.parse(executionRaw) as { execution_id?: string }; if (!execution.execution_id) throw new Error('Dune did not return an execution id.');
    database.prepare(`UPDATE dune_outcome_runs SET execution_id = ?, status = 'running' WHERE id = ?`).run(execution.execution_id, runId);
    return { runId, executionRaw, execution };
  });
  const { runId, executionRaw, execution } = submitted;
  let state = 'QUERY_STATE_EXECUTING'; let resultRaw = '';
  for (let attempt = 0; attempt < 60 && state !== 'QUERY_STATE_COMPLETED'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const statusResponse = await fetch(`https://api.dune.com/api/v1/execution/${execution.execution_id}/status`, { headers }); const statusBody = await statusResponse.json() as { state?: string; error?: string }; state = statusBody.state ?? 'QUERY_STATE_FAILED'; if (state === 'QUERY_STATE_FAILED' || state === 'QUERY_STATE_CANCELLED') { database.prepare(`UPDATE dune_outcome_runs SET status = 'failed', completed_at = ? WHERE id = ?`).run(new Date().toISOString(), runId); throw new Error(statusBody.error ?? `Dune query ${state}`); }
  }
  if (state !== 'QUERY_STATE_COMPLETED') {
    // Keep this run as a durable in-flight marker. Dune may still finish after
    // the local 60-second wait; retrying here would create duplicate work and
    // make the historical evidence ambiguous.
    database.prepare(`UPDATE dune_outcome_runs SET status = 'timed_out' WHERE id = ?`).run(runId);
    throw new Error(`Dune query did not complete within 60 seconds (run ${runId} remains protected from duplicate retries).`);
  }
  const resultResponse = await fetch(`https://api.dune.com/api/v1/execution/${execution.execution_id}/results`, { headers }); resultRaw = await resultResponse.text(); if (!resultResponse.ok) throw new Error(`Dune results HTTP ${resultResponse.status}`);
  const archivePayload = JSON.stringify({ runId, requestedAt, execution: executionRaw, query, result: JSON.parse(resultRaw) }, null, 2); const buffer = Buffer.from(archivePayload); const sha = createHash('sha256').update(buffer).digest('hex'); const dir = path.join(root, '.data', 'archive', 'dune-outcomes'); mkdirSync(dir, { recursive: true }); const archivePath = path.join(dir, `dune-outcome-${runId}-${sha.slice(0, 16)}.json`); if (!existsSync(archivePath)) writeFileSync(archivePath, buffer, { flag: 'wx' });
  const completedAt = new Date().toISOString();
  database.prepare(`UPDATE dune_outcome_runs SET status = 'completed', raw_result = ?, archive_path = ?, archive_sha256 = ?, completed_at = ? WHERE id = ?`).run(resultRaw, archivePath, sha, completedAt, runId);
  const rows = ((JSON.parse(resultRaw) as { result?: { rows?: Array<Record<string, unknown>> } }).result?.rows ?? []);
   return rowsToOutcomes(signals, rows, completedAt, runId);
};

// A single, cheap (one status poll, no waiting) check of one stuck run against Dune's real
// state. Distinct from measureDuneOutcomes's polling loop, which blocks a live request for up
// to 60s while a query is freshly submitted — this instead asks "what actually happened to a
// run that was already submitted/running/timed_out," possibly hours or days ago, and finalizes
// it if Dune has since finished. Never re-submits the query itself, so it can never create a
// duplicate Dune execution.
export const reconcileDuneRun = async (
  database: DatabaseSync,
  runId: number,
): Promise<'completed' | 'failed' | 'still_running' | 'not_found' | 'no_api_key'> => {
  const run = database.prepare(`SELECT id, status, execution_id AS executionId, requested_at AS requestedAt, query_sql AS querySql FROM dune_outcome_runs WHERE id = ?`).get(runId) as { id: number; status: string; executionId: string | null; requestedAt: string; querySql: string } | undefined;
  if (!run) return 'not_found';
  if (!['submitted', 'running', 'timed_out'].includes(run.status)) return run.status === 'completed' ? 'completed' : 'failed';

  if (!run.executionId) {
    // The process died between submitting the request and recording Dune's execution id, so
    // there is nothing upstream to poll. Give it a grace period in case the original request
    // is still genuinely in flight, then write it off so its signals become eligible again.
    const ageMs = Date.now() - new Date(run.requestedAt).getTime();
    if (ageMs < 10 * 60_000) return 'still_running';
    database.prepare(`UPDATE dune_outcome_runs SET status = 'failed', completed_at = ? WHERE id = ?`).run(new Date().toISOString(), runId);
    return 'failed';
  }

  const apiKey = readDuneApiKey();
  if (!apiKey) return 'no_api_key';
  const headers = { 'X-DUNE-API-KEY': apiKey, accept: 'application/json' };

  let statusBody: { state?: string; error?: string };
  try {
    const statusResponse = await fetch(`https://api.dune.com/api/v1/execution/${run.executionId}/status`, { headers });
    statusBody = await statusResponse.json() as { state?: string; error?: string };
  } catch { return 'still_running'; }

  const state = statusBody.state ?? '';
  if (state === 'QUERY_STATE_FAILED' || state === 'QUERY_STATE_CANCELLED') {
    database.prepare(`UPDATE dune_outcome_runs SET status = 'failed', completed_at = ? WHERE id = ?`).run(new Date().toISOString(), runId);
    return 'failed';
  }
  if (state !== 'QUERY_STATE_COMPLETED') return 'still_running';

  const resultResponse = await fetch(`https://api.dune.com/api/v1/execution/${run.executionId}/results`, { headers });
  const resultRaw = await resultResponse.text();
  if (!resultResponse.ok) return 'still_running'; // transient Dune-side issue; try again next reconcile pass

  const archivePayload = JSON.stringify({ runId, requestedAt: run.requestedAt, query: run.querySql, reconciledFrom: 'status-poll', statusAtReconcile: statusBody, result: JSON.parse(resultRaw) }, null, 2);
  const buffer = Buffer.from(archivePayload);
  const sha = createHash('sha256').update(buffer).digest('hex');
  const dir = path.join(root, '.data', 'archive', 'dune-outcomes');
  mkdirSync(dir, { recursive: true });
  const archivePath = path.join(dir, `dune-outcome-${runId}-${sha.slice(0, 16)}.json`);
  if (!existsSync(archivePath)) writeFileSync(archivePath, buffer, { flag: 'wx' });
  const completedAt = new Date().toISOString();
  database.prepare(`UPDATE dune_outcome_runs SET status = 'completed', raw_result = ?, archive_path = ?, archive_sha256 = ?, completed_at = ? WHERE id = ?`).run(resultRaw, archivePath, sha, completedAt, runId);
  return 'completed';
};

export type DuneReconcileSummary = { checked: number; completed: number; failed: number; stillRunning: number; noApiKey: number; runIds: { completed: number[]; failed: number[]; stillRunning: number[] } };

// Sweeps every stuck run once. Called opportunistically (before a fresh measurement batch, or
// via an explicit UI action) rather than on a timer, since each check is a real Dune API call.
export const reconcileStuckDuneRuns = async (database: DatabaseSync): Promise<DuneReconcileSummary> => {
  const stuckRuns = database.prepare(`SELECT id FROM dune_outcome_runs WHERE status IN ('submitted', 'running', 'timed_out') ORDER BY id ASC`).all() as unknown as Array<{ id: number }>;
  const summary: DuneReconcileSummary = { checked: stuckRuns.length, completed: 0, failed: 0, stillRunning: 0, noApiKey: 0, runIds: { completed: [], failed: [], stillRunning: [] } };
  for (const run of stuckRuns) {
    const outcome = await reconcileDuneRun(database, run.id);
    if (outcome === 'completed') { summary.completed += 1; summary.runIds.completed.push(run.id); }
    else if (outcome === 'failed') { summary.failed += 1; summary.runIds.failed.push(run.id); }
    else if (outcome === 'no_api_key') { summary.noApiKey += 1; break; } // no key configured; further checks would fail identically
    else { summary.stillRunning += 1; summary.runIds.stillRunning.push(run.id); }
  }
  return summary;
};

export const readLatestDuneOutcomes = (database: DatabaseSync): DuneOutcome[] => {
  const run = database.prepare(`SELECT id, signal_ids AS signalIds, raw_result AS rawResult, requested_at AS requestedAt, completed_at AS completedAt FROM dune_outcome_runs WHERE status = 'completed' ORDER BY id DESC LIMIT 1`).get() as { id: number; signalIds: string; rawResult: string | null; requestedAt: string | null; completedAt: string | null } | undefined;
  if (!run?.rawResult) return [];
  const ids = JSON.parse(run.signalIds) as number[];
  const signals = database.prepare(`SELECT g.id, g.token_address AS tokenAddress, t.symbol, g.signal_type AS signalType, g.observed_at AS observedAt, g.market_cap AS marketCap FROM gmgn_signals g LEFT JOIN tokens t ON t.token_address = g.token_address WHERE g.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as unknown as Signal[];
  const rows = ((JSON.parse(run.rawResult) as { result?: { rows?: Array<Record<string, unknown>> } }).result?.rows ?? []);
  return rowsToOutcomes(signals, rows, run.completedAt, run.id, run.requestedAt);
};

/**
 * Rebuild the most complete in-memory view from every completed run. Runs are
 * append-only; when a signal was measured more than once, the newest completed
 * measurement wins while results for other batches remain visible after refresh.
 */
export const readAllDuneOutcomes = (database: DatabaseSync): DuneOutcome[] => {
  const runs = database.prepare(`SELECT id, signal_ids AS signalIds, raw_result AS rawResult, requested_at AS requestedAt, completed_at AS completedAt FROM dune_outcome_runs WHERE status = 'completed' AND raw_result IS NOT NULL ORDER BY id ASC`).all() as unknown as Array<{ id: number; signalIds: string; rawResult: string; requestedAt: string | null; completedAt: string | null }>;
  const merged = new Map<number, DuneOutcome>();
  for (const run of runs) {
    let ids: number[];
    try { ids = JSON.parse(run.signalIds) as number[]; } catch { continue; }
    if (!ids.length) continue;
    const signals = database.prepare(`SELECT g.id, g.token_address AS tokenAddress, t.symbol, g.signal_type AS signalType, g.observed_at AS observedAt, g.market_cap AS marketCap FROM gmgn_signals g LEFT JOIN tokens t ON t.token_address = g.token_address WHERE g.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as unknown as Signal[];
    let rows: Array<Record<string, unknown>> = [];
    try { rows = ((JSON.parse(run.rawResult) as { result?: { rows?: Array<Record<string, unknown>> } }).result?.rows ?? []); } catch { continue; }
    for (const outcome of rowsToOutcomes(signals, rows, run.completedAt, run.id, run.requestedAt)) {
      const previous = merged.get(outcome.signal.id);
      if (!previous) { merged.set(outcome.signal.id, outcome); continue; }
      const previousByLabel = new Map(previous.checkpoints.map((checkpoint) => [checkpoint.label, checkpoint]));
      for (const checkpoint of outcome.checkpoints) {
        const old = previousByLabel.get(checkpoint.label);
        // Earliest valid observation wins. Later runs still fill missing/pending checkpoints,
        // while sourceRunId and trade-age provenance remain attached to each selected value.
        if (!old || old.result.status !== 'received' || checkpoint.result.status === 'received' && old.result.status !== 'received') previousByLabel.set(checkpoint.label, checkpoint);
      }
      merged.set(outcome.signal.id, { signal: outcome.signal, checkpoints: [...previousByLabel.values()] });
    }
  }
  return [...merged.values()].sort((a, b) => a.signal.observedAt.localeCompare(b.signal.observedAt) || a.signal.id - b.signal.id);
};
