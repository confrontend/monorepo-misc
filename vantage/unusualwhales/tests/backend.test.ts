import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredDatabaseBackend, databaseBackendStatus } from '../src/db/backend.js';

test('database backend defaults to the explicit SQLite implementation', () => {
  const previous = process.env.UNUSUAL_WHALES_DB_BACKEND;
  delete process.env.UNUSUAL_WHALES_DB_BACKEND;
  try {
    assert.equal(configuredDatabaseBackend(), 'sqlite');
    assert.equal(databaseBackendStatus().cutoverReady, false);
  } finally {
    if (previous === undefined) delete process.env.UNUSUAL_WHALES_DB_BACKEND;
    else process.env.UNUSUAL_WHALES_DB_BACKEND = previous;
  }
});

test('database backend accepts PostgreSQL only as an explicit configuration value', () => {
  const previous = process.env.UNUSUAL_WHALES_DB_BACKEND;
  process.env.UNUSUAL_WHALES_DB_BACKEND = 'postgres';
  try { assert.equal(configuredDatabaseBackend(), 'postgres'); }
  finally {
    if (previous === undefined) delete process.env.UNUSUAL_WHALES_DB_BACKEND;
    else process.env.UNUSUAL_WHALES_DB_BACKEND = previous;
  }
});
