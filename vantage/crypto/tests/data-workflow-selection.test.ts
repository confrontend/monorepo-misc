import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { selectDataWorkflowWallets } from '../src/copytrade/data/dataWorkflowOrchestrator.js';
import { readGmgnPeriodMetrics } from '../src/copytrade/screening/tradeCounts.js';
import type { RosterWallet } from '../src/copytrade/screening/roster.js';
import { openDatabase } from '../src/platform/db/client.js';
import { applyMigrations } from '../src/platform/db/schema.js';

const wallet = (walletAddress: string, rankPosition: number): RosterWallet => ({
  walletAddress,
  chain: 'sol',
  name: walletAddress,
  iconUrl: null,
  rankPosition,
  reportedPnl30d: null,
  reportedWinrate30d: null,
  riskFlags: [],
  gmgnTags: [],
});

test('explicit Data workflow selection preserves current roster order', () => {
  const roster = [wallet('A'.repeat(32), 1), wallet('B'.repeat(32), 2), wallet('C'.repeat(32), 3)];
  const selected = selectDataWorkflowWallets(roster, [roster[2].walletAddress, roster[0].walletAddress], 100);
  assert.deepEqual(selected.map((item) => item.walletAddress), [roster[0].walletAddress, roster[2].walletAddress]);
});

test('an explicit Data workflow selection rejects wallets outside the saved roster', () => {
  const roster = [wallet('A'.repeat(32), 1)];
  assert.throws(
    () => selectDataWorkflowWallets(roster, ['Z'.repeat(32)], 100),
    /not in the current GMGN roster/,
  );
});

test('an omitted selection retains the existing trader limit behavior', () => {
  const roster = [wallet('A'.repeat(32), 1), wallet('B'.repeat(32), 2), wallet('C'.repeat(32), 3)];
  const selected = selectDataWorkflowWallets(roster, undefined, 2);
  assert.deepEqual(selected.map((item) => item.walletAddress), [roster[0].walletAddress, roster[1].walletAddress]);
});

test('period metrics are read from saved activity and exclude unusable sell cost bases from PNL', () => {
  const database: DatabaseSync = openDatabase(':memory:');
  applyMigrations(database);
  const address = 'A'.repeat(32);
  const capturedAt = new Date().toISOString();
  database.prepare(
    `INSERT INTO gmgn_wallet_rank_snapshots (captured_at, raw_payload, source_sha256)
     VALUES (?, ?, ?)`,
  ).run(capturedAt, JSON.stringify({ data: [] }), 'selection-metrics-snapshot');
  const snapshotId = Number(
    (database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id,
  );
  database.prepare(
    `INSERT INTO copytrade_wallets
      (wallet_address, chain, name, source_snapshot_id, rank_position, risk_flags, gmgn_tags, added_at)
     VALUES (?, 'sol', ?, ?, 1, '[]', '[]', ?)`,
  ).run(address, 'Test wallet', snapshotId, capturedAt);
  const timestamp = Math.floor(Date.now() / 1000) - 3600;
  const insertTrade = database.prepare(
    `INSERT INTO copytrade_trades
      (wallet_address, chain, tx_hash, event_type, token_address, observed_timestamp,
       cost_usd, buy_cost_usd, raw_payload, fetched_at, dedup_key)
     VALUES (?, 'sol', ?, ?, 'token', ?, ?, ?, '{}', ?, ?)`,
  );
  insertTrade.run(address, 'buy-tx', 'buy', timestamp, '100', null, capturedAt, 'buy-key');
  insertTrade.run(address, 'sell-tx', 'sell', timestamp + 60, '125', '100', capturedAt, 'sell-key');
  insertTrade.run(address, 'unmatched-sell', 'sell', timestamp + 120, '50', null, capturedAt, 'unmatched-key');

  const metrics = readGmgnPeriodMetrics(database, { periodDays: 30, limit: 100 });
  assert.deepEqual(metrics[address], {
    tradeCount: 3,
    realizedProfitUsd: 25,
    realizedPnlPercent: 25,
  });
  database.close();
});
