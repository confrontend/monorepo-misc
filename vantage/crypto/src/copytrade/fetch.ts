import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { DAILY_TRADE_INSERT_CAP, MAX_REQUESTS_PER_WALLET } from './constants.js';
import { estimateRemainingSeconds, recordFetchRunEstimate } from './estimate.js';
import { listRosterWallets, syncCopyTradeRoster } from './roster.js';
import { GMGN_REQUEST_SPACING_MS, waitForGmgnRequest } from '../gmgn/rateLimit.js';

// Re-export the shared gate for other server-side GMGN collectors. Keeping one exported symbol
// prevents a collector from accidentally creating a second, unsynchronized queue.
export { waitForGmgnRequest } from '../gmgn/rateLimit.js';

/**
 * Runs the CLI with a timeout we enforce ourselves rather than relying on execFile's `timeout`
 * option. A first live run stalled indefinitely on a request even though `timeout: 30_000` was
 * set: execFile only settles once the child has exited *and* its stdio streams have closed, so
 * a child that exits while something still holds its stdout pipe open leaves the promise
 * pending forever — and an unresolved promise inside the fetch loop freezes the whole run with
 * no error and no way to recover. This settles on our own timer regardless of pipe state, and
 * kills the child on the way out so nothing is left behind.
 */
const execFileWithTimeout = (
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; maxBuffer: number; windowsHide: boolean },
  timeoutMs: number,
): Promise<string> => new Promise((resolve, reject) => {
  let settled = false;
  const child = execFile(file, args, options, (error, stdout) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error); else resolve(stdout);
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    try { child.kill(); } catch { /* already gone */ }
    reject(new Error(`GMGN CLI did not respond within ${Math.round(timeoutMs / 1000)}s.`));
  }, timeoutMs);
  timer.unref?.();
});

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

/**
 * All wallet stats/activity requests use the universal GMGN gate. The same gate is also used by
 * Top Caller leaderboard/history, signal capture, and probes, so one flow cannot consume the
 * API-key budget behind another flow's back.
 */
const PAGE_SIZE = 50;
const CLI_TIMEOUT_MS = 30_000;

/**
 * Per-wallet request ceiling: 200 requests ≈ 10,000 trades ≈ 40 seconds.
 *
 * Sized from what the statistics actually need, not from what the API can deliver. Median and
 * win rate are a quantile and a proportion; both are well determined by roughly 2,000
 * completed sells, and telling a 47% win rate from 50% needs about that. Beyond ~10,000 rows
 * you pay fifty times the requests to move the third decimal place.
 *
 * The previous ceiling of 2,000 requests allowed ~7 minutes on a single wallet, so one
 * high-volume trader could consume an eleven-hour run on its own. A wallet that hits this cap
 * is recorded as truncated, and the statistics that truncation biases are suppressed rather
 * than shown — see evaluate.ts.
 */

/**
 * Run ids asked to stop. In-memory on purpose: a run only ever executes inside the process
 * that started it, so a cancellation is only meaningful to that process, and a restart already
 * terminates the run by other means (see reconcileStaleFetchRuns).
 */
const cancelledRuns = new Set<number>();

export type StopReason =
  | 'window_covered' | 'up_to_date' | 'request_cap' | 'no_more_data' | 'cursor_stalled' | 'cancelled';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Kept exported for callers/tests that need to explain the enforced interval. */
export { GMGN_REQUEST_SPACING_MS };

export type ActivityPage = { activities: Record<string, unknown>[]; next: string | null };

/** The CLI unwraps the API envelope's `data`, but tolerate both shapes rather than assume. */
export const parseActivityPage = (stdout: string): ActivityPage => {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new Error('GMGN CLI returned output that is not JSON.'); }
  const root = (parsed ?? {}) as Record<string, unknown>;
  const container = (root.data && typeof root.data === 'object' && !Array.isArray(root.data)
    ? root.data
    : root) as Record<string, unknown>;
  const activities = Array.isArray(container.activities)
    ? container.activities.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    : [];
  const next = typeof container.next === 'string' && container.next.length > 0 ? container.next : null;
  return { activities, next };
};

export type RateLimitInfo = { rateLimited: true; resetAt: string | null };

/**
 * Detects a 429 from whatever the CLI surfaced and extracts `reset_at` when present.
 * Returns null for any other failure so genuine errors are never silently treated as
 * throttling (which would make the run look recoverable when it is not).
 */
export const detectRateLimit = (message: string): RateLimitInfo | null => {
  if (!/\b429\b|RATE_LIMIT/i.test(message)) return null;
  const match = message.match(/"reset_at"\s*:\s*(\d+)/);
  const resetAt = match ? new Date(Number(match[1]) * 1000).toISOString() : null;
  return { rateLimited: true, resetAt };
};

