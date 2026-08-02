"""
Entry-price recording job (implementation prompt, "Entry-price recording").

Run frequently (at minimum around each session's open). For every `reviews`
row without a corresponding `episode_entries` row: determines the applicable
entry session via `TradingCalendar.next_market_open_after(decision_timestamp_utc)`,
waits until that session has actually opened, then fetches and records the
three entry OPENS plus the sector benchmark ticker (frozen permanently for
this episode's outcome-tracking lifetime -- looked up from security_metadata
right now, never re-looked-up later).
"""
from __future__ import annotations

import sqlite3
from datetime import date, datetime, timezone
from typing import Optional

from ..price_source import PriceDataSource
from ..trading_calendar import TradingCalendar, default_calendar


def _parse_timestamp(v) -> datetime:
    ts = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts


def run_entry_price_job(
    conn: sqlite3.Connection,
    price_source: PriceDataSource,
    calendar: TradingCalendar = default_calendar,
    now: Optional[datetime] = None,
) -> list[str]:
    now = now or datetime.now(timezone.utc)
    written: list[str] = []

    pending = conn.execute(
        "SELECT r.episode_id, r.ticker, r.decision_timestamp_utc FROM reviews r "
        "LEFT JOIN episode_entries e ON e.episode_id = r.episode_id "
        "WHERE e.episode_id IS NULL"
    ).fetchall()

    for row in pending:
        episode_id = row["episode_id"]
        ticker = row["ticker"]
        decision_ts = _parse_timestamp(row["decision_timestamp_utc"])

        entry_date, market_open_ts = calendar.next_market_open_after(decision_ts)
        if market_open_ts.tzinfo is None:
            market_open_ts = market_open_ts.replace(tzinfo=timezone.utc)
        if market_open_ts > now:
            continue  # the applicable session hasn't opened yet

        meta = conn.execute(
            "SELECT sector_benchmark_ticker FROM security_metadata WHERE ticker = ?", (ticker,)
        ).fetchone()
        if meta is None or meta["sector_benchmark_ticker"] is None:
            continue  # can't fix a sector benchmark yet; retry on a later run
        sector_ticker = meta["sector_benchmark_ticker"]

        stock_open = price_source.get_open(ticker, entry_date)
        spy_open = price_source.get_open("SPY", entry_date)
        sector_open = price_source.get_open(sector_ticker, entry_date)
        if stock_open is None or spy_open is None or sector_open is None:
            continue  # upstream data not published yet; retry on a later run

        conn.execute(
            "INSERT INTO episode_entries (episode_id, entry_date, stock_entry_open, "
            "spy_entry_open, sector_entry_open, sector_benchmark_ticker) VALUES (?, ?, ?, ?, ?, ?)",
            (episode_id, entry_date.isoformat(), stock_open, spy_open, sector_open, sector_ticker),
        )
        conn.commit()
        written.append(episode_id)

    return written
