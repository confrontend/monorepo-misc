import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/platform/db/client.js';
import { importGmgnBrowserCapture } from '../src/gmgn/capture/browserImport.js';

const exportJson = (events: unknown[], coverageWindows: unknown[] = [], extraCaptures: unknown[] = []) => JSON.stringify({
  formatVersion: 1,
  exportedAt: '2026-03-01T12:00:00.000Z',
  extensionVersion: '0.1.0',
  source: 'gmgn-browser-extension',
  coverageWindows,
  captures: [{ capturedAt: '2026-03-01T12:00:00.250Z', requestPath: '/vas/api/v1/token-signal', status: 200, responseBody: { data: events } }, ...extraCaptures],
});

const event = (id: string, token = 'TokenBrowser') => ({ id, data: { chain: 'sol' }, token_address: token, signal_type: 14, trigger_at: 1_772_359_200, market_cap: 1234, triggering_wallet: 'WalletBrowser', raw_wallet_labels: ['smart-money'], source_url: 'https://gmgn.example/signal' });

const wsSignal = {
  c: 'sol',
  d: { a: '3JLTNKH78VMd3j7kQkHDC7RqdasCAGwsLQdm3BBLpump', mc: 2181.0772, nm: 'Cat Wif Helmet', p: 0.0000021810772, lq: 1.189213228, hd: 1 },
  sig_ath: 2652.5669,
  sig_ft_t: true,
  sig_ftm: 2181.0772,
  sig_id: '2d7a607d-9c62-4fee-bf70-213c1a66e15f',
  sig_op_t: 'create',
  sig_t: 10,
  sig_t_at: 1786596894,
  sig_tms: 2,
  sig_tms_t: { '7': 1, '10': 1 },
  sig_token_ftm: 0,
};

const websocketExportJson = (items: unknown[]) => JSON.stringify({
  formatVersion: 1,
  exportedAt: '2026-03-01T12:00:00.000Z',
  extensionVersion: '0.1.0',
  source: 'gmgn-browser-extension',
  captures: [{ capturedAt: '2026-03-01T12:00:00.250Z', requestPath: '/ws', status: 200, responseBody: { channel: 'token_signal', data: items } }],
});

test('browser import stores source-tagged events, preserves raw source, and archives the upload', () => {
  const database = openDatabase(':memory:');
  try {
    const raw = exportJson([event('browser-1')], [
      { startedAt: '2026-03-01T11:00:00.000Z', endedAt: '2026-03-01T11:30:00.000Z', lastHeartbeatAt: '2026-03-01T11:30:00.000Z', closedReason: null },
    ]);
    const result = importGmgnBrowserCapture(database, 'signals.json', raw, new Date('2026-03-01T12:01:00Z'));
    assert.equal(result.imported, 1);
    assert.equal(result.skipped, 0);
    assert.equal(result.errors, 0);
    assert.equal(result.coverageWindowsImported, 1);
    assert.equal(result.duplicateFile, false);
    assert.ok(result.archivePath);
    const window = database.prepare('SELECT started_at AS startedAt, ended_at AS endedAt, closed_reason AS closedReason FROM gmgn_browser_coverage_windows').get() as Record<string, string | null>;
    assert.equal(window.startedAt, '2026-03-01T11:00:00.000Z');
    assert.equal(window.endedAt, '2026-03-01T11:30:00.000Z');
    assert.equal(window.closedReason, null);
    const row = database.prepare('SELECT source, chain, source_event_id, raw_payload, captured_at FROM gmgn_signals').get() as Record<string, string>;
    assert.equal(row.source, 'gmgn-browser-extension');
    assert.equal(row.chain, 'sol');
    assert.equal(row.source_event_id, 'browser-1');
    assert.deepEqual(JSON.parse(row.raw_payload), event('browser-1'));
    assert.equal(row.captured_at, '2026-03-01T12:00:00.250Z');
    const batch = database.prepare('SELECT status, raw_source, archive_path FROM gmgn_browser_import_batches').get() as Record<string, string>;
    assert.equal(batch.status, 'completed');
    assert.equal(batch.raw_source, raw);
    assert.equal(batch.archive_path, result.archivePath);
  } finally { database.close(); }
});

