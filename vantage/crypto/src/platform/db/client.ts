import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './schema.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
// Walk from src/dist/src/platform/db back to the crypto project root. Keeping
// this identical for tsx development and compiled production code prevents
// each mode from silently opening a different SQLite database.
const sourceOrDistRoot = path.resolve(moduleDirectory, '..', '..', '..');
const projectRoot =
  path.basename(sourceOrDistRoot) === 'dist' ? path.dirname(sourceOrDistRoot) : sourceOrDistRoot;

export const defaultDatabasePath = path.join(projectRoot, '.data', 'crypto-research.sqlite');
export const defaultArchivePath = path.join(projectRoot, '.data', 'archive');

export const openDatabase = (databasePath = defaultDatabasePath): DatabaseSync => {
  if (databasePath !== ':memory:') {
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }

  const database = new DatabaseSync(databasePath);
  // Pattern Discovery runs in a separate process so the API can continue serving status.
  // WAL lets that worker read evidence while the API persists small progress/cache updates.
  if (databasePath !== ':memory:') database.exec('PRAGMA journal_mode = WAL;');
  database.exec('PRAGMA busy_timeout = 5000;');
  database.exec('PRAGMA synchronous = FULL;');
  applyMigrations(database);
  return database;
};
