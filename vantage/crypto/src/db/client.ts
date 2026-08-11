import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './schema.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceOrDistRoot = path.resolve(moduleDirectory, '..', '..');
const projectRoot = path.basename(sourceOrDistRoot) === 'dist'
  ? path.dirname(sourceOrDistRoot)
  : sourceOrDistRoot;

export const defaultDatabasePath = path.join(projectRoot, '.data', 'crypto-research.sqlite');
export const defaultArchivePath = path.join(projectRoot, '.data', 'archive');

export const openDatabase = (databasePath = defaultDatabasePath): DatabaseSync => {
  if (databasePath !== ':memory:') {
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }

  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA journal_mode = TRUNCATE;');
  database.exec('PRAGMA synchronous = FULL;');
  applyMigrations(database);
  return database;
};
