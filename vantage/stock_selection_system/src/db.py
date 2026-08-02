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


def init_db(db_path: str, schema_path: Path = SCHEMA_PATH) -> sqlite3.Connection:
    """Creates all tables/indexes/triggers (idempotent, IF NOT EXISTS) and
    returns an open, foreign-key-enforcing connection."""
    conn = get_connection(db_path)
    schema_sql = schema_path.read_text()
    conn.executescript(schema_sql)
    conn.commit()
    return conn
