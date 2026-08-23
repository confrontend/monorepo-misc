import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { zipStored } from '../../dune/ingest/archive.js';
import { storeGmgnSignal } from './ingest.js';
import { storeRadarSnapshot } from '../radar.js';
import { storeWalletRankSnapshot } from '../walletRank.js';
import { storeSmartMoneyWalletStats } from '../smartmoney.js';
import { storeTwitterMessages } from '../twitter.js';
import { redactAccountIdentifiers } from '../../platform/security/redaction.js';
import { findProjectRoot } from '../../platform/archive.js';

type BrowserCapture = { capturedAt: string; requestPath?: string; requestQuery?: Record<string, unknown>; status: number; responseBody?: { channel?: unknown; data?: unknown } };
type BrowserCoverageWindow = { startedAt: string; endedAt?: string | null; lastHeartbeatAt: string; closedReason?: string | null };
type BrowserExport = { formatVersion: number; exportedAt: string; extensionVersion: string; source: string; captures: BrowserCapture[]; coverageWindows?: unknown };
type RawEndpointCounts = { imported: number; skipped: number };
type RawEndpointBreakdown = { radar: RawEndpointCounts; walletRank: RawEndpointCounts; smartMoney: RawEndpointCounts; twitter: RawEndpointCounts };
export type BrowserImportResult = { batchId: number; imported: number; skipped: number; errors: number; issueBreakdown: Record<string, number>; otherCaptures: number; coverageWindowsImported: number; duplicateFile: boolean; archivePath: string | null; archiveSha256: string | null; rawEndpoints: RawEndpointBreakdown };

const emptyRawEndpointBreakdown = (): RawEndpointBreakdown => ({
  radar: { imported: 0, skipped: 0 },
  walletRank: { imported: 0, skipped: 0 },
  smartMoney: { imported: 0, skipped: 0 },
  twitter: { imported: 0, skipped: 0 },
});

// Must match the primary target in extension/content-main.js's TARGET_PATHS. The extension can
// (and now does) capture several other GMGN endpoints (price candles, trades, holder stats,
// smart-money wallet data) in the same export; only this endpoint's payloads are shaped like
// signal events, so only captures whose requestPath matches this are ever passed to
// storeGmgnSignal. Everything else is preserved in the raw archived export but not parsed here.
const SIGNAL_REQUEST_PATH = '/vas/api/v1/token-signal';
const ENDPOINT_PATHS = {
  radar: '/vas/api/v1/radar/detail',
  walletRank: '/api/v1/rank/sol/wallets/',
  smartMoney: '/defi/quotation/v1/smartmoney/sol/walletNew/',
  twitter: '/vas/api/v1/twitter/messages',
} as const;

// Real captures never carry a query string on requestPath (extension/content-main.js's emit()
// stores only the pathname there); research-relevant query params travel separately on
// requestQuery instead. Reading them from a parsed requestPath URL — which was the original,
// buggy approach — always silently returned null/undefined for every field, since there was
// never a query string to read in the first place.
const capturePath = (capture: BrowserCapture): string => typeof capture.requestPath === 'string' ? capture.requestPath : '';
const queryParam = (capture: BrowserCapture, key: string): string | null => {
  const value = capture.requestQuery?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
};
// gmgn.ai/api/v1/rank/sol/wallets/7d LOOKS like the window ("7d") is a path segment, but a real
// captured 30D selection confirmed the path stays /wallets/7d regardless of which window is
// actually selected in the UI — only orderby (e.g. "pnl_30d" vs "pnl_7d") actually changes.
// Deriving window from the path silently mislabeled every capture from this page as "7d"
// (progress.md 2026-08-17). orderby's trailing "<n><unit>" token is the real window.
const windowFromOrderby = (orderby: string | null): string | null => {
  if (!orderby) return null;
  const match = orderby.match(/_(\d+[a-z]+)$/i);
  return match ? match[1] : null;
};
const isSignalCapture = (capture: BrowserCapture): boolean => capture.responseBody?.channel === 'token_signal' || capturePath(capture).includes(SIGNAL_REQUEST_PATH);
const isRawEndpointCapture = (capture: BrowserCapture): boolean => {
  const path = capturePath(capture);
  return path.includes(ENDPOINT_PATHS.radar) || path.includes(ENDPOINT_PATHS.walletRank) || path.includes(ENDPOINT_PATHS.smartMoney) || path.includes(ENDPOINT_PATHS.twitter);
};
const isRecognizedCapture = (capture: BrowserCapture): boolean => isSignalCapture(capture) || isRawEndpointCapture(capture);

