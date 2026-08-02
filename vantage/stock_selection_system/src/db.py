"""
Database connection + schema initialization helpers.

SQLite does not enforce FOREIGN KEY constraints by default -- every connection
opened through `get_connection()` runs `PRAGMA foreign_keys = ON;` immediately,
per the schema's requirement.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema.sql"


def get_connection(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


# Columns added to already-existing tables after their CREATE TABLE was
# first written. `CREATE TABLE IF NOT EXISTS` is a no-op once a table
# already exists, so a database file created with an older schema.sql would
# silently keep missing these forever without an explicit ALTER TABLE here.
# (Brand-new TABLES, e.g. consumed_triggers, don't need an entry -- IF NOT
# EXISTS handles those correctly on its own; this list is only for columns
# added to a table that already existed before.)
_COLUMN_MIGRATIONS: list[tuple[str, str, str]] = [
    ("reviews", "eligibility_date", "DATE"),
    ("insufficient_data_cases", "trigger_source_table", "TEXT"),
    ("insufficient_data_cases", "trigger_source_row_id", "INTEGER"),
    ("candidates", "direction", "TEXT"),
    ("candidates", "raw_source_data", "TEXT"),
]

# Indexes whose column list has changed since they were first introduced.
# `CREATE INDEX IF NOT EXISTS` only checks whether the NAME already exists --
# it does not detect or fix a stale definition under that name -- so these
# are dropped unconditionally here and left for the schema script (re-run
# right after _migrate()) to recreate fresh with the current definition.
_INDEXES_TO_REFRESH = ["unique_unresolved_audit_case"]


def _migrate(conn: sqlite3.Connection) -> None:
    existing_tables = {
        row["name"] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    }
    for table, column, coltype in _COLUMN_MIGRATIONS:
        if table not in existing_tables:
            continue  # brand-new db -- the CREATE TABLE just above already includes it
        cols = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        if column not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {coltype}")
    for index_name in _INDEXES_TO_REFRESH:
        conn.execute(f"DROP INDEX IF EXISTS {index_name}")
    conn.commit()


def init_db(db_path: str, schema_path: Path = SCHEMA_PATH) -> sqlite3.Connection:
    """Creates all tables/indexes/triggers (idempotent, IF NOT EXISTS) and
    returns an open, foreign-key-enforcing connection. Also safe to call
    against an EXISTING database file created by an older version of this
    schema: _migrate() adds any columns and drops any indexes that
    IF NOT EXISTS can't retrofit onto an already-existing table on its own,
    then the schema script runs a second time so those just-dropped indexes
    get recreated with their current definition. No data is dropped or
    rewritten -- only ALTER TABLE ADD COLUMN and index DROP/CREATE.

    Scope note: this is a bridge from "the schema version immediately
    before this one," not a full historical migration chain. The FIRST
    executescript() call below runs the CURRENT schema.sql as-is, so if a
    database predates a column that one of schema.sql's own index/trigger
    definitions already depends on (e.g. reviews.resolved_from_audit_id,
    referenced by unique_resolved_from_audit_id), that call will fail with
    'no such column' before _migrate() ever runs. _COLUMN_MIGRATIONS only
    needs entries for columns added since the LAST time this list was
    updated -- if this project ever needs to support upgrading databases
    across multiple non-consecutive schema versions, this should become a
    proper numbered-migrations table instead."""
    conn = get_connection(db_path)
    schema_sql = schema_path.read_text()
    conn.executescript(schema_sql)
    conn.commit()
    _migrate(conn)
    conn.executescript(schema_sql)
    conn.commit()
    return conn
