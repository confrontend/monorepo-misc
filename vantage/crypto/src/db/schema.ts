import type { DatabaseSync } from 'node:sqlite';

interface Migration {
  description: string;
  up: (database: DatabaseSync) => void;
}

const migrations: Migration[] = [
  {
    description: 'V1 token cohort, GMGN signals, and Dune ingestion audit',
    up: (database) => {
      database.exec(`
        CREATE TABLE tokens (
          token_address TEXT PRIMARY KEY,
          symbol TEXT,
          first_trade_time TEXT,
          first_dex TEXT,
          first_tx TEXT,
          source TEXT NOT NULL,
          imported_at TEXT NOT NULL,
          raw_payload TEXT NOT NULL,
          validation_errors TEXT NOT NULL DEFAULT '[]'
        );

        CREATE INDEX idx_tokens_first_trade_time ON tokens(first_trade_time);

        CREATE TABLE gmgn_signals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          observed_at TEXT,
          token_address TEXT,
          signal_type TEXT,
          market_cap REAL,
          triggering_wallet TEXT,
          raw_wallet_labels TEXT,
          source_url TEXT,
          ingestion_latency_ms INTEGER,
          raw_payload TEXT NOT NULL,
          captured_at TEXT NOT NULL,
          validation_errors TEXT NOT NULL DEFAULT '[]'
        );

        CREATE INDEX idx_gmgn_signals_token_address
          ON gmgn_signals(token_address);
        CREATE INDEX idx_gmgn_signals_observed_at
          ON gmgn_signals(observed_at);
        CREATE INDEX idx_gmgn_signals_signal_type
          ON gmgn_signals(signal_type);

        CREATE TABLE dune_import_batches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_path TEXT NOT NULL,
          source_sha256 TEXT NOT NULL UNIQUE,
          source_format TEXT NOT NULL CHECK(source_format IN ('csv', 'json', 'unknown')),
          raw_source TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed')),
          imported_count INTEGER NOT NULL DEFAULT 0,
          skipped_count INTEGER NOT NULL DEFAULT 0,
          error_count INTEGER NOT NULL DEFAULT 0,
          imported_at TEXT NOT NULL,
          completed_at TEXT,
          error TEXT
        );

        CREATE TABLE dune_import_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          batch_id INTEGER NOT NULL REFERENCES dune_import_batches(id),
          row_number INTEGER NOT NULL,
          token_address TEXT,
          status TEXT NOT NULL CHECK(status IN ('imported', 'skipped', 'error')),
          errors TEXT NOT NULL DEFAULT '[]',
          raw_payload TEXT NOT NULL,
          captured_at TEXT NOT NULL,
          UNIQUE(batch_id, row_number)
        );

        CREATE INDEX idx_dune_import_records_batch
          ON dune_import_records(batch_id, row_number);
      `);
    },
  },
  {
    description: 'immutable processed-source archive provenance',
    up: (database) => {
      database.exec(`
        ALTER TABLE dune_import_batches ADD COLUMN archive_path TEXT;
        ALTER TABLE dune_import_batches ADD COLUMN archive_sha256 TEXT;
        ALTER TABLE dune_import_batches ADD COLUMN archived_at TEXT;
      `);
    },
  },
  {
    description: 'append-only diagnostic log for request-level troubleshooting',
    up: (database) => {
      database.exec(`
        CREATE TABLE diagnostic_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          level TEXT NOT NULL CHECK(level IN ('info', 'warn', 'error')),
          event TEXT NOT NULL,
          method TEXT,
          path TEXT,
          status INTEGER,
          duration_ms INTEGER,
          request_bytes INTEGER,
          message TEXT,
          detail TEXT
        );

        CREATE INDEX idx_diagnostic_logs_created_at ON diagnostic_logs(created_at);
        CREATE INDEX idx_diagnostic_logs_level ON diagnostic_logs(level);
      `);
    },
  },
  {
    description: 'GMGN source-native event identity and trigger fields',
    up: (database) => {
      database.exec(`
        ALTER TABLE gmgn_signals ADD COLUMN source TEXT;
        ALTER TABLE gmgn_signals ADD COLUMN chain TEXT;
        ALTER TABLE gmgn_signals ADD COLUMN source_event_id TEXT;
        ALTER TABLE gmgn_signals ADD COLUMN trigger_at TEXT;
        ALTER TABLE gmgn_signals ADD COLUMN trigger_mc REAL;
        ALTER TABLE gmgn_signals ADD COLUMN first_trigger_mc REAL;
        ALTER TABLE gmgn_signals ADD COLUMN signal_times INTEGER;
        ALTER TABLE gmgn_signals ADD COLUMN signal_times_by_type TEXT;
        ALTER TABLE gmgn_signals ADD COLUMN query_market_cap REAL;
        ALTER TABLE gmgn_signals ADD COLUMN query_ath REAL;
        ALTER TABLE gmgn_signals ADD COLUMN query_cur_data TEXT;

        CREATE UNIQUE INDEX idx_gmgn_signals_source_identity
          ON gmgn_signals(source, chain, source_event_id)
          WHERE source IS NOT NULL AND chain IS NOT NULL AND source_event_id IS NOT NULL;
      `);
    },
  },
  {
    description: 'GMGN poll audit and coverage boundaries',
    up: (database) => {
      database.exec(`
        CREATE TABLE gmgn_polls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          poll_started_at TEXT NOT NULL,
          poll_completed_at TEXT,
          source TEXT NOT NULL,
          chain TEXT NOT NULL,
          cli_version TEXT,
          status TEXT NOT NULL CHECK(status IN ('started', 'completed', 'failed')),
          received_count INTEGER NOT NULL DEFAULT 0,
          stored_count INTEGER NOT NULL DEFAULT 0,
          repeated_count INTEGER NOT NULL DEFAULT 0,
          error_count INTEGER NOT NULL DEFAULT 0,
          oldest_trigger_at TEXT,
          newest_trigger_at TEXT,
          previous_newest_trigger_at TEXT,
          gap_start_at TEXT,
          gap_end_at TEXT,
          archive_path TEXT,
          archive_sha256 TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_gmgn_polls_started_at ON gmgn_polls(poll_started_at);
        CREATE INDEX idx_gmgn_polls_status ON gmgn_polls(status);
      `);
    },
  },
  {
    description: 'GMGN browser-extension capture import audit',
    up: (database) => {
      database.exec(`
        CREATE TABLE gmgn_browser_import_batches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_path TEXT NOT NULL,
          source_sha256 TEXT NOT NULL UNIQUE,
          raw_source TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed')),
          imported_count INTEGER NOT NULL DEFAULT 0,
          skipped_count INTEGER NOT NULL DEFAULT 0,
          error_count INTEGER NOT NULL DEFAULT 0,
          imported_at TEXT NOT NULL,
          completed_at TEXT,
          archive_path TEXT,
          archive_sha256 TEXT,
          archived_at TEXT,
          error TEXT
        );
        CREATE INDEX idx_gmgn_browser_import_batches_imported_at
          ON gmgn_browser_import_batches(imported_at);
      `);
    },
  },
  {
    description: 'GMGN browser-extension coverage windows (verified capture-active periods)',
    up: (database) => {
      database.exec(`
        CREATE TABLE gmgn_browser_coverage_windows (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          batch_id INTEGER NOT NULL REFERENCES gmgn_browser_import_batches(id),
          started_at TEXT NOT NULL,
          ended_at TEXT,
          last_heartbeat_at TEXT NOT NULL,
          closed_reason TEXT,
          imported_at TEXT NOT NULL
        );
        CREATE INDEX idx_gmgn_browser_coverage_windows_batch
          ON gmgn_browser_coverage_windows(batch_id);
        CREATE INDEX idx_gmgn_browser_coverage_windows_started_at
          ON gmgn_browser_coverage_windows(started_at);
      `);
    },
  },
  {
    description: 'Birdeye historical outcome probe evidence',
    up: (database) => {
      database.exec(`
        CREATE TABLE birdeye_probe_batches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token_address TEXT NOT NULL,
          target_timestamp TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('completed', 'partial', 'failed')),
          price_http_status INTEGER,
          liquidity_http_status INTEGER,
          price_raw_payload TEXT,
          liquidity_raw_payload TEXT,
          price_error TEXT,
          liquidity_error TEXT,
          archive_path TEXT,
          archive_sha256 TEXT,
          archived_at TEXT
        );
        CREATE INDEX idx_birdeye_probe_batches_token_time ON birdeye_probe_batches(token_address, target_timestamp);
      `);
    },
  },
  {
    description: 'Dune signal outcome executions',
    up: (database) => {
      database.exec(`
        CREATE TABLE dune_outcome_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          signal_ids TEXT NOT NULL,
          query_sql TEXT NOT NULL,
          execution_id TEXT,
          status TEXT NOT NULL,
          raw_result TEXT,
          archive_path TEXT,
          archive_sha256 TEXT,
          requested_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE INDEX idx_dune_outcome_runs_requested_at ON dune_outcome_runs(requested_at);
      `);
    },
  },
  {
    description: 'Signal pattern report snapshots',
    up: (database) => {
      database.exec(`
        CREATE TABLE signal_pattern_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          computed_at TEXT NOT NULL,
          params_json TEXT NOT NULL,
          source_run_ids_json TEXT NOT NULL,
          report_json TEXT NOT NULL
        );
        CREATE INDEX idx_signal_pattern_snapshots_computed_at ON signal_pattern_snapshots(computed_at);
      `);
    },
  },
  {
    description: 'GMGN raw radar, wallet rank, smart-money, and Twitter snapshots',
    up: (database) => {
      database.exec(`
        CREATE TABLE gmgn_radar_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chain TEXT,
          period TEXT,
          category TEXT,
          captured_at TEXT NOT NULL,
          raw_payload TEXT NOT NULL,
          source_sha256 TEXT NOT NULL UNIQUE
        );
        CREATE INDEX idx_gmgn_radar_snapshots_lookup
          ON gmgn_radar_snapshots(chain, period, category, captured_at);

        CREATE TABLE gmgn_wallet_rank_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          window TEXT,
          orderby TEXT,
          captured_at TEXT NOT NULL,
          raw_payload TEXT NOT NULL,
          source_sha256 TEXT NOT NULL UNIQUE
        );
        CREATE INDEX idx_gmgn_wallet_rank_snapshots_lookup
          ON gmgn_wallet_rank_snapshots(window, orderby, captured_at);

        CREATE TABLE gmgn_smartmoney_wallet_stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          wallet_address TEXT NOT NULL,
          chain TEXT,
          captured_at TEXT NOT NULL,
          raw_payload TEXT NOT NULL,
          source_sha256 TEXT NOT NULL
        );
        CREATE INDEX idx_gmgn_smartmoney_wallet_stats_lookup
          ON gmgn_smartmoney_wallet_stats(wallet_address, chain, captured_at);

        CREATE TABLE gmgn_twitter_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tweet_id TEXT,
          tw_type TEXT,
          has_token INTEGER,
          captured_at TEXT NOT NULL,
          raw_payload TEXT NOT NULL,
          source_event_id TEXT,
          source_sha256 TEXT NOT NULL UNIQUE
        );
        CREATE INDEX idx_gmgn_twitter_messages_lookup
          ON gmgn_twitter_messages(tweet_id, tw_type, captured_at);
        CREATE INDEX idx_gmgn_twitter_messages_source_event
          ON gmgn_twitter_messages(source_event_id);
      `);
    },
  },
  {
    description: 'Raw-endpoint import breakdown persisted per browser-import batch (for accurate duplicate-file reporting)',
    up: (database) => {
      database.exec(`
        ALTER TABLE gmgn_browser_import_batches ADD COLUMN raw_endpoints_json TEXT;
      `);
    },
  },
  {
    // The migration that originally created gmgn_smartmoney_wallet_stats was edited in place
    // after it had already run in this database (it briefly had `source_sha256 TEXT NOT NULL
    // UNIQUE`, matching the other three raw-endpoint tables, before being corrected to plain
    // `NOT NULL` so repeated wallet observations stay append-only per src/gmgn/smartmoney.ts's
    // intent). Editing already-applied migration text has no effect on a database where it
    // already ran — SQLite migrations here are tracked by count, not by re-diffing SQL — so any
    // database that had already migrated past that point is still silently carrying the old
    // UNIQUE constraint, causing every second capture of an unchanged wallet (very common for
    // inactive/low-volume wallets) to throw an uncaught constraint violation. SQLite has no
    // ALTER TABLE ... DROP CONSTRAINT, so the fix is the standard rebuild: recreate the table
    // without the constraint, copy every row across untouched, then swap it in. A database that
    // never had the bad constraint (fresh installs from schema.ts's current text) just performs
    // a harmless no-op copy through this same path — no branching on which case applies.
    description: 'Drop the erroneous UNIQUE constraint on gmgn_smartmoney_wallet_stats.source_sha256 (rebuild — SQLite has no ALTER TABLE DROP CONSTRAINT)',
    up: (database) => {
      database.exec(`
        ALTER TABLE gmgn_smartmoney_wallet_stats RENAME TO gmgn_smartmoney_wallet_stats_old;
        CREATE TABLE gmgn_smartmoney_wallet_stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          wallet_address TEXT NOT NULL,
          chain TEXT,
          captured_at TEXT NOT NULL,
          raw_payload TEXT NOT NULL,
          source_sha256 TEXT NOT NULL
        );
        INSERT INTO gmgn_smartmoney_wallet_stats (id, wallet_address, chain, captured_at, raw_payload, source_sha256)
          SELECT id, wallet_address, chain, captured_at, raw_payload, source_sha256 FROM gmgn_smartmoney_wallet_stats_old;
        DROP TABLE gmgn_smartmoney_wallet_stats_old;
        CREATE INDEX idx_gmgn_smartmoney_wallet_stats_lookup
          ON gmgn_smartmoney_wallet_stats(wallet_address, chain, captured_at);
      `);
    },
  },
  {
    description: 'Versioned GMGN-to-Dune measurement pre-screen decisions',
    up: (database) => {
      database.exec(`
        CREATE TABLE dune_measurement_prescreen (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          signal_id INTEGER NOT NULL REFERENCES gmgn_signals(id),
          rule_version TEXT NOT NULL,
          decision_key TEXT NOT NULL UNIQUE,
          disposition TEXT NOT NULL,
          reason TEXT NOT NULL,
          signal_type TEXT,
          capture_date TEXT,
          cohort_matched INTEGER NOT NULL DEFAULT 0,
          planner_state TEXT NOT NULL,
          audit_seed TEXT,
          evaluated_at TEXT NOT NULL
        );
        CREATE INDEX idx_dune_measurement_prescreen_signal ON dune_measurement_prescreen(signal_id, id DESC);
        CREATE INDEX idx_dune_measurement_prescreen_disposition ON dune_measurement_prescreen(rule_version, disposition, signal_type, capture_date);
      `);
    },
  },
  {
    description: 'Cached measurement-plan snapshots for fast repeat reads',
    up: (database) => {
      database.exec(`
        CREATE TABLE measurement_plan_cache (
          cache_key TEXT PRIMARY KEY,
          rule_version TEXT NOT NULL,
          source_fingerprint TEXT NOT NULL,
          generated_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          plan_json TEXT NOT NULL
        );
      `);
    },
  },
  {
    // CopyTrade: evaluate whether a top-ranked GMGN trader is worth copying, using that
    // trader's own trade history from the official API (GET /v1/user/wallet_activity).
    //
    // Money values are stored as TEXT exactly as the source returned them. GMGN sends
    // high-precision decimal strings (e.g. "2923737.6948440451208930747") that would lose
    // precision through SQLite's REAL, and this project's standing rule is that source
    // observations are preserved verbatim — parsing happens at read time, in one place.
    description: 'CopyTrade wallet roster, trade history, fetch runs, and frozen result snapshots',
    up: (database) => {
      database.exec(`
        CREATE TABLE copytrade_wallets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          wallet_address TEXT NOT NULL,
          chain TEXT NOT NULL,
          name TEXT,
          source_snapshot_id INTEGER REFERENCES gmgn_wallet_rank_snapshots(id),
          rank_position INTEGER,
          reported_pnl_30d TEXT,
          reported_winrate_30d TEXT,
          risk_flags TEXT NOT NULL DEFAULT '[]',
          added_at TEXT NOT NULL,
          UNIQUE(wallet_address, chain, source_snapshot_id)
        );
        CREATE INDEX idx_copytrade_wallets_lookup
          ON copytrade_wallets(chain, rank_position);

        -- dedup_key deliberately combines more than tx_hash: one Solana transaction can
        -- contain several DEX legs (multi-hop/routed swaps), so tx_hash alone is not a unique
        -- row identity. This is the same class of mistake already fixed once in the Dune
        -- ranking SQL, where a tx_hash-only tie-break produced non-deterministic results.
        CREATE TABLE copytrade_trades (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          wallet_address TEXT NOT NULL,
          chain TEXT NOT NULL,
          tx_hash TEXT NOT NULL,
          event_type TEXT NOT NULL,
          token_address TEXT NOT NULL,
          token_symbol TEXT,
          observed_timestamp INTEGER NOT NULL,
          token_amount TEXT,
          cost_usd TEXT,
          buy_cost_usd TEXT,
          price_usd TEXT,
          gas_usd TEXT,
          dex_usd TEXT,
          launchpad_platform TEXT,
          raw_payload TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          dedup_key TEXT NOT NULL UNIQUE
        );
        CREATE INDEX idx_copytrade_trades_wallet
          ON copytrade_trades(wallet_address, observed_timestamp);
        CREATE INDEX idx_copytrade_trades_token
          ON copytrade_trades(token_address);

        CREATE TABLE copytrade_fetch_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          status TEXT NOT NULL,
          wallet_total INTEGER NOT NULL DEFAULT 0,
          wallet_done INTEGER NOT NULL DEFAULT 0,
          trades_fetched INTEGER NOT NULL DEFAULT 0,
          requests_made INTEGER NOT NULL DEFAULT 0,
          rate_limited_until TEXT,
          error TEXT
        );
        CREATE INDEX idx_copytrade_fetch_runs_status
          ON copytrade_fetch_runs(status, started_at);

        CREATE TABLE copytrade_result_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          computed_at TEXT NOT NULL,
          params_json TEXT NOT NULL,
          report_json TEXT NOT NULL
        );
        CREATE INDEX idx_copytrade_result_snapshots_computed_at
          ON copytrade_result_snapshots(computed_at);
      `);
    },
  },
  {
    // Per-wallet fetch outcome, so a truncated wallet can never be presented as a complete one.
    //
    // The time span actually covered is deliberately NOT stored here — it is derived from
    // copytrade_trades at read time. A stored copy would be a second source of truth that
    // drifts the moment any row is added by another path, and this project has already been
    // bitten by two implementations of the same number disagreeing.
    description: 'CopyTrade per-wallet fetch coverage: request cap, truncation, and stop reason',
    up: (database) => {
      database.exec(`
        CREATE TABLE copytrade_wallet_coverage (
          wallet_address TEXT NOT NULL,
          chain TEXT NOT NULL,
          last_run_id INTEGER REFERENCES copytrade_fetch_runs(id),
          requests_used INTEGER NOT NULL DEFAULT 0,
          truncated INTEGER NOT NULL DEFAULT 0,
          requested_period_days INTEGER,
          stop_reason TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (wallet_address, chain)
        );
      `);
    },
  },
  {
    // Wallet-level context behind a risk flag, from the official portfolio stats endpoint.
    //
    // Note what this does NOT contain: GMGN's "Phishing check" numbers (no_buy_hold, fast_tx,
    // sell_pass_buy) exist only on the browser endpoint /pf/api/v1/wallet/{chain}/{addr}/
    // profit_stat/{period}, not in the official API — verified live against a real wallet. So
    // the quantitative reason a wallet looks like a wash trader is computed from our own
    // stored trades instead (see evaluate.ts), and this table holds the surrounding facts the
    // official API does give: funding origin, wallet age, holding period, and PnL spread.
    description: 'CopyTrade per-wallet official stats: funding origin, holding period, PnL spread',
    up: (database) => {
      database.exec(`
        CREATE TABLE copytrade_wallet_stats (
          wallet_address TEXT NOT NULL,
          chain TEXT NOT NULL,
          period TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          tags TEXT,
          fund_from_address TEXT,
          fund_amount TEXT,
          created_at_ts INTEGER,
          avg_holding_period_seconds TEXT,
          winrate TEXT,
          token_num INTEGER,
          raw_payload TEXT NOT NULL,
          PRIMARY KEY (wallet_address, chain, period)
        );
      `);
    },
  },
  {
    description: 'CopyTrade append-only per-run wallet coverage events',
    up: (database) => {
      database.exec(`
        CREATE TABLE copytrade_wallet_coverage_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL REFERENCES copytrade_fetch_runs(id),
          wallet_address TEXT NOT NULL,
          chain TEXT NOT NULL,
          requested_period_days INTEGER,
          requests_used INTEGER NOT NULL,
          truncated INTEGER NOT NULL,
          stop_reason TEXT,
          oldest_held_ts INTEGER,
          newest_held_ts INTEGER,
          observed_at TEXT NOT NULL
        );
        CREATE INDEX idx_copytrade_coverage_events_wallet
          ON copytrade_wallet_coverage_events(wallet_address, chain, observed_at);
        CREATE INDEX idx_copytrade_coverage_events_run
          ON copytrade_wallet_coverage_events(run_id);
      `);
    },
  },
  {
    description: 'CopyTrade leaderboard request provenance and fetch-run scope',
    up: (database) => {
      database.exec(`
        CREATE TABLE gmgn_wallet_rank_capture_provenance (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          snapshot_id INTEGER NOT NULL REFERENCES gmgn_wallet_rank_snapshots(id),
          captured_at TEXT NOT NULL,
          request_path TEXT,
          request_query_json TEXT NOT NULL,
          window TEXT,
          orderby TEXT,
          capture_sha256 TEXT NOT NULL UNIQUE
        );
        CREATE INDEX idx_wallet_rank_provenance_snapshot
          ON gmgn_wallet_rank_capture_provenance(snapshot_id, captured_at);
        CREATE INDEX idx_wallet_rank_provenance_captured
          ON gmgn_wallet_rank_capture_provenance(captured_at);

        ALTER TABLE copytrade_fetch_runs ADD COLUMN requested_period_days INTEGER;
        ALTER TABLE copytrade_fetch_runs ADD COLUMN trader_limit INTEGER;
        ALTER TABLE copytrade_fetch_runs ADD COLUMN roster_snapshot_id INTEGER
          REFERENCES gmgn_wallet_rank_snapshots(id);
      `);
    },
  },
  {
    description: 'Running aggregate for CopyTrade fetch duration estimates',
    up: (database) => {
      // Deliberately a single running-total row rather than a view over the run history:
      // the estimate must never re-scan every past run's timestamps to answer "how long
      // will this take". last_run_id is the watermark — only runs newer than it are ever
      // folded in, and folding is additive, so the cost of maintaining the estimate is
      // O(1) per completed run no matter how much history accumulates.
      database.exec(`
        CREATE TABLE copytrade_fetch_estimate (
          cache_key TEXT PRIMARY KEY,
          last_run_id INTEGER NOT NULL,
          runs_counted INTEGER NOT NULL,
          total_seconds REAL NOT NULL,
          total_requests INTEGER NOT NULL,
          fresh_wallets INTEGER NOT NULL,
          fresh_requests INTEGER NOT NULL,
          covered_wallets INTEGER NOT NULL,
          covered_requests INTEGER NOT NULL,
          fresh_wallet_period_days REAL NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    description: 'CopyTrade walk-forward experiments (frozen rosters + future-only evaluation)',
    up: (database) => {
      // Append-only by design (see docs/COPYTRADE_PROSPECTIVE_VALIDATION_PLAN.md Phase 1): a
      // frozen roster must never be alterable by a later leaderboard snapshot, so there is no
      // UPDATE path on either table — only INSERT. UNIQUE(leaderboard_snapshot_id) is what makes
      // "duplicate freezes are idempotent" enforceable at the database level rather than only in
      // application code: re-freezing the same snapshot can never create a second experiment.
      database.exec(`
        CREATE TABLE copytrade_experiments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          selected_at_utc TEXT NOT NULL,
          leaderboard_snapshot_id INTEGER NOT NULL UNIQUE
            REFERENCES gmgn_wallet_rank_snapshots(id),
          leaderboard_provenance_id INTEGER NOT NULL
            REFERENCES gmgn_wallet_rank_capture_provenance(id),
          filter_hash TEXT NOT NULL,
          primary_top_n INTEGER NOT NULL,
          roster_top_n INTEGER NOT NULL,
          evaluation_windows_json TEXT NOT NULL,
          methodology_version TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_copytrade_experiments_selected_at
          ON copytrade_experiments(selected_at_utc);

        -- UNIQUE(experiment_id, wallet_address): a frozen roster can never gain, lose, or
        -- duplicate a wallet after creation. rank_at_selection and captured_source_fields_json
        -- are point-in-time facts copied at freeze time, independent of copytrade_wallets,
        -- which is free to accumulate newer rows from later snapshots without touching this one.
        CREATE TABLE copytrade_experiment_wallets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          experiment_id INTEGER NOT NULL REFERENCES copytrade_experiments(id),
          wallet_address TEXT NOT NULL,
          rank_at_selection INTEGER NOT NULL,
          selected_group TEXT NOT NULL,
          captured_source_fields_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(experiment_id, wallet_address)
        );
        CREATE INDEX idx_copytrade_experiment_wallets_experiment
          ON copytrade_experiment_wallets(experiment_id);
      `);
    },
  },
  {
    // Lets a truncated wallet's next fetch resume exactly where the last one stopped, instead
    // of always restarting at the newest trade and re-walking everything in between. Before
    // this, every run for a high-volume wallet burned most of its 200-request budget
    // re-confirming trades it already had, then often hit the cap again with little or no new
    // backward progress — confirmed live against this project's own database (14 of 25 roster
    // wallets on 2026-08-16). resume_cursor is cleared once a wallet's window is fully covered
    // (nothing left to resume) or its cursor turns out to be unusable.
    //
    // trades_duplicate/trades_daily_capped on the run row make that waste (and the new
    // per-day sampling cap) visible per run, rather than folded silently into trades_fetched.
    description: 'CopyTrade resume-cursor backfill + per-day sample cap + run-level duplicate/capped counters',
    up: (database) => {
      database.exec(`
        ALTER TABLE copytrade_wallet_coverage ADD COLUMN resume_cursor TEXT;
        ALTER TABLE copytrade_fetch_runs ADD COLUMN trades_duplicate INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE copytrade_fetch_runs ADD COLUMN trades_daily_capped INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    // Historical Copy Simulation (see docs/COPYTRADE_PROSPECTIVE_VALIDATION_PLAN.md's own
    // disclaimer, and the 2026-08-16 dune-density-spike research that cleared this for build).
    // Mirrors dune_outcome_runs' shape and conventions deliberately: a batch of Dune-price
    // lookups is one immutable run (query, execution id, raw result, archive path+hash),
    // never re-submitted for trade refs already covered by an in-flight or completed run.
    // trade_refs is the JSON array of copytrade_trades.id values this run covers, so a run is
    // self-describing without a join table — trades are never re-queried once a completed run
    // covers them, matching the proposal's "no duplicate Dune calls" requirement.
    description: 'CopyTrade Historical Copy Simulation — Dune entry/exit price-match runs',
    up: (database) => {
      database.exec(`
        CREATE TABLE copytrade_copy_simulation_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trade_refs TEXT NOT NULL,
          query_sql TEXT NOT NULL,
          status TEXT NOT NULL,
          execution_id TEXT,
          requested_at TEXT NOT NULL,
          completed_at TEXT,
          raw_result TEXT,
          archive_path TEXT,
          archive_sha256 TEXT
        );
        CREATE INDEX idx_copytrade_copy_simulation_runs_status
          ON copytrade_copy_simulation_runs(status);
      `);
    },
  },
  {
    // Explicit rather than inferred: a wallet-scoped run's roster_snapshot_id is NULL for both
    // "current Winners" and "one single trader by address/name", so that column alone can't
    // tell them apart — and inferring it from wallet_total (1 wallet = "single") breaks the
    // moment Winners itself narrows to exactly one wallet, which already happens live in this
    // project's own data. An explicit column removes the ambiguity outright.
    description: 'CopyTrade fetch runs gain an explicit fetch_scope, so each UI fetch box only ever shows status for its own kind of run',
    up: (database) => {
      database.exec(`
        ALTER TABLE copytrade_fetch_runs ADD COLUMN fetch_scope TEXT NOT NULL DEFAULT 'roster';
      `);
    },
  },
  {
    // Scaffolding only — the GMGN Top Caller endpoints (/api/v1/notification/callout/rank,
    // call_out/get_record, the follow/callout feed) have never been captured in this project.
    // gmgn-cli's own commands don't cover them, and no existing archive has a real payload, so
    // every GMGN-shaped field name here is a placeholder pending
    // research/prompts/top-callers-research.md, not a verified fact. raw_payload is kept
    // NOT NULL wherever GMGN data would land so nothing has to be guessed beyond what's stored
    // verbatim. See src/copytrade/topCallers.ts for what's actually wired up vs. left as a TODO.
    description: 'Top Callers scaffolding — leaderboard/callout/checkpoint schema, tracking, collection-run tracking',
    up: (database) => {
      database.exec(`
        CREATE TABLE top_caller_collection_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          status TEXT NOT NULL,
          requests_made INTEGER NOT NULL DEFAULT 0,
          rate_limited_until TEXT,
          error TEXT
        );
        CREATE INDEX idx_top_caller_collection_runs_kind
          ON top_caller_collection_runs(kind, started_at);

        CREATE TABLE top_caller_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL REFERENCES top_caller_collection_runs(id),
          captured_at TEXT NOT NULL,
          period TEXT,
          ordering TEXT,
          filters_json TEXT,
          raw_payload TEXT NOT NULL,
          archive_path TEXT,
          archive_sha256 TEXT
        );

        CREATE TABLE top_caller_snapshot_rows (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          snapshot_id INTEGER NOT NULL REFERENCES top_caller_snapshots(id),
          caller_key TEXT NOT NULL,
          rank_position INTEGER NOT NULL,
          call_count INTEGER,
          reported_avg_multiplier TEXT,
          reported_best_multiplier TEXT,
          reported_hit_rate_2x_pct TEXT,
          raw_payload TEXT NOT NULL
        );
        CREATE INDEX idx_top_caller_snapshot_rows_caller ON top_caller_snapshot_rows(caller_key);
        CREATE INDEX idx_top_caller_snapshot_rows_snapshot ON top_caller_snapshot_rows(snapshot_id);

        CREATE TABLE top_caller_tracked (
          caller_key TEXT PRIMARY KEY,
          tracked_at TEXT NOT NULL,
          untracked_at TEXT
        );

        CREATE TABLE top_caller_callouts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          caller_key TEXT NOT NULL,
          token_address TEXT NOT NULL,
          token_symbol TEXT,
          call_timestamp INTEGER NOT NULL,
          call_price_usd TEXT,
          call_market_cap_usd TEXT,
          message TEXT,
          reported_multiplier TEXT,
          source_call_id TEXT,
          raw_payload TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          dedup_key TEXT NOT NULL UNIQUE
        );
        CREATE INDEX idx_top_caller_callouts_caller ON top_caller_callouts(caller_key, call_timestamp);
        CREATE INDEX idx_top_caller_callouts_token ON top_caller_callouts(token_address);

        CREATE TABLE top_caller_outcomes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          callout_id INTEGER NOT NULL REFERENCES top_caller_callouts(id),
          checkpoint TEXT NOT NULL,
          requested_at_ts INTEGER NOT NULL,
          status TEXT NOT NULL,
          measured_price_usd TEXT,
          measured_return_pct REAL,
          matched_trade_at TEXT,
          gap_seconds INTEGER,
          dune_run_id INTEGER,
          computed_at TEXT NOT NULL,
          UNIQUE(callout_id, checkpoint)
        );
      `);
    },
  },
  {
    description: 'Top Callers collection run progress columns (per-wallet callouts fetch was a silent black box: 0 the whole run, then a jump to 1)',
    up: (database) => {
      database.exec(`
        ALTER TABLE top_caller_collection_runs ADD COLUMN wallet_total INTEGER;
        ALTER TABLE top_caller_collection_runs ADD COLUMN wallet_done INTEGER;
      `);
    },
  },
  {
    description: 'Top Callers bounded retry state and frozen wallet snapshot',
    up: (database) => {
      database.exec(`
        ALTER TABLE top_caller_collection_runs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE top_caller_collection_runs ADD COLUMN next_retry_at TEXT;
        ALTER TABLE top_caller_collection_runs ADD COLUMN wallet_snapshot_json TEXT;
      `);
    },
  },
];

export const latestSchemaVersion = migrations.length;

export const applyMigrations = (database: DatabaseSync): void => {
  database.exec('PRAGMA foreign_keys = ON;');
  const row = database.prepare('PRAGMA user_version').get() as { user_version: number };
  let currentVersion = row.user_version;

  if (currentVersion > latestSchemaVersion) {
    throw new Error(
      `Database schema version ${currentVersion} is newer than supported version ${latestSchemaVersion}.`,
    );
  }

  for (let index = currentVersion; index < migrations.length; index += 1) {
    const migration = migrations[index];
    database.exec('BEGIN IMMEDIATE;');
    try {
      migration.up(database);
      database.exec(`PRAGMA user_version = ${index + 1};`);
      database.exec('COMMIT;');
      currentVersion = index + 1;
    } catch (error) {
      database.exec('ROLLBACK;');
      throw new Error(`Migration ${index + 1} failed (${migration.description}).`, { cause: error });
    }
  }
};
