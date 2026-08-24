import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseCsv } from './csv.js';

export interface ImportLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface DuneImportSummary {
  batchId: number;
  sourcePath: string;
  sourceSha256: string;
  imported: number;
  skipped: number;
  errors: number;
  duplicateFile: boolean;
}

interface SourceRecord {
  rowNumber: number;
  value: Record<string, unknown>;
}

const defaultLogger: ImportLogger = {
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

const aliases = {
  tokenAddress: ['token_address', 'tokenAddress', 'token', 'mint', 'mint_address', 'address'],
  symbol: ['symbol', 'token_symbol'],
  firstTradeTime: ['first_trade_time', 'firstTradeTime', 'first_trade_at', 'block_time'],
  firstDex: ['first_dex', 'firstDex', 'dex'],
  firstTx: ['first_tx', 'firstTx', 'first_transaction', 'tx_hash', 'signature'],
} as const;

const pick = (record: Record<string, unknown>, names: readonly string[]): unknown => {
  for (const name of names) {
    if (Object.hasOwn(record, name)) return record[name];
  }
  return undefined;
};

const textOrNull = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const valueAsText = String(value).trim();
  return valueAsText.length > 0 ? valueAsText : null;
};

const parseJsonRecords = (rawSource: string): SourceRecord[] => {
  const parsed: unknown = JSON.parse(rawSource);
  let records: unknown;
  if (Array.isArray(parsed)) {
    records = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const object = parsed as Record<string, unknown>;
    records = object.data ?? object.rows ?? object.result;
  }
  if (!Array.isArray(records)) {
    throw new Error('JSON must be an array or an object containing a data, rows, or result array.');
  }
  return records.map((value, index) => ({
    rowNumber: index + 1,
    value:
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : { __raw_value: value },
  }));
};

const parseSourceRecords = (
  rawSource: string,
  extension: string,
): {
  format: 'csv' | 'json';
  records: SourceRecord[];
} => {
  if (extension === '.csv') {
    return { format: 'csv', records: parseCsv(rawSource) };
  }
  if (extension === '.json') {
    return { format: 'json', records: parseJsonRecords(rawSource) };
  }
  throw new Error(
    `Unsupported Dune export extension "${extension || '(none)'}"; expected .csv or .json.`,
  );
};

