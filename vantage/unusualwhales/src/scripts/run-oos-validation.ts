import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createDatabase } from '../db/client.js';
import { runOutOfSampleValidation, type OosValidationConfig } from '../research/oos-validation.js';

const configPath = process.argv[2];
if (!configPath) {
  throw new Error('Usage: npm run validate:oos -- <frozen-config.json>');
}

const resolvedConfigPath = path.resolve(process.cwd(), configPath);
const config = JSON.parse(readFileSync(resolvedConfigPath, 'utf8')) as OosValidationConfig;
const database = createDatabase();
try {
  const report = runOutOfSampleValidation(database, config);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  database.close();
}
