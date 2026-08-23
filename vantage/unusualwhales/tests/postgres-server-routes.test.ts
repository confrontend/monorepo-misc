import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import test from 'node:test';
import pg from 'pg';

const { Pool } = pg;
const root = process.cwd();
const serverSource = readFileSync(path.join(root, 'src/scripts/server.ts'), 'utf8');
const postgresUrl = process.env.POSTGRES_URL ?? 'postgres://unusualwhales:unusualwhales-local-only@127.0.0.1:54329/unusualwhales';

const routeBlock = (start: string, end: string) => {
  const startIndex = serverSource.indexOf(start);
  const endIndex = serverSource.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing route marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing route end marker: ${end}`);
  return serverSource.slice(startIndex, endIndex);
};

test('PostgreSQL sync route contract runs market refresh and outcomes after sweeps', () => {
  const block = routeBlock("requestUrl.pathname === '/api/signals/sync'", "requestUrl.pathname === '/api/signals/backfill'");
  assert.match(block, /syncRecentSweepsToPostgres\(pool, 'call'\)/);
  assert.match(block, /syncRecentSweepsToPostgres\(pool, 'put'\)/);
  assert.match(block, /refreshMarketPricesPostgres\(pool\)/);
  assert.match(block, /refreshPostgresOutcomes\(pool, \{ jobId \}\)/);
  assert.ok(block.indexOf('refreshMarketPricesPostgres(pool)') < block.indexOf('refreshPostgresOutcomes(pool, { jobId })'));
  assert.match(block, /backend: 'postgres'/);
});

test('PostgreSQL backfill, resume, cancel, diagnostics, and health route contracts are explicit', () => {
  const backfill = routeBlock("requestUrl.pathname === '/api/signals/backfill'", "requestUrl.pathname === '/api/signals/backfill/resume'");
  assert.match(backfill, /startPostgresOperation\(pool, 'signals\.historical_backfill'/);
  assert.match(backfill, /response\.writeHead\(202/);
  assert.match(backfill, /operationId: jobId/);
  assert.match(backfill, /new Worker\(workerUrl\('postgres-backfill-worker'\)/);

  const resume = routeBlock("requestUrl.pathname === '/api/signals/backfill/resume'", "requestUrl.pathname === '/api/signals/backfill/cancel'");
  assert.match(resume, /status IN \('failed','retrying','cancelled'\)/);
  assert.match(resume, /resumed: true/);
  assert.match(resume, /response\.writeHead\(202/);

  const cancel = routeBlock("requestUrl.pathname === '/api/signals/backfill/cancel'", "const relativePath");
  assert.match(cancel, /cancelPostgresOperation\(pool, activePostgresJobId\)/);
  assert.match(cancel, /cancelled: false/);
  assert.match(cancel, /backend: 'postgres'/);

  const diagnostics = routeBlock("requestUrl.pathname === '/api/diagnostics'", "requestUrl.pathname === '/api/provider/unusual-whales/probe'");
  assert.match(diagnostics, /FROM uw_job_runs ORDER BY id DESC LIMIT 20/);
  assert.match(diagnostics, /recentOperations: operations\.rows/);
  assert.match(diagnostics, /backend: 'postgres'/);

  const health = routeBlock("requestUrl.pathname === '/api/health'", "requestUrl.pathname === '/api/diagnostics'");
  assert.match(health, /databaseBackend: \{ \.\.\.databaseBackendStatus\(\), postgres: await checkPostgresReadiness\(\) \}/);
});

const canReachPostgres = async () => {
  const pool = new Pool({ connectionString: postgresUrl, connectionTimeoutMillis: 500 });
  try {
    await pool.query('SELECT 1');
    return pool;
  } catch {
    await pool.end().catch(() => undefined);
    return null;
  }
};

const waitForServer = async (child: ChildProcess, port: number) => {
  const deadline = Date.now() + 8_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.status === 200) return;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (child.exitCode !== null) break;
  }
  throw new Error(`server did not become ready: ${lastError instanceof Error ? lastError.message : 'unknown error'}`);
};

const postJson = async (port: number, route: string, body: Record<string, unknown>) => {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { response, body: await response.json() as Record<string, unknown> };
};

const withLivePostgresServer = async (run: (pool: pg.Pool, port: number) => Promise<void>) => {
  if (process.env.RUN_POSTGRES_ROUTE_INTEGRATION !== '1') return false;
  const pool = await canReachPostgres();
  if (!pool) return false;
  const directory = mkdtempSync(path.join(os.tmpdir(), 'uw-route-contract-'));
  const port = 4373 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['dist/src/scripts/server.js'], {
    cwd: root,
    env: { ...process.env, API_PORT: String(port), POSTGRES_URL: postgresUrl, UNUSUAL_WHALES_DB_BACKEND: 'postgres', UNUSUAL_WHALES_DB_PATH: path.join(directory, 'unused.sqlite') },
    stdio: 'ignore',
  });
  try {
    await waitForServer(child, port);
    await run(pool, port);
    return true;
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => undefined);
    await pool.end();
    rmSync(directory, { recursive: true, force: true });
  }
};

test('PostgreSQL API exposes backend status and recent durable operations', async (t) => {
  const ran = await withLivePostgresServer(async (pool, port) => {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json() as Promise<Record<string, any>>);
    assert.equal(health.databaseBackend.configured, 'postgres');
    assert.equal(health.databaseBackend.postgres.reachable, true);

    const fixturePool = new Pool({ connectionString: postgresUrl, connectionTimeoutMillis: 500 });
    const operation = await fixturePool.query(`INSERT INTO uw_job_runs (kind, status, payload, progress, created_at, started_at, updated_at) VALUES ('test.route_contract', 'completed', '{}', '{"stage":"test"}', now(), now(), now()) RETURNING id`);
    // Release the fixture connection before asking the server's single-connection
    // PostgreSQL pool to execute its diagnostics fan-out.
    await fixturePool.end();
    const diagnostics = await fetch(`http://127.0.0.1:${port}/api/diagnostics`).then((response) => response.json() as Promise<Record<string, any>>);
    assert.equal(diagnostics.database.backend, 'postgres');
    assert.ok(diagnostics.recentOperations.some((row: Record<string, unknown>) => row.id === operation.rows[0].id));
  });
  if (!ran) t.skip('PostgreSQL fixture is not reachable');
});

