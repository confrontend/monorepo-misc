import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const { Pool } = pg;
const sqlitePath = process.env.UNUSUAL_WHALES_DB_PATH ?? new URL('../.data/unusual-whales.sqlite', import.meta.url).pathname.replace(/^\/(\w):/, '$1:');
const pool = new Pool({ connectionString: process.env.POSTGRES_URL ?? 'postgres://unusualwhales:unusualwhales-local-only@127.0.0.1:54329/unusualwhales' });
const sqlite = new DatabaseSync(sqlitePath);
const BATCH = 500;
const json = (value, fallback = {}) => {
  if (value == null) return fallback;
  const text = String(value);
  try { return JSON.parse(text); } catch {
    if (text.startsWith('{') && text.endsWith('}')) return text.slice(1, -1).trim() ? text.slice(1, -1).split(',').map(item => item.trim().replace(/^"|"$/g, '')) : [];
    return fallback;
  }
};
const tables = [
  ['uw_import_batches', ['id','endpoint','query_json','requested_at','completed_at','status','http_status','received_count','inserted_count','duplicate_count','response_sha256','raw_response','error'], row => [row.id,row.endpoint,JSON.stringify(json(row.query_json)),row.requested_at,row.completed_at,row.status,row.http_status,row.received_count,row.inserted_count,row.duplicate_count,row.response_sha256,row.raw_response,row.error]],
  ['uw_option_trades', ['id','source_trade_id','source_batch_id','executed_at','captured_at','signal_type','underlying_symbol','option_chain_id','option_type','expiry','strike','premium','price','size','underlying_price','open_interest','volume','nbbo_bid','nbbo_ask','report_flags','tags','canceled','raw_payload','validation_errors'], row => [row.id,row.source_trade_id,row.source_batch_id,row.executed_at,row.captured_at,row.signal_type,row.underlying_symbol,row.option_chain_id,row.option_type,row.expiry,row.strike,row.premium,row.price,row.size,row.underlying_price,row.open_interest,row.volume,row.nbbo_bid,row.nbbo_ask,JSON.stringify(json(row.report_flags,[])),JSON.stringify(json(row.tags,[])),Boolean(row.canceled),JSON.stringify(json(row.raw_payload,{})),JSON.stringify(json(row.validation_errors,[]))]],
  ['uw_dark_pool_trades', ['id','source_trade_id','executed_at','captured_at','ticker','price','size','premium','canceled','raw_payload','validation_errors'], row => [row.id,row.source_trade_id,row.executed_at,row.captured_at,row.ticker,row.price,row.size,row.premium,Boolean(row.canceled),JSON.stringify(json(row.raw_payload,{})),JSON.stringify(json(row.validation_errors,[]))]],
  ['uw_historical_coverage', ['id','signal_type','trading_date','endpoint','started_at','completed_at','status','received_count','inserted_count','duplicate_count','error','bytes_received','bytes_expected','progress_updated_at'], row => [row.id,row.signal_type,row.trading_date,row.endpoint,row.started_at,row.completed_at,row.status,row.received_count,row.inserted_count,row.duplicate_count,row.error,row.bytes_received,row.bytes_expected,row.progress_updated_at]],
  ['uw_market_bars', ['id','symbol','timeframe','observed_at','open','high','low','close','volume','source','retrieved_at'], row => [row.id,row.symbol,row.timeframe,row.observed_at,row.open,row.high,row.low,row.close,row.volume,row.source,row.retrieved_at]],
  ['uw_signal_outcomes', ['id','trade_id','horizon','entry_at','entry_price','outcome_at','outcome_price','spy_entry_price','spy_outcome_price','return_pct','spy_return_pct','excess_return_pct','exclusion_reason','calculated_at'], row => [row.id,row.trade_id,row.horizon,row.entry_at,row.entry_price,row.outcome_at,row.outcome_price,row.spy_entry_price,row.spy_outcome_price,row.return_pct,row.spy_return_pct,row.excess_return_pct,row.exclusion_reason,row.calculated_at]],
];

const insertBatch = async (client, table, columns, values) => {
  const params = []; const groups = values.map(row => `(${row.map(value => { params.push(value); return `$${params.length}`; }).join(',')})`).join(',');
  await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${groups} ON CONFLICT DO NOTHING`, params);
};

try {
  const client = await pool.connect();
  try {
    for (const [table, columns, map] of tables) {
      const total = Number(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count ?? 0);
      let offset = 0;
      while (offset < total) {
        const rows = sqlite.prepare(`SELECT * FROM ${table} ORDER BY id LIMIT ? OFFSET ?`).all(BATCH, offset);
        if (!rows.length) break;
        await client.query('BEGIN');
        await insertBatch(client, table, columns, rows.map(map));
        await client.query('COMMIT');
        offset += rows.length;
        process.stdout.write(`\r${table}: ${offset}/${total}`);
      }
      process.stdout.write('\n');
      await client.query(`SELECT setval(pg_get_serial_sequence('${table}','id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), true)`);
    }
  } finally { client.release(); }
} finally {
  sqlite.close();
  await pool.end();
}
