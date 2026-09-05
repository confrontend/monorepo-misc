import type { DatabaseSync } from 'node:sqlite';
import { SolanaRpcClient } from './rpcClient.js';
import { SolanaDelayedPriceProvider } from './delayedPriceProvider.js';
import { benchmarkSolanaAgainstDune, type BenchmarkLeg } from './benchmark.js';

type Sample = {
  id: number;
  walletAddress: string;
  tokenMint: string;
  signature: string;
  direction: string;
  observedTimestamp: number;
  duneTimestamp: string | null;
  dunePrice: number | null;
  duneSignature: string | null;
  duneStatus: string;
};
export type BenchmarkRun = {
  id: number;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  completed: number;
  total: number;
  phase: string;
  error: string | null;
  errors: Array<{
    tradeId?: string | number;
    walletAddress?: string;
    reason: string;
    message: string;
    at: string;
  }>;
  rpcRequests: Array<{ count: number; method: string; params: unknown[]; at: string }>;
  requests?: number;
  generatedAt: string;
  updatedAt: string;
  provider: { name: string };
  preflight?: { status: 'PASS' | 'FAIL'; reason: string | null };
  benchmark: ReturnType<typeof benchmarkSolanaAgainstDune>;
  legs: BenchmarkLeg[];
};
const active = new WeakSet<DatabaseSync>();
const cancelledRuns = new Set<number>();
const STALE_RUN_MS = 90_000;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function save(db: DatabaseSync, run: BenchmarkRun) {
  run.updatedAt = new Date().toISOString();
  run.benchmark = benchmarkSolanaAgainstDune(run.legs);
  db.prepare('UPDATE solana_benchmark_runs SET report_json = ? WHERE id = ?').run(
    JSON.stringify(run),
    run.id,
  );
}

export function readBenchmarkRun(db: DatabaseSync): BenchmarkRun | null {
  const row = db
    .prepare('SELECT report_json FROM solana_benchmark_runs ORDER BY id DESC LIMIT 1')
    .get() as { report_json: string } | undefined;
  if (!row) return null;
  const run = JSON.parse(row.report_json) as BenchmarkRun;
  run.errors ??= [];
  run.rpcRequests ??= [];
  const stale = run.status === 'running' && Date.now() - Date.parse(run.updatedAt) > STALE_RUN_MS;
  if (run.status === 'running' && (stale || !active.has(db))) {
    if (stale) cancelledRuns.add(run.id);
    run.status = 'interrupted';
    run.error = 'Server restarted. Saved partial results are available; start a new run to retry.';
    save(db, run);
  }
  return run;
}

export function startBenchmarkRun(db: DatabaseSync): BenchmarkRun {
  const existing = readBenchmarkRun(db);
  if (existing?.status === 'running') return existing;
  if (existing?.status === 'interrupted' && existing.completed < existing.total) {
    existing.status = 'running';
    existing.error = null;
    existing.phase = `Resuming at trade ${existing.completed + 1}/${existing.total}`;
    save(db, existing);
    active.add(db);
    setImmediate(() => {
      void execute(db, existing);
    });
    return existing;
  }
  if (existing?.status === 'interrupted') {
    existing.status = 'running';
    existing.error = null;
    existing.phase = `Resuming ${existing.completed}/${existing.total}`;
    save(db, existing);
    active.add(db);
    setImmediate(() => {
      void execute(db, existing);
    });
    return existing;
  }
  const now = new Date().toISOString();
  const run: BenchmarkRun = {
    id: 0,
    status: 'running',
    completed: 0,
    total: 0,
    phase: 'Preparing sample',
    error: null,
    errors: [],
    rpcRequests: [],
    generatedAt: now,
    updatedAt: now,
    provider: { name: 'Solana Mainnet RPC' },
    legs: [],
    benchmark: benchmarkSolanaAgainstDune([]),
  };
  run.id = Number(
    db.prepare('INSERT INTO solana_benchmark_runs(report_json) VALUES (?)').run(JSON.stringify(run))
      .lastInsertRowid,
  );
  save(db, run);
  active.add(db);
  // Return immediately; reading status never starts RPC work.
  setImmediate(() => {
    void execute(db, run);
  });
  return run;
}

