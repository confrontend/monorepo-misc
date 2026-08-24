import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZipEntries } from '../dune/ingest/archive.js';
import { redactSensitiveText } from '../platform/security/redaction.js';

const findProjectRoot = (): string => {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, 'package.json'))) return current;
    current = path.dirname(current);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
};
const projectRoot = findProjectRoot();
export const gmgnArchiveDirectory = path.join(projectRoot, '.data', 'archive', 'gmgn');

const FILENAME_PATTERN = /^gmgn-capture-.+-([0-9a-f]{16})\.zip$/;

export interface GmgnArchiveManifest {
  capturedAt: string | null;
  eventCount: number | null;
  stored: number | null;
  repeated: number | null;
  validationErrors: number | null;
}

export interface GmgnArchiveSummary {
  fileName: string;
  archiveBytes: number;
  modifiedAt: string;
  archiveSha256: string;
  expectedShaPrefix: string | null;
  hashVerified: boolean;
  structureVerified: boolean;
  eventCountVerified: boolean | null;
  verified: boolean;
  verificationError: string | null;
  entryNames: string[];
  manifest: GmgnArchiveManifest | null;
}

const parseManifest = (raw: string): GmgnArchiveManifest => {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    capturedAt: typeof parsed.capturedAt === 'string' ? parsed.capturedAt : null,
    eventCount: typeof parsed.eventCount === 'number' ? parsed.eventCount : null,
    stored: typeof parsed.stored === 'number' ? parsed.stored : null,
    repeated: typeof parsed.repeated === 'number' ? parsed.repeated : null,
    validationErrors: typeof parsed.validationErrors === 'number' ? parsed.validationErrors : null,
  };
};

// Mirrors gmgn/capture.ts's own event-extraction shape, so a re-derived count can be
// compared against the manifest's recorded eventCount without trusting the manifest alone.
const extractEventCount = (value: unknown): number | null => {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.data)) return record.data.length;
    if (
      record.data &&
      typeof record.data === 'object' &&
      Array.isArray((record.data as Record<string, unknown>).list)
    ) {
      return ((record.data as Record<string, unknown>).list as unknown[]).length;
    }
    if (Array.isArray(record.list)) return record.list.length;
  }
  return null;
};

const readOneArchive = (directory: string, fileName: string): GmgnArchiveSummary => {
  const archivePath = path.join(directory, fileName);
  const bytes = readFileSync(archivePath);
  const stats = statSync(archivePath);
  const archiveSha256 = createHash('sha256').update(bytes).digest('hex');
  const nameMatch = FILENAME_PATTERN.exec(fileName);
  const expectedShaPrefix = nameMatch ? nameMatch[1] : null;
  const hashVerified = expectedShaPrefix !== null && archiveSha256.startsWith(expectedShaPrefix);

  let structureVerified = false;
  let eventCountVerified: boolean | null = null;
  let verificationError: string | null = null;
  let manifest: GmgnArchiveManifest | null = null;
  let entryNames: string[] = [];

  try {
    const entries = readZipEntries(bytes);
    entryNames = entries.map((entry) => entry.name);
    const manifestEntry = entries.find((entry) => entry.name === 'manifest.json');
    if (!manifestEntry) throw new Error('Archive does not contain manifest.json.');
    manifest = parseManifest(manifestEntry.data.toString('utf8'));

    const responseEntry = entries.find((entry) => entry.name === 'gmgn-signal-response.json');
    if (!responseEntry) throw new Error('Archive does not contain gmgn-signal-response.json.');
    structureVerified = true;

    // The raw response is parsed only to recompute an event count for cross-checking —
    // its contents are never returned to a caller of listGmgnArchives.
    try {
      const actualCount = extractEventCount(JSON.parse(responseEntry.data.toString('utf8')));
      eventCountVerified =
        actualCount !== null && manifest.eventCount !== null
          ? actualCount === manifest.eventCount
          : null;
    } catch {
      eventCountVerified = null;
    }
  } catch (error) {
    verificationError = redactSensitiveText(error instanceof Error ? error.message : String(error));
  }

  return {
    fileName,
    archiveBytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    archiveSha256,
    expectedShaPrefix,
    hashVerified,
    structureVerified,
    eventCountVerified,
    verified: hashVerified && structureVerified && eventCountVerified !== false,
    verificationError,
    entryNames,
    manifest,
  };
};

/** Lists locally archived GMGN capture ZIPs with a re-verified hash, structure, and safe manifest. Never returns raw captured events or credentials. */
export const listGmgnArchives = (
  directory: string = gmgnArchiveDirectory,
): GmgnArchiveSummary[] => {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.zip'))
    .sort((a, b) => b.localeCompare(a))
    .map((fileName) => readOneArchive(directory, fileName));
};
