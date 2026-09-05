import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import {
  computeLiveEvaluation,
  parseLiveEvaluationRequest,
} from '../../copytrade/liveEvaluation.js';
import {
  computeEvaluationTrend,
  readEvaluationHistory,
  recordEvaluationHistory,
  shouldRecordEvaluationHistory,
} from '../../copytrade/liveEvaluationHistory.js';
export interface SimulationRouteRequest {
  method: string | undefined;
  url: URL;
  request: IncomingMessage;
  readJsonBody: () => Promise<unknown>;
}

export interface SimulationRouteContext {
  database: DatabaseSync;
  respond: (status: number, value: unknown) => void;
  getRunState: () => Record<string, unknown>;
  setRunState: (state: Record<string, unknown>) => void;
}

export type SimulationRoute = (
  request: SimulationRouteRequest,
  context: SimulationRouteContext,
) => Promise<boolean>;

/** Read-only live-evaluation and copy-simulation status routes. The long-running simulation
 * runner remains in the parent temporarily; keeping its callbacks there avoids changing the
 * established progress protocol while the remaining orchestration is extracted. */
export const createSimulationRoutes = (): SimulationRoute[] => [
  async ({ method, url, readJsonBody }, { database, respond }) => {
    if (method !== 'POST' || url.pathname !== '/api/live-evaluation') return false;
    const parsed = parseLiveEvaluationRequest(await readJsonBody());
    if (!parsed.ok) {
      respond(400, { error: parsed.error });
      return true;
    }
    const result = computeLiveEvaluation(database, parsed.walletAddress, { chain: 'sol' });
    if (
      shouldRecordEvaluationHistory({
        score: result.estimatedOverallScore,
        evidenceLevel: result.evidenceLevel,
      })
    ) {
      const previous =
        readEvaluationHistory(database, parsed.walletAddress, { chain: 'sol', limit: 1 })[0] ??
        null;
      const current = recordEvaluationHistory(database, {
        walletAddress: parsed.walletAddress,
        chain: 'sol',
        source: 'live',
        generatedAt: result.generatedAt,
        score: result.estimatedOverallScore,
        verdict: result.verdict,
        evidenceLevel: result.evidenceLevel,
        componentScores: result.componentScores,
      });
      result.trend = computeEvaluationTrend(current, previous);
    }
    respond(200, { status: 'result', result });
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/live-evaluation/history') return false;
    const walletAddress = url.searchParams.get('walletAddress')?.trim() ?? '';
    if (!walletAddress) {
      respond(400, { error: 'walletAddress is required.' });
      return true;
    }
    const chain = url.searchParams.get('chain') ?? 'sol';
    const requestedLimit = Number(url.searchParams.get('limit') ?? '50');
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(200, Math.max(1, Math.floor(requestedLimit)))
      : 50;
    const entries = readEvaluationHistory(database, walletAddress, { chain, limit });
    respond(200, {
      walletAddress,
      chain,
      entries: entries.map((entry, index) => ({
        ...entry,
        trend: computeEvaluationTrend(entry, entries[index + 1] ?? null),
      })),
    });
    return true;
  },
  async ({ method, url }, { database, respond, getRunState }) => {
    if (method !== 'GET' || url.pathname !== '/api/copytrade/copy-simulation/status') return false;
    const latestSavedRun = database
      .prepare(
        `SELECT id, status, requested_at AS requestedAt, completed_at AS completedAt,
              trade_refs AS tradeRefs, search_window_minutes AS searchWindowMinutes,
              match_source AS matchSource
       FROM copytrade_copy_simulation_runs ORDER BY id DESC LIMIT 1`,
      )
      .get() as
      | {
          id: number;
          status: string;
          requestedAt: string;
          completedAt: string | null;
          tradeRefs: string;
          searchWindowMinutes: number;
          matchSource: string;
        }
      | undefined;
    const savedTradeCount =
      latestSavedRun?.status === 'completed'
        ? (() => {
            try {
              const refs = JSON.parse(latestSavedRun.tradeRefs) as unknown;
              return Array.isArray(refs) ? refs.length : 0;
            } catch {
              return 0;
            }
          })()
        : 0;
    const latestAudit =
      database
        .prepare(
          `SELECT id, requested_at AS requestedAt, completed_at AS completedAt,
       mode, wallet_count AS walletCount, planned_targets AS plannedTargets, submitted_targets AS submittedTargets,
       stored_targets AS storedTargets, failed_targets AS failedTargets, remaining_targets AS remainingTargets,
       status, message FROM copytrade_dune_fetch_audits ORDER BY id DESC LIMIT 1`,
        )
        .get() ?? null;
    const walletAddresses = (url.searchParams.get('walletAddresses') ?? '')
      .split(',')
      .map((address) => address.trim())
      .filter(Boolean);
    const startedAt = url.searchParams.get('startedAt');
    let walletProgress: Array<{ walletAddress: string; processed: number }> | undefined;
    if (walletAddresses.length && startedAt) {
      const placeholders = walletAddresses.map(() => '?').join(', ');
      const rows = database
        .prepare(
          `SELECT t.wallet_address AS walletAddress, COUNT(*) AS processed
           FROM copytrade_copy_simulation_matches m
           JOIN copytrade_trades t ON ABS(m.trade_id) = t.id
           WHERE t.wallet_address IN (${placeholders}) AND m.completed_at >= ?
           GROUP BY t.wallet_address`,
        )
        .all(...walletAddresses, startedAt) as Array<{ walletAddress: string; processed: number }>;
      walletProgress = rows.map((row) => ({
        walletAddress: row.walletAddress,
        processed: Number(row.processed) || 0,
      }));
    }
    respond(200, {
      ...getRunState(),
      ...(walletProgress ? { walletProgress } : {}),
      audit: latestAudit,
      persistedRun: latestSavedRun
        ? {
            id: latestSavedRun.id,
            status: latestSavedRun.status,
            requestedAt: latestSavedRun.requestedAt,
            completedAt: latestSavedRun.completedAt,
            storedTargets: savedTradeCount,
            searchWindowMinutes: latestSavedRun.searchWindowMinutes,
            matchSource: latestSavedRun.matchSource,
          }
        : null,
    });
    return true;
  },
  async ({ method, url }, { database, respond }) => {
    if (method !== 'GET' || url.pathname !== '/api/copytrade/copy-simulation/dune-responses')
      return false;
    const requestedLimit = Number(url.searchParams.get('limit') ?? '20');
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(50, requestedLimit)) : 20;
    const runs = database
      .prepare(
        `SELECT id, execution_id AS executionId, status, requested_at AS requestedAt,
              completed_at AS completedAt, archive_path AS archivePath, archive_sha256 AS archiveSha256,
              trade_refs AS tradeRefs, raw_result AS rawResult, search_window_minutes AS searchWindowMinutes,
              match_source AS matchSource FROM copytrade_copy_simulation_runs ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as unknown as Array<Record<string, unknown> & { tradeRefs: string }>;
    respond(
      200,
      runs.map((run) => {
        let tradeCount = 0;
        try {
          const refs = JSON.parse(run.tradeRefs) as unknown;
          tradeCount = Array.isArray(refs) ? refs.length : 0;
        } catch {
          /* preserve raw evidence */
        }
        const { tradeRefs: _tradeRefs, ...publicRun } = run;
        return { ...publicRun, tradeCount };
      }),
    );
    return true;
  },
  async ({ method, url }, { respond, getRunState, setRunState }) => {
    if (method !== 'POST' || url.pathname !== '/api/copytrade/copy-simulation/stop') return false;
    const state = getRunState();
    if (state.running)
      setRunState({
        ...state,
        cancelRequested: true,
        message: 'Stop requested; waiting for the current Dune batch to finish…',
      });
    respond(200, getRunState());
    return true;
  },
];
