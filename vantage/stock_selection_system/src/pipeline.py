"""
Orchestration layer tying the pieces together for a single-ticker run:
ingest -> episode-trigger detection -> score -> decide -> immutable reviews
row -> entry-price job -> outcome-tracking job -> report.

This module is what a scheduled job / CLI entry point calls; the individual
pieces (episodes.py, required_inputs.py, jobs/*) stay independently testable.
"""
from __future__ import annotations

import sqlite3
from datetime import date, datetime, timezone
from typing import Optional

from .episodes import run_episode
from .jobs.entry_price_job import run_entry_price_job
from .jobs.outcome_tracking_job import run_outcome_tracking_job
from .price_source import PriceDataSource
from .required_inputs import retry_insufficient_data
from .trading_calendar import TradingCalendar, default_calendar


def run_daily_cycle(
    conn: sqlite3.Connection,
    tickers: list[str],
    as_of_date: date,
    price_source: PriceDataSource,
    calendar: TradingCalendar = default_calendar,
    now: Optional[datetime] = None,
) -> dict:
    """One full daily cycle across a watchlist: episode-trigger detection +
    scoring for each ticker (run_episode processes ALL pending triggers per
    ticker, not just the earliest), insufficient-data retries, entry-price
    recording, and close-aware outcome tracking. Returns a summary dict for
    logging/inspection."""
    now = now or datetime.now(timezone.utc)

    new_episode_ids: list[str] = []
    for ticker in tickers:
        new_episode_ids.extend(run_episode(conn, ticker, as_of_date, calendar=calendar))

    def _retry_adapter(**kwargs):
        from .episodes import run_episode_for_retry

        return run_episode_for_retry(conn=conn, calendar=calendar, **kwargs)

    resolved_ids = retry_insufficient_data(conn, _retry_adapter, today=as_of_date, calendar=calendar)

    entries_written = run_entry_price_job(conn, price_source, calendar=calendar, now=now)
    outcomes_written = run_outcome_tracking_job(conn, price_source, calendar=calendar, now=now)

    return {
        "new_episode_ids": new_episode_ids,
        "resolved_from_retry": resolved_ids,
        "entries_written": entries_written,
        "outcomes_written": outcomes_written,
    }
