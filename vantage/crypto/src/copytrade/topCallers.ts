import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { median } from './evaluate.js';
import { fetchActivityPageRaw, waitForGmgnRequest } from './fetch.js';
import { logDiagnostic } from '../db/diagnostics.js';
import { zipStored } from '../dune/archive.js';
import { collectPendingCheckpointTargets, MAX_CHECKPOINT_TARGETS_PER_RUN, runCheckpointBatch as defaultRunCheckpointBatch } from './topCallerCheckpoints.js';

/**
 * Top Callers.
 *
 * The originally-proposed GMGN Top Caller endpoints (/api/v1/notification/callout/rank,
 * call_out/get_record, the follow/callout feed) have STILL never been captured in this project
 * — they look like GMGN's internal web-app API, needing an authenticated browser session, not
 * the API-key-based CLI this project otherwise uses. That research question remains open; see
 * research/prompts/top-callers-research.md.
 *
 * Real capture confirmed live 2026-08-17: gmgn-cli DOES document and expose a real, different
 * source — `track kol` (GET /v1/user/kol, exist auth = API key only, weight 1 in GMGN's
 * leaky-bucket limiter, no personal data per node_modules/gmgn-cli/skills/gmgn-track/SKILL.md's
 * own safety notes). It returns real trades from GMGN-tagged KOL/influencer wallets — an
 * identifiable public wallet (address + twitter handle + platform tags) whose trades carry
 * social signal, which is the spirit "Top Callers" was after even though it isn't the literal
 * message/thesis-based callout feature GMGN also has. GMGN gives no rank or multiplier for KOL
 * trades, so this project never fabricates those — every returned number here is this app's own
 * Dune-measured checkpoint (once that's wired up), never a guessed GMGN figure.
 */

const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const execFileAsync = promisify(execFile);
const findProjectRoot = (): string => {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, 'package.json'))) return current;
    current = path.dirname(current);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
};
const projectRoot = findProjectRoot();
const keyPath = path.join(projectRoot, '.secrets', 'gmgn', 'gmgn-api-key.txt');
const archiveDirectory = path.join(projectRoot, '.data', 'archive', 'top-callers');

export type KolTradeRow = {
  transaction_hash: string;
  maker: string;
  side?: string;
  base_address: string;
  base_token?: { symbol?: string };
  price_usd?: number;
  timestamp: number;
  maker_info?: { twitter_username?: string; tags?: string[] };
};

export type FetchKolTrades = (chain: string, limit: number) => Promise<{ rows: KolTradeRow[]; rawStdout: string }>;
export type FetchWalletActivity = (chain: string, wallet: string, limit: number, stopAtTimestamp?: number | null) => Promise<{ rows: KolTradeRow[]; rawStdout: string; hasGap?: boolean }>;

/** Minimum interval between leaderboard capture starts. This is separate from GMGN's API-key
 * limiter: it prevents repeated identical leaderboard snapshots even when the API is available. */
export const LEADERBOARD_CAPTURE_COOLDOWN_MS = 10_000;

export const msSinceLastCollectionStart = (
  database: DatabaseSync, kind: CollectionKind, nowMs = Date.now(),
): number | null => {
  const row = database.prepare(
    `SELECT started_at AS startedAt FROM top_caller_collection_runs WHERE kind = ? ORDER BY id DESC LIMIT 1`,
  ).get(kind) as { startedAt: string } | undefined;
  if (!row) return null;
  const startedMs = Date.parse(row.startedAt);
  return Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : null;
};

/** The real network call — real GMGN CLI invocation, mirroring the exact execFile pattern
 *  already used in src/gmgn/capture.ts (env-injected key, timeout, maxBuffer, windowsHide;
 *  the key never touches argv, logs, or storage). */
export const runGmgnTrackKol: FetchKolTrades = async (chain, limit) => {
  const secret = existsSync(keyPath) ? readFileSync(keyPath, 'utf8').trim() : '';
  if (!secret) throw new Error('GMGN API key file is empty or missing.');
  const script = path.join(projectRoot, 'node_modules', 'gmgn-cli', 'dist', 'index.js');
  if (!existsSync(script)) throw new Error('Project-local gmgn-cli is unavailable. Run npm install first.');
  await waitForGmgnRequest();
  const { stdout } = await execFileAsync(
    process.execPath,
    [script, 'track', 'kol', '--chain', chain, '--limit', String(limit), '--raw'],
    { cwd: projectRoot, env: { ...process.env, GMGN_API_KEY: secret }, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
  );
  const parsed = JSON.parse(stdout) as { list?: unknown[] };
  const rows = Array.isArray(parsed.list) ? (parsed.list as KolTradeRow[]) : [];
  return { rows, rawStdout: stdout };
};

const activityText = (value: unknown): string | null => {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
};

const activityNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
};

const activityToKolRow = (activity: Record<string, unknown>, fallbackWallet: string): KolTradeRow | null => {
  const token = activity.token && typeof activity.token === 'object' && !Array.isArray(activity.token)
    ? activity.token as Record<string, unknown> : {};
  const maker = activityText(activity.wallet) ?? fallbackWallet;
  const transactionHash = activityText(activity.tx_hash) ?? activityText(activity.transaction_hash);
  const baseAddress = activityText(token.address) ?? activityText(activity.token_address);
  const timestamp = activityNumber(activity.timestamp);
  if (!maker || !transactionHash || !baseAddress || timestamp === null) return null;
  return {
    maker,
    transaction_hash: transactionHash,
    base_address: baseAddress,
    base_token: { symbol: activityText(token.symbol) ?? activityText(activity.token_symbol) ?? undefined },
    price_usd: activityNumber(activity.price_usd) ?? activityNumber(activity.price) ?? undefined,
    timestamp,
    side: activityText(activity.event_type) ?? activityText(activity.side) ?? undefined,
  };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** wallet_activity is weight 3 in GMGN's leaky-bucket limiter (per gmgn-cli's own skill docs),
 *  while track/kol is weight 1. fetchActivityPageRaw now uses the universal five-second
 *  request-start gate; this extra per-page delay remains as additional margin for the heavier
 *  wallet_activity endpoint and is intentionally scoped to this loop only. */
const WALLET_ACTIVITY_EXTRA_PAGE_DELAY_MS = 1500;

