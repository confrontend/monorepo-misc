/**
 * Database selection is kept in one place so the HTTP layer and workers cannot
 * silently disagree about which store they use during the PostgreSQL cutover.
 * The current research implementation still requires the synchronous SQLite
 * handle; PostgreSQL is therefore an explicit migration target, not a hidden
 * partial fallback.
 */
export type DatabaseBackend = 'sqlite' | 'postgres';

export const configuredDatabaseBackend = (): DatabaseBackend => {
  const value = (process.env.UNUSUAL_WHALES_DB_BACKEND ?? 'sqlite').trim().toLowerCase();
  if (value === 'postgres') return 'postgres';
  return 'sqlite';
};

export const databaseBackendStatus = () => ({
  configured: configuredDatabaseBackend(),
  sqlitePath: process.env.UNUSUAL_WHALES_DB_PATH ?? '.data/unusual-whales.sqlite',
  postgresConfigured: Boolean(process.env.POSTGRES_URL),
  cutoverReady: false,
  note: configuredDatabaseBackend() === 'postgres'
    ? 'PostgreSQL is the explicit live backend for comparison, diagnostics, and recent call/put sync. Historical backfill remains unavailable in this mode.'
    : 'SQLite remains the default legacy backend. PostgreSQL contains a validated copy and can be selected explicitly with UNUSUAL_WHALES_DB_BACKEND=postgres.',
});

let postgresPool: pg.Pool | null = null;

const getPostgresPool = () => postgresPool ??= new Pool({
  connectionString: process.env.POSTGRES_URL ?? 'postgres://unusualwhales:unusualwhales-local-only@127.0.0.1:54329/unusualwhales',
  max: 1,
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 5_000,
});

export const postgresResearchPool = () => getPostgresPool();

/** A cheap, bounded readiness check used by health/diagnostics only. */
export const checkPostgresReadiness = async () => {
  try {
    await getPostgresPool().query('SELECT 1');
    return { reachable: true, counts: null, error: null };
  } catch (error) {
    return { reachable: false, counts: null, error: error instanceof Error ? error.message : 'PostgreSQL readiness check failed' };
  }
};

export const closePostgresReadinessPool = async () => {
  if (postgresPool) { await postgresPool.end(); postgresPool = null; }
};
import pg from 'pg';

const { Pool } = pg;
