import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Walks up from this file until it finds the package.json that marks the project root, falling
 *  back to cwd. Previously copy-pasted as an identical IIFE in every module that archives raw
 *  Dune responses (dune/outcomes.ts, copytrade/simulation/copySimulationDune.ts,
 *  copytrade/leaderboard/topCallerCheckpoints.ts). */
export const findProjectRoot = (): string => {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, 'package.json'))) return current;
    current = path.dirname(current);
  }
  return process.cwd();
};

/** Content-addressed archive write, shared by every raw-Dune-response archiver in this project:
 *  hash the payload, write once under `.data/archive/<subdir>/<filenamePrefix>-<runId>-<sha
 *  prefix>.json`, and skip the write if that exact content is already archived (`wx` flag —
 *  never overwrites, never partially writes). Previously implemented identically three times
 *  (dune/outcomes.ts, copytrade/simulation/copySimulationDune.ts,
 *  copytrade/leaderboard/topCallerCheckpoints.ts), differing only in subdir/prefix and the
 *  caller-assembled payload shape — those differences stay with the caller. */
export const archiveJsonWithHash = (subdir: string, filenamePrefix: string, runId: number, payload: unknown): { archivePath: string; sha256: string } => {
  const buffer = Buffer.from(JSON.stringify(payload, null, 2));
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const dir = path.join(findProjectRoot(), '.data', 'archive', subdir);
  mkdirSync(dir, { recursive: true });
  const archivePath = path.join(dir, `${filenamePrefix}-${runId}-${sha256.slice(0, 16)}.json`);
  if (!existsSync(archivePath)) writeFileSync(archivePath, buffer, { flag: 'wx' });
  return { archivePath, sha256 };
};