test('browser import maps real token_signal WebSocket events and skips live tick items', () => {
  const database = openDatabase(':memory:');
  try {
    const raw = websocketExportJson([{ c: 'sol', d: { a: 'tick-token', mc: 10 }, sig_op_t: 'create' }, wsSignal]);
    const result = importGmgnBrowserCapture(database, 'ws-signals.json', raw);
    assert.equal(result.imported, 1);
    assert.equal(result.skipped, 0);
    assert.equal(result.errors, 1, 'one imported event with optional-field warnings counts as one error row');
    const row = database.prepare('SELECT token_address, signal_type, trigger_at, observed_at, market_cap, source_event_id, chain, raw_payload FROM gmgn_signals').get() as Record<string, string | number>;
    assert.equal(row.token_address, wsSignal.d.a);
    assert.equal(row.signal_type, '10');
    assert.equal(row.trigger_at, '2026-08-13T04:54:54.000Z');
    assert.equal(row.observed_at, '2026-08-13T04:54:54.000Z');
    assert.equal(row.market_cap, wsSignal.d.mc);
    assert.equal(row.source_event_id, wsSignal.sig_id);
    assert.equal(row.chain, 'sol');
    assert.deepEqual(JSON.parse(String(row.raw_payload)), {
      token_address: wsSignal.d.a,
      signal_type: wsSignal.sig_t,
      trigger_at: wsSignal.sig_t_at,
      market_cap: wsSignal.d.mc,
      id: wsSignal.sig_id,
      first_trigger_mc: wsSignal.sig_ftm,
      signal_times: wsSignal.sig_tms,
      signal_times_by_type: wsSignal.sig_tms_t,
      ath: wsSignal.sig_ath,
      cur_data: wsSignal.d,
      chain: 'sol',
    });
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM gmgn_signals').get() as { count: number }).count, 1);
  } finally { database.close(); }
});

test('browser import never parses non-signal captures (price candles, trades, holder stats, smart-money wallet data) as signal events', () => {
  const database = openDatabase(':memory:');
  try {
    const raw = exportJson([event('browser-signal')], [], [
      { capturedAt: '2026-03-01T12:00:00.300Z', requestPath: '/api/v1/token_mcap_candles/sol/TokenBrowser', status: 200, responseBody: { data: [{ open: 1, close: 2, time: 100 }] } },
      { capturedAt: '2026-03-01T12:00:00.400Z', requestPath: '/vas/api/v1/token_trades/sol/TokenBrowser', status: 200, responseBody: { data: [{ maker: 'x', amount_usd: 5 }] } },
      { capturedAt: '2026-03-01T12:00:00.500Z', requestPath: '/vas/api/v1/token_holder_stat/sol/TokenBrowser', status: 200, responseBody: { data: [{ holder_count: 900 }] } },
      { capturedAt: '2026-03-01T12:00:00.600Z', requestPath: '/defi/quotation/v1/smartmoney/sol/wallet/SomeWallet', status: 200, responseBody: { data: [{ wallet: 'SomeWallet' }] } },
    ]);
    const result = importGmgnBrowserCapture(database, 'mixed.json', raw);
    assert.equal(result.imported, 1, 'only the real signal event is stored');
    assert.equal(result.errors, 0, 'non-signal captures must not be treated as malformed signal events');
    assert.equal(result.otherCaptures, 4, 'the four non-signal captures are counted, not silently dropped');
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM gmgn_signals').get() as { count: number }).count, 1, 'candle/trade/holder/wallet payloads must never end up in gmgn_signals');

    const reimport = importGmgnBrowserCapture(database, 'mixed-again.json', raw);
    assert.equal(reimport.duplicateFile, true);
    assert.equal(reimport.otherCaptures, 4, 'otherCaptures is reported the same way on the duplicate-file fast path');
  } finally { database.close(); }
});

test('browser import is idempotent by file hash and event identity', () => {
  const database = openDatabase(':memory:');
  try {
    const raw = exportJson([event('browser-2')]);
    const first = importGmgnBrowserCapture(database, 'signals.json', raw);
    const sameFile = importGmgnBrowserCapture(database, 'renamed.json', raw);
    assert.equal(sameFile.duplicateFile, true);
    assert.equal(sameFile.batchId, first.batchId);
    assert.equal(sameFile.coverageWindowsImported, first.coverageWindowsImported);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM gmgn_signals').get() as { count: number }).count, 1);
    const overlap = importGmgnBrowserCapture(database, 'signals-2.json', exportJson([event('browser-2'), event('browser-3')]));
    assert.equal(overlap.imported, 1);
    assert.equal(overlap.skipped, 1);
  } finally { database.close(); }
});

test('browser import drops malformed coverage window entries instead of failing the whole upload', () => {
  const database = openDatabase(':memory:');
  try {
    const raw = exportJson([event('browser-4')], [
      { startedAt: '2026-03-01T11:00:00.000Z', lastHeartbeatAt: '2026-03-01T11:05:00.000Z' },
      { endedAt: '2026-03-01T11:10:00.000Z' },
      'not-an-object',
    ]);
    const result = importGmgnBrowserCapture(database, 'signals.json', raw);
    assert.equal(result.imported, 1);
    assert.equal(result.coverageWindowsImported, 1);
  } finally { database.close(); }
});

