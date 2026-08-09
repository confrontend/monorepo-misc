import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataInputRoot = path.join(projectRoot, 'input');
const threeYearInput = path.join(dataInputRoot, '3-year');
const defaultInput = threeYearInput;

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const hasFlag = (name) => args.includes(name);
const emitProgress = (progress, stage, message) => {
  process.stderr.write(`CONSOLIDATE_PROGRESS ${JSON.stringify({ progress, stage, message })}\n`);
};
const inputDir = path.resolve(option('--input') ?? defaultInput);
const dryRun = hasFlag('--dry-run');
const strict = hasFlag('--strict');
const keepSources = hasFlag('--keep-sources');
const requestedOutput = option('--output');
const generatedAt = new Date();
const timestamp = generatedAt.toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z');
const outputPath = path.resolve(requestedOutput ?? path.join(inputDir, 'consolidated_unique.json'));
const manifestPath = outputPath.replace(/\.json$/i, '.manifest.txt');
const archiveDir = path.resolve(option('--archive') ?? path.join(inputDir, 'archive'));
const archivePath = path.join(archiveDir, `raw_sources_${timestamp}.zip`);

if (hasFlag('--help')) {
  console.log(`Usage: node scripts/consolidate-single-data.mjs [options]

Options:
  --input <folder>   Folder containing raw_*.json and prior consolidated_unique_*.json bundles.
  --output <file>    Output JSON path. Default: the stable consolidated_unique.json.
  --archive <folder> ZIP archive folder. Default: input/3-year/archive.
  --dry-run          Parse, merge, and validate in memory without writing files.
  --strict           Fail if any ticker/type has only invalid upstream responses.
  --keep-sources     Keep raw and older consolidated files after successful local archiving.
  --help             Show this help.

The default workflow also folds standalone ticker JSON from input/ and input/3-year/ into the same
stable bundle. Benchmark files under input/benchmark/ are never touched. It writes and verifies one
stable consolidated file, ZIPs every replaceable source into archive/, and then removes the locally
archived sources and older consolidated files. It never stages or
commits anything to Git. Any failure before verified local archival leaves source files untouched.`);
  process.exit(0);
}

const digestBuffer = (buffer) => createHash('sha256').update(buffer).digest('hex');
const digestFile = async (filePath) => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  stream.on('data', (chunk) => hash.update(chunk));
  stream.on('error', reject);
  stream.on('end', () => resolve(hash.digest('hex')));
});