/** Fetch the official per-wallet history used by GMGN's wallet detail page. We walk pages until
 * the response reaches one day of history (or the endpoint has no next cursor), so the button
 * immediately fills the detail table with older calls instead of only the newest feed page. */
export const runGmgnWalletActivity: FetchWalletActivity = async (chain, wallet, limit, knownLatestTimestamp = null) => {
  const secret = existsSync(keyPath) ? readFileSync(keyPath, 'utf8').trim() : '';
  if (!secret) throw new Error('GMGN API key file is empty or missing.');
  const rows: KolTradeRow[] = [];
  const rawPages: string[] = [];
  // A first fetch walks back one day. On later fetches, the newest stored call is the
  // resume boundary: once a page reaches that timestamp, all older pages are already in
  // SQLite and are not requested again. We still fetch the newest page once to discover
  // genuinely new calls since the last run.
  const cutoff = knownLatestTimestamp ?? Math.floor(Date.now() / 1000) - 86_400;
  let cursor: string | null = null;
  let reachedStopCondition = false;
  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    if (pageNumber > 0) await sleep(WALLET_ACTIVITY_EXTRA_PAGE_DELAY_MS);
    const result = await fetchActivityPageRaw({ wallet, chain, cursor, limit: Math.max(50, limit), apiKey: secret });
    rawPages.push(result.rawStdout);
    for (const activity of result.page.activities) {
      const row = activityToKolRow(activity, wallet);
      if (row) rows.push(row);
    }
    const oldest = rows.reduce((value, row) => Math.min(value, row.timestamp), Number.POSITIVE_INFINITY);
    if (!result.page.next || oldest <= cutoff) { reachedStopCondition = true; break; }
    cursor = result.page.next;
  }
  const oldestFetched = rows.reduce((value, row) => Math.min(value, row.timestamp), Number.POSITIVE_INFINITY);
  const hasGap = knownLatestTimestamp !== null
    && !reachedStopCondition
    && oldestFetched > knownLatestTimestamp;
  return { rows, hasGap, rawStdout: JSON.stringify({ source: 'gmgn-portfolio-activity', wallet, chain, pages: rawPages, hasGap }, null, 2) };
};

const archiveKolResponse = (
  rawStdout: string, capturedAt: string, chain: string, limit: number, rowCount: number,
  sourceName = 'gmgn-track-kol-response.json',
): { archivePath: string; archiveSha256: string } => {
  mkdirSync(archiveDirectory, { recursive: true });
  const source = Buffer.from(rawStdout, 'utf8');
  const manifest = Buffer.from(JSON.stringify({ capturedAt, chain, limit, rowCount, sourceName }, null, 2));
  const archive = zipStored([{ name: sourceName, data: source }, { name: 'manifest.json', data: manifest }]);
  const archiveSha256 = createHash('sha256').update(archive).digest('hex');
  const archivePath = path.join(archiveDirectory, `top-caller-kol-${capturedAt.replace(/[:.]/g, '-')}-${archiveSha256.slice(0, 16)}.zip`);
  if (!existsSync(archivePath)) writeFileSync(archivePath, archive, { flag: 'wx' });
  return { archivePath, archiveSha256 };
};

/**
 * Just the callout rows — no snapshot/ranking side effect. Split out so the per-wallet
 * 'callouts' loop in startCollectionRun can persist each wallet's results the moment that
 * wallet finishes, instead of holding everything in memory until every tracked caller has been
 * fetched (which previously meant a failure on wallet 15 of 20 discarded wallets 1-14 too, and
 * gave the UI no real progress signal to show while it ran). Pure DB writes, no network.
 */
const insertCallouts = (
  database: DatabaseSync, rows: KolTradeRow[], capturedAt: string,
): { calloutsInserted: number; calloutsSkipped: number } => {
  let calloutsInserted = 0;
  let calloutsSkipped = 0;
  const insertCallout = database.prepare(
    `INSERT OR IGNORE INTO top_caller_callouts
       (caller_key, token_address, token_symbol, call_timestamp, call_price_usd, message, reported_multiplier, source_call_id, raw_payload, fetched_at, dedup_key)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    if (!row.maker || !row.base_address || !row.transaction_hash || typeof row.timestamp !== 'number') { calloutsSkipped += 1; continue; }
    const dedupKey = computeCalloutDedupKey({ sourceCallId: row.transaction_hash, callerKey: row.maker, tokenAddress: row.base_address, callTimestamp: row.timestamp });
    const result = insertCallout.run(
      row.maker, row.base_address, row.base_token?.symbol ?? null, row.timestamp,
      row.price_usd !== undefined ? String(row.price_usd) : null,
      row.transaction_hash, JSON.stringify(row), capturedAt, dedupKey,
    );
    if (result.changes > 0) calloutsInserted += 1; else calloutsSkipped += 1;
  }
  return { calloutsInserted, calloutsSkipped };
};

/**
 * Writes both the observed-caller snapshot (ranked by call count WITHIN this one capture batch
 * — explicitly not a GMGN-published rank, since GMGN gives none for KOL trades) and every
 * observed trade as a callout row, via insertCallouts above. Used by 'leaderboard' captures
 * (a single real batch, snapshot IS the leaderboard) and by the legacy fixture-injected
 * 'callouts' test path — never by the real per-wallet 'callouts' loop, which persists
 * incrementally via insertCallouts alone and must NOT create a snapshot per wallet (that would
 * silently corrupt readLeaderboard, which always reads the single most recent snapshot).
 */
const applyKolCapture = (
  database: DatabaseSync, runId: number, rows: KolTradeRow[], chain: string, limit: number,
  capturedAt: string, rawStdout: string, archivePath: string | null, archiveSha256: string | null,
): { callersObserved: number; calloutsInserted: number; calloutsSkipped: number } => {
  const byMaker = new Map<string, number>();
  for (const row of rows) {
    if (!row.maker) continue;
    byMaker.set(row.maker, (byMaker.get(row.maker) ?? 0) + 1);
  }
  const ranked = Array.from(byMaker.entries()).sort((a, b) => b[1] - a[1]);

  const snapshotId = Number(database.prepare(
    `INSERT INTO top_caller_snapshots (run_id, captured_at, period, ordering, filters_json, raw_payload, archive_path, archive_sha256)
     VALUES (?, ?, NULL, 'observed_call_count_desc', ?, ?, ?, ?)`,
  ).run(runId, capturedAt, JSON.stringify({ chain, limit }), rawStdout, archivePath, archiveSha256).lastInsertRowid);
  const insertRow = database.prepare(
    `INSERT INTO top_caller_snapshot_rows (snapshot_id, caller_key, rank_position, call_count, raw_payload) VALUES (?, ?, ?, ?, ?)`,
  );
  ranked.forEach(([callerKey, count], index) => {
    insertRow.run(snapshotId, callerKey, index + 1, count, JSON.stringify({ observedInBatch: count }));
  });

  const { calloutsInserted, calloutsSkipped } = insertCallouts(database, rows, capturedAt);
  return { callersObserved: byMaker.size, calloutsInserted, calloutsSkipped };
};

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

export type CalloutDedupInput = {
  /** The source's own stable per-call ID, when it provides one — always preferred over the
   *  fallback below. Whether GMGN's Callout endpoints actually expose one is itself one of the
   *  open questions in the research prompt. */
  sourceCallId: string | null;
  callerKey: string;
  tokenAddress: string;
  /** Exact timestamp precision as returned by the source — never truncate to a coarser grain,
   *  since a caller may legitimately call the same token twice in one day and a truncated key
   *  would wrongly collapse two real calls into one. */
  callTimestamp: number;
};

export const computeCalloutDedupKey = (input: CalloutDedupInput): string =>
  input.sourceCallId
    ? `id:${input.sourceCallId}`
    : `fallback:${input.callerKey}|${input.tokenAddress}|${input.callTimestamp}`;

// ---------------------------------------------------------------------------
// Tracking — start empty; nothing is auto-tracked
// ---------------------------------------------------------------------------

export const trackCaller = (database: DatabaseSync, callerKey: string): void => {
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO top_caller_tracked (caller_key, tracked_at, untracked_at) VALUES (?, ?, NULL)
     ON CONFLICT(caller_key) DO UPDATE SET tracked_at = excluded.tracked_at, untracked_at = NULL`,
  ).run(callerKey, now);
};