test('PostgreSQL backfill returns 202 and creates a durable job; cancel reports its state', async (t) => {
  const ran = await withLivePostgresServer(async (pool, port) => {
    const { response, body } = await postJson(port, '/api/signals/backfill', { from: '2026-01-01', to: '2026-01-01', signalTypes: ['call_sweep'] });
    assert.equal(response.status, 202);
    assert.equal(body.backend, 'postgres');
    assert.equal(body.status, 'processing');
    const jobId = Number(body.operationId);
    assert.ok(jobId > 0);
    const job = await pool.query('SELECT kind, status, payload FROM uw_job_runs WHERE id=$1', [jobId]);
    assert.equal(job.rows[0]?.kind, 'signals.historical_backfill');
    assert.ok(['running', 'failed', 'completed', 'cancelled'].includes(String(job.rows[0]?.status)));

    const cancel = await postJson(port, '/api/signals/backfill/cancel', {});
    assert.equal(cancel.response.status, 200);
    assert.equal(cancel.body.backend, 'postgres');
    assert.ok(['cancelled', 'idle'].includes(String(cancel.body.status)));
  });
  if (!ran) t.skip('PostgreSQL fixture is not reachable');
});

test('PostgreSQL resume returns 202 from a durable failed request', async (t) => {
  const ran = await withLivePostgresServer(async (pool, port) => {
    await pool.query(`INSERT INTO uw_job_runs (kind, status, payload, progress, created_at, updated_at) VALUES ('signals.historical_backfill', 'failed', $1::jsonb, '{}', now(), now())`, [JSON.stringify({ from: '2026-01-02', to: '2026-01-02', signalTypes: ['put_sweep'] })]);
    const { response, body } = await postJson(port, '/api/signals/backfill/resume', {});
    assert.equal(response.status, 202);
    assert.equal(body.backend, 'postgres');
    assert.equal(body.resumed, true);
    assert.equal(body.status, 'processing');
  });
  if (!ran) t.skip('PostgreSQL fixture is not reachable');
});
