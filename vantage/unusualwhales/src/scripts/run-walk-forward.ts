import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createDatabase } from '../db/client.js';
import { runWalkForwardValidation, type WalkForwardConfig } from '../research/walk-forward.js';

const configPath = process.argv[2];
if (!configPath) throw new Error('Usage: npm run validate:walk-forward -- <frozen-config.json>');
const config = JSON.parse(readFileSync(path.resolve(process.cwd(), configPath), 'utf8')) as WalkForwardConfig;
const database = createDatabase();
try { process.stdout.write(`${JSON.stringify(runWalkForwardValidation(database, config), null, 2)}\n`); }
finally { database.close(); }
