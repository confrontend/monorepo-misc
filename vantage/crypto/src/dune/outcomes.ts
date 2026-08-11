import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { readDuneApiKey } from './credentials.js';

type Signal = { id: number; tokenAddress: string; symbol: string | null; signalType: string | null; observedAt: string; marketCap: number | null };
export type DuneOutcome = { signal: Signal; checkpoints: Array<{ label: string; targetTimestamp: string; result: { priceUsd: number | null; status: string; priceHttpStatus: number | null; archivePath: string | null } }> };
const root = (() => { let current = path.dirname(fileURLToPath(import.meta.url)); while (current !== path.dirname(current)) { if (existsSync(path.join(current, 'package.json'))) return current; current = path.dirname(current); } return process.cwd(); })();

const sqlFor = (signals: Signal[]): string => {
  const values = signals.map((s) => `(${s.id}, '${s.tokenAddress.replaceAll("'", "''")}', '${(s.signalType ?? '').replaceAll("'", "''")}', from_iso8601_timestamp('${s.observedAt}'))`).join(',\n        ');
  return `WITH target_signals (signal_id, token_address, signal_type, signal_at) AS (\n    VALUES\n        ${values}\n), checkpoints AS (\n    SELECT signal_id, token_address, signal_type, signal_at, 'signal' AS checkpoint, signal_at AS target_at FROM target_signals\n    UNION ALL SELECT signal_id, token_address, signal_type, signal_at, '+1h', date_add('hour', 1, signal_at) FROM target_signals\n    UNION ALL SELECT signal_id, token_address, signal_type, signal_at, '+3h', date_add('hour', 3, signal_at) FROM target_signals\n), normalized_trades AS (\n    SELECT token_bought_mint_address AS token_address, block_time, amount_usd / NULLIF(token_bought_amount, 0) AS price_usd, tx_id FROM dex_solana.trades WHERE token_bought_mint_address IN (SELECT token_address FROM target_signals) AND amount_usd > 0 AND token_bought_amount > 0\n    UNION ALL SELECT token_sold_mint_address, block_time, amount_usd / NULLIF(token_sold_amount, 0), tx_id FROM dex_solana.trades WHERE token_sold_mint_address IN (SELECT token_address FROM target_signals) AND amount_usd > 0 AND token_sold_amount > 0\n), ranked AS (\n    SELECT c.signal_id, c.checkpoint, c.target_at, t.price_usd, t.block_time AS matched_trade_at, row_number() OVER (PARTITION BY c.signal_id, c.checkpoint ORDER BY t.block_time DESC) AS rn\n    FROM checkpoints c LEFT JOIN normalized_trades t ON t.token_address = c.token_address AND t.block_time <= c.target_at AND t.block_time > c.target_at - INTERVAL '24' HOUR\n) SELECT signal_id, checkpoint, target_at, price_usd, matched_trade_at FROM ranked WHERE rn = 1 ORDER BY signal_id, target_at`;
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

const rowsToOutcomes = (signals: Signal[], rows: Array<Record<string, unknown>>): DuneOutcome[] => signals.map((signal) => ({
  signal,
  checkpoints: rows.filter((row) => Number(row.signal_id) === signal.id).map((row) => ({
    label: String(row.checkpoint),
    targetTimestamp: String(row.target_at),
    result: {
      priceUsd: typeof row.price_usd === 'number' ? row.price_usd : null,
      priceHttpStatus: null,
      archivePath: null,
      status: row.price_usd == null ? 'not available' : 'received',
    },
  })),
}));

export const measureDuneOutcomes = async (database: DatabaseSync, signalIds: number[]): Promise<DuneOutcome[]> => {
  const signals = database.prepare(`SELECT g.id, g.token_address AS tokenAddress, t.symbol, g.signal_type AS signalType, g.observed_at AS observedAt, g.market_cap AS marketCap FROM gmgn_signals g LEFT JOIN tokens t ON t.token_address = g.token_address WHERE g.id IN (${signalIds.map(() => '?').join(',')}) AND g.token_address IS NOT NULL AND g.observed_at IS NOT NULL`).all(...signalIds.slice(0, 25)) as unknown as Signal[];
  if (!signals.length) throw new Error('No selected signals have usable token addresses and timestamps.');
  const apiKey = readDuneApiKey(); if (!apiKey) throw new Error('Dune API key not found. Add it to .secrets/dune/api-key.txt.');
  const query = sqlFor(signals); const requestedAt = new Date().toISOString();
  const inserted = database.prepare(`INSERT INTO dune_outcome_runs (signal_ids, query_sql, status, requested_at) VALUES (?, ?, 'submitted', ?)`).run(JSON.stringify(signals.map((s) => s.id)), query, requestedAt); const runId = Number(inserted.lastInsertRowid);
  const headers = { 'X-DUNE-API-KEY': apiKey, 'content-type': 'application/json', accept: 'application/json' };
  const execute = await fetchWithRetry('https://api.dune.com/api/v1/sql/execute', { method: 'POST', headers, body: JSON.stringify({ sql: query, performance: 'medium' }) });
  const executionRaw = await execute.text(); if (!execute.ok) throw new Error(`Dune execution HTTP ${execute.status}`);
  const execution = JSON.parse(executionRaw) as { execution_id?: string }; if (!execution.execution_id) throw new Error('Dune did not return an execution id.');
  database.prepare(`UPDATE dune_outcome_runs SET execution_id = ?, status = 'running' WHERE id = ?`).run(execution.execution_id, runId);
  let state = 'QUERY_STATE_EXECUTING'; let resultRaw = '';
  for (let attempt = 0; attempt < 60 && state !== 'QUERY_STATE_COMPLETED'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const statusResponse = await fetch(`https://api.dune.com/api/v1/execution/${execution.execution_id}/status`, { headers }); const statusBody = await statusResponse.json() as { state?: string; error?: string }; state = statusBody.state ?? 'QUERY_STATE_FAILED'; if (state === 'QUERY_STATE_FAILED' || state === 'QUERY_STATE_CANCELLED') throw new Error(statusBody.error ?? `Dune query ${state}`);
  }
  if (state !== 'QUERY_STATE_COMPLETED') throw new Error('Dune query did not complete within 60 seconds.');
  const resultResponse = await fetch(`https://api.dune.com/api/v1/execution/${execution.execution_id}/results`, { headers }); resultRaw = await resultResponse.text(); if (!resultResponse.ok) throw new Error(`Dune results HTTP ${resultResponse.status}`);
  const archivePayload = JSON.stringify({ runId, requestedAt, execution: executionRaw, query, result: JSON.parse(resultRaw) }, null, 2); const buffer = Buffer.from(archivePayload); const sha = createHash('sha256').update(buffer).digest('hex'); const dir = path.join(root, '.data', 'archive', 'dune-outcomes'); mkdirSync(dir, { recursive: true }); const archivePath = path.join(dir, `dune-outcome-${runId}-${sha.slice(0, 16)}.json`); if (!existsSync(archivePath)) writeFileSync(archivePath, buffer, { flag: 'wx' });
  database.prepare(`UPDATE dune_outcome_runs SET status = 'completed', raw_result = ?, archive_path = ?, archive_sha256 = ?, completed_at = ? WHERE id = ?`).run(resultRaw, archivePath, sha, new Date().toISOString(), runId);
  const rows = ((JSON.parse(resultRaw) as { result?: { rows?: Array<Record<string, unknown>> } }).result?.rows ?? []);
  return rowsToOutcomes(signals, rows);
};

export const readLatestDuneOutcomes = (database: DatabaseSync): DuneOutcome[] => {
  const run = database.prepare(`SELECT signal_ids AS signalIds, raw_result AS rawResult FROM dune_outcome_runs WHERE status = 'completed' ORDER BY id DESC LIMIT 1`).get() as { signalIds: string; rawResult: string | null } | undefined;
  if (!run?.rawResult) return [];
  const ids = JSON.parse(run.signalIds) as number[];
  const signals = database.prepare(`SELECT g.id, g.token_address AS tokenAddress, t.symbol, g.signal_type AS signalType, g.observed_at AS observedAt, g.market_cap AS marketCap FROM gmgn_signals g LEFT JOIN tokens t ON t.token_address = g.token_address WHERE g.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as unknown as Signal[];
  const rows = ((JSON.parse(run.rawResult) as { result?: { rows?: Array<Record<string, unknown>> } }).result?.rows ?? []);
  return rowsToOutcomes(signals, rows);
};
