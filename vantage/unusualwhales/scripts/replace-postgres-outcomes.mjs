import pg from 'pg';
import { createDatabase } from '../dist/src/db/client.js';

const { Pool } = pg;
const sqlitePath = process.env.UNUSUAL_WHALES_DB_PATH ?? new URL('../.data/unusual-whales.sqlite', import.meta.url).pathname.replace(/^\/(\w):/, '$1:');
const pool = new Pool({ connectionString: process.env.POSTGRES_URL ?? 'postgres://unusualwhales:unusualwhales-local-only@127.0.0.1:54329/unusualwhales' });
const sqlite = createDatabase(sqlitePath);
const BATCH = 1000;
const total = Number(sqlite.prepare('SELECT COUNT(*) AS count FROM uw_signal_outcomes').get().count ?? 0);
const columns = ['id','trade_id','horizon','entry_at','entry_price','outcome_at','outcome_price','spy_entry_price','spy_outcome_price','return_pct','spy_return_pct','excess_return_pct','exclusion_reason','calculated_at'];
const insert = async (client, rows) => {
  const params = [];
  const groups = rows.map(row => `(${row.map(value => { params.push(value); return `$${params.length}`; }).join(',')})`).join(',');
  await client.query(`INSERT INTO uw_signal_outcomes (${columns.join(',')}) VALUES ${groups}
    ON CONFLICT (trade_id,horizon) DO UPDATE SET entry_at=EXCLUDED.entry_at,entry_price=EXCLUDED.entry_price,
    outcome_at=EXCLUDED.outcome_at,outcome_price=EXCLUDED.outcome_price,spy_entry_price=EXCLUDED.spy_entry_price,
    spy_outcome_price=EXCLUDED.spy_outcome_price,return_pct=EXCLUDED.return_pct,spy_return_pct=EXCLUDED.spy_return_pct,
    excess_return_pct=EXCLUDED.excess_return_pct,exclusion_reason=EXCLUDED.exclusion_reason,calculated_at=EXCLUDED.calculated_at`, params);
};

try {
  const client = await pool.connect();
  try {
    await client.query('TRUNCATE TABLE uw_signal_outcomes RESTART IDENTITY');
    let lastId = 0; let copied = 0;
    while (copied < total) {
      const rows = sqlite.prepare(`SELECT ${columns.join(',')} FROM uw_signal_outcomes WHERE id > ? ORDER BY id LIMIT ?`).all(lastId, BATCH);
      if (!rows.length) break;
      await client.query('BEGIN');
      await insert(client, rows.map(row => columns.map(column => row[column])));
      await client.query('COMMIT');
      lastId = Number(rows[rows.length - 1].id); copied += rows.length;
      if (copied % 10_000 === 0 || copied === total) console.log(`outcomes: ${copied}/${total}`);
    }
    await client.query(`SELECT setval(pg_get_serial_sequence('uw_signal_outcomes','id'), COALESCE((SELECT MAX(id) FROM uw_signal_outcomes), 1), true)`);
  } finally { client.release(); }
} finally { sqlite.close(); await pool.end(); }