const readApiKey = (): string => {
  const secret = existsSync(keyPath) ? readFileSync(keyPath, 'utf8').trim() : '';
  if (!secret) throw new Error('GMGN API key is missing. Add it to .secrets/gmgn/gmgn-api-key.txt.');
  return secret;
};

/**
 * One page of a wallet's trade history via the official read-only endpoint
 * (GET /v1/user/wallet_activity). Requires GMGN_API_KEY only — GMGN_PRIVATE_KEY is the
 * trade-submitting credential and is deliberately never read, passed, or required here, so
 * this path is structurally incapable of moving funds.
 */
export const fetchActivityPage = async (
  options: { wallet: string; chain: string; cursor: string | null; limit?: number; apiKey: string },
): Promise<ActivityPage> => {
  return (await fetchActivityPageRaw(options)).page;
};

/** Same official wallet-activity request, retaining the exact CLI response for append-only
 * provenance consumers such as Top Callers. Existing callers should use fetchActivityPage;
 * this companion avoids making a second request just to preserve raw source JSON. */
export const fetchActivityPageRaw = async (
  options: { wallet: string; chain: string; cursor: string | null; limit?: number; apiKey: string },
): Promise<{ page: ActivityPage; rawStdout: string }> => {
  await waitForGmgnRequest();
  const script = path.join(projectRoot, 'node_modules', 'gmgn-cli', 'dist', 'index.js');
  if (!existsSync(script)) throw new Error('Project-local gmgn-cli is unavailable. Run npm install first.');
  const args = [
    script, 'portfolio', 'activity',
    '--chain', options.chain,
    '--wallet', options.wallet,
    '--type', 'buy', '--type', 'sell',
    '--limit', String(options.limit ?? PAGE_SIZE),
    '--raw',
  ];
  if (options.cursor) args.push('--cursor', options.cursor);
  const stdout = await execFileWithTimeout(process.execPath, args, {
    cwd: projectRoot,
    env: { ...process.env, GMGN_API_KEY: options.apiKey },
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  }, CLI_TIMEOUT_MS);
  return { page: parseActivityPage(stdout), rawStdout: stdout };
};

const asText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
};

/**
 * One call to the official portfolio stats endpoint (GET /v1/user/wallet_stats, weight 3) for
 * the context behind a risk flag: where the wallet was funded from, how old it is, how long it
 * holds, and how its per-token results are spread.
 *
 * Verified live that this endpoint does NOT return GMGN's "Phishing check" risk block — that
 * lives only on a browser endpoint. So this is supporting context, not the reason itself; the
 * quantitative reason is computed from our own stored trades in evaluate.ts.
 */
export const fetchAndStoreWalletStats = async (
  database: DatabaseSync,
  options: { wallet: string; chain: string; period: '7d' | '30d'; apiKey: string },
): Promise<void> => {
  await waitForGmgnRequest();
  const script = path.join(projectRoot, 'node_modules', 'gmgn-cli', 'dist', 'index.js');
  const stdout = await execFileWithTimeout(process.execPath, [
    script, 'portfolio', 'stats', '--chain', options.chain, '--wallet', options.wallet,
    '--period', options.period, '--raw',
  ], {
    cwd: projectRoot,
    env: { ...process.env, GMGN_API_KEY: options.apiKey },
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  }, CLI_TIMEOUT_MS);

  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return; }
  const root = (parsed ?? {}) as Record<string, unknown>;
  const unwrapped = root.data ?? root;
  // The CLI supports batching, so a single-wallet response may still arrive as a one-item array.
  const stats = (Array.isArray(unwrapped) ? unwrapped[0] : unwrapped) as Record<string, unknown> | undefined;
  if (!stats || typeof stats !== 'object') return;

  const common = (stats.common ?? {}) as Record<string, unknown>;
  const pnlStat = (stats.pnl_stat ?? {}) as Record<string, unknown>;
  const createdAt = typeof common.created_at === 'number' && Number.isFinite(common.created_at)
    ? Math.trunc(common.created_at) : null;
  const tokenNum = typeof pnlStat.token_num === 'number' && Number.isFinite(pnlStat.token_num)
    ? Math.trunc(pnlStat.token_num) : null;

  database.prepare(
    `INSERT INTO copytrade_wallet_stats
       (wallet_address, chain, period, fetched_at, tags, fund_from_address, fund_amount,
        created_at_ts, avg_holding_period_seconds, winrate, token_num, raw_payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(wallet_address, chain, period) DO UPDATE SET
       fetched_at = excluded.fetched_at, tags = excluded.tags,
       fund_from_address = excluded.fund_from_address, fund_amount = excluded.fund_amount,
       created_at_ts = excluded.created_at_ts,
       avg_holding_period_seconds = excluded.avg_holding_period_seconds,
       winrate = excluded.winrate, token_num = excluded.token_num,
       raw_payload = excluded.raw_payload`,
  ).run(
    options.wallet, options.chain, options.period, new Date().toISOString(),
    Array.isArray(common.tags) ? JSON.stringify(common.tags) : null,
    asText(common.fund_from_address), asText(common.fund_amount), createdAt,
    asText(pnlStat.avg_holding_period), asText(pnlStat.winrate), tokenNum,
    JSON.stringify(stats),
  );
};

