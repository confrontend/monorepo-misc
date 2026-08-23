import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { zipStored } from '../../dune/ingest/archive.js';
import { storeGmgnSignal } from './ingest.js';
import { completeGmgnPoll, failGmgnPoll, previousNewestTriggerAt, startGmgnPoll, triggerBounds } from './polls.js';
import { waitForGmgnRequest } from '../client/rateLimit.js';
import { findProjectRoot } from '../../platform/archive.js';

const execFileAsync = promisify(execFile);
const projectRoot = findProjectRoot();
const keyPath = path.join(projectRoot, '.secrets', 'gmgn', 'gmgn-api-key.txt');
const archiveDirectory = path.join(projectRoot, '.data', 'archive', 'gmgn');

export type GmgnCaptureResult = { pollId: number; captured: number; stored: number; repeated: number; errors: number; gapDetected: boolean; archivePath: string; archiveSha256: string; capturedAt: string };

const extractEvents = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.data)) return record.data;
    if (record.data && typeof record.data === 'object' && Array.isArray((record.data as Record<string, unknown>).list)) return (record.data as Record<string, unknown>).list as unknown[];
    if (Array.isArray(record.list)) return record.list;
  }
  return [];
};

export const captureGmgnSignals = async (database: DatabaseSync): Promise<GmgnCaptureResult> => {
  const secret = existsSync(keyPath) ? readFileSync(keyPath, 'utf8').trim() : '';
  if (!secret) throw new Error('API key file is empty or missing.');
  const capturedAt = new Date().toISOString();
  const pollId = startGmgnPoll(database, { startedAt: capturedAt, source: 'gmgn-cli', chain: 'sol', cliVersion: '1.5.2' });
  try {
  const script = path.join(projectRoot, 'node_modules', 'gmgn-cli', 'dist', 'index.js');
  if (!existsSync(script)) throw new Error('Project-local gmgn-cli is unavailable. Run npm install first.');
  await waitForGmgnRequest();
  const { stdout } = await execFileAsync(process.execPath, [script, 'market', 'signal', '--chain', 'sol', '--raw'], {
    cwd: projectRoot, env: { ...process.env, GMGN_API_KEY: secret }, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
  });
  const parsed = JSON.parse(stdout) as unknown;
  const events = extractEvents(parsed);
  let errors = 0;
  let stored = 0;
  let repeated = 0;
  for (const event of events) {
    const result = storeGmgnSignal(database, event, { capturedAt: new Date(capturedAt), source: 'gmgn-cli', chain: 'sol' });
    if (result.duplicate) repeated += 1;
    else stored += 1;
    if (result.validationErrors.length > 0) errors += 1;
  }
  mkdirSync(archiveDirectory, { recursive: true });
  const source = Buffer.from(stdout, 'utf8');
  const manifest = Buffer.from(JSON.stringify({ capturedAt, eventCount: events.length, stored, repeated, validationErrors: errors }, null, 2));
  const archive = zipStored([{ name: 'gmgn-signal-response.json', data: source }, { name: 'manifest.json', data: manifest }]);
  const hash = createHash('sha256').update(archive).digest('hex');
  const archivePath = path.join(archiveDirectory, `gmgn-capture-${capturedAt.replace(/[:.]/g, '-')}-${hash.slice(0, 16)}.zip`);
  if (!existsSync(archivePath)) writeFileSync(archivePath, archive, { flag: 'wx' });
  const bounds = triggerBounds(events);
  const previousNewest = previousNewestTriggerAt(database);
  completeGmgnPoll(database, pollId, { completedAt: new Date().toISOString(), received: events.length, stored, repeated, errors, bounds, previousNewest, archivePath, archiveSha256: hash });
  return { pollId, captured: events.length, stored, repeated, errors, gapDetected: Boolean(previousNewest && bounds.oldestTriggerAt && bounds.oldestTriggerAt > previousNewest), archivePath, archiveSha256: hash, capturedAt };
  } catch (error) {
    failGmgnPoll(database, pollId, new Date().toISOString(), error);
    throw error;
  }
};