export const untrackCaller = (database: DatabaseSync, callerKey: string): void => {
  const now = new Date().toISOString();
  database.prepare(
    `UPDATE top_caller_tracked SET untracked_at = ? WHERE caller_key = ? AND untracked_at IS NULL`,
  ).run(now, callerKey);
};

export const isCallerTracked = (database: DatabaseSync, callerKey: string): boolean => {
  const row = database.prepare(
    `SELECT 1 AS present FROM top_caller_tracked WHERE caller_key = ? AND untracked_at IS NULL`,
  ).get(callerKey) as { present: number } | undefined;
  return row !== undefined;
};

export const listTrackedCallerKeys = (database: DatabaseSync): string[] => {
  const rows = database.prepare(
    `SELECT caller_key AS callerKey FROM top_caller_tracked WHERE untracked_at IS NULL ORDER BY tracked_at ASC`,
  ).all() as unknown as Array<{ callerKey: string }>;
  return rows.map((row) => row.callerKey);
};

// ---------------------------------------------------------------------------
// Leaderboard read — works against an empty database, no capture required
// ---------------------------------------------------------------------------

export type LeaderboardRow = {
  callerKey: string;
  rankPosition: number;
  callCount: number | null;
  reportedAvgMultiplier: string | null;
  reportedBestMultiplier: string | null;
  reportedHitRate2xPct: string | null;
  tracked: boolean;
};

export type LeaderboardReport = {
  snapshot: { capturedAt: string; period: string | null } | null;
  rows: LeaderboardRow[];
};

export const readLeaderboard = (database: DatabaseSync): LeaderboardReport => {
  const snapshot = database.prepare(
    `SELECT id, captured_at AS capturedAt, period FROM top_caller_snapshots ORDER BY captured_at DESC, id DESC LIMIT 1`,
  ).get() as { id: number; capturedAt: string; period: string | null } | undefined;
  if (!snapshot) return { snapshot: null, rows: [] };

  const rows = database.prepare(
    `SELECT caller_key AS callerKey, rank_position AS rankPosition, call_count AS callCount,
            reported_avg_multiplier AS reportedAvgMultiplier, reported_best_multiplier AS reportedBestMultiplier,
            reported_hit_rate_2x_pct AS reportedHitRate2xPct
     FROM top_caller_snapshot_rows WHERE snapshot_id = ? ORDER BY rank_position ASC`,
  ).all(snapshot.id) as unknown as Array<Omit<LeaderboardRow, 'tracked'>>;

  const tracked = new Set(listTrackedCallerKeys(database));
  return {
    snapshot: { capturedAt: snapshot.capturedAt, period: snapshot.period },
    rows: rows.map((row) => ({ ...row, tracked: tracked.has(row.callerKey) })),
  };
};

// ---------------------------------------------------------------------------
// Collection run lifecycle — mirrors the shape of copytrade/fetch.ts's run tracking
// ---------------------------------------------------------------------------

export type CollectionKind = 'leaderboard' | 'callouts' | 'checkpoints';
export type CollectionStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'rate_limited' | 'cancelled';

export type CollectionRunState = {
  running: boolean;
  runId: number | null;
  status: CollectionStatus;
  requestsMade: number;
  /** Per-wallet progress for a real 'callouts' run — null for 'leaderboard'/'checkpoints', which
   *  have no comparable notion of "N of M". Checkpoint progress is reported as batch count. */
  walletTotal: number | null;
  walletDone: number | null;
  rateLimitedUntil: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  message: string;
};

/** Keep a machine-readable cooldown even when the CLI only reports a human reset message. */
const rateLimitResetFromMessage = (message: string): string | null => {
  const unix = message.match(/(?:reset_at|resetAt)[^0-9]*(\d{10,})/i);
  if (unix) return new Date(Number(unix[1]) * 1000).toISOString();
  const remaining = message.match(/\(~\s*(\d+)s?\s+remaining\)/i);
  return remaining ? new Date(Date.now() + Number(remaining[1]) * 1000).toISOString() : null;
};

export const hasActiveCollectionRun = (database: DatabaseSync, kind: CollectionKind): boolean => {
  const row = database.prepare(
    `SELECT 1 AS present FROM top_caller_collection_runs WHERE kind = ? AND status = 'running' LIMIT 1`,
  ).get(kind) as { present: number } | undefined;
  return row !== undefined;
};

