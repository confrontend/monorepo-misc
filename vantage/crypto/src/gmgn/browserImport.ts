import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { zipStored } from '../dune/archive.js';
import { storeGmgnSignal } from './ingest.js';

type BrowserCapture = { capturedAt: string; requestPath: string; status: number; responseBody?: { data?: unknown[] } };
type BrowserCoverageWindow = { startedAt: string; endedAt?: string | null; lastHeartbeatAt: string; closedReason?: string | null };
type BrowserExport = { formatVersion: number; exportedAt: string; extensionVersion: string; source: string; captures: BrowserCapture[]; coverageWindows?: unknown };
export type BrowserImportResult = { batchId: number; imported: number; skipped: number; errors: number; coverageWindowsImported: number; duplicateFile: boolean; archivePath: string | null; archiveSha256: string | null };

const findProjectRoot = (): string => {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, 'package.json'))) return current;
    current = path.dirname(current);
  }
  return process.cwd();
};
const archiveDirectory = path.join(findProjectRoot(), '.data', 'archive', 'gmgn-browser');
const asObject = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

// Coverage windows are optional so older exports (captured before the extension recorded
// them) still import cleanly; a window only counts toward verified exposure when it parses.
const asCoverageWindow = (value: unknown): BrowserCoverageWindow | null => {
  const record = asObject(value);
  if (typeof record.startedAt !== 'string' || typeof record.lastHeartbeatAt !== 'string') return null;
  return {
    startedAt: record.startedAt,
    endedAt: typeof record.endedAt === 'string' ? record.endedAt : null,
    lastHeartbeatAt: record.lastHeartbeatAt,
    closedReason: typeof record.closedReason === 'string' ? record.closedReason : null,
  };
};

export const importGmgnBrowserCapture = (
  database: DatabaseSync,
  sourceName: string,
  rawFileContent: string,
  now = new Date(),
): BrowserImportResult => {
  const sourceSha256 = createHash('sha256').update(rawFileContent, 'utf8').digest('hex');
  const existing = database.prepare(`SELECT id, imported_count AS imported, skipped_count AS skipped, error_count AS errors, archive_path AS archivePath, archive_sha256 AS archiveSha256 FROM gmgn_browser_import_batches WHERE source_sha256 = ?`).get(sourceSha256) as { id: number; imported: number; skipped: number; errors: number; archivePath: string | null; archiveSha256: string | null } | undefined;
  if (existing) {
    const coverageWindowsImported = Number((database.prepare(`SELECT COUNT(*) AS count FROM gmgn_browser_coverage_windows WHERE batch_id = ?`).get(existing.id) as { count: number }).count);
    return { batchId: existing.id, imported: existing.imported, skipped: existing.skipped, errors: existing.errors, coverageWindowsImported, duplicateFile: true, archivePath: existing.archivePath, archiveSha256: existing.archiveSha256 };
  }

  const importedAt = now.toISOString();
  const batch = database.prepare(`INSERT INTO gmgn_browser_import_batches (source_path, source_sha256, raw_source, status, imported_at) VALUES (?, ?, ?, 'processing', ?)`).run(`ui-upload/${path.basename(sourceName)}`, sourceSha256, rawFileContent, importedAt);
  const batchId = Number(batch.lastInsertRowid);
  let imported = 0;
  let skipped = 0;
  let errors = 0;
  try {
    const parsed = JSON.parse(rawFileContent) as Partial<BrowserExport>;
    if (parsed.formatVersion !== 1 || parsed.source !== 'gmgn-browser-extension' || !Array.isArray(parsed.captures)) throw new Error('Browser capture export must have source gmgn-browser-extension, formatVersion 1, and a captures array.');
    for (const capture of parsed.captures) {
      if (!capture || typeof capture.capturedAt !== 'string') { errors += 1; continue; }
      const events = Array.isArray(capture.responseBody?.data) ? capture.responseBody.data : [];
      for (const event of events) {
        const eventObject = asObject(event);
        const data = asObject(eventObject.data);
        const result = storeGmgnSignal(database, event, {
          capturedAt: new Date(capture.capturedAt),
          source: 'gmgn-browser-extension',
          chain: typeof data.chain === 'string' ? data.chain : 'sol',
        });
        if (result.duplicate) skipped += 1;
        else imported += 1;
        if (result.validationErrors.length > 0) errors += 1;
      }
    }
    const coverageWindows = Array.isArray(parsed.coverageWindows)
      ? parsed.coverageWindows.map(asCoverageWindow).filter((window): window is BrowserCoverageWindow => window !== null)
      : [];
    const insertWindow = database.prepare(`
      INSERT INTO gmgn_browser_coverage_windows (batch_id, started_at, ended_at, last_heartbeat_at, closed_reason, imported_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const window of coverageWindows) {
      insertWindow.run(batchId, window.startedAt, window.endedAt ?? null, window.lastHeartbeatAt, window.closedReason ?? null, importedAt);
    }

    mkdirSync(archiveDirectory, { recursive: true });
    const manifest = JSON.stringify({ batchId, sourceName: path.basename(sourceName), sourceSha256, imported, skipped, errors, coverageWindows: coverageWindows.length, archivedAt: new Date().toISOString() }, null, 2);
    const archive = zipStored([{ name: path.basename(sourceName), data: Buffer.from(rawFileContent, 'utf8') }, { name: 'manifest.json', data: Buffer.from(manifest, 'utf8') }]);
    const archiveSha256 = createHash('sha256').update(archive).digest('hex');
    const archivePath = path.join(archiveDirectory, `gmgn-browser-batch-${batchId}-${sourceSha256.slice(0, 16)}.zip`);
    if (!existsSync(archivePath)) writeFileSync(archivePath, archive, { flag: 'wx' });
    const completedAt = new Date().toISOString();
    database.prepare(`UPDATE gmgn_browser_import_batches SET status = 'completed', imported_count = ?, skipped_count = ?, error_count = ?, completed_at = ?, archive_path = ?, archive_sha256 = ?, archived_at = ? WHERE id = ?`).run(imported, skipped, errors, completedAt, archivePath, archiveSha256, completedAt, batchId);
    return { batchId, imported, skipped, errors, coverageWindowsImported: coverageWindows.length, duplicateFile: false, archivePath, archiveSha256 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    database.prepare(`UPDATE gmgn_browser_import_batches SET status = 'failed', error = ?, error_count = ?, completed_at = ? WHERE id = ?`).run(message, errors + 1, new Date().toISOString(), batchId);
    throw error;
  }
};
