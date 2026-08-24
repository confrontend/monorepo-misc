import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = (() => {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, 'package.json'))) return current;
    current = path.dirname(current);
  }
  return process.cwd();
})();
export const duneApiKeyPath = path.join(projectRoot, '.secrets', 'dune', 'api-key.txt');
export const readDuneApiKey = (): string => {
  try {
    return readFileSync(duneApiKeyPath, 'utf8').trim();
  } catch {
    return '';
  }
};
