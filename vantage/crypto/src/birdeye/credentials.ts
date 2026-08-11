import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const findProjectRoot = (): string => {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, 'package.json'))) return current;
    current = path.dirname(current);
  }
  return process.cwd();
};
export const birdeyeKeyPath = path.join(findProjectRoot(), '.secrets', 'birdeye', 'api-key.txt');
export const readBirdeyeApiKey = (): string | null => existsSync(birdeyeKeyPath) ? readFileSync(birdeyeKeyPath, 'utf8').trim() || null : null;
