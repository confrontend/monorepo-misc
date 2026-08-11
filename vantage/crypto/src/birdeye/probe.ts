import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { readBirdeyeApiKey } from './credentials.js';

export type BirdeyeProbeResult = { id: number; tokenAddress: string; targetTimestamp: string; status: 'completed' | 'partial' | 'failed'; priceHttpStatus: number | null; liquidityHttpStatus: number | null; priceUsd: number | null; currentLiquidityHttpStatus: number | null; currentLiquidityUsd: number | null; liquidityMessage: string | null; archivePath: string | null; archiveSha256: string | null; error: string | null };

const projectRoot = (() => { let current = path.dirname(fileURLToPath(import.meta.url)); while (current !== path.dirname(current)) { if (existsSync(path.join(current, 'package.json'))) return current; current = path.dirname(current); } return process.cwd(); })();
const archiveDir = path.join(projectRoot, '.data', 'archive', 'birdeye-probe');

export const probeBirdeye = async (database: DatabaseSync, tokenAddress: string, targetTimestamp: string, now = new Date(), includeLiquidity = true): Promise<BirdeyeProbeResult> => {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tokenAddress)) throw new Error('Enter a valid Solana token address.');
  const timestamp = new Date(targetTimestamp);
  if (!Number.isFinite(timestamp.getTime())) throw new Error('Target timestamp must be a valid ISO timestamp.');
  const apiKey = readBirdeyeApiKey();
  if (!apiKey) throw new Error('Birdeye API key not found. Add it to .secrets/birdeye/api-key.txt.');
  const requestedAt = now.toISOString();
  const row = database.prepare(`INSERT INTO birdeye_probe_batches (token_address, target_timestamp, requested_at, status) VALUES (?, ?, ?, 'failed')`).run(tokenAddress, timestamp.toISOString(), requestedAt);
  const id = Number(row.lastInsertRowid);
  const headers = { 'X-API-KEY': apiKey, accept: 'application/json' };
  const unix = Math.floor(timestamp.getTime() / 1000);
  const requests = (includeLiquidity ? [
    ['price', `https://public-api.birdeye.so/defi/historical_price_unix?address=${encodeURIComponent(tokenAddress)}&unixtime=${unix}`],
    ['liquidity', `https://public-api.birdeye.so/defi/v3/liquidity/history/token?address=${encodeURIComponent(tokenAddress)}&resolution=1m&time=${unix}`],
  ] : [['price', `https://public-api.birdeye.so/defi/historical_price_unix?address=${encodeURIComponent(tokenAddress)}&unixtime=${unix}`]]) as Array<readonly ['price' | 'liquidity', string]>;
  const results: Record<'price' | 'liquidity', { status: number | null; raw: string | null; error: string | null }> = { price: { status: null, raw: null, error: null }, liquidity: { status: null, raw: null, error: null } };
  for (const [kind, url] of requests) {
    try { const response = await fetch(url, { headers }); results[kind].status = response.status; results[kind].raw = await response.text(); if (!response.ok) results[kind].error = `HTTP ${response.status}`; }
    catch (error) { results[kind].error = error instanceof Error ? error.message : String(error); }
  }
  const currentLiquidity = { status: null as number | null, raw: null as string | null, error: null as string | null };
  if (includeLiquidity && results.liquidity.error) {
    try {
      const response = await fetch(`https://public-api.birdeye.so/defi/multi_price?list_address=${encodeURIComponent(tokenAddress)}&include_liquidity=true`, { headers });
      currentLiquidity.status = response.status;
      currentLiquidity.raw = await response.text();
      if (!response.ok) currentLiquidity.error = `HTTP ${response.status}`;
    } catch (error) { currentLiquidity.error = error instanceof Error ? error.message : String(error); }
  }
  const status = results.price.raw && results.liquidity.raw && !results.price.error && !results.liquidity.error ? 'completed' : results.price.raw || results.liquidity.raw ? 'partial' : 'failed';
  const archivePayload = JSON.stringify({ probeId: id, tokenAddress, targetTimestamp: timestamp.toISOString(), requestedAt, price: results.price, liquidity: results.liquidity, currentLiquidity }, null, 2);
  mkdirSync(archiveDir, { recursive: true });
  const archiveBuffer = Buffer.from(archivePayload, 'utf8');
  const archiveSha256 = createHash('sha256').update(archiveBuffer).digest('hex');
  const archivePath = path.join(archiveDir, `birdeye-probe-${id}-${archiveSha256.slice(0, 16)}.json`);
  if (!existsSync(archivePath)) writeFileSync(archivePath, archiveBuffer, { flag: 'wx' });
  database.prepare(`UPDATE birdeye_probe_batches SET status = ?, price_http_status = ?, liquidity_http_status = ?, price_raw_payload = ?, liquidity_raw_payload = ?, price_error = ?, liquidity_error = ?, archive_path = ?, archive_sha256 = ?, archived_at = ? WHERE id = ?`).run(status, results.price.status, results.liquidity.status, results.price.raw, results.liquidity.raw, results.price.error, results.liquidity.error, archivePath, archiveSha256, new Date().toISOString(), id);
  let priceUsd: number | null = null;
  if (results.price.raw) {
    try {
      const parsed = JSON.parse(results.price.raw) as { data?: { value?: unknown } };
      priceUsd = typeof parsed.data?.value === 'number' ? parsed.data.value : null;
    } catch { /* raw response remains authoritative */ }
  }
  let liquidityMessage: string | null = results.liquidity.error;
  if (results.liquidity.raw) {
    try {
      const parsed = JSON.parse(results.liquidity.raw) as { message?: unknown };
      if (typeof parsed.message === 'string') liquidityMessage = parsed.message;
    } catch { /* raw response remains authoritative */ }
  }
  let currentLiquidityUsd: number | null = null;
  if (currentLiquidity.raw) {
    try {
      const parsed = JSON.parse(currentLiquidity.raw) as { data?: Record<string, { liquidity?: unknown }> };
      const item = parsed.data?.[tokenAddress];
      currentLiquidityUsd = typeof item?.liquidity === 'number' ? item.liquidity : null;
    } catch { /* raw response remains authoritative */ }
  }
  return { id, tokenAddress, targetTimestamp: timestamp.toISOString(), status, priceHttpStatus: results.price.status, liquidityHttpStatus: results.liquidity.status, priceUsd, currentLiquidityHttpStatus: currentLiquidity.status, currentLiquidityUsd, liquidityMessage: currentLiquidityUsd === null ? liquidityMessage : `${liquidityMessage ?? 'Historical liquidity unavailable'}; current liquidity fallback returned`, archivePath, archiveSha256, error: results.price.error ?? results.liquidity.error };
};
