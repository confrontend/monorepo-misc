import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { readUnusualWhalesApiKey } from './unusualwhales.js';
import { deriveSweepFlowImbalance } from './derived-flow-imbalance.js';
import { normalizeDarkPoolRecords } from './dark-pool.js';
import { parsePostgresArrayLiteral, streamFullTapeCsvRows } from './full-tape-csv.js';
import { normalizeHistoricalEvents, persistHistoricalEvents, type HistoricalEventSource } from './historical-signal-events.js';

const API_BASE_URL = 'https://api.unusualwhales.com';
const ENDPOINT = '/api/option-trades/full-tape';
const MAX_DAYS = 366;
const MAX_REQUESTS = 100;
// The full-tape endpoint streams roughly 1-1.5 GB per trading day (confirmed live), so the
// per-request budget has to cover a full download+decode, not a small JSON response. The old
// 120s timeout was calibrated for the latter and was the direct cause of every historical
// call/put-sweep backfill failing with "aborted due to timeout" in production.
const FULL_TAPE_TIMEOUT_MS = 20 * 60_000;
// api.unusualwhales.com/api/darkpool/recent documents no offset/pagination parameter, so a
// day that returns exactly the request limit cannot be confirmed complete.
const DARK_POOL_DAY_LIMIT = 200;

export type HistoricalSignalType = 'call_sweep' | 'put_sweep' | 'dark_pool_block' | 'repeated_sweeps' | 'flow_imbalance' | 'open_interest_spike' | 'gex_gamma' | 'market_etf_flow' | 'insider_activity' | 'congress_activity';
export type HistoricalSignalResult = {
  signalType: HistoricalSignalType;
  status: 'completed' | 'partial' | 'failed' | 'unsupported';
  received: number;
  inserted: number;
  duplicates: number;
  skippedDays: number;
  errors: string[];
  reason?: string;
};
export type HistoricalBackfillOptions = {
  from: string;
  to: string;
  signalTypes?: HistoricalSignalType[];
  apiBaseUrl?: string;
  apiKeyFile?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  maxRequests?: number;
  /** Overrides the full-tape per-request timeout. Exposed for tests; defaults to 20 minutes. */
  fullTapeTimeoutMs?: number;
  /** Safety cap on decompressed bytes read per full-tape day. Exposed for tests. */
  maxDecompressedBytesPerDay?: number;
  abortSignal?: AbortSignal;
};
export type HistoricalBackfillResult = {
  status: 'completed' | 'partial' | 'failed';
  from: string;
  to: string;
  pages: number;
  received: number;
  inserted: number;
  duplicates: number;
  skippedDays: number;
  excludedOutsideRange: number;
  errors: string[];
  signalTypes: HistoricalSignalType[];
  signalResults: HistoricalSignalResult[];
  assumptions: string[];
};

const assumptions = [
  'Historical days are queried through /api/option-trades/full-tape/:date because /api/option-trades only serves the latest trading day.',
  'The full-tape endpoint returns a single-entry ZIP archive containing one CSV file per trading day (confirmed live: DEFLATE-compressed, roughly 1-1.5 GB on the wire per day). Rows are streamed and parsed incrementally; the decompressed CSV is never held in memory at once.',
  'Full-tape rows are filtered locally by option type, the intermarket_sweep report flag, and the requested UTC date range.',
  'Historical events are accepted only when from <= executed_at < to; this prevents out-of-range records from affecting outcomes.',
  'Dark pool historical days use /api/darkpool/recent with a date filter. That endpoint documents no offset/pagination parameter, so a day that returns the request limit may be undercounted; such days are flagged in the result rather than reported as complete.',
  'Sources without a verified point-in-time historical endpoint are reported as unsupported and are never queried.',
];

