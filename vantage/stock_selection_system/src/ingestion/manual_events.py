"""
Manual-entry (and CSV-import) population paths for guidance_events,
insider_purchases, material_events, and earnings_calendar -- per the
implementation prompt, these "may start as simple CSV-import or manual-form
entry points; automation can come later."

These tables have no UNIQUE constraint in the frozen schema (unlike the
automated-ingestion tables in base.py), so re-importing the same CSV twice
will duplicate rows -- this mirrors the spec as literally given rather than
silently inventing a dedup key the spec doesn't define. Callers driving a
repeatable CSV-import workflow should track what's already been imported
(e.g. by filename/checksum) at the calling layer.
"""
from __future__ import annotations

import csv
import sqlite3
from pathlib import Path


def add_guidance_event(conn: sqlite3.Connection, ticker: str, event_date, guidance_direction: str, detail: str = "", source: str = "manual") -> int:
    on_date = event_date.isoformat() if hasattr(event_date, "isoformat") else event_date
    cur = conn.execute(
        "INSERT INTO guidance_events (ticker, event_date, guidance_direction, detail, source) "
        "VALUES (?, ?, ?, ?, ?)",
        (ticker, on_date, guidance_direction, detail, source),
    )
    conn.commit()
    return cur.lastrowid


def add_insider_purchase(conn: sqlite3.Connection, ticker: str, transaction_date, insider_name: str, insider_title: str, purchase_value_usd: float, transaction_type: str = "open-market", source: str = "manual") -> int:
    on_date = transaction_date.isoformat() if hasattr(transaction_date, "isoformat") else transaction_date
    cur = conn.execute(
        "INSERT INTO insider_purchases (ticker, transaction_date, insider_name, insider_title, "
        "purchase_value_usd, transaction_type, source) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (ticker, on_date, insider_name, insider_title, purchase_value_usd, transaction_type, source),
    )
    conn.commit()
    return cur.lastrowid


def add_material_event(conn: sqlite3.Connection, ticker: str, event_date, event_type: str, polarity: str, detail: str = "", source: str = "manual") -> int:
    on_date = event_date.isoformat() if hasattr(event_date, "isoformat") else event_date
    cur = conn.execute(
        "INSERT INTO material_events (ticker, event_date, event_type, polarity, detail, source) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (ticker, on_date, event_type, polarity, detail, source),
    )
    conn.commit()
    return cur.lastrowid


def add_earnings_calendar_entry(conn: sqlite3.Connection, ticker: str, scheduled_report_date, confirmed: bool = False, source: str = "manual") -> None:
    on_date = scheduled_report_date.isoformat() if hasattr(scheduled_report_date, "isoformat") else scheduled_report_date
    conn.execute(
        "INSERT INTO earnings_calendar (ticker, scheduled_report_date, confirmed, source) "
        "VALUES (?, ?, ?, ?)",
        (ticker, on_date, confirmed, source),
    )
    conn.commit()


# -- CSV import ---------------------------------------------------------------------

def import_guidance_events_csv(conn: sqlite3.Connection, csv_path) -> int:
    """Expects columns: ticker, event_date, guidance_direction, detail (optional), source (optional)."""
    n = 0
    with open(csv_path, newline="") as f:
        for row in csv.DictReader(f):
            add_guidance_event(
                conn, row["ticker"], row["event_date"], row["guidance_direction"],
                row.get("detail", ""), row.get("source", "csv_import"),
            )
            n += 1
    return n


def import_insider_purchases_csv(conn: sqlite3.Connection, csv_path) -> int:
    """Expects columns: ticker, transaction_date, insider_name, insider_title,
    purchase_value_usd, transaction_type (optional, default open-market), source (optional)."""
    n = 0
    with open(csv_path, newline="") as f:
        for row in csv.DictReader(f):
            add_insider_purchase(
                conn, row["ticker"], row["transaction_date"], row["insider_name"],
                row.get("insider_title", ""), float(row["purchase_value_usd"]),
                row.get("transaction_type", "open-market"), row.get("source", "csv_import"),
            )
            n += 1
    return n


def import_material_events_csv(conn: sqlite3.Connection, csv_path) -> int:
    """Expects columns: ticker, event_date, event_type, polarity, detail (optional), source (optional)."""
    n = 0
    with open(csv_path, newline="") as f:
        for row in csv.DictReader(f):
            add_material_event(
                conn, row["ticker"], row["event_date"], row["event_type"], row["polarity"],
                row.get("detail", ""), row.get("source", "csv_import"),
            )
            n += 1
    return n


def import_earnings_calendar_csv(conn: sqlite3.Connection, csv_path) -> int:
    """Expects columns: ticker, scheduled_report_date, confirmed (optional, 0/1), source (optional)."""
    n = 0
    with open(csv_path, newline="") as f:
        for row in csv.DictReader(f):
            add_earnings_calendar_entry(
                conn, row["ticker"], row["scheduled_report_date"],
                bool(int(row.get("confirmed", 0))), row.get("source", "csv_import"),
            )
            n += 1
    return n
