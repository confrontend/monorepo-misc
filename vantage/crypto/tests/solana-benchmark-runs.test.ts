import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from '../src/platform/db/schema.js';
import { readBenchmarkRun, startBenchmarkRun } from '../src/solana/benchmarkRuns.js';
import { SolanaRpcClient } from '../src/solana/rpcClient.js';
import { SolanaDelayedPriceProvider } from '../src/solana/delayedPriceProvider.js';

test('status reads do not start work; duplicate starts reuse the run; failures persist', async () => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db);
  assert.equal(readBenchmarkRun(db), null);
  const run = startBenchmarkRun(db);
  assert.equal(startBenchmarkRun(db).id, run.id);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const saved = readBenchmarkRun(db)!;
  assert.equal(saved.status, 'failed');
  assert.match(saved.error!, /No saved Dune/);
  assert.equal(saved.errors.length, 1);
  assert.deepEqual(readBenchmarkRun(db), saved);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM solana_benchmark_runs').get()!.n, 1);
  // Simulate a run left active by a stopped process.
  saved.status = 'running';
  db.prepare('UPDATE solana_benchmark_runs SET report_json = ?').run(JSON.stringify(saved));
  assert.equal(readBenchmarkRun(db)!.status, 'interrupted');
  assert.equal(readBenchmarkRun(db)!.completed, 0);
  db.close();
});

test('block errors become explicit provider failures', async () => {
  const rpc = new SolanaRpcClient({ transport: async (_url, init) => {
    const { method } = JSON.parse(String(init.body));
    if (method === 'getBlockTime') throw new Error('Block unavailable');
    return new Response(JSON.stringify({ result: method === 'getTransaction' ? { slot: 1, blockTime: 100 } : [2] }));
  } });
  const result = await new SolanaDelayedPriceProvider(rpc).findDelayedPrice({ originalSignature: 'test', tokenMint: 'mint', copyDelaySeconds: 10, maxWindowSeconds: 30 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.failure.message, /Block unavailable/);
});

test('RPC request budget prevents unbounded scans', async () => {
  const rpc = new SolanaRpcClient({ maxCalls: 1, transport: async () => new Response(JSON.stringify({ result: 1 })) });
  await rpc.getFirstAvailableBlock();
  await assert.rejects(() => rpc.getFirstAvailableBlock(), /budget reached/);
});