async function execute(db: DatabaseSync, run: BenchmarkRun) {
  try {
    const rows = db
      .prepare(
        `SELECT t.id, t.wallet_address AS walletAddress, t.token_address AS tokenMint,
      t.tx_hash AS signature, t.event_type AS direction, t.observed_timestamp AS observedTimestamp,
      m.matched_trade_at AS duneTimestamp, m.matched_price_usd AS dunePrice,
      m.matched_tx_id AS duneSignature, m.status AS duneStatus
      FROM copytrade_trades t JOIN copytrade_copy_simulation_matches m ON m.trade_id = t.id
      WHERE t.chain = 'sol' AND m.run_id = (SELECT MAX(x.run_id) FROM copytrade_copy_simulation_matches x WHERE x.trade_id = t.id)
      ORDER BY t.observed_timestamp DESC, t.id DESC LIMIT 50`,
      )
      .all() as unknown as Sample[];
    run.total = rows.length;
    const completedIds = new Set(run.legs.map((leg) => String(leg.id)));
    run.completed = Math.min(completedIds.size, run.total);
    if (!rows.length) throw new Error('No saved Dune matches are available to benchmark.');
    run.phase = 'Checking RPC history';
    save(db, run);
    const rpc = new SolanaRpcClient({
      timeoutMs: 8_000,
      maxCalls: 120,
      deadlineMs: 90_000,
      onRequest: (request) => {
        run.requests = request.count;
        run.rpcRequests.push(request);
        save(db, run);
      },
    });
    const provider = new SolanaDelayedPriceProvider(rpc);
    await rpc.getFirstAvailableBlock();
    run.preflight = { status: 'PASS', reason: null };
    for (const row of rows) {
      if (cancelledRuns.has(run.id)) return;
      if (completedIds.has(String(row.id))) continue;
      run.phase = `Checking trade ${run.completed + 1}/${run.total}`;
      save(db, run);
      const result = await provider.findDelayedPrice({
        originalSignature: row.signature,
        tokenMint: row.tokenMint,
        copyDelaySeconds: 10,
        maxWindowSeconds: 300,
      });
      const target = row.observedTimestamp + 10;
      const duneTime = row.duneTimestamp ? Date.parse(row.duneTimestamp) / 1000 : NaN;
      if (!result.ok)
        run.errors.push({
          tradeId: row.id,
          walletAddress: row.walletAddress,
          reason: result.failure.reason,
          message: result.failure.message,
          at: new Date().toISOString(),
        });
      run.legs.push({
        id: row.id,
        walletAddress: row.walletAddress,
        tokenMint: row.tokenMint,
        direction: row.direction.includes('sell') ? 'sell' : 'buy',
        delaySeconds: 10,
        targetTimestamp: target,
        dune: {
          found: row.duneStatus === 'matched',
          price: row.dunePrice,
          timestamp: Number.isFinite(duneTime) ? duneTime : null,
          signature: row.duneSignature,
        },
        solana: result.ok
          ? {
              found: true,
              signature: result.observation.signature,
              slot: result.observation.slot,
              timestamp: result.observation.blockTime,
              parser: result.observation.parser,
              // SOL quote units are not USD. Only USDC quotes are comparable here.
              price:
                result.observation.quoteMint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
                  ? result.observation.priceInQuote
                  : null,
            }
          : { found: false, failureReason: result.failure.reason },
        rpcStats: result.rpcStats,
      });
      completedIds.add(String(row.id));
      run.completed++;
      save(db, run);
    }
    run.status = 'completed';
    run.phase = 'Finished';
  } catch (error) {
    run.status = 'failed';
    run.error = message(error);
    run.phase = 'Stopped';
    run.errors.push({ reason: 'RUN_FAILED', message: run.error, at: new Date().toISOString() });
    if (!run.preflight) run.preflight = { status: 'FAIL', reason: run.error };
  } finally {
    save(db, run);
    active.delete(db);
    cancelledRuns.delete(run.id);
  }
}