const retryTimers = new Map<number, ReturnType<typeof setTimeout>>();

const logCollectionTerminal = (database: DatabaseSync, runId: number, status: CollectionStatus): void => {
  const row = database.prepare(
    `SELECT kind, started_at AS startedAt, wallet_done AS walletDone, wallet_total AS walletTotal, retry_count AS retryCount FROM top_caller_collection_runs WHERE id = ?`,
  ).get(runId) as { kind: string; startedAt: string; walletDone: number | null; walletTotal: number | null; retryCount: number } | undefined;
  if (!row) return;
  logDiagnostic(database, {
    level: status === 'failed' ? 'error' : status === 'paused' ? 'warn' : 'info',
    event: 'top_caller_collection_terminal',
    message: `Top Caller ${row.kind} run ${runId} ${status}.`,
    detail: {
      runId, kind: row.kind, status, walletDone: row.walletDone, walletTotal: row.walletTotal,
      retryCount: row.retryCount, elapsedMs: Math.max(0, Date.now() - Date.parse(row.startedAt)),
    },
  });
};

/** Mark active Top Caller runs cancelled. The worker checks this flag between network units;
 * an in-flight HTTP request is allowed to finish, but no next wallet/page is started. */
export const stopCollectionRuns = (database: DatabaseSync, kind?: CollectionKind): number => {
  const now = new Date().toISOString();
  const result = kind
    ? database.prepare(`UPDATE top_caller_collection_runs SET status = 'cancelled', completed_at = ?, error = ? WHERE kind = ? AND status IN ('running','paused')`).run(now, 'Stopped by user; data already fetched is retained.', kind)
    : database.prepare(`UPDATE top_caller_collection_runs SET status = 'cancelled', completed_at = ?, error = ? WHERE status IN ('running','paused')`).run(now, 'Stopped by user; data already fetched is retained.');
  const rows = database.prepare(`SELECT id FROM top_caller_collection_runs WHERE status = 'cancelled' AND completed_at = ?`).all(now) as unknown as Array<{ id: number }>;
  for (const row of rows) {
    const timer = retryTimers.get(row.id); if (timer) { clearTimeout(timer); retryTimers.delete(row.id); }
    logCollectionTerminal(database, row.id, 'cancelled');
  }
  return Number(result.changes);
};

const isCollectionRunCancelled = (database: DatabaseSync, runId: number): boolean => {
  const row = database.prepare(`SELECT status FROM top_caller_collection_runs WHERE id = ?`).get(runId) as { status: CollectionStatus } | undefined;
  return row?.status === 'cancelled';
};

export type RunCheckpointBatch = (database: DatabaseSync, collectionRunId: number) => Promise<{ targetsSubmitted: number; measured: number; noTradeInWindow: number }>;
/** One click drains the ENTIRE matured backlog, however large — this runs as a background job
 * already, so there's no request-timeout reason to stop early, and the run stays cancellable
 * via Stop the whole time (checked before and after every batch). This number exists purely as
 * a runaway guard against a logic bug looping forever against Dune, not as a routine per-click
 * ceiling — at 300 targets/batch it covers 1.5M targets, far beyond any real backlog this
 * feature has produced. (Previously 15, sized for a much smaller feature's typical volume and
 * never re-sized for Top Callers' actual scale — a real backlog of ~50k targets needed over
 * 150 clicks at that cap, which was the entire point of raising this.) */
export const MAX_CHECKPOINT_BATCHES_PER_RUN = 5000;

export type CollectionOptions = {
  chain?: string; limit?: number; fetchKolTrades?: FetchKolTrades; fetchWalletActivity?: FetchWalletActivity;
  archive?: boolean; runCheckpointBatch?: RunCheckpointBatch;
};

const rateLimitMessage = (message: string): string => `GMGN rate limit; paused safely. ${message}`;

