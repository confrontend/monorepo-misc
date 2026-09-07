import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMigrations } from '../src/platform/db/schema.js';
import { openDatabase } from '../src/platform/db/client.js';
import { createMinimumCapitalRoutes } from '../src/scripts/routes/minimumCapitalRoutes.js';

test('minimum capital route starts a local-only persisted run and exposes status', async () => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  const routes = createMinimumCapitalRoutes();
  let response: { status: number; value: unknown } | null = null;
  const request = {
    method: 'POST',
    url: new URL('http://localhost/api/copytrade/minimum-capital'),
    request: {} as never,
    readJsonBody: () => Promise.resolve({ walletAddresses: ['wallet-a'] }),
  };
  const handled = await routes[0](request, {
    database,
    respond: (status, value) => {
      response = { status, value };
    },
  });
  assert.equal(handled, true);
  const initialResponse = response as unknown as { status: number; value: unknown };
  assert.equal(initialResponse.status, 202);
  const runId = Number((initialResponse.value as { runId: number }).runId);
  assert.ok(runId > 0);

  await new Promise((resolve) => setTimeout(resolve, 20));
  response = null;
  await routes[1](
    {
      ...request,
      method: 'GET',
      url: new URL(`http://localhost/api/copytrade/minimum-capital/status?runId=${runId}`),
    },
    { database, respond: (status, value) => (response = { status, value }) },
  );
  const statusResponse = response as unknown as { status: number; value: unknown };
  assert.equal(statusResponse.status, 200);
  const status = statusResponse.value as {
    status: string;
    walletDone: number;
    results: Array<{ walletAddress: string; testedConfigurations: unknown[]; status: string }>;
  };
  assert.equal(status.status, 'completed');
  assert.equal(status.walletDone, 1);
  assert.equal(status.results[0]?.walletAddress, 'wallet-a');
  assert.equal(status.results[0]?.status, 'calculated');
  assert.ok(status.results[0]?.testedConfigurations.length);
});