const archiveDirectory = path.join(findProjectRoot(), '.data', 'archive', 'gmgn-browser');
const asObject = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const mapWebSocketSignal = (item: unknown): Record<string, unknown> | null => {
  const event = asObject(item);
  if (event.sig_t === undefined) return null;
  const data = asObject(event.d);
  return {
    token_address: data.a,
    signal_type: event.sig_t,
    trigger_at: event.sig_t_at,
    market_cap: data.mc,
    id: event.sig_id,
    first_trigger_mc: event.sig_ftm,
    signal_times: event.sig_tms,
    signal_times_by_type: event.sig_tms_t,
    ath: event.sig_ath,
    cur_data: data,
    chain: event.c,
  };
};

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
  // Dedup identity is keyed off the ORIGINAL bytes so a redaction-pattern refinement later never
  // changes whether a re-uploaded file counts as a duplicate. Everything actually persisted or
  // archived below uses the redacted version instead — see redactAccountIdentifiers's own
  // comment for why account-identifying fields must never reach storage unredacted.
  const sourceSha256 = createHash('sha256').update(rawFileContent, 'utf8').digest('hex');
  const redactedFileContent = redactAccountIdentifiers(rawFileContent);
  const existing = database.prepare(`SELECT id, imported_count AS imported, skipped_count AS skipped, error_count AS errors, archive_path AS archivePath, archive_sha256 AS archiveSha256, raw_source AS rawSource, raw_endpoints_json AS rawEndpointsJson FROM gmgn_browser_import_batches WHERE source_sha256 = ?`).get(sourceSha256) as { id: number; imported: number; skipped: number; errors: number; archivePath: string | null; archiveSha256: string | null; rawSource: string; rawEndpointsJson: string | null } | undefined;
  if (existing) {
    const coverageWindowsImported = Number((database.prepare(`SELECT COUNT(*) AS count FROM gmgn_browser_coverage_windows WHERE batch_id = ?`).get(existing.id) as { count: number }).count);
    let otherCaptures = 0;
    try {
      const capturesArray = (JSON.parse(existing.rawSource) as Partial<BrowserExport>).captures;
      if (Array.isArray(capturesArray)) otherCaptures = capturesArray.filter((capture) => capture && !isRecognizedCapture(capture as BrowserCapture)).length;
    } catch { /* already validated on first import; a parse failure here would be unexpected, not fatal */ }
    // Persisted at the end of the original import (see the UPDATE below) so a duplicate-file
    // re-upload reports the same real breakdown, not a recomputed approximation. Batches
    // imported before this column existed fall back to an honest all-zero breakdown rather
    // than guessing.
    let rawEndpoints = emptyRawEndpointBreakdown();
    if (existing.rawEndpointsJson) { try { rawEndpoints = JSON.parse(existing.rawEndpointsJson) as RawEndpointBreakdown; } catch { /* fall back to empty */ } }
    return { batchId: existing.id, imported: existing.imported, skipped: existing.skipped, errors: existing.errors, issueBreakdown: {}, otherCaptures, coverageWindowsImported, duplicateFile: true, archivePath: existing.archivePath, archiveSha256: existing.archiveSha256, rawEndpoints };
  }

  const importedAt = now.toISOString();
  const batch = database.prepare(`INSERT INTO gmgn_browser_import_batches (source_path, source_sha256, raw_source, status, imported_at) VALUES (?, ?, ?, 'processing', ?)`).run(`ui-upload/${path.basename(sourceName)}`, sourceSha256, redactedFileContent, importedAt);
  const batchId = Number(batch.lastInsertRowid);
  let imported = 0;
  let skipped = 0;
  let errors = 0;
  let otherCaptures = 0;
  const rawEndpoints = emptyRawEndpointBreakdown();
  const issueBreakdown: Record<string, number> = {};
  const recordIssues = (issues: string[]) => { for (const issue of issues) issueBreakdown[issue] = (issueBreakdown[issue] ?? 0) + 1; };
  try {
    const parsed = JSON.parse(redactedFileContent) as Partial<BrowserExport>;
    if (parsed.formatVersion !== 1 || parsed.source !== 'gmgn-browser-extension' || !Array.isArray(parsed.captures)) throw new Error('Browser capture export must have source gmgn-browser-extension, formatVersion 1, and a captures array.');
    for (const capture of parsed.captures) {
      if (!capture || typeof capture.capturedAt !== 'string') { errors += 1; continue; }
      if (capture.responseBody?.channel === 'token_signal') {
        const events = Array.isArray(capture.responseBody.data) ? capture.responseBody.data : [];
        for (const event of events) {
          const mappedEvent = mapWebSocketSignal(event);
          if (!mappedEvent) continue;
          const result = storeGmgnSignal(database, mappedEvent, {
            capturedAt: new Date(capture.capturedAt),
            source: 'gmgn-browser-extension',
            chain: typeof mappedEvent.chain === 'string' ? mappedEvent.chain : 'sol',
          });
          if (result.duplicate) skipped += 1;
          else imported += 1;
          if (result.validationErrors.length > 0) errors += 1;
          recordIssues(result.validationErrors);
        }
        continue;
      }
      const requestPath = capturePath(capture);
      const responseBody = capture.responseBody;
      if (requestPath.includes(SIGNAL_REQUEST_PATH)) {
        const events = Array.isArray(responseBody?.data) ? responseBody.data : [];
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
          recordIssues(result.validationErrors);
        }
        continue;
      }
      if (isRawEndpointCapture(capture)) {
        try {
          const capturedAt = capture.capturedAt;
          if (requestPath.includes(ENDPOINT_PATHS.radar)) {
            const result = storeRadarSnapshot(database, { chain: queryParam(capture, 'chain'), period: queryParam(capture, 'period'), category: queryParam(capture, 'type'), capturedAt, rawPayload: responseBody });
            rawEndpoints.radar.imported += result.inserted; rawEndpoints.radar.skipped += result.skipped;
          } else if (requestPath.includes(ENDPOINT_PATHS.walletRank)) {
            const orderby = queryParam(capture, 'orderby');
            const result = storeWalletRankSnapshot(database, {
              window: windowFromOrderby(orderby), orderby,
              capturedAt, rawPayload: responseBody, requestPath, requestQuery: capture.requestQuery ?? {},
            });
            rawEndpoints.walletRank.imported += result.inserted; rawEndpoints.walletRank.skipped += result.skipped;
          } else if (requestPath.includes(ENDPOINT_PATHS.smartMoney)) {
            const match = requestPath.match(/\/smartmoney\/([^/]+)\/walletNew\/([^/]+)/);
            if (!match) throw new Error('GMGN smart-money URL is missing chain or wallet address.');
            const result = storeSmartMoneyWalletStats(database, { chain: match[1], walletAddress: decodeURIComponent(match[2]), capturedAt, rawPayload: responseBody });
            rawEndpoints.smartMoney.imported += result.inserted; rawEndpoints.smartMoney.skipped += result.skipped;
          } else {
            const result = storeTwitterMessages(database, { hasToken: queryParam(capture, 'has_token'), capturedAt, rawPayload: responseBody });
            rawEndpoints.twitter.imported += result.inserted; rawEndpoints.twitter.skipped += result.skipped;
            if (result.issues.length > 0) { errors += result.issues.length; recordIssues(result.issues); }
          }
        } catch (error) {
          errors += 1;
          recordIssues([error instanceof Error ? error.message : String(error)]);
        }
        continue;
      }
      otherCaptures += 1;
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
    const manifest = JSON.stringify({ batchId, sourceName: path.basename(sourceName), sourceSha256, imported, skipped, errors, otherCaptures, rawEndpoints, coverageWindows: coverageWindows.length, archivedAt: new Date().toISOString() }, null, 2);
    const archive = zipStored([{ name: path.basename(sourceName), data: Buffer.from(redactedFileContent, 'utf8') }, { name: 'manifest.json', data: Buffer.from(manifest, 'utf8') }]);
    const archiveSha256 = createHash('sha256').update(archive).digest('hex');
    const archivePath = path.join(archiveDirectory, `gmgn-browser-batch-${batchId}-${sourceSha256.slice(0, 16)}.zip`);
    if (!existsSync(archivePath)) writeFileSync(archivePath, archive, { flag: 'wx' });
    const completedAt = new Date().toISOString();
    database.prepare(`UPDATE gmgn_browser_import_batches SET status = 'completed', imported_count = ?, skipped_count = ?, error_count = ?, completed_at = ?, archive_path = ?, archive_sha256 = ?, archived_at = ?, raw_endpoints_json = ? WHERE id = ?`).run(imported, skipped, errors, completedAt, archivePath, archiveSha256, completedAt, JSON.stringify(rawEndpoints), batchId);
    return { batchId, imported, skipped, errors, issueBreakdown, otherCaptures, coverageWindowsImported: coverageWindows.length, duplicateFile: false, archivePath, archiveSha256, rawEndpoints };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    database.prepare(`UPDATE gmgn_browser_import_batches SET status = 'failed', error = ?, error_count = ?, completed_at = ? WHERE id = ?`).run(message, errors + 1, new Date().toISOString(), batchId);
    throw error;
  }
};
