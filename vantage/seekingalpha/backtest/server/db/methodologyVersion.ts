import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This file lives at <project>/server/db/methodologyVersion.ts, so the project root is three levels up.
const projectRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const dataTsPath = path.join(projectRoot, 'src', 'data.ts');
// runs.ts decides which parameter grid gets computed and how each row is written to SQLite -- a
// change there (e.g. adding a policy to the persisted grid, or changing which fields are stored)
// is just as much a "the stored numbers no longer mean what they used to" event as a data.ts edit,
// so it has to be part of the same identity, not just the calculation file.
const runsTsPath = path.join(projectRoot, 'server', 'db', 'runs.ts');

// Auto-derived rather than a manually bumped constant: this logic has changed repeatedly during
// this project's development (forward-match tolerance, the rating whitelist, the whole event-based
// call test) and a hand-maintained version number would be easy to forget to bump. Hashing the
// files' own source means any calculation- or persistence-affecting edit is automatically
// reflected, the same way buildFingerprint() in vite.config.ts already hashes the input data files
// instead of trusting anyone to flag when they change.
let cachedVersion: string | null = null;

export const getMethodologyVersion = (): string => {
  if (cachedVersion) return cachedVersion;
  const dataSource = readFileSync(dataTsPath, 'utf8');
  const runsSource = readFileSync(runsTsPath, 'utf8');
  cachedVersion = createHash('sha1').update(dataSource).update('\n---\n').update(runsSource).digest('hex').slice(0, 16);
  return cachedVersion;
};

// Call this whenever data.ts or runs.ts change on disk without a process restart (vite.config.ts's
// dev-server file watcher calls this) -- otherwise this module's own cache would keep returning a
// stale hash for the rest of the process's life even after the underlying files changed.
export const invalidateMethodologyVersionCache = (): void => {
  cachedVersion = null;
};