const runCalloutLoop = async (
  database: DatabaseSync, runId: number, options: CollectionOptions, startIndex = 0,
): Promise<{ runId: number; status: CollectionStatus }> => {
  const chain = options.chain ?? 'sol';
  const limit = options.limit ?? 100;
  const fetchWalletActivity = options.fetchWalletActivity ?? runGmgnWalletActivity;
  const shouldArchive = options.archive ?? true;
  const snapshotRow = database.prepare(`SELECT wallet_snapshot_json AS walletSnapshot, wallet_done AS walletDone, retry_count AS retryCount FROM top_caller_collection_runs WHERE id = ?`).get(runId) as { walletSnapshot: string | null; walletDone: number | null; retryCount: number } | undefined;
  const tracked = snapshotRow?.walletSnapshot ? JSON.parse(snapshotRow.walletSnapshot) as string[] : listTrackedCallerKeys(database);
  const effectiveStart = Math.max(startIndex, snapshotRow?.walletDone ?? 0);
  database.prepare(`UPDATE top_caller_collection_runs SET wallet_total = ?, wallet_done = ?, wallet_snapshot_json = ? WHERE id = ?`).run(tracked.length, effectiveStart, JSON.stringify(tracked), runId);
  let totalInserted = 0;
  let totalSkipped = 0;
  const gapWallets: string[] = [];
  for (let index = effectiveStart; index < tracked.length; index += 1) {
    if (isCollectionRunCancelled(database, runId)) { logCollectionTerminal(database, runId, 'cancelled'); return { runId, status: 'cancelled' }; }
    const callerKey = tracked[index]!;
    try {
      const latestStored = database.prepare(`SELECT MAX(call_timestamp) AS latestTimestamp FROM top_caller_callouts WHERE caller_key = ?`).get(callerKey) as { latestTimestamp: number | null } | undefined;
      const result = await fetchWalletActivity(chain, callerKey, limit, latestStored?.latestTimestamp ?? null);
      const capturedAt = new Date().toISOString();
      const { calloutsInserted, calloutsSkipped } = insertCallouts(database, result.rows, capturedAt);
      totalInserted += calloutsInserted; totalSkipped += calloutsSkipped;
      if (result.hasGap) gapWallets.push(callerKey);
      if (shouldArchive) archiveKolResponse(result.rawStdout, capturedAt, chain, limit, result.rows.length, `gmgn-wallet-activity-${callerKey}.json`);
      database.prepare(`UPDATE top_caller_collection_runs SET wallet_done = ?, requests_made = requests_made + 1 WHERE id = ?`).run(index + 1, runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const resetAt = rateLimitResetFromMessage(message);
      if (resetAt) {
        const retryCount = snapshotRow?.retryCount ?? 0;
        const nextStatus: CollectionStatus = 'paused';
        database.prepare(`UPDATE top_caller_collection_runs SET status = ?, next_retry_at = ?, rate_limited_until = ?, error = ?, completed_at = NULL WHERE id = ?`).run(nextStatus, retryCount === 0 ? resetAt : null, resetAt, rateLimitMessage(message), runId);
        logCollectionTerminal(database, runId, 'paused');
        if (retryCount === 0) scheduleCalloutRetry(database, runId, resetAt, options);
        return { runId, status: 'paused' };
      }
      database.prepare(`UPDATE top_caller_collection_runs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?`).run(new Date().toISOString(), message, runId);
      logCollectionTerminal(database, runId, 'failed');
      return { runId, status: 'failed' };
    }
  }
  const message = `Fetched ${tracked.length} tracked caller${tracked.length === 1 ? '' : 's'}: ${totalInserted} new callout${totalInserted === 1 ? '' : 's'}, ${totalSkipped} already known.${gapWallets.length ? ` ${gapWallets.length} wallet histor${gapWallets.length === 1 ? 'y has' : 'ies have'} older pages still pending: ${gapWallets.join(', ')}.` : ''}`;
  database.prepare(`UPDATE top_caller_collection_runs SET status = 'completed', completed_at = ?, next_retry_at = NULL, error = ? WHERE id = ?`).run(new Date().toISOString(), message, runId);
  logCollectionTerminal(database, runId, 'completed');
  return { runId, status: 'completed' };
};

const scheduleCalloutRetry = (database: DatabaseSync, runId: number, retryAt: string, options: CollectionOptions): void => {
  const delay = Math.max(0, Date.parse(retryAt) - Date.now());
  const old = retryTimers.get(runId); if (old) clearTimeout(old);
  const timer = setTimeout(() => {
    retryTimers.delete(runId);
    const row = database.prepare(`SELECT status, wallet_done AS walletDone, retry_count AS retryCount, wallet_snapshot_json AS walletSnapshot FROM top_caller_collection_runs WHERE id = ?`).get(runId) as { status: CollectionStatus; walletDone: number | null; retryCount: number; walletSnapshot: string | null } | undefined;
    if (!row || row.status !== 'paused' || row.retryCount !== 0) return;
    database.prepare(`UPDATE top_caller_collection_runs SET status = 'running', retry_count = 1, next_retry_at = NULL, rate_limited_until = NULL WHERE id = ?`).run(runId);
    void runCalloutLoop(database, runId, options, row.walletDone ?? 0);
  }, delay);
  retryTimers.set(runId, timer);
};

export const resumeCollectionRun = async (database: DatabaseSync, runId?: number, options: CollectionOptions = {}): Promise<{ runId: number; status: CollectionStatus }> => {
  const row = (runId
    ? database.prepare(`SELECT id, status, wallet_done AS walletDone FROM top_caller_collection_runs WHERE id = ?`).get(runId)
    : database.prepare(`SELECT id, status, wallet_done AS walletDone FROM top_caller_collection_runs WHERE status = 'paused' ORDER BY id DESC LIMIT 1`).get()) as { id: number; status: CollectionStatus; walletDone: number | null } | undefined;
  if (!row || row.status !== 'paused') throw new Error('No paused Top Caller collection run exists.');
  database.prepare(`UPDATE top_caller_collection_runs SET status = 'running', retry_count = 0, next_retry_at = NULL, rate_limited_until = NULL, completed_at = NULL WHERE id = ?`).run(row.id);
  return runCalloutLoop(database, row.id, options, row.walletDone ?? 0);
};

/** Re-arm only future cooldown timers after a process restart. An already-expired pause stays
 * paused and requires an explicit Resume, avoiding an unknown late retry. */
export const rearmPausedCollectionRuns = (database: DatabaseSync): void => {
  const rows = database.prepare(`SELECT id, next_retry_at AS nextRetryAt FROM top_caller_collection_runs WHERE kind = 'callouts' AND status = 'paused' AND retry_count = 0 AND next_retry_at IS NOT NULL`).all() as unknown as Array<{ id: number; nextRetryAt: string }>;
  for (const row of rows) if (Date.parse(row.nextRetryAt) > Date.now()) scheduleCalloutRetry(database, row.id, row.nextRetryAt, {});
};

/** Mirrors reconcileStaleFetchRuns in fetch.ts for the identical failure mode: a run only ever
 * executes inside the process that started it, so anything still 'running' at process startup
 * was orphaned — either by a restart, or by a genuinely hung network call (no timeout existed
 * on the Dune HTTP calls until this was added; a real checkpoints run sat 'running' with zero
 * progress for 3.5+ minutes before this reconciliation and the underlying timeout fix landed
 * together). Without this, an orphaned 'running' row blocks hasActiveCollectionRun forever,
 * silently preventing every future collection of that kind from ever starting again. */
export const reconcileOrphanedCollectionRuns = (database: DatabaseSync): number => {
  const result = database.prepare(
    `UPDATE top_caller_collection_runs
     SET status = 'failed', completed_at = ?,
         error = 'Interrupted: the server restarted (or this run hung with no request timeout) while it was running. Already-processed data was kept.'
     WHERE status = 'running'`,
  ).run(new Date().toISOString());
  return Number(result.changes);
};

/**
 * 'leaderboard' runs a real `track kol` capture. 'callouts' runs the official per-wallet
 * `portfolio activity` history endpoint for the callers currently tracked in this app. The
 * latter is the same history GMGN shows on a wallet detail page, walked back to the stored
 * watermark (one day on a first capture, older when the database already has older history).
 * 'checkpoints' runs a real Dune-based measurement batch (see
 * src/copytrade/topCallerCheckpoints.ts) against whatever tracked callers' callouts have
 * matured checkpoints pending — the actual network calls (`fetchKolTrades`, `runCheckpointBatch`)
 * are overridable purely so tests can exercise this with fixture data and no filesystem/network
 * access; the default path (used by the real API route) always makes the real calls.
 */
export const startCollectionRun = async (
  database: DatabaseSync, kind: CollectionKind,
  options: { chain?: string; limit?: number; fetchKolTrades?: FetchKolTrades; fetchWalletActivity?: FetchWalletActivity; archive?: boolean; runCheckpointBatch?: RunCheckpointBatch } = {},
): Promise<{ runId: number; status: CollectionStatus }> => {
  if (hasActiveCollectionRun(database, kind)) {
    throw new Error(`A collection run of kind "${kind}" is already in progress.`);
  }
  const chain = options.chain ?? 'sol';
  const limit = options.limit ?? 100;
  const fetchKolTrades = options.fetchKolTrades ?? runGmgnTrackKol;
  const fetchWalletActivity = options.fetchWalletActivity
    ?? (options.fetchKolTrades
      ? async (requestedChain: string, _wallet: string, requestedLimit: number) => ({ ...(await fetchKolTrades(requestedChain, requestedLimit)), hasGap: false })
      : runGmgnWalletActivity);
  const shouldArchive = options.archive ?? true;
  const runCheckpoints = options.runCheckpointBatch ?? defaultRunCheckpointBatch;

  const startedAt = new Date().toISOString();
  const runId = Number(database.prepare(
    `INSERT INTO top_caller_collection_runs (kind, started_at, status, requests_made) VALUES (?, ?, 'running', 0)`,
  ).run(kind, startedAt).lastInsertRowid);

  if (kind === 'checkpoints') {
    try {
      // A real backlog can be tens of thousands of targets — 300/batch means hundreds of
      // batches to fully drain it. This already runs as a background job (the HTTP response
      // returned the moment the run was created), so there is no request-timeout reason to stop
      // early; the batch count only exists as a true runaway guard against a logic bug that
      // would otherwise hammer Dune forever, not as a routine per-click ceiling. wallet_total/
      // wallet_done are reused here (same fields the callouts loop uses for "N of M wallets") to
      // report "N of M targets processed" with zero new schema and the UI's existing progress
      // bar working unmodified.
      const initialPending = collectPendingCheckpointTargets(database).length;
      database.prepare(`UPDATE top_caller_collection_runs SET wallet_total = ?, wallet_done = 0 WHERE id = ?`).run(initialPending, runId);

      let targetsSubmitted = 0;
      let measured = 0;
      let noTradeInWindow = 0;
      let batches = 0;
      while (batches < MAX_CHECKPOINT_BATCHES_PER_RUN) {
        if (isCollectionRunCancelled(database, runId)) { logCollectionTerminal(database, runId, 'cancelled'); return { runId, status: 'cancelled' }; }
        const batch = await runCheckpoints(database, runId);
        batches += 1;
        targetsSubmitted += batch.targetsSubmitted;
        measured += batch.measured;
        noTradeInWindow += batch.noTradeInWindow;
        database.prepare(`UPDATE top_caller_collection_runs SET requests_made = ?, wallet_done = ? WHERE id = ?`).run(batches, targetsSubmitted, runId);
        // A short batch means the durable queue is genuinely exhausted — done, not paused.
        if (batch.targetsSubmitted < MAX_CHECKPOINT_TARGETS_PER_RUN) break;
        if (isCollectionRunCancelled(database, runId)) { logCollectionTerminal(database, runId, 'cancelled'); return { runId, status: 'cancelled' }; }
      }
      if (isCollectionRunCancelled(database, runId)) { logCollectionTerminal(database, runId, 'cancelled'); return { runId, status: 'cancelled' }; }
      const cappedByRunawayGuard = batches >= MAX_CHECKPOINT_BATCHES_PER_RUN;
      const stillPending = collectPendingCheckpointTargets(database).length;
      const message = targetsSubmitted === 0
        ? 'No matured checkpoints pending — nothing to measure yet.'
        : `Measured ${measured} checkpoint${measured === 1 ? '' : 's'} across ${batches} Dune batch${batches === 1 ? '' : 'es'} (${targetsSubmitted} of ${initialPending} pending at the start), ${noTradeInWindow} had no qualifying Dune trade in the lookback window.${
            cappedByRunawayGuard
              ? ` Stopped at the ${MAX_CHECKPOINT_BATCHES_PER_RUN}-batch runaway guard${stillPending > 0 ? ` with ${stillPending} still pending — click again to continue.` : '.'}`
              : stillPending > 0 ? ` ${stillPending} newly-matured since this run started remain for next time.` : ' The backlog is fully drained.'
          }`;
      database.prepare(
        `UPDATE top_caller_collection_runs SET status = 'completed', completed_at = ?, requests_made = ?, error = ? WHERE id = ?`,
      ).run(new Date().toISOString(), batches, message, runId);
      logCollectionTerminal(database, runId, 'completed');
      return { runId, status: 'completed' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      database.prepare(
        `UPDATE top_caller_collection_runs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?`,
      ).run(new Date().toISOString(), message, runId);
      logCollectionTerminal(database, runId, 'failed');
      return { runId, status: 'failed' };
    }
  }

  try {
    if (kind === 'callouts') {
      const tracked = listTrackedCallerKeys(database);
      // Keep the injectable legacy path useful for unit tests and offline fixtures. The real
      // route has no injected fetchKolTrades and therefore always requires tracked callers.
      if (tracked.length === 0 && options.fetchKolTrades) {
        const result = await fetchKolTrades(chain, limit);
        const capturedAt = new Date().toISOString();
        const { archivePath, archiveSha256 } = shouldArchive
          ? archiveKolResponse(result.rawStdout, capturedAt, chain, limit, result.rows.length)
          : { archivePath: null, archiveSha256: null };
        applyKolCapture(database, runId, result.rows, chain, limit, capturedAt, result.rawStdout, archivePath, archiveSha256);
        database.prepare(
          `UPDATE top_caller_collection_runs SET status = 'completed', completed_at = ?, requests_made = 1 WHERE id = ?`,
        ).run(new Date().toISOString(), runId);
        logCollectionTerminal(database, runId, 'completed');
        return { runId, status: 'completed' };
      }
      // The loop freezes the tracked-wallet list and can pause/resume from wallet_done without
      // re-requesting wallets already completed in this run.
      return runCalloutLoop(database, runId, { ...options, chain, limit, fetchWalletActivity, archive: shouldArchive }, 0);
    }

    const result = await fetchKolTrades(chain, limit);
    const capturedAt = new Date().toISOString();
    const { archivePath, archiveSha256 } = shouldArchive
      ? archiveKolResponse(result.rawStdout, capturedAt, chain, limit, result.rows.length)
      : { archivePath: null, archiveSha256: null };
    applyKolCapture(database, runId, result.rows, chain, limit, capturedAt, result.rawStdout, archivePath, archiveSha256);
    // A stop may have arrived while the HTTP request was in flight. Preserve the completed
    // response and archive, but do not report the run as completed or start another unit.
    if (isCollectionRunCancelled(database, runId)) { logCollectionTerminal(database, runId, 'cancelled'); return { runId, status: 'cancelled' }; }
    database.prepare(
      `UPDATE top_caller_collection_runs SET status = 'completed', completed_at = ?, requests_made = 1 WHERE id = ?`,
    ).run(new Date().toISOString(), runId);
    logCollectionTerminal(database, runId, 'completed');
    return { runId, status: 'completed' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const rateLimitedUntil = rateLimitResetFromMessage(message);
    database.prepare(
      `UPDATE top_caller_collection_runs SET status = ?, completed_at = ?, rate_limited_until = ?, error = ? WHERE id = ?`,
    ).run(rateLimitedUntil ? 'rate_limited' : 'failed', new Date().toISOString(), rateLimitedUntil, message, runId);
    logCollectionTerminal(database, runId, rateLimitedUntil ? 'rate_limited' : 'failed');
    return { runId, status: rateLimitedUntil ? 'rate_limited' : 'failed' };
  }
};

export const readCollectionRunState = (database: DatabaseSync, kind: CollectionKind): CollectionRunState => {
  const row = database.prepare(
    `SELECT id, status, requests_made AS requestsMade, wallet_total AS walletTotal, wallet_done AS walletDone,
            rate_limited_until AS rateLimitedUntil, retry_count AS retryCount, next_retry_at AS nextRetryAt, error
     FROM top_caller_collection_runs WHERE kind = ? ORDER BY id DESC LIMIT 1`,
  ).get(kind) as { id: number; status: CollectionStatus; requestsMade: number; walletTotal: number | null; walletDone: number | null; rateLimitedUntil: string | null; retryCount: number; nextRetryAt: string | null; error: string | null } | undefined;

  if (!row) return { running: false, runId: null, status: 'idle', requestsMade: 0, walletTotal: null, walletDone: null, rateLimitedUntil: null, retryCount: 0, nextRetryAt: null, message: 'No collection has run yet.' };

  // Older app processes recorded a 429 as `failed` without filling rate_limited_until. Infer the
  // cooldown on read so a reload immediately after upgrading still protects the user.
  const inferredRateLimitedUntil = row.rateLimitedUntil ?? (row.status === 'failed' && row.error ? rateLimitResetFromMessage(row.error) : null);
  const effectiveStatus: CollectionStatus = inferredRateLimitedUntil && row.status === 'failed' ? 'rate_limited' : row.status;

  return {
    running: effectiveStatus === 'running',
    runId: row.id,
    status: effectiveStatus,
    requestsMade: row.requestsMade,
    walletTotal: row.walletTotal,
    walletDone: row.walletDone,
    rateLimitedUntil: inferredRateLimitedUntil,
    retryCount: row.retryCount ?? 0,
    nextRetryAt: row.nextRetryAt ?? null,
    message: row.error ?? (row.status === 'completed' ? 'Collection completed.' : ''),
  };
};

// ---------------------------------------------------------------------------
// Evaluation — pure computation over whatever callouts/outcomes already exist, works on zero rows
// ---------------------------------------------------------------------------

export const DEFAULT_EVALUATION_CHECKPOINT = '24h';

/** Same reliability convention already used twice elsewhere in this project
 *  (MIN_RELIABLE_SAMPLE in src/db/patterns.ts, MIN_LIQUIDITY_BAND_SAMPLE in copySimulation.ts)
 *  — reused rather than inventing a fourth number. */
export const MIN_RELIABLE_CALLER_SAMPLE = 10;
/** Mirrors patterns.ts's MIN_CAPTURE_DATES — a caller measured entirely on one day's calls isn't
 *  a track record yet, regardless of call count. */
export const MIN_CALLER_CAPTURE_DATES = 3;
export const MIN_CALLER_MEASURED_CALLS = 30;
export const MIN_CALLER_COVERAGE_PERCENT = 70;

export type CallerEvaluationRow = {
  callerKey: string;
  callCount: number;
  measuredCallCount: number;
  waitingCallCount: number;
  unavailableCallCount: number;
  coverageRatePercent: number | null;
  coverageSufficient: boolean;
  winRatePercent: number | null;
  medianReturnPercent: number | null;
  reliable: boolean;
};

export type CallerEvaluationReport = {
  checkpoint: string;
  rows: CallerEvaluationRow[];
};

/** Every distinct reason "reliable" can be false, so the UI never has to collapse "still waiting
 *  on Dune" and "Dune looked and found nothing" and "not enough different days yet" into one
 *  unlabeled "not reliable." More than one can apply at once (e.g. still waiting AND too few
 *  dates); an empty array means genuinely reliable. */
export type CallerReliabilityReason = 'awaiting_dune_fetch' | 'insufficient_coverage' | 'awaiting_more_capture_dates' | 'no_callouts';

const computeCallerCheckpointStats = (
  database: DatabaseSync, callerKey: string, checkpoint: string,
  callouts: Array<{ id: number; callTimestamp: number }>,
): Omit<CallerEvaluationRow, 'callerKey'> & { reasons: CallerReliabilityReason[] } => {
  if (callouts.length === 0) {
    return { callCount: 0, measuredCallCount: 0, waitingCallCount: 0, unavailableCallCount: 0, coverageRatePercent: null, coverageSufficient: false, winRatePercent: null, medianReturnPercent: null, reliable: false, reasons: ['no_callouts'] };
  }

  const placeholders = callouts.map(() => '?').join(',');
  const outcomeRows = database.prepare(
    `SELECT status, measured_return_pct AS measuredReturnPct FROM top_caller_outcomes
     WHERE checkpoint = ? AND callout_id IN (${placeholders})`,
  ).all(checkpoint, ...callouts.map((c) => c.id)) as unknown as Array<{ status: string; measuredReturnPct: number | null }>;

  const returns = outcomeRows.filter((o) => o.status === 'measured').map((o) => o.measuredReturnPct).filter((v): v is number => v !== null);
  const unavailableCallCount = outcomeRows.filter((outcome) => outcome.status === 'no_trade_in_window').length;
  const waitingCallCount = Math.max(0, callouts.length - returns.length - unavailableCallCount);
  const coverageRatePercent = callouts.length ? round((returns.length / callouts.length) * 100, 1) : null;
  const coverageSufficient = returns.length >= MIN_CALLER_MEASURED_CALLS && coverageRatePercent !== null && coverageRatePercent >= MIN_CALLER_COVERAGE_PERCENT;
  const wins = returns.filter((r) => r > 0).length;
  const distinctDates = new Set(callouts.map((c) => new Date(c.callTimestamp * 1000).toISOString().slice(0, 10))).size;
  const reliable = coverageSufficient && returns.length >= MIN_RELIABLE_CALLER_SAMPLE && distinctDates >= MIN_CALLER_CAPTURE_DATES;

  const reasons: CallerReliabilityReason[] = [];
  if (!reliable) {
    // "Still waiting on Dune" and "Dune looked and found nothing" are different failure modes
    // with different fixes — more fetching resolves the first, never the second. A checkpoint
    // can be fully processed (waitingCallCount === 0) and still fail coverage forever if too
    // many calls genuinely had no qualifying Dune trade; that's real, not a collection gap.
    if (waitingCallCount > 0) reasons.push('awaiting_dune_fetch');
    if (!coverageSufficient && waitingCallCount === 0) reasons.push('insufficient_coverage');
    if (distinctDates < MIN_CALLER_CAPTURE_DATES) reasons.push('awaiting_more_capture_dates');
  }

  return {
    callCount: callouts.length,
    measuredCallCount: returns.length,
    waitingCallCount,
    unavailableCallCount,
    coverageRatePercent,
    coverageSufficient,
    winRatePercent: returns.length ? round((wins / returns.length) * 100, 1) : null,
    medianReturnPercent: median(returns),
    reliable,
    reasons,
  };
};

export const computeCallerEvaluationReport = (
  database: DatabaseSync, checkpoint = DEFAULT_EVALUATION_CHECKPOINT,
): CallerEvaluationReport => {
  const callerKeys = listTrackedCallerKeys(database);

  const rows: CallerEvaluationRow[] = callerKeys.map((callerKey) => {
    const callouts = database.prepare(
      `SELECT id, call_timestamp AS callTimestamp FROM top_caller_callouts WHERE caller_key = ?`,
    ).all(callerKey) as unknown as Array<{ id: number; callTimestamp: number }>;
    const { reasons: _reasons, ...stats } = computeCallerCheckpointStats(database, callerKey, checkpoint, callouts);
    return { callerKey, ...stats };
  });

  return { checkpoint, rows };
};

export type CallerCheckpointBreakdownRow = Omit<CallerEvaluationRow, 'callerKey'> & { checkpoint: string; reasons: CallerReliabilityReason[] };

/** All checkpoints for one caller, not just the one DEFAULT_EVALUATION_CHECKPOINT the summary
 *  table uses — "reliable" is a per-checkpoint fact, not a per-caller one, since the exact same
 *  wallet can be fully measured at +1h while still 80% "awaiting Dune fetch" at +24h. */
export const computeCallerCheckpointBreakdown = (
  database: DatabaseSync, callerKey: string,
): CallerCheckpointBreakdownRow[] => {
  const callouts = database.prepare(
    `SELECT id, call_timestamp AS callTimestamp FROM top_caller_callouts WHERE caller_key = ?`,
  ).all(callerKey) as unknown as Array<{ id: number; callTimestamp: number }>;
  return CHECKPOINT_ORDER.map((checkpoint) => ({
    checkpoint, ...computeCallerCheckpointStats(database, callerKey, checkpoint, callouts),
  }));
};

// ---------------------------------------------------------------------------
// Caller detail
// ---------------------------------------------------------------------------

const CHECKPOINT_ORDER = ['5m', '10m', '15m', '30m', '45m', '1h', '6h', '24h', '3d', '7d'] as const;

export type CallerDetailOutcome = { checkpoint: string; status: string; measuredReturnPct: number | null; gapSeconds: number | null };
export type CallerDetailCallout = {
  id: number; tokenAddress: string; tokenSymbol: string | null; callTimestamp: string;
  callPriceUsd: string | null; message: string | null; reportedMultiplier: string | null;
  outcomes: CallerDetailOutcome[];
};
export type CallerDetail = { callerKey: string; callouts: CallerDetailCallout[] };

export const readCallerDetail = (database: DatabaseSync, callerKey: string): CallerDetail => {
  const callouts = database.prepare(
    `SELECT id, token_address AS tokenAddress, token_symbol AS tokenSymbol, call_timestamp AS callTimestamp,
            call_price_usd AS callPriceUsd, message, reported_multiplier AS reportedMultiplier
     FROM top_caller_callouts WHERE caller_key = ? ORDER BY call_timestamp DESC`,
  ).all(callerKey) as unknown as Array<{
    id: number; tokenAddress: string; tokenSymbol: string | null; callTimestamp: number;
    callPriceUsd: string | null; message: string | null; reportedMultiplier: string | null;
  }>;

  return {
    callerKey,
    callouts: callouts.map((callout) => {
      const outcomeRows = database.prepare(
        `SELECT checkpoint, status, measured_return_pct AS measuredReturnPct, gap_seconds AS gapSeconds
         FROM top_caller_outcomes WHERE callout_id = ?`,
      ).all(callout.id) as unknown as CallerDetailOutcome[];
      const byCheckpoint = new Map(outcomeRows.map((row) => [row.checkpoint, row]));
      const outcomes = CHECKPOINT_ORDER
        .map((checkpoint) => byCheckpoint.get(checkpoint))
        .filter((row): row is CallerDetailOutcome => row !== undefined);

      return {
        id: callout.id, tokenAddress: callout.tokenAddress, tokenSymbol: callout.tokenSymbol,
        callTimestamp: new Date(callout.callTimestamp * 1000).toISOString(),
        callPriceUsd: callout.callPriceUsd, message: callout.message, reportedMultiplier: callout.reportedMultiplier,
        outcomes,
      };
    }),
  };
};
