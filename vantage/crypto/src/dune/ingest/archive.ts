import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface DuneArchiveInput {
  archiveDirectory: string;
  batchId: number;
  sourceName: string;
  sourceSha256: string;
  rawSource: string;
  summary: object;
  archivedAt: string;
}

export interface DuneArchiveResult {
  archivePath: string;
  archiveSha256: string;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

// Small dependency-free ZIP writer. Entries are stored without compression so the archive is
// deterministic, inspectable, and does not require a native module or a shell executable.
const crc32 = (data: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

export const zipStored = (entries: ZipEntry[]): Buffer => {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local, entry.data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + entry.data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
};

export interface ZipReadEntry {
  name: string;
  data: Buffer;
}

/**
 * Reads entries back out of an archive written by zipStored. Only the "stored" (uncompressed)
 * method is supported — sufficient for this app, since zipStored never compresses.
 */
export const readZipEntries = (archive: Buffer): ZipReadEntry[] => {
  if (archive.length < 22) throw new Error('File is too small to be a valid ZIP archive.');
  const eocd = archive.subarray(archive.length - 22);
  if (eocd.readUInt32LE(0) !== 0x06054b50) {
    throw new Error('End-of-central-directory record not found; not a valid stored ZIP archive.');
  }
  const entryCount = eocd.readUInt16LE(10);
  const centralSize = eocd.readUInt32LE(12);
  const centralOffset = eocd.readUInt32LE(16);
  if (centralOffset + centralSize > archive.length - 22) {
    throw new Error('Central directory extends past the end of the file.');
  }

  const entries: ZipReadEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`Central directory entry ${index} has an invalid signature.`);
    }
    const compressionMethod = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (compressionMethod !== 0) {
      throw new Error(`Entry "${name}" uses unsupported compression method ${compressionMethod}.`);
    }
    if (localHeaderOffset + 30 > archive.length || archive.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Entry "${name}" has an invalid local file header.`);
    }
    const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > archive.length) {
      throw new Error(`Entry "${name}" data extends past the end of the file.`);
    }
    entries.push({ name, data: Buffer.from(archive.subarray(dataStart, dataStart + compressedSize)) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};

const safeName = (name: string): string => {
  const basename = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  return basename || 'source.txt';
};

export const archiveDuneSource = (input: DuneArchiveInput): DuneArchiveResult => {
  mkdirSync(input.archiveDirectory, { recursive: true });
  const archiveName = `dune-batch-${input.batchId}-${input.sourceSha256.slice(0, 16)}.zip`;
  const archivePath = path.join(input.archiveDirectory, archiveName);
  if (existsSync(archivePath)) {
    const bytes = readFileSync(archivePath);
    return { archivePath, archiveSha256: createHash('sha256').update(bytes).digest('hex') };
  }

  const manifest = JSON.stringify({
    batchId: input.batchId,
    sourceName: safeName(input.sourceName),
    sourceSha256: input.sourceSha256,
    archivedAt: input.archivedAt,
    summary: input.summary,
  }, null, 2);
  const archive = zipStored([
    { name: safeName(input.sourceName), data: Buffer.from(input.rawSource, 'utf8') },
    { name: 'manifest.json', data: Buffer.from(manifest, 'utf8') },
  ]);
  writeFileSync(archivePath, archive, { flag: 'wx' });
  return { archivePath, archiveSha256: createHash('sha256').update(archive).digest('hex') };
};
