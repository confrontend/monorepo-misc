"""
Outcome-tracking job (implementation prompt, "Outcome tracking").

For each `episode_entries` row, computes each `exit_date` as
`add_trading_days(entry_date, horizon)` for horizon in [7, 30, 90, 180]
(entry_date is day 0, never counted toward the horizon). Once `exit_date` has
ACTUALLY CLOSED -- not just once its calendar date has arrived, since a
date-only check would let this job record a "closing price" mid-session,
before the real close exists -- fetches CLOSING prices for the stock, SPY,
and the episode's own frozen `sector_benchmark_ticker` (never a fresh
security_metadata lookup), and computes OPEN-to-CLOSE returns using the entry
opens already recorded in episode_entries. Inserts one
`recommendation_outcomes` row per horizon, respecting
`UNIQUE (episode_id, horizon_days)` -- never updates an existing horizon's row.
"""
from __future__ import annotations

import sqlite3
from datetime import date, datetime, timezone
from typing import Optional

from ..price_source import PriceDataSource
from ..trading_calendar import TradingCalendar, default_calendar

HORIZONS_TRADING_DAYS = (7, 30, 90, 180)


def _parse_date(v) -> date:
    if isinstance(v, date):
        return v
    return datetime.strptime(str(v)[:10], "%Y-%m-%d").date()


def _describe_result(stock_return: float, spy_return: float, sector_return: float) -> str:
    vs_spy = stock_return - spy_return
    vs_sector = stock_return - sector_return
    direction = "outperformed" if vs_spy >= 0 else "underperformed"
    return (
        f"Stock {stock_return:+.2%} vs SPY {spy_return:+.2%} vs sector {sector_return:+.2%} "
        f"({direction} SPY by {vs_spy:+.2%}, sector by {vs_sector:+.2%})."
    )


def run_outcome_tracking_job(
    conn: sqlite3.Connection,
    price_source: PriceDataSource,
    calendar: TradingCalendar = default_calendar,
    now: Optional[datetime] = None,
) -> list[tuple[str, int]]:
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    today = now.date()
    written: list[tuple[str, int]] = []

    entries = conn.execute(
        "SELECT e.episode_id, e.entry_date, e.stock_entry_open, e.spy_entry_open, "
        "e.sector_entry_open, e.sector_benchmark_ticker, r.ticker FROM episode_entries e "
        "JOIN reviews r ON r.episode_id = e.episode_id"
    ).fetchall()

    for entry in entries:
        episode_id = entry["episode_id"]
        entry_date = _parse_date(entry["entry_date"])
        ticker = entry["ticker"]
        sector_ticker = entry["sector_benchmark_ticker"]

        for horizon in HORIZONS_TRADING_DAYS:
            already = conn.execute(
                "SELECT 1 FROM recommendation_outcomes WHERE episode_id = ? AND horizon_days = ?",
                (episode_id, horizon),
            ).fetchone()
            if already is not None:
                continue

            exit_date = calendar.add_trading_days(entry_date, horizon)
            if exit_date > today:
                continue  # this horizon hasn't elapsed yet
            if exit_date == today:
                # A date-only check can't distinguish "market closed an hour
                # ago" from "market opens in five minutes" -- both have
                # exit_date == today. Require the actual close timestamp to
                # have passed before treating today's close as knowable.
                close_ts = calendar.session_close(exit_date)
                if close_ts is None or now < close_ts:
                    continue

            stock_close = price_source.get_close(ticker, exit_date)
            spy_close = price_source.get_close("SPY", exit_date)
            sector_close = price_source.get_close(sector_ticker, exit_date)
            if stock_close is None or spy_close is None or sector_close is None:
                continue  # upstream data not published yet; retry on a later run

            stock_return = stock_close / entry["stock_entry_open"] - 1
            spy_return = spy_close / entry["spy_entry_open"] - 1
            sector_return = sector_close / entry["sector_entry_open"] - 1

            conn.execute(
                "INSERT INTO recommendation_outcomes (episode_id, measurement_date, horizon_days, "
                "exit_date, stock_exit_close, spy_exit_close, sector_exit_close, stock_return, "
                "spy_return, sector_return, recommendation_result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    episode_id, today.isoformat(), horizon, exit_date.isoformat(),
                    stock_close, spy_close, sector_close, stock_return, spy_return, sector_return,
                    _describe_result(stock_return, spy_return, sector_return),
                ),
            )
            conn.commit()
            written.append((episode_id, horizon))

    return written
