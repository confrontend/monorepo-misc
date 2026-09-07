import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import {
  calculateMinimumCapitalFromStoredData,
  minimumCapitalApiResult,
  readCachedMinimumCapital,
  saveMinimumCapital,
  type MinimumCapitalApiResult,
} from '../../copytrade/minimumCapital.js';

export interface MinimumCapitalRouteRequest {
  method: string | undefined;
  url: URL;
  request: IncomingMessage;
  readJsonBody: () => Promise<unknown>;
}

export interface MinimumCapitalRouteContext {
  database: DatabaseSync;
  respond: (status: number, value: unknown) => void;
}

export type MinimumCapitalRoute = (
  request: MinimumCapitalRouteRequest,
  context: MinimumCapitalRouteContext,
) => boolean | Promise<boolean>;

// A process restart cannot resume an in-memory background loop. The next request reconciles any
// persisted `running` rows as interrupted instead of permanently blocking new calculations.
let activeRunId: number | null = null;

const parseWalletAddresses = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
};

const readRun = (database: DatabaseSync, runId?: number): Record<string, unknown> | null => {
  const row = database
    .prepare(
      `SELECT id AS runId, status, wallet_total AS walletTotal, wallet_done AS walletDone,
          current_wallet_address AS currentWalletAddress, results_json AS resultsJson, error,
          started_at AS startedAt, completed_at AS completedAt
       FROM copytrade_minimum_capital_runs
       WHERE (? IS NULL OR id = ?)
       ORDER BY id DESC LIMIT 1`,
    )
    .get(runId ?? null, runId ?? null) as Record<string, unknown> | undefined;
  if (!row) return null;
  let results: MinimumCapitalApiResult[] = [];
  try {
    const rawResults = row.resultsJson;
    const parsed =
      typeof rawResults === 'string' ? (JSON.parse(rawResults) as unknown) : (rawResults ?? []);
    if (Array.isArray(parsed)) results = parsed as MinimumCapitalApiResult[];
  } catch {
    // Preserve the run status even if an interrupted write left malformed diagnostics.
  }
  const { resultsJson: _resultsJson, ...rest } = row;
  return { ...rest, results };
};

const hasRunningRun = (database: DatabaseSync): boolean =>
  activeRunId !== null ||
  Boolean(
    database
      .prepare(
        `SELECT id FROM copytrade_minimum_capital_runs WHERE status = 'running' ORDER BY id DESC LIMIT 1`,
      )
      .get(),
  );

const reconcileInterruptedRuns = (database: DatabaseSync): void => {
  if (activeRunId !== null) return;
  database
    .prepare(
      `UPDATE copytrade_minimum_capital_runs
       SET status = 'error', error = COALESCE(error, 'Calculation interrupted by server restart.'),
           completed_at = COALESCE(completed_at, ?)
       WHERE status = 'running'`,
    )
    .run(new Date().toISOString());
};

const runInBackground = (
  database: DatabaseSync,
  runId: number,
  walletAddresses: string[],
  force: boolean,
): void => {
  void (async () => {
    const results: MinimumCapitalApiResult[] = [];
    try {
      for (let index = 0; index < walletAddresses.length; index += 1) {
        const walletAddress = walletAddresses[index];
        database
          .prepare(
            `UPDATE copytrade_minimum_capital_runs SET wallet_done = ?, current_wallet_address = ? WHERE id = ?`,
          )
          .run(index, walletAddress, runId);
        const cached = !force ? readCachedMinimumCapital(database, walletAddress) : null;
        const calculated = cached ?? calculateMinimumCapitalFromStoredData(database, walletAddress);
        if (!cached) saveMinimumCapital(database, calculated);
        const result = minimumCapitalApiResult(calculated, cached !== null);
        results.push(result);
        database
          .prepare(
            `UPDATE copytrade_minimum_capital_runs SET wallet_done = ?, current_wallet_address = ?, results_json = ? WHERE id = ?`,
          )
          .run(index + 1, walletAddress, JSON.stringify(results), runId);
      }
      database
        .prepare(
          `UPDATE copytrade_minimum_capital_runs SET status = 'completed', wallet_done = ?, current_wallet_address = NULL, results_json = ?, completed_at = ? WHERE id = ?`,
        )
        .run(walletAddresses.length, JSON.stringify(results), new Date().toISOString(), runId);
      if (activeRunId === runId) activeRunId = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      database
        .prepare(
          `UPDATE copytrade_minimum_capital_runs SET status = 'error', results_json = ?, error = ?, completed_at = ? WHERE id = ?`,
        )
        .run(JSON.stringify(results), message, new Date().toISOString(), runId);
      if (activeRunId === runId) activeRunId = null;
    }
  })();
};

/** Local-only minimum capital planning routes. This module never imports a provider client. */
export const createMinimumCapitalRoutes = (): MinimumCapitalRoute[] => [
  async ({ method, url, readJsonBody }, { database, respond }) => {
    if (method !== 'POST' || url.pathname !== '/api/copytrade/minimum-capital') return false;
    const payload = (await readJsonBody().catch(() => ({}))) as Record<string, unknown>;
    const walletAddresses = parseWalletAddresses(payload.walletAddresses);
    if (!walletAddresses.length || walletAddresses.length > 100) {
      respond(400, { error: 'walletAddresses must contain between 1 and 100 wallets.' });
      return true;
    }
    if (activeRunId === null) reconcileInterruptedRuns(database);
    if (hasRunningRun(database)) {
      respond(409, { error: 'A minimum-capital calculation is already running.' });
      return true;
    }
    const force = payload.force === true;
    const now = new Date().toISOString();
    const insert = database
      .prepare(
        `INSERT INTO copytrade_minimum_capital_runs
          (status, wallet_addresses, wallet_total, wallet_done, results_json, started_at)
         VALUES ('running', ?, ?, 0, '[]', ?)`,
      )
      .run(JSON.stringify(walletAddresses), walletAddresses.length, now);
    const runId = Number(insert.lastInsertRowid);
    activeRunId = runId;
    setTimeout(() => runInBackground(database, runId, walletAddresses, force), 0);
    respond(202, { runId, status: 'running', walletTotal: walletAddresses.length, walletDone: 0 });
    return true;
  },
  ({ method, url }, { database, respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/copytrade/minimum-capital/status') return false;
    const rawRunId = Number(url.searchParams.get('runId') ?? '');
    const run = readRun(
      database,
      Number.isInteger(rawRunId) && rawRunId > 0 ? rawRunId : undefined,
    );
    respond(200, run ?? { status: 'idle', walletTotal: 0, walletDone: 0, results: [] });
    return true;
  },
  ({ method, url }, { database, respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/copytrade/minimum-capital') return false;
    const addresses = parseWalletAddresses(
      (url.searchParams.get('walletAddresses') ?? '').split(','),
    );
    if (!addresses.length) {
      respond(400, { error: 'walletAddresses is required.' });
      return true;
    }
    respond(200, {
      results: addresses.map((walletAddress) => {
        const cached = readCachedMinimumCapital(database, walletAddress);
        return cached ? minimumCapitalApiResult(cached, true) : null;
      }),
    });
    return true;
  },
];