test('browser import rejects malformed exports and records a failed batch', () => {
  const database = openDatabase(':memory:');
  try {
    assert.throws(() => importGmgnBrowserCapture(database, 'bad.json', JSON.stringify({ formatVersion: 1, source: 'wrong', captures: [] })), /source gmgn-browser-extension/);
    const batch = database.prepare('SELECT status, error_count, error FROM gmgn_browser_import_batches').get() as { status: string; error_count: number; error: string };
    assert.equal(batch.status, 'failed');
    assert.equal(batch.error_count, 1);
    assert.match(batch.error, /source gmgn-browser-extension/);
  } finally { database.close(); }
});

// Matches the real shape confirmed against an actual downloaded export, not an invented one:
// requestPath is pathname-only (the extension strips the query string before ever writing
// requestPath), and research-relevant query params travel separately on requestQuery. A prior
// version of these fixtures baked a query string directly onto requestPath (e.g.
// '/vas/api/v1/radar/detail?chain=sol...'), which does not match reality and silently masked a
// real bug where every query-derived field (chain/period/category/orderby/has_token) was always
// stored as null in production.
test('browser import stores and deduplicates the four raw GMGN endpoint families, and counts them separately from signals', () => {
  const database = openDatabase(':memory:');
  try {
    const captures = [
      { capturedAt: '2026-03-01T12:00:01.000Z', requestPath: '/vas/api/v1/radar/detail', requestQuery: { chain: 'sol', period: '1d', type: '7' }, status: 200, responseBody: { code: 0, data: [{ address: 'TokenRadar' }] } },
      // orderby carries "pnl_30d" while the path stays the fixed "/wallets/7d" segment
      // regardless of the actually-selected window — a real captured 30D selection confirmed
      // this (progress.md 2026-08-17), which is why window must come from orderby, not the path.
      { capturedAt: '2026-03-01T12:00:02.000Z', requestPath: '/api/v1/rank/sol/wallets/7d', requestQuery: { orderby: 'pnl_30d' }, status: 200, responseBody: { code: 0, data: [{ address: 'WalletRank' }] } },
      { capturedAt: '2026-03-01T12:00:03.000Z', requestPath: '/defi/quotation/v1/smartmoney/sol/walletNew/WalletSmart', status: 200, responseBody: { code: 0, data: { pnl: 12 } } },
      { capturedAt: '2026-03-01T12:00:03.500Z', requestPath: '/defi/quotation/v1/smartmoney/sol/walletNew/WalletSmart', status: 200, responseBody: { code: 0, data: { pnl: 12 } } },
      { capturedAt: '2026-03-01T12:00:04.000Z', requestPath: '/vas/api/v1/twitter/messages', requestQuery: { tw_type: 'kol', has_token: 'false' }, status: 200, responseBody: { code: 0, data: [{ id: 'tweet-1', tweet_id: 'tweet-1', tw_type: 'kol', text: 'hello' }] } },
      { capturedAt: '2026-03-01T12:00:05.000Z', requestPath: '/vas/api/v1/twitter/messages', requestQuery: { tw_type: 'kol', has_token: 'false' }, status: 200, responseBody: { code: 0, data: [{ id: 'tweet-2', tweet_id: 'tweet-2', tw_type: 'kol', text: 'world' }] } },
    ];
    const raw = exportJson([], [], captures);
    const result = importGmgnBrowserCapture(database, 'endpoint-samples.json', raw);
    assert.equal(result.imported, 0, 'no real GMGN signals in this batch — the signal counter must stay untouched by raw-endpoint captures');
    assert.equal(result.skipped, 0);
    assert.equal(result.errors, 0);
    assert.equal(result.otherCaptures, 0);
    assert.deepEqual(result.rawEndpoints, {
      radar: { imported: 1, skipped: 0 },
      walletRank: { imported: 1, skipped: 0 },
      smartMoney: { imported: 2, skipped: 0 },
      twitter: { imported: 2, skipped: 0 },
    });
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM gmgn_radar_snapshots').get() as { count: number }).count, 1);
    const radarRow = database.prepare('SELECT chain, period, category FROM gmgn_radar_snapshots').get() as Record<string, string>;
    assert.equal(radarRow.chain, 'sol');
    assert.equal(radarRow.period, '1d');
    assert.equal(radarRow.category, '7', 'category must come from requestQuery.type, recovered via the fixed extraction path');
    const rankRow = database.prepare('SELECT window, orderby FROM gmgn_wallet_rank_snapshots').get() as Record<string, string>;
    assert.equal(rankRow.window, '30d', 'window must be derived from orderby\'s trailing token, never the fixed /wallets/7d path segment — a real 30D capture proved the path never changes');
    assert.equal(rankRow.orderby, 'pnl_30d');
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM gmgn_smartmoney_wallet_stats').get() as { count: number }).count, 2, 'repeated wallet observations are preserved');
    assert.equal((database.prepare('SELECT wallet_address FROM gmgn_smartmoney_wallet_stats').get() as { wallet_address: string }).wallet_address, 'WalletSmart');
    const twitter = database.prepare('SELECT COUNT(*) AS count, MAX(has_token) AS hasToken FROM gmgn_twitter_messages').get() as { count: number; hasToken: number };
    assert.equal(twitter.count, 2);
    assert.equal(twitter.hasToken, 0, 'has_token must be recovered from requestQuery, not silently stored as null');

    const repeat = importGmgnBrowserCapture(database, 'endpoint-repeat.json', exportJson([], [], captures).replace('2026-03-01T12:00:00.000Z', '2026-03-01T12:01:00.000Z'));
    assert.equal(repeat.imported, 0);
    assert.deepEqual(repeat.rawEndpoints, {
      radar: { imported: 0, skipped: 1 },
      walletRank: { imported: 0, skipped: 1 },
      smartMoney: { imported: 2, skipped: 0 },
      twitter: { imported: 0, skipped: 2 },
    }, 'radar, rank, and Twitter repeats deduplicate by content hash; smart-money observations remain append-only');
  } finally { database.close(); }
});

