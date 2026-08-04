"""
Logging for the Gmail OAuth flow: console (via stdlib `logging`) plus a
persistent SQLite log (`diagnostics.db`) queryable via GET /diagnostics.

Google's own authorization errors (like "origin_mismatch") happen entirely on
Google's side, in the browser, and never touch this server -- so this can't
capture those directly. What it *can* capture: every step this backend took
or received as part of the flow (what redirect_uri/scopes were sent, whether
the callback succeeded, why a later call failed, every HTTP request/response
with timing) so there's a persistent, queryable record instead of relying on
whatever happened to scroll by in the terminal.
"""

import json
import logging
import sqlite3
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

DB_PATH = Path(__file__).parent / "diagnostics.db"

logger = logging.getLogger("gmail_backend")

_LEVEL_TO_LOG_FN = {
    "debug": logger.debug,
    "info": logger.info,
    "warning": logger.warning,
    "error": logger.error,
}


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            level TEXT NOT NULL,
            event TEXT NOT NULL,
            detail TEXT
        )
        """
    )
    return conn


def log_event(
    event: str,
    detail: Optional[dict] = None,
    level: str = "info",
    exc: Optional[BaseException] = None,
) -> None:
    """Record one event to both the console and diagnostics.db.

    Pass `exc` (the caught exception) to also capture its type and traceback
    in the stored detail -- useful in dev when a one-line message isn't enough
    to see what actually went wrong.
    """
    detail = dict(detail or {})
    if exc is not None:
        detail["exception_type"] = type(exc).__name__
        detail["traceback"] = "".join(
            traceback.format_exception(type(exc), exc, exc.__traceback__)
        )[-4000:]

    log_fn = _LEVEL_TO_LOG_FN.get(level, logger.info)
    log_fn("%s | %s", event, json.dumps(detail, default=str))

    try:
        with _connect() as conn:
            conn.execute(
                "INSERT INTO events (timestamp, level, event, detail) VALUES (?, ?, ?, ?)",
                (
                    datetime.now(timezone.utc).isoformat(),
                    level,
                    event,
                    json.dumps(detail, default=str),
                ),
            )
    except Exception:
        # Diagnostics are best-effort: a logging failure should never break
        # the request it's trying to describe. Still surface it on console.
        logger.exception("Failed to write diagnostics event %r to sqlite", event)


def recent_events(limit: int = 50, level: Optional[str] = None) -> list[dict]:
    query = "SELECT id, timestamp, level, event, detail FROM events"
    params: tuple = ()
    if level:
        query += " WHERE level = ?"
        params = (level,)
    query += " ORDER BY id DESC LIMIT ?"
    params = params + (limit,)

    with _connect() as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(query, params).fetchall()
    return [
        {
            "id": row["id"],
            "timestamp": row["timestamp"],
            "level": row["level"],
            "event": row["event"],
            "detail": json.loads(row["detail"]) if row["detail"] else {},
        }
        for row in rows
    ]