/**
 * `duplicates`, `malformed`, and `dailyCapped` are counted separately on purpose. A single
 * `skipped` total would conflate three different things: "we already had this row" (the
 * normal, healthy outcome of re-fetching an overlapping window), "this row could not be
 * parsed" (data loss — needs investigating), and "we chose not to store this one, this
 * calendar day already has enough" (an intentional sampling decision, not a problem). All
 * three look identical from the outside unless kept apart.
 */
export type StoredTrade = { inserted: number; duplicates: number; malformed: number; dailyCapped: number };

/** UTC calendar day a trade falls on, e.g. "2026-08-16" — the unit DAILY_TRADE_INSERT_CAP caps. */
const dayKeyFor = (timestampSeconds: number): string => new Date(timestampSeconds * 1000).toISOString().slice(0, 10);

/**
 * Per-wallet, per-run state for the daily sample cap. Owned by the caller (one instance per
 * wallet walk in runCopyTradeFetch) and threaded through every storeActivityPage call for that
 * wallet, so the count persists across pages within a run. Counts are seeded lazily from
 * copytrade_trades itself the first time a given day is seen — not tracked in a separate
 * table — so a resumed run picks up the true stored count for that day with no extra state to
 * keep in sync.
 */
export type DailyCapTracker = { limit: number; countsByDay: Map<string, number> };

export const createDailyCapTracker = (limit: number): DailyCapTracker => ({ limit, countsByDay: new Map() });

const seededDailyCount = (
  database: DatabaseSync, wallet: string, chain: string, dayKey: string,
): number => {
  const dayStartSeconds = Math.floor(Date.parse(`${dayKey}T00:00:00.000Z`) / 1000);
  const row = database.prepare(
    `SELECT COUNT(*) AS count FROM copytrade_trades
     WHERE wallet_address = ? AND chain = ? AND observed_timestamp >= ? AND observed_timestamp < ?`,
  ).get(wallet, chain, dayStartSeconds, dayStartSeconds + 86_400) as { count: number };
  return row.count;
};

/**
 * Persists one page. `dedup_key` includes token, event type, amount and timestamp alongside
 * tx_hash because a single Solana transaction can contain several DEX legs — keying on
 * tx_hash alone would silently discard real trades.
 */