test('browser import redacts account-identifying fields before the raw file is persisted or archived, while dedup still keys off the original bytes', () => {
  const database = openDatabase(':memory:');
  try {
    const captures = [
      { capturedAt: '2026-03-01T12:00:01.000Z', requestPath: '/vas/api/v1/radar/detail', requestQuery: { chain: 'sol' }, status: 200, responseBody: { code: 0, data: [{ address: 'TokenRadar' }], user_id: 'ee33acab-1234', referral_code: 'D9Km8Jkz' } },
    ];
    const raw = exportJson([], [], captures);
    assert.ok(raw.includes('ee33acab-1234'), 'sanity check: the fixture actually contains the identifier before import');
    const result = importGmgnBrowserCapture(database, 'privacy-sample.json', raw);

    const stored = (database.prepare('SELECT raw_source AS rawSource FROM gmgn_browser_import_batches WHERE id = ?').get(result.batchId) as { rawSource: string }).rawSource;
    assert.ok(!stored.includes('ee33acab-1234'), 'user_id must never reach the database unredacted');
    assert.ok(!stored.includes('D9Km8Jkz'), 'referral_code must never reach the database unredacted');
    assert.ok(stored.includes('TokenRadar'), 'legitimate research data in the same payload must survive redaction');

    // Re-uploading the exact same original (unredacted) bytes must still be recognized as a
    // duplicate — dedup identity is keyed off the original content, not the redacted copy.
    const repeat = importGmgnBrowserCapture(database, 'privacy-sample-again.json', raw);
    assert.equal(repeat.duplicateFile, true);
    assert.equal(repeat.batchId, result.batchId);
  } finally { database.close(); }
});

test('browser import counts malformed recognized endpoint responses without dropping the raw upload', () => {
  const database = openDatabase(':memory:');
  try {
    const raw = exportJson([], [], [
      { capturedAt: '2026-03-01T12:00:01.000Z', requestPath: '/vas/api/v1/radar/detail', requestQuery: { chain: 'sol', period: '1d', type: '7' }, status: 200, responseBody: 'not-json' },
      { capturedAt: '2026-03-01T12:00:02.000Z', requestPath: '/vas/api/v1/twitter/messages', requestQuery: { has_token: 'true' }, status: 200, responseBody: { code: 0, data: 'not-an-array' } },
    ]);
    const result = importGmgnBrowserCapture(database, 'endpoint-bad.json', raw);
    assert.equal(result.imported, 0);
    assert.equal(result.errors, 2);
    assert.equal(result.otherCaptures, 0);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM gmgn_radar_snapshots').get() as { count: number }).count, 0);
  } finally { database.close(); }
});

test('duplicate-file re-upload reports the same real rawEndpoints breakdown as the original import, not a recomputed guess', () => {
  const database = openDatabase(':memory:');
  try {
    const captures = [
      { capturedAt: '2026-03-01T12:00:01.000Z', requestPath: '/vas/api/v1/radar/detail', requestQuery: { chain: 'sol', period: '1d', type: '7' }, status: 200, responseBody: { code: 0, data: [{ address: 'TokenRadar' }] } },
    ];
    const raw = exportJson([], [], captures);
    const first = importGmgnBrowserCapture(database, 'dup-a.json', raw);
    const second = importGmgnBrowserCapture(database, 'dup-b.json', raw);
    assert.equal(second.duplicateFile, true);
    assert.deepEqual(second.rawEndpoints, first.rawEndpoints);
  } finally { database.close(); }
});
