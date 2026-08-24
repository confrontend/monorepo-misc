import { ESLint } from 'eslint';
import path from 'node:path';

const eslint = new ESLint();
const results = await eslint.lintFiles(['.']);

let errors = 0;
let warnings = 0;
let filesWithFindings = 0;

for (const result of results
  .filter((entry) => entry.messages.length > 0)
  .sort((a, b) => a.filePath.localeCompare(b.filePath))) {
  filesWithFindings += 1;
  const file = path.relative(process.cwd(), result.filePath).replaceAll('\\', '/');
  console.log(`\n${file}`);

  for (const message of [...result.messages].sort(
    (a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0),
  )) {
    const severity = message.severity === 2 ? 'error' : 'warning';
    if (message.severity === 2) errors += 1;
    else warnings += 1;

    const location = `${message.line ?? 0}:${message.column ?? 0}`;
    const rule = message.ruleId ? ` (${message.ruleId})` : '';
    console.log(`  ${location} ${severity}: ${message.message}${rule}`);
  }
}

console.log(`\n${errors} errors, ${warnings} warnings in ${filesWithFindings} files`);
process.exitCode = errors > 0 ? 1 : 0;
