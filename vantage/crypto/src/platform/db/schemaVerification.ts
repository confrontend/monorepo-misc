import type { DatabaseSync } from 'node:sqlite';

type RequiredTable = {
  columns: readonly string[];
};

/** Runtime contract for tables used by long-running fetches and audit writes. Keep this list
 * focused on operationally critical tables; migrations remain the source of schema creation. */
const requiredTables: Record<string, RequiredTable> = {
  copytrade_dune_fetch_audits: {
    columns: [
      'id',
      'requested_at',
      'completed_at',
      'mode',
      'wallet_count',
      'wallet_addresses',
      'planned_targets',
      'submitted_targets',
      'stored_targets',
      'failed_targets',
      'remaining_targets',
      'gmgn_screen_rule_version',
      'gmgn_data_fingerprint',
      'selected_target_ids',
      'status',
      'message',
    ],
  },
  copytrade_fetch_runs: {
    columns: ['id', 'status', 'wallet_done', 'wallet_total', 'requests_made', 'trades_fetched'],
  },
  copytrade_copy_simulation_matches: {
    columns: ['trade_id', 'status'],
  },
  copytrade_minimum_capital_results: {
    columns: [
      'wallet_address',
      'chain',
      'calculation_version',
      'gmgn_data_fingerprint',
      'dune_history_fingerprint',
      'fee_model_version',
      'minimum_capital_rule_version',
      'tested_configurations',
      'calculated_at',
    ],
  },
  copytrade_minimum_capital_runs: {
    columns: ['id', 'status', 'wallet_addresses', 'wallet_total', 'wallet_done', 'results_json'],
  },
};

const tableColumns = (database: DatabaseSync, tableName: string): Set<string> =>
  new Set(
    database
      .prepare(`PRAGMA table_info(${tableName})`)
      .all()
      .map((row) => (row as { name: string }).name),
  );

/** Verify the runtime schema after migrations, before request handling begins. */
export const verifyDatabaseSchema = (database: DatabaseSync): void => {
  const missing: string[] = [];
  for (const [tableName, requirement] of Object.entries(requiredTables)) {
    const columns = tableColumns(database, tableName);
    if (!columns.size) {
      missing.push(`${tableName} (table missing)`);
      continue;
    }
    for (const column of requirement.columns) {
      if (!columns.has(column)) missing.push(`${tableName}.${column}`);
    }
  }
  if (missing.length) {
    throw new Error(
      `SQLite schema verification failed. Missing: ${missing.join(', ')}. ` +
        'Stop the server and run the latest migrations before retrying.',
    );
  }
};