export const storeActivityPage = (
  database: DatabaseSync,
  activities: Record<string, unknown>[],
  context: { chain: string; fetchedAt: string; dailyCap?: DailyCapTracker },
): StoredTrade => {
  const insert = database.prepare(
    `INSERT OR IGNORE INTO copytrade_trades
       (wallet_address, chain, tx_hash, event_type, token_address, token_symbol,
        observed_timestamp, token_amount, cost_usd, buy_cost_usd, price_usd,
        gas_usd, dex_usd, launchpad_platform, raw_payload, fetched_at, dedup_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const existsCheck = context.dailyCap
    ? database.prepare(`SELECT 1 FROM copytrade_trades WHERE dedup_key = ?`) : null;
  let inserted = 0;
  let duplicates = 0;
  let malformed = 0;
  let dailyCapped = 0;
  for (const activity of activities) {
    const wallet = asText(activity.wallet);
    const txHash = asText(activity.tx_hash);
    const eventType = asText(activity.event_type);
    const token = (activity.token ?? {}) as Record<string, unknown>;
    const tokenAddress = asText(token.address);
    const timestamp = typeof activity.timestamp === 'number' && Number.isFinite(activity.timestamp)
      ? Math.trunc(activity.timestamp) : null;
    // A row missing any identity field cannot be deduplicated or evaluated. Skip it rather
    // than inserting a row that would silently corrupt later counts.
    if (!wallet || !txHash || !eventType || !tokenAddress || timestamp === null) { malformed += 1; continue; }

    const tokenAmount = asText(activity.token_amount);
    const dedupKey = [wallet, txHash, tokenAddress, eventType, tokenAmount ?? '', String(timestamp)].join('|');

    if (context.dailyCap) {
      const dayKey = dayKeyFor(timestamp);
      let count = context.dailyCap.countsByDay.get(dayKey);
      if (count === undefined) {
        count = seededDailyCount(database, wallet, context.chain, dayKey);
        context.dailyCap.countsByDay.set(dayKey, count);
      }
      // The cap only turns away trades that would otherwise be genuinely new. A trade this
      // page already re-confirms (already stored, re-fetched inside known coverage) must
      // still count as a duplicate, not a capped one — otherwise every re-fetch of an
      // already-dense day gets reported as sacrificing new data it never actually saw.
      if (count >= context.dailyCap.limit) {
        if (!existsCheck?.get(dedupKey)) { dailyCapped += 1; continue; }
        duplicates += 1;
        continue;
      }
    }

    const result = insert.run(
      wallet, context.chain, txHash, eventType, tokenAddress, asText(token.symbol),
      timestamp, tokenAmount, asText(activity.cost_usd), asText(activity.buy_cost_usd),
      asText(activity.price_usd), asText(activity.gas_usd), asText(activity.dex_usd),
      asText(activity.launchpad_platform), JSON.stringify(activity), context.fetchedAt, dedupKey,
    );
    if (result.changes > 0) {
      inserted += 1;
      if (context.dailyCap) {
        const dayKey = dayKeyFor(timestamp);
        context.dailyCap.countsByDay.set(dayKey, (context.dailyCap.countsByDay.get(dayKey) ?? 0) + 1);
      }
    } else duplicates += 1;
  }
  return { inserted, duplicates, malformed, dailyCapped };
};

export type FetchRunState = {
  running: boolean;
  runId: number | null;
  walletDone: number;
  walletTotal: number;
  tradesFetched: number;
  tradesDuplicate: number;
  tradesDailyCapped: number;
  rateLimitedUntil: string | null;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'rate_limited' | 'cancelled';
  message: string;
  estimatedRemainingSeconds: number | null;
  /** Which of the three fetch actions started this run — explicit (fetch_scope column), not
   *  inferred. Lets each fetch box in the UI show status only for its own kind of run, instead
   *  of whichever ran most recently regardless of which button started it. Null only when no
   *  run has ever happened. */
  scope: 'roster' | 'winners' | 'single' | null;
};

/** Watermarks are derived from the stored trades themselves, so they can never drift from
 *  what is actually held. Paging is strictly newest-first and contiguous, so MIN/MAX describe
 *  a genuine covered interval rather than two unrelated endpoints. */
const readWatermark = (
  database: DatabaseSync, walletAddress: string, chain: string,
): { oldest: number | null; newest: number | null } => {
  const row = database.prepare(
    `SELECT MIN(observed_timestamp) AS oldest, MAX(observed_timestamp) AS newest
     FROM copytrade_trades WHERE wallet_address = ? AND chain = ?`,
  ).get(walletAddress, chain) as { oldest: number | null; newest: number | null };
  return { oldest: row.oldest ?? null, newest: row.newest ?? null };
};

/** The paging cursor to resume a truncated wallet's backfill from, saved by the previous run
 *  that stopped mid-history. Null for a wallet that has never been truncated, is now fully
 *  covered, or whose saved cursor turned out to be unusable. */
const readPriorResumeCursor = (
  database: DatabaseSync, walletAddress: string, chain: string,
): string | null => {
  const row = database.prepare(
    `SELECT resume_cursor AS resumeCursor FROM copytrade_wallet_coverage WHERE wallet_address = ? AND chain = ?`,
  ).get(walletAddress, chain) as { resumeCursor: string | null } | undefined;
  return row?.resumeCursor ?? null;
};

export const recordCoverage = (
  database: DatabaseSync,
  input: {
    walletAddress: string; chain: string; runId: number; requestsUsed: number; truncated: boolean;
    periodDays: number; stopReason: StopReason; resumeCursor?: string | null;
  },
): void => {
  database.prepare(
    `INSERT INTO copytrade_wallet_coverage
       (wallet_address, chain, last_run_id, requests_used, truncated, requested_period_days, stop_reason, resume_cursor, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(wallet_address, chain) DO UPDATE SET
       last_run_id = excluded.last_run_id,
       requests_used = excluded.requests_used,
       -- Truncation is sticky per run, not cumulative: a later run that completes the window
       -- clears it, because the wallet is no longer truncated.
       truncated = excluded.truncated,
       requested_period_days = excluded.requested_period_days,
       stop_reason = excluded.stop_reason,
       resume_cursor = excluded.resume_cursor,
       updated_at = excluded.updated_at`,
   ).run(
     input.walletAddress, input.chain, input.runId, input.requestsUsed,
     input.truncated ? 1 : 0, input.periodDays, input.stopReason, input.resumeCursor ?? null, new Date().toISOString(),
   );

  // The latest-state row above is intentionally a cache. Keep the immutable observation beside
  // it so a later run cannot erase what this run actually covered. Failure to write audit history
  // must never discard the trades already persisted by this fetch.
  try {
    const watermark = readWatermark(database, input.walletAddress, input.chain);
    database.prepare(
      `INSERT INTO copytrade_wallet_coverage_events
         (run_id, wallet_address, chain, requested_period_days, requests_used, truncated,
          stop_reason, oldest_held_ts, newest_held_ts, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.runId, input.walletAddress, input.chain, input.periodDays, input.requestsUsed,
      input.truncated ? 1 : 0, input.stopReason, watermark.oldest, watermark.newest,
      new Date().toISOString(),
    );
  } catch {
    // Coverage history is audit metadata; the normalized trades remain the primary evidence.
  }
};

const DEFAULT_COVERAGE_HISTORY_LIMIT = 50;
const MAX_COVERAGE_HISTORY_LIMIT = 500;

const clampCoverageHistoryLimit = (limit?: number): number => {
  if (!Number.isFinite(limit) || !limit || limit <= 0) return DEFAULT_COVERAGE_HISTORY_LIMIT;
  return Math.min(Math.floor(limit), MAX_COVERAGE_HISTORY_LIMIT);
};

export type WalletCoverageHistoryEvent = {
  id: number;
  runId: number;
  walletAddress: string;
  chain: string;
  requestedPeriodDays: number | null;
  requestsUsed: number;
  truncated: boolean;
  stopReason: StopReason | null;
  oldestHeldTs: number | null;
  newestHeldTs: number | null;
  observedAt: string;
};

/** Reads immutable per-run coverage observations, newest first. */
export const listWalletCoverageHistory = (
  database: DatabaseSync,
  options: { walletAddress?: string; chain?: string; runId?: number; limit?: number } = {},
): WalletCoverageHistoryEvent[] => {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (options.walletAddress) { clauses.push('wallet_address = ?'); params.push(options.walletAddress); }
  if (options.chain) { clauses.push('chain = ?'); params.push(options.chain); }
  if (Number.isInteger(options.runId) && (options.runId ?? 0) > 0) { clauses.push('run_id = ?'); params.push(options.runId as number); }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = database.prepare(
    `SELECT id, run_id AS runId, wallet_address AS walletAddress, chain,
            requested_period_days AS requestedPeriodDays, requests_used AS requestsUsed,
            truncated, stop_reason AS stopReason, oldest_held_ts AS oldestHeldTs,
            newest_held_ts AS newestHeldTs, observed_at AS observedAt
     FROM copytrade_wallet_coverage_events
     ${where}
     ORDER BY observed_at DESC, id DESC
     LIMIT ?`,
  ).all(...params, clampCoverageHistoryLimit(options.limit)) as unknown as Array<Omit<WalletCoverageHistoryEvent, 'truncated'> & { truncated: number }>;
  return rows.map((row) => ({ ...row, truncated: row.truncated === 1 }));
};

/**
 * Asks the active run to stop. The loop checks this between pages, so a fetch halts within
 * roughly one request rather than requiring a server restart. Everything already fetched is
 * kept — each page is persisted before the next request is made.
 */
export const requestCopyTradeFetchStop = (database: DatabaseSync): { stopped: boolean; runId: number | null } => {
  const row = database.prepare(
    `SELECT id FROM copytrade_fetch_runs WHERE status = ? ORDER BY id DESC LIMIT 1`,
  ).get(ACTIVE_STATUS) as { id: number } | undefined;
  if (!row) return { stopped: false, runId: null };
  cancelledRuns.add(row.id);
  return { stopped: true, runId: row.id };
};

const ACTIVE_STATUS = 'running';

export const readFetchRunState = (database: DatabaseSync): FetchRunState => {
  const row = database.prepare(
    `SELECT id, status, wallet_done AS walletDone, wallet_total AS walletTotal,
            trades_fetched AS tradesFetched, trades_duplicate AS tradesDuplicate,
            trades_daily_capped AS tradesDailyCapped, rate_limited_until AS rateLimitedUntil, error,
            started_at AS startedAt, requested_period_days AS periodDays, fetch_scope AS fetchScope
     FROM copytrade_fetch_runs ORDER BY id DESC LIMIT 1`,
  ).get() as {
    id: number; status: string; walletDone: number; walletTotal: number;
    tradesFetched: number; tradesDuplicate: number; tradesDailyCapped: number;
    rateLimitedUntil: string | null; error: string | null;
    startedAt: string; periodDays: number | null; fetchScope: string;
  } | undefined;

  if (!row) {
    return {
      running: false, runId: null, walletDone: 0, walletTotal: 0, tradesFetched: 0, tradesDuplicate: 0,
      tradesDailyCapped: 0, rateLimitedUntil: null, status: 'idle', message: 'No fetch has been run yet.',
      estimatedRemainingSeconds: null, scope: null,
    };
  }
  const status = (['running', 'completed', 'failed', 'rate_limited', 'cancelled'].includes(row.status) ? row.status : 'idle') as FetchRunState['status'];
  const running = status === ACTIVE_STATUS;
  const estimatedRemainingSeconds = running
    ? estimateRemainingSeconds(database, { startedAt: row.startedAt, walletDone: row.walletDone, walletTotal: row.walletTotal, periodDays: row.periodDays })
    : null;
  const message = status === 'running' ? `Fetching wallet ${row.walletDone + 1} of ${row.walletTotal}.`
    : status === 'completed' ? `Fetched ${row.tradesFetched} new trades across ${row.walletDone} wallets (${row.tradesDuplicate} already-known rows reconfirmed${row.tradesDailyCapped > 0 ? `, ${row.tradesDailyCapped} skipped by the daily sample cap` : ''}).`
    : status === 'rate_limited' ? 'GMGN rate limit reached. Waiting for the reset time before any retry.'
    : status === 'cancelled' ? `Stopped. ${row.tradesFetched} trades from ${row.walletDone} wallets were kept.`
    : status === 'failed' ? (row.error ?? 'The fetch failed.')
    : 'No fetch has been run yet.';
  return {
    running, runId: row.id, walletDone: row.walletDone, walletTotal: row.walletTotal,
    tradesFetched: row.tradesFetched, tradesDuplicate: row.tradesDuplicate, tradesDailyCapped: row.tradesDailyCapped,
    rateLimitedUntil: row.rateLimitedUntil, status, message, estimatedRemainingSeconds,
    scope: row.fetchScope === 'winners' || row.fetchScope === 'single' ? row.fetchScope : 'roster',
  };
};

/**
 * Clears runs orphaned by a process restart. A fetch only ever executes inside the process
 * that started it, so any row still marked `running` at startup belongs to a process that no
 * longer exists — it can never progress or finish on its own. Without this, one crashed or
 * killed run leaves the 409 single-run guard permanently latched and no fetch can ever be
 * started again. Must be called at startup only, before any run in this process begins.
 */
export const reconcileStaleFetchRuns = (database: DatabaseSync): number => {
  const result = database.prepare(
    `UPDATE copytrade_fetch_runs
     SET status = 'failed', completed_at = ?,
         error = 'Interrupted: the server restarted while this fetch was running. Already-fetched trades were kept.'
     WHERE status = ?`,
  ).run(new Date().toISOString(), ACTIVE_STATUS);
  return Number(result.changes);
};

export const hasActiveFetchRun = (database: DatabaseSync): boolean =>
  (database.prepare(`SELECT COUNT(*) AS count FROM copytrade_fetch_runs WHERE status = ?`).get(ACTIVE_STATUS) as { count: number }).count > 0;

/**
 * Walks every roster wallet's trade history, newest first, stopping at the period cutoff.
 * Each page is persisted before the next request is made, so a rate limit or crash mid-run
 * never discards work already completed.
 */
export const runCopyTradeFetch = async (
  database: DatabaseSync,
  runId: number,
  options: { limit: number; periodDays: number; chain?: string; walletAddresses?: string[] },
): Promise<void> => {
  const chain = options.chain ?? 'sol';
  const cutoffSeconds = Math.floor(Date.now() / 1000) - options.periodDays * 86_400;
  const updateProgress = database.prepare(
    `UPDATE copytrade_fetch_runs
     SET wallet_done = ?, trades_fetched = ?, trades_duplicate = ?, trades_daily_capped = ?, requests_made = ?
     WHERE id = ?`,
  );

  let walletDone = 0;
  let tradesFetched = 0;
  let tradesDuplicate = 0;
  let tradesDailyCapped = 0;
  let requestsMade = 0;

  try {
    const apiKey = readApiKey();
    // An explicit wallet list (e.g. the current Winners) skips the top-N roster sync entirely —
    // this run isn't about discovering who's on the leaderboard, only about refreshing trade
    // history for wallets already selected elsewhere. No roster snapshot is created for it.
    let wallets: Array<{ walletAddress: string }>;
    let rosterSnapshotId: number | null = null;
    if (options.walletAddresses && options.walletAddresses.length > 0) {
      wallets = options.walletAddresses.map((walletAddress) => ({ walletAddress }));
    } else {
      const rosterSync = syncCopyTradeRoster(database, { chain, limit: options.limit });
      wallets = listRosterWallets(database, { chain, limit: options.limit });
      rosterSnapshotId = rosterSync.snapshotId;
    }
    database.prepare(
      `UPDATE copytrade_fetch_runs SET wallet_total = ?, roster_snapshot_id = ? WHERE id = ?`,
    ).run(wallets.length, rosterSnapshotId, runId);

    for (const wallet of wallets) {
      if (cancelledRuns.has(runId)) break;

      // What we already hold for this wallet. Paging cannot skip — reaching older data means
      // walking every page in between — so the watermark is not used to avoid requests. Its
      // job is to tell an *expected* stretch of duplicates (re-reading known history on the
      // way to older data) apart from a cursor that has genuinely stopped advancing. Before
      // this distinction existed, extending the period from 30 to 60 days tripped the
      // stalled-cursor guard within three pages and silently backfilled nothing.
      const { oldest: oldestHeld, newest: newestHeld } = readWatermark(database, wallet.walletAddress, chain);
      const windowAlreadyCovered = oldestHeld !== null && oldestHeld <= cutoffSeconds;
      // Where a previous run's backfill was cut off by the request cap, if any. Reused below
      // to skip straight past ground this wallet already covers instead of re-walking it.
      const priorResumeCursor = readPriorResumeCursor(database, wallet.walletAddress, chain);
      const dailyCap = createDailyCapTracker(DAILY_TRADE_INSERT_CAP);

      // Supporting context for this wallet's risk flag. One extra request per wallet, and a
      // failure here must never abort the trade fetch — the trades are the point.
      try {
        requestsMade += 1;
        await fetchAndStoreWalletStats(database, { wallet: wallet.walletAddress, chain, period: '7d', apiKey });
      } catch { /* context is optional; the trade history is not */ }

      let cursor: string | null = null;
      const seenCursors = new Set<string>();
      let barrenPages = 0;
      let requestsThisWallet = 0;
      let truncated = false;
      let stopReason: StopReason = 'no_more_data';
      // Whether this wallet's walk has already jumped to priorResumeCursor this run — a
      // one-shot attempt, so a stale cursor can only ever cost one wasted request, not a loop.
      let resumeAttempted = false;

      const fetchAndStore = async (cursorToUse: string | null): Promise<{ page: ActivityPage; stored: StoredTrade }> => {
        requestsMade += 1;
        requestsThisWallet += 1;
        updateProgress.run(walletDone, tradesFetched, tradesDuplicate, tradesDailyCapped, requestsMade, runId);
        const page = await fetchActivityPage({ wallet: wallet.walletAddress, chain, cursor: cursorToUse, apiKey });
        const stored = storeActivityPage(database, page.activities, { chain, fetchedAt: new Date().toISOString(), dailyCap });
        tradesFetched += stored.inserted;
        tradesDuplicate += stored.duplicates;
        tradesDailyCapped += stored.dailyCapped;
        updateProgress.run(walletDone, tradesFetched, tradesDuplicate, tradesDailyCapped, requestsMade, runId);
        return { page, stored };
      };

      for (;;) {
        if (cancelledRuns.has(runId)) { stopReason = 'cancelled'; break; }
        if (requestsThisWallet >= MAX_REQUESTS_PER_WALLET) { truncated = true; stopReason = 'request_cap'; break; }

        // Counted before the request, not after, so a stall is visible as "attempted request
        // N, never finished" rather than looking identical to doing nothing at all.
        const { page: result, stored } = await fetchAndStore(cursor);

        if (result.activities.length === 0 || !result.next) { stopReason = 'no_more_data'; break; }

        // Timestamps arrive newest-first, so once the oldest row on this page predates the
        // window there is nothing older worth requesting.
        const oldestOnPage = result.activities.reduce((min, item) => {
          const ts = typeof item.timestamp === 'number' ? item.timestamp : Number.POSITIVE_INFINITY;
          return ts < min ? ts : min;
        }, Number.POSITIVE_INFINITY);
        if (Number.isFinite(oldestOnPage) && oldestOnPage < cutoffSeconds) { stopReason = 'window_covered'; break; }

        // Re-running an already-covered window: once this page reaches back into history we
        // already hold, and everything older is held too, the only new data was above it.
        if (windowAlreadyCovered && newestHeld !== null && oldestOnPage <= newestHeld) { stopReason = 'up_to_date'; break; }

        // This page has now caught up to everything we already held before this run started
        // (oldestOnPage <= newestHeld) but the window still isn't fully covered — meaning the
        // wallet was truncated by the request cap last time. Rather than keep paging one
        // request at a time through the entire stretch we already have (which is exactly the
        // re-walk this feature exists to eliminate), jump straight to where the previous run
        // left off. One-shot: if the saved cursor turns out to be stale or rejected, fall back
        // to normal pagination from here instead of failing the whole run over it.
        if (!resumeAttempted && !windowAlreadyCovered && newestHeld !== null && priorResumeCursor
          && oldestOnPage <= newestHeld && requestsThisWallet < MAX_REQUESTS_PER_WALLET) {
          resumeAttempted = true;
          try {
            const resumed = await fetchAndStore(priorResumeCursor);
            if (resumed.page.activities.length === 0 || !resumed.page.next) { stopReason = 'no_more_data'; break; }
            seenCursors.clear();
            barrenPages = 0;
            cursor = resumed.page.next;
            continue;
          } catch (resumeError) {
            const message = resumeError instanceof Error ? resumeError.message : String(resumeError);
            if (detectRateLimit(message)) throw resumeError; // preserve existing rate-limit handling
            // Stale/expired/rejected cursor — resume this wallet the slow way instead of
            // treating an old token going bad as a run-ending error.
          }
        }

        if (seenCursors.has(result.next)) { stopReason = 'cursor_stalled'; break; }
        seenCursors.add(result.next);

        // A barren page only signals a stalled cursor when it lands *outside* known coverage.
        // Inside it, duplicates are exactly what a backfill is supposed to produce — and a page
        // that was entirely skipped by the daily sample cap had real data too, it just wasn't
        // stored on purpose, so it must not be mistaken for a stalled cursor either.
        const insideKnownCoverage = oldestHeld !== null && newestHeld !== null
          && oldestOnPage <= newestHeld && oldestOnPage >= oldestHeld;
        if (insideKnownCoverage) barrenPages = 0;
        else {
          barrenPages = (stored.inserted + stored.dailyCapped) === 0 ? barrenPages + 1 : 0;
          if (barrenPages >= 3) { stopReason = 'cursor_stalled'; break; }
        }

        cursor = result.next;
      }

      // Save a resume point only when there is real unfinished ground to resume — a truncated
      // wallet, or one the user stopped mid-walk. Every other stop reason means either the
      // window is fully covered or the cursor is known bad, so nothing should be resumed from.
      const resumeCursorToSave = (stopReason === 'request_cap' || stopReason === 'cancelled') ? cursor : null;
      recordCoverage(database, {
        walletAddress: wallet.walletAddress, chain, runId,
        requestsUsed: requestsThisWallet, truncated, periodDays: options.periodDays, stopReason,
        resumeCursor: resumeCursorToSave,
      });
      if (stopReason === 'cancelled') break;
      walletDone += 1;
      updateProgress.run(walletDone, tradesFetched, tradesDuplicate, tradesDailyCapped, requestsMade, runId);
    }

    const cancelled = cancelledRuns.has(runId);
    database.prepare(
      `UPDATE copytrade_fetch_runs SET status = ?, completed_at = ? WHERE id = ?`,
    ).run(cancelled ? 'cancelled' : 'completed', new Date().toISOString(), runId);
    // Only a genuinely completed run (not cancelled, not failed/rate-limited — those exit
    // through the catch block below and never reach here) feeds the duration estimate, so a
    // partial or rate-limit-truncated run can never drag the measured rate off course.
    if (!cancelled) {
      try { recordFetchRunEstimate(database, runId); }
      catch { /* the estimate is advisory; never let it fail a completed fetch */ }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const rateLimit = detectRateLimit(message);
    if (rateLimit) {
      // Deliberately no automatic retry: retrying inside the cooldown extends the ban.
      database.prepare(
        `UPDATE copytrade_fetch_runs SET status = 'rate_limited', rate_limited_until = ?, completed_at = ?,
           error = 'GMGN rate limit reached. Retrying before the reset time extends the ban.' WHERE id = ?`,
      ).run(rateLimit.resetAt, new Date().toISOString(), runId);
      return;
    }
    database.prepare(
      `UPDATE copytrade_fetch_runs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?`,
    ).run(new Date().toISOString(), message.slice(0, 2000), runId);
  } finally {
    // Always discharge the cancellation request. Leaving it set would both leak the id and,
    // far worse, let a stale stop silently abort a future run that happened to reuse it.
    cancelledRuns.delete(runId);
  }
};

export const startCopyTradeFetch = (
  database: DatabaseSync,
  options: {
    limit: number; periodDays: number; chain?: string; walletAddresses?: string[];
    /** Explicit, not inferred — see the fetch_scope migration's own comment for why inferring
     *  this from walletAddresses/wallet_total is unsafe. Defaults to 'roster' for the ordinary
     *  top-N discovery fetch; a caller passing walletAddresses should always pass this too. */
    scope?: 'roster' | 'winners' | 'single';
  },
): { runId: number; status: 'running' } => {
  const startedAt = new Date().toISOString();
  const scope = options.scope ?? 'roster';
  database.prepare(
    `INSERT INTO copytrade_fetch_runs
       (started_at, status, wallet_total, wallet_done, trades_fetched, requests_made,
        requested_period_days, trader_limit, fetch_scope)
     VALUES (?, 'running', 0, 0, 0, 0, ?, ?, ?)`,
  ).run(startedAt, options.periodDays, options.limit, scope);
  const runId = Number((database.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
  // Intentionally not awaited: the HTTP route returns immediately and the UI polls the run
  // row for progress. Every failure path inside runCopyTradeFetch writes its own terminal
  // state, and this catch is the last resort so a fetch can never become an unhandled
  // rejection that leaves the run stuck at 'running' forever.
  void runCopyTradeFetch(database, runId, options).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    try {
      database.prepare(
        `UPDATE copytrade_fetch_runs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?`,
      ).run(new Date().toISOString(), message.slice(0, 2000), runId);
    } catch { /* the database is already unavailable; nothing further can be recorded */ }
  });
  return { runId, status: 'running' };
};