// Minimal standards-compliant ZIP writer (deflate + UTF-8). Keeping this local avoids adding a
// package dependency solely for archival safety. Every compressed member is immediately inflated
// and hash-compared before the archive is accepted.
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});
const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
const dosDateTime = (date) => {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
};
const createZip = (members) => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { dosTime, dosDate } = dosDateTime(generatedAt);
  for (const member of members) {
    const name = Buffer.from(member.name.replace(/\\/g, '/'), 'utf8');
    const compressed = deflateRawSync(member.data, { level: 9 });
    if (digestBuffer(inflateRawSync(compressed)) !== digestBuffer(member.data)) {
      throw new Error(`ZIP verification failed while compressing ${member.name}`);
    }
    const crc = crc32(member.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(member.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(member.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
};

const normalizeSlug = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const normalizeKind = (value) => value === 'prices' || value === 'changes' || value === 'quant' ? value : '';
const stampFor = (entry, sourceIndex) => {
  const timestampValue = Number(entry?._ts);
  return { timestamp: Number.isFinite(timestampValue) ? timestampValue : 0, sourceIndex };
};
const isNewer = (candidate, current) => candidate.timestamp > current.timestamp
  || (candidate.timestamp === current.timestamp && candidate.sourceIndex > current.sourceIndex);
const recordDate = (record, kind) => kind === 'prices'
  ? String(record?.attributes?.as_of_date ?? '')
  : kind === 'changes'
    ? String(record?.attributes?.createdAt ?? '')
    : String(record?.date ?? '');
const recordIdentity = (record, kind) => {
  if (record?.id !== undefined && record?.id !== null) return `${record.type ?? kind}:${String(record.id)}`;
  const date = recordDate(record, kind);
  if (date) return `${kind}:${date}`;
  return `${kind}:sha256:${digestBuffer(Buffer.from(JSON.stringify(record)))}`;
};
const includedIdentity = (record) => {
  if (record?.id !== undefined && record?.id !== null) return `${record.type ?? 'included'}:${String(record.id)}`;
  const slug = normalizeSlug(record?.attributes?.slug);
  if (slug) return `${record.type ?? 'ticker'}:slug:${slug}`;
  return `included:sha256:${digestBuffer(Buffer.from(JSON.stringify(record)))}`;
};
const compareRecords = (left, right, kind) => recordDate(left, kind).localeCompare(recordDate(right, kind))
  || String(left?.id ?? '').localeCompare(String(right?.id ?? ''));

const directJsonFiles = async (directory) => (await readdir(directory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
  .map((entry) => path.join(directory, entry.name));
const bundlePaths = (await readdir(inputDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /^(raw_.*|consolidated_unique(?:_.*)?)\.json$/i.test(entry.name))
  .map((entry) => path.join(inputDir, entry.name));
const isBundleFilename = (filePath) => /^(raw_.*|consolidated_unique(?:_.*)?)\.json$/i.test(path.basename(filePath));
const standalonePaths = [
  ...await directJsonFiles(dataInputRoot),
  ...await directJsonFiles(threeYearInput),
].filter((filePath) => !isBundleFilename(filePath));
const discoverArchivePaths = async () => [
  ...(await readdir(inputDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^raw_.*\.json$/i.test(entry.name))
    .map((entry) => path.join(inputDir, entry.name)),
  ...await directJsonFiles(dataInputRoot),
  ...(await directJsonFiles(threeYearInput)).filter((filePath) => !isBundleFilename(filePath)),
].map((filePath) => path.resolve(filePath)).sort((left, right) => left.localeCompare(right));
const archivePaths = await discoverArchivePaths();
const sources = [...new Set([...bundlePaths, ...standalonePaths].map((filePath) => path.resolve(filePath)))]
  .map((filePath) => ({
    filePath,
    relativeName: path.relative(dataInputRoot, filePath).split(path.sep).join('/'),
    archived: archivePaths.includes(filePath),
  }))
  .sort((left, right) => left.relativeName.localeCompare(right.relativeName));

if (!sources.length) throw new Error(`No consolidatable ticker JSON files found under ${dataInputRoot}`);
if (archivePaths.includes(outputPath)) throw new Error('The output path cannot be an archived input file.');
emitProgress(5, 'scanning', `Found ${sources.length} data source(s), including ${archivePaths.length} standalone/raw file(s) to archive.`);

const standaloneEntry = (payload, source) => {
  if (payload?.quantRatingHistory && Array.isArray(payload.quantRatingHistory.records)) {
    const slug = normalizeSlug(payload?.source?.ticker);
    if (!slug) throw new Error(`${source.relativeName} has quant history but no source ticker.`);
    const attributes = {
      slug,
      name: payload.source.ticker ?? null,
      companyName: payload.source.companyName ?? null,
      exchange: payload.source.exchange ?? null,
      currency: payload.source.currency ?? null,
      fundType: payload.source.fundType ?? null,
    };
    return {
      _key: `quant:${slug}`,
      _slug: slug,
      _kind: 'quant',
      _ts: Date.parse(payload.capturedAt ?? '') || statSync(source.filePath).mtimeMs,
      count: payload.quantRatingHistory.records.length,
      body: {
        data: payload.quantRatingHistory.records,
        included: [{ type: 'ticker', id: slug, attributes }],
        meta: { source: 'standalone-quant-history' },
      },
    };
  }
  if (Array.isArray(payload?.data)) {
    const attributes = payload.data.find((row) => row?.attributes)?.attributes;
    const endpoint = String(payload?.meta?.path ?? '');
    const kind = attributes?.as_of_date !== undefined || endpoint.includes('historical_price')
      ? 'prices'
      : attributes?.createdAt !== undefined || endpoint.includes('ticker_changes') ? 'changes' : '';
    const ticker = Array.isArray(payload.included)
      ? payload.included.find((entry) => entry?.type === 'ticker' && normalizeSlug(entry?.attributes?.slug))
      : null;
    const filenameSlug = path.basename(source.filePath).match(/filters-slugs-([a-z0-9.-]+?)(?:-f(?:i(?:l(?:t(?:e(?:r)?)?)?)?)?)?\.json$/i)?.[1];
    const slug = normalizeSlug(ticker?.attributes?.slug ?? filenameSlug);
    if (!kind || !slug) throw new Error(`${source.relativeName} is not a recognized standalone prices, changes, or quant-history file.`);
    return {
      _key: `${kind}:${slug}`,
      _slug: slug,
      _kind: kind,
      _ts: statSync(source.filePath).mtimeMs,
      count: payload.data.length,
      body: payload,
    };
  }
  throw new Error(`${source.relativeName} is not a recognized standalone prices, changes, or quant-history file.`);
};

const groups = new Map();
const tickerMetadata = new Map();
const sourceManifest = [];
const diagnostics = {
  wrapperEntriesRead: 0,
  duplicateWrappersCollapsed: 0,
  dataRowsRead: 0,
  duplicateDataRowsCollapsed: 0,
  conflictingDataRowsResolved: 0,
  includedRowsRead: 0,
  duplicateIncludedRowsCollapsed: 0,
  conflictingIncludedRowsResolved: 0,
  invalidUpstreamWrappersSkipped: 0,
};
const invalidWrappers = [];

for (const [sourceIndex, source] of sources.entries()) {
  const buffer = readFileSync(source.filePath);
  let payload;
  try {
    payload = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`${source.relativeName} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entries = Array.isArray(payload) ? payload : [standaloneEntry(payload, source)];

  sourceManifest.push({
    file: source.relativeName,
    archived: source.archived,
    bytes: buffer.length,
    sha256: digestBuffer(buffer),
    wrapperEntries: entries.length,
  });

  for (const [entryIndex, entry] of entries.entries()) {
    diagnostics.wrapperEntriesRead += 1;
    const slug = normalizeSlug(entry?._slug);
    const kind = normalizeKind(entry?._kind);
    if (!slug || !kind) {
      throw new Error(`${source.relativeName}[${entryIndex}] is not a valid prices/changes/quant bundle entry.`);
    }

    const key = `${kind}:${slug}`;
    if (!entry?.body || !Array.isArray(entry.body.data)) {
      // Upstream anti-bot/captcha responses are sometimes saved in place of API JSON. They are
      // safe to ignore only when another source file supplies a valid payload for the same key;
      // that coverage check runs after every file has been read.
      diagnostics.invalidUpstreamWrappersSkipped += 1;
      invalidWrappers.push({ file: source.relativeName, entryIndex, key, bodyKeys: Object.keys(entry?.body ?? {}) });
      continue;
    }
    const stamp = stampFor(entry, sourceIndex);
    let group = groups.get(key);
    if (!group) {
      group = { key, slug, kind, latestEntry: entry, latestStamp: stamp, records: new Map(), included: new Map() };
      groups.set(key, group);
    } else {
      diagnostics.duplicateWrappersCollapsed += 1;
      if (isNewer(stamp, group.latestStamp)) {
        group.latestEntry = entry;
        group.latestStamp = stamp;
      }
    }

    for (const record of entry.body.data) {
      diagnostics.dataRowsRead += 1;
      const identity = recordIdentity(record, kind);
      const current = group.records.get(identity);
      if (!current) {
        group.records.set(identity, { value: record, stamp });
      } else {
        diagnostics.duplicateDataRowsCollapsed += 1;
        const differs = JSON.stringify(current.value) !== JSON.stringify(record);
        if (differs) diagnostics.conflictingDataRowsResolved += 1;
        if (isNewer(stamp, current.stamp)) group.records.set(identity, { value: record, stamp });
      }
    }

    const included = Array.isArray(entry.body.included) ? entry.body.included : [];
    for (const record of included) {
      diagnostics.includedRowsRead += 1;
      const identity = includedIdentity(record);
      const current = group.included.get(identity);
      if (!current) {
        group.included.set(identity, { value: record, stamp });
      } else {
        diagnostics.duplicateIncludedRowsCollapsed += 1;
        const differs = JSON.stringify(current.value) !== JSON.stringify(record);
        if (differs) diagnostics.conflictingIncludedRowsResolved += 1;
        if (isNewer(stamp, current.stamp)) group.included.set(identity, { value: record, stamp });
      }

      if (record?.type === 'ticker' && normalizeSlug(record?.attributes?.slug) === slug) {
        const fundType = typeof record?.attributes?.fundType === 'string' && record.attributes.fundType.trim()
          ? record.attributes.fundType.trim() : null;
        const existingTicker = tickerMetadata.get(slug);
        // Price responses often include the ticker but omit fundType. Missing metadata must not
        // erase an explicit ETF classification obtained from the corresponding changes response.
        if (fundType && (!existingTicker || isNewer(stamp, existingTicker.stamp))) {
          tickerMetadata.set(slug, { fundType, stamp });
        }
      }
    }
  }
}

const unresolvedInvalidKeys = [...new Set(invalidWrappers.map((entry) => entry.key))]
  .filter((key) => !groups.has(key));
if (strict && unresolvedInvalidKeys.length) {
  throw new Error(`Cannot produce a complete consolidation: invalid upstream responses have no valid replacement for ${unresolvedInvalidKeys.join(', ')}`);
}
emitProgress(35, 'merging', `Merged ${groups.size} unique ticker/type payloads.`);

const consolidated = [...groups.values()]
  .sort((left, right) => left.slug.localeCompare(right.slug) || left.kind.localeCompare(right.kind))
  .map((group) => {
    const latest = structuredClone(group.latestEntry);
    const records = [...group.records.values()].map((row) => row.value).sort((left, right) => compareRecords(left, right, group.kind));
    const included = [...group.included.values()].map((row) => row.value)
      .sort((left, right) => includedIdentity(left).localeCompare(includedIdentity(right)));
    latest._key = group.key;
    latest._slug = group.slug;
    latest._kind = group.kind;
    latest.count = records.length;
    latest.body.data = records;
    latest.body.included = included;
    if (latest.body.meta && typeof latest.body.meta === 'object' && 'total' in latest.body.meta) {
      latest.body.meta.total = records.length;
    }
    return latest;
  });

const uniqueTickers = new Set(consolidated.map((entry) => entry._slug));
const etfs = new Set([...tickerMetadata.entries()]
  .filter(([, metadata]) => metadata.fundType.toUpperCase() === 'ETF')
  .map(([slug]) => slug));
const mergedDataRows = consolidated.reduce((sum, entry) => sum + entry.body.data.length, 0);

const summary = {
  generatedAt: generatedAt.toISOString(),
  inputDirectory: inputDir,
  outputFile: dryRun ? null : outputPath,
  sourceFiles: sourceManifest,
  sourceFileCount: sourceManifest.length,
  uniqueTickers: uniqueTickers.size,
  etfTickers: etfs.size,
  nonEtfOrUnknownTickers: uniqueTickers.size - etfs.size,
  uniqueTickerKindPayloads: consolidated.length,
  mergedDataRows,
  ...diagnostics,
  invalidUpstreamWrappers: invalidWrappers,
  conflictPolicy: 'For the same API row identity, the wrapper with the greatest _ts wins; ties use the later source filename. Rows absent from newer cumulative files are retained.',
  completePayloadCoverage: unresolvedInvalidKeys.length === 0,
  payloadsWithNoUsableUpstreamData: unresolvedInvalidKeys,
  rawFilesArchived: sourceManifest.filter((source) => source.archived).map((source) => source.file),
  standaloneFilesArchived: sourceManifest.filter((source) => source.archived && !/^3-year\/raw_/i.test(source.file)).map((source) => source.file),
  archiveFile: dryRun || !archivePaths.length ? null : archivePath,
  removedSourceFiles: [],
  verified: false,
};

const noNewSources = archivePaths.length === 0
  && sources.length === 1
  && path.resolve(sources[0].filePath) === outputPath;
if (!dryRun && noNewSources && existsSync(outputPath) && existsSync(manifestPath)) {
  emitProgress(100, 'complete', 'No new ticker sources were found; the existing consolidated file and manifest were retained.');
  console.log(readFileSync(manifestPath, 'utf8').trim());
  console.log('\nNothing to consolidate. Existing output and archive history were left unchanged.');
  process.exit(0);
}

if (!dryRun) {
  emitProgress(45, 'writing', 'Writing and rereading the consolidated bundle.');
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, JSON.stringify(consolidated));

  const verificationPayload = JSON.parse(readFileSync(temporaryPath, 'utf8'));
  const verificationGroups = new Set(verificationPayload.map((entry) => `${entry?._kind}:${normalizeSlug(entry?._slug)}`));
  const verificationRows = verificationPayload.reduce((sum, entry) => sum + (Array.isArray(entry?.body?.data) ? entry.body.data.length : 0), 0);
  if (verificationPayload.length !== consolidated.length
    || verificationGroups.size !== groups.size
    || verificationRows !== mergedDataRows) {
    throw new Error('Verification failed: the written bundle does not match the in-memory consolidated result. The temporary file was retained for diagnosis.');
  }

  if (archivePaths.length) {
    emitProgress(58, 'archiving', `Compressing ${archivePaths.length} replaceable source file(s) into a verified ZIP.`);
    mkdirSync(archiveDir, { recursive: true });
    if (existsSync(archivePath)) throw new Error(`Refusing to overwrite archive ${archivePath}`);
    const rawManifest = sourceManifest.filter((source) => source.archived);
    const rawManifestByName = new Map(rawManifest.map((source) => [source.file, source]));
    const archiveMembers = archivePaths.map((filePath) => {
      const name = path.relative(dataInputRoot, filePath).split(path.sep).join('/');
      const data = readFileSync(filePath);
      if (digestBuffer(data) !== rawManifestByName.get(name)?.sha256) {
        throw new Error(`${name} changed while consolidation was running. Source files were not removed; rerun after the upstream writer finishes.`);
      }
      return { name, data };
    });
    archiveMembers.push({
      name: 'archive_manifest.json',
      data: Buffer.from(`${JSON.stringify({ generatedAt: generatedAt.toISOString(), sources: rawManifest }, null, 2)}\n`),
    });
    const archiveBuffer = createZip(archiveMembers);
    const archiveTemporaryPath = `${archivePath}.tmp-${process.pid}`;
    writeFileSync(archiveTemporaryPath, archiveBuffer);
    if (await digestFile(archiveTemporaryPath) !== digestBuffer(archiveBuffer)) {
      throw new Error('ZIP verification failed after writing the archive. Source files were not removed.');
    }
    renameSync(archiveTemporaryPath, archivePath);
    summary.archiveBytes = statSync(archivePath).size;
    summary.archiveSha256 = await digestFile(archivePath);
    summary.archiveEntries = archiveMembers.length;
    emitProgress(76, 'archiving', 'Local source archive passed hash and decompression verification.');
  }

  // Replace the stable output only after the local source archive has been verified. A
  // backup is kept until the new output and manifest have both landed successfully.
  const outputBackup = existsSync(outputPath) ? `${outputPath}.previous-${process.pid}` : null;
  if (outputBackup) renameSync(outputPath, outputBackup);
  try {
    renameSync(temporaryPath, outputPath);
  } catch (error) {
    if (outputBackup && existsSync(outputBackup)) renameSync(outputBackup, outputPath);
    throw error;
  }
  summary.outputBytes = statSync(outputPath).size;
  summary.outputSha256 = await digestFile(outputPath);
  summary.verified = true;
  emitProgress(90, 'installing', 'Stable consolidated file passed final verification.');

  const mayRemoveSources = !keepSources;
  if (mayRemoveSources) {
    const currentArchivePaths = await discoverArchivePaths();
    if (JSON.stringify(currentArchivePaths) !== JSON.stringify(archivePaths)) {
      throw new Error('The set of raw or standalone ticker files changed while consolidation was running. No source files were removed; rerun after the upstream writer finishes.');
    }
    for (const filePath of archivePaths) {
      const name = path.relative(dataInputRoot, filePath).split(path.sep).join('/');
      const expected = sourceManifest.find((source) => source.file === name)?.sha256;
      if (!expected || await digestFile(filePath) !== expected) {
        throw new Error(`${name} changed after it was archived. No source files were removed; rerun after the upstream writer finishes.`);
      }
    }
  }
  const removableDataFiles = sources
    .map((source) => source.filePath)
    .filter((filePath) => path.resolve(filePath) !== outputPath);
  const existingManifestNames = (await readdir(inputDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^consolidated_unique(?:_.*)?\.manifest\.txt$/i.test(entry.name))
    .map((entry) => path.join(inputDir, entry.name))
    .filter((filePath) => path.resolve(filePath) !== manifestPath);
  summary.removedSourceFiles = mayRemoveSources
    ? [...removableDataFiles, ...existingManifestNames].map((filePath) => path.relative(dataInputRoot, filePath).split(path.sep).join('/'))
    : [];

  const manifestTemporaryPath = `${manifestPath}.tmp-${process.pid}`;
  writeFileSync(manifestTemporaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  const manifestBackup = existsSync(manifestPath) ? `${manifestPath}.previous-${process.pid}` : null;
  if (manifestBackup) renameSync(manifestPath, manifestBackup);
  try {
    renameSync(manifestTemporaryPath, manifestPath);
  } catch (error) {
    if (manifestBackup && existsSync(manifestBackup)) renameSync(manifestBackup, manifestPath);
    throw error;
  }

  if (mayRemoveSources) {
    for (const filePath of [...removableDataFiles, ...existingManifestNames]) {
      if (existsSync(filePath)) unlinkSync(filePath);
    }
  }
  if (outputBackup && existsSync(outputBackup)) unlinkSync(outputBackup);
  if (manifestBackup && existsSync(manifestBackup)) unlinkSync(manifestBackup);
  emitProgress(100, 'complete', 'Consolidation, archival, and cleanup completed safely.');
}

console.log(JSON.stringify(summary, null, 2));
if (dryRun) {
  console.log('\nDry run complete. No files were written.');
} else {
  console.log(`\nVerified consolidated bundle: ${outputPath}`);
  console.log(`Provenance manifest: ${manifestPath}`);
  if (summary.archiveFile) console.log(`Verified local source archive: ${summary.archiveFile}`);
  if (summary.removedSourceFiles.length) console.log(`Removed ${summary.removedSourceFiles.length} superseded source file(s); one consolidated JSON remains.`);
  else console.log('Source files were kept.');
}
if (unresolvedInvalidKeys.length) {
  console.warn(`\nWarning: ${unresolvedInvalidKeys.length} ticker/type payloads contained only upstream error pages and no market rows. See payloadsWithNoUsableUpstreamData in the manifest.`);
}
