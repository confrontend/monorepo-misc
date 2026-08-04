import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySchema } from './schema.js';

// node:sqlite (built into Node 22+, no --experimental flag required as of Node 22.5) rather than
// better-sqlite3: better-sqlite3 is a native module that has to be compiled per-platform, and this
// project is developed across a Linux sandbox and a Windows machine — a native binary built in one
// environment would not load in the other. node:sqlite ships inside Node itself, so there is
// nothing to compile and nothing that can mismatch between machines.
// This file lives at <project>/server/db/client.ts, so the project root is three levels up.
const projectRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const dataDir = path.join(projectRoot, '.data');
const dbPath = path.join(dataDir, 'analysis.sqlite');

let db: DatabaseSync | null = null;

export const getDb = (): DatabaseSync => {
  if (db) return db;
  mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(dbPath);
  applySchema(db);
  return db;
};
