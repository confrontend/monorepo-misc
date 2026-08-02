"""
Orchestration layer tying the pieces together for a single-ticker run:
ingest -> episode-trigger detection -> score -> decide -> immutable reviews
row -> entry-price job -> outcome-tracking job -> report.

This module is what a scheduled job / CLI entry point calls; the individual
pieces (episodes.py, required_inputs.py, jobs/*) stay independently testable.
"""
from __future__ import annotations

import sqlite3
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from .episodes import run_episode
from .jobs.entry_price_job import run_entry_price_job
from .jobs.outcome_tracking_job import run_outcome_tracking_job
from .price_source import PriceDataSource
from .required_inputs import retry_insufficient_data
from .reports import render_report
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


def run_ati_demo(conn: sqlite3.Connection, as_of_date: date, seed: int = 42) -> dict:
    """Runs the required first end-to-end test case (implementation prompt:
    "run the full pipeline end-to-end on ticker ATI first") using synthetic
    seed data, fast-forwarding time so entries and all four outcome horizons
    resolve within a single call."""
    from .ingestion.seed_demo_data import FUTURE_HORIZON_TRADING_DAYS, TICKER, seed_demo_data
    from .price_source import InMemoryPriceSource

    calendar = default_calendar
    price_source = InMemoryPriceSource()
    seed_demo_data(conn, price_source, calendar, as_of_date, seed=seed)

    episode_ids = run_episode(conn, TICKER, as_of_date, calendar=calendar)
    if not episode_ids:
        cases = conn.execute(
            "SELECT * FROM insufficient_data_cases WHERE resolved = FALSE"
        ).fetchall()
        return {"episode_id": None, "insufficient_data_cases": [dict(c) for c in cases]}
    episode_id = episode_ids[0]

    decision_ts = datetime.fromisoformat(
        conn.execute("SELECT decision_timestamp_utc FROM reviews WHERE episode_id = ?", (episode_id,)).fetchone()[0]
        .replace("Z", "+00:00")
    )
    entry_date, market_open_ts = calendar.next_market_open_after(decision_ts)
    now_after_open = market_open_ts + timedelta(hours=1)
    run_entry_price_job(conn, price_source, calendar=calendar, now=now_after_open)

    far_future_date = entry_date + timedelta(days=FUTURE_HORIZON_TRADING_DAYS * 2)
    far_future_close = calendar.session_close(far_future_date) or datetime.combine(
        far_future_date, market_open_ts.time(), tzinfo=timezone.utc
    )
    now_after_all_horizons = far_future_close + timedelta(hours=1)
    run_outcome_tracking_job(conn, price_source, calendar=calendar, now=now_after_all_horizons)

    report_text = render_report(conn, episode_id)
    return {"episode_id": episode_id, "report": report_text}
