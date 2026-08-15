import type { DatabaseSync } from 'node:sqlite';
import { asOptionalString, insertByHash, snapshotPayload, type RawSnapshotResult } from './rawSnapshot.js';

export const storeSmartMoneyWalletStats = (database: DatabaseSync, input: { walletAddress: string; chain?: unknown; capturedAt: string; rawPayload: unknown }): RawSnapshotResult => {
  if (!input.walletAddress) throw new Error('GMGN smart-money response is missing wallet address.');
  const { raw, sha256 } = snapshotPayload(input.rawPayload);
  return insertByHash(database, `INSERT INTO gmgn_smartmoney_wallet_stats (wallet_address, chain, captured_at, raw_payload, source_sha256) VALUES (?, ?, ?, ?, ?)`, [input.walletAddress, asOptionalString(input.chain), input.capturedAt, raw, sha256], sha256);
};
