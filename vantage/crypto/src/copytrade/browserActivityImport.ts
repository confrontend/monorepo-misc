import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { zipStored } from '../dune/ingest/archive.js';
import { storeActivityPage } from './screening/fetch.js';

type InvestigationSample = {
  observedAt?: unknown;
  pageUrl?: unknown;
  requestPayload?: unknown;
  responsePayload?: unknown;
  status?: unknown;
};
type InvestigationEndpoint = { url?: unknown; samples?: unknown };
type InvestigationExport = { source?: unknown; endpoints?: unknown };

export type BrowserActivityImportResult = {
  imported: number;
  duplicates: number;
  malformed: number;
  activityEndpoints: number;
  samples: number;
  archivePath: string | null;
  archiveSha256: string | null;
};

const ACTIVITY_PATH = '/vas/api/v1/wallet_activity/sol';
const asObject = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);
const projectRoot = (() => {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, 'package.json'))) return current;
    current = path.dirname(current);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
})();

/** The extension caps investigation response bodies, so a JSON response may end mid-array. */
const parseActivities = (payload: string): Record<string, unknown>[] => {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const activities = asObject(parsed.data).activities;
    return Array.isArray(activities) ? activities.map(asObject) : [];
  } catch { /* salvage complete activity objects from a truncated response below */ }
  const arrayStart = payload.indexOf('[', payload.indexOf('"activities"'));
  if (arrayStart < 0) return [];
  const found: Record<string, unknown>[] = [];
  let cursor = arrayStart + 1;
  while (cursor < payload.length) {
    while (cursor < payload.length && /[\s,]/.test(payload[cursor])) cursor += 1;
    if (payload[cursor] === ']') break;
    if (payload[cursor] !== '{') break;
    const start = cursor;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (; cursor < payload.length; cursor += 1) {
      const char = payload[cursor];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
      if (char === '"') { quoted = true; continue; }
      if (char === '{') depth += 1;
      if (char === '}') { depth -= 1; if (depth === 0) { cursor += 1; break; } }
    }
    if (depth !== 0) break;
    try { found.push(JSON.parse(payload.slice(start, cursor)) as Record<string, unknown>); } catch { break; }
  }
  return found;
};

/**
 * Imports raw wallet_activity responses captured by the investigation extension. The original
 * file is archived unchanged; normalized trades use the existing append-only dedup path. Source
 * URL/page/capture time are carried inside each row's raw payload because the V1 trade schema
 * predates browser provenance columns.
 */
export const importBrowserWalletActivity = (
  database: DatabaseSync, sourceName: string, rawFileContent: string, now = new Date(),
): BrowserActivityImportResult => {
  const parsed = JSON.parse(rawFileContent) as InvestigationExport;
  if (parsed.source !== 'gmgn-browser-extension-investigation' || !Array.isArray(parsed.endpoints)) {
    throw new Error('Investigation export must have source gmgn-browser-extension-investigation and an endpoints array.');
  }

  let imported = 0;
  let duplicates = 0;
  let malformed = 0;
  let activityEndpoints = 0;
  let samples = 0;
  for (const endpointValue of parsed.endpoints) {
    const endpoint = asObject(endpointValue) as InvestigationEndpoint;
    const url = typeof endpoint.url === 'string' ? endpoint.url : '';
    if (!url.includes(ACTIVITY_PATH) || !Array.isArray(endpoint.samples)) continue;
    activityEndpoints += 1;
    for (const sampleValue of endpoint.samples) {
      samples += 1;
      const sample = asObject(sampleValue) as InvestigationSample;
      const capturedAt = typeof sample.observedAt === 'string' ? sample.observedAt : now.toISOString();
      const payload = typeof sample.responsePayload === 'string' ? sample.responsePayload : '';
      const activities = parseActivities(payload);
      if (activities.length === 0 && payload.length > 0) malformed += 1;
      if (activities.length === 0) continue;
      const decorated = activities.map((activity) => ({
        ...asObject(activity),
        __gmgn_browser_provenance: {
          sourceName,
          sourceUrl: url,
          pageUrl: typeof sample.pageUrl === 'string' ? sample.pageUrl : null,
          capturedAt,
          responseStatus: typeof sample.status === 'number' ? sample.status : null,
        },
      }));
      const stored = storeActivityPage(database, decorated, { chain: 'sol', fetchedAt: capturedAt });
      imported += stored.inserted;
      duplicates += stored.duplicates;
      malformed += stored.malformed;
    }
  }

  const archiveDirectory = path.join(projectRoot, '.data', 'archive', 'copytrade-browser-activity');
  mkdirSync(archiveDirectory, { recursive: true });
  const sourceSha256 = createHash('sha256').update(rawFileContent, 'utf8').digest('hex');
  const archive = zipStored([
    { name: path.basename(sourceName), data: Buffer.from(rawFileContent, 'utf8') },
    { name: 'manifest.json', data: Buffer.from(JSON.stringify({ sourceName: path.basename(sourceName), sourceSha256, imported, duplicates, malformed, activityEndpoints, samples, archivedAt: now.toISOString() }, null, 2), 'utf8') },
  ]);
  const archiveSha256 = createHash('sha256').update(archive).digest('hex');
  const archivePath = path.join(archiveDirectory, `wallet-activity-${sourceSha256.slice(0, 16)}.zip`);
  if (!existsSync(archivePath)) writeFileSync(archivePath, archive, { flag: 'wx' });
  return { imported, duplicates, malformed, activityEndpoints, samples, archivePath, archiveSha256 };
};
