import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { defaultDatabasePath } from '../platform/db/client.js';

const iconDirectory = path.join(path.dirname(defaultDatabasePath), 'wallet-icons');

export const walletIconDirectory = iconDirectory;

const iconFilename = (url: string): string => {
  const extension = path.extname(new URL(url).pathname).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.img';
  return `${createHash('sha256').update(url).digest('hex')}${extension === '.' ? '.img' : extension}`;
};

/** Downloads the avatar references already stored in the roster into the local data folder. */
export const downloadRosterIcons = async (database: DatabaseSync): Promise<{ attempted: number; saved: number; failed: number }> => {
  mkdirSync(iconDirectory, { recursive: true });
  const rows = database.prepare(`SELECT DISTINCT icon_url AS iconUrl FROM copytrade_wallets WHERE icon_url IS NOT NULL AND trim(icon_url) <> ''`).all() as unknown as Array<{ iconUrl: string }>;
  let saved = 0;
  let failed = 0;
  for (const row of rows) {
    const filename = iconFilename(row.iconUrl);
    const target = path.join(iconDirectory, filename);
    try {
      const response = await fetch(row.iconUrl, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      writeFileSync(target, Buffer.from(await response.arrayBuffer()));
      saved += 1;
    } catch {
      failed += 1;
    }
  }
  return { attempted: rows.length, saved, failed };
};