const unsupportedReasons: Partial<Record<HistoricalSignalType, string>> = {
  repeated_sweeps: 'Historical repeated-sweep groups are not downloaded yet; grouping must be reconstructed from timestamped raw sweeps.',
};

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
};
const integer = (value: unknown): number | null => {
  const result = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(result) ? Math.trunc(result) : null;
};
const jsonArray = (value: unknown): string => JSON.stringify(Array.isArray(value) ? value : value == null ? [] : [value]);
const pgBoolean = (value: string | undefined): boolean => {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === 't' || normalized === 'true' || normalized === '1';
};
const normalizeTimestamp = (value: unknown): string | null => {
  const source = text(value);
  if (!source) return null;
  const date = new Date(source);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const isWeekend = (date: Date) => date.getUTCDay() === 0 || date.getUTCDay() === 6;
const isMarketClosedMessage = (message: string) => /market was not open|market closed|not a trading day/i.test(message);
const timedSignal = (abortSignal: AbortSignal | undefined, timeoutMs: number) => abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

// How often an in-flight full-tape download writes its running byte count to
// uw_historical_coverage. A full day can take minutes, so this is what makes a live,
// determinate progress bar possible; too frequent would just add SQLite write pressure for
// no visible benefit.
const PROGRESS_WRITE_INTERVAL_MS = 750;

const makeFullTapeProgressWriter = (database: DatabaseSync, signalType: HistoricalSignalType, tradingDate: string) => {
  let bytesReceived = 0;
  let lastWriteAt = 0;
  const write = () => {
    database.prepare(`UPDATE uw_historical_coverage SET bytes_received=?, progress_updated_at=? WHERE signal_type=? AND trading_date=?`)
      .run(bytesReceived, new Date().toISOString(), signalType, tradingDate);
  };
  return {
    setExpectedBytes: (bytesExpected: number | null) => {
      database.prepare(`UPDATE uw_historical_coverage SET bytes_expected=? WHERE signal_type=? AND trading_date=?`).run(bytesExpected, signalType, tradingDate);
    },
    onBytes: (chunkLength: number) => {
      bytesReceived += chunkLength;
      const now = Date.now();
      if (now - lastWriteAt < PROGRESS_WRITE_INTERVAL_MS) return;
      lastWriteAt = now;
      write();
    },
    flush: write,
  };
};

const parseDateRange = (from: string, to: string) => {
  const fromDate = new Date(from); const toDate = new Date(to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) throw new Error('from and to must be valid ISO dates');
  if (fromDate >= toDate) throw new Error('from must be earlier than to');
  if (toDate.getTime() - fromDate.getTime() > MAX_DAYS * 24 * 60 * 60_000) throw new Error(`historical backfill is limited to ${MAX_DAYS} days per request`);
  return { from: fromDate.toISOString(), to: toDate.toISOString() };
};

export const backfillHistoricalSignals = async (database: DatabaseSync, options: HistoricalBackfillOptions): Promise<HistoricalBackfillResult> => {
  const range = parseDateRange(options.from, options.to);
  const requested = (options.signalTypes?.length ? options.signalTypes : ['call_sweep', 'put_sweep']) as HistoricalSignalType[];
  const signalTypes = [...new Set(requested)];
  const maxRequests = Math.min(Math.max(options.maxRequests ?? MAX_REQUESTS, 1), MAX_REQUESTS);
  const errors: string[] = [];
  const signalResults: HistoricalSignalResult[] = [];
  let pages = 0, received = 0, inserted = 0, duplicates = 0, excludedOutsideRange = 0, skippedDays = 0;
  let requests = 0;

  // These sources are intentionally reported without making a request: an
  // unverified endpoint or publication timestamp would create look-ahead risk.
  for (const signalType of signalTypes) {
    const reason = unsupportedReasons[signalType];
    if (reason) {
      signalResults.push({ signalType, status: 'unsupported', received: 0, inserted: 0, duplicates: 0, skippedDays: 0, errors: [], reason });
    }
  }

  const supported: HistoricalSignalType[] = signalTypes.filter((signalType) => signalType === 'call_sweep' || signalType === 'put_sweep' || signalType === 'dark_pool_block' || signalType === 'flow_imbalance' || signalType === 'open_interest_spike' || signalType === 'market_etf_flow' || signalType === 'gex_gamma' || signalType === 'insider_activity' || signalType === 'congress_activity');
  for (const signalType of signalTypes) {
    if (!supported.includes(signalType)) continue;
    if (signalType === 'flow_imbalance') {
      const derived = deriveSweepFlowImbalance(database, range.from, range.to, options.now?.().toISOString() ?? new Date().toISOString());
      received += derived.received; inserted += derived.inserted; duplicates += derived.duplicates;
      signalResults.push({ signalType, status: 'completed', received: derived.received, inserted: derived.inserted, duplicates: derived.duplicates, skippedDays: 0, errors: [] });
      continue;
    }
    if (signalType === 'open_interest_spike' || signalType === 'market_etf_flow' || signalType === 'gex_gamma' || signalType === 'insider_activity' || signalType === 'congress_activity') {
      const requestedAt = (options.now?.() ?? new Date()).toISOString();
      const endpointBase = signalType === 'open_interest_spike' ? '/api/market/oi-change' : signalType === 'market_etf_flow' ? '/api/market/market-tide' : signalType === 'gex_gamma' ? '/api/stock/{ticker}/spot-exposures' : signalType === 'insider_activity' ? '/api/insider/transactions' : '/api/politician-portfolios/recent_trades';
      const batch = database.prepare(`INSERT INTO uw_import_batches (endpoint, query_json, requested_at, status) VALUES (?, ?, ?, 'processing')`)
        .run(endpointBase, JSON.stringify({ from: range.from, to: range.to, signalType }), requestedAt);
      const batchId = Number(batch.lastInsertRowid);
      let typeReceived = 0, typeInserted = 0, typeDuplicates = 0, typeSkipped = 0;
      const typeErrors: string[] = [];
      try {
        const key = await readUnusualWhalesApiKey(options.apiKeyFile);
        const etfSymbols = ['SPY', 'QQQ', 'IWM'];
        const gexSymbols = (database.prepare(`SELECT underlying_symbol AS symbol, COUNT(*) AS count FROM uw_option_trades WHERE underlying_symbol IS NOT NULL AND canceled=0 GROUP BY underlying_symbol ORDER BY count DESC LIMIT 50`).all() as unknown as Array<{ symbol: string }>).map((row) => row.symbol);
        for (let dayCursor = new Date(new Date(range.to).getTime() - 24 * 60 * 60_000); dayCursor >= new Date(range.from); dayCursor = new Date(dayCursor.getTime() - 24 * 60 * 60_000)) {
          const tradingDate = dayCursor.toISOString().slice(0, 10);
          if (isWeekend(dayCursor)) continue;
          const existing = database.prepare(`SELECT status FROM uw_historical_coverage WHERE signal_type=? AND trading_date=?`).get(signalType, tradingDate) as { status?: string } | undefined;
          const existingEventCount = Number((database.prepare(`SELECT COUNT(*) AS count FROM uw_signal_events WHERE signal_type=? AND event_at>=? AND event_at<?`).get(signalType, `${tradingDate}T00:00:00.000Z`, `${tradingDate}T23:59:59.999Z`) as { count?: number } | undefined)?.count ?? 0);
          if (existing?.status === 'completed' && existingEventCount > 0) { typeSkipped++; skippedDays++; continue; }
          database.prepare(`INSERT INTO uw_historical_coverage (signal_type,trading_date,endpoint,started_at,status) VALUES (?,?,?,?, 'processing') ON CONFLICT(signal_type,trading_date) DO UPDATE SET endpoint=excluded.endpoint,started_at=excluded.started_at,status='processing',completed_at=NULL,error=NULL`).run(signalType, tradingDate, `${endpointBase}?date=${tradingDate}`, requestedAt);
          const targets = signalType === 'open_interest_spike' ? [{ url: endpointBase, symbol: undefined }] : signalType === 'market_etf_flow' ? [{ url: endpointBase, symbol: undefined }, ...etfSymbols.map((symbol) => ({ url: `/api/market/${symbol}/etf-tide`, symbol }))] : signalType === 'gex_gamma' ? gexSymbols.map((symbol) => ({ url: `/api/stock/${symbol}/spot-exposures`, symbol })) : [{ url: endpointBase, symbol: undefined }];
          let dayReceived = 0, dayInserted = 0, dayDuplicates = 0;
          for (const target of targets) {
            const url = new URL(target.url, options.apiBaseUrl ?? API_BASE_URL);
            url.searchParams.set('date', tradingDate);
            if (signalType === 'open_interest_spike') { url.searchParams.set('limit', '200'); url.searchParams.set('order', 'desc'); }
            if (signalType === 'insider_activity') { url.searchParams.set('start_date', tradingDate); url.searchParams.set('end_date', tradingDate); url.searchParams.set('limit', '500'); url.searchParams.set('page', '0'); url.searchParams.set('group', 'true'); }
            if (signalType === 'congress_activity') { url.searchParams.set('date', tradingDate); url.searchParams.set('limit', '500'); url.searchParams.set('page', '1'); }
            const response = await (options.fetchImpl ?? fetch)(url, { method: 'GET', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: timedSignal(options.abortSignal, 120_000) });
            if (!response.ok) throw new Error(`Unusual Whales ${signalType} API returned HTTP ${response.status}`);
            const payload: unknown = await response.json();
            const events = normalizeHistoricalEvents(signalType as HistoricalEventSource, payload, tradingDate, target.symbol)
              .filter((event) => !event.eventAt || (event.eventAt >= range.from && event.eventAt < range.to));
            const persisted = persistHistoricalEvents(database, batchId, requestedAt, events);
            dayReceived += persisted.received; dayInserted += persisted.inserted; dayDuplicates += persisted.duplicates;
          }
          typeReceived += dayReceived; typeInserted += dayInserted; typeDuplicates += dayDuplicates; received += dayReceived; inserted += dayInserted; duplicates += dayDuplicates;
          database.prepare(`UPDATE uw_historical_coverage SET completed_at=?,status='completed',received_count=?,inserted_count=?,duplicate_count=? WHERE signal_type=? AND trading_date=?`).run(requestedAt, dayReceived, dayInserted, dayDuplicates, signalType, tradingDate);
        }
        database.prepare(`UPDATE uw_import_batches SET completed_at=?,status='completed',received_count=?,inserted_count=?,duplicate_count=? WHERE id=?`).run(requestedAt, typeReceived, typeInserted, typeDuplicates, batchId);
        signalResults.push({ signalType, status: 'completed', received: typeReceived, inserted: typeInserted, duplicates: typeDuplicates, skippedDays: typeSkipped, errors: typeErrors });
      } catch (error) {
        const message = error instanceof Error ? error.message : `Historical ${signalType} backfill failed`;
        errors.push(`${signalType}: ${message}`); typeErrors.push(message);
        database.prepare(`UPDATE uw_import_batches SET completed_at=?,status='failed',error=?,received_count=?,inserted_count=?,duplicate_count=? WHERE id=?`).run(requestedAt, message, typeReceived, typeInserted, typeDuplicates, batchId);
        database.prepare(`UPDATE uw_historical_coverage SET completed_at=?,status='failed',error=? WHERE signal_type=? AND status='processing'`).run(requestedAt, message, signalType);
        signalResults.push({ signalType, status: typeInserted ? 'partial' : 'failed', received: typeReceived, inserted: typeInserted, duplicates: typeDuplicates, skippedDays: typeSkipped, errors: typeErrors });
      }
      continue;
    }
    if (signalType === 'dark_pool_block') {
      const endpointBase = '/api/darkpool/recent';
      const requestedAt = (options.now?.() ?? new Date()).toISOString();
      const batch = database.prepare(`INSERT INTO uw_import_batches (endpoint, query_json, requested_at, status) VALUES (?, ?, ?, 'processing')`).run(endpointBase, JSON.stringify({ from: range.from, to: range.to }), requestedAt);
      const batchId = Number(batch.lastInsertRowid);
      let typeReceived = 0, typeInserted = 0, typeDuplicates = 0, typeSkipped = 0, truncatedDays = 0;
      const typeErrors: string[] = [];
      try {
        const key = await readUnusualWhalesApiKey(options.apiKeyFile);
        for (let dayCursor = new Date(new Date(range.to).getTime() - 24 * 60 * 60_000); dayCursor >= new Date(range.from); dayCursor = new Date(dayCursor.getTime() - 24 * 60 * 60_000)) {
          const tradingDate = dayCursor.toISOString().slice(0, 10);
          if (isWeekend(dayCursor)) {
            // Older runs may have recorded a provider 422 for a weekend before the
            // weekend guard was added. Normalize that stale row so resume diagnostics
            // do not keep reporting a known market-closed date as a live failure.
            database.prepare(`UPDATE uw_historical_coverage SET completed_at=?, status='completed', error=? WHERE signal_type=? AND trading_date=? AND status='failed'`)
              .run(requestedAt, `Skipped market-closed date ${tradingDate}`, signalType, tradingDate);
            continue;
          }
          const existing = database.prepare(`SELECT status FROM uw_historical_coverage WHERE signal_type=? AND trading_date=?`).get(signalType, tradingDate) as { status?: string } | undefined;
          if (existing?.status === 'completed') { typeSkipped++; skippedDays++; continue; }
          database.prepare(`INSERT INTO uw_historical_coverage (signal_type,trading_date,endpoint,started_at,status) VALUES (?,?,?,?, 'processing') ON CONFLICT(signal_type,trading_date) DO UPDATE SET endpoint=excluded.endpoint,started_at=excluded.started_at,status='processing',completed_at=NULL,error=NULL`).run(signalType, tradingDate, `${endpointBase}?date=${tradingDate}`, requestedAt);
          const url = new URL(endpointBase, options.apiBaseUrl ?? API_BASE_URL);
          // Recent Darkpool Trades documents a maximum limit of 200.
          url.searchParams.set('limit', String(DARK_POOL_DAY_LIMIT));
          url.searchParams.set('date', tradingDate);
          const response = await (options.fetchImpl ?? fetch)(url, { method: 'GET', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: timedSignal(options.abortSignal, 120_000) });
          if (!response.ok) throw new Error(`Unusual Whales historical dark-pool API returned HTTP ${response.status}`);
          const payload: unknown = await response.json();
          const records = normalizeDarkPoolRecords(payload);
          // The endpoint has no offset/pagination parameter, so a response at the request cap
          // cannot be distinguished from a day that truly had no more trades. Flag it rather
          // than silently reporting the day as complete.
          if (records.length >= DARK_POOL_DAY_LIMIT) {
            truncatedDays++;
            typeErrors.push(`${tradingDate}: hit the ${DARK_POOL_DAY_LIMIT}-record request cap with no pagination available; this day may be undercounted.`);
          }
          const insert = database.prepare(`INSERT OR IGNORE INTO uw_dark_pool_trades (source_trade_id,executed_at,captured_at,ticker,price,size,premium,canceled,raw_payload,validation_errors) VALUES (?,?,?,?,?,?,?,?,?,?)`);
          let dayInserted = 0, dayDuplicates = 0;
          for (const record of records) {
            if (!record.executedAt || record.executedAt < range.from || record.executedAt >= range.to) { excludedOutsideRange++; continue; }
            typeReceived++; received++;
            const result = insert.run(record.sourceId, record.executedAt, requestedAt, record.ticker, record.price, record.size, record.premium, record.canceled ? 1 : 0, record.rawPayload, JSON.stringify(record.validationErrors));
            if (Number(result.changes)) { dayInserted++; typeInserted++; inserted++; } else { dayDuplicates++; typeDuplicates++; duplicates++; }
          }
          database.prepare(`UPDATE uw_historical_coverage SET completed_at=?,status='completed',received_count=?,inserted_count=?,duplicate_count=? WHERE signal_type=? AND trading_date=?`).run(requestedAt, records.length, dayInserted, dayDuplicates, signalType, tradingDate);
        }
        database.prepare(`UPDATE uw_import_batches SET completed_at=?,status='completed',received_count=?,inserted_count=?,duplicate_count=? WHERE id=?`).run(requestedAt, typeReceived, typeInserted, typeDuplicates, batchId);
        signalResults.push({ signalType, status: 'completed', received: typeReceived, inserted: typeInserted, duplicates: typeDuplicates, skippedDays: typeSkipped, errors: typeErrors });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Historical dark-pool backfill failed';
        typeErrors.push(message); errors.push(`${signalType}: ${message}`);
        database.prepare(`UPDATE uw_import_batches SET completed_at=?,status='failed',error=?,received_count=?,inserted_count=?,duplicate_count=? WHERE id=?`).run(requestedAt, message, typeReceived, typeInserted, typeDuplicates, batchId);
        database.prepare(`UPDATE uw_historical_coverage SET completed_at=?,status='failed',error=? WHERE signal_type=? AND status='processing'`).run(requestedAt, message, signalType);
        signalResults.push({ signalType, status: typeInserted || typeReceived ? 'partial' : 'failed', received: typeReceived, inserted: typeInserted, duplicates: typeDuplicates, skippedDays: typeSkipped, errors: typeErrors });
      }
      continue;
    }
    const optionType = signalType === 'call_sweep' ? 'call' : 'put';
    const requestedAt = (options.now?.() ?? new Date()).toISOString();
    const query = { type: optionType, report_flag: 'intermarket_sweep', canceled: false, full_tape: true, from: range.from, to: range.to };
    const batch = database.prepare(`INSERT INTO uw_import_batches (endpoint, query_json, requested_at, status) VALUES (?, ?, ?, 'processing')`).run(ENDPOINT, JSON.stringify(query), requestedAt);
    const batchId = Number(batch.lastInsertRowid);
    let typeReceived = 0, typeInserted = 0, typeDuplicates = 0;
    try {
      const key = await readUnusualWhalesApiKey(options.apiKeyFile);
      let olderThan = range.to;
      while (requests < maxRequests) {
        requests++;
        const day = new Date(new Date(olderThan).getTime() - 24 * 60 * 60_000);
        if (isWeekend(day)) {
          const tradingDate = day.toISOString().slice(0, 10);
          database.prepare(`UPDATE uw_historical_coverage SET completed_at=?, status='completed', error=? WHERE signal_type=? AND trading_date=? AND status='failed'`)
            .run((options.now?.() ?? new Date()).toISOString(), `Skipped market-closed date ${tradingDate}`, signalType, tradingDate);
          if (day.getTime() <= new Date(range.from).getTime()) break;
          olderThan = day.toISOString();
          continue;
        }
        const tradingDate = day.toISOString().slice(0, 10);
        const existingCoverage = database.prepare(`SELECT status FROM uw_historical_coverage WHERE signal_type=? AND trading_date=?`).get(signalType, tradingDate) as { status?: string } | undefined;
        if (existingCoverage?.status === 'completed') {
          skippedDays++;
          if (day.getTime() <= new Date(range.from).getTime()) break;
          olderThan = day.toISOString();
          continue;
        }
        database.prepare(`INSERT INTO uw_historical_coverage (signal_type, trading_date, endpoint, started_at, status)
          VALUES (?, ?, ?, ?, 'processing') ON CONFLICT(signal_type, trading_date) DO UPDATE SET endpoint=excluded.endpoint, started_at=excluded.started_at, completed_at=NULL, status='processing', error=NULL, bytes_received=NULL, bytes_expected=NULL, progress_updated_at=NULL`)
          .run(signalType, tradingDate, `${ENDPOINT}/${tradingDate}`, (options.now?.() ?? new Date()).toISOString());
        const url = new URL(`${ENDPOINT}/${tradingDate}`, options.apiBaseUrl ?? API_BASE_URL);
        // Full Tape is documented (and confirmed live) as a single ZIP-archived CSV file per
        // trading date, identified only by the date path segment -- it takes no query params
        // and returns content-type application/zip, not JSON. Filtering happens locally on
        // the decompressed, streamed CSV below.
        const response = await (options.fetchImpl ?? fetch)(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${key}` },
          signal: timedSignal(options.abortSignal, options.fullTapeTimeoutMs ?? FULL_TAPE_TIMEOUT_MS),
        });
        if (!response.ok) {
          const detail = (await response.text()).replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]').slice(0, 300);
          if (response.status === 422 && isMarketClosedMessage(detail)) {
            database.prepare(`UPDATE uw_historical_coverage SET completed_at=?, status='completed', received_count=0, inserted_count=0, duplicate_count=0, error=? WHERE signal_type=? AND trading_date=?`)
              .run((options.now?.() ?? new Date()).toISOString(), `Skipped market-closed date ${tradingDate}`, signalType, tradingDate);
            if (day.getTime() <= new Date(range.from).getTime()) break;
            olderThan = day.toISOString();
            continue;
          }
          throw new Error(`Unusual Whales historical API returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
        }
        if (!response.body) throw new Error('Unusual Whales full-tape response had no body');

        pages++;
        const capturedAt = (options.now?.() ?? new Date()).toISOString();
        const progressWriter = makeFullTapeProgressWriter(database, signalType, tradingDate);
        const contentLength = Number(response.headers.get('content-length'));
        progressWriter.setExpectedBytes(Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null);
        const insert = database.prepare(`INSERT OR IGNORE INTO uw_option_trades
          (source_trade_id, source_batch_id, executed_at, captured_at, signal_type, underlying_symbol, option_chain_id, option_type, expiry, strike, premium, price, size, underlying_price, open_interest, volume, nbbo_bid, nbbo_ask, report_flags, tags, canceled, raw_payload, validation_errors)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        let dayReceived = 0;
        let oldest = '';
        try {
        for await (const row of streamFullTapeCsvRows(response.body as unknown as ReadableStream<Uint8Array>, {
          maxDecompressedBytes: options.maxDecompressedBytesPerDay,
          onBytes: progressWriter.onBytes,
        })) {
          const actualType = row.option_type?.toLowerCase() ?? null;
          const reportFlags = parsePostgresArrayLiteral(row.report_flags ?? '');
          const isSweep = reportFlags.some((flag) => flag.toLowerCase() === 'intermarket_sweep');
          if (actualType !== optionType || !isSweep) continue;

          dayReceived++; typeReceived++; received++;
          const executedAt = normalizeTimestamp(row.executed_at);
          if (!executedAt || executedAt < range.from || executedAt >= range.to) { excludedOutsideRange++; continue; }
          if (!oldest || executedAt < oldest) oldest = executedAt;

          const validation: string[] = [];
          const symbol = text(row.underlying_symbol); if (!symbol) validation.push('missing underlying_symbol');
          if (actualType !== optionType) validation.push(`option_type is not ${optionType}`);

          const rawPayload = JSON.stringify(row);
          const eventId = text(row.id) ?? `sha256:${createHash('sha256').update(rawPayload).digest('hex')}`;
          const result = insert.run(
            eventId, batchId, executedAt, capturedAt, signalType, symbol,
            text(row.option_chain_id), actualType, text(row.expiry), text(row.strike), text(row.premium), text(row.price),
            integer(row.size), text(row.underlying_price), integer(row.open_interest), integer(row.volume),
            text(row.nbbo_bid), text(row.nbbo_ask), jsonArray(reportFlags), jsonArray(parsePostgresArrayLiteral(row.tags ?? '')),
            pgBoolean(row.canceled) ? 1 : 0, rawPayload, JSON.stringify(validation),
          );
          const changes = Number(result.changes); typeInserted += changes; inserted += changes; if (!changes) { typeDuplicates++; duplicates++; }
          // Full-tape days can contain millions of rows. Yield periodically so the HTTP
          // diagnostics/cancel routes remain responsive while synchronous SQLite inserts run.
          if (dayReceived % 100 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
        }
        } finally {
          // Persist the final byte count even on failure, so a partial day shows exactly how
          // far the download got instead of going stale at whatever the last throttled write was.
          progressWriter.flush();
        }
        if (day.getTime() <= new Date(range.from).getTime()) break;
        database.prepare(`UPDATE uw_historical_coverage SET completed_at=?, status='completed', received_count=?, inserted_count=?, duplicate_count=? WHERE signal_type=? AND trading_date=?`)
          .run((options.now?.() ?? new Date()).toISOString(), dayReceived, typeInserted, typeDuplicates, signalType, tradingDate);
        olderThan = day.toISOString();
      }
      if (olderThan) {
        const finalDate = new Date(new Date(olderThan).getTime() - 24 * 60 * 60_000).toISOString().slice(0, 10);
        database.prepare(`UPDATE uw_historical_coverage SET completed_at=COALESCE(completed_at, ?), status=CASE WHEN status='processing' THEN 'completed' ELSE status END WHERE signal_type=? AND trading_date=?`)
          .run((options.now?.() ?? new Date()).toISOString(), signalType, finalDate);
      }
      const completedAt = (options.now?.() ?? new Date()).toISOString();
      database.prepare(`UPDATE uw_import_batches SET completed_at=?,status=?,received_count=?,inserted_count=?,duplicate_count=?,raw_response=? WHERE id=?`).run(completedAt, requests >= maxRequests ? 'completed' : 'completed', typeReceived, typeInserted, typeDuplicates, null, batchId);
      signalResults.push({ signalType, status: 'completed', received: typeReceived, inserted: typeInserted, duplicates: typeDuplicates, skippedDays: 0, errors: [] });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Historical backfill failed'; errors.push(`${signalType}: ${message}`);
      database.prepare(`UPDATE uw_import_batches SET completed_at=?,status='failed',error=?,received_count=?,inserted_count=?,duplicate_count=? WHERE id=?`).run((options.now?.() ?? new Date()).toISOString(), message, typeReceived, typeInserted, typeDuplicates, batchId);
      database.prepare(`UPDATE uw_historical_coverage SET completed_at=?, status='failed', error=? WHERE signal_type=? AND status='processing'`).run((options.now?.() ?? new Date()).toISOString(), message, signalType);
      signalResults.push({ signalType, status: typeInserted || typeReceived ? 'partial' : 'failed', received: typeReceived, inserted: typeInserted, duplicates: typeDuplicates, skippedDays: 0, errors: [message] });
    }
  }
  const hasUnsupportedOnly = signalResults.length > 0 && signalResults.every((result) => result.status === 'unsupported');
  return { status: hasUnsupportedOnly ? 'partial' : errors.length ? (inserted || received ? 'partial' : 'failed') : 'completed', from: range.from, to: range.to, pages, received, inserted, duplicates, skippedDays, excludedOutsideRange, errors, signalTypes: signalTypes as HistoricalSignalType[], signalResults, assumptions };
};

export { parseDateRange };