const insertAuditRecord = (
  database: DatabaseSync,
  batchId: number,
  record: SourceRecord,
  tokenAddress: string | null,
  status: 'imported' | 'skipped' | 'error',
  errors: string[],
  capturedAt: string,
): void => {
  database
    .prepare(
      `
    INSERT INTO dune_import_records
      (batch_id, row_number, token_address, status, errors, raw_payload, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      batchId,
      record.rowNumber,
      tokenAddress,
      status,
      JSON.stringify(errors),
      JSON.stringify(record.value),
      capturedAt,
    );
};

export const importDuneContent = (
  database: DatabaseSync,
  sourceName: string,
  rawSource: string,
  logger: ImportLogger = defaultLogger,
  now: () => Date = () => new Date(),
  tokenSource: string = 'dune',
): DuneImportSummary => {
  const sourceSha256 = createHash('sha256').update(rawSource, 'utf8').digest('hex');
  const sourcePath = sourceName;
  const priorBatch = database
    .prepare(
      `
    SELECT id, imported_count, skipped_count, error_count
    FROM dune_import_batches
    WHERE source_sha256 = ?
  `,
    )
    .get(sourceSha256) as
    | {
        id: number;
        imported_count: number;
        skipped_count: number;
        error_count: number;
      }
    | undefined;

  if (priorBatch) {
    const totalRecords =
      priorBatch.imported_count + priorBatch.skipped_count + priorBatch.error_count;
    const summary: DuneImportSummary = {
      batchId: priorBatch.id,
      sourcePath,
      sourceSha256,
      imported: 0,
      skipped: totalRecords,
      errors: 0,
      duplicateFile: true,
    };
    logger.info(`[dune] duplicate file skipped: imported=0 skipped=${summary.skipped} errors=0`);
    return summary;
  }

  const importedAt = now().toISOString();
  let format: 'csv' | 'json' | 'unknown' = 'unknown';
  let records: SourceRecord[];
  try {
    const parsed = parseSourceRecords(rawSource, path.extname(sourceName).toLowerCase());
    format = parsed.format;
    records = parsed.records;
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    const result = database
      .prepare(
        `
      INSERT INTO dune_import_batches
        (source_path, source_sha256, source_format, raw_source, status, error_count,
         imported_at, completed_at, error)
      VALUES (?, ?, ?, ?, 'failed', 1, ?, ?, ?)
    `,
      )
      .run(sourcePath, sourceSha256, format, rawSource, importedAt, importedAt, error);
    const batchId = Number(result.lastInsertRowid);
    database
      .prepare(
        `
      INSERT INTO dune_import_records
        (batch_id, row_number, status, errors, raw_payload, captured_at)
      VALUES (?, 0, 'error', ?, ?, ?)
    `,
      )
      .run(batchId, JSON.stringify([error]), JSON.stringify({ raw_source: rawSource }), importedAt);
    logger.error(`[dune] import failed: imported=0 skipped=0 errors=1 (${error})`);
    return {
      batchId,
      sourcePath,
      sourceSha256,
      imported: 0,
      skipped: 0,
      errors: 1,
      duplicateFile: false,
    };
  }

  const batchResult = database
    .prepare(
      `
    INSERT INTO dune_import_batches
      (source_path, source_sha256, source_format, raw_source, status, imported_at)
    VALUES (?, ?, ?, ?, 'processing', ?)
  `,
    )
    .run(sourcePath, sourceSha256, format, rawSource, importedAt);
  const batchId = Number(batchResult.lastInsertRowid);
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  const insertToken = database.prepare(`
    INSERT INTO tokens
      (token_address, symbol, first_trade_time, first_dex, first_tx, source,
       imported_at, raw_payload, validation_errors)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(token_address) DO NOTHING
  `);

  database.exec('BEGIN IMMEDIATE;');
  try {
    for (const record of records) {
      const rowErrors: string[] = [];
      const tokenAddress = textOrNull(pick(record.value, aliases.tokenAddress));
      const symbol = textOrNull(pick(record.value, aliases.symbol));
      // Deliberately stored as source text: parsing through Date would truncate Dune microseconds.
      const firstTradeTime = textOrNull(pick(record.value, aliases.firstTradeTime));
      const firstDex = textOrNull(pick(record.value, aliases.firstDex));
      const firstTx = textOrNull(pick(record.value, aliases.firstTx));

      if (!tokenAddress) rowErrors.push('missing required field: token_address');
      if (!firstTradeTime) rowErrors.push('missing field: first_trade_time');
      if (!symbol) rowErrors.push('missing optional field: symbol');
      if (!firstDex) rowErrors.push('missing optional field: first_dex');
      if (!firstTx) rowErrors.push('missing optional field: first_tx');

      if (!tokenAddress) {
        errors += 1;
        insertAuditRecord(database, batchId, record, null, 'error', rowErrors, importedAt);
        logger.error(`[dune] row ${record.rowNumber}: ${rowErrors.join('; ')}`);
        continue;
      }

      const result = insertToken.run(
        tokenAddress,
        symbol,
        firstTradeTime,
        firstDex,
        firstTx,
        tokenSource,
        importedAt,
        JSON.stringify(record.value),
        JSON.stringify(rowErrors),
      );
      const status = result.changes === 1 ? 'imported' : 'skipped';
      if (status === 'imported') imported += 1;
      else skipped += 1;
      insertAuditRecord(database, batchId, record, tokenAddress, status, rowErrors, importedAt);
      if (rowErrors.length > 0) {
        logger.warn(`[dune] row ${record.rowNumber}: ${rowErrors.join('; ')}`);
      }
    }

    database
      .prepare(
        `
      UPDATE dune_import_batches
      SET status = 'completed', imported_count = ?, skipped_count = ?, error_count = ?, completed_at = ?
      WHERE id = ?
    `,
      )
      .run(imported, skipped, errors, now().toISOString(), batchId);
    database.exec('COMMIT;');
  } catch (cause) {
    database.exec('ROLLBACK;');
    const error = cause instanceof Error ? cause.message : String(cause);
    database
      .prepare(
        `
      UPDATE dune_import_batches
      SET status = 'failed', error = ?, completed_at = ?
      WHERE id = ?
    `,
      )
      .run(error, now().toISOString(), batchId);
    throw cause;
  }

  logger.info(`[dune] import complete: imported=${imported} skipped=${skipped} errors=${errors}`);
  return { batchId, sourcePath, sourceSha256, imported, skipped, errors, duplicateFile: false };
};

export const importDuneFile = (
  database: DatabaseSync,
  filePath: string,
  logger: ImportLogger = defaultLogger,
  now: () => Date = () => new Date(),
  tokenSource: string = 'dune',
): DuneImportSummary =>
  importDuneContent(
    database,
    path.resolve(filePath),
    readFileSync(filePath, 'utf8'),
    logger,
    now,
    tokenSource,
  );
