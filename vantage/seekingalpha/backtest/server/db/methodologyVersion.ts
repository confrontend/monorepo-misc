import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This file lives at <project>/server/db/methodologyVersion.ts, so the project root is three levels up.
const projectRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const dataTsPath = path.join(projectRoot, 'src', 'data.ts');

// Auto-derived rather than a manually bumped constant: data.ts's calculation logic has changed
// repeatedly during this project's development (forward-match tolerance, the rating whitelist,
// the whole event-based call test) and a hand-maintained version number would be easy to forget to
// bump. Hashing the file's own source means any calculation-affecting edit is automatically
// reflected, the same way buildFingerprint() in vite.config.ts already hashes the input data files
// instead of trusting anyone to flag when they change.
let cachedVersion: string | null = null;

export const getMethodologyVersion = (): string => {
  if (cachedVersion) return cachedVersion;
  const source = readFileSync(dataTsPath, 'utf8');
  cachedVersion = createHash('sha1').update(source).digest('hex').slice(0, 16);
  return cachedVersion;
};

// Call this if data.ts is edited without restarting the process (e.g. under Vite's dev-server
// polling, which reloads the module but not this one) — keeps the hash in sync with disk.
export const invalidateMethodologyVersionCache = (): void => {
  cachedVersion = null;
};
